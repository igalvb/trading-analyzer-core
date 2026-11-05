/**
 * The price-cache cleanup, ported from fullStockAnalysisV10_9.gs:
 *   findStalePriceCacheSheetsV1_ :6106-6124, cleanupPriceCacheSheetsV1Menu :6129-6154
 *
 * THESE DELETE TABS. User decision: the CLI form is a DRY RUN unless
 * deps.apply is true (the explicit --yes flag). With apply, legacy's flow is
 * kept exactly: the same list, title and body go to deps.confirm (the YES_NO
 * ui.alert), a "no" logs 'cancelled by user', a "yes" deletes one tab at a
 * time with legacy's per-tab try/catch, then the same log and alert lines.
 *
 * Selection (unchanged): a tab named with the price-history prefix '💾 '
 * (so the '💾 Macro ' tabs too), at least 3 rows, whose last row's column A
 * is a valid Date older than 90 days.
 *
 * HAZARDS (F-C3):
 *  - SheetsWorkbookBackend.readTab returns dates as serial NUMBERS, which
 *    legacy's `instanceof Date` rejects: with the default toDate nothing is
 *    ever stale. Pass toDate: serialAwareDate(timeZone).
 *  - A tab that was not loaded makes getLastRow throw and legacy's catch
 *    skips it silently. Open with openPriceCacheWorkbook.
 *
 * Deleting goes through CleanupWorkbook.deleteSheet, which may be async:
 * DeletableWorkbook wraps a ReportWorkbook and deletes through the Sheets
 * API (sheetsTabDeleter) immediately, so a failed delete is caught per tab.
 */

import type { Clock, RunContext } from '../core/context.ts';
import { PRICE_HISTORY_PREFIX } from '../sheets/tabs.ts';
import { ReportWorkbook, type ReportSheet, type WorkbookBackend } from '../sheets/reportSheet.ts';
import { sheetsSerialToDate, type PriceSheetsApi } from '../storage/priceHistory.ts';
import { TabStoreError } from '../storage/tabStore.ts';

export const PRICE_CACHE_STALE_DAYS = 90;

export interface StaleCandidate {
  readonly name: string;
  readonly lastDate: Date;
  readonly daysOld: number;
}

export interface CleanupSheet {
  getName(): string;
  getLastRow(): number;
  getRange(row: number, col: number): { getValue(): unknown };
}

export interface CleanupWorkbook {
  getSheets(): CleanupSheet[];
  getSheetByName(name: string): CleanupSheet | null;
  deleteSheet(sheet: CleanupSheet | null): void | Promise<void>;
}

const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';

/** findStalePriceCacheSheetsV1_ (:6106-6124). `nowMs` replaces Date.now() (read twice in legacy, once here). */
export function findStalePriceCacheSheets(ss: CleanupWorkbook, nowMs: number, toDate: (v: unknown) => unknown = (v) => v): StaleCandidate[] {
  const cutoff = nowMs - PRICE_CACHE_STALE_DAYS * 86400000;
  const candidates: StaleCandidate[] = [];
  ss.getSheets().forEach((sh) => {
    const name = sh.getName();
    if (name.indexOf(PRICE_HISTORY_PREFIX) !== 0) return;
    try {
      const lastRow = sh.getLastRow();
      if (lastRow < 3) return; // no real data rows, not a genuine cache sheet
      const lastDate = toDate(sh.getRange(lastRow, 1).getValue());
      if (!isDate(lastDate) || isNaN(lastDate.getTime())) return;
      if (lastDate.getTime() < cutoff) {
        candidates.push({ name, lastDate, daysOld: Math.floor((nowMs - lastDate.getTime()) / 86400000) });
      }
    } catch (e) { /* a malformed sheet is skipped, never crashes the scan */ }
  });
  return candidates;
}

export interface CleanupDeps {
  readonly workbook: CleanupWorkbook;
  readonly clock: Clock;
  readonly alert: (message: string, title?: string) => void;
  /** ui.alert(title, body, YES_NO) === YES. Only called when apply is true. */
  readonly confirm: (title: string, body: string) => boolean;
  readonly log: (message: string) => void;
  /** The explicit yes flag. False: report the candidates and delete nothing. */
  readonly apply: boolean;
  readonly toDate?: (v: unknown) => unknown;
}

export type CleanupMode = 'nothing-stale' | 'dry-run' | 'cancelled' | 'deleted';

export interface CleanupResult {
  readonly mode: CleanupMode;
  readonly candidates: readonly StaleCandidate[];
  readonly deleted: number;
}

/** cleanupPriceCacheSheetsV1Menu (:6129-6154). */
export async function cleanupPriceCacheSheets(deps: CleanupDeps): Promise<CleanupResult> {
  const ss = deps.workbook;
  const candidates = findStalePriceCacheSheets(ss, deps.clock.now(), deps.toDate);
  if (!candidates.length) {
    deps.alert('No price-cache sheets are older than ' + PRICE_CACHE_STALE_DAYS + ' days — nothing to clean up.');
    return { mode: 'nothing-stale', candidates, deleted: 0 };
  }
  const list = candidates
    .sort((a, b) => b.daysOld - a.daysOld)
    .map((c) => '  ' + c.name + '  (last data: ' + c.lastDate.toISOString().slice(0, 10) + ', ' + c.daysOld + ' days old)')
    .join('\n');
  const title = 'Delete ' + candidates.length + ' stale price-cache sheet' + (candidates.length === 1 ? '' : 's') + '?';
  const body = list + '\n\nThese haven\'t been refreshed in over ' + PRICE_CACHE_STALE_DAYS + ' days. Deleting them is permanent -- the next real analysis of that ticker will just rebuild the cache from a fresh live fetch, same as it would today anyway.';
  if (!deps.apply) {
    deps.alert(body, title);
    deps.log('Price-cache cleanup: dry run -- nothing deleted (pass --yes to delete).');
    return { mode: 'dry-run', candidates, deleted: 0 };
  }
  if (!deps.confirm(title, body)) { deps.log('Price-cache cleanup: cancelled by user.'); return { mode: 'cancelled', candidates, deleted: 0 }; }
  let deleted = 0;
  for (const c of candidates) {
    try { await ss.deleteSheet(ss.getSheetByName(c.name)); deleted++; }
    catch (e) { deps.log('Price-cache cleanup: failed to delete ' + c.name + ': ' + e.message); }
  }
  deps.log('Price-cache cleanup: deleted ' + deleted + '/' + candidates.length + ' stale sheets.');
  deps.alert('Deleted ' + deleted + ' stale price-cache sheet' + (deleted === 1 ? '' : 's') + '.');
  return { mode: 'deleted', candidates, deleted };
}

/** A ReportWorkbook that can delete tabs: each delete goes to `deleteTab` at once; deleted tabs vanish from the view. */
export class DeletableWorkbook implements CleanupWorkbook {
  private readonly book: ReportWorkbook;
  private readonly deleteTab: (name: string) => Promise<void>;
  private readonly gone = new Set<string>();
  constructor(book: ReportWorkbook, deleteTab: (name: string) => Promise<void>) {
    this.book = book;
    this.deleteTab = deleteTab;
  }
  getSheets(): ReportSheet[] { return this.book.getSheets().filter((s) => !this.gone.has(s.getName())); }
  getSheetByName(name: string): ReportSheet | null { return this.gone.has(name) ? null : this.book.getSheetByName(name); }
  async deleteSheet(sheet: CleanupSheet | null): Promise<void> {
    if (!sheet) throw new Error('Cannot delete a sheet that does not exist.');
    await this.deleteTab(sheet.getName());
    this.gone.add(sheet.getName());
  }
}

/** Deletes a tab through the Sheets API (spreadsheets.batchUpdate deleteSheet). */
export function sheetsTabDeleter(ctx: RunContext, api: PriceSheetsApi): (name: string) => Promise<void> {
  return async (name) => {
    const ids = await api.tabIds(ctx);
    if (!ids.ok) throw new TabStoreError(ids.error);
    const sheetId = ids.value[name];
    if (sheetId === undefined) throw new Error('No sheet named "' + name + '".');
    const r = await api.formatBatch(ctx, [{ deleteSheet: { sheetId } }]);
    if (!r.ok) throw new TabStoreError(r.error);
  };
}

/** Opens a workbook with only the price-cache tabs loaded (the only ones the scan reads). */
export async function openPriceCacheWorkbook(backend: WorkbookBackend): Promise<ReportWorkbook> {
  const tabs = await backend.listTabs();
  return ReportWorkbook.open(backend, tabs.map((t) => t.name).filter((n) => n.indexOf(PRICE_HISTORY_PREFIX) === 0));
}

/** Sheets returns date cells as serial numbers; turns them into Dates in the spreadsheet's zone (F-C3). */
export function serialAwareDate(timeZone: string): (v: unknown) => unknown {
  return (v) => (typeof v === 'number' ? sheetsSerialToDate(v, timeZone) : v);
}
