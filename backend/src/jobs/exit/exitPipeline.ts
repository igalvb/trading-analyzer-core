/**
 * FL-8o: the Exit PIPELINE (not the report). Per-held-ticker orchestration per
 * docs/CHARACTERIZATION_PLAN_V13_exit_pipeline_and_report.md sections 1-4.
 *
 * Legacy ported/reused (nothing duplicated):
 *  - selection rules, blank rows continue not break: src/sheets/readers/portfolio.ts (legacy :10305-10332)
 *  - stock since-entry read = computePositionExitReadV1_ :9772-9844, the pure core of analyzePositionV7 :9846-9883
 *    (src/analysis/exitRead.ts computePositionExitRead) ; fixed-lookback :9936-9986 (computePositionExitReadFixedLookback)
 *  - options since-entry read incl. the 30d short-term / 60d LEAPS hard trigger :9919-9921, :10072-10130
 *    (src/analysis/optionsExitRead.ts); options fixed-lookback :10005-10050 is INJECTED (agent J's port)
 *  - real-date vs generic-lookback fallback flow = exitReport.ts:236-251, :280-287 (legacy buildExitStrategyReportV7)
 *  - action ladder = formatStockSignals :10163-10182 / formatOptionsSignals :10197-10223 (as exitReport.ts), rewritten as
 *    {actionClass, plain-English headline}; a test proves the class equals the legacy summary's class on every input.
 * New (plan): tax at the profile's rate of the gain (portfolio/exitTax.ts, the user's one rule), Bitcoin shared thesis (correlatedGroup.ts), Stage 0 once, per-ticker isolation.
 *
 * Log vs report: technical detail goes to ctx.log only. Everything returned for the report is a code, a number, or a
 * plain sentence (catalog.ts classifyError / labelledReason / dataQualityLines). Raw read errors are never copied.
 * Stored Sheets data is never called "cache" in report text.
 */
import type { RunContext } from '../../core/context.ts';
import { runStep } from '../../core/runStep.ts';
import { reportSentence } from '../../core/result.ts';
import type { Chart } from '../../types/chart.ts';
import type { PortfolioResult, StockHolding, OptionHolding } from '../../sheets/readers/portfolio.ts';
import { ASSUMED_ENTRY_BASIS } from '../../sheets/readers/portfolio.ts';
import { computePositionExitRead, computePositionExitReadFixedLookback, type ExitReadOptions } from '../../analysis/exitRead.ts';
import { computeOptionsPositionExitRead } from '../../analysis/optionsExitRead.ts';
import { classifyError, labelledReason, dataQualityLines, type QualityItem, type ReasonCode } from '../../reports/messages/catalog.ts';
import { mapLimit, DEFAULT_CONCURRENCY } from '../nightly/nightly.ts';
import { computeExitTax, exitTaxLines, OPTION_CONTRACT_MULTIPLIER, EXIT_TAX_RATE, type ExitTax } from '../../portfolio/exitTax.ts';
import { weeklyOverlay, optionOverlayDecision, directionsFromComparison, type WeeklyOverlay, type VoteDirections } from './weeklyOverlay.ts';
import type { ModelVote } from '../../analysis/exitVote.ts';
import { timeToPrice } from '../../analysis/techPlan/entryPlan.ts';
import { computeAtrSlice } from '../../analysis/indicators/slices.ts';
import {
  resolveGroups, buildSharedThesis, defaultScaleInvariantThesis, DEFAULT_CORRELATED_GROUPS,
  type CorrelatedGroup, type ResolvedGroup, type SharedThesis, type SharedThesisCore,
} from './correlatedGroup.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

export type ActionClass = 'EXIT' | 'EXPIRED' | 'REVIEW' | 'TRIM' | 'HOLD' | 'UNKNOWN';
/** ASSUMED (row 36): a stock row with no purchase date, read since the assumed 2020-01-01 and treated like a real date. */
export type ReadConfidence = 'REAL' | 'ASSUMED' | 'GENERIC' | 'NONE';
export type HoldingStatus = 'OK' | 'DEGRADED' | 'FAILED' | 'SKIPPED';
export type EntryDateFallback = 'NO_ENTRY_DATE' | 'ENTRY_DATE_UNUSABLE' | null;

const ACTION_RANK: Readonly<Record<ActionClass, number>> = { EXIT: 0, EXPIRED: 0, REVIEW: 1, TRIM: 2, HOLD: 3, UNKNOWN: 4 };
export function actionRank(c: ActionClass): number { return ACTION_RANK[c]; }

export interface ActionDecision { readonly actionClass: ActionClass; readonly headline: string }

/** $1,234.56: the same money format as the Exit report (audit #49). */
const usd2 = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Stock ladder, same order as legacy formatStockSignals (:10163-10182), plain-English output. */
export function classifyStockAction(r: Rec, hasRealDate: boolean, assumedDate = false): ActionDecision {
  const stop = r.chandelierSinceEntry != null ? r.chandelierSinceEntry : r.chandelierGeneric;
  const stopTxt = typeof stop === 'number' ? usd2(stop) : 'the trailing stop';
  if (r.thesisInvalidated) return { actionClass: 'EXIT', headline: 'Exit: the technical read for this stock has turned negative.' };
  if (r.stopBreached && hasRealDate) return { actionClass: 'EXIT', headline: 'Exit: the price is below your trailing stop of ' + stopTxt + ', ' + (assumedDate ? ASSUMED_ENTRY_BASIS : 'measured from your purchase date') + '.' };
  if (r.stopBreached) return { actionClass: 'REVIEW', headline: 'Review: the price may be below the trailing stop of ' + stopTxt + ', but no purchase date is on file, so this is a low-confidence read.' };
  if (r.hitT2) return { actionClass: 'TRIM', headline: 'Consider trimming: the second price target was reached.' };
  if (r.hitT1) return { actionClass: 'TRIM', headline: 'Consider trimming: the first price target was reached.' };
  return { actionClass: 'HOLD', headline: 'Hold: no stop hit, no negative change in the technical read, targets not yet reached.' };
}

export interface ExitParityFlags {
  /** Legacy: a failed underlying read on an option row falls through to HOLD (F-F1). Default false = shown as unknown. */
  readonly legacyFailedReadHold?: boolean;
  /** Legacy: put rows are analysed as calls. Default false = long-only, puts skipped with a plain line. */
  readonly legacyAnalysePuts?: boolean;
  /** F-X1: legacy = a target counts as reached when the past peak touched it. Default false = current price only. */
  readonly legacyHistoricalTargets?: boolean;
}

/** Options ladder, same order as legacy formatOptionsSignals (:10197-10223). */
export function classifyOptionsAction(r: Rec, hasRealDate: boolean, contracts: number | null, parity: ExitParityFlags = {}): ActionDecision {
  const t: Rec = r.technical || {};
  const techError = !!t.error;
  if (typeof r.daysToExpiry === 'number' && r.daysToExpiry <= 0) return { actionClass: 'EXPIRED', headline: 'Expired: the expiry date has passed. Check whether this row is still open.' };
  if (!techError && t.thesisInvalidated) return { actionClass: 'EXIT', headline: "Exit: the technical read for the underlying stock has turned negative." };
  if (!techError && t.stopBreached && hasRealDate) return { actionClass: 'EXIT', headline: "Exit: the underlying stock is below its trailing stop, measured from your purchase date." };
  if (!techError && t.stopBreached) return { actionClass: 'REVIEW', headline: 'Review: the underlying stock may be below its trailing stop, but no purchase date is on file, so this is a low-confidence read.' };
  if (r.expiryWarning) return { actionClass: 'EXIT', headline: 'Exit: the contract is ' + r.daysToExpiry + ' days from expiry, inside the ' + r.expiryThreshold + '-day warning window.' };
  if (techError && !parity.legacyFailedReadHold) return { actionClass: 'UNKNOWN', headline: labelledReason('Underlying price read', 'SECTION_UNAVAILABLE') };
  if (!techError && (t.hitT2 || t.hitT1)) {
    const which = t.hitT2 ? 'second' : 'first';
    return typeof contracts === 'number' && contracts >= 2
      ? { actionClass: 'TRIM', headline: 'Consider trimming: the underlying stock reached its ' + which + ' price target.' }
      : { actionClass: 'TRIM', headline: 'The underlying stock reached its ' + which + ' price target. With one contract a partial exit is not possible: hold or exit.' };
  }
  return { actionClass: 'HOLD', headline: 'Hold: no stop hit, no negative change, not near expiry, targets not yet reached.' };
}

function codeForReadError(msg: unknown): ReasonCode {
  const m = String(msg ?? '');
  if (/entry price/i.test(m)) return 'INPUT_INVALID_ENTRY_PRICE';
  if (/could not fetch/i.test(m)) return 'NO_DATA_FOR_TICKER';
  return 'SECTION_UNAVAILABLE';
}

// ── injected dependencies ──────────────────────────────────────────────

export type StockReadFn = (ticker: string, avgCost: number, entryDateStr: string, chart: Chart, opts?: ExitReadOptions) => Rec;
export type StockFixedFn = (ticker: string, avgCost: number, chart: Chart, opts?: ExitReadOptions) => Rec;
export type OptionsReadFn = (ticker: string, strike: number, expiryStr: string, avgPremium: number | null, entryDateStr: string, chart: Chart, nowMs: number, opts?: ExitReadOptions) => Rec;
export type OptionsFixedFn = (ticker: string, strike: number, expiryStr: string, avgPremium: number | null, chart: Chart, opts?: ExitReadOptions) => Rec | Promise<Rec>;

export interface PositionAnalyzers {
  readonly stockSinceEntry?: StockReadFn;
  readonly stockFixedLookback?: StockFixedFn;
  readonly optionsSinceEntry?: OptionsReadFn;
  /** Agent J's computeOptionsPositionExitReadFixedLookbackV1_ port (legacy :10005-10050). No default; absent = those rows degrade. */
  readonly optionsFixedLookback?: OptionsFixedFn;
}

const DEFAULT_ANALYZERS: Required<Omit<PositionAnalyzers, 'optionsFixedLookback'>> = {
  stockSinceEntry: (t, c, d, ch, o) => computePositionExitRead(t, c, d, ch, o) as Rec,
  stockFixedLookback: (t, c, ch, o) => computePositionExitReadFixedLookback(t, c, ch, undefined, o) as Rec,
  optionsSinceEntry: (t, s, e, p, d, ch, now, o) => computeOptionsPositionExitRead(t, s, e, p as number, d, ch, now, o) as Rec,
};

/** Opaque per-ticker output of the full analysis (fundamentals, 5 models, comparison, positioning). Passed through untouched. */
export interface ExitAnalysisBundle {
  readonly fundResult?: unknown;
  readonly techPlan?: unknown;
  readonly decision?: unknown;
  readonly modelReads?: unknown;
  readonly comparison?: unknown;
  readonly positioning?: unknown;
  /** FL-17b: the display-only Wyckoff / Trend / combo reads (analysis/extraModels.ts). */
  readonly extraModels?: unknown;
  /** Row 35 (#37): each book model's signal count (synthesis bullish / cautionary), keyed by the sheet's model id. Display only. */
  readonly modelSignals?: Readonly<Record<string, { readonly pro: number; readonly con: number }>>;
}

export type Stage0Data = Readonly<Record<string, unknown>>;

export interface ExitPipelineDeps {
  /** Output of parsePortfolio / readPortfolio. The Portfolio sheet is never written to. */
  readonly portfolio: PortfolioResult;
  readonly getChart: (ctx: RunContext, ticker: string) => Promise<Chart | null | undefined>;
  /** Market-wide inputs (macro, 10Y, regime OHLCV, dark-pool batch, SPY/QQQ). Called ONCE per run. */
  readonly loadStage0?: (ctx: RunContext) => Promise<Stage0Data>;
  /** Stored full-analysis result for one ticker. Never called for option rows (focused options block, plan open question 1). */
  readonly getAnalysis?: (ctx: RunContext, ticker: string, stage0: Stage0Data | null) => Promise<ExitAnalysisBundle | null | undefined>;
  readonly analyzers?: PositionAnalyzers;
  /** Current premium per share for an option, when known (e.g. from the options snapshot). Without it no dollar or tax figure is shown. */
  readonly getOptionPremium?: (ctx: RunContext, holding: OptionHolding) => Promise<number | null | undefined>;
  readonly groups?: readonly CorrelatedGroup[];
  readonly computeThesis?: (chart: Chart) => SharedThesisCore;
}

export interface ExitPipelineOptions {
  readonly concurrency?: number;
  readonly stepTimeoutMs?: number;
  /** Default true. False = each Bitcoin ETF gets only its own read, no shared thesis. */
  readonly shareCorrelatedThesis?: boolean;
  readonly parity?: ExitParityFlags;
  /** Owner 2026-11-05, profile `exit.weeklyStops` (default false): decide from the weekly chart and the owner's exit rules (weeklyOverlay.ts). */
  readonly weeklyStops?: boolean;
  /** weeklyStops only: the tax rate on a gain (default the profile's). */
  readonly taxRate?: number;
}

/** weeklyStops only: what the report shows about the weekly decision. */
export interface WeeklyStopsView {
  readonly lines: readonly string[];
  /** T1 passes the owner's trim rule (+25% after tax over the cost); null = unknown. */
  readonly t1WorthTrimming: boolean | null;
  /** The engine's target the price reached (a trim candidate), or null. */
  readonly reachedTarget: number | null;
  /** Every model's read on this holding (model -> SELL / HOLD / BUY / NA -> why) and the count. */
  readonly votes: readonly ModelVote[];
  readonly voteText: string;
}

// ── results ────────────────────────────────────────────────────────────

export interface ExpiryTrigger {
  readonly daysToExpiry: number | null;
  readonly threshold: number | null;
  readonly kind: 'SHORT_TERM' | 'LEAPS' | 'UNCLASSIFIED';
  readonly triggered: boolean;
  readonly expired: boolean;
}

interface HoldingBase {
  readonly ticker: string;
  readonly rowNumber: number;
  readonly status: HoldingStatus;
  readonly actionClass: ActionClass;
  readonly headline: string;
  readonly confidence: ReadConfidence;
  readonly entryDateFallback: EntryDateFallback;
  readonly price: number | null;
  readonly stopLevel: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly hitT1: boolean;
  readonly hitT2: boolean;
  readonly thesisInvalidated: boolean;
  readonly stopBreached: boolean;
  /** The full read for the report (classicalTrailing, turtlePyramid ...). Null when no read exists. */
  readonly read: Rec | null;
  readonly tax: ExitTax;
  readonly taxLines: readonly string[];
  readonly sharedThesis: SharedThesis | null;
  readonly dataQuality: readonly QualityItem[];
  readonly dataQualityLines: readonly string[];
  readonly notes: readonly string[];
  /** F-X2, display only: estimated trading days for the (underlying) price to reach T1 / T2; null when reached or unknown. */
  readonly daysToT1?: number | null;
  readonly daysToT2?: number | null;
  /** F-X2: 'YYYY-MM-DD' of each split in the chart (the remembered plan restarts after a split). */
  readonly splitDays?: readonly string[];
  /** Present only under the weeklyStops flag. */
  readonly weeklyStops?: WeeklyStopsView;
}

export interface ExitStockResult extends HoldingBase {
  readonly kind: 'STOCK';
  readonly shares: number | null;
  readonly avgCost: number | null;
  readonly entryDate: string | null;
  /** Row 36: entryDate is the assumed 2020-01-01 (no real date on file). */
  readonly entryDateAssumed?: boolean;
  readonly analysis: ExitAnalysisBundle | null;
}

export interface ExitOptionResult extends HoldingBase {
  readonly kind: 'OPTION';
  readonly contracts: number | null;
  readonly strike: number | null;
  readonly expiry: string | null;
  readonly side: 'call' | 'put';
  readonly avgPremium: number | null;
  readonly entryDate: string | null;
  readonly expiryTrigger: ExpiryTrigger;
  /** True when the same underlying is also held as shares: the report points to that stock section. */
  readonly underlyingHeldAsStock: boolean;
}

export type ExitHoldingResult = ExitStockResult | ExitOptionResult;

export interface ExitRollup {
  readonly holdingCount: number;
  readonly stockCount: number;
  readonly optionCount: number;
  readonly actionCounts: Readonly<Record<ActionClass, number>>;
  /** A correlated group counts once, so five Bitcoin ETFs do not read as five independent signals. */
  readonly independentSignalCount: number;
  readonly totals: {
    readonly costBasisUsd: number; readonly marketValueUsd: number; readonly unrealizedUsd: number;
    readonly afterTaxGainUsd: number; readonly taxOwedUsd: number; readonly holdingsCounted: number; readonly holdingsLeftOut: number;
  };
}

export interface ExitPipelineResult {
  readonly startedAtMs: number;
  /** Action-first order (EXIT/EXPIRED, REVIEW, TRIM, HOLD, UNKNOWN), stable within a class. */
  readonly holdings: readonly ExitHoldingResult[];
  readonly groups: ReadonlyArray<{ readonly groupId: string; readonly present: readonly string[]; readonly shared: boolean; readonly thesis: SharedThesis | null }>;
  readonly skipped: { readonly crypto: readonly string[]; readonly other: PortfolioResult['skippedOther']; readonly blankRowCount: number };
  readonly stage0: Stage0Data | null;
  readonly stage0Failed: boolean;
  readonly portfolioQuality: readonly QualityItem[];
  readonly portfolioQualityLines: readonly string[];
  readonly rollup: ExitRollup;
}

// ── helpers ────────────────────────────────────────────────────────────

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Row 35 (#44): the trailing stop the Exit report shows for one stock holding (the same reads and the same choice as
 * the pipeline: since the real entry date, else the generic lookback), for the AI run's position facts. Null when
 * the read refuses or has no stop.
 */
export function stockTrailingStop(ticker: string, avgCost: number, entryDate: Date | null, chart: Chart, opts: ExitReadOptions = {}, entryDateAssumed = false): number | null {
  let r: Rec | null = entryDate ? DEFAULT_ANALYZERS.stockSinceEntry(ticker, avgCost, sinceEntryDateStr(isoDay(entryDate), entryDateAssumed, chart), chart, opts) : null;
  if (!r || r.error) r = DEFAULT_ANALYZERS.stockFixedLookback(ticker, avgCost, chart, opts);
  if (!r || r.error) return null;
  const v = r.chandelierSinceEntry != null ? r.chandelierSinceEntry : (r.chandelierGeneric ?? null);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/**
 * Row 36: the date handed to the since-entry read. A real date is passed as is. The assumed 2020-01-01 is usually
 * older than the price history on file (about two years), which the since-entry read refuses; for an assumed date
 * the read starts at the first bar on file instead, so the stop is the highest price in the whole history.
 */
export function sinceEntryDateStr(entryIso: string, assumed: boolean, chart: Chart): string {
  const first = chart.dates?.[0];
  if (!assumed || !first || first.getTime() <= new Date(entryIso).getTime()) return entryIso;
  return first.toISOString();
}
/** M/D/YYYY parses to LOCAL midnight of the same calendar day in any zone (see F-O4). */
const mdy = (d: Date): string => (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();

function emptyTax(_nowMs: number): ExitTax { return computeExitTax({ quantity: null, unitCost: null, unitPrice: null }); }

/**
 * F-X2 (display only, never a score input): estimated trading days for the price to reach a target, from the same
 * estimator the entry plan uses (techPlan/entryPlan.ts timeToPrice; no regime here, so the default drift).
 */
export function daysToReach(chart: Chart, price: number | null, target: number | null, hit: boolean): number | null {
  if (hit || price == null || target == null || !(target > price)) return null;
  try {
    const atr = chart.closes.length > 15 ? computeAtrSlice(chart).atr14 : null;
    const est = timeToPrice(price, target, { atr, regime: '', gann: null, closes: chart.closes });
    return est ? est.baseDays : null;
  } catch { return null; }
}
const splitDaysOf = (chart: Chart): string[] => (chart.splits ?? []).map((s) => isoDay(s.date));

export async function runExitPipeline(ctx: RunContext, deps: ExitPipelineDeps, options: ExitPipelineOptions = {}): Promise<ExitPipelineResult> {
  const startedAtMs = ctx.clock.now();
  const nowDate = new Date(startedAtMs);
  const parity = options.parity ?? {};
  const weeklyOn = options.weeklyStops === true;
  const taxRate = options.taxRate ?? EXIT_TAX_RATE;
  const readOpts: ExitReadOptions = { legacyHistoricalTargets: parity.legacyHistoricalTargets === true, ...(weeklyOn ? { weeklyStops: true } : {}) };
  /** weeklyStops: the fundamental score per stock ticker, for an option on the same underlying (stocks run first). */
  const fundScoreByTicker = new Map<string, number | null>();
  const directionsByTicker = new Map<string, VoteDirections | null>();
  const viewOf = (o: WeeklyOverlay): WeeklyStopsView => ({ lines: o.lines, t1WorthTrimming: o.decision.t1WorthTrimming, reachedTarget: o.reachedTarget, votes: o.votes, voteText: o.vote.text });
  const timeoutMs = options.stepTimeoutMs;
  const analyzers = { ...DEFAULT_ANALYZERS, ...(deps.analyzers ?? {}) } as Required<Omit<PositionAnalyzers, 'optionsFixedLookback'>> & Pick<PositionAnalyzers, 'optionsFixedLookback'>;
  const { stocks, options: optionRows } = deps.portfolio;
  const portfolioQuality: QualityItem[] = [];

  // Stage 0: market-wide, fetched exactly once per run.
  let stage0: Stage0Data | null = null;
  let stage0Failed = false;
  if (deps.loadStage0) {
    const r = await runStep(ctx, {
      key: 'exit.stage0', label: 'Market-wide data', timeoutMs, maxAttempts: 2,
      onFailure: reportSentence('The market-wide data could not be loaded, so the exit reads use price and chart signals only.'),
    }, () => deps.loadStage0!(ctx));
    if (r.ok) stage0 = r.value;
    else {
      stage0Failed = true;
      portfolioQuality.push({ label: 'Market-wide data', reasonCode: classifyError(r.error.cause), effect: 'PRICE_CHART_ONLY', now: nowDate });
    }
  }

  // Charts: one fetch per distinct ticker, shared by a stock row, an option row on the same underlying, and a Bitcoin anchor.
  type ChartOutcome = { readonly chart: Chart | null; readonly code: ReasonCode | null };
  const chartCache = new Map<string, Promise<ChartOutcome>>();
  const getChartOnce = (ticker: string): Promise<ChartOutcome> => {
    let p = chartCache.get(ticker);
    if (!p) {
      p = (async (): Promise<ChartOutcome> => {
        const r = await runStep(ctx.forTicker(ticker), {
          key: 'exit.chart.' + ticker, label: 'Price history for ' + ticker, timeoutMs, maxAttempts: 2,
          onFailure: reportSentence('Price history for ' + ticker + ' could not be loaded.'),
        }, async () => (await deps.getChart(ctx, ticker)) ?? null);
        if (!r.ok) return { chart: null, code: classifyError(r.error.cause) };
        if (!r.value) return { chart: null, code: 'NO_DATA_FOR_TICKER' };
        return { chart: r.value, code: null };
      })();
      chartCache.set(ticker, p);
    }
    return p;
  };

  // Correlated groups: thesis computed once per group from one anchor.
  const allTickers = [...stocks.map((s) => s.ticker), ...optionRows.map((o) => o.ticker)];
  const resolved = resolveGroups(allTickers, deps.groups ?? DEFAULT_CORRELATED_GROUPS);
  const thesisByGroup = new Map<string, SharedThesis | null>();
  const groupOf = new Map<string, ResolvedGroup>();
  for (const rg of resolved) {
    if (!rg.shared || options.shareCorrelatedThesis === false) { thesisByGroup.set(rg.group.id, null); continue; }
    for (const m of rg.present) groupOf.set(m, rg);
    let thesis: SharedThesis | null = null;
    for (let i = 0; i < rg.group.anchors.length && !thesis; i++) {
      const anchor = rg.group.anchors[i];
      const co = await getChartOnce(anchor.symbol);
      if (!co.chart) { ctx.log.warning('shared thesis anchor unavailable: ' + anchor.symbol, { group: rg.group.id, code: co.code }); continue; }
      const t = await runStep(ctx, {
        key: 'exit.sharedThesis.' + rg.group.id + '.' + anchor.symbol, label: 'Shared thesis for ' + rg.group.label, retry: 'never',
        onFailure: reportSentence('The shared technical read for ' + rg.group.label + ' could not be built.'),
      }, async () => (deps.computeThesis ?? defaultScaleInvariantThesis)(co.chart as Chart));
      if (t.ok) thesis = buildSharedThesis(rg, anchor, i, t.value);
    }
    thesisByGroup.set(rg.group.id, thesis);
    if (!thesis) {
      for (const m of rg.present) portfolioQuality.push({ label: m + ' shared technical read', reasonCode: 'SECTION_UNAVAILABLE', effect: 'SECTION_LEFT_OUT', now: nowDate });
    }
  }
  const thesisFor = (ticker: string): SharedThesis | null => { const rg = groupOf.get(ticker); return rg ? (thesisByGroup.get(rg.group.id) ?? null) : null; };
  const heldStock = new Set(stocks.map((s) => s.ticker));

  // Stored full analysis, once per distinct stock ticker.
  const analysisCache = new Map<string, Promise<{ bundle: ExitAnalysisBundle | null; code: ReasonCode | null }>>();
  const getAnalysisOnce = (ticker: string): Promise<{ bundle: ExitAnalysisBundle | null; code: ReasonCode | null }> => {
    let p = analysisCache.get(ticker);
    if (!p) {
      p = (async () => {
        if (!deps.getAnalysis) return { bundle: null, code: null };
        const r = await runStep(ctx.forTicker(ticker), {
          key: 'exit.analysis.' + ticker, label: 'Stored analysis for ' + ticker, timeoutMs, maxAttempts: 2,
          onFailure: reportSentence('The stored analysis for ' + ticker + ' could not be loaded.'),
        }, async () => (await deps.getAnalysis!(ctx, ticker, stage0)) ?? null);
        if (!r.ok) return { bundle: null, code: classifyError(r.error.cause) };
        return { bundle: r.value, code: r.value ? null : 'NO_DATA_FOR_TICKER' as ReasonCode };
      })();
      analysisCache.set(ticker, p);
    }
    return p;
  };

  const finish = (b: Omit<HoldingBase, 'dataQualityLines'>): HoldingBase => ({ ...b, dataQualityLines: dataQualityLines([...b.dataQuality]) });
  const failedBase = (ticker: string, rowNumber: number, code: ReasonCode, label: string, status: HoldingStatus = 'FAILED'): Omit<HoldingBase, 'dataQualityLines'> => ({
    ticker, rowNumber, status, actionClass: 'UNKNOWN', headline: labelledReason(label, code), confidence: 'NONE', entryDateFallback: null,
    price: null, stopLevel: null, t1: null, t2: null, hitT1: false, hitT2: false, thesisInvalidated: false, stopBreached: false, read: null,
    tax: emptyTax(startedAtMs), taxLines: [], sharedThesis: thesisFor(ticker), dataQuality: [], notes: [],
  });

  // ── one stock holding ──
  const analyseStock = async (h: StockHolding): Promise<ExitStockResult> => {
    const tctx = ctx.forTicker(h.ticker);
    const entryStr = h.entryDate ? isoDay(h.entryDate) : null;
    const assumed = !!entryStr && h.entryDateAssumed === true;
    const pos = { kind: 'STOCK' as const, shares: h.shares, avgCost: h.avgCost, entryDate: entryStr, ...(assumed ? { entryDateAssumed: true } : {}), analysis: null as ExitAnalysisBundle | null };
    if (h.avgCost == null) {
      tctx.log.warning('stock row has no parseable cost avg per stock', { row: h.rowNumber });
      return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, 'INPUT_INVALID_ENTRY_PRICE', 'Exit read')) };
    }
    const co = await getChartOnce(h.ticker);
    if (!co.chart) return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, co.code ?? 'NO_DATA_FOR_TICKER', 'Price history')) };
    const chart = co.chart;

    const rr = await runStep(tctx, {
      key: 'exit.read.' + h.ticker, label: 'Exit read for ' + h.ticker, retry: 'never',
      onFailure: reportSentence('The exit read for ' + h.ticker + ' could not be built.'),
    }, async () => {
      let hasRealDate = !!entryStr;
      let fallback: EntryDateFallback = hasRealDate ? null : 'NO_ENTRY_DATE';
      let r: Rec | null = hasRealDate ? analyzers.stockSinceEntry(h.ticker, h.avgCost as number, sinceEntryDateStr(entryStr as string, assumed, chart), chart, assumed ? { ...readOpts, assumedEntryBasis: ASSUMED_ENTRY_BASIS } : readOpts) : null;
      if (!hasRealDate || (r && r.error)) {
        if (hasRealDate) { hasRealDate = false; fallback = 'ENTRY_DATE_UNUSABLE'; tctx.log.info('since-entry read refused, using generic lookback', { detail: String(r && r.error) }); }
        r = analyzers.stockFixedLookback(h.ticker, h.avgCost as number, chart, readOpts);
      }
      return { r: r as Rec, hasRealDate, fallback };
    });
    if (!rr.ok) return { ...pos, ...finish({ ...failedBase(h.ticker, h.rowNumber, 'SECTION_UNAVAILABLE', 'Exit read'), price: chart.closes[chart.closes.length - 1] ?? null }) };
    const { r, hasRealDate, fallback } = rr.value;
    if (r.error) {
      tctx.log.warning('exit read returned an error', { detail: String(r.error) });
      return { ...pos, ...finish({ ...failedBase(h.ticker, h.rowNumber, codeForReadError(r.error), 'Exit read'), price: chart.closes[chart.closes.length - 1] ?? null }) };
    }
    const price: number | null = typeof r.cp === 'number' ? r.cp : (chart.closes[chart.closes.length - 1] ?? null);
    const decision = classifyStockAction(r, hasRealDate, assumed && hasRealDate);
    const ar = await getAnalysisOnce(h.ticker);
    const quality: QualityItem[] = [];
    if (deps.getAnalysis && !ar.bundle) quality.push({ label: 'Fundamentals and model reads', reasonCode: ar.code ?? 'NO_DATA_FOR_TICKER', effect: 'PRICE_CHART_ONLY', now: nowDate });
    if (stage0Failed) quality.push({ label: 'Market-wide data', reasonCode: 'PROVIDER_NO_RESPONSE', effect: 'PRICE_CHART_ONLY', now: nowDate });
    const thesis = thesisFor(h.ticker);
    if (groupOf.has(h.ticker) && !thesis && options.shareCorrelatedThesis !== false) quality.push({ label: 'Shared technical read', reasonCode: 'SECTION_UNAVAILABLE', effect: 'SECTION_LEFT_OUT', now: nowDate });
    const tax = computeExitTax({ quantity: h.shares, unitCost: h.avgCost, unitPrice: price });
    const fundRaw = (ar.bundle?.fundResult as { score?: unknown } | undefined)?.score;
    const fundScore = typeof fundRaw === 'number' && Number.isFinite(fundRaw) ? fundRaw : null;
    fundScoreByTicker.set(h.ticker, fundScore);
    const directions = directionsFromComparison(ar.bundle?.comparison);
    directionsByTicker.set(h.ticker, directions);
    if (weeklyOn && price != null) {
      const o = weeklyOverlay({ directions,
        chart, read: r, entryDay: hasRealDate ? (entryStr as string) : null, realEntry: hasRealDate && !assumed, price,
        fundScore, cost: h.avgCost, taxRate, nowMs: startedAtMs,
      });
      tctx.log.info('exit read done (weekly stops)', { row: h.rowNumber, action: o.action, oldAction: decision.actionClass, weeklyStop: o.weekly?.stop ?? null, staleBreach: o.stale?.stale ?? null });
      return {
        ...pos, analysis: ar.bundle,
        ...finish({
          ticker: h.ticker, rowNumber: h.rowNumber, status: quality.length ? 'DEGRADED' : 'OK', actionClass: o.action, headline: o.headline,
          confidence: hasRealDate ? (assumed ? 'ASSUMED' : 'REAL') : 'GENERIC', entryDateFallback: fallback, price,
          stopLevel: o.weekly ? o.weekly.stop : null,
          t1: o.targets.t1, t2: o.targets.t2, hitT1: false, hitT2: false, thesisInvalidated: !!r.thesisInvalidated, stopBreached: !!o.weekly?.breached,
          read: { ...r, distanceToT1Pct: o.targets.t1 != null ? (o.targets.t1 / price - 1) * 100 : null, distanceToT2Pct: o.targets.t2 != null ? (o.targets.t2 / price - 1) * 100 : null },
          tax, taxLines: exitTaxLines(tax), sharedThesis: thesis, dataQuality: quality, notes: [],
          daysToT1: daysToReach(chart, price, o.targets.t1, false), daysToT2: daysToReach(chart, price, o.targets.t2, false), splitDays: splitDaysOf(chart),
          weeklyStops: viewOf(o),
        }),
      };
    }
    tctx.log.info('exit read done', { row: h.rowNumber, action: decision.actionClass, basis: hasRealDate ? (assumed ? 'since-assumed-entry' : 'since-entry') : 'generic-lookback', recommendation: r.recommendation, reason: r.reason });
    return {
      ...pos, analysis: ar.bundle,
      ...finish({
        ticker: h.ticker, rowNumber: h.rowNumber, status: quality.length ? 'DEGRADED' : 'OK', actionClass: decision.actionClass, headline: decision.headline,
        confidence: hasRealDate ? (assumed ? 'ASSUMED' : 'REAL') : 'GENERIC', entryDateFallback: fallback, price,
        stopLevel: r.chandelierSinceEntry != null ? r.chandelierSinceEntry : (r.chandelierGeneric ?? null),
        t1: r.t1 ?? null, t2: r.t2 ?? null, hitT1: !!r.hitT1, hitT2: !!r.hitT2, thesisInvalidated: !!r.thesisInvalidated, stopBreached: !!r.stopBreached,
        read: r, tax, taxLines: exitTaxLines(tax), sharedThesis: thesis, dataQuality: quality, notes: [],
        daysToT1: daysToReach(chart, price, r.t1 ?? null, !!r.hitT1), daysToT2: daysToReach(chart, price, r.t2 ?? null, !!r.hitT2), splitDays: splitDaysOf(chart),
      }),
    };
  };

  // ── one option holding ──
  const analyseOption = async (h: OptionHolding): Promise<ExitOptionResult> => {
    const tctx = ctx.forTicker(h.ticker);
    const entryStr = h.entryDate ? isoDay(h.entryDate) : null;
    const expiryIso = h.expiry ? isoDay(h.expiry) : null;
    const noTrigger: ExpiryTrigger = { daysToExpiry: null, threshold: null, kind: 'UNCLASSIFIED', triggered: false, expired: false };
    const pos = { kind: 'OPTION' as const, contracts: h.contracts, strike: h.strike, expiry: expiryIso, side: h.side, avgPremium: h.avgPremium, entryDate: entryStr, expiryTrigger: noTrigger, underlyingHeldAsStock: heldStock.has(h.ticker) };
    if (h.side === 'put' && !parity.legacyAnalysePuts) {
      tctx.log.warning('put position skipped (long calls only)', { row: h.rowNumber });
      return { ...pos, ...finish({ ...failedBase(h.ticker, h.rowNumber, 'LONG_ONLY_NOT_COVERED', 'Put position', 'SKIPPED'), headline: 'Put positions are not covered by this report, which handles long calls only.' }) };
    }
    if (h.strike == null || !h.expiry) return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, 'FIELD_MISSING', 'Option row')) };
    const co = await getChartOnce(h.ticker);
    if (!co.chart) return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, co.code ?? 'NO_DATA_FOR_TICKER', 'Price history for the underlying')) };
    const chart = co.chart;
    const expiryStr = mdy(h.expiry);
    const rr = await runStep(tctx, {
      key: 'exit.read.' + h.ticker + '.' + h.rowNumber, label: 'Options exit read for ' + h.ticker, retry: 'never',
      onFailure: reportSentence('The options exit read for ' + h.ticker + ' could not be built.'),
    }, async () => {
      let hasRealDate = !!entryStr;
      let fallback: EntryDateFallback = hasRealDate ? null : 'NO_ENTRY_DATE';
      let r: Rec | null = hasRealDate ? analyzers.optionsSinceEntry(h.ticker, h.strike as number, expiryStr, h.avgPremium, entryStr as string, chart, startedAtMs, readOpts) : null;
      if (!hasRealDate || (r && r.error)) {
        if (hasRealDate) { hasRealDate = false; fallback = 'ENTRY_DATE_UNUSABLE'; }
        if (!analyzers.optionsFixedLookback) return { r: null as Rec | null, hasRealDate, fallback, missingFixed: true };
        r = await analyzers.optionsFixedLookback(h.ticker, h.strike as number, expiryStr, h.avgPremium, chart, readOpts);
      }
      return { r, hasRealDate, fallback, missingFixed: false };
    });
    if (!rr.ok) return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, 'SECTION_UNAVAILABLE', 'Options exit read')) };
    const { r, hasRealDate, fallback, missingFixed } = rr.value;
    if (missingFixed || !r) return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, 'NOT_RUN', 'Options exit read without a purchase date')) };
    if (r.error) {
      tctx.log.warning('options exit read returned an error', { detail: String(r.error) });
      return { ...pos, ...finish(failedBase(h.ticker, h.rowNumber, codeForReadError(r.error), 'Options exit read')) };
    }
    let decision = classifyOptionsAction(r, hasRealDate, h.contracts, parity);
    const tw: Rec = r.technical || {};
    const underPrice = chart.closes[chart.closes.length - 1] ?? null;
    let overlay: WeeklyOverlay | null = null;
    // Under the flag the expiry rungs (EXPIRED, inside the expiry window) and a failed underlying read keep their class.
    if (weeklyOn && !tw.error && underPrice != null && !(typeof r.daysToExpiry === 'number' && r.daysToExpiry <= 0) && !r.expiryWarning) {
      // The vote needs the engine and book-model reads: a call whose underlying is not also held as shares reads the
      // stored analysis of the underlying here (flag on only; the flag-off run never reads it for an option row).
      if (!directionsByTicker.has(h.ticker)) {
        const ua = await getAnalysisOnce(h.ticker);
        directionsByTicker.set(h.ticker, directionsFromComparison(ua.bundle?.comparison));
        const fr = (ua.bundle?.fundResult as { score?: unknown } | undefined)?.score;
        fundScoreByTicker.set(h.ticker, typeof fr === 'number' && Number.isFinite(fr) ? fr : null);
      }
      overlay = weeklyOverlay({
        directions: directionsByTicker.get(h.ticker) ?? null,
        // Fix 2026-11-06 (owner rule 4: a call follows the UNDERLYING's weekly stop): the weekly anchor is the stock's own
        // 26-week window, never the contract's purchase date, so every call on one stock shows the same weekly stop
        // (live 6 Nov: two MRVL calls showed $122.66 and $204.73). The entry still dates the old daily-stop breach.
        chart, read: tw, entryDay: hasRealDate ? (entryStr as string) : null, realEntry: false, price: underPrice,
        fundScore: fundScoreByTicker.get(h.ticker) ?? null, cost: null, taxRate, nowMs: startedAtMs,
      });
      decision = optionOverlayDecision(overlay, typeof r.daysToExpiry === 'number' ? r.daysToExpiry : null, !!r.isLeapsAtEntry, h.contracts);
    }
    const trigger: ExpiryTrigger = {
      daysToExpiry: typeof r.daysToExpiry === 'number' ? r.daysToExpiry : null,
      threshold: typeof r.expiryThreshold === 'number' ? r.expiryThreshold : null,
      kind: 'isLeapsAtEntry' in r ? (r.isLeapsAtEntry ? 'LEAPS' : 'SHORT_TERM') : 'UNCLASSIFIED',
      triggered: !!r.expiryWarning,
      expired: typeof r.daysToExpiry === 'number' && r.daysToExpiry <= 0,
    };
    const t: Rec = r.technical || {};
    const premium = deps.getOptionPremium ? ((await deps.getOptionPremium(ctx, h)) ?? null) : null;
    const tax = computeExitTax({ quantity: h.contracts, unitCost: h.avgPremium, unitPrice: premium, multiplier: OPTION_CONTRACT_MULTIPLIER });
    const quality: QualityItem[] = [];
    if (stage0Failed) quality.push({ label: 'Market-wide data', reasonCode: 'PROVIDER_NO_RESPONSE', effect: 'PRICE_CHART_ONLY', now: nowDate });
    if (t.error) quality.push({ label: 'Underlying price read', reasonCode: 'SECTION_UNAVAILABLE', effect: 'LOWER_CONFIDENCE', now: nowDate });
    tctx.log.info('options exit read done', { row: h.rowNumber, action: decision.actionClass, daysToExpiry: trigger.daysToExpiry, threshold: trigger.threshold, kind: trigger.kind, recommendation: r.recommendation, reason: r.reason });
    return {
      ...pos, expiryTrigger: trigger,
      ...finish({
        ticker: h.ticker, rowNumber: h.rowNumber, status: quality.length ? 'DEGRADED' : 'OK', actionClass: decision.actionClass, headline: decision.headline,
        confidence: hasRealDate ? 'REAL' : 'GENERIC', entryDateFallback: fallback, price: chart.closes[chart.closes.length - 1] ?? null,
        ...(overlay ? {
          stopLevel: overlay.weekly ? overlay.weekly.stop : null, t1: overlay.targets.t1, t2: overlay.targets.t2, hitT1: false, hitT2: false,
          thesisInvalidated: !!t.thesisInvalidated, stopBreached: !!overlay.weekly?.breached,
          weeklyStops: viewOf(overlay),
        } : {
          stopLevel: t.error ? null : (t.chandelierSinceEntry != null ? t.chandelierSinceEntry : (t.chandelierGeneric ?? null)),
          t1: t.error ? null : (t.t1 ?? null), t2: t.error ? null : (t.t2 ?? null), hitT1: !t.error && !!t.hitT1, hitT2: !t.error && !!t.hitT2,
          thesisInvalidated: !t.error && !!t.thesisInvalidated, stopBreached: !t.error && !!t.stopBreached,
        }),
        read: overlay && underPrice != null ? { ...r, technical: { ...t, distanceToT1Pct: overlay.targets.t1 != null ? (overlay.targets.t1 / underPrice - 1) * 100 : null, distanceToT2Pct: overlay.targets.t2 != null ? (overlay.targets.t2 / underPrice - 1) * 100 : null } } : r, tax, taxLines: exitTaxLines(tax), sharedThesis: thesisFor(h.ticker), dataQuality: quality,
        notes: heldStock.has(h.ticker) ? ['The underlying is also held as shares; see that holding for the full analysis.'] : [],
        ...(t.error ? {} : overlay ? {
          daysToT1: daysToReach(chart, underPrice, overlay.targets.t1, false),
          daysToT2: daysToReach(chart, underPrice, overlay.targets.t2, false),
        } : {
          daysToT1: daysToReach(chart, chart.closes[chart.closes.length - 1] ?? null, t.t1 ?? null, !!t.hitT1),
          daysToT2: daysToReach(chart, chart.closes[chart.closes.length - 1] ?? null, t.t2 ?? null, !!t.hitT2),
        }),
        splitDays: splitDaysOf(chart),
      }),
    };
  };

  const conc = options.concurrency ?? DEFAULT_CONCURRENCY;
  const stockResults = await mapLimit(stocks, conc, (h) => analyseStock(h).catch((e) => {
    ctx.log.error('stock holding crashed outside its steps: ' + h.ticker, { detail: String((e as Error)?.stack ?? e) });
    return { kind: 'STOCK' as const, shares: h.shares, avgCost: h.avgCost, entryDate: h.entryDate ? isoDay(h.entryDate) : null, ...(h.entryDate && h.entryDateAssumed ? { entryDateAssumed: true } : {}), analysis: null, ...finish(failedBase(h.ticker, h.rowNumber, 'SECTION_UNAVAILABLE', 'Exit read')) };
  }));
  const optionResults = await mapLimit(optionRows, conc, (h) => analyseOption(h).catch((e) => {
    ctx.log.error('option holding crashed outside its steps: ' + h.ticker, { detail: String((e as Error)?.stack ?? e) });
    return { kind: 'OPTION' as const, contracts: h.contracts, strike: h.strike, expiry: h.expiry ? isoDay(h.expiry) : null, side: h.side, avgPremium: h.avgPremium, entryDate: h.entryDate ? isoDay(h.entryDate) : null, expiryTrigger: { daysToExpiry: null, threshold: null, kind: 'UNCLASSIFIED' as const, triggered: false, expired: false }, underlyingHeldAsStock: heldStock.has(h.ticker), ...finish(failedBase(h.ticker, h.rowNumber, 'SECTION_UNAVAILABLE', 'Options exit read')) };
  }));

  const all: ExitHoldingResult[] = [...stockResults, ...optionResults];
  const holdings = all.map((h, i) => ({ h, i })).sort((a, b) => ACTION_RANK[a.h.actionClass] - ACTION_RANK[b.h.actionClass] || a.i - b.i).map((x) => x.h);

  // Rollup
  const actionCounts: Record<ActionClass, number> = { EXIT: 0, EXPIRED: 0, REVIEW: 0, TRIM: 0, HOLD: 0, UNKNOWN: 0 };
  const independent = new Set<string>();
  const totals = { costBasisUsd: 0, marketValueUsd: 0, unrealizedUsd: 0, afterTaxGainUsd: 0, taxOwedUsd: 0, holdingsCounted: 0, holdingsLeftOut: 0 };
  for (const h of holdings) {
    actionCounts[h.actionClass]++;
    const rg = groupOf.get(h.ticker);
    independent.add(rg && h.sharedThesis ? 'group:' + rg.group.id : h.kind + ':' + h.ticker + ':' + h.rowNumber);
    if (h.kind === 'STOCK') {
      const t = h.tax;
      if (t.costBasisUsd !== null && t.marketValueUsd !== null && t.unrealizedUsd !== null && t.afterTaxGainUsd !== null && t.taxOwedUsd !== null) {
        totals.costBasisUsd += t.costBasisUsd; totals.marketValueUsd += t.marketValueUsd; totals.unrealizedUsd += t.unrealizedUsd;
        totals.afterTaxGainUsd += t.afterTaxGainUsd; totals.taxOwedUsd += t.taxOwedUsd; totals.holdingsCounted++;
      } else totals.holdingsLeftOut++;
    }
  }
  const rollup: ExitRollup = {
    holdingCount: holdings.length, stockCount: stockResults.length, optionCount: optionResults.length, actionCounts,
    independentSignalCount: independent.size, totals,
  };
  ctx.log.info('exit pipeline done', { holdings: holdings.length, actionCounts, independentSignals: independent.size, ms: ctx.clock.now() - startedAtMs });
  return {
    startedAtMs, holdings,
    groups: resolved.map((rg) => ({ groupId: rg.group.id, present: rg.present, shared: rg.shared, thesis: thesisByGroup.get(rg.group.id) ?? null })),
    skipped: { crypto: deps.portfolio.skippedCrypto, other: deps.portfolio.skippedOther, blankRowCount: deps.portfolio.blankRowCount },
    stage0, stage0Failed, portfolioQuality, portfolioQualityLines: dataQualityLines(portfolioQuality), rollup,
  };
}
