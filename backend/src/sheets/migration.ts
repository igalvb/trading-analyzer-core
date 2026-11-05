/**
 * The migration tool's logic (docs/SHEETS_CLEANUP_PLAN.md (e)): moves the data tabs from My Portfolio to the data
 * spreadsheet and the report tabs to the reports spreadsheet, with verification, a rehearsal and a rollback.
 * The command line and the maintenance pause around the writing steps are in src/migrateDataTabs.ts; this file
 * talks to the three spreadsheets through the SheetsClient methods only, so the tests run it on fakes.
 *
 * Steps: check | plan | rehearse | rehearse-cleanup | migrate | delete | copy-back | abort | unpause.
 *
 * What moves (computed from My Portfolio's tab list, never typed twice):
 *   data   every tab sheetFor() routes to the data sheet ('💾 ...', _OPTIONS_SNAPSHOT, 🔬 Log, 📝 Paper State)
 *   report the 10 MOVED_REPORT_TABS present in My Portfolio
 *   P      the other report-registry tabs in My Portfolio (phase-1 analysis tabs, 📌 Position, ...): deleted by
 *          `delete`, never copied (the next Analyze writes them in the reports sheet)
 *   stay   everything else (Portfolio, 🎯 Watchlist, the owner's personal tabs, any tab the code does not know)
 *
 * `verify` compares, per tab: rows, columns, non-empty cells, SHA-256 of the UNFORMATTED_VALUE values, hidden flag.
 * `migrate` writes the My Portfolio flag BEFORE the `💾 Migration` marker: a crash between them leaves every run
 * refusing (safe) until `migrate` is re-run or `abort` clears the flag.
 *
 * The only writer of the developer-metadata flags (`tradingDataMigrated`, `sheetsPaused`) in the codebase.
 */

import { createHash } from 'node:crypto';
import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import type { StepResult } from '../core/result.ts';
import type { SheetRow } from './coerce.ts';
import type { SheetsClient, SpreadsheetState, TabMeta } from './client.ts';
import {
  MIGRATION_MARKER_TAB, MOVED_REPORT_TABS, Tabs, a1, isPersonalTab, isReportRegistryName, sheetFor, type SheetRole,
} from './tabs.ts';
import {
  MIGRATED_FLAG, PAUSED_FLAG, markerRows, readMarker, type Marker, type MarkerTabRecord, type SheetIds,
} from './threeSheets.ts';

export type MigrationClient = Pick<SheetsClient, 'spreadsheetId' | 'spreadsheetState' | 'batchGet' | 'batchUpdate' | 'batchClear' | 'formatBatch' | 'copyTabTo' | 'referenceScan'>;

export const REHEARSAL_PREFIX = 'REHEARSAL ';
/** Tabs per values.batchGet when reading whole tabs (a price tab is about 500 x 6 cells; a Macro tab 2,514 x 5). */
const READ_CHUNK = 10;
/** Requests per formatBatch when deleting. */
const DELETE_CHUNK = 100;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function must<T>(r: StepResult<T>, what: string): T {
  if (!r.ok) throw new MigrationError(what + ': ' + String(r.error.detail));
  return r.value;
}

// ---- fingerprints -----------------------------------------------------------------------------------------

export interface Fingerprint {
  readonly rows: number;
  readonly columns: number;
  readonly nonEmpty: number;
  readonly hidden: boolean;
  readonly sha256: string;
}

const blank = (v: unknown): boolean => v === '' || v === null || v === undefined;

/** Counts and SHA-256 of a tab's UNFORMATTED values (trailing blank cells and rows do not count). */
export function fingerprint(values: readonly SheetRow[], hidden: boolean): Fingerprint {
  const rows = values.map((r) => {
    const out = [...(r ?? [])];
    while (out.length && blank(out[out.length - 1])) out.pop();
    return out.map((v) => (blank(v) ? '' : v));
  });
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
  let nonEmpty = 0;
  for (const r of rows) for (const v of r) if (!blank(v)) nonEmpty++;
  return {
    rows: rows.length, columns: rows.reduce((m, r) => Math.max(m, r.length), 0), nonEmpty, hidden,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.rows === b.rows && a.columns === b.columns && a.nonEmpty === b.nonEmpty && a.hidden === b.hidden && a.sha256 === b.sha256;
}

/** Reads whole tabs (by title) and fingerprints them. Missing titles are left out. */
export async function readFingerprints(ctx: RunContext, c: MigrationClient, state: SpreadsheetState, titles: readonly string[]): Promise<Map<string, Fingerprint>> {
  const byTitle = new Map(state.tabs.map((t) => [t.title, t] as const));
  const present = titles.filter((t) => byTitle.has(t));
  const out = new Map<string, Fingerprint>();
  for (let i = 0; i < present.length; i += READ_CHUNK) {
    const chunk = present.slice(i, i + READ_CHUNK);
    const vals = must(await c.batchGet(ctx, chunk.map((t) => a1(t))), 'reading tabs');
    chunk.forEach((t, j) => out.set(t, fingerprint(vals[j] ?? [], byTitle.get(t)!.hidden)));
  }
  return out;
}

// ---- what moves -------------------------------------------------------------------------------------------

export interface MovePlan {
  readonly data: readonly string[];
  readonly reports: readonly string[];
  /** Report-registry tabs in My Portfolio that are deleted, not copied. */
  readonly deleteOnly: readonly string[];
  readonly staying: readonly string[];
}

export function planMove(portfolioTabs: readonly string[]): MovePlan {
  const data: string[] = [], reports: string[] = [], deleteOnly: string[] = [], staying: string[] = [];
  for (const t of portfolioTabs) {
    if (t === MIGRATION_MARKER_TAB) { staying.push(t); continue; }
    const role = sheetFor(t);
    if (role === 'data') data.push(t);
    else if (MOVED_REPORT_TABS.includes(t)) reports.push(t);
    else if (role === 'reports' && isReportRegistryName(t)) deleteOnly.push(t);
    else staying.push(t);
  }
  return { data, reports, deleteOnly, staying };
}

// ---- safety rules for every write --------------------------------------------------------------------------

export type TargetMode = 'migrate' | 'rehearsal' | 'copy-back' | 'delete' | 'cleanup';

/**
 * The allow-list exceptions of the migrate tool (plan (d)): null when the write or delete is allowed.
 * Never a personal tab, never the marker (except migrate writing it), never a tab of the wrong sheet.
 */
export function targetRefusal(role: SheetRole, name: string, mode: TargetMode): string | null {
  if (isPersonalTab(name)) return 'never touches the personal tab "' + name + '"';
  if (name === MIGRATION_MARKER_TAB && mode !== 'migrate') return 'never touches "' + MIGRATION_MARKER_TAB + '"';
  const base = name.startsWith(REHEARSAL_PREFIX) ? name.slice(REHEARSAL_PREFIX.length) : name;
  switch (mode) {
    case 'migrate':
      return role !== 'portfolio' && sheetFor(name) === role ? null : 'refused "' + name + '" in the ' + role + ' spreadsheet';
    case 'rehearsal':
    case 'cleanup':
      if (role === 'portfolio') return 'the rehearsal never writes My Portfolio';
      if (name.startsWith(REHEARSAL_PREFIX)) return role === 'reports' && sheetFor(base) === 'data' ? null : 'refused stand-in "' + name + '"';
      return sheetFor(name) === role ? null : 'refused "' + name + '" in the ' + role + ' spreadsheet';
    case 'copy-back':
      return role === 'portfolio' && sheetFor(name) !== 'portfolio' ? null : 'copy-back writes only moved tabs into My Portfolio';
    case 'delete':
      if (role !== 'portfolio') return '`delete` removes tabs from My Portfolio only';
      if (sheetFor(name) === 'portfolio') return 'never deletes the staying tab "' + name + '"';
      return null;
  }
}

function assertTarget(role: SheetRole, name: string, mode: TargetMode): void {
  const why = targetRefusal(role, name, mode);
  if (why) throw new MigrationError('Refused: ' + why + '.');
}

// ---- the flags (My Portfolio developer metadata) ----------------------------------------------------------

function metadataRequests(state: SpreadsheetState, key: string, value: string | null): sheets_v4.Schema$Request[] {
  const out: sheets_v4.Schema$Request[] = [];
  if (state.metadata[key] !== undefined) out.push({ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataKey: key, locationType: 'SPREADSHEET' } } } });
  if (value !== null) out.push({ createDeveloperMetadata: { developerMetadata: { metadataKey: key, metadataValue: value, location: { spreadsheet: true }, visibility: 'DOCUMENT' } } });
  return out;
}

export async function setFlag(ctx: RunContext, portfolio: MigrationClient, key: string, value: string | null): Promise<void> {
  const st = must(await portfolio.spreadsheetState(ctx), 'reading My Portfolio');
  const reqs = metadataRequests(st, key, value);
  if (reqs.length) must(await portfolio.formatBatch(ctx, reqs), 'writing the ' + key + ' flag');
}

export const setPause = (ctx: RunContext, p: MigrationClient, until: Date): Promise<void> => setFlag(ctx, p, PAUSED_FLAG, until.toISOString());
export const clearPause = (ctx: RunContext, p: MigrationClient): Promise<void> => setFlag(ctx, p, PAUSED_FLAG, null);

// ---- copying ------------------------------------------------------------------------------------------------

export interface CopyResult {
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
  readonly mismatches: readonly string[];
}

const strayCopyOf = (title: string, names: ReadonlySet<string>): boolean => {
  const m = /^Copy of (.+?)(?: \d+)?$/u.exec(title);
  return !!m && names.has(m[1] as string);
};

export interface CopyOptions {
  readonly targetRole: SheetRole;
  readonly mode: TargetMode;
  /** Source name -> target name (the rehearsal stand-ins use `REHEARSAL <name>`). */
  readonly mapName?: (name: string) => string;
}

/**
 * Idempotent copy: removes stray `Copy of <name>` tabs first, skips a target that already equals its source,
 * copies with sheets.copyTo (which only reads the source), and gives each copy its name and the source's hidden
 * flag. An existing different target is replaced only after its new copy was verified. Ends with a full verify.
 */
export async function copyTabs(
  ctx: RunContext, from: MigrationClient, to: MigrationClient, names: readonly string[], o: CopyOptions, out: (l: string) => void,
): Promise<CopyResult> {
  const map = o.mapName ?? ((n: string) => n);
  for (const n of names) assertTarget(o.targetRole, map(n), o.mode);
  const fromState = must(await from.spreadsheetState(ctx), 'reading the source spreadsheet');
  const src = await readFingerprints(ctx, from, fromState, names);
  const missing = names.filter((n) => !src.has(n));
  if (missing.length) throw new MigrationError('The source has no tab named ' + missing.map((m) => '"' + m + '"').join(', ') + '.');

  let toState = must(await to.spreadsheetState(ctx), 'reading the target spreadsheet');
  const mapped = new Set(names.map(map));
  const strays = toState.tabs.filter((t) => strayCopyOf(t.title, mapped) || strayCopyOf(t.title, new Set(names)));
  if (strays.length) {
    must(await to.formatBatch(ctx, strays.map((t) => ({ deleteSheet: { sheetId: t.sheetId } }))), 'removing stray copies');
    out('Removed ' + strays.length + ' stray "Copy of" tab(s).');
    toState = must(await to.spreadsheetState(ctx), 'reading the target spreadsheet');
  }
  const existing = await readFingerprints(ctx, to, toState, names.map(map));
  const fromTab = new Map(fromState.tabs.map((t) => [t.title, t] as const));
  const copied: string[] = [], skipped: string[] = [];
  for (const n of names) {
    const target = map(n), want = src.get(n)!;
    const have = existing.get(target);
    if (have && sameFingerprint(have, want)) { skipped.push(n); continue; }
    const made = must(await from.copyTabTo(ctx, fromTab.get(n)!.sheetId, to.spreadsheetId), 'copying "' + n + '"');
    const old = toState.tabs.find((t) => t.title === target);
    if (old) {
      // Replace path: the new copy must equal the source before the old tab goes.
      const st = must(await to.spreadsheetState(ctx), 'reading the target spreadsheet');
      const fp = (await readFingerprints(ctx, to, { ...st, tabs: st.tabs.map((t) => (t.sheetId === made.sheetId ? { ...t, hidden: want.hidden } : t)) }, [made.title])).get(made.title);
      if (!fp || !sameFingerprint(fp, want)) {
        must(await to.formatBatch(ctx, [{ deleteSheet: { sheetId: made.sheetId } }]), 'removing a bad copy');
        throw new MigrationError('The copy of "' + n + '" does not equal its source; the old tab was kept.');
      }
    }
    must(await to.formatBatch(ctx, [
      ...(old ? [{ deleteSheet: { sheetId: old.sheetId } }] : []),
      { updateSheetProperties: { properties: { sheetId: made.sheetId, title: target, hidden: want.hidden }, fields: 'title,hidden' } },
    ]), 'naming the copy of "' + n + '"');
    toState = { ...toState, tabs: [...toState.tabs.filter((t) => t.sheetId !== old?.sheetId), { sheetId: made.sheetId, title: target, hidden: want.hidden, rowCount: 0, columnCount: 0 }] };
    copied.push(n);
  }
  const mismatches = await verifyAgainst(ctx, to, names, map, src);
  out('Copied ' + copied.length + ', already present and equal ' + skipped.length + ', mismatches ' + mismatches.length + '.');
  return { copied, skipped, mismatches };
}

/** Names whose target copy is missing or differs from `src`. */
export async function verifyAgainst(
  ctx: RunContext, to: MigrationClient, names: readonly string[], map: (n: string) => string, src: ReadonlyMap<string, Fingerprint>,
): Promise<string[]> {
  const st = must(await to.spreadsheetState(ctx), 'reading the target spreadsheet');
  const got = await readFingerprints(ctx, to, st, names.map(map));
  return names.filter((n) => { const g = got.get(map(n)); return !g || !sameFingerprint(g, src.get(n)!); });
}

/** Deletes tabs by title (each checked by targetRefusal). A spreadsheet keeps at least one tab: a blank one is added first if needed. */
export async function deleteTabs(ctx: RunContext, c: MigrationClient, role: SheetRole, titles: readonly string[], mode: TargetMode): Promise<number> {
  for (const t of titles) assertTarget(role, t, mode);
  const st = must(await c.spreadsheetState(ctx), 'reading the spreadsheet');
  const want = new Set(titles);
  const doomed = st.tabs.filter((t) => want.has(t.title));
  if (!doomed.length) return 0;
  if (doomed.length === st.tabs.length) {
    must(await c.formatBatch(ctx, [{ addSheet: { properties: { title: blankTabName(st) } } }]), 'adding a blank tab');
  }
  for (let i = 0; i < doomed.length; i += DELETE_CHUNK) {
    must(await c.formatBatch(ctx, doomed.slice(i, i + DELETE_CHUNK).map((t) => ({ deleteSheet: { sheetId: t.sheetId } }))), 'deleting tabs');
  }
  return doomed.length;
}

function blankTabName(st: SpreadsheetState): string {
  let n = 1;
  while (st.tabs.some((t) => t.title === 'Sheet' + n)) n++;
  return 'Sheet' + n;
}

// ---- the steps -----------------------------------------------------------------------------------------------

export interface MigrationSheets {
  readonly portfolio: MigrationClient;
  readonly reports: MigrationClient;
  readonly data: MigrationClient;
}

export interface StepOutput {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export interface StepDeps {
  readonly ctx: RunContext;
  readonly sheets: MigrationSheets;
  readonly ids: SheetIds;
  readonly now: () => number;
  readonly out: (line: string) => void;
}

export interface Classified {
  readonly moved: readonly string[];
  readonly strays: readonly string[];
  readonly rehearsal: readonly string[];
  readonly marker: boolean;
  readonly blankDefault: readonly string[];
  readonly other: readonly string[];
}

/** What a new spreadsheet holds: moved names (a partial copy), stray copies, rehearsal stand-ins, the marker, blank tabs, anything else. */
export async function classifyTarget(ctx: RunContext, c: MigrationClient, state: SpreadsheetState, moved: ReadonlySet<string>): Promise<Classified> {
  const r: { moved: string[]; strays: string[]; rehearsal: string[]; blankDefault: string[]; other: string[] } = { moved: [], strays: [], rehearsal: [], blankDefault: [], other: [] };
  let marker = false;
  const unknown: TabMeta[] = [];
  for (const t of state.tabs) {
    if (t.title === MIGRATION_MARKER_TAB) marker = true;
    else if (moved.has(t.title)) r.moved.push(t.title);
    else if (strayCopyOf(t.title, moved)) r.strays.push(t.title);
    else if (t.title.startsWith(REHEARSAL_PREFIX)) r.rehearsal.push(t.title);
    else unknown.push(t);
  }
  const fps = await readFingerprints(ctx, c, state, unknown.map((t) => t.title));
  for (const t of unknown) (fps.get(t.title)?.nonEmpty ? r.other : r.blankDefault).push(t.title);
  return { ...r, marker };
}

async function states(d: StepDeps): Promise<{ p: SpreadsheetState; r: SpreadsheetState; dt: SpreadsheetState }> {
  const p = must(await d.sheets.portfolio.spreadsheetState(d.ctx), 'reading My Portfolio');
  const r = must(await d.sheets.reports.spreadsheetState(d.ctx), 'reading the reports spreadsheet');
  const dt = must(await d.sheets.data.spreadsheetState(d.ctx), 'reading the data spreadsheet');
  return { p, r, dt };
}

/** The IDs must all be set and different (refusal sentence, or null). */
export function idProblem(ids: SheetIds): string | null {
  if (!ids.portfolio || !ids.reports || !ids.data) return 'SPREADSHEET_ID, REPORTS_SPREADSHEET_ID and DATA_SPREADSHEET_ID must all be set.';
  if (new Set([ids.portfolio, ids.reports, ids.data]).size !== 3) return 'Two of the three spreadsheet IDs are the same.';
  return null;
}

/** `check`: all three reachable, Editor on each, IDs different, the new sheets empty or holding only a partial copy. */
export async function stepCheck(d: StepDeps, o: { readonly probeEdit?: boolean; readonly requireEmpty?: boolean } = {}): Promise<StepOutput> {
  const lines: string[] = [];
  const say = (l: string): void => { lines.push(l); d.out(l); };
  let ok = true;
  const { p, r, dt } = await states(d);
  // The rehearsal skips the probe: it only reads My Portfolio (its own copies prove edit access to the new sheets).
  const probe = o.probeEdit === false ? [] : [['My Portfolio', d.sheets.portfolio, p], ['reports spreadsheet', d.sheets.reports, r], ['data spreadsheet', d.sheets.data, dt]] as const;
  for (const [label, c, st] of probe) {
    // Editor check: re-writing the spreadsheet's own title is a no-op that needs edit access.
    const w = await c.formatBatch(d.ctx, [{ updateSpreadsheetProperties: { properties: { title: st.title }, fields: 'title' } }]);
    say(label + ': ' + st.tabs.length + ' tab(s); ' + (w.ok ? 'the robot can edit it.' : 'the robot can NOT edit it.'));
    if (!w.ok) ok = false;
  }
  const plan = planMove(p.tabs.map((t) => t.title));
  const moved = new Set([...plan.data, ...plan.reports]);
  for (const [label, c, st] of [['reports spreadsheet', d.sheets.reports, r], ['data spreadsheet', d.sheets.data, dt]] as const) {
    const k = await classifyTarget(d.ctx, c, st, moved);
    const parts = [k.moved.length + ' copied tab(s)', k.strays.length + ' stray copies', k.rehearsal.length + ' rehearsal stand-ins', k.blankDefault.length + ' blank tab(s)'];
    say(label + ': ' + parts.join(', ') + (k.marker ? ', the migration record' : '') + (k.other.length ? '; NOT EMPTY: ' + k.other.join(', ') : '') + '.');
    if (k.other.length) ok = false;
    if (o.requireEmpty && (k.moved.length || k.strays.length || k.rehearsal.length || k.marker)) ok = false;
  }
  say(ok ? 'check: passed.' : 'check: FAILED.');
  return { ok, lines };
}

// ---- reference check (read-only) -----------------------------------------------------------------------------

export interface ReferenceHit {
  readonly tab: string;
  readonly where: string;
  /** direct = names a moving tab (must be resolved); review = INDIRECT/IMPORTRANGE/QUERY, pivots, filter views (manual review). */
  readonly kind: 'direct' | 'review';
  readonly detail: string;
}

function colA1(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const DYNAMIC = /\b(INDIRECT|IMPORTRANGE|QUERY)\s*\(/i;

/** Pure: the hits in a referenceScan response, for the moving tab names and their sheetIds. */
export function findReferences(scan: sheets_v4.Schema$Spreadsheet, movingNames: readonly string[], movingIds: ReadonlySet<number>): ReferenceHit[] {
  const hits: ReferenceHit[] = [];
  const names = [...movingNames].sort((a, b) => b.length - a.length);
  const textHit = (text: string): string | null => names.find((n) => text.includes(n)) ?? null;
  const formulaHits = (tab: string, where: string, f: string): void => {
    const n = textHit(f);
    if (n) hits.push({ tab, where, kind: 'direct', detail: 'refers to "' + n + '": ' + f });
    else if (DYNAMIC.test(f)) hits.push({ tab, where, kind: 'review', detail: 'dynamic reference, check by hand: ' + f });
  };
  const idsIn = (o: unknown): number[] => [...JSON.stringify(o ?? {}).matchAll(/"sheetId":(\d+)/g)].map((m) => Number(m[1]));
  for (const nr of scan.namedRanges ?? []) {
    if (movingIds.has(nr.range?.sheetId ?? 0)) hits.push({ tab: '(named range)', where: String(nr.name), kind: 'direct', detail: 'named range on a moving tab' });
  }
  for (const sh of scan.sheets ?? []) {
    const tab = sh.properties?.title ?? '?';
    (sh.data ?? []).forEach((g) => (g.rowData ?? []).forEach((row, i) => (row.values ?? []).forEach((v, j) => {
      const cell = colA1((g.startColumn ?? 0) + j + 1) + ((g.startRow ?? 0) + i + 1);
      const f = v.userEnteredValue?.formulaValue;
      if (f) formulaHits(tab, cell, f);
      if (v.pivotTable) {
        const src = v.pivotTable.source?.sheetId ?? 0;
        hits.push({ tab, where: cell, kind: movingIds.has(src) ? 'direct' : 'review', detail: 'pivot table' + (movingIds.has(src) ? ' on a moving tab' : '') });
      }
      for (const cv of v.dataValidation?.condition?.values ?? []) if (cv.userEnteredValue) formulaHits(tab, cell + ' (data validation)', cv.userEnteredValue);
    })));
    for (const c of sh.charts ?? []) {
      if (idsIn(c.spec).some((id) => movingIds.has(id))) hits.push({ tab, where: 'chart ' + c.chartId, kind: 'direct', detail: 'chart reads a moving tab' });
    }
    for (const fv of sh.filterViews ?? []) hits.push({ tab, where: 'filter view "' + (fv.title ?? '') + '"', kind: movingIds.has(fv.range?.sheetId ?? -1) ? 'direct' : 'review', detail: 'filter view' });
    if (sh.basicFilter) hits.push({ tab, where: 'filter', kind: 'review', detail: 'basic filter' });
    for (const cf of sh.conditionalFormats ?? []) {
      for (const cv of cf.booleanRule?.condition?.values ?? []) if (cv.userEnteredValue) formulaHits(tab, 'conditional format', cv.userEnteredValue);
    }
  }
  return hits;
}

export async function referenceCheck(d: StepDeps, p: SpreadsheetState, plan: MovePlan): Promise<ReferenceHit[]> {
  const moving = [...plan.data, ...plan.reports, ...plan.deleteOnly];
  const ids = new Set(p.tabs.filter((t) => moving.includes(t.title)).map((t) => t.sheetId));
  const staying = plan.staying.filter((t) => t !== MIGRATION_MARKER_TAB);
  if (!staying.length) return [];
  const scan = must(await d.sheets.portfolio.referenceScan(d.ctx, staying), 'reading the formulas');
  return findReferences(scan, moving, ids);
}

function printReferences(d: StepDeps, hits: readonly ReferenceHit[]): void {
  d.out('Reference check: ' + hits.filter((h) => h.kind === 'direct').length + ' direct reference(s), ' + hits.filter((h) => h.kind === 'review').length + ' to review by hand.');
  for (const h of hits) d.out('  [' + h.kind + '] ' + h.tab + ' ' + h.where + ': ' + h.detail);
  d.out('Not visible to the robot: other files that IMPORTRANGE My Portfolio, Looker Studio, add-ons, a bound Apps Script reading tabs by name.');
}

/** `plan`: the lists and the reference check. */
export async function stepPlan(d: StepDeps): Promise<StepOutput> {
  const p = must(await d.sheets.portfolio.spreadsheetState(d.ctx), 'reading My Portfolio');
  const plan = planMove(p.tabs.map((t) => t.title));
  d.out('To copy to the data spreadsheet (' + plan.data.length + '): ' + plan.data.join(', '));
  d.out('To copy to the reports spreadsheet (' + plan.reports.length + '): ' + plan.reports.join(', '));
  d.out('To delete without copying, regenerated by the next Analyze (' + plan.deleteOnly.length + '): ' + plan.deleteOnly.join(', '));
  d.out('Staying in My Portfolio (' + plan.staying.length + '): ' + plan.staying.join(', '));
  const hits = await referenceCheck(d, p, plan);
  printReferences(d, hits);
  return { ok: true, lines: [] };
}

// ---- rehearsal ------------------------------------------------------------------------------------------------

async function notMigratedYet(d: StepDeps): Promise<void> {
  const { p, dt } = await states(d);
  if (p.metadata[MIGRATED_FLAG] !== undefined) throw new MigrationError('Refused: My Portfolio is already marked as moved; the rehearsal runs only before `migrate`.');
  if (dt.tabs.some((t) => t.title === MIGRATION_MARKER_TAB)) throw new MigrationError('Refused: the data spreadsheet already holds the migration record; the rehearsal runs only before `migrate`.');
}

/** `rehearse --cleanup`: removes every `REHEARSAL ` tab and every moved name from the two new sheets (idempotent). */
export async function stepRehearseCleanup(d: StepDeps): Promise<StepOutput> {
  await notMigratedYet(d);
  const { p, r, dt } = await states(d);
  const plan = planMove(p.tabs.map((t) => t.title));
  const moved = new Set([...plan.data, ...plan.reports, ...MOVED_REPORT_TABS]);
  const rDoomed = r.tabs.map((t) => t.title).filter((t) => t.startsWith(REHEARSAL_PREFIX) || (moved.has(t) && sheetFor(t) === 'reports') || strayCopyOf(t, moved));
  const dDoomed = dt.tabs.map((t) => t.title).filter((t) => (moved.has(t) && sheetFor(t) === 'data') || strayCopyOf(t, moved));
  const nr = await deleteTabs(d.ctx, d.sheets.reports, 'reports', rDoomed.filter((t) => !strayCopyOf(t, moved)), 'cleanup');
  const nd = await deleteTabs(d.ctx, d.sheets.data, 'data', dDoomed.filter((t) => !strayCopyOf(t, moved)), 'cleanup');
  // Stray copies are named "Copy of X": removed by sheetId, they never match a real name.
  for (const [c, st, list] of [[d.sheets.reports, r, rDoomed], [d.sheets.data, dt, dDoomed]] as const) {
    const strays = st.tabs.filter((t) => list.includes(t.title) && strayCopyOf(t.title, moved));
    if (strays.length) must(await c.formatBatch(d.ctx, strays.map((t) => ({ deleteSheet: { sheetId: t.sheetId } }))), 'removing stray copies');
  }
  d.out('Rehearsal clean-up: ' + nr + ' tab(s) removed from the reports spreadsheet, ' + nd + ' from the data spreadsheet.');
  const check = await stepCheck(d, { probeEdit: false, requireEmpty: true });
  return { ok: check.ok, lines: check.lines };
}

/** `rehearse`: the copy path and the copy-back replace path on the real tabs, without the switch; empties both new sheets again. */
export async function stepRehearse(d: StepDeps): Promise<StepOutput> {
  const first = await stepRehearseCleanup(d);
  if (!first.ok) return first;
  const p = must(await d.sheets.portfolio.spreadsheetState(d.ctx), 'reading My Portfolio');
  const plan = planMove(p.tabs.map((t) => t.title));
  let ok = true;
  const a = await copyTabs(d.ctx, d.sheets.portfolio, d.sheets.data, plan.data, { targetRole: 'data', mode: 'rehearsal' }, d.out);
  const b = await copyTabs(d.ctx, d.sheets.portfolio, d.sheets.reports, plan.reports, { targetRole: 'reports', mode: 'rehearsal' }, d.out);
  if (a.mismatches.length || b.mismatches.length) { ok = false; d.out('Rehearsal copy: mismatches ' + [...a.mismatches, ...b.mismatches].join(', ')); }
  // Rollback rehearsal: stand-ins in the reports sheet, then the copy-back code (replace path) onto them.
  const stand = (n: string): string => REHEARSAL_PREFIX + n;
  const c = await copyTabs(d.ctx, d.sheets.data, d.sheets.reports, plan.data, { targetRole: 'reports', mode: 'rehearsal', mapName: stand }, d.out);
  const back = await copyBackTabs(d, d.sheets.data, d.sheets.reports, plan.data, 'reports', 'rehearsal', stand);
  if (c.mismatches.length || back.mismatches.length) { ok = false; d.out('Rehearsal copy-back: mismatches ' + [...c.mismatches, ...back.mismatches].join(', ')); }
  if (back.copied.length !== plan.data.length) { ok = false; d.out('Rehearsal copy-back: the replace path ran for ' + back.copied.length + ' of ' + plan.data.length + ' tab(s).'); }
  const last = await stepRehearseCleanup(d);
  d.out(ok && last.ok ? 'rehearse: passed (round trip equal; both new spreadsheets empty again).' : 'rehearse: FAILED.');
  return { ok: ok && last.ok, lines: [] };
}

/** The copy-back path: every name is copied fresh (never skipped), verified, then replaces the old tab. */
async function copyBackTabs(
  d: StepDeps, from: MigrationClient, to: MigrationClient, names: readonly string[], targetRole: SheetRole, mode: TargetMode, map: (n: string) => string = (n) => n,
): Promise<CopyResult> {
  for (const n of names) assertTarget(targetRole, map(n), mode);
  const fromState = must(await from.spreadsheetState(d.ctx), 'reading the source spreadsheet');
  const src = await readFingerprints(d.ctx, from, fromState, names);
  const fromTab = new Map(fromState.tabs.map((t) => [t.title, t] as const));
  const copied: string[] = [];
  for (const n of names) {
    const want = src.get(n);
    if (!want) throw new MigrationError('The source has no tab named "' + n + '".');
    const made = must(await from.copyTabTo(d.ctx, fromTab.get(n)!.sheetId, to.spreadsheetId), 'copying "' + n + '"');
    const st = must(await to.spreadsheetState(d.ctx), 'reading the target spreadsheet');
    const fp = (await readFingerprints(d.ctx, to, { ...st, tabs: st.tabs.map((t) => (t.sheetId === made.sheetId ? { ...t, hidden: want.hidden } : t)) }, [made.title])).get(made.title);
    if (!fp || !sameFingerprint(fp, want)) {
      must(await to.formatBatch(d.ctx, [{ deleteSheet: { sheetId: made.sheetId } }]), 'removing a bad copy');
      throw new MigrationError('The copy of "' + n + '" does not equal its source; the old tab was kept and nothing else changed for it.');
    }
    const old = st.tabs.find((t) => t.title === map(n));
    must(await to.formatBatch(d.ctx, [
      ...(old ? [{ deleteSheet: { sheetId: old.sheetId } }] : []),
      { updateSheetProperties: { properties: { sheetId: made.sheetId, title: map(n), hidden: want.hidden }, fields: 'title,hidden' } },
    ]), 'replacing "' + map(n) + '"');
    copied.push(n);
  }
  const mismatches = await verifyAgainst(d.ctx, to, names, map, src);
  d.out('Copied back ' + copied.length + ', mismatches ' + mismatches.length + '.');
  return { copied, skipped: [], mismatches };
}

// ---- migrate --------------------------------------------------------------------------------------------------

export interface MigrateOptions {
  /** The owner reviewed the direct references the check lists and keeps them as they are. */
  readonly acceptReferences?: boolean;
}

/** `migrate`: reference check -> copy -> re-hide -> verify -> FLAG -> MARKER. */
export async function stepMigrate(d: StepDeps, o: MigrateOptions = {}): Promise<StepOutput> {
  const { p, r, dt } = await states(d);
  const existing = await readMarker(d.ctx, d.sheets.data, dt);
  if (p.metadata[MIGRATED_FLAG] !== undefined && existing?.status === 'VERIFIED') throw new MigrationError('Refused: the move is already done and verified.');
  const plan = planMove(p.tabs.map((t) => t.title));
  const moved = new Set([...plan.data, ...plan.reports]);
  for (const [label, c, st] of [['reports', d.sheets.reports, r], ['data', d.sheets.data, dt]] as const) {
    const k = await classifyTarget(d.ctx, c, st, moved);
    if (k.other.length || k.rehearsal.length) throw new MigrationError('Refused: the ' + label + ' spreadsheet is not empty (' + [...k.other, ...k.rehearsal].join(', ') + '). Run `rehearse-cleanup` first.');
  }
  const hits = await referenceCheck(d, p, plan);
  printReferences(d, hits);
  if (hits.some((h) => h.kind === 'direct') && !o.acceptReferences) throw new MigrationError('Refused: My Portfolio still has direct references to moving tabs (listed above). Resolve them, or run again with accept_references.');

  const a = await copyTabs(d.ctx, d.sheets.portfolio, d.sheets.data, plan.data, { targetRole: 'data', mode: 'migrate' }, d.out);
  const b = await copyTabs(d.ctx, d.sheets.portfolio, d.sheets.reports, plan.reports, { targetRole: 'reports', mode: 'migrate' }, d.out);
  // Google's blank default tab is removed, so each new sheet holds only its own names.
  for (const c of [d.sheets.data, d.sheets.reports]) {
    const st = must(await c.spreadsheetState(d.ctx), 'reading the target spreadsheet');
    const k = await classifyTarget(d.ctx, c, st, moved);
    const blanks = st.tabs.filter((t) => k.blankDefault.includes(t.title));
    if (blanks.length && blanks.length < st.tabs.length) must(await c.formatBatch(d.ctx, blanks.map((t) => ({ deleteSheet: { sheetId: t.sheetId } }))), 'removing the blank tab');
  }
  // Verify all of them, against My Portfolio, once more.
  const pSrc = await readFingerprints(d.ctx, d.sheets.portfolio, p, [...plan.data, ...plan.reports]);
  const bad = [
    ...await verifyAgainst(d.ctx, d.sheets.data, plan.data, (n) => n, pSrc),
    ...await verifyAgainst(d.ctx, d.sheets.reports, plan.reports, (n) => n, pSrc),
    ...a.mismatches, ...b.mismatches,
  ];
  const total = plan.data.length + plan.reports.length;
  if (bad.length) {
    d.out('migrate: verify FAILED for ' + [...new Set(bad)].join(', ') + '. Nothing was switched.');
    return { ok: false, lines: [] };
  }
  d.out('Verified ' + total + ' of ' + total + ' tab(s).');

  // The flag first: a crash before the marker leaves every run refusing (safe).
  await setFlag(d.ctx, d.sheets.portfolio, MIGRATED_FLAG, new Date(d.now()).toISOString());
  const tabs: MarkerTabRecord[] = [...plan.data, ...plan.reports].map((n) => {
    const f = pSrc.get(n)!;
    return { tab: n, sheet: sheetFor(n) === 'data' ? 'data' : 'reports', rows: f.rows, columns: f.columns, nonEmpty: f.nonEmpty, hidden: f.hidden, sha256: f.sha256 };
  });
  const marker: Marker = {
    status: 'VERIFIED', portfolioId: d.ids.portfolio, reportsId: d.ids.reports as string, dataId: d.ids.data as string,
    verifiedAt: new Date(d.now()).toISOString(), tabs, portfolioTabsAtMigrate: p.tabs.map((t) => t.title), deleteOnly: plan.deleteOnly,
  };
  await writeMarker(d, marker);
  d.out('migrate: done. The flag and the migration record are set; the next run uses the three spreadsheets.');
  return { ok: true, lines: [] };
}

async function writeMarker(d: StepDeps, m: Marker): Promise<void> {
  assertTarget('data', MIGRATION_MARKER_TAB, 'migrate');
  const st = must(await d.sheets.data.spreadsheetState(d.ctx), 'reading the data spreadsheet');
  if (!st.tabs.some((t) => t.title === MIGRATION_MARKER_TAB)) {
    must(await d.sheets.data.formatBatch(d.ctx, [{ addSheet: { properties: { title: MIGRATION_MARKER_TAB } } }]), 'adding the migration record');
  } else {
    must(await d.sheets.data.batchClear(d.ctx, [a1(MIGRATION_MARKER_TAB)]), 'clearing the migration record');
  }
  const rows = markerRows(m);
  must(await d.sheets.data.batchUpdate(d.ctx, [{ range: a1(MIGRATION_MARKER_TAB, 'A1:G' + rows.length), values: rows }]), 'writing the migration record');
}

// ---- post-switch check and delete ---------------------------------------------------------------------------

/** Plan (e) "Post-switch check": what `delete` requires, just before deleting. */
export async function postSwitchCheck(d: StepDeps): Promise<{ ok: boolean; marker: Marker | null; problems: string[] }> {
  const problems: string[] = [];
  const { p, r, dt } = await states(d);
  if (p.metadata[MIGRATED_FLAG] === undefined) problems.push('My Portfolio is not marked as moved.');
  const m = await readMarker(d.ctx, d.sheets.data, dt);
  if (!m) return { ok: false, marker: null, problems: [...problems, 'The migration record is missing.'] };
  if (m.status !== 'VERIFIED') problems.push('The migration record says ' + m.status + ', not VERIFIED.');
  if (m.reportsId !== d.ids.reports || m.dataId !== d.ids.data) problems.push('The spreadsheet IDs do not match the migration record.');
  // (a) My Portfolio's old copies still equal the checksums taken at `migrate`: nothing was written only there since.
  const old = await readFingerprints(d.ctx, d.sheets.portfolio, p, m.tabs.map((t) => t.tab));
  for (const t of m.tabs) {
    const f = old.get(t.tab);
    if (f && !sameFingerprint(f, { rows: t.rows, columns: t.columns, nonEmpty: t.nonEmpty, hidden: t.hidden, sha256: t.sha256 })) problems.push('My Portfolio\'s "' + t.tab + '" changed after the move.');
  }
  // (b) every moved name exists and is non-empty in its new sheet.
  const newData = await readFingerprints(d.ctx, d.sheets.data, dt, m.tabs.filter((t) => t.sheet === 'data').map((t) => t.tab));
  const newReports = await readFingerprints(d.ctx, d.sheets.reports, r, m.tabs.filter((t) => t.sheet === 'reports').map((t) => t.tab));
  for (const t of m.tabs) {
    const f = (t.sheet === 'data' ? newData : newReports).get(t.tab);
    if (!f) problems.push('"' + t.tab + '" is missing in the ' + t.sheet + ' spreadsheet.');
    else if (f.nonEmpty === 0 && t.nonEmpty > 0) problems.push('"' + t.tab + '" is empty in the ' + t.sheet + ' spreadsheet.');
  }
  // (c) exact tab-name sets: nothing new in My Portfolio; nothing of the wrong kind in the new sheets.
  const atMigrate = new Set(m.portfolioTabsAtMigrate);
  const newInPortfolio = p.tabs.map((t) => t.title).filter((t) => !atMigrate.has(t));
  if (newInPortfolio.length) problems.push('New tab(s) in My Portfolio since the move: ' + newInPortfolio.join(', ') + '.');
  const wrongR = r.tabs.map((t) => t.title).filter((t) => sheetFor(t) !== 'reports');
  const wrongD = dt.tabs.map((t) => t.title).filter((t) => sheetFor(t) !== 'data');
  if (wrongR.length) problems.push('Tab(s) in the reports spreadsheet that belong elsewhere: ' + wrongR.join(', ') + '.');
  if (wrongD.length) problems.push('Tab(s) in the data spreadsheet that belong elsewhere: ' + wrongD.join(', ') + '.');
  // (d) a run used the data sheet since the move: 💾 Script Properties was written after `migrate`.
  if (dt.tabs.some((t) => t.title === Tabs.SCRIPT_PROPERTIES)) {
    const rows = must(await d.sheets.data.batchGet(d.ctx, [a1(Tabs.SCRIPT_PROPERTIES, 'C2:C')]), 'reading the property store')[0] ?? [];
    const latest = Math.max(...rows.map((x) => Date.parse(String(x?.[0] ?? ''))).filter(Number.isFinite), 0);
    if (!(latest > Date.parse(m.verifiedAt))) problems.push('No run has written the data spreadsheet since the move (💾 Script Properties not updated). Run the Nightly first.');
  }
  return { ok: problems.length === 0, marker: m, problems };
}

/** `delete`: the post-switch check, then (with --yes) removes from My Portfolio the moved names and the P report tabs. */
export async function stepDelete(d: StepDeps, yes: boolean): Promise<StepOutput> {
  const chk = await postSwitchCheck(d);
  for (const pr of chk.problems) d.out('  ' + pr);
  if (!chk.ok || !chk.marker) { d.out('delete: the post-switch check FAILED; nothing was deleted.'); return { ok: false, lines: [] }; }
  const p = must(await d.sheets.portfolio.spreadsheetState(d.ctx), 'reading My Portfolio');
  const present = new Set(p.tabs.map((t) => t.title));
  const plan = planMove(p.tabs.map((t) => t.title));
  const doomed = [...new Set([...chk.marker.tabs.map((t) => t.tab), ...chk.marker.deleteOnly, ...plan.deleteOnly])].filter((t) => present.has(t));
  for (const t of doomed) assertTarget('portfolio', t, 'delete');
  d.out('delete: ' + doomed.length + ' tab(s) to remove from My Portfolio; ' + (p.tabs.length - doomed.length) + ' stay.');
  if (!yes) { d.out('Dry run: nothing was deleted. Run again with yes to delete them.'); return { ok: true, lines: [] }; }
  const n = await deleteTabs(d.ctx, d.sheets.portfolio, 'portfolio', doomed, 'delete');
  d.out('delete: ' + n + ' tab(s) removed from My Portfolio.');
  return { ok: true, lines: [] };
}

// ---- copy-back (rollback), abort, unpause ----------------------------------------------------------------------

/** `copy-back`: every data-sheet tab except the marker, and the 10 report tabs, back into My Portfolio; then the flag is cleared. */
export async function stepCopyBack(d: StepDeps): Promise<StepOutput> {
  const { r, dt } = await states(d);
  const m = await readMarker(d.ctx, d.sheets.data, dt);
  if (!m) throw new MigrationError('Refused: there is no migration record; if only the flag is set, use `abort`.');
  const dataNames = dt.tabs.map((t) => t.title).filter((t) => t !== MIGRATION_MARKER_TAB && sheetFor(t) === 'data');
  const reportNames = MOVED_REPORT_TABS.filter((t) => r.tabs.some((x) => x.title === t));
  const a = await copyBackTabs(d, d.sheets.data, d.sheets.portfolio, dataNames, 'portfolio', 'copy-back');
  const b = await copyBackTabs(d, d.sheets.reports, d.sheets.portfolio, reportNames, 'portfolio', 'copy-back');
  if (a.mismatches.length || b.mismatches.length) {
    d.out('copy-back: verify FAILED for ' + [...a.mismatches, ...b.mismatches].join(', ') + '; the flag stays set.');
    return { ok: false, lines: [] };
  }
  await setFlag(d.ctx, d.sheets.portfolio, MIGRATED_FLAG, null);
  must(await d.sheets.data.batchUpdate(d.ctx, [{ range: a1(MIGRATION_MARKER_TAB, 'B1'), values: [['ROLLED_BACK']] }]), 'updating the migration record');
  d.out('copy-back: done. ' + (dataNames.length + reportNames.length) + ' tab(s) back in My Portfolio; runs use My Portfolio again.');
  return { ok: true, lines: [] };
}

/** `abort`: clears the pause; with no migration record, also clears the flag (a crash between flag and marker). */
export async function stepAbort(d: StepDeps, dataReachable: boolean): Promise<StepOutput> {
  await clearPause(d.ctx, d.sheets.portfolio);
  d.out('abort: the maintenance pause is cleared.');
  if (!dataReachable) { d.out('abort: the data spreadsheet could not be read, so the move flag was left as it is.'); return { ok: false, lines: [] }; }
  const dt = d.ids.data ? must(await d.sheets.data.spreadsheetState(d.ctx), 'reading the data spreadsheet') : null;
  const m = dt ? await readMarker(d.ctx, d.sheets.data, dt) : null;
  if (!m) {
    await setFlag(d.ctx, d.sheets.portfolio, MIGRATED_FLAG, null);
    d.out('abort: no migration record, so the move flag is cleared; runs use My Portfolio.');
  } else {
    d.out('abort: the migration record exists (' + m.status + '), so the move flag was left as it is. Use `copy-back` to roll back.');
  }
  return { ok: true, lines: [] };
}

