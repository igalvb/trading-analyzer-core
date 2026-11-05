/**
 * npm run trim-price-tabs: shrinks the saved price-history tabs to the 6 columns they use (F-B7-10).
 * Google gives a new tab 26 columns; the 124 price tabs held about 2.5 million empty cells, which made
 * the Sheet too heavy to open on a phone (5.36 million of the 10 million cell limit, 2026-10-27).
 *
 * Only a tab that is certainly a price-history tab is touched: its name starts with '💾 ', cell A1 is
 * 'META' and row 2 is the Date/Open/High/Low/Close/Volume header (storage/priceHistory.ts writes exactly
 * A:F), and columns G onward are empty. Dry run unless --yes. Output is counts only.
 *
 * npm run trim-macro-tabs (this file with --macro; docs/SHEETS_CLEANUP_PLAN.md phase 4a): shrinks the
 * 11 '💾 Macro <TICKER>' tabs from 26 to the 5 columns storage/macroCaches.ts writes (Date, High, Low,
 * Close, Volume), about 0.58 million cells. Same safety rules: the name starts with '💾 Macro ' (never
 * '💾 Macro Snapshot'), row 1 is exactly that header, and every column after E is empty, read up to the
 * tab's real last column. Only the column count changes: no row and no value is touched, so the 10-year
 * macro history stays as it is. Dry run unless --yes.
 *
 * Exit code: 0 done, 1 a read or write failed, 2 configuration missing or unusable.
 *
 * Three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d)): the price tabs live in the data spreadsheet once My Portfolio
 * carries the `tradingDataMigrated` flag and DATA_SPREADSHEET_ID is set; the tool then works there. The migration
 * record ('💾 Migration') and the other protected tabs are never touched.
 */

import { processLine } from './core/logFile.ts';
import { pathToFileURL } from 'node:url';
import type { sheets_v4 } from 'googleapis';
import type { RateLimiter } from './sheets/limiter.ts';
import { createContext, type RunContext } from './core/context.ts';
import { SheetsClient, createSheetsApi, createSheetsLimiter, parseServiceAccount, type TabGrid } from './sheets/client.ts';
import { PRICE_HISTORY_PREFIX, PROTECTED_TABS, Tabs, a1 } from './sheets/tabs.ts';
import { MIGRATED_FLAG, sheetIdsFromEnv } from './sheets/threeSheets.ts';
import { PRICE_HISTORY_HEADER } from './storage/priceHistory.ts';
import { MACRO_PRICE_HEADER, MACRO_PRICE_TAB_PREFIX } from './storage/macroCaches.ts';
import type { SheetRow } from './sheets/coerce.ts';

export const PRICE_TAB_COLUMNS = PRICE_HISTORY_HEADER.length;
export const MACRO_TAB_COLUMNS = MACRO_PRICE_HEADER.length;
/** Ranges per values.batchGet call (the ranges travel in the URL). */
const READ_CHUNK = 40;

/** Which tabs a run shrinks, how a tab proves it is one of them, and to how many columns. */
export interface TrimKind {
  /** Name used in the output. */
  readonly label: string;
  readonly columns: number;
  /** By name only: may this tab be considered at all? */
  readonly candidate: (title: string) => boolean;
  /** The range holding the rows `isTab` checks. */
  readonly headRange: string;
  /** By content: the rows read from headRange. */
  readonly isTab: (head: readonly SheetRow[]) => boolean;
  readonly notTabReason: string;
}

const cell = (rows: readonly SheetRow[], r: number, c: number): string => String(rows[r]?.[c] ?? '');

export const PRICE_TRIM: TrimKind = {
  label: 'Trim price tabs',
  columns: PRICE_TAB_COLUMNS,
  candidate: (t) => t.startsWith(PRICE_HISTORY_PREFIX),
  headRange: 'A1:F2',
  isTab: (rows) => cell(rows, 0, 0) === 'META' && PRICE_HISTORY_HEADER.every((h, i) => cell(rows, 1, i) === h),
  notTabReason: 'not a price-history tab',
};

export const MACRO_TRIM: TrimKind = {
  label: 'Trim Macro tabs',
  columns: MACRO_TAB_COLUMNS,
  candidate: (t) => t.startsWith(MACRO_PRICE_TAB_PREFIX) && t !== Tabs.MACRO_SNAPSHOT,
  headRange: 'A1:E1',
  isTab: (rows) => MACRO_PRICE_HEADER.every((h, i) => cell(rows, 0, i) === h),
  notTabReason: 'not a Macro price tab',
};

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export type TrimSheets = Pick<SheetsClient, 'tabGrids' | 'batchGet' | 'formatBatch'>;

export interface TrimPlan {
  /** Tabs to shrink to the kind's column count. */
  readonly trim: readonly TabGrid[];
  /** Candidate tabs with extra columns that are left alone, and why. */
  readonly kept: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
  readonly cellsFreed: number;
}

/** Pure: which tabs to shrink, given each candidate's head rows (kind.headRange) and its columns after kind.columns. */
export function planTrim(
  grids: readonly TabGrid[], head: ReadonlyMap<string, SheetRow[]>, beyond: ReadonlyMap<string, SheetRow[]>, kind: TrimKind = PRICE_TRIM,
): TrimPlan {
  const trim: TabGrid[] = [];
  const kept: Array<{ title: string; reason: string }> = [];
  for (const g of grids) {
    if (!kind.candidate(g.title) || g.columnCount <= kind.columns) continue;
    if (PROTECTED_TABS.includes(g.title)) { kept.push({ title: g.title, reason: 'protected' }); continue; }
    if (!kind.isTab(head.get(g.title) ?? [])) { kept.push({ title: g.title, reason: kind.notTabReason }); continue; }
    const extra = (beyond.get(g.title) ?? []).some((r) => (r ?? []).some((v) => v !== '' && v != null));
    if (extra) { kept.push({ title: g.title, reason: 'has data after column ' + columnLetter(kind.columns) }); continue; }
    trim.push(g);
  }
  return { trim, kept, cellsFreed: trim.reduce((n, g) => n + g.rowCount * (g.columnCount - kind.columns), 0) };
}

async function readChunked(ctx: RunContext, sheets: TrimSheets, ranges: readonly string[], titles: readonly string[]): Promise<Map<string, SheetRow[]> | null> {
  const out = new Map<string, SheetRow[]>();
  for (let i = 0; i < ranges.length; i += READ_CHUNK) {
    const r = await sheets.batchGet(ctx, ranges.slice(i, i + READ_CHUNK));
    if (!r.ok) return null;
    r.value.forEach((rows, j) => out.set(titles[i + j] as string, rows));
  }
  return out;
}

export interface TrimCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly makeSheets?: (env: Readonly<Record<string, string | undefined>>) => TrimSheets;
  readonly ctx?: RunContext;
}

export interface DataSheetDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly ctx?: RunContext;
  /** Tests: the Sheets API (default: from GOOGLE_SERVICE_ACCOUNT_JSON). */
  readonly api?: sheets_v4.Sheets;
  readonly limiter?: RateLimiter;
}

/**
 * My Portfolio, or the data spreadsheet once the move is done (the My Portfolio flag decides, as in the startup guard).
 * Shared by trim-price-tabs and audit-script-properties (A5: 💾 Script Properties moved to the data spreadsheet).
 */
export async function dataSheetClient(deps: DataSheetDeps, label = 'Trim price tabs'): Promise<SheetsClient> {
  const api = deps.api ?? createSheetsApi(parseServiceAccount(deps.env['GOOGLE_SERVICE_ACCOUNT_JSON'] as string));
  const limiter = deps.limiter ?? createSheetsLimiter();
  const ids = sheetIdsFromEnv(deps.env);
  const portfolio = new SheetsClient({ spreadsheetId: ids.portfolio, api, limiter });
  if (!ids.data) return portfolio;
  const st = await portfolio.spreadsheetState(deps.ctx ?? createContext({ mode: 'lock' }));
  if (!st.ok) throw new Error('My Portfolio could not be read, so it is not known which spreadsheet holds the price tabs');
  if (st.value.metadata[MIGRATED_FLAG] === undefined) return portfolio;
  deps.out(label + ': working on the data spreadsheet (the move is done).');
  return new SheetsClient({ spreadsheetId: ids.data, api, limiter });
}

export async function runTrimPriceTabs(deps: TrimCliDeps): Promise<number> {
  const kind = deps.argv.includes('--macro') ? MACRO_TRIM : PRICE_TRIM;
  const name = kind.label;
  const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
  if (missing.length) { deps.errOut(name + ': missing environment variable(s): ' + missing.join(', ')); return 2; }
  let sheets: TrimSheets;
  try {
    sheets = deps.makeSheets ? deps.makeSheets(deps.env) : await dataSheetClient(deps);
  } catch (e) {
    deps.errOut(name + ': ' + (e instanceof Error ? e.message : 'the Google credentials are unusable'));
    return 2;
  }
  const ctx = deps.ctx ?? createContext({ mode: 'lock' });
  const grids = await sheets.tabGrids(ctx);
  if (!grids.ok) { deps.errOut(name + ': the tab list could not be read. Details are in the log.'); return 1; }
  const candidates = grids.value.filter((g) => kind.candidate(g.title) && g.columnCount > kind.columns);
  const titles = candidates.map((g) => g.title);
  const head = await readChunked(ctx, sheets, titles.map((t) => a1(t, kind.headRange)), titles);
  // Price tabs keep F-B7-10's G1:Z; the Macro run reads every column after E up to the tab's real last column.
  const beyondRange = (g: TabGrid): string => (kind === PRICE_TRIM ? 'G1:Z' : `${columnLetter(kind.columns + 1)}1:${columnLetter(g.columnCount)}`);
  const beyond = await readChunked(ctx, sheets, candidates.map((g) => a1(g.title, beyondRange(g))), titles);
  if (!head || !beyond) { deps.errOut(name + ': the tabs could not be read. Details are in the log.'); return 1; }
  const plan = planTrim(grids.value, head, beyond, kind);
  const total = grids.value.reduce((n, g) => n + g.rowCount * g.columnCount, 0);
  const which = kind === PRICE_TRIM ? "'💾'" : "'💾 Macro'";
  deps.out(`${name}: ${plan.trim.length} tab(s) to shrink to ${kind.columns} columns, ${plan.kept.length} ${which} tab(s) left as they are; frees ${plan.cellsFreed} of ${total} cells.`);
  for (const k of plan.kept) deps.out(`  kept: ${k.title} (${k.reason})`);
  if (kind === MACRO_TRIM) for (const g of plan.trim) deps.out(`  shrink: ${g.title} (all ${g.rowCount} rows kept; columns ${g.columnCount} -> ${kind.columns})`);
  if (!deps.argv.includes('--yes')) { deps.out('Dry run: nothing changed. Run again with --yes to shrink them.'); return 0; }
  if (!plan.trim.length) return 0;
  const r = await sheets.formatBatch(ctx, plan.trim.map((g) => ({ updateSheetProperties: { properties: { sheetId: g.sheetId, gridProperties: { columnCount: kind.columns } }, fields: 'gridProperties.columnCount' } })));
  if (!r.ok) { deps.errOut(name + ': the change could not be saved. Nothing was half-done: the Sheet applies the whole batch or none of it.'); return 1; }
  deps.out(`${name}: ${plan.trim.length} tab(s) shrunk.`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runTrimPriceTabs({ env: process.env, argv: process.argv.slice(2), out: (l) => console.log(l), errOut: (l) => console.error(l) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error('Trim tabs: unexpected failure.'); processLine('CRITICAL', 'trim', 'stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exitCode = 1; },
  );
}
