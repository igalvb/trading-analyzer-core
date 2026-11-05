/**
 * Tier C, part 1: the four additive stop-loss methods.
 *
 * These are SEPARATE OPINIONS, not the stop the system acts on. Every one of
 * the four is annotated in the legacy source as "purely additive ... does not
 * affect stop/rrToT1/rrToT2", and the end-to-end fingerprint gate measured
 * that claim rather than trusting it: 375 verdicts identical with none of
 * this computed. They exist so the report can show four independent,
 * book-sourced answers to "where would a stop go?" next to the ATR stop the
 * plan actually uses.
 *
 *   classicalStop            Schabacker Study X   -- recent swing + ATR buffer
 *   basingPointStop          Edwards & Magee Ch27/28 -- Three Days Away
 *   alternateBasingPointStop Edwards & Magee Ch28 p443 -- deep retracement
 *   sidewaysBasingPointStop  Edwards & Magee Ch28 p443-444 -- shallow + sideways
 *
 * ══ TWO SHARED BLOCKS, EXTRACTED ═══════════════════════════════════════
 * The legacy code repeats the 6x3 stop-distance table and its tier lookup
 * VERBATIM in three of the four functions (:2289-2308, :2439-2454,
 * :2553-2568), and repeats the swing-point scan in all four. Extracted here
 * into stopFromTable() and swingPoints(). This is deduplication of identical
 * code, not a behaviour change -- and the parity test calls each of the four
 * public functions against the oracle rather than testing the helpers alone,
 * so an accidental divergence in the shared block fails loudly.
 *
 * ══ TWO SHARP EDGES, REPRODUCED ════════════════════════════════════════
 * 1. SWING DETECTION IS NON-STRICT: `highs[i] === Math.max(...slice)`, not
 *    `>`. On a flat or stepped series every bar in the plateau qualifies.
 *    This is the same trap that produced a 90-touch level in the srLevels
 *    work, and it is reproduced exactly, not "fixed".
 * 2. A NULL BAR SUPPRESSES SWINGS SILENTLY: Math.max over a slice containing
 *    null yields NaN, and `x === NaN` is always false, so no swing point is
 *    recorded there. Also reproduced -- it is why these return null on
 *    gap-ridden series rather than throwing.
 */

import type { Chart } from '../../types/chart.ts';
import type { Indicators } from '../../types/indicators.ts';

/** The chart fields every stop method reads. */
export type StopInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'dates' | 'volumes'>;

/** Long-only in practice -- see the note on `direction` below. */
export type StopDirection = 'long' | 'short';

/**
 * `direction` is threaded through every function because the legacy
 * signatures take it, and the short branches are real, reachable code that
 * the parity tests exercise. The PIPELINE only ever passes 'long' (the three
 * call sites at :2977-2980 are all hardcoded 'long'), matching the user's
 * long-only mandate. Keeping the parameter means the short logic stays
 * verified instead of rotting as dead code.
 */

export interface SwingPoint {
  readonly idx: number;
  readonly price: number;
}

const SWING_WINDOW = 5;
/** "Recent, not archaeological" -- the file's own established bound (:2366). */
const RECENCY_WINDOW = 120;
const MIN_BARS = 20;

/**
 * Swing highs and lows by the centred-window test.
 *
 * `from` lets the two Ch28 methods restrict to the last RECENCY_WINDOW bars.
 * The legacy comment at :2344-2366 records WHY: an unbounded search found a
 * qualifying triple on 93.9%/94.7% of real AKAM/AMD checkpoints, which made
 * the signal meaningless. Bounding it dropped the rate to 65.9%/81.7%.
 */
export function swingPoints(
  c: StopInput,
  from: number,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const n = c.closes.length;
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = from; i < n - SWING_WINDOW; i++) {
    const hSlice = c.highs.slice(i - SWING_WINDOW, i + SWING_WINDOW + 1);
    const lSlice = c.lows.slice(i - SWING_WINDOW, i + SWING_WINDOW + 1);
    // Non-strict by design, and NaN-poisoned by a null bar. See the header.
    if (c.highs[i] === Math.max(...hSlice)) highs.push({ idx: i, price: c.highs[i] as number });
    if (c.lows[i] === Math.min(...lSlice)) lows.push({ idx: i, price: c.lows[i] as number });
  }
  return { highs, lows };
}

export type SensitivityTier = 'conservative' | 'median' | 'speculative';

/**
 * The 6-price-tier x 3-sensitivity-tier stop-distance table, Edwards & Magee
 * Ch27 p436-438, reused verbatim.
 *
 * The sensitivity tier uses this project's own atrRatio as the
 * Sensitivity-Index/beta proxy. That substitution is the book editor's own
 * ("read 'beta' for 'Sensitivity Index'", Appendix A p612), not an invention
 * of this codebase.
 *
 * Note the row lookup is `price >= r.min` against a descending list, so a
 * NaN price matches nothing and falls through to the last (widest) row --
 * reproduced rather than guarded, because that is what legacy does.
 */
const STOP_TABLE: ReadonlyArray<{ min: number; pct: readonly [number, number, number] }> = [
  { min: 100, pct: [0.05, 0.05, 0.05] },
  { min: 40, pct: [0.05, 0.05, 0.06] },
  { min: 20, pct: [0.05, 0.06, 0.08] },
  { min: 10, pct: [0.05, 0.07, 0.10] },
  { min: 5, pct: [0.05, 0.07, 0.12] },
  { min: 0, pct: [0.05, 0.10, 0.15] },
];

const TIER_NAMES: readonly SensitivityTier[] = ['conservative', 'median', 'speculative'];

export interface TableStop {
  readonly level: number;
  readonly stopPct: number;
  readonly sensitivityTier: SensitivityTier;
}

/** The shared tail of the three Edwards & Magee basing-point methods. */
function stopFromTable(price: number, ind: Indicators | null, direction: StopDirection): TableStop {
  const beta = ind && ind.atrRatio != null ? ind.atrRatio : 1.0;
  const tier = beta < 0.75 ? 0 : beta > 1.25 ? 2 : 1;
  const row = STOP_TABLE.find((r) => price >= r.min) ?? (STOP_TABLE[STOP_TABLE.length - 1] as (typeof STOP_TABLE)[number]);
  // Explicit 5% floor (p438). Already true of every row; kept as the source
  // keeps it, defence in depth.
  const stopPct = Math.max(0.05, row.pct[tier] as number);
  const level = direction === 'short' ? price * (1 + stopPct) : price * (1 - stopPct);
  return { level, stopPct, sensitivityTier: TIER_NAMES[tier] as SensitivityTier };
}

/**
 * "Three Days Away" (Ch28 p441): a candidate low is confirmed once three
 * CONSECUTIVE later days trade entirely above it (mirrored for a high).
 *
 * Returns the index of the confirming bar, or -1. The streak RESETS on any
 * non-qualifying day -- it is three consecutive, not three cumulative, and
 * that distinction is the whole point of the rule.
 */
function threeDaysAway(
  c: StopInput,
  fromIdx: number,
  price: number,
  direction: StopDirection,
): number {
  const n = c.closes.length;
  let streak = 0;
  for (let j = fromIdx + 1; j < n; j++) {
    const qualifies = direction === 'short' ? (c.highs[j] as number) < price : (c.lows[j] as number) > price;
    if (qualifies) {
      streak++;
      if (streak === 3) return j;
    } else {
      streak = 0;
    }
  }
  return -1;
}

// ── 1. Classical stop (Schabacker Study X) ─────────────────────────────

export interface ClassicalStop {
  readonly level: number;
  readonly basingPointDate: Date;
  readonly basingPointPrice: number;
  readonly method: 'classical';
  readonly direction: StopDirection;
}

/**
 * A stop anchored to the most recent real swing point plus an ATR-scaled
 * buffer, then nudged off the nearest round number.
 *
 * The round-number nudge is the book's own observation that shake-outs tend
 * to stop right at round figures, so the level is pushed slightly FURTHER
 * away -- never exactly onto one. The step is price-scaled ($5 above $50,
 * $1 above $10, else $0.50).
 *
 * Takes the most recent qualifying swing with NO confirmation requirement,
 * unlike the three Ch28 methods below. That is the real difference between
 * Schabacker's method and Edwards & Magee's, not an oversight.
 */
export function computeClassicalStop(
  chart: StopInput,
  ind: Indicators | null,
  direction: StopDirection,
): ClassicalStop | null {
  const n = chart.closes ? chart.closes.length : 0;
  if (n < MIN_BARS) return null;

  const swings = swingPoints(chart, SWING_WINDOW);
  const pts = direction === 'short' ? swings.highs : swings.lows;
  if (!pts.length) return null;

  const basingPoint = pts[pts.length - 1] as SwingPoint;
  const BASE_STOP_PCT = 0.05;
  // atrRatio clamped to [0.5, 2.0]: a quiet stock still gets a real buffer,
  // and a violently volatile one cannot widen the stop without limit.
  const atrScale = ind && ind.atrRatio != null ? Math.max(0.5, Math.min(2.0, ind.atrRatio)) : 1.0;
  const bufferPct = BASE_STOP_PCT * atrScale;
  let level =
    direction === 'short' ? basingPoint.price * (1 + bufferPct) : basingPoint.price * (1 - bufferPct);

  const ROUND_STEP = level >= 50 ? 5 : level >= 10 ? 1 : 0.5;
  const nearestRound = Math.round(level / ROUND_STEP) * ROUND_STEP;
  const ROUND_AVOID_MARGIN = ROUND_STEP * 0.1;
  if (Math.abs(level - nearestRound) < ROUND_AVOID_MARGIN) {
    level = direction === 'short' ? nearestRound + ROUND_AVOID_MARGIN : nearestRound - ROUND_AVOID_MARGIN;
  }

  return {
    level,
    basingPointDate: chart.dates[basingPoint.idx] as Date,
    basingPointPrice: basingPoint.price,
    method: 'classical',
    direction,
  };
}

// ── 2-4. The three Edwards & Magee basing-point methods ────────────────

export interface BasingPointStop extends TableStop {
  readonly basingPointDate: Date;
  readonly basingPointPrice: number;
  readonly method: 'basingPoint' | 'alternateBasingPoint' | 'sidewaysBasingPoint';
  readonly direction: StopDirection;
}

/**
 * The primary basing point: the most recent swing point CONFIRMED by Three
 * Days Away.
 *
 * Scans swing points newest-first and takes the first confirmed one, so an
 * older confirmed point never wins over a newer confirmed one.
 */
export function computeBasingPointStop(
  chart: StopInput,
  ind: Indicators | null,
  direction: StopDirection,
): BasingPointStop | null {
  const n = chart.closes ? chart.closes.length : 0;
  if (n < MIN_BARS) return null;

  const swings = swingPoints(chart, SWING_WINDOW);
  const pts = direction === 'short' ? swings.highs : swings.lows;
  if (!pts.length) return null;

  let basingPoint: SwingPoint | null = null;
  for (let s = pts.length - 1; s >= 0; s--) {
    const p = pts[s] as SwingPoint;
    if (threeDaysAway(chart, p.idx, p.price, direction) >= 0) {
      basingPoint = p;
      break;
    }
  }
  if (!basingPoint) return null;

  return {
    ...stopFromTable(basingPoint.price, ind, direction),
    basingPointDate: chart.dates[basingPoint.idx] as Date,
    basingPointPrice: basingPoint.price,
    method: 'basingPoint',
    direction,
  };
}

/**
 * The second basing-point-creation path (Ch28 p443): a primary move of >=15%
 * followed by a retracement of >=40%, with the resumption confirmed by Three
 * Days Away.
 *
 * Geometry for a long: swing low L, then the HIGHEST swing high H after it
 * (>=15% up from L), then the LOWEST swing low R after H (>=40% of the L->H
 * range given back). R is the basing point.
 *
 * Note the extremes are picked by `reduce`, so H is the highest high after L
 * and R the lowest low after H -- not the nearest. That makes the test
 * "did this stock ever retrace 40% of its best run" rather than "did the
 * next wiggle retrace 40%", and it is reproduced as written.
 */
export function computeAlternateBasingPoint(
  chart: StopInput,
  ind: Indicators | null,
  direction: StopDirection,
): BasingPointStop | null {
  const n = chart.closes ? chart.closes.length : 0;
  if (n < MIN_BARS) return null;

  const { highs: swingHighs, lows: swingLows } = swingPoints(
    chart, Math.max(SWING_WINDOW, n - RECENCY_WINDOW),
  );
  const MIN_PRIMARY_MOVE = 0.15;
  const MIN_RETRACEMENT = 0.40;
  let best: SwingPoint | null = null;

  if (direction === 'short') {
    for (const H of swingHighs) {
      const laterLows = swingLows.filter((l) => l.idx > H.idx);
      if (!laterLows.length) continue;
      const L = laterLows.reduce((worst, l) => (l.price < worst.price ? l : worst), laterLows[0] as SwingPoint);
      if ((H.price - L.price) / H.price < MIN_PRIMARY_MOVE) continue;
      const laterHighs = swingHighs.filter((h) => h.idx > L.idx);
      if (!laterHighs.length) continue;
      const R = laterHighs.reduce((b, h) => (h.price > b.price ? h : b), laterHighs[0] as SwingPoint);
      if ((R.price - L.price) / (H.price - L.price) < MIN_RETRACEMENT) continue;
      if (threeDaysAway(chart, R.idx, R.price, 'short') < 0) continue;
      if (!best || R.idx > best.idx) best = R;
    }
  } else {
    for (const L of swingLows) {
      const laterHighs = swingHighs.filter((h) => h.idx > L.idx);
      if (!laterHighs.length) continue;
      const H = laterHighs.reduce((b, h) => (h.price > b.price ? h : b), laterHighs[0] as SwingPoint);
      if ((H.price - L.price) / L.price < MIN_PRIMARY_MOVE) continue;
      const laterLows = swingLows.filter((l) => l.idx > H.idx);
      if (!laterLows.length) continue;
      const R = laterLows.reduce((worst, l) => (l.price < worst.price ? l : worst), laterLows[0] as SwingPoint);
      if ((H.price - R.price) / (H.price - L.price) < MIN_RETRACEMENT) continue;
      if (threeDaysAway(chart, R.idx, R.price, 'long') < 0) continue;
      if (!best || R.idx > best.idx) best = R;
    }
  }
  if (!best) return null;

  return {
    ...stopFromTable(best.price, ind, direction),
    basingPointDate: chart.dates[best.idx] as Date,
    basingPointPrice: best.price,
    method: 'alternateBasingPoint',
    direction,
  };
}

/**
 * The third and final basing-point-creation path (Ch28 p443-444): a primary
 * move of >=15%, a SHALLOW retracement (<40%), and a sideways band on
 * declining volume.
 *
 * Deliberately the complement of computeAlternateBasingPoint: that one wants
 * >=40% given back, this one wants <40% plus evidence the stock is marking
 * time instead. The two are mutually exclusive by construction.
 *
 * The basing point here is the sideways band's AVERAGE CLOSE, not a swing
 * price -- the only one of the four whose `basingPointPrice` is not an actual
 * traded high or low.
 */
export function computeSidewaysBasingPoint(
  chart: StopInput,
  ind: Indicators | null,
  direction: StopDirection,
): BasingPointStop | null {
  const closes = chart.closes;
  const volumes = chart.volumes;
  const n = closes ? closes.length : 0;
  if (n < MIN_BARS || !volumes) return null;

  const MIN_PRIMARY_MOVE = 0.15;
  const MAX_RETRACEMENT = 0.40;
  const LEVEL_TOLERANCE = 0.03;
  const SIDEWAYS_WINDOW = 5;

  const { highs: swingHighs, lows: swingLows } = swingPoints(
    chart, Math.max(SWING_WINDOW, n - RECENCY_WINDOW),
  );

  /** Mean volume over an inclusive index range, skipping null bars. */
  function avgVol(a: number, b: number): number | null {
    if (b < a) return null;
    let s = 0;
    let count = 0;
    for (let k = a; k <= b; k++) {
      if (volumes[k] != null) {
        s += volumes[k] as number;
        count++;
      }
    }
    return count ? s / count : null;
  }

  /**
   * The "marks time at the same level" proxy: the first run of
   * SIDEWAYS_WINDOW consecutive closes whose spread is within
   * LEVEL_TOLERANCE of their own mean, on volume below the primary move's.
   */
  function findSidewaysBand(
    startIdx: number,
    primaryAvgVol: number | null,
  ): { endIdx: number; level: number } | null {
    for (let s = startIdx; s <= n - SIDEWAYS_WINDOW; s++) {
      const band = closes.slice(s, s + SIDEWAYS_WINDOW);
      const bandAvg = band.reduce((a, b) => a + b, 0) / band.length;
      const spread = (Math.max(...band) - Math.min(...band)) / bandAvg;
      if (spread > LEVEL_TOLERANCE) continue;
      const bandVolAvg = avgVol(s, s + SIDEWAYS_WINDOW - 1);
      if (bandVolAvg == null || primaryAvgVol == null || bandVolAvg >= primaryAvgVol) continue;
      return { endIdx: s + SIDEWAYS_WINDOW - 1, level: bandAvg };
    }
    return null;
  }

  let best: SwingPoint | null = null;

  if (direction === 'short') {
    for (const H of swingHighs) {
      const laterLows = swingLows.filter((l) => l.idx > H.idx);
      if (!laterLows.length) continue;
      const L = laterLows.reduce((worst, l) => (l.price < worst.price ? l : worst), laterLows[0] as SwingPoint);
      if ((H.price - L.price) / H.price < MIN_PRIMARY_MOVE) continue;
      const band = findSidewaysBand(L.idx, avgVol(H.idx, L.idx));
      if (!band) continue;
      if ((band.level - L.price) / (H.price - L.price) >= MAX_RETRACEMENT) continue;
      if (threeDaysAway(chart, band.endIdx, band.level, 'short') < 0) continue;
      if (!best || band.endIdx > best.idx) best = { idx: band.endIdx, price: band.level };
    }
  } else {
    for (const L of swingLows) {
      const laterHighs = swingHighs.filter((h) => h.idx > L.idx);
      if (!laterHighs.length) continue;
      const H = laterHighs.reduce((b, h) => (h.price > b.price ? h : b), laterHighs[0] as SwingPoint);
      if ((H.price - L.price) / L.price < MIN_PRIMARY_MOVE) continue;
      const band = findSidewaysBand(H.idx, avgVol(L.idx, H.idx));
      if (!band) continue;
      if ((H.price - band.level) / (H.price - L.price) >= MAX_RETRACEMENT) continue;
      if (threeDaysAway(chart, band.endIdx, band.level, 'long') < 0) continue;
      if (!best || band.endIdx > best.idx) best = { idx: band.endIdx, price: band.level };
    }
  }
  if (!best) return null;

  return {
    ...stopFromTable(best.price, ind, direction),
    basingPointDate: chart.dates[best.idx] as Date,
    basingPointPrice: best.price,
    method: 'sidewaysBasingPoint',
    direction,
  };
}
