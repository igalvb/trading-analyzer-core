/**
 * The migration's reconciliation (docs/LEDGER.md): what the ledger files add up to, per group, against the sheet's OWN
 * totals (its summary cells, read by ledger/fromSheet.ts). A difference over 0.5% is flagged. Pure.
 *
 * The ledger side is valued at the sheet's own prices (each row's "price per item", the crypto manualPrice, the open
 * calls' "current market value"), so a flag means a row was left out, mapped twice or read wrong -- not a price move.
 */

import { LEDGER_GROUPS, groupOfStock, type Currency, type LedgerGroup } from './schema.ts';
import type { FromSheetResult } from './fromSheet.ts';

export const RECONCILE_TOLERANCE = 0.005;

export interface GroupLine { readonly group: LedgerGroup; readonly count: number; readonly total: number; readonly currency: Currency }
export interface ReconLine {
  readonly check: string;
  readonly currency: Currency;
  readonly ledger: number | null;
  readonly sheet: number | null;
  /** (ledger - sheet) / |sheet|, in percent; null when either side is missing. */
  readonly diffPct: number | null;
  readonly flagged: boolean;
}
export interface Reconciliation {
  readonly groups: readonly GroupLine[];
  readonly lines: readonly ReconLine[];
  readonly fxUsdIls: number | null;
  readonly flagged: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function reconcile(m: FromSheetResult): Reconciliation {
  const sum = new Map<LedgerGroup, { count: number; total: number }>(LEDGER_GROUPS.map((g) => [g, { count: 0, total: 0 }]));
  const add = (g: LedgerGroup, v: number): void => { const s = sum.get(g)!; s.count++; s.total += v; };
  for (const s of m.holdings.stocks) add(groupOfStock(s), s.qty * (s.manualPrice ?? m.sheetPrice[s.id] ?? 0));
  for (const o of m.holdings.options) add('calls', o.currentValue ?? 0);
  for (const a of m.assets.items) add(a.group, a.value - (a.debt ?? 0));
  const ils = (g: LedgerGroup): boolean => g === 'pension' || g === 'funds' || g === 'realEstate' || g === 'cash';
  const groups: GroupLine[] = LEDGER_GROUPS.map((g) => ({ group: g, count: sum.get(g)!.count, total: r2(sum.get(g)!.total), currency: ils(g) ? 'ILS' : 'USD' }));
  const total = (g: LedgerGroup): number => sum.get(g)!.total;

  const t = m.totals, fx = t.fxUsdIls;
  const stockTable = total('stocks') + total('btcFunds') + total('crypto');
  const portfolioUsd = stockTable + total('calls');
  const portfolioIls = fx != null ? portfolioUsd * fx : null;
  const pension = total('pension') + total('funds');
  // The sheet's separate debt line, when the migration made it a property's mortgage (layout debtTo 'realEstate').
  const attached = m.sheetDebt?.attachedTo ? m.sheetDebt.amount : 0;
  const line = (check: string, currency: Currency, ledger: number | null, sheet: number | null): ReconLine => {
    const diffPct = ledger != null && sheet != null && sheet !== 0 ? ((ledger - sheet) / Math.abs(sheet)) * 100 : ledger != null && sheet === 0 ? (ledger === 0 ? 0 : null) : null;
    return { check, currency, ledger: ledger == null ? null : r2(ledger), sheet: sheet == null ? null : r2(sheet), diffPct: diffPct == null ? null : Math.round(diffPct * 100) / 100, flagged: diffPct == null || Math.abs(diffPct) > RECONCILE_TOLERANCE * 100 };
  };
  const lines: ReconLine[] = [
    line('Stock table (stocks + bitcoin funds + crypto) vs the sub-type rows', 'USD', stockTable, t.stockTableUsd),
    line('Open calls vs the sub-type "options" row', 'USD', total('calls'), t.optionsUsd),
    line('Total Portfolio Sum $', 'USD', portfolioUsd, t.portfolioUsd),
    line('Total Portfolio Sum NIS (at the sheet\'s USD/ILS)', 'ILS', portfolioIls, t.portfolioIls),
    line('Pension + savings funds vs Total pension NIS', 'ILS', pension, t.pensionIls),
    line('Real estate, net of mortgage' + (attached ? ' (before the separate debt line)' : ''), 'ILS', total('realEstate') + attached, t.realEstateIls),
    line('Debt' + (attached ? ' (as a property mortgage)' : ' (as negative cash)'), 'ILS', attached || -total('cash'), t.debtIls),
    line('Total Savings NIS (portfolio + pension - debt)', 'ILS', portfolioIls != null ? portfolioIls + pension + total('cash') - attached : null, t.savingsIls),
    line('Total savings with assets (+ real estate)', 'ILS', portfolioIls != null ? portfolioIls + pension + total('cash') + total('realEstate') : null, t.savingsWithAssetsIls),
  ].filter((l) => l.sheet != null || l.ledger !== 0);
  return { groups, lines, fxUsdIls: fx, flagged: lines.filter((l) => l.flagged).length };
}

const money = (x: number | null): string => (x == null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** The reconciliation as plain-text table lines (the CLI prints them; docs/LEDGER.md has the template). */
export function reconciliationTable(r: Reconciliation): string[] {
  const out = ['Per group (ledger, at the sheet\'s prices):', '| group | items | total |', '|---|---:|---:|'];
  for (const g of r.groups) out.push('| ' + g.group + ' | ' + g.count + ' | ' + money(g.total) + ' ' + g.currency + ' |');
  out.push('', 'Against the sheet\'s own totals (USD/ILS ' + (r.fxUsdIls == null ? '—' : Math.round(r.fxUsdIls * 10_000) / 10_000) + '; flag = difference over ' + RECONCILE_TOLERANCE * 100 + '% or a side missing):',
    '| check | ledger | sheet | diff | |', '|---|---:|---:|---:|---|');
  for (const l of r.lines) out.push('| ' + l.check + ' | ' + money(l.ledger) + ' ' + l.currency + ' | ' + money(l.sheet) + ' | ' + (l.diffPct == null ? '—' : l.diffPct + '%') + ' | ' + (l.flagged ? 'FLAG' : 'ok') + ' |');
  return out;
}
