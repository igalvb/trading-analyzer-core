/**
 * Routing over the three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d)). Used only when the startup guard says
 * routing is on (sheets/threeSheets.ts); with the flag unset the plain single-sheet stores are used, as today.
 *
 *   RoutingTabStore         the TabStore (macro caches, RS, Paper State -> data; Dark Pool Tracker and the paper
 *                           report tabs -> reports), by sheetFor(tab)
 *   RoutingWorkbookBackend  the report workbooks: listTabs merges the three sheets and keeps each name once, from
 *                           the sheet sheetFor names (between `migrate` and `delete` the same names exist twice;
 *                           the stale copy is not shown); readTab / applyTab route by sheetFor
 *   RoutingFormatter        formatting for a TabStore tab (the Dark Pool Tracker), on the sheet that holds it
 *
 * The allow-list: a write may touch only a registry name or '💾 <TICKER>', in the sheet sheetFor names; on My
 * Portfolio only `Portfolio` (My Options), plus creating `🎯 Watchlist` when it is missing (getOrCreateWatchlistSheet).
 * Anything else is refused: logged in production (the write is skipped), an error in tests (`strict`).
 * Tab-colour-only changes are never refused (the Master Lock colours every tab).
 */

import type { FormatOp } from './formatOps.ts';
import type { TabFormatter } from './formatOps.ts';
import { isAllowListedName, sheetFor, type SheetRole } from './tabs.ts';
import type { TabCell, TabStore, TabWriteFormat } from '../storage/tabStore.ts';
import type { TabChange, TabInfo, WorkbookBackend } from './reportSheet.ts';

export class SheetAllowListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetAllowListError';
  }
}

export interface AllowListOptions {
  /** Tests: throw instead of logging and skipping. */
  readonly strict?: boolean;
  /** Production: how a refusal is reported (the run's log). */
  readonly onRefuse?: (message: string) => void;
}

export type WriteKind = 'write' | 'create';

/** Null when allowed; else the refusal sentence. */
export function allowListRefusal(tab: string, kind: WriteKind, role: SheetRole = sheetFor(tab)): string | null {
  if (!isAllowListedName(tab)) return 'refused a write to "' + tab + '": not a tab this program owns';
  if (sheetFor(tab) !== role) return 'refused a write to "' + tab + '" in the ' + role + ' spreadsheet: it belongs in the ' + sheetFor(tab) + ' spreadsheet';
  if (role === 'portfolio') {
    if (tab === 'Portfolio') return null;
    if (tab === '🎯 Watchlist' && kind === 'create') return null;
    return 'refused a write to "' + tab + '" in My Portfolio: the robot writes only the Portfolio tab there';
  }
  return null;
}

function refuse(opts: AllowListOptions, message: string): void {
  if (opts.strict) throw new SheetAllowListError(message);
  opts.onRefuse?.(message);
}

const colourOnly = (ops: readonly FormatOp[]): boolean => ops.every((o) => o.op === 'tabColor');

export type ByRole<T> = Readonly<Record<SheetRole, T>>;

export class RoutingTabStore implements TabStore {
  private readonly stores: ByRole<TabStore>;
  private readonly opts: AllowListOptions;
  constructor(stores: ByRole<TabStore>, opts: AllowListOptions = {}) {
    this.stores = stores;
    this.opts = opts;
  }
  private allowed(tab: string, kind: WriteKind): boolean {
    const why = allowListRefusal(tab, kind);
    if (why) { refuse(this.opts, why); return false; }
    return true;
  }
  read(tab: string, nCols: number, dateColumns?: readonly number[]): Promise<TabCell[][] | null> {
    return this.stores[sheetFor(tab)].read(tab, nCols, dateColumns);
  }
  async ensure(tab: string): Promise<boolean> {
    if (!this.allowed(tab, 'create')) return false;
    return this.stores[sheetFor(tab)].ensure(tab);
  }
  async clear(tab: string): Promise<void> {
    if (!this.allowed(tab, 'write')) return;
    return this.stores[sheetFor(tab)].clear(tab);
  }
  async write(tab: string, row: number, rows: readonly (readonly TabCell[])[], format?: TabWriteFormat): Promise<void> {
    if (!this.allowed(tab, 'write')) return;
    return this.stores[sheetFor(tab)].write(tab, row, rows, format);
  }
}

export class RoutingWorkbookBackend implements WorkbookBackend {
  private readonly backends: ByRole<WorkbookBackend>;
  private readonly opts: AllowListOptions;
  constructor(backends: ByRole<WorkbookBackend>, opts: AllowListOptions = {}) {
    this.backends = backends;
    this.opts = opts;
  }
  async listTabs(): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    const seen = new Set<string>();
    for (const role of ['portfolio', 'reports', 'data'] as const) {
      for (const t of await this.backends[role].listTabs()) {
        if (sheetFor(t.name) !== role || seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }
  readTab(tab: string): Promise<TabCell[][] | null> {
    return this.backends[sheetFor(tab)].readTab(tab);
  }
  private permitted(tab: string, change: TabChange): boolean {
    const onlyColour = !change.created && !change.cleared && change.cells.length === 0 && colourOnly(change.ops);
    if (onlyColour) return true;
    const why = allowListRefusal(tab, change.created ? 'create' : 'write');
    if (why) { refuse(this.opts, why); return false; }
    return true;
  }
  async applyTab(tab: string, change: TabChange): Promise<void> {
    if (!this.permitted(tab, change)) return;
    return this.backends[sheetFor(tab)].applyTab(tab, change);
  }
  /** C3: the changes grouped by sheetFor, one grouped write per spreadsheet (first-touch order inside each). */
  async applyTabs(changes: ReadonlyArray<readonly [string, TabChange]>): Promise<void> {
    const groups = new Map<SheetRole, Array<readonly [string, TabChange]>>();
    for (const [tab, change] of changes) {
      if (!this.permitted(tab, change)) continue;
      const role = sheetFor(tab);
      groups.set(role, [...(groups.get(role) ?? []), [tab, change]]);
    }
    for (const [role, list] of groups) {
      const b = this.backends[role];
      if (b.applyTabs) await b.applyTabs(list);
      else for (const [tab, change] of list) await b.applyTab(tab, change);
    }
  }
}

export class RoutingFormatter implements TabFormatter {
  private readonly formatters: ByRole<TabFormatter>;
  constructor(formatters: ByRole<TabFormatter>) {
    this.formatters = formatters;
  }
  apply(tab: string, ops: readonly FormatOp[]): Promise<void> {
    return this.formatters[sheetFor(tab)].apply(tab, ops);
  }
}
