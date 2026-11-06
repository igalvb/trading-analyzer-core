/**
 * Is this ticker an ETF / fund? From the project's existing reference lists only (no provider call): the spot
 * Bitcoin ETFs (types/bitcoinEtfs.ts), the SPDR sector ETFs incl. SPY (holdings.ts) and QQQ. Used to log the
 * "a fund has no such data" lines (no peers, no short interest / interest coverage) below WARNING. Log level only:
 * no score, status or report reads it.
 */

import { BITCOIN_ETF_TICKERS } from '../../types/bitcoinEtfs.ts';
import { SPDR_ETF_TICKERS } from './holdings.ts';

const ETF_OR_FUND: ReadonlySet<string> = new Set([...BITCOIN_ETF_TICKERS, ...SPDR_ETF_TICKERS, 'QQQ']);

export function isEtfOrFund(ticker: string | null | undefined): boolean {
  return ETF_OR_FUND.has(String(ticker ?? '').toUpperCase().trim());
}
