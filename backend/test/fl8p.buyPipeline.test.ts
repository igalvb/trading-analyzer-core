import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { LogLine } from '../src/core/logger.ts';
import type { PortfolioSummary } from '../src/portfolio/transactions.ts';
import {
  BITCOIN_SUBSTITUTES_TEXT, BUY_METHODOLOGY_CAVEATS, NOTHING_ACTIONABLE_TEXT, NO_CANDIDATES_TEXT,
  cellDayKey, nyDayKey, promotionCondition, runBuyPipeline, tierOf,
} from '../src/jobs/buy/buyPipeline.ts';
import type { BuyAnalysis, BuyHistory, HistoryRow, PriorDecision } from '../src/jobs/buy/buyPipeline.ts';

const RAW = /https?:|:\/\/|Error:|\bat \S+ \(|\bstatus\b|\b[45]\d\d\b|ECONN|apikey|SECRET/i;

function httpErr(status: number): Error {
  return Object.assign(new Error('HTTP ' + status + ' request failed'), { status });
}

function mk() {
  const lines: LogLine[] = [];
  let t = Date.UTC(2026, 9, 24, 21, 0, 0);
  const clock = { now: () => (t += 10) };
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'buy', now: () => new Date(0) });
  const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, clock, sleep: async () => {}, random: () => 0 });
  return { ctx, lines };
}

function an(over: { conv?: number; timing?: string; regime?: string; own?: number; action?: string; ec?: number; entryHigh?: number }): BuyAnalysis {
  return {
    fundResult: { score: over.own ?? 60, verdict: 'ok' },
    techPlan: {
      techScore: 50, regime: over.regime ?? 'TREND_UP', timing: over.timing ?? 'WAIT_PULLBACK', entryPrice: 98, entryLow: 95, entryHigh: over.entryHigh ?? 100,
      stop: 90, t1: { price: 120 }, t2: { price: 130 }, rrToT1: 2, rrToT2: 3, entryConfidencePct: over.ec ?? 50, timeToEntry: { humanText: 'about 3 days', agreement: 'high' },
    },
    decision: { action: over.action ?? 'Only-if-it-dips trade', finalConviction: over.conv ?? 50, fundBand: 'own' },
    confluence: { entryCount: 3, entryLow: 95, entryHigh: 100 },
    sizing: { available: true, n: 2.5, stopLevel: 90, riskPctOfAccount: 1, shares: 123, dollarRisk: 999 },
    options: { leaps: 'x' },
  };
}

function memHistory(priors: Record<string, PriorDecision>, calls: string[]): BuyHistory & { written: HistoryRow[] } {
  const written: HistoryRow[] = [];
  return {
    written,
    loadPriors: (tickers) => { calls.push('loadPriors'); return new Map(Object.entries(priors).filter(([k]) => tickers.includes(k))); },
    append: (rows) => { calls.push('append'); written.push(...rows); },
  };
}

test('watchlist is the only source: empty list means no candidates and no analysis', async () => {
  const { ctx } = mk();
  let n = 0;
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: [] }), analyze: async () => { n++; return an({}); } });
  assert.equal(n, 0);
  assert.equal(run.candidates.length, 0);
  assert.equal(run.emptyText, NO_CANDIDATES_TEXT);
  assert.equal(run.nothingActionable, true);
});

test('tickers are uppercased, trimmed and deduped', async () => {
  const { ctx } = mk();
  const seen: string[] = [];
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['mqzc', ' MQZC ', 'pltr', ''] }), analyze: async (t) => { seen.push(t); return an({}); } });
  assert.deepEqual(seen.slice().sort(), ['MQZC', 'PLTR']);
  assert.equal(run.candidates.length, 2);
});

test('tiering: boundaries, BUY_NOW, blocked beats BUY_NOW, no decision', () => {
  const f = (conv: number | null, buyNow = false, blocked = false, decision = true) => tierOf({ decision, blocked, buyNow, conviction: conv });
  assert.equal(f(70), 1);
  assert.equal(f(69), 2);
  assert.equal(f(45), 2);
  assert.equal(f(44), 3);
  assert.equal(f(10, true), 1);
  assert.equal(f(90, true, true), 3);
  assert.equal(f(null, false, false, false), 3);
});

test('tier 2 always states a concrete promotion condition; others none', async () => {
  const { ctx } = mk();
  const by: Record<string, BuyAnalysis> = {
    A: an({ conv: 80, timing: 'BUY_NOW' }),
    B: an({ conv: 55, regime: 'CHOP', entryHigh: 101.5 }),
    C: an({ conv: 20 }),
  };
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['A', 'B', 'C'] }), analyze: async (t) => by[t]! });
  const b = run.candidates.find((c) => c.ticker === 'B')!;
  assert.equal(b.tier, 2);
  assert.ok(b.promotion && b.promotion.includes('$101.50') && b.promotion.includes('trend'));
  assert.equal(run.candidates.find((c) => c.ticker === 'A')!.promotion, null);
  assert.equal(run.candidates.find((c) => c.ticker === 'C')!.promotion, null);
  assert.ok(promotionCondition({ entryHigh: null, regime: 'TREND_UP', timing: 'BUY_NOW', conviction: 80 }).length > 0);
});

test('ranking: BUY_NOW first, conviction desc, tie by entry confidence; every candidate present with unique rank', async () => {
  const { ctx } = mk();
  const by: Record<string, BuyAnalysis> = {
    HI: an({ conv: 90 }),
    NOW: an({ conv: 40, timing: 'BUY_NOW' }),
    TIE1: an({ conv: 60, ec: 40 }),
    TIE2: an({ conv: 60, ec: 80 }),
  };
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['HI', 'TIE1', 'NOW', 'TIE2'] }), analyze: async (t) => by[t]! });
  assert.deepEqual(run.candidates.map((c) => c.ticker), ['NOW', 'HI', 'TIE2', 'TIE1']);
  assert.deepEqual(run.candidates.map((c) => c.rank), [1, 2, 3, 4]);
  assert.equal(run.counts.tier1 + run.counts.tier2 + run.counts.tier3, 4);
  assert.equal(run.nothingActionable, false);
});

test('nothing actionable is a stated outcome', async () => {
  const { ctx } = mk();
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['X'] }), analyze: async () => an({ conv: 30 }) });
  assert.equal(run.nothingActionable, true);
  assert.equal(run.emptyText, NOTHING_ACTIONABLE_TEXT);
});

test('one ticker failing degrades only its own entry; report text has no raw detail', async () => {
  const { ctx, lines } = mk();
  const run = await runBuyPipeline({
    ctx, readTickers: () => ({ tickers: ['OK', 'BAD'] }),
    analyze: async (t) => { if (t === 'BAD') throw httpErr(404); return an({ conv: 75 }); },
  });
  const bad = run.candidates.find((c) => c.ticker === 'BAD')!;
  assert.equal(bad.status, 'failed');
  assert.equal(bad.tier, 3);
  assert.ok(bad.note && !RAW.test(bad.note), 'note is plain English: ' + bad.note);
  assert.equal(run.candidates[run.candidates.length - 1]!.ticker, 'BAD', 'failed sorts last');
  assert.equal(run.candidates.find((c) => c.ticker === 'OK')!.status, 'ok');
  assert.ok(lines.some((l) => /buy analysis failed/.test(JSON.stringify(l))), 'technical detail is logged');
  for (const c of run.candidates) for (const s of [c.note ?? '', ...c.opportunityCost, ...c.dataHealth]) assert.ok(!RAW.test(s), s);
});

test('Bitcoin group: one ranking slot, disclosure only with 2+ members, per-ticker levels kept', async () => {
  const { ctx } = mk();
  const by: Record<string, BuyAnalysis> = {
    GBTC: an({ conv: 80, entryHigh: 50 }), IBIT: an({ conv: 85, entryHigh: 60 }), NVDA: an({ conv: 82 }),
  };
  const run = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['GBTC', 'IBIT', 'NVDA'] }), analyze: async (t) => by[t]! });
  const g = run.candidates.filter((c) => c.bitcoinGroup);
  assert.equal(new Set(g.map((c) => c.slot)).size, 1);
  assert.equal(run.candidates.find((c) => c.ticker === 'NVDA')!.bitcoinGroup, false);
  assert.deepEqual(run.bitcoin!.members.slice().sort(), ['GBTC', 'IBIT']);
  assert.equal(run.bitcoin!.substitutesText, BITCOIN_SUBSTITUTES_TEXT);
  assert.equal(g.find((c) => c.ticker === 'GBTC')!.entryZone.high, 50);
  assert.equal(g.find((c) => c.ticker === 'IBIT')!.entryZone.high, 60);
  const solo = await runBuyPipeline({ ctx: mk().ctx, readTickers: () => ({ tickers: ['GBTC'] }), analyze: async () => an({}) });
  assert.equal(solo.bitcoin!.substitutesText, null);
});

test('held candidate is flagged add-to-position; portfolio failure degrades only that section', async () => {
  const pf = { positions: [{ ticker: 'MQZC', assetType: 'STOCK', shares: 10, avgCost: 50, earliestLotDate: '2025-01-01' }, { ticker: 'IBIT', assetType: 'STOCK', shares: 5, avgCost: 40, earliestLotDate: '2025-01-01' }], warnings: [] } as unknown as PortfolioSummary;
  const run = await runBuyPipeline({ ctx: mk().ctx, readTickers: () => ({ tickers: ['MQZC', 'GBTC', 'PLTR'] }), analyze: async () => an({}), readPortfolio: () => pf });
  const mu = run.candidates.find((c) => c.ticker === 'MQZC')!;
  assert.equal(mu.addToPosition, true);
  assert.equal(mu.held!.stockShares, 10);
  assert.ok(mu.opportunityCost.some((s) => /add to your position/.test(s)));
  assert.ok(run.candidates.find((c) => c.ticker === 'GBTC')!.opportunityCost.some((s) => /IBIT/.test(s) && /same/.test(s)));
  assert.equal(run.candidates.find((c) => c.ticker === 'PLTR')!.addToPosition, false);

  const bad = await runBuyPipeline({ ctx: mk().ctx, readTickers: () => ({ tickers: ['MQZC'] }), analyze: async () => an({}), readPortfolio: () => { throw new Error('boom https://x'); } });
  assert.equal(bad.portfolioOk, false);
  assert.equal(bad.candidates[0]!.status, 'ok');
  assert.ok(!RAW.test(bad.candidates[0]!.opportunityCost.join(' ')));
});

test('entry ladder percentages sum to 100; sizing is relative only (no shares or dollars)', async () => {
  const run = await runBuyPipeline({ ctx: mk().ctx, readTickers: () => ({ tickers: ['A'] }), analyze: async () => an({}) });
  const c = run.candidates[0]!;
  assert.equal(c.entryLadder.rungs.length, 3);
  assert.equal(c.entryLadder.percents.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(Object.keys(c.sizing!).sort(), ['firstUnitRiskPctOfAccount', 'n', 'stopLevel']);
  assert.match(c.sizingText!, /1\.0% of the account/);
  assert.ok(!/tax/i.test(JSON.stringify(c)));
});

test('history: priors read before any write; changes detected; sequential append; F-P1 same-day baseline', async () => {
  const today = nyDayKey(Date.UTC(2026, 9, 24, 21, 0, 0));
  assert.equal(cellDayKey(new Date(Date.UTC(2026, 9, 24, 21, 0, 0))), today);
  assert.equal(cellDayKey('nonsense'), null);
  const calls: string[] = [];
  const h = memHistory({ A: { date: '2026-10-23', action: 'Stand aside', finalConviction: 40 }, B: { date: '2026-10-23', action: 'BUY NOW', finalConviction: 80 } }, calls);
  const run = await runBuyPipeline({
    ctx: mk().ctx, readTickers: () => ({ tickers: ['A', 'B'] }), history: h,
    analyze: async (t) => { calls.push('analyze ' + t); return an({ conv: 75, action: t === 'A' ? 'BUY NOW' : 'BUY NOW' }); },
  });
  assert.equal(calls[0], 'loadPriors');
  assert.equal(calls[calls.length - 1], 'append');
  assert.equal(h.written.length, 2);
  assert.deepEqual(run.changes.map((c) => c.ticker), ['A']);
  assert.deepEqual(run.changes[0]!.change, { from: 'Stand aside', to: 'BUY NOW', fromConviction: 40 });
  const off = memHistory({}, []);
  await runBuyPipeline({ ctx: mk().ctx, readTickers: () => ({ tickers: ['A'] }), history: off, analyze: async () => an({}) }, { writeHistory: false });
  assert.equal(off.written.length, 0);
});

test('methodology caveats carry the unvalidated-floor disclosure', () => {
  assert.ok(BUY_METHODOLOGY_CAVEATS.some((s) => /not been validated/.test(s)));
  assert.ok(BUY_METHODOLOGY_CAVEATS.every((s) => !/cache/i.test(s)));
});
