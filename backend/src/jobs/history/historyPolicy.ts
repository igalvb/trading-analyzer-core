/**
 * FL-9d (finding F-P4): exactly ONE writer of Decision History per ticker per night.
 *
 * Three code paths can append a row for a watchlist ticker:
 *   'buyPipeline'      runBuyPipeline (src/jobs/buy/buyPipeline.ts)            <- default, the single writer
 *   'dailyAutomation'  runDailyAutomation (src/jobs/automation/dailyAutomation.ts)
 *   'nightlySummary'   the injected afterAnalysis of the nightly "analysis.summary" step
 *
 * FIX (default): only the named writer appends; the others keep their reads (prior decision, change
 * detection) but pass no rows. PARITY FLAG: legacyDoubleAppend:true restores the legacy behaviour in
 * which every path appends (so the oracle-comparison tests keep passing).
 *
 * Logs are technical; nothing here produces report text.
 */

export type HistoryWriter = 'buyPipeline' | 'dailyAutomation' | 'nightlySummary';

export interface HistoryPolicy {
  /** Which path appends. Default 'buyPipeline'. */
  readonly writer?: HistoryWriter;
  /** Parity flag: true = legacy, every path appends (duplicates). Default false. */
  readonly legacyDoubleAppend?: boolean;
}

export const DEFAULT_HISTORY_WRITER: HistoryWriter = 'buyPipeline';

export function mayAppendHistory(path: HistoryWriter, policy?: HistoryPolicy): boolean {
  if (policy?.legacyDoubleAppend === true) return true;
  return (policy?.writer ?? DEFAULT_HISTORY_WRITER) === path;
}

/** FL-9m (F6): structural row shape (AnalysedTicker satisfies it) so this module stays free of nightly imports. */
export interface DecisionRowLike {
  readonly ticker: string;
  readonly sets: readonly string[];
  readonly result: { readonly decision?: unknown } | null;
}

/** FL-9m (F6): the rows Decision History may record: watchlist tickers whose analysis produced a decision. */
export function watchlistDecisionRows<T extends DecisionRowLike>(rows: readonly T[]): Array<T & { readonly result: NonNullable<T['result']> }> {
  return rows.filter(
    (r): r is T & { readonly result: NonNullable<T['result']> } => r.sets.includes('watchlist') && r.result != null && !!r.result.decision,
  );
}

/** FL-9m (F7): technical log line (error level) and the plain report note for the rejected setting. */
export const DAILY_AUTOMATION_REJECTED_LOG =
  'history policy: writer "dailyAutomation" is not part of the nightly chain (runDailyAutomation does not run there); using "buyPipeline" so Decision History is still written once per ticker';
export const DAILY_AUTOMATION_REJECTED_NOTE =
  'The Decision History setting named a step that does not run in the nightly chain, so the Buy report step recorded the decisions instead.';

/**
 * FL-9m (F7): inside the nightly chain writer 'dailyAutomation' would mean nobody writes a row. Reject it and fall
 * back to the default writer. legacyDoubleAppend is left alone (every path appends, so rows are still written).
 */
export function normalizeNightlyHistoryPolicy(policy?: HistoryPolicy): { readonly policy: HistoryPolicy; readonly rejected: boolean } {
  if (policy?.writer === 'dailyAutomation' && policy.legacyDoubleAppend !== true) {
    return { policy: { ...policy, writer: DEFAULT_HISTORY_WRITER }, rejected: true };
  }
  return { policy: policy ?? {}, rejected: false };
}
