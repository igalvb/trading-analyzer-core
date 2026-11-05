/**
 * James — Multi-Year Cycle (docs/models/plans/07-multi-year-cycle.md; James's Rule #66 "Prepare, Deploy, Rotate"):
 * the causal cycle reads of one price series and the BTC halving / regime helpers. Display and research only.
 *
 *   - Weekly closes (the last trading day of each ISO week), the 200-week average, weekly RSI(14) and the 52-week z of
 *     weekly closes. On a day inside a week the current week counts with that day's close ("the week so far"), so the
 *     reads use nothing after the day.
 *   - Drawdown from the 52-week closing high, the Mayer multiple (close / 200-day average), the 126-day return, the
 *     Trend 200 direction (models/trendFollow.ts), the 20-day average and the 20-day z (models/meanReversion.ts).
 *   - The phase of a day [PROPOSED quantification of Rule #66, plan 07 section 2b]: deep bottom (deploy zone), near
 *     top (harvest zone), pump (don't chase), normal (hold).
 *   - Part B / C (descriptive only): the halving month and the BTC top / bottom regime (price-only TABI stand-in),
 *     always read on the BTC bar of the day before (master T7).
 */

import { rsiArray } from '../series.ts';
import { trendSeries, type TrendDirection } from './trendFollow.ts';
import { zSeries } from './meanReversion.ts';

/** ISO week key of a 'YYYY-MM-DD' date: the Monday of its week. */
export function weekKey(date: string): string {
  const d = new Date(date.slice(0, 10) + 'T00:00:00Z'), dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** The completed weeks' closes: the last trading day of each week (a holiday week ends on its last trading day). */
export function weeklyCloses(dates: readonly string[], closes: readonly number[]): Array<{ date: string; close: number }> {
  if (!Array.isArray(dates) || dates.length !== closes.length || dates.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d))) throw new Error('weeklyCloses: dated bars are needed (dates as YYYY-MM-DD, one per close)');
  const out: Array<{ date: string; close: number }> = [];
  for (let i = 0; i < dates.length; i++) {
    const last = i === dates.length - 1 || weekKey(dates[i + 1] as string) !== weekKey(dates[i] as string);
    if (last) out.push({ date: dates[i] as string, close: closes[i] as number });
  }
  return out;
}

export interface CycleBars { readonly dates: readonly string[]; readonly closes: readonly number[] }

/** Per day, everything the phase, the leader test and the report page need. */
export interface CycleSignals {
  readonly close: readonly number[];
  readonly dd: Array<number | null>;        // 1 - close / 52-week closing high (252 bars), 0..1
  readonly mayer: Array<number | null>;     // close / 200-day average
  readonly sma200w: Array<number | null>;   // 200-week average (the week so far counts)
  readonly wrsi: Array<number | null>;      // weekly RSI(14)
  readonly wz52: Array<number | null>;      // 52-week z of weekly closes
  readonly wAbove10: Array<boolean | null>; // weekly close (so far) above the 10-week average
  readonly weeksBelow50: number[];          // completed weeks in a row closing under the 50-week average
  readonly weekAbove50: Array<boolean | null>; // the last completed week closed above its 50-week average
  readonly ret126: Array<number | null>;
  readonly trend200: TrendDirection[];
  readonly sma20: Array<number | null>;
  readonly z20: Array<number | null>;
}

export function cycleSignals(b: CycleBars): CycleSignals {
  const c = b.closes, n = c.length;
  const dd: Array<number | null> = [], mayer: Array<number | null> = [], ret126: Array<number | null> = [], sma20: Array<number | null> = [];
  // 52-week closing high (monotone deque), 200-day and 20-day sums
  const dq: number[] = [];
  let s200 = 0, s20 = 0;
  for (let i = 0; i < n; i++) {
    const x = c[i] as number;
    while (dq.length && (c[dq[dq.length - 1] as number] as number) <= x) dq.pop();
    dq.push(i);
    while ((dq[0] as number) <= i - 252) dq.shift();
    const hi = c[dq[0] as number] as number;
    dd.push(i >= 1 ? 1 - x / hi : null);
    s200 += x; if (i >= 200) s200 -= c[i - 200] as number;
    s20 += x; if (i >= 20) s20 -= c[i - 20] as number;
    mayer.push(i >= 199 ? x / (s200 / 200) : null);
    sma20.push(i >= 19 ? s20 / 20 : null);
    ret126.push(i >= 126 ? x / (c[i - 126] as number) - 1 : null);
  }
  // weekly: W = completed weeks' closes before the current week; the current week's close so far is the day's close
  const sma200w: Array<number | null> = [], wrsi: Array<number | null> = [], wz52: Array<number | null> = [], wAbove10: Array<boolean | null> = [];
  const weeksBelow50: number[] = [], weekAbove50: Array<boolean | null> = [];
  const W: number[] = [];
  let ag: number | null = null, al: number | null = null; // Wilder state after the completed weeks (RSI 14)
  const gains: number[] = [], losses: number[] = [];
  let below = 0, lastAbove: boolean | null = null;
  const mean = (xs: readonly number[], from: number, x: number): number => { let s = x; for (let k = from; k < xs.length; k++) s += xs[k] as number; return s / (xs.length - from + 1); };
  for (let i = 0; i < n; i++) {
    const x = c[i] as number, m = W.length;
    sma200w.push(m >= 199 ? mean(W, m - 199, x) : null);
    // weekly RSI with this week's close so far as the newest weekly close
    if (m >= 1 && ag != null && al != null) {
      const dlt = x - (W[m - 1] as number), g = (ag * 13 + Math.max(0, dlt)) / 14, l = (al * 13 + Math.max(0, -dlt)) / 14;
      wrsi.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
    } else wrsi.push(null);
    if (m >= 51) {
      const xs = [...W.slice(m - 51), x], mu = xs.reduce((a, y) => a + y, 0) / 52, sd = Math.sqrt(xs.reduce((a, y) => a + (y - mu) ** 2, 0) / 52);
      wz52.push(sd > 0 ? (x - mu) / sd : 0);
    } else wz52.push(null);
    wAbove10.push(m >= 9 ? x > mean(W, m - 9, x) : null);
    weeksBelow50.push(below); weekAbove50.push(lastAbove);
    // the week ends today: it becomes a completed week
    const ends = i === n - 1 ? false : weekKey(b.dates[i + 1] as string) !== weekKey(b.dates[i] as string);
    if (ends) {
      if (W.length) { const dlt = x - (W[W.length - 1] as number); gains.push(Math.max(0, dlt)); losses.push(Math.max(0, -dlt)); }
      W.push(x);
      if (gains.length === 14) { ag = gains.reduce((a, y) => a + y, 0) / 14; al = losses.reduce((a, y) => a + y, 0) / 14; }
      else if (gains.length > 14 && ag != null && al != null) { ag = (ag * 13 + (gains[gains.length - 1] as number)) / 14; al = (al * 13 + (losses[losses.length - 1] as number)) / 14; }
      if (W.length >= 50) { const avg = W.slice(-50).reduce((a, y) => a + y, 0) / 50; lastAbove = x > avg; below = x < avg ? below + 1 : 0; }
    }
  }
  return { close: c, dd, mayer, sma200w, wrsi, wz52, wAbove10, weeksBelow50, weekAbove50, ret126, trend200: trendSeries([...c], 200).map((t) => t.direction), sma20, z20: zSeries(c, 20) };
}

/** Weekly RSI(14) of the completed weekly closes (a check against series.ts rsiArray). */
export const weeklyRsi = (weekly: readonly number[]): number[] => rsiArray(weekly, 14);

export type CyclePhase = 'deepBottom' | 'nearTop' | 'pump' | 'normal';

/** The cycle knobs (plan 07 section 2b; defaults = the pre-registered default). */
export interface PhaseOptions {
  /** Deep bottom: drawdown from the 52-week high at least `x` (D9: 50%). */
  readonly x: number;
  /** '200w': and under the 200-week average (weekly RSI < 30 for a stock with under 200 weeks); 'rsi': weekly RSI < 30. */
  readonly bottomTest: '200w' | 'rsi';
  /** Near top: 'mayer' = Mayer multiple >= `m` (D9: 2.0); 'z' = 52-week z of weekly closes >= +3. */
  readonly topTest: 'mayer' | 'z';
  readonly m: number;
}
export const PHASE_DEFAULT: PhaseOptions = { x: 0.5, bottomTest: '200w', topTest: 'mayer', m: 2.0 };
/** Don't chase: never buy (start or rotation) a stock whose Mayer multiple is >= 2.0 or 20-day z >= +2. */
export const PUMP = { mayer: 2.0, z20: 2 } as const;

export function isDeepBottom(s: CycleSignals, i: number, o: PhaseOptions): boolean {
  const dd = s.dd[i];
  if (dd == null || dd < o.x) return false;
  const w = s.sma200w[i], r = s.wrsi[i];
  if (o.bottomTest === '200w' && w != null) return (s.close[i] as number) < w;
  return r != null && r < 30;
}
export const isNearTop = (s: CycleSignals, i: number, o: PhaseOptions): boolean => (o.topTest === 'mayer' ? (s.mayer[i] ?? 0) >= o.m : (s.wz52[i] ?? 0) >= 3);
export const isPump = (s: CycleSignals, i: number): boolean => (s.mayer[i] ?? 0) >= PUMP.mayer || (s.z20[i] ?? 0) >= PUMP.z20;

export function phaseAt(s: CycleSignals, i: number, o: PhaseOptions = PHASE_DEFAULT): CyclePhase {
  if (isDeepBottom(s, i, o)) return 'deepBottom';
  if (isNearTop(s, i, o)) return 'nearTop';
  if (isPump(s, i)) return 'pump';
  return 'normal';
}

/** A leader (plan 07 2b): within 25% of its 52-week high, Trend 200 bullish; score = 126-day return minus QQQ's. */
export function leaderScore(s: CycleSignals, i: number, qqqRet126: number | null): number | null {
  const dd = s.dd[i], r = s.ret126[i];
  if (dd == null || r == null || qqqRet126 == null || dd > 0.25 || s.trend200[i] !== 'bullish') return null;
  return r - qqqRet126;
}

// ─────────────────────────────── Part B / C: BTC (descriptive only) ───────────────────────────────

/** Bitcoin halvings (public record, not from the source); the next is about April 2028 (an estimate from block height). */
export const HALVINGS: readonly string[] = ['2012-11-28', '2016-07-09', '2020-05-11', '2024-04-20'];
export const NEXT_HALVING_ESTIMATE = '2028-04';

/** Whole months since the last halving on or before `date` (0-47); null before the first. */
export function halvingMonth(date: string): number | null {
  const d = date.slice(0, 10);
  const h = [...HALVINGS].reverse().find((x) => x <= d);
  if (!h) return null;
  const [y1, m1, d1] = h.split('-').map(Number) as [number, number, number], [y2, m2, d2] = d.split('-').map(Number) as [number, number, number];
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

/** Part B windows. Default (2c): deploy h >= 30 or h <= 6, harvest h 12-18. Frozen from 2017 (2c): deploy h >= 23 or <= 6, harvest 14-20. */
export interface HalvingWindows { readonly deployFrom: number; readonly deployTo: number; readonly harvestFrom: number; readonly harvestTo: number }
export const HALVING_DEFAULT: HalvingWindows = { deployFrom: 30, deployTo: 6, harvestFrom: 12, harvestTo: 18 };
export const HALVING_FROZEN_2017: HalvingWindows = { deployFrom: 23, deployTo: 6, harvestFrom: 14, harvestTo: 20 };
export function halvingWindow(h: number | null, w: HalvingWindows = HALVING_DEFAULT): 'deploy' | 'harvest' | 'hold' | null {
  if (h == null) return null;
  if (h >= w.deployFrom || h <= w.deployTo) return 'deploy';
  if (h >= w.harvestFrom && h <= w.harvestTo) return 'harvest';
  return 'hold';
}

export type BtcZone = 'bottom' | 'top' | 'riskOff' | 'neutral';
export interface BtcRegime {
  readonly zone: BtcZone; readonly date: string;
  readonly mayer: number | null; readonly below200w: boolean | null; readonly wrsi: number | null; readonly halvingMonth: number | null;
  /** Ben Cowen's rule ([community]): 2 completed weeks in a row under the 50-week average -> no new BTC buys until a week closes back above. */
  readonly riskOff: boolean;
  readonly bottomVotes: number; readonly topVotes: number;
}
/** Part C thresholds (fitted on all known cycles; descriptive only). */
export const BTC_REGIME = { bottomMayer: 0.8, bottomRsi: 30, topMayer: 2.4, topRsi: 85, topHalvingFrom: 12, topHalvingTo: 20 } as const;

/** The regime at bar `j` of the BTC series (2 of 3 votes; top before bottom before risk-off). */
export function btcRegimeAt(btc: CycleBars, s: CycleSignals, j: number): BtcRegime {
  const date = btc.dates[j] as string, c = btc.closes[j] as number, w = s.sma200w[j] ?? null;
  const mayer = s.mayer[j] ?? null, wrsi = s.wrsi[j] ?? null, h = halvingMonth(date);
  const below200w = w == null ? null : c < w;
  const bottomVotes = (mayer != null && mayer < BTC_REGIME.bottomMayer ? 1 : 0) + (below200w ? 1 : 0) + (wrsi != null && wrsi < BTC_REGIME.bottomRsi ? 1 : 0);
  const topVotes = (mayer != null && mayer > BTC_REGIME.topMayer ? 1 : 0) + (wrsi != null && wrsi > BTC_REGIME.topRsi ? 1 : 0) + (h != null && h >= BTC_REGIME.topHalvingFrom && h <= BTC_REGIME.topHalvingTo ? 1 : 0);
  // risk-off: on after 2 weeks under the 50-week average, off after a week back above
  let riskOff = false;
  for (let k = 0; k <= j; k++) { if ((s.weeksBelow50[k] ?? 0) >= 2) riskOff = true; else if (s.weekAbove50[k] === true) riskOff = false; }
  const zone: BtcZone = topVotes >= 2 ? 'top' : bottomVotes >= 2 ? 'bottom' : riskOff ? 'riskOff' : 'neutral';
  return { zone, date, mayer, below200w, wrsi, halvingMonth: h, riskOff, bottomVotes, topVotes };
}

/** Master T7: a decision on US day `day` uses the BTC bar dated before it (Yahoo's BTC-USD bar D closes at 00:00 UTC on D+1). */
export function btcIndexBefore(btc: CycleBars, day: string): number {
  let lo = 0, hi = btc.dates.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if ((btc.dates[mid] as string).slice(0, 10) < day.slice(0, 10)) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
