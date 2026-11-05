/**
 * FL-12a: every backtest trade is also compared with holding QQQ over the same days (owner rule 2026-10-27).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundTripsVsQqq, vsQqqLine, tradeLogCsv } from '../src/backtest/run.ts';
import type { BacktestResult } from '../src/backtest/runner.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const qqq = { ticker: 'QQQ', dates: ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'], opens: [100, 101, 105, 110], highs: [], lows: [], closes: [], volumes: [] } as unknown as PriceSeries;
const trade = (day: string, side: 'BUY' | 'SELL', ticker: string, shares: number, price: number) =>
  ({ day, side, ticker, shares, price, value: shares * price, costBasis: null, realizedGain: null, tax: null, cashAfter: 0, note: '' });
const result = { trades: [
  trade('2024-01-02', 'BUY', 'AAA', 10, 50),
  trade('2024-01-04', 'SELL', 'AAA', 5, 60), // part sale: the trip is still open
  trade('2024-01-05', 'SELL', 'AAA', 5, 40),
  trade('2024-01-03', 'BUY', 'BBB', 2, 10),   // never closed
] } as unknown as BacktestResult;

describe('FL-12a — backtest vs QQQ per trade', () => {
  test('one round trip from the first buy to the sell that empties it, next to QQQ over the same fill days', () => {
    const trips = roundTripsVsQqq(result, qqq);
    assert.equal(trips.length, 1);
    assert.deepEqual({ ...trips[0], tradePct: Number(trips[0]!.tradePct.toFixed(6)) }, { ticker: 'AAA', buyDay: '2024-01-02', sellDay: '2024-01-05', tradePct: 0, qqqPct: 10.000000000000009 });
    assert.match(vsQqqLine(trips), /beat QQQ in 0 of 1; average trade \+0\.0%, QQQ over the same days \+10\.0%/);
  });

  test('the trade log puts the trip and QQQ numbers on the closing sell only', () => {
    const csv = tradeLogCsv(result, roundTripsVsQqq(result, qqq)).trim().split('\n');
    assert.match(csv[0]!, /trip_return_pct,qqq_same_days_pct$/);
    assert.match(csv[2]!, /,,$/);
    assert.match(csv[3]!, /,0(\.00)?,10\.00$/);
  });
});

import { planBuys } from '../src/backtest/policy.ts';

describe('FL-12a — all-money variant', () => {
  test('allIn sizes the buy to the whole account; the default keeps the engine size', () => {
    const read = { ticker: 'AAA', day: '2024-01-02', ok: true, finalConviction: 80, timing: 'BUY_NOW', blocked: false, verdict: 'MAJORITY', entryPrice: 100, stop: 90 } as never;
    const state = { equity: 100_000, held: new Set<string>(), openAfterExits: 0 };
    const engine = planBuys(state, [read], { maxPositions: null }).orders[0]!;
    const all = planBuys(state, [read], { maxPositions: null, allIn: true }).orders[0]!;
    assert.equal(all.plannedShares, 1000);
    assert.ok(engine.plannedShares < all.plannedShares);
  });
});
