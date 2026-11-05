/**
 * LEAPS accounts in the paper test (owner 2026-10-28: the forward test may also buy options, LEAPS calls, the
 * owner's way). Long calls only. One account per research setup (paperLab.ts LAB_SETUPS): it holds a LEAPS call on
 * exactly the stocks its stock twin holds, with the same number of slots, instead of the shares.
 *
 * The contract is the engine's LEAPS pick (`selectRecommendedCall`, legacy selectRecommendedCallV7): the furthest
 * expiry at least 180 days out, the call whose delta is closest to 0.75. Prices are Cboe's delayed quotes read at
 * night (the day's closing quotes): a decision made tonight fills tomorrow night, buying at the ask and selling at
 * the bid. Sold: when the stock twin sells, and always once 60 days or fewer are left to expiry (the exit report's
 * LEAPS window; a fresh LEAPS is bought the same way when the stock is still held). Spare money waits in QQQ, traded
 * at the open. 25% tax on every sale's gain. Values use the middle of bid and ask.
 */

import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';

export const LEAPS_EXIT_DAYS = 60;
export const CONTRACT = 100;
/** An order whose contract has no quote for this many nights is dropped. */
const ORDER_NIGHTS = 5;

/** `delta` / `why`: James — LEAPS's pick (model 3) carries its delta (for the delta cap) and the log's reason. */
export interface LeapsPick { readonly symbol: string; readonly strike: number; readonly expUnix: number; readonly bid: number; readonly ask: number; readonly delta?: number; readonly why?: string }
export interface LeapsQuote { readonly bid: number; readonly ask: number }
/** `delta`, `lastTrim`, `reserved`: James — LEAPS accounts only (absent on the engine twins). */
export interface LeapsHolding { readonly ticker: string; readonly symbol: string; readonly strike: number; readonly expUnix: number; contracts: number; cost: number; mid: number; delta?: number; lastTrim?: number; reserved?: boolean }
export interface LeapsOrder {
  readonly side: 'BUY' | 'SELL'; readonly ticker: string; readonly symbol: string; readonly strike: number; readonly expUnix: number;
  readonly contracts: number; readonly estPrice: number; readonly why: string; nights: number;
  /** A SELL of only `contracts` of the holding (trim, delta cap, contracts that cannot be covered at expiry). */
  readonly partial?: boolean;
  readonly delta?: number;
}
/**
 * `shares`, `shareSells`, `reserve`: James — LEAPS's hold-to-expiry accounts (model 3, X3): the stock an exercise
 * turned the calls into (cost = strike + premium paid), the share sales decided for the next open, and the cash held
 * back for an exercise. Absent on the engine twins.
 */
export interface LeapsAccount {
  cash: number; qqq: { shares: number; cost: number }; held: LeapsHolding[]; orders: LeapsOrder[];
  shares?: Record<string, { shares: number; cost: number; armed: boolean }>;
  shareSells?: string[];
  reserve?: number;
}
export interface LeapsTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string }

export const newLeapsAccount = (cash: number): LeapsAccount => ({ cash, qqq: { shares: 0, cost: 0 }, held: [], orders: [] });

export interface LeapsNight {
  readonly qqq: { readonly open: number; readonly close: number } | null;
  /** Tonight's quote for a contract. */
  readonly quote: (symbol: string) => LeapsQuote | null;
  /** Tonight's LEAPS pick for a stock. */
  readonly pick: (ticker: string) => LeapsPick | null;
  /** Tonight, in seconds. */
  readonly nowUnix: number;
  /** The stocks the twin holds after tonight's decisions, and its slots. */
  readonly want: ReadonlySet<string>;
  readonly slots: number;
  /** Trade tonight (false on the night the account joins). */
  readonly fill: boolean;
  /** Decide tonight (false after the last day). */
  readonly decide: boolean;
  /** James — LEAPS: tonight's stock bar (for an exercise at the close and share sales at the open). */
  readonly stock?: (ticker: string) => { readonly open: number; readonly close: number } | null;
  /** James — LEAPS: the 200-day trend tonight: close above the average, and broken (3% under it). */
  readonly trend?: (ticker: string) => { readonly above: boolean; readonly broken: boolean } | null;
  /** James — LEAPS: tonight's close is a +2 SD spike (X4 trim). */
  readonly spike?: (ticker: string) => boolean;
}

/**
 * James — LEAPS (model 3, docs/models/plans/03-james-leaps-method.md 2.2 C-D). Every field off = the engine twins'
 * behaviour exactly (a test pins it).
 *   exit 'expiry'  X3: no 60-day sale; the expiry checklist 7 calendar days (about 5 trading days) before expiry
 *                  (cash for the exercise held back, QQQ sold for it, contracts that cannot be covered sold to close);
 *                  on the expiry night every contract ITM by $0.01+ at the stock's close is exercised (cash debited,
 *                  shares at cost strike + premium), the rest expire worthless; the shares then follow the
 *                  trend-200 sell, armed once the stock has closed above its 200-day average.
 *   trim           X4: on a +2 SD close, a third of the contracts (at least 3 held), at most once per 60 days.
 *   onePlus        one contract when one costs more than a slot but at most onePlus x the slot.
 *   deltaCap       buys only while delta exposure (contracts x 100 x delta x price + shares) <= cap x equity; above
 *                  1.2 x cap, the excess is sold to close.
 */
export interface LeapsOptions {
  readonly exit?: 'roll60' | 'expiry';
  readonly trim?: boolean;
  readonly onePlus?: number;
  readonly deltaCap?: number | null;
}
const CHECKLIST_DAYS = 7;
const TRIM_GAP_SEC = 60 * 86_400;

const label = (h: { ticker: string; strike: number; expUnix: number }): string => h.ticker + ' $' + h.strike + ' call ' + new Date(h.expUnix * 1000).toISOString().slice(0, 10);

export function leapsNight(a: LeapsAccount, n: LeapsNight, opt: LeapsOptions = {}): LeapsTrade[] {
  const out: LeapsTrade[] = [];
  // 10% over last night's ask, so a day's rise does not cut the order (plus, for James — LEAPS, the cash held for an exercise)
  const reserved = (): number => a.orders.filter((o) => o.side === 'BUY').reduce((s, o) => s + o.contracts * o.estPrice * CONTRACT * 1.1, 0) + (a.reserve ?? 0);

  // James — LEAPS: share sales (exercised stock) at the open, before the QQQ step
  if (n.fill && a.shareSells?.length && a.shares) {
    for (const t of a.shareSells) {
      const p = a.shares[t], bar = n.stock?.(t);
      if (!p || !bar) continue;
      const v = p.shares * bar.open, tax = Math.max(0, v - p.cost) * EXIT_TAX_RATE;
      a.cash += v - tax; delete a.shares[t];
      out.push({ ticker: t, side: 'SELL', shares: p.shares, price: bar.open, tax, why: 'the exercised shares: the 200-day trend broke' });
    }
    a.shareSells = [];
  }

  if (n.fill && n.qqq) {
    // the open: money for tonight's buys out of QQQ, the rest into QQQ
    const q = n.qqq.open, need = reserved() - a.cash;
    if (need > 0 && a.qqq.shares) {
      const k = Math.min(a.qqq.shares, Math.ceil(need / q)), cost = (a.qqq.cost * k) / a.qqq.shares, tax = Math.max(0, k * q - cost) * EXIT_TAX_RATE;
      a.qqq.shares -= k; a.qqq.cost -= cost; a.cash += k * q - tax;
      out.push({ ticker: 'QQQ', side: 'SELL', shares: k, price: q, tax, why: 'money for a LEAPS' });
    } else if (need < 0) {
      const k = Math.floor(-need / q);
      if (k > 0) { a.cash -= k * q; a.qqq.shares += k; a.qqq.cost += k * q; out.push({ ticker: 'QQQ', side: 'BUY', shares: k, price: q, tax: 0, why: 'spare money' }); }
    }
  }

  if (n.fill) {
    // the close: last night's orders, sells first, at tonight's quotes
    const left: LeapsOrder[] = [];
    for (const o of [...a.orders].sort((x, y) => (x.side === 'SELL' ? 0 : 1) - (y.side === 'SELL' ? 0 : 1))) {
      const qt = n.quote(o.symbol);
      if (o.side === 'SELL') {
        const h = a.held.find((x) => x.symbol === o.symbol);
        if (!h) continue;
        if (!qt || !(qt.bid > 0)) { if (++o.nights < ORDER_NIGHTS) left.push(o); continue; }
        if (o.partial && o.contracts < h.contracts) {
          const m = o.contracts, part = (h.cost * m) / h.contracts, value = m * qt.bid * CONTRACT, tax = Math.max(0, value - part) * EXIT_TAX_RATE;
          a.cash += value - tax; h.contracts -= m; h.cost -= part;
          if (h.reserved) a.reserve = Math.max(0, (a.reserve ?? 0) - m * h.strike * CONTRACT);
          out.push({ ticker: label(h), side: 'SELL', shares: m, price: qt.bid, tax, why: o.why });
          continue;
        }
        if (h.reserved) a.reserve = Math.max(0, (a.reserve ?? 0) - h.contracts * h.strike * CONTRACT);
        const value = h.contracts * qt.bid * CONTRACT, tax = Math.max(0, value - h.cost) * EXIT_TAX_RATE;
        a.cash += value - tax; a.held = a.held.filter((x) => x !== h);
        out.push({ ticker: label(h), side: 'SELL', shares: h.contracts, price: qt.bid, tax, why: o.why });
      } else {
        if (!qt || !(qt.ask > 0)) { if (++o.nights < ORDER_NIGHTS) left.push(o); continue; }
        const k = Math.min(o.contracts, Math.floor((a.cash - (a.reserve ?? 0)) / (qt.ask * CONTRACT)));
        if (k <= 0) continue;
        a.cash -= k * qt.ask * CONTRACT;
        a.held.push({ ticker: o.ticker, symbol: o.symbol, strike: o.strike, expUnix: o.expUnix, contracts: k, cost: k * qt.ask * CONTRACT, mid: (qt.bid + qt.ask) / 2, ...(o.delta != null ? { delta: o.delta } : {}) });
        out.push({ ticker: label(o), side: 'BUY', shares: k, price: qt.ask, tax: 0, why: o.why });
      }
    }
    a.orders = left;
  }

  // tonight's marks
  for (const h of a.held) { const qt = n.quote(h.symbol); if (qt && qt.bid > 0 && qt.ask > 0) h.mid = (qt.bid + qt.ask) / 2; }

  // James — LEAPS, X3: the expiry night — exercise what is in the money by $0.01+ at the stock's close, the rest expires
  if (opt.exit === 'expiry' && n.fill) {
    for (const h of [...a.held]) {
      if (n.nowUnix < h.expUnix || a.orders.some((o) => o.symbol === h.symbol)) continue;
      const bar = n.stock?.(h.ticker);
      if (!bar) continue;
      a.held = a.held.filter((x) => x !== h);
      if (h.reserved) a.reserve = Math.max(0, (a.reserve ?? 0) - h.strike * CONTRACT * h.contracts);
      if (bar.close >= h.strike + 0.01) {
        const k = Math.min(h.contracts, Math.floor(a.cash / (h.strike * CONTRACT)));
        if (k > 0) {
          const part = (h.cost * k) / h.contracts;
          a.cash -= k * h.strike * CONTRACT;
          const sh = (a.shares ??= {})[h.ticker] ??= { shares: 0, cost: 0, armed: false };
          sh.shares += k * CONTRACT; sh.cost += k * h.strike * CONTRACT + part;
          out.push({ ticker: label(h), side: 'SELL', shares: k, price: h.strike, tax: 0, why: 'exercised at expiry: ' + k * CONTRACT + ' ' + h.ticker + ' shares at $' + h.strike + ' (cost basis strike + premium)' });
          out.push({ ticker: h.ticker, side: 'BUY', shares: k * CONTRACT, price: h.strike, tax: 0, why: 'exercise of the ' + label(h) });
        }
        if (k < h.contracts) {
          // not enough cash (the checklist should have sold these): settled at the intrinsic value
          const m = h.contracts - k, part = (h.cost * m) / h.contracts, value = m * (bar.close - h.strike) * CONTRACT, tax = Math.max(0, value - part) * EXIT_TAX_RATE;
          a.cash += value - tax;
          out.push({ ticker: label(h), side: 'SELL', shares: m, price: bar.close - h.strike, tax, why: 'not enough cash to exercise: settled at the intrinsic value' });
        }
      } else out.push({ ticker: label(h), side: 'SELL', shares: h.contracts, price: 0, tax: 0, why: 'expired worthless (out of the money at the close)' });
    }
  }

  if (n.decide) {
    const pending = new Set(a.orders.map((o) => o.symbol));
    const keep = new Set<string>();
    const qClose = n.qqq?.close ?? 0;
    for (const h of a.held) {
      if (pending.has(h.symbol)) continue;
      const daysLeft = (h.expUnix - n.nowUnix) / 86_400;
      const why = !n.want.has(h.ticker) ? 'the stock account sells ' + h.ticker : opt.exit !== 'expiry' && daysLeft <= LEAPS_EXIT_DAYS ? Math.floor(daysLeft) + ' days to expiry' : null;
      if (why) { a.orders.push({ side: 'SELL', ticker: h.ticker, symbol: h.symbol, strike: h.strike, expUnix: h.expUnix, contracts: h.contracts, estPrice: h.mid, why, nights: 0 }); continue; }
      keep.add(h.ticker);
      // X3: the expiry checklist, 7 calendar days before expiry, for a contract in the money tonight
      const close = n.stock?.(h.ticker)?.close ?? null;
      if (opt.exit === 'expiry' && !h.reserved && daysLeft <= CHECKLIST_DAYS && close != null && close > h.strike) {
        const need = h.strike * CONTRACT * h.contracts, avail = a.cash + a.qqq.shares * qClose - (a.reserve ?? 0);
        const cover = avail >= need ? h.contracts : Math.max(0, Math.floor(avail / (h.strike * CONTRACT)));
        if (cover < h.contracts) a.orders.push({ side: 'SELL', ticker: h.ticker, symbol: h.symbol, strike: h.strike, expUnix: h.expUnix, contracts: h.contracts - cover, estPrice: h.mid, why: 'expiry checklist: not enough cash to exercise ' + (h.contracts - cover) + ' contract(s); sold to close early', nights: 0, partial: true });
        a.reserve = (a.reserve ?? 0) + h.contracts * h.strike * CONTRACT; h.reserved = true;
        continue;
      }
      // X4: a third on a +2 SD spike, once per 60 days
      if (opt.trim && h.contracts >= 3 && n.spike?.(h.ticker) && n.nowUnix - (h.lastTrim ?? 0) >= TRIM_GAP_SEC && !h.reserved) {
        a.orders.push({ side: 'SELL', ticker: h.ticker, symbol: h.symbol, strike: h.strike, expUnix: h.expUnix, contracts: Math.floor(h.contracts / 3), estPrice: h.mid, why: 'spike trim: a third on a +2 SD close (the long-only stand-in for James selling a call on spikes)', nights: 0, partial: true });
        h.lastTrim = n.nowUnix;
      }
    }
    // the exercised shares: the trend-200 sell, armed once the stock has closed above its 200-day average
    for (const [t, p] of Object.entries(a.shares ?? {})) {
      const tr = n.trend?.(t);
      if (!tr) continue;
      if (tr.above) p.armed = true;
      if (p.armed && tr.broken && !(a.shareSells ??= []).includes(t)) a.shareSells.push(t);
    }
    const priceOf = (t: string): number => n.stock?.(t)?.close ?? 0;
    const exposure = (): number => a.held.reduce((s, h) => s + h.contracts * CONTRACT * (h.delta ?? 0.75) * priceOf(h.ticker), 0) + Object.entries(a.shares ?? {}).reduce((s, [t, p]) => s + p.shares * priceOf(t), 0);
    const buying = new Set(a.orders.filter((o) => o.side === 'BUY').map((o) => o.ticker));
    const equity = a.cash + a.qqq.shares * qClose + a.held.reduce((s, h) => s + h.contracts * h.mid * CONTRACT, 0) + Object.entries(a.shares ?? {}).reduce((s, [t, p]) => s + p.shares * (priceOf(t) || p.cost / p.shares), 0);
    // the delta cap: above 1.2 x cap, sell the excess (pro rata)
    if (opt.deltaCap != null && equity > 0) {
      const ex = exposure();
      if (ex > 1.2 * opt.deltaCap * equity) {
        const f = 1 - (opt.deltaCap * equity) / ex;
        for (const h of a.held) {
          const m = Math.min(h.contracts, Math.ceil(h.contracts * f));
          if (m > 0 && !a.orders.some((o) => o.symbol === h.symbol)) a.orders.push({ side: 'SELL', ticker: h.ticker, symbol: h.symbol, strike: h.strike, expUnix: h.expUnix, contracts: m, estPrice: h.mid, why: 'delta cap: exposure ' + (ex / equity).toFixed(2) + ' x equity, above 1.2 x', nights: 0, partial: true });
        }
      }
    }
    const slot = equity / n.slots;
    let room = opt.deltaCap != null ? opt.deltaCap * equity - exposure() : Infinity;
    for (const t of [...n.want].sort()) {
      if (keep.has(t) || buying.has(t) || a.shares?.[t]) continue;
      const p = n.pick(t);
      if (!p || !(p.ask > 0) || (opt.exit !== 'expiry' && (p.expUnix - n.nowUnix) / 86_400 <= LEAPS_EXIT_DAYS)) continue;
      let k = Math.floor(slot / (p.ask * CONTRACT));
      if (k <= 0 && opt.onePlus != null && p.ask * CONTRACT <= opt.onePlus * slot) k = 1;
      if (opt.deltaCap != null) { const per = CONTRACT * (p.delta ?? 0.75) * priceOf(t); k = per > 0 ? Math.min(k, Math.floor(Math.max(0, room) / per)) : 0; room -= k * per; }
      if (k > 0) a.orders.push({ side: 'BUY', ticker: t, symbol: p.symbol, strike: p.strike, expUnix: p.expUnix, contracts: k, estPrice: p.ask, why: p.why ?? 'LEAPS on ' + t + ' (delta ~0.75)', nights: 0, ...(p.delta != null ? { delta: p.delta } : {}) });
    }
  }
  return out;
}

/** Value after the tax on what is still held (calls at the middle of bid and ask; exercised shares at `closeOf`). */
export function leapsValue(a: LeapsAccount, qqqClose: number | null, closeOf?: (t: string) => number | null): number {
  let v = a.cash;
  if (a.qqq.shares) { const val = a.qqq.shares * (qqqClose ?? a.qqq.cost / a.qqq.shares); v += val - Math.max(0, val - a.qqq.cost) * EXIT_TAX_RATE; }
  for (const h of a.held) { const val = h.contracts * h.mid * CONTRACT; v += val - Math.max(0, val - h.cost) * EXIT_TAX_RATE; }
  for (const [t, p] of Object.entries(a.shares ?? {})) { const val = p.shares * (closeOf?.(t) ?? p.cost / p.shares); v += val - Math.max(0, val - p.cost) * EXIT_TAX_RATE; }
  return v;
}

export const leapsHeld = (a: LeapsAccount): string[] => [...a.held.map((h) => label(h)), ...Object.keys(a.shares ?? {}).map((t) => t + ' (shares)')].sort();
