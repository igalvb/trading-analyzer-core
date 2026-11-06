/**
 * An Apps-Script-shaped workbook for porting legacy report writers almost
 * verbatim: `ss.getSheetByName / insertSheet / getSheets / toast`,
 * `sh.getRange(r, c, nr, nc).merge().setValue(v).setBackground(...)`,
 * `clearContents / clearFormats / setTabColor / setColumnWidth(s) /
 * setRowHeight / setFrozenRows / hideSheet / activate`.
 *
 * READ EVERYTHING AT THE START, ACCUMULATE, FLUSH AT THE END: open() lists
 * the tabs and loads the ones a writer will read; every call is applied to
 * an in-memory model and RECORDED in order (`calls`); flush() sends each
 * touched tab's cell changes and formatting to the backend once.
 *
 * Value semantics are Apps Script's, not the fakes': setValue on a
 * multi-cell range sets EVERY cell, except on a range that was merged, where
 * only the top-left cell keeps a value (F-71). Values are stored RAW (no
 * USER_ENTERED parsing -- F-47/F-68); `coerce` exists so tests can emulate
 * Sheets' parsing where legacy depended on it.
 *
 * Call log shapes: a range call is ['range:' + method, row, col, numRows,
 * numCols, ...args]; a sheet call is [method, ...args]; a workbook call is
 * [method, ...args] in `workbook.calls`.
 */

import type { RunContext } from '../core/context.ts';
import type { TabCell } from '../storage/tabStore.ts';
import { TabStoreError } from '../storage/tabStore.ts';
import { dateToSheetsSerial, type PriceSheetsApi } from '../storage/priceHistory.ts';
import type { sheets_v4 } from 'googleapis';
import type { ValueRangeUpdate } from './client.ts';
import { a1 } from './tabs.ts';
import { formatOpsToRequests, dateTimeFormatRequest, type CellRange, type FormatOp } from './formatOps.ts';

export type SheetCall = readonly unknown[];

const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';
const copyCell = (v: TabCell | undefined): TabCell => (v === undefined ? '' : isDate(v) ? new Date(v.getTime()) : v);
const key = (r: number, c: number): string => r + ',' + c;

export interface TabInfo {
  readonly name: string;
  readonly tabColor: string | null;
}

export interface TabChange {
  readonly created: boolean;
  readonly cleared: boolean;
  /** Every cell written since open (or since the clear), '' for an erased cell. */
  readonly cells: ReadonlyArray<{ readonly row: number; readonly col: number; readonly value: TabCell }>;
  readonly ops: readonly FormatOp[];
}

export interface WorkbookBackend {
  listTabs(): Promise<TabInfo[]>;
  /** The tab's used range (getDataRange().getValues()); null when it does not exist. */
  readTab(tab: string): Promise<TabCell[][] | null>;
  applyTab(tab: string, change: TabChange): Promise<void>;
  /**
   * C3: every touched tab of one flush at once, in first-touch order. A backend that can group its calls
   * (SheetsWorkbookBackend: about 4 calls per spreadsheet instead of 3-4 per tab) implements it; otherwise
   * ReportWorkbook.flush calls applyTab once per tab.
   */
  applyTabs?(changes: ReadonlyArray<readonly [string, TabChange]>): Promise<void>;
}

export class ReportRange {
  readonly sheet: ReportSheet;
  readonly row: number;
  readonly col: number;
  readonly numRows: number;
  readonly numCols: number;
  constructor(sheet: ReportSheet, row: number, col: number, numRows: number, numCols: number) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  private rec(method: string, args: unknown[]): this {
    this.sheet.calls.push(['range:' + method, this.row, this.col, this.numRows, this.numCols, ...args.map((a) => (a !== null && typeof a === 'object' ? structuredClone(a) : a))]);
    return this;
  }
  getSheet(): ReportSheet { return this.sheet; }
  getRow(): number { return this.row; }
  getColumn(): number { return this.col; }
  getValues(): TabCell[][] {
    const out: TabCell[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const row: TabCell[] = [];
      for (let c = 0; c < this.numCols; c++) row.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  getValue(): TabCell { return this.sheet.cell(this.row, this.col); }
  setValue(v: unknown): this {
    this.rec('setValue', [v]);
    if (this.sheet.isMerged(this)) this.sheet.put(this.row, this.col, v);
    else for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.put(this.row + r, this.col + c, v);
    return this;
  }
  setValues(values: readonly (readonly unknown[])[]): this {
    this.rec('setValues', [values]);
    if (values.length !== this.numRows) {
      throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values.length} but the range has ${this.numRows}.`);
    }
    values.forEach((r, i) => {
      if (r.length !== this.numCols) {
        throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${r.length} but the range has ${this.numCols}.`);
      }
      r.forEach((v, j) => this.sheet.put(this.row + i, this.col + j, v));
    });
    return this;
  }
  clearContent(): this {
    this.rec('clearContent', []);
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.put(this.row + r, this.col + c, '');
    return this;
  }
  merge(): this { this.rec('merge', []); this.sheet.merges.push({ row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols }); return this; }
  /** Drops the merges that lie inside this range. A real backend unmerges on the clearFormats that follows (formatOps), so only the call is recorded. */
  breakApart(): this {
    this.rec('breakApart', []);
    const inside = (m: CellRange): boolean => m.row >= this.row && m.col >= this.col && m.row + m.numRows <= this.row + this.numRows && m.col + m.numCols <= this.col + this.numCols;
    this.sheet.merges.splice(0, this.sheet.merges.length, ...this.sheet.merges.filter((m) => !inside(m)));
    return this;
  }
  setBackground(c: string | null): this { return this.rec('setBackground', [c]); }
  setFontColor(c: string): this { return this.rec('setFontColor', [c]); }
  setFontWeight(w: string): this { return this.rec('setFontWeight', [w]); }
  setFontSize(n: number): this { return this.rec('setFontSize', [n]); }
  setFontStyle(s: string): this { return this.rec('setFontStyle', [s]); }
  setHorizontalAlignment(a: string): this { return this.rec('setHorizontalAlignment', [a]); }
  setVerticalAlignment(a: string): this { return this.rec('setVerticalAlignment', [a]); }
  setNote(n: string): this { return this.rec('setNote', [n]); }
  setWrap(w: boolean): this { return this.rec('setWrap', [w]); }
  setNumberFormat(f: string): this { return this.rec('setNumberFormat', [f]); }
  /** A jump link to row `row` of the same tab (Sheets: a #gid=..&range=A<row> link on the cell's text). */
  setLinkToRow(row: number): this { return this.rec('setLinkToRow', [row]); }
}

export class ReportSheet {
  readonly name: string;
  readonly calls: SheetCall[] = [];
  readonly merges: CellRange[] = [];
  private readonly cells = new Map<string, TabCell>();
  private readonly loaded: boolean;
  readonly created: boolean;
  cleared = false;
  readonly written = new Set<string>();
  tabColor: string | null;
  private readonly coerce: (v: unknown) => TabCell;
  constructor(name: string, data: readonly (readonly TabCell[])[] | null, created: boolean, tabColor: string | null, coerce: (v: unknown) => TabCell) {
    this.name = name;
    this.loaded = data !== null;
    this.created = created;
    this.tabColor = tabColor;
    this.coerce = coerce;
    (data ?? []).forEach((r, i) => r.forEach((v, j) => { if (v !== '' && v != null) this.cells.set(key(i + 1, j + 1), copyCell(v)); }));
  }
  private needLoaded(what: string): void {
    if (!this.loaded && !this.created && !this.cleared) throw new Error('ReportSheet: ' + what + ' on tab "' + this.name + '", which was not loaded at open()');
  }
  cell(r: number, c: number): TabCell {
    this.needLoaded('a read');
    return copyCell(this.cells.get(key(r, c)));
  }
  put(r: number, c: number, raw: unknown): void {
    const v = this.coerce(raw);
    const k = key(r, c);
    if (v === '' || v === null || v === undefined) this.cells.delete(k);
    else this.cells.set(k, copyCell(v));
    this.written.add(k);
  }
  isMerged(r: CellRange): boolean {
    return (r.numRows > 1 || r.numCols > 1) && this.merges.some((m) => m.row === r.row && m.col === r.col && m.numRows === r.numRows && m.numCols === r.numCols);
  }
  getName(): string { return this.name; }
  getLastRow(): number {
    this.needLoaded('getLastRow');
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0]));
    return m;
  }
  getLastColumn(): number {
    this.needLoaded('getLastColumn');
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1]));
    return m;
  }
  getRange(row: unknown, col?: number, numRows = 1, numCols = 1): ReportRange {
    if (typeof row !== 'number') throw new Error('ReportSheet.getRange: A1 notation is not supported');
    if (!(row >= 1) || !((col ?? 0) >= 1) || !(numRows >= 1) || !(numCols >= 1)) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    return new ReportRange(this, row, col as number, numRows, numCols);
  }
  getDataRange(): ReportRange {
    return new ReportRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  private rec(method: string, args: unknown[]): this { this.calls.push([method, ...args]); return this; }
  clearContents(): this {
    this.rec('clearContents', []);
    this.cells.clear(); this.written.clear(); this.cleared = true;
    return this;
  }
  clear(): this {
    this.rec('clear', []);
    this.cells.clear(); this.written.clear(); this.cleared = true; this.merges.length = 0;
    return this;
  }
  /** Apps Script appendRow: a new row after the last row that holds content. The recorded values are cloned (a legacy array lives in another realm). */
  appendRow(values: readonly unknown[]): this {
    this.rec('appendRow', [structuredClone(values)]);
    const row = this.getLastRow() + 1;
    values.forEach((v, j) => this.put(row, 1 + j, v));
    return this;
  }
  clearFormats(): this { this.rec('clearFormats', []); this.merges.length = 0; return this; }
  setTabColor(c: string | null): this { this.rec('setTabColor', [c]); this.tabColor = c; return this; }
  getTabColor(): string | null { return this.tabColor; }
  setColumnWidth(col: number, w: number): this { return this.rec('setColumnWidth', [col, w]); }
  setColumnWidths(start: number, n: number, w: number): this { return this.rec('setColumnWidths', [start, n, w]); }
  autoResizeColumns(start: number, n: number): this { return this.rec('autoResizeColumns', [start, n]); }
  setRowHeight(row: number, h: number): this { return this.rec('setRowHeight', [row, h]); }
  setFrozenRows(n: number): this { return this.rec('setFrozenRows', [n]); }
  hideSheet(): this { return this.rec('hideSheet', []); }
  showSheet(): this { return this.rec('showSheet', []); }
  activate(): this { return this.rec('activate', []); }

  /** The current cells as a grid (tests, dry runs). */
  grid(nCols?: number): TabCell[][] {
    let lastR = 0, lastC = 0;
    for (const k of this.cells.keys()) { const [r, c] = k.split(',').map(Number); lastR = Math.max(lastR, r); lastC = Math.max(lastC, c); }
    const w = nCols ?? lastC;
    const out: TabCell[][] = [];
    for (let r = 1; r <= lastR; r++) { const row: TabCell[] = []; for (let c = 1; c <= w; c++) row.push(copyCell(this.cells.get(key(r, c)))); out.push(row); }
    return out;
  }

  change(): TabChange {
    const cells = [...this.written].map((k) => { const [row, col] = k.split(',').map(Number); return { row, col, value: copyCell(this.cells.get(k)) }; })
      .sort((a, b) => a.row - b.row || a.col - b.col);
    return { created: this.created, cleared: this.cleared, cells, ops: callsToFormatOps(this.calls) };
  }
}

const RANGE_FORMAT: Readonly<Record<string, string>> = {
  setBackground: 'background', setFontColor: 'fontColor', setFontWeight: 'fontWeight', setFontSize: 'fontSize', setFontStyle: 'fontStyle',
  setHorizontalAlignment: 'horizontalAlignment', setVerticalAlignment: 'verticalAlignment', setNote: 'note', setWrap: 'wrap', setNumberFormat: 'numberFormat',
  setLinkToRow: 'rowLink',
};

/** The recorded calls' formatting, as FormatOps (values are not formatting). */
export function callsToFormatOps(calls: readonly SheetCall[]): FormatOp[] {
  const out: FormatOp[] = [];
  for (const c of calls) {
    const m = String(c[0]);
    if (m.startsWith('range:')) {
      const method = m.slice(6);
      const range: CellRange = { row: c[1] as number, col: c[2] as number, numRows: c[3] as number, numCols: c[4] as number };
      if (method === 'merge') out.push({ op: 'merge', range });
      else if (RANGE_FORMAT[method]) {
        if (method === 'setBackground' && c[5] == null) continue;
        out.push({ op: RANGE_FORMAT[method], range, value: c[5] } as unknown as FormatOp);
      }
      continue;
    }
    if (m === 'clearFormats' || m === 'clear') out.push({ op: 'clearFormats' });
    else if (m === 'setTabColor') out.push({ op: 'tabColor', color: (c[1] as string | null) ?? null });
    else if (m === 'setColumnWidth') out.push({ op: 'columnWidths', start: c[1] as number, count: 1, width: c[2] as number });
    else if (m === 'setColumnWidths') out.push({ op: 'columnWidths', start: c[1] as number, count: c[2] as number, width: c[3] as number });
    else if (m === 'setRowHeight') out.push({ op: 'rowHeight', row: c[1] as number, height: c[2] as number });
    else if (m === 'setFrozenRows') out.push({ op: 'frozenRows', count: c[1] as number });
    else if (m === 'hideSheet') out.push({ op: 'hidden', value: true });
    else if (m === 'showSheet') out.push({ op: 'hidden', value: false });
  }
  return out;
}

export interface WorkbookOptions {
  /** Tests only: emulate Sheets' parsing of a written value. Default: RAW. */
  readonly coerce?: (v: unknown) => TabCell;
}

export class ReportWorkbook {
  readonly calls: SheetCall[] = [];
  private readonly backend: WorkbookBackend;
  private readonly order: string[];
  private readonly info = new Map<string, TabInfo>();
  private readonly data: Map<string, TabCell[][]>;
  private readonly sheets = new Map<string, ReportSheet>();
  private readonly coerce: (v: unknown) => TabCell;

  private constructor(backend: WorkbookBackend, tabs: TabInfo[], data: Map<string, TabCell[][]>, opts: WorkbookOptions) {
    this.backend = backend;
    this.order = tabs.map((t) => t.name);
    tabs.forEach((t) => this.info.set(t.name, t));
    this.data = data;
    this.coerce = opts.coerce ?? ((v: unknown) => v as TabCell);
  }

  /** Lists the tabs and loads the ones that will be read (`preload`; '*' loads all). */
  static async open(backend: WorkbookBackend, preload: readonly string[] = [], opts: WorkbookOptions = {}): Promise<ReportWorkbook> {
    const tabs = await backend.listTabs();
    const data = new Map<string, TabCell[][]>();
    for (const t of tabs) {
      if (preload.includes('*') || preload.includes(t.name)) data.set(t.name, (await backend.readTab(t.name)) ?? []);
    }
    return new ReportWorkbook(backend, tabs, data, opts);
  }

  getSheetByName(name: string): ReportSheet | null {
    const s = this.sheets.get(name);
    if (s) return s;
    if (!this.info.has(name)) return null;
    const sheet = new ReportSheet(name, this.data.get(name) ?? null, false, this.info.get(name)!.tabColor, this.coerce);
    this.sheets.set(name, sheet);
    return sheet;
  }

  insertSheet(name: string): ReportSheet {
    if (this.info.has(name) || this.sheets.has(name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const sheet = new ReportSheet(name, [], true, null, this.coerce);
    this.sheets.set(name, sheet);
    this.info.set(name, { name, tabColor: null });
    this.order.push(name);
    return sheet;
  }

  getSheets(): ReportSheet[] {
    return this.order.map((n) => this.getSheetByName(n) as ReportSheet);
  }

  toast(...args: unknown[]): void {
    this.calls.push(['toast', ...args]);
  }

  /** Every touched tab's changes, in first-touch order. */
  changes(): Array<[string, TabChange]> {
    const out: Array<[string, TabChange]> = [];
    for (const [name, s] of this.sheets) {
      if (!s.calls.length && !s.created) continue;
      out.push([name, s.change()]);
    }
    return out;
  }

  /** Sends every touched tab's changes: grouped (backend.applyTabs) when the backend can, else one applyTab per tab, in first-touch order. */
  async flush(): Promise<void> {
    const changes = this.changes();
    if (!changes.length) return;
    if (this.backend.applyTabs) { await this.backend.applyTabs(changes); return; }
    for (const [name, change] of changes) await this.backend.applyTab(name, change);
  }
}

/** In-memory backend: tabs, cells, the formatting applied, tab colours. */
export class MemoryWorkbookBackend implements WorkbookBackend {
  readonly tabs = new Map<string, { cells: Map<string, TabCell>; tabColor: string | null }>();
  readonly formats = new Map<string, FormatOp[]>();
  constructor(initial: Readonly<Record<string, readonly (readonly TabCell[])[]>> = {}) {
    for (const [name, grid] of Object.entries(initial)) {
      const cells = new Map<string, TabCell>();
      grid.forEach((r, i) => r.forEach((v, j) => { if (v !== '' && v != null) cells.set(key(i + 1, j + 1), copyCell(v)); }));
      this.tabs.set(name, { cells, tabColor: null });
    }
  }
  async listTabs(): Promise<TabInfo[]> {
    return [...this.tabs].map(([name, t]) => ({ name, tabColor: t.tabColor }));
  }
  async readTab(tab: string): Promise<TabCell[][] | null> {
    const t = this.tabs.get(tab);
    return t ? this.grid(tab) : null;
  }
  grid(tab: string, nCols?: number): TabCell[][] {
    const t = this.tabs.get(tab);
    if (!t) return [];
    let lastR = 0, lastC = 0;
    for (const k of t.cells.keys()) { const [r, c] = k.split(',').map(Number); lastR = Math.max(lastR, r); lastC = Math.max(lastC, c); }
    const w = nCols ?? lastC;
    const out: TabCell[][] = [];
    for (let r = 1; r <= lastR; r++) { const row: TabCell[] = []; for (let c = 1; c <= w; c++) row.push(copyCell(t.cells.get(key(r, c)))); out.push(row); }
    return out;
  }
  async applyTab(tab: string, change: TabChange): Promise<void> {
    let t = this.tabs.get(tab);
    if (!t) { t = { cells: new Map(), tabColor: null }; this.tabs.set(tab, t); }
    if (change.cleared) t.cells.clear();
    for (const c of change.cells) {
      if (c.value === '' || c.value == null) t.cells.delete(key(c.row, c.col));
      else t.cells.set(key(c.row, c.col), copyCell(c.value));
    }
    for (const op of change.ops) if (op.op === 'tabColor') t.tabColor = op.color;
    this.formats.set(tab, [...(this.formats.get(tab) ?? []), ...change.ops]);
  }
}

function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * The Google Sheets backend. C3 (2026-10-30): one flush of a spreadsheet's tabs is grouped into at most four
 * calls, whatever the number of tabs (it was 3-4 calls PER tab, about 22 tabs, under a 50-a-minute limiter):
 *   1. the new tabs: ONE addSheet batch (the new sheetIds come from its reply; the tab-id cache is kept)
 *   2. the unmerge (clearFormats) and value clear of the rewritten tabs: ONE formatBatch, or ONE batchClear when
 *      no tab clears its formats (D11: the unmerge must go BEFORE the values)
 *   3. every tab's changed cells: ONE values batchUpdate (RAW, contiguous runs per row)
 *   4. every tab's remaining formatting: ONE formatBatch
 * Tab colours are not read back (TabInfo.tabColor is null), so sheetGuardian-style checks have no state here.
 */
/** A new Google Sheets tab's grid. */
const DEFAULT_GRID_ROWS = 1000;
const DEFAULT_GRID_COLS = 26;
/** Spare rows added when a tab is grown, so a slightly longer report next night needs no second grow. */
const GRID_SLACK_ROWS = 200;

export class SheetsWorkbookBackend implements WorkbookBackend {
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
  async listTabs(): Promise<TabInfo[]> {
    return Object.keys(await this.ids()).map((name) => ({ name, tabColor: null }));
  }
  async readTab(tab: string): Promise<TabCell[][] | null> {
    if (!(tab in (await this.ids()))) return null;
    const r = await this.api.batchGet(this.ctx, [a1(tab)]);
    if (!r.ok) throw new TabStoreError(r.error);
    return (r.value[0] ?? []).map((row) => row.map((v) => (v == null ? '' : v)));
  }
  applyTab(tab: string, change: TabChange): Promise<void> {
    return this.applyTabs([[tab, change]]);
  }
  /** New tabs in ONE call: title -> sheetId from the reply when the api can (addTabs), else {} (read back after). */
  private async addTabs(titles: readonly string[]): Promise<Record<string, number>> {
    if (!titles.length) return {};
    if (this.api.addTabs) {
      const r = await this.api.addTabs(this.ctx, titles);
      if (!r.ok) throw new TabStoreError(r.error);
      return r.value;
    }
    const r = await this.api.formatBatch(this.ctx, titles.map((title) => ({ addSheet: { properties: { title } } })));
    if (!r.ok) throw new TabStoreError(r.error);
    return {};
  }
  /** appendDimension requests for tabs whose cells go past their grid (default grid for a new tab: 1000 rows x 26 columns). */
  private async growRequests(
    tabs: ReadonlyArray<{ tab: string; created: boolean; cells: TabChange['cells'] }>,
    idOf: (tab: string) => Promise<number>,
  ): Promise<sheets_v4.Schema$Request[]> {
    const need = tabs.map((t) => ({ ...t, rows: t.cells.reduce((m, c) => Math.max(m, c.row), 0), cols: t.cells.reduce((m, c) => Math.max(m, c.col), 0) }))
      .filter((t) => t.rows > DEFAULT_GRID_ROWS || t.cols > DEFAULT_GRID_COLS);
    if (!need.length) return [];
    const grids = this.api.tabGrids ? await this.api.tabGrids(this.ctx) : null;
    const size = new Map((grids && grids.ok ? grids.value : []).map((g) => [g.title, g]));
    const out: sheets_v4.Schema$Request[] = [];
    for (const t of need) {
      const sheetId = await idOf(t.tab);
      const g = t.created ? undefined : size.get(t.tab);
      const rows = g ? g.rowCount : DEFAULT_GRID_ROWS, cols = g ? g.columnCount : DEFAULT_GRID_COLS;
      if (t.rows > rows) out.push({ appendDimension: { sheetId, dimension: 'ROWS', length: t.rows - rows + GRID_SLACK_ROWS } });
      if (t.cols > cols) out.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: t.cols - cols } });
    }
    return out;
  }
  async applyTabs(changes: ReadonlyArray<readonly [string, TabChange]>): Promise<void> {
    if (!changes.length) return;
    const added = await this.addTabs(changes.filter(([, c]) => c.created).map(([t]) => t));
    let known: Record<string, number> | null = null;
    const idOf = async (tab: string): Promise<number> => {
      const fresh = added[tab];
      if (fresh !== undefined) return fresh;
      known ??= await this.ids();
      const id = known[tab];
      if (id === undefined) throw new Error('SheetsWorkbookBackend: no tab named ' + tab);
      return id;
    };
    // D11: a tab rewritten in place still holds the PREVIOUS run's merges until the format batch, and Sheets drops a value
    // written into a covered (not top-left) cell of a merge -- so a row that sat under an old merge lost columns B..N
    // (ATR stop, Chandelier, basing points, Final Conviction, gap rows ...). The unmerge (clearFormats) goes BEFORE
    // the values; a cleared tab's values are cleared in the same request.
    const pre: sheets_v4.Schema$Request[] = [];
    const clearRanges: string[] = [];
    const clearIds: number[] = [];
    const plans: Array<{ tab: string; change: TabChange; lastClear: number; preCleared: boolean }> = [];
    for (const [tab, change] of changes) {
      const lastClear = change.ops.map((o) => o.op).lastIndexOf('clearFormats');
      let preCleared = false;
      if (lastClear >= 0 && !change.created) {
        const sheetId = await idOf(tab);
        pre.push(...formatOpsToRequests(sheetId, change.ops.slice(0, lastClear + 1)));
        if (change.cleared) pre.push({ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } });
        preCleared = true;
      } else if (change.cleared && !change.created) {
        clearRanges.push(a1(tab));
        clearIds.push(await idOf(tab));
      }
      plans.push({ tab, change, lastClear, preCleared });
    }
    // Fix 2026-11-06 (live: the weekly-stops Exit report reached 1,139 rows and Sheets refused "exceeds grid limits",
    // leaving the tab empty): a tab written past its grid is grown first, before any clear (new tabs are 1000 x 26). Only checked when a
    // write goes past the default size, so ordinary runs make no extra call.
    const grow = await this.growRequests(plans.map((p) => ({ tab: p.tab, created: !!p.change.created, cells: p.change.cells })), idOf);
    if (grow.length) {
      const r = await this.api.formatBatch(this.ctx, grow);
      if (!r.ok) throw new TabStoreError(r.error);
    }
    if (pre.length) {
      // Still one call: the value clears of the tabs that keep their formats ride in the same batch
      // (updateCells userEnteredValue on the whole tab == values.batchClear of the tab).
      for (const sheetId of clearIds) pre.push({ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } });
      const r = await this.api.formatBatch(this.ctx, pre);
      if (!r.ok) throw new TabStoreError(r.error);
    } else if (clearRanges.length) {
      const r = await this.api.batchClear(this.ctx, clearRanges);
      if (!r.ok) throw new TabStoreError(r.error);
    }
    const updates: ValueRangeUpdate[] = [];
    const post: sheets_v4.Schema$Request[] = [];
    for (const { tab, change, lastClear, preCleared } of plans) {
      const cells = change.cells;
      let i = 0;
      while (i < cells.length) {
        let j = i;
        while (j + 1 < cells.length && cells[j + 1].row === cells[i].row && cells[j + 1].col === cells[j].col + 1) j++;
        const run = cells.slice(i, j + 1).map((c) => (isDate(c.value) ? dateToSheetsSerial(c.value, this.timeZone) : c.value));
        updates.push({ range: a1(tab, columnLetter(cells[i].col) + cells[i].row + ':' + columnLetter(cells[j].col) + cells[i].row), values: [run] });
        i = j + 1;
      }
      const dateCells = cells.filter((c) => isDate(c.value));
      const restOps = preCleared ? change.ops.slice(lastClear + 1) : change.ops;
      if (restOps.length || dateCells.length) {
        const sheetId = await idOf(tab);
        // F-B7-6: date cells get a date format after any clearFormats and before the other ops, so an explicit numberFormat op still wins.
        post.push(
          ...(preCleared ? [] : formatOpsToRequests(sheetId, change.ops.slice(0, lastClear + 1))),
          ...dateCells.map((c) => dateTimeFormatRequest(sheetId, { row: c.row, col: c.col, numRows: 1, numCols: 1 })),
          ...formatOpsToRequests(sheetId, change.ops.slice(lastClear + 1)),
        );
      }
    }
    if (updates.length) {
      const r = await this.api.batchUpdate(this.ctx, updates);
      if (!r.ok) throw new TabStoreError(r.error);
    }
    if (post.length) {
      const r = await this.api.formatBatch(this.ctx, post);
      if (!r.ok) throw new TabStoreError(r.error);
    }
  }
}
