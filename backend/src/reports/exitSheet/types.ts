/**
 * FL-8q: the input shape of the single combined Exit report sheet. The Exit pipeline (src/jobs/exit, FL-8o) maps
 * its own output onto this; the report never imports the pipeline. Every field is a number, an enum, a ticker, a
 * catalog ReasonCode or a QualityItem -- no free text -- so nothing technical can reach the sheet.
 */
import type { QualityItem, ReasonCode } from '../messages/catalog.ts';
import type { BullPhaseAdvisory, ExitSignals } from '../exit/exitReport.ts';

export type ModelId = 'ENGINE' | 'SCHABACKER' | 'EDWARDS_MAGEE' | 'BROKER_COURSE' | 'TURTLE';
export type Stance = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'UNAVAILABLE';

/** One model's independent read. Display only: the report never scores or re-decides anything. */
export interface ModelRead {
  readonly model: ModelId; readonly stance: Stance; readonly score: number | null; readonly reasonCode?: ReasonCode;
  /** Row 35 (#37): the engine's final conviction (0-100), display only. */
  readonly conviction?: number | null;
  /** Row 35 (#37): a book model's signal count (its synthesis: for / against), display only; the models count, they do not score. */
  readonly signals?: { readonly pro: number; readonly con: number } | null;
}
export interface ComparisonRead { readonly agreeCount: number; readonly totalCount: number; readonly majority: Stance | null; readonly dissenters: readonly ModelId[] }

export interface PositionInput {
  /** Shares, or contracts for an option. */
  readonly quantity: number | null;
  /** Average cost per share, or premium paid per share for an option. */
  readonly avgCost: number | null;
  /** 'YYYY-MM-DD' or 'M/D/YYYY'; null when the Portfolio sheet has no Purchase Data. */
  readonly entryDate: string | null;
  /** Row 36: entryDate is the assumed 2020-01-01 for a stock row with no purchase date (not a real date). */
  readonly entryDateAssumed?: boolean;
  /** Current stock price, or current option price (mark) for an option. */
  readonly currentPrice: number | null;
}

export interface OptionContractInput {
  readonly right: 'CALL' | 'PUT';
  readonly strike: number;
  readonly expiry: string;
  readonly daysToExpiry: number | null;
  readonly expiryThreshold: number | null;
  readonly expiryWarning: boolean;
  readonly underlyingPrice: number | null;
}

export interface ExitLevels {
  readonly stopLevel: number | null;
  readonly stopBasis: 'SINCE_ENTRY' | 'SINCE_ASSUMED_ENTRY' | 'GENERIC' | 'WEEKLY' | null;
  /** Owner 2026-11-05 (weeklyStops flag only): one line per exit rule checked. Present = a missing target reads "no valid target". */
  readonly weeklyLines?: readonly string[];
  /** Weekly-stops flag only: every model's read on the holding (owner 2026-11-05: the exit takes all the models into account). */
  readonly weeklyVotes?: ReadonlyArray<{ readonly model: string; readonly read: 'SELL' | 'HOLD' | 'BUY' | 'NA'; readonly why: string }>;
  readonly stopBreached: boolean;
  readonly thesisInvalidated: boolean;
  readonly t1: number | null;
  readonly hitT1: boolean;
  readonly t2: number | null;
  readonly hitT2: boolean;
  readonly highestHighSinceEntry?: number | null;
  /** F-X1, forward-looking reads only: percent above the current price (positive = target still ahead). */
  readonly distanceToT1Pct?: number | null;
  readonly distanceToT2Pct?: number | null;
}

export interface FundamentalsInput { readonly ownScore: number | null; readonly band: string | null; readonly unavailable?: ReasonCode }
export interface PositioningInput {
  readonly institutionalHolders: number | null;
  readonly darkPoolPct: number | null;
  readonly shortInterestPct: number | null;
  readonly unavailable?: ReasonCode;
}

/** F-X2: how many to sell. Lines are plain English built by portfolio/sellPlan.ts and leak-scanned by the adapter. */
export interface SellPlanView {
  /** The first line is the one-line summary. */
  readonly lines: readonly string[];
  /** One short line about the remembered targets (Exit Target History). */
  readonly memoryLine?: string | null;
}

export interface ExitHoldingInput {
  readonly ticker: string;
  readonly kind: 'STOCK' | 'OPTION';
  readonly position: PositionInput;
  readonly option?: OptionContractInput | null;
  /** The legacy formatStockSignals / formatOptionsSignals result. Absent or an 'ERROR...' summary = no verdict. */
  readonly signals?: ExitSignals | null;
  readonly levels?: ExitLevels | null;
  /** Up to 5 reads; any of the 5 models not listed shows as 'not run'. */
  readonly models: readonly ModelRead[];
  readonly comparison?: ComparisonRead | null;
  /** FL-17b: Expected: ExtraModelsReport (analysis/extraModels.ts readExtraModels). Display only; absent = no rows. */
  readonly extraModels?: unknown;
  readonly fundamentals?: FundamentalsInput | null;
  readonly positioning?: PositioningInput | null;
  /** 'BITCOIN' for GBTC/BTC/FBTC/BITB/IBIT (the shared-thesis group); null/absent otherwise. */
  readonly correlatedGroup?: string | null;
  readonly dataHealth: readonly QualityItem[];
  /** F-X2: shown after the exit levels when present. */
  readonly sellPlan?: SellPlanView | null;
  /** Set when the whole holding failed; the section then shows the catalog sentence only. */
  readonly failed?: ReasonCode;
}

export interface SharedThesisInput {
  readonly group: 'BITCOIN';
  /** The group members that are actually held (resolved by the pipeline, never assumed). */
  readonly members: readonly string[];
  /** The series the shared thesis was read from, e.g. 'BTC-USD' or 'IBIT' (never GBTC). */
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

export interface SkippedRows {
  readonly crypto: readonly string[];
  /** One entry per reason group: "<reason>: row N (T), ...". */
  readonly otherStock: readonly string[];
  /** Rows behind otherStock (otherStock is grouped); falls back to otherStock.length. */
  readonly otherStockCount?: number;
  readonly blankTickerRowCount: number;
  readonly stockTableUnreadable?: boolean;
  readonly optionsTableUnreadable?: boolean;
  readonly stockTableEmpty?: boolean;
}

/**
 * Owner 2026-11-07 (profile `exit.businessAlerts` shadow / on): the business-based exit alerts (jobs/exit/businessAlerts.ts).
 * Display only: no verdict, score or rule reads it. Plain sentences built from numbers and fixed words.
 */
export interface BusinessAlertsView {
  readonly mode: 'shadow' | 'on';
  readonly intro: readonly string[];
  readonly market: { readonly alert: boolean; readonly text: string };
  readonly holdings: ReadonlyArray<{ readonly ticker: string; readonly alert: boolean; readonly text: string }>;
  /** Set when the section could not be built tonight (the other fields are then empty). */
  readonly unavailable?: boolean;
}

export interface ExitReportInput {
  readonly runAt: Date;
  /** Absent = the flag is off: no section. */
  readonly businessAlerts?: BusinessAlertsView | null;
  readonly holdings: readonly ExitHoldingInput[];
  readonly skipped: SkippedRows;
  readonly sharedThesis?: SharedThesisInput | null;
  readonly advisory?: BullPhaseAdvisory | null;
  readonly advisoryUnavailable?: ReasonCode;
  readonly dataHealth: readonly QualityItem[];
  /** Options sentiment part B (display only): the market options line (SPY / QQQ); shown in the banner when set. */
  readonly marketOptionsLine?: string | null;
}

export type OpusMode = 'REVIEW' | 'STANDALONE' | 'OFF';
export interface AiEntry {
  readonly ticker: string;
  readonly gemini?: string | null;
  readonly opus?: string | null;
}
export interface AiSummariesInput {
  readonly ranAt: Date;
  readonly geminiUsed: boolean;
  readonly opusMode: OpusMode;
  /** For STANDALONE: why there was no Gemini narrative to review. */
  readonly standaloneWhy?: ReasonCode;
  readonly effort?: string | null;
  readonly entries: readonly AiEntry[];
  /**
   * Plan #47: the portfolio-wide Claude Opus view (only when the Exit Opus box was ticked). Shown first in the AI
   * SUMMARIES section; its headline is added to the report's top status line. Display only.
   */
  readonly portfolioView?: { readonly paragraphs: readonly string[]; readonly headline: string | null } | null;
}
