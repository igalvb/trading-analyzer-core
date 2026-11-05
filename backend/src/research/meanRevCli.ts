/**
 * `node src/research/meanRevCli.ts <priceDir> [--cost=0,10]`: the history test of James — Mean Reversion ±2 SD
 * (docs/models/plans/05-mean-reversion-2sd.md section 6) on the research list, three periods, after the 25% tax, against
 * 📊 Hold QQQ and 📊 Hold the research list (and "join when listed"): the pre-registered default first; step 1 the event study
 * (non-overlapping signals, random-day baseline, Holm, one primary test); step 2 the 90.7% check (descriptive); step 3
 * the capped sweep (pass 1: 54 setups, pass 2 one knob at a time), the T2 sweep guard chosen on 2010-2019 only, the
 * random-signal null, random bags and the universe minus the 14, the report columns; step 4 the trend weakness;
 * step 5 the +2 SD trim overlay. Prints markdown (docs/models/results/phase2.md).
 */

import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable, holdCurve, type Benchmarks, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, randomSignalNull, nullVerdict, quantile, type SweepSetup, type NullDistribution } from './guards.ts';
import { newSignalBook, signalDay, signalValue, signalEquity, type SignalBook, type SigTrade } from './signalBook.ts';
import { zSeries, entrySignals, adxSeries, atrSeries, type MrEntry } from '../analysis/models/meanReversion.ts';
import { trendSeries, type TrendDay } from '../analysis/models/trendFollow.ts';
import { eventTest, holm } from './eventStudy.ts';
import { runTrim, TRIM_DEFAULT, type TrimOptions } from './trimOverlay.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import { LABELS } from '../profile/labels.ts';

export interface MrSetup {
  readonly name: string;
  readonly n: number; readonly k: number; readonly entry: MrEntry; readonly m: number;
  readonly target: 'X1' | 'X2'; readonly timeStop: number; readonly atrStop: number; readonly trendBreak: boolean;
  readonly filter: 'F0' | 'F1' | 'F2' | 'F3'; readonly adxMax: number;
  readonly slots: number; readonly idle: 'qqq' | 'cash' | 'qqqTrend'; readonly rank: 'z' | 'adx';
}
/** The pre-registered default (plan 05 section 2b): E2 confirmed, n 20, k 2, exit at the mean, 20-day time stop, F1, 5 slots, idle QQQ. */
export const MR_DEFAULT: MrSetup = { name: 'default: E2, n 20, k 2, X1 mean, 20-day time stop, F1', n: 20, k: 2, entry: 'E2', m: 5, target: 'X1', timeStop: 20, atrStop: 0, trendBreak: false, filter: 'F1', adxMax: 25, slots: 5, idle: 'qqq', rank: 'z' };

export const setupName = (s: Omit<MrSetup, 'name'>): string => s.entry + ', n ' + s.n + ', k ' + s.k + ', ' + (s.target === 'X1' ? 'X1 mean' : 'X2 +k');

/**
 * The setup chosen on 2010-2019 only (this CLI, pass 1 + pass 2 at 10 bps; docs/models/results/phase2.md). Used by the
 * paper account and the windows grid; the report page keeps the same values (analysis/jamesPhase2Pages.ts MR_PAGE).
 */
export const MR_CHOSEN: MrSetup = { ...MR_DEFAULT, name: 'E1, n 10, k 2.5, X2 +k + F3 QQQ not down', entry: 'E1', n: 10, k: 2.5, target: 'X2', filter: 'F3' };

export interface MrResult extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>; readonly buysByTicker: Map<string, number>;
  readonly closed: Array<{ ticker: string; entryPx: number; exitPx: number; held: number; entryDate: string; why: string }>;
  readonly inStocksPct: number;
}

interface Pre { z: Array<number | null>; sig: Map<string, boolean[]>; }
const preCache = new WeakMap<PriceSeries, Map<number, Pre>>();
const adxCache = new WeakMap<PriceSeries, Array<number | null>>(), atrCache = new WeakMap<PriceSeries, Array<number | null>>();
const trCache = new WeakMap<PriceSeries, Map<number, TrendDay[]>>();
function pre(s: PriceSeries, n: number): Pre { let m = preCache.get(s); if (!m) preCache.set(s, (m = new Map())); let p = m.get(n); if (!p) m.set(n, (p = { z: zSeries(s.closes, n), sig: new Map() })); return p; }
export function signalsOf(s: PriceSeries, n: number, entry: MrEntry, k: number, m: number): boolean[] {
  const p = pre(s, n), key = entry + k + ':' + m;
  let x = p.sig.get(key); if (!x) p.sig.set(key, (x = entrySignals(s, p.z, entry, k, m))); return x;
}
export const zOf = (s: PriceSeries, n: number): Array<number | null> => pre(s, n).z;
export const adxOf = (s: PriceSeries): Array<number | null> => { let a = adxCache.get(s); if (!a) adxCache.set(s, (a = adxSeries(s))); return a; };
export const atrOf = (s: PriceSeries): Array<number | null> => { let a = atrCache.get(s); if (!a) atrCache.set(s, (a = atrSeries(s))); return a; };
export const trendOf = (s: PriceSeries, days: number): TrendDay[] => { let m = trCache.get(s); if (!m) trCache.set(s, (m = new Map())); let t = m.get(days); if (!t) m.set(days, (t = trendSeries(s.closes, days))); return t; };

/** The exit of a held position at bar k (first of target, time stop, hard stop, trend break), or null. */
export function mrExit(s: PriceSeries, k: number, o: MrSetup, held: number, entryPx: number, atrAtEntry: number | null): string | null {
  const z = zOf(s, o.n)[k];
  if (z != null && (o.target === 'X1' ? z >= 0 : z >= o.k)) return o.target === 'X1' ? 'back at the ' + o.n + '-day average (z ' + z.toFixed(2) + ')' : 'z ' + z.toFixed(2) + ' at +' + o.k + ' SD';
  if (o.timeStop && held >= o.timeStop) return 'time stop, ' + held + ' days';
  if (o.atrStop && atrAtEntry != null && (s.closes[k] as number) < entryPx - o.atrStop * atrAtEntry) return 'hard stop ' + o.atrStop + ' x ATR under the entry';
  if (o.trendBreak && trendOf(s, 200)[k]?.direction === 'cautionary') return 'trend break: 3% under the 200-day average';
  return null;
}
/** Whether the regime filter lets a buy through at bar k (F3 uses the market state passed in). */
export function mrFilter(s: PriceSeries, k: number, o: MrSetup, marketDown: boolean): boolean {
  if (o.filter === 'F1') return trendOf(s, 200)[k]?.direction === 'bullish';
  if (o.filter === 'F2') { const a = adxOf(s)[k]; return a != null && a < o.adxMax; }
  if (o.filter === 'F3') return !marketDown;
  return true;
}

/** One run over [start, end] on `bag`, idle money per the setup. `buyDays`: the random-signal null's buy days. */
export function runMeanRev(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, o: MrSetup, costBps = 0,
  buyDays?: ReadonlyMap<string, ReadonlySet<string>>): MrResult {
  const b: SignalBook = newSignalBook(CASH);
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const live = bag.filter((t) => inp.series.has(t));
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const q200 = trendOf(inp.qqq, 200), q150 = trendOf(inp.qqq, 150);
  let peak = CASH, dd = 0, trades = 0, idleOut = o.idle === 'cash', marketDown = false, stockDays = 0;
  const cashShareByDay = new Map<string, number>(), buysByTicker = new Map<string, number>(), last = new Map<string, number>();
  const closed: MrResult['closed'] = [];
  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string, qk = idx.get('QQQ')!.get(d)!;
    const bars = new Map<string, { open: number; close: number }>(), at = new Map<string, number>();
    for (const t of live) { const k = idx.get(t)!.get(d); if (k == null) continue; const s = ser(t); bars.set(t, { open: s.opens[k]!, close: s.closes[k]! }); at.set(t, k); last.set(t, s.closes[k]!); }
    last.set('QQQ', inp.qqq.closes[qk]!);
    let decide: { exits: Map<string, string>; entries: Array<{ t: string; why: string; note: number | null; r: number }> } | null = null;
    if (n < days.length - 1) {
      if (o.idle === 'qqqTrend') { const qd = q200[qk]?.direction; if (qd === 'cautionary') idleOut = true; else if (qd === 'bullish') idleOut = false; }
      { const qd = q150[qk]?.direction; if (qd === 'cautionary') marketDown = true; else if (qd === 'bullish') marketDown = false; }
      const exits = new Map<string, string>();
      for (const [t, p] of Object.entries(b.pos)) { const k = at.get(t); if (k == null) continue; const why = mrExit(ser(t), k, o, p.held, p.entryPx, p.note); if (why) exits.set(t, why); }
      const entries: Array<{ t: string; why: string; note: number | null; r: number }> = [];
      for (const [t, k] of at) {
        if (b.pos[t]) continue;
        const s = ser(t);
        const sig = buyDays ? !!buyDays.get(t)?.has(d) : signalsOf(s, o.n, o.entry, o.k, o.m)[k] && mrFilter(s, k, o, marketDown);
        if (!sig) continue;
        const z = zOf(s, o.n)[k] ?? 0;
        entries.push({ t, why: (buyDays ? 'random day (null)' : o.entry + ' at z ' + z.toFixed(2)), note: atrOf(s)[k] ?? null, r: o.rank === 'adx' ? -(adxOf(s)[k] ?? 99) : -z });
      }
      entries.sort((x, y) => y.r - x.r || x.t.localeCompare(y.t));
      decide = { exits, entries };
    }
    const tr: SigTrade[] = signalDay(b, { slots: o.slots, idle: o.idle, costBps }, { day: d, bars, qqq: { open: inp.qqq.opens[qk]!, close: inp.qqq.closes[qk]! }, fill: n > 0, decide, idleOut });
    for (const x of tr) if (x.ticker !== 'QQQ') { trades++; if (x.side === 'BUY') buysByTicker.set(x.ticker, (buysByTicker.get(x.ticker) ?? 0) + 1); if (x.closed) closed.push({ ticker: x.ticker, ...x.closed, why: x.why }); }
    const closeOf = (t: string): number | null => last.get(t) ?? null;
    const eq = signalEquity(b, closeOf);
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
    cashShareByDay.set(d, eq > 0 ? Math.min(1, Math.max(0, b.cash) / eq) : 1);
    if (Object.keys(b.pos).length) stockDays++;
  }
  // positions still open count as trades at the last close (for the win-rate table)
  for (const [t, p] of Object.entries(b.pos)) closed.push({ ticker: t, entryPx: p.cost / p.shares, exitPx: last.get(t) ?? p.cost / p.shares, held: p.held, entryDate: p.entryDate, why: 'still held at the end' });
  return { finalTaxed: signalValue(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay, buysByTicker, closed, inStocksPct: days.length ? (stockDays / days.length) * 100 : 0 };
}

export function meanRevNull(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, o: MrSetup, costBps: number, r: MrResult, seeds = 100): NullDistribution {
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  return randomSignalNull(r.buysByTicker, daysOf, (buyDays) => runMeanRev(bag, inp, start, end, o, costBps, buyDays).finalTaxed, seeds);
}

// ─────────────────────────────── the sweep ───────────────────────────────

const ENTRIES: readonly MrEntry[] = ['E1', 'E2', 'E3'];
const TARGETS = ['X1', 'X2'] as const;
const NS = [10, 20, 50], KS = [1.5, 2, 2.5];
export interface MrSwept { readonly setup: MrSetup; readonly knobs: Record<string, number> }
/** Pass 1: 3 entries x 2 targets x 3 lookbacks x 3 bands = 54 setups, the rest at the default. */
export function mrPass1(): MrSwept[] {
  const out: MrSwept[] = [];
  ENTRIES.forEach((e, ei) => TARGETS.forEach((x, xi) => NS.forEach((n, ni) => KS.forEach((k, ki) => {
    const s = { ...MR_DEFAULT, entry: e, target: x, n, k };
    out.push({ setup: { ...s, name: setupName(s) }, knobs: { entry: ei, target: xi, n: ni, k: ki } });
  }))));
  return out;
}
/** Pass 2: stops, filters, slots, idle, ranking, the confirm window, one at a time around `base`. */
export function mrPass2(base: MrSetup): MrSetup[] {
  const v = (name: string, x: Partial<MrSetup>): MrSetup => ({ ...base, ...x, name: base.name + ' + ' + name });
  return [
    v('time stop 10', { timeStop: 10 }), v('time stop 40', { timeStop: 40 }), v('no time stop', { timeStop: 0 }),
    v('hard stop 2 x ATR', { atrStop: 2 }), v('hard stop 3 x ATR', { atrStop: 3 }), v('trend break', { trendBreak: true }),
    v('no filter (F0)', { filter: 'F0' }), v('F2 ADX < 25', { filter: 'F2', adxMax: 25 }), v('F2 ADX < 20', { filter: 'F2', adxMax: 20 }), v('F2 ADX < 30', { filter: 'F2', adxMax: 30 }), v('F3 QQQ not down', { filter: 'F3' }),
    v('3 slots', { slots: 3 }), v('idle cash', { idle: 'cash' }), v('idle QQQ while its trend is up', { idle: 'qqqTrend' }), v('rank lowest ADX', { rank: 'adx' }),
    ...(base.entry === 'E2' ? [v('confirm within 10 days', { m: 10 })] : []),
  ];
}

// ─────────────────────────────── main ───────────────────────────────

function winTable(rows: Array<{ name: string; closed: MrResult['closed']; fall: number }>): string[] {
  const out = ['| Setup | Trades | Win rate | Average win / average loss | Worst trade | Profit factor | Average days held | Deepest fall of an account |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const rs = r.closed.map((x) => x.exitPx / x.entryPx - 1), w = rs.filter((x) => x > 0), l = rs.filter((x) => x <= 0);
    const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const pf = l.length && l.reduce((a, b) => a + b, 0) !== 0 ? w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0) : Infinity;
    out.push('| ' + r.name + ' | ' + rs.length + ' | ' + (rs.length ? ((w.length / rs.length) * 100).toFixed(1) + '%' : '—') + ' | +' + (avg(w) * 100).toFixed(1) + '% / ' + (avg(l) * 100).toFixed(1) + '% | '
      + (rs.length ? (Math.min(...rs) * 100).toFixed(0) + '%' : '—') + ' | ' + (Number.isFinite(pf) ? pf.toFixed(2) : '∞') + ' | ' + avg(r.closed.map((x) => x.held)).toFixed(1) + ' | -' + r.fall.toFixed(0) + '% |');
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir] = args.filter((a) => !a.startsWith('--')) as [string];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const headline = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, [...OWNER_BAG, 'META']);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads: new Map(), qqq: (loadBag(priceDir, ['QQQ']).get('QQQ'))! };
  const runAll = (s: MrSetup, cost: number, b: readonly string[] = bag, i: Pick<PortfolioInput, 'series' | 'qqq'> = inp): MrResult[] => PERIODS.map((p) => runMeanRev(b, i, p.start, p.end, s, cost));
  const out: string[] = ['# James — Mean Reversion ±2 SD: history test', '', 'The 14: ' + bag.join(', ') + '. $100,000, 5 slots, after the 25% tax, idle money in QQQ unless stated. Daily bars only (James\'s signal is on the 4-hour chart; we have no intraday history).'];
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '## ' + cost + ' bps per side' + (cost === headline ? ' (headline)' : ''), '', ...RESULT_HEAD_P2, ...benchRows(bench, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore),
      resultRowP2('**James — Mean Reversion, pre-registered default** (' + MR_DEFAULT.name.replace('default: ', '') + ', 5 slots, idle QQQ)', runAll(MR_DEFAULT, cost), bench));
  }

  // ── Step 1: event study ──
  out.push('', '## Step 1 — event study (T3): next open to the close 5 / 10 / 20 days later, one signal per stock per window, vs random days of the same stocks and period (2,000 draws)', '',
    'Exploratory except the pre-registered primary test (E2, n 20, k 2, +20 days). Holm across the 81 variants (3 entries x 3 n x 3 k x 3 horizons) of each period. Mean forward return of the signals vs the random days\' average.', '',
    '| Variant | ' + PERIODS.map((p) => p.name + ': signals, mean vs random, Holm p').join(' | ') + ' |', '|---|' + PERIODS.map(() => '---|').join(''));
  const variants: Array<{ e: MrEntry; n: number; k: number; h: number }> = [];
  for (const e of ENTRIES) for (const n of NS) for (const k of KS) for (const h of [5, 10, 20]) variants.push({ e, n, k, h });
  const evRes = PERIODS.map((p) => {
    const res = variants.map((v) => {
      const sigs = new Map<PriceSeries, number[]>();
      for (const t of bag) { const s = series.get(t)!; const sg = signalsOf(s, v.n, v.e, v.k, 5); const idx: number[] = []; s.dates.forEach((d, i) => { if (d >= p.start && d <= p.end && sg[i]) idx.push(i); }); sigs.set(s, idx); }
      const pool = (s: PriceSeries): number[] => s.dates.map((d, i) => (d >= p.start && d <= p.end && i >= 200 ? i : -1)).filter((i) => i >= 0);
      return eventTest(sigs, pool, v.h, 2000);
    });
    const adj = holm(res.map((r) => r.p));
    return res.map((r, i) => ({ ...r, adj: adj[i]! }));
  });
  const prim = variants.findIndex((v) => v.e === 'E2' && v.n === 20 && v.k === 2 && v.h === 20);
  const cell = (r: { n: number; mean: number; baseline: number; adj: number }): string => r.n + ', ' + (r.mean * 100).toFixed(2) + '% vs ' + (r.baseline * 100).toFixed(2) + '%, p ' + r.adj.toFixed(3);
  variants.forEach((v, i) => { if (v.h === 20 || i === prim) out.push('| ' + (i === prim ? '**' : '') + v.e + ', n ' + v.n + ', k ' + v.k + ', +' + v.h + 'd' + (i === prim ? ' (primary)**' : '') + ' | ' + evRes.map((r) => cell(r[i]!)).join(' | ') + ' |'); });
  const pr = evRes.map((r) => r[prim]!);
  const gate = pr[0]!.adj < 0.05 && pr[0]!.mean > pr[0]!.baseline && pr.slice(1).every((x) => x.mean > x.baseline);
  out.push('', '(Rows shown: the +20-day variants; the 5- and 10-day variants are in the Holm family.) Variants with Holm p < 0.05: ' + PERIODS.map((p, k) => p.name + ' ' + evRes[k]!.filter((x) => x.adj < 0.05).length + ' of 81').join(', ') + '.',
    '', '**Primary test (gate):** ' + (gate ? 'passes' : 'fails') + ' — 2010-2019 Holm p ' + pr[0]!.adj.toFixed(3) + ' (' + (pr[0]!.mean * 100).toFixed(2) + '% vs ' + (pr[0]!.baseline * 100).toFixed(2) + '%), same sign later: ' + pr.slice(1).map((x, k) => PERIODS[k + 1]!.name + ' ' + (x.mean > x.baseline ? 'yes' : 'no')).join(', ') + '.');

  // ── Step 2: the 90.7% check (descriptive) ──
  out.push('', '## Step 2 — the "90.7% win rate" check (descriptive; each stock traded alone, 1 slot, no filter, idle QQQ, 10 bps; open trades counted at the last close)', '',
    'Claim assets available: GOOGL and META (BTC-USD and SOL-USD are not in the research download: not run). Win = sold above the buy price after costs, before tax.');
  const exitsWin: Array<[string, Partial<MrSetup>]> = [['X1 mean, no stop', { target: 'X1', timeStop: 0 }], ['X1 mean + 20-day time stop', { target: 'X1', timeStop: 20 }], ['X2 +2 SD, no stop', { target: 'X2', timeStop: 0 }], ['X2 +2 SD + 20-day time stop', { target: 'X2', timeStop: 20 }]];
  let bestWin = { rate: 0, name: '', worst: 0, fall: 0 };
  for (const [gname, tick] of [['GOOGL + META', ['GOOGL', 'META']], ['the 14', bag]] as const) {
    for (const [pi, p] of PERIODS.entries()) {
      const rows: Array<{ name: string; closed: MrResult['closed']; fall: number }> = [];
      for (const e of ENTRIES) for (const [xn, xo] of exitsWin) {
        const s: MrSetup = { ...MR_DEFAULT, ...xo, entry: e, filter: 'F0', slots: 1 };
        const rs = tick.filter((t) => series.has(t)).map((t) => runMeanRev([t], inp, p.start, p.end, s, headline));
        const closed = rs.flatMap((r) => r.closed), fall = Math.max(...rs.map((r) => r.maxDrawdownPct));
        rows.push({ name: e + ', ' + xn, closed, fall });
        const rr = closed.map((x) => x.exitPx / x.entryPx - 1), wr = rr.length ? rr.filter((x) => x > 0).length / rr.length : 0;
        if (wr > bestWin.rate && rr.length >= 20) bestWin = { rate: wr, name: gname + ', ' + p.name + ', ' + e + ', ' + xn, worst: Math.min(...rr), fall };
      }
      out.push('', '### ' + gname + ', ' + p.name + (pi === 0 ? '' : ''), '', ...winTable(rows));
    }
  }
  out.push('', '**90.7% finding:** the best daily win rate (20+ trades) is ' + (bestWin.rate * 100).toFixed(1) + '% (' + bestWin.name + '), worst trade ' + (bestWin.worst * 100).toFixed(0) + '%, deepest fall of an account -' + bestWin.fall.toFixed(0) + '%. ' + (bestWin.rate >= 0.9 ? 'A ~90% win rate is reached on daily bars.' : 'No daily setup reaches ~90%.'));

  // ── Step 3: the portfolio sweep ──
  const p1 = mrPass1();
  const results = new Map<number, Map<string, MrResult[]>>();
  for (const cost of costs) { const m = new Map<string, MrResult[]>(); for (const s of p1) m.set(s.setup.name, runAll(s.setup, cost)); results.set(cost, m); process.stderr.write('mean reversion pass 1 at ' + cost + ' bps\n'); }
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: headline });
  const qqqH = benchH.qqq.map((x) => x.finalTaxed);
  const rh = results.get(headline)!;
  const setups: SweepSetup[] = p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: rh.get(s.setup.name)!.map((x) => x.finalTaxed) }));
  const defaultName = setupName(MR_DEFAULT);
  const g = sweepGuard(setups, defaultName, qqqH);
  out.push('', '## Step 3 — pass 1: 54 setups at ' + headline + ' bps (entry x target x n x k; 20-day time stop, F1, 5 slots, idle QQQ), sorted by 2010-2019', '', ...RESULT_HEAD_P2);
  for (const s of [...p1].sort((a, b) => rh.get(b.setup.name)![0]!.finalTaxed - rh.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRowP2(s.setup.name + (s.setup.name === defaultName ? ' **(default)**' : ''), rh.get(s.setup.name)!, benchH));
  out.push('', '### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '),
    '- Best in 2010-2019: ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + g.chosen.name + '**',
    ...g.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 54 setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;
  const base = rh.get(chosen.name)!;
  out.push('', '### Pass 2 — one knob at a time around the pass-1 choice (' + headline + ' bps)', '', ...RESULT_HEAD_P2, resultRowP2(chosen.name + ' (pass-1 choice)', base, benchH));
  let best: { s: MrSetup; r: MrResult[] } | null = null;
  for (const s of mrPass2(chosen)) { const r = runAll(s, headline); out.push(resultRowP2(s.name, r, benchH)); if (r[0]!.finalTaxed > (best ? best.r[0]!.finalTaxed : base[0]!.finalTaxed)) best = { s, r }; }
  if (best && base[0]!.finalTaxed > qqqH[0]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '** (better in 2010-2019; its neighbour, the pass-1 choice, beats QQQ there).'); chosen = best.s; }
  else out.push('', 'Pass 2 adopts nothing (no knob beats the pass-1 choice in 2010-2019, or the choice does not beat QQQ there).');
  if (chosen.name !== MR_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not MR_CHOSEN (' + MR_CHOSEN.name + '); update the constant, the report page and the paper account.');
  const final = new Map(costs.map((c) => [c, runAll(chosen, c)]));
  out.push('', '### The chosen setup: **' + chosen.name + '**', '', ...RESULT_HEAD_P2);
  for (const c of costs) out.push(resultRowP2('at ' + c + ' bps', final.get(c)!, benchmarksFor(bag, inp, CASH, { costBps: c })));
  const hind = [...p1].sort((a, b) => rh.get(b.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0) - rh.get(a.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0))[0]!;
  out.push(resultRowP2('picked with hindsight (best over all three periods, never used): ' + hind.setup.name, rh.get(hind.setup.name)!, benchH));
  const fh = final.get(headline)!;
  const nulls = PERIODS.map((p, k) => meanRevNull(bag, inp, p.start, p.end, chosen, headline, fh[k]!));
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '### Random-signal null (T2e, 100 seeds, the same buys per stock on random days, same exits, ' + headline + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median out-of-sample: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE);
  const uinp = { series: uni, qqq: inp.qqq };
  const bags = randomBags([...uni.keys()].sort(), 20, 12), minus = universeMinusList([...uni.keys()].sort());
  out.push('', '### Robustness (T5): 20 random bags of 12 (survivors only, no delisted names) and the universe minus the 14', '', '| Period | QQQ | Bags beating QQQ | Bag average | Universe minus the 14 |', '|---|---|---|---|---|');
  PERIODS.forEach((p, k) => {
    const vs = bags.map((bg) => runMeanRev(bg.filter((t) => uni.has(t)), uinp, p.start, p.end, chosen, headline).finalTaxed);
    out.push('| ' + p.name + ' | ' + pct(qqqH[k]!) + ' | ' + vs.filter((v) => v > qqqH[k]!).length + ' of ' + vs.length + ' | ' + pct(vs.reduce((a, b) => a + b, 0) / vs.length) + ' | ' + pct(runMeanRev(minus, uinp, p.start, p.end, chosen, headline).finalTaxed) + ' |');
  });
  out.push('', 'The universe (' + uni.size + ' stocks) holds only stocks still listed today; deep losers included: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + '; delisted names are absent, so these results are an upper bound.');
  out.push('', '### Report columns (' + headline + ' bps)', ...reportTable(benchH, [{ name: 'James — Mean Reversion, chosen (' + chosen.name + ')', outcomes: fh }, { name: 'James — Mean Reversion, pre-registered default', outcomes: runAll(MR_DEFAULT, headline) }], inp.qqq, CASH, LABELS.holdResearchCore));

  // ── Step 4: the trend weakness ──
  out.push('', '## Step 4 — the trend weakness, measured (chosen setup, ' + headline + ' bps)', '', '| Period | Trades with ADX < 20 / 20-30 / > 30 at entry: count, average trade | Trades entered with Trend 200 bullish / mixed / cautionary: count, average trade |', '|---|---|---|');
  PERIODS.forEach((p, k) => {
    const cl = fh[k]!.closed.filter((x) => x.entryDate);
    const at = (x: { ticker: string; entryDate: string }): number => series.get(x.ticker)!.dates.indexOf(x.entryDate) - 1;
    const grp = (f: (x: typeof cl[number]) => boolean): string => { const g2 = cl.filter(f), r = g2.map((x) => x.exitPx / x.entryPx - 1); return g2.length + ', ' + (r.length ? ((r.reduce((a, b) => a + b, 0) / r.length) * 100).toFixed(1) + '%' : '—'); };
    const adx = (x: typeof cl[number]): number => adxOf(series.get(x.ticker)!)[at(x)] ?? 0, tr = (x: typeof cl[number]): string => trendOf(series.get(x.ticker)!, 200)[at(x)]?.direction ?? '';
    out.push('| ' + p.name + ' | ' + [grp((x) => adx(x) < 20), grp((x) => adx(x) >= 20 && adx(x) <= 30), grp((x) => adx(x) > 30)].join(' / ') + ' | ' + ['bullish', 'mixed', 'cautionary'].map((d) => grp((x) => tr(x) === d)).join(' / ') + ' |');
  });
  const y22 = runMeanRev(bag, inp, '2022-01-01', '2022-12-31', chosen, headline), q22 = holdCurve([inp.qqq], inp.qqq.dates.filter((d) => d >= '2022-01-01' && d <= '2022-12-31'), CASH, { costBps: headline });
  out.push('', '2022 alone (the bear market): the model ' + pct(y22.finalTaxed) + ' (deepest fall -' + y22.maxDrawdownPct.toFixed(0) + '%), 📊 Hold QQQ ' + pct(q22.finalTaxed) + '.', '',
    'Capture ratio (each stock traded alone by the chosen setup, 1 slot, idle QQQ; vs holding that stock; after tax):', '', '| Stock | ' + PERIODS.map((p) => p.name + ': model / hold the stock').join(' | ') + ' |', '|---|' + PERIODS.map(() => '---|').join(''));
  for (const t of bag) out.push('| ' + t + ' | ' + PERIODS.map((p) => { const s = series.get(t)!; if ((s.dates[0] as string) > p.start) return '—'; const r = runMeanRev([t], inp, p.start, p.end, { ...chosen, slots: 1 }, headline).finalTaxed; const h = holdCurve([s], inp.qqq.dates.filter((d) => d >= p.start && d <= p.end), CASH, { costBps: headline }).finalTaxed; return pct(r) + ' / ' + pct(h); }).join(' | ') + ' |');

  // ── Step 5: the trim overlay ──
  out.push('', '## Step 5 — the +2 SD trim on ' + LABELS.list + ' held equally (the long-only stand-in for call selling; ' + headline + ' bps)', '');
  const per = PERIODS.map((p) => inp.qqq.dates.filter((d) => d >= p.start && d <= p.end));
  const bagS = bag.map((t) => series.get(t)!);
  const trimRow = (name: string, o: TrimOptions): { line: string; finals: number[] } => {
    const r = per.map((days) => runTrim(bagS, days, CASH, o, headline));
    return { finals: r.map((x) => x.finalTaxed), line: '| ' + name + ' | ' + r.map((x) => pct(x.finalTaxed) + ' (-' + x.maxDrawdownPct.toFixed(0) + '%, ' + x.trims + ' trims, ' + (x.trims ? Math.round((x.boughtBackLower / x.trims) * 100) : 0) + '% bought back lower, tax $' + Math.round(x.taxPaid / 1000) + 'k)').join(' | ') + ' |' };
  };
  const head = ['| Row | ' + PERIODS.map((p) => p.name + ': after tax (deepest fall, trims, bought back lower, tax paid)').join(' | ') + ' |', '|---|' + PERIODS.map(() => '---|').join('')];
  const control = trimRow(LABELS.holdResearchCore + ', no trim (control)', { ...TRIM_DEFAULT, on: false });
  const trimSweep: Array<{ name: string; o: TrimOptions }> = [];
  for (const n of [10, 20]) for (const size of [0.1, 0.2, 0.25, 0.5]) for (const bb of ['mean', 'minus2'] as const) trimSweep.push({ name: 'n ' + n + ', trim ' + size * 100 + '%, buy back ' + (bb === 'mean' ? 'at the mean' : 'at -2 SD') + ' or day 39, cool-down 10', o: { ...TRIM_DEFAULT, n, size, buyBack: bb } });
  const rowsT = trimSweep.map((x) => ({ ...x, ...trimRow(x.name + (x.o.n === 20 && x.o.size === 0.2 && x.o.buyBack === 'mean' ? ' **(default)**' : ''), x.o) }));
  out.push(...head, control.line, ...rowsT.map((r) => r.line));
  const pickT = rowsT.reduce((a, r) => (r.finals[0]! > a.finals[0]! ? r : a));
  const coolRows = [5, 20].map((cd) => ({ cd, ...trimRow(pickT.name.replace('cool-down 10', 'cool-down ' + cd), { ...pickT.o, coolDown: cd }) }));
  out.push(...coolRows.map((r) => r.line));
  const tChosen = [pickT, ...coolRows.map((r) => ({ ...r, name: pickT.name.replace('cool-down 10', 'cool-down ' + r.cd), o: { ...pickT.o, coolDown: r.cd } }))].reduce((a, r) => (r.finals[0]! > a.finals[0]! ? r : a));
  const helps = tChosen.finals[1]! > control.finals[1]! && tChosen.finals[2]! > control.finals[2]!;
  out.push('', 'Chosen on 2010-2019: **' + tChosen.name + '** — ' + tChosen.finals.map(pct).join(' / ') + ' vs no trim ' + control.finals.map(pct).join(' / ') + ' -> ' + (helps ? 'beats holding in both later periods.' : 'does not beat holding in both later periods: trimming on spikes costs money after tax.'));
  out.push('', 'Each stock alone, 2020-2023 and 2024-2026, chosen trim vs no trim (after tax):', '', '| Stock | 2020-2023 trim / hold | 2024-2026 trim / hold |', '|---|---|---|');
  for (const t of bag) out.push('| ' + t + ' | ' + [1, 2].map((k) => { const s = series.get(t)!; if ((s.dates[0] as string) > per[k]![0]!) return '—'; return pct(runTrim([s], per[k]!, CASH, tChosen.o, headline).finalTaxed) + ' / ' + pct(runTrim([s], per[k]!, CASH, { ...tChosen.o, on: false }, headline).finalTaxed); }).join(' | ') + ' |');
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
export { quantile };
export type { Benchmarks };
