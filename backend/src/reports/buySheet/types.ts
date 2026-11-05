/**
 * FL-8r: the input shape of the single combined Buy report sheet. The Buy pipeline (src/jobs/buy, FL-8p) produces a
 * BuyRun whose candidates are structurally assignable to BuyCandidateInput (models, comparison and options arrive as
 * `unknown` there and are parsed defensively here). The report never imports the pipeline.
 */
import type { QualityItem, ReasonCode } from '../messages/catalog.ts';

export type BuyTier = 1 | 2 | 3;
export type BuyStatus = 'ok' | 'degraded' | 'failed';
import type { ModelId, Stance, ComparisonRead, FundamentalsInput, PositioningInput } from '../exitSheet/types.ts';
// Identical with the Exit sheet's types: one definition (dedupe cluster 10).
export type { ModelId, Stance, ComparisonRead, FundamentalsInput, PositioningInput };

/** One model's independent read. Display only: the report never scores or re-decides anything. */
export interface ModelRead { readonly model: ModelId; readonly stance: Stance; readonly score?: number | null; readonly reasonCode?: ReasonCode }


/** A recommended-call pick (long calls only), shaped like the legacy pick of buildBottomLineSummaryV7 (:5398-5410). */
export interface OptionPickContract { readonly strike: number | string; readonly expUnix: number; readonly delta: number; readonly iv?: number | null }
export interface OptionPick { readonly found?: boolean; readonly reason?: string; readonly contract?: OptionPickContract }
export interface OptionsPicks { readonly leaps?: OptionPick | null; readonly shortTerm?: OptionPick | null }



export interface BuyCandidateInput {
  readonly ticker: string;
  readonly status: BuyStatus;
  readonly tier: BuyTier;
  /** 1-based, unique per candidate, in report order. */
  readonly rank: number;
  /** Ranking slot: Bitcoin-group followers share the slot of the best-ranked member. */
  readonly slot: number;
  readonly buyNow: boolean;
  readonly blocked: boolean;
  readonly conviction: number | null;
  readonly entryConfidencePct: number | null;
  readonly ownScore: number | null;
  /** 'own' | 'mixed' | 'weak' | 'unknown' (the engine's fundamental band). */
  readonly ownBand: string | null;
  /** 'BUY_NOW' | 'WAIT_PULLBACK' | 'AVOID'. */
  readonly timing: string | null;
  /** 'TREND_UP' | 'TREND_DOWN' | 'CHOP' | 'HIGH_VOL'. */
  readonly regime: string | null;
  readonly action: string | null;
  readonly entryZone: { readonly low: number | null; readonly center: number | null; readonly high: number | null };
  readonly timeToEntry: string | null;
  readonly stop: number | null;
  readonly rrToT1: number | null;
  readonly rrToT2: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly entryLadder: { readonly rungs: ReadonlyArray<{ readonly rung: number; readonly price: number }>; readonly percents: readonly number[] };
  /** Relative sizing only: no share count, no dollar figures. */
  readonly sizing: { readonly firstUnitRiskPctOfAccount: number; readonly n: number | null; readonly stopLevel: number | null } | null;
  readonly sizingText: string | null;
  /** Expected: ModelRead[] (see readModels). Anything else renders as "did not run". */
  readonly models: unknown;
  /** Expected: ComparisonRead (see readComparison). */
  readonly comparison: unknown;
  /** FL-17b: Expected: ExtraModelsReport (analysis/extraModels.ts readExtraModels). Display only; absent = no rows. */
  readonly extraModels?: unknown;
  /** Expected: OptionsPicks (see readOptions). Pipeline sets it for Tier 1 only. */
  readonly options: unknown;
  readonly held: { readonly stockShares: number | null; readonly hasOptions: boolean } | null;
  readonly addToPosition: boolean;
  readonly opportunityCost: readonly string[];
  /** Tier 2 only: the concrete condition that would promote it. */
  readonly promotion: string | null;
  readonly change: { readonly from: string; readonly to: string; readonly fromConviction: number | null } | null;
  readonly bitcoinGroup: boolean;
  /** dataQualityLines output: 'Data quality', then one line per issue (or 'No data issues.'). */
  readonly dataHealth: readonly string[];
  /** Plain sentence for a failed/degraded candidate. */
  readonly note: string | null;
  // ---- optional additions (F-R1): not on the FL-8p candidate yet ----
  /** Legacy TIMING column (techPlan.techScore). */
  readonly techScore?: number | null;
  /** Legacy "R:R at today's price" (:5432). */
  readonly rrToT1AtSpot?: number | null;
  readonly fundamentals?: FundamentalsInput | null;
  readonly positioning?: PositioningInput | null;
}

export interface BitcoinSharedThesisInput {
  readonly anchorSeries: string;
  readonly regime: string | null;
  readonly trend: string | null;
  readonly trendMaturity: string | null;
  readonly rsi: number | null;
  readonly stochRsi: number | null;
  readonly pattern: string | null;
  readonly momentum: string | null;
  readonly thesis: string | null;
}
export interface BitcoinDifferentiator {
  readonly ticker: string;
  readonly expenseRatioPct?: number | null;
  readonly avgDailyVolume?: number | null;
  readonly premiumDiscountPct?: number | null;
}
export interface BitcoinGroupInput {
  /** The group members that are actually candidates (resolved by the pipeline, never assumed). */
  readonly members: readonly string[];
  readonly substitutesText?: string | null;
  readonly sharedThesis?: BitcoinSharedThesisInput | null;
  readonly differentiators?: readonly BitcoinDifferentiator[] | null;
}

export interface BuyReportInput {
  readonly runAt: Date;
  readonly candidates: readonly BuyCandidateInput[];
  /** Pipeline text for "nothing actionable" / "no candidates"; the report has its own fallbacks. */
  readonly emptyText?: string | null;
  readonly bitcoin?: BitcoinGroupInput | null;
  readonly seeded?: boolean;
  readonly portfolioOk?: boolean;
  /** Run-level data issues (catalog QualityItems). */
  readonly dataHealth?: readonly QualityItem[];
  /** Default 70 / 45 (plan §7.1: reasoned starting points, not validated). */
  readonly tiers?: { readonly tier1Min: number; readonly tier2Min: number };
  /** Replaces the default methodology caveat lines when given (e.g. the pipeline's own list). */
  readonly methodologyCaveats?: readonly string[];
  /**
   * Options sentiment A-8 (shadow): one line per stock with tonight's options read and what it would change if applied,
   * and the stocks without a read (A-7). The section is shown only when at least one line exists.
   */
  readonly optionsReads?: { readonly lines: readonly string[]; readonly missing: readonly string[]; readonly applied: boolean } | null;
  /** Options sentiment part B (display only): the market options line (SPY / QQQ); shown under the banner when set. */
  readonly marketOptionsLine?: string | null;
}

export type OpusMode = 'REVIEW' | 'STANDALONE' | 'OFF';
export interface AiEntry {
  readonly ticker: string;
  readonly gemini?: string | null;
  readonly opus?: string | null;
}
export interface BuyAiSummariesInput {
  readonly ranAt: Date;
  readonly geminiUsed: boolean;
  readonly opusMode: OpusMode;
  /** For STANDALONE: why there was no Gemini narrative to review. */
  readonly standaloneWhy?: ReasonCode;
  readonly effort?: string | null;
  readonly entries: readonly AiEntry[];
  /** Every candidate on the report with its tier, so the scope line can name who was NOT covered. */
  readonly candidates: ReadonlyArray<{ readonly ticker: string; readonly tier: BuyTier }>;
}
