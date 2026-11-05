/**
 * Requirement K (owner 2026-11-04, backlog row 39): 💾 Fundamentals History, append-only, one row per ticker per
 * day a value changed, written by the nightly step 'fundamentals.history' from the analyses already run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTabStore, type TabStore } from '../src/storage/tabStore.ts';
import {
  FUNDAMENTALS_HISTORY_HEADER, FUNDAMENTALS_HISTORY_TAB, FUNDAMENTALS_HISTORY_NOT_STORED, appendFundamentalsHistory, fundamentalsRecordOf,
  latestFundamentals, runFundamentalsHistoryNight, type FundamentalsRecord,
} from '../src/storage/fundamentalsHistory.ts';
import type { TickerArtifacts } from '../src/analysis/runTicker.ts';
import { Tabs, sheetFor } from '../src/sheets/tabs.ts';
import { ALL_NIGHTLY_STEPS, stepDef } from '../src/jobs/nightly/steps.ts';
import { CLEANUP_PROTECTED_TABS } from '../src/app/menuCommands.ts';
import { settledWithin } from '../src/app/nightlyApp.ts';

function artifacts(ticker: string, fund: Record<string, unknown> | null, extra: Partial<TickerArtifacts> = {}): TickerArtifacts {
  return {
    ticker, result: { fundResult: {}, techPlan: {}, decision: {} } as never, status: {} as never, dataQuality: [],
    fund: fund as never, fundSource: 'FMP + Finnhub fresh 11/4/2026',
    reports: {
      broker: {
        institutional13F: { Vanguard: { latest: { holdings: { shares: 10 } } }, BlackRock: { latest: { holdings: 5 } }, Citadel: { latest: { holdings: 0 } } },
        news: { shortInterestData: { shortInterest: 1_234_567, daysToCover: 2.345, settlementDate: '2026-10-15' }, shortPctOfFloat: 0.031234 },
      } as never,
    },
    texts: {},
    ...extra,
  };
}

const FUND = {
  revenueGrowth: 0.123456, earningsGrowth: 0.2, grossMargins: 0.45, profitMargins: 0.21, returnOnEquity: 0.3,
  forwardPE: 25.123, trailingPE: 30.456, pegRatio: 1.5, priceToBook: 8.2, debtToEquity: 0.4, currentRatio: 1.8,
  targetMean: 210.5, numAnalysts: 40, recMean: 1.8, recKey: 'Buy', beta: 1.1,
};

const rec = (date: string, over: Partial<FundamentalsRecord> = {}): FundamentalsRecord => ({ ...fundamentalsRecordOf(artifacts('AAPL', FUND), date)!, ...over });

describe('K: the record of one analysis', () => {
  test('reads the fundamentals, the short-interest data and the 13F holder count the analysis already had', () => {
    const r = fundamentalsRecordOf(artifacts('aapl', FUND), '2026-11-04')!;
    assert.equal(r.ticker, 'AAPL');
    assert.equal(r.date, '2026-11-04');
    assert.equal(r.revenueGrowth, 0.123456);
    assert.equal(r.trailingPE, 30.456);
    assert.equal(r.analystTarget, 210.5);
    assert.equal(r.rating, 'Buy');
    assert.equal(r.shortInterest, 1_234_567);
    assert.equal(r.daysToCover, 2.345);
    assert.equal(r.shortPctFloat, 0.031234);
    assert.equal(r.holders13F, 2, 'Vanguard (shares object) and BlackRock (number); Citadel holds 0');
    assert.equal(r.shares13F, 15);
    assert.equal(r.source, 'FMP + Finnhub fresh 11/4/2026');
  });
  test('no fundamentals and no broker data: nothing to store', () => {
    assert.equal(fundamentalsRecordOf(artifacts('X', null, { reports: {} }), '2026-11-04'), null);
  });
  test('broker data alone is still stored', () => {
    const r = fundamentalsRecordOf(artifacts('X', null), '2026-11-04')!;
    assert.equal(r.revenueGrowth, null);
    assert.equal(r.shortInterest, 1_234_567);
  });
});

describe('K: append only when a value changed', () => {
  test('first night: header + one row per ticker; the same values the next day add nothing', async () => {
    const store = new MemoryTabStore();
    assert.deepEqual(await appendFundamentalsHistory(store, [rec('2026-11-03'), rec('2026-11-03', { ticker: 'MSFT' })]), { appended: 2, unchanged: 0 });
    const grid = store.snapshot(FUNDAMENTALS_HISTORY_TAB, FUNDAMENTALS_HISTORY_HEADER.length)!;
    assert.deepEqual(grid[0], [...FUNDAMENTALS_HISTORY_HEADER]);
    assert.equal(grid.length, 3);
    assert.deepEqual(grid[1]!.slice(0, 3), ['2026-11-03', 'AAPL', 0.1235]);
    assert.equal(grid[1]![FUNDAMENTALS_HISTORY_HEADER.indexOf('TrailingPE')], 30.46);
    assert.equal(grid[1]![FUNDAMENTALS_HISTORY_HEADER.length - 1], 'FMP + Finnhub fresh 11/4/2026');

    // next night: same values, a new source label, and float noise below the stored precision
    assert.deepEqual(await appendFundamentalsHistory(store, [rec('2026-11-04', { source: 'FMP fresh 11/5/2026', trailingPE: 30.4561 })]), { appended: 0, unchanged: 1 });
    assert.equal(store.snapshot(FUNDAMENTALS_HISTORY_TAB, 3)!.length, 3);
  });
  test('a changed value appends a new row; the old rows are never touched', async () => {
    const store = new MemoryTabStore();
    await appendFundamentalsHistory(store, [rec('2026-11-03')]);
    assert.deepEqual(await appendFundamentalsHistory(store, [rec('2026-11-04', { analystTarget: 215 }), rec('2026-11-04', { ticker: 'NEW' })]), { appended: 2, unchanged: 0 });
    const grid = store.snapshot(FUNDAMENTALS_HISTORY_TAB, FUNDAMENTALS_HISTORY_HEADER.length)!;
    assert.equal(grid.length, 4);
    assert.equal(grid[1]![FUNDAMENTALS_HISTORY_HEADER.indexOf('AnalystTarget')], 210.5, 'old row unchanged');
    assert.equal(grid[2]![FUNDAMENTALS_HISTORY_HEADER.indexOf('AnalystTarget')], 215);
    // a value turning missing is a change too
    assert.equal((await appendFundamentalsHistory(store, [rec('2026-11-05', { analystTarget: null })])).appended, 1);
    // and stored numbers read back as strings (a formatted read) still compare equal
    const s2 = new MemoryTabStore();
    await s2.ensure(FUNDAMENTALS_HISTORY_TAB);
    const row = [...grid[2]!].map((v) => (typeof v === 'number' ? String(v) : v));
    await s2.write(FUNDAMENTALS_HISTORY_TAB, 1, [[...FUNDAMENTALS_HISTORY_HEADER], row]);
    assert.equal((await appendFundamentalsHistory(s2, [rec('2026-11-06', { analystTarget: 215 })])).appended, 0);
  });
  test('nothing to store: no Sheets call at all', async () => {
    const store = new MemoryTabStore();
    assert.deepEqual(await appendFundamentalsHistory(store, []), { appended: 0, unchanged: 0 });
    assert.equal(store.snapshot(FUNDAMENTALS_HISTORY_TAB, 2), null);
  });
});

describe('K: latestFundamentals (point in time)', () => {
  test('the row in force on the day; null before the first row; per ticker', async () => {
    const store = new MemoryTabStore();
    await appendFundamentalsHistory(store, [rec('2026-11-03')]);
    await appendFundamentalsHistory(store, [rec('2026-11-05', { analystTarget: 220, rating: 'Strong Buy' })]);
    assert.equal(await latestFundamentals(store, 'AAPL', '2026-11-02'), null);
    assert.equal((await latestFundamentals(store, 'aapl', '2026-11-04'))!.analystTarget, 210.5);
    const now = (await latestFundamentals(store, 'AAPL', new Date('2026-11-30T12:00:00Z')))!;
    assert.equal(now.analystTarget, 220);
    assert.equal(now.rating, 'Strong Buy');
    assert.equal(now.date, '2026-11-05');
    assert.equal(now.revenueGrowth, 0.1235);
    assert.equal(await latestFundamentals(store, 'MSFT', '2026-11-30'), null);
    assert.equal(await latestFundamentals(new MemoryTabStore(), 'AAPL', '2026-11-30'), null, 'no tab yet');
  });
});

describe('K: the nightly step', () => {
  test('after the analysis (after options.reads, before the paper test); data spreadsheet; protected from cleanup', () => {
    const ids = ALL_NIGHTLY_STEPS.map((s) => s.id);
    assert.equal(ids.indexOf('fundamentals.history'), ids.indexOf('options.reads') + 1);
    assert.equal(ids.indexOf('paper.trade'), ids.indexOf('fundamentals.history') + 1);
    assert.deepEqual(stepDef('fundamentals.history').dependsOn, ['analysis.tickers']);
    assert.equal(Tabs.FUNDAMENTALS_HISTORY, '💾 Fundamentals History');
    assert.equal(sheetFor(Tabs.FUNDAMENTALS_HISTORY), 'data');
    assert.ok(CLEANUP_PROTECTED_TABS.has(Tabs.FUNDAMENTALS_HISTORY));
  });
  test('reuses the analyses (failed / aborted / pending ones are left out) and appends', async () => {
    const store = new MemoryTabStore();
    const logs: string[] = [];
    const asked: string[] = [];
    const out = await runFundamentalsHistoryNight({
      store, day: '2026-11-04', tickers: ['AAPL', 'BAD', 'ABORT', 'NOFUND'], log: (m) => logs.push(m),
      analysis: async (t) => {
        asked.push(t);
        if (t === 'BAD') throw new Error('boom');
        if (t === 'ABORT') return artifacts(t, FUND, { aborted: 'no price data' });
        if (t === 'NOFUND') return artifacts(t, null, { reports: {} });
        return artifacts(t, FUND);
      },
    });
    assert.deepEqual(out, { state: 'ok' });
    assert.deepEqual(asked, ['AAPL', 'BAD', 'ABORT', 'NOFUND']);
    assert.equal(store.snapshot(FUNDAMENTALS_HISTORY_TAB, 2)!.length, 2);
    assert.match(logs.join('\n'), /1 row\(s\) added, 0 unchanged, 3 without fundamentals/);
  });
  test('never fails the night: a Sheets error makes it degraded with a plain sentence', async () => {
    const broken: TabStore = {
      read: async () => { throw new Error('quota'); }, ensure: async () => false, clear: async () => {}, write: async () => {},
    };
    const logs: string[] = [];
    const out = await runFundamentalsHistoryNight({ store: broken, day: '2026-11-04', tickers: ['AAPL'], log: (m) => logs.push(m), analysis: async () => artifacts('AAPL', FUND) });
    assert.deepEqual(out, { state: 'degraded', reason: FUNDAMENTALS_HISTORY_NOT_STORED });
    assert.match(logs[0]!, /not stored tonight: Error: quota/);
  });
  test('settledWithin: a pending memo does not hang the step', async () => {
    assert.equal(await settledWithin(new Promise(() => {}), 10), null);
    assert.equal(await settledWithin(Promise.reject(new Error('x')), 10), null);
    assert.equal(await settledWithin(Promise.resolve(7), 10), 7);
  });
});
