/**
 * compose(): builds the production dependency graph from the environment.
 * The only place that knows how the pieces are wired; every module below it
 * takes its dependencies as arguments. Every CLI entry (cli.ts analyze,
 * nightly.ts, ai.ts, ticker.ts, myOptions.ts) starts here.
 *
 *   storage 'memory'  -- no spreadsheet: every cache starts empty (or from
 *                        `initialTabs`) and the tabs live in memory.
 *   storage 'sheets'  -- the real spreadsheet (GOOGLE_SERVICE_ACCOUNT_JSON,
 *                        SPREADSHEET_ID): property store, tab store, price
 *                        caches and report workbooks, flushed at the end.
 *
 * Secrets come from the environment only (provider keys, GEMINI_API_KEY,
 * ANTHROPIC_API_KEY, the service account). SEC_CONTACT_EMAIL is used for the
 * SEC User-Agent and nothing else (F-50). The HTTP client is wrapped in the
 * tap (net/httpTap.ts) so every failed request reaches the technical log.
 *
 * SETTINGS (env; parity mode forces legacy for every one):
 *   FUND_FALLBACK_RULES=on         the user's saved-copy rule for fundamentals (default OFF until the
 *                                  score-input list is confirmed); FUND_FALLBACK_MAX_AGE_DAYS (30)
 *   FUND_SERIES_TAB=on             F-36 option B, series/peers in their own tab (default OFF, same reason)
 *   RS ranking                     F-57: read from its own tab ('💾 RS Ranking'), approved, always on
 *   options expiry labels          F-62: fixed (UTC) labels, approved, always on
 *   FINRA weeks                    F-55: calendar-week steps, approved, always on
 *   FMP_RESPONSE_CACHE=off         owner 2026-11-01: FMP fundamentals answers are kept 24 h per ticker in the
 *                                  property store (default ON; the golden replays set it off so their kv is unchanged)
 */

import type { Clock, RunContext } from './core/context.ts';
import { createContext } from './core/context.ts';
import { Logger, LogLevel, formatLine, registerRunLogger, type LogSink, textLog } from './core/logger.ts';
import { runLogSink } from './core/logFile.ts';
import { scriptTimeZone } from './core/dates.ts';
import { HttpClient, LiveTransport, type HttpTransport } from './net/http.ts';
import { TappingTransport } from './net/httpTap.ts';
import { secUserAgentsFromEnv, fetchSecEdgarCIK, fetchSharesOutstandingHistory, fetchSecFilingKeywordHits } from './fetch/sec/edgar.ts';
import { fetch13FCusip, fetchInstitutional13FHoldings } from './fetch/sec/thirteenF.ts';
import { fetchSpdrEtfTopHoldings, fetchQqqTopHoldings } from './fetch/etf/holdings.ts';
import { providerKeysFromEnv, providerKeyValues, type ProviderKeys } from './fetch/providerKeys.ts';
import { fetchYahooChart } from './fetch/chart.ts';
import { DirLongHistoryStore, longHistoryFromEnv, withLongHistory } from './storage/longHistory.ts';
import { fetchYahooChartLongRange, fetchYahooChartLongRangeBars, fetchYahooLongRangeWithBars } from './fetch/yahoo.ts';
import type { WinnersRank } from './analysis/jamesPhase2Pages.ts';
import { gatherFundamentalsV7, fetchPeerMetricsFor } from './fetch/fundamentals/v7.ts';
import { fetchEarningsCalendar, type FundamentalsDeps } from './fetch/fundamentals/providers.ts';
import { earningsSinceFromSavedCopy, type FundamentalsFallbackPolicy } from './fetch/fundamentals/resolve.ts';
import { getCachedMacroRegime, type MacroDeps, type MacroRegimeMemo, type MacroRegimeRead } from './fetch/macro/refresh.ts';
import { fetchGeminiReview, geminiKeyFromEnv } from './fetch/ai/geminiReview.ts';
import { claudeKeyFromEnv, type ClaudeSdk } from './ai/claudeReview.ts';
import { analyzeOpusReview, offResult, ANALYZE_OPUS_AI_OFF } from './ai/analyzeOpus.ts';
import {
  getTickerDarkPoolShare, getCachedEvaluativeIndex, getCachedRelativeStrengthRanking, type DarkPoolDeps, type RelativeStrengthRanking,
} from './analysis/darkPool.ts';
import { readBrokerDataCache, readMacroSnapshot } from './storage/macroCaches.ts';
import type { sheets_v4 } from 'googleapis';
import { MemoryPropertyStore, type PropertyStore } from './storage/kv.ts';
import { MemoryTabStore, type TabStore } from './storage/tabStore.ts';
import { MemoryPriceHistoryStore, type PriceHistoryStore } from './storage/priceHistory.ts';
import type { TabFormatter } from './sheets/formatOps.ts';
import type { RateLimiter } from './sheets/limiter.ts';
import { buildSheetsStorage } from './app/sheetsStorage.ts';
import { readRsRanking } from './storage/rsRankingTab.ts';
import { tabSeriesStore } from './storage/fundamentalsSeriesTab.ts';
import { ReportWorkbook, MemoryWorkbookBackend, type ReportSheet, type WorkbookBackend } from './sheets/reportSheet.ts';
import type { SheetsClient } from './sheets/client.ts';
import { dateStringInTz } from './analysis/macroRegime.ts';
import { buildBrokerCourseReportV1, type BrokerCourseReport } from './analysis/models/brokerCourse/report.ts';
import { buildDashboard } from './reports/dashboard/dashboard.ts';
import { writeTextReportToSheet, buildFailureSheet, type TextReportSheet } from './reports/text/textReports.ts';
import { OPTIONS_SNAPSHOT_SHEET } from './reports/options/tabs.ts';
import type { OptionsReportDeps } from './reports/options/run.ts';
import { TRANSACTIONS_SHEET } from './portfolio/transactions.ts';
import { BOTTOM_LINE_TAB } from './reports/bottomLine/summarySheet.ts';
import { PRICE_CHART_TAB } from './ops/priceChart.ts';
import { formatDateInTz, occExpiryText } from './core/dates.ts';
import type { FetchedChart } from './types/chart.ts';
import {
  runTickerAnalysisDetailed, ANALYSIS_TAB, MODEL_TABS, type TickerAnalysisDeps, type TickerArtifacts,
} from './analysis/runTicker.ts';
import type { RunLog } from './reports/runLog.ts';

export type StorageMode = 'memory' | 'sheets';

export interface ComposeOptions {
  readonly storage: StorageMode;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Tests: a replay or scripted transport instead of the network. */
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  /** Technical-log sink (the CLIs send it to stderr). */
  readonly logSink?: LogSink;
  readonly logLevel?: (typeof LogLevel)[keyof typeof LogLevel];
  /** Legacy exactly: one try per fetch, no data-quality box, legacy report text and caches (oracle comparisons). */
  readonly legacyParity?: boolean;
  /** Tests: no backoff waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Skip the Gemini call (the CLI's --no-ai; the nightly never calls AI, F-W11). */
  readonly noAi?: boolean;
  /**
   * Owner 2026-11-01: Analyze (one stock) only -- ask Claude Opus for a second opinion after Gemini (ai/analyzeOpus.ts).
   * Absent everywhere else (the nightly, AI Dispatch, the recordings). `sdk`: tests' fake (default: the real SDK).
   */
  readonly opus?: { readonly sdk?: ClaudeSdk };
  /** memory mode: the workbook's starting tabs (tests, dry runs). */
  readonly initialTabs?: Readonly<Record<string, readonly (readonly unknown[])[]>>;
  /** The run mode written into the RunContext (and the log scope). */
  readonly mode?: 'ticker' | 'nightly' | 'ai';
  /** Tests: a fake googleapis Sheets object for sheets mode (no service account). */
  readonly sheetsApi?: sheets_v4.Sheets;
  /** Tests: the shared Sheets limiter (default: 5 burst + 50 a minute). */
  readonly sheetsLimiter?: RateLimiter;
}

export interface Settings {
  readonly fundFallbackRules: boolean;
  readonly fundFallbackMaxAgeDays: number;
  readonly fundSeriesTab: boolean;
  readonly rsRankingTab: boolean;
  readonly legacyExpiryLabel: boolean;
  readonly calendarWeekSteps: boolean;
  readonly legacyReportText: boolean;
}

export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>, legacyParity: boolean): Settings {
  const on = (k: string): boolean => String(env[k] ?? '').trim().toLowerCase() === 'on';
  const n = Number(env.FUND_FALLBACK_MAX_AGE_DAYS);
  return {
    fundFallbackRules: !legacyParity && on('FUND_FALLBACK_RULES'),
    fundFallbackMaxAgeDays: Number.isFinite(n) && n > 0 ? n : 30,
    fundSeriesTab: !legacyParity && on('FUND_SERIES_TAB'),
    rsRankingTab: !legacyParity,
    legacyExpiryLabel: legacyParity,
    calendarWeekSteps: !legacyParity,
    legacyReportText: legacyParity,
  };
}

/**
 * The tabs a ticker run reads before it writes. F-84: the dashboard and model tabs too, so old merges are broken apart.
 * Phase 1: the fixed Bottom Line and Price Chart tabs too (same for every ticker).
 */
export const TICKER_RUN_PRELOAD: readonly string[] = ['🔬 Log', OPTIONS_SNAPSHOT_SHEET, TRANSACTIONS_SHEET, ANALYSIS_TAB, ...Object.values(MODEL_TABS), BOTTOM_LINE_TAB, PRICE_CHART_TAB];

/** writeTextReportToSheetV7's two extra calls on a ReportSheet: the grid row count and row insertion (Sheets grows the grid on write). */
export function asTextReportSheet(sh: ReportSheet): TextReportSheet {
  const s = sh as TextReportSheet;
  if (!('getMaxRows' in s)) {
    Object.assign(s, {
      getMaxRows: (): number => { try { return Math.max(1000, sh.getLastRow()); } catch { return 1000; } },
      insertRowsAfter: (): ReportSheet => sh,
    });
  }
  return s;
}

/**
 * The broker-course report's inputs resolver: the I/O buildBrokerCourseReportV1
 * did itself (brokerCourseModelV1.gs:1873-2149), in legacy's order, with its
 * timing log lines, then the pure builder.
 */
export interface BrokerResolverDeps {
  readonly http: HttpClient;
  readonly kv: PropertyStore;
  readonly tabStore: TabStore;
  readonly fmpKey: string;
  readonly clock: Clock;
  readonly fundamentals: FundamentalsDeps;
  readonly fetchChart: (t: string) => Promise<any>;
  /** Legacy-exact fetches (no dei shares fallback). */
  readonly legacyParity?: boolean;
}

export async function buildBrokerCourseReportResolved(
  d: BrokerResolverDeps, ticker: string, log: RunLog, chart: any, vixLevelIn: number | null, fund: any,
  cikIn: string | null | undefined, soIn: unknown, hitsIn: unknown,
): Promise<BrokerCourseReport | null> {
  const now = (): number => d.clock.now();
  const cik = cikIn !== undefined ? cikIn : await fetchSecEdgarCIK({ http: d.http, kv: d.kv, clock: d.clock }, ticker);
  const t13 = now();
  let holdings13F: any = null;
  try {
    const cusip = await fetch13FCusip({ http: d.http, kv: d.kv, fmpKey: d.fmpKey, clock: d.clock, fmp402Memory: !d.legacyParity }, ticker);
    holdings13F = cusip ? await fetchInstitutional13FHoldings({ http: d.http, kv: d.kv, store: d.tabStore, fmpKey: d.fmpKey, clock: d.clock }, cusip) : null;
  } catch { holdings13F = null; }
  log('  ⏱ institutional 13F fetch: ' + ((now() - t13) / 1000).toFixed(1) + 's');
  const so = soIn !== undefined ? soIn : await fetchSharesOutstandingHistory({ http: d.http }, cik, { deiFallback: !d.legacyParity });
  const hits = hitsIn !== undefined ? hitsIn
    : await fetchSecFilingKeywordHits({ http: d.http, clock: d.clock }, cik, formatDateInTz(new Date(now() - 365 * 86400000), 'UTC', 'yyyy-MM-dd'));
  let vixLevel = vixLevelIn;
  if (vixLevel == null) {
    const tV = now();
    const vixChart = await d.fetchChart('^VIX');
    log('  ⏱ VIX fetch (own, not reused): ' + ((now() - tV) / 1000).toFixed(1) + 's');
    vixLevel = vixChart ? vixChart.currentPrice : null;
  }
  const tE = now();
  const reused = !!(fund && fund._earningsHistory != null);
  const earningsHistory = reused ? fund._earningsHistory : ((await fetchEarningsCalendar(d.fundamentals, ticker, log)) || ({} as any)).history;
  log('  ⏱ earnings calendar (' + (reused ? 'reused' : 'own fetch') + '): ' + ((now() - tE) / 1000).toFixed(1) + 's');
  const brokerDataCache = await readBrokerDataCache(d.tabStore, ticker, now());
  const macroSnapshot = await readMacroSnapshot(d.tabStore, now());
  const spdrHoldings = ticker ? await fetchSpdrEtfTopHoldings({ http: d.http }, ticker) : null;
  const qqqHoldings = (!spdrHoldings && ticker === 'QQQ') ? await fetchQqqTopHoldings({ http: d.http, kv: d.kv, clock: d.clock }, ticker) : null;
  return buildBrokerCourseReportV1(ticker, {
    chart, fund, vixLevel, sharesOutstandingHistory: so as any, filingKeywordHits: hits as any, holdings13F, earningsHistory,
    brokerDataCache: brokerDataCache as any, macroSnapshot: macroSnapshot as any, spdrHoldings: spdrHoldings as any, qqqHoldings: qqqHoldings as any, now: new Date(now()),
  }, log);
}

/** Everything a CLI entry needs, built once per process. */
export interface Services {
  readonly opts: ComposeOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settings: Settings;
  readonly ctx: RunContext;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly http: HttpClient;
  readonly tap: TappingTransport;
  readonly keys: ProviderKeys;
  readonly geminiKey: string;
  readonly claudeKey: string;
  readonly kv: PropertyStore;
  readonly tabStore: TabStore;
  readonly priceStore: PriceHistoryStore;
  /** sheets mode only: My Portfolio (SPREADSHEET_ID). */
  readonly sheets: SheetsClient | null;
  /** sheets mode with routing on (three spreadsheets): the reports and data spreadsheets; null otherwise. */
  readonly reportsSheets?: SheetsClient | null;
  readonly dataSheets?: SheetsClient | null;
  /** sheets mode: formatting of TabStore tabs, on the spreadsheet that holds each one. */
  readonly tabFormatter?: TabFormatter | null;
  readonly backend: WorkbookBackend;
  /** A fresh view of the workbook (memory mode: every tab; sheets mode: the named tabs loaded). */
  openWorkbook(preload?: readonly string[]): Promise<ReportWorkbook>;
  fetchChart(ticker: string): Promise<FetchedChart | null>;
  readonly fundDeps: FundamentalsDeps;
  readonly macroDeps: MacroDeps;
  getMacro(): Promise<MacroRegimeRead>;
  readonly darkPoolDeps: DarkPoolDeps;
  readRsRanking(ticker: string): Promise<RelativeStrengthRanking | null>;
  optionsDeps(workbook: ReportWorkbook): OptionsReportDeps;
  /** The property store (sheets mode). Report workbooks are flushed by whoever opened them. */
  flushStores(): Promise<void>;
  /** Every secret value in play, for the report-text gate. */
  readonly secrets: readonly string[];
}

export async function composeServices(opts: ComposeOptions): Promise<Services> {
  const env = opts.env ?? process.env;
  const parity = !!opts.legacyParity;
  const settings = settingsFromEnv(env, parity);
  const timeZone = scriptTimeZone(env);
  const clock = opts.clock ?? { now: () => Date.now() };
  const mode = opts.mode ?? 'ticker';
  const keys = providerKeysFromEnv(env);
  const geminiKey = geminiKeyFromEnv(env);
  const claudeKey = claudeKeyFromEnv(env);
  // The run's full log (every level, DEBUG included) when the workflow sets RUN_LOG_FILE (core/logFile.ts).
  const fullSink = runLogSink(env, [...providerKeyValues(keys), geminiKey, claudeKey].filter(Boolean));
  const logger = new Logger({ minLevel: opts.logLevel ?? LogLevel.INFO, sink: opts.logSink, scope: mode, now: () => new Date(clock.now()), ...(fullSink ? { fullSink } : {}) });
  registerRunLogger(logger);
  const ctx = createContext({ mode, logger, clock, sleep: opts.sleep });
  const tap = new TappingTransport(opts.transport ?? new LiveTransport(), { log: ctx.log.child('http'), now: () => clock.now() });
  const http = new HttpClient({ transport: tap, userAgentByHost: secUserAgentsFromEnv(env) });

  let kv: PropertyStore, tabStore: TabStore, priceStore: PriceHistoryStore, backend: WorkbookBackend;
  let sheets: SheetsClient | null = null;
  let reportsSheets: SheetsClient | null = null, dataSheets: SheetsClient | null = null;
  let tabFormatter: TabFormatter | null = null;
  let flushStores: () => Promise<void> = async () => {};
  if (opts.storage === 'sheets') {
    // One spreadsheet, or three once My Portfolio carries the migration flag (app/sheetsStorage.ts; the startup
    // guard may refuse or pause the run there, before anything is written).
    const st = await buildSheetsStorage(ctx, env, timeZone, { now: () => clock.now(), ...(opts.sheetsApi ? { api: opts.sheetsApi } : {}), ...(opts.sheetsLimiter ? { limiter: opts.sheetsLimiter } : {}) });
    sheets = st.sheets; reportsSheets = st.reportsSheets; dataSheets = st.dataSheets; tabFormatter = st.tabFormatter;
    kv = st.kv; tabStore = st.tabStore; priceStore = st.priceStore; backend = st.backend;
    flushStores = () => st.flushStores();
  } else {
    kv = new MemoryPropertyStore();
    tabStore = new MemoryTabStore();
    priceStore = new MemoryPriceHistoryStore();
    backend = new MemoryWorkbookBackend((opts.initialTabs ?? {}) as never);
  }
  const openWorkbook = (preload: readonly string[] = TICKER_RUN_PRELOAD): Promise<ReportWorkbook> =>
    ReportWorkbook.open(backend, opts.storage === 'sheets' ? preload : ['*']);

  // C2: the FMP free-plan handling (known 402s skipped for 7 days, Finnhub earnings date, no insider call, FMP answers kept 24 h -- owner 2026-11-01); parity keeps legacy.
  const fmpResponseCache = !parity && String(env.FMP_RESPONSE_CACHE ?? '').trim().toLowerCase() !== 'off';
  const fundDeps: FundamentalsDeps = { http, keys, timeZone, clock, withCompanyName: !parity, ...(parity ? {} : { fmpFreePlan: { kv, earningsMemo: new Map(), responseCache: fmpResponseCache } }) };
  const fetchCachedChart = (t: string) => fetchYahooChart({ http, store: priceStore, clock, legacyFreshness: parity, legacySplitMerge: parity }, t);
  // docs/LONG_HISTORY_PLAN.md: OFF by default (LONG_HISTORY=on; never in parity). On, the long files' older bars go in front of the cache.
  const longHistory = longHistoryFromEnv(env);
  const fetchChart = longHistory.on && !parity
    ? withLongHistory(fetchCachedChart, new DirLongHistoryStore(longHistory.dir), textLog(ctx.log))
    : fetchCachedChart;
  const macroMemo: MacroRegimeMemo = { value: null };
  const macroDeps: MacroDeps = {
    http, store: tabStore, kv, fmpKey: keys.fmp, timeZone, clock, log: (m) => textLog(ctx.log)(String(m)), legacyFreshness: parity, plainText: !parity,
    getEvaluativeIndex: () => getCachedEvaluativeIndex({ kv, clock }),
    // C4: /analyze (mode 'ticker') fetches stale regime ETFs live, without saving them; the nightly writes the caches.
    liveWhenStale: !parity && mode === 'ticker',
    fmpResponseCache,
    fmp402Memory: !parity,
  };
  const getMacro = () => getCachedMacroRegime(macroDeps, macroMemo);
  // F-55 fixed by default (calendar-week steps); parity mode keeps legacy's day arithmetic.
  const darkPoolDeps: DarkPoolDeps = { http, timeZone, clock, kv, fetchChart, calendarWeekSteps: settings.calendarWeekSteps, log: textLog(ctx.log) };
  const readRs = async (t: string): Promise<RelativeStrengthRanking | null> =>
    (settings.rsRankingTab ? readRsRanking(tabStore, t, clock.now()) : getCachedRelativeStrengthRanking({ kv, clock }, t));
  const optionsDeps = (workbook: ReportWorkbook): OptionsReportDeps => ({
    http, memo: new Map() as never, kv, timeZone, clock, workbook, legacyExpiryLabel: settings.legacyExpiryLabel, legacyReportText: settings.legacyReportText,
    fetchNextEarnings: async (t, log) => ((await fetchEarningsCalendar(fundDeps, t, log ?? undefined)) || ({} as { next?: null })).next ?? null,
    log: textLog(ctx.log),
  } as OptionsReportDeps);

  return {
    opts, env, settings, ctx, clock, timeZone, http, tap, keys, geminiKey, claudeKey, kv, tabStore, priceStore, sheets, reportsSheets, dataSheets, tabFormatter, backend,
    openWorkbook, fetchChart, fundDeps, macroDeps, getMacro, darkPoolDeps, readRsRanking: readRs, optionsDeps, flushStores,
    secrets: [...providerKeyValues(keys), geminiKey, claudeKey].filter(Boolean),
  };
}

const marketLineMemo = new WeakMap<Services, Promise<string | null>>();
/** Options sentiment part B: the last stored market options line (🌐 Market Options Read), read once per run; null when none. */
export function latestMarketOptionsLine(s: Services): Promise<string | null> {
  let p = marketLineMemo.get(s);
  if (!p) {
    // Imported lazily (like paperJob below): the tab module reaches the paper modules, which would close an import cycle.
    p = Promise.all([import('./storage/optionsReadsTab.ts'), import('./analysis/options/marketRead.ts')])
      .then(async ([tab, mr]) => mr.marketReadLine((await tab.readMarketOptions(s.tabStore)).latest)).catch(() => null);
    marketLineMemo.set(s, p);
  }
  return p;
}

/** Never called: analyzeOpusReview returns before any call when the key is empty. */
const NO_KEY_SDK: ClaudeSdk = { create: async () => { throw new Error('ANTHROPIC_API_KEY is not set'); } };

/** The production TickerAnalysisDeps over one workbook (the CLI's real one, or a nightly scratch workbook). */
export function tickerDeps(s: Services, ss: ReportWorkbook, over: { readonly noAi?: boolean } = {}): TickerAnalysisDeps {
  const { http, kv, tabStore, keys, clock, timeZone, ctx, fundDeps, settings } = s;
  const parity = !!s.opts.legacyParity;
  const noAi = over.noAi ?? !!s.opts.noAi;
  // A2: the expiry's own (UTC) date; parity runs keep legacy's New York date.
  const nyExpiry = parity
    ? (expUnix: unknown): string => dateStringInTz(new Date((expUnix as number) * 1000), 'America/New_York')
    : occExpiryText;
  const fallback: FundamentalsFallbackPolicy | null = settings.fundFallbackRules
    ? { maxAgeDays: settings.fundFallbackMaxAgeDays, earningsSince: earningsSinceFromSavedCopy }
    : null;
  let lastLongBars: { ticker: string; bars: FetchedChart | null } | null = null;
  let winnersRankP: Promise<WinnersRank | null> | null = null;
  const detailLog = (ticker: string) => (l: string): void => ctx.log.child(ticker).debug(l);
  return {
    ss, timeZone, clock, ctx, tap: s.tap, legacyParity: parity,
    fetchYahooChart: (t) => s.fetchChart(t),
    // Parity: the closes-only fetch exactly as legacy. Otherwise the same single request also keeps its dated bars
    // for James's display-only pages (G0b), so they add no HTTP call; only the last ticker's bars are kept.
    fetchLongRangeCloses: parity ? (t) => fetchYahooChartLongRange(http, t)
      : async (t) => { const r = await fetchYahooLongRangeWithBars(http, t); lastLongBars = { ticker: t, bars: r.bars }; return r.closes; },
    fetchLongRangeBars: async (t) => (lastLongBars && lastLongBars.ticker === t ? lastLongBars.bars : fetchYahooChartLongRangeBars(http, t)),
    // James — Winners & Layering (phase 2): the list ranking the nightly paper test stored, read once per run (never in parity)
    ...(parity ? {} : { winnersRank: () => (winnersRankP ??= import('./paper/paperJob.ts').then((m) => m.loadPaper(tabStore)).then((p) => p?.state.lab?.winnersRank ?? null).catch(() => null)) }),
    gatherFundamentals: (t, log) => gatherFundamentalsV7(fundDeps, t, log, { usPeersOnly: !parity }),
    fundamentalsStore: kv,
    fundamentalsFallback: fallback,
    stampFundamentalsFetchedAt: !parity,
    fundamentalsSeriesStore: settings.fundSeriesTab ? tabSeriesStore(tabStore) : null,
    fetchPeerMetrics: (syms) => fetchPeerMetricsFor({ http, keys, store: kv, clock }, syms),
    getTickerDarkPoolShare: (t, chart, log) => getTickerDarkPoolShare(s.darkPoolDeps, t, chart, log),
    getCachedMacroRegime: () => s.getMacro() as never,
    readBrokerDataCache: (t) => readBrokerDataCache(tabStore, t, clock.now()),
    fetchSecEdgarCIK: (t) => fetchSecEdgarCIK({ http, kv, clock }, t),
    fetchSharesOutstandingHistory: (cik) => fetchSharesOutstandingHistory({ http }, cik, { deiFallback: !parity }),
    fetchSecFilingKeywordHits: (cik, since) => fetchSecFilingKeywordHits({ http, clock }, cik, since),
    getCachedRelativeStrengthRanking: (t) => s.readRsRanking(t),
    fetchGeminiReview: async (a, log) => (noAi ? null : fetchGeminiReview({ http, apiKey: s.geminiKey, getMacroRegime: () => s.getMacro() as never, formatExpiry: nyExpiry, plainLabels: !parity, log, ...(parity ? {} : { marketOptionsLine: () => latestMarketOptionsLine(s) }) }, a as never)),
    aiUnavailable: noAi || !s.geminiKey,
    ...(s.opts.opus && !parity ? {
      fetchOpusReview: async (a: unknown, geminiText: string | null) => (noAi ? offResult(ANALYZE_OPUS_AI_OFF) : analyzeOpusReview({
        ctx, apiKey: s.claudeKey, sdk: s.opts.opus?.sdk ?? (s.claudeKey ? (await import('./ai/claudeSdk.ts')).createAnthropicSdk(s.claudeKey) : NO_KEY_SDK), getMacroRegime: () => s.getMacro() as never, formatExpiry: nyExpiry, plainLabels: true,
      }, a as never, geminiText)),
    } : {}),
    buildBrokerCourseReport: (ticker, log, chart, vix, fund, cik, so, hits) =>
      buildBrokerCourseReportResolved({ http, kv, tabStore, fmpKey: keys.fmp, clock, fundamentals: fundDeps, fetchChart: (t) => s.fetchChart(t), legacyParity: parity }, ticker, log, chart, vix, fund, cik, so, hits),
    render: {
      dashboard: async (a) => buildDashboard(a.ss, a.ticker, a.chart, a.ind, a.gann, a.confluence, a.fundResult, a.techPlan, a.decision, a.fund, a.optAnalysis, a.fundSource,
        a.aiReview, a.status, a.ladderStock, a.ladderOptions, a.leapsCall, a.shortTermCall, a.institutional13F, a.shortInterestData, {
          nowMs: clock.now(), timeZone,
          readBrokerData: (t) => readBrokerDataCache(tabStore, t, clock.now()),
          fetch13FCusip: (t) => fetch13FCusip({ http, kv, fmpKey: keys.fmp, clock, fmp402Memory: !parity }, t),
          fetchInstitutional13FHoldings: (cusip) => fetchInstitutional13FHoldings({ http, kv, store: tabStore, fmpKey: keys.fmp, clock }, cusip),
          legacyReportText: settings.legacyReportText,
          onReportDetail: detailLog(a.ticker),
          dataQuality: a.dataQuality,
          ...(a.opusReview ? { opusReview: a.opusReview } : {}),
          ...(parity ? {} : { marketOptionsLine: await latestMarketOptionsLine(s) }),
        }),
      failureSheet: (wb, ticker, status, err) => buildFailureSheet(wb, ticker, status as never, err, { nowMs: clock.now(), timeZone }, { legacyReportText: settings.legacyReportText, onDetail: detailLog(ticker) }),
      textReport: (sh, text, color) => writeTextReportToSheet(asTextReportSheet(sh), text, color),
    },
  };
}

export interface Composition extends Services {
  /** The single-ticker run's workbook (TICKER_RUN_PRELOAD loaded). */
  readonly workbook: ReportWorkbook;
  readonly deps: TickerAnalysisDeps;
  /** runAnalysisV7(ticker, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg). */
  analyze(ticker: string, ladderStock?: boolean, ladderOptions?: boolean, leapsCall?: unknown, shortTermCall?: unknown): Promise<TickerArtifacts>;
  /** Writes the workbook and the property store back (sheets mode); a no-op in memory mode. */
  flush(): Promise<void>;
}

export async function compose(opts: ComposeOptions): Promise<Composition> {
  const s = await composeServices(opts);
  const workbook = await s.openWorkbook(TICKER_RUN_PRELOAD);
  const deps = tickerDeps(s, workbook);
  return {
    ...s, workbook, deps,
    analyze: (ticker, ls, lo, leaps, short) => runTickerAnalysisDetailed(deps, ticker, ls, lo, leaps, short),
    flush: async () => { if (opts.storage === 'sheets') { await workbook.flush(); await s.flushStores(); } else { await workbook.flush(); } },
  };
}

export { ANALYSIS_TAB, MODEL_TABS, formatLine };
