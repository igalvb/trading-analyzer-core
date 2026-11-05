/**
 * Differential tests: ported leaf utilities vs the frozen oracle.
 *
 * The template for every ported function from here on. Note callNormalized
 * rather than call -- see normalize.ts for why raw call() would fail on
 * every array-returning function despite identical values.
 *
 * Verified 2026-09-13: 3,966 comparisons across 26 real fixtures, all exact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, fixturesPresent } from './fixtures.ts';
import { normalizeFromOracle } from './normalize.ts';
import { sma, ema, emaArray, wilderSmooth, wilderArray, stdDev, slope, rsiArray } from '../src/analysis/series.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Windows chosen to straddle every real seeding boundary in the engine. */
const PERIODS = [3, 5, 9, 12, 14, 20, 26, 50, 200];

/** Lengths chosen to sit exactly on / either side of those boundaries. */
const TRUNCATIONS = [0, 1, 2, 3, 13, 14, 15, 199, 200, 201, 500];

function usableFixtures(): Array<{ ticker: string; closes: number[] }> {
  const out: Array<{ ticker: string; closes: number[] }> = [];
  for (const ticker of listFixtures()) {
    try {
      const raw = loadRawFixture(ticker);
      if (Array.isArray(raw.closes) && raw.closes.length >= 60) out.push({ ticker, closes: raw.closes });
    } catch {
      // not a ticker fixture
    }
  }
  return out;
}

describe('series parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('scalar functions match exactly across every fixture and period', () => {
    const oracle = loadOracle();
    let checks = 0;
    for (const { ticker, closes } of usableFixtures()) {
      for (const n of PERIODS) {
        assert.deepStrictEqual(sma(closes, n), oracle.callNormalized('sma', closes, n), `${ticker} sma${n}`);
        assert.deepStrictEqual(ema(closes, n), oracle.callNormalized('ema', closes, n), `${ticker} ema${n}`);
        assert.deepStrictEqual(
          wilderSmooth(closes, n),
          oracle.callNormalized('wilderSmooth', closes, n),
          `${ticker} wilderSmooth${n}`,
        );
        assert.deepStrictEqual(slope(closes, n), oracle.callNormalized('slope', closes, n), `${ticker} slope${n}`);
        checks += 4;
      }
      assert.deepStrictEqual(stdDev(closes.slice(-20)), oracle.callNormalized('stdDev', closes.slice(-20)), `${ticker} stdDev`);
      checks++;
    }
    assert.ok(checks > 500, `expected a substantial number of comparisons, got ${checks}`);
  });

  test('array-returning functions match exactly (the cross-realm case)', () => {
    // These are the three that failed 130/130 before normalisation despite
    // byte-identical values. If normalize.ts ever regresses, this catches it.
    const oracle = loadOracle();
    for (const { ticker, closes } of usableFixtures()) {
      for (const n of PERIODS) {
        assert.deepStrictEqual(emaArray(closes, n), oracle.callNormalized('emaArray', closes, n), `${ticker} emaArray${n}`);
        assert.deepStrictEqual(
          wilderArray(closes, n),
          oracle.callNormalized('wilderArray', closes, n),
          `${ticker} wilderArray${n}`,
        );
        assert.deepStrictEqual(rsiArray(closes, n), oracle.callNormalized('rsiArray', closes, n), `${ticker} rsiArray${n}`);
      }
    }
  });

  test('short-input boundaries match exactly', () => {
    // Where a port most often diverges: the "not enough data" branches.
    // sma/ema/wilderSmooth return null; the *Array forms return [];
    // slope/stdDev return 0. Reproducing that asymmetry is the point.
    const oracle = loadOracle();
    for (const { ticker, closes } of usableFixtures()) {
      for (const len of TRUNCATIONS) {
        const s = closes.slice(0, len);
        assert.deepStrictEqual(sma(s, 14), oracle.callNormalized('sma', s, 14), `${ticker} sma@${len}`);
        assert.deepStrictEqual(ema(s, 14), oracle.callNormalized('ema', s, 14), `${ticker} ema@${len}`);
        assert.deepStrictEqual(emaArray(s, 14), oracle.callNormalized('emaArray', s, 14), `${ticker} emaArray@${len}`);
        assert.deepStrictEqual(wilderSmooth(s, 14), oracle.callNormalized('wilderSmooth', s, 14), `${ticker} wilder@${len}`);
        assert.deepStrictEqual(wilderArray(s, 14), oracle.callNormalized('wilderArray', s, 14), `${ticker} wilderArr@${len}`);
        assert.deepStrictEqual(rsiArray(s, 14), oracle.callNormalized('rsiArray', s, 14), `${ticker} rsiArray@${len}`);
        assert.deepStrictEqual(slope(s, 3), oracle.callNormalized('slope', s, 3), `${ticker} slope@${len}`);
        assert.deepStrictEqual(stdDev(s), oracle.callNormalized('stdDev', s), `${ticker} stdDev@${len}`);
      }
    }
  });

  test('degenerate inputs match exactly', () => {
    const oracle = loadOracle();
    const edges: Array<readonly number[] | null | undefined> = [[], [5], [1, 2], null, undefined];
    for (const e of edges) {
      assert.deepStrictEqual(sma(e, 3), oracle.callNormalized('sma', e, 3));
      assert.deepStrictEqual(ema(e, 3), oracle.callNormalized('ema', e, 3));
      assert.deepStrictEqual(emaArray(e, 3), oracle.callNormalized('emaArray', e, 3));
      assert.deepStrictEqual(wilderSmooth(e, 3), oracle.callNormalized('wilderSmooth', e, 3));
      assert.deepStrictEqual(wilderArray(e, 3), oracle.callNormalized('wilderArray', e, 3));
      assert.deepStrictEqual(rsiArray(e, 3), oracle.callNormalized('rsiArray', e, 3));
      assert.deepStrictEqual(slope(e, 3), oracle.callNormalized('slope', e, 3));
      assert.deepStrictEqual(stdDev(e), oracle.callNormalized('stdDev', e));
    }
  });

  test('the return-type contracts are asymmetric, and that is intentional', () => {
    // Documents legacy behaviour so a future "cleanup" cannot quietly
    // normalise these to one convention and break downstream .toFixed() calls.
    assert.equal(sma([1, 2], 5), null);
    assert.equal(ema([1, 2], 5), null);
    assert.equal(wilderSmooth([1, 2], 5), null);
    assert.deepEqual(emaArray([1, 2], 5), []);
    assert.deepEqual(wilderArray([1, 2], 5), []);
    assert.deepEqual(rsiArray([1, 2], 5), []);
    assert.equal(slope([1], 3), 0, 'slope returns 0, never null');
    assert.equal(stdDev([]), 0, 'stdDev returns 0, never null');
  });

  test('stdDev is the POPULATION form (÷n), not the sample form (÷n-1)', () => {
    // Load-bearing: this feeds Bollinger Band width. The sample form would
    // silently widen every band in the system.
    const v = stdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(v, 2, 'population sd of this classic set is exactly 2');
  });
});

test('normalizeFromOracle passes primitives through untouched', () => {
  assert.equal(normalizeFromOracle(5), 5);
  assert.equal(normalizeFromOracle('x'), 'x');
  assert.equal(normalizeFromOracle(null), null);
});
