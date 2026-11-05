import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { LogLine } from '../src/core/logger.ts';
import type { Chart } from '../src/types/chart.ts';
import type { PortfolioResult, StockHolding, OptionHolding } from '../src/sheets/readers/portfolio.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { formatStockSignals, formatOptionsSignals, urgencyRank } from '../src/reports/exit/exitReport.ts';
import {
  runExitPipeline, classifyStockAction, classifyOptionsAction, type ExitPipelineDeps, type ActionClass, type ExitOptionResult,
} from '../src/jobs/exit/exitPipeline.ts';
import { fixturesPresent, loadChart } from './fixtures.ts';

const NOW = Date.parse('2026-02-12T17:00:00Z');
function mk(nowMs = NOW) {
  const lines: LogLine[] = [];
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'exit', now: () => new Date(0) });
  const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, clock: { now: () => nowMs }, sleep: async () => {}, random: () => 0 });
  return { ctx, lines };
}
const chartOf = (ticker: string, price: number): Chart => ({ ticker, dates: [new Date(NOW)], opens: [price], highs: [price], lows: [price], closes: [price], volumes: [1], splits: [], ipoDate: null, currentPrice: price, prevClose: price, currency: 'USD' }) as unknown as Chart;
const stock = (ticker: string, over: Partial<StockHolding> = {}): StockHolding => ({ ticker, shares: 10, avgCost: 100, entryDate: new Date('2025-03-04T00:00:00Z'), rowNumber: 5, ...over });
const opt = (ticker: string, over: Partial<OptionHolding> = {}): OptionHolding => ({ ticker, contracts: 2, strike: 150, expiry: new Date('2026-03-20T00:00:00Z'), side: 'call', avgPremium: 3, entryDate: new Date('2025-12-01T00:00:00Z'), rowNumber: 20, ...over });
const pf = (stocks: StockHolding[], options: OptionHolding[] = []): PortfolioResult => ({ stocks, options, skippedCrypto: [], skippedOther: [], blankRowCount: 0 });
const sr = (over: Record<string, unknown> = {}) => ({ error: null, cp: 100, unrealizedPct: 0.1, daysHeld: 50, chandelierSinceEntry: 90, stopBreached: false, t1: 120, t2: 140, hitT1: false, hitT2: false, thesisInvalidated: false, recommendation: 'HOLD', reason: 'x', ...over });
const orr = (over: Record<string, unknown> = {}) => ({ error: null, daysToExpiry: 40, isLeapsAtEntry: false, expiryThreshold: 30, expiryWarning: false, technical: sr(), recommendation: 'HOLD', reason: 'x', ...over });
const RAW = /https?:|:\/\/|Error:|\bat \S+ \(|\bstatus\b|\b[45]\d\d\b|ECONN|apikey|SECRET/i;

function base(over: Partial<ExitPipelineDeps> = {}, calls: string[] = []): ExitPipelineDeps {
  return {
    portfolio: pf([stock('TSLA')]),
    getChart: async (_c, t) => { calls.push('chart:' + t); return chartOf(t, 100); },
    analyzers: {
      stockSinceEntry: (t, _c, d, ch) => sr({ cp: ch.closes[0], chandelierSinceEntry: ch.closes[0] * 0.9, entryDateStr: d }),
      stockFixedLookback: (t, _c, ch) => sr({ cp: ch.closes[0], chandelierGeneric: ch.closes[0] * 0.9, chandelierSinceEntry: undefined }),
      optionsSinceEntry: () => orr(),
      optionsFixedLookback: () => orr({ expiryThreshold: 60 }),
    },
    ...over,
  };
}

test('stock with a purchase date uses the since-entry read (confidence REAL)', async () => {
  const { ctx } = mk(); const out: string[] = [];
  const r = await runExitPipeline(ctx, base({ analyzers: { ...base().analyzers, stockSinceEntry: (t, c, d, ch) => { out.push('since:' + d); return sr(); } } }));
  assert.deepEqual(out, ['since:2025-03-04']);
  assert.equal(r.holdings[0].confidence, 'REAL'); assert.equal(r.holdings[0].entryDateFallback, null); assert.equal(r.holdings[0].actionClass, 'HOLD');
});

test('stock without a purchase date uses the generic lookback and says why', async () => {
  const { ctx } = mk();
  const r = await runExitPipeline(ctx, base({ portfolio: pf([stock('TSLA', { entryDate: null })]) }));
  assert.equal(r.holdings[0].confidence, 'GENERIC'); assert.equal(r.holdings[0].entryDateFallback, 'NO_ENTRY_DATE');
  assert.ok(!('term' in r.holdings[0].tax), 'no holding-period analysis (user decision 2026-10-25)');
});

test('a since-entry read that refuses falls back to the generic lookback (ENTRY_DATE_UNUSABLE)', async () => {
  const { ctx } = mk();
  const d = base();
  const r = await runExitPipeline(ctx, { ...d, analyzers: { ...d.analyzers, stockSinceEntry: () => ({ error: 'Entry date is before the available price history' }) } });
  assert.equal(r.holdings[0].confidence, 'GENERIC'); assert.equal(r.holdings[0].entryDateFallback, 'ENTRY_DATE_UNUSABLE');
  assert.ok(r.holdings[0].tax.taxOwedUsd !== null); // tax does not depend on the purchase date at all
});

const classOf = (summary: string): ActionClass => {
  const k = urgencyRank(summary);
  if (summary.indexOf('ERROR') === 0) return 'UNKNOWN';
  if (summary.indexOf('EXPIRED') === 0) return 'EXPIRED';
  if (summary.indexOf('EXIT') === 0) return 'EXIT';
  if (summary.indexOf('REVIEW') === 0) return 'REVIEW';
  if (k === 2) return 'TRIM';
  return 'HOLD';
};

test('action class equals the legacy stock summary class over every input combination', () => {
  for (const real of [true, false]) for (let m = 0; m < 16; m++) {
    const r = { chandelierSinceEntry: 90, thesisInvalidated: !!(m & 1), stopBreached: !!(m & 2), hitT1: !!(m & 4), hitT2: !!(m & 8), t1: 1, t2: 2 };
    assert.equal(classifyStockAction(r, real).actionClass, classOf(formatStockSignals(r as never, real).summary), 'mask ' + m + ' real ' + real);
  }
});

test('action class equals the legacy options summary class over every input combination', () => {
  for (const real of [true, false]) for (const contracts of [1, 2]) for (let m = 0; m < 64; m++) {
    const technical = { thesisInvalidated: !!(m & 1), stopBreached: !!(m & 2), hitT1: !!(m & 4), hitT2: !!(m & 8), chandelierSinceEntry: 90, t1: 1, t2: 2 };
    const r = { technical, daysToExpiry: (m & 16) ? 0 : 40, expiryThreshold: 30, expiryWarning: !!(m & 32) };
    assert.equal(classifyOptionsAction(r, real, contracts).actionClass, classOf(formatOptionsSignals(r as never, real, contracts).summary), 'mask ' + m);
  }
});

test('30-day short-term and 60-day LEAPS hard triggers are reported from the read', async () => {
  const { ctx } = mk();
  const shortRow = opt('NVDA', { rowNumber: 21 }); const leapsRow = opt('AMD', { rowNumber: 22 });
  const d = base({ portfolio: pf([], [shortRow, leapsRow]) });
  const r = await runExitPipeline(ctx, { ...d, analyzers: { ...d.analyzers, optionsSinceEntry: (t) => (t === 'NVDA'
    ? orr({ daysToExpiry: 25, isLeapsAtEntry: false, expiryThreshold: 30, expiryWarning: true })
    : orr({ daysToExpiry: 45, isLeapsAtEntry: true, expiryThreshold: 60, expiryWarning: true })) } });
  const by = (t: string) => r.holdings.find((h) => h.ticker === t) as ExitOptionResult;
  assert.deepEqual(by('NVDA').expiryTrigger, { daysToExpiry: 25, threshold: 30, kind: 'SHORT_TERM', triggered: true, expired: false });
  assert.deepEqual(by('AMD').expiryTrigger, { daysToExpiry: 45, threshold: 60, kind: 'LEAPS', triggered: true, expired: false });
  assert.equal(by('NVDA').actionClass, 'EXIT'); assert.match(by('NVDA').headline, /25 days from expiry/);
});

test('real options read: 30d for a short-term contract, 60d for a LEAPS (TSLA fixture)', { skip: fixturesPresent() ? false : 'fixtures not populated' }, async () => {
  const chart = loadChart('TSLA') as unknown as Chart;
  const n = chart.dates.length;
  const last = chart.dates[n - 1].getTime();
  const nowMs = last + 12 * 3600_000;
  const day = (ms: number) => new Date(Math.floor(ms / 86_400_000) * 86_400_000);
  const run = async (entryBarsBack: number, expiryDays: number) => {
    const { ctx } = mk(nowMs);
    const holding = opt('TSLA', { entryDate: chart.dates[n - 1 - entryBarsBack], expiry: day(last + expiryDays * 86_400_000), rowNumber: 30 });
    const r = await runExitPipeline(ctx, { portfolio: pf([], [holding]), getChart: async () => chart });
    return r.holdings[0] as ExitOptionResult;
  };
  const shortOk = await run(100, 45); const shortHit = await run(100, 25);
  const leapsHit = await run(300, 45);
  assert.equal(shortOk.expiryTrigger.kind, 'SHORT_TERM'); assert.equal(shortOk.expiryTrigger.threshold, 30); assert.equal(shortOk.expiryTrigger.triggered, false);
  assert.equal(shortHit.expiryTrigger.triggered, true);
  assert.equal(leapsHit.expiryTrigger.kind, 'LEAPS'); assert.equal(leapsHit.expiryTrigger.threshold, 60); assert.equal(leapsHit.expiryTrigger.triggered, true);
});

test('option without a purchase date degrades with a plain line when the fixed-lookback port is not wired', async () => {
  const { ctx } = mk();
  const d = base({ portfolio: pf([], [opt('NVDA', { entryDate: null })]) });
  const r = await runExitPipeline(ctx, { ...d, analyzers: { stockSinceEntry: d.analyzers!.stockSinceEntry, stockFixedLookback: d.analyzers!.stockFixedLookback, optionsSinceEntry: d.analyzers!.optionsSinceEntry } });
  assert.equal(r.holdings[0].status, 'FAILED'); assert.match(r.holdings[0].headline, /did not run/);
});

test('put positions are skipped (long-only); the parity flag restores legacy analysis', async () => {
  const d = base({ portfolio: pf([], [opt('NVDA', { side: 'put' })]) });
  const a = await runExitPipeline(mk().ctx, d);
  assert.equal(a.holdings[0].status, 'SKIPPED'); assert.match(a.holdings[0].headline, /long calls only/);
  const b = await runExitPipeline(mk().ctx, d, { parity: { legacyAnalysePuts: true } });
  assert.equal(b.holdings[0].status, 'OK');
});

test('failed underlying read on an option: unknown by default, HOLD with the legacy flag', async () => {
  const d = base({ portfolio: pf([], [opt('NVDA')]) });
  const bad = { ...d, analyzers: { ...d.analyzers, optionsSinceEntry: () => orr({ technical: { error: 'x' } }) } };
  const a = await runExitPipeline(mk().ctx, bad);
  assert.equal(a.holdings[0].actionClass, 'UNKNOWN');
  const b = await runExitPipeline(mk().ctx, bad, { parity: { legacyFailedReadHold: true } });
  assert.equal(b.holdings[0].actionClass, 'HOLD');
});

test('Stage 0 is loaded exactly once however many holdings there are, and reaches getAnalysis', async () => {
  const calls: string[] = []; const seen: unknown[] = [];
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf([stock('TSLA'), stock('NVDA', { rowNumber: 6 }), stock('AMD', { rowNumber: 7 })], [opt('TSLA')]),
    loadStage0: async () => { calls.push('stage0'); return { macro: 1 }; },
    getAnalysis: async (_c, t, s) => { seen.push(s); return { decision: { t } }; },
  }));
  assert.equal(calls.length, 1); assert.equal(seen.length, 3); assert.deepEqual(seen[0], { macro: 1 });
  assert.equal(r.stage0Failed, false);
});

test('a Stage 0 failure degrades every holding with a plain line and does not stop the run', async () => {
  const r = await runExitPipeline(mk().ctx, base({ loadStage0: async () => { throw Object.assign(new Error('HTTP 503 https://x'), { status: 503 }); } }));
  assert.equal(r.stage0Failed, true); assert.equal(r.holdings[0].status, 'DEGRADED');
  const text = [...r.portfolioQualityLines, ...r.holdings[0].dataQualityLines, r.holdings[0].headline].join('\n');
  assert.deepEqual(findReportLeaks(text), []); assert.ok(!RAW.test(text));
});

test('one ticker failing outright degrades only that holding', async () => {
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf([stock('TSLA'), stock('MSTR', { rowNumber: 6 }), stock('NVDA', { rowNumber: 7 })]),
    getChart: async (_c, t) => { if (t === 'MSTR') throw Object.assign(new Error('HTTP 500 https://query1.finance.yahoo.com'), { status: 500 }); return chartOf(t, 100); },
  }));
  const by = (t: string) => r.holdings.find((h) => h.ticker === t)!;
  assert.equal(by('MSTR').status, 'FAILED'); assert.equal(by('MSTR').actionClass, 'UNKNOWN');
  assert.equal(by('TSLA').status, 'OK'); assert.equal(by('NVDA').status, 'OK');
  assert.ok(!RAW.test(by('MSTR').headline)); assert.deepEqual(findReportLeaks(by('MSTR').headline), []);
});

test('a failed stored analysis degrades the holding with the price-chart-only effect line', async () => {
  const r = await runExitPipeline(mk().ctx, base({ getAnalysis: async () => { throw new Error('boom'); } }));
  assert.equal(r.holdings[0].status, 'DEGRADED');
  assert.ok(r.holdings[0].dataQualityLines.some((l) => /price and chart signals only/.test(l)));
  assert.equal(r.holdings[0].actionClass, 'HOLD'); // the exit read itself is unaffected
});

test('stock and option on the same underlying fetch the chart once; options never request the full analysis', async () => {
  const calls: string[] = []; const analysed: string[] = [];
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf([stock('TSLA')], [opt('TSLA')]),
    getAnalysis: async (_c, t) => { analysed.push(t); return {}; },
  }, calls));
  assert.equal(calls.filter((c) => c === 'chart:TSLA').length, 1); assert.deepEqual(analysed, ['TSLA']);
  const o = r.holdings.find((h) => h.kind === 'OPTION') as ExitOptionResult;
  assert.equal(o.underlyingHeldAsStock, true); assert.ok(o.notes.length === 1);
});

test('Bitcoin ETFs: one shared thesis, every dollar level from each ticker\'s own chart, disclosure present', async () => {
  const prices: Record<string, number> = { GBTC: 60, BTC: 40, FBTC: 70, BITB: 50, IBIT: 55, 'BTC-USD': 90000 };
  const calls: string[] = []; let thesisCalls = 0;
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf(['GBTC', 'BTC', 'FBTC', 'BITB', 'IBIT'].map((t, i) => stock(t, { rowNumber: 10 + i }))),
    getChart: async (_c, t) => { calls.push(t); return chartOf(t, prices[t]); },
    computeThesis: () => { thesisCalls++; return { regime: 'TREND_UP', rsi14: 60, rsiWeekly: 55, stochRsi: null, weeklyTrend: null, trendMaturity: null, patternTypes: [] }; },
  }));
  assert.equal(thesisCalls, 1);
  assert.equal(r.holdings.length, 5);
  const stops = new Set(r.holdings.map((h) => h.stopLevel));
  assert.equal(stops.size, 5);
  for (const h of r.holdings) {
    assert.equal(h.sharedThesis?.anchorSymbol, 'BTC-USD'); assert.equal(h.stopLevel, prices[h.ticker] * 0.9);
    assert.match(h.sharedThesis!.disclosure, /^Technical read shared across Bitcoin-tracking ETFs \(GBTC, BTC, FBTC, BITB, IBIT\)/);
  }
  assert.equal(r.rollup.independentSignalCount, 1);
});

test('Bitcoin anchor falls back to IBIT (reusing the held IBIT chart), and is never GBTC', async () => {
  const calls: string[] = [];
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf(['GBTC', 'IBIT'].map((t, i) => stock(t, { rowNumber: 10 + i }))),
    getChart: async (_c, t) => { calls.push(t); return t === 'BTC-USD' ? null : chartOf(t, 50); },
    computeThesis: () => ({ regime: 'CHOP', rsi14: null, rsiWeekly: null, stochRsi: null, weeklyTrend: null, trendMaturity: null, patternTypes: [] }),
  }));
  assert.equal(r.holdings[0].sharedThesis?.anchorSymbol, 'IBIT'); assert.equal(r.holdings[0].sharedThesis?.usedFallbackAnchor, true);
  assert.equal(calls.filter((c) => c === 'IBIT').length, 1);
  assert.ok(!calls.includes('GBTC') || calls.filter((c) => c === 'GBTC').length === 1); // GBTC only fetched as its own holding
});

test('if no anchor works the holdings keep their own levels and say the shared read is missing', async () => {
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf(['GBTC', 'IBIT'].map((t, i) => stock(t, { rowNumber: 10 + i }))),
    getChart: async (_c, t) => (t === 'BTC-USD' ? null : chartOf(t, 50)),
    computeThesis: () => { throw new Error('indicator crash'); },
  }));
  for (const h of r.holdings) {
    assert.equal(h.sharedThesis, null); assert.equal(h.stopLevel, 45); assert.equal(h.status, 'DEGRADED');
    assert.ok(h.dataQualityLines.some((l) => /Shared technical read/.test(l)));
  }
  assert.deepEqual(findReportLeaks(r.portfolioQualityLines.join('\n')), []);
});

test('the shared-thesis switch off gives each Bitcoin ETF only its own read', async () => {
  const r = await runExitPipeline(mk().ctx, base({ portfolio: pf(['GBTC', 'IBIT'].map((t, i) => stock(t, { rowNumber: 10 + i }))) }), { shareCorrelatedThesis: false });
  assert.ok(r.holdings.every((h) => h.sharedThesis === null && h.status === 'OK'));
  assert.equal(r.rollup.independentSignalCount, 2);
});

test('results are action-first and the rollup totals use only holdings with full numbers', async () => {
  const d = base({ portfolio: pf([stock('TSLA'), stock('NVDA', { rowNumber: 6 }), stock('AMD', { rowNumber: 7, shares: null })]) });
  const r = await runExitPipeline(mk().ctx, { ...d, analyzers: { ...d.analyzers, stockSinceEntry: (t) => (t === 'NVDA' ? sr({ stopBreached: true }) : sr()) } });
  assert.deepEqual(r.holdings.map((h) => h.ticker), ['NVDA', 'TSLA', 'AMD']);
  assert.equal(r.rollup.actionCounts.EXIT, 1); assert.equal(r.rollup.actionCounts.HOLD, 2);
  assert.equal(r.rollup.totals.holdingsCounted, 2); assert.equal(r.rollup.totals.holdingsLeftOut, 1);
});

test('tax is the one rule: 25% of the gain, none on a loss (user decision 2026-10-25)', async () => {
  const r = await runExitPipeline(mk().ctx, base());
  const t = r.holdings[0].tax;
  assert.equal(t.rate, 0.25);
  assert.equal(t.taxOwedUsd, Math.max(0, t.unrealizedUsd as number) * 0.25);
  assert.equal(t.afterTaxValueUsd, (t.marketValueUsd as number) - (t.taxOwedUsd as number));
  assert.doesNotMatch(r.holdings[0].taxLines.join('\n'), /long-term|short-term|held \d+ days/i);
});

test('every report-facing string is plain English with no leaks', async () => {
  const r = await runExitPipeline(mk().ctx, base({
    portfolio: pf([stock('TSLA'), stock('BAD', { avgCost: null, rowNumber: 8 })], [opt('NVDA', { strike: null })]),
    getAnalysis: async () => { throw Object.assign(new Error('HTTP 429 https://api.example'), { status: 429 }); },
  }));
  const text = r.holdings.flatMap((h) => [h.headline, ...h.taxLines, ...h.dataQualityLines, ...h.notes]).join('\n');
  assert.deepEqual(findReportLeaks(text), []); assert.ok(!RAW.test(text), text);
});
