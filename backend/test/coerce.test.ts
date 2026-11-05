import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumber, toDate, toBoolean, toStringOrNull, toUpperTicker,
  findHeaderRow, cell, toIsoDateString, SHEETS_EPOCH_OFFSET_DAYS,
} from '../src/sheets/coerce.ts';
import { formatDateInTz } from '../src/core/dates.ts';

test('toNumber handles the real spreadsheet formats', () => {
  assert.equal(toNumber(123.45), 123.45);
  assert.equal(toNumber('123.45'), 123.45);
  assert.equal(toNumber('$1,234.56'), 1234.56);
  assert.equal(toNumber('(1,234.56)'), -1234.56, 'accounting negatives');
  assert.equal(toNumber('12%'), 0.12);
  assert.equal(toNumber('  42  '), 42);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('n/a'), null);
  assert.equal(toNumber('-'), null);
});

test('toNumber preserves 0 rather than treating it as absent', () => {
  // Matters: 0 is a meaningful score in this system, and `if (x)` would drop it.
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber('0'), 0);
});

test('Sheets serial-date epoch is correct', () => {
  // The load-bearing constant, verified rather than trusted:
  // serial 25569 must be exactly 1970-01-01.
  const epoch = toDate(SHEETS_EPOCH_OFFSET_DAYS);
  assert.ok(epoch);
  assert.equal(toIsoDateString(epoch), '1970-01-01');
});

test('toDate handles serial numbers, ISO strings and US-formatted strings', () => {
  const iso = toDate('2026-09-13');
  assert.ok(iso);
  assert.equal(toIsoDateString(iso), '2026-09-13');

  const us = toDate('09/15/2026');
  assert.ok(us);
  assert.equal(toIsoDateString(us), '2026-09-15');

  const serial = toDate(46000);
  assert.ok(serial);
  assert.equal(typeof serial.getTime(), 'number');

  assert.equal(toDate(''), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate('not a date'), null);
});

test('a Sheets serial number is NOT a Date instance', () => {
  // This is the exact hazard coerce.ts exists for. The legacy guard
  // `r[0] instanceof Date` is never true against the Sheets API, so a
  // literal port would silently skip every row.
  const raw: unknown = 46000;
  assert.ok(!(raw instanceof Date), 'raw cell is a number, not a Date');
  assert.ok(toDate(raw as number) instanceof Date, 'but coercion produces one');
});

test('toBoolean and string helpers', () => {
  assert.equal(toBoolean(true), true);
  assert.equal(toBoolean('TRUE'), true);
  assert.equal(toBoolean('no'), false);
  assert.equal(toBoolean('maybe'), null);
  assert.equal(toStringOrNull('  '), null);
  assert.equal(toUpperTicker('  aapl '), 'AAPL');
});

test('findHeaderRow scans for the header and is order-independent', () => {
  const rows = [
    ['some note', ''],
    ['', ''],
    ['cost avg per stock', 'Ticker', 'type'],
    ['100', 'AAPL', 'stock'],
  ];
  const h = findHeaderRow(rows, ['Ticker', 'cost avg per stock']);
  assert.ok(h);
  assert.equal(h.rowIndex, 2);
  assert.equal(h.columns['Ticker'], 1);
  assert.equal(h.columns['cost avg per stock'], 0);
  assert.equal(cell(rows[3], h.columns, 'Ticker'), 'AAPL');
});

test('findHeaderRow returns null when required columns are absent', () => {
  assert.equal(findHeaderRow([['a', 'b']], ['Ticker', 'cost avg per stock']), null);
});

test('formatDateInTz uses the market timezone, not the runner locale', () => {
  // 02:30 UTC on the 14th is still the 13th in New York. A UTC-based
  // formatter would silently report the wrong trading day.
  const d = new Date('2026-09-14T02:30:00Z');
  assert.equal(formatDateInTz(d, 'America/New_York'), '2026-09-13');
  assert.equal(toIsoDateString(d), '2026-09-14');
});
