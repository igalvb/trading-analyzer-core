/**
 * Watchlist stores of fullStockAnalysisV10_9.gs, onto ReportWorkbook:
 *   WATCHLIST_SHEET_V7 / WATCHLIST_SUMMARY_SHEET_V7 :399-400,
 *   getWatchlistTickersV7 :405-417, getOrCreateWatchlistSheetV7 :419-428,
 *   scanWatchlistV7 :9627-9659
 * (buildWatchlistSummarySheetV7 :433-452 was ported and then removed: owner 2026-11-04, the
 * '🎯 Watchlist Summary' tab is no longer written; WATCHLIST_SUMMARY_SHEET stays for routing and cleanup.)
 *
 * getWatchlistTickers is verbatim INCLUDING the CONFIG_V7.dailyTickers
 * fallback (passed in as `dailyTickers`). The Sheets-API reader
 * sheets/readers/watchlist.ts deliberately drops that fallback for the
 * nightly path; this one is the parity twin used by scanWatchlist (F-B6).
 *
 * scanWatchlist is approved to be folded into the Phase-5 Buy report (its
 * BUY_NOW-first, conviction-descending order becomes the report's sort);
 * runAnalysisV7 is an injected dependency, and the ticker source is injected
 * so the Buy report can pass the Sheets-API reader's result instead. It
 * stays sequential, as legacy (F-B7).
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import { Tabs } from '../sheets/tabs.ts';

export const WATCHLIST_SHEET = Tabs.WATCHLIST;
export const WATCHLIST_SUMMARY_SHEET = Tabs.WATCHLIST_SUMMARY;

/** The slice of runAnalysisV7's result that the scan reads. */
export interface ScanAnalysis {
  readonly decision?: { readonly fundBand?: unknown; readonly finalConviction?: number | null; readonly action?: unknown } | null;
  readonly techPlan?: { readonly timing?: unknown } | null;
}

export interface ScanRow {
  readonly ticker: string;
  readonly ownBand: unknown;
  readonly timing: unknown;
  readonly conviction: number | null | undefined;
  readonly action: unknown;
  readonly buyNow: boolean;
}

export interface ScanDeps {
  readonly workbook: ReportWorkbook;
  /** getWatchlistTickersV7(ss) -- or any other ticker source. */
  readonly getTickers: (ss: ReportWorkbook) => readonly string[] | null | undefined;
  /** runAnalysisV7(ticker, false, false): the real engine, no chart or options-ladder side effects. */
  readonly runAnalysis: (ticker: string, withChart: boolean, withOptionsLadder: boolean) => Promise<ScanAnalysis | null | undefined>;
  readonly log: (line: string) => void;
}

/** getWatchlistTickersV7 (:405-417): one ticker per row, deduped, falling back to CONFIG_V7.dailyTickers. */
export function getWatchlistTickers(ss: ReportWorkbook, dailyTickers: readonly string[] | undefined): readonly string[] {
  const sh = ss.getSheetByName(WATCHLIST_SHEET);
  if (!sh) return dailyTickers || [];
  const data = sh.getDataRange().getValues();
  const tickers: string[] = [];
  for (let r = 1; r < data.length; r++) {
    const t = String(data[r][0] || '').toUpperCase().trim();
    // §2.5.3 (legacy): deduped, a repeated ticker would be analysed twice for nothing.
    if (t && tickers.indexOf(t) === -1) tickers.push(t);
  }
  return tickers.length ? tickers : (dailyTickers || []);
}

/** getOrCreateWatchlistSheetV7 (:419-428). */
export function getOrCreateWatchlistSheet(ss: ReportWorkbook): ReportSheet {
  let sh = ss.getSheetByName(WATCHLIST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WATCHLIST_SHEET);
    sh.getRange(1, 1, 1, 1).setValues([['Ticker']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidth(1, 120);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * scanWatchlistV7 (:9627-9659): runs the engine across every watchlist
 * ticker, sequentially, and returns BUY_NOW first, then conviction
 * descending. Read-only: no dashboards, no mail. The legacy
 * `typeof getWatchlistTickersV7 === 'function'` guard (always true) is gone.
 */
export async function scanWatchlist(deps: ScanDeps): Promise<ScanRow[]> {
  const tickers = deps.getTickers(deps.workbook);
  const rows: ScanRow[] = [];
  for (const t of (tickers || [])) {
    try {
      const res = await deps.runAnalysis(t, false, false); // reuse the real engine; no chart/options ladder side-effects
      const d = res && res.decision ? res.decision : null;
      rows.push({
        ticker: t,
        ownBand: d ? d.fundBand : 'n/a',
        timing: (res && res.techPlan) ? res.techPlan.timing : 'n/a',
        conviction: d ? d.finalConviction : null,
        action: d ? d.action : 'n/a',
        buyNow: !!(res && res.techPlan && res.techPlan.timing === 'BUY_NOW'),
      });
    } catch (e) {
      rows.push({ ticker: t, ownBand: 'ERR', timing: 'ERR', conviction: null, action: String(e), buyNow: false });
    }
  }
  // Sort BUY_NOW first, then by conviction descending.
  rows.sort((a, b) => {
    if (a.buyNow !== b.buyNow) return a.buyNow ? -1 : 1;
    return (b.conviction || 0) - (a.conviction || 0);
  });
  deps.log('Watchlist scan (' + rows.length + ' tickers):');
  rows.forEach((r) => {
    deps.log('  ' + r.ticker + '  [' + r.ownBand + ']  ' + r.timing + '  conv=' + (r.conviction != null ? r.conviction : 'n/a') + '  ' + r.action);
  });
  return rows;
}
