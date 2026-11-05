/**
 * Backlog 9 (owner 4d): buy-and-hold benchmarks, untaxed and taxed.
 *
 * Equal weight: the starting cash is split evenly over the tickers; each slice buys whole shares at the open of
 * the ticker's first trading day on or after the start (IBIT / ALAB on their listing day; the slice waits as
 * cash until then). Held to the last close on or before the end. Taxed = 25% of each position's gain at the
 * end (portfolio/exitTax.ts computeExitTax, 0 on a loss), the same rule the system's sells pay.
 */

import { computeExitTax } from '../portfolio/exitTax.ts';
import { lastIndexOnOrBefore, type PriceSeries } from './data.ts';

export interface BenchmarkPosition {
  readonly ticker: string;
  readonly buyDay: string;
  readonly shares: number;
  readonly buyPrice: number;
  readonly endPrice: number;
}

export interface BenchmarkResult {
  readonly name: string;
  readonly tickers: readonly string[];
  readonly start: number;
  readonly untaxed: number;
  readonly taxed: number;
  readonly positions: readonly BenchmarkPosition[];
}

/** First bar index dated on or after `day`. */
export function firstIndexOnOrAfter(s: PriceSeries, day: string): number {
  const i = lastIndexOnOrBefore(s, day);
  if (i >= 0 && s.dates[i] === day) return i;
  return i + 1 < s.dates.length ? i + 1 : -1;
}

export function buyAndHold(
  name: string, series: ReadonlyMap<string, PriceSeries>, tickers: readonly string[], startDay: string, endDay: string, cash: number,
): BenchmarkResult {
  if (!tickers.length) return { name, tickers, start: cash, untaxed: cash, taxed: cash, positions: [] };
  const slice = cash / tickers.length;
  let left = cash, untaxed = 0, taxed = 0;
  const positions: BenchmarkPosition[] = [];
  for (const t of tickers) {
    const s = series.get(t);
    if (!s) throw new Error('benchmark: no prices for ' + t);
    const bi = firstIndexOnOrAfter(s, startDay);
    const ei = lastIndexOnOrBefore(s, endDay);
    if (bi < 0 || ei < bi) continue;
    const buyPrice = s.opens[bi] as number;
    const shares = Math.floor(slice / buyPrice);
    const endPrice = s.closes[ei] as number;
    left -= shares * buyPrice;
    const x = computeExitTax({ quantity: shares, unitCost: buyPrice, unitPrice: endPrice });
    untaxed += shares * endPrice;
    taxed += x.afterTaxValueUsd ?? shares * endPrice;
    positions.push({ ticker: t, buyDay: s.dates[bi] as string, shares, buyPrice, endPrice });
  }
  return { name, tickers, start: cash, untaxed: untaxed + left, taxed: taxed + left, positions };
}
