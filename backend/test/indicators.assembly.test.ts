/**
 * Whole-object parity for the assembled indicator set.
 *
 * Every other indicator test compares FIELDS. This one compares the OBJECT,
 * because field-level parity does not imply it: a key could be missing, two
 * slices could write the same key with one silently overwriting the other,
 * or a slice could be handed the wrong subset of the chart. deepStrictEqual
 * on the whole return value is the only assertion that rules all three out
 * at once.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { computeIndicators, SLICE_COUNT, type SliceFailure } from '../src/analysis/indicators/index.ts';
import { TOTAL_INDICATOR_FIELDS, PORTED_INDICATOR_FIELDS } from '../src/analysis/indicators/slices.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Legacy's own fetch guard rejects anything shorter, so neither side sees it. */
const MIN_BARS = 60;

describe('computeIndicators — whole-object parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the assembled object equals the oracle exactly, on every fixture', () => {
    const oracle = loadOracle();
    let charts = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < MIN_BARS) continue;
      // Several lengths per ticker: a short series exercises the
      // insufficient-history null paths that a full series never reaches.
      for (const len of [60, 201, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
        const got = computeIndicators(chart) as unknown as Record<string, unknown>;
        // Key sets first: a mismatch here produces a readable failure,
        // whereas deepStrictEqual on 115 fields does not.
        assert.deepStrictEqual(
          Object.keys(got).sort(), Object.keys(expected).sort(),
          `${ticker}@${len} key set`,
        );
        assert.deepStrictEqual(got, expected, `${ticker}@${len} whole object`);
        charts++;
      }
    }
    assert.ok(charts >= 60, `only ${charts} charts compared`);
  });

  test('exactly 115 fields, matching the tracked list', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture(listFixtures()[0] as string);
    const got = computeIndicators(buildChart(raw, raw.closes.length));
    const keys = Object.keys(got);
    assert.equal(keys.length, TOTAL_INDICATOR_FIELDS);
    assert.equal(PORTED_INDICATOR_FIELDS.length, TOTAL_INDICATOR_FIELDS);
    assert.deepStrictEqual([...keys].sort(), [...PORTED_INDICATOR_FIELDS].sort());
    assert.equal(SLICE_COUNT, 31);
    // And the oracle agrees on the count, so 115 is not just our own number.
    assert.equal(
      Object.keys(oracle.callNormalized<object>('computeAllIndicators', buildChart(raw, raw.closes.length))).length,
      TOTAL_INDICATOR_FIELDS,
    );
  });
});

describe('computeIndicators — slice isolation', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  /**
   * Slices whose own internal guard absorbs a null volume series and returns
   * a degraded value instead of throwing. Their output legitimately differs
   * from the oracle's here -- the oracle had real volumes.
   */
  const DEGRADES_ON_NULL_VOLUME = [
    'chartPatterns', 'priceGaps', 'srLevels', 'trendAlignedVolume',
    'volumePOC', 'volumeProgressDivergence',
  ];

  const THROWS_ON_NULL_VOLUME = ['composite', 'divergence', 'events', 'oscillator', 'volume', 'wyckoff'];

  test('a failing slice loses only its own fields; the rest stay oracle-exact', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture('NVDA');
    const chart = buildChart(raw, raw.closes.length);
    const expected = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);

    // Verified empirically: `volumes: null` is a corruption that slices do
    // NOT all absorb, so it genuinely reaches the assembler's catch. An
    // earlier attempt used a corrupted `dates` array, which failed zero
    // slices -- a test that proved nothing. The premise is checked below.
    const failures: SliceFailure[] = [];
    const partial = computeIndicators(
      { ...chart, volumes: null as unknown as readonly number[] },
      { onSliceError: (f) => failures.push(f) },
    ) as unknown as Record<string, unknown>;

    assert.deepStrictEqual(
      failures.map((f) => f.slice).sort(), THROWS_ON_NULL_VOLUME,
      'the set of failing slices changed',
    );
    assert.ok(failures.every((f) => f.cause instanceof Error), 'every failure must carry its cause');

    const present = Object.keys(partial);
    assert.equal(present.length, 93, 'surviving field count changed');
    assert.equal(Object.keys(expected).length - present.length, 22, 'lost field count changed');

    let exact = 0;
    const differing: string[] = [];
    for (const k of present) {
      try {
        assert.deepStrictEqual(partial[k], expected[k]);
        exact++;
      } catch {
        differing.push(k);
      }
    }
    // The whole point: 25 of 31 slices still produced oracle-identical
    // output while 6 were failing. Legacy would have returned nothing.
    assert.equal(exact, 87, 'oracle-exact surviving field count changed');
    assert.deepStrictEqual(differing.sort(), DEGRADES_ON_NULL_VOLUME);
  });

  test('never throws, whatever the chart looks like', () => {
    const raw = loadRawFixture('NVDA');
    const chart = buildChart(raw, 300);
    const empty = { closes: [], highs: [], lows: [], volumes: [], opens: [], dates: [] };
    const cases: Array<[string, object]> = [
      ['empty series', { ...chart, ...empty }],
      ['three bars', {
        ...chart, closes: [1, 2, 3], highs: [1, 2, 3], lows: [1, 2, 3],
        volumes: [1, 2, 3], opens: [1, 2, 3], dates: chart.dates.slice(0, 3),
      }],
      ['null closes', { ...chart, closes: null }],
      ['null highs', { ...chart, highs: null }],
      ['null dates', { ...chart, dates: null }],
      ['string closes', { ...chart, closes: 'oops' }],
      ['object volumes', { ...chart, volumes: {} }],
    ];
    for (const [label, bad] of cases) {
      let result: object | null = null;
      assert.doesNotThrow(() => {
        result = computeIndicators(bad as never, { onSliceError: () => {} });
      }, label);
      assert.ok(result && typeof result === 'object', `${label} must still return an object`);
    }
  });

  test('_VIX has null bars, and the port survives a chart legacy cannot finish', () => {
    // F-14: on _VIX the ORACLE throws inside computeTechnicalPlanV7 (:3007)
    // because computeGannInline picked a pivot whose price is one of the 182
    // null bars, and :3007 calls gann.pivot.price.toFixed(2) unguarded.
    // computeIndicators itself is unaffected -- asserted here so the two
    // facts stay distinguishable if either changes.
    const raw = loadRawFixture('_VIX');
    const chart = buildChart(raw, raw.closes.length);
    const nullLows = chart.lows.filter((v) => v == null).length;
    assert.ok(nullLows > 0, 'the _VIX fixture is expected to contain null bars');
    const got = computeIndicators(chart);
    assert.equal(Object.keys(got).length, TOTAL_INDICATOR_FIELDS);
  });
});
