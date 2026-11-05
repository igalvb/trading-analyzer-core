/**
 * FL-9h: ONE simulated night, end to end, with fakes. No network, no real Sheet, no keys.
 *
 * Wiring under test (everything real except the leaves):
 *   runNightly (steps 1-7)  ->  analysis.summary hook runs the BUY report job (buy pipeline -> adapter -> Buy sheet -> flush)
 *                           ->  exit.report runs the EXIT report job (exit pipeline -> adapter -> Exit sheet -> flush)
 *   then the manual AI run (aiDispatch with fake Gemini/Claude transports) writes into both tabs, twice.
 *
 * Leaves that are faked: the per-ticker analysis, charts, the exit read functions, the AI transports, the workbook backend.
 * Findings F1-F8 from this task are listed in the coordinator report; unreachable assertions are test.todo with a reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { Chart } from '../src/types/chart.ts';
import type { PortfolioResult } from '../src/sheets/readers/portfolio.ts';
import type { PortfolioSummary } from '../src/portfolio/transactions.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import type { TabChange } from '../src/sheets/reportSheet.ts';
import { LOCK_TAB_COLOR } from '../src/reports/options/ui.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { reasonLine } from '../src/reports/messages/catalog.ts';
import { AI_ANCHOR, EXIT_SHEET_TAB, EXIT_SHEET_TAB_COLOR, writeAiSummaries } from '../src/reports/exitSheet/exitSheet.ts';
import { writeBuyAiSummaries } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB, BUY_SHEET_TAB_COLOR, T as BUY_T } from '../src/reports/buySheet/text.ts';
import { exitReportJob } from '../src/jobs/exit/exitReportStep.ts';
import type { ExitPipelineResult } from '../src/jobs/exit/exitPipeline.ts';
import { buyReportJob } from '../src/jobs/buy/buyReportStep.ts';
import { workbookHistory } from '../src/jobs/buy/buyPipeline.ts';
import type { BuyAnalysis } from '../src/jobs/buy/buyPipeline.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import type { NightlyJob, RunSummary } from '../src/jobs/nightly/nightly.ts';
import { NIGHTLY_ORDER } from '../src/jobs/nightly/steps.ts';
import type { NightlyStepId } from '../src/jobs/nightly/steps.ts';
import { buildPlainSummary } from '../src/jobs/nightly/summary.ts';
import type { DailyAnalysisResult } from '../src/jobs/automation/dailyAutomation.ts';
import type { HistoryPolicy } from '../src/jobs/history/historyPolicy.ts';
import { appendDecisionHistory, DECISION_HISTORY_SHEET } from '../src/stores/decisionHistory.ts';
import { NIGHTLY_STEP_ORDER } from '../src/workflows/schedule.ts';
import { runAiBatch } from '../src/ai/aiDispatch.ts';
import type { AiDispatchDeps, AiTickerRequest } from '../src/ai/aiDispatch.ts';
import type { AiBatchResult } from '../src/ai/aiDispatch.ts';
import type { ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_MODEL } from '../src/ai/claudeReview.ts';
import type { GeminiTransport } from '../src/ai/geminiTransport.ts';
import type { ExitPositionFacts } from '../src/ai/exitFraming.ts';
import type { GeminiReviewInputs } from '../src/fetch/ai/geminiReview.ts';
import { toBuyAiInput, toExitAiInput } from '../src/ai/aiToSheet.ts';
import { DAILY_AUTOMATION_REJECTED_NOTE, watchlistDecisionRows } from '../src/jobs/history/historyPolicy.ts';

const NOW_MS = Date.UTC(2026, 9, 24, 21, 0, 0);
const WATCHLIST = ['AAPL', 'NVDA', 'GBTC', 'IBIT', 'BADX'];
const WATCH_OK = ['AAPL', 'NVDA', 'GBTC', 'IBIT'];
const LEAKY_ERROR = 'HTTP 400 at https://api.example.com/v1/chart?apikey=ABCDEF1234567890 /Users/x/src/secret.ts:10:5';

function httpErr(status: number, msg: string): Error { return Object.assign(new Error(msg), { status }); }

function mkCtx(mode: 'test' | 'ai' = 'test') {
  let t = NOW_MS;
  const log = new Logger({ sink: () => {}, scope: 'e2e', now: () => new Date(0) });
  return createContext({ mode, runId: 'r-e2e', logger: log, clock: { now: () => (t += 10) }, sleep: async () => {}, random: () => 0 });
}

/** Memory backend that records every applyTab, in order. */
class CountingBackend extends MemoryWorkbookBackend {
  readonly applied: string[] = [];
  override async applyTab(tab: string, change: TabChange): Promise<void> {
    this.applied.push(tab);
    await super.applyTab(tab, change);
  }
  count(tab: string): number { return this.applied.filter((x) => x === tab).length; }
}

// ───────────────────────── fixtures ─────────────────────────

const CONV: Record<string, number> = { AAPL: 80, NVDA: 60, GBTC: 72, IBIT: 50 };

/** One fixture-shaped full analysis per ticker; BADX throws a hostile, permanent (400) error. */
function fullAnalysis(t: string): BuyAnalysis {
  if (t === 'BADX') throw httpErr(400, LEAKY_ERROR);
  const conviction = CONV[t] ?? 40;
  return {
    fundResult: { score: 60, verdict: 'ok' },
    techPlan: {
      techScore: 50, regime: 'TREND_UP', timing: t === 'AAPL' ? 'BUY_NOW' : 'WAIT_PULLBACK', entryPrice: 98, entryLow: 95, entryHigh: 100, stop: 90,
      t1: { price: 120 }, t2: { price: 130 }, rrToT1: 2, rrToT2: 3, entryConfidencePct: 50, timeToEntry: { humanText: 'about 3 days', agreement: 'high' },
    },
    decision: { action: conviction >= 70 ? 'Buy now' : 'Only-if-it-dips trade', finalConviction: conviction, fundBand: 'own' },
    confluence: { entryCount: 3, entryLow: 95, entryHigh: 100 },
    sizing: { available: true, n: 2.5, stopLevel: 90, riskPctOfAccount: 1 },
    comparison: { existingDirection: 'bullish', newDirection: 'cautionary', newModelUnavailable: false, schabackerDirection: 'bullish', verdict: 'MAJORITY' },
  };
}

const chartOf = (price: number): Chart => ({ ticker: 'X', closes: [price], dates: [], opens: [], highs: [], lows: [], volumes: [], splits: [], ipoDate: null, currentPrice: price, prevClose: price, currency: 'USD' }) as unknown as Chart;

/** Exit portfolio: a stock, a failing stock (no chart), a long call, and an ETH-USD crypto row that must be skipped. */
const EXIT_PORTFOLIO: PortfolioResult = {
  stocks: [
    { ticker: 'AAPL', shares: 10, avgCost: 80, entryDate: new Date('2025-01-02T00:00:00Z'), rowNumber: 5 },
    { ticker: 'BADX', shares: 5, avgCost: 10, entryDate: new Date('2025-01-02T00:00:00Z'), rowNumber: 6 },
  ],
  options: [{ ticker: 'MSFT', contracts: 2, strike: 420, expiry: new Date('2026-11-13T00:00:00Z'), side: 'call', avgPremium: 3, entryDate: new Date('2025-06-01T00:00:00Z'), rowNumber: 9 }],
  skippedCrypto: ['ETH-USD'], skippedOther: [], blankRowCount: 0,
};

/** Buy / nightly portfolio (the transactions-based shape, F8): the same three holdings, no crypto. */
const SUMMARY: PortfolioSummary = {
  positions: [
    { ticker: 'AAPL', assetType: 'STOCK', shares: 10, avgCost: 80, earliestLotDate: '2025-01-02' },
    { ticker: 'BADX', assetType: 'STOCK', shares: 5, avgCost: 10, earliestLotDate: '2025-01-02' },
    { ticker: 'MSFT', assetType: 'OPTION', strike: 420, expiry: '2026-11-13', contracts: 2, avgPremium: 3, earliestLotDate: '2025-06-01', snapshot: null },
  ],
  warnings: [],
} as unknown as PortfolioSummary;

const stockRead = { cp: 100, chandelierSinceEntry: 90, t1: 120, t2: 130, hitT1: false, hitT2: false, thesisInvalidated: false, stopBreached: false, highestHighSinceEntry: 105 };
const optionRead = {
  daysToExpiry: 20, expiryThreshold: 30, expiryWarning: true, isLeapsAtEntry: false,
  technical: { chandelierSinceEntry: 350, t1: 450, t2: 480, hitT1: false, hitT2: false, thesisInvalidated: false, stopBreached: false, highestHighSinceEntry: 410 },
};

// ───────────────────────── one night ─────────────────────────

interface Night {
  readonly be: CountingBackend;
  readonly summary: RunSummary;
  readonly order: string[];
  readonly nightlyAnalysisCalls: Record<string, number>;
  readonly fullAnalysisCalls: Record<string, number>;
  readonly exitRun: ExitPipelineResult | null;
  readonly dhOrderAfterAnalysis: boolean;
}

async function runNight(policy?: HistoryPolicy): Promise<Night> {
  const ctx = mkCtx();
  const be = new CountingBackend({ Portfolio: [['x']] });
  const buySs = await ReportWorkbook.open(be, ['*']); // same instance for the history reader/writer AND the Buy sheet (F4)
  const order: string[] = [];
  const nightlyAnalysisCalls: Record<string, number> = {};
  const fullAnalysisCalls: Record<string, number> = {};
  const memo = new Map<string, BuyAnalysis | Error>();
  const full = (t: string): BuyAnalysis => { // ONE underlying analysis per ticker, shared by both consumers (F3 intent)
    fullAnalysisCalls[t] = (fullAnalysisCalls[t] ?? 0) + 1;
    const hit = memo.get(t);
    if (hit instanceof Error) throw hit;
    if (hit) return hit;
    try { const a = fullAnalysis(t); memo.set(t, a); return a; } catch (e) { memo.set(t, e as Error); throw e; }
  };
  let exitRun: ExitPipelineResult | null = null;
  let analysisDone = false;

  const noop = (id: NightlyStepId): NightlyJob => async () => { order.push(id); };

  const buyJob = buyReportJob({
    ctx,
    pipeline: (ss) => ({ // F4: the job opens the workbook first; history shares that same instance
      ctx,
      readTickers: () => ({ tickers: WATCHLIST }),
      analyze: async (t) => { const a = full(t); return a; },
      readPortfolio: () => SUMMARY,
      history: workbookHistory(ss),
    }),
    openWorkbook: () => buySs,
    options: { tickerAttempts: 1, ...(policy ? { historyPolicy: policy } : {}) },
  });

  const exitJob = exitReportJob({
    ctx,
    pipeline: {
      portfolio: EXIT_PORTFOLIO,
      getChart: async (_c, t) => (t === 'BADX' ? null : chartOf(t === 'MSFT' ? 400 : 100)),
      analyzers: { stockSinceEntry: () => stockRead, optionsSinceEntry: () => optionRead },
      getAnalysis: async (_c, t) => { const a = full(t); return { fundResult: a.fundResult, decision: a.decision, comparison: a.comparison }; },
    },
    openWorkbook: () => ReportWorkbook.open(be, ['*']),
    options: { stepTimeoutMs: 5000 },
    loadAdvisory: async (_c, run) => { exitRun = run; return null; },
  });

  const summary = await runNight2();
  async function runNight2(): Promise<RunSummary> {
    return runNightly({
      ctx,
      jobs: {
        'darkPool.tracker': noop('darkPool.tracker'),
        'darkPool.evaluativeIndex': noop('darkPool.evaluativeIndex'),
        'darkPool.relativeStrength': noop('darkPool.relativeStrength'),
        'macro.refresh': noop('macro.refresh'),
        'options.chains': noop('options.chains'),
        'options.reads': noop('options.reads'),
        'fundamentals.history': noop('fundamentals.history'),
        'buy.report': async () => { order.push('buy.report'); return buyJob(); }, // F2: its own step
        'exit.report': async () => { order.push('exit.report'); return exitJob(); },
        'paper.trade': noop('paper.trade'),
        'live.dryRun': noop('live.dryRun'),
      },
      readPortfolio: () => SUMMARY,
      readWatchlist: () => WATCHLIST,
      runAnalysis: async (t): Promise<DailyAnalysisResult> => {
        if (!order.includes('analysis.tickers')) order.push('analysis.tickers');
        nightlyAnalysisCalls[t] = (nightlyAnalysisCalls[t] ?? 0) + 1;
        const a = full(t);
        return { fundResult: { score: a.fundResult?.score }, techPlan: { techScore: a.techPlan?.techScore, regime: a.techPlan?.regime }, decision: a.decision ?? null };
      },
      afterAnalysis: async (rows, opts) => {
        order.push('analysis.summary');
        analysisDone = rows.length > 0;
        if (opts?.writeDecisionHistory) { // interim writer: the summary step itself appends, watchlist tickers only (F6)
          for (const r of watchlistDecisionRows(rows)) {
            appendDecisionHistory(buySs, r.ticker, r.result.fundResult, r.result.techPlan, r.result.decision!, ctx.clock.now());
          }
        }
      },
      ...(policy ? { historyPolicy: policy } : {}),
    }, { tickerAttempts: 1 });
  }

  const dhIdx = be.applied.indexOf(DECISION_HISTORY_SHEET);
  const exitIdx = be.applied.indexOf(EXIT_SHEET_TAB);
  return { be, summary, order, nightlyAnalysisCalls, fullAnalysisCalls, exitRun, dhOrderAfterAnalysis: analysisDone && (dhIdx === -1 || exitIdx === -1 || dhIdx < exitIdx) };
}

let defaultNight: Promise<Night> | null = null;
const night = (): Promise<Night> => (defaultNight ??= runNight());

const cellsOf = (be: MemoryWorkbookBackend, tab: string): string[] => be.grid(tab).flat().map((v) => String(v ?? '')).filter((s) => s !== '');
const dhCounts = (be: MemoryWorkbookBackend): Record<string, number> => {
  const out: Record<string, number> = {};
  const g = be.grid(DECISION_HISTORY_SHEET);
  for (let r = 1; r < g.length; r++) { const tk = String(g[r]![1] ?? ''); if (tk) out[tk] = (out[tk] ?? 0) + 1; }
  return out;
};

// ───────────────────────── (1) step order ─────────────────────────

test('(1) nightly step order IS schedule.ts NIGHTLY_STEP_ORDER (one list, F1), buy.report included (F2), and every step ran in order', async () => {
  const n = await night();
  assert.deepEqual([...NIGHTLY_STEP_ORDER], [...NIGHTLY_ORDER]);
  assert.deepEqual(n.summary.steps.map((s) => s.id), [...NIGHTLY_STEP_ORDER]);
  assert.deepEqual(n.summary.steps.map((s) => s.id), [...NIGHTLY_ORDER]);
  assert.deepEqual(n.order, [...NIGHTLY_ORDER], 'jobs were invoked in the approved order');
  assert.equal(n.summary.stepCounts.skipped, 0);
  assert.equal(n.summary.stepCounts.failed, 0);
});

test('(1) buy.report is its own step right after analysis.summary; the Buy tab is written before the Exit tab (F2)', async () => {
  const n = await night();
  assert.equal(NIGHTLY_ORDER.indexOf('buy.report'), NIGHTLY_ORDER.indexOf('analysis.summary') + 1);
  assert.equal(n.summary.steps.find((s) => s.id === 'analysis.summary')!.state, 'ok');
  assert.ok(n.be.applied.indexOf(BUY_SHEET_TAB) !== -1 && n.be.applied.indexOf(EXIT_SHEET_TAB) !== -1);
  assert.ok(n.be.applied.indexOf(BUY_SHEET_TAB) < n.be.applied.indexOf(EXIT_SHEET_TAB));
  assert.ok(n.dhOrderAfterAnalysis);
});


// ───────────────────────── (2) tabs, written once, lock colour ─────────────────────────

test('(2) both report tabs exist, each is applied exactly once, accent colours set, lock colour never touched', async () => {
  const { be } = await night();
  assert.ok(be.tabs.has(EXIT_SHEET_TAB) && be.tabs.has(BUY_SHEET_TAB));
  assert.equal(EXIT_SHEET_TAB, '📤 Exit Report');
  assert.equal(BUY_SHEET_TAB, '🛒 Buy Report');
  assert.equal(be.count(EXIT_SHEET_TAB), 1);
  assert.equal(be.count(BUY_SHEET_TAB), 1);
  assert.equal(be.tabs.get(EXIT_SHEET_TAB)!.tabColor, EXIT_SHEET_TAB_COLOR);
  assert.equal(be.tabs.get(BUY_SHEET_TAB)!.tabColor, BUY_SHEET_TAB_COLOR);
  for (const [name, t] of be.tabs) assert.notEqual((t.tabColor ?? '').toLowerCase(), LOCK_TAB_COLOR, name + ' was not painted with the lock colour by a report job');
  assert.equal(be.tabs.get('Portfolio')!.tabColor, null, 'an unrelated tab is untouched');
  assert.equal(be.count('Portfolio'), 0);
  assert.equal(new Set(be.applied).size, be.applied.length, 'no tab was applied twice');
});

// ───────────────────────── (3) Decision History single writer ─────────────────────────

test('(3) default policy: exactly ONE Decision History row per analysed watchlist ticker, none for the failing or non-watchlist ones', async () => {
  const { be } = await night();
  assert.deepEqual(dhCounts(be), { AAPL: 1, NVDA: 1, GBTC: 1, IBIT: 1 });
  assert.equal(be.count(DECISION_HISTORY_SHEET), 1);
});

test('(3) interim writer = nightlySummary: still exactly one row per watchlist ticker (the buy pipeline stands down)', async () => {
  const { be } = await runNight({ writer: 'nightlySummary' });
  assert.deepEqual(dhCounts(be), { AAPL: 1, NVDA: 1, GBTC: 1, IBIT: 1 });
});

test('(3) writer = dailyAutomation inside the nightly chain is rejected: the Buy pipeline writes once, a plain note is reported (F7)', async () => {
  const n = await runNight({ writer: 'dailyAutomation' });
  assert.deepEqual(dhCounts(n.be), { AAPL: 1, NVDA: 1, GBTC: 1, IBIT: 1 });
  assert.deepEqual(n.summary.notes, [DAILY_AUTOMATION_REJECTED_NOTE]);
  assert.ok(buildPlainSummary(n.summary).some((l) => l.includes(DAILY_AUTOMATION_REJECTED_NOTE)));
});

test('(3) parity flag legacyDoubleAppend restores the duplicate (summary step + buy pipeline)', async () => {
  const { be } = await runNight({ legacyDoubleAppend: true });
  assert.deepEqual(dhCounts(be), { AAPL: 2, NVDA: 2, GBTC: 2, IBIT: 2 });
});

// ───────────────────────── (4) failing ticker degrades only itself ─────────────────────────

test('(4) the failing ticker degrades only itself: nightly, exit run, both sheets, and the step reasons are plain', async () => {
  const n = await night();
  const failed = n.summary.tickers.filter((t) => t.state === 'failed').map((t) => t.ticker);
  assert.deepEqual(failed, ['BADX']);
  assert.equal(n.summary.tickers.filter((t) => t.state === 'ok').length, n.summary.tickers.length - 1);

  assert.ok(n.exitRun, 'loadAdvisory captured the exit run');
  const run = n.exitRun as unknown as ExitPipelineResult;
  assert.deepEqual(run.holdings.filter((h) => h.status === 'FAILED').map((h) => h.ticker), ['BADX']);
  assert.deepEqual(run.holdings.map((h) => h.ticker).sort(), ['AAPL', 'BADX', 'MSFT']);
  assert.ok(run.holdings.filter((h) => h.ticker !== 'BADX').every((h) => h.status !== 'FAILED'));
  assert.deepEqual(run.skipped.crypto, ['ETH-USD'], 'the crypto row is skipped, never analysed');
  assert.ok(!run.holdings.some((h) => /ETH/.test(h.ticker)));

  const exitStep = n.summary.steps.find((s) => s.id === 'exit.report')!;
  const summaryStep = n.summary.steps.find((s) => s.id === 'buy.report')!; // the "1 of 5" count now belongs to the Buy report step
  assert.equal(exitStep.state, 'degraded');
  assert.match(String(exitStep.reason), /1 of 3 holdings could not be read/);
  assert.equal(summaryStep.state, 'degraded');
  assert.match(String(summaryStep.reason), /1 of 5 stocks could not be analysed/);

  const exitCells = cellsOf(n.be, EXIT_SHEET_TAB);
  const buyCells = cellsOf(n.be, BUY_SHEET_TAB);
  for (const [name, cells] of [['exit', exitCells], ['buy', buyCells]] as const) {
    assert.ok(cells.some((c) => c.includes('BADX')), name + ': failing ticker is still listed');
    for (const ok of ['AAPL']) assert.ok(cells.some((c) => c.includes(ok)), name + ': ' + ok + ' is on the sheet');
    assert.ok(!cells.some((c) => c.includes('AAPL') && /could not|not available/i.test(c) && c.includes('BADX')), name + ': failure text does not bleed across tickers');
  }
  assert.ok(exitCells.some((c) => c.includes(reasonLine('NO_DATA_FOR_TICKER'))), 'exit: catalog sentence for the missing price history');
  for (const t of WATCH_OK) assert.ok(buyCells.some((c) => c.includes(t)), 'buy: ' + t + ' is ranked');

  const plain = buildPlainSummary(n.summary).join('\n');
  assert.match(plain, /BADX/);
  assert.doesNotMatch(plain, /https?:|apikey|secret\.ts|HTTP 400/i);
});

// ───────────────────────── (5) leak scan ─────────────────────────

test('(5) leak scan over every cell of both report tabs', async () => {
  const { be } = await night();
  assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
  assertNoReportLeaks(be.grid(BUY_SHEET_TAB));
  const all = [...cellsOf(be, EXIT_SHEET_TAB), ...cellsOf(be, BUY_SHEET_TAB)].join('\n');
  assert.ok(!/example\.com|ABCDEF1234567890|secret\.ts/.test(all), 'the hostile error text never reached a cell');
});

// ───────────────────────── (6) AI section replaced in place ─────────────────────────

const FACTS: ExitPositionFacts = { entryPrice: 80, currentPrice: 100, unrealizedPct: 25, trailingStop: 90, afterTaxPct: 18.75, taxRatePct: 25 };
function inputsFor(ticker: string): GeminiReviewInputs {
  return {
    ticker, fundResult: { score: 7, verdict: 'Good', profile: 'GENERAL', drivers: [] }, techPlan: { techScore: 6, regime: 'UP', timing: 'WAIT' },
    decision: { action: 'HOLD', finalConviction: 60 }, ind: {}, fund: null, chart: { currentPrice: 100 }, optAnalysis: null,
  } as unknown as GeminiReviewInputs;
}
const reqOf = (t: string, facts = false): AiTickerRequest => ({ ticker: t, inputs: inputsFor(t), ...(facts ? { exitFacts: FACTS } : {}) });

function aiDeps(tag: string): AiDispatchDeps {
  const gemini: GeminiTransport = { async generate() { return { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini narrative ' + tag + '.' }] } }] }) }; } };
  const sdk: ClaudeSdk = {
    async create(): Promise<ClaudeResponse> {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opus narrative ' + tag + '.' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: CLAUDE_REVIEW_MODEL };
    },
  } as ClaudeSdk;
  return { ctx: mkCtx('ai'), geminiTransport: gemini, claudeSdk: sdk, claudeApiKey: 'k-test-123456', getMacroRegime: () => null };
}

async function manualAiRun(be: MemoryWorkbookBackend, tag: string): Promise<{ exit: AiBatchResult; buy: AiBatchResult }> {
  const both = { gemini: true, opus: true };
  const deps = aiDeps(tag);
  const exit = await runAiBatch(deps, 'exit', [reqOf('AAPL', true), reqOf('MSFT', true)], both, 'medium');
  const buy = await runAiBatch(deps, 'buy', WATCH_OK.map((t) => reqOf(t)), both, 'medium');
  const ss = await ReportWorkbook.open(be, ['*']);
  const ranAt = new Date(NOW_MS);
  const a = writeAiSummaries(ss, toExitAiInput(exit, { ranAt, switches: both, effort: 'medium' }));
  const b = writeBuyAiSummaries(ss, toBuyAiInput(buy, { ranAt, switches: both, effort: 'medium', candidates: WATCH_OK.map((t) => ({ ticker: t, tier: 1 as const })) }));
  assert.equal(a.written, true, String(a.message));
  assert.equal(b.written, true, String(b.message));
  await ss.flush();
  return { exit, buy };
}

const anchorRows = (be: MemoryWorkbookBackend, tab: string): number => be.grid(tab, 1).filter((r) => r[0] === AI_ANCHOR).length;

test('(6) the AI section is replaced in place on a second run: one anchor, no new tabs, old text gone, new text present', async () => {
  const n = await runNight(); // own night: this test mutates the workbook
  const be = n.be;
  const tabsBefore = [...be.tabs.keys()].sort();
  const exitRows0 = be.grid(EXIT_SHEET_TAB).length;
  assert.equal(anchorRows(be, EXIT_SHEET_TAB), 1);
  assert.equal(anchorRows(be, BUY_SHEET_TAB), 1);
  assert.ok(cellsOf(be, EXIT_SHEET_TAB).some((c) => /pending/i.test(c)), 'nightly leaves the placeholder');

  const r1 = await manualAiRun(be, 'RUNONE');
  assert.equal(r1.exit.totals.geminiOk, 2);
  assert.equal(r1.buy.totals.opusOk, 4);
  for (const tab of [EXIT_SHEET_TAB, BUY_SHEET_TAB]) {
    const text = cellsOf(be, tab).join('\n');
    assert.match(text, /Gemini narrative RUNONE/);
    assert.match(text, /Opus narrative RUNONE/);
    assert.equal(anchorRows(be, tab), 1);
  }
  const exitRowsAfter1 = be.grid(EXIT_SHEET_TAB).length;
  assert.ok(exitRowsAfter1 >= exitRows0);

  await manualAiRun(be, 'RUNTWO');
  for (const tab of [EXIT_SHEET_TAB, BUY_SHEET_TAB]) {
    const text = cellsOf(be, tab).join('\n');
    assert.doesNotMatch(text, /RUNONE/, tab + ': the first AI run is replaced, not appended to');
    assert.match(text, /Gemini narrative RUNTWO/);
    assert.match(text, /Opus narrative RUNTWO/);
    assert.equal(anchorRows(be, tab), 1, tab + ': still exactly one AI anchor');
    assertNoReportLeaks(be.grid(tab));
  }
  assert.equal(be.grid(EXIT_SHEET_TAB).length, exitRowsAfter1, 'same AI content shape = same row count (no growth)');
  assert.deepEqual([...be.tabs.keys()].sort(), tabsBefore, 'no duplicate or new tabs');
  assert.deepEqual(dhCounts(be), { AAPL: 1, NVDA: 1, GBTC: 1, IBIT: 1 }, 'the AI run wrote no Decision History');

  // everything above the anchor is untouched by the AI run
  const cut = (g: unknown[][]) => g.slice(0, g.findIndex((r) => r[0] === AI_ANCHOR)).map((r) => r.join('|')).join('\n');
  assert.equal(cut(be.grid(EXIT_SHEET_TAB)).length > 0, true);
});

test('(6) the AI layer refuses to run inside a nightly context (zero AI calls at night)', async () => {
  const d = aiDeps('NIGHT');
  const nightCtx = createContext({ mode: 'nightly', runId: 'n', logger: new Logger({ sink: () => {}, scope: 'n', now: () => new Date(0) }), clock: { now: () => NOW_MS }, sleep: async () => {}, random: () => 0 });
  const r = await runAiBatch({ ...d, ctx: nightCtx }, 'buy', [reqOf('AAPL')], { gemini: true, opus: true }, 'medium');
  assert.deepEqual(r.results[0]!.lines, []);
  assert.equal(r.totals.geminiOk + r.totals.opusOk, 0);
});

test('(6) the production adapter keeps the mandatory Opus disclosure line on both tabs and writes no raw error text (F5)', async () => {
  const n = await runNight();
  const r = await manualAiRun(n.be, 'DISCL');
  for (const [tab, batch] of [[EXIT_SHEET_TAB, r.exit], [BUY_SHEET_TAB, r.buy]] as const) {
    const cells = cellsOf(n.be, tab);
    for (const x of batch.results) {
      const o = x.opus;
      assert.equal(o.state, 'ok');
      if (o.state === 'ok') assert.ok(cells.some((c) => c.includes(o.disclosureLine)), tab + ': disclosure line present for ' + x.ticker);
    }
    assert.ok(!cells.some((c) => /AI SUMMARY \(GEMINI\)|CLAUDE OPUS (?:REVIEW|ANALYSIS)/.test(c)), tab + ': no technical header lines');
  }
});

// ───────────────────────── (7) no "cache" wording ─────────────────────────

test('(7) no cache/cached wording in any report cell (before and after the AI run) or in the nightly plain summary', async () => {
  const n = await runNight();
  const CACHE = /\bcach(?:e|ed|es|ing)\b/i;
  for (const tab of [EXIT_SHEET_TAB, BUY_SHEET_TAB]) assert.deepEqual(cellsOf(n.be, tab).filter((c) => CACHE.test(c)), [], tab);
  await manualAiRun(n.be, 'CACHECHK');
  for (const tab of [EXIT_SHEET_TAB, BUY_SHEET_TAB]) assert.deepEqual(cellsOf(n.be, tab).filter((c) => CACHE.test(c)), [], tab + ' after AI');
  assert.doesNotMatch(buildPlainSummary(n.summary).join('\n'), CACHE);
});

// ───────────────────────── (8) long-only wording ─────────────────────────

test('(8) long-only: no put / short wording in any report cell except the long-only disclaimer (and plain "short-term" / "short interest")', async () => {
  const n = await runNight();
  await manualAiRun(n.be, 'LONGONLY');
  const ALLOWED = [BUY_T.longOnly, /short[- ]term/gi, /short interest/gi];
  // 'short' alone is ordinary English ("a short one"); only trading senses are forbidden
    const BAD = /\b(?:puts?|shorting|short[- ]sell\w*|sell(?:ing)? short|go(?:ing)? short|short positions?|shorts? the stock|naked|writ(?:e|ing) (?:a )?calls?|sell(?:ing)? (?:a )?calls?)\b/i;
  const offenders: string[] = [];
  for (const tab of [EXIT_SHEET_TAB, BUY_SHEET_TAB]) {
    for (const cell of cellsOf(n.be, tab)) {
      let c = cell;
      for (const a of ALLOWED) c = typeof a === 'string' ? c.split(a).join('') : c.replace(a, '');
      if (BAD.test(c)) offenders.push(tab + ': ' + cell.slice(0, 120));
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(cellsOf(n.be, BUY_SHEET_TAB).some((c) => c.includes(BUY_T.longOnly)), 'the long-only disclaimer line is on the Buy report');
});
