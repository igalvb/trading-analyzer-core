/**
 * `node src/research/marketMakerCli.ts <priceDir> [--cost=0,10]`: the history test of James — Market Maker Stages
 * (docs/models/plans/08-market-maker-stages.md section 6).
 *
 * Step 1 — the event study (the gate, master T3): every stage-3 signal per variant (V1 Wyckoff spring, V2 loose stages,
 * V2 + double bottom) x context (off, the default rising 200-day with the low >= 0.97 x it, the bull-market filter)
 * x horizon (+5 / +10 / +20 days), one signal per ticker per window, against random days of the same stocks and period
 * and against a matched baseline (random days within 3% of a rising 200-day average), Holm across every row of a
 * period. Pre-registered primary test: V1, default context, +20 days, matched baseline, 2010-2019, on the 14 and on the
 * universe minus the 14; the same sign in 2020-2023 and 2024-2026.
 * Step 2 — the portfolio on the signal book (stops, two targets, time stop, 1% risk sizing, idle QQQ): the
 * pre-registered default first, pass 1 (variant x context x stop = 48), the sweep guard chosen on 2010-2019, pass 2
 * one knob at a time, the random-signal null, random bags, the report columns. Prints markdown.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, randomSignalNull, nullVerdict, type SweepSetup, type NullDistribution } from './guards.ts';
import { eventTest, holm } from './eventStudy.ts';
import { newSignalBook, signalDay, signalValue, signalEquity, type SignalBook, type SigPlan, type SigTrade } from './signalBook.ts';
import { marketMakerSeries, MM_DEFAULT, type MmDay, type MmOptions, type MmVariant, type MmContext } from '../analysis/models/marketMaker.ts';
import { atrSeries } from '../analysis/models/meanReversion.ts';
import { trendSeries, type TrendDirection } from '../analysis/models/trendFollow.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import { LABELS } from '../profile/labels.ts';

export interface MmSetup extends MmOptions {
  readonly exitPlan: 'half' | 'allT2' | 'ride';
  /** Trading days; 0 = none. */
  readonly timeStop: number;
  readonly sizing: 'risk1' | 'pct33' | 'slot';
  readonly slots: number;
  /** The bull-market filter (QQQ not "down": the marketFilter state, 3% under its 150-day average). */
  readonly bull: boolean;
  readonly idle: 'qqq' | 'cash';
}
export const MM_SETUP_DEFAULT: MmSetup = { ...MM_DEFAULT, exitPlan: 'half', timeStop: 20, sizing: 'risk1', slots: 5, bull: false, idle: 'qqq' };
export interface MmNamed { readonly name: string; readonly o: MmSetup }
const CTX_WORD: Readonly<Record<MmContext, string>> = { off: 'no 200-day context', r100: 'rising 200-day, low >= 1.00 x it', r097: 'rising 200-day, low >= 0.97 x it', r095: 'rising 200-day, low >= 0.95 x it' };
const VAR_WORD: Readonly<Record<MmVariant, string>> = { V1: 'V1 Wyckoff spring', V2: 'V2 loose stages', V2DB: 'V2 + double bottom' };
export const mmName = (o: MmSetup): string => VAR_WORD[o.variant] + ', ' + CTX_WORD[o.context] + ', stop ' + (o.stop === 'pct1' ? 'low - 1%' : 'low - ' + o.stop + ' ATR');
export const MM_DEFAULT_NAMED: MmNamed = { name: mmName(MM_SETUP_DEFAULT), o: MM_SETUP_DEFAULT };
/**
 * The setup chosen on 2010-2019 only (this CLI, pass 1 + pass 2 at 10 bps; docs/models/results/phase3.md). Used by the
 * paper account, the windows grid and the report page.
 */
export const MM_CHOSEN: MmNamed = MM_DEFAULT_NAMED;

// ─────────────────────────────── cached reads ───────────────────────────────

const MMC = new WeakMap<PriceSeries, Map<string, MmDay[]>>();
export function mmOf(s: PriceSeries, o: MmOptions): MmDay[] {
  let m = MMC.get(s); if (!m) { m = new Map(); MMC.set(s, m); }
  const key = o.variant + '|' + o.context + '|' + o.stop;
  let x = m.get(key); if (!x) { x = marketMakerSeries(s, o); m.set(key, x); }
  return x;
}
const ATRC = new WeakMap<PriceSeries, Array<number | null>>(), T200C = new WeakMap<PriceSeries, TrendDirection[]>(), T150C = new WeakMap<PriceSeries, boolean[]>();
export const atrOf = (s: PriceSeries): Array<number | null> => { let x = ATRC.get(s); if (!x) { x = atrSeries(s); ATRC.set(s, x); } return x; };
const t200Of = (s: PriceSeries): TrendDirection[] => { let x = T200C.get(s); if (!x) { x = trendSeries(s.closes, 200).map((y) => y.direction); T200C.set(s, x); } return x; };
/** QQQ "down" per day (the marketFilter state: on at a close 3% under the 150-day average, off at a close above a rising one). */
export function qqqDownOf(q: PriceSeries): boolean[] {
  let x = T150C.get(q);
  if (!x) { let down = false; x = trendSeries(q.closes, 150).map((y) => { if (y.direction === 'cautionary') down = true; else if (y.direction === 'bullish') down = false; return down; }); T150C.set(q, x); }
  return x;
}

/** The entry plan of a random day (the null): stop = the day's low - 1 ATR, target 1 = the median close of the prior 20 days, target 2 = their highest high. */
function randomPlan(s: PriceSeries, k: number): SigPlan | null {
  const a = atrOf(s)[k];
  if (a == null || k < 20) return null;
  const cs = s.closes.slice(k - 20, k).slice().sort((x, y) => x - y);
  return { stop: (s.lows[k] as number) - a, target1: ((cs[9] as number) + (cs[10] as number)) / 2, target2: Math.max(...s.highs.slice(k - 20, k)), halfDone: false };
}

/** The exit tonight (or null), and a half to sell at target 1. Mutates the plan (half done; ride: the stop to the entry). */
export function mmExit(s: PriceSeries, k: number, o: MmSetup, held: number, entryPx: number, plan: SigPlan): { sell?: string; trim?: string } | null {
  const c = s.closes[k] as number;
  if (c <= plan.stop) return { sell: 'stop (' + plan.stop.toFixed(2) + ')' };
  if (o.exitPlan === 'ride') {
    if (!plan.halfDone && plan.target1 != null && c >= plan.target1) { plan.halfDone = true; plan.stop = Math.max(plan.stop, entryPx); return { trim: 'target 1 (' + plan.target1.toFixed(2) + '): half sold, stop raised to the entry' }; }
    if (plan.halfDone && t200Of(s)[k] === 'cautionary') return { sell: 'Trend 200 sell (the ridden half)' };
    if (!plan.halfDone && o.timeStop && held >= o.timeStop) return { sell: 'time stop, ' + held + ' days' };
    return null;
  }
  if (plan.target2 != null && c >= plan.target2) return { sell: 'target 2, the range top (' + plan.target2.toFixed(2) + ')' };
  if (o.exitPlan === 'half' && !plan.halfDone && plan.target1 != null && c >= plan.target1) { plan.halfDone = true; return { trim: 'target 1, the range middle (' + plan.target1.toFixed(2) + '): half sold' }; }
  if (o.timeStop && held >= o.timeStop) return { sell: 'time stop, ' + held + ' days' };
  return null;
}

/** The size of an entry as a share of the account (null = one slot). */
export function mmShare(o: MmSetup, close: number, stop: number): number | undefined {
  if (o.sizing === 'slot') return undefined;
  if (o.sizing === 'pct33') return 0.033;
  const risk = (close - stop) / close;
  return risk > 0 ? Math.min(1 / o.slots, 0.01 / risk) : 0;
}

export interface MmResult extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>; readonly buysByTicker: Map<string, number>;
  readonly entries: number; readonly wins: number; readonly closedTrades: number; readonly avgWin: number; readonly avgLoss: number; readonly inStocksPct: number;
}

export function runMarketMaker(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, o: MmSetup, costBps = 0,
  buyDays?: ReadonlyMap<string, ReadonlySet<string>>): MmResult {
  const b: SignalBook = newSignalBook(CASH);
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const live = bag.filter((t) => inp.series.has(t));
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const qdown = qqqDownOf(inp.qqq);
  let peak = CASH, dd = 0, trades = 0, entries = 0, stockDays = 0;
  const cashShareByDay = new Map<string, number>(), buysByTicker = new Map<string, number>(), last = new Map<string, number>();
  const closed: Array<{ r: number }> = [];
  const lots = new Map<string, { cost: number; got: number }>(); // per open position: money in, money back (for the win table)
  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string, qk = idx.get('QQQ')!.get(d)!;
    const bars = new Map<string, { open: number; close: number }>(), at = new Map<string, number>();
    for (const t of live) { const k = idx.get(t)!.get(d); if (k == null) continue; const s = ser(t); bars.set(t, { open: s.opens[k]!, close: s.closes[k]! }); at.set(t, k); last.set(t, s.closes[k]!); }
    last.set('QQQ', inp.qqq.closes[qk]!);
    let decide: Parameters<typeof signalDay>[2]['decide'] = null;
    if (n < days.length - 1) {
      const exits = new Map<string, string>(), trims = new Map<string, { frac: number; why: string }>();
      for (const [t, p] of Object.entries(b.pos)) {
        const k = at.get(t); if (k == null || !p.plan) continue;
        const x = mmExit(ser(t), k, o, p.held, p.entryPx, p.plan);
        if (x?.sell) exits.set(t, x.sell); else if (x?.trim) trims.set(t, { frac: 0.5, why: x.trim });
      }
      const cand: Array<{ t: string; why: string; share?: number; plan: SigPlan; r: number }> = [];
      for (const [t, k] of at) {
        if (b.pos[t]) continue;
        const s = ser(t);
        let plan: SigPlan | null = null, why = '';
        if (buyDays) { if (buyDays.get(t)?.has(d)) { plan = randomPlan(s, k); why = 'random day (null)'; } }
        else {
          const m = mmOf(s, o)[k];
          const ok = m && (o.bull ? m.sweep && !qdown[qk] : m.signal);
          if (ok && m && m.stop != null) { plan = { stop: m.stop, target1: m.target1, target2: m.target2, halfDone: false }; why = 'James — Market Maker: second sweep at ' + (m.sweepLow as number).toFixed(2) + ' (stage 3)'; }
        }
        if (!plan) continue;
        const sh = mmShare(o, s.closes[k] as number, plan.stop);
        if (sh === 0) continue;
        cand.push({ t, why, ...(sh != null ? { share: sh } : {}), plan, r: (s.closes[k] as number) / plan.stop });
      }
      cand.sort((x, y) => x.r - y.r || x.t.localeCompare(y.t));
      decide = { exits, entries: cand, trims };
    }
    const tr: SigTrade[] = signalDay(b, { slots: o.slots, idle: o.idle, costBps }, { day: d, bars, qqq: { open: inp.qqq.opens[qk]!, close: inp.qqq.closes[qk]! }, fill: n > 0, decide });
    for (const x of tr) {
      if (x.ticker === 'QQQ') continue;
      trades++;
      if (x.side === 'BUY') { entries++; buysByTicker.set(x.ticker, (buysByTicker.get(x.ticker) ?? 0) + 1); lots.set(x.ticker, { cost: x.shares * x.price * (1 + costBps / 10_000), got: 0 }); }
      else { const l = lots.get(x.ticker); if (l) { l.got += x.shares * x.price * (1 - costBps / 10_000); if (!b.pos[x.ticker]) { closed.push({ r: l.got / l.cost - 1 }); lots.delete(x.ticker); } } }
    }
    const closeOf = (t: string): number | null => last.get(t) ?? null;
    const eq = signalEquity(b, closeOf);
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
    cashShareByDay.set(d, eq > 0 ? Math.min(1, Math.max(0, b.cash) / eq) : 1);
    if (Object.keys(b.pos).length) stockDays++;
  }
  const w = closed.filter((x) => x.r > 0), l = closed.filter((x) => x.r <= 0);
  const avg = (xs: Array<{ r: number }>): number => (xs.length ? xs.reduce((a, x) => a + x.r, 0) / xs.length : 0);
  return { finalTaxed: signalValue(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay, buysByTicker, entries, wins: w.length, closedTrades: closed.length, avgWin: avg(w), avgLoss: avg(l), inStocksPct: days.length ? (stockDays / days.length) * 100 : 0 };
}

export function mmNull(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, o: MmSetup, costBps: number, r: MmResult, seeds = 100): NullDistribution {
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  return randomSignalNull(r.buysByTicker, daysOf, (buyDays) => runMarketMaker(bag, inp, start, end, o, costBps, buyDays).finalTaxed, seeds);
}

export function mmPass1(): Array<{ setup: MmNamed; knobs: Record<string, number> }> {
  const out: Array<{ setup: MmNamed; knobs: Record<string, number> }> = [];
  (['V1', 'V2', 'V2DB'] as const).forEach((variant, vi) => (['off', 'r100', 'r097', 'r095'] as const).forEach((context, ci) => ([0.5, 1, 1.5, 'pct1'] as const).forEach((stop, si) => {
    const o: MmSetup = { ...MM_SETUP_DEFAULT, variant, context, stop };
    out.push({ setup: { name: mmName(o), o }, knobs: { variant: vi, context: ci, stop: si } });
  })));
  return out;
}
export function mmPass2(base: MmNamed): MmNamed[] {
  const v = (name: string, x: Partial<MmSetup>): MmNamed => ({ name: base.name + ' + ' + name, o: { ...base.o, ...x } });
  return [v('all at target 2', { exitPlan: 'allT2' }), v('ride it (stop to the entry at target 1, Trend 200 sell)', { exitPlan: 'ride' }), v('time stop 10', { timeStop: 10 }), v('time stop 40', { timeStop: 40 }),
    v('3.3% of the account', { sizing: 'pct33' }), v('one equal slot', { sizing: 'slot' }), v('3 slots', { slots: 3 }), v('10 slots', { slots: 10 }), v('bull-market filter (QQQ not down) instead of the 200-day context', { bull: true, context: 'off' })];
}

// ─────────────────────────────── step 1: the event study ───────────────────────────────

const HORIZONS = [5, 10, 20] as const;
type Filter = 'off' | 'default' | 'bull';
interface EvRow { variant: MmVariant | 'TEST'; filter: Filter; h: number; base: 'random' | 'matched'; n: number; mean: number; baseline: number; p: number; adj?: number }

function signalIdx(s: PriceSeries, q: PriceSeries, v: MmVariant | 'TEST', f: Filter, start: string, end: string): number[] {
  const qi = new Map(q.dates.map((d, i) => [d, i])), qd = qqqDownOf(q);
  const m = v === 'TEST' ? mmOf(s, { variant: 'V1', context: 'off', stop: 1 }) : mmOf(s, { variant: v, context: f === 'default' ? 'r097' : 'off', stop: 1 });
  const out: number[] = [];
  for (let k = 0; k < m.length; k++) {
    const d = s.dates[k] as string; if (d < start || d > end) continue;
    const x = m[k]!;
    const hit = v === 'TEST' ? x.test : f === 'bull' ? x.sweep && qi.has(d) && !qd[qi.get(d)!] : x.signal;
    if (hit) out.push(k);
  }
  return out;
}
function poolOf(s: PriceSeries, start: string, end: string, matched: boolean): number[] {
  const t = trendSeries(s.closes, 200), out: number[] = [];
  for (let k = 0; k < s.dates.length; k++) {
    const d = s.dates[k] as string; if (d < start || d > end) continue;
    if (matched) { const m = t[k]?.sma, m20 = k >= 20 ? t[k - 20]?.sma : null; if (m == null || m20 == null || !(m > m20) || Math.abs((s.closes[k] as number) / m - 1) > 0.03) continue; }
    out.push(k);
  }
  return out;
}

export function eventStudy(universe: readonly PriceSeries[], q: PriceSeries, start: string, end: string): EvRow[] {
  const rows: EvRow[] = [];
  const pools = new Map<string, Map<PriceSeries, number[]>>([['random', new Map(universe.map((s) => [s, poolOf(s, start, end, false)]))], ['matched', new Map(universe.map((s) => [s, poolOf(s, start, end, true)]))]]);
  for (const v of ['V1', 'V2', 'V2DB'] as const) for (const f of ['off', 'default', 'bull'] as const) {
    const sig = new Map(universe.map((s) => [s, signalIdx(s, q, v, f, start, end)]));
    for (const h of HORIZONS) for (const base of ['random', 'matched'] as const) {
      const r = eventTest(sig, (s) => pools.get(base)!.get(s) ?? [], h);
      rows.push({ variant: v, filter: f, h, base, ...r });
    }
  }
  const adj = holm(rows.map((r) => r.p));
  rows.forEach((r, i) => { r.adj = adj[i]; });
  // the Wyckoff TEST entry (the existing model's timing), +20 days, exploratory
  const sig = new Map(universe.map((s) => [s, signalIdx(s, q, 'TEST', 'off', start, end)]));
  for (const base of ['random', 'matched'] as const) rows.push({ variant: 'TEST', filter: 'off', h: 20, base, ...eventTest(sig, (s) => pools.get(base)!.get(s) ?? [], 20) });
  return rows;
}

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir] = args.filter((a) => !a.startsWith('--')) as [string];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const H = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, OWNER_BAG);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const qqq = loadBag(priceDir, ['QQQ']).get('QQQ')!;
  const inp: PortfolioInput = { series, reads: new Map(), qqq };
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE), minus = universeMinusList([...uni.keys()].sort());
  const out: string[] = ['# James — Market Maker Stages: history test', '', 'The 14: ' + bag.join(', ') + '. Daily bars only (James times entries on the 5-minute chart). BTC-USD and SOL-USD are not in the research download: the crypto runs are not done.'];
  // step 1
  const fmt = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%' : '—');
  const verdicts: Array<{ uni: string; per: Array<{ n: number; diff: number; adj: number }> }> = [];
  for (const [uname, list] of [['the 14', bag.map((t) => series.get(t)!)], ['the universe minus the 14 (survivors only)', minus.map((t) => uni.get(t)!).filter(Boolean)]] as const) {
    const per = PERIODS.map((p) => eventStudy(list, qqq, p.start, p.end));
    out.push('', '## Step 1 — event study on ' + uname, '', 'One signal per ticker per holding window; p = the share of 2,000 random draws (the same count per stock) at or above the signals\' mean; Holm across the 54 rows of each period. Primary test in bold.', '',
      '| Variant | Context | Days | Baseline | ' + PERIODS.map((p) => p.name + ': n / mean / baseline / Holm p').join(' | ') + ' |', '|---|---|---|---|' + PERIODS.map(() => '---|').join(''));
    per[0]!.forEach((r, i) => {
      const prim = r.variant === 'V1' && r.filter === 'default' && r.h === 20 && r.base === 'matched';
      const lab = r.variant === 'TEST' ? 'V1, the Wyckoff TEST entry (control, exploratory)' : VAR_WORD[r.variant];
      const row = '| ' + lab + ' | ' + ({ off: 'off', default: 'rising 200-day, low >= 0.97 x it', bull: 'QQQ not down' } as const)[r.filter] + ' | +' + r.h + ' | ' + r.base + ' | '
        + per.map((rows) => { const x = rows[i]!; return x.n + ' / ' + fmt(x.mean) + ' / ' + fmt(x.baseline) + ' / ' + (x.adj != null ? x.adj.toFixed(2) : 'p ' + x.p.toFixed(2)); }).join(' | ') + ' |';
      out.push(prim ? row.replace(/\| ([^|]+) \|/, '| **$1** |') : row);
    });
    const pi = per[0]!.findIndex((r) => r.variant === 'V1' && r.filter === 'default' && r.h === 20 && r.base === 'matched');
    verdicts.push({ uni: uname, per: per.map((rows) => ({ n: rows[pi]!.n, diff: rows[pi]!.mean - rows[pi]!.baseline, adj: rows[pi]!.adj ?? 1 })) });
  }
  const passes = verdicts.every((v) => v.per[0]!.n > 0 && v.per[0]!.adj < 0.05 && v.per.every((x) => x.n > 0 && x.diff > 0));
  out.push('', '**Gate (pre-registered primary test: V1, default context, +20 days, matched baseline):** ' + verdicts.map((v) => v.uni + ': ' + v.per.map((x, k) => PERIODS[k]!.name + ' n ' + x.n + (x.n ? ', ' + fmt(x.diff) + ' vs matched, Holm p ' + x.adj.toFixed(2) : '')).join('; ')).join(' — ') + ' -> **' + (passes ? 'passes' : 'fails: no daily edge found') + '**.');
  // step 2
  const runAll = (s: MmNamed, cost: number): MmResult[] => PERIODS.map((p) => runMarketMaker(bag, inp, p.start, p.end, s.o, cost));
  const cols = (r: readonly MmResult[]): string => ' ' + r.map((x) => x.entries).join(' / ') + ' | ' + r.map((x) => (x.closedTrades ? Math.round((x.wins / x.closedTrades) * 100) + '%' : '—')).join(' / ') + ' | ' + r.map((x) => (x.closedTrades ? fmt(x.avgWin) + ' / ' + fmt(x.avgLoss) : '—')).join(' · ') + ' | ' + r.map((x) => x.inStocksPct.toFixed(0) + '%').join(' / ') + ' |';
  const HEAD = RESULT_HEAD_P2.map((l, i) => l + (i === 0 ? ' Entries | Win rate | Avg win / loss | Time in stocks |' : '---|---|---|---|'));
  out.push('', '## Step 2 — the portfolio (run although the gate ' + (passes ? 'passed' : 'failed') + ', as phase 2 did for Mean Reversion; information only)');
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '### ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', ...HEAD, ...benchRows(bench, CASH, 1, ['', '', 'fall', '', '', '', '', ''], LABELS.holdResearchCore),
      resultRowP2('**James — Market Maker Stages, pre-registered default** (' + MM_DEFAULT_NAMED.name + ', half at target 1 / half at target 2, time stop 20, 1% risk, 5 slots, idle QQQ)', runAll(MM_DEFAULT_NAMED, cost), bench) + cols(runAll(MM_DEFAULT_NAMED, cost)));
  }
  const p1 = mmPass1();
  const res = new Map<number, Map<string, MmResult[]>>();
  for (const c of costs) { const m = new Map<string, MmResult[]>(); for (const s of p1) m.set(s.setup.name, runAll(s.setup, c)); res.set(c, m); process.stderr.write('market maker pass 1 at ' + c + ' bps\n'); }
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: H }), qqqH = benchH.qqq.map((x) => x.finalTaxed), rh = res.get(H)!;
  const g = sweepGuard(p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: rh.get(s.setup.name)!.map((x) => x.finalTaxed) }) as SweepSetup), MM_DEFAULT_NAMED.name, qqqH);
  out.push('', '### Pass 1 — 48 setups at ' + H + ' bps (variant x context x stop), sorted by 2010-2019', '', ...HEAD);
  for (const s of [...p1].sort((a, b) => rh.get(b.setup.name)![0]!.finalTaxed - rh.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRowP2(s.setup.name + (s.setup.name === MM_DEFAULT_NAMED.name ? ' **(default)**' : ''), rh.get(s.setup.name)!, benchH) + cols(rh.get(s.setup.name)!));
  out.push('', '#### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '), '- Best in 2010-2019: ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + g.chosen.name + '**',
    ...g.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 48 setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;
  const base = rh.get(chosen.name)!;
  out.push('', '### Pass 2 — one knob at a time around the pass-1 choice (' + H + ' bps)', '', ...HEAD, resultRowP2(chosen.name + ' (pass-1 choice)', base, benchH) + cols(base));
  let best: { s: MmNamed; r: MmResult[] } | null = null;
  for (const s of mmPass2(chosen)) { const r = runAll(s, H); out.push(resultRowP2(s.name, r, benchH) + cols(r)); if (r[0]!.finalTaxed > (best ? best.r[0]!.finalTaxed : base[0]!.finalTaxed)) best = { s, r }; }
  if (best && base[0]!.finalTaxed > qqqH[0]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '** (better in 2010-2019; its neighbour, the pass-1 choice, beats QQQ there).'); chosen = best.s; }
  else out.push('', 'Pass 2 adopts nothing (no knob beats the pass-1 choice in 2010-2019, or the choice does not beat QQQ there).');
  if (chosen.name !== MM_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not MM_CHOSEN (' + MM_CHOSEN.name + '); update the constant, the report page and the paper account.');
  const final = new Map(costs.map((c) => [c, runAll(chosen, c)]));
  out.push('', '### The chosen setup: **' + chosen.name + '**', '', ...HEAD);
  for (const c of costs) out.push(resultRowP2('at ' + c + ' bps', final.get(c)!, benchmarksFor(bag, inp, CASH, { costBps: c })) + cols(final.get(c)!));
  const hind = [...p1].sort((a, b) => rh.get(b.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0) - rh.get(a.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0))[0]!;
  out.push(resultRowP2('picked with hindsight (best over all three periods, never used): ' + hind.setup.name, rh.get(hind.setup.name)!, benchH) + cols(rh.get(hind.setup.name)!));
  const fh = final.get(H)!;
  const nulls = PERIODS.map((p, k) => mmNull(bag, inp, p.start, p.end, chosen.o, H, fh[k]!));
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '### Random-signal null (T2e, 100 seeds: the same entries per stock on random days, stop at the day\'s low - 1 ATR, targets from the prior 20 days, the same exits and sizing, ' + H + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median out-of-sample: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
  const uinp = { series: uni, qqq };
  const bags = randomBags([...uni.keys()].sort(), 20, 12);
  out.push('', '### Robustness (T5): 20 random bags of 12 (survivors only) and the universe minus the 14 (' + H + ' bps)', '', '| Period | QQQ | Bags beating QQQ | Bag average | Universe minus the 14 |', '|---|---|---|---|---|');
  PERIODS.forEach((p, k) => {
    const vs = bags.map((bg) => runMarketMaker(bg.filter((t) => uni.has(t)), uinp, p.start, p.end, chosen.o, H).finalTaxed);
    out.push('| ' + p.name + ' | ' + pct(qqqH[k]!) + ' | ' + vs.filter((v) => v > qqqH[k]!).length + ' of ' + vs.length + ' | ' + pct(vs.reduce((a, b) => a + b, 0) / vs.length) + ' | ' + pct(runMarketMaker(minus, uinp, p.start, p.end, chosen.o, H).finalTaxed) + ' |');
  });
  out.push('', 'The universe (' + uni.size + ' stocks) holds only stocks still listed today; deep losers included: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + '; delisted names are absent, so these results are an upper bound.');
  out.push('', '### Report columns (' + H + ' bps)', ...reportTable(benchH, [{ name: 'James — Market Maker Stages, chosen (' + chosen.name + ')', outcomes: fh }, { name: 'James — Market Maker Stages, pre-registered default', outcomes: runAll(MM_DEFAULT_NAMED, H) }], qqq, CASH, LABELS.holdResearchCore));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
