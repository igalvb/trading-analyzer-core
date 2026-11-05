/**
 * The analysis pipeline: one chart in, one decision out.
 *
 * This is the first module that runs the port END TO END on its own data.
 * Every earlier parity test fed the ORACLE's intermediate objects into a
 * ported consumer, which is the right way to isolate a single stage but
 * leaves the composition unverified. Here nothing comes from the oracle:
 * indicators, Gann, confluence, score, entry plan and decision are all the
 * port's, chained. decision.fingerprint.test.ts compares the result against
 * the oracle's own full chain.
 *
 * Verified 2026-10-08: 375 fingerprints exactly equal to the oracle's, and
 * 375 full headline+line renders identical character for character. Counted,
 * not estimated: test/fixtures/ currently holds 27 tickers, of which 26 clear
 * legacy's own 60-bar minimum (SPCX has 49) and 25 produce an oracle verdict
 * to compare against (_VIX crashes the oracle -- see F-14). Earlier planning
 * documents say 33; the directory says 27, and the 4 Bitcoin-ETF fixtures
 * (GBTC/BTC/FBTC/BITB) are still outstanding.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════
 * Tier C (8 additive stop/sizing/channel helpers) and Tier D (the drivers
 * array and computeSecularReadV7_) are not ported yet. Both are display-only:
 * the legacy source annotates each Tier C helper "purely additive ... does
 * not affect stop/rrToT1/rrToT2", and Tier D only adds `drivers` and
 * `secular`. Neither reaches any of the six fingerprint fields -- and the
 * fingerprint gate passing is what turns that claim from a reading of the
 * comments into a measured fact.
 *
 * Consequence: `secular` is absent from the tech plan this builds, so the
 * decision's rendered `lines` omit the "Secular (own for years?)" line that
 * legacy emits. That is the ONLY difference, and the gate proves it by also
 * comparing every line with the oracle's secular read injected.
 */

import type { Chart } from '../types/chart.ts';
import type { Indicators } from '../types/indicators.ts';
import type { GannRead } from './gann.ts';
import { computeGann } from './gann.ts';
import type { ConfluenceTargets, ConfluenceFundamentals } from './confluence.ts';
import { computeConfluenceTargets } from './confluence.ts';
import type { OptionsAnalysis, TechScoreCore, Regime } from './techPlan/scoring.ts';
import { computeTechScoreCore } from './techPlan/scoring.ts';
import type { EntryPlan, ExitTargetOptions } from './techPlan/entryPlan.ts';
import { computeEntryPlan } from './techPlan/entryPlan.ts';
import { computeIndicators, type ComputeIndicatorsOptions } from './indicators/index.ts';
import type {
  DecisionTechPlan, DecisionFundResult, DecisionOptions, MacroRead, Decision,
} from './decision.ts';
import { synthesizeDecision } from './decision.ts';
import type { StatusAccumulator } from '../core/status.ts';
import type { DecisionFingerprint } from '../types/decision.ts';

export type { DecisionFingerprint };

/** Options analysis as the scoring and entry-plan stages read it. */
export type PipelineOptions = (OptionsAnalysis & { ivRank?: number | null }) | null;

/** Everything the technical stages produced, kept for the report builders. */
export interface TechnicalRead {
  readonly indicators: Indicators;
  readonly gann: GannRead;
  readonly confluence: ConfluenceTargets;
  readonly core: TechScoreCore;
  readonly entryPlan: EntryPlan;
  /** The flattened shape the decision engine consumes. */
  readonly techPlan: DecisionTechPlan;
}

/**
 * Runs the technical half of the pipeline.
 *
 * Stage order is forced by data dependency, not preference: Gann needs the
 * indicators, confluence needs both, the score needs the indicators and Gann,
 * and the entry plan needs the confluence zones plus the score's regime and
 * overall signal. There is no room to reorder.
 */
export function computeTechnicalRead(
  chart: Chart,
  optAnalysis: PipelineOptions = null,
  fund: ConfluenceFundamentals | null = null,
  indicatorOptions: ComputeIndicatorsOptions = {},
  targetOptions: ExitTargetOptions = {},
): TechnicalRead {
  const indicators = computeIndicators(chart, indicatorOptions);
  const gann = computeGann(chart);
  const confluence = computeConfluenceTargets(indicators, gann, fund, chart);
  const core = computeTechScoreCore(indicators, gann, chart, optAnalysis);
  const entryPlan = computeEntryPlan(
    indicators, gann, confluence, chart, optAnalysis, core.regime, core.overallSig, targetOptions,
  );
  return {
    indicators, gann, confluence, core, entryPlan,
    techPlan: { ...entryPlan, techScore: core.techScore },
  };
}

export interface AnalyzeResult {
  readonly ticker: string;
  readonly technical: TechnicalRead;
  readonly decision: Decision;
  readonly regime: Regime;
}

/**
 * The whole pipeline: chart plus the two externally-fetched inputs
 * (fundamentals, options) plus the run-global macro read, to a decision.
 *
 * macroRead is a PARAMETER rather than something fetched here -- see the note
 * at the top of decision.ts. It is run-global: fetched once, passed to every
 * ticker.
 */
export function analyzeTicker(
  chart: Chart,
  fundResult: DecisionFundResult,
  optAnalysis: (DecisionOptions & { ivRank?: number | null }) | null = null,
  macroRead: MacroRead | null = null,
  status?: StatusAccumulator,
  indicatorOptions: ComputeIndicatorsOptions = {},
): AnalyzeResult {
  const technical = computeTechnicalRead(chart, optAnalysis, null, indicatorOptions);
  const decision = synthesizeDecision(fundResult, technical.techPlan, optAnalysis, macroRead, status);
  return { ticker: chart.ticker, technical, decision, regime: technical.core.regime };
}

export function fingerprintOf(result: AnalyzeResult): DecisionFingerprint {
  return {
    ticker: result.ticker,
    finalConviction: result.decision.finalConviction,
    action: result.decision.action,
    fundBand: result.decision.fundBand,
    timing: result.decision.timing,
    regime: result.regime,
  };
}
