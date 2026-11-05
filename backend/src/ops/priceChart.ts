/**
 * showPriceChartV7 (fullStockAnalysisV10_9.gs:5651-5864).
 *
 * F-C1: legacy has NO HTML dialog. It writes a '📊 TICKER Chart' tab (a
 * header row plus the last 126 trading days of one column per series) and
 * inserts an Apps Script native LINE chart over it; the only dialog is the
 * "could not load chart data" alert. This port keeps exactly that: the tab
 * through the ReportWorkbook model, and the chart as a plain ChartSpec
 * (SpecChartBuilder records the same fluent calls the legacy builder got).
 * priceChartHtml.ts turns the spec into a Chart.js page for the CLI.
 *
 * Injected: fetchChart (fetchYahooChart), the two ladder functions
 * (computeStockEntryLadderV7 :3362 and computeStockExitLadderV7 :3389, not
 * ported anywhere yet -- F-C9), alert/log, and the config legacy read from
 * CONFIG_V7 (dashboard tab name, dailyTickers[0]). Without a ticker the
 * ticker is read from the dashboard tab's A1 ("📊 TICKER —"), which only works if
 * that tab was loaded (F-C6).
 *
 * Quirks kept (F-C5): a T1 without a price makes the axis NaN when the
 * ladder is on; empty bars throw after the tab and header were written; a
 * missing currentPrice throws at the title, after the rows.
 *
 * Phase 1 (docs/SHEETS_CLEANUP_PLAN.md (c)): the tab is '📊 Price Chart' whatever the ticker;
 * deps.legacyTabName keeps legacy's '📊 TICKER Chart' (parity tests).
 */

import type { FetchedChart } from '../types/chart.ts';
import type { ReportRange, ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import { activeProfile } from '../profile/active.ts';
import { defaultTickerOf } from '../profile/schema.ts';

export const CHART_DASHBOARD_TAB = '📊 Analysis v7';
/** The first ticker of the profile's list (GENERIC_PLAN P2). */
export const CHART_DEFAULT_TICKER: string = defaultTickerOf(activeProfile());
export const CHART_DISPLAY_DAYS = 126;
/** The fixed tab name every run writes (phase 1). */
export const PRICE_CHART_TAB = '📊 Price Chart';

/** The chart tab's name: fixed, or legacy's '📊 TICKER Chart' in legacy-parity mode. */
export function priceChartTabName(ticker: string, legacy = false): string {
  return legacy ? '📊 ' + ticker + ' Chart' : PRICE_CHART_TAB;
}
export const BUY_RUNG_COLORS: readonly string[] = ['#1b5e20', '#2e7d32', '#388e3c', '#43a047', '#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#c8e6c9'];
export const SELL_RUNG_COLORS: readonly string[] = ['#0d47a1', '#1565c0', '#1e88e5', '#42a5f5', '#90caf9'];

export interface ChartRangeSpec {
  readonly row: number;
  readonly col: number;
  readonly numRows: number;
  readonly numCols: number;
}

/** What legacy's newChart()...build() was given, as data. */
export interface ChartSpec {
  type: 'line';
  ranges: ChartRangeSpec[];
  numHeaders: number;
  options: Record<string, unknown>;
  position: { readonly row: number; readonly col: number; readonly offsetX: number; readonly offsetY: number } | null;
}

export class SpecChartBuilder {
  private readonly spec: ChartSpec = { type: 'line', ranges: [], numHeaders: 0, options: {}, position: null };
  asLineChart(): this { this.spec.type = 'line'; return this; }
  addRange(r: ChartRangeSpec): this { this.spec.ranges.push({ row: r.row, col: r.col, numRows: r.numRows, numCols: r.numCols }); return this; }
  setNumHeaders(n: number): this { this.spec.numHeaders = n; return this; }
  setOption(key: string, value: unknown): this { this.spec.options[key] = value; return this; }
  setPosition(row: number, col: number, offsetX: number, offsetY: number): this { this.spec.position = { row, col, offsetX, offsetY }; return this; }
  build(): ChartSpec { return structuredClone(this.spec); }
}

/** Charts per tab name (a ReportWorkbook backend does not report existing charts; this is the in-process record). */
export type ChartStore = Map<string, ChartSpec[]>;

export interface PriceChartSheet {
  getRange(row: number, col: number, numRows?: number, numCols?: number): ReportRange;
  clearContents(): unknown;
  activate(): unknown;
  getCharts(): ChartSpec[];
  removeChart(chart: ChartSpec): void;
  newChart(): SpecChartBuilder;
  insertChart(chart: ChartSpec): void;
}

export interface PriceChartWorkbook {
  getSheetByName(name: string): PriceChartSheet | null;
  insertSheet(name: string): PriceChartSheet;
}

function chartSheet(sh: ReportSheet, store: ChartStore): PriceChartSheet {
  const list = (): ChartSpec[] => {
    let l = store.get(sh.getName());
    if (!l) { l = []; store.set(sh.getName(), l); }
    return l;
  };
  return {
    getRange: (row, col, numRows, numCols) => sh.getRange(row, col, numRows, numCols),
    clearContents: () => sh.clearContents(),
    activate: () => sh.activate(),
    getCharts: () => [...list()],
    removeChart: (c) => { const l = list(); const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); },
    newChart: () => new SpecChartBuilder(),
    insertChart: (c) => { list().push(c); },
  };
}

/** Gives a ReportWorkbook the chart methods showPriceChart needs; charts are recorded in `store`. */
export function chartWorkbook(ss: ReportWorkbook, store: ChartStore): PriceChartWorkbook {
  return {
    getSheetByName: (name) => { const sh = ss.getSheetByName(name); return sh ? chartSheet(sh, store) : null; },
    insertSheet: (name) => chartSheet(ss.insertSheet(name), store),
  };
}

export interface LadderRung {
  readonly rung: number;
  readonly price: number;
  readonly portion?: number;
}

export interface PriceChartTechPlan {
  readonly entryCount?: number | null;
  readonly entryLow?: number | null;
  readonly entryHigh?: number | null;
  readonly stop?: number | null;
  readonly t1?: { readonly price?: number | null } | null;
  readonly t2?: { readonly price?: number | null } | null;
  readonly regime?: string | null;
}

/** showPriceChartV7's five positional arguments. */
export interface PriceChartArgs {
  readonly ticker?: string;
  readonly techPlan?: PriceChartTechPlan | null;
  readonly decision?: { readonly action?: string | null } | null;
  readonly showLadder?: boolean;
  readonly recCall?: { readonly found?: boolean; readonly contract: { readonly strike: number | string } } | null;
}

export interface PriceChartDeps {
  readonly workbook: PriceChartWorkbook;
  readonly fetchChart: (ticker: string) => Promise<FetchedChart | null>;
  readonly entryLadder: (confluence: { entryCount?: number | null; entryLow?: number | null; entryHigh?: number | null }) => readonly LadderRung[];
  readonly exitLadder: (techPlan: PriceChartTechPlan) => readonly LadderRung[];
  readonly alert: (message: string) => void;
  readonly log: (message: string) => void;
  /** CONFIG_V7.tab. Default CHART_DASHBOARD_TAB. */
  readonly dashboardTab?: string;
  /** CONFIG_V7.dailyTickers; the first is the default ticker. */
  readonly dailyTickers?: readonly string[];
  /** Phase 1: true = legacy's per-ticker tab name '📊 TICKER Chart' (parity tests). Default: '📊 Price Chart'. */
  readonly legacyTabName?: boolean;
}

export interface PriceChartResult {
  readonly ticker: string;
  readonly sheetName: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly spec: ChartSpec;
  readonly entryLabel: string;
}

interface SeriesDef {
  header: string;
  value: (i: number) => unknown;
  opt: Record<string, unknown>;
}

export async function showPriceChart(deps: PriceChartDeps, args: PriceChartArgs = {}): Promise<PriceChartResult | null> {
  const ss = deps.workbook;
  const tickerArg = args.ticker, techPlanArg = args.techPlan, decisionArg = args.decision, showLadderArg = args.showLadder, recCallArg = args.recCall;
  let ticker = tickerArg || (deps.dailyTickers && deps.dailyTickers[0]) || CHART_DEFAULT_TICKER;
  if (!tickerArg) {
    try {
      const sh = ss.getSheetByName(deps.dashboardTab ?? CHART_DASHBOARD_TAB);
      if (sh) {
        const header = String(sh.getRange(1, 1).getValue());
        const m = header.match(/📊\s+([A-Z.]+)\s+—/);
        if (m) ticker = m[1];
      }
    } catch (e) { /* fall back to the default above */ }
  }

  const data = await deps.fetchChart(ticker);
  if (!data) {
    deps.alert('Could not load chart data for ' + ticker + ' — try running an analysis on it first, or check your connection.');
    return null;
  }

  const chartSheetName = priceChartTabName(ticker, deps.legacyTabName === true);
  const existing = ss.getSheetByName(chartSheetName);
  let sh: PriceChartSheet;
  if (existing) {
    existing.getCharts().forEach((c) => existing.removeChart(c)); // clear any prior chart before rebuilding
    existing.clearContents();
    sh = existing;
  } else {
    sh = ss.insertSheet(chartSheetName);
  }

  function sma(period: number, i: number, closes: readonly number[]): number | null {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    return sum / period;
  }

  const entryMid = (techPlanArg && techPlanArg.entryLow != null && techPlanArg.entryHigh != null)
    ? (techPlanArg.entryLow + techPlanArg.entryHigh) / 2 : null;

  const n = data.dates.length;
  const DISPLAY_DAYS = CHART_DISPLAY_DAYS; // ~6 trading months
  const startIdx = Math.max(0, n - DISPLAY_DAYS);
  const isLastRow = (i: number): boolean => i === n - 1;

  // LILO ladder rungs: a VARIABLE number of price lines, unlike the fixed
  // Entry/Stop/T1/T2 columns; a failure is logged and non-fatal.
  const ladderRungs: Array<{ label: string; price: number; color: string }> = [];
  let hasEntryRungs = false; // real buy rungs replace the redundant consolidated Entry line
  let hasExitRungs = false;  // same for T1/T2 vs the sell rungs
  if (showLadderArg && techPlanArg) {
    try {
      const entryLadder = deps.entryLadder({
        entryCount: techPlanArg.entryCount, entryLow: techPlanArg.entryLow, entryHigh: techPlanArg.entryHigh,
      });
      const exitLadder = deps.exitLadder(techPlanArg);
      hasEntryRungs = entryLadder.length > 0;
      hasExitRungs = exitLadder.length > 0;
      entryLadder.forEach((r) => ladderRungs.push({ label: 'Buy rung ' + r.rung, price: r.price, color: BUY_RUNG_COLORS[(r.rung - 1) % BUY_RUNG_COLORS.length] }));
      exitLadder.forEach((r) => ladderRungs.push({ label: 'Sell rung ' + r.rung, price: r.price, color: SELL_RUNG_COLORS[(r.rung - 1) % SELL_RUNG_COLORS.length] }));
    } catch (e) {
      deps.log('LILO ladder computation failed for chart: ' + (e && e.message ? e.message : e));
    }
  }

  // Every series is defined once; headers, rows and series options all derive from this list.
  const seriesDefs: SeriesDef[] = [
    { header: 'Close', value: (i) => data.closes[i], opt: { color: '#1a237e', lineWidth: 2 } },
    { header: 'High', value: (i) => data.highs[i], opt: { color: '#cfd8dc', lineWidth: 1 } },
    { header: 'Low', value: (i) => data.lows[i], opt: { color: '#cfd8dc', lineWidth: 1 } },
    { header: 'SMA50', value: (i) => sma(50, i, data.closes), opt: { color: '#f57c00', lineWidth: 1 } },
    { header: 'SMA200', value: (i) => sma(200, i, data.closes), opt: { color: '#6a1b9a', lineWidth: 1 } },
  ];
  if (!hasEntryRungs) {
    seriesDefs.push({ header: 'Entry', value: () => entryMid, opt: { color: '#2e7d32', lineWidth: 1, lineDashStyle: [4, 2] } });
  }
  seriesDefs.push({ header: 'Stop', value: () => techPlanArg && techPlanArg.stop != null ? techPlanArg.stop : null, opt: { color: '#c62828', lineWidth: 1, lineDashStyle: [4, 2] } });
  if (!hasExitRungs) {
    seriesDefs.push(
      { header: 'T1', value: () => techPlanArg && techPlanArg.t1 && techPlanArg.t1.price != null ? techPlanArg.t1.price : null, opt: { color: '#1565c0', lineWidth: 1, lineDashStyle: [4, 2] } },
      { header: 'T2', value: () => techPlanArg && techPlanArg.t2 && techPlanArg.t2.price != null ? techPlanArg.t2.price : null, opt: { color: '#1565c0', lineWidth: 1, lineDashStyle: [4, 2] } },
    );
  }
  ladderRungs.forEach((r) => {
    seriesDefs.push({ header: r.label, value: () => r.price, opt: { color: r.color, lineWidth: 1, lineDashStyle: [1, 2] } });
  });
  if (recCallArg && recCallArg.found) {
    seriesDefs.push({
      header: 'Rec. Call ($' + recCallArg.contract.strike + ')',
      value: () => recCallArg.contract.strike,
      opt: { color: '#e65100', lineWidth: 1, lineDashStyle: [2, 2] },
    });
  }
  seriesDefs.push({ header: 'Today', value: (i) => isLastRow(i) ? data.closes[i] : null, opt: { color: '#000000', lineWidth: 0, pointSize: 10, pointShape: 'diamond' } });

  const headers = ['Date', ...seriesDefs.map((s) => s.header)];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  const rows: unknown[][] = [];
  for (let i = startIdx; i < n; i++) {
    rows.push([data.dates[i], ...seriesDefs.map((s) => s.value(i))]);
  }
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');

  const regimeLabel = techPlanArg ? (techPlanArg.regime || '') : '';
  const verdictLabel = decisionArg && decisionArg.action ? decisionArg.action : regimeLabel;
  const entryLabel = (techPlanArg && techPlanArg.entryLow != null && techPlanArg.entryHigh != null)
    ? 'Entry ~$' + (entryMid as number).toFixed(2) + ' (zone $' + techPlanArg.entryLow.toFixed(2) + '–$' + techPlanArg.entryHigh.toFixed(2) + ')'
    : 'Entry';

  const displayedCloses = data.closes.slice(startIdx);
  const displayedLows = data.lows.slice(startIdx);

  // W6 (v8.1) data-driven vertical range: the MIN follows the lowest plotted
  // value; the MAX keeps the anti-stretch rule (T2 and the T2-level sell rung
  // are excluded, they may run off the top).
  const maxCandidates: number[] = [Math.max(...displayedCloses)];
  const minCandidates: number[] = [Math.min(...displayedLows)];
  if (techPlanArg) {
    if (entryMid != null) { maxCandidates.push(entryMid); minCandidates.push(entryMid); }
    if (techPlanArg.stop != null) { maxCandidates.push(techPlanArg.stop); minCandidates.push(techPlanArg.stop); }
    if (techPlanArg.t1 && techPlanArg.t1.price != null) maxCandidates.push(techPlanArg.t1.price);
  }
  ladderRungs.forEach((r) => {
    if (/Buy rung/.test(r.label)) { maxCandidates.push(r.price); minCandidates.push(r.price); }
    else if (/Sell rung 1\b/.test(r.label)) { maxCandidates.push(r.price); }
  });
  if (recCallArg && recCallArg.found) {
    const rc = Number(recCallArg.contract.strike);
    if (Number.isFinite(rc)) { maxCandidates.push(rc); minCandidates.push(rc); }
  }
  const dataMax = Math.max(...maxCandidates), dataMin = Math.min(...minCandidates);
  const pad = (dataMax - dataMin) * 0.08 || dataMax * 0.05;
  const vAxisMin = Math.max(0, dataMin - pad);
  const vAxisMax = dataMax + pad;

  const seriesOptions: Record<number, Record<string, unknown>> = {};
  seriesDefs.forEach((s, idx) => { seriesOptions[idx] = s.opt; });

  const chart = sh.newChart()
    .asLineChart()
    .addRange(sh.getRange(1, 1, rows.length + 1, headers.length))
    .setNumHeaders(1)
    .setOption('series', seriesOptions)
    .setOption('title', ticker + ' — $' + data.currentPrice.toFixed(2) + '   ' + verdictLabel)
    .setOption('titleTextStyle', { bold: true, fontSize: 15 })
    .setOption('legend', { position: 'top' })
    .setOption('vAxis', { viewWindow: { min: vAxisMin, max: vAxisMax } })
    .setOption('width', 1200)
    .setOption('height', 700)
    .setPosition(2, headers.length + 2, 0, 0)
    .build();

  sh.insertChart(chart);
  if (deps.legacyTabName === true) {
    // Legacy wrote the label into the Date column (row headers.length+3 is a data row).
    sh.getRange(headers.length + 3, 1).setValue(entryLabel).setFontStyle('italic').setFontColor('#2e7d32');
  } else {
    // D17: its own annotation column, right of the chart's data range, so column A holds dates only.
    sh.getRange(1, headers.length + 1).setValue('Note').setFontStyle('italic').setFontColor('#2e7d32');
    sh.getRange(2, headers.length + 1).setValue(entryLabel).setFontStyle('italic').setFontColor('#2e7d32');
  }
  sh.activate();
  return { ticker, sheetName: chartSheetName, headers, rows, spec: chart, entryLabel };
}
