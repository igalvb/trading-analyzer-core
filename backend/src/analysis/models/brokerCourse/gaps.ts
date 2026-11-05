/**
 * Broker Course Phase 4 -- gap taxonomy, earnings-gap tagging and the
 * reverse-split avoid flag (:616-729, 5 functions; episodes 10 and 11).
 *
 * Depends on Phase 2 for exactly one thing: classifyGapTypeV1's Breakaway
 * test counts touches with findSwingPointsV1. That is the whole reason P4
 * comes after BC-1.
 *
 * ══ A SECOND, INDEPENDENT GAP TAXONOMY -- ON PURPOSE ════════════════════
 * The engine already classifies gaps (priceGaps.ts). This is a fresh
 * implementation of the same course content under the model's
 * no-code-reuse rule, with its own detection (open vs prior close, 2%) and
 * its own windows, so the two can disagree on the same gap. The priority
 * ORDER happens to match the engine's (Breakaway > Exhaustion > Island >
 * Runaway > Common); the tests inside each branch do not.
 *
 * ══ TWO COPIES, ONE OF WHICH DRIFTED ═══════════════════════════════════
 * Two of these five are near-verbatim copies of engine functions.
 * classifyEarningsGapV1 matches classifyGapCauseV7 exactly (measured on
 * every probed case at the production tolerance). reverseSplitAvoidFlagV1
 * does NOT match recentReverseSplitV7 -- see F-23 on that function.
 */

import { findSwingPointsV1 } from './technicals.ts';
import type { Split } from '../../../types/chart.ts';

export type GapDirection = 'UP' | 'DOWN';

export interface BrokerGap {
  readonly idx: number;
  readonly date: Date;
  readonly type: GapDirection;
  readonly sizePct: number;
  /** The prior close -- the price the gap left behind. */
  readonly level: number;
}

/**
 * Gap detection: today's OPEN against yesterday's CLOSE, kept when
 * |change| >= minGapPct (default 2%, a disclosed noise floor, not
 * course-exact). Inclusive, so a gap of exactly 2% counts.
 *
 * A zero or missing prior close is skipped rather than divided by.
 *
 * `type` is `gapPct > 0 ? 'UP' : 'DOWN'`, so with minGapPct 0 an unchanged
 * open is reported as a zero-size DOWN gap. Production always passes 0.02
 * (:1958), where that cannot happen.
 *
 * Harness-only: a null OPEN after a real close coerces to 0 and reads as a
 * -100% DOWN gap -- 181 of them on the _VIX fixture, whose opens are its
 * closes and carry 182 nulls. Production cannot reach this
 * (fetchYahooChartRaw_ drops null-close bars and backfills null opens,
 * dataLayerV1.gs:311-314), so it is pinned by a test, not registered.
 */
export function detectPriceGapsV1(
  opens: readonly number[],
  closes: readonly number[],
  dates: readonly Date[],
  minGapPct?: number | null,
): BrokerGap[] {
  const min = minGapPct == null ? 0.02 : minGapPct;
  const gaps: BrokerGap[] = [];
  for (let i = 1; i < opens.length; i++) {
    const prevClose = closes[i - 1];
    if (!prevClose) continue;
    const gapPct = (opens[i] - prevClose) / prevClose;
    if (Math.abs(gapPct) >= min) {
      gaps.push({ idx: i, date: dates[i], type: gapPct > 0 ? 'UP' : 'DOWN', sizePct: gapPct, level: prevClose });
    }
  }
  return gaps;
}

/**
 * Market-cap-relative significance (ep.11). The course gives exactly ONE
 * number -- a 3% gap is significant on a mega-cap -- and nothing for any
 * other tier, so every other tier is labelled informational rather than
 * given an invented threshold. Direction-blind (|size|), inclusive at 3%.
 *
 * Takes the tier LABEL, so it inherits Phase 1's course tiers; any
 * non-empty string other than 'Mega Cap' is echoed into the text as-is.
 */
export function gapMarketCapSignificanceV1(
  gapSizePct: number | null | undefined,
  marketCapTier: string | null | undefined,
): string | null {
  if (gapSizePct == null || !marketCapTier) return null;
  const abs = Math.abs(gapSizePct);
  if (marketCapTier === 'Mega Cap') {
    return abs >= 0.03
      ? 'Mega-cap gap >=3% — significant (ep.11\'s own stated threshold)'
      : 'Mega-cap gap <3% — likely not significant';
  }
  return marketCapTier + ' — no exact course-stated threshold for this tier, informational only';
}

export type BrokerGapType = 'Breakaway' | 'Exhaustion' | 'Island' | 'Runaway' | 'Common';

/**
 * Gap type. First matching rule wins -- each branch returns:
 *
 *   Breakaway   >=2 earlier swing points (highs for an UP gap, lows for
 *               DOWN) within 3% of the gap's level -- the course's own
 *               two-touch S/R minimum (ep.3) applied to the level gapped
 *   Exhaustion  the gap bar's volume equals the 60-bar max AND the very
 *               next close is back through the level
 *   Island      any opposite-direction gap within 10 bars, either side
 *   Runaway     an UP gap near the all-time high, or a DOWN gap inside an
 *               established long-term downtrend
 *   Common      none of the above
 *
 * Only Runaway reads the two context flags; the first three never do.
 *
 * ══ THREE THINGS THE RULES DO NOT SAY OUT LOUD ═════════════════════════
 * 1. HINDSIGHT. Exhaustion reads the bar AFTER the gap, Island accepts an
 *    opposite gap AFTER it, and swing points within 5 bars of the gap are
 *    confirmed using post-gap bars. Production only ever classifies the
 *    most recent gap (:2032), where no later gap can exist; on historical
 *    gaps these paths do look forward. (The engine's priceGaps flags its
 *    hindsight-dependent types explicitly; this taxonomy does not.)
 * 2. TIES COUNT AS "HIGHEST". `volumes[idx] === max(window)` -- so a gap
 *    on a zero-volume bar inside an all-zero window is "highest volume".
 *    Measured: 177 of 255 full-history Exhaustion classifications are
 *    exactly that, all on _VIX (zero volumes synthesised by the harness);
 *    the real zero-volume stretches in CLSK/HUT produce none.
 * 3. `other !== gap` IS REDUNDANT. The island test also requires
 *    `other.type !== gap.type`, which already excludes the gap itself -- so
 *    a COPY of the gap classifies the same as the array's own element.
 *    Tested, kept.
 *
 * Breakaway does not check that the gap actually CLEARS the level, only
 * that the prior close sits within 3% of two earlier swing points. The
 * `s.idx < gap.idx - 1` filter excludes the gap's own defining bar (the
 * prior close), which would otherwise trivially touch itself.
 */
export function classifyGapTypeV1(
  gap: BrokerGap | null | undefined,
  allGaps: readonly BrokerGap[],
  highs: readonly number[],
  lows: readonly number[],
  volumes: readonly number[],
  closes: readonly number[],
  nearATH: boolean | null | undefined,
  longTermDowntrend: boolean | null | undefined,
): BrokerGapType | null {
  if (!gap) return null;
  const ISLAND_WINDOW = 10;
  const LOOKBACK = 60;

  const { swingHighs, swingLows } = findSwingPointsV1(highs, lows, 5);
  const relevantSwings = gap.type === 'UP' ? swingHighs : swingLows;
  const touchCount = relevantSwings.filter((s) => s.idx < gap.idx - 1 &&
    Math.abs(s.price - gap.level) / gap.level <= 0.03).length;
  if (touchCount >= 2) return 'Breakaway';

  const windowStart = Math.max(0, gap.idx - LOOKBACK);
  const isHighestVol = volumes[gap.idx] === Math.max.apply(null, volumes.slice(windowStart, gap.idx + 1));
  const nextIdx = gap.idx + 1;
  const reversedNext = nextIdx < closes.length &&
    (gap.type === 'UP' ? closes[nextIdx] < gap.level : closes[nextIdx] > gap.level);
  if (isHighestVol && reversedNext) return 'Exhaustion';

  const hasOppositeIsland = allGaps.some((other) => other !== gap && other.type !== gap.type &&
    Math.abs(other.idx - gap.idx) <= ISLAND_WINDOW);
  if (hasOppositeIsland) return 'Island';

  if (gap.type === 'UP' ? nearATH : longTermDowntrend) return 'Runaway';

  return 'Common';
}

export interface EarningsEvent {
  readonly date: Date;
  readonly epsActual?: number | null;
  readonly epsEstimated?: number | null;
  readonly revenueActual?: number | null;
  readonly revenueEstimated?: number | null;
}

export interface EarningsGapTag {
  readonly cause: 'EARNINGS';
  readonly reportDate: Date;
  readonly epsSurprisePct: number | null;
  readonly revenueSurprisePct: number | null;
}

/**
 * Tags a gap as earnings-driven when a report date falls within
 * `toleranceDays` (default 1) of it, nearest report winning, and reports
 * the EPS/revenue surprise %.
 *
 * A near-verbatim copy of the engine's classifyGapCauseV7 (legacy :8455),
 * tolerance made a parameter -- and unlike F-23's pair, this copy agrees
 * with its original everywhere probed.
 *
 * The gap date is truncated to UTC midnight; report dates already are
 * (fetchEarningsCalendarV7 builds them as `date + 'T00:00:00Z'`). The
 * engine's version records the real bug this avoids: local-timezone
 * truncation pushed same-day matches outside the window.
 *
 * ══ THE WINDOW IS CAUSALITY-BLIND ═════════════════════════════════════
 * The window is symmetric, so a gap the day BEFORE a report is tagged as
 * caused by it, and when two reports are equidistant the one listed first
 * wins even if it is the later one. Conversely a Friday report against a
 * Monday gap is 3 calendar days apart and is missed at the production
 * tolerance of 1. All measured on the oracle; reproduced, not adjusted.
 *
 * Surprise % is null when the actual is missing OR the estimate is falsy
 * -- so a genuine $0.00 estimate also yields null -- and divides by
 * |estimate|, so a beat on a negative estimate reads positive.
 */
export function classifyEarningsGapV1(
  gap: { readonly date: Date } | null | undefined,
  earningsHistory: readonly EarningsEvent[] | null | undefined,
  toleranceDays?: number | null,
): EarningsGapTag | null {
  const tol = toleranceDays == null ? 1 : toleranceDays;
  if (!gap || !earningsHistory || !earningsHistory.length) return null;
  const MS_PER_DAY = 86400000;
  const gd = new Date(gap.date);
  const gapDateUTC = new Date(Date.UTC(gd.getUTCFullYear(), gd.getUTCMonth(), gd.getUTCDate()));
  const match = earningsHistory
    .filter((e) => Math.abs(+gapDateUTC - +e.date) <= tol * MS_PER_DAY)
    .sort((a, b) => Math.abs(+gapDateUTC - +a.date) - Math.abs(+gapDateUTC - +b.date))[0];
  if (!match) return null;
  const epsSurprisePct = match.epsActual != null && match.epsEstimated
    ? (match.epsActual - match.epsEstimated) / Math.abs(match.epsEstimated) * 100
    : null;
  const revenueSurprisePct = match.revenueActual != null && match.revenueEstimated
    ? (match.revenueActual - match.revenueEstimated) / Math.abs(match.revenueEstimated) * 100
    : null;
  return { cause: 'EARNINGS', reportDate: match.date, epsSurprisePct, revenueSurprisePct };
}

export interface ReverseSplitFlag {
  readonly date: Date;
  readonly ratio: string;
  readonly daysAgo: number;
  readonly read: string;
}

/**
 * The most recent REVERSE split (numerator < denominator) dated on or after
 * the bar 60 positions before `lastIdx` -- the instructor's deliberate
 * watchlist-exclusion heuristic (ep.10).
 *
 * `lastIdx` is an INDEX; production passes closes.length - 1 (:2047).
 * Passing the length instead reads dates[length], undefined, and the read
 * says "NaNd ago" -- measured.
 *
 * No upper bound on the split date: a split after dates[lastIdx] still
 * matches, with a negative daysAgo. Production cannot see one (splits come
 * from the same response as the bars); a truncated test chart can.
 *
 * ══ FLAGGED (F-23): ONE BAR WIDER THAN THE ENGINE'S OWN COPY ═══════════
 * Line for line this is the engine's recentReverseSplitV7 (legacy :9199,
 * ported as events.ts recentReverseSplit) with an added `read` field and
 * its `n` renamed `lastIdx`. daysAgo was adjusted for the rename
 * (dates[lastIdx], i.e. the engine's dates[n-1]); the cutoff was not -- it
 * kept `lastIdx - 60`. The callers pass different things: the engine
 * passes n = closes.length (:6250 -> :7761), this report passes
 * closes.length - 1 (:1894 -> :2047). So the engine's window is 60 bars
 * counting today and this one is 61. Measured bar by bar on the two real
 * reverse splits in the fixtures (4,459 bars): they disagree on exactly
 * one bar each -- CLSK 2020-03-10, HUT 2024-03-01 -- where the engine says
 * no recent reverse split and this report says "89d ago" / "87d ago".
 * Production-reachable on the 61st bar after any reverse split.
 * Reproduced, not fixed.
 */
export function reverseSplitAvoidFlagV1(
  splits: readonly Split[] | null | undefined,
  dates: readonly Date[] | null | undefined,
  lastIdx: number,
): ReverseSplitFlag | null {
  if (!splits || !splits.length || !dates || !dates.length) return null;
  const RECENT_LOOKBACK_BARS = 60;
  const cutoffDate = dates[Math.max(0, lastIdx - RECENT_LOOKBACK_BARS)];
  const recentReverse = splits
    .filter((s) => s.numerator < s.denominator)
    .filter((s) => s.date >= cutoffDate)
    .sort((a, b) => +b.date - +a.date)[0];
  if (!recentReverse) return null;
  const daysAgo = Math.round((+dates[lastIdx] - +recentReverse.date) / 86400000);
  return {
    date: recentReverse.date,
    ratio: recentReverse.numerator + ':' + recentReverse.denominator,
    daysAgo,
    read: 'Recent reverse split (' + recentReverse.numerator + ':' + recentReverse.denominator
      + ', ' + daysAgo + 'd ago) — course\'s own deliberate avoid-heuristic (ep.10)',
  };
}
