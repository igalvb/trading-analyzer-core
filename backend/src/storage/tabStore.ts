/**
 * A minimal tab-grid store for the small Sheet-backed caches legacy wrote
 * through SpreadsheetApp: the per-ticker macro price tabs ('💾 Macro ' +
 * ticker), '💾 Macro Snapshot' and '💾 Broker Data Cache'. Those legacy
 * functions only ever read a tab's used rows, create a tab, clear it, and
 * write a block of rows -- so that is the whole interface.
 *
 * Two implementations:
 *  - MemoryTabStore: a cell grid with Apps Script semantics (getLastRow is
 *    the last row holding any non-empty cell; empty cells read as ''); the
 *    parity twin of the legacy sheet in tests.
 *  - SheetTabStore: the real tabs through SheetsClient. Date cells travel as
 *    serial numbers counted in the SPREADSHEET's zone. The Sheets API cannot
 *    tell a date serial from a plain number, so each caller names its date
 *    columns: a number there comes back as a Date, everywhere else it stays
 *    a number. Values are written RAW, so -- unlike Apps Script -- a
 *    date-like string is never coerced into a date (the coercion legacy
 *    defended against at dataLayerV1.gs:965-975 no longer happens).
 *
 * Errors: a failed Sheets call throws TabStoreError. Every legacy caller
 * wrapped its sheet access in try/catch and degraded to "no cache" or "not
 * saved"; the ported callers keep those catches, so behaviour is the same.
 */

import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import type { StepError } from '../core/result.ts';
import type { SheetRow } from '../sheets/coerce.ts';
import { a1 } from '../sheets/tabs.ts';
import { dateToSheetsSerial, sheetsSerialToDate, type PriceSheetsApi } from './priceHistory.ts';

export type TabCell = string | number | boolean | Date;

export interface TabWriteFormat {
  /** Bold on #eceff1 for the written rows (legacy's header styling). */
  readonly header?: boolean;
  /** 0-based columns holding dates, and the number format to show them in. */
  readonly dateColumns?: readonly number[];
  readonly datePattern?: string;
}

export interface TabStore {
  /** The tab's used rows, each padded to `nCols` with ''; null when the tab does not exist. */
  read(tab: string, nCols: number, dateColumns?: readonly number[]): Promise<TabCell[][] | null>;
  /** Creates the tab when missing; true when it had to be created. */
  ensure(tab: string): Promise<boolean>;
  /** Removes every value (clearContents). */
  clear(tab: string): Promise<void>;
  /** Writes `rows` starting at 1-based row `row`, column A. The tab must exist. */
  write(tab: string, row: number, rows: readonly (readonly TabCell[])[], format?: TabWriteFormat): Promise<void>;
}

export class TabStoreError extends Error {
  readonly stepError: StepError;
  constructor(e: StepError) {
    super(String(e.detail));
    this.name = 'TabStoreError';
    this.stepError = e;
  }
}

const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';

/** A cell grid per tab, with Apps Script getLastRow semantics. */
export class MemoryTabStore implements TabStore {
  readonly tabs = new Map<string, Map<string, TabCell>>();

  private lastRow(cells: Map<string, TabCell>): number {
    let m = 0;
    for (const k of cells.keys()) m = Math.max(m, Number(k.split(',')[0]));
    return m;
  }

  /** Synchronous read, for test comparisons. */
  snapshot(tab: string, nCols: number): TabCell[][] | null {
    const cells = this.tabs.get(tab);
    if (!cells) return null;
    const out: TabCell[][] = [];
    const last = this.lastRow(cells);
    for (let r = 1; r <= last; r++) {
      const row: TabCell[] = [];
      for (let c = 1; c <= nCols; c++) {
        const v = cells.get(r + ',' + c);
        row.push(v === undefined ? '' : isDate(v) ? new Date(v.getTime()) : v);
      }
      out.push(row);
    }
    return out;
  }

  async read(tab: string, nCols: number): Promise<TabCell[][] | null> {
    return this.snapshot(tab, nCols);
  }

  async ensure(tab: string): Promise<boolean> {
    if (this.tabs.has(tab)) return false;
    this.tabs.set(tab, new Map());
    return true;
  }

  async clear(tab: string): Promise<void> {
    this.tabs.get(tab)?.clear();
  }

  async write(tab: string, row: number, rows: readonly (readonly TabCell[])[]): Promise<void> {
    const cells = this.tabs.get(tab);
    if (!cells) throw new Error('MemoryTabStore: no tab named ' + tab);
    rows.forEach((r, i) => r.forEach((v, j) => {
      const k = (row + i) + ',' + (1 + j);
      if (v === '' || v == null) cells.delete(k);
      else cells.set(k, isDate(v) ? new Date(v.getTime()) : v);
    }));
  }
}

const HEADER_BACKGROUND = { red: 0xec / 255, green: 0xef / 255, blue: 0xf1 / 255 };
const DEFAULT_DATETIME_PATTERN = 'yyyy-mm-dd hh:mm:ss';

function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** The real tabs. `timeZone` must be the spreadsheet's own zone. */
export class SheetTabStore implements TabStore {
  private readonly ctx: RunContext;
  private readonly api: PriceSheetsApi;
  private readonly timeZone: string;

  constructor(ctx: RunContext, api: PriceSheetsApi, timeZone: string) {
    this.ctx = ctx;
    this.api = api;
    this.timeZone = timeZone;
  }

  private async ids(): Promise<Record<string, number>> {
    const r = await this.api.tabIds(this.ctx);
    if (!r.ok) throw new TabStoreError(r.error);
    return r.value;
  }

  async read(tab: string, nCols: number, dateColumns: readonly number[] = []): Promise<TabCell[][] | null> {
    const ids = await this.ids();
    if (!(tab in ids)) return null;
    const res = await this.api.batchGet(this.ctx, [a1(tab, 'A1:' + columnLetter(nCols))]);
    if (!res.ok) throw new TabStoreError(res.error);
    const tz = this.timeZone;
    return (res.value[0] ?? []).map((r) => {
      const out: TabCell[] = [];
      for (let c = 0; c < nCols; c++) {
        let v = (r ?? [])[c] as TabCell | null | undefined;
        if (v == null) v = '';
        if (dateColumns.includes(c) && typeof v === 'number' && Number.isFinite(v)) v = sheetsSerialToDate(v, tz);
        out.push(v);
      }
      return out;
    });
  }

  async ensure(tab: string): Promise<boolean> {
    const ids = await this.ids();
    if (tab in ids) return false;
    const added = await this.api.formatBatch(this.ctx, [{ addSheet: { properties: { title: tab } } }]);
    if (!added.ok) throw new TabStoreError(added.error);
    return true;
  }

  async clear(tab: string): Promise<void> {
    const r = await this.api.batchClear(this.ctx, [a1(tab)]);
    if (!r.ok) throw new TabStoreError(r.error);
  }

  async write(tab: string, row: number, rows: readonly (readonly TabCell[])[], format: TabWriteFormat = {}): Promise<void> {
    if (!rows.length) return;
    const width = Math.max(...rows.map((r) => r.length));
    const values: SheetRow[] = rows.map((r) => r.map((v) => (isDate(v) ? dateToSheetsSerial(v, this.timeZone) : v)));
    const wrote = await this.api.batchUpdate(this.ctx, [{ range: a1(tab, 'A' + row + ':' + columnLetter(width) + (row + rows.length - 1)), values }]);
    if (!wrote.ok) throw new TabStoreError(wrote.error);
    const requests: sheets_v4.Schema$Request[] = [];
    const sheetId = (await this.ids())[tab];
    if (sheetId === undefined) return;
    const range = (c0: number, c1: number): sheets_v4.Schema$GridRange => ({ sheetId, startRowIndex: row - 1, endRowIndex: row - 1 + rows.length, startColumnIndex: c0, endColumnIndex: c1 });
    if (format.header) {
      requests.push({ repeatCell: { range: range(0, width), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: HEADER_BACKGROUND } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
    }
    for (const c of format.dateColumns ?? []) {
      requests.push({ repeatCell: { range: range(c, c + 1), cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: format.datePattern ?? DEFAULT_DATETIME_PATTERN } } }, fields: 'userEnteredFormat.numberFormat' } });
    }
    if (requests.length) {
      const fmt = await this.api.formatBatch(this.ctx, requests);
      if (!fmt.ok) throw new TabStoreError(fmt.error);
    }
  }
}
