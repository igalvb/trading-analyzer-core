/**
 * analyzePositionV7 (fullStockAnalysisV10_9.gs:9846-9883): the single-ticker
 * "I already own this, now what?" tool. Legacy ran it from the script editor
 * (analyzePositionV7('TICKER', entryPrice, 'YYYY-MM-DD')); it is in no menu
 * and has no prompt. Its only UI is one alert, on an input problem.
 *
 * Mapping to the backend (in the style of reports/options/ui.ts):
 *   the three arguments  -> CLI arguments: position TICKER ENTRY_PRICE ENTRY_DATE
 *                           (the CLI converts ENTRY_PRICE with Number(); legacy
 *                           refuses a non-number, so a bad one is an alert)
 *   getUi().alert(text)  -> the returned { status: 'alert', alert } for the CLI to print
 *   the tab write        -> ReportWorkbook, call for call (the caller flushes)
 *
 * INJECTED (not ported here):
 *   deps.fetchChart = fetchYahooChart. Legacy passes no chart, so the fetch
 *   happens inside computePositionExitReadV1_, only AFTER the entry price
 *   passed its check; reproduced (a bad price never fetches).
 * The read itself is analysis/exitRead.ts computePositionExitRead (:9772-9844).
 *
 * ══ F-J1: LEGACY CRASHES WHEN THE POSITION IS NOT STOPPED OUT ══════════
 * The RECOMMENDATION colour expression uses hitT1 and hitT2, which this
 * function never declares (it reads r.hitT1 nowhere). For stopBreached or
 * thesisInvalidated the expression short-circuits and works; for every other
 * position (HOLD, T1, T2) it throws "ReferenceError: hitT1 is not defined"
 * after the rows are written and the row is bolded. No background and no
 * column resize happen, and the error is uncaught.
 * FIXED by default (integration pass, rule "default = fixed"): the colour the
 * line meant (r.hitT1 || r.hitT2 -> yellow, else green). The parity flag
 * legacyHitReferenceError: true reproduces legacy's throw (oracle tests).
 *
 * An existing tab gets clearContents() only, so earlier formatting stays (F-J4; legacy-parity only:
 * the fixed tab below gets a full clear).
 *
 * Phase 1 (docs/SHEETS_CLEANUP_PLAN.md (c)): the tab is '📌 Position' whatever the ticker, and row 1
 * names the ticker (and the run time when given), so the rows start on row 2. Legacy-parity mode
 * (legacyHitReferenceError, or legacyTabName) keeps '📌 Position — TICKER' and legacy's rows exactly.
 */

import type { Chart } from '../../types/chart.ts';
import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { computePositionExitRead, type PositionExitRead } from '../../analysis/exitRead.ts';

/** The fixed tab name (phase 1). */
export const POSITION_TAB = '📌 Position';
/** Legacy's per-ticker name: POSITION_SHEET_PREFIX + ticker (legacy-parity only). */
export const POSITION_SHEET_PREFIX = '📌 Position — ';

/** The position tab's name: fixed, or legacy's per-ticker name in legacy-parity mode. */
export function positionTabName(ticker: string, legacy = false): string {
  return legacy ? POSITION_SHEET_PREFIX + ticker : POSITION_TAB;
}
/** Stop hit or thesis invalidated. */
export const POSITION_BG_EXIT = '#ffcdd2';
/** A target was reached (no stop or thesis problem). Only reachable with fixHitReferenceError. */
export const POSITION_BG_PARTIAL = '#fff9c4';
/** Nothing to act on. Only reachable with fixHitReferenceError. */
export const POSITION_BG_HOLD = '#c8e6c9';

export interface WriteOptions {
  /** Technical log lines (legacy logs nothing here). */
  readonly log?: (line: string) => void;
  /** F-J1. Default true (fixed). */
  readonly fixHitReferenceError?: boolean;
  /** F-J1 parity flag: true = legacy's "hitT1 is not defined" throw (oracle tests). */
  readonly legacyHitReferenceError?: boolean;
  /** Phase 1: true = legacy's per-ticker tab and no title row. Default: legacyHitReferenceError (the parity flag). */
  readonly legacyTabName?: boolean;
  /** The run time for the title row (row 1), e.g. '10/29/2026, 3:00:00 PM'. Not used in legacy mode. */
  readonly runTime?: string;
}

export interface AnalyzePositionDeps extends WriteOptions {
  /** fetchYahooChart. Null = the fetch failed. */
  readonly fetchChart: (ticker: string) => Promise<Chart | null> | Chart | null;
  /** F-X1 parity: true = targets judged against the past peak, as legacy did. Default false = forward-looking. */
  readonly legacyHistoricalTargets?: boolean;
}

export type PositionBook = Pick<ReportWorkbook, 'getSheetByName' | 'insertSheet'>;
export type PositionCell = string | number;

/** The fields of the read that the tab needs. */
export type PositionTabRead = Pick<PositionExitRead,
  'cp' | 'unrealizedPct' | 'daysHeld' | 'highestHighSinceEntry' | 'chandelierSinceEntry' | 'stopBreached'
  | 'classicalTrailing' | 'turtlePyramid' | 't1' | 't2' | 'hitT1' | 'hitT2' | 'thesisInvalidated'
  | 'recommendation' | 'reason' | 'distanceToT1Pct' | 'distanceToT2Pct'>;

export type AnalyzePositionResult =
  | { readonly status: 'alert'; readonly alert: string }
  | {
    readonly status: 'written';
    readonly sheetName: string;
    /** false = the tab existed and was cleared (clearContents). */
    readonly created: boolean;
    readonly rows: readonly (readonly PositionCell[])[];
    /** 1-based row of RECOMMENDATION. */
    readonly recommendationRow: number;
    readonly background: string;
    readonly read: PositionTabRead;
  };

/** The colour the legacy expression intended (see F-J1). */
export function positionBackground(r: Pick<PositionTabRead, 'stopBreached' | 'thesisInvalidated' | 'hitT1' | 'hitT2'>): string {
  return r.stopBreached || r.thesisInvalidated ? POSITION_BG_EXIT : r.hitT1 || r.hitT2 ? POSITION_BG_PARTIAL : POSITION_BG_HOLD;
}

/** The twelve [label, value] rows, as legacy built them. Truthiness checks are kept: a target of 0 reads N/A. */
export function positionRows(entryPrice: number, entryDateStr: string, r: PositionTabRead): PositionCell[][] {
  const { cp, unrealizedPct, daysHeld, highestHighSinceEntry, chandelierSinceEntry, classicalTrailing, turtlePyramid, t1, t2 } = r;
  const fwd = r.distanceToT1Pct !== undefined || r.distanceToT2Pct !== undefined;
  const away = (d: number | null | undefined): string => (d == null ? '' : d > 0 ? ' (' + d.toFixed(1) + '% above the current price)' : ' (reached)');
  const classical = classicalTrailing
    ? '$' + classicalTrailing.currentLevel.toFixed(2) + ' (' + classicalTrailing.shiftCount + ' real shift'
      + (classicalTrailing.shiftCount === 1 ? '' : 's') + ' since entry)'
    : 'N/A (no qualifying pre-entry basing point found)';
  const turtle = (turtlePyramid && turtlePyramid.available)
    ? (turtlePyramid.units + '/4 Units, stop $' + turtlePyramid.stop.toFixed(2)
      + (turtlePyramid.stoppedOut
        ? ' — STOPPED OUT since entry'
        : turtlePyramid.nextAddTrigger
          ? ', next add @ $' + turtlePyramid.nextAddTrigger.toFixed(2)
          : ', at max Units'))
    : 'N/A (' + ((turtlePyramid && !turtlePyramid.available && turtlePyramid.note) || 'model not loaded') + ')';
  return [
    ['Entry', '$' + entryPrice.toFixed(2) + ' on ' + entryDateStr],
    ['Current Price', '$' + cp.toFixed(2)],
    ['Unrealized', (unrealizedPct >= 0 ? '+' : '') + (unrealizedPct * 100).toFixed(1) + '%'],
    ['Days Held', daysHeld],
    ['Trailing Stop (since entry)', '$' + chandelierSinceEntry.toFixed(2)],
    ['Classical Trailing Stop (Schabacker, "two days away")', classical],
    ['Turtle Pyramid Ladder (Appendix E, 0.5N adds / 2N stop)', turtle],
    [fwd ? 'Highest price since you bought (information only)' : 'Highest High Since Entry', '$' + highestHighSinceEntry.toFixed(2)],
    ['Current T1 / T2', (t1 ? '$' + t1.toFixed(2) + (fwd ? away(r.distanceToT1Pct) : '') : 'N/A') + ' / ' + (t2 ? '$' + t2.toFixed(2) + (fwd ? away(r.distanceToT2Pct) : '') : 'N/A')],
    ['', ''],
    ['RECOMMENDATION', r.recommendation],
    ['Why', r.reason],
  ];
}

type Resizable = ReportSheet & { autoResizeColumns?: (start: number, count: number) => unknown };

/** sh.autoResizeColumns(start, n). ReportSheet may not have it yet (proposed edit): then the same call is recorded. */
function autoResizeColumns(sh: ReportSheet, start: number, count: number): void {
  const s = sh as Resizable;
  if (typeof s.autoResizeColumns === 'function') s.autoResizeColumns(start, count);
  else s.calls.push(['autoResizeColumns', start, count]);
}

/** Everything after the read: the tab write. Throws the F-J1 ReferenceError only with legacyHitReferenceError. */
export function writePositionTab(
  ss: PositionBook, ticker: string, entryPrice: number, entryDateStr: string, r: PositionTabRead,
  opts: WriteOptions = {},
): AnalyzePositionResult {
  const log = opts.log ?? (() => {});
  const legacyName = opts.legacyTabName ?? opts.legacyHitReferenceError === true;
  const sheetName = positionTabName(ticker, legacyName);
  let sh = ss.getSheetByName(sheetName);
  const created = !sh;
  if (sh && legacyName) {
    log('analyzePosition: tab "' + sheetName + '" exists, clearContents (old formatting stays)');
    sh.clearContents();
  } else if (sh) {
    // the fixed tab is shared by every ticker: a full clear, so no colour from another stock stays
    log('analyzePosition: tab "' + sheetName + '" exists, full clear');
    sh.clear();
  } else {
    log('analyzePosition: creating tab "' + sheetName + '"');
    sh = ss.insertSheet(sheetName);
  }
  const rows = positionRows(entryPrice, entryDateStr, r);
  if (!legacyName) rows.unshift(['📌 ' + ticker + ' — Position check' + (opts.runTime ? '   |   ' + opts.runTime : ''), '']);
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  // Legacy derives the row from rows.length ('Why' is last, RECOMMENDATION the one before).
  const recommendationRow = rows.length - 1;
  const bold = sh.getRange(recommendationRow, 1, 1, 2).setFontWeight('bold');
  const fixed = opts.legacyHitReferenceError === true ? false : opts.fixHitReferenceError !== false;
  if (!(r.stopBreached || r.thesisInvalidated) && !fixed) {
    log('analyzePosition: legacy ReferenceError reproduced (hitT1 is not defined): rows written and bolded, no background, no column resize');
    throw new ReferenceError('hitT1 is not defined');
  }
  const background = positionBackground(r);
  bold.setBackground(background);
  autoResizeColumns(sh, 1, 2);
  log('analyzePosition: wrote ' + rows.length + ' rows, recommendation row ' + recommendationRow
    + ', "' + r.recommendation + '", background ' + background);
  return { status: 'written', sheetName, created, rows, recommendationRow, background, read: r };
}

/** An already computed read to the tab, or the alert for an error read. */
export function analyzePositionFromRead(
  ss: PositionBook, ticker: string, entryPrice: number, entryDateStr: string,
  r: PositionExitRead | { readonly error: string },
  opts: WriteOptions = {},
): AnalyzePositionResult {
  if (r.error) {
    (opts.log ?? (() => {}))('analyzePosition: input problem, alert only: ' + r.error);
    return { status: 'alert', alert: r.error };
  }
  return writePositionTab(ss, ticker, entryPrice, entryDateStr, r as PositionExitRead, opts);
}

/** analyzePositionV7: fetch, read, tab. The caller flushes the workbook and prints the alert. */
export async function analyzePosition(
  ss: PositionBook, ticker: string, entryPrice: number, entryDateStr: string, deps: AnalyzePositionDeps,
): Promise<AnalyzePositionResult> {
  const log = deps.log ?? (() => {});
  log('analyzePosition: ticker=' + ticker + ' entryPrice=' + entryPrice + ' entryDate=' + entryDateStr);
  // Legacy fetches inside the read, after the price check: a bad price never fetches.
  const priceOk = typeof entryPrice === 'number' && !isNaN(entryPrice) && entryPrice > 0;
  let chart: Chart | null = null;
  if (priceOk) {
    chart = (await deps.fetchChart(ticker)) || null;
    log('analyzePosition: fetchChart(' + ticker + ') -> ' + (chart ? chart.closes.length + ' bars' : 'nothing'));
  }
  const r = computePositionExitRead(ticker, entryPrice, entryDateStr, chart as Chart, { legacyHistoricalTargets: deps.legacyHistoricalTargets === true });
  return analyzePositionFromRead(ss, ticker, entryPrice, entryDateStr, r, deps);
}
