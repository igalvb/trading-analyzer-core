/**
 * Broker Course Phase 2 -- charts/technicals core (:254-480, 9 functions).
 *
 * One of the two foundations the rest of the file depends on: P4, P5 and
 * P14 all call findSwingPoints or findSupportResistance, and P11 calls
 * seven of these nine directly.
 *
 * ══ WHERE THE COURSE'S OWN CONTENT ACTUALLY IS ═════════════════════════
 * The source is careful about this and it is worth preserving. The candle
 * GEOMETRY thresholds here are standard textbook Japanese-candlestick
 * conventions -- the course explicitly defers to an external reference for
 * the shapes. The course's own original material is the CONTEXT-DEPENDENT
 * READING of what a shape means given the preceding trend, which lives in
 * candleContextRead. So a reviewer asking "is this number from the course
 * or from convention?" gets a straight answer per function.
 */

/** Everything in Phase 2 is pure arithmetic over OHLC arrays. */
export interface CandleGeometry {
  readonly range: number;
  readonly body: number;
  readonly upperWick: number;
  readonly lowerWick: number;
  readonly isGreen: boolean;
}

/**
 * Body/wick/range decomposition. No course-specific numbers.
 *
 * `isGreen` uses `close >= open`, so a doji with identical open and close
 * counts as green. That matters only for the Marubozu label, which a doji
 * can never reach.
 */
export function candleGeometryV1(
  open: number | null, high: number | null, low: number | null, close: number | null,
): CandleGeometry | null {
  if ([open, high, low, close].some((v) => v == null || isNaN(v as number))) return null;
  const o = open as number;
  const h = high as number;
  const l = low as number;
  const c = close as number;
  return {
    range: h - l,
    body: Math.abs(c - o),
    upperWick: h - Math.max(o, c),
    lowerWick: Math.min(o, c) - l,
    isGreen: c >= o,
  };
}

/**
 * Candle-type classification by shape.
 *
 * ══ THE THRESHOLDS ARE CONVENTION, NOT COURSE NUMBERS ══════════════════
 *   Doji            body <= 5% of range   (operationalising "open and
 *                                          close essentially identical" on
 *                                          data that is never exactly equal)
 *   Full/Marubozu   body >= 90% of range
 *   Hammer          lower wick >= 2x body, upper wick <= body, body in the
 *                   upper half of the range
 *   Inverted hammer mirror of hammer
 *
 * Order matters: doji is tested first, then Marubozu, then the hammers.
 * A zero-range bar returns null rather than dividing by zero.
 *
 * Note the two half-range tests are NOT complements -- `bodyMidInUpperHalf`
 * is `(bodyBottom - low) > (high - bodyTop)` and the lower-half test is the
 * strict reverse. A body dead-centre satisfies neither, so a perfectly
 * symmetric candle falls through to 'Standard'. Reproduced as written.
 */
export function classifyCandleV1(
  open: number | null, high: number | null, low: number | null, close: number | null,
): string | null {
  const g = candleGeometryV1(open, high, low, close);
  if (!g || g.range === 0) return null;
  const bodyPct = g.body / g.range;

  if (bodyPct <= 0.05) return 'Doji';
  if (bodyPct >= 0.90) return g.isGreen ? 'Full Green (Marubozu)' : 'Full Red (Marubozu)';

  const o = open as number;
  const c = close as number;
  const h = high as number;
  const l = low as number;
  const bodyTop = Math.max(o, c);
  const bodyBottom = Math.min(o, c);
  const bodyMidInUpperHalf = bodyBottom - l > h - bodyTop;

  if (g.lowerWick >= 2 * g.body && g.upperWick <= g.body && bodyMidInUpperHalf) {
    return g.isGreen ? 'Hammer (green)' : 'Hammer (red)';
  }
  const bodyMidInLowerHalf = h - bodyTop > bodyBottom - l;
  if (g.upperWick >= 2 * g.body && g.lowerWick <= g.body && bodyMidInLowerHalf) {
    return g.isGreen ? 'Inverted Hammer (green)' : 'Inverted Hammer (red)';
  }
  return 'Standard';
}

export type PrecedingTrend = 'up' | 'down' | 'flat';

export interface CandleContextRead {
  readonly read: string;
  /** null when no relative volume was supplied -- "unknown", not "unconfirmed". */
  readonly volumeConfirmed: boolean | null;
}

/**
 * The course's own content: what a shape MEANS given the preceding trend.
 *
 * ══ COLOUR DOES NOT MATTER FOR A HAMMER ════════════════════════════════
 * The course is explicit that a hammer is bullish after a downtrend
 * regardless of whether the candle is green or red -- the shape carries
 * the signal, not the colour. Both 'Hammer (green)' and 'Hammer (red)'
 * therefore take the same branch.
 *
 * Volume confirmation is a SEPARATE required cross-check, never folded
 * into the read itself: the course's rule is that a candle is never read
 * alone. `volumeConfirmed` is deliberately three-state -- null means no
 * volume was supplied, which is different from 1.4x relative volume
 * failing the 1.5x bar.
 *
 * The 'Standard' path returns early with a null `volumeConfirmed`, so an
 * unremarkable candle never gets a volume verdict appended.
 */
export function candleContextReadV1(
  candleType: string | null | undefined,
  precedingTrend: PrecedingTrend | string | null | undefined,
  relativeVolume?: number | null,
): CandleContextRead | null {
  if (!candleType) return null;
  let read: string | null = null;

  if (candleType.indexOf('Full Green') === 0) {
    read = precedingTrend === 'up'
      ? 'Confirms upward momentum — expect continuation'
      : 'Strong buying, but against the recent trend — worth attention';
  } else if (candleType.indexOf('Full Red') === 0) {
    read = precedingTrend === 'down'
      ? 'Confirms downward momentum — expect continuation'
      : 'Strong selling, but against the recent trend — worth attention';
  } else if (candleType === 'Doji') {
    read = precedingTrend === 'up' || precedingTrend === 'down'
      ? 'Indecision after a trend — possible reversal/exhaustion warning'
      : 'Indecision, no strong signal in a flat market';
  } else if (candleType.indexOf('Hammer') === 0 && candleType.indexOf('Inverted') !== 0) {
    // The second clause is redundant -- 'Inverted Hammer (...)' has
    // indexOf('Hammer') === 9, so it never reaches here. Kept because
    // removing it would be a behaviour-neutral edit to ported logic.
    read = precedingTrend === 'down'
      ? 'Bullish reversal signal (hammer after a downtrend)'
      : 'Hammer shape present, but not after a downtrend — lower-confidence read';
  } else if (candleType.indexOf('Inverted Hammer') === 0) {
    read = precedingTrend === 'down'
      ? 'Bullish reversal signal (inverted hammer after a downtrend)'
      : 'Inverted-hammer shape present, but not after a downtrend — lower-confidence read';
  } else {
    return { read: 'No distinctive shape', volumeConfirmed: null };
  }

  const volumeConfirmed = relativeVolume == null ? null : relativeVolume >= 1.5;
  if (volumeConfirmed === false) {
    read += ' (not volume-confirmed — treat with caution, ep.3/6\'s own rule)';
  }
  if (volumeConfirmed === true) read += ' (volume-confirmed)';
  return { read, volumeConfirmed };
}

export interface SwingPoint {
  readonly idx: number;
  readonly price: number;
}

export interface SwingPoints {
  readonly swingHighs: readonly SwingPoint[];
  readonly swingLows: readonly SwingPoint[];
}

/**
 * Swing points over a centred window, default 5 bars each side.
 *
 * Deliberately a SECOND, independent implementation rather than a reuse of
 * the engine's own swing detection -- this model is meant to be a separate
 * opinion, and sharing the primitive would couple them.
 *
 * Non-strict `===` against the window max/min, same as every other swing
 * detector in this codebase: on a plateau every interior bar qualifies as
 * both a swing high and a swing low. A null bar poisons Math.max to NaN
 * and silently yields no swing there.
 */
export function findSwingPointsV1(
  highs: readonly number[], lows: readonly number[], window?: number | null,
): SwingPoints {
  const w = window || 5;
  const swingHighs: SwingPoint[] = [];
  const swingLows: SwingPoint[] = [];
  const n = highs.length;
  for (let i = w; i < n - w; i++) {
    const hSlice = highs.slice(i - w, i + w + 1) as number[];
    const lSlice = lows.slice(i - w, i + w + 1) as number[];
    if (highs[i] === Math.max.apply(null, hSlice)) swingHighs.push({ idx: i, price: highs[i] });
    if (lows[i] === Math.min.apply(null, lSlice)) swingLows.push({ idx: i, price: lows[i] });
  }
  return { swingHighs, swingLows };
}

export type SrTier = 'Primary' | 'Secondary' | 'Minor';

export interface SrLevel {
  readonly level: number;
  readonly touchCount: number;
  /** Span in BAR INDICES between first and last touch, not calendar days. */
  readonly duration: number;
  readonly tier: SrTier;
  /** null unless a trendDirection was passed. See F-21. */
  readonly trendFavored: boolean | null;
  readonly lastTouchIdx: number;
}

export interface SupportResistance {
  readonly resistanceLevels: readonly SrLevel[];
  readonly supportLevels: readonly SrLevel[];
}

/**
 * Clusters swing points into S/R levels and tiers them by touch count and
 * duration.
 *
 * ══ THE TIERS ARE THE COURSE'S WORDS, THE CUTOFFS ARE NOT ══════════════
 * Primary/Secondary/Minor is spoken course terminology. The specific
 * cutoffs (>=4 touches AND >=60 bars for Primary; >=3 touches OR >=30 bars
 * for Secondary) are disclosed operationalisations -- the course states the
 * directional rule "more touches plus longer duration equals stronger" and
 * gives no formula. Note Primary needs BOTH conditions while Secondary
 * needs EITHER, so a level with 10 touches over 20 bars is Secondary.
 *
 * The 2-touch minimum is likewise a disclosed default: the source records
 * re-checking the transcript and finding the instructor counts touches
 * aloud but never states a required minimum.
 *
 * ══ CLUSTERING IS ORDER-DEPENDENT ══════════════════════════════════════
 * Points are sorted by price, then each joins the FIRST cluster within
 * tolerance of that cluster's running average -- and the average shifts as
 * members join. So the result depends on sort order, and a long chain of
 * prices each within 3% of the previous can merge into one wide cluster.
 * Reproduced exactly; a different clustering strategy would silently move
 * every level.
 *
 * ══ FLAGGED (F-21): `lastIdx` IS DEAD BUT POSITIONALLY LOAD-BEARING ════
 * Measured: 0 uses in the body. Unlike F-17/F-19 -- trailing dead params
 * that could simply be dropped -- this one sits BEFORE `trendDirection`,
 * and all three legacy call sites (:933, :1114, :1997) pass it. So it must
 * be kept to preserve the positional contract, and is named with a leading
 * underscore to say so.
 *
 * ══ FLAGGED (F-22): `trendFavored` NEVER FIRES IN PRODUCTION ═══════════
 * `trendDirection` is tested with `=== undefined`, and NO legacy call site
 * passes a 5th argument -- verified across all ten files. So `trendFavored`
 * is `null` on every real level the system has ever produced. The feature
 * was added with a long comment quoting the course verbatim on why support
 * matters more in an uptrend, and then never wired up. Reproduced, not
 * fixed.
 *
 * Note also that passing `null` explicitly is NOT the same as omitting:
 * `null === undefined` is false, so an explicit null yields `false` for
 * support and `false` for resistance rather than `null`.
 */
export function findSupportResistanceV1(
  highs: readonly number[],
  lows: readonly number[],
  tolerance?: number | null,
  _lastIdx?: number | null,
  trendDirection?: 'up' | 'down' | 'flat' | null,
): SupportResistance {
  const tol = tolerance || 0.03;
  const { swingHighs, swingLows } = findSwingPointsV1(highs, lows, 5);

  function clusterLevels(points: readonly SwingPoint[], isSupport: boolean): SrLevel[] {
    const sorted = points.slice().sort((a, b) => a.price - b.price);
    const clusters: Array<{ avgPrice: number; touches: SwingPoint[] }> = [];
    for (const p of sorted) {
      let placed = false;
      for (const c of clusters) {
        if (Math.abs(p.price - c.avgPrice) / c.avgPrice <= tol) {
          c.touches.push(p);
          c.avgPrice = c.touches.reduce((s, t) => s + t.price, 0) / c.touches.length;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ avgPrice: p.price, touches: [p] });
    }
    return clusters
      .filter((c) => c.touches.length >= 2)
      .map((c) => {
        const idxs = c.touches.map((t) => t.idx);
        const duration = Math.max.apply(null, idxs) - Math.min.apply(null, idxs);
        const touchCount = c.touches.length;
        let tier: SrTier;
        if (touchCount >= 4 && duration >= 60) tier = 'Primary';
        else if (touchCount >= 3 || duration >= 30) tier = 'Secondary';
        else tier = 'Minor';
        const trendFavored = trendDirection === undefined
          ? null
          : isSupport ? trendDirection === 'up' : trendDirection === 'down';
        return {
          level: c.avgPrice, touchCount, duration, tier, trendFavored,
          lastTouchIdx: Math.max.apply(null, idxs),
        };
      })
      .sort((a, b) => b.touchCount - a.touchCount);
  }

  return {
    resistanceLevels: clusterLevels(swingHighs, false),
    supportLevels: clusterLevels(swingLows, true),
  };
}

/**
 * "An all-time-high breakout is not the same as a downtrend breakout."
 *
 * The course's distinct-reliability-class rule. A breakout at a structural
 * high tends to run further because there is no overhead supply and
 * institutional participation is likelier; the same chart shape against a
 * longer-term downtrend is a weaker class of signal.
 */
export function srReliabilityContextV1(
  atHigh: boolean | null | undefined, longTermTrend?: string | null,
): string {
  if (atHigh) {
    return 'At/near a structural high — a breakout here tends to run further (institutional participation more likely, ep.3/4)';
  }
  if (longTermTrend === 'down') {
    return 'Breakout is against a longer-term downtrend — lower reliability class than an ATH breakout (ep.3/4)';
  }
  return 'Neutral reliability context';
}

/**
 * Simple moving average of the LAST `period` closes.
 *
 * Only 50 and 200 are used by this model: the course explicitly rejects
 * the 20 SMA as "too noisy", so there is deliberately no 20-period read
 * anywhere in Phase 2.
 */
export function smaV1(closes: readonly number[] | null | undefined, period: number): number | null {
  if (!closes || closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * The full trailing SMA series, needed for slope and convergence reads.
 *
 * Returns `[]` -- not null -- when there is insufficient history, which is
 * what lets maRelationshipRead's length check handle both cases uniformly.
 */
export function smaSeriesV1(
  closes: readonly number[] | null | undefined, period: number,
): number[] {
  if (!closes || closes.length < period) return [];
  const out: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    out.push(closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

export interface MaRelationshipRead {
  readonly slope50: 'up' | 'down' | 'flat';
  readonly slope200: 'up' | 'down' | 'flat';
  readonly convergence: string;
  readonly cross: string | null;
  readonly sma50: number;
  readonly sma200: number;
}

/**
 * Slope, convergence/divergence and cross detection between the 50 and 200.
 *
 * ══ TWO SUBTLETIES WORTH KNOWING ═══════════════════════════════════════
 * 1. Slope is a ONE-BAR comparison (last vs previous), not a fit. So
 *    'flat' means exactly equal to the prior value, which on real data is
 *    rare -- the slope flips on a single bar of noise.
 * 2. Convergence uses |gap| so it is direction-agnostic: a 50 below the
 *    200 and falling further away reads "diverging (trend strengthening)",
 *    which is correct for a strengthening DOWNtrend. The label does not
 *    mean bullish.
 *
 * Cross detection uses `<=`/`>=` on the previous gap, so a bar that sat
 * exactly at zero and then moved counts as a cross.
 */
export function maRelationshipReadV1(
  sma50Series: readonly number[] | null | undefined,
  sma200Series: readonly number[] | null | undefined,
): MaRelationshipRead | null {
  if (!sma50Series || !sma200Series || sma50Series.length < 2 || sma200Series.length < 2) {
    return null;
  }
  const n50 = sma50Series.length;
  const n200 = sma200Series.length;
  const s50now = sma50Series[n50 - 1];
  const s50prev = sma50Series[n50 - 2];
  const s200now = sma200Series[n200 - 1];
  const s200prev = sma200Series[n200 - 2];

  const slope50 = s50now > s50prev ? 'up' : s50now < s50prev ? 'down' : 'flat';
  const slope200 = s200now > s200prev ? 'up' : s200now < s200prev ? 'down' : 'flat';

  const gapNow = s50now - s200now;
  const gapPrev = s50prev - s200prev;
  const spreading = Math.abs(gapNow) > Math.abs(gapPrev);
  const convergence = spreading
    ? 'diverging (trend strengthening)'
    : 'converging (trend weakening)';

  const crossedUp = gapPrev <= 0 && gapNow > 0;
  const crossedDown = gapPrev >= 0 && gapNow < 0;
  const cross = crossedUp
    ? 'Golden cross (50 crossed above 200) — potential trend change'
    : crossedDown
      ? 'Death cross (50 crossed below 200) — potential trend change'
      : null;

  return { slope50, slope200, convergence, cross, sma50: s50now, sma200: s200now };
}
