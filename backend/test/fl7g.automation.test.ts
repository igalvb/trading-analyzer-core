/**
 * FL-7g: runDailyAutomationV7, runAnalysisV7FromMenu, runCompleteTickerAnalysisV7(+Continued)
 * and the daily-trigger data, against the oracle. runAnalysisV7, runFullAnalysis,
 * showPriceChartV7, buildBottomLineSummaryV7, the macro/broker refreshes and MailApp are
 * recording stubs installed in the oracle (withOracleGlobals) AND injected in the port;
 * the comparison covers call logs (arguments, order), Logger lines, thrown messages,
 * the final clock, and every tab's recorded calls and cells.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { WATCHLIST_SHEET } from '../src/stores/watchlist.ts';
import { DAILY_TRIGGER_HANDLER, LEGACY_DAILY_TRIGGER } from '../src/jobs/automation/schedule.ts';
import { runDailyAutomation } from '../src/jobs/automation/dailyAutomation.ts';
import {
  FULL_TICKER_DIALOG, TICKER_PICKER_CHOICES, runAnalysisFromMenu, runCompleteTickerAnalysis, runCompleteTickerAnalysisContinued, stockMenuDialog,
} from '../src/jobs/automation/tickerRuns.ts';

const ready = legacyFilesPresent();
const skip = ready ? false : 'legacy/ not populated';
const LEG = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n') : [];
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T22:00:00Z');
const DH = '📈 Decision History';
const HIT = new Set<string>();

const oracle = (): ReturnType<typeof loadOracle> => loadOracle();
/** The live CONFIG_V7 object: a Function built in the oracle's realm sees its top-level const. */
const configV7 = (): { dailyTickers: string[]; alertEmail: string; version: string } => new ((oracle().fns.runDailyAutomationV7 as any).constructor)('return CONFIG_V7')();

async function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TZ; process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}
async function twin(initial: Record<string, unknown[][]> = {}) {
  const mk = async (): Promise<ReportWorkbook> => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
  return { L: await mk(), P: await mk() };
}
/** A Date for the oracle realm whose no-argument form and now() follow a mutable box (the analysis stubs advance it). */
function steppedDate(box: { t: number }): DateConstructor {
  const Real = Date;
  const S = function (this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return Real();
    return args.length ? new (Real as any)(...args) : new Real(box.t);
  } as unknown as DateConstructor;
  Object.defineProperty(S, 'now', { value: () => box.t });
  Object.defineProperty(S, 'UTC', { value: Real.UTC });
  Object.defineProperty(S, 'parse', { value: Real.parse });
  Object.defineProperty(S, 'prototype', { value: Real.prototype });
  Object.defineProperty(S, Symbol.hasInstance, { value: (x: unknown) => x instanceof Real });
  return S;
}
function assertSameBooks(L: ReportWorkbook, P: ReportWorkbook, where: string): void {
  const names = (b: ReportWorkbook) => b.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names(P), names(L), where + ' (tabs)');
  for (const sh of L.getSheets()) {
    const ps = P.getSheetByName(sh.getName())!;
    assert.deepStrictEqual(ps.calls, sh.calls, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.calls, L.calls, where + ' (workbook calls)');
}
const msgOf = (e: any): string => String(e && e.message ? e.message : e);
const clean = (a: unknown, ss: unknown): unknown => (a === ss ? '<SS>' : typeof a === 'function' ? '<fn>' : a);

// ---- daily scenarios
type Behave =
  | { kind: 'ok'; action: string; conv: number } | { kind: 'null' } | { kind: 'undef' } | { kind: 'nodecision' }
  | { kind: 'throw'; value: unknown } | { kind: 'nofund'; action: string; conv: number };
interface DailySpec {
  name: string; initial: Record<string, unknown[][]>; analysis?: Record<string, Behave>; step?: number;
  brokerThrow?: Record<string, unknown>; macroThrow?: unknown; mail?: 'ok' | 'throw'; email?: string; alertEmail?: string;
  dailyTickers?: string[]; repeat?: number;
}
const ok = (action: string, conv: number): Behave => ({ kind: 'ok', action, conv });
const wl = (...ts: string[]): unknown[][] => [['Ticker'], ...ts.map((t) => [t])];
const dh = (...rows: [string, string][]): unknown[][] => [
  ['Date', 'Ticker', 'OWN', 'TIMING Score', 'Final Conviction', 'Action'],
  ...rows.map(([t, a]) => [new Date('2026-10-01T00:00:00Z'), t, 5, 6, 60, a]),
];
function resultFor(t: string, b: Behave): any {
  if (b.kind === 'ok') return { fundResult: { score: 'F-' + t }, techPlan: { techScore: 7, regime: 'UP' }, decision: { action: b.action, finalConviction: b.conv } };
  if (b.kind === 'nofund') return { techPlan: { techScore: 7, regime: 'UP' }, decision: { action: b.action, finalConviction: b.conv } };
  if (b.kind === 'nodecision') return { fundResult: { score: 1 }, techPlan: { techScore: 2, regime: 'X' }, decision: null };
  if (b.kind === 'null') return null;
  if (b.kind === 'undef') return undefined;
  throw b.value;
}
function dailyStubs(spec: DailySpec, box: { t: number }, calls: unknown[][], ss: unknown) {
  return {
    runAnalysis: (...args: unknown[]): any => {
      calls.push(['runAnalysisV7', ...args.map((a) => clean(a, ss))]);
      box.t += spec.step ?? 0;
      const t = String(args[0]);
      return resultFor(t, spec.analysis?.[t] ?? ok('HOLD', 50));
    },
    refreshMacro: (log: any): void => {
      calls.push(['refreshMacroSnapshotV1_', typeof log]);
      if (spec.macroThrow !== undefined) throw spec.macroThrow;
      log('macro stub ran');
    },
    refreshBroker: (t: string, log: any): void => {
      calls.push(['refreshBrokerCourseDataCacheV1_', t, typeof log]);
      if (spec.brokerThrow && t in spec.brokerThrow) throw spec.brokerThrow[t];
      log('broker stub ran for ' + t);
    },
    sendEmail: (...a: unknown[]): void => {
      calls.push(['sendEmail', ...a]);
      if (spec.mail === 'throw') throw new Error('Service invoked too many times for one day: email.');
    },
    effective: (): string => { calls.push(['getEffectiveUser']); calls.push(['getEmail']); return spec.email ?? ''; },
  };
}
async function dailyBoth(spec: DailySpec) {
  const { L, P } = await twin(spec.initial);
  const cfg = configV7();
  const savedTickers = cfg.dailyTickers.slice(), savedEmail = cfg.alertEmail;
  const lcalls: unknown[][] = [], pcalls: unknown[][] = [], llogs: string[] = [], plogs: string[] = [];
  const lbox = { t: NOW }, pbox = { t: NOW };
  const lthrew: string[] = [], pthrew: string[] = [];
  const tickers = spec.dailyTickers ?? savedTickers;
  const alertEmail = spec.alertEmail ?? '';
  try {
    cfg.dailyTickers.splice(0, cfg.dailyTickers.length, ...tickers);
    cfg.alertEmail = alertEmail;
    await inZone(TZ, async () => {
      const ls = dailyStubs(spec, lbox, lcalls, L);
      for (let n = 0; n < (spec.repeat ?? 1); n++) {
        try {
          withOracleGlobals({
            Date: steppedDate(lbox), Logger: { log: (m: unknown) => { llogs.push(String(m)); } },
            SpreadsheetApp: { getActiveSpreadsheet: () => L },
            Session: { getEffectiveUser: () => ({ getEmail: () => ls.effective() }) },
            MailApp: { sendEmail: ls.sendEmail },
            runAnalysisV7: ls.runAnalysis, refreshMacroSnapshotV1_: ls.refreshMacro, refreshBrokerCourseDataCacheV1_: ls.refreshBroker,
            // Owner 2026-11-04 (backlog row 39): the port no longer writes the '🎯 Watchlist Summary' tab; legacy's writer is stubbed out.
            buildWatchlistSummarySheetV7: () => {},
          }, () => oracle().call('runDailyAutomationV7'));
        } catch (e) { lthrew.push(msgOf(e)); }
      }
      const ps = dailyStubs(spec, pbox, pcalls, P);
      const deps = {
        workbook: P, dailyTickers: tickers, alertEmail, clock: { now: () => pbox.t }, timeZone: TZ, log: (m: string) => { plogs.push(m); },
        refreshMacroSnapshot: async (log: any) => ps.refreshMacro(log),
        refreshBrokerCourseDataCache: async (t: string, log: any) => ps.refreshBroker(t, log),
        runAnalysis: async (...a: unknown[]) => (ps.runAnalysis as any)(...a),
        sendEmail: async (...a: unknown[]) => (ps.sendEmail as any)(...a),
        getEffectiveUserEmail: async () => ps.effective(),
        historyPolicy: { legacyDoubleAppend: true },
      };
      for (let n = 0; n < (spec.repeat ?? 1); n++) {
        try { await runDailyAutomation(deps as any); } catch (e) { pthrew.push(msgOf(e)); }
      }
    });
  } finally {
    cfg.dailyTickers.splice(0, cfg.dailyTickers.length, ...savedTickers);
    cfg.alertEmail = savedEmail;
  }
  assert.deepStrictEqual(pcalls, lcalls, spec.name + ' call log');
  assert.deepStrictEqual(plogs, llogs, spec.name + ' logs');
  assert.deepStrictEqual(pthrew, lthrew, spec.name + ' thrown');
  assert.equal(pbox.t, lbox.t, spec.name + ' clock');
  assertSameBooks(L, P, spec.name);
  // Coverage keys are derived from the LEGACY side only: a scenario that never reaches a branch on the oracle fails the guard.
  const obs = (k: string, c: boolean): void => { if (c) HIT.add(k); };
  const lw = L.getSheetByName(WATCHLIST_SHEET)!;
  obs('seeded-from-config', lw.calls.some((c) => c[0] === 'range:setValues' && c[1] === 2 && c[2] === 1));
  obs('config-empty-no-seed', tickers.length === 0 && !lw.calls.some((c) => c[0] === 'range:setValues' && c[1] === 2));
  obs('watchlist-existing-rows', (spec.initial[WATCHLIST_SHEET] ?? []).length > 1);
  obs('time-guard', llogs.some((l) => l.startsWith('⚠ Time budget guard')));
  obs('analysis-null', Object.values(spec.analysis ?? {}).some((b) => b.kind === 'null'));
  obs('analysis-undefined', Object.values(spec.analysis ?? {}).some((b) => b.kind === 'undef'));
  obs('no-decision', Object.values(spec.analysis ?? {}).some((b) => b.kind === 'nodecision'));
  obs('analysis-throws-Error', llogs.some((l) => l.startsWith('Daily automation error for') && /boom/.test(l)));
  obs('analysis-throws-string', llogs.some((l) => l.endsWith(': plain string failure')));
  obs('analysis-throws-null', llogs.some((l) => l.endsWith(': null')));
  obs('broker-throws', llogs.some((l) => l.startsWith('Daily automation error for') && /broker down/.test(l)));
  obs('decision-written', !!L.getSheetByName(DH)?.calls.some((c) => c[0] === 'appendRow'));
  obs('change-detected', lcalls.some((c) => c[0] === 'sendEmail') || llogs.some((l) => l.startsWith('❌ ALERT FAILED')));
  obs('email-sent-ok', spec.mail !== 'throw' && lcalls.some((c) => c[0] === 'sendEmail'));
  obs('email-two-tickers', lcalls.some((c) => c[0] === 'sendEmail' && /, /.test(String(c[2]))));
  obs('email-fails', llogs.some((l) => l.startsWith('Failed to send digest email to ')));
  obs('no-recipient', llogs.some((l) => l.startsWith('❌ ALERT FAILED')));
  obs('configured-recipient', alertEmail !== '' && lcalls.some((c) => c[0] === 'sendEmail' && c[1] === alertEmail) && !lcalls.some((c) => c[0] === 'getEffectiveUser'));
  obs('effective-user-recipient', alertEmail === '' && lcalls.some((c) => c[0] === 'getEffectiveUser') && lcalls.some((c) => c[0] === 'sendEmail'));
  obs('no-email-when-no-change', lcalls.some((c) => c[0] === 'runAnalysisV7') && !lcalls.some((c) => c[0] === 'sendEmail') && !llogs.some((l) => l.startsWith('❌')) && Object.values(spec.analysis ?? {}).length === 0 && !!spec.initial[DH]);
  obs('macro-throws-aborts', lthrew.length > 0 && spec.macroThrow !== undefined);
  obs('second-run-no-realert', (spec.repeat ?? 1) > 1 && lcalls.filter((c) => c[0] === 'sendEmail').length === 1);
  return { L, P, lcalls, llogs, lthrew };
}

const SCEN_A: DailySpec = {
  name: 'A mixed',
  initial: { [WATCHLIST_SHEET]: wl('TSLA', 'nvda', 'AMD', 'AMD', 'MQZC', 'PLTR', 'AAPL', 'ZZZ', 'NULLY', 'STR'), [DH]: dh(['TSLA', 'HOLD'], ['NVDA', 'HOLD'], ['AAPL', 'SELL']) },
  analysis: {
    TSLA: ok('BUY', 71), NVDA: ok('HOLD', 55), AMD: { kind: 'null' }, MQZC: { kind: 'throw', value: new Error('boom') }, PLTR: { kind: 'nodecision' },
    AAPL: ok('HOLD', 40), NULLY: { kind: 'throw', value: null }, STR: { kind: 'throw', value: 'plain string failure' },
  },
  brokerThrow: { ZZZ: 'broker down' }, step: 10_000, email: 'owner@example.com',
};

describe('FL-7g — boundaries and data', { skip }, () => {
  const RANGES: ReadonlyArray<readonly [string, number, number]> = [
    ['installDailyTriggerV7', 330, 344], ['runDailyAutomationV7', 459, 553], ['runAnalysisV7FromMenu', 555, 600],
    ['runCompleteTickerAnalysisV7', 5877, 5922], ['runCompleteTickerAnalysisV7Continued', 5924, 5962],
  ];
  test('every ported range starts and ends where the port says; the constant and the two lifted guards are where documented', () => {
    for (const [name, a, b] of RANGES) {
      assert.ok(LEG[a - 1].startsWith('function ' + name + '('), name + ' starts at ' + a);
      assert.equal(LEG[b - 1], '}', name + ' closes at ' + b);
      assert.equal(LEG[b].trim(), '', name + ' followed by a blank line');
    }
    assert.equal(LEG[324], "const DAILY_TRIGGER_HANDLER_V7 = '" + DAILY_TRIGGER_HANDLER + "';");
    assert.ok(LEG[493].includes("typeof refreshMacroSnapshotV1_ === 'function'"));
    assert.ok(LEG[510].includes("typeof refreshBrokerCourseDataCacheV1_ === 'function'"));
  });
});

describe('FL-7g — installDailyTriggerV7 data equals what legacy installs', { skip }, () => {
  function install(existing: string[]) {
    const rec: unknown[][] = [], logs: string[] = [];
    const chain: any = {
      timeBased: () => { rec.push(['timeBased']); return chain; }, everyDays: (n: number) => { rec.push(['everyDays', n]); return chain; },
      atHour: (h: number) => { rec.push(['atHour', h]); return chain; }, nearMinute: (m: number) => { rec.push(['nearMinute', m]); return chain; },
      create: () => { rec.push(['create']); return {}; },
    };
    withOracleGlobals({
      Logger: { log: (m: unknown) => { logs.push(String(m)); } },
      ScriptApp: { getProjectTriggers: () => existing.map((h) => ({ getHandlerFunction: () => h })), newTrigger: (h: string) => { rec.push(['newTrigger', h]); return chain; } },
    }, () => oracle().call('installDailyTriggerV7'));
    return { rec, logs };
  }
  test('fresh install and the idempotent no-op', () => {
    const a = install(['somethingElse']);
    assert.deepStrictEqual(a.rec, [['newTrigger', LEGACY_DAILY_TRIGGER.handler], ['timeBased'], ['everyDays', LEGACY_DAILY_TRIGGER.everyDays], ['atHour', LEGACY_DAILY_TRIGGER.atHour], ['create']]);
    assert.deepStrictEqual(a.logs, ['Daily trigger installed: runDailyAutomationV7 at ~' + LEGACY_DAILY_TRIGGER.atHour + ':00 AM (project time zone).']);
    const b = install([DAILY_TRIGGER_HANDLER, DAILY_TRIGGER_HANDLER]);
    assert.deepStrictEqual(b.rec, []);
    assert.deepStrictEqual(b.logs, ['Daily trigger already installed (2 found) — not adding another.']);
    HIT.add('trigger-installed'); HIT.add('trigger-idempotent');
  });
});

describe('FL-7g — runDailyAutomation vs runDailyAutomationV7', { skip }, () => {
  test('A: mixed results (dedupe, lower case, null / throwing / decision-less analysis, broker throw, two changes in one digest)', async () => {
    const r = await dailyBoth(SCEN_A);
    assert.equal(r.lthrew.length, 0);
    assert.ok(r.lcalls.filter((c) => c[0] === 'runAnalysisV7').every((c) => c.length === 2), 'runAnalysisV7 is called with ONE argument');
    assert.ok(r.lcalls.some((c) => c[0] === 'sendEmail' && /TSLA: HOLD  →  BUY  \(Final Conviction 71\/100\)\nAAPL: SELL  →  HOLD/.test(String(c[3]))));
  });
  test('B: empty config + header-only watchlist; and a missing watchlist tab', async () => {
    await dailyBoth({ name: 'B1', initial: { [WATCHLIST_SHEET]: wl() }, dailyTickers: [], email: 'o@example.com' });
    await dailyBoth({ name: 'B2', initial: {}, dailyTickers: [] });
  });
  test('C: seeded from CONFIG; time guard at the exact boundary (70 s per ticker: the 4th runs at 210 s, the 5th is skipped)', async () => {
    const r = await dailyBoth({ name: 'C', initial: {}, step: 70_000 });
    assert.equal(r.lcalls.filter((c) => c[0] === 'runAnalysisV7').length, 4);
    assert.ok(r.llogs.some((l) => l.startsWith('⚠ Time budget guard: stopping after 4/21 tickers (elapsed 280s)')));
    await dailyBoth({ name: 'C2 first ticker exact', initial: { [WATCHLIST_SHEET]: wl('A', 'B') }, step: 270_000 });
  });
  test('D: no recipient resolved', async () => {
    await dailyBoth({ name: 'D', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: ok('BUY', 80) } });
  });
  test('E: send fails', async () => {
    await dailyBoth({ name: 'E', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: ok('BUY', 80) }, mail: 'throw', email: 'o@example.com' });
  });
  test('F: a configured alertEmail wins and getEffectiveUser is not touched', async () => {
    await dailyBoth({ name: 'F', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: ok('BUY', 80) }, alertEmail: 'cfg@example.com', email: 'o@example.com' });
  });
  test('G: macro refresh throws -> the whole run aborts before any ticker (F-G5)', async () => {
    const r = await dailyBoth({ name: 'G', initial: { [WATCHLIST_SHEET]: wl('TSLA') }, macroThrow: new Error('macro down') });
    assert.deepStrictEqual(r.lthrew, ['macro down']);
    assert.ok(!r.lcalls.some((c) => c[0] === 'runAnalysisV7'));
  });
  test('H: decision without fundResult -> TypeError in the history write (caught), no change recorded, no email (the summary tab that threw is gone)', async () => {
    const r = await dailyBoth({ name: 'H', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: { kind: 'nofund', action: 'BUY', conv: 9 } }, email: 'o@example.com' });
    assert.equal(r.lthrew.length, 0);
    assert.ok(r.llogs.some((l) => l.startsWith('Daily automation error for TSLA: ')));
    assert.ok(!r.lcalls.some((c) => c[0] === 'sendEmail'));
  });
  test('I: a failed email is never re-sent (F-G4): the second run sees the new action as prior', async () => {
    await dailyBoth({ name: 'I', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: ok('BUY', 80) }, mail: 'throw', email: 'o@example.com', repeat: 2 });
    await dailyBoth({ name: 'I2 ok mail', initial: { [WATCHLIST_SHEET]: wl('TSLA'), [DH]: dh(['TSLA', 'SELL']) }, analysis: { TSLA: ok('BUY', 80) }, email: 'o@example.com', repeat: 2 });
  });
  test('J: undefined analysis result', async () => {
    await dailyBoth({ name: 'J', initial: { [WATCHLIST_SHEET]: wl('TSLA', 'AMD') }, analysis: { TSLA: { kind: 'undef' } } });
  });
  test('K: clean run, nothing changed -> no email, no recipient lookup', async () => {
    await dailyBoth({ name: 'K', initial: { [WATCHLIST_SHEET]: wl('TSLA', 'AMD'), [DH]: dh(['TSLA', 'HOLD']) }, email: 'o@example.com' });
  });
});

// ---- Continued
interface ContSpec {
  name: string; ticker: unknown; ls?: unknown; lo?: unknown;
  options?: 'throwError' | 'throwString' | 'null' | 'undef' | 'empty' | 'both';
  analysis?: 'ok' | 'null' | 'throw'; chartThrow?: boolean; bottomThrow?: 'Error' | 'string' | 'obj';
}
async function contBoth(spec: ContSpec) {
  const { L, P } = await twin({});
  const lcalls: unknown[][] = [], pcalls: unknown[][] = [], llogs: string[] = [], plogs: string[] = [];
  const lbox = { t: NOW }, pbox = { t: NOW + 5 };
  const stubs = (calls: unknown[][], ss: unknown) => ({
    runFull: (...a: unknown[]): any => {
      calls.push(['runFullAnalysis', ...a.map((x) => clean(x, ss))]);
      switch (spec.options) {
        case 'throwError': throw new Error('CBOE 503');
        case 'throwString': throw 'cboe string';
        case 'null': return null;
        case 'undef': return undefined;
        case 'empty': return {};
        default: return { leapsCall: { strike: 250 }, shortTermCall: { strike: 240 } };
      }
    },
    runAnalysis: (...a: unknown[]): any => {
      calls.push(['runAnalysisV7', ...a.map((x) => clean(x, ss))]);
      if (spec.analysis === 'throw') throw new Error('analysis blew up');
      if (spec.analysis === 'null') return null;
      return { fundResult: { score: 8 }, techPlan: { techScore: 7 }, decision: { action: 'BUY' } };
    },
    chart: (...a: unknown[]): any => { calls.push(['showPriceChartV7', ...a.map((x) => clean(x, ss))]); if (spec.chartThrow) throw new Error('chart blew up'); },
    bottom: (...a: unknown[]): any => {
      calls.push(['buildBottomLineSummaryV7', ...a.map((x) => clean(x, ss))]);
      if (spec.bottomThrow === 'Error') throw new Error('bottom blew up');
      if (spec.bottomThrow === 'string') throw 'bottom string';
      if (spec.bottomThrow === 'obj') throw { code: 7 };
    },
  });
  let lthrew: string | null = null, pthrew: string | null = null, lstart: unknown = 'unset', pstart: unknown = 'unset';
  const ls = stubs(lcalls, L), ps = stubs(pcalls, P);
  try {
    withOracleGlobals({
      Date: steppedDate(lbox), Logger: { log: (m: unknown) => { llogs.push(String(m)); } }, SpreadsheetApp: { getActiveSpreadsheet: () => L },
      runFullAnalysis: ls.runFull, runAnalysisV7: ls.runAnalysis, showPriceChartV7: ls.chart, buildBottomLineSummaryV7: ls.bottom, _runStartTimeV7: null,
    }, () => { try { oracle().call('runCompleteTickerAnalysisV7Continued', spec.ticker, spec.ls, spec.lo); } finally { lstart = oracle().getGlobal('_runStartTimeV7'); } });
  } catch (e) { lthrew = msgOf(e); }
  try {
    await runCompleteTickerAnalysisContinued({
      workbook: P, clock: { now: () => pbox.t }, log: (m: string) => { plogs.push(m); }, markRunStart: (ms: number) => { pstart = ms; },
      runOptionsAnalysis: async (...a: unknown[]) => (ps.runFull as any)(...a), runAnalysis: async (...a: unknown[]) => (ps.runAnalysis as any)(...a),
      showPriceChart: async (...a: unknown[]) => (ps.chart as any)(...a), buildBottomLineSummary: async (...a: unknown[]) => (ps.bottom as any)(...a),
    } as any, spec.ticker, spec.ls, spec.lo);
  } catch (e) { pthrew = msgOf(e); }
  assert.deepStrictEqual(pcalls, lcalls, spec.name + ' call log');
  assert.deepStrictEqual(plogs, llogs, spec.name + ' logs');
  assert.equal(pthrew, lthrew, spec.name + ' thrown');
  assert.equal(lstart, lbox.t, spec.name + ' legacy run start = Date.now()');
  assert.equal(pstart, pbox.t, spec.name + ' port run start = clock.now()');
  assertSameBooks(L, P, spec.name);
  const obs = (k: string, c: boolean): void => { if (c) HIT.add(k); };
  const first = (n: string) => lcalls.find((c) => c[0] === n);
  obs('c-returns-on-blank', lcalls.length === 0);
  obs('c-options-error', llogs.some((l) => /options step failed for .*: CBOE 503$/.test(l)));
  obs('c-options-string-error', llogs.some((l) => l.endsWith(': cboe string')));
  obs('c-options-null', spec.options === 'null' && first('runAnalysisV7')?.[4] === null && first('runAnalysisV7')?.[5] === null);
  obs('c-options-undefined', spec.options === 'undef' && first('runAnalysisV7')?.[4] === null);
  obs('c-options-empty-object-undefined-picks', spec.options === 'empty' && first('runAnalysisV7')?.[4] === undefined && first('runAnalysisV7')?.length === 6);
  obs('c-options-both', (spec.options ?? 'both') === 'both' && (first('runAnalysisV7')?.[4] as any)?.strike === 250);
  obs('c-analysis-null-no-bottom', spec.analysis === 'null' && !first('buildBottomLineSummaryV7') && !!first('showPriceChartV7'));
  obs('c-analysis-throws-propagates', spec.analysis === 'throw' && lthrew === 'analysis blew up' && !first('showPriceChartV7'));
  obs('c-chart-throws-propagates', !!spec.chartThrow && lthrew === 'chart blew up' && !first('buildBottomLineSummaryV7'));
  obs('c-bottom-Error', llogs.some((l) => l.endsWith(': bottom blew up')));
  obs('c-bottom-string', llogs.some((l) => l.endsWith(': bottom string')));
  obs('c-bottom-object', llogs.some((l) => l.endsWith(': [object Object]')));
  obs('c-ladder-raw-passthrough', spec.ls === 1 && first('runAnalysisV7')?.[2] === 1 && first('showPriceChartV7')?.[4] === true);
  obs('c-ladder-undefined', spec.ls === undefined && first('runAnalysisV7')?.[2] === undefined && first('showPriceChartV7')?.[4] === false);
  obs('c-ticker-normalised', spec.ticker === '  tsla ' && first('runFullAnalysis')?.[1] === 'TSLA');
  obs('c-ticker-undefined-F-G1', spec.ticker === undefined && first('runFullAnalysis')?.[1] === 'UNDEFINED');
  obs('c-ticker-null-F-G1', spec.ticker === null && first('runFullAnalysis')?.[1] === 'NULL');
  obs('c-ticker-number', spec.ticker === 123 && first('runFullAnalysis')?.[1] === '123');
  obs('c-happy-all-steps', lcalls.map((c) => c[0]).join() === 'runFullAnalysis,runAnalysisV7,showPriceChartV7,buildBottomLineSummaryV7');
  return { lcalls, llogs, lthrew };
}

describe('FL-7g — runCompleteTickerAnalysisContinued vs runCompleteTickerAnalysisV7Continued', { skip }, () => {
  test('happy path, arguments and ordering', async () => {
    const r = await contBoth({ name: 'happy', ticker: '  tsla ', ls: true, lo: false });
    assert.deepStrictEqual(r.lcalls[1], ['runAnalysisV7', 'TSLA', true, false, { strike: 250 }, { strike: 240 }]);
    assert.deepStrictEqual(r.lcalls[2], ['showPriceChartV7', 'TSLA', { techScore: 7 }, { action: 'BUY' }, true, { strike: 250 }]);
    assert.deepStrictEqual(r.lcalls[3], ['buildBottomLineSummaryV7', '<SS>', 'TSLA', { score: 8 }, { techScore: 7 }, { action: 'BUY' }, { strike: 250 }, { strike: 240 }]);
  });
  test('options step: Error, string, null, undefined, empty object', async () => {
    for (const o of ['throwError', 'throwString', 'null', 'undef', 'empty'] as const) await contBoth({ name: 'options ' + o, ticker: 'AMD', options: o, ls: false, lo: true });
  });
  test('analysis null -> the chart is still drawn with nulls, no Bottom Line (F-G6)', async () => { await contBoth({ name: 'null result', ticker: 'AMD', analysis: 'null', ls: 1, lo: 'yes' }); });
  test('analysis throws / chart throws propagate', async () => {
    await contBoth({ name: 'analysis throws', ticker: 'AMD', analysis: 'throw' });
    await contBoth({ name: 'chart throws', ticker: 'AMD', chartThrow: true });
  });
  test('Bottom Line failure is logged (Error, string, object)', async () => {
    for (const b of ['Error', 'string', 'obj'] as const) await contBoth({ name: 'bottom ' + b, ticker: 'AMD', bottomThrow: b });
  });
  test('ladder args pass through raw, the chart gets !!ladderStock', async () => {
    await contBoth({ name: 'raw ladders', ticker: 'AMD', ls: 1, lo: 'yes' });
    await contBoth({ name: 'undefined ladders', ticker: 'AMD' });
  });
  test('ticker handling: blank returns, null / undefined / number are stringified (F-G1)', async () => {
    await contBoth({ name: 'blank', ticker: '   ' });
    await contBoth({ name: 'empty', ticker: '' });
    await contBoth({ name: 'undefined', ticker: undefined });
    await contBoth({ name: 'null', ticker: null });
    await contBoth({ name: 'number', ticker: 123 });
  });
});

describe('FL-7g — the two dialogs', { skip }, () => {
  function capture(fn: string) {
    let cap: any = null;
    withOracleGlobals({
      SpreadsheetApp: { getUi: () => ({ showModalDialog: (out: any, title: string) => { cap = { html: out.html, w: out.w, h: out.h, title }; } }) },
      HtmlService: { createHtmlOutput: (html: string) => { const o: any = { html }; o.setWidth = (w: number) => { o.w = w; return o; }; o.setHeight = (h: number) => { o.h = h; return o; }; return o; } },
    }, () => oracle().call(fn));
    return cap;
  }
  const opts = (html: string): string[] => [...html.matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map((m) => m[1] ?? m[2]);
  test('title, size, choices, server handler and the empty-ticker message equal the data', () => {
    const a = capture('runAnalysisV7FromMenu'), b = capture('runCompleteTickerAnalysisV7');
    const sa = stockMenuDialog(configV7().version);
    assert.deepStrictEqual([a.title, a.w, a.h], [sa.title, sa.width, sa.height]);
    assert.deepStrictEqual([b.title, b.w, b.h], [FULL_TICKER_DIALOG.title, FULL_TICKER_DIALOG.width, FULL_TICKER_DIALOG.height]);
    assert.deepStrictEqual(opts(a.html), [...TICKER_PICKER_CHOICES]);
    assert.deepStrictEqual(opts(b.html), [...TICKER_PICKER_CHOICES]);
    assert.ok(a.html.includes('.runAnalysisV7(t, ladderStock, ladderOptions)'));
    assert.ok(b.html.includes('.runCompleteTickerAnalysisV7Continued(t, ladderStock, ladderOptions)'));
    for (const h of [a.html, b.html]) {
      assert.ok(h.includes("alert('Enter ticker')"));
      assert.ok(h.includes('.value.toUpperCase().trim()'));
      assert.ok(h.includes('.withFailureHandler(e=>{alert(e.message);'));
    }
    HIT.add('dialogs');
  });
});

describe('FL-7g — dialog flows (port only: the HTML client script cannot run here)', () => {
  const mk = (answer: any, over: any = {}) => {
    const calls: unknown[][] = [], alerts: string[] = [], logs: string[] = [];
    return { calls, alerts, logs, deps: {
      version: 'v10.9', prompt: async (spec: any) => { calls.push(['prompt', spec.title]); return answer; }, alert: (m: string) => { alerts.push(m); }, log: (m: string) => { logs.push(m); },
      runAnalysis: async (...a: unknown[]) => { calls.push(['runAnalysisV7', ...a]); if (over.fail) throw new Error('fetch failed'); return null; },
      workbook: {} as any, clock: { now: () => 1 }, runOptionsAnalysis: async (t: string) => { calls.push(['runFullAnalysis', t]); return null; },
      showPriceChart: async (...a: unknown[]) => { calls.push(['showPriceChartV7', ...a]); }, buildBottomLineSummary: async () => {},
    } };
  };
  test('cancel, empty OTHER, OTHER manual, listed ticker, failure', async () => {
    let m = mk(null);
    assert.deepStrictEqual(await runAnalysisFromMenu(m.deps), { status: 'cancelled' });
    assert.deepStrictEqual(m.calls, [['prompt', 'Stock Analysis v10.9']]);
    m = mk({ choice: 'OTHER', manual: '   ' });
    assert.deepStrictEqual(await runAnalysisFromMenu(m.deps), { status: 'invalid', message: 'Enter ticker' });
    assert.deepStrictEqual(m.alerts, ['Enter ticker']);
    m = mk({ choice: 'OTHER', manual: ' brk.b ', ladderStock: true });
    assert.deepStrictEqual(await runAnalysisFromMenu(m.deps), { status: 'done', ticker: 'BRK.B' });
    assert.deepStrictEqual(m.calls[1], ['runAnalysisV7', 'BRK.B', true, false]);
    m = mk({ choice: 'NVDA' }, { fail: true });
    const r = await runAnalysisFromMenu(m.deps);
    assert.equal(r.status, 'failed');
    assert.deepStrictEqual(m.alerts, ['Stock analysis for NVDA did not finish. Real error: fetch failed. Nothing further was run for this ticker.']);
    assert.deepStrictEqual(m.logs, ['runAnalysisV7FromMenu failed for NVDA: fetch failed']);
    m = mk({ choice: 'AMD', ladderOptions: true });
    assert.deepStrictEqual(await runCompleteTickerAnalysis(m.deps), { status: 'done', ticker: 'AMD' });
    assert.deepStrictEqual(m.calls.map((c) => c[0]), ['prompt', 'runFullAnalysis', 'runAnalysisV7', 'showPriceChartV7']);
    assert.deepStrictEqual(m.calls[2], ['runAnalysisV7', 'AMD', false, true, null, null]);
    m = mk(null);
    assert.deepStrictEqual(await runCompleteTickerAnalysis(m.deps), { status: 'cancelled' });
    m = mk({ choice: 'OTHER', manual: '' });
    assert.equal((await runCompleteTickerAnalysis(m.deps)).status, 'invalid');
    m = mk({ choice: 'AMD' }, { fail: true });
    const f = await runCompleteTickerAnalysis(m.deps);
    assert.equal(f.status, 'failed');
    assert.match(m.alerts[0], /^Full analysis for AMD did not finish\. Real error: fetch failed\./);
    HIT.add('menu-flows');
  });
});

describe('FL-7g — injected extras (port only)', () => {
  test('tickerTimeoutMs turns a hung analysis into the normal failure log line; the other ticker still runs; no Watchlist Summary tab', async () => {
    const { P } = await twin({ [WATCHLIST_SHEET]: wl('HANG', 'FINE') });
    const logs: string[] = [];
    let t = NOW;
    await inZone(TZ, () => runDailyAutomation({
      workbook: P, dailyTickers: [], alertEmail: '', clock: { now: () => (t += 1000) }, timeZone: TZ, log: (m: string) => { logs.push(m); },
      refreshMacroSnapshot: async () => {}, refreshBrokerCourseDataCache: async () => {},
      runAnalysis: (tk: string) => (tk === 'HANG' ? new Promise(() => {}) : Promise.resolve({ fundResult: { score: 1 }, techPlan: { techScore: 2, regime: 'R' }, decision: { action: 'HOLD', finalConviction: 5 } })),
      sendEmail: async () => {}, getEffectiveUserEmail: async () => '', tickerTimeoutMs: 20, timeBudgetMs: Infinity,
    } as any));
    assert.deepStrictEqual(logs, ['Daily automation error for HANG: step "runAnalysis HANG" exceeded its 20ms limit']);
    assert.equal(P.getSheetByName('🎯 Watchlist Summary'), null, 'owner 2026-11-04: the tab is no longer written');
    HIT.add('timeout-extra');
  });
});

describe('FL-7g — coverage guards', { skip }, () => {
  test('every branch was reached on the oracle side', () => {
    const REQUIRED = [
      'trigger-installed', 'trigger-idempotent', 'seeded-from-config', 'config-empty-no-seed', 'watchlist-existing-rows', 'time-guard',
      'analysis-null', 'analysis-undefined', 'no-decision', 'analysis-throws-Error', 'analysis-throws-string', 'analysis-throws-null', 'broker-throws',
      'decision-written', 'change-detected', 'email-sent-ok', 'email-two-tickers', 'email-fails', 'no-recipient', 'configured-recipient',
      'effective-user-recipient', 'no-email-when-no-change', 'macro-throws-aborts', 'second-run-no-realert',
      'c-returns-on-blank', 'c-options-error', 'c-options-string-error', 'c-options-null', 'c-options-undefined', 'c-options-empty-object-undefined-picks',
      'c-options-both', 'c-analysis-null-no-bottom', 'c-analysis-throws-propagates', 'c-chart-throws-propagates', 'c-bottom-Error', 'c-bottom-string',
      'c-bottom-object', 'c-ladder-raw-passthrough', 'c-ladder-undefined', 'c-ticker-normalised', 'c-ticker-undefined-F-G1', 'c-ticker-null-F-G1',
      'c-ticker-number', 'c-happy-all-steps', 'dialogs', 'menu-flows', 'timeout-extra',
    ];
    assert.deepStrictEqual(REQUIRED.filter((k) => !HIT.has(k)), []);
  });
});
