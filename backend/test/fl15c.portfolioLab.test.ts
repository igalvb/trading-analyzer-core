/** FL-15c: the portfolio lab -- one account, a bag of stocks, slots, empty slots in QQQ. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolio, holdBag, type PortfolioInput } from '../src/research/portfolioLab.ts';
import { randomBags } from '../src/research/portfolioCli.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import type { CompactRead } from '../src/research/computeReads.ts';

const days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
const ser = (t: string, closes: number[], opens = closes): PriceSeries => ({ ticker: t, dates: days, opens, highs: closes, lows: closes, closes, volumes: closes.map(() => 1), splits: [] });
const read = (d: string, dir: string): CompactRead => ({ d, ok: 1, c: 50, tm: 'WAIT_PULLBACK', ep: null, st: null, ec: null, v: 'MAJORITY', dir, wy: null, lz: null, cl: null });

describe('FL-15c — portfolio lab', () => {
  const inp = (dirs: Record<string, string>): PortfolioInput => ({
    series: new Map([['AAA', ser('AAA', [10, 10, 12, 15, 15])], ['BBB', ser('BBB', [20, 20, 20, 20, 20])]]),
    reads: new Map([['AAA', new Map(Object.entries(dirs).map(([d, x]) => [d, read(d, x)]))], ['BBB', new Map()]]),
    qqq: ser('QQQ', [100, 100, 100, 100, 100]),
  });
  test('no signal: all in QQQ from the first open', () => {
    const r = runPortfolio('turtle', ['AAA', 'BBB'], inp({}), '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000 });
    assert.equal(r.finalTaxed, 100_000);
    assert.equal(r.qqqShare, 100);
  });
  test('a buy fills one slot (20%) funded from QQQ; the sell goes back into QQQ; tax on the stock gain', () => {
    const r = runPortfolio('turtle', ['AAA', 'BBB'], inp({ '2024-01-02': 'mmmmb', '2024-01-04': 'mmmmc' }), '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000 });
    // 2000 sh AAA at 10 (01-03), sold at 15 (01-05): gain 10,000, tax 2,500
    assert.equal(r.trades, 2);
    assert.ok(Math.abs(r.finalTaxed - 107_500) < 1e-6);
  });
  test('holding the bag equally, and the random bags are the same on every run', () => {
    assert.ok(Math.abs(holdBag(['AAA', 'BBB'], inp({}), '2024-01-01', '2024-12-31', 100_000) - (100_000 + 5000 * 5 * 0.75)) < 1e-6);
    assert.deepEqual(randomBags(['A', 'B', 'C', 'D', 'E'], 3, 2), randomBags(['A', 'B', 'C', 'D', 'E'], 3, 2));
  });
});

describe('FL-15c — levers', () => {
  const up = (t: string) => ({ ticker: t, dates: Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10)), opens: Array.from({ length: 300 }, (_, i) => 10 + i * 0.1), highs: Array.from({ length: 300 }, (_, i) => 10 + i * 0.1), lows: Array.from({ length: 300 }, (_, i) => 10 + i * 0.1), closes: Array.from({ length: 300 }, (_, i) => 10 + i * 0.1), volumes: Array.from({ length: 300 }, () => 1), splits: [] }) as PriceSeries;
  const flatQ = (): PriceSeries => { const s = up('QQQ'); return { ...s, opens: s.opens.map(() => 100), closes: s.closes.map(() => 100), highs: s.highs.map(() => 100), lows: s.lows.map(() => 100) }; };
  test('Trend model buys a stock in a rising trend once the 150-day average exists, and keeps it', () => {
    const a = up('AAA');
    const r = runPortfolio('trend', ['AAA'], { series: new Map([['AAA', a]]), reads: new Map(), qqq: flatQ() }, a.dates[0]!, a.dates[299]!, { slots: 1, cash: 100_000 });
    assert.equal(r.trades, 1, 'one buy, never sold');
    assert.ok(r.finalTaxed > 100_000);
  });
  test('fill mode keeps the slots full with the strongest stocks', () => {
    const a = up('AAA');
    const r = runPortfolio('trend', ['AAA'], { series: new Map([['AAA', a]]), reads: new Map(), qqq: flatQ() }, a.dates[0]!, a.dates[299]!, { slots: 1, cash: 100_000, rebalanceDays: 5 });
    assert.ok(r.avgStocksHeld > 0.4, 'held from the first rebalance after the start');
  });
});
