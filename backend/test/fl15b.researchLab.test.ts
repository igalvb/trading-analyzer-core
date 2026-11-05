/** FL-15b: the strategy lab -- each model trading one stock alone from the saved daily reads. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runLab, holdLab } from '../src/research/lab.ts';
import type { CompactRead } from '../src/research/computeReads.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
const s = { ticker: 'AAA', dates: days, opens: [10, 10, 12, 15, 15], highs: [10, 11, 13, 16, 16], lows: [10, 9.5, 11, 14, 14], closes: [10, 11, 14, 15, 16], volumes: [1, 1, 1, 1, 1], splits: [] } as PriceSeries;
const read = (d: string, over: Partial<CompactRead>): CompactRead => ({ d, ok: 1, c: 50, tm: 'WAIT_PULLBACK', ep: 10, st: 9, ec: 50, v: 'MAJORITY', dir: 'mmmmm', wy: null, lz: null, cl: 10, ...over });

describe('FL-15b — strategy lab', () => {
  test('a book model: bullish buys at the next open with all the money; cautionary sells at the next open; 25% tax', () => {
    const reads = new Map([
      ['2024-01-02', read('2024-01-02', { dir: 'mmmmb' })],
      ['2024-01-04', read('2024-01-04', { dir: 'mmmmc' })],
    ]);
    const r = runLab('turtle', s, reads, '2024-01-01', '2024-12-31', 1000);
    // 100 sh at 10 (01-03 open), sold at 15 (01-05 open): gain 500, tax 125
    assert.equal(r.finalTaxed, 1375);
    assert.equal(r.buys, 1);
  });


  test('LILO: staged limit buys on the engine\'s buy signal, staged sells at T1 and T2', () => {
    const reads = new Map([['2024-01-02', read('2024-01-02', { tm: 'BUY_NOW', c: 75, lz: [9.5, 10, 2, 13, 16] })]]);
    const r = runLab('lilo', s, reads, '2024-01-01', '2024-12-31', 1000);
    assert.equal(r.buys, 1);
    assert.ok(r.finalTaxed > 1000, 'bought at the rungs (10 and 9.5), sold half at 13 and the rest at 16');
  });

  test('holding: first open to last close, 25% tax on the gain', () => {
    assert.equal(holdLab(s, '2024-01-01', '2024-12-31', 1000), 1000 + 100 * 6 * 0.75);
  });
});

describe('FL-15b — never in cash (money not in the stock sits in QQQ)', () => {
  const qqq = { ticker: 'QQQ', dates: days, opens: [100, 100, 100, 100, 100], highs: [100, 100, 100, 100, 100], lows: [100, 100, 100, 100, 100], closes: [100, 101, 102, 103, 104], volumes: [1, 1, 1, 1, 1], splits: [] } as PriceSeries;
  test('no signal: the account is QQQ from the first open, same as holding QQQ', () => {
    const r = runLab('turtle', s, new Map(), '2024-01-01', '2024-12-31', 10_000, qqq);
    assert.equal(r.finalTaxed, holdLab(qqq, '2024-01-01', '2024-12-31', 10_000));
    assert.equal(r.investedPct, 0, 'never in the stock');
  });
  test('a buy signal sells QQQ (taxed) and buys the stock at the next open; a sell goes back into QQQ', () => {
    const reads = new Map([['2024-01-02', read('2024-01-02', { dir: 'mmmmb' })], ['2024-01-04', read('2024-01-04', { dir: 'mmmmc' })]]);
    const r = runLab('turtle', s, reads, '2024-01-01', '2024-12-31', 10_000, qqq);
    // QQQ 100 sh at 100, sold at 100 (no gain); stock 1000 sh at 10, sold at 15 (gain 5000, tax 1250); back into QQQ 137 sh at 100
    assert.equal(r.buys, 1);
    assert.ok(Math.abs(r.finalTaxed - (13_750 - 13_700 + 137 * 104 - 137 * 4 * 0.25)) < 1e-6);
  });
});
