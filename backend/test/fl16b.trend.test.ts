/** FL-16b: the Trend model (150-day average). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trendSeries } from '../src/analysis/models/trendFollow.ts';

describe('FL-16b — Trend model', () => {
  test('rising above the average is bullish; 3% under it is cautionary; inside the band is mixed', () => {
    const up = Array.from({ length: 200 }, (_, i) => 100 + i);          // steady rise
    assert.equal(trendSeries(up).at(-1)!.direction, 'bullish');
    const r = trendSeries([...up, ...Array.from({ length: 40 }, (_, i) => 299 - i * 4)]);
    assert.equal(r.at(-1)!.direction, 'cautionary');
    assert.equal(trendSeries(up.slice(0, 149)).at(-1)!.direction, 'mixed', 'not enough history');
  });
  test('causal: adding later days never changes an earlier day', () => {
    const xs = Array.from({ length: 400 }, (_, i) => 100 + 20 * Math.sin(i / 30) + i * 0.1);
    assert.deepEqual(trendSeries(xs.slice(0, 250)), trendSeries(xs).slice(0, 250));
  });
});
