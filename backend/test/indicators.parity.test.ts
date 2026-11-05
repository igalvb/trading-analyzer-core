/**
 * The first real differential test.
 *
 * Pattern for every ported function from here on: feed the SAME real input
 * to the oracle and to the port, and assert the outputs are identical.
 *
 * Right now there is no ported computeAllIndicators, so this file does two
 * things: it proves the harness works end to end against real data, and it
 * locks the contract (115 keys, exact names) the port must satisfy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadChart, fixturesPresent, WARMUP_BARS } from './fixtures.ts';
import { INDICATOR_KEYS } from '../src/types/indicators.ts';
import { barCount } from '../src/types/chart.ts';

const ready = legacyFilesPresent() && fixturesPresent();

describe('indicators — oracle contract', { skip: ready ? false : 'legacy/ not populated yet' }, () => {
  test('the oracle computes indicators on real fixture data', () => {
    const oracle = loadOracle();
    const chart = loadChart('PLTR');
    const ind = oracle.call<Record<string, unknown>>('computeAllIndicators', chart);
    assert.ok(ind && typeof ind === 'object');
    assert.equal(typeof ind['rsi14'], 'number');
    assert.equal(typeof ind['atr14'], 'number');
  });

  test('the declared key set exactly matches what the oracle returns', () => {
    // Locks the contract. If the port omits a field, or the type file drifts
    // from reality, this fails immediately rather than at integration time.
    const oracle = loadOracle();
    const ind = oracle.call<Record<string, unknown>>('computeAllIndicators', loadChart('PLTR'));

    const actual = Object.keys(ind).sort();
    // Compared as plain strings -- this is a set-equality check against
    // whatever the oracle actually returns, not a type-level guarantee.
    const declared: string[] = [...INDICATOR_KEYS].sort();

    const missing = declared.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !declared.includes(k));

    assert.deepEqual(missing, [], `declared but not produced: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `produced but not declared: ${extra.join(', ')}`);

    // Reinstated 2026-09-13 with evidence: Object.keys(computeAllIndicators(chart)).length
    // printed 115 on two independent runs against the real oracle with the PLTR
    // fixture. Breakdown: 76 numbers, 12 booleans, 17 objects, 2 arrays, 2 strings,
    // 6 null-for-this-fixture. If this number changes, the oracle changed.
    assert.equal(actual.length, 115);
  });

  test('indicators are deterministic — identical input yields identical output', () => {
    // A precondition for differential testing at exact equality. If the
    // oracle were non-deterministic (hidden Date.now, unseeded random),
    // deepStrictEqual could never be the comparison rule.
    const oracle = loadOracle();
    const a = oracle.callNormalized('computeAllIndicators', loadChart('PLTR'));
    const b = oracle.callNormalized('computeAllIndicators', loadChart('PLTR'));
    assert.deepStrictEqual(a, b);
  });

  test('indicators run across every fixture without throwing', () => {
    const oracle = loadOracle();
    const failures: string[] = [];

    for (const ticker of listFixtures()) {
      let chart;
      try {
        chart = loadChart(ticker);
      } catch {
        continue; // not a ticker fixture
      }
      if (barCount(chart) < WARMUP_BARS) continue;
      try {
        oracle.call('computeAllIndicators', chart);
      } catch (e) {
        failures.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    assert.deepEqual(failures, [], `oracle threw on: ${failures.join(' | ')}`);
  });

  test('short history yields nulls rather than throwing or fabricating', () => {
    // The branch a port is most likely to get wrong: long-window indicators
    // must return null when there are not enough bars, not NaN or 0.
    const oracle = loadOracle();
    const chart = loadChart('PLTR', 30);
    const ind = oracle.call<Record<string, unknown>>('computeAllIndicators', chart);
    assert.equal(ind['sma200'], null, 'sma200 needs 200 bars');
    assert.ok(!Number.isNaN(ind['sma200'] as unknown as number));
  });
});
