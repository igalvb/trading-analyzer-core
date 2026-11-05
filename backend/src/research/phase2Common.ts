/**
 * Shared output helpers of James's models, phase 2 (research/meanRevCli.ts, pairCli.ts, bigWinnersCli.ts): the same
 * results row and header as phase 1 (liloV2Cli.ts), and a price loader that skips files not downloaded.
 */

import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { resultRow, RESULT_HEAD, pct, CASH } from './liloV2Cli.ts';

export { pct, CASH };
export const resultRowP2 = (name: string, r: ReadonlyArray<{ finalTaxed: number; maxDrawdownPct: number; trades: number }>, b: Parameters<typeof resultRow>[2]): string =>
  resultRow(name, r.map((x) => ({ ...x, cashShareByDay: new Map(), buysByTicker: new Map() })), b);
export const RESULT_HEAD_P2 = RESULT_HEAD;

export function loadBag(priceDir: string, tickers: readonly string[]): Map<string, PriceSeries> {
  const m = new Map<string, PriceSeries>();
  for (const t of tickers) { try { m.set(t, loadSeries(t, priceDir)); } catch { /* not downloaded */ } }
  return m;
}
