/**
 * Decision-layer types.
 *
 * These encode the engine's native vocabulary, which is BUY-SIDE:
 * timing is one of BUY_NOW / WAIT_PULLBACK / AVOID, and the action matrix
 * produces buy-framed verdicts. That is a real property of the engine
 * (fullStockAnalysisV10_9.gs:2946-2948, :3182-3187), not a naming choice --
 * and it is why the Exit report needs its own reframing layer while the Buy
 * report is the engine's natural output.
 */

/** Only reachable from TREND_UP (:2947). */
export type Timing = 'BUY_NOW' | 'WAIT_PULLBACK' | 'AVOID';

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'CHOP' | 'HIGH_VOL';

/** Fundamental band, the row key of the 4x3 action matrix (:3182-3187). */
export type FundBand = 'own' | 'mixed' | 'weak' | 'unknown';

export interface TargetLevel {
  readonly price: number;
  readonly label?: string;
}

export interface TechPlan {
  readonly techScore: number | null;
  readonly regime: Regime | null;
  readonly timing: Timing | null;
  readonly entryPrice: number | null;
  readonly entryLow: number | null;
  readonly entryHigh: number | null;
  readonly stop: number | null;
  readonly t1: TargetLevel | null;
  readonly t2: TargetLevel | null;
  readonly rrToT1: number | null;
  readonly rrToT2: number | null;
  readonly entryConfidencePct: number | null;
  readonly timeToEntry: { readonly humanText: string; readonly agreement: string } | null;
  readonly secular: { readonly verdict: string; readonly why: string } | null;
  readonly dataWarning?: string | null;
}

export interface FundResult {
  readonly score: number | null;
  readonly verdict: string | null;
  readonly profile: string | null;
  readonly drivers: ReadonlyArray<{ label: string; value: unknown; note?: string }>;
  readonly pricedForPerfection?: boolean;
  readonly dataWarning?: string | null;
}

export interface Decision {
  readonly action: string;
  readonly finalConviction: number;
  readonly fundBand: FundBand | null;
  readonly convNotes?: readonly string[];
}

/**
 * The six fields the end-to-end gate compares.
 *
 * Chosen because together they determine what the user is told to DO: the
 * verdict string, how strongly, on what fundamental footing, with what
 * timing, under which regime. Everything else in a report is elaboration.
 *
 * All six are non-nullable. The phase-0 version of this interface allowed
 * null on every field, which was right while nothing produced it; now that
 * pipeline.fingerprintOf does, a null here would mean the pipeline failed
 * rather than produced a weak verdict -- and that case is a thrown error or
 * a failed StepResult, never a fingerprint with holes in it.
 *
 * Verified 2026-10-08: 375 fingerprints over 25 fixture tickers x 5
 * fundamental scores x 3 macro states, all exactly equal to the oracle's own
 * full chain, with the port computing every stage from the raw chart.
 */
export interface DecisionFingerprint {
  readonly ticker: string;
  readonly finalConviction: number;
  readonly action: string;
  readonly fundBand: string;
  readonly timing: string;
  readonly regime: string;
}

/**
 * Conviction thresholds, ported verbatim from :3204-3205.
 *
 * The legacy code flags its own uncertainty here and that flag is carried
 * forward deliberately (:3202-3203): "20 (the floor) is a reasoned default,
 * NOT empirically validated -- worth revisiting against real data, flagged
 * here so that's not lost."
 *
 * Since conviction is the Buy report's primary ranking key, this caveat
 * belongs in the report's methodology footer, not just in a comment.
 */
export const OWN_FILTER_THRESHOLD = 43;
export const OWN_BLOCK_FLOOR = 20;
