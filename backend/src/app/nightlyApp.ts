/**
 * The nightly composition (`npm run nightly`): the real step wiring for
 * runNightly (src/jobs/nightly/nightly.ts, order in steps.ts).
 *
 *   darkPool.*        THROWING variants of the three dark-pool handlers (F-N1): the legacy
 *                     handlers swallow every error, which would make runStep's retries and the
 *                     run summary blind. Same computations, same caches.
 *                     relativeStrength writes the F-57 tab ('💾 RS Ranking').
 *   macro.refresh     refreshMacroRegimeCache + refreshMacroSnapshot (each logs its own failures).
 *   analysis.tickers  portfolio holdings then watchlist; per ticker the broker-course data cache is
 *                     refreshed first (F-N6; inside the run-wide cache, so the paper list's tickers too), then ONE full analysis, memoised for the run (F3) and
 *                     projected for Buy and Exit. Each ticker renders into its own scratch workbook
 *                     (F-N9): concurrent tickers must not interleave writes on the shared dashboard /
 *                     model / Log tabs; the nightly's report tabs are the Buy and Exit reports.
 *                     Two attempts per ticker (F-N8); a retried attempt re-runs, it does not wait on
 *                     the timed-out one.
 *   analysis.summary  Decision History only if the policy names this step (the Watchlist Summary tab is no
 *                     longer written, owner 2026-11-04).
 *   buy.report        the Buy pipeline -> Buy sheet (the default single Decision History writer).
 *   exit.report       the Exit pipeline -> Exit sheet, with J's options fixed-lookback read and the
 *                     bull-phase advisory.
 *   fundamentals.history  (requirement K) after the analysis: each analysed ticker's fundamentals, 13F holder count
 *                     and short-interest data, appended to 💾 Fundamentals History when a value changed. Reuses
 *                     the memoised analyses (no provider call); Sheet runs only; never fails the night.
 *   options.chains    (options sentiment plan A-1, P0, part B) before the analysis: every nightly stock's Cboe chain, the
 *                     paper list, SPY and QQQ, once each, into ONE run-wide memo that paper.trade reuses; the per-stock
 *                     reads (A-2), the A-5 gate and the market read. options.reads (after the Exit report) stores them.
 *                     Profile `options.applied` (OPTIONS_READ_APPLIED, P2 go-live, default off): each stock is scored
 *                     with its own gated read (optionsSeedFor) and also with options off (the 📈 row, the Buy report
 *                     line, Decision History, the paper twin). Off = shadow (A-8): each analysis computes its "if applied"
 *                     numbers; the decisions use the options snapshot exactly as before.
 * The nightly makes no AI call (F-W11). One portfolio reader: the Portfolio sheet (F8).
 */

import { textLog } from '../core/logger.ts';
import type { RunContext } from '../core/context.ts';
import type { Services } from '../compose.ts';
import { tickerDeps } from '../compose.ts';
import { runTickerAnalysisDetailed, toAnalysisChart } from '../analysis/runTicker.ts';
import { createAnalysisCache, type AnalysisCache } from './analysisCache.ts';
import { runPaperNight } from '../paper/paperJob.ts';
import { runLiveDryRun } from '../live/liveJob.ts';
import { liveConfigFromEnv } from '../live/liveConfig.ts';
import { fetchYahooChartLongRangeBars, fetchYahooChartRaw } from '../fetch/yahoo.ts';
import { findChrome, htmlToPdf } from '../reports/pdf/chromePdf.ts';
import { toPortfolioSummary } from './portfolio.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../sheets/reportSheet.ts';
import { OPTIONS_SNAPSHOT_SHEET } from '../reports/options/tabs.ts';
import { TRANSACTIONS_SHEET } from '../portfolio/transactions.ts';
import { Tabs } from '../sheets/tabs.ts';
import { SheetTabFormatter } from '../sheets/formatOps.ts';
import { cacheSet } from '../storage/kv.ts';
import { writeRsRankingTab } from '../storage/rsRankingTab.ts';
import {
  buildDarkPoolTrackerReport, computeEvaluativeIndex, computeRelativeStrengthRanking, darkPoolUniverse, relativeStrengthMissKind,
  EVALUATIVE_INDEX_KEY, RELATIVE_STRENGTH_KEY, DARK_POOL_CACHE_TTL_HOURS, type RelativeStrengthRanking,
} from '../analysis/darkPool.ts';
import { writeDarkPoolTrackerSheet } from '../sheets/writers/darkPoolTracker.ts';
import { refreshMacroRegimeCache, refreshMacroSnapshot, refreshBrokerCourseDataCache } from '../fetch/macro/refresh.ts';
import { parsePortfolio, readPortfolio, type PortfolioResult } from '../sheets/readers/portfolio.ts';
import { parseWatchlistRows, readWatchlist } from '../sheets/readers/watchlist.ts';
import { appendDecisionHistory, DECISION_HISTORY_SHEET } from '../stores/decisionHistory.ts';
import { watchlistDecisionRows, type HistoryPolicy } from '../jobs/history/historyPolicy.ts';
import { buyReportJob } from '../jobs/buy/buyReportStep.ts';
import { workbookHistory } from '../jobs/buy/buyPipeline.ts';
import { BUY_SHEET_TAB } from '../reports/buySheet/text.ts';
import { exitReportJob } from '../jobs/exit/exitReportStep.ts';
import { EXIT_SHEET_TAB } from '../reports/exitSheet/exitSheet.ts';
import { EXIT_TARGET_HISTORY_SHEET } from '../stores/exitTargetHistory.ts';
import { computePortfolioBullPhaseAdvisory } from '../reports/exit/exitReport.ts';
import { computeOptionsPositionExitReadFixedLookback } from '../portfolio/positions/optionsFixedLookback.ts';
import { computeIndicators } from '../analysis/indicators/index.ts';
import type { Chart } from '../types/chart.ts';
import type { NightlyDeps, NightlyOptions, AnalysedTicker, JobOutcome } from '../jobs/nightly/nightly.ts';
import type { SheetRow } from '../sheets/coerce.ts';
import type { DigestCapture } from '../reports/digest/nightlyDigest.ts';
import type { CboeFetchStats, CboeRawMemo } from '../fetch/cboe.ts';
import { activeProfile } from '../profile/active.ts';
import { PAPER_OWNER_LIST } from '../paper/paperLab.ts';
import { OPTIONS_READ_APPLIED, seedOptionsWorkbook, shadowLine } from '../analysis/options/nightlyRead.ts';
import { runFundamentalsHistoryNight } from '../storage/fundamentalsHistory.ts';
import { formatDateInTz } from '../core/dates.ts';
import { orElseAsync } from '../core/guard.ts';
import { dataBranchDir, readLedgerJson } from '../ledger/store.ts';
import { toPortfolio } from '../ledger/toPortfolio.ts';
import { LEDGER_FILES } from '../ledger/schema.ts';
import type { LedgerMode } from '../profile/schema.ts';
import { measuresOfNight, optionsRunReport, recordOptionsNight, runOptionsChains, shadowInputOf, type OptionsNight } from '../jobs/options/optionsNight.ts';

export interface NightlyAppOptions {
  readonly tickerTimeoutMs?: number;
  readonly tickerAttempts?: number;
  readonly concurrency?: number;
  readonly historyPolicy?: HistoryPolicy;
  readonly skip?: NightlyOptions['skip'];
}

export interface NightlyApp {
  readonly deps: NightlyDeps;
  readonly options: NightlyOptions;
  readonly cache: AnalysisCache;
  readonly portfolio: PortfolioResult;
  readonly watchlist: readonly string[];
  /** Row 29: what the Buy and Exit steps built tonight, for the Telegram digest (empty until they run). */
  readonly digest: DigestCapture;
}

const NIGHTLY_TICKER_TIMEOUT_MS = 10 * 60_000;

/**
 * The Portfolio sheet (sheets: one batchGet; memory: the workbook's own tab). Profile `storage.ledger` 'on'
 * (docs/LEDGER.md): the ledger's holdings.json on the data branch folder instead; the sheet is not read for holdings.
 */
export async function loadPortfolio(s: Services, ledger: LedgerMode = activeProfile().storage.ledger): Promise<PortfolioResult> {
  if (ledger === 'on') {
    const root = dataBranchDir(s.env);
    const h = readLedgerJson(root, 'holdings');
    if (!h) throw new Error('Ledger (storage.ledger on): no ' + LEDGER_FILES.holdings + ' in the data branch folder (' + root + ')');
    const p = toPortfolio(h);
    s.ctx.log.info('Portfolio (ledger): ' + p.stocks.length + ' stock holding(s), ' + p.options.length + ' option position(s)', { skippedCrypto: p.skippedCrypto.length });
    return p;
  }
  if (s.sheets) {
    const r = await readPortfolio(s.ctx, s.sheets);
    if (!r.ok) throw new Error('Portfolio sheet: ' + String(r.error.detail));
    return r.value;
  }
  const wb = await s.openWorkbook([Tabs.PORTFOLIO]);
  return parsePortfolio((wb.getSheetByName(Tabs.PORTFOLIO)?.grid() ?? []) as unknown as SheetRow[]);
}

export async function loadWatchlist(s: Services): Promise<{ tickers: string[]; seeded: boolean }> {
  if (s.sheets) {
    const r = await readWatchlist(s.ctx, s.sheets);
    if (!r.ok) throw new Error('Watchlist sheet: ' + String(r.error.detail));
    return r.value;
  }
  const wb = await s.openWorkbook([Tabs.WATCHLIST]);
  return { tickers: parseWatchlistRows((wb.getSheetByName(Tabs.WATCHLIST)?.grid() ?? []) as unknown as SheetRow[]), seeded: false };
}

/**
 * A per-ticker scratch workbook, seeded with the two tabs a ticker run reads (options snapshot, transactions).
 * `override` replaces seeded tabs for one ticker (options sentiment A-4 at go-live: that ticker's own _OPTIONS_SNAPSHOT).
 */
export async function scratchFactory(s: Services): Promise<(override?: Record<string, unknown[][]> | null) => Promise<ReportWorkbook>> {
  const real = await s.openWorkbook([OPTIONS_SNAPSHOT_SHEET, TRANSACTIONS_SHEET]);
  const seed: Record<string, unknown[][]> = {};
  for (const t of [OPTIONS_SNAPSHOT_SHEET, TRANSACTIONS_SHEET]) {
    const sh = real.getSheetByName(t);
    if (sh) seed[t] = sh.grid();
  }
  return (override) => ReportWorkbook.open(new MemoryWorkbookBackend(structuredClone({ ...seed, ...(override ?? {}) }) as never), ['*']);
}

/**
 * A-4 (go-live, profile `options.applied` = OPTIONS_READ_APPLIED): every nightly stock's scratch is seeded with its OWN
 * gated read as its _OPTIONS_SNAPSHOT. A stock without a fresh read (none, or older
 * than 2 trading days, A-5) gets an EMPTY snapshot: options are not applied to it (never another stock's shared one).
 * Shadow phase, or no options night (a memory run): null, the scratch keeps the shared snapshot exactly as before.
 */
export async function optionsSeedFor(night: Pick<OptionsNight, 'gated'> | null, ticker: string, applied = OPTIONS_READ_APPLIED): Promise<Record<string, unknown[][]> | null> {
  if (!applied || !night) return null;
  const g = night.gated.get(ticker.toUpperCase());
  const wb = g && g.fresh && g.read ? await seedOptionsWorkbook(g.read) : null;
  const sh = wb?.getSheetByName(OPTIONS_SNAPSHOT_SHEET);
  return { [OPTIONS_SNAPSHOT_SHEET]: sh ? sh.grid() as unknown[][] : [] };
}

export async function buildNightlyApp(s: Services, o: NightlyAppOptions = {}): Promise<NightlyApp> {
  const ctx: RunContext = s.ctx;
  const log = textLog(ctx.log);
  const portfolio = await loadPortfolio(s);
  const summary = toPortfolioSummary(portfolio);
  const wl = await loadWatchlist(s);
  const scratch = await scratchFactory(s);
  // Options sentiment A-1: one Cboe memo for the whole run (options.chains fills it, paper.trade reads it).
  const cboeMemo: CboeRawMemo = new Map();
  const cboeStats: CboeFetchStats = new Map();
  let night: OptionsNight | null = null;
  const cache = createAnalysisCache(async (t) => {
    // F-N6, fix 2026-11-05: the broker-course data cache (short interest, interest coverage) is refreshed before EVERY
    // analysis of the run -- the portfolio and watchlist tickers AND the ones only paper.trade analyses (the paper list),
    // which used to read an empty cache every night. A fresh row is left alone; FMP's 24 h response cache and the
    // remembered 402 keep it to at most one FMP call per ticker per day.
    await refreshBrokerCourseDataCache(s.macroDeps, t, log);
    return runTickerAnalysisDetailed({
      ...tickerDeps(s, await scratch(await optionsSeedFor(night, t)), { noAi: true }),
      // The scratch workbooks share one _OPTIONS_SNAPSHOT (one ticker's): another ticker's snapshot is expected here.
      optionsSnapshotShared: true,
      // Shadow: the "if applied" numbers. Applied (P2): tonight's gated read (read day, the note when none is applied).
      ...(OPTIONS_READ_APPLIED
        ? { optionsMeasures: (x: string) => measuresOfNight(night, x), optionsGated: (x: string) => night?.gated.get(x.toUpperCase()) ?? (night ? { read: null, source: 'none' as const, ageTradingDays: null, fresh: false, note: 'No options read for ' + x.toUpperCase() + ' tonight' } : null) }
        : { optionsShadow: (x: string) => shadowInputOf(night, x) }),
    }, t);
  });
  const attempts = new Map<string, number>();
  // Three spreadsheets: the formatter writes on the sheet that holds each tab (the Dark Pool Tracker -> reports).
  const formatter = s.tabFormatter ?? (s.sheets ? new SheetTabFormatter(ctx, s.sheets) : undefined);
  const dp = s.darkPoolDeps;
  const getChart = async (t: string): Promise<Chart | null> => { const c = await s.fetchChart(t); return c ? toAnalysisChart(c as never) : null; };
  const digest: DigestCapture = {};

  const jobs: NightlyDeps['jobs'] = {
    // F-N1: the same computations as jobs/darkPool.ts, without the swallowing try/catch.
    'darkPool.tracker': async () => {
      const report = await buildDarkPoolTrackerReport(dp, log);
      await writeDarkPoolTrackerSheet({ store: s.tabStore, formatter, timeZone: s.timeZone }, report);
      log('dark pool tracker written: Tier1 week ' + (report.t1Week || 'n/a') + ', Tier2 week ' + (report.t2Week || 'n/a'));
    },
    'darkPool.evaluativeIndex': async () => {
      const r = await computeEvaluativeIndex(dp);
      if (r.pctStrong == null) throw new Error('Evaluative Index: no basket ticker had enough history (' + r.unavailable + ' unavailable)');
      await cacheSet(s.kv, EVALUATIVE_INDEX_KEY, r, DARK_POOL_CACHE_TTL_HOURS, s.clock.now());
      log('evaluative index cached: ' + r.pctStrong.toFixed(1) + '% strong');
    },
    'darkPool.relativeStrength': async (): Promise<JobOutcome> => {
      const tickers = darkPoolUniverse();
      const map: Record<string, RelativeStrengthRanking> = {};
      const shortHistory: string[] = [];
      const missing: string[] = [];
      // 5 Nov: a miss is re-read raw (the cached fetch hides a short chart as null): a new listing is an expected skip.
      const raw = { fetchChart: (t: string) => fetchYahooChartRaw(s.http, t, '2y') };
      for (const t of tickers) {
        const r = await computeRelativeStrengthRanking(dp, t);
        if (r) map[t] = r;
        else if ((await relativeStrengthMissKind(raw, t)) === 'SHORT_HISTORY') shortHistory.push(t);
        else missing.push(t);
      }
      const n = Object.keys(map).length;
      if (n === 0) throw new Error('relative strength: no ticker could be ranked');
      if (s.settings.rsRankingTab) await writeRsRankingTab(s.tabStore, map, new Date(s.clock.now()));
      else await cacheSet(s.kv, RELATIVE_STRENGTH_KEY, map, DARK_POOL_CACHE_TTL_HOURS, s.clock.now());
      log('relative strength ranked ' + n + '/' + tickers.length);
      return relativeStrengthOutcome(n, tickers.length, shortHistory, missing);
    },
    'macro.refresh': async () => {
      const once = { ...s.macroDeps, gdpOnce: {} }; // Sheets cleanup 4b: GDPC1 fetched once for both
      await refreshMacroRegimeCache(once);
      await refreshMacroSnapshot(once, log);
    },
    // Options sentiment A-1 / P0 / part B: never fails the night for a missing chain.
    'options.chains': async () => {
      // Like the paper test: only against the real Sheet (its tabs are append-only history; a memory dry run stores nothing).
      if (!s.sheets) { log('options reads: skipped (no Sheet in this run)'); return { state: 'ok' }; }
      const stocks = [...summary.positions.map((p) => p.ticker), ...wl.tickers];
      night = await runOptionsChains(
        { cboe: { http: s.http, memo: cboeMemo, stats: cboeStats }, store: s.tabStore, kv: s.kv, timeZone: s.timeZone, now: () => s.clock.now(), log, fetchChart: (t) => s.fetchChart(t) },
        stocks, activeProfile().features.paper ? PAPER_OWNER_LIST : [],
      );
      return { state: 'ok' };
    },
    'options.reads': async () => {
      if (!night) { log('options reads: no option chains were read in this run; nothing stored'); return { state: 'ok' }; }
      log(await recordOptionsNight({ store: s.tabStore, kv: s.kv, now: () => s.clock.now(), log, timeZone: s.timeZone }, night,
        async (t) => (attempts.has(t) ? ((await cache.get(t)).optionsShadow ?? null) : null)));
      return { state: 'ok' };
    },
    'buy.report': buyReportJob({
      ctx,
      pipeline: (ss) => ({
        ctx,
        readTickers: () => ({ tickers: wl.tickers, seeded: wl.seeded }),
        analyze: (t) => cache.buy(t),
        readPortfolio: () => summary,
        history: workbookHistory(ss),
      }),
      openWorkbook: () => s.openWorkbook([BUY_SHEET_TAB, DECISION_HISTORY_SHEET]),
      // The analysis is memoised: a second attempt would read the same result.
      options: { tickerAttempts: 1, ...(o.historyPolicy ? { historyPolicy: o.historyPolicy } : {}) },
      onBuilt: (input, result, wb) => { digest.buy = { input, result, sheet: wb.getSheetByName(BUY_SHEET_TAB) }; },
      // Options sentiment A-8 / A-7 / part B: display lines only; the candidates, tiers and order are untouched.
      decorate: async (input) => {
        const lines: string[] = [];
        for (const c of input.candidates) {
          const sh = attempts.has(c.ticker) ? await cache.get(c.ticker).then((a) => a.optionsShadow ?? null).catch((e: unknown) => { ctx.log.child(c.ticker).warning('buy report: options shadow line left out (the analysis did not settle)', { detail: String(e) }); return null; }) : null;
          if (sh) lines.push(shadowLine(sh, OPTIONS_READ_APPLIED));
        }
        const rep = optionsRunReport(night);
        return {
          ...input,
          ...(lines.length ? { optionsReads: { lines, missing: rep ? rep.missing : [], applied: OPTIONS_READ_APPLIED } } : {}),
          ...(night?.marketLine ? { marketOptionsLine: night.marketLine } : {}),
        };
      },
    }),
    // Requirement K (backlog row 39): tonight's analysed fundamentals -> 💾 Fundamentals History, only the changed ones.
    // Reuses each memoised analysis (no provider call). Never fails the night.
    'fundamentals.history': async (): Promise<JobOutcome> => {
      // Like the paper test: only against the real Sheet (an append-only history; a memory dry run stores nothing).
      if (!s.sheets) { log('fundamentals history: skipped (no Sheet in this run)'); return { state: 'ok' }; }
      return runFundamentalsHistoryNight({
        store: s.tabStore, day: formatDateInTz(new Date(s.clock.now()), s.timeZone), tickers: [...attempts.keys()], log,
        analysis: (t) => settledWithin(cache.get(t), 5_000), // a timed-out ticker's memo may never settle
      });
    },
    // The 1-year forward paper test (owner, 2026-10-27): one closed day per night, from this run's analyses.
    'paper.trade': async () => {
      // Only against the real Sheet: a memory dry run must not start or advance the test.
      if (!s.sheets) { log('paper test: skipped (no Sheet in this run)'); return; }
      const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
      log(await runPaperNight({
        store: s.tabStore, timeZone: s.timeZone, watchlist: wl.tickers, fetchChart: (t) => s.fetchChart(t), analysis: (t) => cache.get(t), log,
        telegram: token && chatId ? { deps: { token }, chatId } : null,
        cboe: { http: s.http, memo: cboeMemo },
        fetchLongBars: (t) => fetchYahooChartLongRangeBars(s.http, t),
        toPdf: (() => { const chrome = findChrome(); return chrome ? (html: string, pdf: string) => htmlToPdf(html, pdf, chrome) : null; })(),
      }));
    },
    // The live broker bot, phase 1 (docs/live-broker): tonight's plan for the real $1,000 account, no broker. Never throws.
    'live.dryRun': async () => {
      if (!s.sheets) { log('live bot: skipped (no Sheet in this run)'); return; }
      const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
      // docs/LOGGING_SPEC.md: a failed dry run is an ERROR line in the live.dryRun scope (raw text in detail), never INFO.
      const line = await orElseAsync(ctx.log.child('live.dryRun'), 'live bot dry run (nothing is traded in this phase)', () => runLiveDryRun({
        store: s.tabStore, timeZone: s.timeZone, fetchChart: (t) => s.fetchChart(t), log, logReport: (m) => ctx.log.child('live.dryRun').info(m), now: () => s.clock.now(),
        config: liveConfigFromEnv(process.env), telegram: token && chatId ? { deps: { token }, chatId } : null,
      }), null, 'error');
      if (line === null) return { state: 'degraded', reason: 'The live bot dry run failed tonight; nothing is traded in this phase (no broker is connected).' };
      log(line);
      return { state: 'ok' };
    },
    'exit.report': exitReportJob({
      ctx,
      pipeline: {
        portfolio,
        getChart: (_c, t) => getChart(t),
        getAnalysis: (_c, t) => cache.exit(t),
        // The option's price per share today, from the row's "current market value" (My Options writes
        // mid x 100 x contracts there); the same unit as "avg price - Premium paid". For the gain and tax lines.
        getOptionPremium: async (_c, h) => optionPricePerShare(h),
        analyzers: {
          optionsFixedLookback: (t, strike, expiryStr, prem, chart, opts) =>
            computeOptionsPositionExitReadFixedLookback(t, strike, expiryStr, prem as number, chart, undefined, s.clock.now(), opts) as never,
        },
      },
      // Owner 2026-11-05: the weekly-stop exit rules, behind the profile flag exit.weeklyStops (default off).
      ...(activeProfile().exit.weeklyStops ? { options: { weeklyStops: true } } : {}),
      openWorkbook: () => s.openWorkbook([EXIT_SHEET_TAB, EXIT_TARGET_HISTORY_SHEET]),
      onBuilt: (input, _r, wb) => { digest.exit = { input, sheet: wb.getSheetByName(EXIT_SHEET_TAB) }; },
      decorate: (input) => (night?.marketLine ? { ...input, marketOptionsLine: night.marketLine } : input),
      loadAdvisory: async () => computePortfolioBullPhaseAdvisory(
        portfolio.stocks.map((h) => ({ ticker: h.ticker, shares: h.shares })), getChart,
        { getMacroRegime: () => s.getMacro() as never, getRelativeStrength: (t) => s.readRsRanking(t), computeIndicators: (c) => computeIndicators(c) },
      ),
    }),
  };

  const afterAnalysis = async (rows: readonly AnalysedTicker[], opts?: { readonly writeDecisionHistory: boolean }): Promise<void> => {
    // Owner 2026-11-04 (backlog row 39): the '🎯 Watchlist Summary' tab is no longer written (unused; the Buy report covers it).
    if (!opts?.writeDecisionHistory) return;
    const ss = await s.openWorkbook([DECISION_HISTORY_SHEET]);
    for (const r of watchlistDecisionRows(rows)) {
      // Options sentiment A-6 (applied runs only): the appended options cells of the memoised analysis.
      const opt = OPTIONS_READ_APPLIED && attempts.has(r.ticker) ? ((await settledWithin(cache.get(r.ticker), 5_000))?.optionsHistory ?? null) : null;
      appendDecisionHistory(ss, r.ticker, r.result.fundResult, r.result.techPlan, r.result.decision!, s.clock.now(), opt);
    }
    await ss.flush();
  };

  const deps: NightlyDeps = {
    ctx,
    jobs,
    readPortfolio: () => summary,
    readWatchlist: () => wl.tickers,
    runAnalysis: async (t) => {
      const n = (attempts.get(t) ?? 0) + 1;
      attempts.set(t, n);
      if (n > 1) cache.forget(t); // F-N8: a retry after a timeout runs again instead of waiting on the hung attempt
      return cache.daily(t); // F-N6: the cache runner refreshes the broker-course data cache first
    },
    afterAnalysis,
    optionsReport: () => optionsRunReport(night),
    ...(o.historyPolicy ? { historyPolicy: o.historyPolicy } : {}),
  };
  const options: NightlyOptions = {
    tickerAttempts: o.tickerAttempts ?? 2,
    tickerTimeoutMs: o.tickerTimeoutMs ?? NIGHTLY_TICKER_TIMEOUT_MS,
    ...(o.concurrency ? { concurrency: o.concurrency } : {}),
    ...(o.skip ? { skip: o.skip } : {}),
  };
  return { deps, options, cache, portfolio, watchlist: wl.tickers, digest };
}

/** The promise's value when it settles within `ms`; null when it rejects or is still pending. */
export async function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); });
  try { return await Promise.race([p.catch(() => null), late]); } finally { clearTimeout(timer); }
}

/**
 * 5 Nov: the relative-strength step's outcome. A ticker with too little price history (a new listing) is an expected
 * gap: the step stays ok and the run-summary line names it. Only a real miss (no usable chart) makes it degraded.
 */
export function relativeStrengthOutcome(ranked: number, total: number, shortHistory: readonly string[], missing: readonly string[]): JobOutcome {
  const skipped = shortHistory.length ? shortHistory.length + ' skipped, too little history: ' + shortHistory.join(', ') : '';
  if (missing.length) {
    return { state: 'degraded', reason: 'The relative-strength ranking was refreshed for ' + ranked + ' of ' + total + ' stocks; '
      + missing.length + ' had no usable price data: ' + missing.join(', ') + (skipped ? '; ' + skipped : '') + '.' };
  }
  return skipped ? { state: 'ok', reason: 'Ranked ' + ranked + ' of ' + total + ' stocks; ' + skipped + '.' } : { state: 'ok' };
}

/** Current market value of the row / (100 x contracts); null when either is missing or not positive. */
export function optionPricePerShare(h: { readonly currentValue?: number | null; readonly contracts: number | null }): number | null {
  const v = h.currentValue, n = h.contracts;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && typeof n === 'number' && n > 0 ? v / (100 * n) : null;
}
