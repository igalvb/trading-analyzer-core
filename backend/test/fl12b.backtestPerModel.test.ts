/**
 * FL-12b: the per-model simulation (owner request 2026-10-27): a book model trades one stock on its own read.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { followModel } from '../src/backtest/perModel.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import type { EngineRead } from '../src/backtest/engineRun.ts';

const s = { ticker: 'AAA', dates: ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'], opens: [10, 10, 12, 15, 15], closes: [10, 11, 14, 15, 16], highs: [], lows: [], volumes: [] } as unknown as PriceSeries;
const reads: Record<string, string> = { '2024-01-02': 'bullish', '2024-01-03': 'mixed', '2024-01-04': 'cautionary', '2024-01-05': 'mixed', '2024-01-08': 'mixed' };
const read = async (d: string) => ({ directions: { turtle: reads[d] } } as unknown as EngineRead);

describe('FL-12b — per-model simulation', () => {
  test('bullish -> buy at the next open with all the cash; cautionary -> sell at the next open; 25% tax on the gain', async () => {
    const r = await followModel(s, read, 'turtle', '2024-01-01', '2024-12-31', 1000);
    // bought 100 sh at 10 on 01-03, sold at 15 on 01-05: gain 500, tax 125 -> 1375
    assert.equal(r.finalTaxed, 1375);
    assert.equal(r.buys, 1);
  });

  test('a model that never reads bullish never buys', async () => {
    const r = await followModel(s, read, 'broker', '2024-01-01', '2024-12-31', 1000);
    assert.deepEqual([r.finalTaxed, r.buys, r.investedPct], [1000, 0, 0]);
  });
});
