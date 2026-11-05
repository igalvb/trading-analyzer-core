/**
 * FL-7b1: the Phase-4 ladders and the two context reads, differential against
 * the oracle over input grids (null, zero, NaN, strings, tier edges).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import {
  computeStockEntryLadder, ladderDisplayPercents, computeStockExitLadder, computeOptionsEntryLadder, computeOptionsExitLadder,
  optionsLadderTimeDecayNote, optionsExpiryFlag,
} from '../src/analysis/ladders.ts';
import { doubleTopBottomMarketCapContext, shortSqueezeSetup } from '../src/analysis/signals.ts';

const ready = legacyFilesPresent();

describe('FL-7b1 — ladders and context reads', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const o = () => loadOracle();
  const same = (name: string, port: unknown, ...args: unknown[]) => assert.deepStrictEqual(structuredClone(port), o().callNormalized(name, ...structuredClone(args)), name + ' ' + JSON.stringify(args));

  test('entry ladder, options entry ladder, display percents', () => {
    // 1000 stands in for the unbounded counts of F-B4 (1e21 would not terminate)
    const counts: unknown[] = [0, 1, 2, 3, 4, 5, 7, 12, 2.5, -1, '3', null, undefined, NaN, Infinity, 1000];
    const zones: Array<[number | undefined, number | undefined]> = [[90, 100], [100, 100], [100, 90], [undefined, 100], [90, undefined], [NaN, 5], [0, 0.5]];
    let nonEmpty = 0, empty = 0, nan = 0;
    for (const c of counts) for (const [low, high] of zones) {
      const conf = { entryCount: c, entryLow: low, entryHigh: high } as never;
      const port = computeStockEntryLadder(conf);
      same('computeStockEntryLadderV7', port, conf);
      same('computeOptionsEntryLadderV7', computeOptionsEntryLadder(conf), conf);
      same('ladderDisplayPercentsV7_', ladderDisplayPercents(port), port);
      if (port.length) nonEmpty++; else empty++;
      if (port.some((r) => Number.isNaN(r.price))) nan++;
    }
    assert.ok(nonEmpty > 40 && empty > 40 && nan > 5, 'guard: ' + [nonEmpty, empty, nan]);
    same('computeStockEntryLadderV7', computeStockEntryLadder({} as never), {});
    same('ladderDisplayPercentsV7_', ladderDisplayPercents([]), []);
    const odd = [{ portion: 0.333 }, { portion: 0.3335 }, { portion: 0.3335 }];
    same('ladderDisplayPercentsV7_', ladderDisplayPercents(odd), odd);
    let residual = 0;
    for (let n = 1; n <= 30; n++) {
      const r = computeStockEntryLadder({ entryCount: n, entryLow: 1, entryHigh: 2 });
      const p = ladderDisplayPercents(r);
      same('ladderDisplayPercentsV7_', p, r);
      assert.equal(p.reduce((a, b) => a + b, 0), 100);
      if (p[p.length - 1] !== p[0]) residual++;
    }
    assert.ok(residual > 5, 'guard: the residual lands on the last rung for several n (' + residual + ')');
  });

  test('exit ladders, the time-decay note, the expiry flag', () => {
    const plans: unknown[] = [{}, { t1: { price: 10 } }, { t2: { price: 5 } }, { t1: { price: 10 }, t2: { price: 12 } }, { t1: 0, t2: { price: 3 } }, { t1: null, t2: null }, { t1: {}, t2: { price: 0 } }, { t1: 5 }, { t2: 'x' }, { t1: { price: NaN } }];
    const sizes = new Set<number>();
    for (const p of plans) {
      const port = computeStockExitLadder(p as never);
      same('computeStockExitLadderV7', port, p);
      same('computeOptionsExitLadderV7', computeOptionsExitLadder(p as never), p);
      sizes.add(port.length);
    }
    assert.deepEqual([...sizes].sort(), [0, 1, 2], 'guard: empty, one and two rungs');
    assert.equal(optionsLadderTimeDecayNote(), o().call('optionsLadderTimeDecayNoteV7'));
    let flagged = 0, plain = 0;
    for (const d of [null, undefined, 0, 1, 7, 44.5, 45, 45.0001, 46, 90, -3, '30', '50', NaN, 1e9, -Infinity]) {
      const port = optionsExpiryFlag(d as never);
      same('optionsExpiryFlagV7', port, d);
      if (port) flagged++; else plain++;
    }
    assert.ok(flagged >= 8 && plain >= 5, 'guard: ' + [flagged, plain]);
  });

  test('doubleTopBottomMarketCapContext: every tier edge, both pattern types, every falsy input', () => {
    const caps: unknown[] = [null, undefined, 0, NaN, -5, 1, 299999999, 300e6, 1.99e9, 2e9, 9.99e9, 10e9, 199.9e9, 200e9, 3e12, '5e9', '0'];
    const tiers = new Set<string>();
    let nulls = 0, rt = 0;
    for (const p of ['DOUBLE_TOP', 'DOUBLE_BOTTOM', 'HEAD_SHOULDERS', null, undefined, '']) for (const c of caps) for (const b of [undefined, null, 0, 12]) {
      const port = doubleTopBottomMarketCapContext(p as never, c as never, b as never);
      same('doubleTopBottomMarketCapContextV7', port, p, c, b);
      if (port) { tiers.add(port.tier); if (port.roundTripBars === 12) rt++; } else nulls++;
    }
    assert.deepEqual([...tiers].sort(), ['Large', 'Mega', 'Micro', 'Mid', 'Small'], 'guard: all five tiers');
    assert.ok(nulls > 40 && rt > 5);
  });

  test('shortSqueezeSetup: the 20% floor, the 3% band, null arguments', () => {
    let trig = 0, notTrig = 0, nulls = 0, nearHigh = 0;
    for (const s of [null, undefined, 0, 0.19, 0.2, 0.2001, 0.45, NaN, 1.5, '0.3']) for (const p of [null, undefined, 0, 96.99, 97, 97.0000001, 100, 120, 'x']) for (const h of [null, undefined, 0, 100, -1, 1000]) {
      const port = shortSqueezeSetup(s as never, p as never, h as never);
      same('shortSqueezeSetupV7', port, s, p, h);
      if (!port) nulls++; else if (port.triggered) trig++; else { notTrig++; if (port.atNewHigh) nearHigh++; }
    }
    assert.ok(trig > 5 && notTrig > 20 && nulls > 20 && nearHigh > 5, 'guard: ' + [trig, notTrig, nulls, nearHigh]);
  });
});
