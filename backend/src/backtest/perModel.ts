/**
 * Owner request 2026-10-27: the simulation per model. Each of the 4 book models trades one stock on its OWN
 * daily read, from the same cached engine runs (no model or score code changed, nothing recomputed):
 *   flat and the model reads "bullish"    -> buy with all the cash at the next day's open;
 *   holding and the model reads "cautionary" -> sell everything at the next day's open;
 *   "mixed" or no read                    -> keep what you have.
 * Tax: 25% of each sale's gain (none on a loss); at the end 25% of the gain still held is taken too, like the
 * other tests' "taxed" value. Whole shares. The engine and the combined system run through runTest (allIn).
 */

import type { PriceSeries } from './data.ts';
import type { EngineRead } from './engineRun.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';

export const BOOK_MODELS = ['schabacker', 'edwardsMagee', 'broker', 'turtle'] as const;
export type BookModel = (typeof BOOK_MODELS)[number];
export const MODEL_LABEL: Readonly<Record<BookModel, string>> = { schabacker: 'Schabacker', edwardsMagee: 'Edwards & Magee', broker: 'Broker Course', turtle: 'Turtle' };

export interface FollowResult {
  readonly finalTaxed: number;
  readonly buys: number;
  /** Average share of the account in the stock at the close, 0-100. */
  readonly investedPct: number;
}

export async function followModel(
  s: PriceSeries, read: (day: string) => Promise<EngineRead | undefined>, model: BookModel, start: string, end: string, cash0: number,
): Promise<FollowResult> {
  let cash = cash0, shares = 0, cost = 0, buys = 0, investedSum = 0, days = 0;
  let pending: 'BUY' | 'SELL' | null = null;
  let lastClose = 0;
  for (let i = 0; i < s.dates.length; i++) {
    const day = s.dates[i] as string;
    if (day < start || day > end) continue;
    const open = s.opens[i] as number, close = s.closes[i] as number;
    if (pending === 'BUY' && shares === 0) {
      const n = Math.floor(cash / open);
      if (n > 0) { shares = n; cost = n * open; cash -= cost; buys++; }
    } else if (pending === 'SELL' && shares > 0) {
      const value = shares * open, gain = value - cost;
      cash += value - (gain > 0 ? gain * EXIT_TAX_RATE : 0);
      shares = 0; cost = 0;
    }
    pending = null;
    const dir = (await read(day))?.directions?.[model] ?? null;
    if (shares === 0 && dir === 'bullish') pending = 'BUY';
    else if (shares > 0 && dir === 'cautionary') pending = 'SELL';
    const equity = cash + shares * close;
    investedSum += equity > 0 ? (shares * close) / equity : 0;
    days++;
    lastClose = close;
  }
  const value = shares * lastClose, gain = value - cost;
  return { finalTaxed: cash + value - (shares > 0 && gain > 0 ? gain * EXIT_TAX_RATE : 0), buys, investedPct: days ? (investedSum / days) * 100 : 0 };
}
