import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestByKey, isFresh, colLetter, BROKER_DATA_HISTORY } from '../src/sheets/writers/appendHistory.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';

const rows = (): SheetRow[] => [
  ['Ticker', 'FetchedAt', 'ShortInterest', 'DaysToCover', 'SettlementDate', 'InterestCoverageRatio'],
  ['AAPL', '2026-09-01T00:00:00Z', 100, 1.1, '2026-08-31', 5],
  ['MSFT', '2026-09-02T00:00:00Z', 200, 2.2, '2026-08-31', 6],
  ['AAPL', '2026-09-10T00:00:00Z', 150, 1.5, '2026-09-09', 7], // newer AAPL
];

test('latestByKey returns the NEWEST row, not the first', () => {
  // The semantic change from the legacy readers, which found the first match
  // (dataLayerV1.gs:915, :952). With history present, "first" is the OLDEST
  // -- so a literal port would silently read stale data forever.
  const latest = latestByKey(rows(), BROKER_DATA_HISTORY);
  assert.equal(latest.get('AAPL')?.[2], 150);
  assert.equal(latest.get('MSFT')?.[2], 200);
  assert.equal(latest.size, 2);
});

test('rows without a usable timestamp lose to rows that have one', () => {
  const r: SheetRow[] = [
    ['Ticker', 'FetchedAt'],
    ['AAPL', '', 1],
    ['AAPL', '2026-09-10T00:00:00Z', 2],
  ];
  assert.equal(latestByKey(r, BROKER_DATA_HISTORY).get('AAPL')?.[2], 2);
});

test('keys are matched case-insensitively', () => {
  const r: SheetRow[] = [['Ticker', 'FetchedAt'], ['aapl', '2026-09-10T00:00:00Z', 9]];
  assert.equal(latestByKey(r, BROKER_DATA_HISTORY).get('AAPL')?.[2], 9);
});

test('stale records are reported as not fresh, never silently served', () => {
  const now = Date.parse('2026-09-13T00:00:00Z');
  const recent: SheetRow = ['AAPL', '2026-09-12T00:00:00Z'];
  const old: SheetRow = ['AAPL', '2026-01-01T00:00:00Z'];
  assert.equal(isFresh(recent, BROKER_DATA_HISTORY, 7, now), true);
  assert.equal(isFresh(old, BROKER_DATA_HISTORY, 7, now), false);
  assert.equal(isFresh(undefined, BROKER_DATA_HISTORY, 7, now), false);
  assert.equal(isFresh(['AAPL', ''], BROKER_DATA_HISTORY, 7, now), false);
});

test('colLetter maps column numbers to A1 letters', () => {
  assert.equal(colLetter(1), 'A');
  assert.equal(colLetter(6), 'F');
  assert.equal(colLetter(26), 'Z');
  assert.equal(colLetter(27), 'AA');
});
