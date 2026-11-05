/**
 * FL-10a: direct legacy-vs-port tests for four entry-plan helpers that were
 * only covered through computeTechnicalPlanV7:
 *   driftFactorV7, formatDurationV7, clusterBeyondV7_, computeStopRRV7.
 * Each legacy function is called by name in the oracle and compared with
 * deepStrictEqual against its port, over edge values (null, undefined, NaN,
 * boundaries) and sweeps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { driftFactor, formatDuration, clusterBeyond, computeStopRR } from '../src/analysis/techPlan/entryPlan.ts';

const ready = legacyFilesPresent();

function rngOf(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('FL-10a entry-plan helpers: direct oracle parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('driftFactor matches driftFactorV7 for every regime, including unknown values', () => {
    const oracle = loadOracle();
    const regimes: unknown[] = ['TREND_UP', 'TREND_DOWN', 'HIGH_VOL', 'CHOP', 'trend_up', '', 'SOMETHING_ELSE', null, undefined, 5, NaN];
    for (const r of regimes) {
      assert.deepStrictEqual(driftFactor(r as never), oracle.callNormalized('driftFactorV7', r), `regime ${String(r)}`);
    }
  });

  test('formatDuration matches formatDurationV7 on boundaries and a dense sweep', () => {
    const oracle = loadOracle();
    const edge: unknown[] = [null, undefined, 0, -0, -3, 0.4, 0.5, 1, 1.49, 1.5, 9.49, 9.5, 9.99, 10, 12.5, 44.9, 45, 100, 1000, NaN, Infinity, -Infinity];
    for (const d of edge) {
      assert.deepStrictEqual(formatDuration(d as never), oracle.callNormalized('formatDurationV7', d), `days ${String(d)}`);
    }
    let n = 0;
    for (let d = 0; d <= 300; d += 0.25) {
      assert.deepStrictEqual(formatDuration(d), oracle.callNormalized('formatDurationV7', d), `days ${d}`);
      n++;
    }
    assert.ok(n > 1000);
  });

  test('clusterBeyond matches clusterBeyondV7_ on random method lists, used-name sets and floors', () => {
    const oracle = loadOracle();
    const r = rngOf(11);
    let nonNull = 0;
    for (let k = 0; k < 400; k++) {
      const count = Math.floor(r() * 12);
      const methods = Array.from({ length: count }, (_, i) => ({
        name: 'M' + (i % 8), // duplicate names on purpose
        price: r() < 0.05 ? NaN : Math.round((50 + r() * 100) * 100) / 100,
        type: 'target',
      }));
      const used = new Set<string>();
      for (let i = 0; i < 8; i++) if (r() < 0.25) used.add('M' + i);
      const floor = r() < 0.1 ? -1 : 50 + r() * 100;
      const got = clusterBeyond(methods as never, new Set(used), floor);
      const expected = oracle.callNormalized('clusterBeyondV7_', methods, new Set(used), floor);
      assert.deepStrictEqual(got, expected, `case ${k}`);
      if (got) nonNull++;
    }
    assert.ok(nonNull > 50, `only ${nonNull} non-null clusters, test would be weak`);
  });

  test('clusterBeyond edge inputs: null, undefined, empty, zero prices, exact 7 percent spread', () => {
    const oracle = loadOracle();
    const cases: Array<[unknown, string[], number]> = [
      [null, [], 100],
      [undefined, [], 100],
      [[], [], 100],
      [[{ name: 'A', price: 50 }], [], 100],
      [[{ name: 'A', price: 50 }], ['A'], 10],
      [[{ name: 'A', price: 0 }, { name: 'B', price: 0.05 }], [], -1], // anchor 0 -> 0/0
      [[{ name: 'A', price: 100 }, { name: 'B', price: 107 }, { name: 'C', price: 107.01 }], [], 0], // 7% boundary
      [[{ name: 'A', price: 100 }, { name: 'B', price: 100 }], [], 99],
    ];
    for (const [methods, used, floor] of cases) {
      assert.deepStrictEqual(
        clusterBeyond(methods as never, new Set(used), floor),
        oracle.callNormalized('clusterBeyondV7_', methods, new Set(used), floor),
        JSON.stringify([methods, used, floor]),
      );
    }
  });

  test('computeStopRR matches computeStopRRV7 across regimes, ATRs and target positions', () => {
    const oracle = loadOracle();
    const regimes = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', 'OTHER', ''];
    const entries = [100, 0, -5, 37.25];
    const atrs = [10, 0, -2, 0.5, NaN];
    const targets: unknown[] = [null, { price: 120 }, { price: 80 }, { price: 100 }, { price: 37.25 }];
    let n = 0;
    for (const reg of regimes) for (const e of entries) for (const a of atrs) for (const t1 of targets) for (const t2 of targets) {
      assert.deepStrictEqual(
        computeStopRR(e, a, reg, t1 as never, t2 as never),
        oracle.callNormalized('computeStopRRV7', e, a, reg, t1, t2),
        JSON.stringify([e, a, reg, t1, t2]),
      );
      n++;
    }
    assert.ok(n > 2000);
  });
});
