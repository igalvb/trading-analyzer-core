/**
 * Fix plan 2026-10-30 B1/D2 (research option, default OFF): T1 = the nearest valid target cluster at least 1 ATR
 * above the entry, T2 = the next cluster, excluded methods skipped. Today's rule stays the default.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExitTargets, deriveNearestExitTargets } from '../src/analysis/techPlan/entryPlan.ts';
import type { ConfluenceMethod, ConfluenceTargets } from '../src/analysis/confluence.ts';
import { runLab } from '../src/research/lab.ts';
import type { CompactRead } from '../src/research/computeReads.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const m = (name: string, price: number, excluded = false): ConfluenceMethod => ({ name, price, type: 'target', ...(excluded ? { excluded: true, exclusionReason: 'test' } : {}) });

/** Entry 100, ATR 5. The biggest cluster (150-155) is far; a small valid one sits at 110-112; 200 is excluded. */
function confluence(): ConfluenceTargets {
  const all = [m('A', 104, true), m('B', 110), m('C', 112), m('D', 150), m('E', 152), m('F', 155), m('G', 200, true)];
  const biggest = all.filter((x) => ['D', 'E', 'F'].includes(x.name));
  return {
    entryLow: 98, entryHigh: 102, entryCenter: 100, entryConfidence: 'x', entryCount: 2, entryMethods: [], allEntryMethods: [],
    exitLow: 150, exitHigh: 155, exitCenter: 152.33333333333334, exitConfidence: 'x', exitCount: 3, exitMethods: biggest, allExitMethods: all,
  };
}

describe('B1/D2 — nearest-cluster exit targets (research option)', () => {
  test('default (no option): today\'s rule, T1 = the biggest cluster, T2 may reuse an excluded method', () => {
    const a = deriveExitTargets(confluence(), 5, 100);
    const b = deriveExitTargets(confluence(), 5, 100, {});
    assert.deepEqual(a, b);
    assert.deepEqual(a.t1.basis, ['D', 'E', 'F']);
    assert.deepEqual(a.t2?.basis, ['G'], 'the legacy T2 reuses the excluded method G');
  });

  test('nearestTargets: T1 = the nearest valid cluster 1 ATR above the entry, T2 = the next, excluded skipped', () => {
    const r = deriveExitTargets(confluence(), 5, 100, { nearestTargets: true });
    assert.deepEqual(r.t1.basis, ['B', 'C']);
    assert.equal(r.t1.price, 111);
    assert.deepEqual(r.t2?.basis, ['D', 'E', 'F']);
    assert.equal(r.t1.promoted, undefined);
  });

  test('a method exactly 1 ATR above the entry counts; one below it does not', () => {
    const c = confluence();
    c.allExitMethods = [m('X', 104.9), m('Y', 105), m('Z', 140)];
    const r = deriveNearestExitTargets(c, 5, 100)!;
    assert.deepEqual(r.t1.basis, ['Y']);
    assert.deepEqual(r.t2?.basis, ['Z']);
  });

  test('no valid method at or beyond the floor: today\'s rule is kept', () => {
    const c = confluence();
    c.allExitMethods = [m('X', 103), m('Y', 120, true)];
    assert.equal(deriveNearestExitTargets(c, 5, 100), null);
    assert.deepEqual(deriveExitTargets(c, 5, 100, { nearestTargets: true }), deriveExitTargets(c, 5, 100));
  });
});

describe('B1/D2 — one-stock lab options', () => {
  const days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
  const s = { ticker: 'AAA', dates: days, opens: [10, 10, 12, 15, 15], highs: [10, 11, 13, 16, 16], lows: [10, 9.5, 11, 14, 14], closes: [10, 11, 14, 15, 16], volumes: [1, 1, 1, 1, 1], splits: [] } as PriceSeries;
  const read = (d: string, dir: string): CompactRead => ({ d, ok: 1, c: 50, tm: 'WAIT_PULLBACK', ep: 10, st: 9, ec: 50, v: 'MAJORITY', dir, wy: null, lz: null, cl: 10 });
  const reads = new Map([['2024-01-02', read('2024-01-02', 'mmmmb')], ['2024-01-04', read('2024-01-04', 'mmmmc')]]);

  test('costBps 0 = today exactly; costBps 10 is charged on the buy and the sell; the deepest fall is reported', () => {
    const plain = runLab('turtle', s, reads, '2024-01-01', '2024-12-31', 1000);
    assert.equal(runLab('turtle', s, reads, '2024-01-01', '2024-12-31', 1000, undefined, { costBps: 0 }).finalTaxed, plain.finalTaxed);
    const c = runLab('turtle', s, reads, '2024-01-01', '2024-12-31', 1000, undefined, { costBps: 10 });
    // 99 sh at 10.01 (990.99 basis), sold at 15 less 0.1%: 1483.515, gain 492.525, tax 123.13
    assert.ok(Math.abs(c.finalTaxed - (1000 - 990.99 + 1483.515 - 492.525 * 0.25)) < 1e-6);
    // peak 1,400 at the 01-04 close; 1,375 once sold and taxed
    assert.ok(Math.abs(plain.maxDrawdownPct - (1 - 1375 / 1400) * 100) < 1e-9);
  });
});
