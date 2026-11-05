import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { PortfolioResult } from '../src/sheets/readers/portfolio.ts';
import type { Chart } from '../src/types/chart.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { assertNoReportLeaks, findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { reasonLine } from '../src/reports/messages/catalog.ts';
import { urgencyRank } from '../src/reports/exit/exitReport.ts';
import { buildExitSheet, EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { buildBuySheet } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { computeExitTax } from '../src/portfolio/exitTax.ts';
import { actionRank } from '../src/jobs/exit/exitPipeline.ts';
import type { ActionClass, ExitOptionResult, ExitPipelineResult, ExitStockResult } from '../src/jobs/exit/exitPipeline.ts';
import { toExitReportInput, reasonCodeOfHeadline } from '../src/jobs/exit/exitReportAdapter.ts';
import { exitReportJob } from '../src/jobs/exit/exitReportStep.ts';
import { runBuyPipeline, workbookHistory } from '../src/jobs/buy/buyPipeline.ts';
import type { BuyAnalysis } from '../src/jobs/buy/buyPipeline.ts';
import { toBuyReportInput } from '../src/jobs/buy/buyReportAdapter.ts';
import { runDailyAutomation } from '../src/jobs/automation/dailyAutomation.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import type { NightlyDeps } from '../src/jobs/nightly/nightly.ts';
import { mayAppendHistory } from '../src/jobs/history/historyPolicy.ts';
import type { HistoryPolicy } from '../src/jobs/history/historyPolicy.ts';
import { DECISION_HISTORY_SHEET } from '../src/stores/decisionHistory.ts';

const NOW_MS = Date.UTC(2026, 9, 24, 21, 0, 0);
const HOSTILE = 'HTTP 503 at https://api.example.com/v1?apikey=ABCDEF1234567890 /Users/x/src/secret.ts:10:5';

function mk() {
  let t = NOW_MS;
  const log = new Logger({ sink: () => {}, scope: 'glue', now: () => new Date(0) });
  return createContext({ mode: 'test', runId: 'r1', logger: log, clock: { now: () => (t += 10) }, sleep: async () => {}, random: () => 0 });
}

function tax(over: Record<string, unknown> = {}) {
  return computeExitTax({ quantity: 10, unitCost: 80, unitPrice: 100, ...over });
}

function stock(over: Partial<ExitStockResult> = {}): ExitStockResult {
  return {
    kind: 'STOCK', ticker: 'AAPL', rowNumber: 5, status: 'OK', actionClass: 'HOLD',
    headline: 'Hold: no stop hit, no negative change in the technical read, targets not yet reached.',
    confidence: 'REAL', entryDateFallback: null, price: 100, stopLevel: 90, t1: 120, t2: 130, hitT1: false, hitT2: false,
    thesisInvalidated: false, stopBreached: false,
    read: { cp: 100, highestHighSinceEntry: 105, recommendation: HOSTILE, reason: HOSTILE },
    tax: tax(), taxLines: [], sharedThesis: null, dataQuality: [], dataQualityLines: [], notes: [HOSTILE],
    shares: 10, avgCost: 80, entryDate: '2025-01-02', analysis: null, ...over,
  };
}

function option(over: Partial<ExitOptionResult> = {}): ExitOptionResult {
  return {
    kind: 'OPTION', ticker: 'MSFT', rowNumber: 9, status: 'OK', actionClass: 'EXIT',
    headline: 'Exit: the contract is 20 days from expiry, inside the 30-day warning window.',
    confidence: 'REAL', entryDateFallback: null, price: 400, stopLevel: 350, t1: 450, t2: 480, hitT1: false, hitT2: false,
    thesisInvalidated: false, stopBreached: false,
    read: { technical: { highestHighSinceEntry: 410 }, reason: HOSTILE },
    tax: tax({ quantity: 2, unitCost: 3, unitPrice: 5, multiplier: 100 }), taxLines: [], sharedThesis: null, dataQuality: [], dataQualityLines: [], notes: [],
    contracts: 2, strike: 420, expiry: '2026-11-13', side: 'call', avgPremium: 3, entryDate: '2025-06-01',
    expiryTrigger: { daysToExpiry: 20, threshold: 30, kind: 'SHORT_TERM', triggered: true, expired: false }, underlyingHeldAsStock: false, ...over,
  };
}

function run(holdings: ExitPipelineResult['holdings'], over: Partial<ExitPipelineResult> = {}): ExitPipelineResult {
  return {
    startedAtMs: NOW_MS, holdings, groups: [], skipped: { crypto: [], other: [], blankRowCount: 0 }, stage0: null, stage0Failed: false,
    portfolioQuality: [], portfolioQualityLines: [],
    rollup: { holdingCount: holdings.length, stockCount: holdings.filter((h) => h.kind === 'STOCK').length, optionCount: holdings.filter((h) => h.kind === 'OPTION').length,
      actionCounts: { EXIT: 0, EXPIRED: 0, REVIEW: 0, TRIM: 0, HOLD: 0, UNKNOWN: 0 }, independentSignalCount: holdings.length,
      totals: { costBasisUsd: 0, marketValueUsd: 0, unrealizedUsd: 0, afterTaxGainUsd: 0, taxOwedUsd: 0, holdingsCounted: 0, holdingsLeftOut: 0 } },
    ...over,
  };
}

async function openBook(be = new MemoryWorkbookBackend({ Portfolio: [['x']] })) {
  return { be, ss: await ReportWorkbook.open(be, ['*']) };
}
const text = (be: MemoryWorkbookBackend, tab: string): string[] => be.grid(tab).flat().map((v) => String(v ?? ''));

// ───────────────────────── Exit adapter ─────────────────────────

test('exit adapter: stock fields all populated or explicitly null; raw read output is not copied', () => {
  const s = stock({ actionClass: 'EXIT', stopBreached: true, headline: 'Exit: the price is below your trailing stop of $90.00, measured from your purchase date.' });
  const out = toExitReportInput(run([s]));
  const h = out.holdings[0]!;
  for (const k of ['ticker', 'kind', 'position', 'option', 'signals', 'levels', 'models', 'comparison', 'fundamentals', 'positioning', 'correlatedGroup', 'dataHealth']) {
    assert.ok(Object.prototype.hasOwnProperty.call(h, k) && (h as unknown as Record<string, unknown>)[k] !== undefined, k + ' is set');
  }
  assert.ok(!('failed' in h));
  assert.deepEqual(h.position, { quantity: 10, avgCost: 80, entryDate: '2025-01-02', currentPrice: 100 });
  assert.equal(h.option, null);
  assert.equal(urgencyRank(h.signals!.summary), 0);
  assert.equal(h.levels!.stopBasis, 'SINCE_ENTRY');
  assert.equal(h.levels!.highestHighSinceEntry, 105);
  assert.equal(h.fundamentals, null);
  assert.equal(h.positioning, null);
  assert.deepEqual(out.skipped.otherStock, []);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('apikey') && !json.includes('example.com') && !json.includes('secret.ts'), 'raw read/notes never reach the adapted input');
});

test('exit adapter: sheet rank equals the pipeline rank for every action class', () => {
  const heads: Record<string, string> = {
    EXIT: 'Exit: the price is below your trailing stop of $90.00, measured from your purchase date.',
    EXPIRED: 'Expired: the expiry date has passed. Check whether this row is still open.',
    REVIEW: 'Review: the price may be below the trailing stop of $90.00, but no purchase date is on file, so this is a low-confidence read.',
    TRIM: 'Consider trimming: the first price target was reached.',
    HOLD: 'Hold: no stop hit, no negative change in the technical read, targets not yet reached.',
  };
  const expected: Record<string, number> = { EXIT: 0, EXPIRED: 0, REVIEW: 1, TRIM: 2, HOLD: 3 };
  for (const [cls, headline] of Object.entries(heads)) {
    const h = toExitReportInput(run([stock({ actionClass: cls as ActionClass, headline })])).holdings[0]!;
    assert.equal(urgencyRank(h.signals!.summary), expected[cls], cls);
    assert.equal(Math.min(actionRank(cls as ActionClass), 3), expected[cls], 'matches ACTION_RANK for ' + cls);
  }
  const single = toExitReportInput(run([option({ actionClass: 'TRIM', hitT1: true, headline: 'The underlying stock reached its first price target. With one contract a partial exit is not possible: hold or exit.' })])).holdings[0]!;
  assert.equal(urgencyRank(single.signals!.summary), 2);
});

test('exit adapter: option contract, derived premium, and the expiry trigger', () => {
  const h = toExitReportInput(run([option()])).holdings[0]!;
  assert.deepEqual(h.option, { right: 'CALL', strike: 420, expiry: '2026-11-13', daysToExpiry: 20, expiryThreshold: 30, expiryWarning: true, underlyingPrice: 400 });
  assert.equal(h.position.currentPrice, 5, 'market value 1000 / (2 contracts * 100)');
  assert.equal(h.position.avgCost, 3);
  assert.equal(urgencyRank(h.signals!.summary), 0);
  assert.equal(h.fundamentals, null);
  assert.equal(h.positioning, null);
});

test('exit adapter: failed and skipped holdings stay visible with a catalog reason and no raw text', async () => {
  const failed = stock({ ticker: 'BAD', status: 'FAILED', actionClass: 'UNKNOWN', headline: 'Price history: ' + reasonLine('NO_DATA_FOR_TICKER'), confidence: 'NONE', read: null, price: null, tax: tax({ quantity: null }) });
  const put = option({ ticker: 'PUT1', side: 'put', status: 'SKIPPED', actionClass: 'UNKNOWN', headline: 'Put positions are not covered by this report, which handles long calls only.', read: null });
  const good = stock();
  const input = toExitReportInput(run([good, failed, put]));
  assert.equal(input.holdings.length, 3);
  const f = input.holdings.find((x) => x.ticker === 'BAD')!;
  assert.equal(f.failed, 'NO_DATA_FOR_TICKER');
  assert.equal(f.signals, null);
  assert.equal(f.levels, null);
  const p = input.holdings.find((x) => x.ticker === 'PUT1')!;
  assert.equal(p.failed, 'LONG_ONLY_NOT_COVERED', 'audit #35: a put says it is outside the long-only scope');
  assert.ok(p.dataHealth.some((q) => q.label.includes('Put position')));
  assert.equal(reasonCodeOfHeadline('Exit read: ' + reasonLine('INPUT_INVALID_ENTRY_PRICE')), 'INPUT_INVALID_ENTRY_PRICE');

  const { be, ss } = await openBook();
  buildExitSheet(ss, input);
  await ss.flush();
  const all = text(be, EXIT_SHEET_TAB);
  assert.ok(all.some((t) => t.includes('BAD')), 'failed holding is on the sheet');
  assert.ok(all.some((t) => t.includes('PUT1')), 'skipped put is on the sheet');
  assert.ok(all.some((t) => t.includes(reasonLine('NO_DATA_FOR_TICKER'))));
  assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
});

test('exit adapter: a hostile headline is replaced, never shown', () => {
  const h = toExitReportInput(run([stock({ actionClass: 'EXIT', headline: 'Exit: ' + HOSTILE })])).holdings[0]!;
  assert.deepEqual(findReportLeaks(h.signals!.summary), []);
  assert.equal(urgencyRank(h.signals!.summary), 0);
});

test('exit adapter: skipped rows carry row and ticker only; Bitcoin shared thesis is mapped', () => {
  const thesis = {
    regime: 'TREND_UP', rsi14: 61, rsiWeekly: 58, stochRsi: 0.7, weeklyTrend: 'up', trendMaturity: 'mature', patternTypes: ['flag'],
    groupId: 'bitcoin-etfs', anchorSymbol: 'BTC-USD', anchorKind: 'UNDERLYING' as const, usedFallbackAnchor: false, narrative: 'Bitcoin is trending up.', disclosure: 'Shared read.',
  };
  const r = run([stock({ ticker: 'GBTC', sharedThesis: thesis }), stock({ ticker: 'IBIT', rowNumber: 6, sharedThesis: thesis })], {
    groups: [{ groupId: 'bitcoin-etfs', present: ['GBTC', 'IBIT'], shared: true, thesis }],
    skipped: { crypto: ['ETH'], other: [{ rowNumber: 12, ticker: 'ZZZ', reason: HOSTILE } as never], blankRowCount: 2 },
  });
  const out = toExitReportInput(r);
  assert.equal(out.holdings[0]!.correlatedGroup, 'BITCOIN');
  assert.deepEqual(out.sharedThesis, { group: 'BITCOIN', members: ['GBTC', 'IBIT'], anchorSeries: 'BTC-USD', regime: 'TREND_UP', trend: 'up', trendMaturity: 'mature', rsi: 61, stochRsi: 0.7, pattern: 'flag', momentum: 'Weekly RSI 58.0: healthy, rising.', thesis: 'Bitcoin is trending up.' });
  assert.deepEqual(out.skipped.otherStock, ['not a position: row 12 (ZZZ)'], 'grouped by a fixed reason; the raw (hostile) reason is never printed');
  assert.equal(out.skipped.otherStockCount, 1);
  assert.deepEqual(out.skipped.crypto, ['ETH']);
  assert.equal(out.skipped.blankTickerRowCount, 2);
  assert.ok(!JSON.stringify(out).includes('apikey'));
});

test('exit adapter: stored analysis becomes fundamentals, positioning and model reads', () => {
  const analysis = {
    fundResult: { score: 72, verdict: 'ok' }, decision: { fundBand: 'own' },
    positioning: { institutionalHolders: 410, darkPoolPct: 31.5, shortInterestPct: 1.2 },
    comparison: { existingDirection: 'bullish', newDirection: 'cautionary', newModelUnavailable: false, schabackerDirection: 'bullish', verdict: 'MAJORITY' },
  };
  const h = toExitReportInput(run([stock({ analysis })])).holdings[0]!;
  assert.deepEqual(h.fundamentals, { ownScore: 72, band: 'own' });
  assert.deepEqual(h.positioning, { institutionalHolders: 410, darkPoolPct: 31.5, shortInterestPct: 1.2 });
  assert.deepEqual(h.models.map((m) => [m.model, m.stance]), [['ENGINE', 'BULLISH'], ['SCHABACKER', 'BULLISH'], ['BROKER_COURSE', 'BEARISH']]);
  assert.deepEqual(h.comparison, { agreeCount: 2, totalCount: 3, majority: 'BULLISH', dissenters: ['BROKER_COURSE'] });
});

// ───────────────────────── Exit step (pipeline -> sheet) ─────────────────────────

test('exit step: runs the pipeline then writes the sheet; a failed holding makes it degraded but stays on the sheet', async () => {
  const ctx = mk();
  const portfolio: PortfolioResult = {
    stocks: [
      { ticker: 'AAPL', shares: 10, avgCost: 80, entryDate: new Date('2025-01-02T00:00:00Z'), rowNumber: 5 },
      { ticker: 'NOPE', shares: 5, avgCost: 10, entryDate: new Date('2025-01-02T00:00:00Z'), rowNumber: 6 },
    ],
    options: [], skippedCrypto: [], skippedOther: [], blankRowCount: 0,
  };
  const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
  const job = exitReportJob({
    ctx,
    pipeline: {
      portfolio,
      getChart: async (_c, t) => (t === 'AAPL' ? ({ closes: [100] } as unknown as Chart) : null),
      analyzers: { stockSinceEntry: () => ({ cp: 100, chandelierSinceEntry: 90, t1: 120, t2: 130, hitT1: false, hitT2: false, thesisInvalidated: false, stopBreached: false }) },
    },
    openWorkbook: () => ReportWorkbook.open(be, ['*']),
    options: { stepTimeoutMs: 1000 },
  });
  const outcome = await job();
  assert.equal(outcome!.state, 'degraded');
  assert.match(String(outcome!.reason), /1 of 2 holdings could not be read/);
  assert.deepEqual(findReportLeaks(String(outcome!.reason)), []);
  const all = text(be, EXIT_SHEET_TAB);
  assert.ok(all.some((t) => t.includes('AAPL')));
  assert.ok(all.some((t) => t.includes('NOPE')), 'failed holding still listed');
  assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
});

// ───────────────────────── Buy adapter ─────────────────────────

function an(): BuyAnalysis {
  return {
    fundResult: { score: 60, verdict: 'ok' },
    techPlan: { techScore: 50, regime: 'TREND_UP', timing: 'WAIT_PULLBACK', entryPrice: 98, entryLow: 95, entryHigh: 100, stop: 90, t1: { price: 120 }, t2: { price: 130 }, rrToT1: 2, rrToT2: 3, entryConfidencePct: 50, timeToEntry: { humanText: 'about 3 days', agreement: 'high' } },
    decision: { action: 'Only-if-it-dips trade', finalConviction: 60, fundBand: 'own' },
    confluence: { entryCount: 3, entryLow: 95, entryHigh: 100 },
    sizing: { available: true, n: 2.5, stopLevel: 90, riskPctOfAccount: 1 },
    comparison: { existingDirection: 'bullish', newDirection: 'cautionary', newModelUnavailable: false, schabackerDirection: 'bullish', verdict: 'MAJORITY' },
  };
}

test('buy adapter: ok, no-decision and failed candidates all stay; models normalised; no raw text', async () => {
  const ctx = mk();
  const buy = await runBuyPipeline({
    ctx, readTickers: () => ({ tickers: ['AAA', 'BBB', 'CCC'] }),
    analyze: async (t) => {
      if (t === 'CCC') throw Object.assign(new Error(HOSTILE), { status: 503 });
      return t === 'BBB' ? {} : an();
    },
  }, { tickerAttempts: 1 });
  const input = toBuyReportInput(buy, { runAt: new Date(NOW_MS) });
  assert.equal(input.candidates.length, 3);
  assert.deepEqual(input.candidates.map((c) => c.ticker), buy.candidates.map((c) => c.ticker), 'report order kept');
  const by = (t: string) => input.candidates.find((c) => c.ticker === t)!;
  assert.equal(by('CCC').status, 'failed');
  assert.ok(by('CCC').note && findReportLeaks(by('CCC').note as string).length === 0);
  assert.equal(by('BBB').status, 'degraded');
  const a = by('AAA');
  for (const k of ['models', 'comparison', 'techScore', 'rrToT1AtSpot', 'fundamentals', 'positioning', 'entryLadder', 'dataHealth', 'note', 'promotion']) {
    assert.ok((a as unknown as Record<string, unknown>)[k] !== undefined, k + ' is set (value or null)');
  }
  assert.equal(a.techScore, null);
  assert.deepEqual(a.comparison, { agreeCount: 2, totalCount: 3, majority: 'BULLISH', dissenters: ['BROKER_COURSE'] });
  assert.ok(Array.isArray(a.models) && (a.models as unknown[]).length === 3);
  assert.deepEqual(a.fundamentals, { ownScore: 60, band: 'own' });
  assert.ok(!JSON.stringify(input).includes('example.com'));

  const { be, ss } = await openBook();
  buildBuySheet(ss, input);
  await ss.flush();
  const all = text(be, BUY_SHEET_TAB);
  for (const t of ['AAA', 'BBB', 'CCC']) assert.ok(all.some((x) => x.includes(t)), t + ' is on the sheet');
  assertNoReportLeaks(be.grid(BUY_SHEET_TAB));
});

test('buy adapter: a leaking note or health line from a hand-built run is replaced', async () => {
  const ctx = mk();
  const buy = await runBuyPipeline({ ctx, readTickers: () => ({ tickers: ['AAA'] }), analyze: async () => an() });
  const dirty = { ...buy, candidates: buy.candidates.map((c) => ({ ...c, note: HOSTILE, dataHealth: [HOSTILE], opportunityCost: [HOSTILE], promotion: HOSTILE })) };
  const c = toBuyReportInput(dirty).candidates[0]!;
  for (const t of [c.note as string, c.promotion as string, ...c.dataHealth, ...c.opportunityCost]) assert.deepEqual(findReportLeaks(t), []);
});

// ───────────────────────── Single Decision History writer (F-P4) ─────────────────────────

function dailyDeps(ss: ReportWorkbook, policy?: HistoryPolicy) {
  let t = NOW_MS;
  return {
    workbook: ss, dailyTickers: ['AAA', 'BBB'], alertEmail: '', clock: { now: () => (t += 1000) }, timeZone: 'America/New_York', log: () => {},
    refreshMacroSnapshot: async () => {}, refreshBrokerCourseDataCache: async () => {},
    runAnalysis: async () => ({ fundResult: { score: 1 }, techPlan: { techScore: 2, regime: 'R' }, decision: { action: 'HOLD', finalConviction: 5 } }),
    sendEmail: async () => {}, getEffectiveUserEmail: async () => '', timeBudgetMs: Infinity,
    ...(policy ? { historyPolicy: policy } : {}),
  };
}

function rowsPerTicker(ss: ReportWorkbook): Record<string, number> {
  const sh = ss.getSheetByName(DECISION_HISTORY_SHEET);
  const out: Record<string, number> = {};
  if (!sh) return out;
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    const tk = String(data[r]![1] ?? '');
    if (tk) out[tk] = (out[tk] ?? 0) + 1;
  }
  return out;
}

async function bothWriters(automation?: HistoryPolicy, buyPolicy?: HistoryPolicy) {
  const { ss } = await openBook();
  await runDailyAutomation(dailyDeps(ss, automation) as never);
  await runBuyPipeline({
    ctx: mk(), readTickers: () => ({ tickers: ['AAA', 'BBB'] }), analyze: async () => an(), history: workbookHistory(ss),
  }, buyPolicy ? { historyPolicy: buyPolicy } : {});
  return rowsPerTicker(ss);
}

test('policy: only the named writer may append; legacy flag lets everyone', () => {
  assert.equal(mayAppendHistory('buyPipeline'), true);
  assert.equal(mayAppendHistory('dailyAutomation'), false);
  assert.equal(mayAppendHistory('nightlySummary'), false);
  assert.equal(mayAppendHistory('dailyAutomation', { writer: 'dailyAutomation' }), true);
  assert.equal(mayAppendHistory('buyPipeline', { writer: 'dailyAutomation' }), false);
  for (const p of ['buyPipeline', 'dailyAutomation', 'nightlySummary'] as const) assert.equal(mayAppendHistory(p, { legacyDoubleAppend: true }), true);
});

test('single writer (default): daily automation + buy pipeline leave exactly one row per ticker', async () => {
  assert.deepEqual(await bothWriters(), { AAA: 1, BBB: 1 });
});

test('single writer: writer=dailyAutomation moves the one row to the automation path', async () => {
  const p: HistoryPolicy = { writer: 'dailyAutomation' };
  assert.deepEqual(await bothWriters(p, p), { AAA: 1, BBB: 1 });
});

test('parity flag restores the legacy double append', async () => {
  const p: HistoryPolicy = { legacyDoubleAppend: true };
  assert.deepEqual(await bothWriters(p, p), { AAA: 2, BBB: 2 });
});

test('default daily automation alone writes no history (the Buy pipeline must run, see Q1)', async () => {
  const { ss } = await openBook();
  await runDailyAutomation(dailyDeps(ss) as never);
  assert.deepEqual(rowsPerTicker(ss), {});
});

test('nightly: the summary step is told whether it may append history', async () => {
  async function seen(policy?: HistoryPolicy): Promise<boolean | undefined> {
    let flag: boolean | undefined;
    const deps: NightlyDeps = {
      ctx: mk(), jobs: {}, readWatchlist: () => ['AAA'],
      runAnalysis: async () => ({ fundResult: { score: 1 }, techPlan: { techScore: 1, regime: 'x' }, decision: { finalConviction: 50, action: 'HOLD' } }),
      afterAnalysis: async (_rows, opts) => { flag = opts?.writeDecisionHistory; },
      ...(policy ? { historyPolicy: policy } : {}),
    };
    await runNightly(deps);
    return flag;
  }
  assert.equal(await seen(), false);
  assert.equal(await seen({ writer: 'nightlySummary' }), true);
  assert.equal(await seen({ legacyDoubleAppend: true }), true);
});
