/**
 * The migration's corrections hook (docs/LEDGER.md phase 1, "Corrections"): the user's answers to the "needs owner
 * check" list, applied to what ledger/fromSheet.ts read, so a fresh migration gives the corrected files every time.
 * Generic: every correction names the migration's stable ids (fromSheet.ts) or a cell of the migrated tab. The shared
 * core carries none (NO_CORRECTIONS); a user keeps theirs in a private overlay, src/owner/ledgerAnswers.ts (export
 * OWNER_LEDGER_CORRECTIONS), or in a JSON file named by LEDGER_CORRECTIONS_FILE.
 *
 * Two kinds, applied in this order by src/ledgerMigrate.ts:
 *   fixes    (stocks, assets, typedTotals, separateDebt): the sheet was read incompletely or into the wrong place;
 *            applied BEFORE the reconciliation, which then checks the fixed files against the sheet's own totals
 *   updates  new values the user gave after the sheet was last written (e.g. a property's value today); applied AFTER
 *            the reconciliation (the sheet's totals do not know them) and listed under it
 * `answered` removes the checks the user has answered from the list. A correction whose id is not in the migration
 * becomes a check of its own (nothing is dropped silently). Pure, except loadLedgerCorrections.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SheetRow } from '../sheets/coerce.ts';
import { toNumber } from '../sheets/coerce.ts';
import type { LedgerAsset, LedgerStock } from './schema.ts';
import { slug, type FromSheetResult, type OwnerCheck } from './fromSheet.ts';

type AssetOptional = 'debt' | 'note' | 'provider' | 'person' | 'savingsType';
export interface AssetChange {
  readonly set?: Partial<Omit<LedgerAsset, 'id'>>;
  readonly unset?: readonly AssetOptional[];
}
export interface StockChange {
  readonly set?: Partial<Pick<LedgerStock, 'subType' | 'avgCost' | 'manualPrice' | 'note' | 'priceSymbol' | 'bought'>>;
  /** What the whole quantity cost, in the holding's currency: avgCost = totalCost / qty. */
  readonly totalCost?: number;
}
/** A total the user typed in the sheet for a group (and a person) that is more than the rows itemized under it. */
export interface TypedTotal {
  /** The cell of the migrated tab, e.g. 'F2'. */
  readonly cell: string;
  readonly group: LedgerAsset['group'];
  /** Whose total (LedgerAsset.person); absent = every item of the group. */
  readonly person?: string;
  /** The added item's name (default NOT_ITEMIZED). */
  readonly name?: string;
}
/** A check the user answered: every condition given must match (`itemPattern` is a regular expression). */
export interface AnsweredCheck { readonly where?: string; readonly item?: string; readonly itemPattern?: string }

export interface LedgerCorrections {
  /** Shown by the migration, e.g. 'owner answers 2026-11-06'. */
  readonly label: string;
  readonly stocks?: Readonly<Record<string, StockChange>>;
  readonly assets?: Readonly<Record<string, AssetChange>>;
  readonly typedTotals?: readonly TypedTotal[];
  /** The sheet's separate debt line is an item of its own (value 0, debt = the amount), not a property's mortgage. */
  readonly separateDebt?: { readonly name: string; readonly id?: string; readonly group?: LedgerAsset['group'] };
  readonly answered?: readonly AnsweredCheck[];
  /** New values given after the sheet; `asOf` is set on every asset changed here. */
  readonly updates?: { readonly asOf: string; readonly assets?: Readonly<Record<string, AssetChange>>; readonly stocks?: Readonly<Record<string, StockChange>> };
}

export const NO_CORRECTIONS: LedgerCorrections = { label: 'none' };
export const NOT_ITEMIZED = 'Not itemized (sheet total)';

export interface Corrected {
  readonly result: FromSheetResult;
  /** One plain line per change made. */
  readonly applied: readonly string[];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const fmt = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const problem = (item: string, why: string): OwnerCheck => ({ where: 'corrections', item, why, raw: '' });

function changeAsset(a: LedgerAsset, ch: AssetChange, asOf?: string): LedgerAsset {
  const out: Record<string, unknown> = { ...a, ...(ch.set ?? {}), ...(asOf ? { asOf } : {}), id: a.id };
  for (const k of ch.unset ?? []) delete out[k];
  return out as unknown as LedgerAsset;
}
function changeStock(s: LedgerStock, ch: StockChange): LedgerStock | string {
  const out: LedgerStock = { ...s, ...(ch.set ?? {}), id: s.id };
  if (ch.totalCost == null) return out;
  if (!(s.qty > 0)) return 'a total cost needs a quantity above 0 (it has ' + s.qty + ')';
  return { ...out, avgCost: Math.round((ch.totalCost / s.qty) * 1e8) / 1e8 };
}
const describe = (ch: AssetChange | StockChange): string => {
  const parts = Object.entries(ch.set ?? {}).map(([k, v]) => k + ' ' + (typeof v === 'number' ? fmt(v) : JSON.stringify(v)));
  if ('unset' in ch && ch.unset?.length) parts.push('no ' + ch.unset.join(', '));
  if ('totalCost' in ch && ch.totalCost != null) parts.push('total cost ' + fmt(ch.totalCost));
  return parts.join(', ');
};

function applyStockAndAssetChanges(m: FromSheetResult, stocks: Readonly<Record<string, StockChange>> | undefined, assets: Readonly<Record<string, AssetChange>> | undefined, asOf: string | undefined, applied: string[], problems: OwnerCheck[]): FromSheetResult {
  let st = m.holdings.stocks, it = m.assets.items;
  for (const [id, ch] of Object.entries(stocks ?? {})) {
    const s = st.find((x) => x.id === id);
    if (!s) { problems.push(problem(id, 'a correction names this holding, but the migration has no such id: not applied')); continue; }
    const c = changeStock(s, ch);
    if (typeof c === 'string') { problems.push(problem(id, c + ': not applied')); continue; }
    st = st.map((x) => (x.id === id ? c : x));
    applied.push(id + ': ' + describe(ch) + (ch.totalCost != null ? ' (avg cost ' + c.avgCost + ')' : ''));
  }
  for (const [id, ch] of Object.entries(assets ?? {})) {
    const a = it.find((x) => x.id === id);
    if (!a) { problems.push(problem(id, 'a correction names this item, but the migration has no such id: not applied')); continue; }
    it = it.map((x) => (x.id === id ? changeAsset(x, ch, asOf) : x));
    applied.push(id + ': ' + describe(ch) + (asOf ? ' (as of ' + asOf + ')' : ''));
  }
  return { ...m, holdings: { ...m.holdings, stocks: st }, assets: { ...m.assets, items: it } };
}

/** 'F2' -> the number in that cell of the grid; null when it is not a number or not a cell. */
function cellValue(grid: readonly SheetRow[], cell: string): number | null {
  const a = /^([A-Z]{1,3})(\d+)$/.exec(cell.trim().toUpperCase());
  if (!a) return null;
  let c = 0;
  for (const ch of a[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
  return toNumber(grid[Number(a[2]) - 1]?.[c - 1] as SheetRow[number]);
}

/** The fixes: before the reconciliation. `grid` = the migrated tab (for typedTotals), `tab` its name. */
export function applyCorrections(m: FromSheetResult, c: LedgerCorrections, grid: readonly SheetRow[], tab = 'Portfolio'): Corrected {
  const applied: string[] = [], problems: OwnerCheck[] = [];
  let r = applyStockAndAssetChanges(m, c.stocks, c.assets, undefined, applied, problems);
  const today = m.holdings.updated;

  if (c.separateDebt) {
    const d = r.sheetDebt;
    if (!d) problems.push(problem(c.separateDebt.name, 'the sheet has no separate debt line: not applied'));
    else {
      let items = r.assets.items;
      if (d.attachedTo) {
        items = items.map((a) => {
          if (a.id !== d.attachedTo) return a;
          const left = (a.debt ?? 0) - d.amount;
          const note = d.added && a.note ? (a.note === d.added ? '' : a.note.endsWith('; ' + d.added) ? a.note.slice(0, -(d.added.length + 2)) : a.note) : a.note ?? '';
          const out: Record<string, unknown> = { ...a, ...(left > 0 ? { debt: left } : {}), ...(note ? { note } : {}) };
          if (!(left > 0)) delete out.debt;
          if (!note) delete out.note;
          return out as unknown as LedgerAsset;
        });
      }
      if (d.cashItem) items = items.filter((a) => a.id !== d.cashItem);
      const group = c.separateDebt.group ?? 'cash';
      const id = c.separateDebt.id ?? group + ':' + slug(c.separateDebt.name);
      items = [...items, { id, group, name: c.separateDebt.name, value: 0, debt: d.amount, currency: 'ILS', asOf: today, ...(d.cellNote ? { note: d.cellNote } : {}) }];
      r = { ...r, assets: { ...r.assets, items }, sheetDebt: { amount: d.amount, attachedTo: null, cashItem: id, ...(d.cellNote ? { cellNote: d.cellNote } : {}) } };
      applied.push(id + ': the sheet\'s debt line ' + fmt(d.amount) + ' as an item of its own (value 0, debt ' + fmt(d.amount) + ')' + (d.attachedTo ? ', no longer the mortgage of ' + d.attachedTo : ''));
    }
  }

  for (const t of c.typedTotals ?? []) {
    const total = cellValue(grid, t.cell);
    const where = tab + '!' + t.cell.toUpperCase();
    const label = t.group + (t.person ? ' of ' + t.person : '');
    if (total == null) { problems.push(problem(where, 'a typed total for ' + label + ' is named here, but the cell holds no number: nothing added')); continue; }
    const rows = r.assets.items.filter((a) => a.group === t.group && (t.person == null || a.person === t.person));
    const sum = rows.reduce((s, a) => s + a.value - (a.debt ?? 0), 0);
    const diff = r2(total - sum);
    if (Math.abs(diff) < 0.5) { applied.push(where + ': ' + label + ' already itemized in full (' + fmt(total) + ')'); continue; }
    if (diff < 0) { problems.push(problem(where, 'the typed total ' + fmt(total) + ' for ' + label + ' is LESS than its rows (' + fmt(sum) + '): nothing added')); continue; }
    const id = t.group + ':not-itemized' + (t.person ? '-' + slug(t.person) : '');
    const item: LedgerAsset = {
      id, group: t.group, name: t.name ?? NOT_ITEMIZED, value: diff, currency: rows[0]?.currency ?? 'ILS', asOf: rows[0]?.asOf ?? today,
      ...(t.person ? { person: t.person } : {}), note: 'the sheet\'s typed total ' + where + ' (' + fmt(total) + ') less the itemized rows (' + fmt(sum) + ')',
    };
    r = { ...r, assets: { ...r.assets, items: [...r.assets.items, item] } };
    applied.push(id + ': ' + fmt(diff) + ' = typed total ' + where + ' ' + fmt(total) + ' - rows ' + fmt(sum));
  }

  const { kept, answered } = withoutAnswered(r.needsOwnerCheck, c.answered ?? []);
  if (answered) applied.push(answered + ' check(s) answered: removed from the list');
  return { result: { ...r, needsOwnerCheck: [...kept, ...problems] }, applied };
}

/** The updates: after the reconciliation (the sheet's totals do not know them). */
export function applyUpdates(m: FromSheetResult, c: LedgerCorrections): Corrected {
  const applied: string[] = [], problems: OwnerCheck[] = [];
  if (!c.updates) return { result: m, applied };
  const r = applyStockAndAssetChanges(m, c.updates.stocks, c.updates.assets, c.updates.asOf, applied, problems);
  return { result: { ...r, needsOwnerCheck: [...r.needsOwnerCheck, ...problems] }, applied };
}

/** The checks left once the answered ones are removed. */
export function withoutAnswered(checks: readonly OwnerCheck[], answered: readonly AnsweredCheck[]): { kept: OwnerCheck[]; answered: number } {
  const res = answered.map((a) => (a.itemPattern ? new RegExp(a.itemPattern, 'u') : null));
  const hit = (ch: OwnerCheck): boolean => answered.some((a, i) => (a.where != null || a.item != null || a.itemPattern != null)
    && (a.where == null || a.where === ch.where) && (a.item == null || a.item === ch.item) && (res[i] == null || (res[i] as RegExp).test(ch.item)));
  const kept = checks.filter((ch) => !hit(ch));
  return { kept, answered: checks.length - kept.length };
}

type Env = Readonly<Record<string, string | undefined>>;

/** backend/src/owner/ledgerAnswers.ts (present only in a copy with a private overlay). */
export const OVERLAY_CORRECTIONS_FILE = path.join(import.meta.dirname, '..', 'owner', 'ledgerAnswers.ts');

/**
 * The corrections of this user's sheet: LEDGER_CORRECTIONS_FILE (JSON), else the overlay's when the sheet's words came
 * from the overlay too (`layoutSource`; both belong to the same sheet), else none.
 */
export async function loadLedgerCorrections(env: Env, layoutSource: 'file' | 'overlay' | 'default'): Promise<{ readonly corrections: LedgerCorrections; readonly source: 'file' | 'overlay' | 'none' }> {
  const file = (env.LEDGER_CORRECTIONS_FILE ?? '').trim();
  if (file) return { corrections: { ...NO_CORRECTIONS, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LedgerCorrections>) }, source: 'file' };
  if (layoutSource === 'overlay' && fs.existsSync(OVERLAY_CORRECTIONS_FILE)) {
    const m = await import(pathToFileURL(OVERLAY_CORRECTIONS_FILE).href) as { readonly OWNER_LEDGER_CORRECTIONS?: LedgerCorrections };
    if (m.OWNER_LEDGER_CORRECTIONS) return { corrections: m.OWNER_LEDGER_CORRECTIONS, source: 'overlay' };
  }
  return { corrections: NO_CORRECTIONS, source: 'none' };
}
