/**
 * Broker Course BC-3 parity: Phase 14 (chart patterns) and Phase 5 (player
 * mapping), 14 functions.
 *
 * ══ ALL REAL DATA ═════════════════════════════════════════════════════
 * Unlike BC-1/BC-2, nothing here needed synthetic charts: across 27
 * fixtures, several end-trims and several lookbacks, all 9 pattern types
 * fire on real bars with every confirmation state, and all three player
 * tags occur. The few hand-built inputs below cover degenerate edges only
 * (flat, zero volume, null, too short), each probed on the oracle first.
 *
 * F-24 is asserted at SOURCE level: no legacy file calls any of Phase 14.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR, ORACLE_FILES } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  linearFitSlopeV1, doubleTopBottomReadV1, headAndShouldersReadV1, cupAndHandleReadV1,
  rectangleReadV1, triangleReadV1, chartPatternReadV1,
} from '../src/analysis/models/brokerCourse/patterns.ts';
import {
  linearFitRSquaredV1, staircasePatternReadV1, speculativeSpikeReadV1, noConsolidationReadV1,
  roundNumberIncrementV1, roundNumberProximityV1, playerMappingReadV1,
} from '../src/analysis/models/brokerCourse/playerMapping.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** End-trims applied to every fixture, so each detector sees many windows. */
const CUTS = [0, 7, 23, 61, 150, 333];

describe('Broker Course P14 — chart patterns', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every detector and the orchestrator match the oracle on every fixture', () => {
    const oracle = loadOracle();
    const detectors = [
      ['doubleTopBottomReadV1', doubleTopBottomReadV1],
      ['headAndShouldersReadV1', headAndShouldersReadV1],
      ['cupAndHandleReadV1', cupAndHandleReadV1],
      ['rectangleReadV1', rectangleReadV1],
      ['triangleReadV1', triangleReadV1],
    ] as const;
    const states = new Set<string>();
    const orchestratorTypes = new Set<string>();
    let comparisons = 0;
    let shadowed = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const cut of CUTS) {
        const len = raw.closes.length - cut;
        if (len < 30) continue;
        const ch = buildChart(raw, len);
        for (const lb of [20, 40, 60, 90, 120, 250]) {
          const fired: string[] = [];
          for (const [name, fn] of detectors) {
            const expected = oracle.callNormalized<{ type: string; confirmed?: boolean; status?: string } | null>(
              name, ch.highs, ch.lows, ch.closes, lb,
            );
            assert.deepStrictEqual(fn(ch.highs, ch.lows, ch.closes, lb), expected, `${ticker}@${len} ${name} lb=${lb}`);
            comparisons++;
            if (expected) {
              fired.push(expected.type);
              states.add(expected.type + ':' + (expected.confirmed ?? expected.status));
            }
          }
          const orch = chartPatternReadV1(ch.highs, ch.lows, ch.closes, lb);
          assert.deepStrictEqual(orch, oracle.callNormalized('chartPatternReadV1', ch.highs, ch.lows, ch.closes, lb));
          comparisons++;
          // The orchestrator is exactly "first detector that fires".
          assert.equal(orch?.type ?? null, fired[0] ?? null);
          if (orch) orchestratorTypes.add(orch.type);
          shadowed += Math.max(0, fired.length - 1);
        }
        // Default lookback: undefined and 0 both mean 60.
        for (const lb of [undefined, 0]) {
          assert.deepStrictEqual(chartPatternReadV1(ch.highs, ch.lows, ch.closes, lb),
            oracle.callNormalized('chartPatternReadV1', ch.highs, ch.lows, ch.closes, lb));
          assert.deepStrictEqual(chartPatternReadV1(ch.highs, ch.lows, ch.closes, lb),
            chartPatternReadV1(ch.highs, ch.lows, ch.closes, 60));
          comparisons++;
        }
      }
    }
    assert.ok(comparisons > 5000, `only ${comparisons} comparisons`);
    // All 9 types, on REAL charts, with both confirmation states for the
    // neckline/rim patterns and all three statuses for the rectangle.
    const expectedStates = [
      'DOUBLE_TOP:true', 'DOUBLE_TOP:false', 'DOUBLE_BOTTOM:true', 'DOUBLE_BOTTOM:false',
      'HEAD_AND_SHOULDERS:true', 'HEAD_AND_SHOULDERS:false',
      'INVERSE_HEAD_AND_SHOULDERS:true', 'INVERSE_HEAD_AND_SHOULDERS:false',
      'CUP_AND_HANDLE:true', 'CUP_AND_HANDLE:false',
      'RECTANGLE:BROKE_UP', 'RECTANGLE:BROKE_DOWN', 'RECTANGLE:FORMING',
      'TRIANGLE_SYMMETRIC:BROKE_UP', 'TRIANGLE_SYMMETRIC:BROKE_DOWN', 'TRIANGLE_SYMMETRIC:FORMING',
    ];
    for (const s of expectedStates) assert.ok(states.has(s), `never reached ${s}`);
    for (const t of ['TRIANGLE_ASCENDING', 'TRIANGLE_DESCENDING']) {
      assert.ok([...states].some((s) => s.startsWith(t + ':')), `never reached ${t}`);
    }
    // 9, not 8: six named patterns plus three triangle subtypes. (A first
    // draft asserted 8 -- the oracle's own output corrected it.)
    assert.equal(orchestratorTypes.size, 9, [...orchestratorTypes].join(','));
    // Priority order is load-bearing: lower-priority patterns are often
    // present and hidden. Measured at 358, not assumed.
    assert.ok(shadowed > 100, `only ${shadowed} shadowed detections`);
  });

  test('the slope helper normalises by the mean and refuses a zero mean', () => {
    const oracle = loadOracle();
    const cases: number[][] = [[], [5], [5, 5], [-1, 1], [1, 2, 3], [3, 2, 1], [100, 101, 103, 102], [0, 0, 0]];
    for (const v of cases) {
      assert.equal(linearFitSlopeV1(v), oracle.call('linearFitSlopeV1', v), JSON.stringify(v));
    }
    assert.equal(linearFitSlopeV1([1, 2, 3]), 0.5, 'slope 1 over mean 2');
    assert.equal(linearFitSlopeV1([5, 5]), 0, 'flat is 0, not null');
    assert.equal(linearFitSlopeV1([-1, 1]), null, 'a zero mean refuses rather than dividing');
  });

  test('F-24: the whole of Phase 14 has no caller anywhere in the ten legacy files', () => {
    // Source-level, comment-stripped: every occurrence of a P14 name.
    const names = ['chartPatternReadV1', 'doubleTopBottomReadV1', 'headAndShouldersReadV1',
      'cupAndHandleReadV1', 'rectangleReadV1', 'triangleReadV1', 'linearFitSlopeV1'];
    const counts: Record<string, Record<string, number>> = {};
    for (const file of ORACLE_FILES) {
      const code = fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      for (const nm of names) {
        const hits = code.match(new RegExp('\\b' + nm + '\\s*\\(', 'g'))?.length ?? 0;
        if (hits) (counts[nm] ??= {})[file] = hits;
      }
    }
    // The orchestrator appears once: its own definition.
    assert.deepStrictEqual(counts.chartPatternReadV1, { 'brokerCourseModelV1.gs': 1 });
    // Each detector: its definition plus the orchestrator's call, nothing else.
    for (const nm of names.slice(1, 6)) {
      assert.deepStrictEqual(counts[nm], { 'brokerCourseModelV1.gs': 2 }, nm);
    }
    // The slope helper: definition plus triangleReadV1's two calls.
    assert.deepStrictEqual(counts.linearFitSlopeV1, { 'brokerCourseModelV1.gs': 3 });
  });
});

describe('Broker Course P5 — player mapping', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('staircase, spike, no-consolidation and the tag match on every fixture', () => {
    const oracle = loadOracle();
    const tags = new Set<string>();
    let comparisons = 0;
    let stairs = 0;
    let spikes = 0;
    let both = 0;
    const consolidation = new Set<boolean>();
    let twinComparisons = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const cut of [...CUTS, 700, 1500]) {
        const len = raw.closes.length - cut;
        if (len < 30) continue;
        const ch = buildChart(raw, len);
        for (const lb of [3, 5, 10, 20, 40]) {
          const s = staircasePatternReadV1(ch.closes, ch.volumes, lb);
          const sp = speculativeSpikeReadV1(ch.closes, ch.volumes, lb);
          const c = noConsolidationReadV1(ch.highs, ch.lows, lb);
          assert.deepStrictEqual(s, oracle.callNormalized('staircasePatternReadV1', ch.closes, ch.volumes, lb), `${ticker}@${len} stair lb=${lb}`);
          assert.deepStrictEqual(sp, oracle.callNormalized('speculativeSpikeReadV1', ch.closes, ch.volumes, lb), `${ticker}@${len} spike lb=${lb}`);
          assert.deepStrictEqual(c, oracle.callNormalized('noConsolidationReadV1', ch.highs, ch.lows, lb), `${ticker}@${len} cons lb=${lb}`);
          comparisons += 3;
          if (s?.isStaircase) stairs++;
          if (sp?.isSpike) spikes++;
          if (s?.isStaircase && sp?.isSpike) both++;
          if (c) consolidation.add(c.hasNoConsolidation);

          // The engine's own copy (speculativeSpikeV7, :9531) agrees on
          // every number; only the read text differs.
          const eng = oracle.call<{ isSpike: boolean; top2ShareOfMove: number; hasExtremeVolDay: boolean } | null>(
            'speculativeSpikeV7', ch.closes, ch.volumes, len, lb);
          assert.deepStrictEqual(
            sp && [sp.isSpike, sp.top2ShareOfMove, sp.hasExtremeVolDay],
            eng && [eng.isSpike, eng.top2ShareOfMove, eng.hasExtremeVolDay],
            `${ticker}@${len} spike twin lb=${lb}`);
          twinComparisons++;
        }
        for (const lb of [undefined, 0, 5, 20, 40]) {
          const expected = oracle.callNormalized<{ tag: string }>('playerMappingReadV1',
            ch.closes, ch.highs, ch.lows, ch.volumes, ch.currentPrice, lb);
          assert.deepStrictEqual(playerMappingReadV1(ch.closes, ch.highs, ch.lows, ch.volumes, ch.currentPrice, lb),
            expected, `${ticker}@${len} mapping lb=${lb}`);
          comparisons++;
          tags.add(expected.tag);
        }
      }
    }
    assert.ok(comparisons > 3000, `only ${comparisons} comparisons`);
    assert.ok(twinComparisons > 500);
    assert.deepStrictEqual([...tags].sort(),
      ['Institutional-Accumulation-Signature', 'Mixed/Unclear', 'Speculative-Spike']);
    assert.ok(stairs > 0 && spikes > 0);
    assert.deepStrictEqual([...consolidation].sort(), [false, true]);
    // Never both, and not by luck: staircase needs maxVol < 3x avg and the
    // spike needs some day >= 3x avg, over the identical window. So the
    // "staircase wins" ordering in playerMappingReadV1 can never matter.
    assert.equal(both, 0);
  });

  test('round numbers: course increments, a 2% tolerance, and the engine twin', () => {
    const oracle = loadOracle();
    const prices = [null, undefined, 0, -3, 0.2, 0.26, 1, 4.74, 4.75, 4.99, 5, 9.8, 9.99, 10, 98, 99.99,
      100, 999, 1000, 1499, 1500, 25000];
    for (const p of prices) {
      for (const tol of [undefined, null, 0.01, 0.02, 0.03]) {
        assert.deepStrictEqual(roundNumberProximityV1(p, tol),
          oracle.callNormalized('roundNumberProximityV1', p, tol), `price=${p} tol=${tol}`);
      }
      if (p != null && p > 0) {
        assert.equal(roundNumberIncrementV1(p), oracle.call('roundNumberIncrementV1', p));
        // The comment's claim of matching the engine's increments is true.
        assert.equal(roundNumberIncrementV1(p), oracle.call('roundLevelIncrementV7', p), `increment ${p}`);
      }
    }
    assert.equal(roundNumberProximityV1(0), null);
    assert.equal(roundNumberProximityV1(4.3)?.nearestRound, 4.5, 'half-dollar steps below $5');
    assert.equal(roundNumberProximityV1(4.75)?.nearestRound, 5, 'Math.round rounds the half up');
    // Below $0.25 the "nearest round number" is 0: 100% away, never near.
    assert.deepStrictEqual(roundNumberProximityV1(0.2)?.nearestRound, 0);
    assert.equal(roundNumberProximityV1(0.2)?.distPct, 1);
    // 98 is 2.04% from 100: just outside the 2% default.
    assert.equal(roundNumberProximityV1(98)?.isNearRoundNumber, false);
    assert.equal(roundNumberProximityV1(98, 0.03)?.isNearRoundNumber, true);

    // The engine's own round-number read (:7730) uses 3% on the last close;
    // this one uses 2% on the live quote. Measured on real prices: they
    // disagree, always in the same direction.
    let compared = 0;
    const disagreements: string[] = [];
    for (const ticker of listFixtures()) {
      const raw = loadRawFixture(ticker);
      for (const cut of [...CUTS, 700, 1500]) {
        const len = raw.closes.length - cut;
        if (len < 30) continue;
        const ch = buildChart(raw, len);
        const mine = roundNumberProximityV1(ch.currentPrice, 0.02)!;
        const eng = oracle.call<{ near: boolean }>('roundNumberProximityV7', ch.closes[len - 1], 0.03);
        compared++;
        if (mine.isNearRoundNumber !== eng.near) {
          disagreements.push(`${ticker}@${len}:${mine.isNearRoundNumber ? 'broker' : 'engine'}`);
        }
      }
    }
    assert.equal(compared, 224); // 200 before the GBTC/BTC/FBTC/BITB fixtures were added (+24); the 11 disagreements are unchanged
    assert.equal(disagreements.length, 11, disagreements.join(' '));
    assert.ok(disagreements.every((d) => d.endsWith(':engine')), 'only the engine (wider band) says near');
  });

  test('edge guards: the R-squared helper, the volumes guard asymmetry, and a mapping that is never null', () => {
    const oracle = loadOracle();
    for (const v of [[1, 2], [3, 3, 3], [1, 2, 4], [4, 2, 1], [1, 3, 2, 5]]) {
      assert.equal(linearFitRSquaredV1(v), oracle.call('linearFitRSquaredV1', v), JSON.stringify(v));
    }
    assert.equal(linearFitRSquaredV1([1, 2]), null, 'needs 3 points');
    assert.equal(linearFitRSquaredV1([3, 3, 3]), null, 'a flat series has no fit');

    // A flat window refuses in BOTH reads (no fit / no move).
    assert.equal(staircasePatternReadV1([10, 10, 10, 10], [1, 1, 1, 1], 4), null);
    assert.equal(speculativeSpikeReadV1([10, 10, 10], [1, 1, 1], 3), null);
    // Zero volume can never be a staircase: avgVol > 0 is required.
    const zeroVol = staircasePatternReadV1([1, 2, 3, 4, 5], [0, 0, 0, 0, 0], 5);
    assert.deepStrictEqual(zeroVol, oracle.callNormalized('staircasePatternReadV1', [1, 2, 3, 4, 5], [0, 0, 0, 0, 0], 5));
    assert.equal(zeroVol?.noVolumeSpike, false);
    // The spike read guards a missing volumes array; the staircase read
    // does not, and throws. Production volumes are never null
    // (fetchYahooChartRaw_ writes `volume || 0`), so this stays latent.
    assert.equal(speculativeSpikeReadV1([1, 2, 3], null, 3), null);
    assert.throws(() => staircasePatternReadV1([1, 2, 3], null as unknown as number[], 3), TypeError);
    assert.throws(() => oracle.call('staircasePatternReadV1', [1, 2, 3], null, 3));

    // playerMappingReadV1 NEVER returns null -- even with every input
    // missing it returns a Mixed/Unclear tag with no evidence. So the
    // engine's own `else setStatusV7(..., 'degraded', 'playerMappingReadV1
    // returned null')` branch (fullStockAnalysisV10_9.gs:1223) is
    // unreachable.
    const empty = playerMappingReadV1(null, null, [], [], null);
    assert.deepStrictEqual(empty, { tag: 'Mixed/Unclear', evidence: [] });
    assert.deepStrictEqual(empty, oracle.callNormalized('playerMappingReadV1', null, null, [], [], null));
    assert.equal(noConsolidationReadV1(null, [], 5), null);
  });
});
