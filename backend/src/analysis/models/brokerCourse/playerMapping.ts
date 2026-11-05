/**
 * Broker Course Phase 5 -- player mapping (:1019-1195, 7 functions;
 * episodes 1, 3, 4, 6, 7).
 *
 * Infers WHO is driving a move from its shape alone -- patient
 * institutional accumulation (the VWAP/TWAP "staircase") vs. speculative
 * spikes -- plus whether the move paused to form S/R ledges and whether
 * price sits at a round number. Inference only, never a claim of
 * institutional data; real 13F holdings are a SEPARATE report section by
 * design.
 *
 * Depends only on Phase 2 (findSupportResistanceV1).
 *
 * ══ SHARED WITH THE ENGINE ════════════════════════════════════════════
 * The engine calls playerMappingReadV1 directly, cross-file
 * (fullStockAnalysisV10_9.gs:1221, attached as `ind.playerMapping`) -- so
 * this module is a dependency of the main pipeline too, not only the
 * broker report. That call site's `else ... 'degraded', 'playerMappingReadV1
 * returned null'` branch (:1223) is unreachable: this function never
 * returns null (tested).
 *
 * ══ TWO ENGINE TWINS, MEASURED ═══════════════════════════════════════
 * speculativeSpikeReadV1 matches the engine's speculativeSpikeV7 (:9531) on
 * every number across 1,000 real windows; only the read text differs.
 * roundNumberIncrementV1 matches roundLevelIncrementV7 exactly. The
 * round-number TOLERANCE does not: the engine uses 3% on the last close
 * (:7730), this model 2% on the live quote (:1180) -- 11 of 200 real price
 * points disagree, always with the engine saying "near". Two independently
 * chosen defaults, not drift; recorded, not registered.
 */

import { findSupportResistanceV1 } from './technicals.ts';

/**
 * Linear-regression R^2. Plain statistics. Needs 3 points; a flat series
 * (zero y-variance) has no fit and returns null.
 */
export function linearFitRSquaredV1(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0;
  let ssXX = 0;
  let ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = values[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }
  if (ssXX === 0 || ssYY === 0) return null;
  const r = ssXY / Math.sqrt(ssXX * ssYY);
  return r * r;
}

export interface StaircaseRead {
  readonly isStaircase: boolean;
  readonly rSquared: number;
  readonly noSingleDayDominates: boolean;
  readonly noVolumeSpike: boolean;
  readonly read: string;
}

/**
 * The institutional "staircase" (ep.6): a net-up, roughly linear climb
 * (R^2 >= 0.7) where no single day's |% change| exceeds 2x the window's
 * average and no day's volume reaches 3x the window average. Disclosed
 * defaults, not fitted.
 *
 * Zero average volume can never qualify (`avgVol > 0`). Unlike
 * speculativeSpikeReadV1, there is NO guard on `volumes` -- a null array
 * throws. Latent only: production volumes are never null
 * (fetchYahooChartRaw_ writes `volume || 0`).
 */
export function staircasePatternReadV1(
  closes: readonly number[] | null | undefined,
  volumes: readonly number[],
  lookbackBars: number,
): StaircaseRead | null {
  if (!closes || closes.length < lookbackBars) return null;
  const n = closes.length;
  const win = closes.slice(n - lookbackBars);
  const volWindow = volumes.slice(n - lookbackBars);
  const rSquared = linearFitRSquaredV1(win);
  if (rSquared == null) return null;
  const netUp = win[win.length - 1] > win[0];

  const dailyPctChanges: number[] = [];
  for (let i = 1; i < win.length; i++) dailyPctChanges.push(Math.abs((win[i] - win[i - 1]) / win[i - 1]));
  const avgDailyPct = dailyPctChanges.reduce((a, b) => a + b, 0) / dailyPctChanges.length;
  const maxDailyPct = Math.max.apply(null, dailyPctChanges);
  const noSingleDayDominates = maxDailyPct <= 2 * avgDailyPct;

  const avgVol = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  const maxVol = Math.max.apply(null, volWindow);
  const noVolumeSpike = avgVol > 0 && maxVol < 3 * avgVol;

  const isStaircase = netUp && rSquared >= 0.7 && noSingleDayDominates && noVolumeSpike;
  return {
    isStaircase, rSquared, noSingleDayDominates, noVolumeSpike,
    read: isStaircase
      ? 'Steady, linear climb with no single-day or single-volume spike driving it — matches the course\'s institutional VWAP/TWAP "staircase" signature (ep.6)'
      : 'Does not match the staircase pattern',
  };
}

export interface SpeculativeSpikeRead {
  readonly isSpike: boolean;
  readonly top2ShareOfMove: number;
  readonly hasExtremeVolDay: boolean;
  readonly read: string;
}

/**
 * The speculative spike (ep.1/3): the two largest |daily % changes| make up
 * >= 50% of the window's total absolute movement AND some day's volume is
 * >= 3x the window average. Disclosed defaults; the source corrected a
 * mis-quoted episode citation without touching these numbers.
 *
 * A flat window (zero total movement) refuses. Direction-blind: a crash
 * qualifies as readily as a squeeze.
 */
export function speculativeSpikeReadV1(
  closes: readonly number[] | null | undefined,
  volumes: readonly number[] | null | undefined,
  lookbackBars: number,
): SpeculativeSpikeRead | null {
  if (!closes || closes.length < lookbackBars || !volumes) return null;
  const n = closes.length;
  const win = closes.slice(n - lookbackBars);
  const volWindow = volumes.slice(n - lookbackBars);
  const dailyPctChanges: number[] = [];
  for (let i = 1; i < win.length; i++) dailyPctChanges.push((win[i] - win[i - 1]) / win[i - 1]);
  const totalAbsMove = dailyPctChanges.reduce((s, v) => s + Math.abs(v), 0);
  if (totalAbsMove === 0) return null;
  const sortedAbs = dailyPctChanges.map(Math.abs).slice().sort((a, b) => b - a);
  const top2Sum = sortedAbs.slice(0, 2).reduce((a, b) => a + b, 0);
  const dominatedByFewDays = top2Sum / totalAbsMove >= 0.5;

  const avgVol = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  const hasExtremeVolDay = avgVol > 0 && volWindow.some((v) => v >= 3 * avgVol);

  const isSpike = dominatedByFewDays && hasExtremeVolDay;
  return {
    isSpike, top2ShareOfMove: top2Sum / totalAbsMove, hasExtremeVolDay,
    read: isSpike
      ? 'A small number of days on extreme volume account for most of the move — matches the course\'s speculative/retail-momentum signature (ep.1/3)'
      : 'Does not match the speculative-spike pattern',
  };
}

export interface NoConsolidationRead {
  readonly hasNoConsolidation: boolean;
  readonly levelsFormed: number;
  readonly read: string;
}

/**
 * "No consolidation" (ep.3/4): did the move form ANY S/R ledge along the
 * way? A straight-line move is a lower-reliability continuation.
 *
 * On short windows this is nearly always true -- Phase 2's S/R needs 5-bar
 * swings with two touches, which a 20-bar window rarely holds -- measured
 * as the majority outcome at lookbacks <= 40. `trendFavored` (F-22) is not
 * read, only the level count.
 */
export function noConsolidationReadV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[],
  lookbackBars: number,
): NoConsolidationRead | null {
  if (!highs || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const { resistanceLevels, supportLevels } = findSupportResistanceV1(wHighs, wLows, 0.03, wHighs.length - 1);
  const totalLevels = resistanceLevels.length + supportLevels.length;
  return {
    hasNoConsolidation: totalLevels === 0,
    levelsFormed: totalLevels,
    read: totalLevels === 0
      ? 'No S/R ledges formed during this move — straight-line, lower-reliability continuation signal (ep.3/4)'
      : totalLevels + ' S/R level(s) formed along the way — the move paused/re-based, higher-reliability signature',
  };
}

/**
 * Round-number step for a price: $0.50 below $5, $1 to $10, $10 to $100,
 * $100 to $1,000, $1,000 above (the DPW/NIO/TSLA worked examples; $1,000+
 * is an extrapolation). Identical to the engine's roundLevelIncrementV7.
 */
export function roundNumberIncrementV1(price: number): number {
  if (price < 5) return 0.5;
  if (price < 10) return 1;
  if (price < 100) return 10;
  if (price < 1000) return 100;
  return 1000;
}

export interface RoundNumberRead {
  readonly nearestRound: number;
  readonly distPct: number;
  readonly isNearRoundNumber: boolean;
  readonly read: string;
}

/**
 * Is the price within `tolerancePct` (default 2%, inclusive) of the nearest
 * round number at its own scale?
 *
 * Math.round rounds halves UP, so 4.75 -> 5. Below $0.25 the "nearest
 * round number" is 0, which is 100% away and never near. Null, zero and
 * negative prices refuse.
 */
export function roundNumberProximityV1(
  price: number | null | undefined, tolerancePct?: number | null,
): RoundNumberRead | null {
  if (price == null || price <= 0) return null;
  const tol = tolerancePct == null ? 0.02 : tolerancePct;
  const magnitude = roundNumberIncrementV1(price);
  const nearestRound = Math.round(price / magnitude) * magnitude;
  const distPct = Math.abs(price - nearestRound) / price;
  return {
    nearestRound, distPct,
    isNearRoundNumber: distPct <= tol,
    read: distPct <= tol
      ? ('Price is near the round number ' + nearestRound + ' — course flags these as algo/institutional order-clustering points (ep.6/7)')
      : 'Not currently near a round-number level',
  };
}

export type PlayerTag = 'Institutional-Accumulation-Signature' | 'Speculative-Spike' | 'Mixed/Unclear';

export interface PlayerMappingRead {
  readonly tag: PlayerTag;
  readonly evidence: string[];
}

/**
 * One qualitative tag plus an evidence list. Default lookback 20 (`||`).
 *
 * Staircase is checked before spike, but the order can never matter: the
 * staircase needs every day's volume under 3x the average and the spike
 * needs some day at or above it, over the identical window -- mutually
 * exclusive whenever average volume is positive, and both false otherwise.
 * Measured: zero overlaps on real data.
 *
 * Never returns null -- with every input missing it is
 * `{ tag: 'Mixed/Unclear', evidence: [] }`.
 *
 * The source records removing a former `gapHoldFade` input: the rule it
 * implemented was found nowhere in the course transcripts.
 */
export function playerMappingReadV1(
  closes: readonly number[] | null | undefined,
  highs: readonly number[] | null | undefined,
  lows: readonly number[],
  volumes: readonly number[],
  currentPrice: number | null | undefined,
  lookbackBars?: number | null,
): PlayerMappingRead {
  const lb = lookbackBars || 20;
  const staircase = staircasePatternReadV1(closes, volumes, lb);
  const spike = speculativeSpikeReadV1(closes, volumes, lb);
  const consolidation = noConsolidationReadV1(highs, lows, lb);
  const roundNumber = roundNumberProximityV1(currentPrice, 0.02);

  const evidence: string[] = [];
  let tag: PlayerTag = 'Mixed/Unclear';
  if (staircase && staircase.isStaircase) {
    tag = 'Institutional-Accumulation-Signature';
    evidence.push(staircase.read);
  } else if (spike && spike.isSpike) {
    tag = 'Speculative-Spike';
    evidence.push(spike.read);
  }
  if (consolidation) evidence.push(consolidation.read);
  if (roundNumber && roundNumber.isNearRoundNumber) evidence.push(roundNumber.read);

  return { tag, evidence };
}
