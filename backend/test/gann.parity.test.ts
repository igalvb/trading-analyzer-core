import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { computeGann, type GannInput } from '../src/analysis/gann.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 100, 201, 250, 400];

function gannCases(): Array<{ ticker: string; chart: GannInput; len: number }> {
  const out: Array<{ ticker: string; chart: GannInput; len: number }> = [];
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

describe('computeGann — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('matches the oracle exactly across every fixture and length', () => {
    const oracle = loadOracle();
    let charts = 0;
    for (const { ticker, chart, len } of gannCases()) {
      // The legacy signature takes (chart, ind) but never reads ind -- pass a
      // real indicator object anyway, so the call is faithful to production.
      const ind = oracle.call('computeAllIndicators', chart);
      const expected = oracle.callNormalized('computeGannInline', chart, ind);
      assert.deepStrictEqual(computeGann(chart), expected, `${ticker}@${len}`);
      charts++;
    }
    assert.ok(charts > 0);
  });

  test('the dropped `ind` parameter genuinely has no effect', () => {
    // Justifies the port's one-argument signature: the oracle produces the same
    // result with a real indicator object, an empty object, or undefined.
    const oracle = loadOracle();
    const chart = gannCases()[0]?.chart;
    assert.ok(chart);
    const withInd = oracle.callNormalized('computeGannInline', chart, oracle.call('computeAllIndicators', chart));
    const withEmpty = oracle.callNormalized('computeGannInline', chart, {});
    const withUndef = oracle.callNormalized('computeGannInline', chart, undefined);
    assert.deepStrictEqual(withEmpty, withInd);
    assert.deepStrictEqual(withUndef, withInd);
  });

  test('score tiers and angle labels are genuinely exercised', () => {
    const scores = new Set<number>();
    const lower = new Set<string>();
    const upper = new Set<string>();
    let volOkTrue = 0;
    let volOkFalse = 0;

    for (const { chart } of gannCases()) {
      const g = computeGann(chart);
      scores.add(g.score);
      lower.add(g.lowerAngle);
      upper.add(g.upperAngle);
      if (g.pivot.volOk) volOkTrue++;
      else volOkFalse++;
    }

    // Five of six tiers. 18 is F-09 -- see the dedicated test below.
    for (const s of [35, 45, 55, 68, 85]) {
      assert.ok(scores.has(s), `score tier ${s} never observed`);
    }
    assert.ok(lower.has('below all'), 'expected the all-angles-above case');
    assert.ok(upper.has('above all'), 'expected the all-angles-below case');
    assert.ok(lower.size >= 5 && upper.size >= 5, 'expected varied nearest-angle outcomes');
    assert.ok(volOkTrue > 0 && volOkFalse > 0, 'both pivot volume states must occur');
  });

  test('F-09: the score=18 tier cannot fire on self-consistent data', () => {
    // It needs currentPrice < pivot.price. The main search requires the pivot be
    // >=12% BELOW price; the fallback takes the minimum low over a range that
    // includes the final bar, and a bar's low is <= its close. So with
    // currentPrice drawn from the same series, velocityRatio >= 0 always.
    //
    // Reproduced to hold parity. Conditionally reachable in production, where
    // currentPrice is a live quote against a possibly-staler bar array.
    for (const { ticker, chart } of gannCases()) {
      const g = computeGann(chart);
      assert.notEqual(g.score, 18, `${ticker}: score 18 should be unreachable`);
      assert.ok(chart.currentPrice >= g.pivot.price, 'pivot must sit at or below current price');
    }

    // Prove the branch DOES work when fed the inconsistent input that reaches it.
    const base = gannCases().find((c) => c.ticker === 'AQZA')?.chart; // the fixture that sorted first before the rename
    assert.ok(base);
    const belowAllLows = { ...base, currentPrice: Math.min(...base.lows) * 0.5 };
    assert.equal(computeGann(belowAllLows).score, 18, 'an artificially low quote reaches the tier');
  });

  test('angle labels use the multiplication sign, not the letter x', () => {
    // They are object keys in `fan` and returned verbatim, so an ASCII
    // substitution silently breaks parity.
    const g = computeGann(gannCases()[0]?.chart as GannInput);
    assert.ok('1×1' in g.fan, 'expected U+00D7 in the key');
    assert.ok(!('1x1' in g.fan), 'ASCII x must not appear');
    assert.equal(g.ANGLES.length, 9);
    assert.equal(g.ANGLES[0]?.label, '8×1', 'steepest first');
  });

  test('priceUnit rounding follows the sliding scale and is never zero', () => {
    for (const { chart } of gannCases()) {
      const { priceUnit } = computeGann(chart);
      assert.ok(priceUnit > 0, 'a zero unit would collapse the fan');
      if (priceUnit >= 10) assert.equal(priceUnit % 5, 0, 'nearest 5 above $10');
      else if (priceUnit >= 2) assert.equal(priceUnit % 1, 0, 'whole numbers above $2');
    }
  });

  test('nearest angles bracket the current price, and support sits below resistance', () => {
    for (const { chart } of gannCases()) {
      const g = computeGann(chart);
      if (g.gannSupport != null) assert.ok(g.gannSupport <= chart.currentPrice);
      if (g.gannResistance != null) assert.ok(g.gannResistance > chart.currentPrice);
      if (g.gannSupport != null && g.gannResistance != null) {
        assert.ok(g.gannSupport < g.gannResistance);
      }
      // Both null is impossible: nine angles must split across the two sides.
      assert.ok(g.gannSupport != null || g.gannResistance != null);
    }
  });

  test('Square-of-9 levels bracket price and skip the pivot itself', () => {
    for (const { chart } of gannCases()) {
      const g = computeGann(chart);
      if (g.sq9below != null) assert.ok(g.sq9below < chart.currentPrice);
      if (g.sq9above != null) assert.ok(g.sq9above > chart.currentPrice);
      if (g.sq9below != null && g.sq9above != null) assert.ok(g.sq9below < g.sq9above);
    }
  });
});
