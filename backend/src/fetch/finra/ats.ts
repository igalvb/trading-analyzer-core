/**
 * FINRA OTC Transparency -- weekly ATS (dark-pool) volume. Ported exactly:
 *   darkPoolTrackerV1.gs FINRA_ATS_WEEKLY_URL_V1 :69, finraCompareFilterV1_ :71-73,
 *     mostRecentMondayV1_ :77-81
 *   dataLayerV1.gs findLatestPublishedFinraWeekV1_ :1563-1588,
 *     fetchFinraAtsWeeklyBatchV1_ :1590-1625
 *
 * The public endpoint needs no key. Every query is a POST to one URL; the
 * body carries the filters (weekStartDate and tierIdentifier must both be
 * EQUAL-filtered or FINRA answers 400).
 *
 * mostRecentMonday is evaluated in the script's zone, as Apps Script did;
 * the probed date is formatted in America/New_York, as legacy hard-codes.
 *
 * F-55 (not fixed by default): legacy walks back by subtracting 7 x 24 h
 * from a local midnight. Across the spring DST change that lands on 23:00
 * of the previous SUNDAY, and every later probe is a Sunday FINRA never
 * publishes -- so for a few weeks each spring the probe finds nothing and
 * the tracker shows no data. `calendarWeekSteps: true` steps by calendar
 * week instead; the default is legacy's behaviour, pending the user.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { formatDateInTz, wallClockInTz, startOfDayInTz } from '../../core/dates.ts';

export const FINRA_ATS_WEEKLY_URL = 'https://api.finra.org/data/group/otcMarket/name/weeklySummary';
export const FINRA_WEEK_PROBE_MAX_WEEKS_BACK = 8;
/** Legacy formats the probed Monday in this zone regardless of the script's zone. */
export const FINRA_WEEK_DATE_TIME_ZONE = 'America/New_York';

export type FinraTier = 'T1' | 'T2';

export interface FinraCompareFilter {
  readonly compareType: 'EQUAL';
  readonly fieldName: string;
  readonly fieldValue: string;
}

/** One weeklySummary row (only the fields legacy reads are typed). */
export interface FinraAtsRow {
  readonly summaryTypeCode?: string;
  readonly totalWeeklyShareQuantity?: number;
  readonly [field: string]: unknown;
}

export interface FinraDeps {
  readonly http: HttpClient;
  /** The script's zone (mostRecentMondayV1_ used the runtime's local date). */
  readonly timeZone: string;
  readonly clock?: Clock;
  /** F-55 fix: step back by calendar week. Default false (legacy). */
  readonly calendarWeekSteps?: boolean;
}

const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());

/** finraCompareFilterV1_ (darkPoolTrackerV1.gs:71-73). */
export function finraCompareFilter(fieldName: string, fieldValue: string): FinraCompareFilter {
  return { compareType: 'EQUAL', fieldName, fieldValue };
}

/** `new Date(year, month - 1, day)` evaluated in `timeZone` (day may overflow, as there). */
export function midnightInTz(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let t = target + 12 * 3600000;
  const w = wallClockInTz(t, timeZone);
  t += target - Date.UTC(w.year, w.month - 1, w.day);
  return startOfDayInTz(new Date(t), timeZone);
}

/** mostRecentMondayV1_ (darkPoolTrackerV1.gs:77-81): local midnight of the Monday on or before `d`. */
export function mostRecentMonday(d: Date, timeZone: string): Date {
  const w = wallClockInTz(d.getTime(), timeZone);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  const diffDays = day === 0 ? 6 : day - 1;
  return midnightInTz(w.year, w.month, w.day - diffDays, timeZone);
}

function previousCalendarMonday(monday: Date, timeZone: string): Date {
  const w = wallClockInTz(monday.getTime(), timeZone);
  return midnightInTz(w.year, w.month, w.day - 7, timeZone);
}

/**
 * A1 (fix plan 2026-10-30): FINRA answers CSV unless the request asks for
 * JSON, and every caller JSON.parses the body -- so without the header every
 * ticker came back null. Legacy sent no Accept header; it is a transport
 * header (not part of the replay key) and no parity test pins its absence,
 * so it is sent in every mode.
 */
export const FINRA_REQUEST_HEADERS: Readonly<Record<string, string>> = { Accept: 'application/json' };

export function finraPost(payload: string): HttpRequest {
  return { url: FINRA_ATS_WEEKLY_URL, method: 'POST', contentType: 'application/json', headers: FINRA_REQUEST_HEADERS, payload, muteHttpExceptions: true };
}

/** A1: a probe body counts as "published" only when it is a non-empty JSON array (a CSV or error body does not). */
export function isNonEmptyJsonArray(body: string | null | undefined): boolean {
  if (!body || !body.trim()) return false;
  try {
    const v: unknown = JSON.parse(body);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

/**
 * findLatestPublishedFinraWeekV1_ (dataLayerV1.gs:1563-1588): the newest
 * Monday (back from this week, at most 8) for which FINRA returns data for
 * the tier. Too-recent weeks answer 204; a network error just moves on.
 * A1: the body must parse as a non-empty JSON array (identical to legacy for
 * every body legacy's own data produced: JSON rows, "[]", blanks, non-200s).
 */
export async function findLatestPublishedFinraWeek(deps: FinraDeps, tierIdentifier: string): Promise<string | null> {
  let monday = mostRecentMonday(new Date(nowOf(deps)), deps.timeZone);
  for (let i = 0; i < FINRA_WEEK_PROBE_MAX_WEEKS_BACK; i++) {
    const dateStr = formatDateInTz(monday, FINRA_WEEK_DATE_TIME_ZONE);
    try {
      const resp = await deps.http.fetch(finraPost(JSON.stringify({
        compareFilters: [finraCompareFilter('weekStartDate', dateStr), finraCompareFilter('tierIdentifier', tierIdentifier)],
        limit: 1,
      })));
      if (resp.status === 200) {
        // A1: legacy accepted any non-empty body that is not "[]"; a CSV
        // answer passed that test and then failed every per-ticker parse.
        if (isNonEmptyJsonArray(resp.text())) return dateStr;
      }
    } catch {
      /* a network hiccup on this probe -- keep walking back */
    }
    monday = deps.calendarWeekSteps ? previousCalendarMonday(monday, deps.timeZone) : new Date(monday.getTime() - 7 * 86400000);
  }
  return null;
}

/**
 * fetchFinraAtsWeeklyBatchV1_ (dataLayerV1.gs:1590-1625): one query per
 * ticker, concurrently. Per ticker: the rows (an empty body is []), or null
 * for a non-200 or unparsable answer. If any request throws, every ticker is
 * re-fetched one by one, as legacy's fetchAll fallback did.
 */
export async function fetchFinraAtsWeeklyBatch(
  deps: Pick<FinraDeps, 'http'>, tickers: readonly string[] | null | undefined, tierIdentifier: string, weekStartDate: string | null | undefined,
): Promise<Record<string, FinraAtsRow[] | null>> {
  const out: Record<string, FinraAtsRow[] | null> = {};
  if (!tickers || !tickers.length || !weekStartDate) return out;
  const buildPayload = (t: string): string => JSON.stringify({
    compareFilters: [
      finraCompareFilter('issueSymbolIdentifier', t),
      finraCompareFilter('weekStartDate', weekStartDate),
      finraCompareFilter('tierIdentifier', tierIdentifier),
    ],
    limit: 50,
  });
  const settled = await Promise.allSettled(tickers.map((t) => deps.http.fetch(finraPost(buildPayload(t)))));
  if (!settled.some((s) => s.status === 'rejected')) {
    tickers.forEach((t, i) => {
      try {
        const res = (settled[i] as PromiseFulfilledResult<HttpResponse>).value;
        out[t] = res.status === 200 ? JSON.parse(res.text() || '[]') : null;
      } catch {
        out[t] = null;
      }
    });
  } else {
    for (const t of tickers) {
      try {
        const res = await deps.http.fetch(finraPost(buildPayload(t)));
        out[t] = res.status === 200 ? JSON.parse(res.text() || '[]') : null;
      } catch {
        out[t] = null;
      }
    }
  }
  return out;
}
