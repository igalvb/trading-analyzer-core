/**
 * Institutional 13F holdings, ported exactly:
 *   dataLayerV1.gs fetch13FCusipV7 :676-689, fetch13FInfoTableUrlV7_ :691-701,
 *     fetch13FSingleCikV7_ :703-727, fetch13FForFilerV7_ :729-733,
 *     fetch13FBatchedV1_ :743-850, fetchInstitutional13FHoldingsV7 :852-893,
 *     expected13FQuarterTagV1_ :895-910, read13FCacheV1_ :912-929, write13FCacheV1_ :931-950
 *   fullStockAnalysisV10_9.gs INSTITUTIONAL_13F_FILERS_V7 :8512-8517,
 *     parse13FInfoTableV7_ :8533-8557, sum13FPerCikResultsV1_ :8568-8583,
 *     CACHE_13F_SHEET_NAME_V1 :8640
 * fetchAllOrSequentialV1_ (:735-741) is HttpClient.fetchAll (FL-0).
 *
 * fetch13FSingleCikV7_ / fetch13FForFilerV7_ are legacy's unused sequential
 * path; ported anyway. The live path is fetch13FBatched: three concurrent
 * rounds (submissions -> index.json -> info-table XML) over every filer CIK.
 *
 * The cache rule is legacy's: the result is cached per CUSIP under the
 * currently expected 13F quarter, and only when SEC answered at least one
 * submissions request AND (there was nothing further to fetch OR at least
 * one info-table download succeeded) -- so a transient SEC outage never
 * poisons a quarter's cache.
 *
 * '💾 13F Cache' keeps legacy's one-row-per-CUSIP upsert. The Phase-1 plan
 * marks it "append-only history" (Tabs.INSTITUTIONAL_HISTORY); unchanged
 * here, pending the user (same decision as F-46).
 */

import type { HttpClient, HttpResponse } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { Tabs } from '../../sheets/tabs.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../../storage/kv.ts';
import { isKnownFmp402, noteFmp402 } from '../fundamentals/providers.ts';
import type { TabStore } from '../../storage/tabStore.ts';
import { SEC_13F_UA, IDENTIFIER_CACHE_TTL_HOURS, nowOf } from './edgar.ts';

/** fullStockAnalysisV10_9.gs:8512-8517: filer -> CIK, or several CIKs summed. */
export const INSTITUTIONAL_13F_FILERS: Readonly<Record<string, string | readonly string[]>> = {
  'Berkshire Hathaway': '1067983',
  'BlackRock': '2012383',
  'State Street': '93751',
  'Vanguard': ['947529', '1680208', '2100119', '933478', '1811242', '1550100'],
};

export const THIRTEEN_F_CACHE_HEADER: readonly string[] = ['CUSIP', 'QuarterTag', 'LastFetched', 'JSON'];

export interface ThirteenFHolding {
  issuer: string | undefined;
  shares: number;
  value: number;
}

export interface ThirteenFEntry {
  readonly date: string;
  readonly holdings: ThirteenFHolding | null;
}

export interface ThirteenFPair {
  latest: ThirteenFEntry | null;
  prior: ThirteenFEntry | null;
}

export type ThirteenFByFiler = Record<string, ThirteenFPair>;

export interface ThirteenFDeps {
  readonly http: HttpClient;
  readonly kv: PropertyStore;
  readonly store: TabStore;
  readonly fmpKey: string;
  readonly clock?: Clock;
  /** Fix 2026-11-04: honour / record the remembered FMP 402s (key 'profile', shared with fetchFMPFundamentals). Unset = legacy. */
  readonly fmp402Memory?: boolean;
}

const SEC_HEADERS = { 'User-Agent': SEC_13F_UA };
const submissionsUrl = (cik: string): string => 'https://data.sec.gov/submissions/CIK' + ('0000000000' + cik).slice(-10) + '.json';
const archiveBase = (cik: string, accession: string): string => 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accession.replace(/-/g, '') + '/';
const isInfoTable = (name: string): boolean => name.indexOf('.xml') === name.length - 4 && name !== 'primary_doc.xml';

/** parse13FInfoTableV7_ (fullStockAnalysisV10_9.gs:8533-8557): CUSIP -> summed position (value in whole dollars). */
export function parse13FInfoTable(xml: string): Record<string, ThirteenFHolding> {
  const holdings: Record<string, ThirteenFHolding> = {};
  const re = /<infoTable>([\s\S]*?)<\/infoTable>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const cusip = (block.match(/<cusip>([^<]+)<\/cusip>/) || [])[1];
    const issuer = (block.match(/<nameOfIssuer>([^<]+)<\/nameOfIssuer>/) || [])[1];
    const shares = parseInt((block.match(/<sshPrnamt>([^<]+)<\/sshPrnamt>/) || [])[1] || '0', 10);
    const value = parseInt((block.match(/<value>([^<]+)<\/value>/) || [])[1] || '0', 10);
    if (!cusip) continue;
    if (!holdings[cusip]) holdings[cusip] = { issuer, shares: 0, value: 0 };
    holdings[cusip].shares += shares;
    holdings[cusip].value += value;
  }
  return holdings;
}

/** sum13FPerCikResultsV1_ (fullStockAnalysisV10_9.gs:8568-8583): shares and value summed across CIKs; the first date found. */
export function sum13FPerCikResults(perCik: ReadonlyArray<ThirteenFPair | null | undefined>): ThirteenFPair {
  const result: ThirteenFPair = { latest: null, prior: null };
  (['latest', 'prior'] as const).forEach((label) => {
    let summed: ThirteenFHolding | null = null;
    let date: string | null = null;
    perCik.forEach((r) => {
      const entry = r && r[label];
      if (!entry || !entry.holdings) return;
      if (!summed) summed = { issuer: entry.holdings.issuer, shares: 0, value: 0 };
      summed.shares += entry.holdings.shares;
      summed.value += entry.holdings.value;
      date = date || entry.date;
    });
    if (summed) result[label] = { date: date as unknown as string, holdings: summed };
  });
  return result;
}

/** fetch13FCusipV7 (:676-689): FMP profile's cusip, cached 90 days; a failed lookup is NOT cached. */
export async function fetch13FCusip(deps: Pick<ThirteenFDeps, 'http' | 'kv' | 'fmpKey' | 'clock' | 'fmp402Memory'>, ticker: string): Promise<string | null> {
  const cacheKey = 'CUSIP_' + String(ticker).toUpperCase();
  const cached = await cacheGet<string>(deps.kv, cacheKey, nowOf(deps));
  if (cached !== null && cached !== undefined) return cached;
  try {
    if (deps.fmp402Memory && await isKnownFmp402(deps.kv, 'profile', ticker, nowOf(deps))) return null;
    const url = 'https://financialmodelingprep.com/stable/profile?symbol=' + encodeURIComponent(ticker) + '&apikey=' + deps.fmpKey;
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (resp.status === 402 && deps.fmp402Memory) await noteFmp402(deps.kv, 'profile', ticker, nowOf(deps));
    if (resp.status !== 200) return null;
    const j = JSON.parse(resp.text());
    const result = (j && j[0] && j[0].cusip) || null;
    if (result) await cacheSet(deps.kv, cacheKey, result, IDENTIFIER_CACHE_TTL_HOURS, nowOf(deps));
    return result;
  } catch {
    return null;
  }
}

/** fetch13FInfoTableUrlV7_ (:691-701). No try: a failure throws to the caller, as in legacy. */
export async function fetch13FInfoTableUrl(deps: Pick<ThirteenFDeps, 'http'>, cik: string, accession: string): Promise<string | null> {
  const resp = await deps.http.fetch({ url: archiveBase(cik, accession) + 'index.json', headers: SEC_HEADERS, muteHttpExceptions: true });
  if (resp.status !== 200) return null;
  const idx = JSON.parse(resp.text());
  const items: Array<{ name: string }> = (idx.directory && idx.directory.item) || [];
  const infoTable = items.find((i) => isInfoTable(i.name));
  if (!infoTable) return null;
  return archiveBase(cik, accession) + infoTable.name;
}

/** The first two 13F-HR filings in a submissions document (latest first). */
function first13FAccessions(sub: any): Array<{ accession: string; date: string }> {
  const r = sub.filings.recent;
  const found: Array<{ accession: string; date: string }> = [];
  for (let j = 0; j < r.form.length && found.length < 2; j++) {
    if (r.form[j] === '13F-HR') found.push({ accession: r.accessionNumber[j], date: r.filingDate[j] });
  }
  return found;
}

/** fetch13FSingleCikV7_ (:703-727): one filer CIK's latest and prior position, sequentially. */
export async function fetch13FSingleCik(deps: Pick<ThirteenFDeps, 'http'>, cik: string, cusip: string | null): Promise<ThirteenFPair> {
  try {
    const subResp = await deps.http.fetch({ url: submissionsUrl(cik), headers: SEC_HEADERS, muteHttpExceptions: true });
    if (subResp.status !== 200) return { latest: null, prior: null };
    const accessions = first13FAccessions(JSON.parse(subResp.text()));
    const result: ThirteenFPair = { latest: null, prior: null };
    const labels = ['latest', 'prior'] as const;
    for (let idx = 0; idx < labels.length; idx++) {
      const acc = accessions[idx];
      if (!acc) continue;
      const url = await fetch13FInfoTableUrl(deps, cik, acc.accession);
      if (!url) continue;
      const xmlResp = await deps.http.fetch({ url, headers: SEC_HEADERS, muteHttpExceptions: true });
      if (xmlResp.status !== 200) continue;
      const holdingsMap = parse13FInfoTable(xmlResp.text());
      result[labels[idx]] = { date: acc.date, holdings: holdingsMap[cusip as string] || null };
    }
    return result;
  } catch {
    return { latest: null, prior: null };
  }
}

/** fetch13FForFilerV7_ (:729-733). */
export async function fetch13FForFiler(deps: Pick<ThirteenFDeps, 'http'>, cikOrCiks: string | readonly string[], cusip: string | null): Promise<ThirteenFPair> {
  const ciks = Array.isArray(cikOrCiks) ? cikOrCiks : [cikOrCiks as string];
  const perCik: ThirteenFPair[] = [];
  for (const cik of ciks) perCik.push(await fetch13FSingleCik(deps, cik, cusip));
  return sum13FPerCikResults(perCik);
}

export interface BatchedMeta {
  readonly safeToCache: boolean;
}

/** fetch13FBatchedV1_ (:743-850): per CIK {latest, prior}, plus `__meta.safeToCache`. */
export async function fetch13FBatched(deps: Pick<ThirteenFDeps, 'http'>, cikList: readonly string[], cusip: string | null): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  cikList.forEach((cik) => { result[cik] = { latest: null, prior: null }; });
  if (!cikList.length) return result;

  const subResps = await deps.http.fetchAll(cikList.map((cik) => ({ url: submissionsUrl(cik), headers: SEC_HEADERS, muteHttpExceptions: true })));

  let anySubmissionsSuccess = false;
  const accessionsByCik: Record<string, Array<{ label: 'latest' | 'prior'; accession: string; date: string }>> = {};
  cikList.forEach((cik, i) => {
    accessionsByCik[cik] = [];
    const resp = subResps[i];
    if (!resp) return;
    try {
      if (resp.status !== 200) return;
      anySubmissionsSuccess = true;
      const found = first13FAccessions(JSON.parse(resp.text()));
      (['latest', 'prior'] as const).forEach((label, idx) => {
        if (found[idx]) accessionsByCik[cik].push({ label, accession: found[idx].accession, date: found[idx].date });
      });
    } catch {
      /* a malformed submissions response leaves this CIK with 0 accessions */
    }
  });

  const idxEntries: Array<{ cik: string; label: 'latest' | 'prior'; accession: string; date: string }> = [];
  cikList.forEach((cik) => { accessionsByCik[cik].forEach((a) => idxEntries.push({ cik, label: a.label, accession: a.accession, date: a.date })); });
  const idxResps = await deps.http.fetchAll(idxEntries.map((e) => ({ url: archiveBase(e.cik, e.accession) + 'index.json', headers: SEC_HEADERS, muteHttpExceptions: true })));

  const dataEntries: Array<{ cik: string; label: 'latest' | 'prior'; date: string; dataUrl: string }> = [];
  idxEntries.forEach((e, i) => {
    const resp = idxResps[i];
    if (!resp) return;
    try {
      if (resp.status !== 200) return;
      const idx = JSON.parse(resp.text());
      const items: Array<{ name: string }> = (idx.directory && idx.directory.item) || [];
      const infoTable = items.find((it) => isInfoTable(it.name));
      if (!infoTable) return;
      dataEntries.push({ cik: e.cik, label: e.label, date: e.date, dataUrl: archiveBase(e.cik, e.accession) + infoTable.name });
    } catch {
      /* a malformed index.json leaves this label unresolved */
    }
  });

  const dataResps = await deps.http.fetchAll(dataEntries.map((e) => ({ url: e.dataUrl, headers: SEC_HEADERS, muteHttpExceptions: true })));

  let anyDataFetchSuccess = false;
  dataEntries.forEach((e, i) => {
    const resp: HttpResponse | null = dataResps[i];
    if (!resp) return;
    try {
      if (resp.status !== 200) return;
      anyDataFetchSuccess = true;
      const holdingsMap = parse13FInfoTable(resp.text());
      result[e.cik][e.label] = { date: e.date, holdings: holdingsMap[cusip as string] || null };
    } catch {
      /* a malformed XML leaves this label null */
    }
  });

  result.__meta = { safeToCache: anySubmissionsSuccess && (dataEntries.length === 0 || anyDataFetchSuccess) } satisfies BatchedMeta;
  return result;
}

/**
 * expected13FQuarterTagV1_ (:895-910): the newest calendar quarter whose
 * 45-day 13F filing deadline has passed at `now`, e.g. '2026Q2'.
 */
export function expected13FQuarterTag(now: Date): string | null {
  const year = now.getUTCFullYear();
  const FILING_LAG_DAYS = 45;
  const candidates: Array<{ qEnd: Date; tag: string }> = [];
  [year - 1, year].forEach((y) => {
    ([[2, 31, 1], [5, 30, 2], [8, 30, 3], [11, 31, 4]] as const).forEach(([month, day, q]) => {
      const qEnd = new Date(Date.UTC(y, month, day));
      const deadline = new Date(qEnd.getTime() + FILING_LAG_DAYS * 86400000);
      if (deadline.getTime() <= now.getTime()) candidates.push({ qEnd, tag: y + 'Q' + q });
    });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.qEnd.getTime() - a.qEnd.getTime());
  return candidates[0].tag;
}

export interface ThirteenFCacheRow {
  readonly quarterTag: unknown;
  readonly lastFetched: unknown;
  readonly data: ThirteenFByFiler;
}

/** read13FCacheV1_ (:912-929): the CUSIP's row; a malformed JSON cell is a miss. */
export async function read13FCache(store: TabStore, cusip: string | null): Promise<ThirteenFCacheRow | null> {
  try {
    const rows = await store.read(Tabs.INSTITUTIONAL_HISTORY, 4, [2]);
    if (!rows) return null;
    if (rows.length < 2) return null;
    const data = rows.slice(1);
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(cusip)) {
        let parsed: ThirteenFByFiler;
        try { parsed = JSON.parse(data[i][3] as string); } catch { return null; }
        return { quarterTag: data[i][1], lastFetched: data[i][2], data: parsed };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** write13FCacheV1_ (:931-950): upsert the CUSIP's row. */
export async function write13FCache(store: TabStore, cusip: string | null, quarterTag: string | null, data: ThirteenFByFiler, now: Date): Promise<void> {
  try {
    const tab = Tabs.INSTITUTIONAL_HISTORY;
    if (await store.ensure(tab)) await store.write(tab, 1, [[...THIRTEEN_F_CACHE_HEADER]], { header: true });
    const firstCol = (await store.read(tab, 1)) ?? [];
    const lastRow = firstCol.length;
    let targetRow: number | null = null;
    if (lastRow >= 2) {
      for (let i = 1; i < firstCol.length; i++) {
        if (String(firstCol[i][0]) === String(cusip)) { targetRow = i + 1; break; }
      }
    }
    if (!targetRow) targetRow = lastRow + 1;
    await store.write(tab, targetRow, [[String(cusip), quarterTag as string, now.toISOString(), JSON.stringify(data)]]);
  } catch {
    /* non-fatal -- caching is supplementary */
  }
}

/** fetchInstitutional13FHoldingsV7 (:852-893): per filer, cached per CUSIP and expected quarter. */
export async function fetchInstitutional13FHoldings(deps: ThirteenFDeps, cusip: string | null): Promise<ThirteenFByFiler> {
  const now = new Date(nowOf(deps));
  const expectedTag = expected13FQuarterTag(now);
  const cached = await read13FCache(deps.store, cusip);
  if (cached && expectedTag && cached.quarterTag === expectedTag) return cached.data;

  const cikToFilers: Record<string, string[]> = {};
  Object.keys(INSTITUTIONAL_13F_FILERS).forEach((name) => {
    const v = INSTITUTIONAL_13F_FILERS[name];
    const ciks = Array.isArray(v) ? v : [v as string];
    ciks.forEach((cik) => { (cikToFilers[cik] = cikToFilers[cik] || []).push(name); });
  });
  const allCiks = Object.keys(cikToFilers);
  const perCikResults = await fetch13FBatched(deps, allCiks, cusip);
  const safeToCache = perCikResults.__meta ? perCikResults.__meta.safeToCache : true;
  delete perCikResults.__meta;

  const out: ThirteenFByFiler = {};
  Object.keys(INSTITUTIONAL_13F_FILERS).forEach((name) => {
    const v = INSTITUTIONAL_13F_FILERS[name];
    const ciks = Array.isArray(v) ? v : [v as string];
    out[name] = sum13FPerCikResults(ciks.map((cik) => perCikResults[cik] || { latest: null, prior: null }));
  });
  if (safeToCache) await write13FCache(deps.store, cusip, expectedTag, out, now);
  return out;
}
