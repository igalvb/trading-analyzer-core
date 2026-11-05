/**
 * Owner 2026-11-04 "everything with proper logs" (docs/LOGGING_SPEC.md): the CRITICAL level, the run-wide counts,
 * the full log file (every level), the leveled text adapter, the logged fallback helper, and a few of the gaps the
 * audit closed (nightly CRITICAL sites, the startup refusal, the live dry run's ERROR line).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger, LogLevel, formatLine, levelOfText, textLog, type LogLine } from '../src/core/logger.ts';
import { fileSink, processLine, redactLine } from '../src/core/logFile.ts';
import { orElse, orElseAsync } from '../src/core/guard.ts';
import { createContext } from '../src/core/context.ts';
import { runNightly, reportCritical, type NightlyDeps, type NightlyJob } from '../src/jobs/nightly/nightly.ts';
import { buildLogLines } from '../src/jobs/nightly/summary.ts';
import { NIGHTLY_STEPS, stepDef, type NightlyStepId } from '../src/jobs/nightly/steps.ts';
import type { PortfolioSummary } from '../src/portfolio/transactions.ts';
import { composeServices } from '../src/compose.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { SheetsRefusedError } from '../src/sheets/threeSheets.ts';
import { FakeGoogle } from './fakeGoogleSheets.ts';

const fixedNow = (): Date => new Date('2026-11-04T00:00:00.000Z');
function capture(): { lines: LogLine[]; sink: (l: LogLine) => void } {
  const lines: LogLine[] = [];
  return { lines, sink: (l) => lines.push(l) };
}
const tmpFile = (name: string): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-')), name);

describe('CRITICAL level', () => {
  test('is 50, printed as CRITICAL, escalates and replays like ERROR', () => {
    const { lines, sink } = capture();
    const log = new Logger({ sink, now: fixedNow, scope: 'nightly' });
    log.debug('lead-up');
    log.critical('sheet unreachable', { detail: 'HTTP 403' });
    assert.equal(LogLevel.CRITICAL, 50);
    assert.ok(log.isEscalated());
    assert.ok(lines.some((l) => l.replayed && l.message === 'lead-up'), 'pre-buffer replayed');
    const crit = lines.find((l) => l.level === LogLevel.CRITICAL);
    assert.ok(crit);
    assert.match(formatLine(crit), /^2026-11-04T00:00:00\.000Z CRITICAL \[nightly\] sheet unreachable \{"detail":"HTTP 403"\}$/);
  });

  test('is not filtered by a high minimum level', () => {
    const { lines, sink } = capture();
    const log = new Logger({ sink, now: fixedNow, minLevel: LogLevel.ERROR });
    log.info('hidden');
    log.critical('shown');
    assert.deepEqual(lines.filter((l) => !l.replayed).map((l) => l.message), ['shown']);
  });

  test('counted per scope and run-wide (children share one tally)', () => {
    const { sink } = capture();
    const root = new Logger({ sink, now: fixedNow });
    const a = root.child('AAPL'), b = a.child('http');
    root.warning('w');
    a.error('e');
    b.critical('c1');
    a.critical('c2');
    assert.deepEqual(a.getCounts(), { debug: 0, info: 0, warning: 0, error: 1, critical: 1 });
    assert.deepEqual(root.runCounts(), { debug: 0, info: 0, warning: 1, error: 1, critical: 2 });
    assert.deepEqual(b.runCounts(), root.runCounts());
  });
});

describe('the full log (every level)', () => {
  test('fullSink gets DEBUG lines the console never shows, once each (no replay copies)', () => {
    const { lines, sink } = capture();
    const full: LogLine[] = [];
    const log = new Logger({ sink, now: fixedNow, fullSink: (l) => full.push(l) }).child('T');
    log.debug('d1');
    log.info('i1');
    log.warning('w1'); // replays d1 on the console
    assert.deepEqual(full.map((l) => l.message), ['d1', 'i1', 'w1']);
    assert.ok(full.every((l) => !l.replayed));
    assert.ok(lines.some((l) => l.message === 'd1' && l.replayed));
  });

  test('a throwing full sink never breaks the console log', () => {
    const { lines, sink } = capture();
    const log = new Logger({ sink, now: fixedNow, fullSink: () => { throw new Error('disk full'); } });
    log.info('still here');
    assert.equal(lines[0]?.message, 'still here');
  });

  test('fileSink writes formatted lines with secrets redacted; processLine also reaches the file', () => {
    const file = tmpFile('nightly.log');
    const sinkFn = fileSink(file, ['supersecretvalue']);
    assert.ok(sinkFn);
    const log = new Logger({ sink: () => {}, now: fixedNow, scope: 'nightly', fullSink: sinkFn });
    log.debug('GET https://x.example/q?apikey=abc123&t=1');
    log.critical('token supersecretvalue leaked?');
    const out: string[] = [];
    processLine('CRITICAL', 'run', 'crashed', { detail: 'boom' }, { RUN_LOG_FILE: file }, (t) => out.push(t));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, / DEBUG {3}\[nightly\] GET https:\/\/x\.example\/q\?apikey=\*\*\*&t=1/);
    assert.match(text, / CRITICAL \[nightly\] token \*\*\* leaked\?/);
    assert.match(text, / CRITICAL \[run\] crashed \{"detail":"boom"\}/);
    assert.ok(!text.includes('supersecretvalue') && !text.includes('abc123'));
    assert.match(out.join(''), /CRITICAL \[run\] crashed/);
    assert.equal(redactLine('Bearer abc.def'), 'Bearer ***');
  });

  test('composeServices with RUN_LOG_FILE: the run log file has DEBUG lines, secrets redacted', async () => {
    const file = tmpFile('analyze.log');
    const s = await composeServices({ storage: 'memory', env: { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', RUN_LOG_FILE: file, FMP_API_KEY: 'fmpkey-0123456789' }, logSink: () => {}, sleep: async () => {} });
    s.ctx.log.child('AAPL').debug('quiet detail fmpkey-0123456789');
    s.ctx.log.info('visible');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /DEBUG {3}\[ticker:AAPL\] quiet detail \*\*\*/);
    assert.match(text, /INFO {4}\[ticker\] visible/);
  });
});

describe('leveled text and the logged fallback', () => {
  test('levelOfText: ❌ = ERROR, ⚠️ / failure words = WARNING, else INFO', () => {
    assert.equal(levelOfText('❌ CBOE fetch failed'), 'error');
    assert.equal(levelOfText('⚠️ Combo page failed'), 'warning');
    assert.equal(levelOfText('paper test: Telegram failed: x'), 'warning');
    assert.equal(levelOfText('the PDF could not be made'), 'warning');
    assert.equal(levelOfText('options P0 summary: 14 of 16 read; 0 failed'), 'info');
    assert.equal(levelOfText('relative strength ranked 30/33'), 'info');
    const { lines, sink } = capture();
    textLog(new Logger({ sink, now: fixedNow }))('⚠️ no option chain for TSLA');
    assert.equal(lines.find((l) => !l.replayed)?.level, LogLevel.WARNING);
  });

  test('orElse / orElseAsync: fallback plus one line with the raw text in detail; a null logger stays silent', async () => {
    const { lines, sink } = capture();
    const log = new Logger({ sink, now: fixedNow, scope: 't' });
    assert.equal(orElse(log, 'next resistance', () => { throw new Error('bad atr'); }, null), null);
    assert.equal(await orElseAsync(log, 'QQQ chart fetch', async () => { throw new Error('HTTP 500'); }, 'fb', 'error'), 'fb');
    assert.equal(await orElseAsync(null, 'x', async () => { throw new Error('y'); }, 7), 7);
    assert.equal(orElse(log, 'ok path', () => 3, 0), 3);
    const own = lines.filter((l) => !l.replayed && l.level >= LogLevel.WARNING);
    assert.deepEqual(own.map((l) => [l.level, l.message, l.data?.detail]), [
      [LogLevel.WARNING, 'next resistance failed; using the fallback', 'bad atr'],
      [LogLevel.ERROR, 'QQQ chart fetch failed; using the fallback', 'HTTP 500'],
    ]);
  });
});

describe('nightly CRITICAL sites (docs/LOGGING_SPEC.md)', () => {
  const GOOD = { fundResult: { score: 1 }, techPlan: { techScore: 1, regime: 'x' }, decision: { finalConviction: 50, action: 'HOLD' } };
  function run(over: Partial<NightlyDeps>) {
    const lines: LogLine[] = [];
    let t = 1_000;
    const log = new Logger({ sink: (l) => lines.push(l), scope: 'nightly', now: () => new Date(0) });
    const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, clock: { now: () => (t += 10) }, sleep: async () => {}, random: () => 0 });
    const jobs: Partial<Record<NightlyStepId, NightlyJob>> = {};
    for (const s of NIGHTLY_STEPS) if (s.kind !== 'tickers' && s.id !== 'analysis.summary') jobs[s.id] = async () => {};
    const deps: NightlyDeps = {
      ctx, jobs,
      readPortfolio: () => ({ positions: [{ ticker: 'AAPL', assetType: 'STOCK' }], warnings: [] }) as unknown as PortfolioSummary,
      readWatchlist: () => ['NVDA'],
      runAnalysis: async () => GOOD,
      ...over,
    };
    return { lines, log, deps };
  }
  const crit = (lines: LogLine[]): string[] => lines.filter((l) => l.level === LogLevel.CRITICAL && !l.replayed).map((l) => l.message);

  test('which failed steps are critical: the reports, the analysis and what the reports read', () => {
    assert.ok(reportCritical(stepDef('buy.report')));
    assert.ok(reportCritical(stepDef('exit.report')));
    assert.ok(reportCritical(stepDef('analysis.tickers')));
    assert.ok(reportCritical(stepDef('darkPool.evaluativeIndex')), 'the Exit report depends on it');
    assert.ok(!reportCritical(stepDef('darkPool.tracker')));
    assert.ok(!reportCritical(stepDef('paper.trade')));
  });

  test('a clean run: no CRITICAL, and the summary log line carries the counts', async () => {
    const r = run({});
    const s = await runNightly(r.deps);
    assert.deepEqual(crit(r.lines), []);
    assert.deepEqual(s.logCounts, { warning: 0, error: 0, critical: 0 });
    assert.match(buildLogLines(s)[0] as string, / log\[warning=0 error=0 critical=0\]$/);
  });

  test('the Buy report failing: ERROR from runStep plus one CRITICAL; a non-report step failing: ERROR only', async () => {
    const r = run({});
    const jobs = r.deps.jobs as Partial<Record<NightlyStepId, NightlyJob>>;
    jobs['buy.report'] = async () => { throw Object.assign(new Error('HTTP 403 forbidden'), { status: 403 }); };
    jobs['darkPool.tracker'] = async () => { throw Object.assign(new Error('HTTP 403 forbidden'), { status: 403 }); };
    const s = await runNightly(r.deps);
    assert.deepEqual(crit(r.lines), ['Buy report failed: a report of tonight depends on it']);
    assert.ok(r.lines.some((l) => l.level === LogLevel.ERROR && l.message.startsWith('Dark Pool Tracker refresh failed')));
    assert.equal(s.logCounts?.critical, 1);
    assert.ok((s.logCounts?.error ?? 0) >= 2);
  });

  test('no ticker list readable: CRITICAL, and the raw error stays out of the report sentence', async () => {
    const r = run({
      readPortfolio: () => { throw new Error('ECONNRESET at socket'); },
      readWatchlist: () => { throw new Error('ECONNRESET at socket'); },
    });
    const s = await runNightly(r.deps);
    assert.ok(crit(r.lines).some((m) => m.startsWith('Stock analysis (portfolio and watchlist) failed: no ticker list could be read')));
    const step = s.steps.find((x) => x.id === 'analysis.tickers');
    assert.equal(step?.state, 'failed');
    assert.ok(!String(step?.reason).includes('ECONNRESET'));
  });

  test('every ticker failing: the analysis step is CRITICAL', async () => {
    const r = run({ runAnalysis: async () => { throw new Error('boom'); } });
    await runNightly(r.deps, { tickerAttempts: 1 });
    assert.ok(crit(r.lines).some((m) => m.startsWith('Stock analysis (portfolio and watchlist) failed: no stock could be analysed')));
  });
});

describe('startup refusal is CRITICAL', () => {
  test('My Portfolio without the Script Properties tab: SheetsRefusedError and one CRITICAL line', async () => {
    const g = new FakeGoogle();
    g.addBook('P', 'My Portfolio', { Portfolio: [['Ticker', 'type']] });
    const logs: LogLine[] = [];
    await assert.rejects(composeServices({
      storage: 'sheets', env: { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', SPREADSHEET_ID: 'P' },
      sheetsApi: g.api, sheetsLimiter: RateLimiter.perMinute(1_000_000), clock: { now: () => Date.parse('2026-11-04T12:00:00Z') }, sleep: async () => {},
      logSink: (l) => logs.push(l),
    }), SheetsRefusedError);
    assert.deepEqual(logs.filter((l) => l.level === LogLevel.CRITICAL).map((l) => l.message), ['startup refused: My Portfolio has no Script Properties tab']);
  });
});
