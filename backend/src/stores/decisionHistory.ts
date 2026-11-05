/**
 * Decision history (fullStockAnalysisV10_9.gs): the append-only change log
 * the daily automation diffs against.
 *   DECISION_HISTORY_SHEET_V7 / _HEADERS_V7 :323-324,
 *   getOrCreateDecisionHistorySheetV7 :346-366, getLastDecisionV7 :370-380,
 *   appendDecisionHistoryV7 :383-386
 *
 * Needs ReportSheet.appendRow (Apps Script: a new row after the last row
 * that holds content). The Date column is written as a Date; on the Sheets
 * backend it arrives as a serial number with no number format (F-B3).
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import type { TabCell } from '../storage/tabStore.ts';
import { Tabs } from '../sheets/tabs.ts';

export const DECISION_HISTORY_SHEET = Tabs.DECISION_HISTORY;
export const DECISION_HISTORY_HEADERS: readonly string[] = ['Date', 'Ticker', 'OWN', 'TIMING Score', 'Final Conviction', 'Action'];

export interface LastDecision {
  readonly date: TabCell;
  readonly ticker: TabCell;
  readonly own: TabCell;
  readonly timing: TabCell;
  readonly finalConviction: TabCell;
  readonly action: TabCell;
}

/**
 * getOrCreateDecisionHistorySheetV7 (:346-366). P2-3 (legacy): row 1 is
 * checked on EVERY call, not only when the tab is new, so a cleared tab gets
 * its headers back before appendRow could put a decision on row 1.
 */
export function getOrCreateDecisionHistorySheet(ss: ReportWorkbook): ReportSheet {
  let sh = ss.getSheetByName(DECISION_HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DECISION_HISTORY_SHEET);
  }
  const row1 = sh.getRange(1, 1, 1, DECISION_HISTORY_HEADERS.length).getValues()[0];
  const headersPresent = row1[0] === DECISION_HISTORY_HEADERS[0];
  if (!headersPresent) {
    sh.getRange(1, 1, 1, DECISION_HISTORY_HEADERS.length).setValues([DECISION_HISTORY_HEADERS]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidths(1, DECISION_HISTORY_HEADERS.length, 130);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** getLastDecisionV7 (:370-380): the most recent PRIOR row for this ticker, read BEFORE today's is written. */
export function getLastDecision(ss: ReportWorkbook, ticker: string): LastDecision | null {
  const sh = ss.getSheetByName(DECISION_HISTORY_SHEET);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][1]).toUpperCase() === ticker.toUpperCase()) {
      return { date: data[r][0], ticker: data[r][1], own: data[r][2], timing: data[r][3], finalConviction: data[r][4], action: data[r][5] };
    }
  }
  return null;
}

/** appendDecisionHistoryV7 (:383-386): append-only, never edits a past row. `nowMs` replaces `new Date()`. */
export function appendDecisionHistory(
  ss: ReportWorkbook,
  ticker: string,
  fundResult: { readonly score: unknown },
  techPlan: { readonly techScore: unknown },
  decision: { readonly finalConviction: unknown; readonly action: unknown },
  nowMs: number,
): void {
  const sh = getOrCreateDecisionHistorySheet(ss);
  sh.appendRow([new Date(nowMs), ticker, fundResult.score, techPlan.techScore, decision.finalConviction, decision.action]);
}
