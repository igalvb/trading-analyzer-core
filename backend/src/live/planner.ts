/**
 * From target weights to orders (phase 1, 1.2): the difference between the twin's weights and the real account, at
 * tonight's close as the price estimate.
 *   - sells first; a stock the twin sells is sold whole (exempt from the fee filter, so no dust is left behind);
 *   - the buys use the settled cash plus the sells' money, stocks first (largest first), QQQ last (it takes the rest);
 *   - fractional shares rounded down to 4 decimals when allowed (LIVE_FRACTIONAL), else whole shares rounded down;
 *   - the fee filter: a trade under LIVE_MIN_TRADE ($50) is skipped (mostly small QQQ top-ups);
 *   - the drift report: per ticker, how far the account is from the twin after the plan, in points of the account.
 * Unfilled or skipped trades need no memory: tomorrow's plan starts again from the real positions.
 */

import type { LiveConfig } from './liveConfig.ts';
import { orderFee } from './liveConfig.ts';
import type { RealAccount, HoldingKind } from './account.ts';
import type { Target } from './target.ts';

export interface PlannedOrder {
  readonly ticker: string;
  readonly side: 'BUY' | 'SELL';
  readonly kind: HoldingKind;
  readonly qty: number;
  /** Tonight's close: the estimate (phase 3 sets the real limit). */
  readonly price: number;
  readonly value: number;
  readonly fee: number;
  readonly why: string;
  /** The fixed reference of this order (R5): the same plan always gets the same one. */
  readonly ref: string;
  /** A whole position sold because the twin sells it. */
  readonly fullExit: boolean;
}
export interface SkippedTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly value: number; readonly why: string }
export interface DriftLine { readonly ticker: string; readonly targetPct: number; readonly nowPct: number; readonly afterPct: number }
export interface Plan {
  readonly day: string;
  readonly account: string;
  readonly slots: number;
  /** The real account's value at tonight's prices, before tax. */
  readonly accountValue: number;
  readonly orders: readonly PlannedOrder[];
  readonly skipped: readonly SkippedTrade[];
  readonly drift: readonly DriftLine[];
  /** Half the sum of the gaps after the plan: the share of the account not where the twin has it, %. */
  readonly driftPct: number;
}

export const orderRef = (day: string, account: string, ticker: string, side: string): string => 'LB-' + day + '-' + account + '-' + ticker + '-' + side;

/** Shares rounded down: to 4 decimals with fractions, else to whole shares. */
export function roundShares(x: number, fractional: boolean): number {
  if (!(x > 0)) return 0;
  return fractional ? Math.floor(x * 10_000 + 1e-6) / 10_000 : Math.floor(x + 1e-9);
}

export function planTrades(target: Target, acct: RealAccount, closeOf: (t: string) => number | null, cfg: Pick<LiveConfig, 'fractional' | 'minTrade' | 'fees'>): Plan {
  const day = target.decisionDay;
  const held = new Map(acct.positions.filter((p) => (p.kind ?? 'share') === 'share').map((p) => [p.ticker, p]));
  const priceOf = (t: string): number | null => { const p = closeOf(t); if (p != null && p > 0) return p; const h = held.get(t); return h && h.shares > 0 ? h.cost / h.shares : null; };
  let V = acct.cash;
  for (const p of acct.positions) { const px = closeOf(p.ticker); V += px == null ? p.cost : p.shares * px * (p.kind === 'call' || p.kind === 'put' ? 100 : 1); }
  const tickers = [...new Set([...Object.keys(target.weights), ...held.keys()])].sort();
  const want = (t: string): number => target.weights[t] ?? 0;
  const orders: PlannedOrder[] = [], skipped: SkippedTrade[] = [];
  const order = (t: string, side: 'BUY' | 'SELL', qty: number, px: number, why: string, fullExit = false): PlannedOrder =>
    ({ ticker: t, side, kind: 'share', qty, price: px, value: qty * px, fee: orderFee(qty, px, cfg.fees), why, ref: orderRef(day, target.account, t, side), fullExit });
  const whyOf = (t: string): string => target.why[t] ?? (t in target.weights ? '' : 'not held by the twin: sold to match it');

  // 1. sells
  for (const t of tickers) {
    const h = held.get(t), px = priceOf(t);
    if (!h || !(h.shares > 0) || px == null) continue;
    const diff = want(t) * V - h.shares * px;
    if (diff >= 0) continue;
    if (want(t) === 0) { orders.push(order(t, 'SELL', h.shares, px, whyOf(t), true)); continue; }
    const qty = Math.min(h.shares, roundShares(-diff / px, cfg.fractional));
    if (qty * px < cfg.minTrade) { if (-diff >= 1) skipped.push({ ticker: t, side: 'SELL', value: -diff, why: 'under $' + cfg.minTrade + ' (fee filter)' }); continue; }
    orders.push(order(t, 'SELL', qty, px, whyOf(t)));
  }
  // 2. buys, within the settled cash plus the sells' money
  let cash = acct.settledCash + orders.reduce((s, o) => s + o.value - o.fee, 0);
  const buyList = tickers.filter((t) => t !== 'QQQ').map((t) => ({ t, gap: want(t) * V - (held.get(t)?.shares ?? 0) * (priceOf(t) ?? 0) })).sort((x, y) => y.gap - x.gap || x.t.localeCompare(y.t));
  if (tickers.includes('QQQ')) buyList.push({ t: 'QQQ', gap: want('QQQ') * V - (held.get('QQQ')?.shares ?? 0) * (priceOf('QQQ') ?? 0) });
  for (const { t, gap } of buyList) {
    const px = priceOf(t);
    if (!(gap > 0) || px == null) continue;
    let qty = roundShares(Math.min(gap, cash) / px, cfg.fractional);
    for (let i = 0; i < 4 && qty > 0 && qty * px + orderFee(qty, px, cfg.fees) > cash + 1e-9; i++) qty = roundShares((cash - orderFee(qty, px, cfg.fees)) / px, cfg.fractional);
    if (qty * px < cfg.minTrade) { if (gap >= 1) skipped.push({ ticker: t, side: 'BUY', value: gap, why: gap < cfg.minTrade ? 'under $' + cfg.minTrade + ' (fee filter)' : 'not enough settled cash ($' + Math.max(0, cash).toFixed(2) + ' left)' }); continue; }
    const o = order(t, 'BUY', qty, px, whyOf(t));
    orders.push(o); cash -= o.value + o.fee;
  }
  // 3. drift after the plan
  const after = new Map<string, number>();
  for (const t of tickers) after.set(t, (held.get(t)?.shares ?? 0) * (priceOf(t) ?? 0));
  for (const o of orders) after.set(o.ticker, (after.get(o.ticker) ?? 0) + (o.side === 'BUY' ? o.value : -o.value));
  const drift = V > 0 ? tickers.map((t) => ({ ticker: t, targetPct: want(t) * 100, nowPct: ((held.get(t)?.shares ?? 0) * (priceOf(t) ?? 0)) / V * 100, afterPct: (after.get(t) ?? 0) / V * 100 })) : [];
  const driftPct = drift.reduce((s, d) => s + Math.abs(d.afterPct - d.targetPct), 0) / 2;
  return { day, account: target.account, slots: target.slots, accountValue: V, orders, skipped, drift, driftPct };
}
