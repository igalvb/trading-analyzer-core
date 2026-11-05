/** FL-12a (backlog 9): the backtest ledger (cash, FIFO, 25% tax), the day-by-day walk and the benchmarks, on mock data. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/backtest/ledger.ts';
import { runBacktest, type BacktestSources } from '../src/backtest/runner.ts';
import { buyAndHold } from '../src/backtest/benchmarks.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import type { EngineRead } from '../src/backtest/engineRun.ts';
import { read, exitRead, weekdays, synthSeries } from './fl12aFixtures.ts';

describe('FL-12a — ledger', () => {
  test('buy spends cash; overspending, fractions and shorting are refused', () => {
    const l = new Ledger(1000);
    l.buy('2024-01-02', 'A', 5, 100);
    assert.equal(l.cash, 500); assert.equal(l.shares('A'), 5); assert.deepEqual(l.held(), ['A']);
    assert.throws(() => l.buy('2024-01-02', 'B', 6, 100), /not enough cash/);
    assert.throws(() => l.buy('2024-01-02', 'B', 1.5, 10), /whole number/);
    assert.throws(() => l.sell('2024-01-03', 'A', 6, 100), /more shares than held/);
    assert.throws(() => l.sell('2024-01-03', 'Z', 1, 100), /more shares than held/);
  });

  test('FIFO: the oldest lot is sold first; tax is 25% of the sale gain, 0 on a loss', () => {
    const l = new Ledger(10_000);
    l.buy('2024-01-02', 'A', 10, 100);
    l.buy('2024-02-01', 'A', 10, 200);
    assert.equal(l.avgCost('A'), 150);
    const s1 = l.sell('2024-03-01', 'A', 15, 180); // 10 @100 + 5 @200 = 2000 cost, 2700 value
    assert.equal(s1.costBasis, 2000); assert.equal(s1.realizedGain, 700); assert.equal(s1.tax, 175);
    assert.equal(l.cash, 10_000 - 3000 + 2700 - 175);
    assert.equal(l.avgCost('A'), 200);
    const s2 = l.sell('2024-03-02', 'A', 5, 150); // loss of 250: no tax
    assert.equal(s2.realizedGain, -250); assert.equal(s2.tax, 0);
    assert.equal(l.taxPaid, 175); assert.equal(l.realized, 450); assert.deepEqual(l.held(), []);
  });

  test('untaxed ledger pays nothing; liquidation tax takes 25% of each open gain, 0 on a loss', () => {
    const u = new Ledger(1000, 0);
    u.buy('d', 'A', 1, 100);
    assert.equal(u.sell('d2', 'A', 1, 300).tax, 0);
    const l = new Ledger(1000);
    l.buy('d', 'A', 2, 100); l.buy('d', 'B', 1, 100);
    const px = (t: string): number => (t === 'A' ? 150 : 50);
    assert.equal(l.equity(px), 700 + 300 + 50);
    assert.equal(l.equityAfterLiquidationTax(px), 700 + 300 - 25 + 50);
  });
});

describe('FL-12a — the walk (mock engine)', () => {
  const days = weekdays('2024-01-01', 12);
  const mk = (): Map<string, PriceSeries> => new Map([
    ['SPY', synthSeries('SPY', days, () => 400)],
    ['AAA', synthSeries('AAA', days, (i) => 100 + i, (i) => 100.5 + i)],
    ['BBB', synthSeries('BBB', days, () => 50)],
    ['CCC', synthSeries('CCC', days, () => 20)],
  ]);

  test('signal at a close fills at the NEXT open; the exit read gets the real entry date and cost; EXIT sells all next open', async () => {
    const seen: Array<[string, string[]]> = [];
    const exitCalls: Array<[string, string, string, number]> = [];
    const src: BacktestSources = {
      async engineReads(day, tickers) {
        seen.push([day, [...tickers]]);
        return tickers.map((t) => read({ ticker: t, day, timing: t === 'AAA' && day === days[1] ? 'BUY_NOW' : 'WAIT_PULLBACK', finalConviction: 50 }));
      },
      exitRead(ticker, day, entryDate, entryPrice) {
        exitCalls.push([ticker, day, entryDate, entryPrice]);
        return exitRead({ ticker, day, actionClass: day === days[5] ? 'EXIT' : 'HOLD', recommendation: day === days[5] ? 'STOP HIT — EXIT' : 'HOLD' });
      },
    };
    const r = await runBacktest(mk(), src, { name: 't', universe: ['AAA', 'BBB'], start: days[0]!, end: days[11]!, cash: 100_000, policy: { maxPositions: 6 }, taxRate: 0.25, calendar: 'SPY' });
    assert.equal(r.days, 12);
    assert.deepEqual(r.trades.map((t) => [t.side, t.ticker, t.day, t.price]), [['BUY', 'AAA', days[2], 102], ['SELL', 'AAA', days[6], 106]]);
    // 1% of 100,000 x 0.75 = 750 risk / 5 = 150 shares.
    assert.equal(r.trades[0]!.shares, 150);
    assert.equal(r.trades[1]!.tax, 150 * 4 * 0.25);
    assert.deepEqual(exitCalls[0], ['AAA', days[2], days[2], 102]);
    assert.equal(exitCalls.length, 4, 'exit reads on days 2..5 only');
    assert.ok(seen.every(([d, ts]) => d !== days[11] && !(ts.includes('AAA') && d > days[1]! && d < days[6]!)), 'no engine run on the last day, none for a held ticker');
    assert.deepEqual(r.tickersBought, ['AAA']);
    assert.equal(r.finalEquity, r.finalCash);
    assert.equal(r.finalCash, 100_000 - 150 * 102 + 150 * 106 - 150);
  });

  test('max positions, cash cap and the end-of-2024 checkpoint count', async () => {
    const src: BacktestSources = {
      async engineReads(day, tickers) { return tickers.map((t): EngineRead => read({ ticker: t, day, entryPrice: 10, stop: 9, finalConviction: 100 })); },
      exitRead(ticker, day) { return exitRead({ ticker, day }); },
    };
    // Each order sizes 1% of 1,000 / $1 = 10 shares; at most 2 positions; cash 1,000 cannot pay 10 x $100 for AAA-like prices.
    const r = await runBacktest(mk(), src, { name: 't', universe: ['AAA', 'BBB', 'CCC'], start: days[0]!, end: days[11]!, cash: 1000, policy: { maxPositions: 2 }, taxRate: 0.25, calendar: 'SPY', checkpointDay: days[3]! });
    assert.equal(r.maxOpenPositions, 2);
    const buys = r.trades.filter((t) => t.side === 'BUY');
    assert.deepEqual(buys.map((t) => [t.ticker, t.shares]), [['AAA', 9], ['BBB', 1]], 'AAA is cut from 10 to 9 by cash; BBB gets what is left');
    assert.equal(r.cashCapped, 2);
    assert.equal(r.openAtCheckpoint, 2);
    assert.ok(r.skipped.some((s) => s.ticker === 'CCC' && s.reason === 'max 2 positions'));
  });

  test('a ticker that has not listed yet cannot be bought before its first bar', async () => {
    const late = synthSeries('NEW', days.slice(6), () => 10);
    const m = mk(); m.set('NEW', late);
    const src: BacktestSources = {
      async engineReads(day, tickers) { return tickers.map((t) => (m.get(t)!.dates[0]! <= day ? read({ ticker: t, day, entryPrice: 10, stop: 9 }) : read({ ticker: t, day, ok: false, finalConviction: null, aborted: 'no price data' }))); },
      exitRead(ticker, day) { return exitRead({ ticker, day }); },
    };
    const r = await runBacktest(m, src, { name: 't', universe: ['NEW'], start: days[0]!, end: days[11]!, cash: 1000, policy: { maxPositions: null }, taxRate: 0, calendar: 'SPY' });
    assert.equal(r.trades[0]!.day, days[7]);
    assert.equal(r.signalStats['no decision'], 6);
  });
});

describe('FL-12a — benchmarks', () => {
  test('equal weight, whole shares at the first open on or after the start, a late lister waits as cash; taxed = 25% of each gain', () => {
    const days = weekdays('2024-01-01', 10);
    const m = new Map<string, PriceSeries>([
      ['A', synthSeries('A', days, (i) => (i === 0 ? 10 : 20))],
      ['B', synthSeries('B', days.slice(4), () => 30, (i) => (i === 5 ? 15 : 30))],
    ]);
    const r = buyAndHold('bh', m, ['A', 'B'], '2024-01-01', days[9]!, 1000);
    assert.deepEqual(r.positions.map((p) => [p.ticker, p.buyDay, p.shares, p.buyPrice, p.endPrice]), [['A', days[0], 50, 10, 20], ['B', days[4], 16, 30, 15]]);
    assert.equal(r.untaxed, 1000 - 500 - 480 + 50 * 20 + 16 * 15);
    assert.equal(r.taxed, r.untaxed - 500 * 0.25);
  });
});
