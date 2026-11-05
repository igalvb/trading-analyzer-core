/**
 * Position exit reads: "I already own this -- now what?"
 *
 *   computePositionExitRead              (:9772-9844)
 *   computePositionExitReadFixedLookback (:9936-9986)
 *   computeClassicalStopTrailing         (:2154-2212)
 *   turtlePyramidLadderForRealEntry      (turtleModelV1.gs:132-163)
 *
 * The buy engine answers "should I enter and where". These answer the
 * different question of what to do with a position that already exists, and
 * they are the engine's only EXIT-framed output -- everything in
 * decision.ts is buy-framed by construction.
 *
 * ══ TWO VARIANTS, AND WHY BOTH EXIST ═══════════════════════════════════
 * The difference is the trailing stop's anchor, and it is not cosmetic:
 *
 *   since-entry     highest high since YOUR actual entry bar
 *   fixed-lookback  highest high over the last 800 trading days
 *
 * The since-entry read is the real one. The fixed-lookback variant exists
 * only because the Portfolio sheet's two sub-tables often have no entry
 * date on file, and 800 was the user's own stated number. Every reason
 * string it produces says so explicitly -- it never passes itself off as a
 * since-entry calculation.
 *
 * ══ ONE STRUCTURAL CHANGE: THE CHART IS REQUIRED ═══════════════════════
 * Legacy does `existingChart || fetchYahooChart(ticker)`, so a network
 * fetch hides inside an analysis function. Here `chart` is a required
 * parameter. Same reasoning as macroRead in decision.ts: fetching belongs
 * in the data layer, and a function that fetches cannot be tested. Both
 * legacy call sites at :10341-10344 already pass a chart, so no real caller
 * relied on the fallback.
 *
 * ══ VERIFIED ═══════════════════════════════════════════════════════════
 * Differentially against the oracle, with the oracle's chart passed to both
 * sides so the fetch difference cannot mask anything.
 */

import type { Chart } from '../types/chart.ts';
import type { Indicators } from '../types/indicators.ts';
import { computeTechnicalRead } from './pipeline.ts';
import { swingPoints, type StopDirection } from './techPlan/stops.ts';

/** The user's own stated number for the no-entry-date fallback (:9928). */
export const EXIT_GENERIC_LOOKBACK_TRADING_DAYS = 800;

const SWING_WINDOW = 5;
const BASE_STOP_PCT = 0.05;
/** Chandelier multiple: highest high minus 3 ATR. */
const CHANDELIER_ATR_MULT = 3;

// ── Schabacker "two days away" trailing stop ───────────────────────────

export interface TrailingShift {
  readonly date: Date;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly basingPointDate: Date;
  readonly basingPointPrice: number;
}

export interface ClassicalStopTrailing {
  readonly available: true;
  readonly currentLevel: number;
  readonly basingPointDate: Date;
  readonly basingPointPrice: number;
  readonly shiftCount: number;
  readonly shiftHistory: readonly TrailingShift[];
  readonly direction: StopDirection;
}

/**
 * The classical stop, walked FORWARD from entry one trading day at a time.
 *
 * This is the trailing counterpart to computeClassicalStop: that one gives
 * a single level from the latest swing, this one reconstructs the whole
 * history of how the stop would have ratcheted since entry.
 *
 * ══ THE CONFIRMATION LAG IS THE POINT ══════════════════════════════════
 * Two separate delays stack, and conflating them would make the walk
 * look-ahead biased:
 *
 *  1. A swing point at index `c` cannot be KNOWN until `c + 5`, because
 *     swing detection needs 5 bars on each side. So on day `d` the newest
 *     candidate that could possibly be known is `d - 5`.
 *  2. Schabacker's own rule then needs the TWO days after `c` to trade
 *     entirely on the favourable side before the stop may shift.
 *
 * The stop only ever moves in the favourable direction (`moreFavorable`),
 * so `shiftHistory` is monotonic by construction -- a trailing stop that
 * could loosen would not be a stop.
 *
 * Note the shift is dated `dates[c+2]` -- the day the confirmation
 * completed, not the day the swing occurred. That is the honest date: it is
 * when a real trader could have moved the order.
 */
export function computeClassicalStopTrailing(
  chart: Pick<Chart, 'closes' | 'highs' | 'lows' | 'dates'>,
  ind: Indicators | null,
  direction: StopDirection,
  entryIdx: number | null | undefined,
): ClassicalStopTrailing | null {
  const { closes, highs, lows, dates } = chart;
  const n = closes ? closes.length : 0;
  if (n < 20 || entryIdx == null || entryIdx < 0 || entryIdx >= n) return null;

  const atrScale = ind && ind.atrRatio != null ? Math.max(0.5, Math.min(2.0, ind.atrRatio)) : 1.0;
  const bufferPct = BASE_STOP_PCT * atrScale;
  const levelFromBasing = (price: number): number =>
    direction === 'short' ? price * (1 + bufferPct) : price * (1 - bufferPct);

  // Deliberately NOT swingPoints() from stops.ts: that returns a prebuilt
  // list, while this walk needs a point-wise test it can apply at an
  // arbitrary index, including indices outside that list's bounds. Same
  // non-strict `===` comparison though -- see the note in stops.ts.
  const isSwing = (i: number): boolean => {
    if (i < SWING_WINDOW || i >= n - SWING_WINDOW) return false;
    if (direction === 'short') {
      const s = highs.slice(i - SWING_WINDOW, i + SWING_WINDOW + 1);
      return highs[i] === Math.max(...s);
    }
    const s = lows.slice(i - SWING_WINDOW, i + SWING_WINDOW + 1);
    return lows[i] === Math.min(...s);
  };
  const moreFavorable = (candidate: number, current: number): boolean =>
    direction === 'short' ? candidate < current : candidate > current;

  // Initial basing point: the most recent qualifying swing AT OR BEFORE
  // entry. Bounded to the pre-entry window because this is a since-entry
  // walk -- seeding it from a later swing would be look-ahead.
  let basing: { idx: number; price: number } | null = null;
  for (let i = Math.min(entryIdx, n - SWING_WINDOW - 1); i >= SWING_WINDOW; i--) {
    if (isSwing(i)) {
      basing = { idx: i, price: direction === 'short' ? highs[i] : lows[i] };
      break;
    }
  }
  if (!basing) return null;

  let currentLevel = levelFromBasing(basing.price);
  const shiftHistory: TrailingShift[] = [];

  for (let d = entryIdx; d < n; d++) {
    const c = d - SWING_WINDOW;
    if (c < SWING_WINDOW || !isSwing(c)) continue;
    const candidatePrice = direction === 'short' ? highs[c] : lows[c];
    if (!moreFavorable(candidatePrice, basing.price)) continue;
    // c+1 and c+2 are guaranteed to exist: isSwing bounds c < n-5.
    const day1OK = direction === 'short' ? highs[c + 1] < candidatePrice : lows[c + 1] > candidatePrice;
    const day2OK = direction === 'short' ? highs[c + 2] < candidatePrice : lows[c + 2] > candidatePrice;
    if (!day1OK || !day2OK) continue;
    const newLevel = levelFromBasing(candidatePrice);
    if (!moreFavorable(newLevel, currentLevel)) continue;
    shiftHistory.push({
      date: dates[c + 2], fromLevel: currentLevel, toLevel: newLevel,
      basingPointDate: dates[c], basingPointPrice: candidatePrice,
    });
    basing = { idx: c, price: candidatePrice };
    currentLevel = newLevel;
  }

  return {
    available: true, currentLevel,
    basingPointDate: dates[basing.idx], basingPointPrice: basing.price,
    shiftCount: shiftHistory.length, shiftHistory, direction,
  };
}

// ── Turtle pyramid ladder ──────────────────────────────────────────────

/** Entry minus 2N, from the "1N = 1% of equity" rule (p693-694). */
const TURTLE_STOP_N = 2;
/** Add one unit per 0.5N of favourable movement (p691-692). */
const TURTLE_PYRAMID_STEP_N = 0.5;
/** Max units in a single market (p690-692). */
const TURTLE_MAX_UNITS = 4;

export interface TurtleUnitFill {
  readonly idx: number;
  readonly price: number;
}

export type TurtlePyramid =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true;
    readonly n: number;
    readonly units: number;
    readonly unitFills: readonly TurtleUnitFill[];
    readonly stop: number;
    readonly stoppedOut: boolean;
    readonly stoppedOutIdx: number | null;
    readonly nextAddTrigger: number | null;
  };

/**
 * Wilder-smoothed true range, the same N series ind.turtleN uses.
 *
 * Inlined rather than imported because the legacy function reaches for the
 * global `wilderArray` with a 20-period window and its own index offset
 * convention (`nAt`), and reproducing that offset exactly matters more than
 * sharing code -- an off-by-one here silently shifts every add trigger.
 */
function wilderArray(values: readonly number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

/**
 * The 0.5N pyramid-add and 2N stop-convergence ladder for a REAL entry.
 *
 * Deliberately NOT conditional on the entry having been a genuine Turtle
 * channel breakout: the book's add/stop mechanics are general position
 * management, so they apply to a position however it was opened.
 *
 * Each add moves the stop up to `addTrigger - 2N`, so the stop converges on
 * price as units accumulate. The stop check runs BEFORE the add check in
 * each bar, and uses `lows[i] <= stop` -- the at-or-through fill convention,
 * matching the simulator. A bar that would both stop out and trigger an add
 * therefore stops out, which is the conservative reading.
 *
 * Long-only, matching the user's standing strategy.
 */
export function turtlePyramidLadderForRealEntry(
  chart: Pick<Chart, 'closes' | 'highs' | 'lows'>,
  entryIdx: number | null | undefined,
  entryPrice: number,
): TurtlePyramid {
  const highs = chart && chart.highs;
  const lows = chart && chart.lows;
  const closes = chart && chart.closes;
  const n = (closes || []).length;
  if (entryIdx == null || entryIdx < 0 || entryIdx >= n
    || !Number.isFinite(entryPrice) || !(entryPrice > 0)) {
    return { available: false, note: 'Invalid entry index/price for this chart.' };
  }

  const trArr: number[] = [];
  for (let i = 1; i < n; i++) {
    trArr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  const nSeries = wilderArray(trArr, 20);
  const nAt = (i: number): number | null =>
    i >= 20 && i - 20 < nSeries.length ? nSeries[i - 20] : null;

  const N = nAt(entryIdx);
  if (N == null || !(N > 0)) {
    return {
      available: false,
      note: 'N unavailable at the entry date (insufficient real price history before entry).',
    };
  }

  const units: TurtleUnitFill[] = [{ idx: entryIdx, price: entryPrice }];
  let stop = entryPrice - TURTLE_STOP_N * N;
  let stoppedOutIdx: number | null = null;

  for (let i = entryIdx + 1; i < n; i++) {
    if (lows[i] <= stop) {
      stoppedOutIdx = i;
      break;
    }
    if (units.length < TURTLE_MAX_UNITS) {
      const lastUnit = units[units.length - 1];
      const addTrigger = lastUnit.price + TURTLE_PYRAMID_STEP_N * N;
      if (highs[i] >= addTrigger) {
        units.push({ idx: i, price: addTrigger });
        stop = addTrigger - TURTLE_STOP_N * N;
      }
    }
  }

  return {
    available: true, n: N, units: units.length, unitFills: units, stop,
    stoppedOut: stoppedOutIdx != null, stoppedOutIdx,
    nextAddTrigger: stoppedOutIdx == null && units.length < TURTLE_MAX_UNITS
      ? units[units.length - 1].price + TURTLE_PYRAMID_STEP_N * N
      : null,
  };
}

// ── The two exit reads ─────────────────────────────────────────────────

export type ExitRecommendation =
  | 'STOP HIT — EXIT'
  | 'THESIS INVALIDATED — CONSIDER EXIT'
  | 'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST'
  | 'T1 REACHED — CONSIDER PARTIAL PROFITS'
  | 'HOLD';

export interface ExitReadError {
  readonly error: string;
}

/**
 * F-X1: forward-looking targets. Default (nothing set) = FIXED: hitT1/hitT2 mean
 * the CURRENT price is at or above the target. `legacyHistoricalTargets: true`
 * (or `forwardTargets: false`) restores the old comparison with the highest high
 * since entry, exactly, for oracle parity.
 */
export interface ExitReadOptions {
  readonly forwardTargets?: boolean;
  readonly legacyHistoricalTargets?: boolean;
  /** Fix plan B1/D2 research option (techPlan/entryPlan.ts ExitTargetOptions): nearest-cluster T1/T2. Default off. */
  readonly nearestTargets?: boolean;
  /** Fix plan B1 option B part 2 (ExitTargetOptions.fixedT2): T2 skips the excluded methods. */
  readonly fixedT2?: boolean;
  /** Owner 2026-11-05 (profile exit.weeklyStops): also return the engine's exit-method levels (`exitCandidates`) for the coherent-target check. Default off. */
  readonly weeklyStops?: boolean;
}
/** The non-excluded confluence exit-method prices (weeklyStops only). */
function exitCandidatesOf(technical: { confluence?: { allExitMethods?: ReadonlyArray<{ price?: unknown; excluded?: boolean }> } | null }): number[] {
  const all = technical.confluence?.allExitMethods ?? [];
  return all.filter((m) => !m.excluded && typeof m.price === 'number' && Number.isFinite(m.price)).map((m) => m.price as number);
}
/** The exit-target options an exit read passes to the technical read (only the set ones). */
function targetOptionsOf(o: ExitReadOptions): { nearestTargets?: boolean; fixedT2?: boolean } {
  return { ...(o.nearestTargets ? { nearestTargets: true } : {}), ...(o.fixedT2 ? { fixedT2: true } : {}) };
}
export function useLegacyTargets(o?: ExitReadOptions | null): boolean {
  return !!o && (o.legacyHistoricalTargets === true || o.forwardTargets === false);
}
/** Percent of the current price: (target - cp) / cp * 100. Positive = target still above price. */
export function distanceToTargetPct(cp: number, target: number | null): number | null {
  return target == null || !(cp > 0) ? null : ((target - cp) / cp) * 100;
}
/** The one place the T1/T2 trigger is decided. legacy compares the peak, fixed compares the current price. */
export function evaluateTargetHits(
  cp: number, peak: number, t1: number | null, t2: number | null, legacy: boolean,
): { hitT1: boolean; hitT2: boolean } {
  const ref = legacy ? peak : cp;
  return { hitT1: t1 != null && ref >= t1, hitT2: t2 != null && ref >= t2 };
}
function holdTargetNote(cp: number, t1: number | null, t2: number | null): string {
  const parts: string[] = [];
  for (const [label, t] of [['T1', t1], ['T2', t2]] as Array<[string, number | null]>) {
    const d = distanceToTargetPct(cp, t);
    if (t != null && d != null) parts.push(label + ' is $' + t.toFixed(2) + ' (' + Math.abs(d).toFixed(1) + '% ' + (d > 0 ? 'above' : 'below') + ' the current price)');
  }
  return parts.length ? ' ' + parts.join('; ') + '.' : '';
}

export interface PositionExitRead {
  readonly error: null;
  readonly ticker: string;
  readonly entryPrice: number;
  readonly entryDateStr: string;
  readonly cp: number;
  readonly unrealizedPct: number;
  readonly daysHeld: number;
  readonly highestHighSinceEntry: number;
  readonly chandelierSinceEntry: number;
  readonly stopBreached: boolean;
  readonly classicalTrailing: ClassicalStopTrailing | null;
  readonly turtlePyramid: TurtlePyramid | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly hitT1: boolean;
  readonly hitT2: boolean;
  readonly thesisInvalidated: boolean;
  readonly recommendation: ExitRecommendation;
  readonly reason: string;
  /** F-X1, fixed mode only (absent under legacyHistoricalTargets). Percent above (+) or below (-) the current price. */
  readonly distanceToT1Pct?: number | null;
  readonly distanceToT2Pct?: number | null;
  /** weeklyStops only: the engine's exit-method levels. */
  readonly exitCandidates?: readonly number[];
}

/**
 * The recommendation ladder, in priority order.
 *
 * ORDER IS THE CONTRACT. A position can be several of these at once -- past
 * T2 and also stopped out, for instance -- and the first match wins. Stop
 * before thesis before T2 before T1 means risk always outranks reward: a
 * stopped-out winner reads STOP HIT, not T2 REACHED.
 *
 * F-X1 (FIXED, default): hitT1/hitT2 now mean the CURRENT price is at or above
 * the target; highestHighSinceEntry is information only. The text below
 * describes the LEGACY behaviour, kept under legacyHistoricalTargets.
 *
 * `hitT1`/`hitT2` are evaluated against the HIGHEST HIGH since entry, not
 * the current price, so "reached T1 then gave it all back" still reports
 * T1 as reached. That is deliberate and it is why the field is named
 * highestHighSinceEntry rather than anything about today.
 *
 * ══ FLAGGED (F-16): THE STOP RUNG DOMINATES THE PROFIT RUNGS ═══════════
 * Measured over 792 real exit reads (27 fixtures x 3 lengths x 10 entry
 * points), the distribution is:
 *
 *   582  STOP HIT — EXIT                      (73%)
 *   153  HOLD                                 (19%)
 *    44  T1 REACHED — CONSIDER PARTIAL PROFITS (5.6%)
 *    13  THESIS INVALIDATED — CONSIDER EXIT    (1.6%)
 *     0  T2 REACHED — ...                      (0%)
 *
 * The targets ARE being reached -- hitT1 was true 553 times and hitT2 305
 * times. They are almost never REPORTED: T1 surfaced in 44 of 553 cases
 * (8%), and T2 in 0 of 305. Every one of those 305 T2 hits was shadowed by
 * stopBreached; not one by AVOID.
 *
 * The cause is structural, not a tuning accident. `hitT1`/`hitT2` compare a
 * HISTORICAL MAXIMUM (highest high since entry) against targets recomputed
 * from TODAY's price, while `stopBreached` compares today's price against
 * that same maximum minus 3 ATR. Any position that ran up far enough to tag
 * a target and then gave back more than 3 ATR trips the stop rung, which
 * sits above both profit rungs. So the user is told "stopped out" rather
 * than "you reached your first target" in 509 of 553 real cases.
 *
 * Reproduced exactly, NOT fixed -- the ladder order is the legacy contract
 * and risk-before-reward is defensible on its own terms. Flagged because
 * the consequence is invisible from reading the code and changes what the
 * user is actually told.
 */
export function exitRecommendation(
  stopBreached: boolean, thesisInvalidated: boolean, hitT2: boolean, hitT1: boolean,
): ExitRecommendation {
  if (stopBreached) return 'STOP HIT — EXIT';
  if (thesisInvalidated) return 'THESIS INVALIDATED — CONSIDER EXIT';
  if (hitT2) return 'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST';
  if (hitT1) return 'T1 REACHED — CONSIDER PARTIAL PROFITS';
  return 'HOLD';
}

/**
 * The real exit read, anchored to an actual entry date.
 *
 * Three distinct error returns, all reproduced verbatim because they are
 * user-facing: a bad entry price, an entry date after all data, and an
 * entry date BEFORE the fetched history. That third one matters -- legacy
 * refuses rather than silently computing a highest-high over a window that
 * does not include the real entry, and it says so.
 */
export function computePositionExitRead(
  ticker: string,
  entryPrice: number,
  entryDateStr: string,
  chart: Chart,
  opts: ExitReadOptions = {},
): PositionExitRead | ExitReadError {
  if (typeof entryPrice !== 'number' || isNaN(entryPrice) || entryPrice <= 0) {
    return { error: 'Entry price must be a valid positive number (e.g. 150.25). Got: ' + entryPrice };
  }
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };
  const { dates, closes, highs } = chart;

  const entryDate = new Date(entryDateStr);
  const entryIdx = dates.findIndex((d) => d.getTime() >= entryDate.getTime());
  if (entryIdx === -1) return { error: 'Entry date is after all available data.' };
  if (entryIdx === 0 && dates[0].getTime() > entryDate.getTime()) {
    return {
      error: 'Entry date is before the available price history for this ticker (this file fetches '
        + '2yr of history) -- the highest-high-since-entry calculation would be inaccurate. '
        + 'Real limitation, not silently ignored.',
    };
  }

  const technical = opts.nearestTargets || opts.fixedT2 ? computeTechnicalRead(chart, null, null, {}, targetOptionsOf(opts)) : computeTechnicalRead(chart);
  const ind = technical.indicators;
  const cp = closes[closes.length - 1];
  const unrealizedPct = (cp - entryPrice) / entryPrice;
  const daysHeld = Math.round(
    (dates[dates.length - 1].getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  const highestHighSinceEntry = Math.max(...highs.slice(entryIdx));
  const chandelierSinceEntry = highestHighSinceEntry - CHANDELIER_ATR_MULT * (ind.atr14 as number);
  const stopBreached = cp < chandelierSinceEntry;

  const classicalTrailing = computeClassicalStopTrailing(chart, ind, 'long', entryIdx);
  const turtlePyramid = turtlePyramidLadderForRealEntry(chart, entryIdx, entryPrice);

  const t1 = technical.entryPlan.t1 ? technical.entryPlan.t1.price : null;
  const t2 = technical.entryPlan.t2 ? technical.entryPlan.t2.price : null;
  const legacy = useLegacyTargets(opts);
  const { hitT1, hitT2 } = evaluateTargetHits(cp, highestHighSinceEntry, t1, t2, legacy);
  const thesisInvalidated = technical.entryPlan.timing === 'AVOID';

  const recommendation = exitRecommendation(stopBreached, thesisInvalidated, hitT2, hitT1);
  let reason: string;
  if (stopBreached) {
    reason = 'Price ($' + cp.toFixed(2) + ') is below the trailing stop ($'
      + chandelierSinceEntry.toFixed(2) + '), based on the highest high since your actual entry, '
      + 'not a generic lookback.';
  } else if (thesisInvalidated) {
    reason = 'The engine now reads AVOID on this ticker — a real change since you entered.';
  } else if (hitT2) {
    reason = legacy
      ? 'Price reached the current T2 target ($' + (t2 as number).toFixed(2) + ') at some point since entry.'
      : 'Price ($' + cp.toFixed(2) + ') is at or above the current T2 target ($' + (t2 as number).toFixed(2) + ').';
  } else if (hitT1) {
    reason = legacy
      ? 'Price reached the current T1 target ($' + (t1 as number).toFixed(2)
        + ') — the normal, designed point for a first partial exit.'
      : 'Price ($' + cp.toFixed(2) + ') is at or above the current T1 target ($' + (t1 as number).toFixed(2)
        + ') — the normal, designed point for a first partial exit.';
  } else {
    reason = 'No stop breach, no thesis change, targets not yet reached.' + (legacy ? '' : holdTargetNote(cp, t1, t2));
  }

  return {
    error: null, ticker, entryPrice, entryDateStr, cp, unrealizedPct, daysHeld,
    highestHighSinceEntry, chandelierSinceEntry, stopBreached,
    classicalTrailing, turtlePyramid, t1, t2, hitT1, hitT2, thesisInvalidated,
    recommendation, reason,
    ...(legacy ? {} : { distanceToT1Pct: distanceToTargetPct(cp, t1), distanceToT2Pct: distanceToTargetPct(cp, t2) }),
    ...(opts.weeklyStops ? { exitCandidates: exitCandidatesOf(technical) } : {}),
  };
}

export interface FixedLookbackExitRead {
  readonly error: null;
  readonly ticker: string;
  readonly entryPrice: number;
  readonly cp: number;
  readonly unrealizedPct: number;
  readonly lookbackTradingDays: number;
  readonly highestHighInWindow: number;
  readonly chandelierGeneric: number;
  readonly stopBreached: boolean;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly hitT1: boolean;
  readonly hitT2: boolean;
  readonly thesisInvalidated: boolean;
  readonly recommendation: ExitRecommendation;
  readonly reason: string;
  /** F-X1, fixed mode only. Percent above (+) or below (-) the current price. */
  readonly distanceToT1Pct?: number | null;
  readonly distanceToT2Pct?: number | null;
  /** weeklyStops only: the engine's exit-method levels. */
  readonly exitCandidates?: readonly number[];
}

/**
 * The fallback read for a position with no entry date on file.
 *
 * Returns NEITHER `daysHeld` nor the two trailing-stop opinions, and that
 * is correct rather than an omission: without an entry date there is no
 * holding period to report and no entry bar to walk forward from. A
 * fabricated entry index would produce a confident, wrong ladder.
 *
 * Every reason string names the lookback window explicitly and the stop
 * path adds "NOT since your actual entry (no entry date on file; add one to
 * switch to the real since-entry calc)". The user is told which of the two
 * reads they are looking at, every time.
 */
export function computePositionExitReadFixedLookback(
  ticker: string,
  entryPrice: number,
  chart: Chart,
  lookbackTradingDays?: number | null,
  opts: ExitReadOptions = {},
): FixedLookbackExitRead | ExitReadError {
  // `||` not `??`, matching legacy: an explicit 0 falls back to 800 rather
  // than producing an empty window.
  const lookback = lookbackTradingDays || EXIT_GENERIC_LOOKBACK_TRADING_DAYS;
  if (typeof entryPrice !== 'number' || isNaN(entryPrice) || entryPrice <= 0) {
    return { error: 'Entry price (avg cost) must be a valid positive number. Got: ' + entryPrice };
  }
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };
  const { closes, highs } = chart;

  const technical = opts.nearestTargets || opts.fixedT2 ? computeTechnicalRead(chart, null, null, {}, targetOptionsOf(opts)) : computeTechnicalRead(chart);
  const ind = technical.indicators;
  const cp = closes[closes.length - 1];
  const unrealizedPct = (cp - entryPrice) / entryPrice;

  const lookbackStart = Math.max(0, highs.length - lookback);
  const highestHighInWindow = Math.max(...highs.slice(lookbackStart));
  const chandelierGeneric = highestHighInWindow - CHANDELIER_ATR_MULT * (ind.atr14 as number);
  const stopBreached = cp < chandelierGeneric;

  const t1 = technical.entryPlan.t1 ? technical.entryPlan.t1.price : null;
  const t2 = technical.entryPlan.t2 ? technical.entryPlan.t2.price : null;
  const legacy = useLegacyTargets(opts);
  const { hitT1, hitT2 } = evaluateTargetHits(cp, highestHighInWindow, t1, t2, legacy);
  const thesisInvalidated = technical.entryPlan.timing === 'AVOID';

  const recommendation = exitRecommendation(stopBreached, thesisInvalidated, hitT2, hitT1);
  let reason: string;
  if (stopBreached) {
    reason = 'Price ($' + cp.toFixed(2) + ') is below the trailing stop ($'
      + chandelierGeneric.toFixed(2) + '), based on the highest high over the last ' + lookback
      + ' trading days -- a generic lookback, NOT since your actual entry (no entry date on file; '
      + 'add one to switch to the real since-entry calc).';
  } else if (thesisInvalidated) {
    reason = 'The engine now reads AVOID on this ticker.';
  } else if (hitT2) {
    reason = legacy
      ? 'Price reached the current T2 target ($' + (t2 as number).toFixed(2) + ') within the last ' + lookback + ' trading days.'
      : 'Price ($' + cp.toFixed(2) + ') is at or above the current T2 target ($' + (t2 as number).toFixed(2) + ').';
  } else if (hitT1) {
    reason = legacy
      ? 'Price reached the current T1 target ($' + (t1 as number).toFixed(2) + ') within the last ' + lookback + ' trading days.'
      : 'Price ($' + cp.toFixed(2) + ') is at or above the current T1 target ($' + (t1 as number).toFixed(2) + ').';
  } else {
    reason = 'No stop breach, no thesis change, targets not yet reached.' + (legacy ? '' : holdTargetNote(cp, t1, t2));
  }

  return {
    error: null, ticker, entryPrice, cp, unrealizedPct, lookbackTradingDays: lookback,
    highestHighInWindow, chandelierGeneric, stopBreached, t1, t2, hitT1, hitT2,
    thesisInvalidated, recommendation, reason,
    ...(legacy ? {} : { distanceToT1Pct: distanceToTargetPct(cp, t1), distanceToT2Pct: distanceToTargetPct(cp, t2) }),
    ...(opts.weeklyStops ? { exitCandidates: exitCandidatesOf(technical) } : {}),
  };
}
