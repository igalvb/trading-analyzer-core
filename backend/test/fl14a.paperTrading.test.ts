/**
 * FL-14a: the 1-year forward paper test (owner, 2026-10-28). One closed day per call: fill yesterday's orders at
 * today's open, decide at today's close; the close before the start only decides.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newPaperState, paperDay, standings, PAPER_CASH, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { loadPaper, savePaper, paperTabRows } from '../src/paper/paperJob.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';

const read = (ticker: string, day: string, dirs: Record<string, string>, extra: Partial<EngineRead> = {}): EngineRead => ({
  ticker, day, ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90,
  ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: dirs, close: 100, ...extra,
});
const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
const day = (d: string, px: Record<string, [number, number]>, reads: EngineRead[]): PaperDayInput => ({
  day: d, bars: Object.fromEntries(Object.entries(px).map(([t, [o, c]]) => [t, { open: o, close: c }])), reads, exitRead: noExit,
});

describe('FL-14a — paper test', () => {
  test('the close before the start only decides; the first buys fill at the start open with the benchmarks', () => {
    const s = newPaperState(['AAA', 'BBB']);
    const t0 = paperDay(s, day('2026-10-28', { AAA: [100, 100], BBB: [50, 50], QQQ: [500, 500] }, [read('AAA', '2026-10-28', { turtle: 'bullish' }), read('BBB', '2026-10-28', {})]));
    assert.deepEqual(t0, []);
    assert.equal(s.marks.length, 0);
    assert.equal(s.benchmarks, null);
    assert.equal(s.accounts.turtle.pendingBuys.length, 1);
    const t1 = paperDay(s, day('2026-10-29', { AAA: [110, 120], BBB: [50, 55], QQQ: [500, 510] }, [read('AAA', '2026-10-29', { turtle: 'mixed' }), read('BBB', '2026-10-29', {})]));
    assert.deepEqual(t1.map((t) => [t.strategy, t.side, t.ticker, t.shares, t.price]), [['turtle', 'BUY', 'AAA', 151, 110]], 'one sixth of $100,000 at the open');
    assert.equal(s.benchmarks!.qqq.shares.QQQ, 200);
    assert.equal(s.marks.length, 1);
  });

  test('a cautionary read sells at the next open with 25% tax on the gain; a day is never handled twice', () => {
    const s = newPaperState(['AAA']);
    paperDay(s, day('2026-10-29', { AAA: [100, 100], QQQ: [500, 500] }, [read('AAA', '2026-10-29', { turtle: 'bullish' })]));
    paperDay(s, day('2026-10-30', { AAA: [100, 110], QQQ: [500, 500] }, [read('AAA', '2026-10-30', { turtle: 'cautionary' })]));
    assert.equal(s.accounts.turtle.pendingSells.length, 1);
    const sold = paperDay(s, day('2026-11-02', { AAA: [120, 120], QQQ: [500, 500] }, [read('AAA', '2026-11-02', {})]));
    const sell = sold.find((t) => t.side === 'SELL')!;
    assert.equal(sell.shares, 166);
    assert.equal(sell.tax, 166 * 20 * 0.25);
    assert.equal(s.accounts.turtle.cash, PAPER_CASH + 166 * 20 * 0.75);
    assert.deepEqual(paperDay(s, day('2026-11-02', { AAA: [1, 1], QQQ: [1, 1] }, [])), [], 'same day again: nothing');
  });

  test('the engine strategies buy on the Buy report tier 1; "current" holds off when the models disagree', () => {
    const s = newPaperState(['AAA']);
    const strong = read('AAA', '2026-10-29', {}, { timing: 'BUY_NOW', finalConviction: 75, verdict: 'NO_CONSENSUS' });
    paperDay(s, day('2026-10-29', { AAA: [100, 100], QQQ: [500, 500] }, [strong]));
    assert.equal(s.accounts.engine.pendingBuys.length, 1);
    assert.equal(s.accounts.current.pendingBuys.length, 0);
  });

  test('state survives a save and load through the Sheet in chunks; the tab lists the standings', async () => {
    const store = new MemoryTabStore();
    const s = newPaperState(['AAA']);
    paperDay(s, day('2026-10-29', { AAA: [100, 100], QQQ: [500, 500] }, [read('AAA', '2026-10-29', { turtle: 'bullish' })]));
    await savePaper(store, { state: s, trades: [] });
    const back = await loadPaper(store);
    assert.deepEqual(back!.state, JSON.parse(JSON.stringify(s)));
    assert.equal(standings(back!.state).length, 8);
    assert.ok(paperTabRows(back!).some((r) => r[0] === '📊 Hold QQQ'));
  });
});

import { runPaperNight } from '../src/paper/paperJob.ts';

describe('FL-14a — a late run during market hours', () => {
  const chart = (days: string[]) => ({ dates: days.map((d) => new Date(d + 'T20:00:00Z')), opens: days.map(() => 100), highs: days.map(() => 101), lows: days.map(() => 99), closes: days.map(() => 100), volumes: days.map(() => 1), splits: [] }) as never;
  const deps = (nowIso: string) => ({
    store: new MemoryTabStore(), timeZone: 'America/New_York', watchlist: [], log: () => {}, now: () => Date.parse(nowIso),
    fetchChart: async () => chart(['2026-10-28', '2026-10-29', '2026-10-30']),
    analysis: async (t: string) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: {}, texts: {} }) as never,
  });
  test('at 11:00 New York on a trading day, today\'s half bar is ignored: the day handled is the previous close', async () => {
    const d = deps('2026-10-30T15:00:00Z');
    await runPaperNight(d);
    assert.equal((await loadPaper(d.store))!.state.lastDay, '2026-10-29');
  });
  test('after the close the day itself is handled', async () => {
    const d = deps('2026-10-30T21:00:00Z');
    await runPaperNight(d);
    assert.equal((await loadPaper(d.store))!.state.lastDay, '2026-10-30');
  });
});
