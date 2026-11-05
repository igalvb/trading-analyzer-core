/**
 * LILO across several stocks (owner 2026-10-28: LILO must be tested like the other models). The owner's staged
 * ladder, as in the one-stock lab (lab.ts): on a tier-1 read with a ladder, the slot's money is set aside and the
 * entry rungs wait as limit buys for 20 days; T1 / T2 wait as limit sells; the engine's stop protects the position;
 * once every rung is done the rest is sold at the close. At most `slots` stocks (or open ladders) at a time; money
 * not set aside for a ladder waits in QQQ. 25% tax on every sale's gain (QQQ included).
 *
 * The state is plain JSON, so the live paper test can keep it between nights (paper/paperLab.ts).
 */

import { computeStockEntryLadder, computeStockExitLadder } from '../analysis/ladders.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { newPtState, profitTakingFills, type PtSchedule, type PtState } from '../analysis/models/profitTaking.ts';

export const LILO_ORDER_DAYS = 20;

/** What LILO needs from tonight's read of a stock that is a buy (tier 1 with a ladder). */
export interface LiloSignal {
  readonly rank: number;
  readonly entryLow: number; readonly entryHigh: number; readonly entryCount: number;
  readonly t1: number | null; readonly t2: number | null;
  readonly stop: number | null;
}
export interface LiloBar { readonly open: number; readonly high: number; readonly low: number; readonly close: number }
interface Rung { price: number; shares: number }
interface SellRung { price: number; portion: number }
export interface LiloLine {
  shares: number; cost: number;
  buyRungs: Rung[]; sellRungs: SellRung[]; stop: number | null; age: number;
  /** Money set aside for the rungs not filled yet. */
  reserved: number; funded: boolean;
  /** James — Profit-Taking (plan 02, liloDay's `profitTaking` option): the schedule that replaces T1 / T2. */
  pt?: PtState;
}
export interface LiloBook { cash: number; qqq: { shares: number; cost: number }; lines: Record<string, LiloLine> }
export interface LiloTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string }

export const newLiloBook = (cash: number): LiloBook => ({ cash, qqq: { shares: 0, cost: 0 }, lines: {} });

/**
 * Plan 02 (James — Profit-Taking): with `profitTaking`, a new ladder's T1 / T2 sell rungs are replaced by the schedule at
 * the stock's LILO v2 layers 6-10 (`layersOf`, G1's anchor layers at tonight's close, frozen with the ladder), and the
 * rest is no longer sold when every rung is done (the stop still applies). A stock without layers keeps T1 / T2.
 * Absent (the paper test's `lab.lilo`): today's trades exactly.
 */
export interface LiloDayOptions {
  readonly profitTaking?: { readonly schedule: PtSchedule; readonly layersOf: (ticker: string) => readonly number[] | null };
}

/**
 * One trading day: the open (fund new ladders from QQQ, park spare money in QQQ), the day (limit fills, stop,
 * targets), the close (new ladders from tonight's signals when `signals` is given). `fill` false: the close only (the first night).
 * `costBps` (G5, research only; the paper test leaves it at 0): the trading cost in basis points of the money traded,
 * charged on every buy (into the cost basis) and every sell (from the proceeds, before the tax), QQQ included.
 */
export function liloDay(b: LiloBook, slots: number, bars: ReadonlyMap<string, LiloBar>, qqq: { open: number; close: number } | null,
  signals: ReadonlyMap<string, LiloSignal> | null, fill = true, costBps = 0, opts: LiloDayOptions = {}): LiloTrade[] {
  const out: LiloTrade[] = [];
  const c = costBps / 10_000;
  const sellQqq = (n: number, px: number, why: string): void => {
    n = Math.min(n, b.qqq.shares); if (n <= 0) return;
    const cost = (b.qqq.cost * n) / b.qqq.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    b.qqq.shares -= n; b.qqq.cost -= cost; b.cash += n * px - fee - tax;
    out.push({ ticker: 'QQQ', side: 'SELL', shares: n, price: px, tax, why });
  };
  const sellStock = (t: string, l: LiloLine, n: number, px: number, why: string): void => {
    n = Math.min(n, l.shares); if (n <= 0) return;
    const cost = (l.cost * n) / l.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    l.shares -= n; l.cost -= cost; b.cash += n * px - fee - tax;
    out.push({ ticker: t, side: 'SELL', shares: n, price: px, tax, why });
  };

  // 1. the open: fund the new ladders from QQQ, then park what is not set aside
  if (fill && qqq) {
    const need = Object.values(b.lines).reduce((a, x) => a + x.reserved, 0) - b.cash;
    if (need > 0 && Object.values(b.lines).some((x) => !x.funded)) sellQqq(Math.ceil(need / (qqq.open * (1 - c))), qqq.open, 'money for a LILO ladder');
    for (const l of Object.values(b.lines)) l.funded = true;
    const spare = b.cash - Object.values(b.lines).reduce((a, x) => a + x.reserved, 0);
    const pc = qqq.open * (1 + c), n = Math.floor(spare / pc);
    if (n > 0) { b.cash -= n * pc; b.qqq.shares += n; b.qqq.cost += n * pc; out.push({ ticker: 'QQQ', side: 'BUY', shares: n, price: qqq.open, tax: 0, why: 'spare money' }); }
  }

  // 2. the day: limit buys, the stop, the targets; a line with nothing left to do is closed at the close
  for (const [t, l] of fill ? Object.entries(b.lines) : []) {
    const bar = bars.get(t);
    if (!bar) continue;
    for (const r of [...l.buyRungs]) {
      if (bar.low > r.price) continue;
      const px = Math.min(r.price, bar.open), pc = px * (1 + c), n = Math.min(r.shares, Math.floor(Math.min(b.cash, l.reserved + 1e-6) / pc));
      l.buyRungs = l.buyRungs.filter((x) => x !== r);
      if (n <= 0) continue;
      b.cash -= n * pc; l.reserved = Math.max(0, l.reserved - n * pc); l.shares += n; l.cost += n * pc;
      out.push({ ticker: t, side: 'BUY', shares: n, price: px, tax: 0, why: 'LILO buy rung $' + r.price.toFixed(2) });
    }
    if (++l.age > LILO_ORDER_DAYS && l.buyRungs.length) { l.buyRungs = []; }
    if (!l.buyRungs.length) l.reserved = 0;
    if (l.shares && l.stop != null && bar.low <= l.stop) { sellStock(t, l, l.shares, Math.min(l.stop, bar.open), 'LILO stop'); l.sellRungs = []; l.buyRungs = []; }
    if (l.pt && l.shares) {
      if (l.pt.fired === 0) l.pt.r0 = l.shares;
      for (const f of profitTakingFills(l.pt, bar, l.shares, 'intraday', l.cost / l.shares)) sellStock(t, l, f.shares, f.price as number, 'James — Profit-Taking ' + l.pt.schedule + ' step ' + (f.step + 1) + ' $' + f.level.toFixed(2));
    }
    for (const r of [...l.sellRungs]) if (l.shares && bar.high >= r.price) {
      sellStock(t, l, Math.max(1, Math.round(l.shares * r.portion)), Math.max(r.price, bar.open), 'LILO target $' + r.price.toFixed(2));
      l.sellRungs = l.sellRungs.filter((x) => x !== r);
    }
    if (l.shares && !l.pt && !l.sellRungs.length && !l.buyRungs.length) sellStock(t, l, l.shares, bar.close, 'LILO ladder done');
    if (!l.shares && !l.buyRungs.length) delete b.lines[t];
  }

  // 3. the close: new ladders
  if (signals && qqq) {
    let equity = b.cash + b.qqq.shares * qqq.close;
    for (const [t, l] of Object.entries(b.lines)) equity += l.shares * (bars.get(t)?.close ?? (l.shares ? l.cost / l.shares : 0));
    const free = slots - Object.keys(b.lines).length;
    const picks = [...signals].filter(([t]) => !b.lines[t] && bars.has(t)).sort((x, y) => y[1].rank - x[1].rank || x[0].localeCompare(y[0])).slice(0, Math.max(0, free));
    for (const [t, s] of picks) {
      const entry = computeStockEntryLadder({ entryLow: s.entryLow, entryHigh: s.entryHigh, entryCount: s.entryCount });
      const exit = computeStockExitLadder({ t1: s.t1 != null ? { price: s.t1 } : null, t2: s.t2 != null ? { price: s.t2 } : null });
      if (!entry.length || !exit.length) continue;
      const slot = equity / slots, planned = Math.floor(slot / s.entryHigh);
      const levels = opts.profitTaking ? opts.profitTaking.layersOf(t) : null;
      b.lines[t] = {
        ...(levels && opts.profitTaking ? { pt: newPtState(opts.profitTaking.schedule, levels, 0) } : {}),
        shares: 0, cost: 0, age: 0, stop: s.stop, reserved: slot, funded: false,
        buyRungs: entry.map((x) => ({ price: x.price, shares: Math.floor(planned * x.portion) })),
        sellRungs: levels ? [] : exit.map((x, k) => ({ price: x.price, portion: k === exit.length - 1 ? 1 : x.portion / exit.slice(k).reduce((a, y) => a + y.portion, 0) })),
      };
    }
  }
  return out;
}

/** Value after the tax on what is still held. */
export function liloValue(b: LiloBook, closeOf: (t: string) => number | null): number {
  const taxed = (shares: number, cost: number, px: number): number => shares * px - Math.max(0, shares * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.qqq.shares ? taxed(b.qqq.shares, b.qqq.cost, closeOf('QQQ') ?? b.qqq.cost / b.qqq.shares) : 0);
  for (const [t, l] of Object.entries(b.lines)) if (l.shares) v += taxed(l.shares, l.cost, closeOf(t) ?? l.cost / l.shares);
  return v;
}

/** Every stock LILO holds or has a ladder on. */
export const liloHeld = (b: LiloBook): string[] => Object.keys(b.lines).filter((t) => b.lines[t]!.shares > 0).sort();
