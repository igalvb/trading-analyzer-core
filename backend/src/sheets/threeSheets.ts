/**
 * Three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d), phase 2): configuration, the two My Portfolio flags,
 * the `💾 Migration` marker, and the startup guard.
 *
 *   SPREADSHEET_ID           My Portfolio (unchanged)
 *   REPORTS_SPREADSHEET_ID   tickerAnalysisReports   (new; '' counts as unset: GitHub passes '' for a missing secret)
 *   DATA_SPREADSHEET_ID      stocksAndMarketMetadata (new; same)
 *
 * THE AUTHORITY FOR ROUTING is the developer-metadata flag `tradingDataMigrated` on My Portfolio, never the
 * secrets alone. Flag unset = today's behaviour (everything in My Portfolio), whatever the secrets say. Flag set
 * = routing to the two new sheets, and only when every check of the guard passes; otherwise the run refuses
 * (exit 2, one plain sentence, nothing written). The migrate tool writes the flag BEFORE the marker, so a crash
 * between the two leaves every run refusing, which fails safe.
 *
 * A second flag, `sheetsPaused` (value: the expiry instant), is the maintenance pause the migration tool sets:
 * while it is set and not expired, a run writes nothing and exits cleanly (exit 0); Telegram-started runs say
 * "paused, send it again after HH:MM UTC" (app/sheetGuardExit.ts).
 *
 * Only the migrate tool (src/migrateDataTabs.ts via sheets/migration.ts) writes either flag.
 */

import type { RunContext } from '../core/context.ts';
import type { SheetRow } from './coerce.ts';
import type { SheetsClient, SpreadsheetState } from './client.ts';
import { MIGRATION_MARKER_TAB, Tabs, a1 } from './tabs.ts';

export const MIGRATED_FLAG = 'tradingDataMigrated';
export const PAUSED_FLAG = 'sheetsPaused';

/** Tabs the data sheet must hold before routing is allowed. */
export const REQUIRED_DATA_TABS: readonly string[] = [Tabs.SCRIPT_PROPERTIES, '📝 Paper State'];
/** Tabs the reports sheet must hold before routing is allowed (state the Buy/Exit pipelines and the paper test read back). */
export const REQUIRED_REPORT_TABS: readonly string[] = [Tabs.DECISION_HISTORY, 'Exit Target History', '📒 Paper Log', '📈 Paper Values'];

export interface SheetIds {
  readonly portfolio: string;
  readonly reports: string | null;
  readonly data: string | null;
}

const clean = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

/** The three IDs from the environment; an empty or blank value counts as unset. */
export function sheetIdsFromEnv(env: Readonly<Record<string, string | undefined>>): SheetIds {
  return { portfolio: clean(env.SPREADSHEET_ID) ?? '', reports: clean(env.REPORTS_SPREADSHEET_ID), data: clean(env.DATA_SPREADSHEET_ID) };
}

/** Thrown when the startup guard refuses: the entry prints `message` (one plain sentence) and exits 2. */
export class SheetsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetsRefusedError';
  }
}

/** Thrown while the maintenance pause is on: the entry exits 0 without writing. */
export class SheetsPausedError extends Error {
  readonly until: Date;
  constructor(until: Date) {
    super(pausedLine(until));
    this.name = 'SheetsPausedError';
    this.until = until;
  }
}

/** "HH:MM" in UTC. */
export function utcHhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

export function pausedLine(until: Date): string {
  return 'Paused for maintenance until about ' + utcHhmm(until) + ' UTC; please send it again after that.';
}

/** The pause's expiry, when the flag is set and not expired at `now`; otherwise null (an expired pause is ignored). */
export function activePause(metadata: Readonly<Record<string, string>>, now: number): Date | null {
  const raw = metadata[PAUSED_FLAG];
  if (raw === undefined) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t <= now) return null;
  return new Date(t);
}

// ---- the `💾 Migration` marker ------------------------------------------------------------------------------

export type MarkerStatus = 'VERIFIED' | 'ROLLED_BACK';

export interface MarkerTabRecord {
  readonly tab: string;
  /** 'data' or 'reports': where the tab went. */
  readonly sheet: string;
  readonly rows: number;
  readonly columns: number;
  readonly nonEmpty: number;
  readonly hidden: boolean;
  readonly sha256: string;
}

export interface Marker {
  readonly status: string;
  readonly portfolioId: string;
  readonly reportsId: string;
  readonly dataId: string;
  readonly verifiedAt: string;
  readonly tabs: readonly MarkerTabRecord[];
  /** My Portfolio's tab names when `migrate` ran (the post-switch check expects no new ones). */
  readonly portfolioTabsAtMigrate: readonly string[];
  /** Report-routed tabs that were in My Portfolio at `migrate` (deleted, not copied). */
  readonly deleteOnly: readonly string[];
}

export const MARKER_TAB_HEADER: readonly string[] = ['Tab', 'Sheet', 'Rows', 'Columns', 'NonEmpty', 'Hidden', 'SHA256'];
const PORTFOLIO_TAB_ROW = '(My Portfolio tab at migrate)';
const DELETE_ONLY_ROW = '(deleted, not copied)';

/** The marker's cells. Section 1: key/value rows; then the per-tab table; then the two name lists. */
export function markerRows(m: Marker): SheetRow[] {
  const rows: SheetRow[] = [
    ['Status', m.status], ['PortfolioSpreadsheetId', m.portfolioId], ['ReportsSpreadsheetId', m.reportsId], ['DataSpreadsheetId', m.dataId],
    ['VerifiedAt', m.verifiedAt], [''], [...MARKER_TAB_HEADER],
  ];
  for (const t of m.tabs) rows.push([t.tab, t.sheet, t.rows, t.columns, t.nonEmpty, t.hidden ? 'TRUE' : 'FALSE', t.sha256]);
  rows.push(['']);
  for (const n of m.portfolioTabsAtMigrate) rows.push([PORTFOLIO_TAB_ROW, n]);
  for (const n of m.deleteOnly) rows.push([DELETE_ONLY_ROW, n]);
  return rows;
}

/** Reads the marker back; null when the cells are not a marker. */
export function parseMarker(rows: readonly SheetRow[]): Marker | null {
  const kv: Record<string, string> = {};
  let i = 0;
  for (; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const k = String(r[0] ?? '');
    if (k === '') { i++; break; }
    kv[k] = String(r[1] ?? '');
  }
  if (!kv.Status) return null;
  const tabs: MarkerTabRecord[] = [];
  const portfolioTabsAtMigrate: string[] = [];
  const deleteOnly: string[] = [];
  for (; i < rows.length; i++) {
    const r = (rows[i] ?? []).map((v) => (v == null ? '' : v));
    const k = String(r[0] ?? '');
    if (k === 'Tab' && String(r[1]) === 'Sheet') continue;
    if (k === PORTFOLIO_TAB_ROW) { portfolioTabsAtMigrate.push(String(r[1] ?? '')); continue; }
    if (k === DELETE_ONLY_ROW) { deleteOnly.push(String(r[1] ?? '')); continue; }
    if (k === '') continue;
    tabs.push({ tab: k, sheet: String(r[1]), rows: Number(r[2]), columns: Number(r[3]), nonEmpty: Number(r[4]), hidden: String(r[5]).toUpperCase() === 'TRUE' || r[5] === true, sha256: String(r[6]) });
  }
  return {
    status: kv.Status, portfolioId: kv.PortfolioSpreadsheetId ?? '', reportsId: kv.ReportsSpreadsheetId ?? '', dataId: kv.DataSpreadsheetId ?? '',
    verifiedAt: kv.VerifiedAt ?? '', tabs, portfolioTabsAtMigrate, deleteOnly,
  };
}

/** Reads `💾 Migration` from the data sheet; null when the tab is missing or not a marker. */
export async function readMarker(ctx: RunContext, data: Pick<SheetsClient, 'batchGet'>, state: SpreadsheetState): Promise<Marker | null> {
  if (!state.tabs.some((t) => t.title === MIGRATION_MARKER_TAB)) return null;
  const r = await data.batchGet(ctx, [a1(MIGRATION_MARKER_TAB)]);
  if (!r.ok) throw new Error('could not read the migration marker: ' + String(r.error.detail));
  return parseMarker(r.value[0] ?? []);
}

// ---- the startup guard --------------------------------------------------------------------------------------

export type GuardClient = Pick<SheetsClient, 'spreadsheetState' | 'batchGet'>;

export type GuardDecision =
  | { readonly mode: 'single'; readonly warnings: readonly string[] }
  | { readonly mode: 'routed'; readonly reportsId: string; readonly dataId: string; readonly warnings: readonly string[] };

export interface GuardDeps {
  readonly portfolio: GuardClient;
  /** A client for one of the new spreadsheets (built only when needed). */
  readonly open: (spreadsheetId: string) => GuardClient;
  readonly now: number;
}

const has = (s: SpreadsheetState, name: string): boolean => s.tabs.some((t) => t.title === name);

/**
 * The guard table of plan (d). Throws SheetsPausedError (pause on) or SheetsRefusedError (refuse);
 * otherwise says whether routing is on. Reads only; never writes.
 */
export async function checkStartup(ctx: RunContext, ids: SheetIds, deps: GuardDeps): Promise<GuardDecision> {
  const p = await deps.portfolio.spreadsheetState(ctx);
  // As before the three-spreadsheet change: an unreadable My Portfolio is a plain failure (exit 1), not a refusal.
  if (!p.ok) {
    ctx.log.critical('startup: My Portfolio spreadsheet unreachable; the run cannot start', { detail: String(p.error.detail) });
    throw new Error('could not load the property store tab: ' + String(p.error.detail));
  }
  const pause = activePause(p.value.metadata, deps.now);
  if (pause) throw new SheetsPausedError(pause);
  const migrated = p.value.metadata[MIGRATED_FLAG] !== undefined;

  if (!migrated) {
    if (!has(p.value, Tabs.SCRIPT_PROPERTIES)) {
      ctx.log.critical('startup refused: My Portfolio has no Script Properties tab');
      throw new SheetsRefusedError('The spreadsheet has no "💾 Script Properties" tab, so the run stopped instead of starting an empty store. Nothing was changed.');
    }
    const warnings: string[] = [];
    if (ids.data) {
      // Only a reminder: with the flag cleared after a rollback, the runs use My Portfolio again.
      try {
        const c = deps.open(ids.data);
        const d = await c.spreadsheetState(ctx);
        const m = d.ok ? await readMarker(ctx, c, d.value) : null;
        if (m && m.status === 'ROLLED_BACK') warnings.push('The data move was rolled back: this run used My Portfolio. Remove the REPORTS_SPREADSHEET_ID and DATA_SPREADSHEET_ID secrets when convenient.');
      } catch (e) { ctx.log.warning('startup: the data spreadsheet could not be checked for a rolled-back move (a reminder only; the run goes on)', { detail: String(e) }); }
    }
    return { mode: 'single', warnings };
  }

  const refuse = (why: string): never => {
    ctx.log.critical('startup refused: ' + why);
    throw new SheetsRefusedError('The spreadsheets are marked as moved, but ' + why + ', so the run stopped and nothing was changed.');
  };
  if (!ids.reports || !ids.data) refuse('REPORTS_SPREADSHEET_ID or DATA_SPREADSHEET_ID is not set');
  const reportsId = ids.reports as string, dataId = ids.data as string;
  if (new Set([ids.portfolio, reportsId, dataId]).size !== 3) refuse('two of the three spreadsheet IDs are the same');
  const reports = deps.open(reportsId), data = deps.open(dataId);
  const rs = await reports.spreadsheetState(ctx);
  if (!rs.ok) refuse('the reports spreadsheet could not be reached');
  const ds = await data.spreadsheetState(ctx);
  if (!ds.ok) refuse('the data spreadsheet could not be reached');
  const rState = (rs as { value: SpreadsheetState }).value, dState = (ds as { value: SpreadsheetState }).value;
  let marker: Marker | null = null;
  try { marker = await readMarker(ctx, data, dState); } catch (e) { ctx.log.error('startup: the migration record read failed', { detail: String(e) }); refuse('the migration record could not be read'); }
  if (!marker) refuse('the migration record ("💾 Migration") is missing in the data spreadsheet');
  const m = marker as Marker;
  if (m.status !== 'VERIFIED') refuse('the migration record is not VERIFIED (it says ' + (m.status || 'nothing') + ')');
  if (m.reportsId !== reportsId || m.dataId !== dataId || (m.portfolioId && m.portfolioId !== ids.portfolio)) {
    refuse('the spreadsheet IDs do not match the migration record (swapped or mistyped?)');
  }
  for (const t of REQUIRED_DATA_TABS) if (!has(dState, t)) refuse('the data spreadsheet has no "' + t + '" tab');
  for (const t of REQUIRED_REPORT_TABS) if (!has(rState, t)) refuse('the reports spreadsheet has no "' + t + '" tab');
  return { mode: 'routed', reportsId, dataId, warnings: [] };
}
