/**
 * Fixtures for the FL-7b1 tests: a Transactions tab with one row per row class
 * readTransactionsV7 distinguishes (sheet row = index + 1) and the hidden
 * _OPTIONS_SNAPSHOT tab it is matched against.
 */

import type { TabCell } from '../src/storage/tabStore.ts';
import { OPTIONS_SNAPSHOT_COLS } from '../src/reports/options/tabs.ts';

export const TZ = 'America/New_York';
export const NOW = Date.parse('2026-10-23T15:00:00Z');
export const TX_SHEET = '📒 Transactions';
export const SNAPSHOT_TAB = '_OPTIONS_SNAPSHOT';

const dt = (iso: string): Date => new Date(iso);
const EXP_JAN27 = dt('2027-01-15T12:00:00Z');
const EXP_JUN27_TEXT = "Jun 18 '27";
const TX_H = ['Date', 'Ticker', 'Asset Type', 'Action', 'Shares/Contracts', 'Price', 'Strike', 'Expiry', 'Notes'];

export function transactionsGrid(): TabCell[][] {
  const d = dt('2026-01-04T00:00:00Z');
  return [
    TX_H,
    // PLTR stock: lower-case ticker and action, numeric strings, an ISO-string date, a blank asset type, a 0 note
    [dt('2026-01-05T00:00:00Z'), 'pltr', 'STOCK', 'buy', 100, 20, '', '', 'first lot'],
    [dt('2026-02-10T00:00:00Z'), 'PLTR', 'stock', 'BUY', '50', '30.5', '', '', 0],
    ['2026-03-01', 'PLTR', '', 'SELL', 120, 40, '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['2026-02-20', 'PLTR', 'STOCK', 'SELL', 5, 35, '', '', 'out of sheet order'],
    ['4/1/2026', 'PLTR', 'STOCK', 'BUY', 10, 50, '', '', ''],
    // AAPL: a SELL with nothing to sell, then a BUY. MSFT: a partial over-sell, closed.
    [dt('2026-01-02T00:00:00Z'), 'AAPL', 'STOCK', 'SELL', 10, 150, '', '', ''],
    [dt('2026-01-09T00:00:00Z'), 'AAPL', 'STOCK', 'BUY', 5, 160, '', '', ''],
    [dt('2026-01-03T00:00:00Z'), 'MSFT', 'STOCK', 'BUY', 2, 300, '', '', ''],
    [dt('2026-01-04T00:00:00Z'), 'MSFT', 'STOCK', 'SELL', 5, 310, '', '', ''],
    // TSLA: closed exactly, then a dust lot (<= 1e-6 shares) that also drops off
    [dt('2026-01-06T00:00:00Z'), 'TSLA', 'STOCK', 'BUY', 10, 100, '', '', ''],
    [dt('2026-01-07T00:00:00Z'), 'TSLA', 'STOCK', 'SELL', 10, 120, '', '', ''],
    [dt('2026-01-08T00:00:00Z'), 'TSLA', 'STOCK', 'BUY', 1e-7, 5, '', '', ''],
    // NVDA: a numeric date cell. AMD: a stock row with junk in Strike (ignored for STOCK).
    [46000, 'NVDA', 'STOCK', 'BUY', 7, 120, '', '', ''],
    [d, 'amd', 'STOCK', 'BUY', 1, 1, 'abc', '', ''],
    // ---- one row per parse problem (13 warnings) ----
    ['abc', 'AMD', 'STOCK', 'BUY', 1, 1, '', '', ''],
    [d, '', 'STOCK', 'BUY', 1, 1, '', '', ''],
    [d, '  ', 'STOCK', 'BUY', 1, 1, '', '', ''],
    [d, 'AMD', 'BOND', 'BUY', 1, 1, '', '', ''],
    [d, 'AMD', 'STOCK', 'HOLD', 1, 1, '', '', ''],
    [d, 'AMD', 'STOCK', 'BUY', 0, 1, '', '', ''],
    [d, 'AMD', 'STOCK', 'BUY', 'x', 1, '', '', ''],
    [d, 'AMD', 'STOCK', 'BUY', 1, -1, '', '', ''],
    [d, 'AMD', 'STOCK', 'BUY', 1, '', '', '', ''],
    [d, 'AMD', 'OPTION', 'BUY', 1, 1, '', EXP_JAN27, ''],
    [d, 'AMD', 'OPTION', 'BUY', 1, 1, 100, '', ''],
    [d, 'AMD', 'OPTION', 'BUY', 1, 1, 'abc', EXP_JAN27, ''],
    ['nope', '', 'FUTURE', 'HOLD', '', '-3', '', '', ''],
    // ---- PLTR 150 Jan 2027: a Date expiry, a text expiry (same contract), and a SELL typed as the label "Jan 15, 2027" ----
    [dt('2026-01-10T00:00:00Z'), 'pltr', 'OPTION', 'BUY', 2, 5.5, 150, EXP_JAN27, ''],
    [dt('2026-01-20T00:00:00Z'), 'PLTR', 'option', 'BUY', 1, 6.5, 150, "Jan 15 '27", ''],
    [dt('2026-02-01T00:00:00Z'), 'PLTR', 'OPTION', 'SELL', 1, 9, 150, 'Jan 15, 2027', ''],
    // PLTR 40 Jun 2027 open (the snapshot holds a 40.02 decoy and a 40.004 match); PLTR 200 closed
    [dt('2026-01-12T00:00:00Z'), 'PLTR', 'OPTION', 'BUY', 3, 2, 40, EXP_JUN27_TEXT, ''],
    [dt('2026-01-13T00:00:00Z'), 'PLTR', 'OPTION', 'BUY', 1, 1, 200, EXP_JUN27_TEXT, ''],
    [dt('2026-01-14T00:00:00Z'), 'PLTR', 'OPTION', 'SELL', 1, 3, 200, EXP_JUN27_TEXT, ''],
    // open options the snapshot cannot answer: another ticker, and a strike it does not hold; an option over-sell
    [dt('2026-01-15T00:00:00Z'), 'MSFT', 'OPTION', 'BUY', 1, 3, 300, EXP_JAN27, ''],
    [dt('2026-01-16T00:00:00Z'), 'PLTR', 'OPTION', 'BUY', 1, 1, 999, EXP_JAN27, ''],
    [dt('2026-01-17T00:00:00Z'), 'TSLA', 'OPTION', 'SELL', 2, 1, 100, EXP_JAN27, ''],
  ];
}

/** META, headers, contracts; a blank-first-cell row is skipped, numeric strings are converted. */
export function snapshotGrid(ticker = 'PLTR'): TabCell[][] {
  const cols = [...OPTIONS_SNAPSHOT_COLS];
  const row = (side: string, strike: TabCell, expiry: TabCell, days: TabCell, conviction: TabCell): TabCell[] =>
    [side, strike, expiry, days, 1200, '300', 0.55, 50000, 5, 5, 5, 5, 5, 5, conviction, 'LEAPS'];
  return [
    ['META', JSON.stringify({ ticker, priceAtRun: 25.5, timestamp: '2026-10-21T15:00:00Z', context: { putCallRatioOI: 0.8 } })],
    cols,
    row('CALL', 150, EXP_JAN27, 450, 72),
    row('CALL', 40.02, EXP_JUN27_TEXT, 600, 61),
    row('CALL', 40.004, EXP_JUN27_TEXT, '600', '66'),
    row('PUT', 300, EXP_JAN27, 450, 40),
    ['', 1, 2],
  ];
}
