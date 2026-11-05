/**
 * James — Pair Rotation's book (docs/models/plans/06-pair-rotation.md section 5): one account always in ONE leg of a
 * pair (100% swap), or a 50% core (25% A + 25% B, never traded) plus a 50% swap sleeve. Decide at the close, sell the
 * held leg and buy the other at the next open; the tax (25%, or 0 for the labelled Roth run) on each sold leg's gain;
 * the shared `costBps` on every buy and sell. Long only: never short, never more than the account. Plain-JSON state
 * (`PairBook`), so the paper test keeps it between nights; `runPair` replays it on history.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { alignPair, ratioBars, pairStateSeries, type PairOptions, type PairDay } from '../analysis/models/pairRotation.ts';

export interface PairLot { shares: number; cost: number }
export interface PairBook {
  readonly a: string; readonly b: string;
  cash: number;
  /** The swap pot: the leg held (ticker) and its shares. */
  hold: string | null; pot: PairLot;
  /** The 50% core of the sleeve variant (never traded); empty for a 100% swap. */
  core: Record<string, PairLot>;
  /** Tonight's decision: the leg to hold from the next open. */
  toHold: string | null;
  sleeve: boolean; coreBought: boolean;
}
export const newPairBook = (a: string, b: string, cash: number, sleeve = false): PairBook => ({ a, b, cash, hold: null, pot: { shares: 0, cost: 0 }, core: {}, toHold: null, sleeve, coreBought: false });

export interface PairTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string }

/** One day: the open (the swap decided last night, the sleeve's core on the first fill), then tonight's decision (`want`). */
export function pairDay(k: PairBook, o: { readonly costBps?: number; readonly taxRate?: number }, x: { readonly opens: ReadonlyMap<string, number>; readonly fill: boolean; readonly want: string | null; readonly why?: string }): PairTrade[] {
  const out: PairTrade[] = [];
  const c = (o.costBps ?? 0) / 10_000, tr = o.taxRate ?? EXIT_TAX_RATE;
  const buy = (lot: PairLot, t: string, money: number, why: string): void => {
    const px = x.opens.get(t) as number, pc = px * (1 + c), n = Math.floor(Math.min(money, k.cash) / pc);
    if (n <= 0) return;
    k.cash -= n * pc; lot.shares += n; lot.cost += n * pc;
    out.push({ ticker: t, side: 'BUY', shares: n, price: px, tax: 0, why });
  };
  if (x.fill && x.opens.has(k.a) && x.opens.has(k.b)) {
    if (k.sleeve && !k.coreBought) {
      const quarter = k.cash / 4;
      for (const t of [k.a, k.b]) { k.core[t] ??= { shares: 0, cost: 0 }; buy(k.core[t]!, t, quarter, 'the core (never traded)'); }
      k.coreBought = true;
    }
    if (k.toHold && k.toHold !== k.hold) {
      if (k.hold && k.pot.shares) {
        const px = x.opens.get(k.hold) as number, v = k.pot.shares * px, fee = v * c, tax = Math.max(0, v - fee - k.pot.cost) * tr;
        k.cash += v - fee - tax;
        out.push({ ticker: k.hold, side: 'SELL', shares: k.pot.shares, price: px, tax, why: 'swap into ' + k.toHold + (x.why ? ' (' + x.why + ')' : '') });
        k.pot = { shares: 0, cost: 0 };
      }
      const into = k.toHold;
      buy(k.pot, into, k.cash, k.hold ? 'swap from ' + k.hold : 'the starting leg');
      if (k.pot.shares) k.hold = into;
    }
    k.toHold = null;
  }
  if (x.want && x.want !== k.hold) k.toHold = x.want;
  return out;
}

export function pairValue(k: PairBook, closeOf: (t: string) => number | null, taxRate = EXIT_TAX_RATE): number {
  const taxed = (l: PairLot, t: string): number => { const px = closeOf(t) ?? (l.shares ? l.cost / l.shares : 0), v = l.shares * px; return v - Math.max(0, v - l.cost) * taxRate; };
  return k.cash + (k.hold ? taxed(k.pot, k.hold) : 0) + Object.entries(k.core).reduce((a, [t, l]) => a + taxed(l, t), 0);
}
export const pairHeld = (k: PairBook): string[] => [...new Set([...(k.hold && k.pot.shares ? [k.hold] : []), ...Object.keys(k.core).filter((t) => k.core[t]!.shares > 0)])].sort();

// ─────────────────────────────── history ───────────────────────────────

export interface PairSetup { readonly name: string; readonly opts: PairOptions; readonly sleeve: boolean }

export interface PairResult {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number; readonly swaps: number; readonly taxPaid: number;
  /** A- and B-equivalent shares at the end vs at the start, % change. */
  readonly aEquivPct: number; readonly bEquivPct: number;
  readonly cashShareByDay: Map<string, number>; readonly buysByTicker: Map<string, number>;
  readonly swapsList: Array<{ day: string; into: string; R: number }>;
  /** Every completed round trip back into the starting leg: R at the two swaps, the share gain, the worst fall of the other leg while held. */
  readonly roundTrips: Array<{ from: string; out: string; back: string; R1: number; R2: number; shareGain: number; worst: number }>;
  readonly years: number; readonly firstDay: string | null;
}

const stateCache = new WeakMap<PriceSeries, Map<PriceSeries, Map<string, { al: ReturnType<typeof alignPair>; st: PairDay[] }>>>();
export function pairStates(A: PriceSeries, B: PriceSeries, o: PairOptions): { al: ReturnType<typeof alignPair>; st: PairDay[] } {
  let m1 = stateCache.get(A); if (!m1) stateCache.set(A, (m1 = new Map()));
  let m2 = m1.get(B); if (!m2) m1.set(B, (m2 = new Map()));
  const key = JSON.stringify(o);
  let r = m2.get(key);
  if (!r) { const al = alignPair(A, B); r = { al, st: pairStateSeries(ratioBars(A, B, al), o) }; m2.set(key, r); }
  return r;
}

/**
 * One run over [start, end] (the days both legs trade). The first fill buys the leg held after the previous close
 * (money waits in cash until the signal has its history). `swapDays`: the random-swap null (the held leg is swapped at
 * the next open after each of these days; the first leg is the model's).
 */
export function runPair(A: PriceSeries, B: PriceSeries, start: string, end: string, s: PairSetup, costBps = 0, taxRate = EXIT_TAX_RATE, swapDays?: ReadonlySet<string>): PairResult {
  const { al, st } = pairStates(A, B, s.opts);
  const k = newPairBook(A.ticker, B.ticker, 100_000, s.sleeve);
  const js = al.dates.map((d, j) => (d >= start && d <= end ? j : -1)).filter((j) => j >= 0);
  let peak = 100_000, dd = 0, swaps = 0, taxPaid = 0, trades = 0;
  const cashShareByDay = new Map<string, number>(), swapsList: PairResult['swapsList'] = [];
  let tripStart: { into: string; R: number; day: string } | null = null, legLow = Infinity, legEntry = 0, startLeg: string | null = null;
  const roundTrips: PairResult['roundTrips'] = [];
  if (js.length && js[0]! > 0) k.toHold = st[js[0]! - 1]!.hold === 'A' ? A.ticker : st[js[0]! - 1]!.hold === 'B' ? B.ticker : null;
  const close = new Map<string, number>();
  js.forEach((j, n) => {
    const ia = al.ia[j]!, ib = al.ib[j]!;
    const opens = new Map([[A.ticker, A.opens[ia] as number], [B.ticker, B.opens[ib] as number]]);
    close.set(A.ticker, A.closes[ia] as number); close.set(B.ticker, B.closes[ib] as number);
    let want: string | null = null;
    if (n < js.length - 1) {
      if (swapDays) {
        const cur = k.toHold ?? k.hold;
        want = cur == null ? (st[j]!.hold === 'A' ? A.ticker : st[j]!.hold === 'B' ? B.ticker : null) : swapDays.has(al.dates[j]!) ? (cur === A.ticker ? B.ticker : A.ticker) : cur;
      } else want = st[j]!.hold === 'A' ? A.ticker : st[j]!.hold === 'B' ? B.ticker : null;
    }
    const before = k.hold;
    const tr = pairDay(k, { costBps, taxRate }, { opens, fill: true, want });
    for (const x of tr) { trades++; taxPaid += x.tax; }
    if (k.hold !== before && k.hold) {
      const R = (A.opens[ia] as number) / (B.opens[ib] as number);
      if (before) {
        swaps++; swapsList.push({ day: al.dates[j]!, into: k.hold, R });
        if (k.hold !== startLeg && tripStart == null) tripStart = { into: k.hold, R, day: al.dates[j]! };
        else if (k.hold === startLeg && tripStart) {
          const R1 = tripStart.R, R2 = R, gain = startLeg === A.ticker ? R1 / R2 - 1 : R2 / R1 - 1;
          roundTrips.push({ from: tripStart.day, out: tripStart.into, back: startLeg, R1, R2, shareGain: gain, worst: legLow });
          tripStart = null;
        }
      } else startLeg = k.hold;
      legEntry = k.hold === A.ticker ? (A.opens[ia] as number) : (B.opens[ib] as number); legLow = 0;
    }
    if (k.hold) { const c = close.get(k.hold)!; legLow = Math.min(legLow, c / legEntry - 1); }
    const eq = k.cash + (k.hold ? k.pot.shares * close.get(k.hold)! : 0) + Object.entries(k.core).reduce((a, [t, l]) => a + l.shares * close.get(t)!, 0);
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
    cashShareByDay.set(al.dates[j]!, eq > 0 ? Math.min(1, Math.max(0, k.cash) / eq) : 1);
  });
  const fin = pairValue(k, (t) => close.get(t) ?? null, taxRate);
  const j0 = js[0], j1 = js[js.length - 1];
  const aEq = j0 == null ? 0 : (fin / (A.closes[al.ia[j1!]!] as number)) / (100_000 / (A.opens[al.ia[j0]!] as number)) * 100 - 100;
  const bEq = j0 == null ? 0 : (fin / (B.closes[al.ib[j1!]!] as number)) / (100_000 / (B.opens[al.ib[j0]!] as number)) * 100 - 100;
  const years = j0 == null ? 0 : (Date.parse(al.dates[j1!]!) - Date.parse(al.dates[j0]!)) / 86_400_000 / 365.25;
  return { finalTaxed: fin, maxDrawdownPct: dd, trades, swaps, taxPaid, aEquivPct: aEq, bEquivPct: bEq, cashShareByDay, buysByTicker: new Map([['PAIR', swaps]]), swapsList, roundTrips, years, firstDay: j0 == null ? null : al.dates[j0]! };
}

/** 50/50 rebalanced every year (the first trading day of each calendar year; each sale taxed); the yardstick pays the cost on each trade. */
export function hold5050Yearly(A: PriceSeries, B: PriceSeries, start: string, end: string, costBps = 0): { finalTaxed: number; maxDrawdownPct: number } {
  const al = alignPair(A, B), c = costBps / 10_000;
  const js = al.dates.map((d, j) => (d >= start && d <= end ? j : -1)).filter((j) => j >= 0);
  let cash = 100_000, peak = 100_000, dd = 0, year = '';
  const lot: Record<string, PairLot> = { [A.ticker]: { shares: 0, cost: 0 }, [B.ticker]: { shares: 0, cost: 0 } };
  const pxA = (j: number, f: 'opens' | 'closes'): number => A[f][al.ia[j]!] as number, pxB = (j: number, f: 'opens' | 'closes'): number => B[f][al.ib[j]!] as number;
  for (const j of js) {
    const y = al.dates[j]!.slice(0, 4);
    if (y !== year) {
      year = y;
      const pa = pxA(j, 'opens'), pb = pxB(j, 'opens');
      const total = cash + lot[A.ticker]!.shares * pa + lot[B.ticker]!.shares * pb, target = total / 2;
      for (const [t, p] of [[A.ticker, pa], [B.ticker, pb]] as const) {
        const l = lot[t]!, over = l.shares * p - target;
        if (over > p) { const n = Math.floor(over / p), part = (l.cost * n) / l.shares, v = n * p, fee = v * c; l.shares -= n; l.cost -= part; cash += v - fee - Math.max(0, v - fee - part) * EXIT_TAX_RATE; }
      }
      for (const [t, p] of [[A.ticker, pa], [B.ticker, pb]] as const) {
        const l = lot[t]!, under = target - l.shares * p, n = Math.floor(Math.min(under, cash) / (p * (1 + c)));
        if (n > 0) { cash -= n * p * (1 + c); l.shares += n; l.cost += n * p * (1 + c); }
      }
    }
    const eq = cash + lot[A.ticker]!.shares * pxA(j, 'closes') + lot[B.ticker]!.shares * pxB(j, 'closes');
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
  }
  const jl = js[js.length - 1];
  let fin = cash;
  if (jl != null) for (const [t, p] of [[A.ticker, pxA(jl, 'closes')], [B.ticker, pxB(jl, 'closes')]] as const) { const l = lot[t]!, v = l.shares * p; fin += v - Math.max(0, v - l.cost) * EXIT_TAX_RATE; }
  return { finalTaxed: fin, maxDrawdownPct: dd };
}
