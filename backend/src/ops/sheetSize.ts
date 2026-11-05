/**
 * diagnoseSheetSizeV1Menu (fullStockAnalysisV10_9.gs:6165-6190): read-only
 * size report of every tab, written to '🔍 Sheet Size Report' and returned in
 * the alert text. The workbook must be opened with every tab loaded
 * (ReportWorkbook.open(backend, ['*'])): row/column counts come from the
 * loaded cells, and an unloaded tab throws.
 *
 * Number grouping uses 'en-US' (legacy's default locale in Apps Script).
 * ui.alert(title, text, OK) -> deps.alert(text, title).
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';

export const SHEET_SIZE_REPORT_TAB = '🔍 Sheet Size Report';

export interface SheetSizeRow {
  readonly name: string;
  readonly lastRow: number;
  readonly lastCol: number;
  readonly cells: number;
}

/**
 * autoResizeColumns has no ReportSheet method: it is recorded in the call
 * log in legacy order, but the Sheets backend has no op for it (F-C7).
 */
export function autoResizeColumns(sheet: ReportSheet, start: number, count: number): void {
  sheet.calls.push(['autoResizeColumns', start, count]);
}

export function diagnoseSheetSize(ss: ReportWorkbook, deps: { readonly alert: (message: string, title?: string) => void }): SheetSizeRow[] {
  const sheets = ss.getSheets();
  const rows = sheets.map((sh) => {
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    return { name: sh.getName(), lastRow, lastCol, cells: lastRow * lastCol };
  });
  rows.sort((a, b) => b.cells - a.cells);
  const totalCells = rows.reduce((s, r) => s + r.cells, 0);

  const reportSheetName = SHEET_SIZE_REPORT_TAB;
  let reportSheet = ss.getSheetByName(reportSheetName);
  if (reportSheet) reportSheet.clearContents(); else reportSheet = ss.insertSheet(reportSheetName);
  reportSheet.getRange(1, 1, 1, 4).setValues([['Sheet Name', 'Rows', 'Columns', 'Cells (Rows x Cols)']]).setFontWeight('bold').setBackground('#eceff1');
  reportSheet.getRange(2, 1, rows.length, 4).setValues(rows.map((r) => [r.name, r.lastRow, r.lastCol, r.cells]));
  reportSheet.setFrozenRows(1);
  autoResizeColumns(reportSheet, 1, 4);

  deps.alert(
    'Total real sheets: ' + sheets.length + '\nTotal cells across all sheets: ' + totalCells.toLocaleString('en-US') +
    '\n\nTop 5 biggest:\n' + rows.slice(0, 5).map((r) => '  ' + r.name + ': ' + r.cells.toLocaleString('en-US') + ' cells (' + r.lastRow + ' rows x ' + r.lastCol + ' cols)').join('\n') +
    '\n\nFull breakdown written to the "' + reportSheetName + '" sheet.',
    'Sheet Size Report',
  );
  return rows;
}
