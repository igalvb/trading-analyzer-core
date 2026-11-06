/**
 * runTickerAnalysis: runAnalysisV7 (fullStockAnalysisV10_9.gs:919-1617),
 * the single-ticker analysis run, plus logDataStatusSummaryV7 (:5170-5192).
 *
 * Every step, log line and status write of legacy, in legacy's order.
 * The 6-minute hasTimeBudgetV7_ gates are gone (the user's rule): every
 * gated branch is always taken; the per-request HTTP timeout bounds each
 * fetch instead. The `typeof fn === 'function'` guards are all true here
 * (every guarded function is ported -- test/guardSites.ts).
 *
 * ══ INJECTED ═══════════════════════════════════════════════════════════
 * Every fetch and cache read (bound to its own dependencies by compose.ts),
 * the Gemini review, the broker-course report (its own inputs resolver,
 * compose.ts), and the renderers that are not this module's job: the
 * dashboard (buildDashboardV7, src/reports/dashboard -- agent E), the
 * failure sheet (buildFailureSheetV7) and the text-report tab writer
 * (writeTextReportToSheetV7).
 *
 * ══ PARITY MODE vs PRODUCTION (F-34, the user's decision) ═══════════════
 * `legacyParity: true` is legacy exactly: one try per fetch, the SPY fetch
 * unguarded (a throw aborts the run), no data-quality box.
 * Production (the default): every fetch goes through core/fetchStep.ts --
 * up to 3 tries with backoff, every failed attempt logged to the technical
 * log with the real error, and a plain DataQualityItem (core/messages.ts)
 * for the report's 'Data quality' box. The SPY fetch degrades instead of
 * aborting. Nothing in any model or score is touched: the same values reach
 * the same functions; only how a failed fetch is retried and reported
 * changes.
 *
 * The run log ('🔬 Log' tab, makeLogger) is the legacy technical log and
 * keeps legacy's lines verbatim, including raw error text -- it is a log.
 */

import type { Clock, RunContext } from '../core/context.ts';
import { StatusAccumulator } from '../core/status.ts';
import { fetchStep, type FetchStepDeps } from '../core/fetchStep.ts';
import { orElse, orElseAsync } from '../core/guard.ts';
import { qualityFor, statusQualityItems, PENDING_BEFORE_DASHBOARD, PENDING_MEANS_NOT_RUN, type KeyedQuality } from '../core/messages.ts';
import { classifyError, type EffectCode, type QualityItem, type ReasonCode } from '../reports/messages/catalog.ts';
import type { FundamentalsFallbackPolicy, SavedCopyVerdict } from '../fetch/fundamentals/resolve.ts';
import type { FundamentalsSeriesStore } from '../storage/fundamentalsSeriesTab.ts';
import type { TappingTransport } from '../net/httpTap.ts';
import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import type { FetchedChart, Chart } from '../types/chart.ts';
import type { GatherResult, MergedFundamentals, PeerBasicMetrics } from '../types/fundamentals.ts';
import type { PropertyStore } from '../storage/kv.ts';
import { makeLogger, type RunLog } from '../reports/runLog.ts';
import { getOrCreate } from '../reports/options/tabs.ts';
import { readOptionsSnapshot } from '../reports/options/run.ts';
import { resolveFundamentals } from '../fetch/fundamentals/resolve.ts';
import { attachMarketContext, type MarketContextChart } from '../fetch/marketContext.ts';
import { newDataStatus, setStatus, type DataStatus } from './dataStatus.ts';
import { computeIndicators } from './indicators/index.ts';
import { computeGann } from './gann.ts';
import { computeConfluenceTargets } from './confluence.ts';
import { computeFundamentalScore, peerSymbolsForScore, type FundamentalScore } from './fundamentalScore.ts';
import { analyzeOptionsForScoring, type OptionsScoring } from './options/scoring.ts';
import { computeOptionsShadow, type GatedRead, type OptionsShadow } from './options/nightlyRead.ts';
import type { SnapshotRead } from '../reports/options/run.ts';
import { computeTechnicalPlan, type TechnicalPlan } from './techPlan/plan.ts';
import { synthesizeDecision, type Decision } from './decision.ts';
import { playerMappingReadV1 } from './models/brokerCourse/playerMapping.ts';
import { zombieCompanyScreenV1, sharesOutstandingTrendReadV1, filingKeywordReadV1, filingKeywordRead, type CheckedFilingKeywordRead } from './models/brokerCourse/screens.ts';
import type { SharesOutstandingPoint } from '../fetch/sec/edgar.ts';
import { formatBrokerCourseReportV1, type BrokerCourseReport } from './models/brokerCourse/report.ts';
import { buildComparisonReportV1, formatComparisonReportV1, type ComparisonReport } from './models/brokerCourse/comparison.ts';
import { buildSchabackerReport, formatSchabackerReport } from './models/schabacker.ts';
import { buildEdwardsMageeReport, formatEdwardsMageeReport } from './models/edwardsMagee.ts';
import { buildTurtleReport, formatTurtleReport } from './models/turtle.ts';
import { formatDateInTz } from '../core/dates.ts';
import { buildExtraModelsReport, type ExtraModelsReport } from './extraModels.ts';
import { buildJamesReads, formatLiloV2Page, formatProfitTakingPage, type JamesReads } from './jamesPages.ts';
import { buildMeanRevRead, buildPairRead, buildWinnersRead, formatMeanRevPage, formatPairPage, formatWinnersPage, type James2Reads, type J2Bars, type WinnersRank } from './jamesPhase2Pages.ts';
import { pairsOf } from './models/pairRotation.ts';
import { buildCycleRead, buildMmRead, formatCyclePage, formatMmPage, type James3Reads, type J3Bars } from './jamesPhase3Pages.ts';
import { buildQualityRead, formatQualityGatePage, type James5Reads } from './jamesPhase5Pages.ts';
import { buildJamesLeapsRead, buildFairValueRead, formatJamesLeapsPage, formatFairValuePage, type James4Reads } from './jamesPhase4Pages.ts';
import { jamesCallsOfPick } from './options/leapsPick.ts';
import { rateOn } from '../research/optionsSim.ts';

const NO_JAMES = 'No reads — the price data was not available.';
import { liveBarFraction } from '../core/marketSession.ts';
import { atBuyLimit, type AtBuyLimit } from './atBuyLimit.ts';
import { nextResistance, fixedT2Display, type NextResistance, type FixedT2Display } from './nextResistance.ts';
import {
  formatWyckoffPage, formatTrendPage, formatComboPage, buildLiloRead, formatLiloPage, allModelsRows, formatAllModelsPage, writeAllModelsSheet,
  formatOptionsDecisionPage,
} from './reportPages.ts';
import { logDataStatusSummary, STATUS_DISPLAY_ORDER } from '../reports/text/textReports.ts';
import { activeProfile } from '../profile/active.ts';
import { defaultTickerOf } from '../profile/schema.ts';
import type { AnalyzeOpusResult } from '../ai/analyzeOpus.ts';

/** CONFIG_V7.tab / .version (fullStockAnalysisV10_9.gs:10-60). */
export const ANALYSIS_TAB = '📊 Analysis v7';
export const ENGINE_VERSION = 'v10.9';

export const MODEL_TABS = {
  broker: '📚 Broker Model',
  schabacker: '📜 Schabacker Model',
  edwardsMagee: '📖 Edwards & Magee Model',
  turtle: '🐢 Turtle Model',
  comparison: '🔀 Model Comparison',
  // FL-17b/17e: display-only pages, each model on its own page; none is written in legacy-parity mode.
  wyckoff: '🏛️ Wyckoff Model',
  trend: '📈 Trend Model',
  combo: '🧩 Combo Models',
  lilo: '🪜 LILO Model',
  // James's models, phase 1 (docs/models/MASTER_PLAN.md section 5): display-only pages, James's names
  liloV2: '🪜 James — LILO v2',
  profitTaking: '💰 James — Profit-Taking',
  // James's models, phase 2
  meanReversion: '↩️ James — Mean Reversion',
  pair: '🔁 James — Pair Rotation',
  winners: '🏆 James — Winners & Layering',
  // James's models, phase 3
  cycle: '🔄 James — Multi-Year Cycle',
  marketMaker: '🪤 James — Market Maker Stages',
  allModels: '🧮 All Models',
  optionsDecision: '📞 Options Decision',
  // James's models, phase 4 (after 📞 Options Decision)
  jamesLeaps: '🎯 James — LEAPS',
  jamesFairValue: '⚖️ James — Option Fair Value',
  // James's models, phase 5 (after 🔄 James — Multi-Year Cycle, before 🔀 Model Comparison)
  qualityGate: '✅ James — Quality Gate',
} as const;

export const MODEL_TAB_COLORS = {
  broker: '#6a1b9a', schabacker: '#8d6e63', edwardsMagee: '#5e35b1', turtle: '#00838f', comparison: '#00695c',
  wyckoff: '#4e342e', trend: '#2e7d32', combo: '#37474f', lilo: '#6a1b9a', liloV2: '#ad1457', profitTaking: '#f9a825', meanReversion: '#0277bd', pair: '#6d4c41', winners: '#c62828', cycle: '#00796b', marketMaker: '#5d4037', allModels: '#1a237e', optionsDecision: '#4a148c', jamesLeaps: '#283593', jamesFairValue: '#455a64', qualityGate: '#2e7d32',
} as const;

/** The legacy-dynamic indicator object, enriched by the run (dark pool, macro, screens, RS ranking). */
export type RunIndicators = ReturnType<typeof computeIndicators> & Record<string, any>;
export type RunFundResult = FundamentalScore & { dataWarning?: string };
export type RunTechPlan = TechnicalPlan<OptionsScoring>;

/** buildDashboardV7's 20 arguments (:1498), by name, plus the production data-quality box. */
export interface DashboardArgs {
  readonly ss: ReportWorkbook;
  readonly ticker: string;
  readonly chart: MarketContextChart;
  readonly ind: RunIndicators;
  readonly gann: ReturnType<typeof computeGann>;
  readonly confluence: ReturnType<typeof computeConfluenceTargets>;
  readonly fundResult: RunFundResult;
  readonly techPlan: RunTechPlan;
  readonly decision: Decision;
  readonly fund: MergedFundamentals | null;
  readonly optAnalysis: OptionsScoring;
  readonly fundSource: string;
  readonly aiReview: string | null;
  readonly status: DataStatus;
  readonly ladderStock: boolean;
  readonly ladderOptions: boolean;
  readonly leapsCall: unknown;
  readonly shortTermCall: unknown;
  readonly institutional13F: unknown;
  readonly shortInterestData: unknown;
  /** Production only ([] in parity mode): the 'Data quality' items (catalog QualityItem, rendered by dataQualityLines). */
  readonly dataQuality: readonly QualityItem[];
  /** Owner 2026-11-01 (Analyze only): Claude Opus's second opinion, shown under Gemini's review. Absent everywhere else. */
  readonly opusReview?: readonly string[] | null;
}

export interface TickerRenderers {
  /** buildDashboardV7 (agent E). Must leave the ANALYSIS_TAB sheet in the workbook. */
  dashboard(args: DashboardArgs): Promise<void> | void;
  /** buildFailureSheetV7 (:5231-5288). */
  failureSheet(ss: ReportWorkbook, ticker: string, status: DataStatus, error: unknown): Promise<void> | void;
  /** writeTextReportToSheetV7 (:5207-5229). */
  textReport(sheet: ReportSheet, text: string, accentColor: string): Promise<void> | void;
}

export interface GeminiArgs {
  readonly ticker: string;
  readonly fundResult: RunFundResult;
  readonly techPlan: RunTechPlan;
  readonly decision: Decision;
  readonly ind: RunIndicators;
  readonly gann: unknown;
  readonly confluence: unknown;
  readonly fund: MergedFundamentals | null;
  readonly chart: MarketContextChart;
  readonly optAnalysis: OptionsScoring;
  readonly leapsCall: unknown;
  readonly shortTermCall: unknown;
  /** B2/D18: fixed confidence words, the method-agreement label and the company name in the prompt. Unset = legacy prompt. */
  readonly plainPrompt?: boolean;
  /** E1 (option A): the "✅ AT YOUR BUY LIMIT — ..." label for the AI input. Absent in legacy-parity mode. */
  readonly atBuyLimit?: string;
  /** B1 option B (display only): "Next resistance: $X (+Y%, methods) · R:R to it Z" for the AI input. Absent in legacy-parity mode. */
  readonly nextResistance?: string;
  /** B1 option B part 2 (display only): "T2 (fixed): $X ..." when it differs from T2. Absent in legacy-parity mode. */
  readonly fixedT2?: string;
}

export interface TickerAnalysisDeps {
  /**
   * Fix plan 2026-10-30 B1/D2 research option (techPlan/entryPlan.ts ExitTargetOptions): T1 = the nearest valid target
   * cluster at least 1 ATR above the entry, T2 the next one, excluded methods skipped. Default off (today's rule);
   * ignored in legacy-parity mode. Only the research runs set it.
   */
  readonly nearestTargets?: boolean;
  /** Fix plan B1 option B part 2 (techPlan/entryPlan.ts ExitTargetOptions.fixedT2): T2 skips excluded methods. Ignored in legacy-parity mode. */
  readonly fixedT2?: boolean;
  readonly ss: ReportWorkbook;
  readonly timeZone: string;
  readonly clock: Clock;
  /** The technical log and the retry policy. Required unless legacyParity. */
  readonly ctx?: RunContext;
  /** The HTTP tap, so a fetch step can tell an outage from "no data". */
  readonly tap?: TappingTransport | null;
  /** Legacy exactly (oracle tests): no retries, SPY unguarded, no data-quality box. */
  readonly legacyParity?: boolean;

  readonly fetchYahooChart: (ticker: string) => Promise<FetchedChart | null>;
  /** fetchYahooChartLongRange_ (computeAllIndicators :7361). */
  readonly fetchLongRangeCloses: (ticker: string) => Promise<number[] | null>;
  /**
   * G0b: the dated 10-year daily bars, for James's display-only pages (an anchor older than the 2-year chart is still
   * found). Optional; never called in legacy-parity mode. Missing or failing: the pages use the run's chart and say so.
   */
  readonly fetchLongRangeBars?: (ticker: string) => Promise<FetchedChart | null>;
  /**
   * James — Winners & Layering (phase 2): the list ranking the nightly paper test stored. Optional; never called in
   * legacy-parity mode; missing or failing: the page says "rank not available".
   */
  readonly winnersRank?: () => Promise<WinnersRank | null>;
  /** gatherFundamentalsV7 (dataLayerV1.gs:58-86). */
  readonly gatherFundamentals: (ticker: string, log: RunLog) => Promise<GatherResult>;
  /** PropertiesService for the FUND_ cache. */
  readonly fundamentalsStore: PropertyStore;
  /** Legacy `new Date().toLocaleDateString()` for the FUND_ cache label. */
  readonly dateLabel?: (d: Date) => string;
  /** fetchPeerBasicMetricsV7 for each peerSymbolsForScore symbol, in order. */
  readonly fetchPeerMetrics: (symbols: readonly string[]) => Promise<ReadonlyMap<string, PeerBasicMetrics | null>>;
  /** getTickerDarkPoolShareV1_(ticker, chart, log). */
  readonly getTickerDarkPoolShare: (ticker: string, chart: MarketContextChart, log: RunLog) => Promise<unknown>;
  /** getCachedMacroRegime_ (memoised for the run by the caller). */
  readonly getCachedMacroRegime: () => Promise<{ readonly available: boolean; readonly regime?: string; readonly supplemental?: any; readonly dowTheory?: any; readonly evaluativeIndex?: any }>;
  /** readBrokerDataCacheV1_(ticker). */
  readonly readBrokerDataCache: (ticker: string) => Promise<{ readonly interestCoverageRatio: number | null } | null>;
  /**
   * Fix 2026-11-05 (log level only): true when the interest coverage is missing because FMP's ratios-ttm answered 402
   * (not in the plan, remembered). The zombie screen's report status is unchanged; the technical log says DEBUG
   * 'skipped' instead of a nightly WARNING. Optional; absent = false.
   */
  readonly interestCoverageNotInPlan?: (ticker: string) => Promise<boolean>;
  /**
   * Fix 2026-11-05 (log level only): the nightly's scratch workbooks share ONE _OPTIONS_SNAPSHOT (one ticker's), so a
   * snapshot for another ticker is expected there: the report status is unchanged, the technical log says DEBUG 'skipped'.
   */
  readonly optionsSnapshotShared?: boolean;
  readonly fetchSecEdgarCIK: (ticker: string) => Promise<string | null>;
  readonly fetchSharesOutstandingHistory: (cik: string) => Promise<SharesOutstandingPoint[] | null>;
  readonly fetchSecFilingKeywordHits: (cik: string, sinceDate: string) => Promise<Record<string, number | null> | null>;
  /** getCachedRelativeStrengthRankingV1_(ticker). */
  readonly getCachedRelativeStrengthRanking: (ticker: string) => Promise<unknown>;
  /** fetchGeminiReviewV7 (agent D's port, bound). Production: retried through fetchStep on a provider failure (429/5xx/timeout). */
  readonly fetchGeminiReview: (args: GeminiArgs, log: RunLog) => Promise<string | null>;
  /**
   * Owner 2026-11-01: Analyze (one stock) only -- Claude Opus's second opinion on Gemini's review (ai/analyzeOpus.ts).
   * Display only, never throws, never read by a score. Absent (the nightly, AI Dispatch, `npm run ticker`, the
   * recordings): nothing is called and the page is unchanged. Never called in legacy-parity mode.
   */
  readonly fetchOpusReview?: (args: GeminiArgs, geminiText: string | null) => Promise<AnalyzeOpusResult>;
  /** When the AI review is deliberately off (no key, --no-ai): truthy, and the box says the AI step did not run. */
  readonly aiUnavailable?: string | boolean | null;
  /** The user's saved-copy rule for fundamentals (resolve.ts). Absent/null = legacy: any saved copy is used. */
  readonly fundamentalsFallback?: FundamentalsFallbackPolicy | null;
  /** Stamp each saved fundamentals copy with `fetchedAt` (production). */
  readonly stampFundamentalsFetchedAt?: boolean;
  /** F-36 option B (default off): series and peers in their own tab. */
  readonly fundamentalsSeriesStore?: FundamentalsSeriesStore | null;
  /** buildBrokerCourseReportV1 with legacy's arguments; the inputs resolver lives in compose.ts. */
  readonly buildBrokerCourseReport: (
    ticker: string, log: RunLog, chart: MarketContextChart, vixLevel: number | null, fund: MergedFundamentals | null,
    cik: string | null | undefined, soHistory: SharesOutstandingPoint[] | null | undefined, filingHits: Record<string, number | null> | null | undefined,
  ) => Promise<BrokerCourseReport | null>;
  readonly render: TickerRenderers;
  /**
   * Options sentiment A-8 (shadow): tonight's gated per-stock options read for this ticker (jobs/options/optionsNight.ts).
   * When given, the run also computes what the tech score, conviction and timing WOULD be with it applied; the real
   * decision is unchanged. Nightly only; never in legacy-parity mode.
   */
  readonly optionsShadow?: (ticker: string) => { readonly gated: GatedRead; readonly snap: SnapshotRead } | null;
}

export interface TickerAnalysisResult {
  readonly fundResult: RunFundResult;
  readonly techPlan: RunTechPlan;
  readonly decision: Decision;
}

/** Everything the run produced, for the CLI's text output and the automation. */
export interface TickerArtifacts {
  readonly ticker: string;
  result: TickerAnalysisResult | undefined;
  status: DataStatus;
  dataQuality: QualityItem[];
  chart?: MarketContextChart;
  gann?: ReturnType<typeof computeGann>;
  confluence?: ReturnType<typeof computeConfluenceTargets>;
  leapsCall?: unknown;
  shortTermCall?: unknown;
  ind?: RunIndicators;
  fund?: MergedFundamentals | null;
  fundSource?: string;
  optAnalysis?: OptionsScoring;
  aiReview?: string | null;
  /** Owner 2026-11-01 (Analyze only): Claude Opus's second opinion (display only). Absent when not asked for. */
  opusReview?: AnalyzeOpusResult | null;
  reports: { broker?: BrokerCourseReport | null; schabacker?: unknown; edwardsMagee?: unknown; turtle?: unknown; comparison?: ComparisonReport | null; extraModels?: ExtraModelsReport | null };
  /** E1 (option A, label only): set when the price is at the buy limit (analysis/atBuyLimit.ts). Never in legacy-parity mode. */
  atBuyLimit?: AtBuyLimit | null;
  /** B1 option B (display only): the nearest valid resistance 1 ATR above the entry (analysis/nextResistance.ts). Never in legacy-parity mode. */
  nextResistance?: NextResistance | null;
  /** B1 option B part 2 (display only): T2 with the excluded methods skipped, when it differs from T2. Never in legacy-parity mode. */
  fixedT2?: FixedT2Display | null;
  /** Options sentiment A-8: the "if applied" numbers of tonight's options read (shadow; nothing applied). */
  optionsShadow?: OptionsShadow | null;
  /** Text written to each model tab, by tab name. */
  texts: Record<string, string>;
  /** Set when the run aborted (legacy's top-level catch, or no price data). */
  aborted?: string;
}

const errMessage = (e: any): string => (e && e.message ? e.message : String(e));
const fmt1 = (ms: number): string => (ms / 1000).toFixed(1);

/** logDataStatusSummaryV7 (:5170-5192) and its order: one copy, reports/text/textReports.ts (dedupe cluster 6). */
export const STATUS_ORDER: readonly string[] = STATUS_DISPLAY_ORDER;
export { logDataStatusSummary };

/**
 * The data-quality items: the fetch-step items first (they carry the real reason), then every status entry left
 * failed, degraded or skipped (F-H5: skipped was dropped), and with `pendingNotRun` every listed entry still
 * 'pending' (it never ran). core/messages.ts statusQualityItems is the one calculation.
 */
export function dataQualityFromStatus(status: DataStatus, fetchItems: readonly KeyedQuality[], now: Date = new Date(), pendingNotRun?: readonly string[]): QualityItem[] {
  const have = new Set(fetchItems.map((i) => i.key));
  const fromStatus = statusQualityItems(status as never, now, { order: STATUS_ORDER, skip: have, ...(pendingNotRun ? { pendingNotRun } : {}) });
  return [...fetchItems, ...fromStatus].map((q) => q.item);
}

/** runAnalysisV7, with legacy's return value (`undefined` when it aborted). */
export async function runTickerAnalysis(
  deps: TickerAnalysisDeps, tickerIn?: unknown, ladderStock?: unknown, ladderOptions?: unknown, leapsCallArg?: unknown, shortTermCallArg?: unknown,
): Promise<TickerAnalysisResult | undefined> {
  return (await runTickerAnalysisDetailed(deps, tickerIn, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg)).result;
}

export async function runTickerAnalysisDetailed(
  deps: TickerAnalysisDeps, tickerIn?: unknown, ladderStock?: unknown, ladderOptions?: unknown, leapsCallArg?: unknown, shortTermCallArg?: unknown,
): Promise<TickerArtifacts> {
  const parity = !!deps.legacyParity;
  if (!parity && !deps.ctx) throw new Error('runTickerAnalysis: a RunContext (ctx) is required outside legacy-parity mode');
  const now = (): number => deps.clock.now();
  const ticker = (String(tickerIn || defaultTickerOf(activeProfile()))).toUpperCase().trim();
  const ss = deps.ss;
  const log = makeLogger(ss, { timeZone: deps.timeZone, clock: deps.clock });
  const t0 = now();
  const status = newDataStatus();
  // FL-9g: reason codes only outside parity mode (the oracle comparison deep-equals the status object).
  const tech = deps.ctx ? deps.ctx.log.child(ticker) : null;
  // docs/LOGGING_SPEC.md: every section status also reaches the technical log (failed = ERROR, degraded = WARNING,
  // skipped / ok = DEBUG), with the raw detail; the report only ever shows the curated status sentence.
  // logState: what the technical log calls it when that differs from the report's state (the AI review deliberately
  // off is 'degraded' in the report, unchanged, but 'skipped' = DEBUG in the log: nothing failed).
  const S = (key: string, state: string, detail?: string | null, rc?: ReasonCode, logState: string = state): void => {
    setStatus(status, key, state, detail, parity ? undefined : rc);
    if (!tech) return;
    const data = { section: key, ...(detail ? { detail } : {}), ...(rc ? { reason: rc } : {}) };
    if (logState === 'failed') tech.error('section ' + key + ' failed', data);
    else if (logState === 'degraded') tech.warning('section ' + key + ' degraded', data);
    else tech.debug('section ' + key + ' ' + logState, data);
  };
  const art: TickerArtifacts = { ticker, result: undefined, status, dataQuality: [], reports: {}, texts: {}, leapsCall: leapsCallArg, shortTermCall: shortTermCallArg };
  const fetchItems: KeyedQuality[] = [];
  const stepDeps: FetchStepDeps = { ctx: deps.ctx as RunContext, parity, tap: deps.tap ?? null };

  /** One fetch through fetchStep; in production a failure is recorded and yields null. */
  const step = async <T>(key: string, source: string, fn: () => Promise<T>, opts: { onNull?: 'retry' | 'tap' | 'accept'; label?: string; effect?: EffectCode; noDataNote?: string } = {}): Promise<T | null> => {
    const r = await fetchStep(stepDeps, { key, source, onNull: opts.onNull, label: opts.label, effect: opts.effect, noDataNote: opts.noDataNote }, fn);
    if (r.ok) return r.value;
    fetchItems.push(r.quality);
    return null;
  };
  const writeModelTab = async (tab: string, text: string, color: string): Promise<void> => {
    art.texts[tab] = text;
    await deps.render.textReport(getOrCreate(ss, tab), text, color);
  };
  const activateAnalysisTab = (required: boolean): void => {
    const sh = ss.getSheetByName(ANALYSIS_TAB);
    if (sh) sh.activate();
    else if (required) (null as unknown as ReportSheet).activate(); // legacy :1599 dereferences the missing sheet and throws
  };

  log('▶ Analysis v7 — ' + ticker);
  tech?.info('analysis start', { ticker, parity });

  try {
    // 1. Price -- the one input the run cannot proceed without.
    log('📡 Fetching OHLCV...');
    const fetched = await step('price', 'Yahoo chart ' + ticker, () => deps.fetchYahooChart(ticker));
    if (!fetched) {
      S('price', 'failed', 'Yahoo returned no price data — check the ticker symbol', 'NO_DATA_FOR_TICKER');
      log('❌ Price data failed — check ticker');
      await deps.render.failureSheet(ss, ticker, status, new Error('Price data unavailable for ' + ticker));
      activateAnalysisTab(false);
      art.aborted = 'no price data';
      art.dataQuality = parity ? [] : dataQualityFromStatus(status, fetchItems, new Date(now()));
      return art;
    }
    S('price', 'ok', fetched.closes.length + ' days');
    log('✅ ' + fetched.closes.length + ' days  |  $' + fetched.currentPrice.toFixed(2));

    // 2. Fundamentals: live, else the FUND_ cache, else none.
    const gather = parity ? deps.gatherFundamentals : async (t: string, l: RunLog): Promise<GatherResult> => {
      const hasData = (g: GatherResult | null): boolean => !!(g && g.fund && (g.fund._sources.length || g.fund.beta != null));
      let last: GatherResult | null = null;
      const r = await step('fundamentals', 'Fundamentals (FMP / Alpha Vantage / Finnhub) ' + t, async () => {
        last = await deps.gatherFundamentals(t, l);
        return hasData(last) ? last : null;
      });
      return r ?? last ?? { fund: null, source: 'none' };
    };
    let savedCopy: SavedCopyVerdict | null = null;
    const { fund, fundSource } = await resolveFundamentals(ticker, {
      gather, store: deps.fundamentalsStore, now: () => new Date(now()), dateLabel: deps.dateLabel, log,
      setStatus: (k, st, d, rc, ls) => S(k, st, d, rc, ls),
      ...(parity ? {} : {
        fallback: deps.fundamentalsFallback ?? null,
        stampFetchedAt: !!deps.stampFundamentalsFetchedAt,
        seriesStore: deps.fundamentalsSeriesStore ?? null,
        onSavedCopy: (v: SavedCopyVerdict) => {
          savedCopy = v;
          tech?.warning('fundamentals saved copy ' + (v.accepted ? 'used' : 'refused') + ': ' + v.why, { savedAt: v.savedAt ? v.savedAt.toISOString() : null });
        },
      }),
    });
    if (!parity && savedCopy) {
      // The plain line names the copy's date; the live failure's reason (if any) says why it was needed.
      const sc = savedCopy as SavedCopyVerdict;
      const at = fetchItems.findIndex((q) => q.key === 'fundamentals');
      const liveReason: ReasonCode = at >= 0 ? fetchItems[at].item.reasonCode : 'PROVIDER_NO_RESPONSE';
      if (at >= 0) fetchItems.splice(at, 1);
      const saved = sc.savedAt ? { savedDate: sc.savedAt } : {};
      fetchItems.push(sc.accepted
        ? qualityFor('fundamentals', liveReason, new Date(now()), { effect: 'USES_SAVED_DATA', ...saved })
        : qualityFor('fundamentals', 'SAVED_COPY_TOO_OLD', new Date(now()), { effect: 'PRICE_CHART_ONLY', ...saved }));
    }

    // 3a / 3 / 3b. Sector ETF, SPY, VIX (fetch/marketContext.ts).
    const contextFetch = parity ? deps.fetchYahooChart : async (t: string): Promise<FetchedChart | null> => {
      const key = t === 'SPY' ? 'spyRS' : t === '^VIX' ? 'vix' : 'sector';
      return step(key, 'Yahoo chart ' + t, () => deps.fetchYahooChart(t));
    };
    const chart = await attachMarketContext(fetched, fund, { fetchChart: contextFetch, log, setStatus: (k, st, d, rc) => S(k, st, d, rc) });
    art.chart = chart;
    const analysisChart = toAnalysisChart(chart);

    // 4-5. Indicators + Gann; 6. Confluence -- each a controlled abort.
    let ind: RunIndicators, gann: ReturnType<typeof computeGann>, confluence: ReturnType<typeof computeConfluenceTargets>;
    try {
      const longCloses = await step('longRange', 'Yahoo 10y closes ' + ticker, () => deps.fetchLongRangeCloses(ticker));
      ind = computeIndicators(analysisChart, {
        simulatedNow: new Date(now()), longCloses,
        // Legacy computeAllIndicators has no per-slice catch: the first throw aborts it.
        onSliceError: (f) => { throw f.cause; },
      }) as RunIndicators;
      S('indicators', 'ok', '');
      log('✅ RSI=' + ind.rsi14!.toFixed(1) + '  ADX=' + ind.adx14!.toFixed(1) + '  ATR=$' + ind.atr14!.toFixed(2));
    } catch (e) { S('indicators', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); throw e; }
    try {
      gann = computeGann(analysisChart);
      S('gann', 'ok', '');
      log('✅ Gann pivot: ' + gann.pivot.dateStr + ' @ $' + gann.pivot.price.toFixed(2) + '  |  score ' + gann.score + '/100');
    } catch (e) { S('gann', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); throw e; }
    try {
      confluence = computeConfluenceTargets(ind, gann, fund, analysisChart, { plainText: !parity });
      S('confluence', 'ok', '');
      log('Entry zone: $' + confluence.entryLow.toFixed(2) + '–$' + confluence.entryHigh.toFixed(2) + '  (' + confluence.entryConfidence + ')');
      log('Exit zone:  $' + confluence.exitLow.toFixed(2) + '–$' + confluence.exitHigh.toFixed(2) + '  (' + confluence.exitConfidence + ')');
    } catch (e) { S('confluence', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); throw e; }
    art.ind = ind; art.fund = fund; art.fundSource = fundSource; art.gann = gann; art.confluence = confluence;

    // 6.5. Dark pool share (cache-only FINRA week + one live query).
    try {
      ind.darkPoolShare = await deps.getTickerDarkPoolShare(ticker, chart, log);
      S('darkPool', ind.darkPoolShare ? 'ok' : 'degraded', ind.darkPoolShare ? '' : 'no cached FINRA week yet, or no data for this ticker/week', ind.darkPoolShare ? undefined : 'NO_DATA_FOR_TICKER');
    } catch (e) {
      S('darkPool', 'degraded', errMessage(e), 'SECTION_UNAVAILABLE');
    }

    // 6.6. Macro supplemental / Dow theory / Evaluative Index (display-only attach).
    await orElseAsync(tech, 'macro supplemental / Dow theory / Evaluative Index attach (display only)', async () => {
      const m = await deps.getCachedMacroRegime();
      if (m && m.supplemental) ind.macroSupplemental = m.supplemental;
      if (m && m.dowTheory && m.dowTheory.verdict) ind.dowTheoryConfirmation = m.dowTheory;
      if (m && m.evaluativeIndex && m.evaluativeIndex.pctStrong != null) ind.evaluativeIndex = m.evaluativeIndex;
    }, undefined);

    // 6.65. Player Mapping.
    try {
      if (!chart.closes || !chart.closes.length) S('playerMapping', 'skipped', 'no chart data available', 'NOT_RUN');
      else {
        const pm = playerMappingReadV1(chart.closes, chart.highs, chart.lows, chart.volumes, chart.currentPrice, 20);
        if (pm) { ind.playerMapping = pm; S('playerMapping', 'ok', pm.tag); }
        else S('playerMapping', 'degraded', 'playerMappingReadV1 returned null', 'NO_DATA_FOR_TICKER');
      }
    } catch (e) { S('playerMapping', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); }

    // 6.66. Zombie Company Screen (the broker-data cache, never live).
    try {
      const cached = await deps.readBrokerDataCache(ticker);
      const icr = cached ? cached.interestCoverageRatio : null;
      const zombie = zombieCompanyScreenV1(icr);
      if (zombie) { ind.zombieCompanyScreen = zombie; S('zombieCompanyScreen', 'ok', ''); }
      else {
        const notInPlan = !parity && deps.interestCoverageNotInPlan ? await deps.interestCoverageNotInPlan(ticker) : false;
        S('zombieCompanyScreen', 'degraded', 'Interest-coverage data not yet available (populated by the nightly automation)', 'NO_DATA_FOR_TICKER', notInPlan ? 'skipped' : undefined);
      }
    } catch (e) { S('zombieCompanyScreen', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); }

    // 6.67. Dilution / filing-keyword screen. undefined = never attempted; null = attempted, nothing found.
    let dilutionCik: string | null | undefined, sharedSoHistory: SharesOutstandingPoint[] | null | undefined, sharedFilingHits: Record<string, number | null> | null | undefined;
    try {
      const tCik = now();
      dilutionCik = await step('dilutionScreen', 'SEC EDGAR CIK ' + ticker, () => deps.fetchSecEdgarCIK(ticker));
      log('  ⏱ SEC EDGAR CIK lookup: ' + fmt1(now() - tCik) + 's');
      if (!dilutionCik) {
        S('dilutionScreen', 'degraded', 'no real SEC CIK found for this ticker', 'NO_DATA_FOR_TICKER');
      } else {
        let gotOne = false;
        const tSo = now();
        sharedSoHistory = await step('dilutionScreen', 'SEC shares-outstanding history ' + ticker, () => deps.fetchSharesOutstandingHistory(dilutionCik as string),
          { noDataNote: 'SEC has no company-wide share count for this ticker (e.g. per-class shares only); the share-count trend of the dilution screen is skipped for it' });
        log('  ⏱ SEC shares-outstanding history fetch: ' + fmt1(now() - tSo) + 's');
        const soTrend = sharesOutstandingTrendReadV1(sharedSoHistory, 4);
        if (soTrend) { ind.sharesOutstandingTrend = soTrend; gotOne = true; }
        const oneYearAgo = new Date(now() - 365 * 86400000);
        const tHits = now();
        sharedFilingHits = await step('dilutionScreen', 'SEC filing-keyword search ' + ticker,
          () => deps.fetchSecFilingKeywordHits(dilutionCik as string, formatDateInTz(oneYearAgo, 'UTC', 'yyyy-MM-dd')));
        log('  ⏱ SEC filing-keyword search (up to 5 real calls): ' + fmt1(now() - tHits) + 's');
        // Fix 2026-11-05: a keyword SEC's search could not answer (after retries) is named, and the section is degraded,
        // not ok (identical to filingKeywordReadV1 when every keyword answered; parity keeps legacy's read).
        const kwRead: CheckedFilingKeywordRead | null = parity ? filingKeywordReadV1(sharedFilingHits) : filingKeywordRead(sharedFilingHits);
        if (kwRead) { ind.filingKeywordScreen = kwRead; gotOne = true; }
        const unchecked = kwRead?.uncheckedKeywords ?? null;
        if (unchecked) S('dilutionScreen', 'degraded', 'SEC full-text search could not check: ' + unchecked.join(', '), 'PROVIDER_NO_RESPONSE');
        else S('dilutionScreen', gotOne ? 'ok' : 'degraded', gotOne ? '' : 'real CIK found but no shares-outstanding history or filing-keyword data came back', gotOne ? undefined : 'NO_DATA_FOR_TICKER');
      }
    } catch (e) { S('dilutionScreen', 'failed', errMessage(e), 'SECTION_UNAVAILABLE'); }

    // 6.7. Relative Strength Ranking (cache-only).
    const rsr = await orElseAsync(tech, 'relative strength ranking read (display only)', () => deps.getCachedRelativeStrengthRanking(ticker), null);
    if (rsr) ind.relativeStrengthRanking = rsr;

    // 7. Fundamental score -- zero technical input.
    const peerMetrics = await deps.fetchPeerMetrics(peerSymbolsForScore(fund));
    const fundResult: RunFundResult = computeFundamentalScore(fund, peerMetrics);
    if (status.fundamentals && status.fundamentals.state === 'degraded') fundResult.dataWarning = status.fundamentals.detail;
    log('📊 OWN score: ' + (fundResult.score != null ? fundResult.score + '/100 (' + fundResult.profile + ') ' + fundResult.verdict : 'N/A'));

    // 7.5. Options snapshot (direction-independent read first).
    const optSnap: any = readOptionsSnapshot(ss, ticker, now(), deps.timeZone);
    let optAnalysis = analyzeOptionsForScoring(optSnap, null, { plainLabels: !parity });
    if (!optSnap) S('options', 'degraded', 'No options snapshot — run Options Analysis on this ticker first', 'NO_DATA_FOR_TICKER');
    else if (optSnap.mismatch) S('options', 'degraded', 'Snapshot is for ' + optSnap.ticker + ' — run Options Analysis on ' + ticker, 'NO_DATA_FOR_TICKER', deps.optionsSnapshotShared ? 'skipped' : undefined);
    else S('options', (optSnap.ageDays != null && optSnap.ageDays > 4) ? 'degraded' : 'ok',
      (optSnap.ageDays != null && optSnap.ageDays > 4) ? ('Snapshot is ~' + Math.round(optSnap.ageDays) + 'd old') : '',
      (optSnap.ageDays != null && optSnap.ageDays > 4) ? 'SAVED_COPY_TOO_OLD' : undefined);
    log(optAnalysis.available ? '✅ Options snapshot loaded (' + optSnap.contracts.length + ' contracts)'
      : 'ℹ️ No usable options snapshot for ' + ticker + ' — scoring proceeds without it');

    // 8. Technical plan -- zero fundamentals input.
    const techPlan: RunTechPlan = computeTechnicalPlan(ind, gann, confluence, analysisChart, optAnalysis, parity ? {} : {
      ...(deps.nearestTargets ? { nearestTargets: true } : {}), ...(deps.fixedT2 ? { fixedT2: true } : {}),
    });
    if (status.spyRS && status.spyRS.state === 'degraded') techPlan.dataWarning = status.spyRS.detail;
    log('🎯 Tech score: ' + techPlan.techScore + '/100  Regime ' + techPlan.regime + '  Timing ' + techPlan.timing);
    log('   Entry $' + techPlan.entryPrice.toFixed(2) + '  ETA ' + (techPlan.timeToEntry ? techPlan.timeToEntry.humanText : 'N/A') + '  Confidence ' + techPlan.entryConfidencePct + '%');

    optAnalysis = analyzeOptionsForScoring(optSnap, techPlan, { plainLabels: !parity });
    if (optAnalysis.available) { techPlan.options = optAnalysis; log('   Options: ' + optAnalysis.confirm.toUpperCase() + ' — ' + optAnalysis.notes.join(' · ')); }
    art.optAnalysis = optAnalysis;

    // 9. Decision. synthesizeDecisionV7 reads getCachedMacroRegime_ itself (:3238).
    const macroRead = await deps.getCachedMacroRegime();
    const acc = new StatusAccumulator();
    const decision = synthesizeDecision(fundResult, techPlan, optAnalysis, macroRead as never, acc);
    const macroEntry = acc.get('macroRegime');
    if (macroEntry) {
      // Legacy's own detail text (:3239-3240); decision.ts's accumulator wording differs (F-11 note).
      const okRead = macroEntry.state === 'ok';
      // C4: a regime classified from a live fetch (a saved copy was stale) says so; absent in legacy mode.
      const liveSource = (macroRead as { source?: unknown } | null)?.source;
      S('macroRegime', okRead ? 'ok' : 'degraded', okRead ? (typeof liveSource === 'string' ? liveSource : 'cached read') :'cache stale/missing — refreshed by a separate daily trigger, not fetched inline (v9.70)', okRead ? undefined : 'NOT_SAVED_YET');
    }
    log('✅ Decision: ' + decision.action + '   Final Conviction ' + decision.finalConviction + '/100');

    // 9.5. Options sentiment A-8 (shadow): the same scoring with tonight's own options read, kept aside. Display only.
    if (!parity && deps.optionsShadow) {
      try {
        const sh = deps.optionsShadow(ticker);
        const targets = { ...(deps.nearestTargets ? { nearestTargets: true } : {}), ...(deps.fixedT2 ? { fixedT2: true } : {}) };
        art.optionsShadow = sh ? computeOptionsShadow(ticker, {
          gated: sh.gated, snap: sh.snap, techPlan, decision, optAnalysis,
          plan: (opt) => {
            const p: RunTechPlan = computeTechnicalPlan(ind, gann, confluence, analysisChart, opt, targets);
            if (techPlan.dataWarning) p.dataWarning = techPlan.dataWarning;
            return p;
          },
          decide: (tp, opt) => synthesizeDecision(fundResult, tp, opt, macroRead as never, new StatusAccumulator()),
        }) : null;
        if (art.optionsShadow) log('   Options read (not yet applied): ' + art.optionsShadow.confirm.toUpperCase() + ', conviction ' + decision.finalConviction + ' → ' + art.optionsShadow.convictionIfApplied + ' if applied');
      } catch (e) {
        art.optionsShadow = null;
        tech?.warning('options shadow failed (nothing applied, the decision is unchanged): ' + errMessage(e));
      }
    }

    // 11. AI review (Gemini).
    log('🤖 Requesting Gemini v7 review...');
    const tGemini = now();
    // E1 (option A, label only): price inside/below the buy zone, above the stop, timing WAIT_PULLBACK. Display only.
    const atLimit = parity ? null : atBuyLimit({
      timing: techPlan.timing, currentPrice: chart.currentPrice, entryLow: techPlan.entryLow, entryHigh: techPlan.entryHigh, entryPrice: techPlan.entryPrice, stop: techPlan.stop,
    });
    if (!parity) art.atBuyLimit = atLimit;
    // B1 option B (display only): the next resistance next to T1; T1, the conviction and the R:R gate are unchanged.
    // B1 option B part 2: the fixed T2 is shown beside T2 (switching it on made LILO worse, targets-test.md).
    let nextRes: NextResistance | null = null, fixedT2: FixedT2Display | null = null;
    if (!parity) {
      nextRes = orElse(tech, 'next resistance (display only)', () => nextResistance({ confluence, atr: ind.atr14, entryPrice: techPlan.entryPrice, stop: techPlan.stop, currentPrice: chart.currentPrice, t1Price: techPlan.t1?.price }), null);
      fixedT2 = orElse(tech, 'fixed T2 (display only)', () => fixedT2Display({ confluence, atr: ind.atr14, entryPrice: techPlan.entryPrice, t2Price: techPlan.t2?.price ?? null }), null);
      art.nextResistance = nextRes;
      art.fixedT2 = fixedT2;
    }
    const geminiArgs: GeminiArgs = {
      ticker, fundResult, techPlan, decision, ind, gann, confluence, fund, chart, optAnalysis, leapsCall: leapsCallArg, shortTermCall: shortTermCallArg,
      ...(parity ? {} : { plainPrompt: true }),
      ...(atLimit ? { atBuyLimit: atLimit.text } : {}),
      ...(nextRes ? { nextResistance: nextRes.text } : {}),
      ...(fixedT2 ? { fixedT2: fixedT2.text } : {}),
    };
    const aiReview = (parity || deps.aiUnavailable)
      ? await deps.fetchGeminiReview(geminiArgs, log)
      : await step('aiReview', 'Gemini review ' + ticker, () => deps.fetchGeminiReview(geminiArgs, log));
    if (!aiReview && deps.aiUnavailable && !parity) fetchItems.push(qualityFor('aiReview', 'NOT_RUN', new Date(now())));
    S('aiReview', aiReview ? 'ok' : 'degraded', aiReview ? '' : 'AI narrative unavailable (all numbers above are unaffected)', aiReview ? undefined : 'AI_REVIEW_UNAVAILABLE',
      !aiReview && deps.aiUnavailable ? 'skipped' : undefined);
    log((aiReview ? '✅ Gemini review received (' + aiReview.length + ' chars)' : 'ℹ️ Gemini review unavailable') + '  [⏱ ' + fmt1(now() - tGemini) + 's]');
    art.aiReview = aiReview;
    if (!parity && deps.fetchOpusReview) {
      const tOpus = now();
      log('🤖 Requesting Claude Opus second opinion...');
      art.opusReview = await deps.fetchOpusReview(geminiArgs, aiReview).catch((e: unknown) => { log('ℹ️ Opus second opinion not added: ' + errMessage(e)); return null; });
      if (art.opusReview) log('ℹ️ ' + art.opusReview.summary + '  [⏱ ' + fmt1(now() - tOpus) + 's]');
    }

    // Broker Course Model -- before the dashboard (v9.99), its own try/catch.
    let brokerModelReport: BrokerCourseReport | null = null;
    try {
      const tBroker = now();
      log('🏗️ Building broker-course model report...');
      brokerModelReport = await deps.buildBrokerCourseReport(ticker, log, chart, chart.vixContext ? chart.vixContext.level : null, fund, dilutionCik, sharedSoHistory, sharedFilingHits);
      log('  ⏱ broker-course model report: ' + fmt1(now() - tBroker) + 's');
      await writeModelTab(MODEL_TABS.broker, formatBrokerCourseReportV1(brokerModelReport, parity ? {} : { plainText: true, timeZone: deps.timeZone, analysisGaps: (ind as any).priceGaps ?? null }), MODEL_TAB_COLORS.broker);
      S('brokerModel', brokerModelReport ? 'ok' : 'degraded', brokerModelReport ? '' : 'broker-course report build returned null', brokerModelReport ? undefined : 'SECTION_UNAVAILABLE');
    } catch (e) {
      S('brokerModel', 'failed', errMessage(e), classifyError(e));
      log('⚠️ Broker-course model report failed: ' + errMessage(e) + ' (does not affect Schabacker/E&M/main dashboard)');
    }
    art.reports.broker = brokerModelReport;

    // 12-13. Render the dashboard.
    log('🏗️ Building v7 dashboard (' + ANALYSIS_TAB + ')...');
    // F-H5: a step that should have run by now and is still 'pending' is listed as not run (the 13F step is the dashboard's own).
    const preQuality = parity ? [] : dataQualityFromStatus(status, fetchItems, new Date(now()), PENDING_BEFORE_DASHBOARD);
    await deps.render.dashboard({
      ss, ticker, chart, ind, gann, confluence, fundResult, techPlan, decision, fund, optAnalysis, fundSource, aiReview, status,
      ladderStock: !!ladderStock, ladderOptions: !!ladderOptions, leapsCall: leapsCallArg, shortTermCall: shortTermCallArg,
      institutional13F: brokerModelReport ? (brokerModelReport as any).institutional13F : undefined,
      shortInterestData: (brokerModelReport && (brokerModelReport as any).news) ? (brokerModelReport as any).news.shortInterestData : undefined,
      dataQuality: preQuality,
      ...(art.opusReview ? { opusReview: art.opusReview.lines } : {}),
    });
    log('✅ Done in ' + fmt1(now() - t0) + 's');

    // Schabacker / Edwards & Magee / Turtle -- built only from data already computed.
    let schabackerReport: any = null;
    try {
      const t = now();
      log('🏗️ Building Schabacker model report...');
      schabackerReport = buildSchabackerReport(ticker, ind as never, techPlan as never, analysisChart as never, log);
      log('  ⏱ Schabacker model report: ' + fmt1(now() - t) + 's');
      await writeModelTab(MODEL_TABS.schabacker, formatSchabackerReport(schabackerReport, parity ? {} : { plainText: true, timeZone: deps.timeZone }), MODEL_TAB_COLORS.schabacker);
      S('schabackerModel', schabackerReport ? 'ok' : 'degraded', schabackerReport ? '' : 'Schabacker report build returned null', schabackerReport ? undefined : 'SECTION_UNAVAILABLE');
    } catch (e) {
      S('schabackerModel', 'failed', errMessage(e), 'SECTION_UNAVAILABLE');
      log('⚠️ Schabacker model report failed: ' + errMessage(e) + ' (does not affect Broker Model/E&M/main dashboard)');
    }
    let edwardsMageeReport: any = null;
    try {
      const t = now();
      log('🏗️ Building Edwards & Magee model report...');
      edwardsMageeReport = buildEdwardsMageeReport(ticker, ind as never, techPlan as never, log);
      log('  ⏱ Edwards & Magee model report: ' + fmt1(now() - t) + 's');
      await writeModelTab(MODEL_TABS.edwardsMagee, formatEdwardsMageeReport(edwardsMageeReport, parity ? {} : { plainText: true, timeZone: deps.timeZone }), MODEL_TAB_COLORS.edwardsMagee);
      S('edwardsMageeModel', edwardsMageeReport ? 'ok' : 'degraded', edwardsMageeReport ? '' : 'Edwards & Magee report build returned null', edwardsMageeReport ? undefined : 'SECTION_UNAVAILABLE');
    } catch (e) {
      S('edwardsMageeModel', 'failed', errMessage(e), 'SECTION_UNAVAILABLE');
      log('⚠️ Edwards & Magee model report failed: ' + errMessage(e) + ' (does not affect Broker Model/Schabacker/main dashboard)');
    }
    let turtleReport: any = null;
    try {
      const t = now();
      log('🏗️ Building Turtle model report...');
      turtleReport = buildTurtleReport(ticker, ind as never, techPlan as never, analysisChart as never, log);
      log('  ⏱ Turtle model report: ' + fmt1(now() - t) + 's');
      await writeModelTab(MODEL_TABS.turtle, formatTurtleReport(turtleReport, parity ? {} : { plainText: true, timeZone: deps.timeZone }), MODEL_TAB_COLORS.turtle);
      S('turtleModel', turtleReport ? 'ok' : 'degraded', turtleReport ? '' : 'Turtle report build returned null', turtleReport ? undefined : 'SECTION_UNAVAILABLE');
    } catch (e) {
      S('turtleModel', 'failed', errMessage(e), 'SECTION_UNAVAILABLE');
      log('⚠️ Turtle model report failed: ' + errMessage(e) + ' (does not affect Broker Model/Schabacker/E&M/main dashboard)');
    }
    art.reports.schabacker = schabackerReport; art.reports.edwardsMagee = edwardsMageeReport; art.reports.turtle = turtleReport;

    // Comparison report -- built from whichever models succeeded.
    try {
      const anyModel = brokerModelReport || schabackerReport || edwardsMageeReport || turtleReport;
      if (anyModel) {
        const t = now();
        log('🏗️ Building comparison report...');
        const comparisonReport = buildComparisonReportV1(ticker, {
          techPlan, fundScore: fundResult, decision, newModelReport: brokerModelReport,
          schabackerReport, edwardsMageeReport, turtleReport,
        }, log);
        log('  ⏱ comparison report: ' + fmt1(now() - t) + 's');
        art.reports.comparison = comparisonReport;
        await writeModelTab(MODEL_TABS.comparison, formatComparisonReportV1(comparisonReport, ENGINE_VERSION), MODEL_TAB_COLORS.comparison);
        S('comparisonReport', comparisonReport ? 'ok' : 'degraded', comparisonReport ? '' : 'comparison report build returned null', comparisonReport ? undefined : 'SECTION_UNAVAILABLE');
      } else {
        S('comparisonReport', 'skipped', 'no model report succeeded — nothing to compare against the engine', 'NOT_RUN');
      }
    } catch (e) {
      S('comparisonReport', 'failed', errMessage(e), 'SECTION_UNAVAILABLE');
      log('⚠️ Comparison report failed: ' + errMessage(e) + ' (does not affect Broker Model/Schabacker/E&M/main dashboard)');
    }

    // FL-17b/17e: Wyckoff (original method), Trend 150 / 200, the 2-of-3 combo, Everything together, LILO, All Models and
    // the Options Decision -- display only, after every score and decision is final, from values the run already has.
    // Each page is guarded on its own. Not in legacy-parity mode (the oracle's call log).
    if (!parity) {
      const pageFailed = (what: string, e: unknown): void => {
        log('⚠️ ' + what + ' page failed: ' + errMessage(e) + ' (display only; nothing else is affected)');
        tech?.warning(what + ' page failed (display only)', { detail: errMessage(e) });
      };
      let extra: ExtraModelsReport | null = null;
      try {
        extra = buildExtraModelsReport(ticker, chart, art.reports.comparison ?? null, ind, deps.timeZone, { finalConviction: decision.finalConviction, timing: techPlan.timing },
          !parity && liveBarFraction(chart.dates, now()) != null ? 'price' : 'close');
      } catch (e) { pageFailed('Wyckoff / Trend model reads', e); }
      art.reports.extraModels = extra;
      try { await writeModelTab(MODEL_TABS.wyckoff, formatWyckoffPage(extra, ticker), MODEL_TAB_COLORS.wyckoff); } catch (e) { pageFailed('Wyckoff', e); }
      try { await writeModelTab(MODEL_TABS.trend, formatTrendPage(extra, ticker), MODEL_TAB_COLORS.trend); } catch (e) { pageFailed('Trend', e); }
      try { await writeModelTab(MODEL_TABS.combo, formatComboPage(extra, ticker), MODEL_TAB_COLORS.combo); } catch (e) { pageFailed('Combo', e); }
      const optionsRun = leapsCallArg != null || shortTermCallArg != null;
      let lilo: ReturnType<typeof buildLiloRead> | null = null;
      try {
        lilo = buildLiloRead(confluence, techPlan, decision);
        await writeModelTab(MODEL_TABS.lilo, formatLiloPage(ticker, lilo, { leapsCall: leapsCallArg, optionsRun, atBuyLimit: atLimit, nextResistance: nextRes, fixedT2 }), MODEL_TAB_COLORS.lilo);
      } catch (e) { pageFailed('LILO', e); }
      // James's models, phase 1: 🪜 James — LILO v2 and 💰 James — Profit-Taking, on the 10-year bars (G0b) when they come back
      let james: JamesReads | null = null;
      let long: FetchedChart | null = null;
      try {
        if (deps.fetchLongRangeBars) { const f = deps.fetchLongRangeBars; long = await orElseAsync(tech, '10-year bars fetch (James reads fall back to 2 years)', () => f(ticker), null); }
        const use10y = !!long && long.closes.length > 0;
        james = buildJamesReads(use10y ? long : chart, use10y ? '10y' : '2y', deps.timeZone);
        if (extra) { extra = { ...extra, james }; art.reports.extraModels = extra; }
      } catch (e) { pageFailed('James — LILO v2 / Profit-Taking reads', e); }
      try { await writeModelTab(MODEL_TABS.liloV2, james ? formatLiloV2Page(ticker, james.liloV2) : NO_JAMES, MODEL_TAB_COLORS.liloV2); } catch (e) { pageFailed('James — LILO v2', e); }
      try { await writeModelTab(MODEL_TABS.profitTaking, james ? formatProfitTakingPage(ticker, james.profitTaking) : NO_JAMES, MODEL_TAB_COLORS.profitTaking); } catch (e) { pageFailed('James — Profit-Taking', e); }
      // James's models, phase 2: ↩️ Mean Reversion, 🔁 Pair Rotation (the partner leg's chart, pair stocks only), 🏆 Winners & Layering (the paper test's rank)
      let james2: James2Reads | null = null;
      try {
        const bars: J2Bars = long && long.closes.length ? long : chart;
        const partners = new Map<string, J2Bars | null>();
        for (const [a, b] of pairsOf(ticker)) {
          const other = a === ticker ? b : a;
          if (!partners.has(other)) { const c: FetchedChart | null = await orElseAsync(tech, 'pair partner chart fetch', () => deps.fetchYahooChart(other), null, 'warning', { partner: other }); partners.set(other, c && c.closes.length ? c : null); }
        }
        let rank: WinnersRank | null = null;
        if (deps.winnersRank) { const w = deps.winnersRank; rank = await orElseAsync(tech, 'paper-test winners rank read', () => w(), null); }
        james2 = { meanRev: buildMeanRevRead(chart, deps.timeZone), pair: buildPairRead(ticker, chart, (t) => partners.get(t) ?? null, deps.timeZone), winners: buildWinnersRead(ticker, bars, rank) };
        if (extra) { extra = { ...extra, james2 }; art.reports.extraModels = extra; }
      } catch (e) { pageFailed('James — phase 2 reads', e); }
      try { await writeModelTab(MODEL_TABS.meanReversion, james2 ? formatMeanRevPage(ticker, james2.meanRev) : NO_JAMES, MODEL_TAB_COLORS.meanReversion); } catch (e) { pageFailed('James — Mean Reversion', e); }
      try { await writeModelTab(MODEL_TABS.pair, james2 ? formatPairPage(ticker, james2.pair) : NO_JAMES, MODEL_TAB_COLORS.pair); } catch (e) { pageFailed('James — Pair Rotation', e); }
      try { await writeModelTab(MODEL_TABS.winners, james2 ? formatWinnersPage(ticker, james2.winners) : NO_JAMES, MODEL_TAB_COLORS.winners); } catch (e) { pageFailed('James — Winners & Layering', e); }
      // James's models, phase 3: 🔄 Multi-Year Cycle (the 10-year bars, QQQ's 2-year chart, BTC-USD's 10-year bars) and 🪤 Market Maker Stages (the run's chart, as the Wyckoff page)
      let james3: James3Reads | null = null;
      let qqqChart: FetchedChart | null = null;
      try {
        const use10y = !!long && long.closes.length > 0;
        let btcBars: FetchedChart | null = null;
        qqqChart = await orElseAsync(tech, 'QQQ chart fetch (cycle read)', () => deps.fetchYahooChart('QQQ'), null);
        if (deps.fetchLongRangeBars) { const f = deps.fetchLongRangeBars; btcBars = await orElseAsync(tech, 'BTC-USD 10-year bars fetch (cycle read)', () => f('BTC-USD'), null); }
        const bars: J3Bars = use10y ? (long as FetchedChart) : chart;
        james3 = { cycle: buildCycleRead(bars, use10y ? '10y' : '2y', qqqChart && qqqChart.closes.length ? qqqChart : null, btcBars && btcBars.closes.length ? btcBars : null, deps.timeZone), mm: buildMmRead(chart, deps.timeZone) };
        if (extra) { extra = { ...extra, james3 }; art.reports.extraModels = extra; }
      } catch (e) { pageFailed('James — phase 3 reads', e); }
      try { await writeModelTab(MODEL_TABS.cycle, james3 ? formatCyclePage(ticker, james3.cycle) : NO_JAMES, MODEL_TAB_COLORS.cycle); } catch (e) { pageFailed('James — Multi-Year Cycle', e); }
      try { await writeModelTab(MODEL_TABS.marketMaker, james3 ? formatMmPage(ticker, james3.mm) : NO_JAMES, MODEL_TAB_COLORS.marketMaker); } catch (e) { pageFailed('James — Market Maker Stages', e); }
      // James's models, phase 4: 🎯 James — LEAPS and ⚖️ James — Option Fair Value (the run's chart, QQQ's chart fetched above, the chain the options run attached)
      let james4: James4Reads | null = null;
      try {
        const optsRun = leapsCallArg != null || shortTermCallArg != null, chainJ = jamesCallsOfPick(leapsCallArg);
        const today = formatDateInTz(new Date(now()), deps.timeZone, 'yyyy-MM-dd');
        const rate = orElse(tech, 'Fed funds rate lookup (4% used)', () => rateOn(today) || 0.04, 0.04);
        const leapsRead = buildJamesLeapsRead(chart, qqqChart && qqqChart.closes.length ? qqqChart : null, chainJ, now(), optsRun, deps.timeZone);
        james4 = { leaps: leapsRead, fair: buildFairValueRead(long && long.closes.length ? long : chart, leapsCallArg, shortTermCallArg, leapsRead, chainJ, now(), rate) };
        if (extra) { extra = { ...extra, james4 }; art.reports.extraModels = extra; }
      } catch (e) { pageFailed('James — phase 4 reads', e); }
      // James's models, phase 5: ✅ James — Quality Gate (the run's chart and merged fundamentals; display only)
      let james5: James5Reads | null = null;
      try {
        james5 = { quality: buildQualityRead(ticker, chart, fund as unknown as Record<string, unknown> | null, deps.timeZone) };
        if (extra) { extra = { ...extra, james5 }; art.reports.extraModels = extra; }
      } catch (e) { pageFailed('James — phase 5 reads', e); }
      try { await writeModelTab(MODEL_TABS.qualityGate, james5 ? formatQualityGatePage(ticker, james5.quality) : NO_JAMES, MODEL_TAB_COLORS.qualityGate); } catch (e) { pageFailed('James — Quality Gate', e); }
      try {
        const rows = allModelsRows({ decision, techPlan, fund: fundResult, comparison: art.reports.comparison ?? null, extra, lilo, james, james2, james3, james4, james5 });
        art.texts[MODEL_TABS.allModels] = formatAllModelsPage(ticker, rows);
        writeAllModelsSheet(getOrCreate(ss, MODEL_TABS.allModels), ticker, rows, MODEL_TAB_COLORS.allModels);
      } catch (e) { pageFailed('All Models', e); }
      try {
        await writeModelTab(MODEL_TABS.optionsDecision, formatOptionsDecisionPage({
          ticker, leapsCall: leapsCallArg, shortTermCall: shortTermCallArg, decision, techPlan, fund: fundResult, confluence, flow: optAnalysis,
          nowMs: now(), timeZone: deps.timeZone, atBuyLimit: atLimit, nextResistance: nextRes, fixedT2,
          chart: { dates: chart.dates, closes: chart.closes, currentPrice: chart.currentPrice }, liveBar: liveBarFraction(chart.dates, now()) != null,
          jamesLeaps: james4?.leaps ?? null,
        }), MODEL_TAB_COLORS.optionsDecision);
      } catch (e) { pageFailed('Options Decision', e); }
      try { await writeModelTab(MODEL_TABS.jamesLeaps, james4 ? formatJamesLeapsPage(ticker, james4.leaps) : NO_JAMES, MODEL_TAB_COLORS.jamesLeaps); } catch (e) { pageFailed('James — LEAPS', e); }
      try { await writeModelTab(MODEL_TABS.jamesFairValue, james4 ? formatFairValuePage(ticker, james4.fair) : NO_JAMES, MODEL_TAB_COLORS.jamesFairValue); } catch (e) { pageFailed('James — Option Fair Value', e); }
    }

    logDataStatusSummary(status, log);
    activateAnalysisTab(true);
    art.result = { fundResult, techPlan, decision };
    art.dataQuality = parity ? [] : dataQualityFromStatus(status, fetchItems, new Date(now()), PENDING_MEANS_NOT_RUN);
    tech?.info('analysis done', { ticker, ms: now() - t0, conviction: decision.finalConviction });
    return art;
  } catch (err) {
    // Top-level safety net: any unexpected failure still leaves a readable sheet.
    log('❌ v7 aborted: ' + errMessage(err));
    tech?.error('analysis aborted: ' + errMessage(err), { ticker, stack: (err as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
    logDataStatusSummary(status, log);
    try {
      await deps.render.failureSheet(ss, ticker, status, err);
      const sh = ss.getSheetByName(ANALYSIS_TAB);
      if (sh) sh.activate();
    } catch (e2) {
      log('❌ Could not render failure sheet: ' + errMessage(e2));
    }
    art.aborted = errMessage(err);
    art.dataQuality = parity ? [] : dataQualityFromStatus(status, fetchItems, new Date(now()));
    return art;
  }
}

/**
 * F-35: the market-context chart as the analysis functions' Chart. The
 * arrays are passed through untouched -- benchmarkCloses keeps legacy's
 * leading nulls (before SPY's first aligned date), which the indicator
 * code reads with the same truthiness checks legacy used; prevClose may be
 * undefined for a one-bar response, which nothing in the analysis reads.
 */
export function toAnalysisChart(chart: MarketContextChart): Chart {
  return chart as unknown as Chart;
}
