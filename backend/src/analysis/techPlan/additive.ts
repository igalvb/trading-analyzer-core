/**
 * Tier C, part 2: the second-opinion sizing, leverage and channel reads.
 *
 *   nNormalizedPositionSize  Edwards & Magee Appendix E   (:221-236)
 *   compositeLeverage        Edwards & Magee Appendix A    (:271-279)
 *     + normalRangeForPrice  Appendix A Ch C p620 table    (:256-270)
 *   fanPrinciple             Edwards & Magee Ch14          (:2602-2655)
 *   trendChannel             Edwards & Magee Ch14          (:2689-2731)
 *
 * Every one is annotated "purely additive" in the legacy source, and the
 * end-to-end fingerprint gate measured that: 375 verdicts identical with
 * none of this computed.
 *
 * ══ TWO NOTATION COLLISIONS THE BOOK ITSELF HAS ════════════════════════
 * Both are disclosed in the legacy comments rather than hidden, and both are
 * carried forward here because renaming them would break the link to the
 * book:
 *
 *  - `N` means TWO different things. In Appendix E it is the Turtle system's
 *    ATR-based unit of volatility (ind.turtleN). In Appendix A it is the
 *    "Normal Range for Price" table value. They are unrelated.
 *  - `S` (Sensitivity Index) is approximated by this project's atrRatio.
 *    That substitution is the book editor's own instruction ("read 'beta'
 *    for 'Sensitivity Index'", Appendix A p612), not an invention here --
 *    and it is the same approximation the Ch27 stop table already makes.
 *
 * ══ ONE DELIBERATE INDEPENDENCE ════════════════════════════════════════
 * nNormalizedPositionSize uses a FIXED 1% risk, NOT ACCOUNT.riskPct, even
 * though both happen to be 1 right now. The legacy comment at :215-220 is
 * explicit about why: the two sizing methods must stay a genuine comparable
 * second opinion rather than silently sharing one config knob. Changing
 * ACCOUNT.riskPct must move one number and not the other.
 */

import type { Chart } from '../../types/chart.ts';
import { ACCOUNT, type AccountConfig } from '../decision.ts';
import { swingPoints, type StopInput, type SwingPoint } from './stops.ts';

const MIN_BARS = 20;
const SWING_WINDOW = 5;
/** "Recent, not archaeological" -- the file's own established bound. */
const RECENCY_WINDOW = 120;

// ── 1. N-normalized position size (Appendix E) ─────────────────────────

export interface NNormalizedPositionSize {
  readonly shares: number;
  readonly cost: number;
  /** The Turtle ATR-based N, NOT the Appendix A table N. See the header. */
  readonly n: number;
  readonly stopLevel: number;
  readonly dollarRisk: number;
  readonly riskPctOfAccount: number;
}

/**
 * Appendix E sizing: risk 1% of equity per 1N of volatility, stop 2N below
 * entry.
 *
 * `DollarsPerPoint` is 1 for a single stock share, which is why the book's
 * formula collapses to `floor(account * 1% / N)`.
 *
 * Returns null rather than zero shares whenever the result would not be a
 * real position -- same contract as computePositionSize, and the same
 * cash-account cap (never let one position exceed the account).
 *
 * Note `stopLevel` is NOT clamped at zero: a stock whose 2N exceeds its own
 * price yields a negative stop. Reproduced as found. It is informational
 * only and never routed anywhere, but it is worth knowing before anyone
 * renders it.
 */
export function computeNNormalizedPositionSize(
  entryPrice: number,
  n: number,
  account: AccountConfig = ACCOUNT,
): NNormalizedPositionSize | null {
  const acct = (account && account.size) || 0;
  if (!(acct > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(n) || !(n > 0)) return null;

  const RISK_PCT_PER_N = 0.01; // Appendix E's own literal "1N = 1% of equity"
  const STOP_MULTIPLE_N = 2; // Appendix E's own literal initial stop

  let shares = Math.floor((acct * RISK_PCT_PER_N) / n);
  if (!(shares > 0)) return null;

  let cost = shares * entryPrice;
  if (cost > acct) {
    shares = Math.floor(acct / entryPrice);
    cost = shares * entryPrice;
  }
  if (!(shares > 0)) return null;

  const dollarRisk = shares * STOP_MULTIPLE_N * n;
  return {
    shares,
    cost,
    n,
    stopLevel: entryPrice - STOP_MULTIPLE_N * n,
    dollarRisk,
    riskPctOfAccount: (dollarRisk / acct) * 100,
  };
}

// ── 2. Composite leverage (Appendix A) ─────────────────────────────────

/**
 * Normal Range for Price, Appendix A Chapter C p620.
 *
 * These are the book's own printed anchor points, not every row. Values
 * between anchors are linearly interpolated and values beyond the $250 top
 * row are held flat -- both disclosed in the legacy comment at :253-255
 * rather than presented as if the table were continuous.
 */
const NORMAL_RANGE_FOR_PRICE_TABLE: ReadonlyArray<readonly [number, number]> = [
  [1.25, 38.0], [5, 24.0], [10, 19.8], [15, 17.6], [20, 16.5], [25, 15.5], [30, 14.7],
  [35, 14.2], [40, 13.7], [45, 13.2], [50, 12.7], [60, 12.1], [70, 11.6], [80, 11.1],
  [90, 10.8], [100, 10.4], [150, 9.0], [200, 8.0], [250, 7.0],
];

/** Flat below $1.25, flat above $250, linear in between. */
export function normalRangeForPrice(price: number): number {
  const t = NORMAL_RANGE_FOR_PRICE_TABLE;
  if (price <= t[0][0]) return t[0][1];
  if (price >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 0; i < t.length - 1; i++) {
    const [p1, r1] = t[i];
    const [p2, r2] = t[i + 1];
    if (price >= p1 && price <= p2) return r1 + ((r2 - r1) * (price - p1)) / (p2 - p1);
  }
  return t[t.length - 1][1];
}

export type LeverageTier = 'conservative' | 'moderate' | 'speculative' | 'highly speculative';

export interface CompositeLeverage {
  readonly leverage: number;
  readonly sensitivityIndex: number;
  readonly normalRangeForPrice: number;
  readonly tier: LeverageTier;
}

/**
 * Composite Leverage = (S x N x T) / (15.5 x C), Appendix A Chapter B.
 *
 * T/C cancels to 1 here because this is a cash-only, long-only, unmargined
 * account: the dollars committed ARE the capital reserved. That is the
 * user's actual strategy, not a simplifying assumption made for convenience
 * -- if margin were ever used this function would be wrong and would need
 * the real T and C passed in.
 */
export function computeCompositeLeverage(
  price: number,
  sensitivityIndex: number,
): CompositeLeverage | null {
  if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(sensitivityIndex)) return null;
  const nRange = normalRangeForPrice(price);
  const leverage = (sensitivityIndex * nRange) / 15.5;
  const tier: LeverageTier =
    leverage < 0.5 ? 'conservative'
      : leverage < 1.0 ? 'moderate'
        : leverage < 1.5 ? 'speculative'
          : 'highly speculative';
  return { leverage, sensitivityIndex, normalRangeForPrice: nRange, tier };
}

// ── 3. The Fan Principle (Ch14) ────────────────────────────────────────

export type FanDirection = 'bullCorrection' | 'bearRecovery';

export interface FanPoint {
  readonly date: Date;
  readonly price: number;
  readonly broken: boolean;
}

export interface FanPrinciple {
  /** The book's rule: the correction is over once all THREE lines break. */
  readonly triggered: boolean;
  readonly brokenCount: number;
  /** The book claims each line is flatter than the last. Measured, not assumed. */
  readonly flattening: boolean;
  readonly originDate: Date;
  readonly originPrice: number;
  readonly fanPoints: readonly FanPoint[];
  readonly direction: FanDirection;
}

/**
 * The Three-Fan Rule: three successively flatter lines from a correction's
 * origin, and the correction is complete once all three are broken.
 *
 * ══ WHY A "BREAK" IS NOT A CLOSE ═══════════════════════════════════════
 * The legacy comment at :2625-2634 records a real bug found while testing,
 * not assumed away: a fan point sits ON its own line by definition and the
 * line keeps sloping, so ANY close just past the pivot reads as "above the
 * line" within a bar or two. A close-based test was therefore almost always
 * true and meaningless.
 *
 * A break instead requires a separately CONFIRMED opposite-direction swing
 * point -- its own genuine +/-5-bar local extreme -- whose price clears the
 * line. Real follow-through, not one noisy bar. Each line is tested only
 * within its own window, ending at the next fan point (or "now" for the
 * third).
 *
 * Returns null when fewer than 3 opposite swings exist after the origin:
 * the correction has not yet produced enough structure to draw all three
 * lines. That is a disclosed "no read", not a failure.
 *
 * ══ FLAGGED (F-15): `flattening` ONLY COMPARES LINES 1 AND 3 ═══════════
 * :2645 is `slopes[2] > slopes[0]` (bull) / `slopes[2] < slopes[0]` (bear).
 * `slopes[1]` is never read. The legacy comment claims this is "verified
 * here, not assumed" against the book's claim that each successive line is
 * flatter -- it is only PARTLY verified. Measured on real fixtures: 19 of
 * 149 reads are not monotonically flattening, and 14 of those still report
 * `flattening: true`. Reproduced exactly, not fixed.
 */
export function computeFanPrinciple(chart: StopInput, direction: FanDirection): FanPrinciple | null {
  const n = chart.closes ? chart.closes.length : 0;
  if (n < MIN_BARS) return null;

  // NOTE the scan is FULL-RANGE here and the recency bound is applied as a
  // FILTER afterwards -- unlike the Ch28 basing-point methods, which bound
  // the scan itself. The filtered origin pool is the same either way, but
  // `oppositeSwings` below deliberately uses the UNFILTERED list, so a break
  // can be confirmed by a swing that formed before the recent window.
  const { highs: swingHighs, lows: swingLows } = swingPoints(chart, SWING_WINDOW);

  const isBull = direction === 'bullCorrection';
  const originPool = (isBull ? swingHighs : swingLows).filter((p) => p.idx >= n - RECENCY_WINDOW);
  if (!originPool.length) return null;

  // reduce() with no seed, matching legacy: the first element is the seed,
  // so an empty pool would throw -- which the guard above makes impossible.
  const origin = originPool.reduce((best, p) =>
    (isBull ? p.price > best.price : p.price < best.price) ? p : best);

  const oppositePool = (isBull ? swingLows : swingHighs).filter((p) => p.idx > origin.idx);
  if (oppositePool.length < 3) return null;

  const fanPts = oppositePool.slice(0, 3);
  const lineValueAt = (pt: SwingPoint, barIdx: number): number =>
    origin.price + ((pt.price - origin.price) * (barIdx - origin.idx)) / (pt.idx - origin.idx);

  const oppositeSwings = isBull ? swingHighs : swingLows;
  const brokenFlags = fanPts.map((pt, i) => {
    const windowEnd = i < fanPts.length - 1 ? fanPts[i + 1].idx : n;
    return oppositeSwings.some((sh) =>
      sh.idx > pt.idx && sh.idx < windowEnd &&
      (isBull ? sh.price > lineValueAt(pt, sh.idx) : sh.price < lineValueAt(pt, sh.idx)));
  });

  const slopes = fanPts.map((pt) => (pt.price - origin.price) / (pt.idx - origin.idx));
  const flattening = isBull ? slopes[2] > slopes[0] : slopes[2] < slopes[0];

  return {
    triggered: brokenFlags.filter(Boolean).length === 3,
    brokenCount: brokenFlags.filter(Boolean).length,
    flattening,
    originDate: chart.dates[origin.idx],
    originPrice: origin.price,
    fanPoints: fanPts.map((pt, i) => ({
      date: chart.dates[pt.idx], price: pt.price, broken: brokenFlags[i],
    })),
    direction,
  };
}

// ── 4. Trend channel / return line (Ch14) ──────────────────────────────

export type ChannelDirection = 'up' | 'down';

export interface TrendChannel {
  readonly basicTrendline: {
    readonly p1: { readonly date: Date; readonly price: number };
    readonly p2: { readonly date: Date; readonly price: number };
    readonly currentValue: number;
  };
  readonly returnLine: {
    readonly anchorDate: Date;
    readonly anchorPrice: number;
    readonly currentValue: number;
  };
  readonly latestSwing: { readonly date: Date; readonly price: number };
  /** Positive = fell short of its boundary. Negative/zero = reached or passed it. */
  readonly shortfall: number;
  /** A DOLLAR AMOUNT to apply to the opposite boundary, not a price. */
  readonly projectedOvershoot: number | null;
  readonly direction: ChannelDirection;
}

/**
 * The basic trendline plus a parallel Return Line, and the symmetric
 * overshoot projection the book draws from a swing that fell short.
 *
 * The basic line is drawn through the LAST TWO same-direction swings (not a
 * fit over all of them), so it is the current leg, not an average. The
 * Return Line is parallel -- identical slope -- anchored on the most extreme
 * opposite swing in the window, which is the book's own "wave top"/"wave
 * bottom".
 *
 * `shortfall` measures how far the latest completed opposite swing fell
 * short of its own boundary. `projectedOvershoot` exposes it only when
 * positive, because a swing that already reached or passed its boundary
 * leaves nothing to project. Reproduced exactly, including that the value is
 * a dollar DISTANCE, not a target price -- it is applied to the opposite
 * boundary's value when the next swing occurs.
 *
 * Two distinct null paths, both disclosed in the source: fewer than two
 * same-direction swings (no channel), and a channel with no completed
 * opposite swing after it (nothing to measure).
 */
export function computeTrendChannel(
  chart: StopInput,
  direction: ChannelDirection,
): TrendChannel | null {
  const n = chart.closes ? chart.closes.length : 0;
  if (n < MIN_BARS) return null;

  const { highs: swingHighs, lows: swingLows } = swingPoints(chart, SWING_WINDOW);
  const isUp = direction === 'up';
  const basicPool = (isUp ? swingLows : swingHighs).filter((p) => p.idx >= n - RECENCY_WINDOW);
  const returnPool = (isUp ? swingHighs : swingLows).filter((p) => p.idx >= n - RECENCY_WINDOW);
  if (basicPool.length < 2 || !returnPool.length) return null;

  const basicP1 = basicPool[basicPool.length - 2];
  const basicP2 = basicPool[basicPool.length - 1];
  if (basicP2.idx === basicP1.idx) return null;

  const slope = (basicP2.price - basicP1.price) / (basicP2.idx - basicP1.idx);
  const basicValueAt = (barIdx: number): number => basicP1.price + slope * (barIdx - basicP1.idx);

  const returnAnchor = returnPool.reduce((best, p) =>
    (isUp ? p.price > best.price : p.price < best.price) ? p : best);
  const returnValueAt = (barIdx: number): number =>
    returnAnchor.price + slope * (barIdx - returnAnchor.idx);

  const latestOpposite = returnPool.filter((p) => p.idx > basicP2.idx).slice(-1)[0];
  if (!latestOpposite) return null;

  const boundaryValueThere = returnValueAt(latestOpposite.idx);
  const shortfall = isUp
    ? boundaryValueThere - latestOpposite.price
    : latestOpposite.price - boundaryValueThere;

  return {
    basicTrendline: {
      p1: { date: chart.dates[basicP1.idx], price: basicP1.price },
      p2: { date: chart.dates[basicP2.idx], price: basicP2.price },
      currentValue: basicValueAt(n - 1),
    },
    returnLine: {
      anchorDate: chart.dates[returnAnchor.idx],
      anchorPrice: returnAnchor.price,
      currentValue: returnValueAt(n - 1),
    },
    latestSwing: { date: chart.dates[latestOpposite.idx], price: latestOpposite.price },
    shortfall,
    projectedOvershoot: shortfall > 0 ? shortfall : null,
    direction,
  };
}

/** Re-exported for the pipeline, which passes a full Chart. */
export type AdditiveInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'dates' | 'volumes'>;
