/**
 * Wyckoff + RECTANGLE parity, verified on SYNTHETIC charts.
 *
 * No real fixture produces a RECTANGLE, so wyckoffSchematic is null on all of
 * them -- a passing comparison there would be vacuous. These tests build flat
 * trading ranges that genuinely trigger both, giving real verification.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { computeChartPatterns, type ChartPattern, type PatternInput } from '../src/analysis/indicators/chartPatterns.ts';
import { wyckoffSchematic } from '../src/analysis/indicators/wyckoff.ts';

const ready = legacyFilesPresent();

// Redeclares the array fields as mutable (PatternInput has them readonly) --
// the mid-range-climax test below needs to overwrite specific bars in place.
interface SynthChart extends Omit<PatternInput, 'closes' | 'highs' | 'lows' | 'volumes' | 'dates'> {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  dates: Date[];
  opens: number[];
  ticker: string;
  currentPrice: number;
  prevClose: number;
  currency: string;
  splits: never[];
  ipoDate: Date;
}

/**
 * Builds a flat oscillating range that satisfies the RECTANGLE conditions.
 *
 * The climax bar is shaped deliberately: it closes DOWN versus the prior bar
 * but in the UPPER half of its own range, which is the Selling Climax
 * signature. Symmetric bars give a close position of exactly 0.5 and match
 * NEITHER climax branch, since both comparisons are strict.
 */
function buildRectChart(
  nBars: number,
  climaxAt: number,
  climaxVolMult: number,
  tailBreak = false,
  finalVolMult = 1,
): SynthChart {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const opens: number[] = [];
  const volumes: number[] = [];
  const dates: Date[] = [];
  const base = new Date('2024-01-01T00:00:00Z');

  for (let i = 0; i < nBars; i++) {
    const t = (i % 20) / 20;
    let c = 103 + 3 * Math.sin(t * 2 * Math.PI);
    if (tailBreak && i >= nBars - 2) c = 108;
    let hi = c + 0.3;
    let lo = c - 0.3;
    if (i === climaxAt) {
      c = (closes[i - 1] as number) - 1.0; // closes DOWN
      lo = c - 0.5; // ...but recovers into the upper half
      hi = c + 0.1;
    }
    closes.push(c);
    opens.push(c);
    highs.push(hi);
    lows.push(lo);
    volumes.push(i === climaxAt ? 1_000_000 * climaxVolMult : i === nBars - 1 ? 1_000_000 * finalVolMult : 1_000_000);
    dates.push(new Date(base.getTime() + i * 86400000));
  }

  return {
    closes, highs, lows, opens, volumes, dates,
    splits: [], ipoDate: dates[0] as Date, ticker: 'SYNTH',
    currentPrice: closes[closes.length - 1] as number,
    prevClose: closes[closes.length - 2] as number,
    currency: 'USD',
  };
}

/** volRatio exactly as the engine computes it. */
function volRatioOf(chart: SynthChart): number {
  const n = chart.closes.length;
  const v20 = chart.volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return v20 > 0 ? (chart.volumes[n - 1] as number) / (v20 || 1) : 1;
}

const CASES: Array<[string, SynthChart]> = [
  ['flat range, no climax', buildRectChart(200, -1, 1)],
  ['climax at 120', buildRectChart(200, 120, 5)],
  ['climax at 150, breaks up', buildRectChart(200, 150, 5, true)],
  ['climax before scan window', buildRectChart(220, 100, 8)],
  ['SOS: break on heavy volume', buildRectChart(200, 150, 5, true, 2.0)],
  ['break on light volume', buildRectChart(200, 150, 5, true, 0.5)],
];

describe('RECTANGLE + wyckoffSchematic', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('synthetic charts genuinely produce a RECTANGLE', () => {
    // Guards the premise: if these stopped firing, every test below would pass
    // vacuously and prove nothing.
    let rects = 0;
    for (const [, chart] of CASES) {
      if (computeChartPatterns(chart).some((p) => p.type === 'RECTANGLE')) rects++;
    }
    assert.ok(rects >= 4, `only ${rects} synthetic charts produced a RECTANGLE`);
  });

  test('RECTANGLE matches the oracle exactly on synthetic ranges', () => {
    const oracle = loadOracle();
    for (const [label, chart] of CASES) {
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const expected = (all['chartPatterns'] as ChartPattern[]) ?? [];
      assert.deepStrictEqual(computeChartPatterns(chart), expected, `${label}: chartPatterns`);
    }
  });

  test('wyckoffSchematic matches the oracle exactly, on real non-null paths', () => {
    const oracle = loadOracle();
    const stages = new Set<string>();
    let nonNull = 0;

    for (const [label, chart] of CASES) {
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const expected = all['wyckoffSchematic'];
      const got = wyckoffSchematic(chart, volRatioOf(chart), computeChartPatterns(chart));
      assert.deepStrictEqual(got, expected, `${label}: wyckoffSchematic`);
      if (got) {
        nonNull++;
        stages.add(got.stage);
      }
    }

    assert.ok(nonNull >= 2, `only ${nonNull} non-null results — verification would be vacuous`);
    assert.ok(stages.has('ST'), 'expected the ST stage');
    assert.ok(stages.has('SOS/SOW'), 'expected the SOS/SOW stage');
  });

  test('a bar closing exactly mid-range is NOT a climax', () => {
    // Both comparisons are strict, so closePosInRange === 0.5 matches neither
    // branch. Symmetric synthetic bars therefore never produce a climax.
    const symmetric = buildRectChart(200, -1, 1);
    // Force a huge-volume bar with a perfectly symmetric range.
    symmetric.volumes[150] = 10_000_000;
    symmetric.highs[150] = (symmetric.closes[150] as number) + 0.5;
    symmetric.lows[150] = (symmetric.closes[150] as number) - 0.5;
    const got = wyckoffSchematic(symmetric, volRatioOf(symmetric), computeChartPatterns(symmetric));
    assert.equal(got, null, 'a mid-range close must not qualify as a climax');
  });

  test('F-07: the LPS/LPSY stage is unreachable, and that is reproduced', () => {
    // sosConfirmed requires volRatio > 1.3; the lps test inside it requires
    // volRatio < 1.0, on the SAME value. Unsatisfiable, so lps is always null.
    // Reproduced faithfully -- do NOT "fix" this without a parity re-baseline.
    for (const [, chart] of CASES) {
      const got = wyckoffSchematic(chart, volRatioOf(chart), computeChartPatterns(chart));
      assert.notEqual(got?.stage, 'LPS/LPSY', 'LPS/LPSY should be unreachable');
    }
    // Direct proof: no volRatio can satisfy both conditions.
    for (const vr of [0.5, 0.9, 1.0, 1.3, 1.4, 2.0, 5.0]) {
      const sosConfirmed = vr > 1.3;
      const lpsPossible = sosConfirmed && vr < 1.0;
      assert.equal(lpsPossible, false, `volRatio ${vr} must not reach the lps branch`);
    }
  });

  test('wyckoff returns null without a RECTANGLE', () => {
    const chart = buildRectChart(200, 150, 5);
    assert.equal(wyckoffSchematic(chart, 1, []), null, 'no patterns at all');
    assert.equal(wyckoffSchematic(chart, 1, null), null, 'null patterns');
    const noRect = computeChartPatterns(chart).filter((p) => p.type !== 'RECTANGLE');
    assert.equal(wyckoffSchematic(chart, 1, noRect), null, 'patterns present but no RECTANGLE');
  });

  test('wyckoff returns null below the minimum history', () => {
    const short = buildRectChart(70, 60, 5); // needs 60 + 20
    assert.equal(wyckoffSchematic(short, 1, computeChartPatterns(short)), null);
  });
});
