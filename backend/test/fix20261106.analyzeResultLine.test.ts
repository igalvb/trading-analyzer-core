/** Fix 2026-11-06: an Analyze run logs its levels (entry zone, stop, R:R), not only the PDF. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultFields } from '../src/analyzeReport.ts';

test('the result line carries verdict, conviction, price, entry zone, stop and R:R', () => {
  const job = { ticker: 'MQZC', art: { chart: { currentPrice: 706.6 }, result: { decision: { action: 'SET A BUY LIMIT', finalConviction: 39, timing: 'WAIT_PULLBACK' }, techPlan: { entryLow: 650.123, entryHigh: 660, stop: 600.5, rrToT1: 2.345 } } } } as never;
  const f = resultFields(job);
  assert.equal(f.conviction, '39/100');
  assert.deepEqual([f.entryLow, f.entryHigh, f.stop, f.rrToT1], [650.12, 660, 600.5, 2.35]);
});

test('missing levels are null, never invented', () => {
  const f = resultFields({ ticker: 'X', art: { result: {} } } as never);
  assert.deepEqual([f.entryLow, f.entryHigh, f.stop, f.rrToT1], [null, null, null, null]);
});
