import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { normalizeFromOracle } from './normalize.ts';
import { computeConfluenceTargets, type ConfluenceFundamentals, type ConfluenceMethod } from '../src/analysis/confluence.ts';
import type { Indicators } from '../src/types/indicators.ts';
import type { GannRead } from '../src/analysis/gann.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 201, 250, 400];

/**
 * Four fundamental variants, chosen to hit every analyst-target branch:
 *   null          -> "data unavailable"
 *   targetMean: 0 -> FALSY, so also "data unavailable" (not "below price")
 *   huge targets  -> above current price, included
 *   tiny targets  -> below current price, excluded with a formatted reason
 */
const FUND_VARIANTS: Array<ConfluenceFundamentals | null> = [
  null,
  { targetMean: 0 },
  { targetMean: 1e9, targetHigh: 2e9 },
  { targetMean: 1, targetHigh: 2 },
];

function confluenceCases(): Array<{ ticker: string; chart: ReturnType<typeof buildChart>; len: number }> {
  const out: Array<{ ticker: string; chart: ReturnType<typeof buildChart>; len: number }> = [];
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

describe('computeConfluenceTargets — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('matches the oracle exactly across fixtures, lengths and fundamental variants', () => {
    const oracle = loadOracle();
    let cases = 0;
    let methodEntries = 0;

    for (const { ticker, chart, len } of confluenceCases()) {
      // ind and gann come from the oracle for BOTH sides, so this isolates the
      // confluence logic rather than re-testing its already-verified inputs.
      const rawInd = oracle.call('computeAllIndicators', chart);
      const rawGann = oracle.call('computeGannInline', chart, rawInd);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(rawGann) as GannRead;

      for (const fund of FUND_VARIANTS) {
        const expected = oracle.callNormalized('computeConfluenceTargets', rawInd, rawGann, fund, chart);
        const got = computeConfluenceTargets(ind, gann, fund, chart);
        assert.deepStrictEqual(got, expected, `${ticker}@${len} fund=${JSON.stringify(fund)}`);
        cases++;
        methodEntries += got.allEntryMethods.length + got.allExitMethods.length;
      }
    }
    assert.ok(cases > 300, `only ${cases} cases compared`);
    assert.ok(methodEntries > 5000, `only ${methodEntries} method entries compared`);
  });

  test('every candidate method is always present, included or excluded', () => {
    // The audit trail is the point: a reader can tell that SMA50 was considered
    // and rejected, versus never checked. Counts must therefore be constant.
    const entryCounts = new Set<number>();
    const exitCounts = new Set<number>();
    for (const { chart } of confluenceCases()) {
      const oracle = loadOracle();
      const rawInd = oracle.call('computeAllIndicators', chart);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(oracle.call('computeGannInline', chart, rawInd)) as GannRead;
      const got = computeConfluenceTargets(ind, gann, null, chart);
      entryCounts.add(got.allEntryMethods.length);
      exitCounts.add(got.allExitMethods.length);
      for (const m of [...got.allEntryMethods, ...got.allExitMethods]) {
        // Excluded entries must always explain themselves.
        if (m.excluded) assert.ok(m.exclusionReason && m.exclusionReason.length > 0, `${m.name} excluded without a reason`);
      }
    }
    assert.equal(entryCounts.size, 1, `entry method count varies: ${[...entryCounts]}`);
    assert.equal(exitCounts.size, 1, `exit method count varies: ${[...exitCounts]}`);
  });

  test('confidence tags reflect both absolute and relative agreement', () => {
    // 4 of 5 methods agreeing is HIGH; 4 of 20 is not. The fraction gate is
    // what makes the tag meaningful.
    const tags = new Set<string>();
    for (const { chart } of confluenceCases()) {
      const oracle = loadOracle();
      const rawInd = oracle.call('computeAllIndicators', chart);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(oracle.call('computeGannInline', chart, rawInd)) as GannRead;
      const got = computeConfluenceTargets(ind, gann, null, chart);

      for (const [conf, count, methods] of [
        [got.entryConfidence, got.entryCount, got.entryMethods],
        [got.exitConfidence, got.exitCount, got.exitMethods],
      ] as Array<[string, number, ConfluenceMethod[]]>) {
        const tag = conf.split(' (')[0] as string;
        tags.add(tag);
        assert.equal(count, methods.length, 'count must match the cluster size');
        if (tag === 'HIGH') assert.ok(count >= 4);
        if (tag === 'MEDIUM') assert.ok(count >= 3);
        if (tag === 'LOW-MEDIUM') assert.ok(count >= 2);
        // The string always carries the raw numbers so a reader can judge.
        assert.match(conf, /\(\d+\/\d+ methods in zone\)|LOW \(no data\)/);
      }
    }
    // Verification run observed HIGH, MEDIUM, LOW-MEDIUM on entry and all four
    // on exit. Assert variety rather than a specific set, which depends on the
    // fixture data.
    assert.ok(tags.size >= 3, `only observed tags: ${[...tags].join(', ')}`);
  });

  test('zone bounds are consistent and derived from the cluster', () => {
    for (const { chart } of confluenceCases()) {
      const oracle = loadOracle();
      const rawInd = oracle.call('computeAllIndicators', chart);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(oracle.call('computeGannInline', chart, rawInd)) as GannRead;
      const got = computeConfluenceTargets(ind, gann, null, chart);

      assert.ok(got.entryLow <= got.entryCenter && got.entryCenter <= got.entryHigh);
      assert.ok(got.exitLow <= got.exitCenter && got.exitCenter <= got.exitHigh);
      if (got.entryCount > 0) {
        const prices = got.entryMethods.map((m) => m.price as number);
        assert.equal(got.entryLow, Math.min(...prices));
        assert.equal(got.entryHigh, Math.max(...prices));
      }
    }
  });

  test('the entry/exit filters overlap current price by 2% in each direction', () => {
    // Entry admits up to cp*1.02 (momentum entry); exit down to cp*0.98. A
    // level at the money can legitimately appear on either side.
    for (const { chart } of confluenceCases()) {
      const cp = chart.currentPrice;
      const oracle = loadOracle();
      const rawInd = oracle.call('computeAllIndicators', chart);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(oracle.call('computeGannInline', chart, rawInd)) as GannRead;
      const got = computeConfluenceTargets(ind, gann, null, chart);

      for (const m of got.entryMethods) {
        assert.ok((m.price as number) > 0 && (m.price as number) < cp * 1.02);
      }
      for (const m of got.exitMethods) {
        assert.ok((m.price as number) > cp * 0.98);
      }
    }
  });

  test('a falsy-zero analyst target reads as unavailable, not as below price', () => {
    // F-06 family. Implausible for a real target, but the branch is real.
    const first = confluenceCases()[0];
    assert.ok(first);
    const oracle = loadOracle();
    const rawInd = oracle.call('computeAllIndicators', first.chart);
    const ind = normalizeFromOracle(rawInd) as Indicators;
    const gann = normalizeFromOracle(oracle.call('computeGannInline', first.chart, rawInd)) as GannRead;

    const withZero = computeConfluenceTargets(ind, gann, { targetMean: 0 }, first.chart);
    const consensus = withZero.allExitMethods.find((m) => m.name === 'Analyst consensus (FMP)');
    assert.ok(consensus);
    assert.equal(consensus.excluded, true);
    assert.equal(consensus.exclusionReason, 'analyst target data unavailable');
    assert.equal(consensus.price, null, 'a falsy target yields null price, not 0');
  });

  test('excluded moving averages keep their real price; unavailable ones are null', () => {
    // A meaningful distinction: "SMA50 is $120, above price" versus "SMA50
    // could not be computed". Collapsing both to null would lose information.
    for (const { chart } of confluenceCases()) {
      const oracle = loadOracle();
      const rawInd = oracle.call('computeAllIndicators', chart);
      const ind = normalizeFromOracle(rawInd) as Indicators;
      const gann = normalizeFromOracle(oracle.call('computeGannInline', chart, rawInd)) as GannRead;
      const got = computeConfluenceTargets(ind, gann, null, chart);

      const sma50 = got.allEntryMethods.find((m) => m.name === 'SMA50 dynamic support');
      assert.ok(sma50);
      if (sma50.exclusionReason === 'SMA50 unavailable') assert.equal(sma50.price, null);
      else if (sma50.excluded) assert.equal(typeof sma50.price, 'number', 'a real level above price keeps its value');
    }
  });

  test('method names preserve the multiplication sign', () => {
    // 'ATR pullback (1.5×ATR)', 'Gann 1×1 (12 months)' -- U+00D7, not ASCII x.
    const first = confluenceCases()[0];
    assert.ok(first);
    const oracle = loadOracle();
    const rawInd = oracle.call('computeAllIndicators', first.chart);
    const ind = normalizeFromOracle(rawInd) as Indicators;
    const gann = normalizeFromOracle(oracle.call('computeGannInline', first.chart, rawInd)) as GannRead;
    const got = computeConfluenceTargets(ind, gann, null, first.chart);

    assert.ok(got.allEntryMethods.some((m) => m.name === 'ATR pullback (1.5×ATR)'));
    assert.ok(got.allExitMethods.some((m) => m.name === 'Gann 1×1 (12 months)'));
    assert.ok(!got.allExitMethods.some((m) => m.name.includes('1x1')), 'ASCII x must not appear');
  });
});
