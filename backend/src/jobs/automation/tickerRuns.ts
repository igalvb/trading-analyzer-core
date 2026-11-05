/**
 * The interactive ticker runs of fullStockAnalysisV10_9.gs:
 *   runAnalysisV7FromMenu :555-600          (an HTML dialog, then runAnalysisV7(t, ladderStock, ladderOptions))
 *   runCompleteTickerAnalysisV7 :5877-5922  (an HTML dialog, then ...Continued)
 *   runCompleteTickerAnalysisV7Continued :5924-5962
 *
 * Dialogs -> CLI arguments: a `prompt` returns the answer (the dialog's choice, the
 * OTHER text, two ladder checkboxes) or null (the user closed the dialog = nothing
 * runs). An empty OTHER ticker alerts "Enter ticker" and runs nothing. A failure is
 * alerted with the real error AND logged.
 *
 * INJECTED: runOptionsAnalysis (runFullAnalysis, options file), runAnalysis (runAnalysisV7),
 * showPriceChart (showPriceChartV7), buildBottomLineSummary (buildBottomLineSummaryV7),
 * markRunStart (_runStartTimeV7 = Date.now(); see F-G8), alert, log, prompt.
 */

import type { Clock } from '../../core/context.ts';
import { resolveDialogTicker, type DialogSpec, type EntryPoint } from '../../reports/options/ui.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import type { LogFn, RunAnalysisFn } from './dailyAutomation.ts';
import { activeProfile } from '../../profile/active.ts';

/** Both dialogs' <select> (:561-565 and :5885-5889): profile `lists.pickers.stockMenu` (GENERIC_PLAN P2), OTHER last. */
export const TICKER_PICKER_CHOICES: readonly string[] = [...activeProfile().lists.pickers.stockMenu, 'OTHER'];

/** runAnalysisV7FromMenu's dialog; the title carries CONFIG_V7.version. */
export function stockMenuDialog(version: string): DialogSpec {
  return { title: 'Stock Analysis ' + version, width: 320, height: 320, choices: TICKER_PICKER_CHOICES, emptyManualMessage: 'Enter ticker', handler: 'runAnalysisV7' };
}

export const FULL_TICKER_DIALOG: DialogSpec = {
  title: 'Full Ticker Analysis', width: 320, height: 360, choices: TICKER_PICKER_CHOICES, emptyManualMessage: 'Enter ticker', handler: 'runCompleteTickerAnalysisV7Continued',
};

/** Menu handler -> backend entry point, in the style of MENU_ENTRY_POINTS (reports/options/ui.ts). Not merged there. */
export const AUTOMATION_ENTRY_POINTS: Readonly<Record<string, EntryPoint>> = {
  runDailyAutomationV7: { entry: 'workflow: nightly / cli: nightly', ported: 'FL-7g jobs/automation/dailyAutomation.ts runDailyAutomation' },
  installDailyTriggerV7: { entry: 'workflow: nightly cron', ported: 'FL-7g jobs/automation/schedule.ts LEGACY_DAILY_TRIGGER (data; replaced by the new nightly order)' },
  runAnalysisV7FromMenu: { entry: 'cli: ticker TICKER --stock-only [--ladder-stock] [--ladder-options]', ported: 'FL-7g jobs/automation/tickerRuns.ts runAnalysisFromMenu', note: 'dialog -> arguments; closing the dialog = no run; empty OTHER -> "Enter ticker"' },
  runCompleteTickerAnalysisV7: { entry: 'cli: ticker TICKER [--ladder-stock] [--ladder-options]', ported: 'FL-7g jobs/automation/tickerRuns.ts runCompleteTickerAnalysis', note: 'options + stock + chart + Bottom Line' },
  runCompleteTickerAnalysisV7Continued: { entry: 'cli: ticker TICKER [--ladder-stock] [--ladder-options]', ported: 'FL-7g jobs/automation/tickerRuns.ts runCompleteTickerAnalysisContinued', note: 'the server half of the dialog' },
};

export interface AnalysisResult {
  readonly fundResult?: unknown;
  readonly techPlan?: unknown;
  readonly decision?: unknown;
}

export interface OptionsPicks {
  readonly leapsCall?: unknown;
  readonly shortTermCall?: unknown;
}

export interface TickerRunDeps {
  readonly workbook: ReportWorkbook;
  readonly clock: Clock;
  /** Logger.log. */
  readonly log: LogFn;
  /** `_runStartTimeV7 = Date.now()` -- optional, see F-G8. */
  readonly markRunStart?: (startMs: number) => void;
  /** runFullAnalysis(ticker) (futuresStockAnalysisV3_3_11.gs). */
  readonly runOptionsAnalysis: (ticker: string) => Promise<OptionsPicks | null | undefined>;
  readonly runAnalysis: RunAnalysisFn<AnalysisResult>;
  /** showPriceChartV7(ticker, techPlan, decision, !!ladderStock, leapsCall). */
  readonly showPriceChart: (ticker: string, techPlan: unknown, decision: unknown, showLadder: boolean, recCall: unknown) => Promise<unknown>;
  /** buildBottomLineSummaryV7(ss, ticker, fundResult, techPlan, decision, leapsCall, shortTermCall). */
  readonly buildBottomLineSummary: (
    ss: ReportWorkbook, ticker: string, fundResult: unknown, techPlan: unknown, decision: unknown, leapsCall: unknown, shortTermCall: unknown,
  ) => Promise<unknown>;
}

const errMsg = (e: any): any => (e && e.message ? e.message : e);

/** runCompleteTickerAnalysisV7Continued (:5924-5962). The ticker is stringified as legacy does (F-G1). */
export async function runCompleteTickerAnalysisContinued(deps: TickerRunDeps, ticker: unknown, ladderStock?: unknown, ladderOptions?: unknown): Promise<void> {
  if (deps.markRunStart) deps.markRunStart(deps.clock.now());
  const t = String(ticker).toUpperCase().trim();
  if (!t) return;
  let optionsResult: OptionsPicks | null | undefined = null;
  try {
    optionsResult = await deps.runOptionsAnalysis(t);
  } catch (e) {
    deps.log('Full Ticker Analysis: options step failed for ' + t + ': ' + errMsg(e));
    // Non-fatal, as legacy: the dashboard's own banner handles "no options data".
  }
  const result = await deps.runAnalysis(
    t, ladderStock, ladderOptions,
    optionsResult ? optionsResult.leapsCall : null,
    optionsResult ? optionsResult.shortTermCall : null,
  );
  await deps.showPriceChart(t, result ? result.techPlan : null, result ? result.decision : null, !!ladderStock, optionsResult ? optionsResult.leapsCall : null);
  if (result) {
    try {
      await deps.buildBottomLineSummary(
        deps.workbook, t, result.fundResult, result.techPlan, result.decision,
        optionsResult ? optionsResult.leapsCall : null,
        optionsResult ? optionsResult.shortTermCall : null,
      );
    } catch (e) {
      deps.log('Bottom Line summary failed for ' + t + ': ' + errMsg(e));
    }
  }
}

export interface PickerAnswer {
  readonly choice: string;
  /** The OTHER text field. */
  readonly manual?: string;
  readonly ladderStock?: boolean;
  readonly ladderOptions?: boolean;
}

export type PickerOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'done'; readonly ticker: string }
  | { readonly status: 'failed'; readonly ticker: string; readonly message: string };

export interface MenuDeps {
  /** The dialog. null/undefined = the user closed it. On the CLI this is built from the arguments. */
  readonly prompt: (spec: DialogSpec) => Promise<PickerAnswer | null | undefined>;
  /** ui.alert / the dialog's alert(). */
  readonly alert: (message: string) => void;
  readonly log: LogFn;
  /** CONFIG_V7.version (the dialog title). */
  readonly version: string;
}

export interface StockMenuDeps extends MenuDeps {
  readonly runAnalysis: RunAnalysisFn<AnalysisResult>;
}

/** runAnalysisV7FromMenu (:555-600): the dialog, then runAnalysisV7(t, ladderStock, ladderOptions). */
export async function runAnalysisFromMenu(deps: StockMenuDeps): Promise<PickerOutcome> {
  const spec = stockMenuDialog(deps.version);
  const answer = await deps.prompt(spec);
  if (!answer) return { status: 'cancelled' };
  const picked = resolveDialogTicker(spec, answer.choice, answer.manual ?? '');
  if ('error' in picked) { deps.alert(picked.error); return { status: 'invalid', message: picked.error }; }
  const ticker = picked.ticker;
  try {
    await deps.runAnalysis(ticker, !!answer.ladderStock, !!answer.ladderOptions);
    return { status: 'done', ticker };
  } catch (e) {
    const message = 'Stock analysis for ' + ticker + ' did not finish. Real error: ' + errMsg(e) + '. Nothing further was run for this ticker.';
    deps.log('runAnalysisV7FromMenu failed for ' + ticker + ': ' + errMsg(e));
    deps.alert(message);
    return { status: 'failed', ticker, message };
  }
}

/** runCompleteTickerAnalysisV7 (:5877-5922): the dialog, then runCompleteTickerAnalysisV7Continued(t, ladderStock, ladderOptions). */
export async function runCompleteTickerAnalysis(deps: MenuDeps & TickerRunDeps): Promise<PickerOutcome> {
  const spec = FULL_TICKER_DIALOG;
  const answer = await deps.prompt(spec);
  if (!answer) return { status: 'cancelled' };
  const picked = resolveDialogTicker(spec, answer.choice, answer.manual ?? '');
  if ('error' in picked) { deps.alert(picked.error); return { status: 'invalid', message: picked.error }; }
  const ticker = picked.ticker;
  try {
    await runCompleteTickerAnalysisContinued(deps, ticker, !!answer.ladderStock, !!answer.ladderOptions);
    return { status: 'done', ticker };
  } catch (e) {
    const message = 'Full analysis for ' + ticker + ' did not finish. Real error: ' + errMsg(e) + '. The steps after the failing one were not run.';
    deps.log('runCompleteTickerAnalysisV7 failed for ' + ticker + ': ' + errMsg(e));
    deps.alert(message);
    return { status: 'failed', ticker, message };
  }
}
