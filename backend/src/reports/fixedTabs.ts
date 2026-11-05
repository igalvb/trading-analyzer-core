/**
 * Phase 1 of docs/SHEETS_CLEANUP_PLAN.md, section (c): the fixed analysis tabs.
 *
 * Every analyze run (Telegram /analyze, the Analyze workflow, `npm run ticker`, `npm run analyze-report`)
 * writes the same 20 tabs, whatever the ticker. So that a page left over from an earlier ticker is never
 * read as this ticker's page:
 *   1. at the start of the run every fixed tab gets a FULL clear (values, formats and merges -- F-84) and
 *      one title line naming the ticker and the run time. On 📊 Analysis v7 the line keeps the
 *      '📊 TICKER —' prefix that ops/priceChart.ts (and `cli chart` without a ticker) read the ticker from;
 *   2. the run then overwrites the pages it produces. The "produced" set is every fixed tab the run
 *      wrote after the reset; the PDF (analyzeReport.ts reportHtml) uses only that set, so it lists
 *      exactly the pages it listed before phase 1;
 *   3. row 1 of every produced page names the ticker and the run time: most writers already put both
 *      there; where the time (or the ticker) is missing it is added to row 1 (stampRunLine).
 * The workbook is still written once, at the end of the run. Legacy-parity mode never calls this module
 * (it keeps the old per-ticker names; see bottomLineTabName / priceChartTabName).
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import { ANALYSIS_TAB, MODEL_TABS } from '../analysis/runTicker.ts';
import { OptionsTabs } from './options/tabs.ts';
import { BOTTOM_LINE_TAB } from './bottomLine/summarySheet.ts';
import { PRICE_CHART_TAB } from '../ops/priceChart.ts';

/** The 30 fixed analysis tabs, in reading order (the PDF order, then the chart and the PUT Table); James's pages follow LILO (Market Maker Stages follows 🏛️ Wyckoff, which it is built on). */
export const FIXED_ANALYSIS_TABS: readonly string[] = [
  BOTTOM_LINE_TAB, MODEL_TABS.allModels, ANALYSIS_TAB,
  MODEL_TABS.broker, MODEL_TABS.schabacker, MODEL_TABS.edwardsMagee, MODEL_TABS.turtle,
  MODEL_TABS.wyckoff, MODEL_TABS.marketMaker, MODEL_TABS.trend, MODEL_TABS.combo, MODEL_TABS.lilo, MODEL_TABS.liloV2, MODEL_TABS.profitTaking, MODEL_TABS.meanReversion, MODEL_TABS.pair, MODEL_TABS.winners, MODEL_TABS.cycle, MODEL_TABS.qualityGate, MODEL_TABS.comparison,
  MODEL_TABS.optionsDecision, MODEL_TABS.jamesLeaps, MODEL_TABS.jamesFairValue,
  OptionsTabs.DASHBOARD, OptionsTabs.TOP10, OptionsTabs.CALLS, OptionsTabs.BUCKETS, OptionsTabs.GAMMA,
  PRICE_CHART_TAB, OptionsTabs.PUTS,
];

/** The run time as the report headers print it (options tabs, Bottom Line, Analysis v7): '10/29/2026, 3:00:00 PM'. */
export function runTimeText(nowMs: number, timeZone: string): string {
  return new Date(nowMs).toLocaleString('en-US', { timeZone });
}

/** The reset line: '📊 TSLA — not produced in the run of 10/29/2026, 3:00:00 PM; details in the 🔬 Log'. */
export function notProducedLine(ticker: string, runTime: string): string {
  return '📊 ' + ticker + ' — not produced in the run of ' + runTime + '; details in the 🔬 Log';
}

/** What the reset left: each fixed tab and how many calls it had then, so the run's own writes can be told apart. */
export interface FixedTabsReset {
  readonly ticker: string;
  readonly runTime: string;
  readonly marks: ReadonlyMap<string, number>;
}

/** Step 1: a full clear of every fixed tab (created when missing) and the title line in A1. */
export function resetFixedAnalysisTabs(wb: ReportWorkbook, ticker: string, nowMs: number, timeZone: string): FixedTabsReset {
  const runTime = runTimeText(nowMs, timeZone);
  const marks = new Map<string, number>();
  for (const name of FIXED_ANALYSIS_TABS) {
    const sh = wb.getSheetByName(name) ?? wb.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1).setValue(notProducedLine(ticker, runTime));
    marks.set(name, sh.calls.length);
  }
  return { ticker, runTime, marks };
}

/** Step 2: the fixed tabs the run wrote after the reset, in FIXED_ANALYSIS_TABS order. */
export function producedTabs(wb: ReportWorkbook, reset: FixedTabsReset): Set<string> {
  const out = new Set<string>();
  for (const [name, mark] of reset.marks) {
    const sh = wb.getSheetByName(name);
    if (sh && sh.calls.length > mark) out.add(name);
  }
  return out;
}

const HAS_TIME = /\b\d{1,2}:\d{2}\b/;

function rowOneText(sh: ReportSheet): string[] {
  return (sh.grid()[0] ?? []).map((v) => String(v ?? ''));
}

/** True when row 1 names the ticker and a time of day. */
export function rowOneNamesRun(sh: ReportSheet, ticker: string): boolean {
  const cells = rowOneText(sh);
  return cells.some((c) => c.includes(ticker)) && cells.some((c) => HAS_TIME.test(c));
}

/**
 * Step 3: row 1 of a produced page names the ticker and the run time. A title in A1 that names the ticker
 * gets '   |   <run time>' appended; a page whose row 1 is a table header (the price chart's Date/Close/...)
 * gets a title two columns to the right of its last column (above the chart). Pages that already name both
 * are left alone.
 */
export function stampRunLine(wb: ReportWorkbook, produced: ReadonlySet<string>, reset: FixedTabsReset): void {
  for (const name of produced) {
    const sh = wb.getSheetByName(name);
    if (!sh || rowOneNamesRun(sh, reset.ticker)) continue;
    const a1 = rowOneText(sh)[0] ?? '';
    if (a1.includes(reset.ticker)) sh.getRange(1, 1).setValue(a1 + '   |   ' + reset.runTime);
    else sh.getRange(1, sh.getLastColumn() + 2).setValue(reset.ticker + ' — ' + name + '   |   ' + reset.runTime);
  }
}

/** After the run, before the flush: the produced set, with row 1 of each produced page stamped. */
export function finishFixedAnalysisTabs(wb: ReportWorkbook, reset: FixedTabsReset): Set<string> {
  const produced = producedTabs(wb, reset);
  stampRunLine(wb, produced, reset);
  return produced;
}
