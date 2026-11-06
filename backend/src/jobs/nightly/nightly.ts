/**
 * runNightly(): the approved nightly chain (steps.ts) with per-step timeout, retries and isolation.
 *
 * Every step goes through runStep (3 attempts by default). A failed step never stops a later one;
 * a later step whose input step failed still runs, on the last stored data, and is reported as
 * "degraded". Tickers (portfolio holdings first, then watchlist, deduped) run with bounded
 * concurrency; each has its own timeout and its own logger scope, so one failure never stops the
 * others and only that ticker's log turns verbose.
 *
 * INJECTED: every job, both ticker readers, and the per-ticker analysis (the legacy runAnalysisV7
 * signature, called with ONE argument as runDailyAutomation does). Nothing here fetches anything.
 */

import type { RunContext } from '../../core/context.ts';
import { degradeStep, runStep, skipStep } from '../../core/runStep.ts';
import { logDetail, reportSentence } from '../../core/result.ts';
import type { LogDetail, ReportSentence } from '../../core/result.ts';
import { StepState } from '../../core/status.ts';
import type { PortfolioSummary } from '../../portfolio/transactions.ts';
import type { DailyAnalysisResult, RunAnalysisFn } from '../automation/dailyAutomation.ts';
import { NIGHTLY_STEPS } from './steps.ts';
import { DAILY_AUTOMATION_REJECTED_LOG, DAILY_AUTOMATION_REJECTED_NOTE, mayAppendHistory, normalizeNightlyHistoryPolicy } from '../history/historyPolicy.ts';
import type { HistoryPolicy } from '../history/historyPolicy.ts';
import type { NightlyStepDef, NightlyStepId } from './steps.ts';
import { buildLogLines, buildPlainSummary, countStates, scrubDetail } from './summary.ts';
import { optionsGap } from './summary.ts';
import type { OptionsReadsSummary, OutcomeState, RunSummary, StepOutcome, TickerOutcome, TickerSet } from './summary.ts';

export type { RunSummary, StepOutcome, TickerOutcome } from './summary.ts';
export { buildPlainSummary, buildLogLines } from './summary.ts';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TICKER_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_TICKER_ATTEMPTS = 3;
export const DEFAULT_TICKER_PHASE_BUDGET_MS = 3 * 60 * 60_000;

/**
 * What a job may report. A job that returns nothing is "ok". A job that did part of its work returns
 * state 'degraded' and a plain `reason` (a curated sentence; it is shown in the report). An 'ok' job may also give a
 * `reason` for an expected gap (e.g. tickers skipped for too little history): it goes on the run-summary log line only.
 */
export interface JobOutcome {
  readonly state?: 'ok' | 'degraded';
  readonly reason?: string;
}
export type NightlyJob = () => Promise<JobOutcome | undefined | void>;

export interface AnalysedTicker {
  readonly ticker: string;
  readonly sets: readonly TickerSet[];
  readonly result: DailyAnalysisResult | null;
}

export interface NightlyDeps {
  readonly ctx: RunContext;
  /** darkPool.*, macro.refresh, buy.report, exit.report. A missing job is reported as skipped. */
  readonly jobs: Partial<Record<NightlyStepId, NightlyJob>>;
  /** Portfolio holdings: computePortfolioSummary result. */
  readonly readPortfolio?: () => PortfolioSummary | Promise<PortfolioSummary>;
  /** Watchlist tickers: getWatchlistTickers result. */
  readonly readWatchlist?: () => readonly string[] | Promise<readonly string[]>;
  /** The orchestrator, legacy signature (called with the ticker only). */
  readonly runAnalysis?: RunAnalysisFn<DailyAnalysisResult>;
  /** Watchlist summary + decision history + change email, fed the analysed rows. Optional. */
  readonly afterAnalysis?: (rows: readonly AnalysedTicker[], opts?: { readonly writeDecisionHistory: boolean }) => Promise<JobOutcome | undefined | void>;
  /** F-P4: single Decision History writer. Default: the Buy pipeline, so the summary step must NOT append. */
  readonly historyPolicy?: HistoryPolicy;
  /** Options sentiment A-7: tonight's per-stock options reads for the run summary (read after the last step). */
  readonly optionsReport?: () => OptionsReadsSummary | null;
}

export interface NightlyOptions {
  readonly concurrency?: number;
  readonly tickerTimeoutMs?: number;
  readonly tickerAttempts?: number;
  /** After this long, tickers not yet started are reported as "not reached". */
  readonly tickerPhaseBudgetMs?: number;
  readonly skip?: readonly NightlyStepId[];
  readonly overrides?: Partial<Record<NightlyStepId, { readonly timeoutMs?: number; readonly retries?: number }>>;
}

/** Runs fn over items with at most `limit` in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const n = Math.max(1, Math.floor(limit) || 1);
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

const sentence = (s: string): ReportSentence => reportSentence(s);

/**
 * docs/LOGGING_SPEC.md: a failed step is CRITICAL (not only ERROR) when the run's reports depend on it -- a report
 * step itself, or a step a report step lists in dependsOn. Other failed steps stay ERROR (the run goes on).
 */
export function reportCritical(def: Pick<NightlyStepDef, 'id' | 'kind'>): boolean {
  return def.kind === 'report' || def.kind === 'tickers' || NIGHTLY_STEPS.some((s) => s.kind === 'report' && s.dependsOn.includes(def.id));
}

function skippedOutcome(ctx: RunContext, def: Pick<NightlyStepDef, 'id' | 'label'>, why: string): StepOutcome {
  skipStep(ctx, { key: def.id, label: def.label }, sentence(why));
  return { id: def.id, label: def.label, state: 'skipped', reason: sentence(why), attempts: 0, durationMs: 0 };
}

function failedDeps(def: NightlyStepDef, done: Map<string, StepOutcome>): string[] {
  return def.dependsOn.filter((id) => done.get(id)?.state === 'failed');
}

async function runJob(
  deps: NightlyDeps, opts: NightlyOptions, def: NightlyStepDef, job: NightlyJob | undefined, done: Map<string, StepOutcome>,
): Promise<StepOutcome> {
  const ctx = deps.ctx;
  if (opts.skip && opts.skip.includes(def.id)) return skippedOutcome(ctx, def, 'Skipped on purpose for this run.');
  if (!job) return skippedOutcome(ctx, def, 'Not set up for this run.');

  const started = ctx.clock.now();
  const ov = opts.overrides?.[def.id];
  const retries = ov?.retries ?? def.retries;
  ctx.log.info(def.label + ' starting', { key: def.id, timeoutMs: ov?.timeoutMs ?? def.timeoutMs, attempts: retries + 1 });
  const res = await runStep(
    ctx,
    { key: def.id, label: def.label, onFailure: sentence(def.failedText), retry: 'auto', timeoutMs: ov?.timeoutMs ?? def.timeoutMs, maxAttempts: retries + 1, retryAfterTimeout: false },
    async () => ((await job()) as unknown as JobOutcome | undefined) ?? {},
  );
  const attempts = ctx.status.get(def.id)?.attempts ?? 1;
  const durationMs = ctx.clock.now() - started;

  if (!res.ok) {
    // runStep logged the ERROR; a step a report is built from (or a report itself) failing is CRITICAL.
    if (reportCritical(def)) ctx.log.critical(def.label + ' failed: a report of tonight depends on it', { key: def.id, attempts: res.error.attempts, ms: durationMs });
    return { id: def.id, label: def.label, state: 'failed', reason: res.error.disclosure, detail: logDetail(scrubDetail(String(res.error.detail))), attempts: res.error.attempts, durationMs };
  }
  if (res.value.state === 'degraded') {
    const why = sentence(res.value.reason ?? def.failedText);
    degradeStep(ctx, { key: def.id, label: def.label }, why);
    return { id: def.id, label: def.label, state: 'degraded', reason: why, attempts, durationMs };
  }
  if (def.staleText && failedDeps(def, done).length > 0) {
    const why = sentence(def.staleText);
    degradeStep(ctx, { key: def.id, label: def.label }, why);
    return { id: def.id, label: def.label, state: 'degraded', reason: why, attempts, durationMs };
  }
  return { id: def.id, label: def.label, state: 'ok', ...(res.value.reason ? { reason: sentence(res.value.reason) } : {}), attempts, durationMs };
}

interface TickerEntry { readonly ticker: string; readonly sets: TickerSet[] }

async function runTickerPhase(
  deps: NightlyDeps, opts: NightlyOptions, def: NightlyStepDef, done: Map<string, StepOutcome>,
): Promise<{ step: StepOutcome; tickers: TickerOutcome[]; analysed: AnalysedTicker[] }> {
  const ctx = deps.ctx;
  const none = { tickers: [] as TickerOutcome[], analysed: [] as AnalysedTicker[] };
  if (opts.skip && opts.skip.includes(def.id)) return { step: skippedOutcome(ctx, def, 'Skipped on purpose for this run.'), ...none };
  const runAnalysis = deps.runAnalysis;
  if (!runAnalysis || (!deps.readPortfolio && !deps.readWatchlist)) return { step: skippedOutcome(ctx, def, 'Not set up for this run.'), ...none };

  const started = ctx.clock.now();
  const entries = new Map<string, TickerEntry>();
  const add = (raw: unknown, set: TickerSet): void => {
    const t = String(raw ?? '').toUpperCase().trim();
    if (!t) return;
    const e = entries.get(t);
    if (!e) entries.set(t, { ticker: t, sets: [set] });
    else if (!e.sets.includes(set)) e.sets.push(set);
  };

  const problems: string[] = [];
  let readers = 0;
  let readerFailures = 0;
  const readPortfolio = deps.readPortfolio;
  if (readPortfolio) {
    readers++;
    const r = await runStep(
      ctx,
      { key: 'tickers.portfolio', label: 'Read portfolio holdings', onFailure: sentence('The portfolio holdings could not be read.'), retry: 'auto', timeoutMs: 60_000, maxAttempts: 3 },
      async () => (await readPortfolio()).positions.map((p) => p.ticker),
    );
    if (r.ok) r.value.forEach((t) => add(t, 'portfolio'));
    else { readerFailures++; problems.push('The portfolio holdings could not be read, so those stocks were left out tonight.'); }
  }
  const readWatchlist = deps.readWatchlist;
  if (readWatchlist) {
    readers++;
    const r = await runStep(
      ctx,
      { key: 'tickers.watchlist', label: 'Read watchlist', onFailure: sentence('The watchlist could not be read.'), retry: 'auto', timeoutMs: 60_000, maxAttempts: 3 },
      async () => [...(await readWatchlist())],
    );
    if (r.ok) r.value.forEach((t) => add(t, 'watchlist'));
    else { readerFailures++; problems.push('The watchlist could not be read, so those stocks were left out tonight.'); }
  }

  if (readerFailures === readers) {
    const why = sentence('The stock lists could not be read, so no stock was analysed tonight.');
    ctx.status.set({ key: def.id, label: def.label, state: StepState.FAILED, disclosure: why, elapsedMs: ctx.clock.now() - started });
    ctx.log.critical(def.label + ' failed: no ticker list could be read, so no stock is analysed and the reports cannot be updated', { key: def.id, ms: ctx.clock.now() - started });
    return { step: { id: def.id, label: def.label, state: 'failed', reason: why, attempts: 1, durationMs: ctx.clock.now() - started }, ...none };
  }
  if (entries.size === 0) {
    ctx.log.warning(def.label + ': the portfolio and the watchlist are both empty; nothing to analyse', { key: def.id });
    return { step: skippedOutcome(ctx, def, 'There were no stocks to analyse tonight.'), ...none };
  }

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = opts.tickerTimeoutMs ?? DEFAULT_TICKER_TIMEOUT_MS;
  const attempts = opts.tickerAttempts ?? DEFAULT_TICKER_ATTEMPTS;
  const budget = opts.tickerPhaseBudgetMs ?? DEFAULT_TICKER_PHASE_BUDGET_MS;
  const phaseStart = ctx.clock.now();
  ctx.log.info('analysis starting', { tickers: entries.size, concurrency, tickerTimeoutMs: timeoutMs, tickerAttempts: attempts });

  const rows = await mapLimit([...entries.values()], concurrency, async (e): Promise<{ outcome: TickerOutcome; analysed: AnalysedTicker | null }> => {
    const t = e.ticker;
    if (ctx.clock.now() - phaseStart > budget) {
      ctx.log.warning('ticker not reached: phase time budget used up', { ticker: t, budgetMs: budget });
      return { outcome: { ticker: t, sets: e.sets, state: 'skipped', reason: sentence('Not reached: tonight\'s time budget ran out.'), attempts: 0, durationMs: 0 }, analysed: null };
    }
    const tctx = ctx.forTicker(t);
    const key = 'analysis.' + t;
    const label = 'Analysis ' + t;
    const t0 = ctx.clock.now();
    const res = await runStep(
      tctx,
      { key, label, onFailure: sentence('The analysis for ' + t + ' did not finish tonight; its previous results are unchanged.'), retry: 'auto', timeoutMs, maxAttempts: attempts },
      () => runAnalysis(t),
    );
    const used = ctx.status.get(key)?.attempts ?? 1;
    const durationMs = ctx.clock.now() - t0;
    if (!res.ok) {
      return {
        outcome: { ticker: t, sets: e.sets, state: 'failed', reason: res.error.disclosure, detail: logDetail(scrubDetail(String(res.error.detail))), attempts: res.error.attempts, durationMs },
        analysed: { ticker: t, sets: e.sets, result: null },
      };
    }
    const result = res.value ?? null;
    if (!result || !result.decision) {
      const why = sentence('The analysis for ' + t + ' ran but gave no decision.');
      degradeStep(tctx, { key, label }, why);
      return { outcome: { ticker: t, sets: e.sets, state: 'degraded', reason: why, attempts: used, durationMs }, analysed: { ticker: t, sets: e.sets, result } };
    }
    return { outcome: { ticker: t, sets: e.sets, state: 'ok', attempts: used, durationMs }, analysed: { ticker: t, sets: e.sets, result } };
  });

  const tickers = rows.map((r) => r.outcome);
  const analysed = rows.map((r) => r.analysed).filter((a): a is AnalysedTicker => a !== null);
  const c = countStates(tickers);
  const durationMs = ctx.clock.now() - started;

  let state: OutcomeState = 'ok';
  let reason: ReportSentence | undefined;
  if (c.ok === 0 && tickers.length > 0) {
    state = 'failed';
    reason = sentence('No stock could be analysed tonight.');
  } else if (c.failed + c.degraded + c.skipped > 0) {
    state = 'degraded';
    const bits: string[] = [];
    if (c.failed) bits.push(c.failed + ' did not finish');
    if (c.degraded) bits.push(c.degraded + ' gave partial results');
    if (c.skipped) bits.push(c.skipped + ' were not reached');
    reason = sentence('Some stocks need attention: ' + bits.join(', ') + '.');
  } else if (problems.length > 0) {
    state = 'degraded';
    reason = sentence(problems.join(' '));
  } else if (failedDeps(def, done).length > 0) {
    state = 'degraded';
    reason = sentence(def.staleText);
  }
  if (state === 'degraded' && problems.length > 0 && (c.failed + c.degraded + c.skipped > 0)) {
    reason = sentence(String(reason) + ' ' + problems.join(' '));
  }
  ctx.status.set({
    key: def.id, label: def.label,
    state: state === 'ok' ? StepState.OK : state === 'degraded' ? StepState.DEGRADED : StepState.FAILED,
    disclosure: reason, elapsedMs: durationMs,
  });
  if (state === 'degraded') ctx.log.warning(def.label + ' degraded', { key: def.id, ok: c.ok, degraded: c.degraded, failed: c.failed, skipped: c.skipped });
  else if (state === 'failed') ctx.log.critical(def.label + ' failed: no stock could be analysed, the reports cannot be updated', { key: def.id, ms: durationMs, failed: c.failed, skipped: c.skipped });
  else ctx.log.info(def.label + ' OK', { key: def.id, ms: durationMs, tickers: tickers.length });

  return { step: { id: def.id, label: def.label, state, reason, attempts: 1, durationMs }, tickers, analysed };
}

/** A run-summary line of a step or ticker that ended ok (buildLogLines: 'step <id> state=ok ...'). */
const OK_SUMMARY_LINE = /^(step|ticker) \S+ (sets=\S+ )?state=ok\b/;

export async function runNightly(deps: NightlyDeps, options: NightlyOptions = {}): Promise<RunSummary> {
  const ctx = deps.ctx;
  const startedAtMs = ctx.clock.now();
  ctx.log.info('nightly starting', { runId: ctx.runId, steps: NIGHTLY_STEPS.map((s) => s.id).join(',') });
  const hp = normalizeNightlyHistoryPolicy(deps.historyPolicy);
  const notes: string[] = [];
  if (hp.rejected) {
    ctx.log.error(DAILY_AUTOMATION_REJECTED_LOG, { runId: ctx.runId });
    notes.push(DAILY_AUTOMATION_REJECTED_NOTE);
  }

  const done = new Map<string, StepOutcome>();
  const steps: StepOutcome[] = [];
  let tickers: TickerOutcome[] = [];
  let analysed: AnalysedTicker[] = [];

  for (const def of NIGHTLY_STEPS) {
    let outcome: StepOutcome;
    if (def.kind === 'tickers') {
      const r = await runTickerPhase(deps, options, def, done);
      outcome = r.step;
      tickers = r.tickers;
      analysed = r.analysed;
    } else {
      let job: NightlyJob | undefined = deps.jobs[def.id];
      if (def.id === 'analysis.summary') {
        const after = deps.afterAnalysis;
        const writeDecisionHistory = mayAppendHistory('nightlySummary', hp.policy);
        job = after ? () => after(analysed, { writeDecisionHistory }) : undefined;
      }
      outcome = await runJob(deps, options, def, job, done);
    }
    done.set(def.id, outcome);
    steps.push(outcome);
  }

  const finishedAtMs = ctx.clock.now();
  const stepCounts = countStates(steps);
  const tickerCounts = countStates(tickers);
  const ran = steps.length - stepCounts.skipped;
  let optReads: OptionsReadsSummary | null = null;
  try { optReads = deps.optionsReport ? deps.optionsReport() : null; } catch (e) { ctx.log.warning('options report for the run summary failed', { detail: String(e) }); }
  const overall: RunSummary['overall'] =
    stepCounts.failed === 0 && stepCounts.degraded === 0 && tickerCounts.failed === 0 && tickerCounts.degraded === 0 && tickerCounts.skipped === 0 && !optionsGap(optReads ?? undefined)
      ? 'ok'
      : ran > 0 && stepCounts.failed === ran ? 'failed' : 'partial';

  if (overall === 'failed') ctx.log.critical('nightly: every step that ran failed; the run did not do its job', { runId: ctx.runId, steps: steps.length, failed: stepCounts.failed });
  // The run's log counts so far (every scope): the summary's log line and the workflow's notice show them.
  const rc = ctx.log.runCounts();
  const logCounts = { warning: rc.warning, error: rc.error, critical: rc.critical };
  const summary: RunSummary = { runId: ctx.runId, startedAtMs, finishedAtMs, durationMs: finishedAtMs - startedAtMs, overall, steps, tickers, stepCounts, tickerCounts, logCounts, ...(notes.length ? { notes } : {}), ...(optReads ? { options: optReads } : {}) };
  // 5 Nov: on a partial night only the overall line and the non-ok lines are WARNINGs; an ok step's line is INFO.
  for (const line of buildLogLines(summary)) {
    if (overall === 'ok' || OK_SUMMARY_LINE.test(line)) ctx.log.info(line);
    else ctx.log.warning(line);
  }
  return summary;
}

export type { LogDetail };
