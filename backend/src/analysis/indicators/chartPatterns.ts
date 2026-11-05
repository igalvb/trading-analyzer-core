/**
 * chartPatterns -- classical chart-pattern detection.
 *
 * ══ WHY THIS IS NOT A SLICE ════════════════════════════════════════════
 * Every other ported field is an independent slice. chartPatterns cannot be,
 * for two reasons found by reading the legacy structure directly
 * (fullStockAnalysisV10_9.gs:6434-7320, 23 push sites):
 *
 *  1. ALL detectors share ONE try block. A throw in any detector aborts every
 *     LATER detector and leaves the array partially filled. Splitting them
 *     into independently-guarded functions would change that: a failing
 *     detector would no longer suppress its successors, and the output would
 *     diverge from the oracle in precisely the bad-data case where it matters.
 *     So the guard stays shared.
 *
 *  2. The result is an ARRAY, so order is part of the contract. Detectors must
 *     run in the exact legacy sequence.
 *
 * Therefore this is one function whose detectors are internal steps, built up
 * incrementally across passes. Each pass verifies against the oracle's array
 * FILTERED to the pattern types ported so far -- real verification at every
 * step with a correct end state.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * COMPLETE — all 28 observed pattern types ported, PLUS RECTANGLE (29 total).
 *
 * Verified 2026-09-20 with the FULL UNFILTERED array compared against the
 * oracle: 144/144 real charts exact, 927 pattern instances, 28 distinct
 * types, zero failures. The parity test no longer filters by ported type.
 *
 * RECTANGLE (legacy 7117) was observed ZERO times across the real fixture
 * set -- it fired on no real chart -- but was ported anyway because
 * wyckoffSchematic depends on it, and verified on SYNTHETIC flat-range charts
 * instead (test/wyckoff.parity.test.ts). It is therefore not among the 28
 * "observed" types, but is real, ported, and verified.
 *
 * DETECTOR ORDER IS THE CONTRACT. New detectors must be inserted at their
 * LEGACY LINE POSITION, not appended. The full legacy sequence:
 *   DOUBLE_TOP 6480, DOUBLE_BOTTOM 6499, HEAD_AND_SHOULDERS 6530,
 *   INVERSE_HEAD_AND_SHOULDERS 6583, SCALLOP_SERIES 6677, TRIPLE_TOP 6711,
 *   TRIPLE_BOTTOM 6731, [SYMMETRICAL_TRIANGLE/ASCENDING_TRIANGLE/
 *   DESCENDING_TRIANGLE/RISING_WEDGE/FALLING_WEDGE] 6754-6803,
 *   [PENNANT/BULL_FLAG/BEAR_FLAG] ~6831-6869, HALF_MAST 6931,
 *   [BROADENING_TOP/BROADENING_BOTTOM] ~6980, [DIAMOND_TOP/DIAMOND_BOTTOM]
 *   ~7022, COMPLEX_TOP 7053, COMPLEX_BOTTOM 7075, RECTANGLE 7117,
 *   STAIRCASE 7175, ROUNDING_BOTTOM 7218, ROUNDING_TOP 7230,
 *   CUP_AND_HANDLE 7257, BULL_TRAP 7301, BEAR_TRAP 7313.
 */

import type { Chart } from '../../types/chart.ts';

export type PatternInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'volumes' | 'dates'>;

// Shared detection constants. LEVEL_TOLERANCE here is local to pattern
// detection and coincidentally equals the module-level one in slices.ts; kept
// separate so tuning one cannot silently affect the other.
const SWING_WINDOW = 5;
const PATTERN_LEVEL_TOLERANCE = 0.03;
const MIN_PULLBACK = 0.05;

/** Head must clear the taller shoulder by this much; shoulders may differ by this much. */
const HS_HEAD_MIN_PCT = 0.03;
const HS_SHOULDER_TOL = 0.05;

/** Trap detection uses its own independent constants, deliberately not shared. */
const TRAP_LOOKBACK = 90;
const TRAP_WINDOW = 3;
const TRAP_MIN_BREAK_PCT = 0.03;

/**
 * Rounding-formation constants. RND_EDGE_FRAC keeps the extreme away from
 * either edge of the window, so a plain one-way trend cannot masquerade as a
 * rounded base or top.
 */
const RND_LOOKBACK = 60;
const RND_EDGE_FRAC = 0.2;
const RND_MIN_DEPTH = 0.08;
const RND_SEGMENTS = 4;
const RND_MAX_SINGLE_BAR_SHARE = 0.35;

/** Cup-and-handle constants. The handle occupies the most recent bars. */
const CUP_LOOKBACK = 50;
const HANDLE_BARS = 10;
const HANDLE_MAX_DEPTH_RATIO = 0.5;
const HANDLE_MIN_DEPTH = 0.02;
const HANDLE_MAX_DEPTH_ABS = 0.15;

/**
 * Triangle / wedge constants.
 *
 * TW_MIN_CONVERGE_RATIO is the heart of the detector: the gap between the two
 * trendlines at the END must be at most 70% of the gap at the START. That is
 * what makes the formation converging rather than parallel or diverging.
 */
const TW_LOOKBACK_BARS = 60;
const TW_FLAT_TOL = 0.02;
const TW_MIN_CONVERGE_RATIO = 0.7;

/**
 * Scallop-series constants. The MIN values are deliberately LOOSER than the
 * book's own typical floors (10% gain / 20% pullback) -- they are structural
 * minimums for detection, with the stricter book range reported separately per
 * leg via `matchesBook`.
 */
const SCALLOP_LOOKBACK = 260; // about one year
const SCALLOP_MIN_GAIN = 0.05;
const SCALLOP_MIN_PULLBACK = 0.15;
const SCALLOP_MIN_DURATION_WEEKS = 3;
const SCALLOP_PRICE_TIER = 20; // informational only; real exceptions exist above it

/** Half-mast constants: a sharp move, then a tight low-volume consolidation. */
const HM_MOVE_BARS = 15;
const HM_MOVE_MIN_PCT = 0.12;
const HM_CONSOL_BARS = 10;
const HM_CONSOL_MAX_RANGE_RATIO = 0.35;
const HM_VOLUME_SHRINK_RATIO = 0.7;
const HM_SCAN_BARS = 20;

/** Staircase constants: overlapping flat shelves, each stepping up from the last. */
const STAIR_WIN = 15;
const STAIR_STEP = 3;
const STAIR_DRIFT_TOL = 0.15;
const STAIR_MIN_STEP_RISE = 0.15;
const STAIR_MIN_STEPS = 3;

/**
 * Flag / pennant constants. FP_PENNANT_NARROW_RATIO is the discriminator: if
 * the consolidation's second half is at most 60% as wide as its first half, it
 * is converging (a pennant) rather than drifting sideways (a flag).
 */
const FP_POLE_BARS = 10;
const FP_POLE_MIN_PCT = 0.08;
const FP_CONSOL_BARS = 10;
const FP_CONSOL_MAX_RANGE_RATIO = 0.5;
const FP_PENNANT_NARROW_RATIO = 0.6;
const FP_FLAG_DRIFT_MAX = 0.02;
const FP_SCAN_BARS = 20;

/** Zigzag point counts: broadening needs 5 alternating pivots, diamond 7. */
const BT_POINTS = 5;
const DM_POINTS = 7;

/**
 * Rectangle constants. RECT_MIN_CONTAINMENT is what separates a real trading
 * range from a trend that happens to have two similar highs: at least 80% of
 * the window's closes must sit inside the band.
 */
const RECT_LOOKBACK = 60;
const RECT_LEVEL_TOL = 0.015;
const RECT_MIN_RANGE = 0.04;
const RECT_MIN_CONTAINMENT = 0.8;

/**
 * Only swings within this many bars of the present count.
 *
 * Not arbitrary: running all patterns against 13 real tickers with 10 years of
 * history each produced 1,045 instances, of which 957 were stale -- decade-old
 * swing pairs that never broke their neckline still reporting as "forming"
 * today. 120 bars is about six months: generous enough for a real multi-month
 * double top, short enough to exclude that noise.
 */
const RECENCY_WINDOW = 120;

export interface SwingPoint {
  idx: number;
  price: number;
}

export interface Swings {
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
}

/**
 * Pivot detection shared by every pattern detector.
 *
 * Comparisons are NON-strict, so a tie registers as a swing -- the opposite of
 * detectDivergence, which uses strict comparisons so a tie disqualifies the
 * pivot. That inconsistency between the two algorithms is real and reproduced.
 */
export function detectSwings(
  highs: readonly number[],
  lows: readonly number[],
  n: number,
  window: number = SWING_WINDOW,
): Swings {
  const swingHighs: SwingPoint[] = [];
  const swingLows: SwingPoint[] = [];
  for (let i = window; i < n - window; i++) {
    const hSlice = highs.slice(i - window, i + window + 1);
    const lSlice = lows.slice(i - window, i + window + 1);
    if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] as number });
    if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] as number });
  }
  return { swingHighs, swingLows };
}

export interface AsymmetricVolumeRead {
  volumeConfirmationNeeded: boolean;
  confirmed: boolean;
  suspiciouslyHeavy: boolean;
  note: string;
}

/**
 * Volume confirmation, deliberately ASYMMETRIC by direction.
 *
 * An upside breakout needs real volume to be trusted. A downside break does
 * not -- and conspicuously heavy volume on a downside break is treated as
 * SUSPICIOUS rather than confirming, because it is often a two-to-three-day
 * shakeout that reverses.
 *
 * Note the consequence: for direction 'down', `confirmed` is always true and
 * the signal lives in `suspiciouslyHeavy`. That asymmetry is the point, not an
 * oversight.
 */
export function asymmetricVolumeConfirmation(
  direction: 'up' | 'down',
  breakoutVol: number | null,
  avgVol: number,
): AsymmetricVolumeRead | null {
  if (breakoutVol == null || !(avgVol > 0)) return null;
  const ELEVATED_MULT = 1.3;
  const elevated = breakoutVol > ELEVATED_MULT * avgVol;

  if (direction === 'up') {
    return {
      volumeConfirmationNeeded: true,
      confirmed: elevated,
      suspiciouslyHeavy: false,
      note: 'Real, repeated book rule: an upside breakout needs real volume confirmation to be trusted ("it takes buying to put them up").',
    };
  }
  return {
    volumeConfirmationNeeded: false,
    confirmed: true,
    suspiciouslyHeavy: elevated,
    note: elevated
      ? 'Real, disclosed caution: conspicuously heavy volume right at a downside break is itself suspicious -- often a real 2-3-day shakeout that reverses back up, not genuine confirmation.'
      : 'Real, repeated book rule: a downside breakout does NOT need volume confirmation to be trusted ("stocks fall of their own weight").',
  };
}

export interface EmSpacingCheck {
  weeksApart: number;
  magnitudePct: number;
  meetsBook: boolean;
}

export interface SwingRef {
  date: Date;
  price: number;
}

export interface ScallopLeg {
  fromDate: Date;
  fromPrice: number;
  toDate: Date;
  toPrice: number;
  peakDate: Date;
  peakPrice: number;
  weeksApart: number;
  gainPct: number;
  pullbackPct: number;
  /** True only within the book's stricter typical ranges -- see the note below. */
  matchesBook: boolean;
}

export interface ZigzagPoint {
  date: Date;
  price: number;
  kind: 'H' | 'L';
}

export interface ChartPattern {
  type: string;
  date1?: Date;
  date2?: Date;
  level?: number;
  neckline?: number;
  necklineAtLast?: number;
  confirmed?: boolean;
  measuredTarget?: number;
  necklineSlope?: 'flat' | 'ascending' | 'descending';
  volumeShapeValid?: boolean;
  leftShoulder?: SwingRef;
  head?: SwingRef;
  rightShoulder?: SwingRef;
  peak1?: SwingRef;
  peak2?: SwingRef;
  peak3?: SwingRef;
  trough1?: SwingRef;
  trough2?: SwingRef;
  trough3?: SwingRef;
  breakoutDate?: Date;
  breakdownDate?: Date;
  failDate?: Date;
  reclaimDate?: Date;
  status?: 'CONFIRMED' | 'WATCHING' | 'FORMING' | 'BROKE_UP' | 'BROKE_DOWN';
  rim?: number;
  shoulder1?: SwingRef;
  shoulder2?: SwingRef;
  head1?: SwingRef;
  head2?: SwingRef;
  resistanceP1?: SwingRef;
  resistanceP2?: SwingRef;
  supportP1?: SwingRef;
  supportP2?: SwingRef;
  resistanceAtLast?: number;
  supportAtLast?: number;
  volumeConfirmationExpected?: boolean;
  breakoutVolumeElevated?: boolean | null;
  legs?: ScallopLeg[];
  legCount?: number;
  priceTierMatch?: boolean;
  moveDir?: 'UP' | 'DOWN';
  movePct?: number;
  moveStartDate?: Date;
  moveEndDate?: Date;
  consolHigh?: number;
  consolLow?: number;
  steps?: number;
  baseLevel?: number;
  lastStepLevel?: number;
  poleDir?: 'UP' | 'DOWN';
  polePct?: number;
  poleStartDate?: Date;
  poleEndDate?: Date;
  points?: ZigzagPoint[];
  resistance?: number;
  support?: number;
  resistanceLevel?: number;
  supportLevel?: number;
  emSpacingCheck?: EmSpacingCheck;
  asymmetricVolumeRead?: AsymmetricVolumeRead | null;
  [key: string]: unknown;
}

/**
 * Detects chart patterns. Detectors run in legacy order inside one guard.
 *
 * `onAbort` exists because the legacy catch swallows the error and returns a
 * partially-filled array, which renders as "no patterns detected" -- visually
 * indistinguishable from a genuinely patternless chart. The legacy code added
 * a Logger.log for exactly this reason. Since the swallow is part of the
 * contract (the partial array IS the result), the return value is unchanged
 * and the callback simply makes the abort visible. Wire it to the project
 * logger at WARNING level when calling this from the real pipeline.
 *
 * INCOMPLETE -- 8 of 28 pattern types. See the header for the remaining list.
 */
export function computeChartPatterns(c: PatternInput, onAbort?: (message: string) => void): ChartPattern[] {
  const { closes, highs, lows, volumes, dates } = c;
  const n = closes.length;
  const chartPatterns: ChartPattern[] = [];

  // ONE shared try, deliberately. See the header note.
  try {
    const { swingHighs, swingLows } = detectSwings(highs, lows, n);

    /**
     * Prior-20-bar average volume, EXCLUDING today.
     * The Math.max/Math.min guards make it safe on short history, and the
     * divisor is min(20, n-1) rather than a hardcoded 20 -- notably unlike
     * several other sites in the legacy engine (flagged findings F-01, F-02,
     * F-04), so this one is correct on short input.
     */
    const avgVolPrior = (): number =>
      volumes.slice(Math.max(0, n - 21), n - 1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, n - 1));

    // ── DOUBLE_TOP ────────────────────────────────────────────────────
    for (let i = 0; i < swingHighs.length - 1; i++) {
      const h1 = swingHighs[i] as SwingPoint;
      const h2 = swingHighs[i + 1] as SwingPoint;
      if (h2.idx < n - RECENCY_WINDOW) continue; // stale
      if (Math.abs(h2.price - h1.price) / h1.price > PATTERN_LEVEL_TOLERANCE) continue;

      const between = swingLows.filter((l) => l.idx > h1.idx && l.idx < h2.idx);
      if (!between.length) continue;
      const neck = between.reduce((min, l) => (l.price < min.price ? l : min));
      const pullbackPct = (h1.price - neck.price) / h1.price;
      if (pullbackPct < MIN_PULLBACK) continue;

      // A stricter, SEPARATE book-quality bar (6+ weeks apart, 15%+ intervening
      // move) reported ALONGSIDE the pattern -- never substituted for the
      // 5%/3% detection thresholds above, which stay untouched.
      const weeksApartTop = ((dates[h2.idx] as Date).getTime() - (dates[h1.idx] as Date).getTime()) / (7 * 86400000);
      const emSpacingCheck: EmSpacingCheck = {
        weeksApart: +weeksApartTop.toFixed(1),
        magnitudePct: +(pullbackPct * 100).toFixed(1),
        meetsBook: weeksApartTop >= 6 && pullbackPct >= 0.15,
      };

      // A Double Top is always a DOWN break when confirmed.
      const dtConfirmed = (closes[n - 1] as number) < neck.price;
      const dtAsymVol = dtConfirmed
        ? asymmetricVolumeConfirmation('down', volumes[n - 1] as number, avgVolPrior())
        : null;

      chartPatterns.push({
        type: 'DOUBLE_TOP',
        date1: dates[h1.idx] as Date,
        date2: dates[h2.idx] as Date,
        level: (h1.price + h2.price) / 2,
        neckline: neck.price,
        confirmed: dtConfirmed,
        emSpacingCheck,
        asymmetricVolumeRead: dtAsymVol,
      });
    }

    // ── DOUBLE_BOTTOM ─────────────────────────────────────────────────
    for (let i = 0; i < swingLows.length - 1; i++) {
      const l1 = swingLows[i] as SwingPoint;
      const l2 = swingLows[i + 1] as SwingPoint;
      if (l2.idx < n - RECENCY_WINDOW) continue;
      if (Math.abs(l2.price - l1.price) / l1.price > PATTERN_LEVEL_TOLERANCE) continue;

      const between = swingHighs.filter((h) => h.idx > l1.idx && h.idx < l2.idx);
      if (!between.length) continue;
      const neck = between.reduce((max, h) => (h.price > max.price ? h : max));
      const bouncePct = (neck.price - l1.price) / l1.price;
      if (bouncePct < MIN_PULLBACK) continue;

      const weeksApartBot = ((dates[l2.idx] as Date).getTime() - (dates[l1.idx] as Date).getTime()) / (7 * 86400000);
      const emSpacingCheckBot: EmSpacingCheck = {
        weeksApart: +weeksApartBot.toFixed(1),
        magnitudePct: +(bouncePct * 100).toFixed(1),
        meetsBook: weeksApartBot >= 6 && bouncePct >= 0.15,
      };

      // A Double Bottom is always an UP break when confirmed, so it DOES need
      // real volume confirmation -- see asymmetricVolumeConfirmation.
      const dbConfirmed = (closes[n - 1] as number) > neck.price;
      const dbAsymVol = dbConfirmed
        ? asymmetricVolumeConfirmation('up', volumes[n - 1] as number, avgVolPrior())
        : null;

      chartPatterns.push({
        type: 'DOUBLE_BOTTOM',
        date1: dates[l1.idx] as Date,
        date2: dates[l2.idx] as Date,
        level: (l1.price + l2.price) / 2,
        neckline: neck.price,
        confirmed: dbConfirmed,
        emSpacingCheck: emSpacingCheckBot,
        asymmetricVolumeRead: dbAsymVol,
      });
    }

    /**
     * Neckline is a LINE through the two troughs, extrapolated to the last
     * bar -- not a flat level. That is why confirmation compares against
     * necklineAt(n-1) rather than a fixed price: a sloping neckline moves.
     */
    const necklineAt = (p1: SwingPoint, p2: SwingPoint, idx: number): number => {
      const m = (p2.price - p1.price) / (p2.idx - p1.idx);
      return p1.price + m * (idx - p1.idx);
    };

    // ── HEAD_AND_SHOULDERS ────────────────────────────────────────────
    for (let i = 0; i < swingHighs.length - 2; i++) {
      const h1 = swingHighs[i] as SwingPoint;
      const h2 = swingHighs[i + 1] as SwingPoint;
      const h3 = swingHighs[i + 2] as SwingPoint;
      if (h3.idx < n - RECENCY_WINDOW) continue; // stale
      // Minimum spacing, so three adjacent noise pivots cannot form a pattern.
      if (h2.idx - h1.idx < SWING_WINDOW || h3.idx - h2.idx < SWING_WINDOW) continue;
      const higherShoulder = Math.max(h1.price, h3.price);
      if (h2.price < higherShoulder * (1 + HS_HEAD_MIN_PCT)) continue; // head not tall enough
      if (Math.abs(h1.price - h3.price) / h1.price > HS_SHOULDER_TOL) continue; // shoulders mismatched

      const leftTroughs = swingLows.filter((l) => l.idx > h1.idx && l.idx < h2.idx);
      const rightTroughs = swingLows.filter((l) => l.idx > h2.idx && l.idx < h3.idx);
      if (!leftTroughs.length || !rightTroughs.length) continue;
      const leftTrough = leftTroughs.reduce((min, l) => (l.price < min.price ? l : min));
      const rightTrough = rightTroughs.reduce((min, l) => (l.price < min.price ? l : min));
      const necklineLast = necklineAt(leftTrough, rightTrough, n - 1);

      chartPatterns.push({
        type: 'HEAD_AND_SHOULDERS',
        leftShoulder: { date: dates[h1.idx] as Date, price: h1.price },
        head: { date: dates[h2.idx] as Date, price: h2.price },
        rightShoulder: { date: dates[h3.idx] as Date, price: h3.price },
        necklineAtLast: necklineLast,
        confirmed: (closes[n - 1] as number) < necklineLast,
        // Classic measured move: project the head-to-neckline distance down.
        measuredTarget: necklineLast - (h2.price - necklineLast),
        necklineSlope:
          Math.abs(rightTrough.price - leftTrough.price) / leftTrough.price < 0.01
            ? 'flat'
            : rightTrough.price > leftTrough.price
              ? 'ascending'
              : 'descending',
        // Textbook shape: volume on the head at least matches both shoulders.
        volumeShapeValid:
          (volumes[h2.idx] as number) >= (volumes[h1.idx] as number) &&
          (volumes[h2.idx] as number) >= (volumes[h3.idx] as number),
        asymmetricVolumeRead:
          (closes[n - 1] as number) < necklineLast
            ? asymmetricVolumeConfirmation('down', volumes[n - 1] as number, avgVolPrior())
            : null,
      });
    }

    // ── INVERSE_HEAD_AND_SHOULDERS ────────────────────────────────────
    for (let i = 0; i < swingLows.length - 2; i++) {
      const l1 = swingLows[i] as SwingPoint;
      const l2 = swingLows[i + 1] as SwingPoint;
      const l3 = swingLows[i + 2] as SwingPoint;
      if (l3.idx < n - RECENCY_WINDOW) continue;
      if (l2.idx - l1.idx < SWING_WINDOW || l3.idx - l2.idx < SWING_WINDOW) continue;
      const lowerShoulder = Math.min(l1.price, l3.price);
      if (l2.price > lowerShoulder * (1 - HS_HEAD_MIN_PCT)) continue;
      if (Math.abs(l1.price - l3.price) / l1.price > HS_SHOULDER_TOL) continue;

      const leftPeaks = swingHighs.filter((h) => h.idx > l1.idx && h.idx < l2.idx);
      const rightPeaks = swingHighs.filter((h) => h.idx > l2.idx && h.idx < l3.idx);
      if (!leftPeaks.length || !rightPeaks.length) continue;
      const leftPeak = leftPeaks.reduce((max, h) => (h.price > max.price ? h : max));
      const rightPeak = rightPeaks.reduce((max, h) => (h.price > max.price ? h : max));
      const necklineLast = necklineAt(leftPeak, rightPeak, n - 1);

      chartPatterns.push({
        type: 'INVERSE_HEAD_AND_SHOULDERS',
        leftShoulder: { date: dates[l1.idx] as Date, price: l1.price },
        head: { date: dates[l2.idx] as Date, price: l2.price },
        rightShoulder: { date: dates[l3.idx] as Date, price: l3.price },
        necklineAtLast: necklineLast,
        confirmed: (closes[n - 1] as number) > necklineLast,
        measuredTarget: necklineLast + (necklineLast - l2.price),
        necklineSlope:
          Math.abs(rightPeak.price - leftPeak.price) / leftPeak.price < 0.01
            ? 'flat'
            : rightPeak.price > leftPeak.price
              ? 'ascending'
              : 'descending',
        volumeShapeValid:
          (volumes[l2.idx] as number) >= (volumes[l1.idx] as number) &&
          (volumes[l2.idx] as number) >= (volumes[l3.idx] as number),
        // Inverse H&S is an UP break, so it DOES need volume confirmation.
        asymmetricVolumeRead:
          (closes[n - 1] as number) > necklineLast
            ? asymmetricVolumeConfirmation('up', volumes[n - 1] as number, avgVolPrior())
            : null,
      });
    }

    // ── SCALLOP_SERIES (legacy 6677) ──────────────────────────────────
    /**
     * A chain of saucer legs, each bottoming HIGHER than the last -- an
     * uptilted series rather than one shape.
     *
     * Note the deliberate two-tier thresholds. Detection uses loosened
     * structural minimums (5% gain, 15% pullback) while `matchesBook` on each
     * leg reports the book's own stricter typical ranges (10-15% gain, 20-30%
     * pullback, 3-9 weeks). So a leg can be detected without matching the
     * book, and the caller can tell the difference. Collapsing the two would
     * either lose real formations or overstate their quality.
     *
     * Requires at least TWO legs -- a single saucer is not a series.
     *
     * `priceTierMatch` is informational only: the book's typical ceiling is
     * about $20, but it documents real exceptions above that, so this is
     * reported rather than used as a filter.
     */
    {
      const scLowsPool = swingLows.filter((l) => l.idx >= n - SCALLOP_LOOKBACK);
      const scLegs: ScallopLeg[] = [];

      for (let i = 0; i < scLowsPool.length - 1; i++) {
        const l1 = scLowsPool[i] as SwingPoint;
        const l2 = scLowsPool[i + 1] as SwingPoint;
        const gainPct = (l2.price - l1.price) / l1.price;
        // Each saucer must end MEANINGFULLY higher, not merely up a tick.
        if (gainPct < SCALLOP_MIN_GAIN) continue;

        const weeksApart = ((dates[l2.idx] as Date).getTime() - (dates[l1.idx] as Date).getTime()) / (7 * 86400000);
        if (weeksApart < SCALLOP_MIN_DURATION_WEEKS) continue;

        const between = swingHighs.filter((h) => h.idx > l1.idx && h.idx < l2.idx);
        if (!between.length) continue;
        const peak = between.reduce((max, h) => (h.price > max.price ? h : max));
        const pullbackPct = (peak.price - l2.price) / peak.price;
        if (pullbackPct < SCALLOP_MIN_PULLBACK) continue;

        scLegs.push({
          fromDate: dates[l1.idx] as Date,
          fromPrice: l1.price,
          toDate: dates[l2.idx] as Date,
          toPrice: l2.price,
          peakDate: dates[peak.idx] as Date,
          peakPrice: peak.price,
          weeksApart: +weeksApart.toFixed(1),
          gainPct: +(gainPct * 100).toFixed(1),
          pullbackPct: +(pullbackPct * 100).toFixed(1),
          // The book's own typical ranges, with a disclosed margin either side
          // of its 5-7 week "normal" -- reported, never used as a cutoff.
          matchesBook:
            gainPct >= 0.1 && gainPct <= 0.15 && pullbackPct >= 0.2 && pullbackPct <= 0.3 && weeksApart >= 3 && weeksApart <= 9,
        });
      }

      if (scLegs.length >= 2) {
        chartPatterns.push({
          type: 'SCALLOP_SERIES',
          legs: scLegs,
          legCount: scLegs.length,
          priceTierMatch: (closes[n - 1] as number) <= SCALLOP_PRICE_TIER,
          status: (closes[n - 1] as number) > (scLegs[scLegs.length - 1] as ScallopLeg).peakPrice ? 'BROKE_UP' : 'FORMING',
        });
      }
    }

    // ── TRIPLE_TOP ────────────────────────────────────────────────────
    for (let i = 0; i < swingHighs.length - 2; i++) {
      const h1 = swingHighs[i] as SwingPoint;
      const h2 = swingHighs[i + 1] as SwingPoint;
      const h3 = swingHighs[i + 2] as SwingPoint;
      if (h3.idx < n - RECENCY_WINDOW) continue;
      // All three peaks within tolerance of each other -- measured against the
      // LOWEST peak, not the first, so the test is symmetric.
      const maxP = Math.max(h1.price, h2.price, h3.price);
      const minP = Math.min(h1.price, h2.price, h3.price);
      if ((maxP - minP) / minP > PATTERN_LEVEL_TOLERANCE) continue;

      const between1 = swingLows.filter((l) => l.idx > h1.idx && l.idx < h2.idx);
      const between2 = swingLows.filter((l) => l.idx > h2.idx && l.idx < h3.idx);
      if (!between1.length || !between2.length) continue;
      const t1 = between1.reduce((min, l) => (l.price < min.price ? l : min));
      const t2 = between2.reduce((min, l) => (l.price < min.price ? l : min));
      // Neckline is the LOWER of the two troughs — a flat level here, unlike
      // the sloping H&S neckline above.
      const neckline3 = Math.min(t1.price, t2.price);
      const avgPeak = (h1.price + h2.price + h3.price) / 3;
      if ((avgPeak - neckline3) / avgPeak < MIN_PULLBACK) continue;

      chartPatterns.push({
        type: 'TRIPLE_TOP',
        peak1: { date: dates[h1.idx] as Date, price: h1.price },
        peak2: { date: dates[h2.idx] as Date, price: h2.price },
        peak3: { date: dates[h3.idx] as Date, price: h3.price },
        neckline: neckline3,
        confirmed: (closes[n - 1] as number) < neckline3,
      });
    }

    // ── TRIPLE_BOTTOM ─────────────────────────────────────────────────
    for (let i = 0; i < swingLows.length - 2; i++) {
      const l1 = swingLows[i] as SwingPoint;
      const l2 = swingLows[i + 1] as SwingPoint;
      const l3 = swingLows[i + 2] as SwingPoint;
      if (l3.idx < n - RECENCY_WINDOW) continue;
      const maxP = Math.max(l1.price, l2.price, l3.price);
      const minP = Math.min(l1.price, l2.price, l3.price);
      if ((maxP - minP) / minP > PATTERN_LEVEL_TOLERANCE) continue;

      const between1 = swingHighs.filter((h) => h.idx > l1.idx && h.idx < l2.idx);
      const between2 = swingHighs.filter((h) => h.idx > l2.idx && h.idx < l3.idx);
      if (!between1.length || !between2.length) continue;
      const p1 = between1.reduce((max, h) => (h.price > max.price ? h : max));
      const p2 = between2.reduce((max, h) => (h.price > max.price ? h : max));
      const neckline3 = Math.max(p1.price, p2.price);
      const avgTrough = (l1.price + l2.price + l3.price) / 3;
      if ((neckline3 - avgTrough) / avgTrough < MIN_PULLBACK) continue;

      chartPatterns.push({
        type: 'TRIPLE_BOTTOM',
        trough1: { date: dates[l1.idx] as Date, price: l1.price },
        trough2: { date: dates[l2.idx] as Date, price: l2.price },
        trough3: { date: dates[l3.idx] as Date, price: l3.price },
        neckline: neckline3,
        confirmed: (closes[n - 1] as number) > neckline3,
      });
    }

    // ── TRIANGLE / WEDGE group (legacy 6754-6803) ─────────────────────
    /**
     * ONE detector emitting one of FIVE types, chosen by the direction pair of
     * the two trendlines. Structurally unlike everything above: the others each
     * detect a single named shape, while this one classifies.
     *
     * The two trendlines are fitted through the FIRST and LAST swing in the
     * window -- not a least-squares fit across all of them. So a single
     * outlying swing at either end moves the whole line. That is the real
     * algorithm, and it is why the convergence test uses the gap at the window
     * start versus the gap at the last swing rather than at n-1.
     *
     * Classification, where FLAT means within TW_FLAT_TOL of horizontal:
     *   resistance DOWN + support UP    -> SYMMETRICAL_TRIANGLE
     *   resistance FLAT + support UP    -> ASCENDING_TRIANGLE
     *   resistance DOWN + support FLAT  -> DESCENDING_TRIANGLE
     *   both UP,   support rising faster   -> RISING_WEDGE
     *   both DOWN, resistance falling faster -> FALLING_WEDGE
     *
     * Any other combination emits NOTHING -- parallel channels and diverging
     * formations are deliberately not classified here. (Broadening formations,
     * which are the diverging case, are a separate detector at ~6980.)
     *
     * Emits at most one instance: it is a single check, not a loop.
     */
    const twWindowStart = Math.max(0, n - TW_LOOKBACK_BARS);
    const twHighs = swingHighs.filter((h) => h.idx >= twWindowStart);
    const twLows = swingLows.filter((l) => l.idx >= twWindowStart);

    if (twHighs.length >= 2 && twLows.length >= 2) {
      const twR1 = twHighs[0] as SwingPoint;
      const twR2 = twHighs[twHighs.length - 1] as SwingPoint;
      const twS1 = twLows[0] as SwingPoint;
      const twS2 = twLows[twLows.length - 1] as SwingPoint;

      // Guard against a zero-width line, which would divide by zero in necklineAt.
      if (twR2.idx !== twR1.idx && twS2.idx !== twS1.idx) {
        const twLastIdx = Math.max(twR2.idx, twS2.idx);
        const twGapStart = necklineAt(twR1, twR2, twWindowStart) - necklineAt(twS1, twS2, twWindowStart);
        const twGapEnd = necklineAt(twR1, twR2, twLastIdx) - necklineAt(twS1, twS2, twLastIdx);

        // Both gaps positive means resistance stays above support (no crossover);
        // the ratio test is the actual convergence requirement.
        if (twGapStart > 0 && twGapEnd > 0 && twGapEnd <= twGapStart * TW_MIN_CONVERGE_RATIO) {
          const twResPct = (twR2.price - twR1.price) / twR1.price;
          const twSupPct = (twS2.price - twS1.price) / twS1.price;
          const twDir = (pct: number): string => (Math.abs(pct) < TW_FLAT_TOL ? 'FLAT' : pct > 0 ? 'UP' : 'DOWN');
          const twResDir = twDir(twResPct);
          const twSupDir = twDir(twSupPct);

          let twType: string | null = null;
          if (twResDir === 'DOWN' && twSupDir === 'UP') twType = 'SYMMETRICAL_TRIANGLE';
          else if (twResDir === 'FLAT' && twSupDir === 'UP') twType = 'ASCENDING_TRIANGLE';
          else if (twResDir === 'DOWN' && twSupDir === 'FLAT') twType = 'DESCENDING_TRIANGLE';
          else if (twResDir === 'UP' && twSupDir === 'UP' && twSupPct > twResPct) twType = 'RISING_WEDGE';
          else if (twResDir === 'DOWN' && twSupDir === 'DOWN' && twResPct < twSupPct) twType = 'FALLING_WEDGE';

          if (twType) {
            // Breakout is judged at n-1 against both lines extrapolated there,
            // even though convergence was measured only to the last swing.
            const twResLast = necklineAt(twR1, twR2, n - 1);
            const twSupLast = necklineAt(twS1, twS2, n - 1);
            const twBrokeUp = (closes[n - 1] as number) > twResLast;
            const twBrokeDown = (closes[n - 1] as number) < twSupLast;

            // Only the symmetrical triangle is treated as needing volume
            // confirmation -- the directional shapes already carry a bias.
            const twVolExpected = twType === 'SYMMETRICAL_TRIANGLE';
            const twBreakoutVol = twBrokeUp || twBrokeDown ? (volumes[n - 1] as number) : null;
            const twAvgVol =
              volumes.slice(Math.max(0, n - 21), n - 1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, n - 1));

            chartPatterns.push({
              type: twType,
              resistanceP1: { date: dates[twR1.idx] as Date, price: twR1.price },
              resistanceP2: { date: dates[twR2.idx] as Date, price: twR2.price },
              supportP1: { date: dates[twS1.idx] as Date, price: twS1.price },
              supportP2: { date: dates[twS2.idx] as Date, price: twS2.price },
              resistanceAtLast: twResLast,
              supportAtLast: twSupLast,
              status: twBrokeUp ? 'BROKE_UP' : twBrokeDown ? 'BROKE_DOWN' : 'FORMING',
              volumeConfirmationExpected: twVolExpected,
              // Note the tri-state: null when there was no breakout at all,
              // which is distinct from a breakout on unremarkable volume.
              breakoutVolumeElevated:
                twBreakoutVol != null && twAvgVol > 0 ? twBreakoutVol > 1.3 * twAvgVol : null,
              asymmetricVolumeRead: twBrokeUp
                ? asymmetricVolumeConfirmation('up', twBreakoutVol, twAvgVol)
                : twBrokeDown
                  ? asymmetricVolumeConfirmation('down', twBreakoutVol, twAvgVol)
                  : null,
            });
          }
        }
      }
    }

    // ── PENNANT / BULL_FLAG / BEAR_FLAG (legacy 6846-6890) ────────────
    /**
     * A sharp pole, then a tight consolidation. One detector, three types.
     *
     * The discriminator is SHAPE, not direction: if the consolidation's second
     * half is at most FP_PENNANT_NARROW_RATIO as wide as its first half, it is
     * converging and classified PENNANT regardless of pole direction. Only if
     * it is NOT converging does direction decide bull vs bear flag.
     *
     * That ordering matters -- a converging consolidation after an up-pole is a
     * PENNANT, never a BULL_FLAG. Reversing the checks would misclassify most
     * pennants.
     *
     * The flag drift test is direction-aware and one-sided: a bull flag may
     * drift DOWN freely but only 2% up; a bear flag the mirror. A flag is a
     * pause against the trend, so drift WITH the pole is what disqualifies it.
     *
     * Scans backward and `break`s on the first match -- one result per call,
     * avoiding the over-counting already fixed for the double/triple/H&S family.
     *
     * measuredTarget projects the pole length from the breakout level in the
     * pole's direction. The book's own caveat travels with it: this is a
     * probable IMMEDIATE objective, not a forecast of a reversal there.
     */
    {
      for (let fpOffset = 0; fpOffset <= FP_SCAN_BARS; fpOffset++) {
        const fpPoleEnd = n - 1 - FP_CONSOL_BARS - 1 - fpOffset;
        const fpPoleStart = fpPoleEnd - FP_POLE_BARS;
        if (fpPoleStart < 0) break; // out of history

        const fpPolePct = ((closes[fpPoleEnd] as number) - (closes[fpPoleStart] as number)) / (closes[fpPoleStart] as number);
        if (Math.abs(fpPolePct) < FP_POLE_MIN_PCT) continue;
        const fpPoleDir = fpPolePct > 0 ? 'UP' : 'DOWN';

        const fpConsolStart = fpPoleEnd + 1;
        const fpConsolEnd = fpPoleEnd + FP_CONSOL_BARS;
        const fpChunk = (arr: readonly number[], a: number, b: number): number[] => arr.slice(a, b + 1);

        const fpConsolHigh = Math.max(...fpChunk(highs, fpConsolStart, fpConsolEnd));
        const fpConsolLow = Math.min(...fpChunk(lows, fpConsolStart, fpConsolEnd));
        const fpConsolRangePct = (fpConsolHigh - fpConsolLow) / (closes[fpPoleEnd] as number);
        if (fpConsolRangePct > FP_CONSOL_MAX_RANGE_RATIO * Math.abs(fpPolePct)) continue;

        // Split the consolidation in half to test for convergence.
        const fpMid = fpConsolStart + Math.floor(FP_CONSOL_BARS / 2);
        const fpFirstRange =
          Math.max(...fpChunk(highs, fpConsolStart, fpMid - 1)) - Math.min(...fpChunk(lows, fpConsolStart, fpMid - 1));
        const fpSecondRange =
          Math.max(...fpChunk(highs, fpMid, fpConsolEnd)) - Math.min(...fpChunk(lows, fpMid, fpConsolEnd));
        const fpIsPennant = fpSecondRange <= FP_PENNANT_NARROW_RATIO * fpFirstRange;

        const fpFirstAvg = fpChunk(closes, fpConsolStart, fpMid - 1).reduce((a, b) => a + b, 0) / (fpMid - fpConsolStart);
        const fpSecondAvg = fpChunk(closes, fpMid, fpConsolEnd).reduce((a, b) => a + b, 0) / (fpConsolEnd - fpMid + 1);
        const fpDrift = (fpSecondAvg - fpFirstAvg) / fpFirstAvg;

        let fpType: string | null = null;
        if (fpIsPennant) fpType = 'PENNANT'; // shape wins over direction
        else if (fpPoleDir === 'UP' && fpDrift <= FP_FLAG_DRIFT_MAX) fpType = 'BULL_FLAG';
        else if (fpPoleDir === 'DOWN' && fpDrift >= -FP_FLAG_DRIFT_MAX) fpType = 'BEAR_FLAG';

        if (fpType) {
          const fpBrokeUp = (closes[n - 1] as number) > fpConsolHigh;
          const fpBrokeDown = (closes[n - 1] as number) < fpConsolLow;
          const fpMastLength = Math.abs((closes[fpPoleEnd] as number) - (closes[fpPoleStart] as number));
          const fpMeasuredTarget = fpPoleDir === 'UP' ? fpConsolHigh + fpMastLength : fpConsolLow - fpMastLength;

          chartPatterns.push({
            type: fpType,
            poleDir: fpPoleDir,
            polePct: fpPolePct,
            poleStartDate: dates[fpPoleStart] as Date,
            poleEndDate: dates[fpPoleEnd] as Date,
            consolHigh: fpConsolHigh,
            consolLow: fpConsolLow,
            status: fpBrokeUp ? 'BROKE_UP' : fpBrokeDown ? 'BROKE_DOWN' : 'FORMING',
            measuredTarget: fpMeasuredTarget,
          });
          break; // most-recent qualifying match only
        }
      }
    }

    // ── HALF_MAST (legacy 6931) ───────────────────────────────────────
    /**
     * A sharp move (the mast), then a tight low-volume consolidation roughly
     * halfway through a larger move. Three independent conditions:
     *
     *   1. The move must exceed HM_MOVE_MIN_PCT in either direction.
     *   2. The consolidation range must be TIGHT relative to the move --
     *      at most 35% of it. That ratio, not an absolute range, is what makes
     *      it a pause rather than a reversal.
     *   3. Consolidation volume must SHRINK to at most 70% of move volume.
     *      A consolidation on heavy volume is distribution, not a pause.
     *
     * Scans BACKWARD from today up to HM_SCAN_BARS, and `break`s on the first
     * qualifying match -- so it reports the most recent one only. Same
     * one-result-per-call convention the flag/pennant block uses.
     *
     * measuredTarget projects the mast length from the breakout LEVEL (the
     * relevant consolidation edge), not from the current price.
     */
    {
      for (let hmOffset = 0; hmOffset <= HM_SCAN_BARS; hmOffset++) {
        const hmConsolEnd = n - 1 - hmOffset;
        const hmConsolStart = hmConsolEnd - HM_CONSOL_BARS + 1;
        const hmMoveEnd = hmConsolStart - 1;
        const hmMoveStart = hmMoveEnd - HM_MOVE_BARS;
        if (hmMoveStart < 0) break; // out of history, no older candidate possible

        const hmMovePct = ((closes[hmMoveEnd] as number) - (closes[hmMoveStart] as number)) / (closes[hmMoveStart] as number);
        if (Math.abs(hmMovePct) < HM_MOVE_MIN_PCT) continue;
        const hmDir = hmMovePct > 0 ? 'UP' : 'DOWN';

        const hmSlice = (arr: readonly number[], a: number, b: number): number[] => arr.slice(a, b + 1);
        const hmConsolHigh = Math.max(...hmSlice(highs, hmConsolStart, hmConsolEnd));
        const hmConsolLow = Math.min(...hmSlice(lows, hmConsolStart, hmConsolEnd));
        const hmConsolRangePct = (hmConsolHigh - hmConsolLow) / (closes[hmMoveEnd] as number);
        if (hmConsolRangePct > HM_CONSOL_MAX_RANGE_RATIO * Math.abs(hmMovePct)) continue;

        const hmMoveVolAvg =
          hmSlice(volumes, hmMoveStart, hmMoveEnd).reduce((a, b) => a + b, 0) / (hmMoveEnd - hmMoveStart + 1);
        const hmConsolVolAvg = hmSlice(volumes, hmConsolStart, hmConsolEnd).reduce((a, b) => a + b, 0) / HM_CONSOL_BARS;
        if (hmMoveVolAvg <= 0 || hmConsolVolAvg > HM_VOLUME_SHRINK_RATIO * hmMoveVolAvg) continue;

        const hmMastLength = Math.abs((closes[hmMoveEnd] as number) - (closes[hmMoveStart] as number));
        const hmBreakoutLevel = hmDir === 'UP' ? hmConsolHigh : hmConsolLow;
        const hmMeasuredTarget = hmDir === 'UP' ? hmBreakoutLevel + hmMastLength : hmBreakoutLevel - hmMastLength;
        const hmBrokeUp = (closes[n - 1] as number) > hmConsolHigh;
        const hmBrokeDown = (closes[n - 1] as number) < hmConsolLow;

        chartPatterns.push({
          type: 'HALF_MAST',
          moveDir: hmDir,
          movePct: hmMovePct,
          moveStartDate: dates[hmMoveStart] as Date,
          moveEndDate: dates[hmMoveEnd] as Date,
          consolHigh: hmConsolHigh,
          consolLow: hmConsolLow,
          status: hmBrokeUp ? 'BROKE_UP' : hmBrokeDown ? 'BROKE_DOWN' : 'FORMING',
          measuredTarget: hmMeasuredTarget,
        });
        break; // most-recent qualifying match only
      }
    }

    // ── BROADENING + DIAMOND (legacy 6945-7024) ───────────────────────
    /**
     * Both work on a ZIGZAG -- an alternating H/L sequence built by merging
     * swingHighs and swingLows and collapsing consecutive same-type pivots,
     * keeping the more extreme one. That collapse is what guarantees strict
     * alternation, which both detectors rely on for their `i-2` comparisons.
     *
     * Each compares a pivot to the one TWO back, i.e. the previous pivot of the
     * SAME kind -- so "higher highs and lower lows" is expressible as a single
     * uniform test over the window.
     *
     * BROADENING (5 points): widening throughout -- every H above the prior H
     * and every L below the prior L. The diverging counterpart to the
     * converging triangle/wedge family.
     *
     * DIAMOND (7 points): widening to the midpoint, then narrowing -- a
     * broadening formation followed by a triangle. Hence 7 points where
     * broadening needs 5.
     *
     * Direction for both comes from the FIRST point's kind, not the last:
     * starting on a high makes it a TOP. Both scan backward from the most
     * recent pivot and `break` on the first match.
     *
     * The two are NOT mutually exclusive -- a chart can show both, since they
     * scan independently over the same zigzag.
     */
    {
      type ZzPoint = { idx: number; price: number; type: 'H' | 'L' };
      const zzMerged: ZzPoint[] = swingHighs
        .map((h): ZzPoint => ({ idx: h.idx, price: h.price, type: 'H' }))
        .concat(swingLows.map((l): ZzPoint => ({ idx: l.idx, price: l.price, type: 'L' })))
        .sort((a, b) => a.idx - b.idx);
      const zigzag: ZzPoint[] = [];
      zzMerged.forEach((pt) => {
        if (!zigzag.length) {
          zigzag.push(pt);
          return;
        }
        const zLast = zigzag[zigzag.length - 1] as ZzPoint;
        if (pt.type === zLast.type) {
          // Same kind in a row: keep only the more extreme, preserving alternation.
          if ((pt.type === 'H' && pt.price > zLast.price) || (pt.type === 'L' && pt.price < zLast.price)) {
            zigzag[zigzag.length - 1] = pt;
          }
        } else {
          zigzag.push(pt);
        }
      });

      // BROADENING_TOP / BROADENING_BOTTOM
      for (let end = zigzag.length - 1; end >= BT_POINTS - 1; end--) {
        const btWindow = zigzag.slice(end - BT_POINTS + 1, end + 1);
        if ((btWindow[btWindow.length - 1] as ZzPoint).idx < n - RECENCY_WINDOW) continue;

        let btWidening = true;
        for (let i = 2; i < btWindow.length; i++) {
          const cur = btWindow[i] as ZzPoint;
          const prior = btWindow[i - 2] as ZzPoint;
          if (cur.type === 'H' ? !(cur.price > prior.price) : !(cur.price < prior.price)) {
            btWidening = false;
            break;
          }
        }
        if (!btWidening) continue;

        const btHighs = btWindow.filter((w) => w.type === 'H').map((w) => w.price);
        const btLows = btWindow.filter((w) => w.type === 'L').map((w) => w.price);
        if (btHighs.length < 2 || btLows.length < 2) continue;
        const btResistance = Math.max(...btHighs);
        const btSupport = Math.min(...btLows);

        chartPatterns.push({
          type: (btWindow[0] as ZzPoint).type === 'H' ? 'BROADENING_TOP' : 'BROADENING_BOTTOM',
          points: btWindow.map((w) => ({ date: dates[w.idx] as Date, price: w.price, kind: w.type })),
          resistance: btResistance,
          support: btSupport,
          status:
            (closes[n - 1] as number) > btResistance
              ? 'BROKE_UP'
              : (closes[n - 1] as number) < btSupport
                ? 'BROKE_DOWN'
                : 'FORMING',
        });
        break;
      }

      // DIAMOND_TOP / DIAMOND_BOTTOM
      for (let end = zigzag.length - 1; end >= DM_POINTS - 1; end--) {
        const dmWindow = zigzag.slice(end - DM_POINTS + 1, end + 1);
        if ((dmWindow[dmWindow.length - 1] as ZzPoint).idx < n - RECENCY_WINDOW) continue;

        const dmMid = Math.floor(dmWindow.length / 2);
        let dmOk = true;
        // First half must widen...
        for (let i = 2; i <= dmMid; i++) {
          const cur = dmWindow[i] as ZzPoint;
          const prior = dmWindow[i - 2] as ZzPoint;
          if (cur.type === 'H' ? !(cur.price > prior.price) : !(cur.price < prior.price)) {
            dmOk = false;
            break;
          }
        }
        // ...then the second half must narrow. Note the inverted comparisons.
        if (dmOk)
          for (let i = dmMid + 1; i < dmWindow.length; i++) {
            const cur = dmWindow[i] as ZzPoint;
            const prior = dmWindow[i - 2] as ZzPoint;
            if (cur.type === 'H' ? !(cur.price < prior.price) : !(cur.price > prior.price)) {
              dmOk = false;
              break;
            }
          }
        if (!dmOk) continue;

        const dmHighs = dmWindow.filter((w) => w.type === 'H').map((w) => w.price);
        const dmLows = dmWindow.filter((w) => w.type === 'L').map((w) => w.price);
        if (dmHighs.length < 2 || dmLows.length < 2) continue;
        const dmResistance = Math.max(...dmHighs);
        const dmSupport = Math.min(...dmLows);

        chartPatterns.push({
          type: (dmWindow[0] as ZzPoint).type === 'H' ? 'DIAMOND_TOP' : 'DIAMOND_BOTTOM',
          points: dmWindow.map((w) => ({ date: dates[w.idx] as Date, price: w.price, kind: w.type })),
          resistance: dmResistance,
          support: dmSupport,
          status:
            (closes[n - 1] as number) > dmResistance
              ? 'BROKE_UP'
              : (closes[n - 1] as number) < dmSupport
                ? 'BROKE_DOWN'
                : 'FORMING',
        });
        break;
      }
    }

    // ── COMPLEX_TOP / COMPLEX_BOTTOM ──────────────────────────────────
    /**
     * A head-and-shoulders with TWO heads: shoulder, head, head, shoulder.
     * Reuses the H&S tolerances and the same sloping neckline.
     *
     * NOTE THE `break`: unlike every other detector here, these emit AT MOST
     * ONE instance per chart and stop scanning. With four consecutive swings
     * the overlapping-window matches would otherwise be near-duplicates. This
     * is real behaviour -- removing the break would emit extra patterns and
     * break parity.
     */
    for (let i = 0; i < swingHighs.length - 3; i++) {
      const cs1 = swingHighs[i] as SwingPoint;
      const ch1 = swingHighs[i + 1] as SwingPoint;
      const ch2 = swingHighs[i + 2] as SwingPoint;
      const cs2 = swingHighs[i + 3] as SwingPoint;
      if (cs2.idx < n - RECENCY_WINDOW) continue;
      if (
        ch1.idx - cs1.idx < SWING_WINDOW ||
        ch2.idx - ch1.idx < SWING_WINDOW ||
        cs2.idx - ch2.idx < SWING_WINDOW
      )
        continue;
      if (Math.abs(ch1.price - ch2.price) / ch1.price > HS_SHOULDER_TOL) continue; // heads comparable
      const higherShoulder = Math.max(cs1.price, cs2.price);
      // BOTH heads must clear the taller shoulder, not just the higher head.
      if (Math.min(ch1.price, ch2.price) < higherShoulder * (1 + HS_HEAD_MIN_PCT)) continue;
      if (Math.abs(cs1.price - cs2.price) / cs1.price > HS_SHOULDER_TOL) continue; // shoulders comparable

      const cLeftTroughs = swingLows.filter((l) => l.idx > cs1.idx && l.idx < ch1.idx);
      const cRightTroughs = swingLows.filter((l) => l.idx > ch2.idx && l.idx < cs2.idx);
      if (!cLeftTroughs.length || !cRightTroughs.length) continue;
      const cLeftTrough = cLeftTroughs.reduce((min, l) => (l.price < min.price ? l : min));
      const cRightTrough = cRightTroughs.reduce((min, l) => (l.price < min.price ? l : min));
      const cNecklineLast = necklineAt(cLeftTrough, cRightTrough, n - 1);

      chartPatterns.push({
        type: 'COMPLEX_TOP',
        shoulder1: { date: dates[cs1.idx] as Date, price: cs1.price },
        head1: { date: dates[ch1.idx] as Date, price: ch1.price },
        head2: { date: dates[ch2.idx] as Date, price: ch2.price },
        shoulder2: { date: dates[cs2.idx] as Date, price: cs2.price },
        necklineAtLast: cNecklineLast,
        confirmed: (closes[n - 1] as number) < cNecklineLast,
      });
      break; // at most one -- see the note above
    }

    for (let i = 0; i < swingLows.length - 3; i++) {
      const cs1 = swingLows[i] as SwingPoint;
      const ch1 = swingLows[i + 1] as SwingPoint;
      const ch2 = swingLows[i + 2] as SwingPoint;
      const cs2 = swingLows[i + 3] as SwingPoint;
      if (cs2.idx < n - RECENCY_WINDOW) continue;
      if (
        ch1.idx - cs1.idx < SWING_WINDOW ||
        ch2.idx - ch1.idx < SWING_WINDOW ||
        cs2.idx - ch2.idx < SWING_WINDOW
      )
        continue;
      if (Math.abs(ch1.price - ch2.price) / ch1.price > HS_SHOULDER_TOL) continue;
      const lowerShoulder = Math.min(cs1.price, cs2.price);
      if (Math.max(ch1.price, ch2.price) > lowerShoulder * (1 - HS_HEAD_MIN_PCT)) continue;
      if (Math.abs(cs1.price - cs2.price) / cs1.price > HS_SHOULDER_TOL) continue;

      const cLeftPeaks = swingHighs.filter((h) => h.idx > cs1.idx && h.idx < ch1.idx);
      const cRightPeaks = swingHighs.filter((h) => h.idx > ch2.idx && h.idx < cs2.idx);
      if (!cLeftPeaks.length || !cRightPeaks.length) continue;
      const cLeftPeak = cLeftPeaks.reduce((max, h) => (h.price > max.price ? h : max));
      const cRightPeak = cRightPeaks.reduce((max, h) => (h.price > max.price ? h : max));
      const cNecklineLast = necklineAt(cLeftPeak, cRightPeak, n - 1);

      chartPatterns.push({
        type: 'COMPLEX_BOTTOM',
        shoulder1: { date: dates[cs1.idx] as Date, price: cs1.price },
        head1: { date: dates[ch1.idx] as Date, price: ch1.price },
        head2: { date: dates[ch2.idx] as Date, price: ch2.price },
        shoulder2: { date: dates[cs2.idx] as Date, price: cs2.price },
        necklineAtLast: cNecklineLast,
        confirmed: (closes[n - 1] as number) > cNecklineLast,
      });
      break;
    }

    // ── RECTANGLE (legacy 7117) ───────────────────────────────────────
    /**
     * A flat trading range. Note it is the ONLY pattern using the field names
     * `resistanceLevel` / `supportLevel` -- the triangle family uses
     * `resistanceAtLast` / `supportAtLast`, and broadening/diamond use
     * `resistance` / `support`. wyckoffSchematic reads the Level names
     * specifically, so they must not be normalised to match the others.
     *
     * Levels are MEANS of the swing prices, not extremes, then every swing must
     * sit within RECT_LEVEL_TOL of its mean -- so the boundaries must be
     * genuinely flat, not merely bounded.
     *
     * Previously unported because it never fired on any fixture. Added now
     * because wyckoffSchematic depends on it, and verified against the oracle
     * on synthetic flat-range charts instead.
     */
    {
      const rectWindowStart = Math.max(0, n - RECT_LOOKBACK);
      const rectH = swingHighs.filter((h) => h.idx >= rectWindowStart);
      const rectL = swingLows.filter((l) => l.idx >= rectWindowStart);

      if (rectH.length >= 2 && rectL.length >= 2) {
        const rectResistance = rectH.reduce((a, h) => a + h.price, 0) / rectH.length;
        const rectSupport = rectL.reduce((a, l) => a + l.price, 0) / rectL.length;
        const rectFlatH = rectH.every((h) => Math.abs(h.price - rectResistance) / rectResistance <= RECT_LEVEL_TOL);
        const rectFlatL = rectL.every((l) => Math.abs(l.price - rectSupport) / rectSupport <= RECT_LEVEL_TOL);

        if (
          rectFlatH &&
          rectFlatL &&
          rectResistance > rectSupport &&
          (rectResistance - rectSupport) / rectSupport >= RECT_MIN_RANGE
        ) {
          const rectWindowCloses = closes.slice(rectWindowStart, n);
          const rectContained = rectWindowCloses.filter(
            (cl) => cl >= rectSupport * (1 - RECT_LEVEL_TOL) && cl <= rectResistance * (1 + RECT_LEVEL_TOL),
          ).length;

          if (rectContained / rectWindowCloses.length >= RECT_MIN_CONTAINMENT) {
            const rectBrokeUp = (closes[n - 1] as number) > rectResistance;
            const rectBrokeDown = (closes[n - 1] as number) < rectSupport;
            chartPatterns.push({
              type: 'RECTANGLE',
              resistanceLevel: rectResistance,
              supportLevel: rectSupport,
              status: rectBrokeUp ? 'BROKE_UP' : rectBrokeDown ? 'BROKE_DOWN' : 'FORMING',
            });
          }
        }
      }
    }

    // ── STAIRCASE (legacy 7175) ───────────────────────────────────────
    /**
     * Institutional-accumulation signature: a chain of flat shelves, each
     * stepping up from the last through a real breakout. The conceptual
     * opposite of speculativeSpike.
     *
     * Built in four stages:
     *   1. Slide a STAIR_WIN window in STAIR_STEP increments, keeping windows
     *      whose net drift is under STAIR_DRIFT_TOL -- candidate flat shelves.
     *   2. MERGE overlapping windows into regions. The overlap test is
     *      `w.start <= cur.end`, STRICT overlap only. An earlier legacy draft
     *      used `cur.end + STAIR_STEP`, which let two genuinely separate
     *      shelves merge across a real breakout gap and silently ate a step --
     *      caught in real-data testing, not theory. Do not loosen this.
     *   3. Chain regions where each is at least STAIR_MIN_STEP_RISE above the
     *      previous AND a real breakout occurred between them. A gap in the
     *      chain RESETS it to a single step rather than skipping -- so the
     *      chain is always contiguous.
     *   4. Emit only if the chain reaches STAIR_MIN_STEPS.
     *
     * Note `level` is a MEAN close over the shelf while `localHigh` is a max
     * high -- the breakout test uses the high, the step-rise test uses the mean.
     */
    {
      const stairFlatWindows: Array<{ start: number; end: number }> = [];
      for (let i = 0; i + STAIR_WIN <= n; i += STAIR_STEP) {
        const drift = ((closes[i + STAIR_WIN - 1] as number) - (closes[i] as number)) / (closes[i] as number);
        if (Math.abs(drift) < STAIR_DRIFT_TOL) stairFlatWindows.push({ start: i, end: i + STAIR_WIN - 1 });
      }

      if (stairFlatWindows.length) {
        const stairRegions = [{ ...(stairFlatWindows[0] as { start: number; end: number }) }];
        for (let i = 1; i < stairFlatWindows.length; i++) {
          const w = stairFlatWindows[i] as { start: number; end: number };
          const cur = stairRegions[stairRegions.length - 1] as { start: number; end: number };
          if (w.start <= cur.end) cur.end = Math.max(cur.end, w.end); // STRICT overlap -- see note
          else stairRegions.push({ ...w });
        }

        const stairSteps = stairRegions.map((r) => {
          const seg = closes.slice(r.start, r.end + 1);
          return {
            ...r,
            level: seg.reduce((a, b) => a + b, 0) / seg.length,
            localHigh: Math.max(...highs.slice(r.start, r.end + 1)),
          };
        });

        let stairChain: typeof stairSteps = [];
        for (const step of stairSteps) {
          if (stairChain.length) {
            const prev = stairChain[stairChain.length - 1] as (typeof stairSteps)[number];
            const brokeOut = Math.max(...closes.slice(prev.end, step.start + 1)) > prev.localHigh;
            if (step.level > prev.level * (1 + STAIR_MIN_STEP_RISE) && brokeOut) {
              stairChain.push(step);
              continue;
            }
          }
          stairChain = [step]; // reset, not skip -- the chain stays contiguous
        }

        if (stairChain.length >= STAIR_MIN_STEPS) {
          const stairLast = stairChain[stairChain.length - 1] as (typeof stairSteps)[number];
          chartPatterns.push({
            type: 'STAIRCASE',
            steps: stairChain.length,
            baseLevel: (stairChain[0] as (typeof stairSteps)[number]).level,
            lastStepLevel: stairLast.level,
            status: (closes[n - 1] as number) > stairLast.localHigh ? 'BROKE_UP' : 'FORMING',
          });
        }
      }
    }

    // ── ROUNDING_BOTTOM / ROUNDING_TOP / CUP_AND_HANDLE ───────────────
    /**
     * Unlike the swing-based detectors above, these work directly on the close
     * series and emit AT MOST ONE instance each -- they are single checks, not
     * loops. No `break` is needed because there is no loop to break out of.
     *
     * The shared shape test has three parts:
     *   1. The extreme sits away from both window edges (RND_EDGE_FRAC), so a
     *      plain one-way trend cannot pass as a rounded formation.
     *   2. Each phase is split into RND_SEGMENTS blocks whose averages must be
     *      monotonic within a 1% tolerance -- a smooth arc, not a zigzag.
     *   3. No SINGLE bar may account for more than RND_MAX_SINGLE_BAR_SHARE of
     *      a phase's total movement, which is what makes it "rounded" rather
     *      than a gap or a spike.
     */
    const rndSegAvgs = (arr: readonly number[], k: number): number[] => {
      const avgs: number[] = [];
      const cs = Math.floor(arr.length / k);
      for (let s = 0; s < k; s++) {
        const a = s * cs;
        const b = s === k - 1 ? arr.length : (s + 1) * cs; // last segment absorbs the remainder
        const seg = arr.slice(a, b);
        avgs.push(seg.reduce((x, y) => x + y, 0) / seg.length);
      }
      return avgs;
    };
    const rndMonoDec = (avgs: readonly number[], tol: number): boolean => {
      for (let i = 0; i < avgs.length - 1; i++) {
        if ((avgs[i + 1] as number) > (avgs[i] as number) * (1 + tol)) return false;
      }
      return true;
    };
    const rndMonoInc = (avgs: readonly number[], tol: number): boolean => {
      for (let i = 0; i < avgs.length - 1; i++) {
        if ((avgs[i + 1] as number) < (avgs[i] as number) * (1 - tol)) return false;
      }
      return true;
    };
    const rndMaxBarShare = (phase: readonly number[]): number => {
      let total = 0;
      let maxBar = 0;
      for (let i = 1; i < phase.length; i++) {
        const d = Math.abs((phase[i] as number) - (phase[i - 1] as number));
        total += d;
        if (d > maxBar) maxBar = d;
      }
      return total === 0 ? 0 : maxBar / total;
    };

    // Window ends YESTERDAY. Today (n-1) is deliberately excluded so it can
    // serve as the independent breakout candidate in the status check below --
    // otherwise the breakout bar would be part of the formation it breaks out of.
    const rndWindowEnd = n - 2;
    const rndWindowStart = Math.max(0, rndWindowEnd - RND_LOOKBACK + 1);
    const rndWin = closes.slice(rndWindowStart, rndWindowEnd + 1);
    const rndWn = rndWin.length;

    let rndMinIdx = 0;
    let rndMaxIdx = 0;
    for (let i = 1; i < rndWn; i++) {
      if ((rndWin[i] as number) < (rndWin[rndMinIdx] as number)) rndMinIdx = i;
      if ((rndWin[i] as number) > (rndWin[rndMaxIdx] as number)) rndMaxIdx = i;
    }

    if (rndMinIdx >= rndWn * RND_EDGE_FRAC && rndMinIdx <= rndWn * (1 - RND_EDGE_FRAC)) {
      const declPhase = rndWin.slice(0, rndMinIdx + 1);
      const risePhase = rndWin.slice(rndMinIdx);
      if (declPhase.length >= RND_SEGMENTS && risePhase.length >= RND_SEGMENTS) {
        const declAvgs = rndSegAvgs(declPhase, RND_SEGMENTS);
        const riseAvgs = rndSegAvgs(risePhase, RND_SEGMENTS);
        const declDepth = ((rndWin[0] as number) - (rndWin[rndMinIdx] as number)) / (rndWin[0] as number);
        const riseDepth =
          ((rndWin[rndWn - 1] as number) - (rndWin[rndMinIdx] as number)) / (rndWin[rndMinIdx] as number);
        const gradual =
          rndMaxBarShare(declPhase) <= RND_MAX_SINGLE_BAR_SHARE &&
          rndMaxBarShare(risePhase) <= RND_MAX_SINGLE_BAR_SHARE;
        if (
          rndMonoDec(declAvgs, 0.01) &&
          rndMonoInc(riseAvgs, 0.01) &&
          declDepth >= RND_MIN_DEPTH &&
          riseDepth >= RND_MIN_DEPTH &&
          gradual
        ) {
          // Rim is the HIGHER of the two window edges -- the level that must
          // be cleared for a genuine breakout.
          const rndRim = Math.max(rndWin[0] as number, rndWin[rndWn - 1] as number);
          chartPatterns.push({
            type: 'ROUNDING_BOTTOM',
            rim: rndRim,
            status: (closes[n - 1] as number) > rndRim ? 'BROKE_UP' : 'FORMING',
          });
        }
      }
    }

    if (rndMaxIdx >= rndWn * RND_EDGE_FRAC && rndMaxIdx <= rndWn * (1 - RND_EDGE_FRAC)) {
      const risePhase = rndWin.slice(0, rndMaxIdx + 1);
      const declPhase = rndWin.slice(rndMaxIdx);
      if (declPhase.length >= RND_SEGMENTS && risePhase.length >= RND_SEGMENTS) {
        const riseAvgs = rndSegAvgs(risePhase, RND_SEGMENTS);
        const declAvgs = rndSegAvgs(declPhase, RND_SEGMENTS);
        const riseDepth = ((rndWin[rndMaxIdx] as number) - (rndWin[0] as number)) / (rndWin[0] as number);
        const declDepth =
          ((rndWin[rndMaxIdx] as number) - (rndWin[rndWn - 1] as number)) / (rndWin[rndMaxIdx] as number);
        const gradual =
          rndMaxBarShare(declPhase) <= RND_MAX_SINGLE_BAR_SHARE &&
          rndMaxBarShare(risePhase) <= RND_MAX_SINGLE_BAR_SHARE;
        if (
          rndMonoInc(riseAvgs, 0.01) &&
          rndMonoDec(declAvgs, 0.01) &&
          riseDepth >= RND_MIN_DEPTH &&
          declDepth >= RND_MIN_DEPTH &&
          gradual
        ) {
          const rndRim2 = Math.min(rndWin[0] as number, rndWin[rndWn - 1] as number);
          chartPatterns.push({
            type: 'ROUNDING_TOP',
            rim: rndRim2,
            status: (closes[n - 1] as number) < rndRim2 ? 'BROKE_DOWN' : 'FORMING',
          });
        }
      }
    }

    /**
     * CUP_AND_HANDLE: a rounding bottom whose window ENDS earlier, reserving
     * the most recent HANDLE_BARS for the handle itself.
     *
     * The handle must be a shallow pullback -- at least HANDLE_MIN_DEPTH so it
     * is a real pause, at most HANDLE_MAX_DEPTH_ABS in absolute terms, AND no
     * more than HANDLE_MAX_DEPTH_RATIO of the cup's own depth. That last,
     * relative condition is what distinguishes a handle from a second leg down.
     *
     * Note the handle low uses `lows`, while the cup shape uses `closes`.
     */
    const cupEnd = n - 1 - HANDLE_BARS - 1;
    const cupStart = Math.max(0, cupEnd - CUP_LOOKBACK + 1);
    if (cupEnd - cupStart >= RND_SEGMENTS * 2) {
      const cupWin = closes.slice(cupStart, cupEnd + 1);
      const cupWn = cupWin.length;
      let cupMinIdx = 0;
      for (let i = 1; i < cupWn; i++) {
        if ((cupWin[i] as number) < (cupWin[cupMinIdx] as number)) cupMinIdx = i;
      }
      if (cupMinIdx >= cupWn * RND_EDGE_FRAC && cupMinIdx <= cupWn * (1 - RND_EDGE_FRAC)) {
        const cDeclPhase = cupWin.slice(0, cupMinIdx + 1);
        const cRisePhase = cupWin.slice(cupMinIdx);
        if (cDeclPhase.length >= RND_SEGMENTS && cRisePhase.length >= RND_SEGMENTS) {
          const cDeclAvgs = rndSegAvgs(cDeclPhase, RND_SEGMENTS);
          const cRiseAvgs = rndSegAvgs(cRisePhase, RND_SEGMENTS);
          const cDeclDepth = ((cupWin[0] as number) - (cupWin[cupMinIdx] as number)) / (cupWin[0] as number);
          const cRiseDepth =
            ((cupWin[cupWn - 1] as number) - (cupWin[cupMinIdx] as number)) / (cupWin[cupMinIdx] as number);
          const cGradual =
            rndMaxBarShare(cDeclPhase) <= RND_MAX_SINGLE_BAR_SHARE &&
            rndMaxBarShare(cRisePhase) <= RND_MAX_SINGLE_BAR_SHARE;
          if (
            rndMonoDec(cDeclAvgs, 0.01) &&
            rndMonoInc(cRiseAvgs, 0.01) &&
            cDeclDepth >= RND_MIN_DEPTH &&
            cRiseDepth >= RND_MIN_DEPTH &&
            cGradual
          ) {
            const cupRim = Math.max(cupWin[0] as number, cupWin[cupWn - 1] as number);
            const handleStart = cupEnd + 1;
            const handleEnd = cupEnd + HANDLE_BARS;
            const handleLow = Math.min(...lows.slice(handleStart, handleEnd + 1));
            const handleDepth = (cupRim - handleLow) / cupRim;
            if (
              handleDepth >= HANDLE_MIN_DEPTH &&
              handleDepth <= HANDLE_MAX_DEPTH_ABS &&
              handleDepth <= HANDLE_MAX_DEPTH_RATIO * cDeclDepth
            ) {
              chartPatterns.push({
                type: 'CUP_AND_HANDLE',
                rim: cupRim,
                status: (closes[n - 1] as number) > cupRim ? 'BROKE_UP' : 'FORMING',
              });
            }
          }
        }
      }
    }

    // ── BULL_TRAP / BEAR_TRAP (LAST detectors in legacy order) ────────
    /**
     * A trap is a breakout that fails fast. Note the two distinct outcomes:
     *
     *  - CONFIRMED: price broke out, then closed back through the level within
     *    TRAP_WINDOW bars. The trap happened.
     *  - WATCHING: price broke out too recently for the window to have elapsed,
     *    so the outcome is still unknown. Emitted only when
     *    (n-1 - breakoutIdx) < TRAP_WINDOW.
     *
     * A breakout that survived its window emits NOTHING -- absence of a trap is
     * not a pattern. Conflating WATCHING with CONFIRMED would turn every recent
     * breakout into a warning.
     *
     * The breakout threshold (3% beyond the level) is asymmetric with the
     * failure threshold (any close back through the bare level), which is
     * deliberate: it takes a real move to qualify as a breakout, but only a
     * return to the level to invalidate it.
     */
    const trapWindowStart = Math.max(0, n - TRAP_LOOKBACK);

    swingHighs
      .filter((h) => h.idx >= trapWindowStart)
      .forEach((h) => {
        let breakoutIdx = -1;
        for (let j = h.idx + 1; j < n; j++) {
          if ((closes[j] as number) > h.price * (1 + TRAP_MIN_BREAK_PCT)) {
            breakoutIdx = j;
            break;
          }
        }
        if (breakoutIdx === -1) return;

        let failIdx = -1;
        for (let k = breakoutIdx + 1; k <= Math.min(breakoutIdx + TRAP_WINDOW, n - 1); k++) {
          if ((closes[k] as number) < h.price) {
            failIdx = k;
            break;
          }
        }

        if (failIdx !== -1) {
          chartPatterns.push({
            type: 'BULL_TRAP',
            level: h.price,
            breakoutDate: dates[breakoutIdx] as Date,
            failDate: dates[failIdx] as Date,
            status: 'CONFIRMED',
          });
        } else if (n - 1 - breakoutIdx < TRAP_WINDOW) {
          chartPatterns.push({
            type: 'BULL_TRAP',
            level: h.price,
            breakoutDate: dates[breakoutIdx] as Date,
            status: 'WATCHING',
          });
        }
      });

    swingLows
      .filter((l) => l.idx >= trapWindowStart)
      .forEach((l) => {
        let breakdownIdx = -1;
        for (let j = l.idx + 1; j < n; j++) {
          if ((closes[j] as number) < l.price * (1 - TRAP_MIN_BREAK_PCT)) {
            breakdownIdx = j;
            break;
          }
        }
        if (breakdownIdx === -1) return;

        let reclaimIdx = -1;
        for (let k = breakdownIdx + 1; k <= Math.min(breakdownIdx + TRAP_WINDOW, n - 1); k++) {
          if ((closes[k] as number) > l.price) {
            reclaimIdx = k;
            break;
          }
        }

        if (reclaimIdx !== -1) {
          chartPatterns.push({
            type: 'BEAR_TRAP',
            level: l.price,
            breakdownDate: dates[breakdownIdx] as Date,
            reclaimDate: dates[reclaimIdx] as Date,
            status: 'CONFIRMED',
          });
        } else if (n - 1 - breakdownIdx < TRAP_WINDOW) {
          chartPatterns.push({
            type: 'BEAR_TRAP',
            level: l.price,
            breakdownDate: dates[breakdownIdx] as Date,
            status: 'WATCHING',
          });
        }
      });

    // ── Remaining 15 detectors go here, in legacy order ───────────────
  } catch (e) {
    // The partial array IS the contract -- do NOT rethrow. But do not let the
    // abort be silent either: an empty result here is otherwise
    // indistinguishable from a genuinely patternless chart.
    if (onAbort) onAbort(`chart-pattern detection aborted: ${e instanceof Error ? e.message : String(e)}`);
  }

  return chartPatterns;
}

/** Pattern types ported so far. The parity test filters the oracle to these. */
export const PORTED_PATTERN_TYPES: readonly string[] = [
  'DOUBLE_TOP', 'DOUBLE_BOTTOM',
  'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS',
  'SCALLOP_SERIES',
  'TRIPLE_TOP', 'TRIPLE_BOTTOM',
  'SYMMETRICAL_TRIANGLE', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE',
  'RISING_WEDGE', 'FALLING_WEDGE',
  'PENNANT', 'BULL_FLAG', 'BEAR_FLAG',
  'HALF_MAST',
  'BROADENING_TOP', 'BROADENING_BOTTOM',
  'DIAMOND_TOP', 'DIAMOND_BOTTOM',
  'COMPLEX_TOP', 'COMPLEX_BOTTOM',
  'RECTANGLE',
  'STAIRCASE',
  'ROUNDING_BOTTOM', 'ROUNDING_TOP', 'CUP_AND_HANDLE',
  'BULL_TRAP', 'BEAR_TRAP',
];

/** Distinct types observed across the fixture set, for progress tracking. */
export const OBSERVED_PATTERN_TYPE_COUNT = 28;

/** 28 types appear in the fixtures; RECTANGLE is the 29th, verified synthetically. */
export const TOTAL_PATTERN_TYPE_COUNT = 29;

/** True once every observed type is ported — the parity test then stops filtering. */
export const CHART_PATTERNS_COMPLETE = true;
