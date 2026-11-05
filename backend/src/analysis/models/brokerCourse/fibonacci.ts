/**
 * Broker Course Phase 3 -- Fibonacci + flag scoring (:490-607, 5 functions
 * + 2 constant tables).
 *
 * The ratios themselves are standard and the source says so plainly -- the
 * course defers to them. Its own content is WHEN and HOW: anchoring off a
 * real swing high/low with S/R confluence rather than an arbitrary
 * lookback, and the explicit ">50% retraced = trend likely broken" rule.
 *
 * P7 depends on riskRewardV1 from this file, which is why Phase 3 is in
 * the first checkpoint despite its number.
 */

/** Standard retracement ratios. 0 and 1.0 are included as the anchors. */
export const FIB_RETRACEMENT_RATIOS: readonly number[] = [0, 0.382, 0.5, 0.618, 1.0];
/** Standard extension ratios, used only for a new-ATH breakout target. */
export const FIB_EXTENSION_RATIOS: readonly number[] = [1.272, 1.618];

export type FibDirection = 'up' | 'down';

/**
 * Price at each retracement ratio.
 *
 * Keys are the RATIO values, which become string keys ('0', '0.382', ...)
 * on the returned object -- not labels like '38.2%'. Callers index by the
 * number and JS coerces.
 *
 * `direction: 'up'` means retracing DOWN from a swing high (so levels
 * descend from the high); 'down' is the mirror. Returns null when the high
 * is not strictly above the low, which also rules out a zero range.
 */
export function fibonacciLevelsV1(
  swingHigh: number | null | undefined,
  swingLow: number | null | undefined,
  direction: FibDirection | string,
): Record<string, number> | null {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  const levels: Record<string, number> = {};
  FIB_RETRACEMENT_RATIOS.forEach((r) => {
    levels[r] = direction === 'up' ? swingHigh - r * range : swingLow + r * range;
  });
  return levels;
}

export interface FibRetracementRead {
  readonly levels: Record<string, number>;
  readonly retracedFraction: number;
  readonly trendIntact: boolean;
  readonly read: string;
  readonly nearestFibLevel: number | null;
}

/**
 * Where price sits in the retracement, plus the course's trend-validity
 * verdict.
 *
 * The 50% threshold is the course's own stated number: retrace half or
 * less and the trend is intact, more and it is likely broken. `<=` means
 * exactly 50% counts as intact.
 *
 * `retracedFraction` is NOT clamped -- price beyond the swing extreme
 * yields a value above 1 or below 0, which is honest (the move has fully
 * reversed) rather than capped into looking like a normal retracement.
 *
 * `nearestFibLevel` is the ratio NUMBER, not the string key, and ties go
 * to the first in array order because the scan uses a strict `<`.
 */
export function fibonacciRetracementReadV1(
  currentPrice: number | null | undefined,
  swingHigh: number | null | undefined,
  swingLow: number | null | undefined,
  direction: FibDirection | string,
): FibRetracementRead | null {
  const levels = fibonacciLevelsV1(swingHigh, swingLow, direction);
  if (!levels || currentPrice == null) return null;
  const high = swingHigh as number;
  const low = swingLow as number;
  const range = high - low;
  const retracedFraction = direction === 'up'
    ? (high - currentPrice) / range
    : (currentPrice - low) / range;
  const trendIntact = retracedFraction <= 0.5;

  let nearestLevel: number | null = null;
  let nearestDist = Infinity;
  FIB_RETRACEMENT_RATIOS.forEach((r) => {
    const d = Math.abs(currentPrice - levels[r]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestLevel = r;
    }
  });

  return {
    levels, retracedFraction, trendIntact,
    read: trendIntact
      ? 'Retracement is within the trend-validity zone (<=50% of the prior move) — trend likely intact'
      : 'Retracement exceeds 50% of the prior move — trend likely broken, reassess (ep.5\'s own stated threshold)',
    nearestFibLevel: nearestLevel,
  };
}

/**
 * Extension targets, both measured UP from the swing low.
 *
 * Note both ratios anchor on `swingLow` regardless of direction -- there is
 * no direction parameter, because the course's stated application is
 * specifically a new-ATH breakout where there is no prior resistance to
 * reference. Using this on a downtrend would give meaningless targets.
 */
export function fibonacciExtensionTargetsV1(
  swingHigh: number | null | undefined, swingLow: number | null | undefined,
): Record<string, number> | null {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  const targets: Record<string, number> = {};
  FIB_EXTENSION_RATIOS.forEach((r) => {
    targets[r] = swingLow + r * range;
  });
  return targets;
}

export type FlagTier = 'Strong' | 'Moderate' | 'Weak' | 'Marginal' | 'Invalid' | 'Insufficient data';

export interface FlagQuality {
  readonly tier: FlagTier;
  readonly reason: string;
  readonly tightConsolidation?: boolean;
  readonly longConsolidation?: boolean;
  readonly strongPriorMove?: boolean;
}

/** Consolidation range must be <= half the pole move. Ratio, not absolute. */
const FP_CONSOL_MAX_RANGE_RATIO = 0.5;

/**
 * Flag/pennant quality as a qualitative tier, never a fabricated score.
 *
 * ══ VOLUME IS A HARD GATE, CHECKED FIRST ═══════════════════════════════
 * Breakout relative volume below 1.5x returns 'Invalid' immediately -- the
 * course's own minimum for a valid signal. That check runs BEFORE the
 * missing-input check, so a setup with no volume data AND no other inputs
 * reads 'Invalid' rather than 'Insufficient data'.
 *
 * ══ THE TIGHTNESS TEST IS RELATIVE, AND THAT WAS A REAL FIX ════════════
 * The original used a fixed `consolidationRangePct <= 0.15`, independent
 * of how big the pole was. The source records re-checking the transcript
 * and finding the rule is explicitly COMPARATIVE -- "the tighter my
 * consolidation, the stronger the prior move" -- so it became a ratio
 * against the pole, matching the main engine's own convention. A 10%
 * consolidation after a 15% move now correctly fails where it used to pass.
 *
 * Tier is simply how many of three independent checks hold, because the
 * course gives directional rules and no weighting. Note 0/3 is 'Marginal',
 * not 'Invalid' -- a valid-volume setup is never called invalid on quality.
 */
export function flagPatternQualityV1(
  priorMovePct: number | null | undefined,
  consolidationRangePct: number | null | undefined,
  consolidationBars: number | null | undefined,
  breakoutRelVol: number | null | undefined,
): FlagQuality {
  if (breakoutRelVol == null || breakoutRelVol < 1.5) {
    return {
      tier: 'Invalid',
      reason: 'Breakout volume below 1.5x average — course\'s own minimum for a valid signal (ep.3/5)',
    };
  }
  if (priorMovePct == null || consolidationRangePct == null || consolidationBars == null) {
    return { tier: 'Insufficient data', reason: 'Missing one or more required inputs' };
  }
  const tightConsolidation = priorMovePct > 0
    && consolidationRangePct / priorMovePct <= FP_CONSOL_MAX_RANGE_RATIO;
  const longConsolidation = consolidationBars >= 10; // ~2 trading weeks
  const strongPriorMove = priorMovePct >= 0.20;

  const hits = [tightConsolidation, longConsolidation, strongPriorMove].filter(Boolean).length;
  const tier: FlagTier = hits === 3 ? 'Strong' : hits === 2 ? 'Moderate' : hits === 1 ? 'Weak' : 'Marginal';
  return {
    tier, tightConsolidation, longConsolidation, strongPriorMove,
    reason: hits + '/3 quality factors met (tight consolidation, long consolidation, strong prior move)',
  };
}

export interface RiskReward {
  readonly risk: number;
  readonly reward: number;
  readonly ratio: number;
  readonly meetsMinimum: boolean;
  readonly read: string;
}

/**
 * Risk:reward against the course's 1:1 floor.
 *
 * Both legs use Math.abs, so this does not care which side of entry the
 * stop and target sit on -- a "target" below entry still yields a positive
 * ratio. The caller is responsible for passing a coherent long setup.
 *
 * Returns null on zero risk rather than Infinity.
 *
 * Note the read string formats as '1:' + ratio, so a sub-1 ratio prints as
 * e.g. "1:0.60" -- unconventional, but it is what the report shows.
 */
export function riskRewardV1(
  entryPrice: number | null | undefined,
  stopPrice: number | null | undefined,
  targetPrice: number | null | undefined,
): RiskReward | null {
  if ([entryPrice, stopPrice, targetPrice].some((v) => v == null || isNaN(v as number))) return null;
  const entry = entryPrice as number;
  const risk = Math.abs(entry - (stopPrice as number));
  const reward = Math.abs((targetPrice as number) - entry);
  if (risk === 0) return null;
  const ratio = reward / risk;
  return {
    risk, reward, ratio,
    meetsMinimum: ratio >= 1.0,
    read: ratio >= 1.0
      ? 'R:R = 1:' + ratio.toFixed(2) + ' — meets the course\'s stated minimum'
      : 'R:R = 1:' + ratio.toFixed(2) + ' — below the 1:1 minimum, course says skip the trade',
  };
}
