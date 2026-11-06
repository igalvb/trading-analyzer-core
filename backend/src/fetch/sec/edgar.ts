/**
 * SEC EDGAR lookups, ported exactly from dataLayerV1.gs:
 *   fetchSecEdgarCIKV1              :1420-1442  -- ticker -> 10-digit CIK, cached 90 days ('CIK_' + TICKER)
 *   fetchSharesOutstandingHistoryV1 :1444-1466  -- XBRL CommonStockSharesOutstanding, one value per period
 *   fetchSecFilingKeywordHitsV1     :1468-1497  -- full-text search hit counts for the dilution keywords
 * plus SEC_DILUTION_KEYWORDS_V1 (brokerCourseModelV1.gs:2679).
 *
 * User-Agent: legacy sent placeholder contacts ('BrokerCourseModelV1
 * research contact@example.com', 'Mozilla/5.0 research@example.com'); SEC's
 * fair-access policy requires a real one. The port still passes legacy's
 * header, and the HTTP client REPLACES it for every SEC host with
 * secUserAgent(SEC_CONTACT_EMAIL) -- build the client with
 * secUserAgentsFromEnv(). The contact email is used for nothing else.
 */

import type { HttpClient, HttpResponse } from '../../net/http.ts';
import { secUserAgents, SEC_CONTACT_EMAIL_ENV } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { formatDateInTz } from '../../core/dates.ts';
import { backoffMs, sleep as realSleep } from '../../core/errors.ts';
import { currentSignal } from '../../core/cancel.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../../storage/kv.ts';

/** Legacy's placeholder headers (replaced on SEC hosts by the client's user-agent policy). */
export const SEC_BROKER_COURSE_UA = 'BrokerCourseModelV1 research contact@example.com';
export const SEC_13F_UA = 'Mozilla/5.0 research@example.com';

/** brokerCourseModelV1.gs:2679. */
export const SEC_DILUTION_KEYWORDS: readonly string[] = ['offering', 'shelf', 'warrants', 'convertible', 'dilution'];

/** Cache TTL for CIK and CUSIP lookups (legacy: 24 * 90 hours). */
export const IDENTIFIER_CACHE_TTL_HOURS = 24 * 90;

export interface SecDeps {
  readonly http: HttpClient;
  readonly kv: PropertyStore;
  readonly clock?: Clock;
}

export const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());

/**
 * The user-agent map for HttpClient's `userAgentByHost`, from SEC_CONTACT_EMAIL.
 * Throws when it is unset: SEC blocks anonymous automated traffic.
 */
export function secUserAgentsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<string, string>> {
  const email = env[SEC_CONTACT_EMAIL_ENV];
  if (!email) throw new Error(SEC_CONTACT_EMAIL_ENV + ' is not set. SEC EDGAR requires a real contact in the User-Agent; put it in .env.');
  return secUserAgents(email);
}

const SEC_HEADERS = { 'User-Agent': SEC_BROKER_COURSE_UA };

/** fetchSecEdgarCIKV1 (:1420-1442). A ticker with no CIK is NOT cached (a future filing must stay visible). */
export async function fetchSecEdgarCIK(deps: SecDeps, ticker: string): Promise<string | null> {
  const cacheKey = 'CIK_' + String(ticker).toUpperCase();
  const cached = await cacheGet<string>(deps.kv, cacheKey, nowOf(deps));
  if (cached !== null && cached !== undefined) return cached;
  try {
    const res = await deps.http.fetch({ url: 'https://www.sec.gov/files/company_tickers.json', headers: SEC_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.text());
    const upperTicker = ticker.toUpperCase();
    for (const key in data) {
      if (data[key].ticker === upperTicker) {
        const cik = String(data[key].cik_str);
        const result = '0'.repeat(Math.max(0, 10 - cik.length)) + cik;
        await cacheSet(deps.kv, cacheKey, result, IDENTIFIER_CACHE_TTL_HOURS, nowOf(deps));
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface SharesOutstandingPoint {
  readonly date: string;
  readonly value: number;
}

/** fetchSharesOutstandingHistoryV1 (:1444-1466): the latest-FILED value per period end, oldest first. */
export interface SharesHistoryOptions {
  /**
   * A4: when us-gaap has no CommonStockSharesOutstanding (404, e.g. a foreign filer), read the fallback concepts
   * (SHARES_OUTSTANDING_FALLBACKS) in order. Unset = legacy (the us-gaap concept only).
   */
  readonly deiFallback?: boolean;
}

/**
 * The share-count concepts tried after us-gaap/CommonStockSharesOutstanding (fix 2026-11-04, MSTR).
 *
 * SEC's companyconcept API serves only facts WITHOUT a dimension. A company with more than one class of common
 * stock (MSTR: class A + class B) tags its balance-sheet and cover-page share counts per class
 * (StatementClassOfStockAxis), so both CommonStockSharesOutstanding and dei EntityCommonStockSharesOutstanding are
 * 404 for it. The EPS denominator, WeightedAverageNumberOfSharesOutstandingBasic, is reported company-wide (all
 * classes together, no dimension) by such filers, so it is the next best trend of the share count; diluted is last.
 * Weighted averages are duration facts: per period end the shortest period wins (the quarter, not the year-to-date).
 */
export const SHARES_OUTSTANDING_FALLBACKS: readonly string[] = [
  'dei/EntityCommonStockSharesOutstanding',
  'us-gaap/WeightedAverageNumberOfSharesOutstandingBasic',
  'us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding',
];
export const SHARES_OUTSTANDING_PRIMARY = 'us-gaap/CommonStockSharesOutstanding';

const conceptUrl = (cik: string, concept: string): string => 'https://data.sec.gov/api/xbrl/companyconcept/CIK' + cik + '/' + concept + '.json';

const spanDays = (s: { start?: string; end: string }): number => (s.start ? (new Date(s.end).getTime() - new Date(s.start).getTime()) / 86400000 : 0);

interface ShareFact { readonly start?: string; readonly end: string; readonly val: number; readonly filed: string }

/** One concept's `units.shares` as history points, or null when it has none. */
function sharesHistoryOf(data: { units?: { shares?: ShareFact[] } } | null): SharesOutstandingPoint[] | null {
  const shares = data && data.units && data.units.shares;
  if (!shares || !shares.length) return null;
  const byEnd: Record<string, ShareFact> = {};
  shares.forEach((s) => {
    const cur = byEnd[s.end];
    if (!cur) { byEnd[s.end] = s; return; }
    const dSpan = spanDays(s) - spanDays(cur); // 0 for instant facts (legacy: latest filed only)
    if (dSpan < 0 || (dSpan === 0 && new Date(s.filed).getTime() > new Date(cur.filed).getTime())) byEnd[s.end] = s;
  });
  return Object.keys(byEnd).map((k) => byEnd[k] as ShareFact).sort((a, b) => new Date(a.end).getTime() - new Date(b.end).getTime())
    .map((s) => ({ date: s.end, value: s.val }));
}

export async function fetchSharesOutstandingHistory(deps: Pick<SecDeps, 'http'>, cik: string | null | undefined, opts: SharesHistoryOptions = {}): Promise<SharesOutstandingPoint[] | null> {
  if (!cik) return null;
  try {
    const res = await deps.http.fetch({ url: conceptUrl(cik, SHARES_OUTSTANDING_PRIMARY), headers: SEC_HEADERS, muteHttpExceptions: true });
    if (res.status === 404 && opts.deiFallback) {
      for (const concept of SHARES_OUTSTANDING_FALLBACKS) {
        const r = await deps.http.fetch({ url: conceptUrl(cik, concept), headers: SEC_HEADERS, muteHttpExceptions: true });
        if (r.status === 404) continue; // this filer does not report the concept undimensioned: try the next
        if (r.status !== 200) return null; // a real failure (5xx / 429): the step's retry handles it
        const h = sharesHistoryOf(JSON.parse(r.text()));
        if (h) return h;
      }
      return null;
    }
    if (res.status !== 200) return null;
    return sharesHistoryOf(JSON.parse(res.text()));
  } catch {
    return null;
  }
}

/**
 * Fix 2026-11-05 (live logs 4 and 5 Nov: the efts.sec.gov full-text search answers HTTP 500 a few times a night):
 * a 5xx or a network error on one keyword's search is retried `retries` times with a short jittered backoff
 * (500 ms, then 1 s, each + up to 1 s jitter) -- one request at a time per keyword, through the same client
 * (per-host limiter, SEC User-Agent policy), so well inside SEC's 10 req/s. 4xx (429 included) and a cancelled
 * step are not retried. Legacy-parity callers pass retries: 0 (legacy: one try per keyword).
 */
export interface KeywordSearchOptions {
  /** Retries after the first try (default KEYWORD_SEARCH_RETRIES). */
  readonly retries?: number;
  /** Tests: no real waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}
export const KEYWORD_SEARCH_RETRIES = 2;
export const KEYWORD_SEARCH_BACKOFF_BASE_MS = 500;
export const KEYWORD_SEARCH_BACKOFF_MAX_MS = 2000;

/** One search, retried on 5xx / network error. Resolves the last response; rejects with the last error. */
async function searchWithRetry(http: HttpClient, url: string, o: KeywordSearchOptions): Promise<HttpResponse> {
  const retries = Math.max(0, o.retries ?? KEYWORD_SEARCH_RETRIES);
  for (let attempt = 0; ; attempt++) {
    const out = await http.fetch({ url, headers: SEC_HEADERS, muteHttpExceptions: true })
      .then((res) => ({ res, err: undefined as unknown }), (err: unknown) => ({ res: null, err }));
    const transient = out.res ? out.res.status >= 500 : !currentSignal()?.aborted;
    if (!transient || attempt >= retries) {
      if (out.res) return out.res;
      throw out.err;
    }
    await (o.sleep ?? realSleep)(backoffMs(attempt + 1, KEYWORD_SEARCH_BACKOFF_BASE_MS, KEYWORD_SEARCH_BACKOFF_MAX_MS, o.random));
  }
}

/**
 * fetchSecFilingKeywordHitsV1 (:1468-1497): one EDGAR full-text search per
 * keyword, in order; a hit count, 0 when the response has no total, or null
 * on any failure (after the retries above). The window ends today (UTC).
 */
export async function fetchSecFilingKeywordHits(deps: Pick<SecDeps, 'http' | 'clock'>, cik: string | null | undefined, sinceDate?: string | null, opts: KeywordSearchOptions = {}): Promise<Record<string, number | null> | null> {
  if (!cik) return null;
  const cikNum = String(parseInt(cik, 10));
  const results: Record<string, number | null> = {};
  for (const kw of SEC_DILUTION_KEYWORDS) {
    try {
      let url = 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent('"' + kw + '"') +
        '&ciks=' + ('0'.repeat(Math.max(0, 10 - cikNum.length)) + cikNum);
      if (sinceDate) url += '&dateRange=custom&startdt=' + sinceDate + '&enddt=' + formatDateInTz(new Date(nowOf(deps)), 'UTC');
      const res = await searchWithRetry(deps.http, url, opts);
      if (res.status === 200) {
        const parsed = JSON.parse(res.text());
        const total = parsed && parsed.hits && parsed.hits.total;
        results[kw] = total ? total.value : 0;
      } else {
        results[kw] = null;
      }
    } catch {
      results[kw] = null;
    }
  }
  return results;
}
