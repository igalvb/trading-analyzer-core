/**
 * The dashboard writer's view of a sheet and a range (FL-7e).
 *
 * The dashboard (fullStockAnalysisV10_9.gs buildDashboardV7 :3442-4559) makes
 * two Apps Script range calls that ReportRange does not have yet:
 * setVerticalAlignment (the AI-review and narrative paragraphs) and setNote
 * (the 10-year Treasury as-of date). They are recorded in the sheet's call
 * log in the same shape as every other range call, ['range:setX', row, col,
 * numRows, numCols, arg], so the log stays comparable with legacy's. If
 * ReportRange gains the methods natively (EDIT #1), the native method is used.
 *
 * Until formatOps knows 'verticalAlignment' and 'note' (EDIT #1/#2),
 * callsToFormatOps ignores these two calls, so they never reach Google Sheets
 * (F-E4).
 */

import type { ReportRange, ReportSheet } from '../../sheets/reportSheet.ts';

export class DashRange {
  private readonly r: ReportRange;
  constructor(r: ReportRange) { this.r = r; }
  merge(): this { this.r.merge(); return this; }
  breakApart(): this { this.r.breakApart(); return this; }
  setValue(v: unknown): this { this.r.setValue(v); return this; }
  setValues(v: readonly (readonly unknown[])[]): this { this.r.setValues(v); return this; }
  setBackground(c: string | null): this { this.r.setBackground(c); return this; }
  setFontColor(c: string): this { this.r.setFontColor(c); return this; }
  setFontWeight(w: string): this { this.r.setFontWeight(w); return this; }
  setFontSize(n: number): this { this.r.setFontSize(n); return this; }
  setFontStyle(s: string): this { this.r.setFontStyle(s); return this; }
  setWrap(w: boolean): this { this.r.setWrap(w); return this; }
  setNumberFormat(f: string): this { this.r.setNumberFormat(f); return this; }
  setVerticalAlignment(a: string): this { return this.extra('setVerticalAlignment', a); }
  setNote(n: string): this { return this.extra('setNote', n); }
  private extra(method: string, arg: string): this {
    const native = (this.r as unknown as Record<string, unknown>)[method];
    if (typeof native === 'function') (native as (a: string) => unknown).call(this.r, arg);
    else this.r.sheet.calls.push(['range:' + method, this.r.row, this.r.col, this.r.numRows, this.r.numCols, arg]);
    return this;
  }
}

/** The sheet calls the dashboard makes, over a ReportSheet. */
export class DashSheet {
  readonly sheet: ReportSheet;
  constructor(sheet: ReportSheet) { this.sheet = sheet; }
  getRange(row: number, col: number, numRows?: number, numCols?: number): DashRange { return new DashRange(this.sheet.getRange(row, col, numRows, numCols)); }
  getDataRange(): DashRange { return new DashRange(this.sheet.getDataRange()); }
  clearContents(): this { this.sheet.clearContents(); return this; }
  clearFormats(): this { this.sheet.clearFormats(); return this; }
  setTabColor(c: string | null): this { this.sheet.setTabColor(c); return this; }
  setColumnWidth(col: number, w: number): this { this.sheet.setColumnWidth(col, w); return this; }
  setColumnWidths(start: number, n: number, w: number): this { this.sheet.setColumnWidths(start, n, w); return this; }
  setRowHeight(row: number, h: number): this { this.sheet.setRowHeight(row, h); return this; }
  setFrozenRows(n: number): this { this.sheet.setFrozenRows(n); return this; }
}
