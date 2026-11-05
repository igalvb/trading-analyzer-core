/**
 * Broker Course Phase 14 -- multi-bar chart-pattern detection
 * (:748-1002, 7 functions): double top/bottom, head & shoulders (+
 * inverse), cup & handle, rectangle, triangle, plus an orchestrator and a
 * slope helper.
 *
 * Depends only on Phase 2 (findSwingPointsV1, findSupportResistanceV1).
 * Deliberately independent of the engine's own chartPatterns.ts -- a
 * separate opinion by design, with its own thresholds; result shapes only
 * loosely mirror the engine's for comparison.
 *
 * ══ FLAGGED (F-24): NOTHING CALLS ANY OF THIS ═════════════════════════
 * chartPatternReadV1 has zero callers across all ten legacy files; the
 * five detectors are reachable only through it, and linearFitSlopeV1 only
 * through triangleReadV1. buildBrokerCourseReportV1's `technical` section
 * (:2141) has no pattern field and the formatter (:2155-2245) reads none.
 * The parent project's CHECKPOINT_TODAY.md (:1074-1086) records this phase
 * as closing the model's "zero multi-bar chart-pattern detection" gap and
 * calls it complete -- yet the report still shows no patterns. Ported and
 * verified anyway (in scope, and it may yet be wired); NOT wired here.
 * test/brokerCourse.bc3.parity.test.ts pins the call-site counts.
 *
 * ══ HOW EVERY DETECTOR SEARCHES ════════════════════════════════════════
 * Each works on the last `lookbackBars` bars, scans swing points from the
 * MOST RECENT pair/triple backward, and returns the first qualifying match
 * -- so it reports the latest formation, not the best one. Swing window is
 * 5 bars everywhere except the triangle (3).
 *
 * Four output shapes coexist and must stay distinct: neckline+confirmed
 * (doubles, H&S), rim+confirmed (cup), resistance/support+status
 * (rectangle), status only (triangle).
 */

import { findSwingPointsV1, findSupportResistanceV1 } from './technicals.ts';

/**
 * Least-squares slope divided by the series mean -- %-per-step, comparable
 * across price levels. Plain statistics.
 *
 * Refuses (null) on fewer than 2 points, zero x-variance, OR a zero mean --
 * so [-1, 1] is null, not a slope. A flat series gives 0, not null.
 *
 * (The legacy comment says "same convention as linearFitRSquaredV1 above";
 * that function is actually BELOW it, at :1019 in Phase 5.)
 */
export function linearFitSlopeV1(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0;
  let ssXX = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = values[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
  }
  if (ssXX === 0 || !meanY) return null;
  return (ssXY / ssXX) / meanY;
}

export interface DoubleTopBottomRead {
  readonly type: 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';
  readonly level: number;
  readonly neckline: number;
  readonly confirmed: boolean;
  readonly read: string;
}

/**
 * Double top / double bottom (ep.5, the AMD worked example).
 *
 * Two CONSECUTIVE swing highs (lows) within 3% of each other (relative to
 * the first), with at least one opposite swing between them retracing
 * >=15% from the first -- conservatively below the AMD example's ~33%. The
 * neckline is the deepest trough (highest peak) between them; confirmed
 * when the last close is beyond it. `level` is the mean of the two peaks.
 *
 * Tops are checked first: a window holding both reports only the top.
 */
export function doubleTopBottomReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars: number,
): DoubleTopBottomRead | null {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 5);
  const TOLERANCE = 0.03;
  const MIN_RETRACE = 0.15;
  const lastClose = wCloses[wCloses.length - 1];

  function checkTop(): DoubleTopBottomRead | null {
    const sorted = swingHighs.slice().sort((a, b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i > 0; i--) {
      const p2 = sorted[i];
      const p1 = sorted[i - 1];
      if (Math.abs(p2.price - p1.price) / p1.price > TOLERANCE) continue;
      const between = swingLows.filter((l) => l.idx > p1.idx && l.idx < p2.idx);
      if (!between.length) continue;
      const trough = between.reduce((min, l) => l.price < min.price ? l : min, between[0]);
      const retrace = (p1.price - trough.price) / p1.price;
      if (retrace < MIN_RETRACE) continue;
      const confirmed = lastClose < trough.price;
      return {
        type: 'DOUBLE_TOP', level: (p1.price + p2.price) / 2, neckline: trough.price, confirmed,
        read: (confirmed ? 'CONFIRMED — broke below neckline. ' : 'Forming — neckline not yet broken. ')
          + 'Two comparable peaks ($' + p1.price.toFixed(2) + ', $' + p2.price.toFixed(2) + ') with a ' + (retrace * 100).toFixed(0)
          + '% pullback between them (neckline $' + trough.price.toFixed(2) + ') — matches the course\'s Double Top teaching (ep.5)',
      };
    }
    return null;
  }
  function checkBottom(): DoubleTopBottomRead | null {
    const sorted = swingLows.slice().sort((a, b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i > 0; i--) {
      const p2 = sorted[i];
      const p1 = sorted[i - 1];
      if (Math.abs(p2.price - p1.price) / p1.price > TOLERANCE) continue;
      const between = swingHighs.filter((h) => h.idx > p1.idx && h.idx < p2.idx);
      if (!between.length) continue;
      const peak = between.reduce((max, h) => h.price > max.price ? h : max, between[0]);
      const retrace = (peak.price - p1.price) / p1.price;
      if (retrace < MIN_RETRACE) continue;
      const confirmed = lastClose > peak.price;
      return {
        type: 'DOUBLE_BOTTOM', level: (p1.price + p2.price) / 2, neckline: peak.price, confirmed,
        read: (confirmed ? 'CONFIRMED — broke above neckline. ' : 'Forming — neckline not yet broken. ')
          + 'Two comparable troughs ($' + p1.price.toFixed(2) + ', $' + p2.price.toFixed(2) + ') with a ' + (retrace * 100).toFixed(0)
          + '% bounce between them (neckline $' + peak.price.toFixed(2) + ') — matches the course\'s Double Bottom teaching (ep.5)',
      };
    }
    return null;
  }
  return checkTop() || checkBottom();
}

export interface HeadAndShouldersRead {
  readonly type: 'HEAD_AND_SHOULDERS' | 'INVERSE_HEAD_AND_SHOULDERS';
  readonly level: number;
  readonly neckline: number;
  readonly confirmed: boolean;
  readonly read: string;
}

/**
 * Head & shoulders and its inverse (ep.5, both named).
 *
 * Three CONSECUTIVE swing highs (lows): the head must clear BOTH shoulders
 * by >=3%, and the shoulders must sit within 5% of each other (looser than
 * the double top's 3% -- only the head has to stand out). Needs at least
 * one trough on each side of the head.
 *
 * The neckline is a FLAT level -- the average of the last trough before the
 * head and the first trough after it -- not a sloping line extrapolated to
 * today as in the engine's own H&S. Regular is checked before inverse.
 */
export function headAndShouldersReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars: number,
): HeadAndShouldersRead | null {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 5);
  const SHOULDER_TOLERANCE = 0.05;
  const HEAD_MIN_EXCESS = 0.03;
  const lastClose = wCloses[wCloses.length - 1];

  function checkRegular(): HeadAndShouldersRead | null {
    const sorted = swingHighs.slice().sort((a, b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i >= 2; i--) {
      const rightShoulder = sorted[i];
      const head = sorted[i - 1];
      const leftShoulder = sorted[i - 2];
      if (head.price < leftShoulder.price * (1 + HEAD_MIN_EXCESS) || head.price < rightShoulder.price * (1 + HEAD_MIN_EXCESS)) continue;
      if (Math.abs(rightShoulder.price - leftShoulder.price) / leftShoulder.price > SHOULDER_TOLERANCE) continue;
      const leftTroughs = swingLows.filter((l) => l.idx > leftShoulder.idx && l.idx < head.idx);
      const rightTroughs = swingLows.filter((l) => l.idx > head.idx && l.idx < rightShoulder.idx);
      if (!leftTroughs.length || !rightTroughs.length) continue;
      const necklineLevel = (leftTroughs[leftTroughs.length - 1].price + rightTroughs[0].price) / 2;
      const confirmed = lastClose < necklineLevel;
      return {
        type: 'HEAD_AND_SHOULDERS', level: head.price, neckline: necklineLevel, confirmed,
        read: (confirmed ? 'CONFIRMED — broke below neckline. ' : 'Forming — neckline not yet broken. ')
          + 'Head $' + head.price.toFixed(2) + ' clearly above comparable shoulders ($' + leftShoulder.price.toFixed(2) + ', $' + rightShoulder.price.toFixed(2)
          + '), neckline $' + necklineLevel.toFixed(2) + ' — matches the course\'s Head & Shoulders teaching (ep.5)',
      };
    }
    return null;
  }
  function checkInverted(): HeadAndShouldersRead | null {
    const sorted = swingLows.slice().sort((a, b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i >= 2; i--) {
      const rightShoulder = sorted[i];
      const head = sorted[i - 1];
      const leftShoulder = sorted[i - 2];
      if (head.price > leftShoulder.price * (1 - HEAD_MIN_EXCESS) || head.price > rightShoulder.price * (1 - HEAD_MIN_EXCESS)) continue;
      if (Math.abs(rightShoulder.price - leftShoulder.price) / leftShoulder.price > SHOULDER_TOLERANCE) continue;
      const leftPeaks = swingHighs.filter((h) => h.idx > leftShoulder.idx && h.idx < head.idx);
      const rightPeaks = swingHighs.filter((h) => h.idx > head.idx && h.idx < rightShoulder.idx);
      if (!leftPeaks.length || !rightPeaks.length) continue;
      const necklineLevel = (leftPeaks[leftPeaks.length - 1].price + rightPeaks[0].price) / 2;
      const confirmed = lastClose > necklineLevel;
      return {
        type: 'INVERSE_HEAD_AND_SHOULDERS', level: head.price, neckline: necklineLevel, confirmed,
        read: (confirmed ? 'CONFIRMED — broke above neckline. ' : 'Forming — neckline not yet broken. ')
          + 'Head $' + head.price.toFixed(2) + ' clearly below comparable shoulders ($' + leftShoulder.price.toFixed(2) + ', $' + rightShoulder.price.toFixed(2)
          + '), neckline $' + necklineLevel.toFixed(2) + ' — matches the course\'s Inverted Head & Shoulders teaching (ep.5)',
      };
    }
    return null;
  }
  return checkRegular() || checkInverted();
}

export interface CupAndHandleRead {
  readonly type: 'CUP_AND_HANDLE';
  readonly rim: number;
  readonly cupLow: number;
  readonly handleLow: number;
  readonly confirmed: boolean;
  readonly read: string;
}

/**
 * Cup & handle (ep.5, named repeatedly; no numbers given -- every threshold
 * is a disclosed textbook default).
 *
 * FIXED geometry, not a search: the cup is the first 80% of the window and
 * the handle the last 20%. The left rim is the highest high among only the
 * FIRST 5 bars; the cup low must sit between 15% and 85% of the cup; depth
 * 10-50%; the right rim (max high of the cup's last 5 bars) must recover to
 * within 5% of the left. The legacy comment's "cup spans at least half the
 * window" is not a separate check -- the 80% split makes it automatic.
 *
 * ══ THE HANDLE IS MEASURED ON CLOSES AGAINST A RIM BUILT FROM HIGHS ════
 * handleDepth = (rim - min handle CLOSE) / rim must be >= 0 and <= half the
 * cup depth. So if every handle close is ABOVE the rim, the pattern is
 * rejected outright (null) -- a breakout whose handle never dipped back to
 * the rim is not reported. Confirmed = last close above the rim.
 *
 * Note `n` is taken from closes while the guard checks highs; the arrays
 * are always the same length in practice.
 */
export function cupAndHandleReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars: number,
): CupAndHandleRead | null {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = closes.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const wCloses = closes.slice(n - lookbackBars);
  const m = wCloses.length;
  const cupWindow = Math.floor(m * 0.8);
  const cupHighs = wHighs.slice(0, cupWindow);
  const cupLows = wLows.slice(0, cupWindow);
  let leftRimIdx = 0;
  for (let i = 1; i < 5 && i < cupHighs.length; i++) if (cupHighs[i] > cupHighs[leftRimIdx]) leftRimIdx = i;
  const leftRim = cupHighs[leftRimIdx];
  let cupLowIdx = 0;
  for (let i = 0; i < cupLows.length; i++) if (cupLows[i] < cupLows[cupLowIdx]) cupLowIdx = i;
  const cupLow = cupLows[cupLowIdx];
  if (cupLowIdx < cupWindow * 0.15 || cupLowIdx > cupWindow * 0.85) return null;
  const cupDepth = (leftRim - cupLow) / leftRim;
  if (cupDepth < 0.10 || cupDepth > 0.50) return null;
  const rightRim = Math.max.apply(null, wHighs.slice(Math.max(0, cupWindow - 5), cupWindow));
  if (rightRim < leftRim * (1 - 0.05)) return null;
  const rim = Math.max(leftRim, rightRim);

  const handleSlice = wCloses.slice(cupWindow);
  if (!handleSlice.length) return null;
  const handleLow = Math.min.apply(null, handleSlice);
  const handleDepth = (rim - handleLow) / rim;
  if (handleDepth > cupDepth * 0.5 || handleDepth < 0) return null;

  const lastClose = wCloses[wCloses.length - 1];
  const confirmed = lastClose > rim;
  return {
    type: 'CUP_AND_HANDLE', rim, cupLow, handleLow, confirmed,
    read: (confirmed ? 'CONFIRMED — broke above the cup\'s rim. ' : 'Forming — rim not yet broken. ')
      + 'Rounded decline-and-recovery (' + (cupDepth * 100).toFixed(0) + '% deep) back to $' + rim.toFixed(2)
      + ', followed by a shallow ' + (handleDepth * 100).toFixed(0) + '% handle pullback — matches the course\'s Cup & Handle teaching (ep.5)',
  };
}

export type PatternStatus = 'BROKE_UP' | 'BROKE_DOWN' | 'FORMING';

export interface RectangleRead {
  readonly type: 'RECTANGLE';
  readonly resistanceLevel: number;
  readonly supportLevel: number;
  readonly status: PatternStatus;
  readonly read: string;
}

/**
 * Rectangle (ep.4, the instructor's own spoken "touched once and dropped,
 * touched twice and dropped" definition): a resistance level and a support
 * level coexisting in time. Pure reuse of Phase 2's S/R.
 *
 * Only the STRONGEST of each side (most touches) is considered; resistance
 * must be above support and their touch spans must overlap. Status is
 * judged against the levels themselves.
 *
 * Calls findSupportResistanceV1 with four arguments (F-21/F-22), but reads
 * only level/touchCount/duration/lastTouchIdx, never `trendFavored` -- so
 * F-22 has no effect here.
 */
export function rectangleReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars: number,
): RectangleRead | null {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const wCloses = closes.slice(n - lookbackBars);
  const { resistanceLevels, supportLevels } = findSupportResistanceV1(wHighs, wLows, 0.03, wHighs.length - 1);
  if (!resistanceLevels.length || !supportLevels.length) return null;
  const res = resistanceLevels[0];
  const sup = supportLevels[0];
  if (res.level <= sup.level) return null;
  const resSpan = [res.lastTouchIdx - res.duration, res.lastTouchIdx];
  const supSpan = [sup.lastTouchIdx - sup.duration, sup.lastTouchIdx];
  const overlaps = resSpan[0] <= supSpan[1] && supSpan[0] <= resSpan[1];
  if (!overlaps) return null;
  const lastClose = wCloses[wCloses.length - 1];
  const status: PatternStatus = lastClose > res.level ? 'BROKE_UP' : lastClose < sup.level ? 'BROKE_DOWN' : 'FORMING';
  return {
    type: 'RECTANGLE', resistanceLevel: res.level, supportLevel: sup.level, status,
    read: (status !== 'FORMING' ? 'CONFIRMED ' + status.replace('_', ' ') + ' — ' : 'Forming — ')
      + 'Repeated touch-and-reject at resistance ($' + res.level.toFixed(2) + ', ' + res.touchCount + ' touches) and support ($'
      + sup.level.toFixed(2) + ', ' + sup.touchCount + ' touches) — matches the course\'s rectangle definition (ep.4)',
  };
}

export type TriangleSubtype = 'ASCENDING' | 'DESCENDING' | 'SYMMETRIC';

export interface TriangleRead {
  readonly type: 'TRIANGLE_ASCENDING' | 'TRIANGLE_DESCENDING' | 'TRIANGLE_SYMMETRIC';
  readonly status: PatternStatus;
  readonly read: string;
}

/**
 * Triangle -- NOT course content. The source records an exhaustive
 * transcript search finding only two casual mentions; built for parity with
 * the engine at the user's explicit request and labelled as standard TA in
 * its own read text.
 *
 * Uses a 3-bar swing window (every other detector uses 5).
 *
 * ══ "PER BAR" IS REALLY "PER SWING" ═══════════════════════════════════
 * The trendline slopes are linearFitSlopeV1 over the swing PRICES in order
 * -- x is the swing's ordinal (0,1,2...), not its bar index. So the
 * FLAT = 0.001 threshold the source calls "roughly flat per bar" is
 * actually per swing, and unevenly spaced swings are treated as evenly
 * spaced.
 *
 * Convergence is checked only as last bar's range < first bar's range, and
 * status is judged against the most recent swing high/low, not the fitted
 * lines.
 */
export function triangleReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars: number,
): TriangleRead | null {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  const resSlope = linearFitSlopeV1(swingHighs.map((p) => p.price));
  const supSlope = linearFitSlopeV1(swingLows.map((p) => p.price));
  if (resSlope == null || supSlope == null) return null;
  const FLAT = 0.001;
  let subtype: TriangleSubtype | null = null;
  if (Math.abs(resSlope) <= FLAT && supSlope > FLAT) subtype = 'ASCENDING';
  else if (Math.abs(supSlope) <= FLAT && resSlope < -FLAT) subtype = 'DESCENDING';
  else if (resSlope < -FLAT && supSlope > FLAT) subtype = 'SYMMETRIC';
  if (!subtype) return null;
  const firstRange = wHighs[0] - wLows[0];
  const lastRange = wHighs[wHighs.length - 1] - wLows[wLows.length - 1];
  if (!(firstRange > 0) || lastRange >= firstRange) return null;
  const lastClose = wCloses[wCloses.length - 1];
  const resLine = swingHighs[swingHighs.length - 1].price;
  const supLine = swingLows[swingLows.length - 1].price;
  const status: PatternStatus = lastClose > resLine ? 'BROKE_UP' : lastClose < supLine ? 'BROKE_DOWN' : 'FORMING';
  return {
    type: ('TRIANGLE_' + subtype) as TriangleRead['type'],
    status,
    read: (status !== 'FORMING' ? 'CONFIRMED ' + status.replace('_', ' ') + ' — ' : 'Forming — ')
      + subtype.charAt(0) + subtype.slice(1).toLowerCase()
      + ' triangle, converging trendlines — standard technical-analysis pattern (not course-specific, same disclosure as the basic candlestick geometry)',
  };
}

export type BrokerChartPattern =
  | DoubleTopBottomRead | HeadAndShouldersRead | CupAndHandleRead | RectangleRead | TriangleRead;

/**
 * First detector that fires, in priority order: course-taught patterns
 * first, the standard-TA triangle last. Default lookback 60 (`||`, so 0
 * also means 60).
 *
 * Priority is load-bearing: measured over the test sweep, 358 real
 * lower-priority detections are hidden by a higher-priority one.
 *
 * F-24: nothing in the legacy system calls this.
 */
export function chartPatternReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackBars?: number | null,
): BrokerChartPattern | null {
  const lb = lookbackBars || 60;
  return doubleTopBottomReadV1(highs, lows, closes, lb)
    || headAndShouldersReadV1(highs, lows, closes, lb)
    || cupAndHandleReadV1(highs, lows, closes, lb)
    || rectangleReadV1(highs, lows, closes, lb)
    || triangleReadV1(highs, lows, closes, lb);
}
