/**
 * Backlog 9: Test A / Test B end to end -- engine source (cached), the taxed and the untaxed walk, the benchmarks,
 * and the trade log as CSV.
 */

import fs from 'node:fs';
import { loadSeries, type PriceSeries } from './data.ts';
import { runEngineDay, exitReadFor, type EngineRead, type ExitReadResult, type EngineRunOptions } from './engineRun.ts';
import { holdCurve } from '../research/benchmarks.ts';
import { PERIODS } from '../research/lab.ts';
import { OWNER_BAG } from '../research/portfolioCli.ts';
import { runBacktest, type BacktestResult, type BacktestSources } from './runner.ts';
import { buyAndHold, type BenchmarkResult } from './benchmarks.ts';
import { EXIT_TAX_RATE, EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import { activeProfile } from '../profile/active.ts';
import { LABELS } from '../profile/labels.ts';

/** Profile `research.testAUniverse` (GENERIC_PLAN P2). */
export const TEST_A_UNIVERSE: readonly string[] = activeProfile().research.testAUniverse;
export const TEST_B_UNIVERSE: readonly string[] = ['AKAM'];
export const WINDOW = { start: '2024-01-01', end: '2026-08-01' } as const;
export const START_CASH = 100_000;
/** Context series every engine run needs, plus the index benchmarks. */
export const CONTEXT_SYMBOLS: readonly string[] = ['SPY', '^VIX', 'QQQ'];

export interface TestSpec {
  /** 'A', 'B', or a ticker for a single-stock run (per-ticker mode). */
  readonly name: string;
  readonly universe: readonly string[];
  readonly maxPositions: number | null;
  readonly start: string;
  readonly end: string;
  readonly cash: number;
  readonly checkpointDay: string | null;
  /** Variant: all the account into each buy (see PolicyConfig.allIn). */
  readonly allIn?: boolean;
  /** Variant: the engine alone, no comparison-verdict hold-off (see PolicyConfig.noVeto). */
  readonly noVeto?: boolean;
}

export const TEST_A: TestSpec = { name: 'A', universe: TEST_A_UNIVERSE, maxPositions: 6, ...WINDOW, cash: START_CASH, checkpointDay: '2024-12-31' };
export const TEST_B: TestSpec = { name: 'B', universe: TEST_B_UNIVERSE, maxPositions: null, ...WINDOW, cash: START_CASH, checkpointDay: null };

export function loadAll(symbols: readonly string[], dir?: string): Map<string, PriceSeries> {
  const m = new Map<string, PriceSeries>();
  for (const s of new Set([...symbols, ...CONTEXT_SYMBOLS])) m.set(s, loadSeries(s, dir));
  return m;
}

/** Engine reads through a day|ticker cache (optionally a JSON file), so the taxed and untaxed walks share them. */
export class CachedEngineSource implements BacktestSources {
  private readonly cache = new Map<string, EngineRead>();
  private readonly series: ReadonlyMap<string, PriceSeries>;
  private readonly file: string | null;
  /** Backlog 37: options of every engine run (the macro archive for simulation v2). */
  private readonly runOptions: EngineRunOptions;
  computed = 0;
  ms = 0;
  constructor(series: ReadonlyMap<string, PriceSeries>, file: string | null = null, runOptions: EngineRunOptions = {}) {
    this.series = series;
    this.file = file;
    this.runOptions = runOptions;
    if (file && fs.existsSync(file)) for (const r of JSON.parse(fs.readFileSync(file, 'utf8')) as EngineRead[]) this.cache.set(r.day + '|' + r.ticker, r);
  }
  async engineReads(day: string, tickers: readonly string[]): Promise<EngineRead[]> {
    const missing = tickers.filter((t) => !this.cache.has(day + '|' + t));
    if (missing.length) {
      const t0 = performance.now();
      for (const r of await runEngineDay(this.series, day, missing, this.runOptions)) this.cache.set(day + '|' + r.ticker, r);
      this.ms += performance.now() - t0;
      this.computed += missing.length;
    }
    return tickers.map((t) => this.cache.get(day + '|' + t) as EngineRead);
  }
  exitRead(ticker: string, day: string, entryDate: string, entryPrice: number): ExitReadResult {
    return exitReadFor(this.series.get(ticker) as PriceSeries, day, entryDate, entryPrice);
  }
  save(): void {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify([...this.cache.values()]));
  }
}

export interface TestOutcome {
  readonly spec: TestSpec;
  readonly taxed: BacktestResult;
  readonly untaxed: BacktestResult;
  readonly benchmarks: readonly BenchmarkResult[];
  readonly engineMsPerCall: number | null;
  readonly engineCallsComputed: number;
  /** Owner rule 2026-10-27: every trade is also compared with holding QQQ over the same days (taxed run). */
  readonly vsQqq: readonly RoundTrip[];
}

/** One closed round trip (first buy while flat to the sell that empties it), untaxed, next to QQQ over the same fill days. */
export interface RoundTrip {
  readonly ticker: string;
  readonly buyDay: string;
  readonly sellDay: string;
  /** (all sale proceeds / all purchase cost - 1) x 100. */
  readonly tradePct: number;
  /** (QQQ open on the sell day / QQQ open on the buy day - 1) x 100; fills are at the open. Null when QQQ has no bar. */
  readonly qqqPct: number | null;
}

export function roundTripsVsQqq(r: BacktestResult, qqq: PriceSeries | undefined): RoundTrip[] {
  const openAt = (day: string): number | null => { const i = qqq ? qqq.dates.indexOf(day) : -1; return i >= 0 ? (qqq!.opens[i] as number) : null; };
  const open = new Map<string, { buyDay: string; held: number; cost: number; proceeds: number }>();
  const out: RoundTrip[] = [];
  for (const t of r.trades) {
    const o = open.get(t.ticker);
    if (t.side === 'BUY') {
      if (o) { o.held += t.shares; o.cost += t.value; } else open.set(t.ticker, { buyDay: t.day, held: t.shares, cost: t.value, proceeds: 0 });
      continue;
    }
    if (!o) continue;
    o.held -= t.shares; o.proceeds += t.value;
    if (o.held > 1e-9) continue;
    const a = openAt(o.buyDay), b = openAt(t.day);
    out.push({ ticker: t.ticker, buyDay: o.buyDay, sellDay: t.day, tradePct: (o.proceeds / o.cost - 1) * 100, qqqPct: a && b ? (b / a - 1) * 100 : null });
    open.delete(t.ticker);
  }
  return out;
}

/** "Beat QQQ in X of Y round trips; average trade +a% vs QQQ +b% over the same days." */
export function vsQqqLine(trips: readonly RoundTrip[]): string {
  const both = trips.filter((t) => t.qqqPct != null);
  if (!both.length) return 'Round trips vs holding QQQ over the same days: none closed.';
  const avg = (xs: number[]): string => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return (m >= 0 ? '+' : '') + m.toFixed(1) + '%'; };
  return 'Round trips vs holding QQQ over the same days (untaxed): the trade beat QQQ in ' + both.filter((t) => t.tradePct > (t.qqqPct as number)).length + ' of ' + both.length
    + '; average trade ' + avg(both.map((t) => t.tradePct)) + ', QQQ over the same days ' + avg(both.map((t) => t.qqqPct as number)) + '.';
}

export async function runTest(spec: TestSpec, series: ReadonlyMap<string, PriceSeries>, src: CachedEngineSource, onDay?: (day: string, i: number, n: number) => void): Promise<TestOutcome> {
  const base = {
    universe: spec.universe, start: spec.start, end: spec.end, cash: spec.cash, calendar: 'SPY',
    policy: { maxPositions: spec.maxPositions, ...(spec.allIn ? { allIn: true } : {}), ...(spec.noVeto ? { noVeto: true } : {}) }, ...(spec.checkpointDay ? { checkpointDay: spec.checkpointDay } : {}),
  };
  const taxed = await runBacktest(series, src, { ...base, name: 'Test ' + spec.name + ' (taxed)', taxRate: EXIT_TAX_RATE, ...(onDay ? { onDay } : {}) });
  const untaxed = await runBacktest(series, src, { ...base, name: 'Test ' + spec.name + ' (untaxed)', taxRate: 0 });
  const benchmarks: BenchmarkResult[] = [];
  if (spec.universe.length > 1) {
    benchmarks.push(buyAndHold('Buy and hold, all ' + spec.universe.length + ' equal weight', series, spec.universe, spec.start, spec.end, spec.cash));
    benchmarks.push(buyAndHold('Buy and hold, only the tickers the system bought (taxed run), equal weight', series, taxed.tickersBought, spec.start, spec.end, spec.cash));
  } else {
    benchmarks.push(buyAndHold('Buy and hold ' + spec.universe[0], series, spec.universe, spec.start, spec.end, spec.cash));
  }
  benchmarks.push(buyAndHold('Buy and hold QQQ', series, ['QQQ'], spec.start, spec.end, spec.cash));
  benchmarks.push(buyAndHold('Buy and hold SPY', series, ['SPY'], spec.start, spec.end, spec.cash));
  return { spec, taxed, untaxed, benchmarks, engineMsPerCall: src.computed ? src.ms / src.computed : null, engineCallsComputed: src.computed, vsQqq: roundTripsVsQqq(taxed, series.get('QQQ')) };
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** One row per trade. With `trips`, the SELL that closes a round trip also gets the trip's return and QQQ's over the same days. */
export function tradeLogCsv(r: BacktestResult, trips: readonly RoundTrip[] = []): string {
  const head = ['day', 'side', 'ticker', 'shares', 'price', 'value', 'cost_basis', 'realized_gain', 'tax', 'cash_after', 'reason', 'trip_return_pct', 'qqq_same_days_pct'];
  const closing = new Map(trips.map((t) => [t.ticker + '|' + t.sellDay, t]));
  return [head.join(','), ...r.trades.map((t) => {
    const trip = t.side === 'SELL' ? closing.get(t.ticker + '|' + t.day) : undefined;
    return [t.day, t.side, t.ticker, t.shares, t.price, t.value, t.costBasis, t.realizedGain, t.tax, t.cashAfter, t.note, trip ? trip.tradePct : null, trip ? trip.qqqPct : null].map(csvCell).join(',');
  })].join('\n') + '\n';
}

/** Median, shortest and longest holding period in trading days over the closed round trips (one lot per position here). */
export function holdStats(r: BacktestResult): string {
  const idx = new Map(r.marks.map((m, i) => [m.day, i]));
  const open = new Map<string, string>();
  const spans: number[] = [];
  for (const t of r.trades) {
    if (t.side === 'BUY' && !open.has(t.ticker)) open.set(t.ticker, t.day);
    else if (t.side === 'SELL' && open.has(t.ticker)) {
      spans.push((idx.get(t.day) ?? 0) - (idx.get(open.get(t.ticker) as string) ?? 0));
      open.delete(t.ticker);
    }
  }
  if (!spans.length) return 'none closed';
  spans.sort((a, b) => a - b);
  return 'median ' + spans[Math.floor(spans.length / 2)] + ', shortest ' + spans[0] + ', longest ' + spans[spans.length - 1] + ' (' + spans.length + ' closed)';
}

const usd = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n: number, base: number): string => ((n / base - 1) * 100 >= 0 ? '+' : '') + ((n / base - 1) * 100).toFixed(1) + '%';

/** The plain result table (markdown). */
export function resultTable(o: TestOutcome): string {
  const c = o.spec.cash;
  const rows = [
    ['The system (engine + models, this policy)', o.untaxed.finalEquity, o.taxed.finalEquityAfterLiquidationTax],
    ...o.benchmarks.map((b) => [b.name, b.untaxed, b.taxed] as [string, number, number]),
  ] as Array<[string, number, number]>;
  return ['| Strategy | Final value, untaxed | Return | Final value, taxed | Return |', '|---|---|---|---|---|',
    ...rows.map(([n, u, t]) => '| ' + n + ' | ' + usd(u) + ' | ' + pct(u, c) + ' | ' + usd(t) + ' | ' + pct(t, c) + ' |')].join('\n');
}

export function summaryText(o: TestOutcome): string {
  const t = o.taxed;
  const buys = t.trades.filter((x) => x.side === 'BUY').length, sells = t.trades.filter((x) => x.side === 'SELL').length;
  const ub = o.untaxed.trades.filter((x) => x.side === 'BUY').length, us = o.untaxed.trades.filter((x) => x.side === 'SELL').length;
  const lines = [
    '== Test ' + o.spec.name + ' (' + t.firstDay + ' to ' + t.lastDay + ', ' + t.days + ' trading days) ==',
    resultTable(o),
    'Trades (taxed run): ' + buys + ' buys, ' + sells + ' sells. Untaxed run: ' + ub + ' buys, ' + us + ' sells.',
    'Tax paid on sells (taxed run): ' + usd(t.taxPaid) + '; realized gain ' + usd(t.realized) + '.',
    'Final holdings (taxed run): ' + (t.finalHoldings.length ? t.finalHoldings.map((h) => h.ticker + ' ' + h.shares + ' sh (' + usd(h.value) + ')').join(', ') : 'none') + '; cash ' + usd(t.finalCash) + '.',
    'Final value before the liquidation tax on remaining holdings (taxed run): ' + usd(t.finalEquity) + '.',
    'Tickers bought: ' + (t.tickersBought.join(', ') || 'none') + '. Most positions open at once: ' + t.maxOpenPositions + '.',
    'Days with no position at all: ' + t.marks.filter((m) => m.positions === 0).length + ' of ' + t.days + '. Average share of the account in stocks at the close: '
      + (t.marks.reduce((a, m) => a + (m.equity > 0 ? (m.equity - m.cash) / m.equity : 0), 0) / t.marks.length * 100).toFixed(0) + '%.',
    'Holding period per round trip (trading days, buy fill to sell fill): ' + holdStats(t) + '.',
    vsQqqLine(o.vsQqq),
    ...(t.openAtCheckpoint != null ? ['Open positions at the close of ' + o.spec.checkpointDay + ': ' + t.openAtCheckpoint + ' (distinct tickers bought by then: ' + t.distinctHeldByCheckpoint + ').'] : []),
    'Engine runs: ' + t.engineCalls + ' (taxed walk), exit reads: ' + t.exitReads + '. Buys cut by cash: ' + t.cashCapped + ', skipped for cash: ' + t.cashSkipped + '.',
    'Exit reads by class (taxed walk): ' + Object.entries(t.exitStats).sort().map(([k, v]) => k + ' ' + v).join('; ') + '.',
    'Signal counts over the not-held ticker-days (taxed walk): ' + Object.entries(t.signalStats).sort().map(([k, v]) => k + ' ' + v).join('; ') + '.',
  ];
  return lines.join('\n');
}

/** Per-ticker mode (owner, 2026-10-27): the system trading ONE stock alone vs holding that stock vs holding QQQ, same window and cash. */
export const singleTickerSpec = (ticker: string): TestSpec => ({ name: ticker, universe: [ticker], maxPositions: null, ...WINDOW, cash: START_CASH, checkpointDay: null });

export function perTickerTable(outcomes: readonly TestOutcome[], allIn: readonly TestOutcome[] = []): string {
  const c = START_CASH;
  const row = (o: TestOutcome): string => {
    const hold = o.benchmarks.find((b) => b.name === 'Buy and hold ' + o.spec.name);
    const qqq = o.benchmarks.find((b) => b.name === 'Buy and hold QQQ');
    const sys = o.taxed.finalEquityAfterLiquidationTax;
    const all = allIn.find((x) => x.spec.name === o.spec.name)?.taxed.finalEquityAfterLiquidationTax;
    const best = Math.max(sys, all ?? -Infinity, hold?.taxed ?? -Infinity, qqq?.taxed ?? -Infinity);
    const mark = (v: number | undefined): string => (v == null ? '—' : pct(v, c) + (v === best ? ' ✅' : ''));
    const trades = o.taxed.trades.filter((t) => t.side === 'BUY').length;
    const m = o.taxed.marks;
    const invested = m.reduce((a, x) => a + (x.equity > 0 ? (x.equity - x.cash) / x.equity : 0), 0) / Math.max(1, m.length) * 100;
    return '| ' + o.spec.name + ' | ' + mark(sys) + ' | ' + (allIn.length ? mark(all) + ' | ' : '') + mark(hold?.taxed) + ' | ' + mark(qqq?.taxed) + ' | ' + trades + ' | ' + invested.toFixed(0) + '% |';
  };
  const extra = allIn.length ? ' System, all money in each trade |' : '';
  return ['| Stock | System, engine sizing |' + extra + ' Just hold the stock | Just hold QQQ | Buys | Money invested, average (engine sizing) |', '|---|---|' + (allIn.length ? '---|' : '') + '---|---|---|---|', ...outcomes.map(row)].join('\n');
}
/**
 * Backlog 37 (simulation v2): the same test on the research list (research/portfolioCli.ts OWNER_BAG, profile
 * lists.researchCore), over the research periods (research/lab.ts PERIODS), 6 positions at most like Test A. Needs a
 * price directory holding the whole list. The CLI name `owner14` is kept (scripts and file names use it).
 */
export const owner14Spec = (period: { readonly name: string; readonly start: string; readonly end: string }): TestSpec =>
  ({ name: 'owner14 ' + period.name, universe: OWNER_BAG, maxPositions: 6, start: period.start, end: period.end, cash: START_CASH, checkpointDay: null });
export const OWNER_14_SPECS: readonly TestSpec[] = PERIODS.map(owner14Spec);

/** The deepest fall from a high, in percent, over a run's daily equity marks (before the liquidation tax). */
export function maxDrawdownPct(marks: ReadonlyArray<{ readonly equity: number }>): number {
  let peak = 0, dd = 0;
  for (const m of marks) { peak = Math.max(peak, m.equity); if (peak > 0) dd = Math.max(dd, (1 - m.equity / peak) * 100); }
  return dd;
}

/** One row of the house-rule table: the value after the tax (EXIT_TAX_RATE) and the deepest fall on the way. */
export interface HouseRow { readonly name: string; readonly finalTaxed: number; readonly maxDrawdownPct: number }

/**
 * House rule (owner 2026-10-28): every result next to holding QQQ and holding the research list, after the tax,
 * with the deepest fall. The system row is the taxed walk (open positions taxed as if sold at the end); the holds
 * are research/benchmarks.ts holdCurve over the same trading days (the plain list leaves out a stock not trading on
 * the first day; "join when listed" gives it its share once it trades). `list` is null when the list is not loaded.
 */
export function houseRows(o: TestOutcome, series: ReadonlyMap<string, PriceSeries>, list: ReadonlyMap<string, PriceSeries> | null, label = 'The system'): HouseRow[] {
  const days = o.taxed.marks.map((m) => m.day);
  const rows: HouseRow[] = [{ name: label, finalTaxed: o.taxed.finalEquityAfterLiquidationTax, maxDrawdownPct: maxDrawdownPct(o.taxed.marks) }];
  const qqq = series.get('QQQ');
  if (qqq) { const b = holdCurve([qqq], days, o.spec.cash); rows.push({ name: 'Hold QQQ', ...b }); }
  if (list) {
    const ss = OWNER_BAG.map((t) => list.get(t)).filter((x): x is PriceSeries => !!x);
    rows.push({ name: LABELS.holdResearch, ...holdCurve(ss, days, o.spec.cash) });
    rows.push({ name: LABELS.holdResearch + ' (join when listed)', ...holdCurve(ss, days, o.spec.cash, { join: true }) });
  }
  return rows.map((r) => ({ name: r.name, finalTaxed: r.finalTaxed, maxDrawdownPct: r.maxDrawdownPct }));
}

export function houseTable(rows: readonly HouseRow[], cash: number): string {
  return ['| Run | Final, after ' + EXIT_TAX_PCT + ' tax | Return | Deepest fall |', '|---|---|---|---|',
    ...rows.map((r) => '| ' + r.name + ' | ' + usd(r.finalTaxed) + ' | ' + pct(r.finalTaxed, cash) + ' | -' + r.maxDrawdownPct.toFixed(0) + '% |')].join('\n');
}

/** Loads the research list from `dir` for the house-rule rows; null when any of its stocks is missing there. */
export function loadOwnerList(dir: string): Map<string, PriceSeries> | null {
  try {
    const m = new Map<string, PriceSeries>();
    for (const t of OWNER_BAG) m.set(t, loadSeries(t, dir));
    return m;
  } catch {
    return null;
  }
}
