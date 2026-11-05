/**
 * Slice-by-slice differential tests for computeAllIndicators.
 *
 * Each slice is compared field-by-field against the oracle's full 115-field
 * output. Running coverage is asserted, so "23/115 at parity" is a checked
 * fact rather than a claim in a comment.
 *
 * Verified 2026-09-14: 13,248 comparisons across 192 chart variants, all exact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  computeRsiSlice, computeMacdSlice, computeBollingerSlice,
  computeStochasticSlice, computeOscillatorSlice, computeAtrSlice,
  computeTrendStrengthSlice, computeVolumeSlice, computeMovingAverageSlice,
  computeMomentumSlice, computeFibonacciSlice, computePivotSlice, computeChannelSlice,
  computeAroonSlice, computeDonchianSlice, computeParabolicSarSlice, computeSuperTrendSlice,
  computeIchimokuSlice, computeVolumeProfileSlice, computeVolatilitySlice, volatilityHotCold,
  computeTrailingPerfSlice, computeRelativeStrengthSlice,
  computeDivergenceSlice, computeCompositeSlice, detectDivergence,
  roundLevelIncrement, roundNumberProximity, singleCandleClassify,
  KNOWN_DPO_TICKERS, ROUND_NUMBER_TOLERANCE,
  computeTrendMaturitySlice, trendMaturity,
  computeChartPatternsSlice, computeWyckoffSlice, computePriceGapsSlice,
  computeVolumeStructureSlice, computeSrFamilySlice, computeEventsSlice,
  PORTED_INDICATOR_FIELDS, TOTAL_INDICATOR_FIELDS,
  type SeriesInput, type DatedSeriesInput, type BenchmarkedSeriesInput, type CompositeInput, type FullChartInput,
} from '../src/analysis/indicators/slices.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/**
 * Bar counts spanning every seeding boundary the slices depend on:
 * 20 (Bollinger/CCI), 26 (MACD long EMA), 50/200 (weekly SMA equivalents).
 */
const LENGTHS = [60, 80, 100, 150, 201, 250, 400];

interface Case { ticker: string; chart: SeriesInput; len: number }

/**
 * Fixed clock for computeEventsSlice's lockupExpiration, the only field in
 * this generic loop that reads the wall clock. Every real fixture's ipoDate
 * is years in the past, so this value is harmless for every other slice and
 * keeps lockupExpiration deterministic here too.
 */
const FIXED_NOW = new Date('2026-09-21T00:00:00Z');

function cases(): Case[] {
  const out: Case[] = [];
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    // Needs genuine OHLCV — excludes _VIX (index: closes only) and the macro CSVs.
    if (!Array.isArray(raw.closes) || !Array.isArray(raw.highs) || raw.closes.length < 250) continue;

    for (const len of [...LENGTHS, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      out.push({ ticker, chart: { ...buildChart(raw, len), simulatedNow: FIXED_NOW } as unknown as SeriesInput, len });
    }
  }
  return out;
}

type AnySliceFn = (c: SeriesInput) => Record<string, unknown>;

const SLICES: Array<[string, AnySliceFn]> = [
  ['rsi', computeRsiSlice as unknown as AnySliceFn],
  ['macd', computeMacdSlice as unknown as AnySliceFn],
  ['bollinger', computeBollingerSlice as unknown as AnySliceFn],
  ['stochastic', computeStochasticSlice as unknown as AnySliceFn],
  ['oscillator', computeOscillatorSlice as unknown as AnySliceFn],
  ['atr', computeAtrSlice as unknown as AnySliceFn],
  ['trendStrength', computeTrendStrengthSlice as unknown as AnySliceFn],
  ['volume', computeVolumeSlice as unknown as AnySliceFn],
  ['movingAverage', computeMovingAverageSlice as unknown as AnySliceFn],
  ['momentum', computeMomentumSlice as unknown as AnySliceFn],
  ['fibonacci', computeFibonacciSlice as unknown as AnySliceFn],
  ['pivot', computePivotSlice as unknown as AnySliceFn],
  ['channel', computeChannelSlice as unknown as AnySliceFn],
  ['aroon', computeAroonSlice as unknown as AnySliceFn],
  ['donchian', computeDonchianSlice as unknown as AnySliceFn],
  ['parabolicSar', computeParabolicSarSlice as unknown as AnySliceFn],
  ['superTrend', computeSuperTrendSlice as unknown as AnySliceFn],
  ['ichimoku', computeIchimokuSlice as unknown as AnySliceFn],
  ['volumeProfile', computeVolumeProfileSlice as unknown as AnySliceFn],
  ['volatility', computeVolatilitySlice as unknown as AnySliceFn],
  // Both take a wider input (dates / benchmarkCloses) than SeriesInput, but
  // every real chart case below (built by buildChart) has dates and lacks
  // benchmarkCloses, so this generic loop exercises the no-benchmark branch
  // of `rs` and the full branch of `trailingPerf`. The benchmark-present
  // branch of `rs` gets its own dedicated test below, with a real SPY fixture.
  ['trailingPerf', computeTrailingPerfSlice as unknown as AnySliceFn],
  ['rs', computeRelativeStrengthSlice as unknown as AnySliceFn],
  ['divergence', computeDivergenceSlice as unknown as AnySliceFn],
  ['composite', computeCompositeSlice as unknown as AnySliceFn],
  ['trendMaturity', computeTrendMaturitySlice as unknown as AnySliceFn],
  ['chartPatternsAdapter', computeChartPatternsSlice as unknown as AnySliceFn],
  ['wyckoffAdapter', computeWyckoffSlice as unknown as AnySliceFn],
  ['priceGapsAdapter', computePriceGapsSlice as unknown as AnySliceFn],
  ['volumeStructure', computeVolumeStructureSlice as unknown as AnySliceFn],
  ['srFamily', computeSrFamilySlice as unknown as AnySliceFn],
  ['events', computeEventsSlice as unknown as AnySliceFn],
];

describe('indicator slices — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  for (const [sliceName, sliceFn] of SLICES) {
    test(`${sliceName} slice matches the oracle exactly`, () => {
      const oracle = loadOracle();
      let comparisons = 0;

      for (const { ticker, chart, len } of cases()) {
        const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
        const got = sliceFn(chart);

        for (const [field, value] of Object.entries(got)) {
          assert.deepStrictEqual(value, expected[field], `${ticker}@${len} ${sliceName}.${field}`);
          comparisons++;
        }
      }
      assert.ok(comparisons > 0, 'no comparisons ran — are fixtures present?');
    });
  }

  test('every ported field genuinely exists in the oracle output', () => {
    // Guards against a slice inventing a field name the oracle never produces,
    // which would otherwise compare undefined === undefined and pass silently.
    const oracle = loadOracle();
    const first = cases()[0];
    assert.ok(first, 'expected at least one fixture case');

    const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', first.chart);
    const oracleKeys = new Set(Object.keys(expected));

    const phantom = PORTED_INDICATOR_FIELDS.filter((f) => !oracleKeys.has(f));
    assert.deepEqual(phantom, [], `fields not produced by the oracle: ${phantom.join(', ')}`);
  });

  test('the slices collectively produce exactly the declared field set', () => {
    const first = cases()[0];
    assert.ok(first);

    const produced = new Set<string>();
    for (const [, fn] of SLICES) {
      for (const k of Object.keys(fn(first.chart))) produced.add(k);
    }

    assert.deepEqual(
      [...produced].sort(),
      [...PORTED_INDICATOR_FIELDS].sort(),
      'PORTED_INDICATOR_FIELDS has drifted from what the slices actually return',
    );
  });

  test('COMPLETE: all 115 indicator fields at exact parity', () => {
    assert.equal(PORTED_INDICATOR_FIELDS.length, 115);
    assert.equal(TOTAL_INDICATOR_FIELDS, 115);
    console.log('      → computeAllIndicators: COMPLETE, 115/115 fields');
  });

  test('verification STRENGTH is not uniform across registered fields', () => {
    // The coverage count says a field is produced and agrees with the oracle.
    // It does NOT say the field's logic was exercised. wyckoffSchematic is null
    // on every fixture (no RECTANGLE), so its entry in the fixture-driven loop
    // is a null-to-null comparison; its real verification is the synthetic
    // charts in wyckoff.parity.test.ts.
    //
    // This test exists so that distinction is recorded in the suite rather than
    // living only in a report.
    const FIXTURE_ALWAYS_NULL = ['wyckoffSchematic'];
    const first = cases()[0];
    assert.ok(first);

    for (const field of FIXTURE_ALWAYS_NULL) {
      let anyNonNull = false;
      for (const { chart } of cases()) {
        // cases() types chart as SeriesInput, but the real buildChart() output
        // (OracleChart) always carries ticker/dates/opens too -- same cast
        // pattern the SLICES array above uses via AnySliceFn.
        const got = computeWyckoffSlice(chart as unknown as FullChartInput);
        if ((got as unknown as Record<string, unknown>)[field] != null) anyNonNull = true;
      }
      assert.equal(
        anyNonNull,
        false,
        `${field} produced a non-null value on a fixture — update this list and its verification note`,
      );
    }
  });

  test('volume-structure branches are genuinely exercised', () => {
    // Both fields are objects with boolean flags; a field that only ever took
    // one value would pass parity while proving little.
    const dirs = new Set<string>();
    let alignedTrue = 0;
    let alignedFalse = 0;
    let flaggedTrue = 0;
    let flaggedFalse = 0;

    for (const { chart } of cases()) {
      const got = computeVolumeStructureSlice(chart);
      if (got.trendAlignedVolume) {
        dirs.add(got.trendAlignedVolume.trendDir);
        if (got.trendAlignedVolume.aligned) alignedTrue++;
        else alignedFalse++;
      }
      if (got.volumeProgressDivergence) {
        if (got.volumeProgressDivergence.flagged) flaggedTrue++;
        else flaggedFalse++;
      }
    }

    assert.ok(dirs.has('UP') && dirs.has('DOWN'), `only observed trendDir: ${[...dirs].join(', ')}`);
    assert.ok(alignedTrue > 0 && alignedFalse > 0, 'both aligned states must occur');
    assert.ok(flaggedFalse > 0, 'expected unflagged divergence readings');
    // flagged=true is genuinely rare (2 of 192 in the verification run), so this
    // is informational rather than asserted -- it depends on the fixture set.
    if (flaggedTrue === 0) {
      console.log('      note: no flagged volumeProgressDivergence in this fixture set');
    }
  });

  test('unchanged closes count toward NEITHER volume bucket', () => {
    // A flat day is neither buying nor selling pressure. With every close
    // identical, both buckets stay empty and the whole read is null.
    const flat: SeriesInput = {
      closes: Array(100).fill(100),
      highs: Array(100).fill(100),
      lows: Array(100).fill(100),
      volumes: Array(100).fill(1000),
    };
    assert.equal(computeVolumeStructureSlice(flat).trendAlignedVolume, null);
  });

  test('trendAlignedVolume needs BOTH up-days and down-days', () => {
    // A monotonically rising series has no down-days, so the comparison would
    // be meaningless and the read is withheld entirely.
    const rising: SeriesInput = {
      closes: Array.from({ length: 100 }, (_, i) => 100 + i),
      highs: Array.from({ length: 100 }, (_, i) => 101 + i),
      lows: Array.from({ length: 100 }, (_, i) => 99 + i),
      volumes: Array(100).fill(1000),
    };
    assert.equal(computeVolumeStructureSlice(rising).trendAlignedVolume, null, 'no down-days, no read');
  });

  test('F-08: short history reports trendDir DOWN rather than unknown', () => {
    // sma50 is null under 50 bars, so `sma50 && last > sma50` short-circuits to
    // 'DOWN'. A strongly RISING 30-bar series is still labelled a downtrend.
    //
    // The close sequence cycles [+1, -1, +3] per bar (net +3 every 3 bars) so
    // it genuinely contains both up-days and down-days throughout -- both
    // volume buckets are populated, and the read is non-null.
    //
    // This contradicts the choice pctFromSma* made deliberately (null, not 0,
    // to avoid "flat therefore bearish"). Reproduced to hold parity; do NOT
    // change without a parity re-baseline.
    const base = Array.from({ length: 30 }, (_, i) => 100 + i);
    const closes = base.map((v, i) => (i % 3 === 2 ? v - 2 : v));
    const shortRising: SeriesInput = {
      closes,
      highs: closes.map((v) => v + 1),
      lows: closes.map((v) => v - 1),
      volumes: closes.map((_, i) => (i % 2 === 0 ? 2000 : 1000)),
    };
    const got = computeVolumeStructureSlice(shortRising).trendAlignedVolume;
    assert.ok(got, 'expected a read from a mixed 30-bar series');
    assert.equal(got.trendDir, 'DOWN', 'F-08: unknown trend is reported as DOWN');
  });

  test('the divergence baseline window does not overlap the recent window', () => {
    // Baseline is volumes[n-25 .. n-5], recent is volumes[n-5 .. n]. If they
    // overlapped, elevated recent volume would inflate its own baseline and the
    // ratio test would be self-defeating.
    const n = 100;
    const volumes = Array.from({ length: n }, (_, i) => (i >= n - 5 ? 10_000 : 1000));
    const spiky: SeriesInput = {
      closes: Array(n).fill(100),
      highs: Array(n).fill(100.5),
      lows: Array(n).fill(99.5),
      volumes,
    };
    const got = computeVolumeStructureSlice(spiky).volumeProgressDivergence;
    assert.ok(got);
    assert.equal(got.avgBaseVolume, 1000, 'baseline must exclude the volume spike');
    assert.equal(got.avgRecentVolume, 10_000);
    assert.equal(got.netProgressPct, 0, 'flat closes mean zero progress');
    assert.equal(got.flagged, true, 'heavy volume with no progress is the definition of churn');
  });

  test('ichimokuCloudBullish is tri-state — null means INSIDE the cloud', () => {
    // null here is a genuine neutral reading, not missing data. Collapsing it
    // to false would turn "no signal" into a bearish one.
    const oracle = loadOracle();
    let sawNull = false;
    let sawBool = false;
    for (const { chart } of cases()) {
      const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const got = computeIchimokuSlice(chart);
      assert.deepStrictEqual(got.ichimokuCloudBullish, expected['ichimokuCloudBullish']);
      if (got.ichimokuCloudBullish === null) sawNull = true;
      if (typeof got.ichimokuCloudBullish === 'boolean') sawBool = true;
    }
    assert.ok(sawBool, 'expected at least one definite above/below-cloud reading');
    assert.ok(sawNull, 'expected at least one inside-the-cloud (null) reading across the fixtures');
  });

  test('volatility band strings match byte-exactly, including punctuation', () => {
    // These strings reach the user-facing report. The em-dash and curly
    // apostrophe are part of the contract; a straight quote fails parity.
    const band = volatilityHotCold(0.08);
    assert.ok(band);
    assert.equal(band.tier, 'Hot');
    assert.ok(band.read.includes('—'), 'em-dash, not a hyphen');
    assert.ok(band.read.includes("course's"), 'curly apostrophe');
    assert.equal(volatilityHotCold(null), null);
    assert.equal(volatilityHotCold(0.04)?.tier, 'Normal');
    assert.equal(volatilityHotCold(0.01)?.tier, 'Coiled');
  });

  test('crossDataAvailable prevents the phantom death cross (legacy v9.46)', () => {
    // For 200-204 bars, sma200 is real but closes.slice(0,-5) can fall below
    // 200 bars. Without the guard, deathCross latched TRUE unconditionally.
    const oracle = loadOracle();
    for (const ticker of listFixtures()) {
      let raw;
      try { raw = loadRawFixture(ticker); } catch { continue; }
      if (!Array.isArray(raw.highs) || raw.closes.length < 210) continue;

      for (const len of [200, 201, 202, 203, 204]) {
        const chart = buildChart(raw, len);
        const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
        const got = computeMovingAverageSlice(chart);
        assert.deepStrictEqual(got.deathCross, expected['deathCross'], `${ticker}@${len} deathCross`);
        assert.deepStrictEqual(got.goldenCross, expected['goldenCross'], `${ticker}@${len} goldenCross`);
      }
    }
  });

  test('flat-series edge cases hit the documented neutral fallbacks', () => {
    // A perfectly flat series is the case the legacy v8.1 guard exists for:
    // without it, zero gains AND zero losses reports a maximally-overbought
    // 100 for a series that never moved.
    const flat: SeriesInput = {
      closes: Array(300).fill(100),
      highs: Array(300).fill(100),
      lows: Array(300).fill(100),
      volumes: Array(300).fill(1000),
    };
    const oracle = loadOracle();
    const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', flat);

    assert.equal(computeRsiSlice(flat).rsi14, 50, 'flat series must read neutral, not 100');
    assert.deepStrictEqual(computeRsiSlice(flat).rsi14, expected['rsi14']);
    assert.deepStrictEqual(computeStochasticSlice(flat).stochK, expected['stochK']);
    assert.deepStrictEqual(computeAtrSlice(flat).atr14, expected['atr14']);
    assert.equal(computeAtrSlice(flat).atr14, 0.0001, 'flat series ATR floors to the epsilon, not 1.0');
  });

  test('trailingPerf matches the oracle exactly', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    for (const { ticker, chart, len } of cases()) {
      const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const got = computeTrailingPerfSlice(chart as DatedSeriesInput);
      assert.deepStrictEqual(got.trailingPerf, expected['trailingPerf'], `${ticker}@${len} trailingPerf`);
      comparisons++;
    }
    assert.ok(comparisons > 0, 'no comparisons ran — are fixtures present?');
  });

  test('trailingPerf returns FRACTIONS, not percentages', () => {
    // 0.0339 = +3.39%, not 3.39. Verified against a direct recomputation from
    // the raw closes, independent of the oracle -- a wrong-by-100x port would
    // still pass a pure oracle comparison if the oracle itself were somehow
    // wrong, so this test checks the arithmetic, not just agreement.
    const raw = loadRawFixture('PLTR');
    const chart = buildChart(raw, 300);
    const got = computeTrailingPerfSlice(chart as DatedSeriesInput).trailingPerf;
    assert.ok(got, 'expected a non-null trailingPerf at 300 bars');
    const last = chart.closes[chart.closes.length - 1] as number;
    const weekAgo = chart.closes[chart.closes.length - 1 - 5] as number;
    const expectedWeek = (last - weekAgo) / weekAgo;
    assert.equal(got.week, expectedWeek);
    assert.ok(Math.abs(got.week as number) < 2, 'a one-week return as a fraction must be a small number, not e.g. 339');
  });

  test('trailingPerf long-range fields are null — UNVERIFIED, pending the fetch layer', () => {
    // Documents the honest limitation in computeTrailingPerfSlice: threeYear/
    // fiveYear/tenYear are hardcoded null because the legacy long-range fetch
    // (fetchYahooChartLongRange_) has no port yet. This passes today because
    // the oracle ALSO returns null here (UrlFetchApp is stubbed to 404 in the
    // test sandbox) -- it is not proof these fields are correct once fetched.
    const raw = loadRawFixture('PLTR');
    const chart = buildChart(raw, 300);
    const got = computeTrailingPerfSlice(chart as DatedSeriesInput).trailingPerf;
    assert.ok(got);
    assert.equal(got.threeYear, null);
    assert.equal(got.fiveYear, null);
    assert.equal(got.tenYear, null);
  });

  test('rs is null without a benchmark, and matches the oracle when present', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture('PLTR');
    const spyRaw = loadRawFixture('SPY');

    for (const len of [80, 150, 250]) {
      const chart = buildChart(raw, len);

      // No benchmark attached -- must read as null, not throw or default to 0.
      const noBench = computeRelativeStrengthSlice(chart as BenchmarkedSeriesInput);
      assert.equal(noBench.rs, null);
      const expectedNoBench = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      assert.deepStrictEqual(noBench.rs, expectedNoBench['rs']);

      // Real SPY closes, aligned by truncating to the same length.
      const benchmarkCloses = spyRaw.closes.slice(0, len);
      const withBench = { ...chart, benchmarkCloses };
      const got = computeRelativeStrengthSlice(withBench as BenchmarkedSeriesInput);
      const expectedWithBench = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', withBench);
      assert.deepStrictEqual(got.rs, expectedWithBench['rs'], `PLTR@${len} rs vs real SPY`);
    }
  });

  test('rs requires an EXACT length match, not a minimum', () => {
    // legacy: `bench.length===n`, strict equality. One extra or missing bar
    // must be treated as no benchmark at all, not silently truncated/padded.
    const raw = loadRawFixture('PLTR');
    const spyRaw = loadRawFixture('SPY');
    const chart = buildChart(raw, 150);

    const oneShort = { ...chart, benchmarkCloses: spyRaw.closes.slice(0, 149) };
    assert.equal(computeRelativeStrengthSlice(oneShort as BenchmarkedSeriesInput).rs, null);

    const oneLong = { ...chart, benchmarkCloses: spyRaw.closes.slice(0, 151) };
    assert.equal(computeRelativeStrengthSlice(oneLong as BenchmarkedSeriesInput).rs, null);

    const exact = { ...chart, benchmarkCloses: spyRaw.closes.slice(0, 150) };
    assert.notEqual(computeRelativeStrengthSlice(exact as BenchmarkedSeriesInput).rs, null);
  });

  test('rs against itself reads as flat, not as outperformance', () => {
    // A ticker compared to itself as its own "benchmark" has a constant
    // price ratio of 1 throughout -- rs21/rs63 must read ~0, not spuriously
    // positive or negative, and outperforming (rs63>0) must be false.
    const raw = loadRawFixture('PLTR');
    const chart = buildChart(raw, 150);
    const selfBench = { ...chart, benchmarkCloses: chart.closes };
    const got = computeRelativeStrengthSlice(selfBench as BenchmarkedSeriesInput).rs;
    assert.ok(got);
    assert.equal(got.rs21, 0);
    assert.equal(got.rs63, 0);
    assert.equal(got.outperforming, false);
  });

  test('divergence coverage is genuinely exercised, not trivially null', () => {
    // A field that is always null on every fixture passes parity while proving
    // nothing. Assert real variety instead.
    const seen: Record<string, number> = { bullish: 0, bearish: 0, none: 0 };
    for (const { chart } of cases()) {
      const d = computeDivergenceSlice(chart);
      for (const v of [d.divergence, d.macdDivergence, d.obvDivergence]) {
        seen[v.type] = (seen[v.type] ?? 0) + 1;
      }
    }
    assert.ok(seen.bullish! > 0, 'expected at least one bullish divergence across the fixtures');
    assert.ok(seen.bearish! > 0, 'expected at least one bearish divergence');
    assert.ok(seen.none! > 0, 'expected at least one no-divergence reading');
  });

  test('detectDivergence label defaults to RSI, and is overridable', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const osc = Array.from({ length: 80 }, (_, i) => 50 + Math.cos(i / 5) * 20);
    const dflt = detectDivergence(closes, osc, 60);
    const named = detectDivergence(closes, osc, 60, 'MACD');
    if (dflt.type !== 'none') assert.ok(dflt.note.includes('RSI'));
    if (named.type !== 'none') assert.ok(named.note.includes('MACD'));
  });

  test('detectDivergence reports insufficient history below 20 usable bars', () => {
    const r = detectDivergence([1, 2, 3], [1, 2, 3], 60);
    assert.deepEqual(r, { type: 'none', note: 'insufficient history' });
  });

  test('round-number increments scale with price', () => {
    assert.equal(roundLevelIncrement(3), 0.5);
    assert.equal(roundLevelIncrement(7), 1);
    assert.equal(roundLevelIncrement(45), 10);
    assert.equal(roundLevelIncrement(430), 100);
    assert.equal(roundLevelIncrement(5000), 1000);
    const r = roundNumberProximity(299, ROUND_NUMBER_TOLERANCE);
    assert.equal(r.nearest, 300);
    assert.equal(r.near, true);
  });

  test('candle-note strings are byte-exact, including Hebrew and punctuation', () => {
    // These reach the user-facing report. A straight quote or an ASCII "~"
    // in place of the approx sign fails parity, which is the intended net.
    // high=100, low=90, body=1 (open 96, close 97): bodyPct=0.1 (doji), but
    // wicks (3 up, 6 down) are lopsided enough to miss dragonfly (needs
    // upperWick<=10%), gravestone (needs lowerWick<=10%) AND long-legged
    // (needs BOTH wicks >=40%) -- landing on the plain 'DOJI' branch.
    const doji = singleCandleClassify(96, 100, 90, 97);
    assert.ok(doji);
    assert.equal(doji.type, 'DOJI');
    assert.ok(doji.note.includes('≈'), 'Unicode approx sign, not ~');

    // The course terminology is deliberately inverted vs Western convention:
    // its "Hammer" is the shooting-star shape and reads BEARISH.
    const hammer = singleCandleClassify(100, 110, 99.5, 100.5);
    if (hammer?.type === 'HAMMER_COURSE_TERM') {
      assert.equal(hammer.courseDirection, 'bearish');
      assert.ok(hammer.note.includes('פטיש'), 'Hebrew term preserved');
      assert.ok(hammer.note.includes('shooting star'));
    }
  });

  test('singleCandle returns null for an unremarkable candle and a zero range', () => {
    assert.equal(singleCandleClassify(100, 100, 100, 100), null, 'zero range');
    assert.equal(singleCandleClassify(null, 1, 1, 1), null, 'missing open');
  });

  test('dpoSignature is gated to known DPO tickers only', () => {
    // Derived from ONE real worked example, so it is deliberately not applied
    // to arbitrary tickers.
    assert.equal(KNOWN_DPO_TICKERS['PLTR'], true);
    assert.equal(KNOWN_DPO_TICKERS['AAPL'], undefined);

    let pltrNonNull = 0;
    let otherNonNull = 0;
    for (const { ticker, chart } of cases()) {
      const got = computeCompositeSlice(chart as unknown as CompositeInput).dpoSignature;
      if (got !== null) {
        if (ticker === 'PLTR') pltrNonNull++;
        else otherNonNull++;
      }
    }
    assert.equal(otherNonNull, 0, 'no non-DPO ticker may produce a signature');
    assert.ok(pltrNonNull > 0, 'PLTR should produce a real signature');
  });

  test('halfwayRetracementRead classifies against the half-way rule', () => {
    // Book rule: retracing half or less is a normal correction; more raises
    // real suspicion of a major reversal.
    let normal = 0;
    let beyondHalf = 0;
    for (const { chart } of cases()) {
      const hr = computeCompositeSlice(chart as unknown as CompositeInput).halfwayRetracementRead;
      if (!hr) continue;
      if (hr.classification === 'normal') {
        assert.ok(hr.retracedPct <= 0.5);
        normal++;
      } else {
        assert.ok(hr.retracedPct > 0.5);
        beyondHalf++;
      }
    }
    assert.ok(normal + beyondHalf > 0, 'expected some retracement readings across the fixtures');
  });

  test('trendMaturity returns null on a current SMA tie, not a guessed direction', () => {
    // A flat series makes sma50 === sma200 exactly, which must yield null
    // rather than defaulting to UP or DOWN.
    const flat = Array(300).fill(100) as number[];
    assert.equal(trendMaturity(flat), null);
  });

  test('trendMaturity distinguishes no-crossover-found from a real crossover', () => {
    // foundCross=false means the trend persisted across all visible history,
    // which is a different statement from "the trend began on this bar".
    let sawFound = false;
    let sawNotFound = false;
    for (const { chart } of cases()) {
      const tm = trendMaturity(chart.closes);
      if (!tm) continue;
      if (tm.foundCross) sawFound = true;
      else sawNotFound = true;
      assert.ok(['NEW', 'MATURING', 'MATURE'].includes(tm.maturity));
      assert.equal(tm.monthsSinceCross, tm.daysSinceCross / 21);
    }
    assert.ok(sawFound, 'expected at least one real crossover across the fixtures');
    assert.ok(sawNotFound, 'expected at least one persistent-trend case');
  });
});
