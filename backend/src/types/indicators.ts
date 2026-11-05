/**
 * The indicator set returned by computeAllIndicators.
 *
 * 115 fields, enumerated from a real run against a real fixture on
 * 2026-09-13 rather than read off the source: 76 numbers, 12 booleans,
 * 2 strings, 17 objects, 2 arrays, and 6 that were null for that fixture.
 *
 * TYPING POLICY, per the project's tsconfig philosophy (permissive first,
 * tightened over time):
 *   - Scalars are `T | null`. Almost every indicator returns null when there
 *     is insufficient history, and strictNullChecks is on from day one, so
 *     callers are forced to handle that rather than reading NaN.
 *   - Composite sub-objects whose shape is not yet established are typed as
 *     `IndicatorDetail` and carry a TODO(types) marker. They are tightened
 *     as each is genuinely needed by a ported consumer -- not speculatively.
 *
 * This interface is deliberately NOT the port's source of truth for
 * behaviour. The oracle is. This describes what the oracle produces.
 */

/**
 * A composite sub-object not yet fully typed.
 * TODO(types): narrow each of these as its consumer is ported.
 */
export type IndicatorDetail = Record<string, unknown>;

// Type-only, and therefore erased: slices.ts imports Indicators from here,
// so a VALUE import would be a real cycle. These two shapes are defined
// beside the slices that produce them, which is their natural home.
import type { RelativeStrength, TrailingPerf } from '../analysis/indicators/slices.ts';
export type { RelativeStrength, TrailingPerf };

export interface Indicators {
  // ── Price extremes and position ──────────────────────────────────────
  last: number | null;
  high52: number | null;
  low52: number | null;
  fibPct: number | null;
  range52Pct: number | null;

  // ── Oscillators ──────────────────────────────────────────────────────
  rsi14: number | null;
  rsiWeekly: number | null;
  stochK: number | null;
  stochD: number | null;
  stochRSI: number | null;
  willR: number | null;
  cci20: number | null;
  mfi14: number | null;

  // ── MACD ─────────────────────────────────────────────────────────────
  macdVal: number | null;
  sigVal: number | null;
  histogram: number | null;
  histSlope: number | null;

  // ── Bollinger / Keltner ──────────────────────────────────────────────
  bbUpper: number | null;
  bbLower: number | null;
  bbPctB: number | null;
  bbWidth: number | null;
  bbSqueeze: boolean;
  sma20v: number | null;
  keltnerUpper: number | null;
  keltnerLower: number | null;
  keltnerSqueeze: boolean;

  // ── Volatility / range ───────────────────────────────────────────────
  atr14: number | null;
  atrRatio: number | null;
  turtleN: number | null;
  weeklyVolatilityPct: number | null;
  monthlyVolatilityPct: number | null;
  weeklyVolatility: IndicatorDetail | null;
  monthlyVolatility: IndicatorDetail | null;

  // ── Trend strength ───────────────────────────────────────────────────
  adx14: number | null;
  adxBullish: boolean;
  shortSlope: number | null;
  weeklyTrend: string | null;
  trendMaturity: IndicatorDetail | null;

  // ── Moving averages ──────────────────────────────────────────────────
  sma20: number | null;
  sma50: number | null;
  sma150: number | null;
  sma200: number | null;
  ema9: number | null;
  ema21: number | null;
  above200: boolean;
  above50: boolean;
  goldenCross: boolean;
  deathCross: boolean;
  pctFromSma20: number | null;
  pctFromSma50: number | null;
  pctFromSma200: number | null;

  // ── Momentum ─────────────────────────────────────────────────────────
  roc10: number | null;
  roc26: number | null;
  roc52: number | null;
  roc252: number | null;
  mom5: number | null;
  mom20: number | null;

  // ── Volume ───────────────────────────────────────────────────────────
  obvShortSlope: number | null;
  obvLongSlope: number | null;
  cmf20: number | null;
  volRatio: number | null;
  volumePOC: number | null;
  climaxVolume: boolean;
  trendAlignedVolume: IndicatorDetail | null;
  volumeProgressDivergence: IndicatorDetail | null;
  speculativeSpike: IndicatorDetail | null;

  // ── Fibonacci / pivots ───────────────────────────────────────────────
  fib236: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
  fib786: number | null;
  pivot: number | null;
  pp_R1: number | null;
  pp_S1: number | null;
  pp_R2: number | null;
  pp_S2: number | null;
  abovePivot: boolean;
  halfwayRetracementRead: IndicatorDetail | null;

  // ── Channels / stops ─────────────────────────────────────────────────
  donchianUpper: number | null;
  donchianLower: number | null;
  donchianMid: number | null;
  donchian55Upper: number | null;
  donchian55Lower: number | null;
  chandelierStop: number | null;
  chandelierHighestHigh: number | null;
  parabolicSAR: number | null;
  parabolicSARBullish: boolean;
  superTrend: number | null;
  superTrendBullish: boolean;
  progressiveStopFlag: IndicatorDetail | null;

  // ── Ichimoku ─────────────────────────────────────────────────────────
  tenkanSen: number | null;
  kijunSen: number | null;
  senkouSpanA: number | null;
  senkouSpanB: number | null;
  ichimokuCloudBullish: boolean;

  // ── Aroon ────────────────────────────────────────────────────────────
  aroonUp: number | null;
  aroonDown: number | null;

  // ── Divergences ──────────────────────────────────────────────────────
  divergence: IndicatorDetail | null;
  macdDivergence: IndicatorDetail | null;
  obvDivergence: IndicatorDetail | null;

  // ── Structure and patterns ───────────────────────────────────────────
  breakoutContext: string | null;
  monthlyStructure: IndicatorDetail | null;
  srLevels: IndicatorDetail | null;
  srMultiTimeframe: IndicatorDetail | null;
  chartPatterns: IndicatorDetail[];
  priceGaps: IndicatorDetail[];
  wyckoffSchematic: IndicatorDetail | null;
  singleCandle: IndicatorDetail | null;
  dpoSignature: IndicatorDetail | null;
  roundNumber: IndicatorDetail | null;
  secondaryDay: IndicatorDetail | null;

  // ── Corporate actions / events ───────────────────────────────────────
  lockupExpiration: IndicatorDetail | null;
  recentReverseSplit: IndicatorDetail | null;

  // ── Relative strength / performance ──────────────────────────────────
  /** Null unless a benchmark series was supplied. */
  /** Null unless a benchmark series was supplied. */
  /**
   * Tightened from IndicatorDetail once a ported consumer needed the real
   * shape -- the drivers table (techPlan/drivers.ts) reads rs.rs63,
   * rs.outperforming and all nine trailingPerf windows by name. Exactly the
   * "narrow as its consumer is ported, not speculatively" policy at the top
   * of this file.
   */
  rs: RelativeStrength | null;
  trailingPerf: TrailingPerf | null;
}

/** Every key the oracle actually returned. Used to assert the port is complete. */
export const INDICATOR_KEYS: readonly (keyof Indicators)[] = [
  'last', 'high52', 'low52', 'rsi14', 'rsiWeekly', 'weeklyTrend', 'macdVal', 'sigVal',
  'histogram', 'histSlope', 'bbUpper', 'bbLower', 'bbPctB', 'bbWidth', 'bbSqueeze',
  'sma20v', 'stochK', 'stochD', 'stochRSI', 'willR', 'cci20', 'mfi14', 'atr14',
  'atrRatio', 'adx14', 'adxBullish', 'obvShortSlope', 'obvLongSlope', 'cmf20',
  'volRatio', 'sma20', 'sma50', 'sma150', 'sma200', 'ema9', 'ema21', 'above200',
  'above50', 'goldenCross', 'deathCross', 'trendMaturity', 'singleCandle',
  'dpoSignature', 'pctFromSma20', 'pctFromSma50', 'pctFromSma200', 'roc10', 'roc26',
  'roc52', 'roc252', 'mom5', 'mom20', 'fibPct', 'range52Pct', 'fib236', 'fib382',
  'fib500', 'fib618', 'fib786', 'pivot', 'pp_R1', 'pp_S1', 'pp_R2', 'pp_S2',
  'abovePivot', 'shortSlope', 'breakoutContext', 'climaxVolume', 'progressiveStopFlag',
  'turtleN', 'roundNumber', 'secondaryDay', 'lockupExpiration', 'recentReverseSplit',
  'divergence', 'macdDivergence', 'obvDivergence', 'rs', 'keltnerUpper', 'keltnerLower',
  'keltnerSqueeze', 'chandelierStop', 'chandelierHighestHigh', 'monthlyStructure',
  'volumePOC', 'trailingPerf', 'priceGaps', 'chartPatterns', 'weeklyVolatilityPct',
  'monthlyVolatilityPct', 'weeklyVolatility', 'monthlyVolatility', 'srLevels',
  'srMultiTimeframe', 'speculativeSpike', 'aroonUp', 'aroonDown', 'donchianUpper',
  'donchianLower', 'donchianMid', 'donchian55Upper', 'donchian55Lower', 'parabolicSAR',
  'parabolicSARBullish', 'superTrend', 'superTrendBullish', 'tenkanSen', 'kijunSen',
  'senkouSpanA', 'senkouSpanB', 'ichimokuCloudBullish', 'wyckoffSchematic',
  'trendAlignedVolume', 'volumeProgressDivergence', 'halfwayRetracementRead',
];
