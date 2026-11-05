/**
 * James — Quality Gate (docs/models/plans/10-quality-gate-8-step-ackman.md, section 5): SEC XBRL "company facts" with
 * their FILING dates, read point-in-time. `data.sec.gov/api/xbrl/companyfacts/CIK##########.json` holds every value a
 * company reported, each with `filed` (the day it became public), `form`, and the period (`start` / `end`). A value can
 * be restated by a later filing; `factsAsOf` keeps, for each period, the FIRST filing on or before the day asked, so a
 * restatement is never visible before its own filing date (no lookahead).
 *
 * `fetchSharesOutstandingHistory` (edgar.ts) is not changed: it feeds an existing model and keeps the latest-filed
 * value per period (restated data), which is why the quality gate does not use it.
 */

import type { HttpClient } from '../../net/http.ts';
import { SEC_BROKER_COURSE_UA } from './edgar.ts';

/** One reported value (the SEC's own field names). Duration facts have `start`; instant facts (shares on a date) do not. */
export interface FactEntry {
  readonly start?: string; readonly end: string; readonly val: number; readonly filed: string;
  readonly form?: string; readonly fy?: number; readonly fp?: string;
}
/** concept name (us-gaap or dei) -> its entries, one unit each (USD for money, shares for share counts). */
export type CompanyFacts = Readonly<Record<string, readonly FactEntry[]>>;

/** Revenue tags, in order of preference (tag names changed over the years: ASC 606 from 2018). */
export const REVENUE_TAGS: readonly string[] = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet'];
export const COST_TAGS: readonly string[] = ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'];
export const GROSS_PROFIT_TAG = 'GrossProfit';
export const DILUTED_SHARES_TAG = 'WeightedAverageNumberOfDilutedSharesOutstanding';
export const COVER_SHARES_TAG = 'EntityCommonStockSharesOutstanding';
/** The concepts the download keeps (the full company-facts file is several MB per company). */
export const KEPT_CONCEPTS: readonly string[] = [...REVENUE_TAGS, ...COST_TAGS, GROSS_PROFIT_TAG, DILUTED_SHARES_TAG, COVER_SHARES_TAG];

/** The kept concepts of a raw company-facts JSON (`facts.us-gaap.X.units.USD` / `.shares`), entries without a filing date dropped. */
export function parseCompanyFacts(raw: unknown): CompanyFacts {
  const out: Record<string, FactEntry[]> = {};
  const facts = (raw as { facts?: Record<string, Record<string, { units?: Record<string, unknown[]> }>> } | null)?.facts ?? {};
  for (const ns of Object.values(facts)) {
    for (const [concept, body] of Object.entries(ns ?? {})) {
      if (!KEPT_CONCEPTS.includes(concept)) continue;
      const units = body?.units ?? {};
      const list = (units['USD'] ?? units['shares'] ?? []) as Array<Record<string, unknown>>;
      const kept: FactEntry[] = [];
      for (const e of list) {
        const val = e['val'], end = e['end'], filed = e['filed'];
        if (typeof val !== 'number' || !Number.isFinite(val) || typeof end !== 'string' || typeof filed !== 'string') continue;
        kept.push({ end, val, filed, ...(typeof e['start'] === 'string' ? { start: e['start'] } : {}), ...(typeof e['form'] === 'string' ? { form: e['form'] } : {}), ...(typeof e['fy'] === 'number' ? { fy: e['fy'] } : {}), ...(typeof e['fp'] === 'string' ? { fp: e['fp'] } : {}) });
      }
      if (kept.length) out[concept] = [...(out[concept] ?? []), ...kept];
    }
  }
  return out;
}

/** One company's facts from the SEC (the HTTP client applies SEC's user-agent policy); null on any failure. */
export async function fetchCompanyFacts(deps: { readonly http: HttpClient }, cik: string): Promise<CompanyFacts | null> {
  try {
    const res = await deps.http.fetch({ url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK' + cik + '.json', headers: { 'User-Agent': SEC_BROKER_COURSE_UA }, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    return parseCompanyFacts(JSON.parse(res.text()));
  } catch {
    return null;
  }
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const periodKey = (e: FactEntry): string => (e.start ?? '') + '|' + e.end;

/**
 * Point-in-time view: for each period of `entries`, the FIRST filing dated on or before `day` (later restatements of
 * that period stay invisible until their own filing date). Sorted by period end.
 */
export function factsAsOf(entries: readonly FactEntry[] | undefined, day: string): FactEntry[] {
  const first = new Map<string, FactEntry>();
  for (const e of entries ?? []) {
    if (e.filed > day) continue;
    const k = periodKey(e), cur = first.get(k);
    if (!cur || e.filed < cur.filed) first.set(k, e);
  }
  return [...first.values()].sort((a, b) => a.end.localeCompare(b.end) || (a.start ?? '').localeCompare(b.start ?? ''));
}

/** A merged duration concept: per period the value of the first tag (in `tags` order) that has it, point-in-time. */
function mergedAsOf(facts: CompanyFacts, tags: readonly string[], day: string): FactEntry[] {
  const byPeriod = new Map<string, FactEntry>();
  for (const tag of tags) for (const e of factsAsOf(facts[tag], day)) if (e.start && !byPeriod.has(periodKey(e))) byPeriod.set(periodKey(e), e);
  return [...byPeriod.values()].sort((a, b) => a.end.localeCompare(b.end));
}

const isQuarter = (e: FactEntry): boolean => !!e.start && daysBetween(e.start, e.end) >= 80 && daysBetween(e.start, e.end) <= 100;
const isYear = (e: FactEntry): boolean => !!e.start && daysBetween(e.start, e.end) >= 350 && daysBetween(e.start, e.end) <= 380;

/**
 * Discrete quarters from mixed 10-Q / 10-K data: the 3-month values as filed, and each fiscal Q4 as the annual value
 * minus the three quarters inside that year (a 10-K reports only the year). Keyed by quarter end, oldest first.
 */
export function quartersOf(rows: readonly FactEntry[]): Array<{ end: string; val: number }> {
  const q = new Map<string, number>();
  for (const e of rows) if (isQuarter(e)) q.set(e.end, e.val);
  for (const y of rows) {
    if (!isYear(y) || q.has(y.end)) continue;
    const inside = [...q.entries()].filter(([end]) => end > (y.start as string) && end < y.end && daysBetween(end, y.end) <= 300);
    if (inside.length === 3) q.set(y.end, y.val - inside.reduce((a, [, v]) => a + v, 0));
  }
  return [...q.entries()].map(([end, val]) => ({ end, val })).sort((a, b) => a.end.localeCompare(b.end));
}

/** The sum of the 4 consecutive quarters ending at quarter `k` (each 75-105 days apart, ~one year in all); null when a quarter is missing. */
function sum4(qs: ReadonlyArray<{ end: string; val: number }>, k: number): number | null {
  if (k < 3) return null;
  for (let j = k - 2; j <= k; j++) { const g = daysBetween(qs[j - 1]!.end, qs[j]!.end); if (g < 75 || g > 105) return null; }
  return qs[k - 3]!.val + qs[k - 2]!.val + qs[k - 1]!.val + qs[k]!.val;
}

/** Trailing-4-quarter value now and a year earlier (the quarter ending 350-380 days before), point-in-time on `day`. */
export interface Ttm { readonly end: string; readonly now: number; readonly yearAgo: number | null; readonly filed: string }
function ttmOf(rows: readonly FactEntry[]): Ttm | null {
  const qs = quartersOf(rows);
  for (let k = qs.length - 1; k >= 3; k--) {
    const now = sum4(qs, k);
    if (now == null) continue;
    const j = qs.findIndex((x) => { const g = daysBetween(x.end, qs[k]!.end); return g >= 350 && g <= 380; });
    const filed = rows.filter((e) => e.end <= qs[k]!.end).reduce((a, e) => (e.end === qs[k]!.end && e.filed > a ? e.filed : a), '');
    return { end: qs[k]!.end, now, yearAgo: j >= 0 ? sum4(qs, j) : null, filed };
  }
  return null;
}

/** What the quality gate reads from the filings on one day (point-in-time; null = not known that day). */
export interface PitFundamentals {
  readonly revenueTtm: number | null; readonly revenueGrowth: number | null;
  readonly grossMargin: number | null;
  readonly dilutedShares: number | null; readonly dilution: number | null;
  /** The last quarter end the numbers cover, and the filing that made it public. */
  readonly periodEnd: string | null; readonly filed: string | null;
}

/** The facts the gate needs, as they were known on `day`. */
export function fundamentalsAsOf(facts: CompanyFacts, day: string): PitFundamentals {
  const rev = mergedAsOf(facts, REVENUE_TAGS, day);
  const r = ttmOf(rev);
  // gross profit: GrossProfit, else revenue minus the cost of revenue (per period)
  let gpRows = factsAsOf(facts[GROSS_PROFIT_TAG], day).filter((e) => !!e.start);
  if (!gpRows.length) {
    const cost = mergedAsOf(facts, COST_TAGS, day), revBy = new Map(rev.map((e) => [periodKey(e), e]));
    gpRows = cost.flatMap((c) => { const v = revBy.get(periodKey(c)); return v ? [{ ...c, val: v.val - c.val }] : []; });
  }
  const g = ttmOf(gpRows);
  const sh = factsAsOf(facts[DILUTED_SHARES_TAG], day).filter(isQuarter);
  const last = sh[sh.length - 1], prev = last ? sh.find((x) => { const d = daysBetween(x.end, last.end); return d >= 350 && d <= 380; }) : undefined;
  return {
    revenueTtm: r?.now ?? null,
    revenueGrowth: r && r.yearAgo != null && r.yearAgo > 0 ? r.now / r.yearAgo - 1 : null,
    grossMargin: g && r && g.end === r.end && r.now > 0 ? g.now / r.now : null,
    dilutedShares: last?.val ?? null,
    dilution: last && prev && prev.val > 0 ? last.val / prev.val - 1 : null,
    periodEnd: r?.end ?? null, filed: r?.filed || null,
  };
}
