/**
 * One day's LedgerSnapshot (ledger/schema.ts): the value of every group in USD, from tonight's prices and the static
 * values of assets.json. Pure: the prices and the USD/ILS rate come in.
 *
 *   stocks, btcFunds  qty x (manualPrice, else tonight's close)
 *   crypto            qty x (manualPrice, else the price of '<TICKER>-USD')
 *   calls             the options' currentValue (all contracts; written by My Options)
 *   pension, funds, realEstate (net of debt), cash   assets.json, ILS -> USD at fxUsdIls (none = left out)
 * A holding with no price is left out of its group and named in `missing` (never valued at 0 silently).
 */

import { LEDGER_SCHEMA, groupOfStock, type LedgerAssets, type LedgerGroup, type LedgerHoldings, type LedgerSnapshot } from './schema.ts';

export interface SnapshotInput {
  readonly date: string;
  readonly holdings: LedgerHoldings;
  readonly assets: LedgerAssets | null;
  /** Tonight's price of a market symbol; null when not known. */
  readonly price: (ticker: string) => number | null;
  readonly fxUsdIls: number | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function buildSnapshot(i: SnapshotInput): { readonly snapshot: LedgerSnapshot; readonly missing: readonly string[] } {
  const usd: Partial<Record<LedgerGroup, number>> = {};
  const missing: string[] = [];
  const add = (g: LedgerGroup, v: number): void => { usd[g] = (usd[g] ?? 0) + v; };
  for (const s of i.holdings.stocks) {
    const p = s.manualPrice ?? i.price(s.kind === 'crypto' ? s.ticker.replace(/\.+$/, '') + '-USD' : s.ticker);
    if (p == null || !Number.isFinite(p)) { missing.push(s.ticker + ' (no price)'); continue; }
    const v = s.qty * p;
    add(groupOfStock(s), s.currency === 'ILS' ? (i.fxUsdIls ? v / i.fxUsdIls : NaN) : v);
  }
  for (const o of i.holdings.options) {
    if (o.currentValue == null) { missing.push(o.ticker + ' ' + o.strike + ' ' + o.expiry + ' (no current value)'); continue; }
    add('calls', o.currentValue);
  }
  for (const a of i.assets?.items ?? []) {
    const net = a.value - (a.debt ?? 0);
    if (a.currency === 'USD') { add(a.group, net); continue; }
    if (!i.fxUsdIls) { missing.push(a.name + ' (no USD/ILS rate)'); continue; }
    add(a.group, net / i.fxUsdIls);
  }
  for (const g of Object.keys(usd) as LedgerGroup[]) if (!Number.isFinite(usd[g] as number)) { missing.push(g + ' (no USD/ILS rate)'); delete usd[g]; } else usd[g] = r2(usd[g] as number);
  const totalUsd = r2(Object.values(usd).reduce((a, b) => a + (b ?? 0), 0));
  return {
    snapshot: { schema: LEDGER_SCHEMA, date: i.date, fxUsdIls: i.fxUsdIls, usd, totalUsd, totalIls: i.fxUsdIls ? r2(totalUsd * i.fxUsdIls) : null },
    missing,
  };
}
