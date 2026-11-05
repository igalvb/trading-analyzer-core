/**
 * runDailyAutomationV7 (fullStockAnalysisV10_9.gs:459-553): the nightly watchlist run.
 *
 * Order, as legacy: ensure the Watchlist tab (seed it from dailyTickers when it holds
 * only the header), read the tickers, refresh the market-wide macro snapshot ONCE, then
 * per ticker: broker-data refresh, last decision (read BEFORE this run writes), the
 * full analysis, a Decision History row, change detection. Then ONE digest email only
 * if some action changed. Legacy's ranked '🎯 Watchlist Summary' tab is no longer written
 * (owner 2026-11-04, backlog row 39).
 *
 * INJECTED (nothing here is fetched directly):
 *   runAnalysis                   runAnalysisV7, called with ONE argument (ticker), as legacy
 *   refreshMacroSnapshot          refreshMacroSnapshotV1_(Logger.log)     -> fetch/macro/refresh.ts
 *   refreshBrokerCourseDataCache  refreshBrokerCourseDataCacheV1_(t, log) -> fetch/macro/refresh.ts
 *   sendEmail / getEffectiveUserEmail   MailApp / Session.getEffectiveUser().getEmail()
 *   alertEmail                    CONFIG_V7.alertEmail ('' in legacy); dailyTickers = CONFIG_V7.dailyTickers
 * The two legacy `typeof X === 'function'` guards (:494, :511) are always true in
 * legacy and are lifted: both are required inputs.
 *
 * The legacy 4.5 min guard (:481-482) is kept as written, driven by the injected clock:
 * before each ticker, if elapsed + 60 s > 270 s the rest are skipped and reported.
 * It is a different check from hasTimeBudgetV7_. The only addition is the optional
 * tickerTimeoutMs: a hung analysis becomes the same "Daily automation error" row.
 */

import type { Clock } from '../../core/context.ts';
import { TimeoutError } from '../../core/errors.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import { appendDecisionHistory, getLastDecision } from '../../stores/decisionHistory.ts';
import { mayAppendHistory } from '../history/historyPolicy.ts';
import type { HistoryPolicy } from '../history/historyPolicy.ts';
import { getOrCreateWatchlistSheet, getWatchlistTickers } from '../../stores/watchlist.ts';

export const AUTOMATION_TIME_BUDGET_MS = 4.5 * 60 * 1000;
export const CONSERVATIVE_PER_TICKER_MS = 60 * 1000;

export interface DailyAnalysisResult {
  readonly fundResult: { readonly score: unknown };
  readonly techPlan: { readonly techScore: unknown; readonly regime: unknown };
  readonly decision?: { readonly finalConviction: number; readonly action: unknown } | null;
}

/** runAnalysisV7(ticker, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg) -- the exact legacy signature. */
export type RunAnalysisFn<R = unknown> = (
  ticker: string, ladderStock?: unknown, ladderOptions?: unknown, leapsCallArg?: unknown, shortTermCallArg?: unknown,
) => Promise<R | null | undefined>;

export type LogFn = (line: string) => void;

export interface DailyAutomationDeps {
  readonly workbook: ReportWorkbook;
  /** CONFIG_V7.dailyTickers. */
  readonly dailyTickers: readonly string[] | undefined;
  /** CONFIG_V7.alertEmail ('' in legacy). */
  readonly alertEmail: string;
  readonly clock: Clock;
  /** The zone the summary's timestamps are printed in. */
  readonly timeZone: string;
  /** Logger.log. */
  readonly log: LogFn;
  readonly refreshMacroSnapshot: (log: LogFn) => Promise<void>;
  readonly refreshBrokerCourseDataCache: (ticker: string, log: LogFn) => Promise<void>;
  readonly runAnalysis: RunAnalysisFn<DailyAnalysisResult>;
  readonly sendEmail: (to: string, subject: string, body: string) => Promise<void>;
  readonly getEffectiveUserEmail: () => Promise<string>;
  /** Default AUTOMATION_TIME_BUDGET_MS. Infinity turns the skip logic off. */
  readonly timeBudgetMs?: number;
  /** Default CONSERVATIVE_PER_TICKER_MS. */
  readonly perTickerEstimateMs?: number;
  /** Optional per-analysis timeout (replaces the 6-minute cap). */
  readonly tickerTimeoutMs?: number;
  /** F-P4: who writes Decision History. Default: the Buy pipeline, so this path only reads. legacyDoubleAppend:true = legacy. */
  readonly historyPolicy?: HistoryPolicy;
}

interface DecisionChange {
  readonly ticker: string;
  readonly from: any;
  readonly to: any;
  readonly finalConviction: number;
}

const errMsg = (e: any): any => (e && e.message ? e.message : e);

function withTimeout<T>(p: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (ms == null) return p;
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

export async function runDailyAutomation(deps: DailyAutomationDeps): Promise<void> {
  const ss = deps.workbook;
  const log = deps.log;
  const watchlistSheet = getOrCreateWatchlistSheet(ss);
  if (watchlistSheet.getLastRow() <= 1) { // only the header row present -> genuinely new
    const seed = deps.dailyTickers || [];
    if (seed.length) watchlistSheet.getRange(2, 1, seed.length, 1).setValues(seed.map((t) => [t]));
  }
  const tickers = getWatchlistTickers(ss, deps.dailyTickers);
  const changes: DecisionChange[] = [];
  const budgetMs = deps.timeBudgetMs ?? AUTOMATION_TIME_BUDGET_MS;
  const perTickerMs = deps.perTickerEstimateMs ?? CONSERVATIVE_PER_TICKER_MS;
  const startTime = deps.clock.now();
  const skipped: string[] = [];
  await deps.refreshMacroSnapshot(log); // not wrapped, as legacy (F-G5)
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const elapsed = deps.clock.now() - startTime;
    if (elapsed + perTickerMs > budgetMs) {
      skipped.push(...tickers.slice(i));
      log('⚠ Time budget guard: stopping after ' + i + '/' + tickers.length + ' tickers (elapsed ' + Math.round(elapsed / 1000) + 's) — skipped: ' + skipped.join(', '));
      break;
    }
    try {
      await deps.refreshBrokerCourseDataCache(ticker, log);
      const prior = getLastDecision(ss, ticker); // read BEFORE this run's write
      const result = await withTimeout(Promise.resolve(deps.runAnalysis(ticker)), deps.tickerTimeoutMs, 'runAnalysis ' + ticker);
      if (!result || !result.decision) continue;
      if (mayAppendHistory('dailyAutomation', deps.historyPolicy)) {
        appendDecisionHistory(ss, ticker, result.fundResult, result.techPlan, result.decision, deps.clock.now());
      }
      if (prior && prior.action !== result.decision.action) {
        changes.push({ ticker, from: prior.action, to: result.decision.action, finalConviction: result.decision.finalConviction });
      }
    } catch (e) {
      log('Daily automation error for ' + ticker + ': ' + errMsg(e));
    }
  }
  if (changes.length > 0) { // silent when nothing changed
    const body = changes.map((c) => c.ticker + ': ' + c.from + '  →  ' + c.to + '  (Final Conviction ' + c.finalConviction + '/100)').join('\n');
    const recipient = deps.alertEmail || (await deps.getEffectiveUserEmail());
    if (!recipient) {
      log('❌ ALERT FAILED: no email recipient resolved (CONFIG_V7.alertEmail is blank and getEffectiveUser() returned empty) — set CONFIG_V7.alertEmail to guarantee delivery. Decision change was: ' + body);
    } else {
      try {
        await deps.sendEmail(recipient, '[v7] Decision change: ' + changes.map((c) => c.ticker).join(', '), body);
      } catch (e) {
        log('Failed to send digest email to ' + recipient + ': ' + errMsg(e));
      }
    }
  }
}
