/**
 * Sheet formatting as data.
 *
 * Legacy report writers format with Apps Script calls -- merge(),
 * setBackground(), setFontWeight(), setTabColor(), setColumnWidths() ...
 * Each such call becomes ONE FormatOp here, in the same order, so a port's
 * formatting can be compared with legacy's call for call (the FL-5 tests
 * record legacy's calls and compare). A TabFormatter applies them:
 * SheetTabFormatter sends every op of a tab in ONE spreadsheets.batchUpdate.
 *
 * clearFormats() also unmerges: legacy re-merges the same rows each run, and
 * a stale merge left over a data row would hide its columns B-D.
 */

import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import { TabStoreError } from '../storage/tabStore.ts';
import type { PriceSheetsApi } from '../storage/priceHistory.ts';

/** getRange(row, col, numRows, numCols), 1-based. */
export interface CellRange {
  readonly row: number;
  readonly col: number;
  readonly numRows: number;
  readonly numCols: number;
}

export type FormatOp =
  | { readonly op: 'clearFormats' }
  | { readonly op: 'tabColor'; readonly color: string | null }
  | { readonly op: 'merge'; readonly range: CellRange }
  | { readonly op: 'fontWeight'; readonly range: CellRange; readonly value: 'bold' | 'normal' }
  | { readonly op: 'fontSize'; readonly range: CellRange; readonly value: number }
  | { readonly op: 'background'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'fontColor'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'wrap'; readonly range: CellRange; readonly value: boolean }
  | { readonly op: 'columnWidths'; readonly start: number; readonly count: number; readonly width: number }
  | { readonly op: 'frozenRows'; readonly count: number }
  | { readonly op: 'fontStyle'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'horizontalAlignment'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'verticalAlignment'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'note'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'numberFormat'; readonly range: CellRange; readonly value: string }
  | { readonly op: 'rowHeight'; readonly row: number; readonly height: number }
  /** Row 35 (#7): the cell's text links to row `value` of the same tab (a jump link). */
  | { readonly op: 'rowLink'; readonly range: CellRange; readonly value: number }
  | { readonly op: 'hidden'; readonly value: boolean };

export interface TabFormatter {
  apply(tab: string, ops: readonly FormatOp[]): Promise<void>;
}

/** Records every op per tab (tests, dry runs). */
export class MemoryTabFormatter implements TabFormatter {
  readonly applied = new Map<string, FormatOp[]>();
  async apply(tab: string, ops: readonly FormatOp[]): Promise<void> {
    const list = this.applied.get(tab) ?? [];
    list.push(...ops);
    this.applied.set(tab, list);
  }
}

/** '#rgb' / '#rrggbb' -> a Sheets API colour. */
export function hexColor(hex: string): sheets_v4.Schema$Color {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('hexColor: not a #rgb or #rrggbb colour: ' + hex);
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}

function grid(sheetId: number, r: CellRange): sheets_v4.Schema$GridRange {
  return { sheetId, startRowIndex: r.row - 1, endRowIndex: r.row - 1 + r.numRows, startColumnIndex: r.col - 1, endColumnIndex: r.col - 1 + r.numCols };
}

function cellFormat(sheetId: number, range: CellRange, format: sheets_v4.Schema$CellFormat, fields: string): sheets_v4.Schema$Request {
  return { repeatCell: { range: grid(sheetId, range), cell: { userEnteredFormat: format }, fields } };
}

/**
 * F-B7-6: a Date value is sent as a Sheets serial number (RAW), which shows as 46322.27 unless the
 * cell has a date format. Apps Script's setValue/appendRow(new Date()) set one automatically, so the
 * backend does the same: the locale's date-time format (no pattern = the spreadsheet's default).
 */
export function dateTimeFormatRequest(sheetId: number, range: CellRange): sheets_v4.Schema$Request {
  return cellFormat(sheetId, range, { numberFormat: { type: 'DATE_TIME' } }, 'userEnteredFormat.numberFormat');
}

export function formatOpsToRequests(sheetId: number, ops: readonly FormatOp[]): sheets_v4.Schema$Request[] {
  const out: sheets_v4.Schema$Request[] = [];
  for (const o of ops) {
    switch (o.op) {
      case 'clearFormats':
        out.push({ unmergeCells: { range: { sheetId } } }, { updateCells: { range: { sheetId }, fields: 'userEnteredFormat' } });
        break;
      case 'tabColor':
        out.push({ updateSheetProperties: { properties: o.color === null ? { sheetId } : { sheetId, tabColor: hexColor(o.color) }, fields: 'tabColor' } });
        break;
      case 'merge':
        out.push({ mergeCells: { range: grid(sheetId, o.range), mergeType: 'MERGE_ALL' } });
        break;
      case 'fontWeight':
        out.push(cellFormat(sheetId, o.range, { textFormat: { bold: o.value === 'bold' } }, 'userEnteredFormat.textFormat.bold'));
        break;
      case 'fontSize':
        out.push(cellFormat(sheetId, o.range, { textFormat: { fontSize: o.value } }, 'userEnteredFormat.textFormat.fontSize'));
        break;
      case 'fontColor':
        out.push(cellFormat(sheetId, o.range, { textFormat: { foregroundColor: hexColor(o.value) } }, 'userEnteredFormat.textFormat.foregroundColor'));
        break;
      case 'background':
        out.push(cellFormat(sheetId, o.range, { backgroundColor: hexColor(o.value) }, 'userEnteredFormat.backgroundColor'));
        break;
      case 'wrap':
        out.push(cellFormat(sheetId, o.range, { wrapStrategy: o.value ? 'WRAP' : 'OVERFLOW_CELL' }, 'userEnteredFormat.wrapStrategy'));
        break;
      case 'columnWidths':
        out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: o.start - 1, endIndex: o.start - 1 + o.count }, properties: { pixelSize: o.width }, fields: 'pixelSize' } });
        break;
      case 'frozenRows':
        out.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: o.count } }, fields: 'gridProperties.frozenRowCount' } });
        break;
      case 'fontStyle':
        out.push(cellFormat(sheetId, o.range, { textFormat: { italic: o.value === 'italic' } }, 'userEnteredFormat.textFormat.italic'));
        break;
      case 'horizontalAlignment':
        out.push(cellFormat(sheetId, o.range, { horizontalAlignment: o.value.toUpperCase() }, 'userEnteredFormat.horizontalAlignment'));
        break;
      case 'verticalAlignment':
        out.push(cellFormat(sheetId, o.range, { verticalAlignment: o.value.toUpperCase() }, 'userEnteredFormat.verticalAlignment'));
        break;
      case 'note':
        out.push({ repeatCell: { range: grid(sheetId, o.range), cell: { note: o.value }, fields: 'note' } });
        break;
      case 'numberFormat':
        out.push(cellFormat(sheetId, o.range, { numberFormat: { type: 'NUMBER', pattern: o.value } }, 'userEnteredFormat.numberFormat'));
        break;
      case 'rowLink':
        out.push(cellFormat(sheetId, o.range, { textFormat: { link: { uri: '#gid=' + sheetId + '&range=A' + o.value } } }, 'userEnteredFormat.textFormat.link'));
        break;
      case 'rowHeight':
        out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: o.row - 1, endIndex: o.row }, properties: { pixelSize: o.height }, fields: 'pixelSize' } });
        break;
      case 'hidden':
        out.push({ updateSheetProperties: { properties: { sheetId, hidden: o.value }, fields: 'hidden' } });
        break;
    }
  }
  return out;
}

/** Applies a tab's ops in one batchUpdate. The tab must exist. */
export class SheetTabFormatter implements TabFormatter {
  private readonly ctx: RunContext;
  private readonly api: Pick<PriceSheetsApi, 'tabIds' | 'formatBatch'>;
  constructor(ctx: RunContext, api: Pick<PriceSheetsApi, 'tabIds' | 'formatBatch'>) {
    this.ctx = ctx;
    this.api = api;
  }
  async apply(tab: string, ops: readonly FormatOp[]): Promise<void> {
    if (!ops.length) return;
    const ids = await this.api.tabIds(this.ctx);
    if (!ids.ok) throw new TabStoreError(ids.error);
    const sheetId = ids.value[tab];
    if (sheetId === undefined) throw new Error('SheetTabFormatter: no tab named ' + tab);
    const r = await this.api.formatBatch(this.ctx, formatOpsToRequests(sheetId, ops));
    if (!r.ok) throw new TabStoreError(r.error);
  }
}
