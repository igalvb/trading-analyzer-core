/**
 * E1 option A (fix plan 2026-10-30, label only): the price is already inside or below the buy zone.
 *
 * Timing stays WAIT_PULLBACK (BUY_NOW is reachable only in TREND_UP, entryPlan.ts) and no score changes, but the
 * reports must not tell the reader to "wait for the zone / buy on a dip" when a limit order at the plan's entry
 * would already have filled. This is the one place that decides when that is true and what the label says;
 * the Bottom Line, the Analysis v7 entry zone, the Options Decision, the LILO page and the AI briefing input all
 * print it. Never used in legacy-parity mode (the callers gate it).
 *
 * The label applies when ALL hold: timing WAIT_PULLBACK, price <= the top of the buy zone, price above the plan's
 * stop. Risk is measured at today's price: price - stop.
 */

export interface AtBuyLimitInput {
  readonly timing: unknown;
  readonly currentPrice: unknown;
  readonly entryLow: unknown;
  readonly entryHigh: unknown;
  readonly entryPrice: unknown;
  readonly stop: unknown;
}

export interface AtBuyLimit {
  /** 'inside' the zone (entryLow <= price <= entryHigh) or 'below' it (price < entryLow, still above the stop). */
  readonly where: 'inside' | 'below';
  readonly price: number;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly entryPrice: number;
  readonly stop: number;
  readonly riskPerShare: number;
  /** riskPerShare as a % of today's price. */
  readonly riskPct: number;
  /** The whole label: "✅ AT YOUR BUY LIMIT — price $X is inside the buy zone ($L–$H); ... at today's price." */
  readonly text: string;
  /** The same without the "✅ AT YOUR BUY LIMIT — " prefix, for a sentence that names the state itself. */
  readonly detail: string;
}

export const AT_BUY_LIMIT_PREFIX = '✅ AT YOUR BUY LIMIT — ';

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const usd = (n: number): string => '$' + n.toFixed(2);

export function atBuyLimit(i: AtBuyLimitInput): AtBuyLimit | null {
  if (i.timing !== 'WAIT_PULLBACK') return null;
  const price = fin(i.currentPrice), lo = fin(i.entryLow), hi = fin(i.entryHigh), entry = fin(i.entryPrice), stop = fin(i.stop);
  if (price == null || lo == null || hi == null || entry == null || stop == null || price <= 0) return null;
  if (!(price <= hi) || !(price > stop)) return null;
  const where: AtBuyLimit['where'] = price >= lo ? 'inside' : 'below';
  const riskPerShare = price - stop;
  const riskPct = (riskPerShare / price) * 100;
  // A limit at the plan's entry fills only at or below it; above the entry (still inside the zone) it is the
  // zone's top that would have filled, so the label names that price instead of claiming a fill that did not happen.
  const fill = price <= entry ? usd(entry) : 'the top of the zone (' + usd(hi) + ')';
  const detail = 'price ' + usd(price) + ' is ' + where + ' the buy zone (' + usd(lo) + '–' + usd(hi) + '); a limit order at ' + fill
    + ' would have filled. Stop ' + usd(stop) + ', risk ' + usd(riskPerShare) + '/share (' + riskPct.toFixed(1) + '%) at today\'s price.';
  return { where, price, entryLow: lo, entryHigh: hi, entryPrice: entry, stop, riskPerShare, riskPct, text: AT_BUY_LIMIT_PREFIX + detail, detail };
}
