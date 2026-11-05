import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { LogLine } from '../src/core/logger.ts';
import type { PortfolioSummary } from '../src/portfolio/transactions.ts';
import type { DailyAnalysisResult } from '../src/jobs/automation/dailyAutomation.ts';
import { mapLimit, runNightly, type RunSummary } from '../src/jobs/nightly/nightly.ts';
import type { NightlyDeps, NightlyJob, NightlyOptions } from '../src/jobs/nightly/nightly.ts';
import { NIGHTLY_ORDER, NIGHTLY_STEPS, SEPARATE_JOBS } from '../src/jobs/nightly/steps.ts';
import type { NightlyStepId } from '../src/jobs/nightly/steps.ts';
import { buildLogLines, buildPlainSummary } from '../src/jobs/nightly/summary.ts';

const RAW = /https?:|:\/\/|Error:|\bat \S+ \(|\bstatus\b|\b[45]\d\d\b|ECONN|apikey|SECRET/i;

function httpErr(status: number, msg = 'request failed'): Error {
  return Object.assign(new Error('HTTP ' + status + ' ' + msg), { status });
}
const GOOD: DailyAnalysisResult = { fundResult: { score: 1 }, techPlan: { techScore: 1, regime: 'x' }, decision: { finalConviction: 50, action: 'HOLD' } };

function mk(manual?: { now: () => number }) {
  const lines: LogLine[] = [];
  let t = 1_000;
  const clock = manual ?? { now: () => (t += 10) };
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'nightly', now: () => new Date(0) });
  const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, clock, sleep: async () => {}, random: () => 0 });
  return { ctx, lines, log };
}

function okJobs(calls: string[]): Partial<Record<NightlyStepId, NightlyJob>> {
  const j: Partial<Record<NightlyStepId, NightlyJob>> = {};
  for (const id of ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh', 'buy.report', 'exit.report', 'paper.trade', 'live.dryRun'] as const) {
    j[id] = async () => { calls.push(id); };
  }
  return j;
}

function base(over: Partial<NightlyDeps> & { calls?: string[] } = {}) {
  const { ctx, lines, log } = mk();
  const calls = over.calls ?? [];
  const deps: NightlyDeps = {
    ctx,
    jobs: okJobs(calls),
    readPortfolio: () => ({ positions: [{ ticker: 'aapl', assetType: 'STOCK' }, { ticker: 'MSFT', assetType: 'OPTION' }], warnings: [] }) as unknown as PortfolioSummary,
    readWatchlist: () => ['AAPL', 'NVDA', 'amd'],
    runAnalysis: async () => GOOD,
    afterAnalysis: async () => { calls.push('analysis.summary'); },
    ...over,
  };
  return { deps, lines, log, calls, ctx };
}

const stepOf = (s: RunSummary, id: string) => s.steps.find((x) => x.id === id)!;

test('step data: approved F-76 order, myOptions is separate', () => {
  assert.deepEqual([...NIGHTLY_ORDER], ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh', 'options.chains', 'analysis.tickers', 'analysis.summary', 'buy.report', 'exit.report', 'options.reads', 'fundamentals.history', 'paper.trade', 'live.dryRun']);
  assert.ok(!NIGHTLY_ORDER.includes('myOptions.refresh' as NightlyStepId));
  assert.equal(SEPARATE_JOBS[0].id, 'myOptions.refresh');
  assert.equal(SEPARATE_JOBS[0].inNightlyChain, false);
  for (const s of NIGHTLY_STEPS) {
    assert.equal(s.retries, 2);
    assert.ok(s.timeoutMs > 0);
    for (const d of s.dependsOn) assert.ok(NIGHTLY_ORDER.indexOf(d) < NIGHTLY_ORDER.indexOf(s.id), 'dependency comes earlier');
    assert.ok(!/cache/i.test(s.failedText + s.staleText));
  }
});

test('order respected; sets and dedupe', async () => {
  const seen: string[] = [];
  const calls: string[] = [];
  const { deps } = base({ calls, runAnalysis: async (t) => { seen.push(t); return GOOD; } });
  const s = await runNightly(deps);
  assert.deepEqual(s.steps.map((x) => x.id), [...NIGHTLY_ORDER]);
  assert.deepEqual(calls, ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh', 'analysis.summary', 'buy.report', 'exit.report', 'paper.trade', 'live.dryRun']);
  assert.deepEqual(s.tickers.map((t) => t.ticker), ['AAPL', 'MSFT', 'NVDA', 'AMD']);
  assert.deepEqual(s.tickers[0].sets, ['portfolio', 'watchlist']);
  assert.deepEqual(seen.slice().sort(), ['AAPL', 'AMD', 'MSFT', 'NVDA']);
  assert.equal(s.overall, 'ok');
  assert.equal(s.stepCounts.ok, 10);
});

test('a failing step does not stop the next; dependants are degraded, not skipped', async () => {
  const calls: string[] = [];
  const { deps } = base({ calls });
  deps.jobs['darkPool.evaluativeIndex'] = async () => { throw httpErr(403, 'forbidden'); };
  const s = await runNightly(deps);
  assert.equal(stepOf(s, 'darkPool.evaluativeIndex').state, 'failed');
  assert.equal(stepOf(s, 'darkPool.evaluativeIndex').attempts, 1, 'permanent error is not retried');
  for (const id of ['darkPool.relativeStrength', 'macro.refresh', 'analysis.summary', 'exit.report']) assert.ok(calls.includes(id), id + ' still ran');
  assert.equal(stepOf(s, 'analysis.tickers').state, 'degraded');
  assert.equal(stepOf(s, 'exit.report').state, 'degraded');
  assert.equal(s.tickerCounts.ok, 4);
  assert.equal(s.overall, 'partial');
});

test('retries counted: transient fails twice then works; always-failing stops at 3', async () => {
  let n = 0;
  let m = 0;
  const { deps } = base();
  deps.jobs['macro.refresh'] = async () => { n++; if (n < 3) throw httpErr(503); };
  deps.jobs['darkPool.tracker'] = async () => { m++; throw httpErr(503); };
  const s = await runNightly(deps);
  assert.equal(n, 3);
  assert.equal(stepOf(s, 'macro.refresh').state, 'ok');
  assert.equal(stepOf(s, 'macro.refresh').attempts, 3);
  assert.equal(m, 3);
  assert.equal(stepOf(s, 'darkPool.tracker').state, 'failed');
  assert.equal(stepOf(s, 'darkPool.tracker').attempts, 3);
});

test('per-ticker isolation, ticker retry, and no decision', async () => {
  const tries: Record<string, number> = {};
  const { deps } = base({
    readWatchlist: () => ['AAA', 'BAD', 'FLAKY', 'NODEC', 'ZZZ'],
    readPortfolio: undefined,
    runAnalysis: async (t) => {
      tries[t] = (tries[t] ?? 0) + 1;
      if (t === 'BAD') throw httpErr(400, 'bad ticker');
      if (t === 'FLAKY' && tries[t] < 2) throw httpErr(503);
      if (t === 'NODEC') return { ...GOOD, decision: null };
      return GOOD;
    },
  });
  const s = await runNightly(deps);
  const by = (t: string) => s.tickers.find((x) => x.ticker === t)!;
  assert.equal(by('BAD').state, 'failed');
  assert.equal(by('BAD').attempts, 1);
  assert.equal(by('FLAKY').state, 'ok');
  assert.equal(by('FLAKY').attempts, 2);
  assert.equal(by('NODEC').state, 'degraded');
  assert.equal(by('AAA').state, 'ok');
  assert.equal(by('ZZZ').state, 'ok');
  assert.deepEqual(s.tickerCounts, { ok: 3, degraded: 1, failed: 1, skipped: 0 });
  assert.equal(stepOf(s, 'analysis.tickers').state, 'degraded');
  assert.equal(stepOf(s, 'exit.report').state, 'ok');
});

test('concurrency never exceeds the limit (measured); default is 4', async () => {
  for (const [limit, expectMax] of [[3, 3], [undefined, 4]] as const) {
    let inflight = 0;
    let max = 0;
    const names = Array.from({ length: 12 }, (_, i) => 'T' + i);
    const { deps } = base({
      readWatchlist: () => names, readPortfolio: undefined,
      runAnalysis: async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return GOOD; },
    });
    const opts: NightlyOptions = limit ? { concurrency: limit } : {};
    const s = await runNightly(deps, opts);
    assert.equal(s.tickerCounts.ok, 12);
    assert.equal(max, expectMax);
  }
  let inflight = 0;
  let max = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (x) => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 3)); inflight--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(max, 2);
});

test('timeouts enforced: hung ticker and hung job', async () => {
  const { deps } = base({
    readWatchlist: () => ['HANG', 'OK1'], readPortfolio: undefined,
    runAnalysis: async (t) => (t === 'HANG' ? new Promise<never>(() => {}) : GOOD),
  });
  deps.jobs['macro.refresh'] = () => new Promise<never>(() => {});
  const s = await runNightly(deps, { tickerTimeoutMs: 20, tickerAttempts: 1, overrides: { 'macro.refresh': { timeoutMs: 20, retries: 0 } } });
  assert.equal(s.tickers.find((t) => t.ticker === 'HANG')!.state, 'failed');
  assert.equal(s.tickers.find((t) => t.ticker === 'OK1')!.state, 'ok');
  assert.equal(stepOf(s, 'macro.refresh').state, 'failed');
  assert.match(String(s.tickers.find((t) => t.ticker === 'HANG')!.detail), /exceeded/);
});

test('ticker phase budget uses the injected clock; remaining tickers are "not reached"', async () => {
  let now = 0;
  const { deps } = base({
    readWatchlist: () => ['A', 'B', 'C', 'D', 'E'], readPortfolio: undefined,
    runAnalysis: async () => { now += 100; return GOOD; },
  });
  const m = mk({ now: () => now });
  const s = await runNightly({ ...deps, ctx: m.ctx }, { concurrency: 1, tickerPhaseBudgetMs: 150 });
  assert.deepEqual(s.tickers.map((t) => t.state), ['ok', 'ok', 'skipped', 'skipped', 'skipped']);
  assert.equal(stepOf(s, 'analysis.tickers').state, 'degraded');
});

test('readers: one failing degrades; both failing fails; missing deps skip', async () => {
  const one = base({ readPortfolio: () => { throw httpErr(400); } });
  const s1 = await runNightly(one.deps);
  assert.equal(stepOf(s1, 'analysis.tickers').state, 'degraded');
  assert.match(String(stepOf(s1, 'analysis.tickers').reason), /portfolio holdings could not be read/);
  assert.equal(s1.tickers.length, 3);

  const both = base({ readPortfolio: () => { throw httpErr(400); }, readWatchlist: () => { throw httpErr(400); } });
  const s2 = await runNightly(both.deps);
  assert.equal(stepOf(s2, 'analysis.tickers').state, 'failed');
  assert.ok(both.calls.includes('exit.report'), 'later steps still run');

  const bare = base({ runAnalysis: undefined, afterAnalysis: undefined });
  bare.deps.jobs['exit.report'] = undefined;
  const s3 = await runNightly(bare.deps, { skip: ['macro.refresh'] });
  assert.equal(stepOf(s3, 'analysis.tickers').state, 'skipped');
  assert.equal(stepOf(s3, 'analysis.summary').state, 'skipped');
  assert.equal(stepOf(s3, 'exit.report').state, 'skipped');
  assert.equal(stepOf(s3, 'macro.refresh').state, 'skipped');
});

test('plain summary has no raw errors, urls, status numbers or stack lines; log has them (scrubbed)', async () => {
  const nasty = 'HTTP 503 from https://api.example.com/v1/x?apikey=SECRET123&y=1\nError: boom\n    at fetchIt (file.ts:10:5)';
  const { deps } = base({ readWatchlist: () => ['AAA', 'BAD'], readPortfolio: undefined,
    runAnalysis: async (t) => { if (t === 'BAD') throw Object.assign(new Error(nasty), { status: 400 }); return GOOD; } });
  deps.jobs['darkPool.tracker'] = async () => { throw new Error(nasty); };
  deps.jobs['macro.refresh'] = async () => ({ state: 'degraded', reason: 'HTTP 429 from https://fred.example.com Error: slow' });
  const s = await runNightly(deps);
  const plain = buildPlainSummary(s).join('\n');
  assert.doesNotMatch(plain, RAW);
  assert.match(plain, /BAD/);
  assert.match(plain, /Dark Pool Tracker/);
  assert.match(plain, /Total time/);
  const tech = buildLogLines(s).join('\n');
  assert.match(tech, /boom/);
  assert.match(tech, /attempts=3/);
  assert.doesNotMatch(tech, /SECRET123/);
  assert.match(tech, /apikey=\*\*\*/);
});

test('log escalation: failing step turns later steps verbose; failing ticker replays only its own lines', async () => {
  const a = base();
  a.deps.jobs['darkPool.tracker'] = async () => { throw httpErr(400, 'nope'); };
  await runNightly(a.deps);
  assert.ok(a.lines.some((l) => l.level === 40 && l.message.includes('Dark Pool Tracker')), 'ERROR logged');
  assert.ok(a.log.isEscalated());
  assert.ok(a.lines.some((l) => l.level === 10 && l.scope === 'nightly' && l.message.includes('Evaluative Index')), 'later step logs DEBUG');

  const b = base({ readWatchlist: () => ['GOOD', 'BAD'], readPortfolio: undefined,
    runAnalysis: async (t) => { if (t === 'BAD') throw httpErr(400); return GOOD; } });
  await runNightly(b.deps);
  assert.ok(b.lines.some((l) => l.scope === 'nightly:BAD' && l.replayed), 'BAD replayed its buffered lines');
  assert.ok(b.lines.some((l) => l.scope === 'nightly:BAD' && l.level === 40));
  assert.ok(!b.lines.some((l) => l.scope === 'nightly:GOOD' && l.level === 10), 'clean ticker stays at INFO');
});
