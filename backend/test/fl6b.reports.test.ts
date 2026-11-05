/**
 * FL-6b: the options report tabs, the options run and its diagnostics, the
 * recommended-call text, the snapshot/overlay readers, the menus, dialogs and
 * sheet lock, and the whole of myOptionsValueTracker.gs.
 *
 * Legacy and port run against the same Apps-Script-shaped workbook model
 * (src/sheets/reportSheet.ts, unit-tested first), each on its own copy; the
 * tests compare the complete recorded call log of every tab (every value and
 * formatting call, in order), the final cells, Logger lines, request traces
 * and PropertiesService.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { recordedGet, cboeUrlOf, occ, chainJson, DAYS_ALL, MULTS, type ChainSpec } from './cboeFixtures.ts';
import { HttpClient, ReplayTransport, ExchangeBook, exchangeKey, type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { ok } from '../src/core/result.ts';
import { ReportWorkbook, MemoryWorkbookBackend, SheetsWorkbookBackend, callsToFormatOps } from '../src/sheets/reportSheet.ts';
import { formatOpsToRequests } from '../src/sheets/formatOps.ts';
import { runFullAnalysis, diagnose, recommendedCallReport, readOptionsSnapshot, readOptionsOverlay, fmtExpiry } from '../src/reports/options/run.ts';
import { OptionsTabs, OPTIONS_SNAPSHOT_SHEET, TOP10_TAB_COLOR, LEGACY_TOP10_TAB_COLOR } from '../src/reports/options/tabs.ts';
import {
  LEGACY_MENUS, MENU_ENTRY_POINTS, RUN_DIALOG, CALL_DIALOG, resolveDialogTicker, lockAllSheets, unlockAllSheets, sheetGuardian, LOCK_TAB_COLOR,
} from '../src/reports/options/ui.ts';
import {
  myOptParseDate, myOptFindTable, findPortfolioStockTable, parsePortfolioNumber, refreshMyOptionsValue, MY_OPTIONS_DAILY_JOB,
} from '../src/jobs/myOptions.ts';

const ready = legacyFilesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T15:00:00Z');

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

class TracingTransport implements HttpTransport {
  readonly trace: string[] = [];
  private readonly inner: HttpTransport;
  constructor(inner: HttpTransport) {
    this.inner = inner;
  }
  send(req: HttpRequest): Promise<HttpResponse> {
    this.trace.push(exchangeKey(req.method, req.url, req.payload));
    return this.inner.send(req);
  }
}

interface GasParams { readonly method?: string; readonly payload?: string }

function tracingUrlFetchApp(book: ExchangeBook, trace: string[]): Record<string, unknown> {
  const inner = replayUrlFetchApp(book) as { fetch: (u: string, p?: GasParams) => unknown };
  return { fetch: (url: string, params?: GasParams) => { trace.push(exchangeKey(params?.method, url, params?.payload)); return inner.fetch(url, params); } };
}

type Initial = Record<string, unknown[][]>;

interface Side {
  readonly backend: MemoryWorkbookBackend;
  readonly book: ReportWorkbook;
  readonly props: FakeProperties;
  readonly kv: MemoryPropertyStore;
}

async function sides(initial: Initial = {}, coerce?: (v: unknown) => never): Promise<{ L: Side; P: Side }> {
  const mk = async (): Promise<Side> => {
    const backend = new MemoryWorkbookBackend(initial as never);
    return { backend, book: await ReportWorkbook.open(backend, ['*'], coerce ? { coerce } : {}), props: new FakeProperties(new Map(), true), kv: new MemoryPropertyStore() };
  };
  return { L: await mk(), P: await mk() };
}

interface LegacyOut<T> { value: T; logs: string[]; trace: string[]; alerts: string[]; dialogs: unknown[] }

function legacy<T>(s: Side, ex: readonly RecordedExchange[], now: number, fn: (o: ReturnType<typeof loadOracle>) => T, extra: Record<string, unknown> = {}): LegacyOut<T> {
  const logs: string[] = [], trace: string[] = [], alerts: string[] = [], dialogs: unknown[] = [];
  const ui = { alert: (m: unknown) => { alerts.push(String(m)); }, showModalDialog: (h: unknown, title: unknown) => { dialogs.push([h, title]); } };
  const value = withOracleGlobals({
    SpreadsheetApp: { getActiveSpreadsheet: () => s.book, flush: () => {}, getUi: () => ui },
    PropertiesService: fakePropertiesService(s.props), UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now),
    Logger: { log: (m: unknown) => { logs.push(String(m)); } }, hasTimeBudgetV7_: () => true, _cboeRawChainCacheV1_: {},
    HtmlService: { createHtmlOutput: (html: string) => { const o = { html, width: 0, height: 0, setWidth: (w: number) => { o.width = w; return o; }, setHeight: (h: number) => { o.height = h; return o; } }; return o; } },
    ...extra,
  }, () => fn(loadOracle()));
  return { value: structuredClone(value), logs, trace, alerts, dialogs };
}

function port(s: Side, ex: readonly RecordedExchange[], now: number, earnings: (t: string) => unknown = () => null) {
  const logs: string[] = [], alerts: string[] = [];
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  return {
    logs, alerts, transport,
    deps: {
      http: new HttpClient({ transport }), memo: new Map(), kv: s.kv, timeZone: TZ, clock: { now: () => now }, workbook: s.book, legacyExpiryLabel: true,
      fetchNextEarnings: async (t: string) => earnings(t) as never, alert: (m: string) => { alerts.push(m); }, log: (m: string) => { logs.push(m); },
    },
  };
}

/** Every tab's call log and cells, and the workbook's toasts, identical on both sides. */
function assertSameBooks(L: Side, P: Side, where: string): void {
  const names = (b: ReportWorkbook) => b.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names(P.book), names(L.book), where + ' (tabs)');
  for (const sh of L.book.getSheets()) {
    const ps = P.book.getSheetByName(sh.getName())!;
    // The one deliberate deviation (F-73): the Top 10 tab is blue, not the lock red.
    const expected = sh.getName() === OptionsTabs.TOP10
      ? sh.calls.map((c) => (c[0] === 'setTabColor' && c[1] === LEGACY_TOP10_TAB_COLOR ? ['setTabColor', TOP10_TAB_COLOR] : c))
      : sh.calls;
    assert.deepStrictEqual(ps.calls, expected, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.book.calls, L.book.calls, where + ' (workbook calls)');
}

const spec = (over: Partial<ChainSpec> = {}): ChainSpec => ({ root: 'TSLA', spot: 400, nowMs: NOW, days: DAYS_ALL, strikeMults: MULTS, maxOi: 60000, ...over });
const quietCtx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

describe('FL-6b — the workbook model', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('Apps Script value semantics, the call log, flush to memory and to the Sheets API', async () => {
    const backend = new MemoryWorkbookBackend({ Existing: [['a', 'b'], [1, 2]] });
    const ss = await ReportWorkbook.open(backend, ['Existing']);
    const sh = ss.insertSheet('New');
    sh.getRange(1, 1, 1, 3).setValue('x');
    sh.getRange(2, 1, 1, 3).merge().setValue('only A2').setBackground('#fff').setFontStyle('italic');
    assert.deepStrictEqual(sh.grid(), [['x', 'x', 'x'], ['only A2', '', '']]);
    assert.throws(() => sh.getRange(3, 1, 1, 2).setValues([[1]]), /number of columns in the data does not match/);
    assert.throws(() => sh.getRange(0, 1), /outside the dimensions/);
    assert.throws(() => ss.insertSheet('Existing'), /already exists/);
    const ex = ss.getSheetByName('Existing')!;
    assert.deepStrictEqual(ex.getDataRange().getValues(), [['a', 'b'], [1, 2]]);
    ex.getRange(2, 2).setValue('');
    ex.setTabColor('#d50000'); ex.setRowHeight(1, 30); ex.hideSheet();
    assert.deepStrictEqual(callsToFormatOps(ex.calls), [{ op: 'tabColor', color: '#d50000' }, { op: 'rowHeight', row: 1, height: 30 }, { op: 'hidden', value: true }]);
    await ss.flush();
    assert.deepStrictEqual(backend.grid('Existing'), [['a', 'b'], [1, '']]);
    assert.deepStrictEqual(backend.grid('New'), [['x', 'x', 'x'], ['only A2', '', '']]);
    const lazy = await ReportWorkbook.open(backend);
    assert.throws(() => lazy.getSheetByName('Existing')!.getLastRow(), /not loaded at open/);
    // The Sheets backend: create, clear, RAW cell runs, one formatting batch.
    const calls: unknown[] = [];
    const ids: Record<string, number> = { Existing: 3 };
    const api = {
      tabIds: async () => ok({ ...ids }), batchGet: async () => ok([[['a', 'b'], [1, 2]]]),
      batchUpdate: async (_c: unknown, u: unknown) => { calls.push(['values', u]); return ok(1); },
      batchClear: async (_c: unknown, r: unknown) => { calls.push(['clear', r]); return ok(1); },
      formatBatch: async (_c: unknown, r: Array<{ addSheet?: { properties: { title: string } } }>) => { calls.push(['format', r]); for (const q of r) if (q.addSheet) ids[q.addSheet.properties.title] = 9; return ok(r.length); },
    };
    const sb = new SheetsWorkbookBackend(quietCtx(), api as never, TZ);
    const ss2 = await ReportWorkbook.open(sb, ['Existing']);
    const t = ss2.insertSheet('T');
    t.getRange(1, 1, 1, 2).setValues([['h1', 'h2']]); t.getRange(3, 2).setValue(5); t.getRange(1, 1, 1, 2).setFontWeight('bold');
    ss2.getSheetByName('Existing')!.clearContents();
    await ss2.flush();
    // C3 (2026-10-30): one call per kind for all tabs: add tabs, clear, values, formats.
    assert.deepStrictEqual(calls, [
      ['format', [{ addSheet: { properties: { title: 'T' } } }]],
      ['clear', ["'Existing'"]],
      ['values', [{ range: "'T'!A1:B1", values: [['h1', 'h2']] }, { range: "'T'!B3:B3", values: [[5]] }]],
      ['format', formatOpsToRequests(9, [{ op: 'fontWeight', range: { row: 1, col: 1, numRows: 1, numCols: 2 }, value: 'bold' }])],
    ], 'grouped: add, clear, values, formats');
  });
});

describe('FL-6b — the options run', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('runFullAnalysis: every tab call for call, the log tab, snapshot, overlay, OI history -- twice', async () => {
    await inZone(TZ, async () => {
      const cases: Array<[string, string, string, (t: string) => unknown]> = [
        ['mega-cap', 'TSLA', chainJson(1, spec()), () => ({ dateStr: '2026-11-20' })],
        ['small-cap', 'SNDL', chainJson(2, spec({ root: 'SNDL', spot: 5, maxOi: 3000 })), () => null],
        ['market closed', 'TSLA', chainJson(3, spec({ closed: true })), () => { throw new Error('earnings down'); }],
        ['no delta, near only', 'TSLA', chainJson(4, spec({ noDelta: true, days: [3, 10, 45] })), () => ({ dateStr: '2030-01-01' })],
        ['zero scored', 'TINY', chainJson(5, spec({ root: 'TINY', spot: 3, maxOi: 40, days: [20], strikeMults: [1] })), () => null],
        ['fetch fails', 'ZZZZ', '', () => null],
      ];
      for (const [label, ticker, body, earnings] of cases) {
        const ex = body ? [recordedGet(cboeUrlOf(ticker), 200, body)] : [recordedGet(cboeUrlOf(ticker), 404, ''), recordedGet(cboeUrlOf('_' + ticker), 404, '')];
        const { L, P } = await sides({ Portfolio: [['keep me']] });
        for (const at of [NOW, NOW + 86400000]) {
          const Lr = legacy(L, ex, at, (o) => o.call('runFullAnalysis', ticker), { fetchEarningsCalendarV7: (t: string) => ({ next: earnings(t) }) });
          const Pr = port(P, ex, at, earnings);
          const value = await runFullAnalysis(Pr.deps as never, ticker);
          assert.deepStrictEqual(structuredClone(value), Lr.value, label + ' (return)');
          assertSameBooks(L, P, label + ' ' + at);
          assert.deepStrictEqual([...P.kv.map].sort(), [...L.props.map].sort(), label + ' (properties)');
          assert.deepStrictEqual(Pr.transport.trace, Lr.trace, label + ' (requests)');
        }
        await P.book.flush();
        assert.deepStrictEqual(P.backend.grid('Portfolio'), [['keep me']], 'untouched tabs stay untouched');
      }
      // The default ticker.
      const ex = [recordedGet(cboeUrlOf('TSLA'), 200, chainJson(1, spec()))];
      const { L, P } = await sides();
      const Lr = legacy(L, ex, NOW, (o) => o.call('runFullAnalysis', undefined), { fetchEarningsCalendarV7: () => ({ next: null }) });
      assert.deepStrictEqual(structuredClone(await runFullAnalysis(port(P, ex, NOW).deps as never)), Lr.value);
      assertSameBooks(L, P, 'default ticker');
      // F-73: the freshly written Top 10 tab is not mistaken for a locked tab.
      assert.notEqual(TOP10_TAB_COLOR, LOCK_TAB_COLOR);
      assert.equal(P.book.getSheetByName(OptionsTabs.TOP10)!.getTabColor(), TOP10_TAB_COLOR);
      assert.equal(L.book.getSheetByName(OptionsTabs.TOP10)!.getTabColor(), LEGACY_TOP10_TAB_COLOR, 'legacy painted it lock red');
      const toasts: unknown[] = [];
      sheetGuardian({ range: { getSheet: () => P.book.getSheetByName(OptionsTabs.TOP10)!, clearContent: () => {}, setValue: () => {} }, oldValue: 'x' }, { toast: (...a: unknown[]) => { toasts.push(a); } });
      assert.deepStrictEqual(toasts, [], 'an edit on the Top 10 tab is not reverted as "locked"');
    });
  });

  test('diagnose and the recommended-call text', async () => {
    await inZone(TZ, async () => {
      const cases: Array<[string, RecordedExchange[]]> = [
        ['ok', [recordedGet(cboeUrlOf('TSLA'), 200, chainJson(1, spec()))]], ['no contracts', [recordedGet(cboeUrlOf('TSLA'), 200, '{"data":{"options":[]}}')]],
        ['no data', [recordedGet(cboeUrlOf('TSLA'), 200, '{}')]], ['404', [recordedGet(cboeUrlOf('TSLA'), 404, 'y'.repeat(500))]],
        ['bad JSON', [recordedGet(cboeUrlOf('TSLA'), 200, '<html>')]], ['network error', []],
      ];
      for (const [label, ex] of cases) {
        for (const existing of [false, true]) {
          const { L, P } = await sides(existing ? { [OptionsTabs.LOG]: [['old'], ['lines']] } : {});
          legacy(L, ex, NOW, (o) => o.call('diagnose'));
          await diagnose(port(P, ex, NOW).deps as never);
          assertSameBooks(L, P, 'diagnose ' + label);
        }
      }
      const day = Date.UTC(2027, 0, 15);
      for (const [label, body, earnings] of [
        ['mega, earnings before expiry', chainJson(1, spec()), { dateStr: '2026-11-20' }], ['no earnings', chainJson(1, spec()), null],
        ['earnings after', chainJson(1, spec()), { dateStr: '2031-01-01' }], ['no delta', chainJson(2, spec({ noDelta: true })), null],
        ['few strikes', JSON.stringify({ data: { options: [{ option: occ('TSLA', day, 'C', 400), delta: 0.5, bid: 1, ask: 2, iv: 0 }] } }), null],
        ['no chain', '', 'throw'],
      ] as Array<[string, string, unknown]>) {
        const ex = body ? [recordedGet(cboeUrlOf('TSLA'), 200, body)] : [];
        const e = (): unknown => { if (earnings === 'throw') throw new Error('x'); return earnings; };
        const { L, P } = await sides();
        const Lr = legacy(L, ex, NOW, (o) => o.call('showRecommendedCallV7Continued', ' tsla '), { fetchEarningsCalendarV7: () => ({ next: e() }) });
        const Pr = port(P, ex, NOW, e);
        await recommendedCallReport(Pr.deps as never, ' tsla ');
        assert.deepStrictEqual(Pr.alerts, Lr.alerts, label);
      }
    });
  });

  test('readOptionsSnapshotV7 / fmtExpiryV7_ / readOptionsOverlay -- on what the run wrote, with Sheets\' date parsing emulated', async () => {
    await inZone(TZ, async () => {
      const LABEL = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/;
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const sheetsParse = (v: unknown): never => {
        const m = typeof v === 'string' ? LABEL.exec(v) : null;
        return (m ? new Date(Number(m[3]), MON.indexOf(m[1]), Number(m[2])) : v) as never;
      };
      const ex = [recordedGet(cboeUrlOf('TSLA'), 200, chainJson(1, spec()))];
      // Legacy writes through Sheets' parsing (labels become Dates); the port writes RAW.
      const { L } = await sides({}, sheetsParse);
      const { P } = await sides();
      legacy(L, ex, NOW, (o) => o.call('runFullAnalysis', 'TSLA'), { fetchEarningsCalendarV7: () => ({ next: null }) });
      await runFullAnalysis(port(P, ex, NOW).deps as never, 'TSLA');
      for (const at of [NOW, NOW + 3 * 86400000]) {
        for (const t of ['TSLA', 'tsla', 'NVDA', null]) {
          const Lr = legacy(L, [], at, (o) => o.call('readOptionsSnapshotV7', L.book, t));
          assert.deepStrictEqual(readOptionsSnapshot(P.book, t, at, TZ), Lr.value, 'snapshot ' + t);
          const Lo = legacy(L, [], at, (o) => o.call('readOptionsOverlay', L.book, t));
          assert.deepStrictEqual(readOptionsOverlay(P.book, t), Lo.value, 'overlay ' + t);
        }
      }
      // Corrupt and missing snapshots.
      for (const grid of [[['META', '{bad'], ['h'], ['x']], [['META', 'null'], ['h'], ['x']], [['NOTMETA', '{}'], ['h'], ['x']], [['META', '{}']]]) {
        const s = await sides({ [OPTIONS_SNAPSHOT_SHEET]: grid, [OptionsTabs.TOP10]: [['Weird title'], ['TOP 10 CALL'], ['1', 'x']] });
        assert.deepStrictEqual(readOptionsSnapshot(s.P.book, 'TSLA', NOW, TZ), legacy(s.L, [], NOW, (o) => o.call('readOptionsSnapshotV7', s.L.book, 'TSLA')).value);
        assert.deepStrictEqual(readOptionsOverlay(s.P.book, 'TSLA'), legacy(s.L, [], NOW, (o) => o.call('readOptionsOverlay', s.L.book, 'TSLA')).value);
      }
      // F-70: on a sheet where Sheets parsed '$400' into 400, legacy's '$' test never matches (always null);
      // the fixed reader finds the contracts, and legacyStrikeText restores legacy's null.
      const parsedTop = [['TSLA Top 10'], ['TOP 10 CALL'], ['1', 400, '', '', '', '', '', '', '', '', '', 88], ['TOP 10 PUT'], ['1', 350, '', '', '', '', '', '', '', '', '', 71]];
      const pt = await sides({ [OptionsTabs.TOP10]: parsedTop });
      assert.equal(legacy(pt.L, [], NOW, (o) => o.call('readOptionsOverlay', pt.L.book, 'TSLA')).value, null, 'legacy: null on a parsed sheet');
      assert.equal(readOptionsOverlay(pt.P.book, 'TSLA', { legacyStrikeText: true }), null, 'parity flag: legacy null');
      assert.deepStrictEqual(readOptionsOverlay(pt.P.book, 'TSLA'), { ticker: 'TSLA', topCallStrike: 400, topCallConv: 88, topPutStrike: 350, topPutConv: 71 });
      const none = await sides();
      assert.equal(readOptionsSnapshot(none.P.book, 'X', NOW, TZ), null);
      for (const v of [new Date(2027, 0, 14), 'Jan 14, 2027', 'N/A', null, 7, new Date(NaN)]) {
        assert.equal(fmtExpiry(v, TZ, false), loadOracle().call('fmtExpiryV7_', v), String(v));
      }
    });
  });
});

describe('FL-6b — menus, dialogs, the sheet lock', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('onOpen\'s menus are LEGACY_MENUS, every handler is mapped; the two dialogs\' choices, sizes and validation', async () => {
    const menus: Array<{ menu: string; items: unknown[] }> = [];
    const ui = {
      createMenu: (menu: string) => { const m = { menu, items: [] as unknown[] }; menus.push(m); const b = { addItem: (l: string, f: string) => { m.items.push([l, f]); return b; }, addSeparator: () => { m.items.push(null); return b; }, addToUi: () => b }; return b; },
    };
    const { L, P } = await sides({ A: [['1']], B: [] });
    legacy(L, [], NOW, (o) => o.call('onOpen'), { SpreadsheetApp: { getActiveSpreadsheet: () => L.book, getUi: () => ui } });
    assert.deepStrictEqual(menus, structuredClone(LEGACY_MENUS));
    for (const m of LEGACY_MENUS) for (const it of m.items) if (it) assert.ok(MENU_ENTRY_POINTS[it[1]], 'unmapped menu handler ' + it[1]);
    lockAllSheets(P.book);
    assertSameBooks(L, P, 'onOpen locks every tab');
    for (const [fn, spec2] of [['selectTickerAndRun', RUN_DIALOG], ['showRecommendedCallV7', CALL_DIALOG]] as const) {
      const out = legacy(L, [], NOW, (o) => o.call(fn));
      const [h, title] = out.dialogs[0] as [{ html: string; width: number; height: number }, string];
      const choices = [...h.html.matchAll(/<option(?: value="([^"]+)")?>([^<]+)<\/option>/g)].map((m) => m[1] ?? m[2]);
      assert.deepStrictEqual({ title, width: h.width, height: h.height, choices }, { title: spec2.title, width: spec2.width, height: spec2.height, choices: [...spec2.choices] });
      assert.ok(h.html.includes("alert('" + spec2.emptyManualMessage + "')") || h.html.includes('alert(\'' + spec2.emptyManualMessage + '\')'), 'the empty-manual alert');
      assert.ok(h.html.includes('.' + spec2.handler + '('), 'calls ' + spec2.handler);
    }
    assert.deepStrictEqual(resolveDialogTicker(RUN_DIALOG, 'NVDA'), { ticker: 'NVDA' });
    assert.deepStrictEqual(resolveDialogTicker(RUN_DIALOG, 'OTHER', '  aapl '), { ticker: 'AAPL' });
    assert.deepStrictEqual(resolveDialogTicker(CALL_DIALOG, 'OTHER', '  '), { error: 'Enter ticker' });
  });

  test('lockAllSheets / unlockAllSheets / sheetGuardian', async () => {
    const { L, P } = await sides({ A: [['1']], B: [['2']] });
    for (const step of ['lockAllSheets', 'unlockAllSheets', 'lockAllSheets']) {
      legacy(L, [], NOW, (o) => o.call(step));
      (step === 'lockAllSheets' ? lockAllSheets : unlockAllSheets)(P.book);
      assertSameBooks(L, P, step);
    }
    for (const [tab, oldValue] of [['A', undefined], ['B', 'was'], ['A', 0]] as Array<[string, unknown]>) {
      for (const locked of [true, false]) {
        const mk = (s: typeof L) => { const sh = s.book.getSheetByName(tab)!; sh.setTabColor(locked ? '#d50000' : '#ffffff'); return { range: sh.getRange(1, 1), oldValue }; };
        const eL = mk(L), eP = mk(P);
        legacy(L, [], NOW, (o) => o.call('sheetGuardian', eL));
        sheetGuardian(eP, P.book);
        assertSameBooks(L, P, 'guardian ' + tab + ' ' + locked);
      }
    }
    legacy(L, [], NOW, (o) => o.call('sheetGuardian', null));
    sheetGuardian(null, P.book);
    assertSameBooks(L, P, 'no event');
  });
});

describe('FL-6b — myOptionsValueTracker.gs', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const HEAD = ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg', 'current market value', 'notes'];
  const portfolio = (rows: unknown[][]): unknown[][] => [
    ['My portfolio'], [], ['Ticker', 'type', 'sub-type', 'amount', 'price per item', 'value of investment', 'Allocation %', 'cost avg per stock'],
    ['NVDA', 'stock', '', 10, 120, 1200, '5%', '$48.10'], ['', '', '', '', '', '', '', ''], ['Options'], HEAD, ...rows,
  ];
  const day = Date.UTC(2027, 2, 19);

  test('myOpt_parseDate in three zones, parsePortfolioNumberV1_, both table finders', async () => {
    const o = loadOracle();
    for (const tz of [TZ, 'Asia/Jerusalem', 'UTC']) {
      await inZone(tz, () => {
        for (const v of ["Mar19'27", 'JUN17\'27', 'Dec 17 2027', 'jan5 27', 'Feb30\'27', '17-Jun-2027', '2027-06-17', '2027-06-17T00:00:00Z', 'June 17, 2027', 'Xyz12\'27', '', null, undefined, 0,
          new Date(2027, 5, 17), new Date(Date.UTC(2027, 5, 17)), new Date(NaN), 'garbage', '6/17/2027', '2027-06-17T10:00:00+05:00']) {
          assert.deepStrictEqual(myOptParseDate(v, tz), o.callNormalized('myOpt_parseDate', v), tz + ' ' + String(v));
        }
      });
    }
    for (const v of [48.1, '$48.10', '1,234.5%', '-3', 'abc', '', null, NaN, '--5', '1.2.3']) assert.deepStrictEqual(parsePortfolioNumber(v), o.call('parsePortfolioNumberV1_', v), String(v));
    const grids: Array<Record<string, unknown[][]>> = [
      { Portfolio: portfolio([]) }, {}, { Portfolio: [['Ticker', 'positions', 'last trade Date']] },
      { Portfolio: [['Ticker', 'cost avg per stock']] }, { Portfolio: [['nothing here']] },
    ];
    for (const g of grids) {
      const { L, P } = await sides(g);
      const strip = (x: { sheet?: unknown }): unknown => (x && x.sheet && typeof x.sheet === 'object' ? { ...x, sheet: (x.sheet as { getName(): string }).getName() } : x);
      assert.deepStrictEqual(strip(myOptFindTable(P.book) as never), strip(legacy(L, [], NOW, (oo) => { const r = oo.call('myOpt_findTable', L.book) as { sheet?: unknown }; return strip(r); }).value as never));
      assert.deepStrictEqual(strip(findPortfolioStockTable(P.book) as never), strip(legacy(L, [], NOW, (oo) => strip(oo.call('findPortfolioStockTableV1_', L.book) as never)).value as never));
    }
  });

  test('refreshMyOptionsValueV1: market values written into the Portfolio tab only, skips, the stop at a blank ticker, errors', async () => {
    await inZone(TZ, async () => {
      const body = (root: string) => JSON.stringify({ data: { options: [
        { option: occ(root, day, 'C', 120), bid: 10, ask: 12 }, { option: occ(root, day, 'P', 100), bid: 0, ask: 0, last_trade_price: 3.5 },
        { option: occ(root, Date.UTC(2027, 5, 17), 'C', 150), bid: 0, ask: 0 },
      ] } });
      const ex = [recordedGet(cboeUrlOf('PLTR'), 200, body('PLTR')), recordedGet(cboeUrlOf('NVDA'), 200, body('NVDA'))];
      const rows: unknown[][] = [
        ['pltr', 2, "Mar19'27", 120, 'CALL', 5, '', 'a'], ['PLTR', 1, new Date(2027, 2, 19), 100, ' put ', 2, 'old', ''],
        ['NVDA', 3, 'Jun17\'27', 150, 'call', 1, '', ''], ['NVDA', 'x', "Mar19'27", 120, 'call', 1, '', ''], ['NVDA', 1, 'never', 120, 'call', 1, '', ''],
        ['ZZZZ', 1, "Mar19'27", 120, 'call', 1, '', ''], ['', '', '', '', '', '', '', ''], ['PLTR', 9, "Mar19'27", 120, 'call', 1, 'after the blank row', ''],
      ];
      for (const [label, grid] of [['full', { Portfolio: portfolio(rows) }], ['no Portfolio tab', { Other: [['x']] }], ['no options table', { Portfolio: [['Ticker', 'cost avg per stock']] }],
        ['missing column', { Portfolio: [['Ticker', 'positions', 'last trade Date', 'strike']] }]] as Array<[string, Initial]>) {
        const { L, P } = await sides(grid);
        const Lr = legacy(L, ex, NOW, (o) => o.call('refreshMyOptionsValue'));
        const Pr = port(P, ex, NOW);
        await refreshMyOptionsValue({ workbook: P.book, http: Pr.deps.http, timeZone: TZ, log: Pr.deps.log, alert: Pr.deps.alert });
        assert.deepStrictEqual(Pr.logs, Lr.logs, label + ' (log)');
        assert.deepStrictEqual(Pr.alerts, Lr.alerts, label + ' (alert)');
        assert.deepStrictEqual(Pr.transport.trace, Lr.trace, label + ' (requests)');
        assertSameBooks(L, P, label);
        if (label === 'full') {
          await P.book.flush();
          const g = P.backend.grid('Portfolio');
          assert.equal(g[7][6], 2200, 'pltr call: mid 11 x 100 x 2');
          assert.equal(g[14][6], 'after the blank row', 'F-67: rows after a blank ticker are not refreshed');
        }
      }
      // A header row with nothing under it: Apps Script throws on a 0-row range; so does the port.
      const { L, P } = await sides({ Portfolio: portfolio([]) });
      assert.throws(() => withOracleGlobals({ SpreadsheetApp: { getActiveSpreadsheet: () => L.book, getUi: () => null } }, () => loadOracle().call('refreshMyOptionsValue')));
      await assert.rejects(refreshMyOptionsValue({ workbook: P.book, http: port(P, [], NOW).deps.http, timeZone: TZ }));
    });
  });

  test('installMyOptionsEndOfDayTrigger -> the job table', () => {
    const created: unknown[] = [];
    const b: Record<string, (...a: any[]) => unknown> = {};
    const t: Record<string, unknown> = {};
    Object.assign(b, { timeBased: () => b, everyDays: (n: number) => { t.everyDays = n; return b; }, atHour: (h: number) => { t.atHour = h; return b; }, create: () => { created.push({ ...t }); return t; } });
    const scriptApp = (existing: string[]) => ({ getProjectTriggers: () => existing.map((h) => ({ getHandlerFunction: () => h })), newTrigger: (h: string) => { t.handler = h; return b; } });
    const logs: string[] = [];
    withOracleGlobals({ ScriptApp: scriptApp([]), Logger: { log: (m: unknown) => { logs.push(String(m)); } } }, () => loadOracle().call('installMyOptionsEndOfDayTrigger'));
    withOracleGlobals({ ScriptApp: scriptApp(['refreshMyOptionsValue']), Logger: { log: (m: unknown) => { logs.push(String(m)); } } }, () => loadOracle().call('installMyOptionsEndOfDayTrigger'));
    assert.deepStrictEqual(created, [{ handler: MY_OPTIONS_DAILY_JOB.handler, everyDays: MY_OPTIONS_DAILY_JOB.everyDays, atHour: MY_OPTIONS_DAILY_JOB.atHour }]);
    assert.deepStrictEqual(logs, ['✅ Daily trigger installed for refreshMyOptionsValue (~5:00 PM).', 'Trigger already installed.']);
  });
});
