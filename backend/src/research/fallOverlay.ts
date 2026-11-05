/**
 * Fall-cutting overlays (row 42, owner: "cut the deep falls (-50 to -70%) on the stock side";
 * docs/models/results/deep-falls.md, pre-registered before the run). Research only: an optional layer on
 * runPortfolio (`fallOverlay`); absent = today's results exactly. No live score or decision code uses it.
 *
 * - mkt: QQQ's 200-day trend down (close > 3% under the average; up again above a rising average) -> the book
 *   (stocks + idle QQQ) is scaled to `x` of the account, the rest in cash.
 * - dd: the account closes `y` or more under its high -> the book is scaled to `cutTo`; back to full when the
 *   account closes above its own `avgDays`-day average close (the high is reset then).
 * - vol: scale = `target` / the book's realized volatility (20 days, annualized), capped at 1, rounded down to `step`,
 *   at least `floor`; rescaled only when the step changes.
 * - cap: a stock closing above `w` of the account is trimmed at the next open back to one slot.
 * - atr: a stock closing under its highest close since the buy minus `k` x ATR(`atrDays`) is sold at the next open;
 *   no rebuy of it for `cooldown` trading days.
 */

import type { PriceSeries } from '../backtest/data.ts';

export type FallOverlay =
  | { readonly kind: 'mkt'; readonly x: number; readonly days?: number }
  | { readonly kind: 'dd'; readonly y: number; readonly cutTo?: number; readonly avgDays?: number }
  | { readonly kind: 'vol'; readonly target: number; readonly lookback?: number; readonly step?: number; readonly floor?: number }
  | { readonly kind: 'cap'; readonly w: number }
  | { readonly kind: 'atr'; readonly k: number; readonly atrDays?: number; readonly cooldown?: number };

/** What the overlay did in a run (for the results tables). */
export interface FallOverlayStats {
  /** Times the book was rescaled (mkt / dd / vol). */
  readonly rescales: number;
  /** Share of days the book was scaled under 100%, %. */
  readonly scaledDaysPct: number;
  /** Stops (atr) and trims (cap) executed. */
  readonly stops: number; readonly trims: number;
}

export const DD_CUT_TO = 1 / 3;
export const DD_AVG_DAYS = 50;
export const VOL_LOOKBACK = 20;
export const VOL_STEP = 0.25;
export const ATR_DAYS = 20;
export const ATR_COOLDOWN = 20;

/** The pre-registered candidates (deep-falls.md section 1): 5 overlays x 3 settings. */
export const FALL_CANDIDATES: ReadonlyArray<{ readonly family: 'MKT' | 'DD' | 'VOL' | 'CAP' | 'ATR'; readonly name: string; readonly ov: FallOverlay }> = [
  ...[0, 1 / 3, 2 / 3].map((x) => ({ family: 'MKT' as const, name: 'MKT ' + Math.round(x * 100) + '%', ov: { kind: 'mkt', x } as FallOverlay })),
  ...[0.15, 0.2, 0.25].map((y) => ({ family: 'DD' as const, name: 'DD ' + Math.round(y * 100) + '%', ov: { kind: 'dd', y } as FallOverlay })),
  ...[0.3, 0.4, 0.5].map((target) => ({ family: 'VOL' as const, name: 'VOL ' + Math.round(target * 100) + '%', ov: { kind: 'vol', target } as FallOverlay })),
  ...[0.4, 0.5, 0.6].map((w) => ({ family: 'CAP' as const, name: 'CAP ' + Math.round(w * 100) + '%', ov: { kind: 'cap', w } as FallOverlay })),
  ...[3, 4, 5].map((k) => ({ family: 'ATR' as const, name: 'ATR ' + k, ov: { kind: 'atr', k } as FallOverlay })),
];

const atrCache = new WeakMap<PriceSeries, Map<number, number[]>>();
/** ATR(n): the simple n-day average of the true range (NaN for the first n - 1 bars). */
export function atrSeries(s: PriceSeries, n = ATR_DAYS): number[] {
  let byN = atrCache.get(s);
  if (!byN) { byN = new Map(); atrCache.set(s, byN); }
  const hit = byN.get(n); if (hit) return hit;
  const tr = s.closes.map((_, i) => {
    const h = s.highs[i] as number, l = s.lows[i] as number;
    if (i === 0) return h - l;
    const pc = s.closes[i - 1] as number;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const out: number[] = []; let sum = 0;
  for (let i = 0; i < tr.length; i++) { sum += tr[i] as number; if (i >= n) sum -= tr[i - n] as number; out.push(i >= n - 1 ? sum / n : NaN); }
  byN.set(n, out);
  return out;
}

/** Annualized volatility of a series of daily returns (sample standard deviation x sqrt(252)); 0 for fewer than 2. */
export function annualVol(rets: readonly number[]): number {
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 252);
}

/** The vol overlay's scale: target / vol, at most 1, rounded down to `step`, at least `floor` (default = step). */
export function volScale(target: number, vol: number, step = VOL_STEP, floor = step): number {
  if (!(vol > 0)) return 1;
  const raw = Math.min(1, target / vol);
  return Math.max(floor, Math.floor(raw / step + 1e-9) * step);
}

/**
 * The book's daily returns over the last `lookback` days ending at `day`: per position (ticker -> value at the close),
 * value-weighted close-to-close returns. Positions without `lookback` days of history before `day` are left out.
 */
export function bookReturns(values: ReadonlyMap<string, number>, seriesOf: (t: string) => PriceSeries | undefined, idxOf: (t: string, d: string) => number | undefined, day: string, lookback = VOL_LOOKBACK): number[] {
  const legs: Array<{ s: PriceSeries; k: number; w: number }> = [];
  for (const [t, v] of values) {
    const s = seriesOf(t), k = idxOf(t, day);
    if (s && k != null && k >= lookback && v > 0) legs.push({ s, k, w: v });
  }
  const tot = legs.reduce((a, l) => a + l.w, 0);
  if (!tot) return [];
  const out: number[] = [];
  for (let j = lookback - 1; j >= 0; j--) out.push(legs.reduce((a, l) => a + (l.w / tot) * ((l.s.closes[l.k - j] as number) / (l.s.closes[l.k - j - 1] as number) - 1), 0));
  return out;
}

/** The drawdown brake's state machine, one close at a time. */
export interface DdBrake { on: boolean; peak: number; readonly hist: number[] }
export const newDdBrake = (): DdBrake => ({ on: false, peak: 0, hist: [] });
/** Feed the account's close; returns whether the brake is on for the next open. */
export function ddStep(b: DdBrake, equity: number, y: number, avgDays = DD_AVG_DAYS): boolean {
  b.hist.push(equity);
  if (b.hist.length > avgDays) b.hist.shift();
  if (b.on) {
    const avg = b.hist.reduce((a, x) => a + x, 0) / b.hist.length;
    if (b.hist.length >= avgDays && equity > avg) { b.on = false; b.peak = equity; }
  } else {
    b.peak = Math.max(b.peak, equity);
    if (b.peak > 0 && equity <= b.peak * (1 - y)) b.on = true;
  }
  return b.on;
}

/**
 * The 2010-2019 choice rule: the highest Calmar ratio (growth a year after tax / deepest fall, both in 2010-2019);
 * ties go to the higher return. Returns the index of the chosen setting.
 */
export function chooseByCalmar(rows: ReadonlyArray<{ readonly finalTaxed: number; readonly maxDrawdownPct: number }>, cash: number, years: number): number {
  const calmar = (r: { finalTaxed: number; maxDrawdownPct: number }): number => ((r.finalTaxed / cash) ** (1 / years) - 1) * 100 / Math.max(r.maxDrawdownPct, 1e-9);
  let best = 0;
  rows.forEach((r, i) => {
    const b = rows[best]!;
    if (calmar(r) > calmar(b) + 1e-12 || (Math.abs(calmar(r) - calmar(b)) <= 1e-12 && r.finalTaxed > b.finalTaxed)) best = i;
  });
  return best;
}

/** The pass rule (deep-falls.md): all three against the host. Values are final account values after tax; falls in %. */
export interface PassInput {
  readonly cand: { readonly finals: readonly number[]; readonly fall: number };
  readonly host: { readonly finals: readonly number[]; readonly fall: number };
  /** Per out-of-sample period (indexes 1 and 2 of `finals`): the best yardstick (max of Hold QQQ and both holds of the research list). */
  readonly yardMax: readonly number[];
  readonly cash: number;
}
export function passRule(p: PassInput): { shallower: boolean; kept: boolean; beats: boolean; pass: boolean } {
  const g = (v: number): number => v / p.cash - 1;
  const shallower = p.cand.fall <= p.host.fall - 15;
  const kept = [1, 2].every((k) => g(p.cand.finals[k] as number) >= 0.9 * g(p.host.finals[k] as number));
  const beats = [1, 2].every((k) => (p.cand.finals[k] as number) > (p.yardMax[k] as number));
  return { shallower, kept, beats, pass: shallower && kept && beats };
}
