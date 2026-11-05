/**
 * An in-memory stand-in for the googleapis Sheets object, over several spreadsheets at once (the three-spreadsheet
 * tests). Only what SheetsClient calls: spreadsheets.get, values.batchGet / batchUpdate / batchClear / append,
 * spreadsheets.batchUpdate (addSheet, deleteSheet, updateSheetProperties, developer metadata, the rest ignored)
 * and spreadsheets.sheets.copyTo. A cell string starting with '=' is a formula (for the reference check).
 */

import type { sheets_v4 } from 'googleapis';

export type Cell = string | number | boolean;

export interface FakeTab {
  sheetId: number;
  title: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
  cells: Cell[][];
  color: string | null;
  pivotSourceSheetId?: number;
  charts?: sheets_v4.Schema$EmbeddedChart[];
  filterViews?: sheets_v4.Schema$FilterView[];
  /** emulateFormats only: the merged ranges and the other formatting requests, in order. */
  merges?: sheets_v4.Schema$GridRange[];
  formats?: sheets_v4.Schema$Request[];
}

export interface FakeBook {
  id: string;
  title: string;
  tabs: FakeTab[];
  metadata: Map<string, string>;
  nextId: number;
}

export interface FakeCall {
  readonly id: string;
  readonly method: string;
  readonly ranges?: readonly string[];
}

function parseRange(range: string): { tab: string; r0: number; c0: number; r1: number | null; c1: number | null } {
  let tab: string, rest = '';
  if (range.startsWith("'")) {
    let i = 1, name = '';
    for (;;) {
      if (range[i] === "'" && range[i + 1] === "'") { name += "'"; i += 2; continue; }
      if (range[i] === "'") { i++; break; }
      name += range[i]; i++;
    }
    tab = name;
    rest = range[i] === '!' ? range.slice(i + 1) : '';
  } else {
    const k = range.indexOf('!');
    tab = k >= 0 ? range.slice(0, k) : range;
    rest = k >= 0 ? range.slice(k + 1) : '';
  }
  if (!rest) return { tab, r0: 0, c0: 0, r1: null, c1: null };
  const m = /^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/.exec(rest);
  if (!m) throw new Error('fake: bad range ' + range);
  const col = (s: string): number => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const r0 = m[2] ? Number(m[2]) - 1 : 0, c0 = m[1] ? col(m[1]) : 0;
  const single = m[3] === undefined && m[4] === undefined;
  const r1 = single ? (m[2] ? r0 : null) : (m[4] ? Number(m[4]) - 1 : null);
  const c1 = single ? (m[1] ? c0 : null) : (m[3] ? col(m[3]) : null);
  return { tab, r0, c0, r1, c1 };
}

const httpError = (code: number, message: string): Error => Object.assign(new Error(message), { code, status: code });

function hexToRgb(hex: string): sheets_v4.Schema$Color {
  const h = hex.replace('#', '');
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}
function rgbToHex(c: sheets_v4.Schema$Color | null | undefined): string | null {
  if (!c) return null;
  const h = (v: number | null | undefined): string => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.red) + h(c.green) + h(c.blue);
}

export class FakeGoogle {
  readonly books = new Map<string, FakeBook>();
  readonly calls: FakeCall[] = [];
  /** Spreadsheets that answer 404. */
  readonly unreachable = new Set<string>();
  /** Spreadsheets the robot may only read (writes answer 403). */
  readonly readOnly = new Set<string>();
  /** A spreadsheets.batchUpdate whose requests match fails (a crash in the middle of a step). */
  failWhen: ((id: string, r: sheets_v4.Schema$Request) => boolean) | null = null;
  /** Source tab titles whose copies come out different (a bad copy). */
  readonly corruptCopies = new Set<string>();
  /**
   * C3: keep merges and formatting requests per tab, clear values on updateCells(userEnteredValue), and drop a
   * value written into a covered (not top-left) cell of a merge, as Sheets does (D11). Off by default.
   */
  emulateFormats = false;

  addBook(id: string, title: string, tabs: Record<string, Cell[][]> = {}, opts: { hidden?: readonly string[] } = {}): FakeBook {
    const b: FakeBook = { id, title, tabs: [], metadata: new Map(), nextId: 100 };
    for (const [name, cells] of Object.entries(tabs)) this.addTab(b, name, cells, opts.hidden?.includes(name) ?? false);
    this.books.set(id, b);
    return b;
  }

  addTab(b: FakeBook, title: string, cells: Cell[][] = [], hidden = false): FakeTab {
    const t: FakeTab = { sheetId: b.nextId++, title, hidden, rowCount: Math.max(1000, cells.length), columnCount: Math.max(26, ...cells.map((r) => r.length)), cells: cells.map((r) => [...r]), color: null };
    b.tabs.push(t);
    return t;
  }

  book(id: string): FakeBook {
    if (this.unreachable.has(id)) throw httpError(404, 'Requested entity was not found.');
    const b = this.books.get(id);
    if (!b) throw httpError(404, 'Requested entity was not found.');
    return b;
  }

  tab(id: string, title: string): FakeTab | undefined {
    return this.books.get(id)?.tabs.find((t) => t.title === title);
  }

  titles(id: string): string[] {
    return (this.books.get(id)?.tabs ?? []).map((t) => t.title);
  }

  /** The used cells of a tab as the API returns them (trailing blanks trimmed). */
  values(id: string, title: string): Cell[][] {
    const t = this.tab(id, title);
    if (!t) return [];
    return trim(t.cells);
  }

  writeCount(id: string): number {
    return this.calls.filter((c) => c.id === id && /^(values\.(batchUpdate|batchClear|append)|batchUpdate|copyTo:dest)$/.test(c.method)).length;
  }

  private findTab(b: FakeBook, title: string): FakeTab {
    const t = b.tabs.find((x) => x.title === title);
    if (!t) throw httpError(400, 'Unable to parse range: ' + title);
    return t;
  }

  private read(b: FakeBook, range: string): Cell[][] {
    const r = parseRange(range);
    const t = this.findTab(b, r.tab);
    const rows = t.cells;
    const r1 = r.r1 ?? rows.length - 1;
    const out: Cell[][] = [];
    for (let i = r.r0; i <= r1 && i < rows.length; i++) {
      const row = rows[i] ?? [];
      const c1 = r.c1 ?? row.length - 1;
      out.push(row.slice(r.c0, c1 + 1));
    }
    return trim(out);
  }

  private write(b: FakeBook, range: string, values: unknown[][]): number {
    const r = parseRange(range);
    const t = this.findTab(b, r.tab);
    let n = 0;
    values.forEach((row, i) => row.forEach((v, j) => {
      const ri = r.r0 + i, ci = r.c0 + j;
      while (t.cells.length <= ri) t.cells.push([]);
      const line = t.cells[ri]!;
      while (line.length <= ci) line.push('');
      if (this.emulateFormats && (t.merges ?? []).some((m) => ri >= (m.startRowIndex ?? 0) && ri < (m.endRowIndex ?? 0) && ci >= (m.startColumnIndex ?? 0) && ci < (m.endColumnIndex ?? 0) && !(ri === m.startRowIndex && ci === m.startColumnIndex))) return;
      line[ci] = (v === null || v === undefined ? '' : v) as Cell;
      n++;
    }));
    t.rowCount = Math.max(t.rowCount, t.cells.length);
    t.columnCount = Math.max(t.columnCount, ...t.cells.map((x) => x.length));
    return n;
  }

  private clear(b: FakeBook, range: string): void {
    const r = parseRange(range);
    const t = this.findTab(b, r.tab);
    if (r.r1 === null && r.c1 === null && r.r0 === 0 && r.c0 === 0) { t.cells = []; return; }
    for (let i = r.r0; i < t.cells.length && (r.r1 === null || i <= r.r1); i++) {
      const row = t.cells[i]!;
      for (let j = r.c0; j < row.length && (r.c1 === null || j <= r.c1); j++) row[j] = '';
    }
  }

  private mustWrite(id: string): void {
    if (this.readOnly.has(id)) throw httpError(403, 'The caller does not have permission');
  }

  get api(): sheets_v4.Sheets {
    const g = this;
    const sheetJson = (t: FakeTab, withData: boolean): sheets_v4.Schema$Sheet => ({
      properties: { sheetId: t.sheetId, title: t.title, hidden: t.hidden, gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount }, ...(t.color ? { tabColorStyle: { rgbColor: hexToRgb(t.color) } } : {}) },
      ...(withData ? {
        data: [{ startRow: 0, startColumn: 0, rowData: t.cells.map((row, i) => ({ values: row.map((v, j) => ({
          ...(typeof v === 'string' && v.startsWith('=') ? { userEnteredValue: { formulaValue: v } } : {}),
          ...(i === 0 && j === 0 && t.pivotSourceSheetId !== undefined ? { pivotTable: { source: { sheetId: t.pivotSourceSheetId } } } : {}),
        })) })) }],
        charts: t.charts ?? [], filterViews: t.filterViews ?? [],
      } : {}),
    });
    return {
      spreadsheets: {
        get: async (p: { spreadsheetId: string; ranges?: string[]; includeGridData?: boolean }) => {
          g.calls.push({ id: p.spreadsheetId, method: 'get' });
          const b = g.book(p.spreadsheetId);
          const want = p.ranges ? new Set(p.ranges.map((r) => parseRange(r).tab)) : null;
          const sheets = b.tabs.filter((t) => !want || want.has(t.title)).map((t) => sheetJson(t, !!p.includeGridData));
          return { data: {
            properties: { title: b.title }, sheets,
            developerMetadata: [...b.metadata].map(([k, v], i) => ({ metadataId: i + 1, metadataKey: k, metadataValue: v, location: { spreadsheet: true, locationType: 'SPREADSHEET' } })),
          } };
        },
        values: {
          batchGet: async (p: { spreadsheetId: string; ranges: string[] }) => {
            g.calls.push({ id: p.spreadsheetId, method: 'values.batchGet', ranges: p.ranges });
            const b = g.book(p.spreadsheetId);
            return { data: { valueRanges: p.ranges.map((r) => { const v = g.read(b, r); return v.length ? { range: r, values: v } : { range: r }; }) } };
          },
          batchUpdate: async (p: { spreadsheetId: string; requestBody: { data: Array<{ range: string; values: unknown[][] }> } }) => {
            g.calls.push({ id: p.spreadsheetId, method: 'values.batchUpdate' });
            g.mustWrite(p.spreadsheetId);
            const b = g.book(p.spreadsheetId);
            let n = 0;
            for (const d of p.requestBody.data) n += g.write(b, d.range, d.values);
            return { data: { totalUpdatedCells: n } };
          },
          batchClear: async (p: { spreadsheetId: string; requestBody: { ranges: string[] } }) => {
            g.calls.push({ id: p.spreadsheetId, method: 'values.batchClear' });
            g.mustWrite(p.spreadsheetId);
            const b = g.book(p.spreadsheetId);
            for (const r of p.requestBody.ranges) g.clear(b, r);
            return { data: {} };
          },
          append: async (p: { spreadsheetId: string; range: string; requestBody: { values: unknown[][] } }) => {
            g.calls.push({ id: p.spreadsheetId, method: 'values.append' });
            g.mustWrite(p.spreadsheetId);
            const b = g.book(p.spreadsheetId);
            const t = g.findTab(b, parseRange(p.range).tab);
            const start = trim(t.cells).length;
            for (const [i, row] of p.requestBody.values.entries()) t.cells[start + i] = row.map((v) => (v ?? '') as Cell);
            return { data: { updates: { updatedRows: p.requestBody.values.length } } };
          },
        },
        batchUpdate: async (p: { spreadsheetId: string; requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
          g.calls.push({ id: p.spreadsheetId, method: 'batchUpdate' });
          g.mustWrite(p.spreadsheetId);
          const b = g.book(p.spreadsheetId);
          // All or nothing, like the real API: work on a copy.
          if (g.failWhen && p.requestBody.requests.some((r) => g.failWhen!(p.spreadsheetId, r))) throw httpError(500, 'Internal error (fake crash)');
          const tabs = b.tabs.map((t) => ({ ...t, cells: t.cells.map((r) => [...r]), ...(t.merges ? { merges: [...t.merges] } : {}), ...(t.formats ? { formats: [...t.formats] } : {}) }));
          const replies: sheets_v4.Schema$Response[] = [];
          const byId = (id: number | null | undefined): FakeTab => {
            const t = tabs.find((x) => x.sheetId === id);
            if (!t) throw httpError(400, 'No grid with id: ' + id);
            return t;
          };
          const meta = new Map(b.metadata);
          let title = b.title, nextId = b.nextId;
          for (const r of p.requestBody.requests) {
            if (r.addSheet) {
              const name = String(r.addSheet.properties?.title);
              if (tabs.some((t) => t.title === name)) throw httpError(400, 'A sheet with the name "' + name + '" already exists.');
              const sheetId = nextId++;
              tabs.push({ sheetId, title: name, hidden: false, rowCount: 1000, columnCount: r.addSheet.properties?.gridProperties?.columnCount ?? 26, cells: [], color: null });
              replies.push({ addSheet: { properties: { sheetId, title: name } } });
              continue;
            } else if (g.emulateFormats && r.unmergeCells) {
              byId(r.unmergeCells.range?.sheetId).merges = [];
            } else if (g.emulateFormats && r.mergeCells) {
              const t = byId(r.mergeCells.range?.sheetId);
              t.merges = [...(t.merges ?? []), r.mergeCells.range!];
            } else if (g.emulateFormats && r.updateCells && r.updateCells.fields === 'userEnteredValue') {
              byId(r.updateCells.range?.sheetId).cells = [];
            } else if (g.emulateFormats && (r.repeatCell || r.updateCells || r.updateDimensionProperties)) {
              const t = byId(r.repeatCell?.range?.sheetId ?? r.updateCells?.range?.sheetId ?? r.updateDimensionProperties?.range?.sheetId);
              t.formats = [...(t.formats ?? []), r];
            } else if (r.deleteSheet) {
              const i = tabs.findIndex((t) => t.sheetId === r.deleteSheet!.sheetId);
              if (i < 0) throw httpError(400, 'No grid with id: ' + r.deleteSheet.sheetId);
              tabs.splice(i, 1);
              if (!tabs.length) throw httpError(400, 'You can\'t remove all the sheets in a document.');
            } else if (r.updateSheetProperties) {
              const pr = r.updateSheetProperties.properties!;
              const t = tabs.find((x) => x.sheetId === pr.sheetId);
              if (!t) throw httpError(400, 'No grid with id: ' + pr.sheetId);
              const f = String(r.updateSheetProperties.fields);
              if (/(^|,)title/.test(f)) {
                if (tabs.some((x) => x !== t && x.title === pr.title)) throw httpError(400, 'A sheet with the name "' + pr.title + '" already exists.');
                t.title = String(pr.title);
              }
              if (/(^|,)hidden/.test(f)) t.hidden = !!pr.hidden;
              if (/tabColor/.test(f)) t.color = rgbToHex(pr.tabColorStyle?.rgbColor ?? pr.tabColor ?? null);
              if (/gridProperties\.columnCount/.test(f)) t.columnCount = pr.gridProperties?.columnCount ?? t.columnCount;
              if (g.emulateFormats && /frozenRowCount/.test(f)) t.formats = [...(t.formats ?? []), r];
            } else if (r.createDeveloperMetadata) {
              const m = r.createDeveloperMetadata.developerMetadata!;
              meta.set(String(m.metadataKey), String(m.metadataValue ?? ''));
            } else if (r.deleteDeveloperMetadata) {
              meta.delete(String(r.deleteDeveloperMetadata.dataFilter?.developerMetadataLookup?.metadataKey));
            } else if (r.updateSpreadsheetProperties) {
              title = String(r.updateSpreadsheetProperties.properties?.title ?? title);
            }
            replies.push({});
          }
          b.tabs = tabs; b.metadata = meta; b.title = title; b.nextId = nextId;
          return { data: { replies } };
        },
        sheets: {
          copyTo: async (p: { spreadsheetId: string; sheetId: number; requestBody: { destinationSpreadsheetId: string } }) => {
            g.calls.push({ id: p.spreadsheetId, method: 'copyTo' });
            const src = g.book(p.spreadsheetId);
            const dest = g.book(p.requestBody.destinationSpreadsheetId);
            g.calls.push({ id: dest.id, method: 'copyTo:dest' });
            g.mustWrite(dest.id);
            const t = src.tabs.find((x) => x.sheetId === p.sheetId);
            if (!t) throw httpError(400, 'No grid with id: ' + p.sheetId);
            let name = 'Copy of ' + t.title, n = 2;
            while (dest.tabs.some((x) => x.title === name)) name = 'Copy of ' + t.title + ' ' + n++;
            const made: FakeTab = { ...t, sheetId: dest.nextId++, title: name, hidden: false, cells: t.cells.map((r) => [...r]) };
            if (g.corruptCopies.has(t.title)) made.cells.push(['corrupted']);
            dest.tabs.push(made);
            return { data: { sheetId: made.sheetId, title: made.title } };
          },
        },
      },
    } as unknown as sheets_v4.Sheets;
  }
}

function trim(rows: Cell[][]): Cell[][] {
  const out = rows.map((r) => {
    const x = [...r];
    while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop();
    return x;
  });
  while (out.length && out[out.length - 1]!.length === 0) out.pop();
  return out;
}
