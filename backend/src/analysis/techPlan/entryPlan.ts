/**
 * Tier B of computeTechnicalPlanV7: entry timing, exit targets, stops and
 * risk/reward.
 *
 * Together with Tier A (scoring.ts) this completes the DECISION PATH --
 * everything synthesizeDecisionV7 reads. Tiers C and D (the 8 additive
 * stop/sizing helpers and the drivers array, ~570 lines) are display-only and
 * affect no decision output.
 *
 * Dependency closure measured before porting: 3 direct helpers (58 lines) plus
 * 6 nested ones (59 lines) plus ~40 lines of orchestration = 157 total.
 *
 * Verified 2026-10-05: 8,040 comparisons across 19 distinct output fields, all
 * exact. All three timing values and all three agreement levels exercised; the
 * t1-promotion loop fired 40 times; entryConfidencePct spanned 18-82 across 43
 * distinct values, including the elevated-IV penalty path.
 */

import type { Chart } from '../../types/chart.ts';
import type { Indicators } from '../../types/indicators.ts';
import type { GannRead } from '../gann.ts';
import type { ConfluenceTargets, ConfluenceMethod } from '../confluence.ts';
import type { Regime, OptionsAnalysis } from './scoring.ts';

export type Timing = 'BUY_NOW' | 'WAIT_PULLBACK' | 'AVOID';

export interface TimeEstimateMethod {
  method: string;
  days: number;
}

export interface TimeEstimate {
  baseDays: number;
  minDays: number;
  maxDays: number;
  agreement: string;
  methodCount: number;
  methods: TimeEstimateMethod[];
  humanText: string;
}

export interface ExitTarget {
  price: number;
  low: number;
  high: number;
  basis: string[];
  count: number;
  /** Present only when the promotion loop moved t2 up into t1. */
  promoted?: boolean;
  promotionHops?: number;
}

export interface EntryPlan {
  timing: Timing;
  entryPrice: number;
  entryLow: number;
  entryHigh: number;
  entryConfidencePct: number;
  timeToEntry: TimeEstimate | null;
  t1: ExitTarget | null;
  t1Time: TimeEstimate | null;
  t2: ExitTarget | null;
  t2Time: TimeEstimate | null;
  stop: number;
  rrToT1: number | null;
  rrToT2: number | null;
  stopAtSpot: number;
  rrToT1AtSpot: number | null;
  rrToT2AtSpot: number | null;
}

/**
 * Expected daily drift as a fraction of ATR, by regime.
 *
 * A trending market covers ground fastest (0.45 ATR/day); chop is slowest
 * (0.20) because moves retrace. HIGH_VOL sits between: large bars, but
 * directionless, so net progress is modest.
 *
 * The `default` arm IS reachable here, unlike the dead DEFAULT entries in
 * scoring.ts (F-10) -- this is a switch over a string parameter that callers
 * could pass anything to, not a lookup keyed by a closed enum.
 */
export function driftFactor(regime: string): number {
  switch (regime) {
    case 'TREND_UP':
    case 'TREND_DOWN':
      return 0.45;
    case 'HIGH_VOL':
      return 0.3;
    case 'CHOP':
      return 0.2;
    default:
      return 0.35;
  }
}

/** Distance to target divided by expected daily drift. */
export function timeToPriceATR(cp: number, target: number, atr: number | null, regime: string): number | null {
  if (!atr || atr <= 0) return null;
  const dailyDrift = atr * driftFactor(regime);
  if (dailyDrift <= 0) return null;
  return Math.abs(target - cp) / dailyDrift;
}

/**
 * Gann's time-squaring estimate: price advances one priceUnit per bar along
 * the 1x1, so the bar count to a target is implied by the price distance from
 * the pivot.
 *
 * Returns null when the target is already behind the implied schedule
 * (barsFromNow <= 0) -- Gann cannot estimate a target the fan has passed.
 *
 * The 7/5 factor converts TRADING bars to CALENDAR days, which makes this
 * method's unit inconsistent with the other two (both in trading days). Real
 * behaviour, reproduced -- it inflates the Gann estimate by 40% relative to its
 * peers and therefore widens the reported range.
 */
export function timeToPriceGann(gann: GannRead | null, target: number): number | null {
  if (!gann || !gann.priceUnit || gann.priceUnit === 0 || !gann.pivot) return null;
  const totalBarsFromPivot = (target - gann.pivot.price) / gann.priceUnit;
  const barsFromNow = totalBarsFromPivot - gann.pivot.daysAgo;
  if (barsFromNow <= 0) return null;
  return barsFromNow * (7 / 5);
}

/** Human-readable duration. Note the U+2248 almost-equal sign throughout. */
export function formatDuration(days: number | null): string {
  if (days == null) return 'N/A';
  if (days < 10) {
    const d = Math.round(days);
    return `≈${d} trading day${d === 1 ? '' : 's'}`;
  }
  if (days < 45) {
    const w = Math.round(days / 5);
    return `≈${w} wk${w === 1 ? '' : 's'}`;
  }
  return `≈${(days / 21).toFixed(1)} mo`;
}

export interface CadenceRead {
  medianDays: number;
  sampleSize: number;
}

/**
 * How long moves of a similar DEPTH have historically taken for this ticker.
 *
 * The only one of the three estimators grounded in the stock's own behaviour
 * rather than a model.
 *
 * Two details worth preserving:
 *   - Swings are detected on CLOSES, and consecutive same-type swings are
 *     collapsed keeping the more extreme -- so the sequence strictly
 *     alternates peak/trough before durations are measured.
 *   - The similarity band is max(40% of target depth, 3 percentage points), so
 *     shallow targets get an absolute floor rather than an impossibly tight
 *     relative window. If fewer than 2 similar moves exist it falls back to
 *     ALL pullbacks rather than returning null -- a weaker estimate beats none.
 */
export function historicalCadence(closes: readonly number[], targetDepthPct: number): CadenceRead | null {
  const n = closes.length;
  const w = 5;
  if (n < w * 4) return null;

  const swings: Array<{ idx: number; price: number; type: 'peak' | 'trough' }> = [];
  for (let i = w; i < n - w; i++) {
    const window = closes.slice(i - w, i + w + 1);
    const c = closes[i] as number;
    if (c === Math.max(...window)) swings.push({ idx: i, price: c, type: 'peak' });
    else if (c === Math.min(...window)) swings.push({ idx: i, price: c, type: 'trough' });
  }

  // Collapse runs of the same type, keeping the more extreme -- guarantees
  // alternation, which the pairwise loop below depends on.
  const cleaned: typeof swings = [];
  swings.forEach((s) => {
    const last = cleaned[cleaned.length - 1];
    if (last && last.type === s.type) {
      if ((s.type === 'peak' && s.price > last.price) || (s.type === 'trough' && s.price < last.price)) {
        cleaned[cleaned.length - 1] = s;
      }
    } else cleaned.push(s);
  });

  const pullbacks: Array<{ depth: number; duration: number }> = [];
  for (let i = 0; i < cleaned.length - 1; i++) {
    const a = cleaned[i] as (typeof swings)[number];
    const b = cleaned[i + 1] as (typeof swings)[number];
    // Depth is always measured as a positive fraction of the STARTING price,
    // so rallies and declines are directly comparable.
    if (a.type === 'peak' && b.type === 'trough') {
      pullbacks.push({ depth: (a.price - b.price) / a.price, duration: b.idx - a.idx });
    } else if (a.type === 'trough' && b.type === 'peak') {
      pullbacks.push({ depth: (b.price - a.price) / a.price, duration: b.idx - a.idx });
    }
  }
  if (pullbacks.length === 0) return null;

  const similar = pullbacks.filter((p) => Math.abs(p.depth - targetDepthPct) <= Math.max(0.4 * targetDepthPct, 0.03));
  const pool = similar.length >= 2 ? similar : pullbacks; // weaker estimate beats none
  const durations = pool.map((p) => p.duration).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianDays =
    durations.length % 2 ? (durations[mid] as number) : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
  return { medianDays, sampleSize: pool.length };
}

export interface TimeToPriceContext {
  atr: number | null;
  regime: string;
  gann: GannRead | null;
  closes: readonly number[];
}

/**
 * Combines up to three independent time estimates.
 *
 * Each contributor may decline (return null) and is simply omitted, so the
 * estimate degrades rather than failing. With nothing available, returns null.
 *
 * Agreement is the coefficient of variation across contributors -- a real
 * dispersion measure, not a count. But note the single-method case is
 * hardcoded to `'low (single method)'` BEFORE the CV is consulted, since CV is
 * meaningless with one sample. That string was never observed across the
 * fixture set, so in practice at least two estimators always contribute.
 *
 * The averaging is UNWEIGHTED, so the Gann estimate's calendar-day unit (see
 * timeToPriceGann) pulls the mean upward relative to its trading-day peers.
 */
export function timeToPrice(cp: number, target: number, ctx: TimeToPriceContext): TimeEstimate | null {
  const results: TimeEstimateMethod[] = [];

  const atrDays = timeToPriceATR(cp, target, ctx.atr, ctx.regime);
  if (atrDays != null) results.push({ method: 'ATR/velocity', days: atrDays });

  const gannDays = timeToPriceGann(ctx.gann, target);
  if (gannDays != null) results.push({ method: 'Gann time-square', days: gannDays });

  const depthPct = Math.abs(target - cp) / cp;
  const cadence = ctx.closes ? historicalCadence(ctx.closes, depthPct) : null;
  if (cadence) results.push({ method: 'Historical cadence', days: cadence.medianDays });

  if (results.length === 0) return null;

  const days = results.map((r) => r.days);
  const base = days.reduce((a, b) => a + b, 0) / days.length;
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  const variance = days.reduce((s, d) => s + (d - base) ** 2, 0) / days.length;
  const cv = base > 0 ? Math.sqrt(variance) / base : 1;
  const agreement = results.length < 2 ? 'low (single method)' : cv < 0.25 ? 'high' : cv < 0.6 ? 'medium' : 'low';
  // The range is shown only when more than one method contributed -- otherwise
  // low and high would both equal base and imply false precision.
  const humanText = formatDuration(base) + (results.length > 1 ? ` (range ${formatDuration(lo)}–${formatDuration(hi)})` : '');

  return {
    baseDays: Math.round(base), minDays: Math.round(lo), maxDays: Math.round(hi),
    agreement, methodCount: results.length, methods: results, humanText,
  };
}

/**
 * Finds the next cluster of exit methods strictly above a floor price.
 *
 * Anchors on the LOWEST remaining method and gathers everything within 7% of
 * it -- a fixed anchor, matching confluence.findClusters rather than
 * srLevels' drifting centroid. Third clustering implementation in the
 * codebase; see confluence.ts for the same note.
 *
 * Exclusion is by NAME, so a method already consumed by t1 cannot reappear
 * in t2.
 */
export function clusterBeyond(
  allMethods: readonly ConfluenceMethod[] | null,
  usedNames: Set<string>,
  floorPrice: number,
): ExitTarget | null {
  const remaining = (allMethods || []).filter((m) => !usedNames.has(m.name) && (m.price as number) > floorPrice);
  if (remaining.length === 0) return null;

  remaining.sort((a, b) => (a.price as number) - (b.price as number));
  const anchor = remaining[0]?.price as number;
  const near = remaining.filter((m) => Math.abs((m.price as number) - anchor) / anchor <= 0.07);
  const prices = near.map((m) => m.price as number);

  return {
    price: prices.reduce((a, b) => a + b, 0) / prices.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    basis: near.map((m) => m.name),
    count: near.length,
  };
}

/**
 * Fix plan 2026-10-30 B1/D2 (research option, default OFF): which exit-target rule to use.
 * Unset / false = today's rule (T1 = the BIGGEST confluence cluster, promoted past 1 ATR; T2 may reuse methods the
 * confluence excluded). `nearestTargets: true` = T1 is the NEAREST cluster of valid (not excluded) target methods at
 * least one ATR above the entry; T2 is the next cluster above it, excluded methods skipped.
 */
export interface ExitTargetOptions {
  readonly nearestTargets?: boolean;
  /**
   * Fix plan B1 option B, part 2 (the T2 bug): T2 -- and a T1 promoted from it -- is built only from methods the
   * confluence did NOT mark excluded (today clusterBeyond also reads excluded ones, e.g. a Gann projection beyond the
   * 2.5x ceiling: TSLA T2 $2,187, AMD T2 $6,701 on 2026-10-27). Unset = today's rule. Never set in legacy-parity mode.
   */
  readonly fixedT2?: boolean;
}

/** The exit methods the confluence did not mark excluded, with a usable price. */
export function validExitMethods(confluence: Pick<ConfluenceTargets, 'allExitMethods'>): ConfluenceMethod[] {
  return (confluence.allExitMethods || []).filter((m) => !m.excluded && typeof m.price === 'number' && Number.isFinite(m.price) && m.price > 0);
}

/**
 * The B1 variant: T1 = the nearest cluster (clusterBeyond's 7% fixed anchor) of the valid target methods whose price
 * is at least entry + 1 ATR; T2 = the next cluster above T1. Methods marked `excluded` never count. Null when no valid
 * method lies at or beyond that floor (the caller then keeps today's rule).
 */
export function deriveNearestExitTargets(
  confluence: ConfluenceTargets,
  atr: number | null,
  entryPrice: number | null,
): { t1: ExitTarget; t2: ExitTarget | null } | null {
  const valid = validExitMethods(confluence);
  const anchor = entryPrice != null ? entryPrice : confluence.exitCenter;
  const minGap = atr && atr > 0 ? atr : 0;
  // clusterBeyond keeps prices strictly above its floor; "at least 1 ATR" admits a method exactly at entry + ATR.
  const floor = anchor + minGap;
  const t1 = clusterBeyond(valid.filter((m) => (m.price as number) >= floor), new Set(), -Infinity);
  if (!t1) return null;
  const t2 = clusterBeyond(valid, new Set(t1.basis), t1.high);
  return { t1, t2 };
}

/**
 * Derives T1 and T2 from the confluence exit zones.
 *
 * ══ THE PROMOTION LOOP ══════════════════════════════════════════════════
 * T1 starts as the confluence exit cluster. But if T1 sits closer to the entry
 * than one ATR, it is not a meaningful target -- normal daily noise would reach
 * it. So T2 is PROMOTED into T1 and a fresh T2 is found beyond it, repeating up
 * to MAX_PROMOTION_HOPS times.
 *
 * The hop cap matters: without it, a chart whose targets all cluster tightly
 * near the entry would loop until the method list is exhausted. Five is the
 * ceiling, and `promotionHops` is surfaced so downstream can disclose that the
 * nominal first target was skipped.
 *
 * Fired on 40 of the verification cases, so this is a live path, not an edge.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function deriveExitTargets(
  confluence: ConfluenceTargets,
  atr: number | null,
  entryPrice: number | null,
  opts: ExitTargetOptions = {},
): { t1: ExitTarget; t2: ExitTarget | null } {
  if (opts.nearestTargets) {
    const near = deriveNearestExitTargets(confluence, atr, entryPrice);
    if (near) return near;
  }
  let t1: ExitTarget = {
    price: confluence.exitCenter,
    low: confluence.exitLow,
    high: confluence.exitHigh,
    basis: (confluence.exitMethods || []).map((m) => m.name),
    count: confluence.exitCount,
  };
  let usedNames = new Set(t1.basis);
  // fixedT2: excluded methods never form T2 (nor a T1 promoted from it).
  const pool = opts.fixedT2 ? validExitMethods(confluence) : confluence.allExitMethods;
  let t2 = clusterBeyond(pool, usedNames, t1.high);

  const minGap = atr && atr > 0 ? atr : 0;
  const anchor = entryPrice != null ? entryPrice : confluence.exitCenter;
  let promotionHops = 0;
  const MAX_PROMOTION_HOPS = 5;

  while (minGap > 0 && anchor != null && t1.price != null && t1.price - anchor < minGap && t2 != null && promotionHops < MAX_PROMOTION_HOPS) {
    const promotedUsed = new Set([...usedNames, ...t2.basis]);
    const newT2 = clusterBeyond(pool, promotedUsed, t2.high);
    t1 = { price: t2.price, low: t2.low, high: t2.high, basis: t2.basis, count: t2.count, promoted: true };
    usedNames = promotedUsed;
    t2 = newT2;
    promotionHops++;
  }
  if (promotionHops > 0) t1.promotionHops = promotionHops;

  return { t1, t2 };
}

/**
 * Stop placement and risk/reward.
 *
 * The ATR multiplier is regime-aware and counter-intuitive at first glance:
 * trending regimes get the TIGHTEST stop (1.25x) and HIGH_VOL the widest
 * (2.0x). The logic is that a trend should not retrace much before the thesis
 * is wrong, whereas a volatile tape needs room to avoid being shaken out by
 * noise. Chop sits in between at 1.5x.
 *
 * Returns null for a ratio when the target is missing or risk is non-positive
 * -- never a fabricated number.
 */
export function computeStopRR(
  entryPrice: number,
  atr: number,
  regime: Regime | string,
  t1: ExitTarget | null,
  t2: ExitTarget | null,
): { stop: number; risk: number; rr1: number | null; rr2: number | null } {
  const stopMult = regime === 'HIGH_VOL' ? 2.0 : regime === 'TREND_UP' || regime === 'TREND_DOWN' ? 1.25 : 1.5;
  const stop = entryPrice - stopMult * atr;
  const risk = entryPrice - stop;
  return {
    stop,
    risk,
    rr1: t1 && risk > 0 ? (t1.price - entryPrice) / risk : null,
    rr2: t2 && risk > 0 ? (t2.price - entryPrice) / risk : null,
  };
}

/**
 * Assembles the full entry plan.
 *
 * TIMING is decided in strict priority order, and the ordering is the whole
 * logic:
 *   1. TREND_DOWN or a strongly negative signal (<= -0.35) -> AVOID. This wins
 *      outright -- no entry zone is attractive enough in a downtrend.
 *   2. TREND_UP and price at or below entryHigh*1.02 -> BUY_NOW. Note BUY_NOW
 *      is reachable ONLY from TREND_UP, so a cheap price in CHOP never
 *      produces one.
 *   3. Otherwise WAIT_PULLBACK.
 *
 * ENTRY CONFIDENCE blends three factors: how many entry methods clustered
 * (40%), how well the timing estimators agreed (35%), and how favourable the
 * regime is (25%). Elevated implied volatility (ivRank >= 80) then subtracts a
 * flat 8 points -- the market pricing a big move makes any entry less reliable.
 *
 * Both stop variants are computed: from the planned ENTRY price and from the
 * current SPOT price. They differ whenever price is not already in the entry
 * zone, and a caller must pick the one matching the trade it describes.
 */
export function computeEntryPlan(
  ind: Indicators,
  gann: GannRead,
  confluence: ConfluenceTargets,
  chart: Pick<Chart, 'currentPrice' | 'closes'>,
  optAnalysis: (OptionsAnalysis & { ivRank?: number | null }) | null,
  regime: Regime,
  overallSig: number,
  targetOptions: ExitTargetOptions = {},
): EntryPlan {
  const cp = chart.currentPrice;
  const entryPrice = confluence.entryCenter;
  const entryLow = confluence.entryLow;
  const entryHigh = confluence.entryHigh;

  const timeToEntry = timeToPrice(cp, entryPrice, { atr: ind.atr14, regime, gann, closes: chart.closes });

  let timing: Timing;
  if (regime === 'TREND_DOWN' || overallSig <= -0.35) timing = 'AVOID';
  else if (regime === 'TREND_UP' && cp <= entryHigh * 1.02) timing = 'BUY_NOW';
  else timing = 'WAIT_PULLBACK';

  const entryMethodCount = (confluence.entryMethods || []).length;
  // The `|| entryMethodCount || 1` chain guards a zero divisor.
  const totalEntryMethods = (confluence.allEntryMethods || []).length || entryMethodCount || 1;
  const confluenceStrength = totalEntryMethods ? entryMethodCount / totalEntryMethods : 0;
  const timeAgreementScore = !timeToEntry ? 0.3 : timeToEntry.agreement === 'high' ? 0.9 : timeToEntry.agreement === 'medium' ? 0.6 : 0.3;
  const regimeAlignScore = regime === 'TREND_UP' ? 0.8 : regime === 'CHOP' ? 0.5 : regime === 'HIGH_VOL' ? 0.35 : 0.5;

  let entryConfidencePct = Math.round((confluenceStrength * 0.4 + timeAgreementScore * 0.35 + regimeAlignScore * 0.25) * 100);
  if (optAnalysis && optAnalysis.available && optAnalysis.ivRank != null && optAnalysis.ivRank >= 80) {
    entryConfidencePct = Math.max(0, entryConfidencePct - 8);
  }

  const { t1, t2 } = deriveExitTargets(confluence, ind.atr14, entryPrice, targetOptions);
  const t1Time = t1 ? timeToPrice(cp, t1.price, { atr: ind.atr14, regime, gann, closes: chart.closes }) : null;
  const t2Time = t2 ? timeToPrice(cp, t2.price, { atr: ind.atr14, regime, gann, closes: chart.closes }) : null;

  const stopRR = computeStopRR(entryPrice, ind.atr14 as number, regime, t1, t2);
  const stopRRAtSpot = computeStopRR(cp, ind.atr14 as number, regime, t1, t2);

  return {
    timing, entryPrice, entryLow, entryHigh, entryConfidencePct, timeToEntry,
    t1, t1Time, t2, t2Time,
    stop: stopRR.stop, rrToT1: stopRR.rr1, rrToT2: stopRR.rr2,
    stopAtSpot: stopRRAtSpot.stop, rrToT1AtSpot: stopRRAtSpot.rr1, rrToT2AtSpot: stopRRAtSpot.rr2,
  };
}
