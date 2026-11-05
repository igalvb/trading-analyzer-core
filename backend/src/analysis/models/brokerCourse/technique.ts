/**
 * Broker Course Phase 7 -- technique / entry (:1331-1439, 4 functions;
 * episodes 3, 4, 7).
 *
 * Only the two numerically concrete entry rules the course adds are built
 * -- Secondary Day and the $20B counter-trend-at-support rule -- plus stop
 * placement. Breakout / pullback / gap-and-go stay organisational labels
 * covered by Phases 2/3/4 (the `note` field says so in the output).
 *
 * ══ FLAGGED (F-26): THE R:R RULE NEVER RUNS IN PRODUCTION ═════════════
 * techniqueEntryReadV1 computes R:R via Phase 3's riskRewardV1 only when a
 * `targetPrice` is supplied -- and its only call site (:2079) passes a
 * literal `null`. riskRewardV1 has no other caller in any legacy file, so
 * the course's 1:1 minimum ("course says skip the trade") never reaches a
 * user. Kept as a real tested parameter: with a target injected, both
 * sides of the 1:1 floor fire on real charts.
 */

import { riskRewardV1, type RiskReward } from './fibonacci.ts';
import type { SrLevel } from './technicals.ts';

export interface SecondaryDayRead {
  readonly isSecondaryDay: boolean;
  readonly yesterdayRelVol: number;
  readonly breaksYesterdayHigh: boolean;
  readonly read: string;
}

/**
 * Secondary Day (ep.7): yesterday's volume > 1.5x the 20 bars before it,
 * and today's CLOSE above yesterday's high.
 *
 * The baseline excludes yesterday itself (a real legacy fix) and divides by
 * min(n-1, 20), so short histories use what exists; n = 1 is 0/0 and
 * refuses. Matches the engine's secondaryDayV7 on every real window
 * measured (production-shaped: this n = length-1, the engine's n = length).
 *
 * The threshold is STRICT (> 1.5). The source comment calls it "the same
 * >1.5x convention as Phase 1", but Phase 1's relativeVolumeReadV1 is
 * inclusive (>= 1.5) -- at exactly 1.5x the two disagree (tested).
 */
export function secondaryDayEntryReadV1(
  closes: readonly number[] | null | undefined,
  highs: readonly number[] | null | undefined,
  volumes: readonly number[] | null | undefined,
  n: number | null | undefined,
): SecondaryDayRead | null {
  if (!closes || !highs || !volumes || n == null || n < 1) return null;
  if (closes.length <= n || highs.length <= n || volumes.length <= n) return null;
  const avgVol = volumes.slice(Math.max(0, n - 21), n - 1).reduce((a, b) => a + b, 0) / Math.min(n - 1, 20);
  if (!avgVol) return null;
  const yesterdayRelVol = volumes[n - 1] / avgVol;
  const yesterdayElevated = yesterdayRelVol > 1.5;
  const breaksYesterdayHigh = closes[n] > highs[n - 1];
  const isSecondaryDay = yesterdayElevated && breaksYesterdayHigh;
  return {
    isSecondaryDay, yesterdayRelVol, breaksYesterdayHigh,
    read: isSecondaryDay
      ? 'Yesterday\'s elevated volume (' + yesterdayRelVol.toFixed(1) + 'x) + today breaking above yesterday\'s high — matches the course\'s "Secondary Day" momentum-continuation entry (ep.7)'
      : 'Does not match the Secondary Day entry pattern',
  };
}

export interface CounterTrendRead {
  readonly eligible: boolean;
  readonly atSupport: boolean;
  /** ABSENT (not null) on the ineligible path; null when eligible but not at a level. */
  readonly level?: number | null;
  readonly read: string;
}

/**
 * Large-cap counter-trend-at-support (ep.4): above $20B (strict -- exactly
 * $20B is ineligible), buying at an established support is legitimate even
 * against the trend. Below it, the read says so rather than offering a
 * weaker version.
 *
 * Picks the FIRST support within 3% in the list's order (most touches
 * first), not the nearest. Its caller passes the last close, not the live
 * quote. The ineligible object has no `level` key at all.
 */
export function counterTrendAtSupportReadV1(
  marketCap: number | null | undefined,
  currentPrice: number | null | undefined,
  supportLevels: readonly SrLevel[] | null | undefined,
  tolerance?: number | null,
): CounterTrendRead | null {
  if (marketCap == null || currentPrice == null || !supportLevels) return null;
  const tol = tolerance == null ? 0.03 : tolerance;
  const COUNTER_TREND_MIN_MARKET_CAP = 20e9;
  const eligible = marketCap > COUNTER_TREND_MIN_MARKET_CAP;
  if (!eligible) {
    return { eligible, atSupport: false, read: 'Market cap below the course\'s $20B counter-trend-buying threshold — dip-buying against the trend not considered safe here (ep.4)' };
  }
  const nearSupport = supportLevels.find((s) => Math.abs(currentPrice - s.level) / s.level <= tol);
  const atSupport = !!nearSupport;
  return {
    eligible, atSupport, level: nearSupport ? nearSupport.level : null,
    read: atSupport
      ? ('Large-cap (>$20B) at an established support level (' + nearSupport!.tier + ', ' + nearSupport!.touchCount + ' touches) — course\'s counter-trend-buying rule applies (ep.4)')
      : 'Large-cap, but not currently at an established support level — counter-trend rule not triggered',
  };
}

export interface StopPlacement {
  readonly stopPrice: number;
  readonly supportLevel: number;
  readonly margin: number;
  readonly read: string;
}

/**
 * Stop a margin BELOW support, not on it (ep.3's stop-hunt example; the
 * source corrected an earlier ep.7 citation). Default margin 3%, reusing
 * the file's S/R tolerance -- no number is given in the course.
 */
export function stopPlacementV1(
  supportLevel: number | null | undefined, margin?: number | null,
): StopPlacement | null {
  if (supportLevel == null) return null;
  const m = margin == null ? 0.03 : margin;
  const stopPrice = supportLevel * (1 - m);
  return {
    stopPrice, supportLevel, margin: m,
    read: 'Stop placed ' + (m * 100).toFixed(0) + '% below the ' + supportLevel.toFixed(2) + ' support level (not exactly at it) — avoids sitting in the same stop-hunt cluster as the level itself (ep.3)',
  };
}

export type TechniqueTag = 'Secondary-Day-Entry' | 'Counter-Trend-At-Institutional-Support' | 'No specific entry technique identified';

export interface TechniqueEntryRead {
  readonly tag: TechniqueTag;
  readonly evidence: string[];
  readonly riskReward: RiskReward | null;
  readonly note: string;
}

/**
 * Secondary Day takes priority over counter-trend. Only the counter-trend
 * path places a stop, so R:R is only ever computed there -- and only when
 * a target is passed, which production never does (F-26, header).
 */
export function techniqueEntryReadV1(
  closes: readonly number[],
  highs: readonly number[] | null | undefined,
  volumes: readonly number[] | null | undefined,
  n: number,
  marketCap: number | null | undefined,
  supportLevels: readonly SrLevel[] | null | undefined,
  targetPrice: number | null | undefined,
): TechniqueEntryRead {
  const secondaryDay = secondaryDayEntryReadV1(closes, highs, volumes, n);
  const counterTrend = counterTrendAtSupportReadV1(marketCap, closes[n], supportLevels);

  const evidence: string[] = [];
  let tag: TechniqueTag = 'No specific entry technique identified';
  let stop: StopPlacement | null = null;
  if (secondaryDay && secondaryDay.isSecondaryDay) {
    tag = 'Secondary-Day-Entry';
    evidence.push(secondaryDay.read);
  } else if (counterTrend && counterTrend.atSupport) {
    tag = 'Counter-Trend-At-Institutional-Support';
    evidence.push(counterTrend.read);
    stop = stopPlacementV1(counterTrend.level);
    evidence.push(stop!.read);
  }

  let riskReward: RiskReward | null = null;
  if (stop && targetPrice != null) {
    riskReward = riskRewardV1(closes[n], stop.stopPrice, targetPrice);
    if (riskReward) evidence.push(riskReward.read);
  }

  return {
    tag, evidence, riskReward,
    note: 'Breakout, pullback-to-support, and gap-and-go entry types are the course\'s own organizational framing, not separate numeric rules — see the Technicals (Phase 2), Fibonacci (Phase 3), and Gap-taxonomy (Phase 4) reads for those signals directly.',
  };
}
