/**
 * A tab read back from the Sheet (values as the Sheet displays them + their formatting, SheetsClient.tabWithFormats)
 * as one HTML section, in the same style as workbookHtml.tabHtml. Used to send a SAVED report without re-running it.
 */

import type { sheets_v4 } from 'googleapis';
import { colorToHex } from '../../sheets/client.ts';
import { htmlEsc } from './workbookHtml.ts';

const PAGE_WIDTH_PX = 1040;
const DEFAULT_COL_PX = 100;
const key = (r: number, c: number): string => r + ',' + c;

export function sheetGridHtml(sheet: sheets_v4.Schema$Sheet): string | null {
  const title = sheet.properties?.title ?? '';
  const data = sheet.data?.[0];
  const rows = data?.rowData ?? [];
  const text = (r: number, c: number): string => rows[r]?.values?.[c]?.formattedValue ?? '';
  let nRows = 0, nCols = 0;
  rows.forEach((row, r) => (row.values ?? []).forEach((v, c) => { if ((v.formattedValue ?? '') !== '') { nRows = Math.max(nRows, r + 1); nCols = Math.max(nCols, c + 1); } }));
  if (!nRows) return null;
  // A merged title can reach past the last filled column.
  for (const m of sheet.merges ?? []) if ((m.startRowIndex ?? 0) < nRows) nCols = Math.max(nCols, m.endColumnIndex ?? 0);
  const spanAt = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const m of sheet.merges ?? []) {
    const r0 = m.startRowIndex ?? 0, c0 = m.startColumnIndex ?? 0;
    if (r0 >= nRows || c0 >= nCols) continue;
    const rs = Math.min(m.endRowIndex ?? r0 + 1, nRows) - r0, cs = Math.min(m.endColumnIndex ?? c0 + 1, nCols) - c0;
    spanAt.set(key(r0, c0), { rows: rs, cols: cs });
    for (let i = r0; i < r0 + rs; i++) for (let j = c0; j < c0 + cs; j++) if (i !== r0 || j !== c0) covered.add(key(i, j));
  }
  const colPx = Array.from({ length: nCols }, (_, j) => data?.columnMetadata?.[j]?.pixelSize ?? DEFAULT_COL_PX);
  const total = colPx.reduce((a, b) => a + b, 0);
  const zoom = Math.min(1, PAGE_WIDTH_PX / total);
  const out: string[] = [];
  for (let r = 0; r < nRows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < nCols; c++) {
      if (covered.has(key(r, c))) continue;
      const v = rows[r]?.values?.[c];
      const f = v?.effectiveFormat;
      const t = text(r, c);
      let span = spanAt.get(key(r, c)) ?? { rows: 1, cols: 1 };
      if (t && span.rows === 1 && span.cols === 1 && f?.wrapStrategy !== 'WRAP') {
        let k = 1;
        while (c + k < nCols && !text(r, c + k) && !covered.has(key(r, c + k)) && !spanAt.has(key(r, c + k))) k++;
        if (k > 1) { span = { rows: 1, cols: k }; for (let x = 1; x < k; x++) covered.add(key(r, c + x)); }
      }
      const css: string[] = [];
      const bg = colorToHex(f?.backgroundColor);
      if (bg && bg !== '#ffffff') css.push('background:' + bg);
      const fg = colorToHex(f?.textFormat?.foregroundColor);
      if (fg && fg !== '#000000') css.push('color:' + fg);
      if (f?.textFormat?.bold) css.push('font-weight:700');
      if (f?.textFormat?.italic) css.push('font-style:italic');
      if (f?.textFormat?.fontSize && f.textFormat.fontSize !== 10) css.push('font-size:' + f.textFormat.fontSize + 'pt');
      if (f?.horizontalAlignment) css.push('text-align:' + f.horizontalAlignment.toLowerCase());
      const attrs = (span.rows > 1 ? ' rowspan="' + span.rows + '"' : '') + (span.cols > 1 ? ' colspan="' + span.cols + '"' : '') + (css.length ? ' style="' + htmlEsc(css.join(';')) + '"' : '');
      cells.push('<td' + attrs + '>' + htmlEsc(t) + '</td>');
    }
    out.push('<tr>' + cells.join('') + '</tr>');
  }
  return '<section class="tab"><h2>' + htmlEsc(title) + '</h2><div class="grid" style="zoom:' + zoom.toFixed(3) + '"><table style="width:' + total + 'px"><colgroup>'
    + colPx.map((w) => '<col style="width:' + w + 'px">').join('') + '</colgroup><tbody>' + out.join('\n') + '</tbody></table></div></section>';
}

/** Any displayed cell text contains `needle` (e.g. the AI placeholder). */
export function sheetHasText(sheet: sheets_v4.Schema$Sheet, needle: string): boolean {
  return (sheet.data?.[0]?.rowData ?? []).some((r) => (r.values ?? []).some((v) => (v.formattedValue ?? '').includes(needle)));
}

/** The displayed text of the first cell that starts with `prefix` (e.g. 'Run time:'). */
export function sheetFindText(sheet: sheets_v4.Schema$Sheet, prefix: string): string | null {
  for (const r of sheet.data?.[0]?.rowData ?? []) for (const v of r.values ?? []) if ((v.formattedValue ?? '').startsWith(prefix)) return v.formattedValue ?? null;
  return null;
}
