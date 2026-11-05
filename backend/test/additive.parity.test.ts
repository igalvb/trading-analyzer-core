/**
 * Differential verification of Tier C part 2 and Tier D.
 *
 * Tier C part 2: nNormalizedPositionSize, compositeLeverage (+ its
 * normalRangeForPrice table), fanPrinciple, trendChannel.
 * Tier D: the drivers table and the secular read.
 *
 * The drivers table is compared against the oracle's OWN techPlan.drivers
 * rather than a separate call, because it is inline in
 * computeTechnicalPlanV7 (:2990-3008) and has no callable entry point.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Indicators } from '../src/types/indicators.ts';
import type { GannRead } from '../src/analysis/gann.ts';
import type { Regime } from '../src/analysis/techPlan/scoring.ts';
import {
  computeNNormalizedPositionSize, computeCompositeLeverage, normalRangeForPrice,
  computeFanPrinciple, computeTrendChannel,
  type FanDirection, type ChannelDirection,
} from '../src/analysis/techPlan/additive.ts';
import { computeDrivers, computeDriversSafe, computeSecularRead } from '../src/analysis/techPlan/drivers.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [19, 20, 26, 60, 201, 250, 400];
const FAN_DIRECTIONS: FanDirection[] = ['bullCorrection', 'bearRecovery'];
const CHANNEL_DIRECTIONS: ChannelDirection[] = ['up', 'down'];

describe('Appendix A/E reads — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('normalRangeForPrice matches at every table anchor, between them, and beyond both ends', () => {
    const oracle = loadOracle();
    // Every printed anchor, a midpoint between several, both flat regions,
    // and NaN -- which falls through every branch to the last row.
    const prices = [
      0, 0.5, 1.25, 2, 5, 7.5, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 55,
      60, 70, 80, 90, 100, 125, 150, 175, 200, 225, 250, 300, 1e6, NaN,
    ];
    for (const p of prices) {
      assert.deepStrictEqual(normalRangeForPrice(p), oracle.call('normalRangeForPriceV1_', p), `price ${p}`);
    }
    // The documented flat regions, asserted rather than described.
    assert.equal(normalRangeForPrice(0.5), 38.0, 'flat below the $1.25 row');
    assert.equal(normalRangeForPrice(1e6), 7.0, 'flat above the $250 row');
    // And genuinely interpolating in between, not snapping to a row.
    const mid = normalRangeForPrice(7.5);
    assert.ok(mid < 24.0 && mid > 19.8, `expected interpolation, got ${mid}`);
  });

  test('compositeLeverage matches the oracle and reaches all four tiers', () => {
    const oracle = loadOracle();
    const tiers = new Set<string>();
    let comparisons = 0;
    for (const price of [0, -5, 1, 3, 12, 45, 99, 150, 400, NaN, Infinity]) {
      for (const s of [0, 0.3, 0.8, 1.0, 1.4, 2.5, NaN]) {
        const expected = oracle.callNormalized('computeCompositeLeverageV1_', price, s);
        assert.deepStrictEqual(computeCompositeLeverage(price, s), expected, `price=${price} S=${s}`);
        comparisons++;
        const t = expected as { tier?: string } | null;
        if (t?.tier) tiers.add(t.tier);
      }
    }
    assert.equal(comparisons, 77);
    assert.deepStrictEqual(
      [...tiers].sort(),
      ['conservative', 'highly speculative', 'moderate', 'speculative'],
    );
  });

  test('nNormalizedPositionSize matches the oracle, including every rejection path', () => {
    const oracle = loadOracle();
    let sized = 0;
    let rejected = 0;
    for (const entry of [1, 10, 50, 300, 20_000, NaN, Infinity]) {
      for (const n of [0, -1, 0.01, 0.5, 2, 10, 500, NaN]) {
        const got = computeNNormalizedPositionSize(entry, n);
        assert.deepStrictEqual(
          got, oracle.callNormalized('computeNNormalizedPositionSizeV1_', entry, n),
          `entry=${entry} n=${n}`,
        );
        got === null ? rejected++ : sized++;
      }
    }
    assert.ok(sized > 0 && rejected > 0, 'only one outcome branch was exercised');
    // The fixed 1% is deliberately NOT ACCOUNT.riskPct. Both are 1 today, so
    // this asserts the Appendix E arithmetic directly: 10000 * 1% / N shares.
    const r = computeNNormalizedPositionSize(100, 2);
    assert.equal(r?.shares, 50, '10000 * 0.01 / 2');
    assert.equal(r?.stopLevel, 96, 'entry - 2N');
    assert.equal(r?.dollarRisk, 200, 'shares * 2N');
    assert.equal(r?.riskPctOfAccount, 2);
    // FLAGGED: stopLevel is not clamped at zero. Reproduced, not fixed.
    const neg = computeNNormalizedPositionSize(5, 0.5);
    assert.ok(neg != null && neg.stopLevel === 4);
    const belowZero = computeNNormalizedPositionSize(1, 0.5);
    assert.ok(belowZero != null && belowZero.stopLevel === 0);
  });
});

describe('Ch14 fan and channel — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('both match the oracle on every fixture, length and direction', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    const fanFired: Record<string, number> = {};
    const fanNull: Record<string, number> = {};
    const chanFired: Record<string, number> = {};
    const chanNull: Record<string, number> = {};
    const brokenCounts = new Set<number>();
    let shortfallPositive = 0;
    let shortfallNonPositive = 0;

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

        for (const d of FAN_DIRECTIONS) {
          const expected = oracle.callNormalized('computeFanPrincipleV1_', chart, d);
          const got = computeFanPrinciple(chart, d);
          assert.deepStrictEqual(got, expected, `${ticker}@${len} fan ${d}`);
          comparisons++;
          if (got) {
            fanFired[d] = (fanFired[d] ?? 0) + 1;
            brokenCounts.add(got.brokenCount);
          } else {
            fanNull[d] = (fanNull[d] ?? 0) + 1;
          }
        }

        for (const d of CHANNEL_DIRECTIONS) {
          const expected = oracle.callNormalized('computeTrendChannelV1_', chart, d);
          const got = computeTrendChannel(chart, d);
          assert.deepStrictEqual(got, expected, `${ticker}@${len} channel ${d}`);
          comparisons++;
          if (got) {
            chanFired[d] = (chanFired[d] ?? 0) + 1;
            got.shortfall > 0 ? shortfallPositive++ : shortfallNonPositive++;
          } else {
            chanNull[d] = (chanNull[d] ?? 0) + 1;
          }
        }
      }
    }

    assert.ok(comparisons > 700, `only ${comparisons} comparisons`);
    for (const d of FAN_DIRECTIONS) {
      assert.ok(fanFired[d] > 0 && fanNull[d] > 0, `fan ${d} exercised only one branch`);
    }
    for (const d of CHANNEL_DIRECTIONS) {
      assert.ok(chanFired[d] > 0 && chanNull[d] > 0, `channel ${d} exercised only one branch`);
    }
    // All four break counts occur, so `triggered` is not degenerate.
    assert.deepStrictEqual([...brokenCounts].sort(), [0, 1, 2, 3]);
    // Both signs of shortfall, so projectedOvershoot has a real null path.
    assert.ok(shortfallPositive > 0 && shortfallNonPositive > 0);
  });

  test('F-15: `flattening` compares only the first and third lines, so it can be true for a non-monotonic fan', () => {
    // Reproduced, not fixed. The legacy comment at :2645-2647 says the book
    // claims "each successive line is flatter" and that this is "verified
    // here, not assumed". It is only PARTLY verified: the expression is
    // `slopes[2] > slopes[0]` (bull) -- slopes[1] is never read. So a fan
    // whose middle line is flatter than its last still reports flattening.
    //
    // Measured on real fixtures: 19 of 149 reads are not monotonically
    // flattening, and 14 of those report flattening=true anyway. Example:
    // AQZB bearRecovery slopes [6.4637, 5.1477, 6.0996].
    const oracle = loadOracle();
    let reads = 0;
    let nonMonotonicButFlagged = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 60) continue;
      for (const len of [60, 201, 250, 400, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        for (const d of FAN_DIRECTIONS) {
          const r = computeFanPrinciple(chart, d);
          assert.deepStrictEqual(r, oracle.callNormalized('computeFanPrincipleV1_', chart, d));
          if (!r) continue;
          reads++;
          const isBull = d === 'bullCorrection';
          const originIdx = chart.dates.findIndex((x) => x.getTime() === r.originDate.getTime());
          const slopes = r.fanPoints.map((p) => {
            const idx = chart.dates.findIndex((x) => x.getTime() === p.date.getTime());
            return (p.price - r.originPrice) / (idx - originIdx);
          });
          const monotonic = isBull
            ? slopes[1] > slopes[0] && slopes[2] > slopes[1]
            : slopes[1] < slopes[0] && slopes[2] < slopes[1];
          if (!monotonic && r.flattening) nonMonotonicButFlagged++;
        }
      }
    }
    assert.ok(reads > 100, `only ${reads} fan reads`);
    assert.ok(nonMonotonicButFlagged > 0,
      'the F-15 discrepancy no longer reproduces -- the finding or the port changed');
  });
});

describe('Tier D — drivers and secular read', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the drivers table matches the oracle techPlan.drivers exactly', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let oracleThrew = 0;
    let portThrewToo = 0;
    let safeReturnedNull = 0;
    const notes = new Set<string>();

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [60, 120, 201, 250, 400, 1200, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const rawInd = oracle.call('computeAllIndicators', chart);
        const rawGann = oracle.call('computeGannInline', chart, rawInd);
        const conf = oracle.call('computeConfluenceTargets', rawInd, rawGann, null, chart);
        const ind = oracle.callNormalized<Indicators>('computeAllIndicators', chart);
        const gann = oracle.callNormalized<GannRead>('computeGannInline', chart, rawInd);

        let plan: { drivers: unknown; regime: Regime } | null = null;
        try {
          plan = oracle.call('computeTechnicalPlanV7', rawInd, rawGann, conf, chart, null);
        } catch {
          // F-14. The port must fail the SAME way, or the reproduction is
          // not faithful -- and the safe wrapper must absorb it.
          oracleThrew++;
          assert.throws(() => computeDrivers(ind, 'CHOP', gann), `${ticker}@${len} port should throw too`);
          portThrewToo++;
          assert.equal(computeDriversSafe(ind, 'CHOP', gann), null, `${ticker}@${len} safe variant`);
          safeReturnedNull++;
          continue;
        }
        if (!plan) continue;

        assert.deepStrictEqual(
          computeDrivers(ind, plan.regime, gann),
          structuredClone(plan.drivers),
          `${ticker}@${len} drivers`,
        );
        comparisons++;
        for (const d of plan.drivers as Array<{ label: string; note: string }>) {
          if (d.note) notes.add(d.label + '|' + d.note.slice(0, 28));
        }
      }
    }

    assert.ok(comparisons > 150, `only ${comparisons} driver tables compared`);
    assert.ok(notes.size > 100, `only ${notes.size} distinct notes seen`);
    // F-14 must still reproduce, and must reproduce symmetrically.
    assert.ok(oracleThrew > 0, 'F-14 no longer reproduces on any fixture');
    assert.equal(portThrewToo, oracleThrew);
    assert.equal(safeReturnedNull, oracleThrew);
  });

  test('the secular read matches the oracle and reaches all four verdicts', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let limitedHistory = 0;
    const verdicts = new Set<string>();
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      // 59 is deliberately one below the 60-bar floor.
      for (const len of [59, 60, 120, 201, 250, 400, 1200, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        // Explicit annotation: loadRawFixture's return is loosely typed, so
        // inferring this from buildChart(...).closes is circular (TS7022).
        const closes: readonly number[] = buildChart(raw, len).closes;
        const got = computeSecularRead(closes);
        assert.deepStrictEqual(got, oracle.callNormalized('computeSecularReadV7_', closes), `${ticker}@${len}`);
        comparisons++;
        if (got) {
          verdicts.add(got.verdict);
          if (got.why.includes('limited history')) limitedHistory++;
        }
      }
    }
    assert.ok(comparisons > 150, `only ${comparisons} comparisons`);
    assert.equal(verdicts.size, 4, `expected all four verdict arms, saw ${[...verdicts].join(' / ')}`);
    assert.ok(limitedHistory > 0, 'the sub-1000-bar "(limited history)" suffix never appeared');
  });

  test('the secular read guards and arithmetic are exactly the legacy ones', () => {
    const oracle = loadOracle();
    const cases: Array<[string, unknown]> = [
      ['not an array', null],
      ['string', 'nope'],
      ['59 bars', Array.from({ length: 59 }, (_, i) => 10 + i)],
      ['first is zero', [0, ...Array.from({ length: 70 }, () => 10)]],
      ['last is zero', [...Array.from({ length: 70 }, () => 10), 0]],
      ['all equal', Array.from({ length: 300 }, () => 25)],
    ];
    for (const [label, closes] of cases) {
      assert.deepStrictEqual(
        computeSecularRead(closes as number[]),
        oracle.callNormalized('computeSecularReadV7_', closes),
        label,
      );
    }
    // A flat series: zero CAGR, exactly AT the 200-week SMA. `aboveWk200`
    // uses >=, so equality counts as above -- which routes to MIXED, not NO.
    const flat = computeSecularRead(Array.from({ length: 300 }, () => 25));
    assert.ok(flat != null);
    assert.equal(flat.aboveWk200, true, '>= means equality counts as above');
    assert.equal(flat.cagr, 0);
    assert.equal(flat.pctVsWk200, 0);
    assert.ok(flat.verdict.startsWith('MIXED'));
    // yearsAvailable is BAR COUNT / 252, not the real date span. Flagged in
    // the module doc; pinned here so the approximation stays visible.
    assert.equal(flat.yearsAvailable, 300 / 252);
  });
});
