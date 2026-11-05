/**
 * FL-7a-2b: F-57 RS ranking tab, the analysis-cache projections (F3) and the
 * one-portfolio-reader projection (F8).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { writeRsRankingTab, readRsRanking, RS_RANKING_TAB } from '../src/storage/rsRankingTab.ts';
import { createAnalysisCache, positioningOf, toBuyAnalysis, toExitBundle } from '../src/app/analysisCache.ts';
import { toPortfolioSummary, heldTickers } from '../src/app/portfolio.ts';
import type { TickerArtifacts } from '../src/analysis/runTicker.ts';

const NOW = Date.parse('2026-10-24T22:00:00Z');
const rk = (rank: number) => ({ categories: ['Semis'], peerCount: 9, rank, percentile: 90, read: 'STRONG', topPeers: [], bottomPeers: [] });

describe('FL-7a-2b — F-57 RS ranking tab', () => {
  test('one row per ticker, 30-hour TTL, rewrite replaces', async () => {
    const tabs = new MemoryTabStore();
    const big: Record<string, ReturnType<typeof rk>> = {};
    for (let i = 0; i < 111; i++) big['T' + i] = rk(i + 1);
    assert.ok(JSON.stringify(big).length > 9 * 1024, 'over the legacy 9 KB cap');
    assert.equal(await writeRsRankingTab(tabs, big, new Date(NOW)), 111);
    assert.deepStrictEqual(await readRsRanking(tabs, 't5', NOW + 3600000), rk(6));
    assert.equal(await readRsRanking(tabs, 'T5', NOW + 31 * 3600000), null, 'stale after 30 h');
    assert.equal(await readRsRanking(tabs, 'NOPE', NOW), null);
    await writeRsRankingTab(tabs, { NVDA: rk(1) }, new Date(NOW));
    assert.equal(tabs.snapshot(RS_RANKING_TAB, 3)!.length, 2);
    assert.equal(await readRsRanking(new MemoryTabStore(), 'NVDA', NOW), null, 'no tab yet');
  });
});

function art(t: string, ok = true): TickerArtifacts {
  return {
    ticker: t, status: {} as never, dataQuality: [], texts: {}, leapsCall: null, shortTermCall: null,
    result: ok ? { fundResult: { score: 61 } as never, techPlan: { techScore: 55, regime: 'TREND_UP', timing: 'BUY_NOW' } as never, decision: { action: 'Buy', finalConviction: 72 } as never } : undefined,
    aborted: ok ? undefined : 'no price data',
    confluence: { entryCount: 3, entryLow: 95, entryHigh: 100 } as never,
    ind: { darkPoolShare: { darkPoolSharePct: 0.382 } } as never,
    reports: {
      turtle: { sizing: { available: true, n: 2, stopLevel: 90, riskPctOfAccount: 1 } } as never,
      comparison: { existingDirection: 'bullish' } as never,
      broker: { institutional13F: { vanguard: { latest: { holdings: 1000 } }, blackrock: { latest: { holdings: 0 } }, ssga: { latest: null } }, news: { shortPctOfFloat: 0.031 } } as never,
    },
  };
}

describe('FL-7a-2b — one analysis per ticker, projected (F3)', () => {
  test('memoised once; daily, buy, exit and gemini are projections', async () => {
    let runs = 0;
    const cache = createAnalysisCache(async (t) => { runs++; return art(t, t !== 'BAD'); });
    await Promise.all([cache.daily('nvda'), cache.buy('NVDA'), cache.exit(' NVDA'), cache.gemini('NVDA')]);
    assert.equal(runs, 1);
    const b = toBuyAnalysis(art('NVDA'));
    assert.deepStrictEqual(b.confluence, { entryCount: 3, entryLow: 95, entryHigh: 100 });
    assert.deepStrictEqual(b.sizing, { available: true, n: 2, stopLevel: 90, riskPctOfAccount: 1 });
    const p = positioningOf(art('NVDA'));
    assert.equal(p.institutionalHolders, 1);
    assert.ok(Math.abs((p.darkPoolPct as number) - 38.2) < 1e-9);
    assert.ok(Math.abs((p.shortInterestPct as number) - 3.1) < 1e-9);
    assert.deepStrictEqual(Object.keys(toExitBundle(art('NVDA'))), ['fundResult', 'techPlan', 'decision', 'comparison', 'positioning']);
    await assert.rejects(cache.buy('BAD'), /did not complete: no price data/);
    assert.equal(await cache.exit('BAD'), null);
    assert.equal(await cache.daily('BAD'), null);
    assert.equal(runs, 2);
    assert.equal(cache.size, 2);
  });
});

describe('FL-7a-2b — one portfolio reader (F8)', () => {
  test('the Portfolio sheet projected to the nightly/Buy shape; crypto skips disclosed', () => {
    const p = {
      stocks: [{ ticker: 'AAPL', shares: 10, avgCost: 80, entryDate: new Date('2025-01-02T00:00:00Z'), rowNumber: 5 }, { ticker: 'IBIT', shares: 3, avgCost: null, entryDate: null, rowNumber: 6 }],
      options: [{ ticker: 'MSFT', contracts: 2, strike: 420, expiry: new Date('2026-11-13T00:00:00Z'), side: 'call' as const, avgPremium: 3, entryDate: null, rowNumber: 9 }, { ticker: 'aapl', contracts: 1, strike: 200, expiry: null, side: 'call' as const, avgPremium: null, entryDate: null, rowNumber: 10 }],
      skippedCrypto: ['ETH-USD'], skippedOther: [{ rowNumber: 12, ticker: '', reason: 'x' }], blankRowCount: 1,
    };
    const s = toPortfolioSummary(p);
    assert.deepStrictEqual(s.positions[0], { ticker: 'AAPL', assetType: 'STOCK', shares: 10, avgCost: 80, earliestLotDate: '2025-01-02' });
    assert.deepStrictEqual(s.positions[2], { ticker: 'MSFT', assetType: 'OPTION', strike: 420, expiry: '2026-11-13', contracts: 2, avgPremium: 3, earliestLotDate: '', snapshot: null });
    assert.deepStrictEqual(s.warnings, ['Skipped ETH-USD: crypto is not analysed.', 'Skipped row 12.']);
    assert.deepStrictEqual(heldTickers(p), ['AAPL', 'IBIT', 'MSFT']);
  });
});

describe('2026-11-04 fix: 13F holders counted from the stored { shares } shape', () => {
  test('object holdings with shares > 0 count; zero or missing do not; a plain number still counts', () => {
    const a = (h13: Record<string, unknown>) => ({ reports: { broker: { institutional13F: h13, news: {} } }, ind: {} }) as unknown as TickerArtifacts;
    const p = positioningOf(a({
      A: { latest: { holdings: { issuer: 'X', shares: 1200, value: 5 } } },
      B: { latest: { holdings: { issuer: 'X', shares: 0, value: 0 } } },
      C: { latest: null },
      D: { latest: { holdings: 300 } },
    }));
    assert.equal(p.institutionalHolders, 2);
  });
});
