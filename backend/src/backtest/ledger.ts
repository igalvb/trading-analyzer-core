/**
 * Backlog 9: the backtest's cash-and-positions ledger.
 *
 *   - Whole shares, long only. A buy never spends more than the cash on hand (the caller scales it down first).
 *   - FIFO cost basis per ticker (the oldest lot is sold first).
 *   - Tax (portfolio/exitTax.ts EXIT_TAX_RATE, the owner's rule): 25% of each sell's realized gain, 0 on a loss,
 *     paid from cash at the sale. No holding period, no loss carry-forward. `taxRate: 0` gives the untaxed run.
 *   - The final "taxed" value also takes 25% of every remaining position's unrealized gain (as if sold at the
 *     last close, computeExitTax per position), so it compares like-for-like with the taxed benchmarks.
 */

import { EXIT_TAX_RATE, computeExitTax } from '../portfolio/exitTax.ts';

export interface Lot {
  readonly day: string;
  shares: number;
  readonly price: number;
}

export interface Trade {
  readonly day: string;
  readonly side: 'BUY' | 'SELL';
  readonly ticker: string;
  readonly shares: number;
  readonly price: number;
  readonly value: number;
  /** SELL only: FIFO cost of the shares sold, the realized gain and the tax paid on it. */
  readonly costBasis: number | null;
  readonly realizedGain: number | null;
  readonly tax: number | null;
  readonly cashAfter: number;
  /** The signal that caused it (engine read / exit read summary). */
  readonly note: string;
}

export class Ledger {
  cash: number;
  readonly taxRate: number;
  private readonly lots = new Map<string, Lot[]>();
  readonly trades: Trade[] = [];
  taxPaid = 0;
  realized = 0;

  constructor(cash: number, taxRate: number = EXIT_TAX_RATE) {
    this.cash = cash;
    this.taxRate = taxRate;
  }

  shares(ticker: string): number {
    return (this.lots.get(ticker) ?? []).reduce((a, l) => a + l.shares, 0);
  }

  /** Average cost per share of what is held now. */
  avgCost(ticker: string): number | null {
    const ls = this.lots.get(ticker) ?? [];
    const sh = ls.reduce((a, l) => a + l.shares, 0);
    return sh > 0 ? ls.reduce((a, l) => a + l.shares * l.price, 0) / sh : null;
  }

  /** Tickers with shares held, sorted. */
  held(): string[] {
    return [...this.lots.entries()].filter(([, ls]) => ls.some((l) => l.shares > 0)).map(([t]) => t).sort();
  }

  buy(day: string, ticker: string, shares: number, price: number, note = ''): Trade {
    if (!(Number.isInteger(shares) && shares > 0)) throw new Error('buy: shares must be a positive whole number');
    if (!(price > 0)) throw new Error('buy: price must be positive');
    const value = shares * price;
    if (value > this.cash + 1e-6) throw new Error('buy: not enough cash (' + value.toFixed(2) + ' > ' + this.cash.toFixed(2) + ')');
    this.cash -= value;
    const ls = this.lots.get(ticker) ?? [];
    ls.push({ day, shares, price });
    this.lots.set(ticker, ls);
    const t: Trade = { day, side: 'BUY', ticker, shares, price, value, costBasis: null, realizedGain: null, tax: null, cashAfter: this.cash, note };
    this.trades.push(t);
    return t;
  }

  sell(day: string, ticker: string, shares: number, price: number, note = ''): Trade {
    if (!(Number.isInteger(shares) && shares > 0)) throw new Error('sell: shares must be a positive whole number');
    if (shares > this.shares(ticker)) throw new Error('sell: more shares than held (long only)');
    const ls = this.lots.get(ticker) as Lot[];
    let left = shares, cost = 0;
    for (const l of ls) {
      if (left <= 0) break;
      const take = Math.min(l.shares, left);
      cost += take * l.price;
      l.shares -= take;
      left -= take;
    }
    this.lots.set(ticker, ls.filter((l) => l.shares > 0));
    const value = shares * price;
    const gain = value - cost;
    const tax = Math.max(0, gain) * this.taxRate;
    this.cash += value - tax;
    this.taxPaid += tax;
    this.realized += gain;
    const t: Trade = { day, side: 'SELL', ticker, shares, price, value, costBasis: cost, realizedGain: gain, tax, cashAfter: this.cash, note };
    this.trades.push(t);
    return t;
  }

  /** Cash plus every position at `priceOf(ticker)`. */
  equity(priceOf: (ticker: string) => number): number {
    return this.cash + this.held().reduce((a, t) => a + this.shares(t) * priceOf(t), 0);
  }

  /** Equity minus the 25% tax a sale of every remaining position at `priceOf` would owe (0 on a loss). */
  equityAfterLiquidationTax(priceOf: (ticker: string) => number, rate: number = this.taxRate): number {
    let v = this.cash;
    for (const t of this.held()) {
      const x = computeExitTax({ quantity: this.shares(t), unitCost: this.avgCost(t), unitPrice: priceOf(t) });
      v += (x.marketValueUsd ?? 0) - (rate > 0 ? (x.taxOwedUsd ?? 0) * (rate / EXIT_TAX_RATE) : 0);
    }
    return v;
  }
}
