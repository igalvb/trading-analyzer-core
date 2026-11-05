import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortfolio, PURCHASE_DATE_COLUMN } from '../src/sheets/readers/portfolio.ts';
import { parseWatchlistRows } from '../src/sheets/readers/watchlist.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';

/** Mirrors the real sheet: two tables, notes above, a blank spacer between. */
function realisticSheet(): SheetRow[] {
  return [
    ['My portfolio', '', '', '', ''],
    ['', '', '', '', ''],
    ['Ticker', 'type', 'amount', 'cost avg per stock', PURCHASE_DATE_COLUMN],
    ['TSLA', 'stock', 100, '$250.00', '2025-03-14'],
    ['', '', '', '', ''],                                  // blank spacer
    ['GBTC', 'stock', 50, '$92.10', '2025-06-01'],         // must survive the spacer
    ['DOGE', 'crypto', 1000, '$0.12', ''],
    ['', 'stock-TBD', '', '', ''],                         // blank ticker, real hint
    ['TOTAL', '', '', '', ''],
    ['NVDA', 'stock', 20, '$1,234.56', ''],
    ['', '', '', '', ''],
    ['Ticker', 'positions', 'strike', 'last trade Date', 'PUT/CALL', 'avg price - Premium paid'],
    ['AMD', 2, 150, '2027-01-15', 'call', '$12.50'],
    ['', '', '', '', '', ''],                              // blank spacer in options
    ['MQZC', 1, 90, '2026-12-18', 'put', '$3.20'],           // must survive it
  ];
}

test('both tables are found on one sheet, by header scan', () => {
  const r = parsePortfolio(realisticSheet());
  assert.equal(r.stocks.length, 3, 'TSLA, GBTC, NVDA');
  assert.equal(r.options.length, 2, 'AMD, MQZC');
});

test('a blank row does NOT truncate either table', () => {
  // The legacy bug: `if (!ticker) break;` at fullStockAnalysisV10_9.gs:10363
  // and myOptionsValueTracker.gs:155 stopped at the first spacer.
  const r = parsePortfolio(realisticSheet());
  assert.ok(r.stocks.some((s) => s.ticker === 'GBTC'), 'stock row after a spacer must be kept');
  assert.ok(r.options.some((o) => o.ticker === 'MQZC'), 'option row after a spacer must be kept');
});

test('crypto is skipped by the type column, not by ticker name', () => {
  const r = parsePortfolio(realisticSheet());
  assert.deepEqual(r.skippedCrypto, ['DOGE']);
  // GBTC is a spot Bitcoin ETF -- an ordinary security typed `stock`, so it
  // gets full analysis. Skipping must never key off what a name looks like.
  assert.ok(r.stocks.some((s) => s.ticker === 'GBTC'));
});

test('all five spot Bitcoin ETFs are analysed when typed stock', () => {
  const rows: SheetRow[] = [
    ['Ticker', 'type', 'amount', 'cost avg per stock'],
    ['GBTC', 'stock', 10, 90],
    ['BTC', 'stock', 10, 40],
    ['FBTC', 'stock', 10, 80],
    ['BITB', 'stock', 10, 50],
    ['IBIT', 'stock', 10, 60],
  ];
  const r = parsePortfolio(rows);
  assert.equal(r.stocks.length, 5);
  assert.equal(r.skippedCrypto.length, 0);
});

test('TOTAL and blank-with-hint rows are disclosed by name, not dropped silently', () => {
  const r = parsePortfolio(realisticSheet());
  assert.ok(r.skippedOther.some((s) => s.reason.includes('TOTAL')));
  assert.ok(r.skippedOther.some((s) => s.reason.includes('stock-TBD')));
  assert.ok(r.blankRowCount >= 2, 'genuinely empty rows are counted, not itemised');
});

test('numbers and dates are coerced from their real formats', () => {
  const r = parsePortfolio(realisticSheet());
  const tsla = r.stocks.find((s) => s.ticker === 'TSLA');
  assert.equal(tsla?.avgCost, 250);
  assert.equal(tsla?.entryDate?.toISOString().slice(0, 10), '2025-03-14');

  const nvda = r.stocks.find((s) => s.ticker === 'NVDA');
  assert.equal(nvda?.avgCost, 1234.56, 'thousands separator and $ handled');
  // Row 36 (owner 2026-10-31): a missing stock entry date is the ASSUMED 2020-01-01, always marked as assumed.
  assert.equal(nvda?.entryDate?.toISOString().slice(0, 10), '2020-01-01');
  assert.equal(nvda?.entryDateAssumed, true, 'the assumed date is flagged, never passed off as real');
  assert.equal(tsla?.entryDateAssumed, undefined);
});

test('option side defaults to call unless the cell says put', () => {
  const r = parsePortfolio(realisticSheet());
  assert.equal(r.options.find((o) => o.ticker === 'AMD')?.side, 'call');
  assert.equal(r.options.find((o) => o.ticker === 'MQZC')?.side, 'put');
});

test('column ORDER does not matter', () => {
  const rows: SheetRow[] = [
    ['cost avg per stock', PURCHASE_DATE_COLUMN, 'Ticker', 'amount', 'type'],
    [100, '2025-01-01', 'AAPL', 5, 'stock'],
  ];
  const r = parsePortfolio(rows);
  assert.equal(r.stocks[0]?.ticker, 'AAPL');
  assert.equal(r.stocks[0]?.avgCost, 100);
});

test('an empty sheet yields empty results rather than throwing', () => {
  const r = parsePortfolio([]);
  assert.deepEqual(r.stocks, []);
  assert.deepEqual(r.options, []);
});

test('watchlist parsing skips the header, uppercases and dedupes', () => {
  const rows: SheetRow[] = [['Ticker'], ['sqzb'], ['PLTR'], [''], ['  aqzb '], ['PLTR'], ['MQZB'], ['MQZC']];
  assert.deepEqual(parseWatchlistRows(rows), ['SQZB', 'PLTR', 'AQZB', 'MQZB', 'MQZC']);
});
