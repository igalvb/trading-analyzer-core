/** FL-15a: strategy research price download (Yahoo chart -> the historical_data shape). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOne } from '../src/research/fetchPrices.ts';

describe('FL-15a — research prices', () => {
  test('bars with a missing close are dropped; dates are exchange-local; splits kept', async () => {
    const body = { chart: { result: [{ meta: { exchangeTimezoneName: 'America/New_York' }, timestamp: [1704205800, 1704292200, 1704378600],
      indicators: { quote: [{ open: [10, null, 12], high: [11, null, 13], low: [9, null, 11], close: [10.5, null, 12.5], volume: [100, 0, 300] }] },
      events: { splits: { a: { date: 1704292200, numerator: 2, denominator: 1 } } } }] } };
    const f = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const s = await fetchOne('ABC', f, Date.UTC(2026, 9, 28));
    assert.deepEqual(s!.dates, ['2024-01-02', '2024-01-04']);
    assert.deepEqual(s!.closes, [10.5, 12.5]);
    assert.deepEqual(s!.splits, [{ date: 1704292200, numerator: 2, denominator: 1 }]);
  });
  test('an HTTP error gives null', async () => {
    assert.equal(await fetchOne('X', (async () => new Response('', { status: 404 })) as unknown as typeof fetch, 0), null);
  });
});
