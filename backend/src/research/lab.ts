/**
 * Strategy lab (owner 2026-10-28: each model must be judged on its own, against holding the stock and holding QQQ,
 * and the result must beat QQQ substantially). Works on the saved daily reads (computeReads.ts) and price files, so
 * a strategy is tried in milliseconds. Same mechanics as the backtest: decide at a close, fill at the next open,
 * 25% tax on each sale's gain, values after the tax on anything still held. No model or score code is changed.
 *
 * Each model buys and sells ONE stock with all the money ("single-stock" view), over three separate periods.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { exitReadFor } from '../backtest/engineRun.ts';
import { computeStockEntryLadder, computeStockExitLadder } from '../analysis/ladders.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import type { CompactRead } from './computeReads.ts';
import { wyckoffClassicSeries, type WyckoffDirection } from '../analysis/models/wyckoffClassic.ts';

const wyckoffCache = new WeakMap<PriceSeries, Map<string, WyckoffDirection>>();
/** The Wyckoff model's read for every day of the series (price only, causal), computed once per series. */
function wyckoffDays(s: PriceSeries): Map<string, WyckoffDirection> {
  let m = wyckoffCache.get(s);
  if (!m) { const out = wyckoffClassicSeries(s); m = new Map(s.dates.map((d, i) => [d, out[i]!.direction])); wyckoffCache.set(s, m); }
  return m;
}

export const LAB_MODELS = ['engine', 'current', 'schabacker', 'edwardsMagee', 'broker', 'turtle', 'wyckoff', 'lilo'] as const;
export type LabModel = (typeof LAB_MODELS)[number];
export const LAB_LABEL: Readonly<Record<LabModel, string>> = {
  engine: 'Engine alone', current: 'Engine + models (current)', schabacker: 'Schabacker', edwardsMagee: 'Edwards & Magee',
  broker: 'Broker Course', turtle: 'Turtle', wyckoff: 'Wyckoff', lilo: 'LILO',
};
export const PERIODS: ReadonlyArray<{ readonly name: string; readonly start: string; readonly end: string }> = [
  { name: '2010-2019', start: '2010-01-01', end: '2019-12-31' },
  { name: '2020-2023', start: '2020-01-01', end: '2023-12-31' },
  { name: '2024-2026', start: '2024-01-01', end: '2026-10-27' },
];

/** Position in the 5-letter direction string of a compact read. */
const DIR_INDEX: Readonly<Record<string, number>> = { engine: 0, broker: 1, schabacker: 2, edwardsMagee: 3, turtle: 4 };
const HOLD_OFF = new Set(['SPLIT', 'NO_CONSENSUS']);
const tier1 = (r: CompactRead): boolean => r.ok === 1 && r.c != null && (r.tm === 'BUY_NOW' || r.c >= 70);

export interface LabResult {
  readonly finalTaxed: number; readonly buys: number; readonly investedPct: number;
  /** Largest fall from a high of the day-close account value, % (before tax). */
  readonly maxDrawdownPct: number;
}

/** Research options of the one-stock lab. Unset = today's results exactly. */
export interface LabOptions {
  /** G5: trading cost in basis points, on every buy (into the cost basis) and sell (from the proceeds, before the tax). */
  readonly costBps?: number;
  /** Fix plan B1/D2: the engine's exit read uses the nearest-cluster T1/T2 (backtest/engineRun.ts exitReadFor). */
  readonly nearestTargets?: boolean;
  /** Fix plan B1 option B part 2: the engine's exit read's T2 skips excluded methods. */
  readonly fixedT2?: boolean;
}

interface Lot { shares: number; price: number }

/** Mutable one-stock account. */
class Acct {
  cash: number; lots: Lot[] = []; buys = 0; entryDate: string | null = null;
  /** Trading cost as a fraction of the money traded (G5). */
  readonly fee: number;
  constructor(c: number, fee = 0) { this.cash = c; this.fee = fee; }
  get shares(): number { return this.lots.reduce((a, l) => a + l.shares, 0); }
  get cost(): number { return this.lots.reduce((a, l) => a + l.shares * l.price, 0); }
  buy(n: number, px: number, day: string): void {
    const pc = px * (1 + this.fee);
    n = Math.min(n, Math.floor(this.cash / pc));
    if (n <= 0) return;
    if (!this.shares) { this.entryDate = day; this.buys++; }
    this.cash -= n * pc; this.lots.push({ shares: n, price: pc });
  }
  sell(n: number, px: number): void {
    n = Math.min(n, this.shares);
    if (n <= 0) return;
    let left = n, cost = 0;
    for (const l of this.lots) { const t = Math.min(l.shares, left); cost += t * l.price; l.shares -= t; left -= t; if (!left) break; }
    this.lots = this.lots.filter((l) => l.shares > 0);
    const net = n * px * (1 - this.fee), gain = net - cost;
    this.cash += net - Math.max(0, gain) * EXIT_TAX_RATE;
    if (!this.shares) this.entryDate = null;
  }
  valueTaxed(px: number): number {
    const v = this.shares * px, gain = v - this.cost;
    return this.cash + v - Math.max(0, gain) * EXIT_TAX_RATE;
  }
}

/** One model trading one stock alone over [start, end]. */
export function runLab(model: LabModel, s: PriceSeries, reads: ReadonlyMap<string, CompactRead>, start: string, end: string, cash: number, idle?: PriceSeries, opt: LabOptions = {}): LabResult {
  const fee = (opt.costBps ?? 0) / 10_000;
  const a = new Acct(cash, fee);
  // Owner 2026-10-28: never sit in cash. With `idle` (QQQ), money not in the stock is held in QQQ; every switch
  // sells one and buys the other at that day's open (25% tax on the sold side's gain).
  const q = new Acct(0, fee);
  const qIdx = idle ? new Map(idle.dates.map((d, k) => [d, k])) : null;
  let qLast = 0;
  const qPx = (d: string, at: 'open' | 'close'): number | null => {
    const k = qIdx?.get(d);
    return k == null || !idle ? null : ((at === 'open' ? idle.opens[k] : idle.closes[k]) as number);
  };
  const toCash = (d: string): void => { const px = qPx(d, 'open'); if (px && q.shares) { q.sell(q.shares, px); } a.cash += q.cash; q.cash = 0; };
  const toQqq = (d: string, at: 'open' | 'close'): void => {
    const px = qPx(d, at);
    if (!px || a.cash < px) return;
    q.cash += a.cash; a.cash = 0; q.buy(Math.floor(q.cash / px), px, d); a.cash += q.cash; q.cash = 0;
  };
  let pending: { side: 'BUY' | 'SELL'; shares?: number } | null = null;
  // LILO state: open limit rungs to buy and to sell, the protective stop and the order's age.
  let buyRungs: Array<{ price: number; shares: number }> = [], sellRungs: Array<{ price: number; portion: number }> = [], liloStop: number | null = null, rungAge = 0, plannedShares = 0;
  let invested = 0, days = 0, lastClose = 0, peak = 0, maxDd = 0;
  for (let i = 0; i < s.dates.length; i++) {
    const d = s.dates[i] as string;
    if (d < start || d > end) continue;
    const o = s.opens[i] as number, h = s.highs[i] as number, l = s.lows[i] as number, c = s.closes[i] as number;
    // 1. fills at the open (market orders)
    if (idle && pending?.side === 'BUY' && !a.shares) toCash(d);
    if (pending?.side === 'BUY' && !a.shares) a.buy(Math.floor(a.cash / o), o, d);
    else if (pending?.side === 'SELL' && a.shares) a.sell(pending.shares ?? a.shares, o);
    pending = null;
    if (idle && !buyRungs.length) toQqq(d, 'open');
    // LILO: limit rungs fill during the day (at the rung, or at the open when it gaps through)
    if (model === 'lilo') {
      for (const p of [...buyRungs]) if (l <= p.price) { a.buy(p.shares, Math.min(p.price, o), d); buyRungs = buyRungs.filter((x) => x !== p); }
      if (++rungAge > 20) buyRungs = [];
      if (a.shares && liloStop != null && l <= liloStop) { a.sell(a.shares, Math.min(liloStop, o)); sellRungs = []; buyRungs = []; }
      for (const r of [...sellRungs]) if (a.shares && h >= r.price) { a.sell(Math.max(1, Math.round(a.shares * r.portion)), Math.max(r.price, o)); sellRungs = sellRungs.filter((x) => x !== r); }
      if (a.shares && !sellRungs.length && !buyRungs.length) a.sell(a.shares, c);
    }
    // 2. decide at the close
    const r = reads.get(d);
    if (r && r.ok) {
      if (model === 'engine' || model === 'current') {
        if (!a.shares && tier1(r) && (model === 'engine' || !HOLD_OFF.has(String(r.v)))) pending = { side: 'BUY' };
        else if (a.shares && a.entryDate) {
          const x = opt.nearestTargets || opt.fixedT2
            ? exitReadFor(s, d, a.entryDate, a.cost / a.shares, { ...(opt.nearestTargets ? { nearestTargets: true } : {}), ...(opt.fixedT2 ? { fixedT2: true } : {}) })
            : exitReadFor(s, d, a.entryDate, a.cost / a.shares);
          if (x.ok && x.actionClass === 'EXIT') pending = { side: 'SELL' };
          else if (x.ok && (x.hitT1 || x.hitT2) && a.shares > 2) pending = { side: 'SELL', shares: Math.floor(a.shares / 3) };
        }
      } else if (model === 'wyckoff') {
        const w = wyckoffDays(s).get(d);
        if (!a.shares && w === 'bullish') pending = { side: 'BUY' };
        else if (a.shares && w === 'cautionary') pending = { side: 'SELL' };
      } else if (model === 'lilo') {
        if (!a.shares && !buyRungs.length && tier1(r) && r.lz && r.lz[0] != null && r.lz[1] != null) {
          const entry = computeStockEntryLadder({ entryLow: r.lz[0], entryHigh: r.lz[1], entryCount: r.lz[2] ?? 1 });
          const exit = computeStockExitLadder({ t1: r.lz[3] != null ? { price: r.lz[3] } : null, t2: r.lz[4] != null ? { price: r.lz[4] } : null });
          if (entry.length && exit.length) {
            if (idle) { const k = i + 1 < s.dates.length ? (s.dates[i + 1] as string) : d; toCash(k); }
            plannedShares = Math.floor(a.cash / (r.lz[1] as number));
            buyRungs = entry.map((x) => ({ price: x.price, shares: Math.floor(plannedShares * x.portion) })); rungAge = 0;
            sellRungs = exit.map((x, k) => ({ price: x.price, portion: k === exit.length - 1 ? 1 : x.portion / exit.slice(k).reduce((t, y) => t + y.portion, 0) }));
            liloStop = r.st;
          }
        }
      } else {
        const k = DIR_INDEX[model] as number;
        const dir = r.dir[k];
        if (!a.shares && dir === 'b') pending = { side: 'BUY' };
        else if (a.shares && dir === 'c') pending = { side: 'SELL' };
      }
    }
    if (idle && !buyRungs.length && model === 'lilo') toQqq(d, 'close');
    const qc = qPx(d, 'close'); if (qc) qLast = qc;
    const eq = a.cash + a.shares * c + q.shares * (qc ?? qLast);
    invested += eq > 0 ? (a.shares * c) / eq : 0; days++; lastClose = c;
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak > 0 ? (1 - eq / peak) * 100 : 0);
  }
  return { finalTaxed: a.valueTaxed(lastClose) + (q.shares ? q.valueTaxed(qLast) : 0), buys: a.buys, investedPct: days ? (invested / days) * 100 : 0, maxDrawdownPct: maxDd };
}

/**
 * Holding from the first open to the last close of the period, after the 25% tax on the gain. `costBps` (G5): the
 * yardstick pays the trading cost once, at the entry (part of the cost basis).
 */
export function holdLab(s: PriceSeries, start: string, end: string, cash: number, costBps = 0): number | null {
  let i0 = -1, i1 = -1;
  for (let i = 0; i < s.dates.length; i++) { const d = s.dates[i] as string; if (d >= start && d <= end) { if (i0 < 0) i0 = i; i1 = i; } }
  if (i0 < 0) return null;
  const pc = (s.opens[i0] as number) * (1 + costBps / 10_000);
  const n = Math.floor(cash / pc);
  const v = n * (s.closes[i1] as number), gain = v - n * pc;
  return cash - n * pc + v - Math.max(0, gain) * EXIT_TAX_RATE;
}
