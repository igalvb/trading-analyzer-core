/**
 * The report tabs a run wrote, as one printable HTML page (then a PDF, reports/pdf/chromePdf.ts).
 *
 * Each tab is drawn from the workbook's own cells and recorded formatting (colours, bold, sizes,
 * alignment, merges, column widths), so the PDF shows what the Sheet shows. Nothing is computed
 * here: no model or score logic, only layout. Unwrapped text spills into empty cells to its right,
 * as it does in Sheets.
 */

import type { ReportSheet } from '../../sheets/reportSheet.ts';
import { callsToFormatOps } from '../../sheets/reportSheet.ts';
import type { CellRange } from '../../sheets/formatOps.ts';
import type { TabCell } from '../../storage/tabStore.ts';

export const htmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Printable width of an A4 landscape page with 10 mm margins, in CSS px. */
const PAGE_WIDTH_PX = 1040;
const DEFAULT_COL_PX = 100;

interface CellStyle {
  background?: string; fontColor?: string; fontWeight?: string; fontSize?: number; fontStyle?: string;
  horizontalAlignment?: string; verticalAlignment?: string; wrap?: boolean; numberFormat?: string;
}

/** A cell's value as Sheets would show it (dates in the run's zone; the number formats the reports use). */
export function displayValue(v: TabCell, numberFormat: string | undefined, timeZone: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const day = v.toLocaleDateString('en-CA', { timeZone });
    return numberFormat === 'yyyy-mm-dd' ? day : day + ' ' + v.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (numberFormat === '$#,##0.00') return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (numberFormat === '0') return Math.round(v).toString();
    if (Number.isInteger(v)) return v.toString();
    return Math.abs(v) < 1 ? String(Number(v.toPrecision(4))) : v.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
  }
  return String(v);
}

const key = (r: number, c: number): string => r + ',' + c;

/** One tab as an HTML section: title, then its cells as a table. Null when the tab is empty. */
export function tabHtml(sheet: ReportSheet, timeZone: string): string | null {
  const grid = sheet.grid();
  if (!grid.length) return null;
  const nRows = grid.length;
  const ops = callsToFormatOps(sheet.calls);
  // A merged title can reach past the last filled column; the table is as wide as the widest of them.
  let nCols = Math.max(...grid.map((r) => r.length), 1);
  for (const op of ops) if (op.op === 'merge' && op.range.row <= nRows) nCols = Math.max(nCols, op.range.col + op.range.numCols - 1);
  const styles = new Map<string, CellStyle>();
  let merges: CellRange[] = [];
  const widths = new Map<number, number>();
  let hidden = false;
  for (const op of ops) {
    if (op.op === 'clearFormats') { styles.clear(); merges = []; continue; }
    if (op.op === 'merge') { merges.push(op.range); continue; }
    if (op.op === 'columnWidths') { for (let i = 0; i < op.count; i++) widths.set(op.start + i, op.width); continue; }
    if (op.op === 'hidden') { hidden = op.value; continue; }
    if (!('range' in op) || op.op === 'note') continue;
    const r = op.range;
    for (let i = r.row; i < r.row + r.numRows && i <= nRows; i++) {
      for (let j = r.col; j < r.col + r.numCols && j <= nCols; j++) {
        const st = styles.get(key(i, j)) ?? {};
        (st as Record<string, unknown>)[op.op] = op.value;
        styles.set(key(i, j), st);
      }
    }
  }
  if (hidden) return null;
  // Merges, clipped to the grid; the cells they cover are not drawn.
  const spanAt = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const m of merges) {
    if (m.row > nRows || m.col > nCols) continue;
    const rows = Math.min(m.numRows, nRows - m.row + 1), cols = Math.min(m.numCols, nCols - m.col + 1);
    spanAt.set(key(m.row, m.col), { rows, cols });
    for (let i = m.row; i < m.row + rows; i++) for (let j = m.col; j < m.col + cols; j++) if (i !== m.row || j !== m.col) covered.add(key(i, j));
  }
  const colPx = Array.from({ length: nCols }, (_, j) => widths.get(j + 1) ?? DEFAULT_COL_PX);
  const total = colPx.reduce((a, b) => a + b, 0);
  const zoom = Math.min(1, PAGE_WIDTH_PX / total);
  const empty = (i: number, j: number): boolean => {
    const v = grid[i - 1]?.[j - 1];
    return (v === '' || v === null || v === undefined) && !covered.has(key(i, j)) && !spanAt.has(key(i, j));
  };
  const rowsHtml: string[] = [];
  for (let i = 1; i <= nRows; i++) {
    const cells: string[] = [];
    for (let j = 1; j <= nCols; j++) {
      const k = key(i, j);
      if (covered.has(k)) continue;
      const st = styles.get(k) ?? {};
      const text = displayValue(grid[i - 1]?.[j - 1] ?? '', st.numberFormat, timeZone);
      let span = spanAt.get(k) ?? { rows: 1, cols: 1 };
      // Sheets lets unwrapped text run on into empty cells to its right.
      if (text && span.cols === 1 && span.rows === 1 && st.wrap !== true) {
        let c = 1;
        while (j + c <= nCols && empty(i, j + c) && !styles.get(key(i, j + c))?.background) c++;
        if (c > 1) { span = { rows: 1, cols: c }; for (let x = 1; x < c; x++) covered.add(key(i, j + x)); }
      }
      const css: string[] = [];
      if (st.background) css.push('background:' + st.background);
      if (st.fontColor) css.push('color:' + st.fontColor);
      if (st.fontWeight === 'bold') css.push('font-weight:700');
      if (st.fontStyle === 'italic') css.push('font-style:italic');
      if (st.fontSize) css.push('font-size:' + st.fontSize + 'pt');
      const align = (st.horizontalAlignment ?? (typeof grid[i - 1]?.[j - 1] === 'number' ? 'right' : '')).toLowerCase();
      if (align) css.push('text-align:' + (align === 'centre' ? 'center' : align));
      if (st.verticalAlignment) css.push('vertical-align:' + (st.verticalAlignment.toLowerCase() === 'center' ? 'middle' : st.verticalAlignment.toLowerCase()));
      const attrs = (span.rows > 1 ? ' rowspan="' + span.rows + '"' : '') + (span.cols > 1 ? ' colspan="' + span.cols + '"' : '') + (css.length ? ' style="' + htmlEsc(css.join(';')) + '"' : '');
      cells.push('<td' + attrs + '>' + htmlEsc(text) + '</td>');
    }
    rowsHtml.push('<tr>' + cells.join('') + '</tr>');
  }
  return '<section class="tab"><h2>' + htmlEsc(sheet.getName()) + '</h2>' +
    '<div class="grid" style="zoom:' + zoom.toFixed(3) + '"><table style="width:' + total + 'px"><colgroup>' +
    colPx.map((w) => '<col style="width:' + w + 'px">').join('') + '</colgroup><tbody>' + rowsHtml.join('\n') + '</tbody></table></div></section>';
}

export interface ReportCover {
  readonly title: string;
  readonly subtitle: string;
  /** Label / value pairs shown as large tiles. */
  readonly facts: readonly (readonly [string, string])[];
  /** Plain lines under the tiles (the headline, data-quality notes). */
  readonly lines: readonly string[];
}

const CSS = `
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, 'Liberation Sans', 'Noto Sans', sans-serif; font-size: 10pt; color: #1f2933; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover { page-break-after: always; padding: 24px 8px; }
.cover .brand { font-size: 10pt; letter-spacing: .12em; text-transform: uppercase; color: #52606d; }
.cover h1 { font-size: 34pt; margin: 6px 0 2px; color: #102a43; }
.cover .sub { font-size: 12pt; color: #52606d; margin-bottom: 22px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.tile { flex: 1 1 180px; border: 1px solid #d9e2ec; border-radius: 10px; padding: 12px 14px; background: #f8fafc; }
.tile .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #627d98; }
.tile .v { font-size: 16pt; font-weight: 700; color: #102a43; margin-top: 4px; }
.cover .lines { font-size: 11pt; line-height: 1.5; white-space: pre-wrap; }
.tab { page-break-before: always; }
.tab h2 { font-size: 14pt; color: #102a43; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 2px solid #102a43; }
.grid table { border-collapse: collapse; table-layout: fixed; }
.grid td { border: 1px solid #e4e7eb; padding: 2px 4px; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 9pt; line-height: 1.3; }
.grid td:empty { border-color: transparent; }
.grid tr { page-break-inside: avoid; }
.chart { page-break-before: always; }
.chart iframe { width: 100%; height: 640px; border: 0; }
`;

/** The whole document: a cover page, then each tab (and the price chart page, if any). */
export function reportDocument(cover: ReportCover, sections: readonly string[], chartHtml: string | null): string {
  const tiles = cover.facts.map(([k, v]) => '<div class="tile"><div class="k">' + htmlEsc(k) + '</div><div class="v">' + htmlEsc(v) + '</div></div>').join('');
  const chart = chartHtml ? '<section class="chart"><h2>Price chart</h2><iframe scrolling="no" srcdoc="' + htmlEsc(chartHtml) + '"></iframe></section>' : '';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + htmlEsc(cover.title) + '</title><style>' + CSS + '</style></head><body>' +
    '<section class="cover"><div class="brand">Trading Analyzer</div><h1>' + htmlEsc(cover.title) + '</h1><div class="sub">' + htmlEsc(cover.subtitle) + '</div>' +
    '<div class="tiles">' + tiles + '</div><div class="lines">' + htmlEsc(cover.lines.join('\n')) + '</div>' +
    '</section>' +
    sections.join('\n') + chart + '</body></html>';
}
