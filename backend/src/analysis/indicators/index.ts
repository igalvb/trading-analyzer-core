/**
 * computeIndicators -- the 31 verified slices assembled into one object.
 *
 * This is the port's equivalent of legacy computeAllIndicators (:6249-8062,
 * 1,814 lines). The behaviour lives in the slices, which were each ported and
 * differentially verified on their own; this file contributes NO arithmetic.
 * It only decides what runs, in what order, and what happens when one throws.
 *
 * ══ WHY AN ASSEMBLER AT ALL ════════════════════════════════════════════
 * Until now every parity test fed the ORACLE's indicator object into the
 * ported consumers, which verified the consumers but left one gap wide open:
 * nothing proved the 31 slices COMBINE into the same object. Fields could be
 * individually exact and the assembled whole still be wrong -- a missing key,
 * a duplicated key silently overwriting another, a slice whose input subset
 * was wrong. This file closes that gap, and indicators.assembly.test.ts
 * compares the whole object with deepStrictEqual rather than field by field.
 *
 * ══ ONE REAL BEHAVIOURAL DIFFERENCE, DELIBERATE ════════════════════════
 * Legacy computeAllIndicators is a single function body. A throw anywhere in
 * it that is not caught by one of its inner try blocks loses EVERY field --
 * the caller gets nothing and the ticker is dead for the run. Here each slice
 * is isolated: if one throws, its fields are simply ABSENT from the result
 * (not defaulted -- absent, which is why every consumer reads them as
 * `T | null`), every other slice still lands, and the failure is reported
 * through onSliceError rather than swallowed.
 *
 * That is strictly more resilient, and it CANNOT change any number on the
 * success path -- which is the path parity is measured on.
 *
 * ══ HOW RESILIENT, MEASURED ════════════════════════════════════════════
 * The claim above is measured, not asserted. Two things were checked, and
 * the first attempt at checking was WRONG in an instructive way.
 *
 * Corrupting `dates` into non-Date values fails ZERO slices -- every slice
 * carries its own internal try/catch, ported from the legacy inner guards,
 * so the assembler's catch is never reached that way. The first version of
 * this comment claimed that test proved isolation. It proved nothing.
 *
 * What DOES reach it: `volumes: null` on a real NVDA chart. Measured result
 * (indicators.assembly.test.ts asserts all of it):
 *   - 6 slices throw (oscillator, volume, divergence, composite, wyckoff,
 *     events) and contribute nothing -- 22 of the 115 fields are absent
 *   - the other 25 slices still land, giving 93 fields
 *   - 87 of those 93 are still EXACTLY oracle-equal
 *   - 6 (volumePOC, chartPatterns, priceGaps, trendAlignedVolume,
 *     volumeProgressDivergence, srLevels) differ because they read volume
 *     and their own internal guard degraded them gracefully rather than
 *     throwing -- which is the designed behaviour, not a defect
 * Legacy, in the same situation, loses all 115.
 */

import type { Chart } from '../../types/chart.ts';
import type { Indicators } from '../../types/indicators.ts';
import {
  computeRsiSlice, computeMacdSlice, computeBollingerSlice, computeStochasticSlice,
  computeOscillatorSlice, computeAtrSlice, computeTrendStrengthSlice, computeVolumeSlice,
  computeMovingAverageSlice, computeMomentumSlice, computeFibonacciSlice, computePivotSlice,
  computeChannelSlice, computeAroonSlice, computeDonchianSlice, computeParabolicSarSlice,
  computeSuperTrendSlice, computeIchimokuSlice, computeVolumeProfileSlice, computeVolatilitySlice,
  computeTrailingPerfSlice, computeRelativeStrengthSlice, computeDivergenceSlice,
  computeCompositeSlice, computeTrendMaturitySlice, computeChartPatternsSlice,
  computeWyckoffSlice, computePriceGapsSlice, computeVolumeStructureSlice,
} from './slices.ts';
import { computeSrFamilySlice } from './srLevels.ts';
import { computeEventsSlice } from './events.ts';

/** Reported when one slice fails. Every other slice still runs. */
export interface SliceFailure {
  readonly slice: string;
  readonly cause: unknown;
}

export interface ComputeIndicatorsOptions {
  /**
   * Injectable clock, threaded to the events slice. Without it, lockup
   * expiration depends on wall-clock time and the output is not reproducible
   * -- which is why the slice takes it rather than reading Date.now().
   */
  readonly simulatedNow?: Date;
  /** Called once per failing slice. Logging belongs to the caller. */
  readonly onSliceError?: (failure: SliceFailure) => void;
  /**
   * The ticker's 10-year closes (fetch/yahoo.ts fetchYahooChartLongRange),
   * for trailingPerf's threeYear / fiveYear / tenYear. Legacy fetched these
   * inside computeAllIndicators (:7361); the caller now supplies them.
   * Absent or null: those three stay null, as when legacy's fetch failed.
   */
  readonly longCloses?: readonly number[] | null;
}

/**
 * The 31 slices, in the order legacy computes them.
 *
 * ORDER IS NOT ARBITRARY and is not a style choice: it mirrors the legacy
 * function's own top-to-bottom order so that a future slice needing an
 * earlier slice's output can be added without reshuffling. No slice currently
 * reads another's output -- every one takes only the chart -- which is why
 * this list can be run with a plain loop.
 */
const SLICES: ReadonlyArray<readonly [string, (c: Chart, o: ComputeIndicatorsOptions) => object]> = [
  ['rsi', (c) => computeRsiSlice(c)],
  ['macd', (c) => computeMacdSlice(c)],
  ['bollinger', (c) => computeBollingerSlice(c)],
  ['stochastic', (c) => computeStochasticSlice(c)],
  ['oscillator', (c) => computeOscillatorSlice(c)],
  ['atr', (c) => computeAtrSlice(c)],
  ['trendStrength', (c) => computeTrendStrengthSlice(c)],
  ['volume', (c) => computeVolumeSlice(c)],
  ['movingAverage', (c) => computeMovingAverageSlice(c)],
  ['momentum', (c) => computeMomentumSlice(c)],
  ['fibonacci', (c) => computeFibonacciSlice(c)],
  ['pivot', (c) => computePivotSlice(c)],
  ['channel', (c) => computeChannelSlice(c)],
  ['aroon', (c) => computeAroonSlice(c)],
  ['donchian', (c) => computeDonchianSlice(c)],
  ['parabolicSar', (c) => computeParabolicSarSlice(c)],
  ['superTrend', (c) => computeSuperTrendSlice(c)],
  ['ichimoku', (c) => computeIchimokuSlice(c)],
  ['volumeProfile', (c) => computeVolumeProfileSlice(c)],
  ['volatility', (c) => computeVolatilitySlice(c)],
  ['trailingPerf', (c, o) => computeTrailingPerfSlice(c, o.longCloses)],
  ['relativeStrength', (c) => computeRelativeStrengthSlice(c)],
  ['divergence', (c) => computeDivergenceSlice(c)],
  ['composite', (c) => computeCompositeSlice(c)],
  ['trendMaturity', (c) => computeTrendMaturitySlice(c)],
  ['chartPatterns', (c) => computeChartPatternsSlice(c)],
  ['wyckoff', (c) => computeWyckoffSlice(c)],
  ['priceGaps', (c) => computePriceGapsSlice(c)],
  ['volumeStructure', (c) => computeVolumeStructureSlice(c)],
  ['srFamily', (c) => computeSrFamilySlice(c)],
  ['events', (c, o) => computeEventsSlice({ ...c, simulatedNow: o.simulatedNow })],
];

export const SLICE_COUNT = SLICES.length;

/**
 * Computes the indicator set for one chart: all 115 fields on the success
 * path, fewer if a slice failed.
 *
 * Never throws. A slice that fails contributes nothing rather than killing
 * the ticker, and reports through onSliceError. The returned object is
 * therefore always usable, though possibly missing a family of fields --
 * which every downstream consumer already handles, because every scalar
 * indicator is `T | null` by design.
 */
export function computeIndicators(
  chart: Chart,
  options: ComputeIndicatorsOptions = {},
): Indicators {
  const out: Record<string, unknown> = {};
  for (const [name, run] of SLICES) {
    try {
      Object.assign(out, run(chart, options));
    } catch (cause) {
      options.onSliceError?.({ slice: name, cause });
    }
  }
  return out as unknown as Indicators;
}
