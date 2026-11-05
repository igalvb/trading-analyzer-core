/**
 * Dual-AI dispatch layer -- NEW (plan: CHARACTERIZATION_PLAN_V13_dual_ai_gemini_opus
 * s4, s5, s7; workflow inputs: workflows/schedule.ts AI_INPUTS, sub-plan 6 s3.1).
 *
 * Per ticker: Gemini first (if selected), then Opus (if selected) with Gemini's
 * output (REVIEW) or without it (STANDALONE). Both off -> nothing runs. Every
 * leg runs through runStep (timing, status, logs) and NEVER throws out of here:
 * a failed leg degrades only that ticker/leg into one plain catalog line.
 *
 * Report text vs logs: the lines returned for the report come from the message
 * catalog (labelledReason + EFFECTS) or from the model's own text; HTTP codes,
 * block reasons and exception text exist only in log output (runStep logs the
 * thrown AiLegError message).
 *
 * Nightly runs contain ZERO AI calls (plan DoD 13): in mode 'nightly' no
 * transport is touched. This layer writes no sheet and creates no report (DoD
 * 14); it only returns lines for the already-existing AI SUMMARIES section.
 */

import type { RunContext } from '../core/context.ts';
import { runStep } from '../core/runStep.ts';
import { reportSentence } from '../core/result.ts';
import { AI_INPUTS, AI_EFFORT_OPTIONS } from '../workflows/schedule.ts';
import { EFFECTS, classifyError, labelledReason, type ReasonCode } from '../reports/messages/catalog.ts';
import { buildGeminiReport, type FormatExpiry, type GeminiReviewInputs, type GetMacroRegime } from '../fetch/ai/geminiReview.ts';
import { reviewWithClaude, type ClaudeEffort, type ClaudeRetryPolicy, type ClaudeReviewMode, type ClaudeSdk, type ClaudeUsage, type GeminiOutcome } from './claudeReview.ts';
import { buildGeminiPromptFor, framedReport, type AiFrame, type ExitPositionFacts } from './exitFraming.ts';
import { generateGeminiText, type GeminiRetryPolicy, type GeminiTransport } from './geminiTransport.ts';

// ── inputs ──────────────────────────────────────────────────────────────

export interface AiSideSwitches { readonly gemini: boolean; readonly opus: boolean }
export interface AiRunPlan { readonly effort: ClaudeEffort; readonly buy: AiSideSwitches | null; readonly exit: AiSideSwitches | null }

export type ParsedAiInputs =
  | { readonly ok: true; readonly plan: AiRunPlan }
  | { readonly ok: false; readonly message: string; readonly detail: string };

const BAD_INPUTS_MESSAGE = 'The AI run settings were not understood, so no AI analysis was started.';

/** The seven dispatch inputs (strings as GitHub passes them). Defaults come from AI_INPUTS. */
export function parseAiInputs(raw: Readonly<Record<string, string | undefined>>): ParsedAiInputs {
  const value = (name: string): string => {
    const given = raw[name];
    if (given !== undefined && given !== '') return given;
    const spec = AI_INPUTS.find((i) => i.name === name);
    return spec ? spec.default : '';
  };
  const bool = (name: string): boolean | null => {
    const v = value(name).trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
  };
  const flags: Record<string, boolean> = {};
  for (const n of ['buy', 'buy_gemini', 'buy_opus', 'exit', 'exit_gemini', 'exit_opus']) {
    const b = bool(n);
    if (b === null) return { ok: false, message: BAD_INPUTS_MESSAGE, detail: 'input ' + n + ' is not true/false: ' + String(raw[n]) };
    flags[n] = b;
  }
  const effort = value('effort').trim().toLowerCase();
  if (!AI_EFFORT_OPTIONS.includes(effort)) return { ok: false, message: BAD_INPUTS_MESSAGE, detail: 'input effort is not one of ' + AI_EFFORT_OPTIONS.join('/') + ': ' + effort };
  return {
    ok: true,
    plan: {
      effort: effort as ClaudeEffort,
      buy: flags['buy'] ? { gemini: flags['buy_gemini'] === true, opus: flags['buy_opus'] === true } : null,
      exit: flags['exit'] ? { gemini: flags['exit_gemini'] === true, opus: flags['exit_opus'] === true } : null,
    },
  };
}

// ── deps / results ──────────────────────────────────────────────────────

export interface AiDispatchDeps {
  readonly ctx: RunContext;
  readonly geminiTransport: GeminiTransport;
  readonly claudeSdk: ClaudeSdk;
  /** Env ANTHROPIC_API_KEY (claudeKeyFromEnv). Injected; never read here. */
  readonly claudeApiKey: string;
  readonly getMacroRegime: GetMacroRegime;
  readonly formatExpiry?: FormatExpiry;
  /** B3: the report's options block in plain labels (GeminiReportOptions). */
  readonly plainLabels?: boolean;
  /** Named flag, default true. false = legacy single-attempt Gemini. */
  readonly geminiRetry429?: boolean;
  readonly geminiPolicy?: Partial<GeminiRetryPolicy>;
  readonly claudeRetry?: Partial<ClaudeRetryPolicy>;
  readonly claudeModel?: string;
  readonly claudeMaxTokens?: number;
  /** runStep ceilings; must exceed the layer's own retries. */
  readonly stepTimeoutMs?: { readonly gemini?: number; readonly opus?: number };
}

export interface AiTickerRequest {
  readonly ticker: string;
  readonly inputs: GeminiReviewInputs;
  /** Required when frame is 'exit'. */
  readonly exitFacts?: ExitPositionFacts;
}

export type GeminiLeg =
  | { readonly state: 'off' }
  | { readonly state: 'ok'; readonly text: string }
  | { readonly state: 'failed'; readonly reason: ReasonCode; readonly line: string };

export type OpusLeg =
  | { readonly state: 'off'; readonly note?: string }
  | {
    readonly state: 'ok'; readonly mode: ClaudeReviewMode; readonly disclosureLine: string; readonly body: string;
    /** Opus hit max_tokens: the text is kept and marked. */
    readonly truncated: boolean; readonly model: string; readonly usage: ClaudeUsage;
  }
  | { readonly state: 'failed'; readonly reason: ReasonCode; readonly line: string };

export interface AiTickerResult {
  readonly ticker: string;
  readonly frame: AiFrame;
  readonly gemini: GeminiLeg;
  readonly opus: OpusLeg;
  /** Report-ready plain-English lines (no codes, no URLs). Empty when both legs are off. */
  readonly lines: string[];
}

export const OPUS_TRUNCATED_NOTE = 'Note: this review was cut off before Claude Opus finished, so the last part may be incomplete. Everything it wrote is shown.';
export const OPUS_FILTERED_NOTE = 'Claude Opus review was not run for this ticker.';

class AiLegError extends Error {
  readonly code: ReasonCode;
  readonly status: number | null;
  constructor(code: ReasonCode, status: number | null, detail: string) {
    super(detail);
    this.name = 'AiLegError';
    this.code = code;
    this.status = status;
  }
}

function reasonFrom(cause: unknown): ReasonCode {
  return cause instanceof AiLegError ? cause.code : classifyError(cause);
}

function failureLine(label: string, code: ReasonCode): string {
  return labelledReason(label, code) + ' ' + EFFECTS.SCORE_UNCHANGED;
}

// ── one ticker ──────────────────────────────────────────────────────────

export async function runAiForTicker(deps: AiDispatchDeps, frame: AiFrame, req: AiTickerRequest, switches: AiSideSwitches, effort: ClaudeEffort, opusAllowed = true): Promise<AiTickerResult> {
  const ctx = deps.ctx.forTicker(req.ticker);
  const T = req.ticker;
  const off: AiTickerResult = { ticker: T, frame, gemini: { state: 'off' }, opus: { state: 'off' }, lines: [] };

  if (deps.ctx.mode === 'nightly') {
    ctx.log.critical('AI layer was called from a nightly run; refusing (nightly runs make no AI calls)');
    return off;
  }
  const wantGemini = switches.gemini;
  const wantOpus = switches.opus && opusAllowed;
  if (!wantGemini && !wantOpus) {
    return { ...off, opus: switches.opus && !opusAllowed ? { state: 'off', note: OPUS_FILTERED_NOTE } : { state: 'off' } };
  }

  // Gemini leg ---------------------------------------------------------
  let gemini: GeminiLeg = { state: 'off' };
  if (wantGemini) {
    const label = 'Gemini summary for ' + T;
    const r = await runStep(ctx, {
      key: 'ai.gemini.' + T, label, retry: 'never', maxAttempts: 1, timeoutMs: deps.stepTimeoutMs?.gemini ?? 300_000,
      onFailure: reportSentence(failureLine(label, 'AI_REVIEW_UNAVAILABLE')),
    }, async () => {
      if (frame === 'exit' && !req.exitFacts) throw new AiLegError('AI_REVIEW_UNAVAILABLE', null, 'exit frame without position facts');
      const report = framedReport(frame, await buildGeminiReport(req.inputs, deps.getMacroRegime, deps.formatExpiry, { plainLabels: deps.plainLabels }), req.exitFacts);
      const g = await generateGeminiText({
        transport: deps.geminiTransport, retry429: deps.geminiRetry429, policy: deps.geminiPolicy, sleep: ctx.sleep, random: ctx.random,
        log: (lvl, m) => (lvl === 'warn' ? ctx.log.warning(m) : ctx.log.info(m)),
      }, buildGeminiPromptFor(frame, T, report));
      if (!g.ok) throw new AiLegError(g.reason === 'rate-limit' ? 'RATE_LIMIT' : 'AI_REVIEW_UNAVAILABLE', g.status, 'Gemini ' + g.reason + ' after ' + g.attempts + ' attempt(s): ' + String(g.detail));
      return g.text;
    });
    if (r.ok) gemini = { state: 'ok', text: r.value };
    else { const code = reasonFrom(r.error.cause); gemini = { state: 'failed', reason: code, line: failureLine(label, code) }; }
  }

  // Opus leg -----------------------------------------------------------
  let opus: OpusLeg = switches.opus && !opusAllowed ? { state: 'off', note: OPUS_FILTERED_NOTE } : { state: 'off' };
  if (wantOpus) {
    const label = 'Claude Opus review for ' + T;
    const outcome: GeminiOutcome = gemini.state === 'ok' ? { status: 'ok', text: gemini.text } : wantGemini ? { status: 'unavailable' } : { status: 'not-selected' };
    const r = await runStep(ctx, {
      key: 'ai.opus.' + T, label, retry: 'never', maxAttempts: 1, timeoutMs: deps.stepTimeoutMs?.opus ?? 420_000,
      onFailure: reportSentence(failureLine(label, 'AI_REVIEW_UNAVAILABLE')),
    }, async () => {
      if (frame === 'exit' && !req.exitFacts) throw new AiLegError('AI_REVIEW_UNAVAILABLE', null, 'exit frame without position facts');
      const res = await reviewWithClaude({
        apiKey: deps.claudeApiKey, sdk: deps.claudeSdk, getMacroRegime: deps.getMacroRegime, formatExpiry: deps.formatExpiry, plainLabels: deps.plainLabels,
        log: (lvl, m) => (lvl === 'info' ? ctx.log.info(m) : lvl === 'warn' ? ctx.log.warning(m) : ctx.log.error(m)),
        sleep: ctx.sleep, random: ctx.random,
      }, req.inputs, outcome, { effort, frame, exitFacts: req.exitFacts, model: deps.claudeModel, maxTokens: deps.claudeMaxTokens, retry: deps.claudeRetry });
      if (!res.ok) throw new AiLegError(res.status === 429 ? 'RATE_LIMIT' : 'AI_REVIEW_UNAVAILABLE', res.status, 'Opus ' + res.reason + ' (' + res.mode + ') ' + String(res.detail));
      return res;
    });
    if (r.ok) {
      const v = r.value;
      opus = { state: 'ok', mode: v.mode, disclosureLine: v.disclosureLine, body: v.body, truncated: v.truncated, model: v.model, usage: v.usage };
    } else {
      const code = reasonFrom(r.error.cause);
      opus = { state: 'failed', reason: code, line: failureLine(label, code) };
    }
  }

  return { ticker: T, frame, gemini, opus, lines: renderLines(gemini, opus) };
}

/** Report-ready lines. Opus's mandatory disclosure line comes first, then its text; a truncated answer is kept and marked. */
export function renderLines(gemini: GeminiLeg, opus: OpusLeg): string[] {
  const lines: string[] = [];
  if (gemini.state === 'ok') lines.push('AI SUMMARY (GEMINI)', gemini.text);
  else if (gemini.state === 'failed') lines.push(gemini.line);
  if (lines.length && opus.state !== 'off') lines.push('');
  if (opus.state === 'ok') {
    lines.push(opus.mode === 'REVIEW' ? 'CLAUDE OPUS REVIEW' : 'CLAUDE OPUS ANALYSIS', opus.disclosureLine, '', opus.body);
    if (opus.truncated) lines.push('', OPUS_TRUNCATED_NOTE);
  } else if (opus.state === 'failed') lines.push(opus.line);
  else if (opus.note) lines.push(opus.note);
  return lines;
}

// ── a batch of tickers ──────────────────────────────────────────────────

export interface AiBatchOptions {
  /** Bounded concurrency across tickers; default 3. */
  readonly concurrency?: number;
  /** Optional Opus tier gate (open question 1); default: every ticker. */
  readonly opusFilter?: (ticker: string) => boolean;
}

export interface AiBatchTotals {
  readonly geminiOk: number; readonly geminiFailed: number;
  readonly opusOk: number; readonly opusFailed: number; readonly opusTruncated: number;
  readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number;
}

export interface AiBatchResult {
  readonly frame: AiFrame;
  readonly results: AiTickerResult[];
  readonly totals: AiBatchTotals;
  /** Plain "covered / not covered" lines for the AI section's scope disclosure. */
  readonly scopeLines: string[];
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return out;
}

export async function runAiBatch(deps: AiDispatchDeps, frame: AiFrame, requests: readonly AiTickerRequest[], switches: AiSideSwitches, effort: ClaudeEffort, opts: AiBatchOptions = {}): Promise<AiBatchResult> {
  const results = await pool(requests, opts.concurrency ?? 3, (req) => runAiForTicker(deps, frame, req, switches, effort, opts.opusFilter ? opts.opusFilter(req.ticker) : true));

  let geminiOk = 0, geminiFailed = 0, opusOk = 0, opusFailed = 0, opusTruncated = 0, inT = 0, outT = 0, cr = 0, cw = 0;
  for (const r of results) {
    if (r.gemini.state === 'ok') geminiOk++; else if (r.gemini.state === 'failed') geminiFailed++;
    if (r.opus.state === 'ok') {
      opusOk++;
      if (r.opus.truncated) opusTruncated++;
      inT += r.opus.usage.inputTokens ?? 0; outT += r.opus.usage.outputTokens ?? 0;
      cr += r.opus.usage.cacheReadInputTokens ?? 0; cw += r.opus.usage.cacheCreationInputTokens ?? 0;
    } else if (r.opus.state === 'failed') opusFailed++;
  }
  const totals: AiBatchTotals = { geminiOk, geminiFailed, opusOk, opusFailed, opusTruncated, inputTokens: inT, outputTokens: outT, cacheReadTokens: cr, cacheWriteTokens: cw };
  deps.ctx.log.info('AI batch (' + frame + '): ' + results.length + ' ticker(s), gemini ok=' + geminiOk + ' failed=' + geminiFailed + ', opus ok=' + opusOk + ' failed=' + opusFailed +
    ' truncated=' + opusTruncated + ', tokens in=' + inT + ' out=' + outT + ' cache_read=' + cr + ' cache_write=' + cw);

  return { frame, results, totals, scopeLines: scopeLines(results, switches) };
}

export function scopeLines(results: readonly AiTickerResult[], switches: AiSideSwitches): string[] {
  if (!switches.gemini && !switches.opus) return ['AI analysis was not selected for this report.'];
  const covered = results.filter((r) => r.gemini.state === 'ok' || r.opus.state === 'ok').map((r) => r.ticker);
  const missed = results.filter((r) => r.gemini.state !== 'ok' && r.opus.state !== 'ok');
  const lines: string[] = [];
  lines.push(covered.length ? 'AI analysis covered: ' + covered.join(', ') + '.' : 'AI analysis covered no tickers.');
  for (const r of missed) {
    const leg = r.opus.state === 'failed' ? r.opus.line : r.gemini.state === 'failed' ? r.gemini.line : '';
    lines.push('Not covered: ' + r.ticker + (leg ? '. ' + leg : '.'));
  }
  return lines;
}
