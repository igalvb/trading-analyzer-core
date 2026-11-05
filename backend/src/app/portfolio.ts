/**
 * F8: ONE portfolio reader. The Portfolio sheet (sheets/readers/portfolio.ts,
 * the table the user maintains, the one that discloses crypto and other
 * skipped rows) is the source for the nightly ticker list, the Buy pipeline
 * and the Exit pipeline alike; the nightly/Buy shape (PortfolioSummary) is a
 * projection of it. The '📒 Transactions' tab stays the dashboard's own
 * "your position" source, as in legacy.
 */

import type { PortfolioResult } from '../sheets/readers/portfolio.ts';
import type { PortfolioSummary, Position } from '../portfolio/transactions.ts';

const day = (d: Date | null): string => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '');

export function toPortfolioSummary(p: PortfolioResult): PortfolioSummary {
  const positions: Position[] = [
    ...p.stocks.map((s): Position => ({ ticker: s.ticker, assetType: 'STOCK', shares: s.shares ?? 0, avgCost: s.avgCost ?? 0, earliestLotDate: s.entryDateAssumed ? '' : day(s.entryDate) })),
    ...p.options.map((o): Position => ({
      ticker: o.ticker, assetType: 'OPTION', strike: o.strike, expiry: o.expiry ? day(o.expiry) : null, contracts: o.contracts ?? 0,
      avgPremium: o.avgPremium ?? 0, earliestLotDate: day(o.entryDate), snapshot: null,
    })),
  ];
  const warnings = [
    ...p.skippedCrypto.map((t) => 'Skipped ' + t + ': crypto is not analysed.'),
    ...p.skippedOther.map((r) => 'Skipped row ' + r.rowNumber + (r.ticker ? ' (' + r.ticker + ')' : '') + '.'),
  ];
  return { positions, warnings };
}

/** Distinct tickers held (stocks and option underlyings), in sheet order. */
export function heldTickers(p: PortfolioResult): string[] {
  const out: string[] = [];
  for (const t of [...p.stocks.map((s) => s.ticker), ...p.options.map((o) => o.ticker)]) {
    const u = String(t || '').toUpperCase().trim();
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}
