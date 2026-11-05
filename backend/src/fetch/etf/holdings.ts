/**
 * ETF top-10 holdings, ported exactly:
 *   dataLayerV1.gs fetchSpdrEtfTopHoldingsV1 :1317-1334 -- State Street's daily holdings .xlsx
 *   dataLayerV1.gs fetchQqqTopHoldingsV1     :1336-1382 -- QQQ's latest SEC NPORT-P filing
 *   brokerCourseModelV1.gs SPDR_ETF_TICKERS_V1 :1523, parseSpdrSharedStringsV1_ :1525-1532,
 *     spdrCellValueV1_ :1533-1538, parseSpdrHoldingsV1_ :1542-1559
 *
 * The .xlsx is unzipped by net/unzip.ts (Utilities.unzip's replacement).
 * SPY and the 11 sector SPDRs only; QQQ only via NPORT-P (cached 30 days,
 * 'QQQ_NPORT_HOLDINGS_V1'). Every failure is null, as in legacy.
 */

import type { HttpClient } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import { unzip } from '../../net/unzip.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../../storage/kv.ts';
import { fetchSecEdgarCIK, SEC_BROKER_COURSE_UA, nowOf } from '../sec/edgar.ts';

/** brokerCourseModelV1.gs:1523. */
export const SPDR_ETF_TICKERS: readonly string[] = ['SPY', 'XLK', 'XLF', 'XLE', 'XLV', 'XLP', 'XLY', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'];
export const QQQ_NPORT_CACHE_KEY = 'QQQ_NPORT_HOLDINGS_V1';
/** legacy: 24 * 30 hours -- NPORT-P is filed quarterly. */
export const QQQ_NPORT_CACHE_TTL_HOURS = 24 * 30;

export interface SpdrHolding {
  readonly name: unknown;
  readonly ticker: unknown;
  readonly weightPct: any;
}

export interface EtfHoldings<H> {
  readonly holdings: H[];
  readonly top10ConcentrationPct: number;
  readonly filingDate?: string;
}

/** parseSpdrSharedStringsV1_ (:1525-1532): the shared-string table, rich-text runs joined, entities decoded. */
export function parseSpdrSharedStrings(xml: string): string[] {
  const sis = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
  return sis.map((si) => {
    const ts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    return ts.map((t) => t.replace(/<[^>]*>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  });
}

/** spdrCellValueV1_ (:1533-1538): a shared string for t="s" cells, else parseFloat; null without <v>. */
export function spdrCellValue(cellXml: string, sharedStrings: readonly string[]): string | number | null {
  const isString = /t="s"/.test(cellXml);
  const vMatch = cellXml.match(/<v>([^<]*)<\/v>/);
  if (!vMatch) return null;
  return isString ? sharedStrings[parseInt(vMatch[1], 10)] : parseFloat(vMatch[1]);
}

/** parseSpdrHoldingsV1_ (:1542-1559): data from row 6; name A, ticker B, weight E; the first `topN`. */
export function parseSpdrHoldings(sheetXml: string, sharedStrings: readonly string[], topN: number): SpdrHolding[] {
  const rows = sheetXml.match(/<row r="\d+"[^>]*>[\s\S]*?<\/row>/g) || [];
  const holdings: SpdrHolding[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNum = parseInt((rows[i].match(/<row r="(\d+)"/) || [])[1], 10);
    if (rowNum < 6) continue;
    const cells = rows[i].match(/<c r="[A-Z]+\d+"[^>]*\/?>(?:[\s\S]*?<\/c>)?/g) || [];
    const byCol: Record<string, string | number | null | undefined> = {};
    cells.forEach((c) => {
      const col = (c.match(/<c r="([A-Z]+)\d+"/) || [])[1];
      byCol[col as string] = spdrCellValue(c, sharedStrings);
    });
    if (byCol.A == null || byCol.B == null) continue;
    holdings.push({ name: byCol.A, ticker: byCol.B, weightPct: byCol.E });
    if (holdings.length >= topN) break;
  }
  return holdings;
}

export function spdrHoldingsUrl(ticker: string): string {
  return 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-' + ticker.toLowerCase() + '.xlsx';
}

/** fetchSpdrEtfTopHoldingsV1 (:1317-1334). */
export async function fetchSpdrEtfTopHoldings(deps: { readonly http: HttpClient }, ticker: string): Promise<EtfHoldings<SpdrHolding> | null> {
  if (SPDR_ETF_TICKERS.indexOf(ticker) < 0) return null;
  try {
    const resp = await deps.http.fetch({ url: spdrHoldingsUrl(ticker), headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
    if (resp.status !== 200) return null;
    const files = unzip(resp.bytes());
    const sharedStringsFile = files.filter((f) => f.name.indexOf('sharedStrings.xml') >= 0)[0];
    const sheetFile = files.filter((f) => f.name.indexOf('worksheets/sheet1.xml') >= 0)[0];
    if (!sharedStringsFile || !sheetFile) return null;
    const sharedStrings = parseSpdrSharedStrings(sharedStringsFile.text());
    const holdings = parseSpdrHoldings(sheetFile.text(), sharedStrings, 10);
    if (!holdings.length) return null;
    const totalWeight = holdings.reduce((s, h) => s + h.weightPct, 0);
    return { holdings, top10ConcentrationPct: totalWeight };
  } catch {
    return null;
  }
}

export interface NportHolding {
  readonly name: string;
  readonly weightPct: number;
}

/**
 * fetchQqqTopHoldingsV1 (:1336-1382): QQQ's CIK, its newest NPORT-P, that
 * filing's primary_doc.xml; positions summed by issuer name (multi-class
 * issuers combine), the top 10 by weight. Cached 30 days.
 */
export async function fetchQqqTopHoldings(deps: { readonly http: HttpClient; readonly kv: PropertyStore; readonly clock?: Clock }, ticker: string): Promise<EtfHoldings<NportHolding> | null> {
  if (ticker !== 'QQQ') return null;
  const cached = await cacheGet<EtfHoldings<NportHolding>>(deps.kv, QQQ_NPORT_CACHE_KEY, nowOf(deps));
  if (cached !== null && cached !== undefined) return cached;
  try {
    const cik = await fetchSecEdgarCIK(deps, 'QQQ');
    if (!cik) return null;
    const subRes = await deps.http.fetch({ url: 'https://data.sec.gov/submissions/CIK' + cik + '.json', headers: { 'User-Agent': SEC_BROKER_COURSE_UA }, muteHttpExceptions: true });
    if (subRes.status !== 200) return null;
    const sub = JSON.parse(subRes.text());
    const recent = sub.filings && sub.filings.recent;
    if (!recent || !recent.form) return null;
    let accession: string | null = null;
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === 'NPORT-P') { accession = recent.accessionNumber[i]; break; }
    }
    if (!accession) return null;
    const accessionNoDash = accession.replace(/-/g, '');
    const cikNoLeadingZeros = String(parseInt(cik, 10));
    const docUrl = 'https://www.sec.gov/Archives/edgar/data/' + cikNoLeadingZeros + '/' + accessionNoDash + '/primary_doc.xml';
    const docRes = await deps.http.fetch({ url: docUrl, headers: { 'User-Agent': SEC_BROKER_COURSE_UA }, muteHttpExceptions: true });
    if (docRes.status !== 200) return null;
    const xml = docRes.text();
    const recs = xml.match(/<invstOrSec>[\s\S]*?<\/invstOrSec>/g) || [];
    const byName: Record<string, number> = {};
    recs.forEach((r) => {
      const nameM = r.match(/<name>([\s\S]*?)<\/name>/);
      const pctM = r.match(/<pctVal>([\s\S]*?)<\/pctVal>/);
      if (!nameM || !pctM) return;
      const name = nameM[1].trim();
      const pct = parseFloat(pctM[1]);
      if (!Number.isFinite(pct)) return;
      byName[name] = (byName[name] || 0) + pct;
    });
    const holdings = Object.keys(byName).map((name) => ({ name, weightPct: byName[name] }))
      .sort((a, b) => b.weightPct - a.weightPct)
      .slice(0, 10);
    if (!holdings.length) return null;
    const totalWeight = holdings.reduce((s, h) => s + h.weightPct, 0);
    const result = { holdings, top10ConcentrationPct: totalWeight, filingDate: recent.filingDate[recent.accessionNumber.indexOf(accession)] };
    await cacheSet(deps.kv, QQQ_NPORT_CACHE_KEY, result, QQQ_NPORT_CACHE_TTL_HOURS, nowOf(deps));
    return result;
  } catch {
    return null;
  }
}
