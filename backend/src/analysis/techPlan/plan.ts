/**
 * computeTechnicalPlanV7 (fullStockAnalysisV10_9.gs:2773-3033), assembled
 * from the tiers already ported and parity-tested one by one:
 *   Tier A  scoring.ts computeTechScoreCore     (regime, signals, techScore, headline weights)
 *   Tier B  entryPlan.ts computeEntryPlan       (entry, timing, targets, ETAs, stop / R:R both ways)
 *   Tier C  stops.ts + additive.ts              (four extra stops, sizing, leverage, fan, channel)
 *   Tier D  drivers.ts                          (drivers table, secular read)
 * The returned object has legacy's keys in legacy's order. A throw anywhere
 * (legacy's drivers table dereferences rsi14/adx14/gann.pivot unguarded)
 * propagates, as in legacy, to the caller's top-level catch.
 */

import type { Chart } from '../../types/chart.ts';
import type { Indicators } from '../../types/indicators.ts';
import type { GannRead } from '../gann.ts';
import type { ConfluenceMethod, ConfluenceTargets } from '../confluence.ts';
import { computeTechScoreCore, type OptionsAnalysis, type Regime } from './scoring.ts';
import { computeEntryPlan, type EntryPlan, type ExitTargetOptions } from './entryPlan.ts';
import {
  computeClassicalStop, computeBasingPointStop, computeAlternateBasingPoint, computeSidewaysBasingPoint,
  type ClassicalStop, type BasingPointStop,
} from './stops.ts';
import {
  computeNNormalizedPositionSize, computeCompositeLeverage, computeFanPrinciple, computeTrendChannel,
  type NNormalizedPositionSize, type CompositeLeverage, type FanPrinciple, type TrendChannel,
} from './additive.ts';
import { computeDrivers, computeSecularRead, type Driver, type SecularRead } from './drivers.ts';

/** The options read the plan carries (`options`) -- the scoring stage's object, passed through. */
export type PlanOptions = OptionsAnalysis & { readonly ivRank?: number | null };

export interface TechnicalPlan<O extends PlanOptions = PlanOptions> extends EntryPlan {
  techScore: number;
  regime: Regime;
  headlineWeights: Record<string, number>;
  headlineUsedDefaultWeights: boolean;
  classicalStop: ClassicalStop | null;
  basingPointStop: BasingPointStop | null;
  alternateBasingPointStop: BasingPointStop | null;
  sidewaysBasingPointStop: BasingPointStop | null;
  nNormalizedPositionSize: NNormalizedPositionSize | null;
  compositeLeverage: CompositeLeverage | null;
  fanPrinciple: FanPrinciple | null;
  trendChannel: TrendChannel | null;
  drivers: Driver[];
  entryMethods: ConfluenceMethod[];
  exitMethods: ConfluenceMethod[];
  atr14: number | null;
  secular: SecularRead | null;
  entryCount: number;
  /** Legacy: `(opt && opt.available) ? opt : null`; runAnalysisV7 overwrites it with the finalized read. */
  options: O | null;
  /** Set by the analysis run when the SPY fetch degraded (:1379-1381). */
  dataWarning?: string | null;
}

export type PlanChart = Pick<Chart, 'closes' | 'highs' | 'lows' | 'dates' | 'volumes' | 'currentPrice'>;

export function computeTechnicalPlan<O extends PlanOptions>(
  ind: Indicators, gann: GannRead, confluence: ConfluenceTargets, chart: PlanChart, optAnalysis: O | null | undefined,
  targetOptions: ExitTargetOptions = {},
): TechnicalPlan<O> {
  const opt = optAnalysis ?? null;
  const core = computeTechScoreCore(ind, gann, chart, opt);
  const regime = core.regime;
  const ep = computeEntryPlan(ind, gann, confluence, chart, opt, regime, core.overallSig, targetOptions);
  const classicalStop = computeClassicalStop(chart, ind, 'long');
  const basingPointStop = computeBasingPointStop(chart, ind, 'long');
  const alternateBasingPointStop = computeAlternateBasingPoint(chart, ind, 'long');
  const sidewaysBasingPointStop = computeSidewaysBasingPoint(chart, ind, 'long');
  // Legacy passes ind.turtleN / ind.atrRatio as they are (possibly null); both helpers reject a non-finite value.
  const nNormalizedPositionSize = computeNNormalizedPositionSize(ep.entryPrice, ind.turtleN as number);
  const compositeLeverage = computeCompositeLeverage(ep.entryPrice, ind.atrRatio as number);
  const fanPrinciple = regime === 'TREND_UP' ? computeFanPrinciple(chart, 'bullCorrection') : regime === 'TREND_DOWN' ? computeFanPrinciple(chart, 'bearRecovery') : null;
  const trendChannel = regime === 'TREND_UP' ? computeTrendChannel(chart, 'up') : regime === 'TREND_DOWN' ? computeTrendChannel(chart, 'down') : null;
  const drivers = computeDrivers(ind, regime, gann);
  return {
    techScore: core.techScore, regime, timing: ep.timing,
    headlineWeights: core.headlineWeights, headlineUsedDefaultWeights: core.headlineUsedDefaultWeights,
    entryPrice: ep.entryPrice, entryLow: ep.entryLow, entryHigh: ep.entryHigh, entryConfidencePct: ep.entryConfidencePct,
    timeToEntry: ep.timeToEntry, t1: ep.t1, t1Time: ep.t1Time, t2: ep.t2, t2Time: ep.t2Time,
    stop: ep.stop, rrToT1: ep.rrToT1, rrToT2: ep.rrToT2,
    stopAtSpot: ep.stopAtSpot, rrToT1AtSpot: ep.rrToT1AtSpot, rrToT2AtSpot: ep.rrToT2AtSpot,
    classicalStop, basingPointStop, alternateBasingPointStop, sidewaysBasingPointStop,
    nNormalizedPositionSize, compositeLeverage, fanPrinciple, trendChannel,
    drivers, entryMethods: confluence.entryMethods || [], exitMethods: confluence.exitMethods || [],
    atr14: ind.atr14,
    secular: computeSecularRead(chart.closes),
    entryCount: confluence.entryCount,
    options: (opt && opt.available) ? opt : null,
  };
}
