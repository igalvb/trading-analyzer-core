/**
 * 5 Nov Nightly log: (1) on a partial night only the overall line and the non-ok run-summary lines are WARNINGs;
 * (2) relative-strength tickers with too little price history are an expected skip (step ok, named on the line),
 * while a real fetch miss still degrades the step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger, LogLevel, type LogLine } from '../src/core/logger.ts';
import type { PortfolioSummary } from '../src/portfolio/transactions.ts';
import type { DailyAnalysisResult } from '../src/jobs/automation/dailyAutomation.ts';
import { runNightly, type NightlyDeps, type NightlyJob } from '../src/jobs/nightly/nightly.ts';
import type { NightlyStepId } from '../src/jobs/nightly/steps.ts';
import { buildPlainSummary } from '../src/jobs/nightly/summary.ts';
import { relativeStrengthOutcome } from '../src/app/nightlyApp.ts';
import { computeRelativeStrengthRanking, relativeStrengthMissKind, RELATIVE_STRENGTH_MIN_BARS, DARK_POOL_WATCHLIST } from '../src/analysis/darkPool.ts';

const GOOD: DailyAnalysisResult = { fundResult: { score: 1 }, techPlan: { techScore: 1, regime: 'x' }, decision: { finalConviction: 50, action: 'HOLD' } };

function run(jobs: Partial<Record<NightlyStepId, NightlyJob>>) {
  const lines: LogLine[] = [];
  let t = 1_000;
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'nightly', now: () => new Date(0) });
  const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, clock: { now: () => (t += 10) }, sleep: async () => {}, random: () => 0 });
  const all: Partial<Record<NightlyStepId, NightlyJob>> = {};
  for (const id of ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh', 'buy.report', 'exit.report', 'paper.trade', 'live.dryRun'] as const) all[id] = async () => {};
  const deps: NightlyDeps = {
    ctx, jobs: { ...all, ...jobs },
    readPortfolio: () => ({ positions: [{ ticker: 'AAPL', assetType: 'STOCK' }], warnings: [] }) as unknown as PortfolioSummary,
    readWatchlist: () => ['NVDA'],
    runAnalysis: async () => GOOD,
    afterAnalysis: async () => {},
  };
  return { lines, summary: runNightly(deps) };
}

const summaryLines = (lines: LogLine[]) => lines.filter((l) => /^(run \S+ overall=|step \S+ state=|ticker \S+ sets=)/.test(l.message));

test('partial night: the overall line and the non-ok step lines are WARNING, ok step lines are INFO', async () => {
  const { lines, summary } = run({ 'macro.refresh': async () => ({ state: 'degraded', reason: 'The macro data was only partly refreshed.' }) });
  const s = await summary;
  assert.equal(s.overall, 'partial');
  const sl = summaryLines(lines);
  const overall = sl.find((l) => l.message.startsWith('run '))!;
  assert.equal(overall.level, LogLevel.WARNING);
  const macro = sl.find((l) => l.message.startsWith('step macro.refresh '))!;
  assert.equal(macro.level, LogLevel.WARNING);
  const okSteps = sl.filter((l) => / state=ok /.test(l.message));
  assert.ok(okSteps.length >= 5, 'several ok steps logged');
  for (const l of okSteps) assert.equal(l.level, LogLevel.INFO, l.message);
  const skipped = sl.filter((l) => / state=skipped /.test(l.message));
  for (const l of skipped) assert.equal(l.level, LogLevel.WARNING, l.message);
});

test('ok night: every summary line stays INFO', async () => {
  const { lines, summary } = run({});
  assert.equal((await summary).overall, 'ok');
  for (const l of summaryLines(lines)) assert.equal(l.level, LogLevel.INFO, l.message);
});

test('relative strength: too-little-history tickers are skipped (ok) and named; the night stays ok', async () => {
  const { lines, summary } = run({ 'darkPool.relativeStrength': async () => relativeStrengthOutcome(108, 111, ['NEWA', 'NEWB', 'NEWC'], []) });
  const s = await summary;
  const st = s.steps.find((x) => x.id === 'darkPool.relativeStrength')!;
  assert.equal(st.state, 'ok');
  assert.equal(s.overall, 'ok');
  const line = summaryLines(lines).find((l) => l.message.startsWith('step darkPool.relativeStrength '))!;
  assert.equal(line.level, LogLevel.INFO);
  assert.ok(line.message.includes('3 skipped, too little history: NEWA, NEWB, NEWC'), line.message);
  assert.ok(!buildPlainSummary(s).join('\n').includes('NEWA'), 'an ok step adds nothing to the plain report');
});

test('relative strength: a real fetch miss still degrades, and names both groups', () => {
  const o = relativeStrengthOutcome(107, 111, ['NEWA'], ['XYZ', 'QQQ', 'ABC']);
  assert.equal(o.state, 'degraded');
  assert.equal(o.reason, 'The relative-strength ranking was refreshed for 107 of 111 stocks; 3 had no usable price data: XYZ, QQQ, ABC; 1 skipped, too little history: NEWA.');
  assert.deepEqual(relativeStrengthOutcome(111, 111, [], []), { state: 'ok' });
});

test('relativeStrengthMissKind: a short chart is SHORT_HISTORY; no chart or a fetch error is NO_DATA', async () => {
  const cat = Object.keys(DARK_POOL_WATCHLIST)[0]!;
  const [a, b] = DARK_POOL_WATCHLIST[cat]!;
  const bars = (n: number) => { const c = Array.from({ length: n }, (_, i) => 100 + i); return { closes: c, highs: c.map((x) => x + 1), lows: c.map((x) => x - 1) }; };
  const deps = { fetchChart: async (t: string) => (t === a ? bars(RELATIVE_STRENGTH_MIN_BARS - 1) : t === b ? null : bars(300)) };
  assert.equal(await computeRelativeStrengthRanking(deps, a!), null);
  assert.equal(await relativeStrengthMissKind(deps, a!), 'SHORT_HISTORY');
  assert.equal(await relativeStrengthMissKind(deps, b!), 'NO_DATA');
  assert.equal(await relativeStrengthMissKind({ fetchChart: async () => { throw new Error('boom'); } }, a!), 'NO_DATA');
});
