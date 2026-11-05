/**
 * FL-17c: the two yardsticks on every simulation table (owner 2026-10-28): holding QQQ and holding the owner's list
 * equally, after the 25% tax, with the deepest fall on the way.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarksFor, benchRows } from '../src/research/benchmarks.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const ser = (t: string, dates: string[], px: number[]): PriceSeries => ({ ticker: t, dates, opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1), splits: [] });

describe('FL-17c — benchmarks', () => {
  test('QQQ and the list: final value after tax and the deepest fall, per period; the two table rows', () => {
    const dates = ['2010-01-04', '2010-01-05', '2010-01-06', '2020-01-02', '2020-01-03', '2024-01-02', '2024-01-03'];
    const qqq = ser('QQQ', dates, [100, 50, 200, 100, 100, 100, 100]);
    const a = ser('AAA', dates, [10, 10, 30, 10, 10, 10, 10]), b = ser('BBB', dates, [10, 5, 10, 10, 10, 10, 10]);
    const bm = benchmarksFor(['AAA', 'BBB'], { series: new Map([['AAA', a], ['BBB', b]]), reads: new Map(), qqq }, 100_000);
    assert.equal(bm.qqq[0]!.finalTaxed, 100_000 + 100_000 * 0.75, 'doubled, a quarter of the gain taxed');
    assert.equal(bm.qqq[0]!.maxDrawdownPct, 50);
    assert.equal(bm.list[0]!.finalTaxed, 50_000 + 50_000 + 100_000 * 0.75, 'AAA tripled, BBB flat');
    assert.equal(bm.list[0]!.maxDrawdownPct, 25, 'BBB halved while AAA was flat');
    const rows = benchRows(bm, 100_000, 2, ['', 'fall']);
    assert.deepEqual(rows, ['| **Hold QQQ** | — | +75% | +0% | +0% | — | -50% |', '| **Hold your list equally** | — | +75% | +0% | +0% | — | -25% |',
      '| **Hold your list equally (join when listed)** | — | +75% | +0% | +0% | — | -25% |']);
  });
});
