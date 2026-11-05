/**
 * FL-7b3 integration pass: the Master Lock around every entry's writes, the legacy menu items as CLI commands
 * (verify triggers G2), the data-quality items for skipped / not-run steps (F-H5), the failure sheet (F-H4, F-H6)
 * and the bottom line (F-I5, F-I8), fixed by default with the legacy text behind legacyReportText.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts'; // FL-7b3
import { Logger } from '../src/core/logger.ts';
import { ok, err, logDetail } from '../src/core/result.ts';
import type { StepResult } from '../src/core/result.ts';
import { lockFailureSentence, type LockPhase, type TabColorChange, type TabColorInfo } from '../src/sheets/client.ts';
import { LOCK_COLOR } from '../src/sheets/masterLock.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from '../src/app/sheetWrites.ts';
import { runMenuCommand, MENU_COMMANDS } from '../src/app/menuCommands.ts';
import { statusQualityItems, PENDING_BEFORE_DASHBOARD, PENDING_MEANS_NOT_RUN } from '../src/core/messages.ts';
import { dataQualityLines } from '../src/reports/messages/catalog.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { buildFailureSheet, ANALYSIS_TAB, DASH_COLS } from '../src/reports/text/textReports.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { main, USAGE } from '../src/cli.ts';
import { resolveMenus } from '../src/verify/triggerChecklist.ts';
import { loadPackageScripts } from '../src/verify/parityLoad.ts';
import { WORKFLOWS } from '../src/workflows/schedule.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';

const quietCtx = () => createContext({ mode: 'test', logger: new Logger({ sink: () => {}, scope: 't', now: () => new Date(0) }), sleep: async () => {} });

class FakeLock {
  events: string[] = [];
  fail: LockPhase | null = null;
  async tabColors(_c: unknown, phase: LockPhase): Promise<StepResult<TabColorInfo[]>> {
    this.events.push('read:' + phase);
    return ok([{ sheetId: 1, title: 'A', color: LOCK_COLOR, themed: false }, { sheetId: 2, title: 'B', color: null, themed: false }]);
  }
  async setTabColors(_c: unknown, phase: LockPhase, ch: readonly TabColorChange[]): Promise<StepResult<number>> {
    this.events.push('write:' + phase);
    if (this.fail === phase) return err({ kind: 'transient', detail: logDetail('boom'), disclosure: lockFailureSentence(phase), attempts: 1 });
    return ok(ch.length);
  }
}

describe('FL-7b3 -- Master Lock around the entry writes', () => {
  test('memory runs as is; sheets: unlock -> run -> lock; a failed unlock writes nothing; a failed re-lock is one plain line', async () => {
    const ctx = quietCtx();
    assert.deepEqual(await withSheetWrites({ ctx, sheets: null }, async () => 7), { value: 7, reportLines: [] });
    const L = new FakeLock();
    const r = await withSheetWrites({ ctx, sheets: L as never }, async () => { L.events.push('run'); return 1; });
    assert.deepEqual(L.events, ['read:unlock', 'write:unlock', 'run', 'read:lock', 'write:lock']);
    assert.deepEqual(r, { value: 1, reportLines: [] });
    const U = new FakeLock(); U.fail = 'unlock';
    let ran = false;
    await assert.rejects(withSheetWrites({ ctx, sheets: U as never }, async () => { ran = true; }), (e: unknown) => isUnlockFailure(e));
    assert.equal(ran, false);
    assert.deepEqual(U.events.slice(-2), ['read:lock', 'write:lock'], 'the lock is put back even when the unlock failed');
    assert.equal(UNLOCK_FAILED_LINE, 'Sheet lock: The sheet tabs could not be unlocked, so nothing was written.');
    const R = new FakeLock(); R.fail = 'lock';
    const r2 = await withSheetWrites({ ctx, sheets: R as never }, async () => 'x');
    assert.equal(r2.value, 'x');
    assert.equal(r2.reportLines.length, 1);
    assert.deepEqual(findReportLeaks(String(r2.reportLines[0])), []);
    const T = new FakeLock();
    await assert.rejects(withSheetWrites({ ctx, sheets: T as never }, async () => { throw new Error('mid-write'); }), /mid-write/);
    assert.deepEqual(T.events.slice(-2), ['read:lock', 'write:lock'], 'a crash mid-write still re-locks');
  });

  // The entries (cli.ts, nightly.ts, ticker.ts, myOptions.ts, ai.ts, app/menuCommands.ts) call withSheetWrites; their
  // memory-mode runs are exercised by fl7b2.entries and the menu-command tests below.
});

describe('FL-7b3 -- data quality for skipped and not-run steps (F-H5)', () => {
  test('failed, degraded and skipped are listed; pending only where it means the step did not run', () => {
    const now = new Date('2026-10-26T15:00:00Z');
    const st = {
      price: { state: 'ok' }, options: { state: 'skipped' }, darkPool: { state: 'degraded', reasonCode: 'NO_DATA_FOR_TICKER' },
      gann: { state: 'failed', reasonCode: 'SECTION_UNAVAILABLE' }, aiReview: { state: 'pending' }, macroRegime: { state: 'pending' }, turtleModel: { state: 'pending' },
    };
    const order = ['price', 'options', 'darkPool', 'gann', 'aiReview', 'macroRegime', 'turtleModel'];
    const keys = (p?: readonly string[]): string[] => statusQualityItems(st as never, now, { order, ...(p ? { pendingNotRun: p } : {}) }).map((q) => q.key);
    assert.deepEqual(keys(), ['options', 'darkPool', 'gann']);
    assert.deepEqual(keys(PENDING_BEFORE_DASHBOARD), ['options', 'darkPool', 'gann', 'aiReview']);
    assert.deepEqual(keys(PENDING_MEANS_NOT_RUN), ['options', 'darkPool', 'gann', 'aiReview', 'turtleModel'], 'macroRegime stays out (F-11: a blocked ticker never writes it)');
    assert.deepEqual(statusQualityItems(st as never, now, { order, skip: new Set(['gann']) }).map((q) => q.key), ['options', 'darkPool']);
    const lines = dataQualityLines(statusQualityItems(st as never, now, { order, pendingNotRun: PENDING_MEANS_NOT_RUN }).map((q) => q.item));
    assert.equal(lines[0], 'Data quality');
    assert.ok(lines.includes('Note: Options snapshot: This step did not run. This source is left out of the result.'), lines.join(' | '));
    for (const l of lines) assert.deepEqual(findReportLeaks(l), [], l);
    assert.deepEqual(statusQualityItems(null, now, { order }), []);
  });
});

describe('FL-7b3 -- failure sheet and bottom line, fixed by default', () => {
  const TIME = { nowMs: Date.parse('2026-10-26T15:00:00Z'), timeZone: 'America/New_York' };
  const open = () => ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);

  test('failure sheet: skipped has its own icon (F-H4); a non-string error message is a plain reason, not a crash (F-H6); legacy keeps both', async () => {
    const st = { price: { label: 'Price (OHLCV)', state: 'failed', reasonCode: 'RATE_LIMIT' }, spyRS: { label: 'SPY', state: 'skipped' } };
    const P = await open();
    buildFailureSheet(P, 'X', st as never, { message: 42 }, TIME);
    const g = P.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS);
    assert.ok(String(g[1]![0]).startsWith('Reason: '));
    assert.ok(g.some((r) => r[0] === 'SPY' && r[1] === '⏭ skipped'), JSON.stringify(g));
    const L = await open();
    buildFailureSheet(L, 'X', st as never, new Error('e'), TIME, { legacyReportText: true });
    assert.ok(L.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS).some((r) => r[0] === 'SPY' && r[1] === 'skipped'));
    const L2 = await open();
    assert.throws(() => buildFailureSheet(L2, 'X', st as never, { message: 42 }, TIME, { legacyReportText: true }), TypeError);
  });

  test('bottom line: F-I5 no throw on a missing T1 R:R or tech plan; F-I8 the ladder error is a plain line with its detail in the log; legacy keeps both', async () => {
    const deps = { clock: { now: () => TIME.nowMs }, timeZone: TIME.timeZone };
    const tp = { techScore: 60, timing: 'BUY_NOW', regime: 'TREND_UP', rrToT1: null, rrToT1AtSpot: 1.8, entryPrice: 100, entryCount: 3, entryLow: 90, entryHigh: 99, t1: { price: 120 }, t2: { price: 130 }, atr14: 2.5, stop: 90 };
    const tab = BOTTOM_LINE_TAB;
    const A = await open();
    buildBottomLineSummary(A, 'T', { score: 70 }, tp, { action: 'BUY', finalConviction: 70 }, null, null, deps);
    assert.ok(A.getSheetByName(tab)!.grid().some((r) => r[0] === "📍 R:R at today's price" && r[1] === 'T1 R:R 1.80'));
    const L = await open();
    assert.throws(() => buildBottomLineSummary(L, 'T', { score: 70 }, tp, { action: 'BUY', finalConviction: 70 }, null, null, { ...deps, legacyReportText: true }), TypeError);
    const N = await open();
    buildBottomLineSummary(N, 'T', null, null as never, null, null, null, deps);
    assert.ok(N.getSheetByName(tab)!.grid().some((r) => r[0] === '📊 Stock Timing (short-term)' && r[1] === 'N/A — N/A  (regime: N/A)'));
    const NL = await open();
    assert.throws(() => buildBottomLineSummary(NL, 'T', null, null as never, null, null, null, { ...deps, legacyReportText: true }), TypeError);
    const logs: string[] = [];
    const B = await open();
    buildBottomLineSummary(B, 'T', { score: 1 }, { ...tp, rrToT1: 1.2, t1: { price: 'x' as unknown as number } }, null, null, null, { ...deps, onReportDetail: (l) => logs.push(l) });
    assert.ok(B.getSheetByName(tab)!.grid().some((r) => r[0] === '🪜 LILO Ladder' && r[1] === 'This section could not be built.'));
    assert.ok(logs.some((l) => /LILO ladder failed: /.test(l)), logs.join(' | '));
  });
});

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };
const CLOCK = { now: () => Date.parse('2026-10-26T15:00:00Z') };
class NoNet implements HttpTransport {
  readonly urls: string[] = [];
  async send(req: HttpRequest): Promise<HttpResponse> { this.urls.push(req.url); return new HttpResponse(404, new TextEncoder().encode('not found')); }
}
function cap(env: Record<string, string> = ENV) {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (x: string) => { out.push(x); }, err: (x: string) => { err.push(x); }, env } };
}

describe('FL-7b3 -- the legacy menu items as CLI commands', () => {
  test('verify triggers G2: every legacy menu item names a command that exists', () => {
    const fromUsage = [...USAGE.matchAll(/^\s{2}([a-z][a-z0-9-]*)/gm)].map((m) => m[1] as string);
    for (const c of MENU_COMMANDS) assert.ok(fromUsage.includes(c), 'USAGE lists ' + c);
    const rows = resolveMenus({
      workflowFiles: WORKFLOWS.map((w) => w.file), availableCommands: [...loadPackageScripts().available, ...fromUsage],
      run: null, rollbackTestedOn: null, userApprovedRemovalOn: null, openBlockingFindings: [], liveTriggerCountAfterRemoval: null,
    });
    assert.deepEqual(rows.filter((r) => r.status !== 'READY').map((r) => r.label + ': ' + r.detail), []);
  });

  test('help, check-keys and the usage errors need no network', async () => {
    const h = cap();
    assert.equal(await main(['help'], h.io), 0);
    assert.match(h.out.join(''), /cli: options/);
    const k = cap();
    assert.equal(await main(['check-keys'], k.io), 1);
    assert.match(k.out.join(''), /^Missing keys: FMP_API_KEY, ALPHAVANTAGE_KEY, FINNHUB_KEY, GEMINI_API_KEY\.\n$/);
    const all = cap({ ...ENV, FMP_API_KEY: 'secret-1', ALPHAVANTAGE_KEY: 'secret-2', FINNHUB_KEY: 'secret-3', GEMINI_API_KEY: 'secret-4' });
    assert.equal(await main(['check-keys'], all.io), 0);
    assert.ok(!/secret-/.test(all.out.join('') + all.err.join('')), 'no key value is ever printed');
    const u1 = cap();
    assert.equal(await main(['options-call'], u1.io), 2);
    assert.match(u1.err.join(''), /Please give a ticker symbol/);
    const u2 = cap();
    assert.equal(await main(['position', 'TSLA'], u2.io), 2);
    const u3 = cap();
    assert.equal(await main(['nonsense'], u3.io), 2);
  });

  test('methodology, sheet-size and cleanup-price-caches on a memory workbook', async () => {
    const m = cap();
    assert.equal(await runMenuCommand('methodology', ['--memory'], m.io, { clock: CLOCK }), 0);
    assert.match(m.out.join(''), /Methodology sheet built/);
    const s = cap();
    assert.equal(await runMenuCommand('sheet-size', ['--memory'], s.io, { clock: CLOCK, initialTabs: { Alpha: [['a', 'b'], ['c', 'd']] } }), 0);
    assert.match(s.out.join(''), /Total real sheets: 1[\s\S]*Alpha: 4 cells/);
    const stale = [['Date', 'Close'], [new Date('2025-01-02T00:00:00Z'), 1], [new Date('2025-01-03T00:00:00Z'), 2]];
    // F-B3-1: the store tabs carry the same '💾 ' prefix; an old last row must never put them on the list
    const tabs = { '💾 OLD': stale, '💾 13F Cache': stale, '💾 Script Properties': stale, '💾 RS Ranking': stale, Keep: [['x']] };
    const d = cap();
    assert.equal(await runMenuCommand('cleanup-price-caches', ['--memory'], d.io, { clock: CLOCK, initialTabs: tabs }), 0);
    assert.match(d.out.join(''), /Delete 1 stale price-cache sheet\?[\s\S]*Nothing was deleted/);
    const y = cap();
    assert.equal(await runMenuCommand('cleanup-price-caches', ['--memory', '--yes'], y.io, { clock: CLOCK, initialTabs: tabs }), 0);
    assert.match(y.out.join(''), /Deleted 1 stale price-cache sheet\./);
  });

  test('network commands with no data: plain lines, the technical detail in the log only', async () => {
    const plain = (lines: string[]): void => { for (const l of lines.join('').split('\n')) assert.deepEqual(findReportLeaks(l), [], l); };
    const c = cap();
    assert.equal(await runMenuCommand('chart', ['TSLA', '--memory'], c.io, { transport: new NoNet(), clock: CLOCK }), 1);
    assert.match(c.out.join(''), /Could not load chart data for TSLA/);
    const dg = cap();
    assert.equal(await runMenuCommand('options-diagnose', ['--memory'], dg.io, { transport: new NoNet(), clock: CLOCK }), 1);
    assert.equal(dg.out.join(''), 'The options data source did not answer as expected. Details are in the log.\n');
    assert.match(dg.err.join(''), /options diagnostic: HTTP code/);
    const p = cap();
    assert.equal(await runMenuCommand('position', ['TSLA', '250', '2025-03-03', '--memory'], p.io, { transport: new NoNet(), clock: CLOCK }), 1);
    assert.ok(p.out.join('').trim().length > 0);
    const oc = cap();
    assert.equal(await runMenuCommand('options-call', ['TSLA', '--memory'], oc.io, { transport: new NoNet(), clock: CLOCK }), 0);
    assert.match(oc.out.join(''), /^📞 Recommended Call — TSLA/);
    const o = cap();
    const code = await runMenuCommand('options', ['TSLA', '--memory'], o.io, { transport: new NoNet(), clock: CLOCK });
    assert.ok(code === 0 || code === 1);
    assert.match(o.out.join(''), /options analysis/i);
    plain(o.out);
    const x = cap();
    assert.equal(await runMenuCommand('exit-report', ['--memory'], x.io, { transport: new NoNet(), clock: CLOCK, initialTabs: { Portfolio: [['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'], ['TSLA', 'stock', 10, 250, '2025-03-03']] } }), 0);
    assert.match(x.out.join(''), /Exit Strategy report/);
    plain(x.out);
  });
});
