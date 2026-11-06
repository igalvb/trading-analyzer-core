/**
 * LedgerHoldings -> the PortfolioResult the runs read today (sheets/readers/portfolio.ts), so the Exit / Buy / paper
 * pipelines can take their holdings from the ledger with no other change (docs/LEDGER.md phase 3).
 *
 *   stocks + btcFunds  -> stocks (a holding with no `bought` gets the profile's assumed purchase date, as the sheet does)
 *   crypto             -> skippedCrypto (not analysed, as the sheet's crypto rows)
 *   options            -> options
 *   closed             -> nothing (the runs never read sold positions)
 * Row numbers are the item's place in the file (1-based): there is no sheet row any more.
 *
 * compareHoldings: the shadow phase's check, sheet vs ledger, as plain difference lines ([] = the same holdings).
 */

import { assumedStockPurchaseDate, type OptionHolding, type PortfolioResult, type StockHolding } from '../sheets/readers/portfolio.ts';
import type { LedgerHoldings } from './schema.ts';
import { calendarDay } from './fromSheet.ts';

const utcDay = (d: string | null): Date | null => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z') : null);

export function toPortfolio(h: LedgerHoldings): PortfolioResult {
  const stocks: StockHolding[] = [];
  const skippedCrypto: string[] = [];
  h.stocks.forEach((s, i) => {
    if (s.kind === 'crypto') { skippedCrypto.push(s.ticker); return; }
    const bought = utcDay(s.bought);
    stocks.push({ ticker: s.ticker, shares: s.qty, avgCost: s.avgCost, entryDate: bought ?? assumedStockPurchaseDate(), rowNumber: i + 1, ...(bought ? {} : { entryDateAssumed: true }) });
  });
  const options: OptionHolding[] = h.options.map((o, i) => ({
    ticker: o.ticker, contracts: o.contracts, strike: o.strike, expiry: utcDay(o.expiry), side: o.side, avgPremium: o.avgPremium,
    entryDate: utcDay(o.bought), rowNumber: i + 1, currentValue: o.currentValue ?? null,
  }));
  return { stocks, options, skippedCrypto, skippedOther: [], blankRowCount: 0 };
}

const day = (d: Date | null | undefined): string => calendarDay(d) ?? '-';
const n = (x: number | null | undefined): string => (x == null ? '-' : String(Math.round(x * 1e6) / 1e6));
const stockKey = (s: StockHolding): string => s.ticker;
const stockText = (s: StockHolding): string => 'qty ' + n(s.shares) + ', cost ' + n(s.avgCost) + ', bought ' + (s.entryDateAssumed ? 'assumed' : day(s.entryDate));
const optionKey = (o: OptionHolding): string => o.ticker + ' ' + o.side + ' ' + n(o.strike) + ' ' + day(o.expiry);
const optionText = (o: OptionHolding): string => 'contracts ' + n(o.contracts) + ', premium ' + n(o.avgPremium) + ', bought ' + day(o.entryDate);

function diffBy<T>(kind: string, sheet: readonly T[], ledger: readonly T[], key: (x: T) => string, text: (x: T) => string): string[] {
  const group = (xs: readonly T[]): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), text(x)]);
    return m;
  };
  const a = group(sheet), b = group(ledger), out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const sa = [...(a.get(k) ?? [])].sort(), sb = [...(b.get(k) ?? [])].sort();
    if (!sb.length) out.push(kind + ' ' + k + ': in the sheet only (' + sa.join('; ') + ')');
    else if (!sa.length) out.push(kind + ' ' + k + ': in the ledger only (' + sb.join('; ') + ')');
    else if (sa.join('|') !== sb.join('|')) out.push(kind + ' ' + k + ': sheet ' + sa.join('; ') + ' / ledger ' + sb.join('; '));
  }
  return out;
}

/** Sheet vs ledger: same stocks (quantity, cost, purchase date), options (contracts, premium, date) and crypto list. */
export function compareHoldings(sheet: PortfolioResult, ledger: PortfolioResult): string[] {
  const crypto = (p: PortfolioResult): string[] => [...p.skippedCrypto].sort();
  const cs = crypto(sheet), cl = crypto(ledger);
  return [
    ...diffBy('stock', sheet.stocks, ledger.stocks, stockKey, stockText),
    ...diffBy('option', sheet.options, ledger.options, optionKey, optionText),
    ...(cs.join(',') !== cl.join(',') ? ['crypto: sheet ' + (cs.join(', ') || 'none') + ' / ledger ' + (cl.join(', ') || 'none')] : []),
  ];
}
