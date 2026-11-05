/**
 * computeAllIndicators, ported in verifiable slices.
 *
 * The legacy function is 1,814 lines (fullStockAnalysisV10_9.gs:6249-8062)
 * producing 115 fields in one body. Porting it as a single unit would mean
 * handing over ~1,800 lines of unverified translation on the highest-risk
 * code in the project. Instead it is split along its own internal section
 * boundaries, each slice independently differential-tested against the
 * oracle, with field coverage tracked as a real number.
 *
 * COVERAGE: 23 / 115 fields. Verified 2026-09-13: 4,416 comparisons across
 * 192 chart variants from 24 real fixtures (at 60/80/100/150/201/250/400/
 * full bars), all exact matches via deepStrictEqual, zero failures.
 *
 * Every slice recomputes its own intermediates from the raw series rather
 * than sharing them. That is deliberate: it makes each slice independently
 * testable, and the cost is trivial (pure arithmetic over in-memory arrays).
 * The full assembled computeAllIndicators can share intermediates later once
 * every slice is proven.
 */

import type { Chart } from '../../types/chart.ts';
import { sma, ema, emaArray, wilderSmooth, wilderArray, stdDev, slope, rsiArray } from '../series.ts';
import { computeChartPatterns } from './chartPatterns.ts';
import type { ChartPattern } from './chartPatterns.ts';
import { wyckoffSchematic } from './wyckoff.ts';
import type { WyckoffSchematic } from './wyckoff.ts';
import { computePriceGaps } from './priceGaps.ts';
import type { PriceGap } from './priceGaps.ts';
import { computeSrFamilySlice } from './srLevels.ts';
import { computeEventsSlice } from './events.ts';
export { computeEventsSlice };
export { computeSrFamilySlice };

/**
 * The subset of a Chart the indicator slices actually read.
 * Narrower than Chart so slices are testable without a full quote object.
 */
export type SeriesInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'volumes'>;

// ── Slice 1: RSI and weekly momentum (4 fields) ────────────────────────

export interface RsiSlice {
  last: number;
  rsi14: number;
  rsiWeekly: number;
  weeklyTrend: string | null;
}

/**
 * Two real quirks preserved verbatim:
 *
 *  1. A perfectly flat series (no gains AND no losses) returns a neutral 50,
 *     not 100. That guard was added deliberately in the legacy code (v8.1) --
 *     without it, zero-gain/zero-loss hits the avgL===0 branch and reports a
 *     maximally-overbought 100 for a series that never moved.
 *
 *  2. `weekly` is a 5th-day resample walking BACKWARD from the last bar, not
 *     true calendar week-ending closes. The legacy source documents this as
 *     an accepted approximation. Reproduced exactly -- sampling forward from
 *     bar 0 instead would silently shift every weekly value.
 */
export function computeRsiSlice(c: SeriesInput): RsiSlice {
  const closes = c.closes;
  const n = closes.length;

  const diffs = closes.slice(1).map((v, i) => v - (closes[i] as number));
  const gains = diffs.map((d) => (d > 0 ? d : 0));
  const losses = diffs.map((d) => (d < 0 ? Math.abs(d) : 0));
  const avgG = wilderSmooth(gains, 14) || 0;
  const avgL = wilderSmooth(losses, 14) || 0;
  const rsi14 = avgG === 0 && avgL === 0 ? 50 : avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

  const weekly: number[] = [];
  for (let i = n - 1; i >= 0; i -= 5) weekly.unshift(closes[i] as number);

  const wd = weekly.slice(1).map((v, i) => v - (weekly[i] as number));
  const wg = wd.map((d) => (d > 0 ? d : 0));
  const wl = wd.map((d) => (d < 0 ? Math.abs(d) : 0));
  const _wg = wilderSmooth(wg, 14) || 0;
  const _wl = wilderSmooth(wl, 14) || 0;
  const rsiWeekly = _wg === 0 && _wl === 0 ? 50 : _wl === 0 ? 100 : 100 - 100 / (1 + _wg / _wl);

  // 10wk/40wk mirror the daily 50/200 SMA pair (10*5=50, 40*5=200 bars).
  const wSma10 = sma(weekly, 10);
  const wSma40 = sma(weekly, 40);
  const weeklyTrend = wSma10 != null && wSma40 != null ? (wSma10 > wSma40 ? 'UP' : 'DOWN') : null;

  return { last: closes[n - 1] as number, rsi14, rsiWeekly, weeklyTrend };
}

// ── Slice 2: MACD (4 fields) ───────────────────────────────────────────

export interface MacdSlice {
  macdVal: number;
  sigVal: number;
  histogram: number;
  histSlope: number;
}

/**
 * The `off` alignment is essential: emaArray(closes,12) is longer than
 * emaArray(closes,26) because each seeds at a different bar. Subtracting
 * without that offset would compare EMAs from different dates -- a silent
 * error producing plausible-looking wrong values.
 *
 * histSlope's inner map is faithfully odd: index 0 of the 5-element window
 * is forced to 0 rather than a real difference. Reproduced as-is.
 */
export function computeMacdSlice(c: SeriesInput): MacdSlice {
  const closes = c.closes;
  const ema12a = emaArray(closes, 12);
  const ema26a = emaArray(closes, 26);
  const off = ema12a.length - ema26a.length;

  const macdLine = ema26a.map((v, i) => (ema12a[i + off] as number) - v);
  const sigLine = emaArray(macdLine, 9);

  const macdVal = macdLine[macdLine.length - 1] || 0;
  const sigVal = sigLine[sigLine.length - 1] || 0;
  const histogram = macdVal - sigVal;

  const histSlope = slope(
    macdLine.slice(-5).map((v, i) => (i >= 1 ? v - (sigLine[sigLine.length - 5 + i] || 0) : 0)),
    3,
  );

  return { macdVal, sigVal, histogram, histSlope };
}

// ── Slice 3: Bollinger Bands (6 fields) ────────────────────────────────

export interface BollingerSlice {
  sma20v: number;
  bbUpper: number;
  bbLower: number;
  bbPctB: number;
  bbWidth: number;
  bbSqueeze: boolean;
}

/**
 * FLAGGED FINDING (reproduced, not fixed): sma20v divides by a hardcoded 20,
 * not by bb20.length. With fewer than 20 bars available it therefore
 * understates the mean and skews both bands. Unreachable in practice given
 * the engine's own 60-bar fetch minimum, but real. Recorded in the
 * flagged-findings register; the port MUST match this to hold parity.
 *
 * stdDev here is the POPULATION form (divides by n), which is what sets band
 * width. Switching to the sample form would move every band in the system.
 */
export function computeBollingerSlice(c: SeriesInput): BollingerSlice {
  const closes = c.closes;
  const last = closes[closes.length - 1] as number;

  const bb20 = closes.slice(-20);
  const sma20v = bb20.reduce((a, b) => a + b, 0) / 20;
  const std20 = stdDev(bb20);

  const bbUpper = sma20v + 2 * std20;
  const bbLower = sma20v - 2 * std20;
  const bbRange = bbUpper - bbLower;

  const bbPctB = bbRange === 0 ? 0.5 : (last - bbLower) / bbRange;
  const bbWidth = sma20v === 0 ? 0 : bbRange / sma20v;

  return { sma20v, bbUpper, bbLower, bbPctB, bbWidth, bbSqueeze: bbWidth < 0.08 };
}

// ── Slice 4: Stochastics (3 fields) ────────────────────────────────────

export interface StochasticSlice {
  stochK: number;
  stochD: number;
  stochRSI: number;
}

/**
 * The stochK fallback uses ARRAY-LENGTH truthiness, not value truthiness.
 * That distinction is a real bug fix from the legacy code (v9.46): %K of
 * exactly 0 means price closed at the precise low of the 14-bar range -- a
 * routine, maximally-oversold reading -- but 0 is falsy in JS, so the old
 * `|| 50` silently converted it to a neutral "mid-range" and dropped the
 * signal. Only a genuinely empty array falls back now.
 *
 * All three fields return a number, never null: six legacy call sites invoke
 * .toFixed() on them directly.
 */
export function computeStochasticSlice(c: SeriesInput): StochasticSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;

  const stochKarr: number[] = [];
  for (let i = 13; i < n; i++) {
    const hh = Math.max(...highs.slice(i - 13, i + 1));
    const ll = Math.min(...lows.slice(i - 13, i + 1));
    stochKarr.push(hh === ll ? 50 : (((closes[i] as number) - ll) / (hh - ll)) * 100);
  }

  const stochK = stochKarr.length ? (stochKarr[stochKarr.length - 1] as number) : 50;
  const stochDraw = sma(stochKarr, 3);
  const stochD = stochKarr.length ? (stochDraw != null ? stochDraw : stochK) : 50;

  // try/catch retained from the legacy source. Math.min/max over a spread of
  // a very large array can throw (stack limits); the fallback is a neutral 50
  // rather than a crash.
  let stochRSI = 50;
  try {
    const rsiSeries = rsiArray(closes, 14);
    const rsiWindow = rsiSeries.slice(-14).filter((v) => Number.isFinite(v));
    if (rsiWindow.length >= 2) {
      const rMin = Math.min(...rsiWindow);
      const rMax = Math.max(...rsiWindow);
      stochRSI =
        rMax === rMin ? 50 : (((rsiSeries[rsiSeries.length - 1] as number) - rMin) / (rMax - rMin)) * 100;
    }
  } catch {
    stochRSI = 50;
  }

  return { stochK, stochD, stochRSI };
}

// ── Slice 5: Williams %R, CCI, MFI (3 fields) ──────────────────────────

export interface OscillatorSlice {
  willR: number;
  cci20: number;
  mfi14: number;
}

/**
 * FLAGGED FINDINGS (both reproduced, not fixed):
 *
 *  1. smaTP and meanDev divide by a hardcoded 20, same class of issue as
 *     sma20v in the Bollinger slice.
 *
 *  2. The MFI loop starts at i = n-14 and reads highs[i-1]. When n < 15 that
 *     index is negative, yielding undefined and propagating NaN through
 *     mfi14. Unreachable given the 60-bar minimum, but latent.
 *
 * MFI deliberately ignores an unchanged typical price -- it counts neither as
 * buying nor selling (legacy v8.1).
 */
export function computeOscillatorSlice(c: SeriesInput): OscillatorSlice {
  const { closes, highs, lows, volumes } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  const wHH = Math.max(...highs.slice(-14));
  const wLL = Math.min(...lows.slice(-14));
  const willR = wHH === wLL ? -50 : ((wHH - last) / (wHH - wLL)) * -100;

  const tpArr = highs.map((h, i) => (h + (lows[i] as number) + (closes[i] as number)) / 3);
  const tp20 = tpArr.slice(-20);
  const smaTP = tp20.reduce((a, b) => a + b, 0) / 20;
  const meanDev = tp20.reduce((s, v) => s + Math.abs(v - smaTP), 0) / 20;
  const cci20 = meanDev === 0 ? 0 : ((tpArr[n - 1] as number) - smaTP) / (0.015 * meanDev);

  let posMF = 0;
  let negMF = 0;
  for (let i = n - 14; i < n; i++) {
    const tp = ((highs[i] as number) + (lows[i] as number) + (closes[i] as number)) / 3;
    const tpp = ((highs[i - 1] as number) + (lows[i - 1] as number) + (closes[i - 1] as number)) / 3;
    const mf = tp * (volumes[i] as number);
    if (tp > tpp) posMF += mf;
    else if (tp < tpp) negMF += mf;
  }
  const mfi14 = negMF === 0 ? 100 : 100 - 100 / (1 + posMF / negMF);

  return { willR, cci20, mfi14 };
}

// ── Slice 6: ATR and volatility units (3 fields) ───────────────────────

export interface AtrSlice {
  atr14: number;
  atrRatio: number;
  turtleN: number;
}

/**
 * The `|| 0.0001` floor is deliberate and documented in the legacy source: a
 * genuinely flat series has a true ATR of 0, and the floor exists only to
 * avoid divide-by-zero downstream. An earlier version floored to 1.0, which
 * distorted real values -- the epsilon is the fix, not a hack.
 *
 * turtleN is Edwards & Magee Appendix E's volatility unit. The book's formula
 * N = (19*PrevN + TodayTrueRange)/20 is mathematically identical to Wilder
 * smoothing at period 20, so it reuses the same trArr with no new math.
 */
export function computeAtrSlice(c: SeriesInput): AtrSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;

  const trArr: number[] = [];
  for (let i = 1; i < n; i++) {
    trArr.push(
      Math.max(
        (highs[i] as number) - (lows[i] as number),
        Math.abs((highs[i] as number) - (closes[i - 1] as number)),
        Math.abs((lows[i] as number) - (closes[i - 1] as number)),
      ),
    );
  }

  const atr14 = wilderSmooth(trArr, 14) || 0.0001;
  const atr50arr = wilderArray(trArr, 14).slice(-50);
  const atrAvg50 = atr50arr.length ? atr50arr.reduce((a, b) => a + b, 0) / atr50arr.length : atr14;
  const atrRatio = atr14 / atrAvg50;
  const turtleN = wilderSmooth(trArr, 20) || 0.0001;

  return { atr14, atrRatio, turtleN };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICES 7-13 — trend, volume, moving averages, momentum, levels
//  Verified 2026-09-14: 13,248 comparisons across 192 chart variants,
//  all exact, zero failures.
// ══════════════════════════════════════════════════════════════════════

/**
 * True Range series — shared by ATR, ADX, and the channel slice.
 *
 * Recomputed per slice rather than threaded between them. Deliberate: it
 * keeps each slice independently testable, and the cost is trivial pure
 * arithmetic. The assembled computeAllIndicators can share it later, once
 * every slice is proven.
 */
function trueRangeSeries(c: SeriesInput): number[] {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    out.push(
      Math.max(
        (highs[i] as number) - (lows[i] as number),
        Math.abs((highs[i] as number) - (closes[i - 1] as number)),
        Math.abs((lows[i] as number) - (closes[i - 1] as number)),
      ),
    );
  }
  return out;
}

// ── Slice 7: ADX trend strength (2 fields) ─────────────────────────────

export interface TrendStrengthSlice {
  adx14: number;
  adxBullish: boolean;
}

/**
 * Wilder's ADX. Two details that must not be "tidied":
 *
 *  - Bars where smoothed TR is exactly 0 are SKIPPED (`continue`), not
 *    pushed as 0. That shortens dxArr relative to the other arrays, which is
 *    why adxLen is recomputed as a min across all three.
 *  - adxBullish compares the LAST +DI/-DI pair, not the smoothed ADX value.
 *    ADX measures trend strength without direction; direction comes from the
 *    DI pair.
 */
export function computeTrendStrengthSlice(c: SeriesInput): TrendStrengthSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const trArr = trueRangeSeries(c);

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = (highs[i] as number) - (highs[i - 1] as number);
    const dn = (lows[i - 1] as number) - (lows[i] as number);
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }

  const sTR = wilderArray(trArr, 14);
  const sPDM = wilderArray(plusDM, 14);
  const sMDM = wilderArray(minusDM, 14);
  const adxLen = Math.min(sTR.length, sPDM.length, sMDM.length);

  const dxArr: number[] = [];
  for (let i = 0; i < adxLen; i++) {
    if (sTR[i] === 0) continue;
    const pdi = (100 * (sPDM[i] as number)) / (sTR[i] as number);
    const mdi = (100 * (sMDM[i] as number)) / (sTR[i] as number);
    dxArr.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi));
  }

  const adx14 = wilderSmooth(dxArr, 14) || 0;
  const lastPDI = adxLen > 0 ? (100 * (sPDM[adxLen - 1] as number)) / (sTR[adxLen - 1] as number) : 0;
  const lastMDI = adxLen > 0 ? (100 * (sMDM[adxLen - 1] as number)) / (sTR[adxLen - 1] as number) : 0;

  return { adx14, adxBullish: lastPDI > lastMDI };
}

// ── Slice 8: Volume (4 fields) ─────────────────────────────────────────

export interface VolumeSlice {
  obvShortSlope: number;
  obvLongSlope: number;
  cmf20: number;
  volRatio: number;
}

/**
 * volRatio carries a real bug fix worth preserving precisely (legacy v9.46):
 * a halted ticker can show 20 consecutive zero-volume bars. The old `||1`
 * coerced the AVERAGE to 1, so volRatio became the raw current-day share
 * count — producing a literal "3000000.00x HIGH" on the dashboard. The fix
 * sets volRatio itself to a neutral 1 when the window average is genuinely 0,
 * rather than deriving it from a fabricated average. Note vol20avg is still
 * computed but only used on the non-zero path.
 *
 * CMF keeps volume in the denominator on high==low days (multiplier 0)
 * rather than dropping the bar — the standard definition.
 */
export function computeVolumeSlice(c: SeriesInput): VolumeSlice {
  const { closes, highs, lows, volumes } = c;
  const n = closes.length;

  const obvArr: number[] = [0];
  for (let i = 1; i < n; i++) {
    const p = obvArr[obvArr.length - 1] as number;
    obvArr.push(
      (closes[i] as number) > (closes[i - 1] as number)
        ? p + (volumes[i] as number)
        : (closes[i] as number) < (closes[i - 1] as number)
          ? p - (volumes[i] as number)
          : p,
    );
  }
  const obvShortSlope = slope(obvArr, 10);
  const obvLongSlope = slope(obvArr, 50);

  let cmfMFV = 0;
  let cmfVol = 0;
  for (let i = n - 20; i < n; i++) {
    const hl = (highs[i] as number) - (lows[i] as number);
    const mult =
      hl === 0
        ? 0
        : ((closes[i] as number) - (lows[i] as number) - ((highs[i] as number) - (closes[i] as number))) / hl;
    cmfMFV += mult * (volumes[i] as number);
    cmfVol += volumes[i] as number;
  }
  const cmf20 = cmfVol === 0 ? 0 : cmfMFV / cmfVol;

  // slice(-21,-1) = the 20 bars BEFORE the last one, excluding it.
  const vol20avgRaw = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const vol20avg = vol20avgRaw || 1;
  const volRatio = vol20avgRaw > 0 ? (volumes[n - 1] as number) / vol20avg : 1;

  return { obvShortSlope, obvLongSlope, cmf20, volRatio };
}

// ── Slice 9: Moving averages and crosses (14 fields) ───────────────────

export interface MovingAverageSlice {
  sma20: number | null;
  sma50: number | null;
  sma150: number | null;
  sma200: number | null;
  ema9: number | null;
  ema21: number | null;
  goldenCross: boolean;
  deathCross: boolean;
  above200: boolean;
  above50: boolean;
  pctFromSma20: number | null;
  pctFromSma50: number | null;
  pctFromSma200: number | null;
  shortSlope: number;
}

/**
 * crossDataAvailable encodes a real, subtle bug fix (legacy v9.46). For
 * 200-204 bars of history, sma200 is a real number but closes.slice(0,-5)
 * has only n-5 elements, which can fall below 200. The old code `||0`'d
 * sma200_5 to zero, which made deathCross's `sma50_5 >= sma200_5` fire
 * unconditionally TRUE and goldenCross's `<=` unconditionally FALSE — a
 * latched phantom death cross feeding the highest-weighted trend signal.
 * Requiring non-null data on both sides of the comparison is the fix.
 *
 * Note the asymmetry, preserved as-is: above200/above50 return `false` when
 * the SMA is unavailable, while pctFromSma* return `null`. The legacy source
 * documents the null choice deliberately — a `0` there would read downstream
 * as "flat, therefore bearish" rather than "unknown".
 */
export function computeMovingAverageSlice(c: SeriesInput): MovingAverageSlice {
  const closes = c.closes;
  const last = closes[closes.length - 1] as number;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma150 = sma(closes, 150);
  const sma200 = sma(closes, 200);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  const sma50_5 = sma(closes.slice(0, -5), 50);
  const sma200_5 = sma(closes.slice(0, -5), 200);
  const crossDataAvailable = sma200 != null && sma200_5 != null && sma50_5 != null;

  const goldenCross = crossDataAvailable && (sma50 as number) > sma200 && (sma50_5 as number) <= sma200_5;
  const deathCross = crossDataAvailable && (sma50 as number) < sma200 && (sma50_5 as number) >= sma200_5;

  const above200 = sma200 ? last > sma200 : false;
  const above50 = sma50 ? last > sma50 : false;

  return {
    sma20, sma50, sma150, sma200, ema9, ema21,
    goldenCross, deathCross, above200, above50,
    pctFromSma20: sma20 ? (last / sma20 - 1) * 100 : null,
    pctFromSma50: sma50 ? (last / sma50 - 1) * 100 : null,
    pctFromSma200: sma200 ? (last / sma200 - 1) * 100 : null,
    shortSlope: slope(closes, 20),
  };
}

// ── Slice 10: Rate of change / momentum (6 fields) ─────────────────────

export interface MomentumSlice {
  roc10: number;
  roc26: number;
  roc52: number;
  roc252: number;
  mom5: number;
  mom20: number;
}

/**
 * Note the off-by-one that is intentional: roc10 uses closes[n-11], i.e. the
 * close 10 bars BEFORE the last one. The guard is `n > 10`, not `n >= 10`,
 * which is exactly what makes index n-11 safe. Returns 0 (not null) when
 * there is insufficient history — legacy convention, several callers format
 * these directly.
 */
export function computeMomentumSlice(c: SeriesInput): MomentumSlice {
  const closes = c.closes;
  const n = closes.length;
  const last = closes[n - 1] as number;
  return {
    roc10: n > 10 ? (last / (closes[n - 11] as number) - 1) * 100 : 0,
    roc26: n > 26 ? (last / (closes[n - 27] as number) - 1) * 100 : 0,
    roc52: n > 52 ? (last / (closes[n - 53] as number) - 1) * 100 : 0,
    roc252: n > 252 ? (last / (closes[n - 253] as number) - 1) * 100 : 0,
    mom5: n > 5 ? (last / (closes[n - 6] as number) - 1) * 100 : 0,
    mom20: n > 20 ? (last / (closes[n - 21] as number) - 1) * 100 : 0,
  };
}

// ── Slice 11: 52-week range and Fibonacci levels (9 fields) ────────────

export interface FibonacciSlice {
  high52: number;
  low52: number;
  fibPct: number;
  range52Pct: number;
  fib236: number;
  fib382: number;
  fib500: number;
  fib618: number;
  fib786: number;
}

/**
 * fibPct is a POSITION within the rolling 52-week range, not a retracement of
 * a specific swing. The legacy source is explicit about that distinction —
 * worth preserving in the comment, because the two are easy to conflate and
 * a separate half-way-retracement read exists elsewhere for the other sense.
 *
 * Uses 252 trading days as the 52-week window.
 */
export function computeFibonacciSlice(c: SeriesInput): FibonacciSlice {
  const { closes, highs, lows } = c;
  const last = closes[closes.length - 1] as number;

  const high52 = Math.max(...highs.slice(-252));
  const low52 = Math.min(...lows.slice(-252));
  const fibRange = high52 - low52;
  const fibPct = fibRange === 0 ? 0.5 : (last - low52) / fibRange;

  return {
    high52, low52, fibPct,
    range52Pct: fibPct * 100,
    fib236: low52 + 0.236 * fibRange,
    fib382: low52 + 0.382 * fibRange,
    fib500: low52 + 0.5 * fibRange,
    fib618: low52 + 0.618 * fibRange,
    fib786: low52 + 0.786 * fibRange,
  };
}

// ── Slice 12: Classic floor-trader pivots (6 fields) ───────────────────

export interface PivotSlice {
  pivot: number;
  pp_R1: number;
  pp_S1: number;
  pp_R2: number;
  pp_S2: number;
  abovePivot: boolean;
}

/**
 * Computed from the PREVIOUS bar (index n-2), which is the standard
 * definition — today's pivot derives from yesterday's H/L/C.
 *
 * FLAGGED FINDING F-06 (reproduced, not fixed): the `|| last` fallbacks use
 * value truthiness, so a genuine 0 in highs/lows/closes[n-2] silently
 * substitutes the last close. Unreachable for a real equity (a price of
 * exactly 0 does not occur), but it is the same falsy-zero class this
 * codebase has already had to fix twice elsewhere (stochK, volRatio).
 */
export function computePivotSlice(c: SeriesInput): PivotSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  const pH = (highs[n - 2] as number) || last;
  const pL = (lows[n - 2] as number) || last;
  const pC = (closes[n - 2] as number) || last;
  const pivot = (pH + pL + pC) / 3;

  return {
    pivot,
    pp_R1: 2 * pivot - pL,
    pp_S1: 2 * pivot - pH,
    pp_R2: pivot + (pH - pL),
    pp_S2: pivot - (pH - pL),
    abovePivot: last > pivot,
  };
}

// ── Slice 13: Keltner channel and Chandelier stop (5 fields) ───────────

export interface ChannelSlice {
  keltnerUpper: number;
  keltnerLower: number;
  keltnerSqueeze: boolean;
  chandelierHighestHigh: number;
  chandelierStop: number;
}

/**
 * keltnerSqueeze is the TTM-style squeeze: Bollinger Bands sitting entirely
 * INSIDE the Keltner Channel. Distinct from bbSqueeze (Bollinger width alone).
 *
 * chandelierStop is documented in the legacy source as NOT a true ratchet: a
 * real trailing stop is max(previousStop, currentStop) carried across runs,
 * which needs per-ticker persisted state that is deliberately not threaded
 * into this stateless function. The value is a valid point-in-time Chandelier
 * level, and the honest caveat travels with it.
 *
 * The `ema(closes,20) || sma20v` fallback is another falsy-zero site (same
 * class as F-06), benign for the same reason.
 */
export function computeChannelSlice(c: SeriesInput): ChannelSlice {
  const { closes, highs } = c;
  const trArr = trueRangeSeries(c);
  const atr14 = wilderSmooth(trArr, 14) || 0.0001;

  const bb20 = closes.slice(-20);
  const sma20v = bb20.reduce((a, b) => a + b, 0) / 20;
  const std20 = stdDev(bb20);
  const bbUpper = sma20v + 2 * std20;
  const bbLower = sma20v - 2 * std20;

  const ema20v = ema(closes, 20) || sma20v;
  const keltnerMult = 1.5;
  const keltnerUpper = ema20v + keltnerMult * atr14;
  const keltnerLower = ema20v - keltnerMult * atr14;

  const chandelierLookback = 22;
  const chandelierHighestHigh = Math.max(...highs.slice(-chandelierLookback));
  const chandelierMult = 3;

  return {
    keltnerUpper,
    keltnerLower,
    keltnerSqueeze: bbUpper < keltnerUpper && bbLower > keltnerLower,
    chandelierHighestHigh,
    chandelierStop: chandelierHighestHigh - chandelierMult * atr14,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICES 14-20 — channels, trend-following stops, Ichimoku, volatility
//  Verified 2026-09-14: 17,280 comparisons across 192 chart variants,
//  all exact, zero failures.
// ══════════════════════════════════════════════════════════════════════

// ── Slice 14: Aroon (2 fields) ─────────────────────────────────────────

export interface AroonSlice {
  aroonUp: number | null;
  aroonDown: number | null;
}

/**
 * Aroon measures trend strength by TIME since the extreme, not by price
 * distance from it.
 *
 * The tie-breaking comparisons are `>=` for highs and `<=` for lows, so on a
 * repeated extreme the LATEST occurrence wins — which is what makes
 * daysSinceHigh/Low smaller and the reading stronger. Flipping either to a
 * strict comparison would silently weaken every reading on flat-topped bases.
 *
 * Guard is `n > AROON_PERIOD`, strictly greater, so a series of exactly 25
 * bars returns null rather than a value computed from a partial window.
 */
export function computeAroonSlice(c: SeriesInput): AroonSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const AROON_PERIOD = 25;

  if (n <= AROON_PERIOD) return { aroonUp: null, aroonDown: null };

  const hSlice = highs.slice(n - AROON_PERIOD, n);
  const lSlice = lows.slice(n - AROON_PERIOD, n);
  let hIdx = 0;
  let lIdx = 0;
  for (let i = 1; i < hSlice.length; i++) {
    if ((hSlice[i] as number) >= (hSlice[hIdx] as number)) hIdx = i;
    if ((lSlice[i] as number) <= (lSlice[lIdx] as number)) lIdx = i;
  }
  const daysSinceHigh = hSlice.length - 1 - hIdx;
  const daysSinceLow = lSlice.length - 1 - lIdx;

  return {
    aroonUp: ((AROON_PERIOD - daysSinceHigh) / AROON_PERIOD) * 100,
    aroonDown: ((AROON_PERIOD - daysSinceLow) / AROON_PERIOD) * 100,
  };
}

// ── Slice 15: Donchian channels (5 fields) ─────────────────────────────

export interface DonchianSlice {
  donchianUpper: number | null;
  donchianLower: number | null;
  donchianMid: number | null;
  donchian55Upper: number | null;
  donchian55Lower: number | null;
}

/**
 * Both channels use the INCLUSIVE-today convention (slice ending at n), which
 * the legacy source calls out explicitly as a deliberate difference from the
 * Turtle model's own stricter, book-exact EXCLUSIVE-today breakout definition
 * (turtleRollHighV1_/turtleRollLowV1_). Different purposes: these are a
 * display read, those drive real entry signals.
 *
 * The 55-day channel is informational only and deliberately NOT scored
 * anywhere — the project's standing rule is that a new Final-Conviction input
 * needs a real predictive-value backtest first.
 *
 * Note the guards differ from Aroon's: `>=` here, so exactly 20 bars yields a
 * value. Reproduced as found.
 */
export function computeDonchianSlice(c: SeriesInput): DonchianSlice {
  const { highs, lows } = c;
  const n = highs.length;
  const DONCHIAN_PERIOD = 20;
  const DONCHIAN55_PERIOD = 55;

  let donchianUpper: number | null = null;
  let donchianLower: number | null = null;
  let donchianMid: number | null = null;
  if (n >= DONCHIAN_PERIOD) {
    donchianUpper = Math.max(...highs.slice(n - DONCHIAN_PERIOD, n));
    donchianLower = Math.min(...lows.slice(n - DONCHIAN_PERIOD, n));
    donchianMid = (donchianUpper + donchianLower) / 2;
  }

  let donchian55Upper: number | null = null;
  let donchian55Lower: number | null = null;
  if (n >= DONCHIAN55_PERIOD) {
    donchian55Upper = Math.max(...highs.slice(n - DONCHIAN55_PERIOD, n));
    donchian55Lower = Math.min(...lows.slice(n - DONCHIAN55_PERIOD, n));
  }

  return { donchianUpper, donchianLower, donchianMid, donchian55Upper, donchian55Lower };
}

// ── Slice 16: Parabolic SAR (2 fields) ─────────────────────────────────

export interface ParabolicSarSlice {
  parabolicSAR: number | null;
  parabolicSARBullish: boolean | null;
}

/**
 * Wilder's original formula, with all three constants at their real,
 * never-changed defaults: AF starts 0.02, steps 0.02 per new extreme, caps
 * at 0.20.
 *
 * Genuinely recursive and stateful — today's SAR cannot be computed without
 * walking the entire available history, the same as ADX and OBV here. The
 * initial trend direction is seeded from closes[1] > closes[0], which means
 * the very start of the series is effectively arbitrary; the algorithm
 * self-corrects within a few reversals.
 *
 * The two-bar clamps (lows[i-1], lows[i-2]) are part of Wilder's definition,
 * not defensive coding: SAR may never penetrate the prior two bars' range.
 */
export function computeParabolicSarSlice(c: SeriesInput): ParabolicSarSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;

  let parabolicSAR: number | null = null;
  let parabolicSARBullish: boolean | null = null;

  try {
    const SAR_AF_START = 0.02;
    const SAR_AF_STEP = 0.02;
    const SAR_AF_MAX = 0.2;

    if (n > 5) {
      let trendUp = (closes[1] as number) > (closes[0] as number);
      let sar = trendUp
        ? Math.min(lows[0] as number, lows[1] as number)
        : Math.max(highs[0] as number, highs[1] as number);
      let ep = trendUp
        ? Math.max(highs[0] as number, highs[1] as number)
        : Math.min(lows[0] as number, lows[1] as number);
      let af = SAR_AF_START;

      for (let i = 2; i < n; i++) {
        let nextSar = sar + af * (ep - sar);
        if (trendUp) {
          nextSar = Math.min(nextSar, lows[i - 1] as number, lows[i - 2] as number);
          if ((lows[i] as number) < nextSar) {
            trendUp = false;
            nextSar = ep;
            ep = lows[i] as number;
            af = SAR_AF_START;
          } else if ((highs[i] as number) > ep) {
            ep = highs[i] as number;
            af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX);
          }
        } else {
          nextSar = Math.max(nextSar, highs[i - 1] as number, highs[i - 2] as number);
          if ((highs[i] as number) > nextSar) {
            trendUp = true;
            nextSar = ep;
            ep = highs[i] as number;
            af = SAR_AF_START;
          } else if ((lows[i] as number) < ep) {
            ep = lows[i] as number;
            af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX);
          }
        }
        sar = nextSar;
      }
      parabolicSAR = sar;
      parabolicSARBullish = trendUp;
    }
  } catch {
    /* non-fatal, matching the legacy guard */
  }

  return { parabolicSAR, parabolicSARBullish };
}

// ── Slice 17: SuperTrend (2 fields) ────────────────────────────────────

export interface SuperTrendSlice {
  superTrend: number | null;
  superTrendBullish: boolean | null;
}

/**
 * SuperTrend needs a PER-BAR ATR, not the final scalar atr14 — so it reuses
 * the Wilder-smoothed True Range ARRAY.
 *
 * The index alignment is the subtle part, and the legacy source documents
 * having checked it directly rather than assuming: sTR[0] is the average of
 * the first 14 real TR values (trArr[0..13], i.e. TR for real day indices
 * 1..14), which represents ATR "as of" day index 14. Each subsequent sTR[k]
 * advances exactly one day, so sTR[k] = ATR as of day (14 + k) — hence
 * atrAt(i) = sTR[i - 14]. Getting this off by one would produce plausible
 * but silently wrong bands.
 *
 * trendUp seeds `true` unconditionally, which is a real arbitrary choice at
 * the series start; like SAR, it self-corrects on the first real reversal.
 */
export function computeSuperTrendSlice(c: SeriesInput): SuperTrendSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const sTR = wilderArray(trueRangeSeries(c), 14);

  let superTrend: number | null = null;
  let superTrendBullish: boolean | null = null;

  try {
    const ST_MULTIPLIER = 3;
    const ST_START = 14;

    if (n > ST_START + 1 && sTR.length >= n - ST_START) {
      const atrAt = (i: number): number => sTR[i - ST_START] as number;

      let finalUpper =
        ((highs[ST_START] as number) + (lows[ST_START] as number)) / 2 + ST_MULTIPLIER * atrAt(ST_START);
      let finalLower =
        ((highs[ST_START] as number) + (lows[ST_START] as number)) / 2 - ST_MULTIPLIER * atrAt(ST_START);
      let trendUp = true;

      for (let i = ST_START + 1; i < n; i++) {
        const atrI = atrAt(i);
        const basicUpper = ((highs[i] as number) + (lows[i] as number)) / 2 + ST_MULTIPLIER * atrI;
        const basicLower = ((highs[i] as number) + (lows[i] as number)) / 2 - ST_MULTIPLIER * atrI;

        const newFinalUpper =
          basicUpper < finalUpper || (closes[i - 1] as number) > finalUpper ? basicUpper : finalUpper;
        const newFinalLower =
          basicLower > finalLower || (closes[i - 1] as number) < finalLower ? basicLower : finalLower;

        if (trendUp && (closes[i] as number) < newFinalLower) trendUp = false;
        else if (!trendUp && (closes[i] as number) > newFinalUpper) trendUp = true;

        finalUpper = newFinalUpper;
        finalLower = newFinalLower;
      }
      superTrend = trendUp ? finalLower : finalUpper;
      superTrendBullish = trendUp;
    }
  } catch {
    /* non-fatal */
  }

  return { superTrend, superTrendBullish };
}

// ── Slice 18: Ichimoku Cloud (5 fields) ────────────────────────────────

export interface IchimokuSlice {
  tenkanSen: number | null;
  kijunSen: number | null;
  senkouSpanA: number | null;
  senkouSpanB: number | null;
  /** TRI-STATE: true above cloud, false below, null INSIDE the cloud. */
  ichimokuCloudBullish: boolean | null;
}

/**
 * Standard textbook periods throughout: Tenkan 9, Kijun 26, Senkou B 52,
 * displacement 26.
 *
 * NO LOOKAHEAD, and the legacy source is careful to explain why: the cloud
 * visible against today's price on a real chart was computed 26 bars ago and
 * displaced forward when plotted. Reading it at cloudSrcIdx = lastIdx - 26
 * therefore uses only already-past data — the same legitimate displacement
 * every real Ichimoku chart uses.
 *
 * ichimokuCloudBullish is deliberately TRI-STATE. `null` means price is
 * INSIDE the cloud, which is a genuine neutral reading, not missing data.
 * Collapsing it to false would turn "no signal" into a bearish one.
 */
export function computeIchimokuSlice(c: SeriesInput): IchimokuSlice {
  const { closes, highs, lows } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  let tenkanSen: number | null = null;
  let kijunSen: number | null = null;
  let senkouSpanA: number | null = null;
  let senkouSpanB: number | null = null;
  let ichimokuCloudBullish: boolean | null = null;

  try {
    const ICHI_TENKAN = 9;
    const ICHI_KIJUN = 26;
    const ICHI_SENKOU_B = 52;
    const ICHI_DISPLACEMENT = 26;

    const midOf = (period: number, endIdx: number): number | null => {
      if (endIdx - period + 1 < 0) return null;
      return (
        (Math.max(...highs.slice(endIdx - period + 1, endIdx + 1)) +
          Math.min(...lows.slice(endIdx - period + 1, endIdx + 1))) /
        2
      );
    };

    const lastIdx = n - 1;
    tenkanSen = midOf(ICHI_TENKAN, lastIdx);
    kijunSen = midOf(ICHI_KIJUN, lastIdx);

    const cloudSrcIdx = lastIdx - ICHI_DISPLACEMENT;
    if (cloudSrcIdx >= ICHI_SENKOU_B - 1) {
      const tenkanAtSrc = midOf(ICHI_TENKAN, cloudSrcIdx);
      const kijunAtSrc = midOf(ICHI_KIJUN, cloudSrcIdx);
      senkouSpanA = ((tenkanAtSrc as number) + (kijunAtSrc as number)) / 2;
      senkouSpanB = midOf(ICHI_SENKOU_B, cloudSrcIdx);

      if (senkouSpanA != null && senkouSpanB != null) {
        const cloudTop = Math.max(senkouSpanA, senkouSpanB);
        const cloudBottom = Math.min(senkouSpanA, senkouSpanB);
        ichimokuCloudBullish = last > cloudTop ? true : last < cloudBottom ? false : null;
      }
    }
  } catch {
    /* non-fatal */
  }

  return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, ichimokuCloudBullish };
}

// ── Slice 19: Volume profile POC (1 field) ─────────────────────────────

export interface VolumeProfileSlice {
  volumePOC: number | null;
}

/**
 * Point of Control — the price level with the most traded volume.
 *
 * Each bar's volume is DISTRIBUTED evenly across every bucket its intraday
 * high-low range spans, rather than dumped into its close bucket. That is a
 * truer volume profile; the legacy code was upgraded to this from close-only
 * bucketing. Uses full available history, 25 buckets.
 *
 * The `|| 1` on bucketSize guards a zero price range (a series that never
 * moved) from producing a division by zero.
 */
export function computeVolumeProfileSlice(c: SeriesInput): VolumeProfileSlice {
  const { closes, highs, lows, volumes } = c;
  let volumePOC: number | null = null;

  try {
    if (closes.length > 30 && volumes.some((v) => v > 0)) {
      const priceMin = Math.min(...lows);
      const priceMax = Math.max(...highs);
      const numBuckets = 25;
      const bucketSize = (priceMax - priceMin) / numBuckets || 1;
      const bucketVolume = new Array<number>(numBuckets).fill(0);

      for (let i = 0; i < closes.length; i++) {
        const v = (volumes[i] as number) || 0;
        if (v <= 0) continue;
        let loIdx = Math.floor(((lows[i] as number) - priceMin) / bucketSize);
        let hiIdx = Math.floor(((highs[i] as number) - priceMin) / bucketSize);
        loIdx = Math.max(0, Math.min(numBuckets - 1, loIdx));
        hiIdx = Math.max(0, Math.min(numBuckets - 1, hiIdx));
        const span = hiIdx - loIdx + 1;
        const share = v / span;
        for (let b = loIdx; b <= hiIdx; b++) bucketVolume[b] = (bucketVolume[b] as number) + share;
      }

      let maxIdx = 0;
      for (let i = 1; i < numBuckets; i++) {
        if ((bucketVolume[i] as number) > (bucketVolume[maxIdx] as number)) maxIdx = i;
      }
      volumePOC = priceMin + (maxIdx + 0.5) * bucketSize;
    }
  } catch {
    /* non-fatal — supplementary signal */
  }

  return { volumePOC };
}

// ── Slice 20: Range volatility (4 fields) ──────────────────────────────

export interface VolatilityBand {
  tier: string;
  read: string;
}

export interface VolatilitySlice {
  weeklyVolatilityPct: number | null;
  monthlyVolatilityPct: number | null;
  weeklyVolatility: VolatilityBand | null;
  monthlyVolatility: VolatilityBand | null;
}

/**
 * Classifies range volatility against the broker course's own hot/coiled
 * bands (>5% hot, <3% coiled).
 *
 * The `read` strings are user-facing and must be reproduced BYTE-EXACTLY,
 * including the typographic em-dash and the curly apostrophe in "course's".
 * Any difference fails parity — which is the intended safety net, since these
 * strings reach the report.
 */
export function volatilityHotCold(pct: number | null): VolatilityBand | null {
  if (pct == null) return null;
  if (pct > 0.05) {
    return {
      tier: 'Hot',
      read: `Volatility ${(pct * 100).toFixed(1)}% — above the course's 5-6% "hot" band (ep.1): something real is happening`,
    };
  }
  if (pct < 0.03) {
    return {
      tier: 'Coiled',
      read: `Volatility ${(pct * 100).toFixed(1)}% — below the course's 3% "coiled" band (ep.1): calm before a possible storm`,
    };
  }
  return {
    tier: 'Normal',
    read: `Volatility ${(pct * 100).toFixed(1)}% — neither the course's hot (>5-6%) nor coiled (<3%) band (ep.1)`,
  };
}

/**
 * Range as a percentage of the window's average close.
 *
 * Note `!avgC` uses value truthiness, so an average close of exactly 0
 * returns null. Benign for equities; recorded as part of the F-06 family.
 */
export function computeVolatilitySlice(c: SeriesInput): VolatilitySlice {
  const { closes, highs, lows } = c;
  const n = closes.length;

  const trailing = (lookback: number): number | null => {
    if (n < lookback) return null;
    const wH = highs.slice(n - lookback);
    const wL = lows.slice(n - lookback);
    const wC = closes.slice(n - lookback);
    const avgC = wC.reduce((a, b) => a + b, 0) / wC.length;
    if (!avgC) return null;
    return (Math.max(...wH) - Math.min(...wL)) / avgC;
  };

  const weeklyVolatilityPct = trailing(5);
  const monthlyVolatilityPct = trailing(21);

  return {
    weeklyVolatilityPct,
    monthlyVolatilityPct,
    weeklyVolatility: volatilityHotCold(weeklyVolatilityPct),
    monthlyVolatility: volatilityHotCold(monthlyVolatilityPct),
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICES 21-22 — trailing performance and relative strength
//  Verified 2026-09-18: 566 comparisons, all exact, zero failures --
//  including rs both WITH a real SPY benchmark (139 cases) and WITHOUT
//  it (144 cases), confirming the graceful-null contract.
// ══════════════════════════════════════════════════════════════════════

/** trailingPerf additionally needs `dates` for its year-to-date calculation. */
export type DatedSeriesInput = SeriesInput & Pick<Chart, 'dates'>;

/** Relative strength additionally needs an optional, date-aligned benchmark. */
export type BenchmarkedSeriesInput = SeriesInput & Pick<Chart, 'benchmarkCloses'>;

// ── Slice 21: Trailing performance (1 field) ───────────────────────────

export interface TrailingPerf {
  week: number | null;
  month: number | null;
  quarter: number | null;
  halfYear: number | null;
  year: number | null;
  ytd: number | null;
  threeYear: number | null;
  fiveYear: number | null;
  tenYear: number | null;
}

export interface TrailingPerfSlice {
  trailingPerf: TrailingPerf | null;
}

export interface LongRangePerf {
  readonly threeYear: number | null;
  readonly fiveYear: number | null;
  readonly tenYear: number | null;
}

/**
 * computeLongRangeTrailingPerf_ (fullStockAnalysisV10_9.gs:6237-6247):
 * fractional returns over 756 / 1260 / 2520 bars of the 10-year closes.
 * Fewer than 2 closes is null. A past close of 0 is falsy and yields null
 * rather than a division (F-06 family).
 */
export function computeLongRangeTrailingPerf(longCloses: readonly number[]): LongRangePerf | null {
  const nL = longCloses.length;
  if (nL < 2) return null;
  const currentLong = longCloses[nL - 1] as number;
  const perfAt = (daysAgo: number): number | null => {
    if (nL <= daysAgo) return null;
    const past = longCloses[nL - 1 - daysAgo] as number;
    return past ? (currentLong - past) / past : null;
  };
  return { threeYear: perfAt(756), fiveYear: perfAt(1260), tenYear: perfAt(2520) };
}

/**
 * The ticker's OWN historical returns at fixed lookbacks. No benchmark
 * involved -- this is absolute performance, unlike the `rs` slice below.
 *
 * Returns are FRACTIONS, not percentages (0.0339 = +3.39%), unlike the roc*
 * and mom* fields which are pre-multiplied by 100. That inconsistency is real
 * legacy behaviour; consumers rely on it.
 *
 * YTD subtlety, reproduced exactly: startOfYearIdx finds the FIRST bar whose
 * UTC year matches the LAST bar's year, i.e. the first trading day of the
 * current year. When the whole series sits inside one calendar year that index
 * is 0, so "YTD" becomes the full-series return. Faithful, and worth knowing.
 *
 * The `past ? ... : null` guard is another falsy-zero site (F-06 family):
 * a genuine close of 0 yields null rather than a division. Benign for equities.
 *
 * threeYear / fiveYear / tenYear come from a SEPARATE long-range series of
 * the same ticker (legacy fetchYahooChartLongRange_: range=10y, closes only;
 * ported as fetch/yahoo.ts fetchYahooChartLongRange). Legacy fetched it
 * inside this computation (fullStockAnalysisV10_9.gs:7361) behind
 * hasTimeBudgetV7_(10000); here the caller fetches it and passes it in, so
 * the slice stays pure, and the budget gate is gone (per-step timeouts
 * replace it). Omitted or null `longCloses` leaves all three null, exactly
 * as legacy did when that fetch failed or was skipped. Verified against the
 * oracle with the long-range fetch injected (fl1.chart.test.ts).
 */
export function computeTrailingPerfSlice(
  c: DatedSeriesInput,
  longCloses?: readonly number[] | null,
): TrailingPerfSlice {
  const { closes, dates } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  let trailingPerf: TrailingPerf | null = null;
  try {
    const perfAt = (daysAgo: number): number | null => {
      if (n <= daysAgo) return null;
      const past = closes[n - 1 - daysAgo] as number;
      return past ? (last - past) / past : null;
    };

    const lastYear = (dates[n - 1] as Date).getUTCFullYear();
    const startOfYearIdx = dates.findIndex((d) => d.getUTCFullYear() === lastYear);
    const ytd =
      startOfYearIdx >= 0 && startOfYearIdx < n - 1
        ? (last - (closes[startOfYearIdx] as number)) / (closes[startOfYearIdx] as number)
        : null;

    trailingPerf = {
      week: perfAt(5),
      month: perfAt(21),
      quarter: perfAt(63),
      halfYear: perfAt(126),
      year: perfAt(252),
      ytd,
      // Filled below from the long-range series, when supplied.
      threeYear: null,
      fiveYear: null,
      tenYear: null,
    };

    // Legacy :7361-7369, inside the same try.
    if (longCloses) {
      const longPerf = computeLongRangeTrailingPerf(longCloses);
      if (longPerf) {
        trailingPerf.threeYear = longPerf.threeYear;
        trailingPerf.fiveYear = longPerf.fiveYear;
        trailingPerf.tenYear = longPerf.tenYear;
      }
    }
  } catch {
    /* non-fatal, matching the legacy guard */
  }

  return { trailingPerf };
}

// ── Slice 22: Relative strength vs benchmark (1 field) ─────────────────

export interface RelativeStrength {
  rs21: number;
  rs63: number;
  rsSlope: number;
  outperforming: boolean;
}

export interface RelativeStrengthSlice {
  rs: RelativeStrength | null;
}

/**
 * Performance relative to a benchmark (SPY), via the price RATIO series.
 *
 * The only slice with a genuine cross-ticker dependency. It requires
 * `benchmarkCloses` to be present AND exactly the same length as `closes` --
 * the legacy contract is `bench.length === n`, a strict equality, not a
 * minimum. A benchmark of any other length is treated as absent, which is a
 * deliberate refusal to silently compare misaligned series.
 *
 * Alignment is the CALLER's responsibility ("aligned to this stock's dates by
 * the caller"). That belongs to the Stage-0 shared-data layer, which fetches
 * SPY once per run and aligns it per ticker.
 *
 * Note the ratio series is FILTERED, so `rn` can be shorter than `n` when the
 * benchmark has zero/falsy entries -- and the rs21/rs63 lookbacks index into
 * the filtered array, not the original. Another falsy-zero site (F-06 family).
 *
 * Returns 0 rather than null for rs21/rs63 when history is too short, matching
 * the legacy convention for the roc-family / mom-family fields.
 */
export function computeRelativeStrengthSlice(c: BenchmarkedSeriesInput): RelativeStrengthSlice {
  const { closes } = c;
  const n = closes.length;
  const bench = c.benchmarkCloses;

  if (!bench || bench.length !== n) return { rs: null };

  const ratio = closes
    .map((v, i) => (bench[i] ? v / (bench[i] as number) : null))
    .filter((v): v is number => v != null);

  const rn = ratio.length;
  const rs21 = rn > 21 ? ((ratio[rn - 1] as number) / (ratio[rn - 22] as number) - 1) * 100 : 0;
  const rs63 = rn > 63 ? ((ratio[rn - 1] as number) / (ratio[rn - 64] as number) - 1) * 100 : 0;
  const rsSlope = slope(ratio, 63);

  return { rs: { rs21, rs63, rsSlope, outperforming: rs63 > 0 } };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICES 23-24 — divergence family and self-contained composites
//  Verified 2026-09-18: 1,584 comparisons across 144 chart variants,
//  all exact, zero failures.
//
//  Coverage here is genuinely exercised, not trivially null. Oracle
//  non-null counts out of 144: divergence / macdDivergence /
//  obvDivergence 144, climaxVolume / breakoutContext / roundNumber /
//  secondaryDay 144, halfwayRetracementRead 120, speculativeSpike 143,
//  singleCandle 22, dpoSignature 6 (PLTR only, by design).
// ══════════════════════════════════════════════════════════════════════

/** singleCandle needs `opens`; dpoSignature needs `ticker`. */
export type CompositeInput = SeriesInput & Pick<Chart, 'opens' | 'ticker'>;

// ── Slice 23: Divergence family (3 fields) ─────────────────────────────

export interface Divergence {
  type: 'bullish' | 'bearish' | 'none';
  note: string;
}

export interface DivergenceSlice {
  divergence: Divergence;
  macdDivergence: Divergence;
  obvDivergence: Divergence;
}

/**
 * Pivot-based divergence detection, shared by all three divergence fields.
 *
 * A bar is a pivot low only if NO bar within +/-3 is lower, and a pivot high
 * only if none is higher. The comparisons are strict, so a tie disqualifies
 * the pivot entirely -- on a flat-bottomed base no pivot is registered at all.
 * That is real behaviour and must not be relaxed to a non-strict comparison.
 *
 * Only the LAST TWO pivots of each kind are examined, and bullish is checked
 * before bearish, so a chart showing both reports bullish. Order matters.
 *
 * `oscLabel` defaults to 'RSI' purely for backward compatibility: the label
 * was once hardcoded, and keeping the default means the original call site
 * behaves identically while MACD and OBV can now identify themselves.
 */
export function detectDivergence(
  closes: readonly number[],
  osc: readonly number[],
  look: number,
  oscLabel?: string,
): Divergence {
  const label = oscLabel || 'RSI';
  const L = Math.min(look || 60, osc.length, closes.length);
  if (L < 20) return { type: 'none', note: 'insufficient history' };

  const price = closes.slice(-L);
  const o = osc.slice(-L);
  const w = 3;
  const lows: number[] = [];
  const highs: number[] = [];

  for (let i = w; i < L - w; i++) {
    let isLow = true;
    let isHigh = true;
    for (let j = i - w; j <= i + w; j++) {
      if ((price[j] as number) < (price[i] as number)) isLow = false;
      if ((price[j] as number) > (price[i] as number)) isHigh = false;
    }
    if (isLow) lows.push(i);
    if (isHigh) highs.push(i);
  }

  if (lows.length >= 2) {
    const a = lows[lows.length - 2] as number;
    const b = lows[lows.length - 1] as number;
    if ((price[b] as number) < (price[a] as number) && (o[b] as number) > (o[a] as number)) {
      return { type: 'bullish', note: `price lower low, ${label} higher low` };
    }
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2] as number;
    const b = highs[highs.length - 1] as number;
    if ((price[b] as number) > (price[a] as number) && (o[b] as number) < (o[a] as number)) {
      return { type: 'bearish', note: `price higher high, ${label} lower high` };
    }
  }
  return { type: 'none', note: 'no clear divergence' };
}

/** OBV as a full series. Duplicated from slice 8 to keep this slice independent. */
function obvSeries(c: SeriesInput): number[] {
  const { closes, volumes } = c;
  const n = closes.length;
  const out: number[] = [0];
  for (let i = 1; i < n; i++) {
    const p = out[out.length - 1] as number;
    out.push(
      (closes[i] as number) > (closes[i - 1] as number)
        ? p + (volumes[i] as number)
        : (closes[i] as number) < (closes[i - 1] as number)
          ? p - (volumes[i] as number)
          : p,
    );
  }
  return out;
}

/** MACD line as a full series. Same offset alignment as slice 2. */
function macdSeries(c: SeriesInput): number[] {
  const closes = c.closes;
  const e12 = emaArray(closes, 12);
  const e26 = emaArray(closes, 26);
  const off = e12.length - e26.length;
  return e26.map((v, i) => (e12[i + off] as number) - v);
}

/**
 * All three divergences use a 60-bar lookback. The oscillator series are
 * recomputed here rather than shared from slices 2 and 8 -- the legacy code
 * reuses them from its single function scope, but recomputation keeps each
 * slice independently testable and costs only pure arithmetic.
 */
export function computeDivergenceSlice(c: SeriesInput): DivergenceSlice {
  const closes = c.closes as readonly number[];
  return {
    divergence: detectDivergence(closes, rsiArray(closes, 14), 60),
    macdDivergence: detectDivergence(closes, macdSeries(c), 60, 'MACD'),
    obvDivergence: detectDivergence(closes, obvSeries(c), 60, 'OBV'),
  };
}

// ── Slice 24: Self-contained composites (8 fields) ─────────────────────

export const LEVEL_TOLERANCE = 0.03;
export const ROUND_NUMBER_TOLERANCE = 0.03;

/**
 * Tickers with a known DPO (direct public offering) history.
 *
 * Hardcoded to a single entry in the legacy code, and reproduced as such:
 * the delayed-breakout signature was derived from ONE real worked example,
 * so applying it to arbitrary tickers would be unsupported extrapolation.
 */
export const KNOWN_DPO_TICKERS: Readonly<Record<string, boolean>> = { PLTR: true };

export interface RoundNumberRead {
  nearest: number;
  increment: number;
  distPct: number;
  near: boolean;
}

export interface SecondaryDayRead {
  triggered: boolean;
  yesterdayVolRatio: number;
  yesterdayHigh: number;
}

export interface SpeculativeSpikeRead {
  isSpike: boolean;
  top2ShareOfMove: number;
  hasExtremeVolDay: boolean;
  read: string;
}

export interface SingleCandleRead {
  type: string;
  courseDirection: 'bullish' | 'bearish' | 'neutral';
  note: string;
}

export interface DpoSignatureRead {
  triggered: boolean;
  decliningPhase: boolean;
  resurgingPhase: boolean;
  breakingOut: boolean;
  read: string;
}

export interface HalfwayRetracementRead {
  moveFrom: number;
  moveTo: number;
  retracedPct: number;
  classification: 'normal' | 'thin' | 'suspect-major-reversal';
}

export interface CompositeSlice {
  climaxVolume: boolean;
  breakoutContext: string;
  halfwayRetracementRead: HalfwayRetracementRead | null;
  roundNumber: RoundNumberRead;
  secondaryDay: SecondaryDayRead | null;
  speculativeSpike: SpeculativeSpikeRead | null;
  singleCandle: SingleCandleRead | null;
  dpoSignature: DpoSignatureRead | null;
}

/** Round-level spacing scales with price. Above $1000 is acknowledged extrapolation. */
export function roundLevelIncrement(price: number): number {
  if (price < 5) return 0.5;
  if (price < 10) return 1;
  if (price < 100) return 10;
  if (price < 1000) return 100;
  return 1000;
}

export function roundNumberProximity(price: number, tolerance: number): RoundNumberRead {
  const inc = roundLevelIncrement(price);
  const nearest = Math.round(price / inc) * inc;
  const distPct = Math.abs(price - nearest) / price;
  return { nearest, increment: inc, distPct, near: distPct <= tolerance };
}

/**
 * Single-candle classification.
 *
 * IMPORTANT -- the `note` strings are user-facing and must be byte-exact.
 * They contain a Unicode approx sign, em-dashes, curly apostrophes, and
 * Hebrew text. Any substitution fails parity, which is the intended safety net
 * since these reach the report.
 *
 * Deliberate terminology divergence, preserved: the course's "Hammer" maps to
 * the Western SHOOTING STAR shape and is read BEARISH, while its "Inverted
 * Hammer" maps to the Western hammer and is read BULLISH. The names look
 * swapped relative to Western convention. They are not a mistake -- the course
 * naming is followed intentionally and the notes say so.
 *
 * Returns null for any candle matching no pattern, which is the common case.
 */
export function singleCandleClassify(
  open: number | null,
  high: number | null,
  low: number | null,
  close: number | null,
): SingleCandleRead | null {
  if (open == null || high == null || low == null || close == null) return null;
  const range = high - low;
  if (range <= 0) return null;

  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const bodyPct = body / range;

  if (bodyPct <= 0.1) {
    if (upperWick <= range * 0.1 && lowerWick >= range * 0.6) {
      return {
        type: 'DRAGONFLY_DOJI',
        courseDirection: 'bullish',
        note: 'open≈close≈high, long lower wick only — bullish reversal per the course (ep.6 external reference)',
      };
    }
    if (lowerWick <= range * 0.1 && upperWick >= range * 0.6) {
      return {
        type: 'GRAVESTONE_DOJI',
        courseDirection: 'bearish',
        note: 'open≈close≈low, long upper wick only — bearish reversal per the course (ep.6 external reference)',
      };
    }
    if (upperWick >= range * 0.4 && lowerWick >= range * 0.4) {
      return {
        type: 'LONG_LEGGED_DOJI',
        courseDirection: 'neutral',
        note: 'long wicks both sides, roughly equal — pure indecision per the course (ep.6)',
      };
    }
    return {
      type: 'DOJI',
      courseDirection: 'neutral',
      note: 'open≈close — the course frames this as a pause/transition after a run, not necessarily a reversal (ep.3 JKS example)',
    };
  }

  if (upperWick <= range * 0.05 && lowerWick <= range * 0.05) {
    const bullish = close > open;
    return {
      type: 'FULL_MARUBOZU',
      courseDirection: bullish ? 'bullish' : 'bearish',
      note:
        (bullish ? 'buyers won unambiguously' : 'sellers won unambiguously') +
        ' — real body-size still matters for significance (ep.3: a 1% full candle carries little signal, a 15% one is clearly powerful) but no single clean numeric cutoff was reliably spoken in the transcript; not encoded as a threshold here, disclosed not invented',
    };
  }

  if (body > 0) {
    if (lowerWick <= range * 0.1 && upperWick >= body * 2) {
      return {
        type: 'HAMMER_COURSE_TERM',
        courseDirection: 'bearish',
        note: 'course calls this "Hammer" (פטיש) — shape matches Western "shooting star," not Western "hammer." Course\'s own stated direction: bearish (tries to rise, closes low).',
      };
    }
    if (upperWick <= range * 0.1 && lowerWick >= body * 2) {
      return {
        type: 'INVERTED_HAMMER_COURSE_TERM',
        courseDirection: 'bullish',
        note: 'course calls this "Inverted Hammer" (פטיש הפוך) — shape matches Western "hammer," not Western "inverted hammer." Course\'s own stated direction: bullish.',
      };
    }
  }

  return null;
}

/**
 * Yesterday's high-volume day followed by today closing above yesterday's high.
 *
 * Note the volume window EXCLUDES yesterday itself: slice(yesterdayIdx-20,
 * yesterdayIdx). Needs 22 bars minimum -- 20 for the trailing window, plus
 * yesterday, plus today.
 */
export function secondaryDay(
  closes: readonly number[],
  highs: readonly number[],
  volumes: readonly number[],
  n: number,
): SecondaryDayRead | null {
  if (n < 22) return null;
  const yesterdayIdx = n - 2;
  const vol20avgRaw = volumes.slice(yesterdayIdx - 20, yesterdayIdx).reduce((a, b) => a + b, 0) / 20;
  const vol20avg = vol20avgRaw || 1;
  const yesterdayVolRatio = vol20avgRaw > 0 ? (volumes[yesterdayIdx] as number) / vol20avg : 1;
  const brokeYesterdayHigh = (closes[n - 1] as number) > (highs[yesterdayIdx] as number);
  return {
    triggered: yesterdayVolRatio > 1.5 && brokeYesterdayHigh,
    yesterdayVolRatio,
    yesterdayHigh: highs[yesterdayIdx] as number,
  };
}

/**
 * Detects a move driven by a handful of extreme-volume days rather than
 * sustained accumulation -- the inverse of the staircase pattern.
 *
 * Returns null when total absolute movement is exactly zero, so a perfectly
 * flat window yields no reading rather than a division by zero.
 */
export function speculativeSpike(
  closes: readonly number[],
  volumes: readonly number[],
  n: number,
  lookbackBars?: number,
): SpeculativeSpikeRead | null {
  const lookback = lookbackBars || 20;
  if (n < lookback) return null;

  const window = closes.slice(n - lookback, n);
  const volWindow = volumes.slice(n - lookback, n);

  const dailyPctChanges: number[] = [];
  for (let i = 1; i < window.length; i++) {
    dailyPctChanges.push(((window[i] as number) - (window[i - 1] as number)) / (window[i - 1] as number));
  }
  const totalAbsMove = dailyPctChanges.reduce((s, v) => s + Math.abs(v), 0);
  if (totalAbsMove === 0) return null;

  const sortedAbs = dailyPctChanges.map(Math.abs).slice().sort((a, b) => b - a);
  const top2Sum = sortedAbs.slice(0, 2).reduce((a, b) => a + b, 0);
  const dominatedByFewDays = top2Sum / totalAbsMove >= 0.5;

  const avgVol = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  const hasExtremeVolDay = avgVol > 0 && volWindow.some((v) => v >= 3 * avgVol);
  const isSpike = dominatedByFewDays && hasExtremeVolDay;

  return {
    isSpike,
    top2ShareOfMove: top2Sum / totalAbsMove,
    hasExtremeVolDay,
    read: isSpike
      ? 'A small number of days on extreme volume account for most of the move — speculative/retail-momentum signature (ep.1/3), the opposite of the staircase institutional-accumulation pattern'
      : 'Does not match the speculative-spike pattern',
  };
}

/**
 * Volume declining then resurging ahead of a breakout.
 *
 * `windowHigh` excludes today (slice(0, -1)), which is what makes this a
 * genuine no-lookahead breakout test rather than a tautology.
 *
 * The 30-bar lookback comes from the single real worked example, not a
 * separately stated universal rule -- which is also why it is gated to
 * KNOWN_DPO_TICKERS rather than applied broadly.
 */
export function dpoDelayedBreakout(
  closes: readonly number[],
  volumes: readonly number[],
  isDPO: boolean,
): DpoSignatureRead | null {
  if (!isDPO) return null;
  const LOOKBACK = 30;
  if (closes.length < LOOKBACK || volumes.length < LOOKBACK) return null;

  const cw = closes.slice(-LOOKBACK);
  const vw = volumes.slice(-LOOKBACK);
  const firstHalf = vw.slice(0, 15);
  const secondHalf = vw.slice(15);

  const decliningPhase = slope(firstHalf, firstHalf.length) < 0;
  const resurgingPhase = slope(secondHalf, secondHalf.length) > 0;
  const windowHigh = Math.max(...cw.slice(0, -1));
  const breakingOut = (cw[cw.length - 1] as number) >= windowHigh * (1 - LEVEL_TOLERANCE);
  const triggered = decliningPhase && resurgingPhase && breakingOut;

  return {
    triggered,
    decliningPhase,
    resurgingPhase,
    breakingOut,
    read: triggered
      ? "Volume declined then resurged ahead of a real breakout — matches the course's DPO delayed-breakout signature (ep.9, real PLTR example)"
      : 'Does not match the DPO delayed-breakout signature',
  };
}

/**
 * The eight self-contained composite reads.
 *
 * Two fields depend on values other slices also compute -- climaxVolume needs
 * volRatio and above200, breakoutContext needs high52 and roc252. Those are
 * recomputed inline here rather than threaded in, preserving slice
 * independence at the cost of a little duplicated arithmetic. The duplicated
 * expressions are identical to the verified ones in slices 8, 9, 10 and 11.
 *
 * halfwayRetracementRead measures a retracement of the most recent completed
 * SWING, which is genuinely different from fibPct (a position within the
 * rolling 52-week range). The two are easy to conflate. Its swing detection
 * uses non-strict comparisons, unlike detectDivergence above, so ties DO
 * register -- an inconsistency between the two algorithms that is real and
 * reproduced.
 */
export function computeCompositeSlice(c: CompositeInput): CompositeSlice {
  const { closes, highs, lows, volumes, opens, ticker } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  // climaxVolume dependencies (mirrors slices 8 and 9)
  const vol20avgRaw = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vol20avgRaw > 0 ? (volumes[n - 1] as number) / (vol20avgRaw || 1) : 1;
  const sma200 = sma(closes, 200);
  const above200 = sma200 ? last > sma200 : false;
  const climaxVolume = n > 1 && volRatio > 3.0 && last < (closes[n - 2] as number) && above200;

  // breakoutContext dependencies (mirrors slices 10 and 11)
  const high52 = Math.max(...highs.slice(-252));
  const roc252 = n > 252 ? (last / (closes[n - 253] as number) - 1) * 100 : 0;
  const nearATH = last >= high52 * 0.97;
  const longTermDowntrend = !nearATH && roc252 < -30;
  const breakoutContext = nearATH
    ? 'near 52wk/ATH — favorable breakout context'
    : longTermDowntrend
      ? 'long-term downtrend — weaker breakout context'
      : 'neutral';

  // halfwayRetracementRead
  let halfwayRetracementRead: HalfwayRetracementRead | null = null;
  try {
    const HR_SWING_WINDOW = 5;
    const hrSwings: Array<{ idx: number; price: number; type: 'H' | 'L' }> = [];
    for (let i = HR_SWING_WINDOW; i < n - HR_SWING_WINDOW; i++) {
      const hSlice = highs.slice(i - HR_SWING_WINDOW, i + HR_SWING_WINDOW + 1);
      const lSlice = lows.slice(i - HR_SWING_WINDOW, i + HR_SWING_WINDOW + 1);
      if (highs[i] === Math.max(...hSlice)) hrSwings.push({ idx: i, price: highs[i] as number, type: 'H' });
      if (lows[i] === Math.min(...lSlice)) hrSwings.push({ idx: i, price: lows[i] as number, type: 'L' });
    }
    hrSwings.sort((a, b) => a.idx - b.idx);

    if (hrSwings.length >= 2) {
      const hrLast = hrSwings[hrSwings.length - 1] as { idx: number; price: number; type: 'H' | 'L' };
      const hrPrior = hrSwings[hrSwings.length - 2] as { idx: number; price: number; type: 'H' | 'L' };
      if (hrLast.type !== hrPrior.type) {
        const moveSize = Math.abs(hrLast.price - hrPrior.price);
        if (moveSize > 0) {
          const retracedPct = Math.abs(last - hrLast.price) / moveSize;
          const classification =
            retracedPct <= 0.5 ? 'normal' : retracedPct <= 0.667 ? 'thin' : 'suspect-major-reversal';
          halfwayRetracementRead = { moveFrom: hrPrior.price, moveTo: hrLast.price, retracedPct, classification };
        }
      }
    }
  } catch {
    /* non-fatal, matching the legacy guard */
  }

  return {
    climaxVolume,
    breakoutContext,
    halfwayRetracementRead,
    roundNumber: roundNumberProximity(last, ROUND_NUMBER_TOLERANCE),
    secondaryDay: secondaryDay(closes, highs, volumes, n),
    speculativeSpike: speculativeSpike(closes, volumes, n),
    singleCandle:
      opens && opens[n - 1] != null
        ? singleCandleClassify(opens[n - 1] as number, highs[n - 1] as number, lows[n - 1] as number, last)
        : null,
    dpoSignature: ticker && KNOWN_DPO_TICKERS[ticker] ? dpoDelayedBreakout(closes, volumes, true) : null,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICE 25 — trend maturity
//  Verified 2026-09-19: 168/168 charts exact, 120 non-null, all three
//  maturity tiers exercised (NEW 94, MATURING 7, MATURE 19).
// ══════════════════════════════════════════════════════════════════════

export interface TrendMaturityRead {
  daysSinceCross: number;
  monthsSinceCross: number;
  maturity: 'NEW' | 'MATURING' | 'MATURE';
  foundCross: boolean;
  direction: 'UP' | 'DOWN';
}

export interface TrendMaturitySlice {
  trendMaturity: TrendMaturityRead | null;
}

/**
 * Days since the last SMA50/SMA200 crossover, so a Golden or Death Cross flag
 * can be read alongside how mature the resulting trend already is.
 *
 * Uses a PREFIX-SUM array to get O(1) SMA lookups at arbitrary bar indices.
 * A naive implementation recomputing sma() per bar would be O(n * 250) and is
 * the obvious way to write this -- the prefix sum is a deliberate optimisation
 * and produces identical values.
 *
 * Three behaviours that must be preserved exactly:
 *
 *  - A tie (s50 === s200) makes relAt return 0, and a CURRENT tie returns null
 *    for the whole read rather than picking a direction. No trend, no maturity.
 *  - The backward scan stops at index 199, the earliest bar where sma200
 *    exists. When no crossover is found in range, daysSinceCross falls back to
 *    (n-1) - 199 and foundCross is false -- so the caller can tell "trend has
 *    persisted for the entire visible history" apart from "trend began here".
 *  - Thresholds are 9 months for MATURE and 6 for MATURING, on a 21-trading-day
 *    month.
 */
export function trendMaturity(closes: readonly number[]): TrendMaturityRead | null {
  const n = closes.length;
  if (n < 200) return null;

  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (closes[i] as number);

  const smaAt = (endIdxIncl: number, len: number): number | null => {
    const startIdx = endIdxIncl - len + 1;
    if (startIdx < 0) return null;
    return ((prefix[endIdxIncl + 1] as number) - (prefix[startIdx] as number)) / len;
  };

  const relAt = (i: number): number | null => {
    const s50 = smaAt(i, 50);
    const s200 = smaAt(i, 200);
    if (s50 == null || s200 == null) return null;
    return s50 > s200 ? 1 : s50 < s200 ? -1 : 0;
  };

  const currentRel = relAt(n - 1);
  if (currentRel == null || currentRel === 0) return null;

  let crossBar: number | null = null;
  for (let j = n - 2; j >= 199; j--) {
    const rel = relAt(j);
    if (rel == null) break;
    if (rel !== currentRel) {
      crossBar = j + 1;
      break;
    }
  }

  const TRADING_DAYS_PER_MONTH = 21;
  const daysSinceCross = crossBar != null ? n - 1 - crossBar : n - 1 - 199;
  const monthsSinceCross = daysSinceCross / TRADING_DAYS_PER_MONTH;
  const maturity = monthsSinceCross >= 9 ? 'MATURE' : monthsSinceCross >= 6 ? 'MATURING' : 'NEW';

  return {
    daysSinceCross,
    monthsSinceCross,
    maturity,
    foundCross: crossBar != null,
    direction: currentRel > 0 ? 'UP' : 'DOWN',
  };
}

export function computeTrendMaturitySlice(c: SeriesInput): TrendMaturitySlice {
  return { trendMaturity: trendMaturity(c.closes) };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICES 26-28 — adapters for the fields that live in their own modules
//
//  chartPatterns, wyckoffSchematic and priceGaps are implemented in separate
//  modules because each is a substantial algorithm. These thin adapters exist
//  purely so they register in the coverage tracker under the same
//  computeXSlice(c) convention as everything else, keeping the asserted field
//  count honest.
// ══════════════════════════════════════════════════════════════════════

/** Everything the module-backed slices need: the series plus dates, opens and ticker. */
export type FullChartInput = SeriesInput & Pick<Chart, 'dates' | 'opens' | 'ticker'>;

export interface ChartPatternsSlice {
  chartPatterns: ChartPattern[];
}

/**
 * The only slice returning an ARRAY rather than scalars. deepStrictEqual on an
 * array is order-sensitive, so detector order is part of what the coverage test
 * verifies -- see chartPatterns.ts for why that order is the contract.
 */
export function computeChartPatternsSlice(c: FullChartInput): ChartPatternsSlice {
  return { chartPatterns: computeChartPatterns(c) };
}

export interface WyckoffSlice {
  wyckoffSchematic: WyckoffSchematic | null;
}

/**
 * Derives its own dependencies, which is what lets it fit the one-argument
 * slice convention despite wyckoffSchematic() needing three parameters.
 *
 * Both derived values are already verified at exact parity: volRatio via slice
 * 8, chartPatterns via its own full-array test. So recomputing them here yields
 * exactly what the legacy code's in-scope locals hold.
 *
 * ══ WHAT THIS DOES AND DOES NOT PROVE ═══════════════════════════════════
 * No real fixture produces a RECTANGLE, and wyckoffSchematic returns null
 * without one. So in the fixture-driven coverage test this compares null to
 * null -- it confirms the field is PRODUCED and AGREES, but exercises no logic.
 *
 * The real verification lives in test/wyckoff.parity.test.ts, which builds
 * synthetic flat-range charts that genuinely trigger it and covers the ST and
 * SOS/SOW stages. Do not read this registration as uniform verification
 * strength with the other slices.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Recomputes chartPatterns, so it runs twice across the two slices. Fine for
 * tests; the assembled computeAllIndicators will share one result.
 */
export function computeWyckoffSlice(c: FullChartInput): WyckoffSlice {
  const patterns = computeChartPatterns(c);
  const { volRatio } = computeVolumeSlice(c);
  return { wyckoffSchematic: wyckoffSchematic(c, volRatio, patterns) };
}

export interface PriceGapsSlice {
  priceGaps: PriceGap[];
}

export function computePriceGapsSlice(c: FullChartInput): PriceGapsSlice {
  return { priceGaps: computePriceGaps(c) };
}

// ══════════════════════════════════════════════════════════════════════
//  SLICE 29 — volume structure (2 fields)
//  Verified 2026-09-21: 384 comparisons across 192 chart variants, all
//  exact. Branch coverage: both trendDir values, aligned true 104 /
//  false 85, flagged true 2 / false 190.
// ══════════════════════════════════════════════════════════════════════

export interface TrendAlignedVolumeRead {
  avgUpDayVolume: number;
  avgDownDayVolume: number;
  trendDir: 'UP' | 'DOWN';
  aligned: boolean;
}

export interface VolumeProgressDivergenceRead {
  flagged: boolean;
  avgRecentVolume: number;
  avgBaseVolume: number;
  netProgressPct: number;
}

export interface VolumeStructureSlice {
  trendAlignedVolume: TrendAlignedVolumeRead | null;
  volumeProgressDivergence: VolumeProgressDivergenceRead | null;
}

/**
 * Two independent volume-structure reads.
 *
 * trendAlignedVolume asks whether volume confirms the prevailing trend: in an
 * uptrend, up-days should carry heavier volume than down-days. Flat days
 * (close unchanged) are counted in NEITHER bucket, and both buckets must be
 * non-empty or the whole read is null -- a one-sided sample would make the
 * comparison meaningless.
 *
 * volumeProgressDivergence flags heavy volume producing no price movement --
 * churn. Requires recent volume above 1.5x the prior baseline AND net progress
 * under 2% over the same window. Note the baseline window EXCLUDES the recent
 * window (slice ends at n-VPD_WINDOW), so the comparison is against genuinely
 * prior activity rather than a window overlapping itself.
 *
 * ══ FLAGGED FINDING F-08 — reproduced, not fixed ════════════════════════
 * `trendDir` is computed as `sma50 && last > sma50 ? 'UP' : 'DOWN'`. When
 * sma50 is null (under 50 bars) this short-circuits to 'DOWN', so short
 * history asserts a DOWNTREND regardless of actual direction -- and `aligned`
 * is then evaluated against that assumption.
 *
 * Notable because this file made the OPPOSITE choice elsewhere and said why:
 * pctFromSma20/50/200 return null rather than 0 precisely so a consumer does
 * not read "flat, therefore bearish". Same failure mode, opposite decision.
 *
 * Confirmed by test at 26- and 30-bar lengths: port and oracle agree on 'DOWN'
 * for every ticker. Reproduced to hold parity.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function computeVolumeStructureSlice(c: SeriesInput): VolumeStructureSlice {
  const { closes, volumes } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;
  const sma50 = sma(closes, 50);

  let trendAlignedVolume: TrendAlignedVolumeRead | null = null;
  try {
    const TAV_LOOKBACK = 20;
    if (n > TAV_LOOKBACK) {
      const upDayVols: number[] = [];
      const downDayVols: number[] = [];
      for (let i = n - TAV_LOOKBACK; i < n; i++) {
        // Unchanged closes land in neither bucket -- deliberate, not an oversight.
        if ((closes[i] as number) > (closes[i - 1] as number)) upDayVols.push(volumes[i] as number);
        else if ((closes[i] as number) < (closes[i - 1] as number)) downDayVols.push(volumes[i] as number);
      }
      // Both sides required: a one-sided sample makes the comparison meaningless.
      if (upDayVols.length && downDayVols.length) {
        const avgUp = upDayVols.reduce((a, b) => a + b, 0) / upDayVols.length;
        const avgDown = downDayVols.reduce((a, b) => a + b, 0) / downDayVols.length;
        const trendDir = sma50 && last > sma50 ? 'UP' : 'DOWN'; // see F-08
        const aligned = trendDir === 'UP' ? avgUp > avgDown : avgDown > avgUp;
        trendAlignedVolume = { avgUpDayVolume: avgUp, avgDownDayVolume: avgDown, trendDir, aligned };
      }
    }
  } catch {
    /* non-fatal */
  }

  let volumeProgressDivergence: VolumeProgressDivergenceRead | null = null;
  try {
    const VPD_WINDOW = 5;
    const VPD_VOL_MULT = 1.5;
    const VPD_MAX_PROGRESS_PCT = 0.02;
    const VPD_BASE_LOOKBACK = 20;
    if (n >= VPD_WINDOW + VPD_BASE_LOOKBACK) {
      // Baseline ends where the recent window begins -- no overlap.
      const baseVols = volumes.slice(n - VPD_WINDOW - VPD_BASE_LOOKBACK, n - VPD_WINDOW);
      const avgBaseVol = baseVols.reduce((a, b) => a + b, 0) / baseVols.length;
      const recentVols = volumes.slice(n - VPD_WINDOW, n);
      const avgRecentVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
      // Absolute value: churn in either direction counts as no progress.
      const netProgressPct = Math.abs(
        ((closes[n - 1] as number) - (closes[n - 1 - VPD_WINDOW] as number)) / (closes[n - 1 - VPD_WINDOW] as number),
      );
      const flagged = avgBaseVol > 0 && avgRecentVol > VPD_VOL_MULT * avgBaseVol && netProgressPct < VPD_MAX_PROGRESS_PCT;
      // The measurements are ALWAYS returned, flagged or not -- the caller can
      // see the numbers even when the threshold was not met.
      volumeProgressDivergence = { flagged, avgRecentVolume: avgRecentVol, avgBaseVolume: avgBaseVol, netProgressPct };
    }
  } catch {
    /* non-fatal */
  }

  return { trendAlignedVolume, volumeProgressDivergence };
}

// ── Coverage tracking ──────────────────────────────────────────────────

/**
 * Fields at verified exact parity with the oracle.
 * Asserted by the parity test, so it cannot drift from reality.
 *
 * Verified 2026-09-14: 17,280 comparisons across 192 chart variants from 24
 * fixtures (60→full bars), all exact via deepStrictEqual, zero failures.
 */
export const PORTED_INDICATOR_FIELDS: readonly string[] = [
  // slice 1 — RSI / weekly
  'last', 'rsi14', 'rsiWeekly', 'weeklyTrend',
  // slice 2 — MACD
  'macdVal', 'sigVal', 'histogram', 'histSlope',
  // slice 3 — Bollinger
  'sma20v', 'bbUpper', 'bbLower', 'bbPctB', 'bbWidth', 'bbSqueeze',
  // slice 4 — Stochastics
  'stochK', 'stochD', 'stochRSI',
  // slice 5 — Williams %R / CCI / MFI
  'willR', 'cci20', 'mfi14',
  // slice 6 — ATR
  'atr14', 'atrRatio', 'turtleN',
  // slice 7 — ADX
  'adx14', 'adxBullish',
  // slice 8 — volume
  'obvShortSlope', 'obvLongSlope', 'cmf20', 'volRatio',
  // slice 9 — moving averages
  'sma20', 'sma50', 'sma150', 'sma200', 'ema9', 'ema21',
  'goldenCross', 'deathCross', 'above200', 'above50',
  'pctFromSma20', 'pctFromSma50', 'pctFromSma200', 'shortSlope',
  // slice 10 — momentum
  'roc10', 'roc26', 'roc52', 'roc252', 'mom5', 'mom20',
  // slice 11 — 52wk / Fibonacci
  'high52', 'low52', 'fibPct', 'range52Pct',
  'fib236', 'fib382', 'fib500', 'fib618', 'fib786',
  // slice 12 — pivots
  'pivot', 'pp_R1', 'pp_S1', 'pp_R2', 'pp_S2', 'abovePivot',
  // slice 13 — Keltner / Chandelier
  'keltnerUpper', 'keltnerLower', 'keltnerSqueeze', 'chandelierHighestHigh', 'chandelierStop',
  // slice 14 — Aroon
  'aroonUp', 'aroonDown',
  // slice 15 — Donchian
  'donchianUpper', 'donchianLower', 'donchianMid', 'donchian55Upper', 'donchian55Lower',
  // slice 16 — Parabolic SAR
  'parabolicSAR', 'parabolicSARBullish',
  // slice 17 — SuperTrend
  'superTrend', 'superTrendBullish',
  // slice 18 — Ichimoku
  'tenkanSen', 'kijunSen', 'senkouSpanA', 'senkouSpanB', 'ichimokuCloudBullish',
  // slice 19 — volume profile
  'volumePOC',
  // slice 20 — range volatility
  'weeklyVolatilityPct', 'monthlyVolatilityPct', 'weeklyVolatility', 'monthlyVolatility',
  // slice 21 — trailing performance (3/5/10yr fields pending the fetch layer)
  'trailingPerf',
  // slice 22 — relative strength vs benchmark
  'rs',
  // slice 23 — divergence family
  'divergence', 'macdDivergence', 'obvDivergence',
  // slice 24 — self-contained composites
  'climaxVolume', 'breakoutContext', 'halfwayRetracementRead', 'roundNumber',
  'secondaryDay', 'speculativeSpike', 'singleCandle', 'dpoSignature',
  // slice 25 — trend maturity
  'trendMaturity',
  // slices 26-28 — module-backed fields (see the adapters above)
  'chartPatterns', 'wyckoffSchematic', 'priceGaps',
  // slice 29 — volume structure
  'trendAlignedVolume', 'volumeProgressDivergence',
  // slice 30 — support/resistance family
  'monthlyStructure', 'srLevels', 'srMultiTimeframe',
  // slice 31 — event-driven fields (verified on synthetic charts)
  'progressiveStopFlag', 'lockupExpiration', 'recentReverseSplit',
];

export const TOTAL_INDICATOR_FIELDS = 115;
