/**
 * SYNTHETIC SEC / State Street / FMP responses for FL-4, in the real
 * formats legacy reads (EDGAR submissions JSON, archive index.json, 13F
 * info-table XML, NPORT-P primary_doc.xml, XBRL companyconcept, full-text
 * search, company_tickers.json, a State Street holdings .xlsx). Real
 * recordings are still needed -- see the FL-4 handback.
 *
 * The .xlsx is built here by a small, independent ZIP writer (stored and
 * deflated entries, real CRC-32), and the oracle's Utilities.unzip is
 * replaced by a small, independent ZIP reader -- written separately from
 * src/net/unzip.ts so the two cross-check each other.
 */

import zlib from 'node:zlib';
import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';

export function recordedGet(url: string, status: number, body: string | Uint8Array): RecordedExchange {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return { request: { method: 'GET', url: scrubUrl(url) }, response: { status, bodyBase64: b.toString('base64') } };
}

export function submissionsBody(filings: ReadonlyArray<readonly [string, string, string]>): string {
  return JSON.stringify({ cik: 'x', filings: { recent: { form: filings.map((f) => f[0]), accessionNumber: filings.map((f) => f[1]), filingDate: filings.map((f) => f[2]) } } });
}

export function indexBody(names: readonly string[]): string {
  return JSON.stringify({ directory: { item: names.map((name) => ({ name, type: 'text.gif' })) } });
}

export interface InfoRow {
  readonly cusip?: string;
  readonly issuer?: string;
  readonly shares?: string;
  readonly value?: string;
}

export function infoTableXml(rows: readonly InfoRow[]): string {
  return '<?xml version="1.0"?><informationTable>' + rows.map((r) =>
    '<infoTable>' + (r.issuer ? '<nameOfIssuer>' + r.issuer + '</nameOfIssuer>' : '') + '<titleOfClass>COM</titleOfClass>' +
    (r.cusip ? '<cusip>' + r.cusip + '</cusip>' : '') + (r.value != null ? '<value>' + r.value + '</value>' : '') +
    '<shrsOrPrnAmt>' + (r.shares != null ? '<sshPrnamt>' + r.shares + '</sshPrnamt>' : '') + '<sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>',
  ).join('') + '</informationTable>';
}

export function nportXml(records: ReadonlyArray<readonly [string | null, string | null]>): string {
  return '<edgarSubmission><formData><invstOrSecs>' + records.map(([name, pct]) =>
    '<invstOrSec>' + (name != null ? '<name>' + name + '</name>' : '') + '<lei>x</lei>' + (pct != null ? '<pctVal>' + pct + '</pctVal>' : '') + '</invstOrSec>',
  ).join('') + '</invstOrSecs></formData></edgarSubmission>';
}

export const COMPANY_TICKERS = JSON.stringify({
  0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
  2: { cik_str: 1067839, ticker: 'QQQ', title: 'INVESCO QQQ TRUST, SERIES 1' },
  3: { cik_str: 2488, ticker: 'AMD', title: 'ADVANCED MICRO DEVICES INC' },
});

export function sharesConceptBody(points: ReadonlyArray<readonly [string, number, string]>): string {
  return JSON.stringify({ cik: 1, taxonomy: 'us-gaap', units: { shares: points.map(([end, val, filed]) => ({ end, val, filed, form: '10-Q' })) } });
}

// ── a small ZIP writer ──────────────────────────────────────────────────

export function zipBytes(entries: ReadonlyArray<readonly [string, string, 'store' | 'deflate']>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text, how] of entries) {
    const data = Buffer.from(text, 'utf8');
    const comp = how === 'deflate' ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(how === 'deflate' ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(how === 'deflate' ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, eocd]));
}

/** The oracle's Utilities.unzip: blob.getBytes() (signed bytes) -> [{getName, getDataAsString}]. */
export function gasUnzip(blob: { getBytes(): number[] }): Array<{ getName(): string; getDataAsString(): string }> {
  const buf = Buffer.from(Int8Array.from(blob.getBytes()).buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Could not unzip the blob: not a valid archive.');
  const n = buf.readUInt16LE(end + 10);
  let q = buf.readUInt32LE(end + 16);
  const files: Array<{ getName(): string; getDataAsString(): string }> = [];
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(q + 10), size = buf.readUInt32LE(q + 20), nl = buf.readUInt16LE(q + 28), xl = buf.readUInt16LE(q + 30), cl = buf.readUInt16LE(q + 32), at = buf.readUInt32LE(q + 42);
    const name = buf.subarray(q + 46, q + 46 + nl).toString('utf8');
    q += 46 + nl + xl + cl;
    const s = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const body = buf.subarray(s, s + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    if (!name.endsWith('/')) files.push({ getName: () => name, getDataAsString: () => data.toString('utf8') });
  }
  return files;
}

/** A State Street-style holdings workbook: title rows 1-4, header row 5, data from row 6, a footer. */
export function spdrXlsx(holdings: ReadonlyArray<readonly [string, string, number | null]>, opts: { deflate?: boolean; richText?: boolean; footer?: boolean; missingSheet?: boolean } = {}): Uint8Array {
  const strings: string[] = [];
  const si = (s: string): number => { const i = strings.indexOf(s); if (i >= 0) return i; strings.push(s); return strings.length - 1; };
  const cellS = (ref: string, s: string): string => '<c r="' + ref + '" t="s"><v>' + si(s) + '</v></c>';
  const cellN = (ref: string, v: number | null): string => (v == null ? '<c r="' + ref + '"/>' : '<c r="' + ref + '"><v>' + v + '</v></c>');
  const rows: string[] = [];
  rows.push('<row r="1">' + cellS('A1', 'Fund Name:') + cellS('B1', 'SPDR S&P 500 ETF Trust') + '</row>');
  rows.push('<row r="2">' + cellS('A2', 'Ticker Symbol:') + cellS('B2', 'SPY') + '</row>');
  rows.push('<row r="4">' + cellS('A4', 'Holdings:') + cellS('B4', 'As of 21-Oct-2026') + '</row>');
  rows.push('<row r="5" spans="1:8">' + ['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector', 'Shares Held', 'Local Currency'].map((h, i) => cellS(String.fromCharCode(65 + i) + '5', h)).join('') + '</row>');
  holdings.forEach(([name, ticker, w], i) => {
    const r = 6 + i;
    rows.push('<row r="' + r + '" spans="1:8">' + cellS('A' + r, name) + cellS('B' + r, ticker) + cellS('C' + r, 'ID' + i) + cellN('E' + r, w) + cellN('G' + r, 1000 * (i + 1)) + '</row>');
  });
  if (opts.footer) {
    const r = 6 + holdings.length;
    rows.push('<row r="' + r + '"/>');
    rows.push('<row r="' + (r + 1) + '">' + cellS('A' + (r + 1), 'Past performance is no guarantee of future results.') + '</row>');
  }
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>' + rows.join('') + '</sheetData></worksheet>';
  const sst = '<?xml version="1.0" encoding="UTF-8"?><sst count="' + strings.length + '">' + strings.map((s, i) => {
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return opts.richText && i % 3 === 0 ? '<si><r><rPr><b/></rPr><t xml:space="preserve">' + esc.slice(0, 2) + '</t></r><r><t>' + esc.slice(2) + '</t></r></si>' : '<si><t>' + esc + '</t></si>';
  }).join('') + '</sst>';
  const how = opts.deflate === false ? 'store' : 'deflate';
  const parts: Array<[string, string, 'store' | 'deflate']> = [['[Content_Types].xml', '<Types/>', how], ['xl/', '', 'store'], ['xl/sharedStrings.xml', sst, how]];
  if (!opts.missingSheet) parts.push(['xl/worksheets/sheet1.xml', sheet, how]);
  return zipBytes(parts);
}
