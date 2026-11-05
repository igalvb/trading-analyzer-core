/**
 * The three fundamentals providers and FMP's three side endpoints. Each is
 * a verbatim port of its legacy fetcher in dataLayerV1.gs:
 *   fetchFinnhubFundamentals       :584-637
 *   fetchEarningsCalendarV7        :639-674
 *   fetchInsiderTradingNet         :1051-1088
 *   fetchTreasuryRate10Y           :1090-1115
 *   fetchFMPFundamentals           :1117-1231
 *   fetchAlphaVantageFundamentals  :1233-1284
 *
 * Kept exactly, on purpose: every URL (FMP's ticker is NOT URL-encoded; the
 * others' is), every status and body check, every log line, the `||` vs
 * `??` choices, and the falsy-zero quirks (an FMP result whose only data is
 * 0 counts as "no data"). Requests go out one after another in legacy's
 * order, so log lines keep their order.
 *
 * Keys come from deps.keys (injected configuration), never from code.
 */

import type { HttpClient } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { startOfDayInTz, formatDateInTz } from '../../core/dates.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../../storage/kv.ts';
import type { ProviderKeys } from '../providerKeys.ts';
import type {
  ProviderFundamentals, EarningsCalendar, EarningsReport, InsiderTradingNet, TreasuryRate10Y,
} from '../../types/fundamentals.ts';

/** Legacy passes `log` as an optional function, sometimes null. */
export type FundLog = ((msg: string) => void) | null | undefined;

export interface FundamentalsDeps {
  readonly http: HttpClient;
  readonly keys: ProviderKeys;
  /**
   * The script's zone. "Today" for the earnings calendar is local midnight
   * here (legacy `setHours(0,0,0,0)`, evaluated by Apps Script in the
   * script's zone), and the "fresh <date>" label is printed in it.
   */
  readonly timeZone: string;
  readonly clock?: Clock;
  /** Legacy `new Date().toLocaleDateString()`. Defaults to en-US in `timeZone`. */
  readonly dateLabel?: (d: Date) => string;
  /** D18: keep the profile's company name as `_companyName` (for the AI prompt). Unset = legacy (no extra field). */
  readonly withCompanyName?: boolean;
  /**
   * C2 (owner 2026-10-30: FMP free plan only). Set: an FMP endpoint that answered 402 for a ticker is skipped
   * for 7 days (remembered in `kv`), the earnings date comes from Finnhub's free calendar when FMP refuses it,
   * the earnings calendar is fetched once per ticker per run, and insider trading (402 for every ticker) is
   * never asked. Unset = legacy.
   */
  readonly fmpFreePlan?: FmpFreePlan;
}

export interface FmpFreePlan {
  readonly kv: PropertyStore;
  /** ticker -> its earnings calendar, for this run. */
  readonly earningsMemo: Map<string, Promise<EarningsCalendar>>;
  /**
   * Owner 2026-11-01 (FMP free plan, ~250 calls/day): FMP fundamentals answers are kept 24 h per endpoint + ticker
   * in `kv` (FMP_RESPONSE_CACHE_HOURS), so the nightly's fetch serves the same day's /analyze. Unset = always ask.
   */
  readonly responseCache?: boolean;
}

export const FMP_BASE = 'https://financialmodelingprep.com/stable/';
export const FINNHUB_BASE = 'https://finnhub.io/api/v1/';
export const ALPHA_VANTAGE_OVERVIEW = 'https://www.alphavantage.co/query?function=OVERVIEW&symbol=';

export function nowOf(deps: { readonly clock?: Clock }): number {
  return deps.clock ? deps.clock.now() : Date.now();
}

/** `e.message.substring(0, n)` -- evaluated only where legacy evaluates it. */
export function errText(e: unknown, n: number): string {
  return (e as Error).message.substring(0, n);
}

/** parseFloat-based coercion (dataLayerV1.gs:596, :1166). */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(v as string);
  return isNaN(n) ? null : n;
}

/** A Finnhub percentage, as a fraction (dataLayerV1.gs:597). */
function pct(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : n / 100;
}

/** fetchFinnhubFundamentals (dataLayerV1.gs:584-637): metric + profile2 + recommendation. */
export async function fetchFinnhubFundamentals(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<ProviderFundamentals | null> {
  try {
    if (!deps.keys.finnhub) return null;
    const get = async (q: string): Promise<any> => {
      try {
        const r = await deps.http.fetch({ url: FINNHUB_BASE + q + '&token=' + deps.keys.finnhub, muteHttpExceptions: true });
        if (r.status !== 200) return null;
        const j = JSON.parse(r.text() || 'null');
        if (j && j.error) return null;
        return j;
      } catch {
        return null;
      }
    };
    const T = encodeURIComponent(ticker);
    const mm = await get('stock/metric?symbol=' + T + '&metric=all');
    const m = (mm && mm.metric) || null;
    const prof = await get('stock/profile2?symbol=' + T);
    const rec = await get('stock/recommendation?symbol=' + T);
    if (!m && !prof && !(rec && rec.length)) {
      if (log) log('  Finnhub: no data for ' + ticker);
      return null;
    }

    // recommendation is an array, newest first
    let recMean: number | null = null;
    let recKey = '';
    let sb = 0, b = 0, h = 0, sl = 0, ss = 0, totRec = 0;
    if (rec && rec.length) {
      const r0 = rec[0];
      sb = +r0.strongBuy || 0; b = +r0.buy || 0; h = +r0.hold || 0; sl = +r0.sell || 0; ss = +r0.strongSell || 0;
      totRec = sb + b + h + sl + ss;
      if (totRec) {
        recMean = (1 * sb + 2 * b + 3 * h + 4 * sl + 5 * ss) / totRec;
        recKey = recMean < 1.5 ? 'Strong Buy' : recMean < 2.5 ? 'Buy' : recMean < 3.5 ? 'Hold' : recMean < 4.5 ? 'Sell' : 'Strong Sell';
      }
    }
    return {
      _source: 'finnhub',
      forwardPE: num(m && m.forwardPE),
      trailingPE: num(m && m.peTTM),
      pegRatio: num(m && m.pegTTM),
      priceToBook: num(m && (m.pbQuarterly != null ? m.pbQuarterly : m.pb)),
      profitMargins: pct(m && m.netProfitMarginTTM),
      grossMargins: pct(m && m.grossMarginTTM),
      returnOnEquity: pct(m && m.roeTTM),
      returnOnAssets: pct(m && m.roaTTM),
      revenueGrowth: pct(m && (m.revenueGrowthTTMYoy != null ? m.revenueGrowthTTMYoy : m.revenueGrowthQuarterlyYoy)),
      earningsGrowth: pct(m && (m.epsGrowthTTMYoy != null ? m.epsGrowthTTMYoy : m.epsGrowthQuarterlyYoy)),
      beta: num(m && m.beta),
      // `num(...) * 1e6`: a non-numeric value becomes null * 1e6 = 0, as in legacy.
      marketCap: prof && prof.marketCapitalization != null ? (num(prof.marketCapitalization) as number) * 1e6 : null,
      shareFloat: prof && prof.floatingShare != null ? (num(prof.floatingShare) as number) * 1e6 : null,
      dividend: num(m && m.dividendPerShareTTM) || num(m && m.currentDividendPerShareTTM),
      price: null,
      sector: (prof && prof.finnhubIndustry) || null,
      industry: (prof && prof.finnhubIndustry) || null,
      targetMean: null, targetHigh: null, targetLow: null,
      numAnalysts: totRec || null,
      recMean, recKey,
      strongBuy: sb, buy: b, hold: h, sell: sl, strongSell: ss,
      shortRatio: null, institutionPct: null,
      _premiumBlocked: false, _rateLimited: false,
      ...(deps.withCompanyName && prof && typeof prof.name === 'string' && prof.name ? { _companyName: prof.name } : {}),
    };
  } catch (e) {
    if (log) log('  Finnhub error: ' + errText(e, 50));
    return null;
  }
}

/**
 * fetchEarningsCalendarV7 (dataLayerV1.gs:639-674): every report FMP lists,
 * plus the soonest one dated today or later. "Today" is local midnight in
 * deps.timeZone; report dates are UTC midnight, so whether a report dated
 * today counts as upcoming depends on the zone, exactly as in legacy.
 *
 * Kept: the missing-`date` warning returns early ONLY when a logger is
 * passed (`&& log` is part of the condition) -- F-39.
 */
export async function fetchEarningsCalendar(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<EarningsCalendar> {
  const plan = deps.fmpFreePlan;
  if (!plan) return (await fetchFmpEarningsCalendar(deps, ticker, log)).calendar;
  const memo = plan.earningsMemo.get(ticker);
  if (memo) return memo;
  const p = (async (): Promise<EarningsCalendar> => {
    if (await knownFmp402(deps, 'earnings', ticker)) {
      if (log) log('  FMP [earnings] not on the free plan for ' + ticker + ' (HTTP 402 within 7 days) -- skipped; earnings date from Finnhub');
      return finnhubNextEarnings(deps, ticker, log);
    }
    const r = await fetchFmpEarningsCalendar(deps, ticker, log);
    if (r.status !== 402) return r.calendar;
    await rememberFmp402(deps, 'earnings', ticker);
    return finnhubNextEarnings(deps, ticker, log);
  })();
  plan.earningsMemo.set(ticker, p);
  return p;
}

async function fetchFmpEarningsCalendar(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<{ calendar: EarningsCalendar; status: number | null }> {
  const url = FMP_BASE + 'earnings?symbol=' + ticker + '&apikey=' + deps.keys.fmp;
  try {
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (resp.status !== 200) {
      if (log) log('  FMP [earnings] HTTP ' + resp.status);
      return { calendar: { next: null, history: [] }, status: resp.status };
    }
    return { calendar: parseFmpEarnings(deps, ticker, resp.text(), log), status: 200 };
  } catch (e) {
    if (log) log('  FMP [earnings] error: ' + errText(e, 60));
    return { calendar: { next: null, history: [] }, status: null };
  }
}

/** The 200 body of FMP earnings (throws on bad JSON; the caller logs it as legacy did). */
function parseFmpEarnings(deps: FundamentalsDeps, ticker: string, body: string, log?: FundLog): EarningsCalendar {
  {
    if (!body || body.length < 5) return { next: null, history: [] };
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return { next: null, history: [] };
    if (list[0] && list[0].date === undefined && log) {
      log('  ⚠ WARNING: expected "date" field not found on FMP earnings response for ' + ticker + ' -- field-name assumption may be wrong, needs investigating.');
      return { next: null, history: [] };
    }
    const today = startOfDayInTz(new Date(nowOf(deps)), deps.timeZone);
    const parsed: EarningsReport[] = list
      .filter((e) => e && e.date)
      .map((e) => ({
        date: new Date(e.date + 'T00:00:00Z'), raw: e.date,
        epsActual: (typeof e.epsActual === 'number') ? e.epsActual : null,
        epsEstimated: (typeof e.epsEstimated === 'number') ? e.epsEstimated : null,
        revenueActual: (typeof e.revenueActual === 'number') ? e.revenueActual : null,
        revenueEstimated: (typeof e.revenueEstimated === 'number') ? e.revenueEstimated : null,
      }))
      .filter((e) => !isNaN(e.date.getTime()));
    const upcoming = parsed.filter((e) => e.date.getTime() >= today.getTime()).sort((a, b) => a.date.getTime() - b.date.getTime());
    const next = upcoming.length ? { date: upcoming[0].date, dateStr: upcoming[0].raw } : null;
    return { next, history: parsed };
  }
}

/**
 * C2: the next earnings date from Finnhub's free calendar/earnings (used when FMP refuses the ticker on the
 * free plan). Only the date: the history stays empty, as it was after the 402, so nothing that reads the
 * history (broker-course gaps, the saved-copy check) changes.
 */
async function finnhubNextEarnings(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<EarningsCalendar> {
  const none: EarningsCalendar = { next: null, history: [] };
  if (!deps.keys.finnhub) return none;
  try {
    const today = startOfDayInTz(new Date(nowOf(deps)), deps.timeZone);
    const from = formatDateInTz(new Date(nowOf(deps)), deps.timeZone, 'yyyy-MM-dd');
    const to = formatDateInTz(new Date(nowOf(deps) + 365 * 86400000), deps.timeZone, 'yyyy-MM-dd');
    const r = await deps.http.fetch({ url: FINNHUB_BASE + 'calendar/earnings?from=' + from + '&to=' + to + '&symbol=' + encodeURIComponent(ticker) + '&token=' + deps.keys.finnhub, muteHttpExceptions: true });
    if (r.status !== 200) { if (log) log('  Finnhub [calendar/earnings] HTTP ' + r.status); return none; }
    const j = JSON.parse(r.text() || 'null');
    const list: unknown[] = j && Array.isArray(j.earningsCalendar) ? j.earningsCalendar : [];
    const dates = list
      .map((e) => (e && typeof (e as { date?: unknown }).date === 'string' ? (e as { date: string }).date : ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .map((raw) => ({ raw, date: new Date(raw + 'T00:00:00Z') }))
      .filter((e) => !isNaN(e.date.getTime()) && e.date.getTime() >= today.getTime())
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    if (log) log('  Finnhub [calendar/earnings]: ' + (dates.length ? 'next ' + dates[0]!.raw : 'no upcoming date') + ' for ' + ticker);
    return { next: dates.length ? { date: dates[0]!.date, dateStr: dates[0]!.raw } : null, history: [] };
  } catch (e) {
    if (log) log('  Finnhub [calendar/earnings] error: ' + errText(e, 60));
    return none;
  }
}

/** C2: how long a 402 (endpoint not on the free plan for this ticker) is remembered. */
export const FMP_402_TTL_MS = 7 * 86400000;

/** The key-value store key of a remembered FMP 402. */
export function fmp402Key(endpoint: string, ticker: string): string {
  return 'FMP_402_' + endpoint + '_' + ticker;
}

/**
 * Fix 2026-11-04 (watchdog: the same ratios-ttm 402s 24x a night): the remembered-402 check, for every FMP caller
 * that has a `kv` (the broker-data refresh and the 13F CUSIP lookup as well as fetchFMPFundamentals). The keys are
 * shared, so a 402 any caller saw is honoured by all of them.
 */
export async function isKnownFmp402(kv: PropertyStore, endpoint: string, ticker: string, now: number): Promise<boolean> {
  try {
    const at = Number(await kv.get(fmp402Key(endpoint, ticker)));
    return Number.isFinite(at) && at > 0 && now - at < FMP_402_TTL_MS;
  } catch {
    return false;
  }
}

/** Remember a 402 for FMP_402_TTL_MS (a store failure only means the next run asks again). */
export async function noteFmp402(kv: PropertyStore, endpoint: string, ticker: string, now: number): Promise<void> {
  try { await kv.set(fmp402Key(endpoint, ticker), String(now)); } catch { /* the next run asks again */ }
}

async function knownFmp402(deps: FundamentalsDeps, endpoint: string, ticker: string): Promise<boolean> {
  return deps.fmpFreePlan ? isKnownFmp402(deps.fmpFreePlan.kv, endpoint, ticker, nowOf(deps)) : false;
}

async function rememberFmp402(deps: FundamentalsDeps, endpoint: string, ticker: string): Promise<void> {
  if (deps.fmpFreePlan) await noteFmp402(deps.fmpFreePlan.kv, endpoint, ticker, nowOf(deps));
}

/**
 * Owner 2026-11-01: a 24 h cache of FMP's fundamentals answers (fundamentals change at most quarterly). One `kv` key
 * per endpoint + ticker; the value is cacheSet's { _savedAt, _ttlHours, data } with data = { v }: the answer's first
 * row cut down to the fields read (FMP_CACHED_FIELDS), or null for a 200 with no rows. Only a clean 200 is kept:
 * a 402 (remembered 7 days, apart), a 429 / "Limit Reach", any other status, an error body or a parse error is not.
 */
export const FMP_RESPONSE_CACHE_HOURS = 24;
export const FMP_RESPONSE_CACHE_PREFIX = 'FMP_C_';

/**
 * The endpoints cached, each with the fields its row keeps (everything fetchFMPFundamentals and
 * fetchFMPInterestCoverage read). `profile` is NOT cached: it carries the live `price` (analyst-target upside,
 * dividend yield), which must never be older than the run's own fetch -- so it is asked every run (5 of 6 cached).
 */
export const FMP_CACHED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'ratios-ttm': ['priceToEarningsRatioTTM', 'priceToEarningsGrowthRatioTTM', 'priceToBookRatioTTM', 'netProfitMarginTTM', 'grossProfitMarginTTM',
    'debtToEquityRatioTTM', 'currentRatioTTM', 'quickRatioTTM', 'freeCashFlowPerShareTTM', 'interestCoverageRatioTTM'],
  'metrics-ttm': ['returnOnEquityTTM', 'returnOnAssetsTTM', 'freeCashFlowPerShareTTM'],
  growth: ['revenueGrowth', 'netIncomeGrowth', 'epsgrowth'],
  target: ['targetConsensus', 'targetMedian', 'targetHigh', 'targetLow', 'numberOfAnalystOpinions'],
  rating: ['rating'],
};

export function fmpCacheKey(endpoint: string, ticker: string): string {
  return FMP_RESPONSE_CACHE_PREFIX + endpoint + '_' + ticker;
}

/** The row cut down to its endpoint's fields (anything not an object is null). */
export function trimFmpRow(endpoint: string, row: unknown): Record<string, unknown> | null {
  if (row == null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const keep = FMP_CACHED_FIELDS[endpoint] ?? [];
  const out: Record<string, unknown> = {};
  for (const f of keep) if (r[f] !== undefined) out[f] = r[f];
  return out;
}

/** The cached row as { v }, or null when none is in date (or the store fails). */
export async function readFmpCache(kv: PropertyStore, endpoint: string, ticker: string, now: number): Promise<{ v: Record<string, unknown> | null } | null> {
  const c = await cacheGet<{ v: Record<string, unknown> | null }>(kv, fmpCacheKey(endpoint, ticker), now);
  return c && typeof c === 'object' && 'v' in c ? c : null;
}

/** Keeps a clean 200's first row for 24 h (a store failure only means the next run asks again). */
export async function writeFmpCache(kv: PropertyStore, endpoint: string, ticker: string, row: unknown, now: number): Promise<void> {
  await cacheSet(kv, fmpCacheKey(endpoint, ticker), { v: trimFmpRow(endpoint, row) }, FMP_RESPONSE_CACHE_HOURS, now);
}

/** fetchInsiderTradingNet (dataLayerV1.gs:1051-1088). The field name's typo ("acquistion") is FMP's. */
export async function fetchInsiderTradingNet(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<InsiderTradingNet | null> {
  // C2: FMP answers 402 for every ticker on the free plan, so the free plan never asks.
  if (deps.fmpFreePlan) return null;
  const url = FMP_BASE + 'insider-trading/search?symbol=' + ticker + '&page=0&limit=50&apikey=' + deps.keys.fmp;
  try {
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (resp.status !== 200) {
      if (resp.status === 402) {
        if (log) log('  FMP [insider-trading] HTTP 402 -- confirmed via real run: this endpoint requires a plan tier this API key doesn\'t have. Not a parameter-naming issue -- the symbol= assumption is fine, this data just isn\'t accessible on the current plan.');
      } else if (log) {
        log('  FMP [insider-trading] HTTP ' + resp.status + ' -- the symbol= parameter assumption may be wrong for this endpoint');
      }
      return null;
    }
    const body = resp.text();
    if (!body || body.length < 5) return null;
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return null;
    if (list[0] && list[0].acquistionOrDisposition === undefined) {
      if (log) log('  ⚠ WARNING: expected "acquistionOrDisposition" field not found on FMP insider-trading response for ' + ticker + ' -- field-name assumption may be wrong, needs investigating.');
      return null;
    }
    let sharesAcquired = 0, sharesDisposed = 0, purchaseCount = 0, saleCount = 0;
    list.forEach((t) => {
      if (!t || !t.acquistionOrDisposition) return;
      const shares = Number(t.securitiesTransacted) || 0;
      if (t.acquistionOrDisposition === 'A') { sharesAcquired += shares; purchaseCount++; }
      else if (t.acquistionOrDisposition === 'D') { sharesDisposed += shares; saleCount++; }
    });
    const netShares = sharesAcquired - sharesDisposed;
    return {
      sharesAcquired, sharesDisposed, netShares, purchaseCount, saleCount,
      transactionsAnalyzed: list.length,
      netBuying: netShares > 0,
    };
  } catch (e) {
    if (log) log('  FMP [insider-trading] error: ' + errText(e, 60));
    return null;
  }
}

/** fetchTreasuryRate10Y (dataLayerV1.gs:1090-1115). The newest entry is first. */
export async function fetchTreasuryRate10Y(deps: FundamentalsDeps, log?: FundLog): Promise<TreasuryRate10Y | null> {
  const url = FMP_BASE + 'treasury-rates?apikey=' + deps.keys.fmp;
  try {
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (resp.status !== 200) {
      if (log) log('  FMP [treasury-rates] HTTP ' + resp.status);
      return null;
    }
    const body = resp.text();
    if (!body || body.length < 5) return null;
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return null;
    if (list[0] && list[0].year10 === undefined) {
      if (log) log('  ⚠ WARNING: expected "year10" field not found on FMP treasury-rates response -- field-name assumption may be wrong, needs investigating. Real fields present: ' + Object.keys(list[0]).join(', '));
      return null;
    }
    const latest = list[0];
    return { year10: Number(latest.year10), date: latest.date };
  } catch (e) {
    if (log) log('  FMP [treasury-rates] error: ' + errText(e, 60));
    return null;
  }
}

/**
 * fetchFMPFundamentals (dataLayerV1.gs:1117-1231): six /stable/ endpoints.
 * 429 or "Limit Reach" marks the result rate-limited, 402 or "current
 * subscription" premium-blocked; both flags are per call and only survive
 * if this function returns a result (F-37).
 */
export async function fetchFMPFundamentals(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<ProviderFundamentals | null> {
  const K = deps.keys.fmp;
  const addKey = (url: string): string => url + (url.includes('?') ? '&' : '?') + 'apikey=' + K;

  let premiumBlocked = false;
  let rateLimited = false;

  const runCacheKv = deps.fmpFreePlan && deps.fmpFreePlan.responseCache ? deps.fmpFreePlan.kv : null;
  let fromCache = 0;

  const safeFetch = async (label: string, url: string): Promise<any> => {
    // Only the endpoints in FMP_CACHED_FIELDS (never `profile`: its price must be this run's).
    const cacheKv = FMP_CACHED_FIELDS[label] ? runCacheKv : null;
    if (cacheKv) {
      const hit = await readFmpCache(cacheKv, label, ticker, nowOf(deps));
      if (hit) { fromCache++; return hit.v; }
    }
    // C2: an endpoint that answered 402 for this ticker within 7 days is not asked again (same result as the 402).
    if (await knownFmp402(deps, label, ticker)) {
      premiumBlocked = true;
      if (log) log('  FMP [' + label + '] not on the free plan for ' + ticker + ' (HTTP 402 within 7 days) -- skipped');
      return null;
    }
    try {
      const res = await deps.http.fetch({ url: addKey(url), muteHttpExceptions: true });
      const code = res.status;
      const body = res.text();
      if (code === 429 || (body && body.indexOf('Limit Reach') !== -1)) {
        rateLimited = true;
        if (log) log('  FMP [' + label + '] rate-limited (HTTP ' + code + ' — free tier ~250 calls/day, resets midnight ET)');
        return null;
      }
      if (code === 402 || (body && body.indexOf('current subscription') !== -1)) {
        premiumBlocked = true;
        if (log) log('  FMP [' + label + '] premium-gated (HTTP ' + code + ' — symbol not covered on free plan)');
        await rememberFmp402(deps, label, ticker);
        return null;
      }
      if (code !== 200) { if (log) log('  FMP [' + label + '] HTTP ' + code); return null; }
      if (!body || body.length < 5) {
        // A clean "no rows" ([]) is an answer too (kept 24 h); an empty or cut body is not.
        if (cacheKv && body && body.trim() === '[]') await writeFmpCache(cacheKv, label, ticker, null, nowOf(deps));
        return null;
      }
      const p = JSON.parse(body);
      if (p && (p['Error Message'] || p['errors'])) { if (log) log('  FMP [' + label + '] access denied'); return null; }
      const row = Array.isArray(p) ? (p[0] || null) : p;
      if (cacheKv) await writeFmpCache(cacheKv, label, ticker, row, nowOf(deps));
      return row;
    } catch (e) {
      if (log) log('  FMP [' + label + '] ' + errText(e, 50));
      return null;
    }
  };

  const profile = await safeFetch('profile', FMP_BASE + 'profile?symbol=' + ticker);
  const ratios = await safeFetch('ratios-ttm', FMP_BASE + 'ratios-ttm?symbol=' + ticker);
  const metrics = await safeFetch('metrics-ttm', FMP_BASE + 'key-metrics-ttm?symbol=' + ticker);
  const growth = await safeFetch('growth', FMP_BASE + 'financial-growth?symbol=' + ticker + '&period=annual&limit=1');
  const target = await safeFetch('target', FMP_BASE + 'price-target-consensus?symbol=' + ticker);
  const rating = await safeFetch('rating', FMP_BASE + 'ratings-snapshot?symbol=' + ticker);
  if (fromCache > 0 && log) log('  FMP: ' + fromCache + '/5 cacheable endpoints from the 24 h cache for ' + ticker + ' (' + fromCache + ' FMP call' + (fromCache === 1 ? '' : 's') + ' saved)');

  if (!profile && !ratios && !metrics) { if (log) log('  FMP: all core endpoints failed'); return null; }
  if (log) {
    const prem = [ratios, metrics, growth, target, rating].filter((x) => x == null).length;
    log('  FMP: profile OK' + (prem > 0 ? ' — ' + prem + '/5 premium endpoints unavailable (' + (rateLimited ? 'rate-limited' : premiumBlocked ? 'not covered on free plan for ' + ticker : 'no data') + ')' : ' — full fundamentals loaded'));
  }

  const pick = (...vals: unknown[]): any => vals.find((v) => v != null && v !== '') ?? null;
  // ratings-snapshot gives a letter grade (A best ... F worst); map to 1 = Strong Buy ... 5 = Strong Sell.
  let recMean: number | null = null;
  let recKey = '';
  if (rating) {
    recKey = rating.rating || '';
    const m: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, F: 5 };
    recMean = m[String(recKey).charAt(0).toUpperCase()] || null;
  }

  const fund: ProviderFundamentals = {
    _source: 'fmp',
    forwardPE: null,
    trailingPE: num(pick(ratios && ratios.priceToEarningsRatioTTM)),
    pegRatio: num(pick(ratios && ratios.priceToEarningsGrowthRatioTTM)),
    priceToBook: num(pick(ratios && ratios.priceToBookRatioTTM)),
    profitMargins: num(pick(ratios && ratios.netProfitMarginTTM)),
    grossMargins: num(pick(ratios && ratios.grossProfitMarginTTM)),
    returnOnEquity: num(pick(metrics && metrics.returnOnEquityTTM)),
    returnOnAssets: num(pick(metrics && metrics.returnOnAssetsTTM)),
    revenueGrowth: num(pick(growth && growth.revenueGrowth)),
    earningsGrowth: num(pick(growth && growth.netIncomeGrowth, growth && growth.epsgrowth)),
    beta: num(pick(profile && profile.beta)),
    marketCap: num(pick(profile && profile.marketCap)),
    dividend: num(pick(profile && profile.lastDividend)),
    price: num(pick(profile && profile.price)),
    sector: pick(profile && profile.sector),
    industry: pick(profile && profile.industry),
    targetMean: num(pick(target && target.targetConsensus, target && target.targetMedian)),
    targetHigh: num(pick(target && target.targetHigh)),
    targetLow: num(pick(target && target.targetLow)),
    numAnalysts: num(pick(target && target.numberOfAnalystOpinions)),
    debtToEquity: num(pick(ratios && ratios.debtToEquityRatioTTM)),
    currentRatio: num(pick(ratios && ratios.currentRatioTTM)),
    quickRatio: num(pick(ratios && ratios.quickRatioTTM)),
    fcfPerShare: num(pick(ratios && ratios.freeCashFlowPerShareTTM, metrics && metrics.freeCashFlowPerShareTTM)),
    recMean, recKey,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
    shortRatio: null, institutionPct: null,
    _premiumBlocked: premiumBlocked,
    _rateLimited: rateLimited,
    ...(deps.withCompanyName && profile && typeof profile.companyName === 'string' && profile.companyName ? { _companyName: profile.companyName } : {}),
  };

  // Truthiness, as in legacy: a result whose only data is 0 counts as empty.
  const hasData = fund.forwardPE || fund.trailingPE || fund.revenueGrowth || fund.targetMean || fund.profitMargins || fund.returnOnEquity || fund.beta;
  if (!hasData) { if (log) log('  FMP: connected but all fields null for ' + ticker); return null; }
  return fund;
}

/** fetchAlphaVantageFundamentals (dataLayerV1.gs:1233-1284): the OVERVIEW endpoint. */
export async function fetchAlphaVantageFundamentals(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<ProviderFundamentals | null> {
  try {
    if (!deps.keys.alphaVantage) return null;
    const url = ALPHA_VANTAGE_OVERVIEW + encodeURIComponent(ticker) + '&apikey=' + deps.keys.alphaVantage;
    const res = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (res.status !== 200) { if (log) log('  AV HTTP ' + res.status); return null; }
    const d = JSON.parse(res.text() || '{}');
    // Rate-limit / demo-key / info responses come back as {Note:...} or {Information:...}
    if (d.Note || d.Information) { if (log) log('  AV: ' + String(d.Note || d.Information).substring(0, 70)); return null; }
    if (!d.Symbol || Object.keys(d).length < 5) { if (log) log('  AV: no fundamentals for ' + ticker); return null; }

    const avNum = (v: unknown): number | null => {
      if (v == null) return null;
      const s = String(v).trim();
      if (s === '' || s === 'None' || s === '-' || s === 'NaN') return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };
    const tc = (s: unknown): string => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const sb = avNum(d.AnalystRatingStrongBuy) || 0, b = avNum(d.AnalystRatingBuy) || 0, h = avNum(d.AnalystRatingHold) || 0,
      sl = avNum(d.AnalystRatingSell) || 0, ss = avNum(d.AnalystRatingStrongSell) || 0;
    const totRec = sb + b + h + sl + ss;
    const recMean = totRec ? (1 * sb + 2 * b + 3 * h + 4 * sl + 5 * ss) / totRec : null;
    const recKey = recMean == null ? '' : (recMean < 1.5 ? 'Strong Buy' : recMean < 2.5 ? 'Buy' : recMean < 3.5 ? 'Hold' : recMean < 4.5 ? 'Sell' : 'Strong Sell');

    return {
      _source: 'alphavantage',
      forwardPE: avNum(d.ForwardPE),
      trailingPE: avNum(d.PERatio),
      pegRatio: avNum(d.PEGRatio),
      priceToBook: avNum(d.PriceToBookRatio),
      profitMargins: avNum(d.ProfitMargin),
      grossMargins: null,
      returnOnEquity: avNum(d.ReturnOnEquityTTM),
      returnOnAssets: avNum(d.ReturnOnAssetsTTM),
      revenueGrowth: avNum(d.QuarterlyRevenueGrowthYOY),
      earningsGrowth: avNum(d.QuarterlyEarningsGrowthYOY),
      beta: avNum(d.Beta),
      marketCap: avNum(d.MarketCapitalization),
      shareFloat: avNum(d.SharesFloat),
      dividend: avNum(d.DividendPerShare),
      price: null,
      sector: (d.Sector && d.Sector !== 'None') ? tc(d.Sector) : null,
      industry: (d.Industry && d.Industry !== 'None') ? tc(d.Industry) : null,
      targetMean: avNum(d.AnalystTargetPrice),
      targetHigh: null,
      targetLow: null,
      numAnalysts: totRec || null,
      recMean, recKey,
      strongBuy: sb, buy: b, hold: h, sell: sl, strongSell: ss,
      shortRatio: null, institutionPct: null,
      _premiumBlocked: false, _rateLimited: false,
    };
  } catch (e) {
    if (log) log('  AV error: ' + errText(e, 50));
    return null;
  }
}
