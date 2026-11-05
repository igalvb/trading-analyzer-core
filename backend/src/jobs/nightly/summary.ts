/**
 * Run summary: types, the plain-English report lines, and the technical log lines.
 *
 * Report lines are built ONLY from `reason` (a ReportSentence) and counts. `detail` (LogDetail) is
 * reachable only from buildLogLines. Job-supplied reasons are also passed through a last-resort
 * filter, so a careless reason can never put a URL, status number or exception text in the report.
 */

import type { LogDetail, ReportSentence } from '../../core/result.ts';

export type OutcomeState = 'ok' | 'degraded' | 'failed' | 'skipped';
export type TickerSet = 'portfolio' | 'watchlist';

export interface StepOutcome {
  readonly id: string;
  readonly label: string;
  readonly state: OutcomeState;
  /** Plain reason for the report. Absent when ok. */
  readonly reason?: ReportSentence;
  /** Technical, log only. */
  readonly detail?: LogDetail;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface TickerOutcome {
  readonly ticker: string;
  readonly sets: readonly TickerSet[];
  readonly state: OutcomeState;
  readonly reason?: ReportSentence;
  readonly detail?: LogDetail;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface StateCounts { readonly ok: number; readonly degraded: number; readonly failed: number; readonly skipped: number }

/** Options sentiment plan A-7: the per-stock options reads of the night (jobs/options/optionsNight.ts). */
export interface OptionsReadsSummary {
  readonly day: string;
  readonly stocks: number;
  readonly readTonight: number;
  /** Stocks on a stored read that is still fresh (A-5). */
  readonly stored: readonly string[];
  /** Stocks with no read that could be applied (none, or too old). */
  readonly missing: readonly string[];
  /** False in the shadow phase (A-8): shown, not counted as partial results. */
  readonly applied: boolean;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly durationMs: number;
  readonly overall: 'ok' | 'partial' | 'failed';
  readonly steps: readonly StepOutcome[];
  readonly tickers: readonly TickerOutcome[];
  readonly stepCounts: StateCounts;
  readonly tickerCounts: StateCounts;
  /** Plain-English run-level notes (curated sentences only), shown in the plain summary. */
  readonly notes?: readonly string[];
  /** A-7: the options reads; once applied (P2) a missing read counts toward the partial results. */
  readonly options?: OptionsReadsSummary;
  /** docs/LOGGING_SPEC.md: the run's WARNING / ERROR / CRITICAL line counts when the summary was built (log only). */
  readonly logCounts?: { readonly warning: number; readonly error: number; readonly critical: number };
}

/** A-7: once the reads are applied, a stock without one is a gap in the run (in the shadow phase it is only shown). */
export function optionsGap(o: OptionsReadsSummary | undefined): boolean {
  return !!o && o.applied && o.missing.length > 0;
}

/** The options line of the plain summary ("Options reads (not yet applied): 14 of 16 stocks read tonight; ..."). */
export function optionsSummaryLine(o: OptionsReadsSummary): string {
  const bits = [o.readTonight + ' of ' + o.stocks + ' stocks read tonight'];
  if (o.stored.length) bits.push('a stored read used for ' + names(o.stored));
  if (o.missing.length) bits.push('missing for ' + names(o.missing));
  return 'Options reads' + (o.applied ? '' : ' (not yet applied)') + ': ' + bits.join('; ') + '.';
}

export function countStates(items: ReadonlyArray<{ readonly state: OutcomeState }>): StateCounts {
  const c = { ok: 0, degraded: 0, failed: 0, skipped: 0 };
  for (const i of items) c[i.state]++;
  return c;
}

const RAW_LOOKING = /https?|:\/\/|\bstatus\b|\b[1-5]\d\d\s+(?:error|from|response|bad|unauthorized|forbidden|not found)|\w+Error\b|Error:|[\r\n]|\s+at\s+\S+\s*\(|\bE[A-Z]{4,}\b/i;
const GENERIC_REASON = 'Something went wrong; the technical log has the details.';

/** Last line of defence: a reason that looks like raw technical text is replaced. */
export function plainReason(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return GENERIC_REASON;
  return RAW_LOOKING.test(t) ? GENERIC_REASON : t;
}

/** Removes secrets from technical text before it is written to the log summary. */
export function scrubDetail(text: string): string {
  return text
    .replace(/([?&](?:api_?key|apikey|token|access_token|key|secret|auth)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return totalSec + ' s';
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return totalMin + ' min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? h + ' h ' + m + ' min' : h + ' h';
}

const NAME_CAP = 10;
function names(list: readonly string[]): string {
  if (list.length <= NAME_CAP) return list.join(', ');
  return list.slice(0, NAME_CAP).join(', ') + ' and ' + (list.length - NAME_CAP) + ' more';
}

/** Clean, short, plain English. No raw errors, URLs, status codes or stack lines. */
export function buildPlainSummary(s: RunSummary): string[] {
  const lines: string[] = [];
  const tc = s.tickerCounts;
  const sc = s.stepCounts;
  const clean = sc.failed === 0 && sc.degraded === 0 && tc.failed === 0 && tc.degraded === 0 && tc.skipped === 0 && !optionsGap(s.options);
  if (clean) lines.push('Nightly run finished: everything completed.');
  else if (s.overall === 'failed') lines.push('Nightly run finished, but nothing completed properly.');
  else lines.push('Nightly run finished with some gaps.');

  if (s.tickers.length > 0) {
    const parts = [tc.ok + ' of ' + s.tickers.length + ' stocks analysed fully'];
    if (tc.degraded) parts.push(tc.degraded + ' with partial results');
    if (tc.failed) parts.push(tc.failed + ' did not finish');
    if (tc.skipped) parts.push(tc.skipped + ' not reached');
    lines.push('Stocks: ' + parts.join(', ') + '.');
    const failed = s.tickers.filter((t) => t.state === 'failed').map((t) => t.ticker);
    const degraded = s.tickers.filter((t) => t.state === 'degraded').map((t) => t.ticker);
    const skipped = s.tickers.filter((t) => t.state === 'skipped').map((t) => t.ticker);
    if (failed.length) lines.push('Did not finish: ' + names(failed) + '.');
    if (degraded.length) lines.push('Partial results: ' + names(degraded) + '.');
    if (skipped.length) lines.push('Not reached: ' + names(skipped) + '.');
  }

  for (const st of s.steps) {
    if (st.state === 'ok') continue;
    lines.push('- ' + st.label + ': ' + plainReason(st.reason));
  }
  if (s.options) lines.push(optionsSummaryLine(s.options));
  for (const n of s.notes ?? []) lines.push('Note: ' + plainReason(n));
  lines.push('Total time: ' + formatDuration(s.durationMs) + '.');
  return lines;
}

/** Technical, verbose lines for the log. Details are scrubbed of secrets. */
export function buildLogLines(s: RunSummary): string[] {
  const sc = s.stepCounts;
  const tc = s.tickerCounts;
  const out: string[] = [];
  out.push(
    'run ' + s.runId + ' overall=' + s.overall + ' durationMs=' + s.durationMs +
    ' steps[ok=' + sc.ok + ' degraded=' + sc.degraded + ' failed=' + sc.failed + ' skipped=' + sc.skipped + ']' +
    ' tickers[ok=' + tc.ok + ' degraded=' + tc.degraded + ' failed=' + tc.failed + ' skipped=' + tc.skipped + ']' +
    (s.logCounts ? ' log[warning=' + s.logCounts.warning + ' error=' + s.logCounts.error + ' critical=' + s.logCounts.critical + ']' : ''),
  );
  for (const st of s.steps) {
    out.push(
      'step ' + st.id + ' state=' + st.state + ' attempts=' + st.attempts + ' durationMs=' + st.durationMs +
      (st.reason ? ' reason="' + String(st.reason) + '"' : '') +
      (st.detail ? ' detail="' + scrubDetail(String(st.detail)) + '"' : ''),
    );
  }
  if (s.options) {
    const o = s.options;
    out.push('options day=' + o.day + ' applied=' + o.applied + ' stocks=' + o.stocks + ' readTonight=' + o.readTonight + ' stored=' + o.stored.length + ' missing=' + o.missing.length + (o.missing.length ? ' [' + o.missing.join(',') + ']' : ''));
  }
  for (const t of s.tickers) {
    if (t.state === 'ok') continue;
    out.push(
      'ticker ' + t.ticker + ' sets=' + t.sets.join('+') + ' state=' + t.state + ' attempts=' + t.attempts + ' durationMs=' + t.durationMs +
      (t.reason ? ' reason="' + String(t.reason) + '"' : '') +
      (t.detail ? ' detail="' + scrubDetail(String(t.detail)) + '"' : ''),
    );
  }
  return out;
}
