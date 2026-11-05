/**
 * The options file's menus, dialogs and sheet lock, ported from
 * futuresStockAnalysisV3_3_11.gs:
 *   onOpen :46-95, selectTickerAndRun :100-163, showRecommendedCallV7 :538-568,
 *   lockAllSheets :1573-1578, unlockAllSheets :1580-1585, sheetGuardian :1592-1605
 *
 * A Node backend has no spreadsheet UI: menus become CLI commands / workflow
 * entry points (LEGACY_MENUS + MENU_ENTRY_POINTS, the mapping table of the
 * FL-6b handback), the two HTML dialogs become a ticker argument with the
 * same choices and validation (resolveDialogTicker). lockAllSheets /
 * unlockAllSheets work on a ReportWorkbook; sheetGuardian is an Apps Script
 * edit trigger and cannot run here -- it is kept, working on the same event
 * shape, for a thin Apps Script shim if the user wants the lock kept (F-73).
 */

import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { DEFAULT_TICKER } from './tabs.ts';
import { activeProfile } from '../../profile/active.ts';

/** A menu item [label, legacy handler], or null for a separator. */
export type MenuItem = readonly [string, string] | null;

export interface LegacyMenu {
  readonly menu: string;
  readonly items: readonly MenuItem[];
}

/** onOpen (:46-95), item for item. */
export const LEGACY_MENUS: readonly LegacyMenu[] = [
  {
    menu: '🚀 Options Analysis',
    items: [
      ['▶ Run Analysis (Default: ' + DEFAULT_TICKER + ')', 'runFullAnalysis'], ['📊 Select Ticker & Run', 'selectTickerAndRun'], null,
      ['📞 Find Recommended Call', 'showRecommendedCallV7'], null, ['🔬 Diagnose API connection', 'diagnose'],
    ],
  },
  {
    menu: '📈 Stock Analysis',
    items: [
      ['🚀 Full Ticker Analysis (Options + Stock + Chart)', 'runCompleteTickerAnalysisV7'], ['📊 Run Stock Analysis (v7)', 'runAnalysisV7FromMenu'],
      ['📊 Show Price Chart', 'showPriceChartV7'], null,
      ['📤 Build Exit Strategy Report', 'buildExitStrategyReportV7Menu'], ['⏰ Install Exit Strategy Nightly Trigger (~1am)', 'installExitStrategyTriggerV1'], null,
      ['🎯 Run Watchlist / Daily Check Now', 'runDailyAutomationV7'], ['⏰ Install Daily Auto-Run Trigger', 'installDailyTriggerV7'], null,
      ['🔑 Check API Keys Configured', 'checkApiKeysConfiguredV7'], ['🧹 Clean Up Old Price Caches', 'cleanupPriceCacheSheetsV1Menu'],
      ['🔍 Diagnose Sheet Size (read-only)', 'diagnoseSheetSizeV1Menu'], null,
      ['📖 Build Methodology Sheet', 'buildMethodologySheetV7'], ['❓ What do these do?', 'showMenuHelpV7'],
    ],
  },
  { menu: '🔒 Master Lock', items: [['🔓 Unlock All Sheets (Deep Clean)', 'unlockAllSheets'], ['🔒 Lock All Sheets', 'lockAllSheets']] },
];

export interface EntryPoint {
  /** The backend command or job that replaces the menu item. */
  readonly entry: string;
  /** Where the logic is ported (or will be). */
  readonly ported: string;
  readonly note?: string;
}

/** Every menu handler -> its backend entry point. */
export const MENU_ENTRY_POINTS: Readonly<Record<string, EntryPoint>> = {
  runFullAnalysis: { entry: 'cli: options [TICKER] (default TSLA)', ported: 'FL-6b reports/options/run.ts runFullAnalysis' },
  selectTickerAndRun: { entry: 'cli: options TICKER', ported: 'FL-6b ui.ts resolveDialogTicker', note: 'the HTML dialog becomes the TICKER argument; same choices and validation' },
  showRecommendedCallV7: { entry: 'cli: options-call TICKER', ported: 'FL-6b ui.ts resolveDialogTicker + run.ts recommendedCallReport', note: 'ui.alert text printed to stdout' },
  diagnose: { entry: 'cli: options-diagnose', ported: 'FL-6b run.ts diagnose' },
  runCompleteTickerAnalysisV7: { entry: 'cli: ticker TICKER (Phase 5 ticker mode)', ported: 'FL-7g jobs/automation/tickerRuns.ts runCompleteTickerAnalysis + runCompleteTickerAnalysisContinued', note: 'dialog -> TICKER argument + --ladder-stock / --ladder-options; closing the dialog = no run; empty OTHER -> "Enter ticker"' },
  runAnalysisV7FromMenu: { entry: 'cli: ticker TICKER --stock-only', ported: 'FL-7g jobs/automation/tickerRuns.ts runAnalysisFromMenu; pipeline = Phase 3-5 + FL-7 wiring', note: 'dialog -> TICKER argument + --ladder-stock / --ladder-options' },
  showPriceChartV7: { entry: 'cli: chart TICKER', ported: 'FL-7c1 ops/priceChart.ts showPriceChart + ops/priceChartHtml.ts', note: 'writes out/<TICKER>-chart.html' },
  buildExitStrategyReportV7Menu: { entry: 'cli: exit-report', ported: 'app/menuCommands.ts: the nightly exit.report job alone (Exit pipeline -> Exit sheet)', note: 'the FL-7f port of the old Exit Strategy tab writer was removed (owner 2026-11-04, backlog row 39)' },
  analyzePositionV7: { entry: 'cli: position TICKER ENTRY_PRICE ENTRY_DATE', ported: 'FL-J portfolio/positions/analyzePosition.ts analyzePosition', note: 'not a menu item (run from the script editor); the 3 arguments become CLI arguments (price via Number()), the alert text is the returned alert; F-J1: legacy throws for any position not stop-hit or thesis-invalidated' },
  installExitStrategyTriggerV1: { entry: 'workflow: nightly cron (schedule set by the workflow generator)', ported: 'FL-7f reports/exit/schedule.ts EXIT_STRATEGY_LEGACY_TRIGGER', note: 'legacy 01:00 is superseded; trigger installer -> declarative cron' },
  runDailyAutomationV7: { entry: 'workflow: nightly / cli: nightly', ported: 'FL-7g jobs/automation/dailyAutomation.ts runDailyAutomation' },
  installDailyTriggerV7: { entry: 'workflow: nightly cron', ported: 'FL-7g jobs/automation/schedule.ts LEGACY_DAILY_TRIGGER (data only; the new nightly order replaces it)', note: 'trigger installer -> declarative cron' },
  checkApiKeysConfiguredV7: { entry: 'cli: check-keys', ported: 'FL-7c1 ops/apiKeys.ts checkApiKeysConfigured', note: 'env presence check, names only; smoke (src/smoke.ts) stays the connectivity check' },
  cleanupPriceCacheSheetsV1Menu: { entry: 'cli: cleanup-price-caches [--yes]', ported: 'FL-7c1 ops/priceCaches.ts cleanupPriceCacheSheets', note: 'a dry run unless --yes' },
  diagnoseSheetSizeV1Menu: { entry: 'cli: sheet-size', ported: 'FL-7c1 ops/sheetSize.ts diagnoseSheetSize' },
  buildMethodologySheetV7: { entry: 'cli: methodology', ported: 'FL-7c1 ops/methodology.ts buildMethodologySheet' },
  showMenuHelpV7: { entry: 'cli: help', ported: 'FL-7c1 ops/menuHelp.ts cliHelpText', note: 'lists the CLI commands instead of menu items; menuHelpHtml keeps the legacy dialog' },
  unlockAllSheets: { entry: 'cli: unlock-sheets', ported: 'FL-9e sheets/masterLock.ts unlockAllTabs (npm run unlock-sheets)', note: 'normally done in code around the writes (withUnlockedSheets); the command is the manual deep-clean' },
  lockAllSheets: { entry: 'cli: lock-sheets', ported: 'FL-9e sheets/masterLock.ts lockAllTabs (npm run lock-sheets)', note: 'onOpen ran it on every open; there is no "open" in the backend (F-73), so every workflow runs it last under if: always()' },
};

/** selectTickerAndRun's <select> (:113-127): profile `lists.pickers.runDialog` (GENERIC_PLAN P2), OTHER last. */
export const RUN_DIALOG_CHOICES: readonly string[] = [...activeProfile().lists.pickers.runDialog, 'OTHER'];
/** showRecommendedCallV7's <select> (:549-554): profile `lists.pickers.callDialog`, OTHER last. */
export const CALL_DIALOG_CHOICES: readonly string[] = [...activeProfile().lists.pickers.callDialog, 'OTHER'];

export interface DialogSpec {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly choices: readonly string[];
  /** The alert when OTHER is picked with an empty manual ticker. */
  readonly emptyManualMessage: string;
  /** The server function the dialog called. */
  readonly handler: string;
}

export const RUN_DIALOG: DialogSpec = { title: 'Select Ticker', width: 320, height: 280, choices: RUN_DIALOG_CHOICES, emptyManualMessage: 'Please enter a ticker symbol.', handler: 'runFullAnalysis' };
export const CALL_DIALOG: DialogSpec = { title: 'Recommended Call', width: 320, height: 240, choices: CALL_DIALOG_CHOICES, emptyManualMessage: 'Enter ticker', handler: 'showRecommendedCallV7Continued' };

/** The dialogs' run() logic: a listed ticker as is; OTHER -> the manual entry, upper-cased and trimmed. */
export function resolveDialogTicker(dialog: DialogSpec, choice: string, manual = ''): { readonly ticker: string } | { readonly error: string } {
  let ticker = choice;
  if (ticker === 'OTHER') {
    ticker = manual.toUpperCase().trim();
    if (!ticker) return { error: dialog.emptyManualMessage };
  }
  return { ticker };
}

export const LOCK_TAB_COLOR = '#d50000';

/** lockAllSheets (:1573-1578): every tab red, and a toast. */
export function lockAllSheets(ss: ReportWorkbook): void {
  ss.getSheets().forEach((sh) => sh.setTabColor(LOCK_TAB_COLOR));
  ss.toast('🔒 HARD LOCK ACTIVE', 'Security');
}

/** unlockAllSheets (:1580-1585): every tab colour cleared, and a toast. */
export function unlockAllSheets(ss: ReportWorkbook): void {
  ss.getSheets().forEach((sh) => sh.setTabColor(null));
  ss.toast('🔓 UNLOCKED', 'Security');
}

/** The onEdit event fields sheetGuardian reads. */
export interface EditEvent {
  readonly range?: { getSheet(): Pick<ReportSheet, 'getTabColor'>; clearContent(): unknown; setValue(v: unknown): unknown } | null;
  readonly oldValue?: unknown;
}

/** sheetGuardian (:1592-1605): on a red (locked) tab, revert the edit. */
export function sheetGuardian(e: EditEvent | null | undefined, ss: Pick<ReportWorkbook, 'toast'>): void {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getTabColor() === LOCK_TAB_COLOR) {
    if (e.oldValue === undefined) e.range.clearContent();
    else e.range.setValue(e.oldValue);
    ss.toast('🛑 LOCKED: Use menu to unlock.', 'Security', 2);
  }
}
