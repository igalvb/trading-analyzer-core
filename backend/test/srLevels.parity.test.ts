import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  computeSrFamilySlice, srLevels, resampleHighLow, srMultiTimeframeConfluence,
  type SrInput,
} from '../src/analysis/indicators/srLevels.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 100, 201, 250, 400];

function srCases(): Array<{ ticker: string; chart: SrInput; len: number }> {
  const out: Array<{ ticker: string; chart: SrInput; len: number }> = [];
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    if (!Array.isArray(raw.closes) || !Array.isArray(raw.highs) || raw.closes.length < 250) continue;
    for (const len of [...LENGTHS, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      out.push({ ticker, chart: buildChart(raw, len), len });
    }
  }
  return out;
}

describe('S/R family — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('all three fields match the oracle exactly', () => {
    const oracle = loadOracle();
    let levels = 0;
    for (const { ticker, chart, len } of srCases()) {
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const got = computeSrFamilySlice(chart);
      assert.deepStrictEqual(got.monthlyStructure, all['monthlyStructure'], `${ticker}@${len} monthlyStructure`);
      assert.deepStrictEqual(got.srLevels, all['srLevels'], `${ticker}@${len} srLevels`);
      assert.deepStrictEqual(got.srMultiTimeframe, all['srMultiTimeframe'], `${ticker}@${len} srMultiTimeframe`);
      levels += got.srLevels.resistanceLevels.length + got.srLevels.supportLevels.length;
    }
    assert.ok(levels > 1000, `only ${levels} individual levels compared`);
  });

  test('every tier and every confluence strength is exercised', () => {
    const tiers = new Set<string>();
    const strengths = new Set<string>();
    const monthlyTrends = new Set<string>();

    for (const { chart } of srCases()) {
      const got = computeSrFamilySlice(chart);
      for (const l of [...got.srLevels.resistanceLevels, ...got.srLevels.supportLevels]) tiers.add(l.tier);
      for (const side of [got.srMultiTimeframe.resistance, got.srMultiTimeframe.support]) {
        if (side) strengths.add(side.strength);
      }
      if (got.monthlyStructure) monthlyTrends.add(got.monthlyStructure.monthlyTrend);
    }

    for (const t of ['Minor', 'Secondary', 'Primary']) {
      assert.ok(tiers.has(t), `tier ${t} never observed — that branch is unverified`);
    }
    for (const s of ['DAILY_ONLY', 'DAILY+WEEKLY', 'DAILY+WEEKLY+MONTHLY']) {
      assert.ok(strengths.has(s), `confluence strength ${s} never observed`);
    }
    assert.ok(monthlyTrends.has('above') && monthlyTrends.has('below'));
  });

  test('Primary requires BOTH touch count and duration; Secondary requires EITHER', () => {
    // A level with many touches in a short span is Secondary, not Primary --
    // frequency alone does not establish a major level without duration.
    for (const { chart } of srCases()) {
      const got = computeSrFamilySlice(chart);
      for (const l of [...got.srLevels.resistanceLevels, ...got.srLevels.supportLevels]) {
        if (l.tier === 'Primary') {
          assert.ok(l.touchCount >= 4 && l.duration >= 60, 'Primary needs both conditions');
        } else if (l.tier === 'Secondary') {
          assert.ok(l.touchCount >= 3 || l.duration >= 30, 'Secondary needs at least one');
          assert.ok(!(l.touchCount >= 4 && l.duration >= 60), 'would have been Primary');
        } else {
          assert.equal(l.tier, 'Minor');
          assert.ok(l.touchCount === 2 && l.duration < 30);
        }
      }
    }
  });

  test('a single touch is never a level', () => {
    for (const { chart } of srCases()) {
      const got = computeSrFamilySlice(chart);
      for (const l of [...got.srLevels.resistanceLevels, ...got.srLevels.supportLevels]) {
        assert.ok(l.touchCount >= 2);
      }
    }
  });

  test('levels are sorted by touch count, descending', () => {
    // The confluence function relies on this: it classifies only [0].
    for (const { chart } of srCases()) {
      const got = computeSrFamilySlice(chart);
      for (const side of [got.srLevels.resistanceLevels, got.srLevels.supportLevels]) {
        for (let i = 1; i < side.length; i++) {
          assert.ok((side[i]?.touchCount as number) <= (side[i - 1]?.touchCount as number));
        }
      }
    }
  });

  test('the optional parameters change output SHAPE, not just values', () => {
    // Load-bearing for parity: the confluence function calls srLevels with two
    // arguments, producing the sparser shape.
    const chart = srCases()[0]?.chart;
    assert.ok(chart);

    const full = srLevels(chart.highs, chart.lows, 'up', chart.volumes);
    const sparse = srLevels(chart.highs, chart.lows);

    const fullLevel = full.supportLevels[0];
    const sparseLevel = sparse.supportLevels[0];
    if (fullLevel && sparseLevel) {
      assert.equal(typeof fullLevel.volumeWeightedStrength, 'number');
      assert.ok(!('volumeWeightedStrength' in sparseLevel), 'key must be ABSENT, not undefined-valued');
      assert.equal(typeof fullLevel.trendFavored, 'boolean');
      assert.equal(sparseLevel.trendFavored, null, 'null means "not evaluated", not false');
    }
  });

  test('trendFavored is direction-aware: support favoured up, resistance favoured down', () => {
    const chart = srCases()[0]?.chart;
    assert.ok(chart);
    const up = srLevels(chart.highs, chart.lows, 'up');
    for (const l of up.supportLevels) assert.equal(l.trendFavored, true);
    for (const l of up.resistanceLevels) assert.equal(l.trendFavored, false);

    const down = srLevels(chart.highs, chart.lows, 'down');
    for (const l of down.supportLevels) assert.equal(l.trendFavored, false);
    for (const l of down.resistanceLevels) assert.equal(l.trendFavored, true);

    // 'flat' favours neither -- which is how an unavailable sma50 resolves.
    const flat = srLevels(chart.highs, chart.lows, 'flat');
    for (const l of [...flat.supportLevels, ...flat.resistanceLevels]) assert.equal(l.trendFavored, false);
  });

  test('resampling walks backward so the most recent group is complete', () => {
    // Forward grouping would leave a partial group at the END, contaminating
    // the most recent and most decision-relevant bar.
    const highs = [10, 11, 12, 13, 14, 15, 16]; // 7 bars, groups of 5
    const lows = highs.map((h) => h - 1);
    const r = resampleHighLow(highs, lows, 5);
    assert.equal(r.highs.length, 2);
    assert.equal(r.highs[1], 16, 'last group must cover the final 5 bars');
    assert.equal(r.highs[0], 11, 'the PARTIAL group lands first');
    assert.equal(r.lows[0], 9);
  });

  test('confluence strength is monotonic, and null when a side has no levels', () => {
    for (const { chart } of srCases()) {
      const mtf = computeSrFamilySlice(chart).srMultiTimeframe;
      for (const side of [mtf.resistance, mtf.support]) {
        if (!side) continue;
        if (side.strength === 'DAILY+WEEKLY+MONTHLY') assert.equal(side.onMonthly, true);
        if (side.strength === 'DAILY_ONLY') assert.equal(side.onWeekly, false);
      }
    }
    // Too short for the swing window (SR_WINDOW=5) to ever fire -- the
    // detection loop `for (i=5; i<n-5; i++)` never executes below 11 bars, so
    // there are zero swing points and therefore no levels.
    //
    // NOTE: a flat series does NOT work for this -- swing detection uses
    // non-strict comparisons (documented elsewhere as deliberate: "a tied
    // plateau must still register as a swing"), so on a flat series every
    // interior bar ties for both the window max and min and registers as
    // BOTH a swing high and low, producing a real (degenerate) level.
    const short = { highs: Array(8).fill(100), lows: Array(8).fill(99) };
    const mtf = srMultiTimeframeConfluence(short.highs, short.lows);
    assert.equal(mtf.resistance, null);
    assert.equal(mtf.support, null);
  });

  test('monthlyStructure buckets by CALENDAR month, not trading days', () => {
    // Genuine UTC calendar bucketing, unlike resampleHighLow's 21-trading-day
    // approximation. Both conventions coexist in this module deliberately.
    for (const { chart } of srCases()) {
      const got = computeSrFamilySlice(chart).monthlyStructure;
      if (!got) continue;
      const distinctMonths = new Set(
        chart.dates.map((d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`),
      ).size;
      assert.equal(got.monthsAvailable, distinctMonths, 'month count must match distinct calendar months');
      assert.ok(got.monthsAvailable >= 10, 'the 10-month rule needs 10 months');
    }
  });

  test('monthlyStructure is null below ten calendar months', () => {
    const shortChart: SrInput = {
      closes: Array.from({ length: 60 }, (_, i) => 100 + i),
      highs: Array.from({ length: 60 }, (_, i) => 101 + i),
      lows: Array.from({ length: 60 }, (_, i) => 99 + i),
      volumes: Array(60).fill(1000),
      dates: Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i))),
    };
    // 60 consecutive days spans only 2-3 calendar months.
    assert.equal(computeSrFamilySlice(shortChart).monthlyStructure, null);
  });
});
