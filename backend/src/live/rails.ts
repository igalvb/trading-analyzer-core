/**
 * The safety rails (phase 1, 1.3). Each one is a refusal with a plain reason; none is ever bent by the planner.
 *
 *   Order rails (the order is dropped, the rest of the plan goes on):
 *     long-only   BUY shares, ETFs or call options; SELL only up to what is held; no puts, no shorts, no writing calls
 *     allow-list  profile `live.allowList` (owner: the list plus QQQ); no live settings = the list plus the index
 *     cap         a BUY is at most the strategy's slot + 10% of the account (2 stocks: 60%; QQQ: 100%); sells are not
 *                 capped (they only ever reduce what is held)
 *   Plan rails (the whole plan is refused):
 *     halt        the kill switch (LIVE_HALTED, or the account file's "halted")
 *     freshness   the paper decision day is the last NYSE trading day (marketCalendar.ts) and every price is from it
 *     count       at most LIVE_MAX_ORDERS (10) orders a day
 *     cash        the buys (with fees) fit in the settled cash plus the same plan's sells
 *   The -20% / -35% alerts (D5) are account.ts fallAlerts: a message, never a stop.
 */

import { PAPER_OWNER_LIST } from '../paper/paperLab.ts';
import { activeProfile } from '../profile/active.ts';
import { holidayName, isTradingDay } from './marketCalendar.ts';
import type { PlannedOrder } from './planner.ts';

export const ALLOW_LIST: ReadonlySet<string> = new Set(activeProfile().live?.allowList ?? [...PAPER_OWNER_LIST, activeProfile().benchmarks.index]);

export interface RailInput {
  readonly orders: readonly PlannedOrder[];
  /** What the account holds now: ticker -> shares (or contracts), per kind. */
  readonly held: ReadonlyMap<string, number>;
  readonly heldCalls: ReadonlyMap<string, number>;
  readonly slots: number;
  readonly accountValue: number;
  readonly settledCash: number;
  readonly maxOrders: number;
  readonly capSlack: number;
  readonly halted: boolean;
  /** The paper twin's decision day. */
  readonly decisionDay: string;
  /** The last trading day closed tonight (marketCalendar.ts lastClosedTradingDay). */
  readonly lastTradingDay: string;
  /** Ticker -> the day of the price used (null = none). Every ticker of the plan and the target. */
  readonly priceDays: ReadonlyMap<string, string | null>;
  readonly allow?: ReadonlySet<string>;
}

export interface RailRefusal { readonly ref: string; readonly ticker: string; readonly why: string }
export interface RailResult {
  /** No refusal of any kind. */
  readonly ok: boolean;
  /** Plan rails broken: nothing may be sent. */
  readonly planRefusals: readonly string[];
  readonly orderRefusals: readonly RailRefusal[];
  /** The orders that passed every rail (empty when the plan is refused). */
  readonly passed: readonly PlannedOrder[];
  /** One plain line of what was checked, for the log. */
  readonly checks: string;
}

const usd = (v: number): string => '$' + v.toFixed(2);

/** Why one order breaks a rail, or null. */
export function orderRail(o: PlannedOrder, r: RailInput): string | null {
  const allow = r.allow ?? ALLOW_LIST;
  if (o.kind === 'put') return 'puts are not allowed (long-only: shares, ETFs and call options)';
  if (!(o.qty > 0)) return 'the quantity ' + o.qty + ' is not a positive number';
  if (o.side === 'SELL') {
    const have = (o.kind === 'call' ? r.heldCalls : r.held).get(o.ticker) ?? 0;
    if (o.qty > have + 1e-9) return o.kind === 'call' ? 'selling ' + o.qty + ' ' + o.ticker + ' calls with ' + have + ' held would write options (not allowed)' : 'selling ' + o.qty + ' ' + o.ticker + ' with ' + have + ' held would be a short sale (not allowed)';
  }
  if (!allow.has(o.ticker)) return o.ticker + ' is not on the owner\'s list or QQQ';
  if (o.side === 'BUY') {
    const share = o.ticker === 'QQQ' ? 1 : 1 / r.slots + r.capSlack, cap = share * r.accountValue;
    if (o.value > cap + 0.005) return 'buying ' + usd(o.value) + ' of ' + o.ticker + ' is above the cap of ' + usd(cap) + ' (' + (o.ticker === 'QQQ' ? 'the whole account' : '1/' + r.slots + ' of the account + ' + Math.round(r.capSlack * 100) + '%') + ')';
  }
  return null;
}

/** Why the prices or the decision are stale, or null. */
export function freshnessRail(r: Pick<RailInput, 'decisionDay' | 'lastTradingDay' | 'priceDays'>): string | null {
  if (!isTradingDay(r.decisionDay)) return 'the paper twin decided on ' + r.decisionDay + ', a day the market was closed' + (holidayName(r.decisionDay) ? ' (' + holidayName(r.decisionDay) + ')' : '');
  if (r.decisionDay < r.lastTradingDay) return 'the paper twin last decided on ' + r.decisionDay + ' but the last trading day is ' + r.lastTradingDay + ' (a late or missing Nightly): its signal is stale';
  if (r.decisionDay > r.lastTradingDay) return 'the paper twin decided on ' + r.decisionDay + ', which has not closed yet (last closed trading day ' + r.lastTradingDay + ')';
  const bad = [...r.priceDays].filter(([, d]) => d !== r.decisionDay).map(([t, d]) => t + (d ? ' (' + d + ')' : ' (none)'));
  if (bad.length) return 'prices not from ' + r.decisionDay + ': ' + bad.join(', ');
  return null;
}

export function checkRails(r: RailInput): RailResult {
  const plan: string[] = [];
  if (r.halted) plan.push('the bot is halted (kill switch): no plan is made');
  const stale = freshnessRail(r);
  if (stale) plan.push(stale);
  const orderRefusals: RailRefusal[] = [];
  const kept: PlannedOrder[] = [];
  for (const o of r.orders) { const why = orderRail(o, r); if (why) orderRefusals.push({ ref: o.ref, ticker: o.ticker, why }); else kept.push(o); }
  if (kept.length > r.maxOrders) plan.push(kept.length + ' orders is more than the ' + r.maxOrders + ' a day allowed');
  const buys = kept.filter((o) => o.side === 'BUY').reduce((s, o) => s + o.value + o.fee, 0);
  const sells = kept.filter((o) => o.side === 'SELL').reduce((s, o) => s + o.value - o.fee, 0);
  if (buys > r.settledCash + sells + 0.005) plan.push('the buys need ' + usd(buys) + ', more than the settled cash ' + usd(r.settledCash) + ' plus the sells ' + usd(sells));
  const passed = plan.length ? [] : kept;
  const checks = plan.length ? 'REFUSED: ' + plan.join('; ')
    : 'OK: long-only, owner\'s list + QQQ, cap 1/' + r.slots + ' + ' + Math.round(r.capSlack * 100) + '%, ' + kept.length + '/' + r.maxOrders + ' orders, signal and prices from ' + r.decisionDay + ', not halted, cash ' + usd(buys) + ' <= ' + usd(r.settledCash + sells);
  return { ok: !plan.length && !orderRefusals.length, planRefusals: plan, orderRefusals, passed, checks };
}
