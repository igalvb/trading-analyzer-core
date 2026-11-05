/**
 * The macro / broker-data refresh layer -- the nightly fetches, their
 * caches, and the cache-only reads the analysis uses. Ported exactly from
 * dataLayerV1.gs:
 *   fetchHistoricalOHLCV_MacroBatch   :1776-1819
 *   computeMacroSupplementalV1_       :1821-1854
 *   refreshMacroRegimeCacheV1         :1856-1894
 *   getCachedMacroSupplementalV1_     :1896-1904
 *   getCachedDowTheoryConfirmationV1_ :1906-1908
 *   fetchFMPInterestCoverageV1        :1499-1508
 *   refreshBrokerCourseDataCacheV1_   :1510-1538
 *   refreshMacroSnapshotV1_           :1540-1557
 * and from fullStockAnalysisV10_9.gs getCachedMacroRegime_ (:3127-3165),
 * plus the two manual diagnostics of macro_fetchers_v0_15.gs
 * (testMacroFetchers :298-381, testMacroRegimePredictiveValue :454-484).
 *
 * Deliberate differences, all disclosed:
 *  - Freshness of the macro price caches uses the completed-session rule
 *    (F-30) unless `legacyFreshness` is set -- the same rule the user
 *    approved for the price cache, applied here too (confirm, F-43).
 *  - UrlFetchApp.fetchAll becomes concurrent requests through the HTTP
 *    limiter; if any request throws, legacy's sequential fallback runs, as
 *    in legacy (the fallback's log names the first failing request).
 *  - getCachedMacroRegime_'s per-execution cache (`_macroRegimeCache`)
 *    becomes an explicit memo object owned by the run.
 *  - installMacroRegimeCacheTriggerV1 (:276-285) is not code here: the
 *    schedule belongs to the workflow that runs the nightly job.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../../storage/kv.ts';
import { isPriceCacheFresh, isPriceCacheFreshForSession } from '../../storage/priceHistory.ts';
import type { TabStore } from '../../storage/tabStore.ts';
import {
  readMacroPriceCache, writeMacroPriceCache, readMacroSnapshot, writeMacroSnapshot, readBrokerDataCache, writeBrokerDataCache,
  type MacroSeries,
} from '../../storage/macroCaches.ts';
import { businessCyclePhaseReadV1 } from '../../analysis/models/brokerCourse/screens.ts';
import {
  alignSeries, classifyMacroRegimeAt, computeDowTheoryConfirmation, macroRegimePredictiveValue, dateStringInTz,
  MACRO_REGIME_TICKERS, MACRO_REGIME_LOOKBACK, DOW_THEORY_TICKERS, type MacroRegime, type DowTheoryConfirmation,
} from '../../analysis/macroRegime.ts';
import { fetchFredSeriesValues, fetchFredSeriesMacro, fetchM2Macro, FRED_CSV_URL, type MacroLog } from './fred.ts';
import { readFmpCache, writeFmpCache, isKnownFmp402, noteFmp402 } from '../fundamentals/providers.ts';
import { fetchNasdaqShortInterestV1, fetchHistoricalOHLCV, nasdaqHistoricalUrl, parseNasdaqHistorical, NASDAQ_HEADERS } from './nasdaq.ts';

export interface MacroDeps {
  readonly http: HttpClient;
  readonly store: TabStore;
  readonly kv: PropertyStore;
  /** For fetchFMPInterestCoverage; injected, never hard-coded. */
  readonly fmpKey: string;
  /** The script's zone (Date#toDateString in alignSeries and the diagnostics). */
  readonly timeZone: string;
  readonly clock?: Clock;
  /** Logger.log. */
  readonly log?: MacroLog;
  /** Legacy freshness (last bar UTC-dated today or yesterday). Default false: the completed-session rule. */
  readonly legacyFreshness?: boolean;
  /** getCachedEvaluativeIndexV1_ (dark pool, FL-5). Absent: null, as when legacy's typeof guard failed. */
  readonly getEvaluativeIndex?: () => Promise<unknown>;
  /**
   * Sheets cleanup phase 4b: one GDPC1 request per night. Legacy fetches FRED's GDPC1 CSV twice, once for the
   * business-cycle phase (computeMacroSupplemental) and once for the Macro Snapshot (refreshMacroSnapshot).
   * When this memo is present both read the same response, each with its own legacy parsing and error rule,
   * so the values are unchanged. Absent (every parity test): two requests, as legacy. Created per run.
   */
  readonly gdpOnce?: GdpFetchMemo;
  /** A3: the broker-data log line names each source's real reason (402 plan / no data / HTTP n). Unset = legacy's text. */
  readonly plainText?: boolean;
  /**
   * C4 (fix plan 2026-10-30): getCachedMacroRegime fetches the STALE regime ETFs live (the same Nasdaq request
   * as the nightly batch), classifies from memory and writes nothing back. Set for /analyze only (mode 'ticker',
   * not legacy parity); the nightly, which owns the caches, keeps the cache-only read. Ignored with legacyFreshness.
   */
  readonly liveWhenStale?: boolean;
  /** Owner 2026-11-01: fetchFMPInterestCoverage shares fetchFMPFundamentals' 24 h ratios-ttm cache in `kv`. Unset = legacy. */
  readonly fmpResponseCache?: boolean;
  /**
   * Fix 2026-11-04: honour (and record) the remembered FMP 402s in `kv` (fundamentals/providers.ts FMP_402_TTL_MS):
   * a ratios-ttm 402 seen within 7 days by any caller is not asked again, and the skip is logged at INFO. Unset = legacy.
   */
  readonly fmp402Memory?: boolean;
}

/** C4: the source label of a regime classified from a live fetch because a saved copy was stale. */
export const MACRO_LIVE_SOURCE = 'live (cache stale)';

/** The run's single GDPC1 response (or its failure), shared by the two readers. */
export interface GdpFetchMemo {
  response?: Promise<HttpResponse>;
}

export const GDP_SERIES_ID = 'GDPC1';

/** deps.http, except that the GDPC1 request is sent once per memo and its response shared. */
function gdpHttp(deps: MacroDeps): HttpClient {
  const memo = deps.gdpOnce;
  if (!memo) return deps.http;
  return {
    fetch: (req: HttpRequest): Promise<HttpResponse> => {
      if (req.url !== FRED_CSV_URL + GDP_SERIES_ID) return deps.http.fetch(req);
      memo.response ??= deps.http.fetch(req);
      return memo.response;
    },
  } as unknown as HttpClient;
}

const nowOf = (d: Pick<MacroDeps, 'clock'>): number => (d.clock ? d.clock.now() : Date.now());
const logOf = (d: MacroDeps): MacroLog => d.log ?? ((): void => {});
const errMsg = (e: any): unknown => (e && e.message ? e.message : e);

function isFresh(deps: MacroDeps, cached: MacroSeries | null): boolean {
  const now = new Date(nowOf(deps));
  // Only `.dates` is read; a MacroSeries is a valid argument.
  const c = cached as unknown as Parameters<typeof isPriceCacheFresh>[0];
  return deps.legacyFreshness ? isPriceCacheFresh(c, now) : isPriceCacheFreshForSession(c, now);
}

export const MACRO_SUPPLEMENTAL_KEY = 'macroSupplementalV1';
export const DOW_THEORY_KEY = 'dowTheoryConfirmationV1';
/** refreshMacroRegimeCacheV1: TTL of both PropertiesService entries, hours. */
export const MACRO_CACHE_TTL_HOURS = 30;

/** fetchHistoricalOHLCV_MacroBatch (dataLayerV1.gs:1776-1819): fresh caches are used, the rest fetched and cached. */
export async function fetchHistoricalOHLCVBatch(deps: MacroDeps, tickers: readonly string[]): Promise<Record<string, MacroSeries | null>> {
  const log = logOf(deps);
  const out: Record<string, MacroSeries | null> = {};
  if (!tickers || !tickers.length) return out;
  const needFetch: string[] = [];
  for (const t of tickers) {
    const cached = await readMacroPriceCache(deps.store, t);
    if (isFresh(deps, cached)) out[t] = cached;
    else needFetch.push(t);
  }
  if (!needFetch.length) return out;
  const settled = await Promise.allSettled(needFetch.map((t) => deps.http.fetch({ url: nasdaqHistoricalUrl(t), headers: NASDAQ_HEADERS, muteHttpExceptions: true })));
  const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
  if (!failed) {
    for (let i = 0; i < needFetch.length; i++) {
      const t = needFetch[i];
      try {
        const res = (settled[i] as PromiseFulfilledResult<Awaited<ReturnType<HttpClient['fetch']>>>).value;
        out[t] = parseNasdaqHistorical(t, res.status, res.text(), log);
        if (out[t]) await writeMacroPriceCache(deps.store, t, out[t] as MacroSeries);
      } catch (e) {
        log('Batch parse exception for ' + t + ': ' + (e as Error).message);
        out[t] = null;
      }
    }
  } else {
    log('fetchAll exception, falling back to sequential fetch: ' + (failed.reason as Error).message);
    for (const t of needFetch) {
      out[t] = await fetchHistoricalOHLCV(deps.http, t, log);
      if (out[t]) await writeMacroPriceCache(deps.store, t, out[t] as MacroSeries);
    }
  }
  return out;
}

export interface MacroSupplemental {
  m2YoyGrowthPct: number | null;
  m2AsOfDate: string | null;
  yieldCurveSpread: number | null;
  yieldCurveInverted: boolean | null;
  yieldCurveAsOfDate: string | null;
  businessCyclePhase: ReturnType<typeof businessCyclePhaseReadV1> | null;
}

/** computeMacroSupplementalV1_ (dataLayerV1.gs:1821-1854): M2 YoY, the 10y-2y spread, the GDP business-cycle phase. */
export async function computeMacroSupplemental(deps: MacroDeps): Promise<MacroSupplemental> {
  const log = logOf(deps);
  const out: MacroSupplemental = { m2YoyGrowthPct: null, m2AsOfDate: null, yieldCurveSpread: null, yieldCurveInverted: null, yieldCurveAsOfDate: null, businessCyclePhase: null };
  try {
    const m2 = await fetchM2Macro(deps.http, log);
    if (m2 && m2.values.length >= 13) {
      const latest = m2.values[m2.values.length - 1], yearAgo = m2.values[m2.values.length - 13];
      if (yearAgo) { out.m2YoyGrowthPct = (latest / yearAgo - 1) * 100; out.m2AsOfDate = m2.dates[m2.dates.length - 1]; }
    }
  } catch (e) { log('computeMacroSupplementalV1_: M2 fetch failed (non-fatal): ' + errMsg(e)); }
  try {
    const yc = await fetchFredSeriesMacro(deps.http, 'T10Y2Y', log);
    if (yc && yc.values.length) {
      out.yieldCurveSpread = yc.values[yc.values.length - 1];
      out.yieldCurveInverted = out.yieldCurveSpread < 0;
      out.yieldCurveAsOfDate = yc.dates[yc.dates.length - 1];
    }
  } catch (e) { log('computeMacroSupplementalV1_: yield-curve fetch failed (non-fatal): ' + errMsg(e)); }
  try {
    const gdp = await fetchFredSeriesMacro(gdpHttp(deps), GDP_SERIES_ID, log);
    if (gdp && gdp.values.length >= 3) {
      const cycle = businessCyclePhaseReadV1(gdp.values);
      if (cycle) out.businessCyclePhase = cycle;
    }
  } catch (e) { log('computeMacroSupplementalV1_: GDP fetch failed (non-fatal): ' + errMsg(e)); }
  return out;
}

/** computeDowTheoryConfirmationV1_'s cache reads (macro_fetchers_v0_15.gs:241). */
export async function computeDowTheoryFromCache(deps: MacroDeps): Promise<DowTheoryConfirmation> {
  const dia = await readMacroPriceCache(deps.store, 'DIA');
  const iyt = await readMacroPriceCache(deps.store, 'IYT');
  return computeDowTheoryConfirmation(dia, iyt);
}

async function countFresh(deps: MacroDeps, tickers: readonly string[]): Promise<number> {
  let n = 0;
  for (const t of tickers) if (isFresh(deps, await readMacroPriceCache(deps.store, t))) n++;
  return n;
}

/** refreshMacroRegimeCacheV1 (dataLayerV1.gs:1856-1894): the nightly macro refresh. Never throws. */
export async function refreshMacroRegimeCache(deps: MacroDeps): Promise<void> {
  const log = logOf(deps);
  try {
    const before = await countFresh(deps, MACRO_REGIME_TICKERS);
    await fetchHistoricalOHLCVBatch(deps, MACRO_REGIME_TICKERS);
    const after = await countFresh(deps, MACRO_REGIME_TICKERS);
    log('refreshMacroRegimeCacheV1: ' + before + '/9 already fresh, ' + after + '/9 fresh after refresh.');
  } catch (e) {
    log('refreshMacroRegimeCacheV1 failed (non-fatal, interactive path degrades gracefully): ' + errMsg(e));
  }
  try {
    const supplemental = await computeMacroSupplemental(deps);
    await cacheSet(deps.kv, MACRO_SUPPLEMENTAL_KEY, supplemental, MACRO_CACHE_TTL_HOURS, nowOf(deps));
    log('refreshMacroRegimeCacheV1: supplemental cached -- M2 YoY ' + (supplemental.m2YoyGrowthPct != null ? supplemental.m2YoyGrowthPct.toFixed(1) + '%' : 'n/a') + ', yield curve ' + (supplemental.yieldCurveSpread != null ? supplemental.yieldCurveSpread.toFixed(2) : 'n/a'));
  } catch (e) {
    log('refreshMacroRegimeCacheV1: supplemental cache failed (non-fatal): ' + errMsg(e));
  }
  try {
    const before = await countFresh(deps, DOW_THEORY_TICKERS);
    await fetchHistoricalOHLCVBatch(deps, DOW_THEORY_TICKERS);
    const after = await countFresh(deps, DOW_THEORY_TICKERS);
    const dowTheory = await computeDowTheoryFromCache(deps);
    await cacheSet(deps.kv, DOW_THEORY_KEY, dowTheory, MACRO_CACHE_TTL_HOURS, nowOf(deps));
    log('refreshMacroRegimeCacheV1: Dow Theory ' + before + '/2 already fresh, ' + after + '/2 fresh after refresh -- verdict: ' + (dowTheory.verdict || 'n/a'));
  } catch (e) {
    log('refreshMacroRegimeCacheV1: Dow Theory fetch/cache failed (non-fatal): ' + errMsg(e));
  }
}

/** getCachedMacroSupplementalV1_ (dataLayerV1.gs:1896-1904). JSON round trip: dates are strings. */
export async function getCachedMacroSupplemental(deps: MacroDeps): Promise<unknown> {
  return cacheGet(deps.kv, MACRO_SUPPLEMENTAL_KEY, nowOf(deps));
}

/** getCachedDowTheoryConfirmationV1_ (dataLayerV1.gs:1906-1908). JSON round trip: dates are strings. */
export async function getCachedDowTheoryConfirmation(deps: MacroDeps): Promise<unknown> {
  return cacheGet(deps.kv, DOW_THEORY_KEY, nowOf(deps));
}

export interface MacroRegimeRead {
  readonly regime?: MacroRegime;
  readonly available: boolean;
  readonly supplemental: unknown;
  readonly dowTheory: unknown;
  readonly evaluativeIndex: unknown;
  /** C4: MACRO_LIVE_SOURCE when the regime was classified from a live fetch (a saved copy was stale). Absent = the saved copies. */
  readonly source?: string;
}

/** getCachedMacroRegime_'s `_macroRegimeCache` (fullStockAnalysisV10_9.gs:3088), owned by the run. */
export interface MacroRegimeMemo {
  value: MacroRegimeRead | null;
}

/**
 * getCachedMacroRegime_ (fullStockAnalysisV10_9.gs:3127-3165): cache-only.
 * Any of the 9 caches stale or missing makes the regime unavailable; the
 * supplemental, Dow Theory and evaluative-index reads ride along on every
 * exit. Computed once per memo.
 */
export async function getCachedMacroRegime(deps: MacroDeps, memo: MacroRegimeMemo = { value: null }): Promise<MacroRegimeRead> {
  if (memo.value !== null) return memo.value;
  const log = logOf(deps);
  const t0 = nowOf(deps);
  const supplemental = await getCachedMacroSupplemental(deps);
  const dowTheory = await getCachedDowTheoryConfirmation(deps);
  const evaluativeIndex = deps.getEvaluativeIndex ? await deps.getEvaluativeIndex() : null;
  const live = !!deps.liveWhenStale && !deps.legacyFreshness;
  let fetchedLive: string[] = [];
  try {
    const seriesMap: Record<string, MacroSeries> = {};
    const stale: string[] = [];
    for (const t of MACRO_REGIME_TICKERS) {
      const cached = await readMacroPriceCache(deps.store, t);
      if (!isFresh(deps, cached)) {
        if (live) { stale.push(t); continue; }
        memo.value = { available: false, supplemental, dowTheory, evaluativeIndex };
        log('  ⏱ getCachedMacroRegime_: ' + ((nowOf(deps) - t0) / 1000).toFixed(1) + 's (unavailable -- ' + t + ' cache stale/missing, not fetched live -- see refreshMacroRegimeCacheV1)');
        return memo.value;
      }
      seriesMap[t] = cached as MacroSeries;
    }
    if (stale.length) {
      // C4: fetch only the stale ETFs, in memory; the saved copies stay as they are (the nightly writes them).
      const fetched = await fetchMacroSeriesLive(deps, stale);
      const missing = stale.filter((t) => !fetched[t]);
      if (missing.length) {
        memo.value = { available: false, supplemental, dowTheory, evaluativeIndex };
        log('  ⏱ getCachedMacroRegime_: ' + ((nowOf(deps) - t0) / 1000).toFixed(1) + 's (unavailable -- ' + stale.join(', ') + ' cache stale/missing; the live fetch failed for ' + missing.join(', ') + ')');
        return memo.value;
      }
      for (const t of stale) seriesMap[t] = fetched[t] as MacroSeries;
      fetchedLive = stale;
    }
    const aligned = alignSeries(seriesMap, deps.timeZone);
    const latestIdx = aligned._dates.length - 1;
    const regime = classifyMacroRegimeAt(aligned, latestIdx, MACRO_REGIME_LOOKBACK);
    memo.value = regime
      ? { regime, available: true, supplemental, dowTheory, evaluativeIndex, ...(fetchedLive.length ? { source: MACRO_LIVE_SOURCE } : {}) }
      : { available: false, supplemental, dowTheory, evaluativeIndex };
  } catch {
    memo.value = { available: false, supplemental, dowTheory, evaluativeIndex };
  }
  log('  ⏱ getCachedMacroRegime_: ' + ((nowOf(deps) - t0) / 1000).toFixed(1) + 's ' + (fetchedLive.length
    ? '(' + MACRO_LIVE_SOURCE + ': ' + fetchedLive.join(', ') + ' fetched live, not saved)'
    : '(cache-only, no network call)'));
  return memo.value;
}

/**
 * C4: the nightly batch's Nasdaq requests (fetchHistoricalOHLCVBatch: concurrent, sequential fallback if one
 * throws) for `tickers`, WITHOUT reading or writing the saved copies. A ticker that fails is null.
 */
export async function fetchMacroSeriesLive(deps: MacroDeps, tickers: readonly string[]): Promise<Record<string, MacroSeries | null>> {
  const log = logOf(deps);
  const out: Record<string, MacroSeries | null> = {};
  const settled = await Promise.allSettled(tickers.map((t) => deps.http.fetch({ url: nasdaqHistoricalUrl(t), headers: NASDAQ_HEADERS, muteHttpExceptions: true })));
  const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    const s = settled[i];
    try {
      if (!failed) {
        const res = (s as PromiseFulfilledResult<HttpResponse>).value;
        out[t] = parseNasdaqHistorical(t, res.status, res.text(), log);
      } else {
        out[t] = await fetchHistoricalOHLCV(deps.http, t, log);
      }
    } catch (e) {
      log('Live macro fetch failed for ' + t + ': ' + errMsg(e));
      out[t] = null;
    }
  }
  return out;
}

/** fetchFMPInterestCoverageV1 (dataLayerV1.gs:1499-1508). */
export async function fetchFMPInterestCoverage(
  deps: Pick<MacroDeps, 'http' | 'fmpKey'> & Partial<Pick<MacroDeps, 'kv' | 'clock' | 'fmpResponseCache' | 'fmp402Memory' | 'log'>>, ticker: string, why?: (reason: string) => void,
): Promise<number | null> {
  try {
    // Owner 2026-11-01: the same 24 h ratios-ttm cache as fetchFMPFundamentals (one FMP call per ticker per day for both).
    const cacheKv = deps.fmpResponseCache && deps.kv ? deps.kv : null;
    if (cacheKv) {
      const hit = await readFmpCache(cacheKv, 'ratios-ttm', ticker, nowOf(deps));
      if (hit) {
        if (deps.log) deps.log('  FMP [ratios-ttm] from the 24 h cache for ' + ticker + ' (1 FMP call saved)');
        const v = hit.v && hit.v.interestCoverageRatioTTM;
        if (v == null) { if (why) why('no data'); return null; }
        return v as number;
      }
    }
    const memoKv = deps.fmp402Memory && deps.kv ? deps.kv : null;
    if (memoKv && await isKnownFmp402(memoKv, 'ratios-ttm', ticker, nowOf(deps))) {
      // Expected on the FMP free plan: INFO, not a repeat of the first 402's WARNING.
      if (deps.log) deps.log('  FMP [ratios-ttm] not on the free plan for ' + ticker + ' (HTTP 402 within 7 days) -- skipped');
      if (why) why('not in the FMP plan (402, remembered)');
      return null;
    }
    const url = 'https://financialmodelingprep.com/stable/ratios-ttm?symbol=' + ticker + '&apikey=' + deps.fmpKey;
    const res = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (res.status === 402 && memoKv) await noteFmp402(memoKv, 'ratios-ttm', ticker, nowOf(deps));
    if (res.status !== 200) { if (why) why(res.status === 402 ? 'not in the FMP plan (402)' : 'HTTP ' + res.status); return null; }
    const list = JSON.parse(res.text());
    if (cacheKv && Array.isArray(list)) await writeFmpCache(cacheKv, 'ratios-ttm', ticker, list[0] || null, nowOf(deps));
    if (!Array.isArray(list) || !list[0] || list[0].interestCoverageRatioTTM == null) { if (why) why('no data'); return null; }
    return list[0].interestCoverageRatioTTM;
  } catch (e) {
    if (why) why('error: ' + (e as Error).message);
    return null;
  }
}

/**
 * refreshBrokerCourseDataCacheV1_ (dataLayerV1.gs:1510-1538): nightly, per
 * ticker. A fresh row is left alone; a row is written only when at least
 * one of the two fetches returned data (no cache poisoning on an outage).
 */
export async function refreshBrokerCourseDataCache(deps: MacroDeps, ticker: string, log: MacroLog | null = deps.log ?? null): Promise<void> {
  try {
    const existing = await readBrokerDataCache(deps.store, ticker, nowOf(deps));
    if (existing) return;
    let nasdaqWhy = 'no data';
    let fmpWhy = 'no data';
    const shortInterest = await fetchNasdaqShortInterestV1(deps.http, ticker, (r) => { nasdaqWhy = r; });
    const interestCoverageRatio = await fetchFMPInterestCoverage(deps, ticker, (r) => { fmpWhy = r; });
    if (shortInterest == null && interestCoverageRatio == null) {
      if (log) log(deps.plainText
        ? '  ⚠ Broker data cache NOT written for ' + ticker + ' -- no data from either source (Nasdaq short interest: ' + nasdaqWhy + '; FMP interest coverage: ' + fmpWhy + '), will retry next run'
        : '  ⚠ Broker data cache NOT written for ' + ticker + ' -- both real fetches failed (Nasdaq + FMP), real transient failure, will retry next run');
      return;
    }
    await writeBrokerDataCache(deps.store, ticker, {
      shortInterest: shortInterest ? shortInterest.shortInterest : null,
      daysToCover: shortInterest ? shortInterest.daysToCover : null,
      settlementDate: shortInterest ? shortInterest.settlementDate : null,
      interestCoverageRatio,
    }, new Date(nowOf(deps)));
    if (log) log('  💾 Broker data cache refreshed for ' + ticker + ' (short-interest' + (shortInterest ? '' : ': n/a') + ', interest-coverage' + (interestCoverageRatio != null ? '' : ': n/a') + ')');
  } catch (e) {
    if (log) log('  ⚠ Broker data cache refresh failed for ' + ticker + ': ' + (e as Error).message);
  }
}

/** refreshMacroSnapshotV1_ (dataLayerV1.gs:1540-1557): nightly, market-wide. Keeps the last 20 / 12 / 8 points. */
export async function refreshMacroSnapshot(deps: MacroDeps, log: MacroLog | null = deps.log ?? null): Promise<void> {
  try {
    const existing = await readMacroSnapshot(deps.store, nowOf(deps));
    if (existing) return;
    const dgs10Raw = await fetchFredSeriesValues(deps.http, 'DGS10');
    const fedfundsRaw = await fetchFredSeriesValues(deps.http, 'FEDFUNDS');
    const gdpSeriesRaw = await fetchFredSeriesValues(gdpHttp(deps), GDP_SERIES_ID);
    if (dgs10Raw == null && fedfundsRaw == null && gdpSeriesRaw == null) {
      if (log) log('  ⚠ Macro snapshot NOT written -- all 3 real FRED fetches failed, real transient failure, will retry next run');
      return;
    }
    const dgs10 = dgs10Raw ? dgs10Raw.slice(-20) : null;
    const fedfunds = fedfundsRaw ? fedfundsRaw.slice(-12) : null;
    const gdpSeries = gdpSeriesRaw ? gdpSeriesRaw.slice(-8) : null;
    await writeMacroSnapshot(deps.store, new Date(nowOf(deps)), dgs10, fedfunds, gdpSeries);
    if (log) log('  💾 Macro snapshot refreshed (DGS10' + (dgs10 ? '' : ': n/a') + ', FEDFUNDS' + (fedfunds ? '' : ': n/a') + ', GDPC1' + (gdpSeries ? '' : ': n/a') + ')');
  } catch (e) {
    if (log) log('  ⚠ Macro snapshot refresh failed: ' + (e as Error).message);
  }
}

/** testMacroFetchers' ticker list (macro_fetchers_v0_15.gs:299-348), in its order. */
export const MACRO_DIAGNOSTIC_TICKERS: Readonly<Record<string, string>> = {
  'Gold': 'GC=F', 'Silver': 'SI=F', 'Crude Oil (WTI)': 'CL=F', 'Brent Crude': 'BZ=F',
  'Natural Gas': 'NG=F', 'Copper': 'HG=F', 'Platinum': 'PL=F', 'Palladium': 'PA=F',
  'Corn': 'ZC=F', 'Wheat': 'ZW=F', 'Soybeans': 'ZS=F', 'Coffee': 'KC=F',
  'Sugar': 'SB=F', 'Cotton': 'CT=F', 'Cocoa': 'CC=F', 'Lumber': 'LBS=F',
  'Uranium (ETF proxy)': 'URA', 'Broad commodities (ETF)': 'DBC', 'Live Cattle': 'LE=F', 'Metals & Mining (aluminum proxy)': 'XME',
  'Bitcoin (IBIT ETF proxy)': 'IBIT', 'Ethereum (ETHE ETF proxy)': 'ETHE',
  'Tech (XLK)': 'XLK', 'Financials (XLF)': 'XLF', 'Health Care (XLV)': 'XLV', 'Cons. Discretionary (XLY)': 'XLY',
  'Cons. Staples (XLP)': 'XLP', 'Energy (XLE)': 'XLE', 'Industrials (XLI)': 'XLI', 'Materials (XLB)': 'XLB',
  'Utilities (XLU)': 'XLU', 'Real Estate (XLRE)': 'XLRE', 'Communication Svcs (XLC)': 'XLC',
  '10yr Treasury Yield': '^TNX', '30yr Treasury Yield': '^TYX', '3mo Treasury Yield': '^IRX', '7-10yr Bond ETF': 'IEF', '20yr+ Bond ETF': 'TLT',
  'US Dollar Index': 'DX-Y.NYB', 'Dollar ETF (backup)': 'UUP',
  'Nikkei 225': '^N225', 'DAX': '^GDAXI', 'FTSE 100': '^FTSE', 'Hang Seng': '^HSI',
  'S&P 500 (baseline)': 'SPY',
};

/** testMacroFetchers (macro_fetchers_v0_15.gs:298-381): the manual reachability sweep. Logs only. */
export async function runMacroFetcherDiagnostics(deps: MacroDeps): Promise<void> {
  const log = logOf(deps);
  const tickers = MACRO_DIAGNOSTIC_TICKERS;
  log('=== Macro/cross-asset fetch test (' + Object.keys(tickers).length + ' tickers) ===');
  let okCount = 0, failCount = 0;
  for (const label in tickers) {
    const data = await fetchHistoricalOHLCV(deps.http, tickers[label], log);
    if (data) {
      okCount++;
      log('OK    ' + label + ' (' + tickers[label] + '): ' + data.closes.length + ' bars, ' + dateStringInTz(data.dates[0], deps.timeZone) + ' to ' + dateStringInTz(data.dates[data.dates.length - 1], deps.timeZone));
    } else {
      failCount++;
      log('FAIL  ' + label + ' (' + tickers[label] + ')');
    }
  }
  log('\n' + okCount + ' OK, ' + failCount + ' FAILED out of ' + Object.keys(tickers).length);

  const m2 = await fetchM2Macro(deps.http, log);
  if (m2) log('M2 money supply: ' + m2.values.length + ' monthly observations, ' + m2.dates[0] + ' to ' + m2.dates[m2.dates.length - 1] + ', latest value: ' + m2.values[m2.values.length - 1]);
  else log('M2 money supply: FAILED');
  const fedfunds = await fetchFredSeriesMacro(deps.http, 'FEDFUNDS', log);
  if (fedfunds) log('Fed Funds Rate: ' + fedfunds.values.length + ' monthly observations, latest: ' + fedfunds.values[fedfunds.values.length - 1] + '%');
  else log('Fed Funds Rate: FAILED');
  const t10y2y = await fetchFredSeriesMacro(deps.http, 'T10Y2Y', log);
  if (t10y2y) log('10yr-2yr Yield Curve: ' + t10y2y.values.length + ' daily observations, latest: ' + t10y2y.values[t10y2y.values.length - 1]);
  else log('10yr-2yr Yield Curve: FAILED');
}

/** testMacroRegimePredictiveValue (macro_fetchers_v0_15.gs:454-484): fetches the 9 series live, then the diagnostic. */
export async function runMacroRegimePredictiveValue(deps: MacroDeps): Promise<void> {
  const log = logOf(deps);
  const seriesMap: Record<string, MacroSeries> = {};
  log('Fetching ' + MACRO_REGIME_TICKERS.length + ' series for regime classification...');
  for (const t of MACRO_REGIME_TICKERS) {
    const data = await fetchHistoricalOHLCV(deps.http, t, log);
    if (!data) { log('FAILED to fetch ' + t + ' -- cannot proceed without it.'); return; }
    seriesMap[t] = data;
  }
  macroRegimePredictiveValue(seriesMap, deps.timeZone, log);
}
