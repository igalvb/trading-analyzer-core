/**
 * The washout signal (shared by the research lab and the live Washout ADD alert), and the market regime from QQQ.
 *
 * Washout (pre-registered in docs/RESEARCH_WASHOUT_ROTATION_2026-11-07.md; W1 is the live alert's):
 *   close <= 20-day average - sd x SD (population SD of the 20 closes)
 *   AND close at least `off` below the highest close of the last 252 bars
 *   AND (trend) the 150-day average above its value 20 bars earlier
 *   with at least 170 bars of history. Every value at bar i uses bars 0..i only.
 *
 * Market regime (owner 2026-11-07), from QQQ's daily closes:
 *   bull        QQQ above its 200-day average, the 200-day rising (vs 20 bars earlier), less than 10% off its 252-day high
 *   correction  "correction in a bull market": the 200-day still rising and QQQ not 20% off its high, but 10%+ off it
 *               or below the 200-day
 *   bear        20%+ off the high, OR the 200-day falling (not rising)
 * Deterministic; no fetch here.
 */

// ---- Fixed numbers (pre-registered) ------------------------------------------------------------------------------
export const SD_DAYS = 20;
export const HIGH_DAYS = 252;
export const LONG_DAYS = 150;
export const RISE_LAG = 20;
export const MIN_BARS = LONG_DAYS + RISE_LAG;

export interface WashoutParams { readonly sd: number; readonly off: number; readonly trend: boolean }
export const WASHOUTS = {
  W1: { sd: 2.5, off: 0.2, trend: true },
  W2: { sd: 2.0, off: 0.15, trend: true },
  W3: { sd: 2.5, off: 0.2, trend: false },
} as const satisfies Record<string, WashoutParams>;
export type WashoutKey = keyof typeof WASHOUTS;

// ---- Indicators (each value at bar i uses bars 0..i only) ---------------------------------------------------------
export function smaArr(x: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(x.length).fill(null);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]!; if (i >= n) s -= x[i - n]!; if (i >= n - 1) out[i] = s / n; }
  return out;
}
export function sdArr(x: readonly number[], n: number, m: ReadonlyArray<number | null>): Array<number | null> {
  return x.map((_, i) => {
    const mu = m[i]; if (mu == null) return null;
    let v = 0; for (let k = i - n + 1; k <= i; k++) v += (x[k]! - mu) ** 2;
    return Math.sqrt(v / n);
  });
}
export function maxArr(x: readonly number[], n: number): number[] {
  return x.map((_, i) => { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, x[k]!); return m; });
}
/** a[i] vs a[i - lag]: +1 rising, -1 falling, 0 unknown / flat. */
export function dirArr(a: ReadonlyArray<number | null>, lag: number): number[] {
  return a.map((v, i) => { const b = i >= lag ? a[i - lag] : null; return v == null || b == null ? 0 : v > b ? 1 : v < b ? -1 : 0; });
}

/** What the signal reads (the research lab's Ind has these fields too). */
export interface WashoutInd {
  readonly s: { readonly closes: readonly number[] };
  /** (close - 20-day average) / 20-day SD; null before 20 bars or with a flat window. */
  readonly z: ReadonlyArray<number | null>;
  readonly hi252: readonly number[];
  /** The 150-day average vs 20 bars earlier: +1 rising, -1 falling, 0 unknown / flat. */
  readonly dir150: readonly number[];
}

/** z, the 252-bar high and the 150-day direction of a close series. */
export function washoutInd(closes: readonly number[]): WashoutInd {
  const sma20 = smaArr(closes, SD_DAYS), sd20 = sdArr(closes, SD_DAYS, sma20);
  const z = closes.map((x, i) => (sma20[i] != null && sd20[i]! > 0 ? (x - sma20[i]!) / sd20[i]! : null));
  return { s: { closes }, z, hi252: maxArr(closes, HIGH_DAYS), dir150: dirArr(smaArr(closes, LONG_DAYS), RISE_LAG) };
}

/** The washout signal at bar i. */
export function washoutAt(ind: WashoutInd, i: number, p: WashoutParams): boolean {
  if (i < MIN_BARS - 1) return false;
  const z = ind.z[i]; if (z == null) return false;
  return z <= -p.sd && ind.s.closes[i]! <= (1 - p.off) * ind.hi252[i]! && (!p.trend || ind.dir150[i] === 1);
}

export interface WashoutRead {
  readonly fired: boolean;
  /** SDs under the 20-day average (positive = under), at the last bar; null when not known. */
  readonly sdUnder: number | null;
  /** Fraction below the 252-bar high (0.41 = 41% off). */
  readonly offHigh: number | null;
  readonly trendRising: boolean;
  readonly bars: number;
}

/** The signal at the LAST close of a series (the night's read). */
export function washoutReadLast(closes: readonly number[], p: WashoutParams = WASHOUTS.W1): WashoutRead {
  const n = closes.length;
  if (!n) return { fired: false, sdUnder: null, offHigh: null, trendRising: false, bars: 0 };
  const ind = washoutInd(closes), i = n - 1, z = ind.z[i] ?? null, hi = ind.hi252[i]!;
  return { fired: washoutAt(ind, i, p), sdUnder: z == null ? null : -z, offHigh: hi > 0 ? 1 - closes[i]! / hi : null, trendRising: ind.dir150[i] === 1, bars: n };
}

// ---- Market regime from QQQ ----------------------------------------------------------------------------------------
export const REGIME_AVG_DAYS = 200;
export const CORRECTION_OFF = 0.10;
export const BEAR_OFF = 0.20;
export type MarketRegime = 'bull' | 'correction' | 'bear';
export interface MarketRegimeRead {
  readonly regime: MarketRegime;
  readonly offHigh: number;
  readonly above200: boolean;
  readonly rising200: boolean;
}

/** QQQ's regime at its last close; null with fewer than 220 closes (the 200-day and its value 20 bars earlier). */
export function marketRegime(closes: readonly number[]): MarketRegimeRead | null {
  const n = closes.length;
  if (n < REGIME_AVG_DAYS + RISE_LAG || closes.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  const sma = smaArr(closes, REGIME_AVG_DAYS), i = n - 1;
  const now = sma[i]!, before = sma[i - RISE_LAG]!, close = closes[i]!;
  const hi = Math.max(...closes.slice(-HIGH_DAYS));
  const offHigh = 1 - close / hi, above200 = close > now, rising200 = now > before;
  // 1e-9: exactly 20% / 10% off counts as that band (floating point).
  const regime: MarketRegime = !rising200 || offHigh >= BEAR_OFF - 1e-9 ? 'bear' : above200 && offHigh < CORRECTION_OFF - 1e-9 ? 'bull' : 'correction';
  return { regime, offHigh, above200, rising200 };
}

/** The short words of a regime on an alert line. */
export function regimeWords(r: MarketRegime | null): string {
  return r === 'bull' ? 'market: bull' : r === 'correction' ? 'market: correction in a bull market' : r === 'bear' ? 'bear market: smaller size' : 'market: regime not known';
}
