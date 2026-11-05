/**
 * G7 "signal book" (docs/models/MASTER_PLAN.md section 4; plan 05 section 5): a slot book for the signal models that
 * need what `runPortfolio` lacks — a per-position exit decided by the caller (target, time stop, hard stop, trend
 * break), the holding days of each position, and plain-JSON state, so the paper test keeps it between nights.
 *
 * Same conventions as portfolioLab.ts `runPortfolio`: decide at the close, fill at the next open; sells first, then the
 * buys (each 1/slots of the account at the open), funded from QQQ; spare money waits in QQQ ('qqq'), in cash ('cash'),
 * or in QQQ only while QQQ's trend is up ('qqqTrend': the caller passes `idleOut`); 25% tax (EXIT_TAX_RATE) on every
 * sale's gain, QQQ included; the shared `costBps` (G5) on every buy and sell. `runPortfolio` itself is not changed.
 */

import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';

export interface SigPos { shares: number; cost: number; entryDate: string; entryPx: number; /** closes held since the fill */ held: number; /** e.g. the ATR at the decision, for a hard stop */ note: number | null;
  /** Phase 3 (James — Market Maker Stages): the stop and targets set at entry; absent for the older books. */
  plan?: SigPlan }
/** A position's plan at entry (phase 3): the stop, two targets, and whether the first half was sold. */
export interface SigPlan { stop: number; target1: number | null; target2: number | null; halfDone: boolean }
export interface SignalBook {
  cash: number; qqq: { shares: number; cost: number }; pos: Record<string, SigPos>;
  /** Tonight's decisions for the next open: ticker -> why. */
  toSell: Record<string, string>; toBuy: Array<{ t: string; why: string; note: number | null; share?: number; plan?: SigPlan }>;
  /** Phase 3: partial sells for the next open (ticker -> share of the shares, why); absent in the older books. */
  toTrim?: Record<string, { frac: number; why: string }>;
}
export const newSignalBook = (cash: number): SignalBook => ({ cash, qqq: { shares: 0, cost: 0 }, pos: {}, toSell: {}, toBuy: [] });

export interface SignalBookOptions { readonly slots: number; readonly idle: 'qqq' | 'cash' | 'qqqTrend'; readonly costBps?: number }
export interface SigTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string;
  /** a closed stock trade: buy price (with cost), days held */ readonly closed?: { readonly entryPx: number; readonly exitPx: number; readonly held: number; readonly entryDate: string } }

export interface SignalDayInput {
  /** Today ('YYYY-MM-DD'): the entry date of tonight's fills. */
  readonly day?: string;
  readonly bars: ReadonlyMap<string, { readonly open: number; readonly close: number }>;
  readonly qqq: { readonly open: number; readonly close: number } | null;
  /** false: the close only (the first night). */
  readonly fill: boolean;
  /** Tonight's decisions; null = none (the last day). exits: held ticker -> why; entries: candidates, best first. */
  readonly decide: { readonly exits: ReadonlyMap<string, string>; readonly entries: ReadonlyArray<{ t: string; why: string; note?: number | null; share?: number; plan?: SigPlan }>;
    /** Phase 3: partial sells (ticker -> share of the shares). */
    readonly trims?: ReadonlyMap<string, { frac: number; why: string }> } | null;
  /** 'qqqTrend': QQQ's trend is down tonight (idle money in cash). */
  readonly idleOut?: boolean;
}

export function signalDay(b: SignalBook, o: SignalBookOptions, x: SignalDayInput): SigTrade[] {
  const out: SigTrade[] = [];
  const c = (o.costBps ?? 0) / 10_000;
  const sellQqq = (n: number, px: number, why: string): void => {
    n = Math.min(n, b.qqq.shares); if (n <= 0) return;
    const cost = (b.qqq.cost * n) / b.qqq.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    b.qqq.shares -= n; b.qqq.cost -= cost; b.cash += n * px - fee - tax;
    out.push({ ticker: 'QQQ', side: 'SELL', shares: n, price: px, tax, why });
  };
  const idleQqq = o.idle === 'qqq' || (o.idle === 'qqqTrend' && !x.idleOut);
  if (x.fill && x.qqq) {
    // 1. the open: sells, then buys funded from QQQ, then the spare money
    for (const [t, why] of Object.entries(b.toSell)) {
      const p = b.pos[t], bar = x.bars.get(t);
      if (!p || !bar) continue;
      const v = p.shares * bar.open, fee = v * c, tax = Math.max(0, v - fee - p.cost) * EXIT_TAX_RATE;
      b.cash += v - fee - tax; delete b.pos[t];
      out.push({ ticker: t, side: 'SELL', shares: p.shares, price: bar.open, tax, why, closed: { entryPx: p.cost / p.shares, exitPx: bar.open * (1 - c), held: p.held, entryDate: p.entryDate } });
    }
    b.toSell = {};
    for (const [t, tr] of Object.entries(b.toTrim ?? {})) {
      const p = b.pos[t], bar = x.bars.get(t);
      if (!p || !bar) continue;
      const n = Math.min(p.shares, Math.floor(p.shares * tr.frac));
      if (n <= 0) continue;
      const cost = (p.cost * n) / p.shares, v = n * bar.open, fee = v * c, tax = Math.max(0, v - fee - cost) * EXIT_TAX_RATE;
      b.cash += v - fee - tax; p.shares -= n; p.cost -= cost;
      out.push({ ticker: t, side: 'SELL', shares: n, price: bar.open, tax, why: tr.why, closed: { entryPx: cost / n, exitPx: bar.open * (1 - c), held: p.held, entryDate: p.entryDate } });
      if (p.shares <= 0) delete b.pos[t];
    }
    if (b.toTrim) b.toTrim = {};
    const buys = b.toBuy.filter((y) => x.bars.has(y.t) && !b.pos[y.t]);
    if (!idleQqq && b.qqq.shares) sellQqq(b.qqq.shares, x.qqq.open, 'idle money to cash');
    if (buys.length) {
      let eq = b.cash + b.qqq.shares * x.qqq.open;
      for (const [t, p] of Object.entries(b.pos)) eq += p.shares * (x.bars.get(t)?.open ?? p.cost / p.shares);
      const slot = eq / o.slots;
      // phase 3: an entry may ask for a smaller size (a share of the account, e.g. 1% at risk), never more than a slot
      const size = (y: (typeof buys)[number]): number => (y.share != null ? Math.min(slot, y.share * eq) : slot);
      const need = buys.some((y) => y.share != null) ? buys.reduce((a, y) => a + size(y), 0) - b.cash : slot * buys.length - b.cash;
      if (need > 0) sellQqq(Math.ceil(need / (x.qqq.open * (1 - c))), x.qqq.open, 'money for the buys');
      for (const y of buys) {
        const px = x.bars.get(y.t)!.open, pc = px * (1 + c), n = Math.floor(Math.min(size(y), b.cash) / pc);
        if (n <= 0) continue;
        b.cash -= n * pc; b.pos[y.t] = { shares: n, cost: n * pc, entryDate: x.day ?? '', entryPx: px, held: 0, note: y.note, ...(y.plan ? { plan: { ...y.plan } } : {}) };
        out.push({ ticker: y.t, side: 'BUY', shares: n, price: px, tax: 0, why: y.why });
      }
    }
    b.toBuy = [];
    if (idleQqq) {
      const pc = x.qqq.open * (1 + c), n = Math.floor(b.cash / pc);
      if (n > 0) { b.cash -= n * pc; b.qqq.shares += n; b.qqq.cost += n * pc; out.push({ ticker: 'QQQ', side: 'BUY', shares: n, price: x.qqq.open, tax: 0, why: 'spare money' }); }
    }
  }
  // 2. the close: the holding days, then tonight's decisions
  for (const [t, p] of Object.entries(b.pos)) if (x.bars.has(t)) p.held++;
  if (x.decide) {
    for (const [t, why] of x.decide.exits) if (b.pos[t]) b.toSell[t] = why;
    for (const [t, tr] of x.decide.trims ?? []) if (b.pos[t] && !b.toSell[t]) (b.toTrim ??= {})[t] = { ...tr };
    const keep = Object.keys(b.pos).filter((t) => !b.toSell[t]).length;
    const free = o.slots - keep;
    b.toBuy = x.decide.entries.filter((e) => !b.pos[e.t]).slice(0, Math.max(0, free)).map((e) => ({ t: e.t, why: e.why, note: e.note ?? null, ...(e.share != null ? { share: e.share } : {}), ...(e.plan ? { plan: { ...e.plan } } : {}) }));
  }
  return out;
}

/** Value after the tax on what is still held. */
export function signalValue(b: SignalBook, closeOf: (t: string) => number | null): number {
  const taxed = (shares: number, cost: number, px: number): number => shares * px - Math.max(0, shares * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.qqq.shares ? taxed(b.qqq.shares, b.qqq.cost, closeOf('QQQ') ?? b.qqq.cost / b.qqq.shares) : 0);
  for (const [t, p] of Object.entries(b.pos)) v += taxed(p.shares, p.cost, closeOf(t) ?? p.cost / p.shares);
  return v;
}
/** Value before tax (for the deepest fall and the cash share). */
export function signalEquity(b: SignalBook, closeOf: (t: string) => number | null): number {
  let v = b.cash + b.qqq.shares * (closeOf('QQQ') ?? (b.qqq.shares ? b.qqq.cost / b.qqq.shares : 0));
  for (const [t, p] of Object.entries(b.pos)) v += p.shares * (closeOf(t) ?? p.cost / p.shares);
  return v;
}
export const signalHeld = (b: SignalBook): string[] => Object.keys(b.pos).sort();
