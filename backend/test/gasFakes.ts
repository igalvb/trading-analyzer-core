/**
 * Apps Script service fakes for the oracle sandbox: PropertiesService,
 * SpreadsheetApp, Session, a timezone-correct Utilities.formatDate, and a
 * replaying UrlFetchApp. Opt-in per test via withOracleGlobals -- the
 * sandbox's DEFAULT stubs (UrlFetchApp 404, getActiveSpreadsheet null) are
 * left alone, because earlier parity tests rely on them.
 *
 * ══ FIDELITY, AND WHERE IT STOPS ═══════════════════════════════════════
 * FakeProperties enforces the real 9 KB-per-value and 500 KB-total caps,
 * so legacy code's swallowed "Argument too large" path is reachable.
 * FakeSpreadsheet has two modes. 'raw' stores exactly what is written.
 * 'sheets' imitates the real coercion legacy code defends against
 * (dataLayerV1.gs:965-975): numeric strings become numbers, M/D/YYYY and
 * YYYY-MM-DD become Dates (at UTC midnight -- real Sheets uses the
 * spreadsheet's zone, an approximation disclosed here), and a string
 * starting with '=' reads back as '#ERROR!' (the documented live header
 * bug). A real-Sheet round trip is still needed (sub-plan step 2.6).
 */

import { ExchangeBook, scrubUrl } from '../src/net/http.ts';

export const GAS_PROPERTY_VALUE_LIMIT_BYTES = 9 * 1024;
export const GAS_PROPERTY_TOTAL_LIMIT_BYTES = 500 * 1024;

export class FakeProperties {
  readonly map: Map<string, string>;
  readonly enforceLimits: boolean;
  constructor(map: Map<string, string> = new Map(), enforceLimits = true) {
    this.map = map;
    this.enforceLimits = enforceLimits;
  }
  getProperty(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setProperty(key: string, value: unknown): this {
    const v = String(value);
    if (this.enforceLimits) {
      if (Buffer.byteLength(v, 'utf8') > GAS_PROPERTY_VALUE_LIMIT_BYTES) throw new Error('Argument too large: value');
      let total = Buffer.byteLength(key + v, 'utf8');
      for (const [k, x] of this.map) if (k !== key) total += Buffer.byteLength(k + x, 'utf8');
      if (total > GAS_PROPERTY_TOTAL_LIMIT_BYTES) throw new Error('You have exceeded the property storage quota.');
    }
    this.map.set(key, v);
    return this;
  }
  deleteProperty(key: string): this {
    this.map.delete(key);
    return this;
  }
  getProperties(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

export function fakePropertiesService(props: FakeProperties): { getScriptProperties(): FakeProperties } {
  return { getScriptProperties: () => props };
}

export type CellValue = string | number | boolean | Date;
export type CoercionMode = 'raw' | 'sheets';

function coerceLikeSheets(v: unknown): CellValue {
  if (typeof v !== 'string') return v as CellValue;
  if (v.startsWith('=')) return '#ERROR!';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return new Date(Date.UTC(+us[3], +us[1] - 1, +us[2]));
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  return v;
}

function copyCell(v: CellValue | undefined): CellValue {
  if (v === undefined) return '';
  return v instanceof Date ? new Date(v.getTime()) : v;
}

export class FakeRange {
  private readonly sheet: FakeSheet;
  readonly row: number;
  readonly col: number;
  readonly numRows: number;
  readonly numCols: number;
  constructor(sheet: FakeSheet, row: number, col: number, numRows: number, numCols: number) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  /** Empty cells read as '' -- Apps Script's convention. */
  getValues(): CellValue[][] {
    const out: CellValue[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < this.numCols; c++) row.push(copyCell(this.sheet.cell(this.row + r, this.col + c)));
      out.push(row);
    }
    return out;
  }
  getValue(): CellValue {
    return copyCell(this.sheet.cell(this.row, this.col));
  }
  /** Dimension mismatches throw with Apps Script's own messages. */
  setValues(values: readonly (readonly unknown[])[]): this {
    if (values.length !== this.numRows) {
      throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values.length} but the range has ${this.numRows}.`);
    }
    values.forEach((r, i) => {
      if (r.length !== this.numCols) {
        throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${r.length} but the range has ${this.numCols}.`);
      }
      r.forEach((v, j) => this.sheet.write(this.row + i, this.col + j, v));
    });
    return this;
  }
  setValue(v: unknown): this {
    this.sheet.write(this.row, this.col, v);
    return this;
  }
  clearContent(): this {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.erase(this.row + r, this.col + c);
    return this;
  }
  // Formatting is accepted and ignored: it never affects a value.
  setBackground(): this { return this; }
  setFontWeight(): this { return this; }
  setNumberFormat(): this { return this; }
  setFontColor(): this { return this; }
  setFontSize(): this { return this; }
  setWrap(): this { return this; }
  clearFormats(): this { return this; }
  setHorizontalAlignment(): this { return this; }
  setVerticalAlignment(): this { return this; }
}

export class FakeSheet {
  private name: string;
  private readonly cells = new Map<string, CellValue>();
  readonly mode: CoercionMode;
  hidden = false;
  constructor(name: string, mode: CoercionMode) {
    this.name = name;
    this.mode = mode;
  }
  cell(row: number, col: number): CellValue | undefined {
    return this.cells.get(row + ',' + col);
  }
  write(row: number, col: number, v: unknown): void {
    const value = this.mode === 'sheets' ? coerceLikeSheets(v) : (v as CellValue);
    if (value === '' || value === null || value === undefined) this.cells.delete(row + ',' + col);
    else this.cells.set(row + ',' + col, value instanceof Date ? new Date(value.getTime()) : value);
  }
  erase(row: number, col: number): void {
    this.cells.delete(row + ',' + col);
  }
  getName(): string {
    return this.name;
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  getLastRow(): number {
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0]));
    return m;
  }
  getLastColumn(): number {
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1]));
    return m;
  }
  /** Numeric form only; A1 notation throws so an unsupported call is visible. */
  getRange(row: unknown, col?: number, numRows = 1, numCols = 1): FakeRange {
    if (typeof row !== 'number') throw new Error('FakeSheet.getRange: A1 notation is not supported by this fake');
    if (!(row >= 1) || !((col ?? 0) >= 1) || !(numRows >= 1) || !(numCols >= 1)) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    return new FakeRange(this, row, col as number, numRows, numCols);
  }
  getDataRange(): FakeRange {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  clear(): this {
    this.cells.clear();
    return this;
  }
  clearContents(): this {
    this.cells.clear();
    return this;
  }
  hideSheet(): this {
    this.hidden = true;
    return this;
  }
  showSheet(): this {
    this.hidden = false;
    return this;
  }
  setTabColor(): this { return this; }
  setColumnWidths(): this { return this; }
  setFrozenRows(): this { return this; }
  activate(): this { return this; }
}

export class FakeSpreadsheet {
  private readonly sheets: FakeSheet[] = [];
  readonly mode: CoercionMode;
  constructor(mode: CoercionMode = 'raw') {
    this.mode = mode;
  }
  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((s) => s.getName() === name) ?? null;
  }
  insertSheet(name: string): FakeSheet {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const s = new FakeSheet(name, this.mode);
    this.sheets.push(s);
    return s;
  }
  deleteSheet(sheet: FakeSheet): void {
    const i = this.sheets.indexOf(sheet);
    if (i >= 0) this.sheets.splice(i, 1);
  }
  getSheets(): FakeSheet[] {
    return [...this.sheets];
  }
}

export function fakeSpreadsheetApp(ss: FakeSpreadsheet): Record<string, unknown> {
  return { getActiveSpreadsheet: () => ss, flush: () => {}, getUi: () => null };
}

export function fakeSession(scriptTimeZone: string): Record<string, unknown> {
  return { getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => scriptTimeZone };
}

/**
 * The oracle's Utilities.formatDate. A DIFFERENT implementation from
 * src/core/dates.ts on purpose (en-CA format() here, en-US formatToParts
 * there), so the two cross-check each other; hand-computed instants in the
 * FL-0 test are the ground truth for both. Like Apps Script, a non-Date
 * first argument throws.
 */
export function gasFormatDate(d: unknown, tz: unknown, pattern: unknown): string {
  if (Object.prototype.toString.call(d) !== '[object Date]') throw new TypeError('Cannot find method formatDate(' + typeof d + ',string,string).');
  if (pattern !== 'yyyy-MM-dd') throw new Error('oracle Utilities.formatDate stub: only yyyy-MM-dd is implemented (the only pattern legacy uses)');
  return new Intl.DateTimeFormat('en-CA', { timeZone: String(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d as Date);
}

interface GasFetchParams {
  readonly method?: string;
  readonly muteHttpExceptions?: boolean;
  readonly headers?: Record<string, string>;
  readonly payload?: string;
  readonly contentType?: string;
}

/**
 * A UrlFetchApp that replays recorded exchanges. Give it its OWN
 * ExchangeBook (built from the same exchanges as the port's). Unmuted
 * 4xx/5xx throw, as in Apps Script; fetchAll throws if any request throws,
 * which is what drives legacy's sequential fallback. getBytes() returns
 * signed Java-style bytes.
 */
export function replayUrlFetchApp(book: ExchangeBook): Record<string, unknown> {
  const one = (url: string, params: GasFetchParams = {}): Record<string, unknown> => {
    const r = book.next(params.method, url, params.payload);
    const bytes = Buffer.from(r.bodyBase64, 'base64');
    if (!params.muteHttpExceptions && r.status >= 400) throw new Error(`Request failed for ${scrubUrl(url)} returned code ${r.status}`);
    return {
      getResponseCode: () => r.status,
      getContentText: () => bytes.toString('utf8'),
      getBlob: () => ({
        getBytes: () => Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)),
        getDataAsString: () => bytes.toString('utf8'),
      }),
      getHeaders: () => ({ ...(r.headers ?? {}) }),
      getAllHeaders: () => ({ ...(r.headers ?? {}) }),
    };
  };
  return {
    fetch: one,
    fetchAll: (reqs: Array<string | (GasFetchParams & { url: string })>) =>
      reqs.map((q) => (typeof q === 'string' ? one(q) : one(q.url, q))),
  };
}
