/**
 * Differential verification of the four additive stop-loss methods.
 *
 * Real fixtures alone leave two holes, so this file fills both with charts
 * built to order and then checks the synthetic cases against the oracle too
 * -- a synthetic case that is not also oracle-verified proves nothing about
 * parity:
 *
 *  1. No fixture trades under $5, so the stop table's last row (15% for a
 *     speculative sub-$5 stock) was never reached. Covered by synthesising
 *     one swing low per price tier.
 *  2. The classical stop's round-number nudge fires only when the computed
 *     level lands within 10% of a step of a round figure, which no fixture
 *     happened to do. Covered, and asserted by measuring the final distance
 *     rather than by trusting that it ran.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Chart } from '../src/types/chart.ts';
import type { Indicators } from '../src/types/indicators.ts';
import {
  computeClassicalStop, computeBasingPointStop, computeAlternateBasingPoint,
  computeSidewaysBasingPoint, swingPoints, type StopDirection,
} from '../src/analysis/techPlan/stops.ts';

const ready = legacyFilesPresent() && fixturesPresent();

const METHODS = [
  ['computeClassicalStopV1_', computeClassicalStop, 'classical'],
  ['computeBasingPointStopV1_', computeBasingPointStop, 'basingPoint'],
  ['computeAlternateBasingPointV1_', computeAlternateBasingPoint, 'alternate'],
  ['computeSidewaysBasingPointV1_', computeSidewaysBasingPoint, 'sideways'],
] as const;

/** 19 is deliberately below the 20-bar floor every method enforces. */
const LENGTHS = [19, 20, 25, 60, 201, 250, 400];
const DIRECTIONS: StopDirection[] = ['long', 'short'];

describe('additive stops — parity on real fixtures', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('all four methods match the oracle, both directions, every length', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    const fired: Record<string, number> = { classical: 0, basingPoint: 0, alternate: 0, sideways: 0 };
    const returnedNull: Record<string, number> = { classical: 0, basingPoint: 0, alternate: 0, sideways: 0 };
    const tiers = new Set<string>();
    const stopPcts = new Set<number>();

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [...LENGTHS, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const rawInd = oracle.call('computeAllIndicators', chart);
        const ind = oracle.callNormalized<Indicators>('computeAllIndicators', chart);
        for (const dir of DIRECTIONS) {
          for (const [name, fn, key] of METHODS) {
            const expected = oracle.callNormalized(name, chart, rawInd, dir);
            const got = fn(chart, ind, dir);
            assert.deepStrictEqual(got, expected, `${ticker}@${len} ${dir} ${name}`);
            comparisons++;
            if (dir === 'long') {
              if (got === null) returnedNull[key]++;
              else fired[key]++;
            }
            const t = got as { sensitivityTier?: string; stopPct?: number } | null;
            if (t?.sensitivityTier) {
              tiers.add(t.sensitivityTier);
              if (t.stopPct != null) stopPcts.add(t.stopPct);
            }
          }
        }
      }
    }

    assert.ok(comparisons > 1500, `only ${comparisons} comparisons`);
    // Every method must have produced BOTH a real stop and a null on real
    // data, or the test only proved one branch.
    for (const key of Object.keys(fired)) {
      assert.ok(fired[key] > 0, `${key} never produced a stop`);
      assert.ok(returnedNull[key] > 0, `${key} never returned null`);
    }
    assert.deepStrictEqual([...tiers].sort(), ['conservative', 'median', 'speculative']);
    assert.ok(stopPcts.size >= 6, `only ${stopPcts.size} distinct stop percentages`);
  });

  test('the sideways path is rare but real, and never overlaps the alternate path', () => {
    // The two Ch28 secondary paths are complements by construction:
    // alternate needs >=40% retracement, sideways needs <40%. Both firing
    // on the same bar would mean one of the thresholds was ported wrong.
    const oracle = loadOracle();
    let sidewaysFired = 0;
    let bothFired = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 60) continue;
      for (const len of [60, 201, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const ind = oracle.callNormalized<Indicators>('computeAllIndicators', chart);
        const alt = computeAlternateBasingPoint(chart, ind, 'long');
        const side = computeSidewaysBasingPoint(chart, ind, 'long');
        if (side) sidewaysFired++;
        if (alt && side && alt.basingPointDate.getTime() === side.basingPointDate.getTime()) bothFired++;
      }
    }
    assert.ok(sidewaysFired > 0, 'the sideways path never fired on any fixture');
    assert.equal(bothFired, 0, 'the two complementary paths selected the same bar');
  });
});

describe('additive stops — synthetic coverage', { skip: ready ? false : 'legacy/ not populated' }, () => {
  /**
   * A V-shaped series with its single lowest low at bar 20, then a steady
   * rise. The rise is what satisfies Three Days Away, so basingPoint fires
   * -- verified by the assertions below, not assumed.
   */
  function vShape(lowPrice: number, bars = 60): Chart {
    const closes: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const opens: number[] = [];
    const volumes: number[] = [];
    const dates: Date[] = [];
    for (let i = 0; i < bars; i++) {
      const base = i <= 20 ? lowPrice * (1 + (20 - i) * 0.02) : lowPrice * (1 + (i - 20) * 0.03);
      closes.push(base);
      opens.push(base);
      highs.push(base * 1.005);
      lows.push(i === 20 ? lowPrice : base * 0.995);
      volumes.push(1_000_000);
      dates.push(new Date(Date.UTC(2024, 0, 1 + i)));
    }
    return {
      ticker: 'SYN', closes, highs, lows, opens, volumes, dates, splits: [], ipoDate: null,
      currentPrice: closes[bars - 1], prevClose: closes[bars - 2], currency: 'USD',
    };
  }

  test('every row of the stop-distance table is reached, and matches the oracle', () => {
    const oracle = loadOracle();
    const stopPcts = new Set<number>();
    const tiers = new Set<string>();
    let comparisons = 0;
    // One price per table row, one atrRatio per sensitivity tier.
    for (const price of [3, 7, 15, 30, 60, 150]) {
      for (const atrRatio of [0.5, 1.0, 1.5]) {
        const chart = vShape(price);
        const ind = { atrRatio } as unknown as Indicators;
        for (const dir of DIRECTIONS) {
          for (const [name, fn] of [METHODS[0], METHODS[1]] as const) {
            const expected = oracle.callNormalized(name, chart, ind, dir);
            assert.deepStrictEqual(fn(chart, ind, dir), expected, `$${price} atr=${atrRatio} ${dir} ${name}`);
            comparisons++;
            const t = expected as { stopPct?: number; sensitivityTier?: string } | null;
            if (t?.stopPct != null) {
              stopPcts.add(t.stopPct);
              tiers.add(String(t.sensitivityTier));
            }
          }
        }
      }
    }
    assert.ok(comparisons >= 72, `only ${comparisons} comparisons`);
    // All seven distinct values in the 6x3 table, including the 15% floor
    // for a speculative sub-$5 stock that no real fixture can reach.
    assert.deepStrictEqual(
      [...stopPcts].sort((a, b) => a - b),
      [0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 0.15],
    );
    assert.deepStrictEqual([...tiers].sort(), ['conservative', 'median', 'speculative']);
  });

  test('the round-number nudge pushes the level exactly off the round figure', () => {
    const oracle = loadOracle();
    let nudged = 0;
    for (const price of [3, 7, 15, 30, 60, 150]) {
      for (const atrRatio of [0.5, 1.0, 1.5]) {
        const chart = vShape(price);
        const ind = { atrRatio } as unknown as Indicators;
        const got = computeClassicalStop(chart, ind, 'long');
        assert.deepStrictEqual(got, oracle.callNormalized('computeClassicalStopV1_', chart, ind, 'long'));
        if (!got) continue;
        const step = got.level >= 50 ? 5 : got.level >= 10 ? 1 : 0.5;
        const distance = Math.abs(got.level - Math.round(got.level / step) * step);
        // A nudged level sits at EXACTLY the margin, never inside it.
        if (Math.abs(distance - step * 0.1) < 1e-9) nudged++;
        assert.ok(distance >= step * 0.1 - 1e-9,
          `level ${got.level} is inside the round-number margin`);
      }
    }
    assert.ok(nudged > 0, 'the round-number nudge never fired');
  });

  test('degenerate charts return null on both sides, exactly as the oracle does', () => {
    const oracle = loadOracle();
    const base = vShape(10);
    const cases: Array<[string, unknown]> = [
      ['empty', { ...base, closes: [], highs: [], lows: [], volumes: [], dates: [] }],
      ['19 bars (below the 20 floor)', vShape(10, 19)],
      ['no volumes', { ...base, volumes: null }],
    ];
    for (const [label, chart] of cases) {
      for (const [name, fn] of METHODS) {
        const expected = oracle.callNormalized(name, chart, { atrRatio: 1 }, 'long');
        assert.deepStrictEqual(
          fn(chart as Chart, { atrRatio: 1 } as unknown as Indicators, 'long'),
          expected, `${label} ${name}`,
        );
      }
    }
    // TWO SEPARATE REASONS FOR NULL, measured rather than assumed. The
    // first attempt at this assertion conflated them and failed: a 25-bar
    // V-shape returns null NOT because of the 20-bar floor but because the
    // scan range is `i < n - 5`, so the low at index 20 is out of range
    // until n >= 26. Both thresholds are pinned here.
    assert.equal(computeClassicalStop(vShape(10, 19), null, 'long'), null, 'below the 20-bar floor');
    assert.equal(computeClassicalStop(vShape(10, 25), null, 'long'), null, 'low at idx 20 not yet in scan range');
    assert.ok(computeClassicalStop(vShape(10, 26), null, 'long') !== null, 'n=26 is where idx 20 becomes scannable');
    assert.equal(swingPoints(vShape(10, 25), 5).lows.length, 0);
    assert.equal(swingPoints(vShape(10, 26), 5).lows.length, 1);
  });

  test('swing detection is non-strict, so a plateau yields many points', () => {
    // Reproducing legacy exactly (`===`, not `>`). A flat series makes every
    // interior bar both a swing high AND a swing low. Asserted so that
    // "fixing" it to strict comparison fails here instead of silently
    // changing which bar becomes the basing point.
    const flat = vShape(10, 40);
    const level = flat.closes[0];
    const plateau: Chart = {
      ...flat,
      closes: flat.closes.map(() => level),
      highs: flat.highs.map(() => level),
      lows: flat.lows.map(() => level),
    };
    const { highs, lows } = swingPoints(plateau, 5);
    assert.equal(highs.length, 30, 'every interior bar should qualify as a swing high');
    assert.equal(lows.length, 30, 'every interior bar should qualify as a swing low');
  });
});
