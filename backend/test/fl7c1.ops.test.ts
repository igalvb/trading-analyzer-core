/**
 * FL-7c1 (ops part): menu help, methodology tab, API-key check, diagnostics,
 * sheet-size report and the price-cache cleanup -- legacy (the oracle) and
 * port run on their own copy of the same workbook and are compared on every
 * recorded call, cell, alert, log line and thrown message.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { recordedGet } from './cboeFixtures.ts';
import { NOW, DAY, openBook, legacyUi, portAlert, legacyBook, fakeSpreadsheet, priceTab, staleTabs, type Rows } from './fl7c1Fixtures.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { HttpClient, ReplayTransport, ExchangeBook } from '../src/net/http.ts';
import { dateToSheetsSerial, type PriceSheetsApi } from '../src/storage/priceHistory.ts';
import { TabStoreError } from '../src/storage/tabStore.ts';
import { ok, err } from '../src/core/result.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { LEGACY_MENUS, MENU_ENTRY_POINTS } from '../src/reports/options/ui.ts';
import * as mMenuHelp from '../src/ops/menuHelp.ts';
import * as mMethodology from '../src/ops/methodology.ts';
import * as mApiKeys from '../src/ops/apiKeys.ts';
import * as mDiagnostics from '../src/ops/diagnostics.ts';
import * as mSheetSize from '../src/ops/sheetSize.ts';
import * as mPriceCaches from '../src/ops/priceCaches.ts';
import * as mPriceChart from '../src/ops/priceChart.ts';
import { OPS_COMMANDS } from '../src/ops/commands.ts';
import { menuHelpHtml, showMenuHelp, helpCoverage, cliHelpText, MENU_HELP_SECTIONS } from '../src/ops/menuHelp.ts';
import { buildMethodologySheet, METHODOLOGY_TAB, METHODOLOGY_SECTIONS } from '../src/ops/methodology.ts';
import { checkApiKeysConfigured } from '../src/ops/apiKeys.ts';
import { testFMPStablePointInTimeFields, backtestEngineSkeleton, FMP_INCOME_STATEMENT_URL } from '../src/ops/diagnostics.ts';
import { diagnoseSheetSize, SHEET_SIZE_REPORT_TAB } from '../src/ops/sheetSize.ts';
import {
  cleanupPriceCacheSheets, findStalePriceCacheSheets, DeletableWorkbook, sheetsTabDeleter, openPriceCacheWorkbook, serialAwareDate,
} from '../src/ops/priceCaches.ts';

const ready = legacyFilesPresent();
const oracle = () => loadOracle();

describe('FL-7c1 -- ops and diagnostics', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('legacy boundaries: start text and closing brace of every ported function', () => {
    const lines = fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n');
    const ranges: Array<[number, number, string]> = [
      [5446, 5527, 'function buildMethodologySheetV7() {'], [5529, 5539, 'function checkApiKeysConfiguredV7() {'], [5554, 5608, 'function showMenuHelpV7() {'],
      [5651, 5864, 'function showPriceChartV7('], [6106, 6124, 'function findStalePriceCacheSheetsV1_() {'], [6129, 6154, 'function cleanupPriceCacheSheetsV1Menu() {'],
      [6165, 6190, 'function diagnoseSheetSizeV1Menu() {'], [9695, 9726, 'function testFMPStablePointInTimeFields_() {'], [9728, 9740, 'function backtestEngineV7_SKELETON(ticker, opts) {'],
    ];
    for (const [a, b, text] of ranges) {
      assert.ok(lines[a - 1].startsWith(text), a + ': ' + lines[a - 1]);
      assert.equal(lines[b - 1], '}', 'closing brace of ' + a);
    }
    assert.equal(lines[5979 - 1], "const PRICE_CACHE_SHEET_PREFIX_V7 = '💾 ';");
  });

  test('menu help: the exact legacy HTML, dialog size and title', () => {
    const out: { html?: string; w?: number; h?: number; title?: string } = {};
    withOracleGlobals({
      SpreadsheetApp: { getUi: () => ({ showModalDialog: (ob: any, title: string) => { out.html = ob.html; out.w = ob.w; out.h = ob.h; out.title = title; } }) },
      HtmlService: { createHtmlOutput: (x: string) => { const q: any = { html: x, w: 0, h: 0, setWidth(v: number) { q.w = v; return q; }, setHeight(v: number) { q.h = v; return q; } }; return q; } },
    }, () => oracle().call('showMenuHelpV7'));
    assert.equal(menuHelpHtml(), out.html);
    assert.equal(out.html!.length, 4247);
    const got: unknown[][] = [];
    showMenuHelp({ showModalDialog: (...a) => { got.push(a); } });
    assert.deepEqual(got, [[out.html, out.title, out.w, out.h]]);
  });

  test('menu help: matches the menu (the legacy rule), the CLI text and the command registry', () => {
    assert.deepEqual(helpCoverage(), {
      undescribed: ['unlockAllSheets', 'lockAllSheets'], orphaned: [],
      labelDrift: [['runFullAnalysis', '▶ Run Analysis (Default: ticker)', '▶ Run Analysis (Default: TSLA)']],
    });
    assert.equal(MENU_HELP_SECTIONS.reduce((n, s) => n + s.items.length, 0), 16);
    const text = cliHelpText();
    for (const m of LEGACY_MENUS) {
      for (const it of m.items) {
        if (!it) continue;
        const ep = MENU_ENTRY_POINTS[it[1]];
        assert.ok(ep, 'unmapped ' + it[1]);
        assert.ok(text.includes(ep.entry), 'help lacks the command of ' + it[1]);
        assert.ok(text.includes('was: ' + it[0]), 'help lacks ' + it[0]);
      }
    }
    // a new menu item without help or without a command is visible
    const extra = [...LEGACY_MENUS, { menu: 'X', items: [['new item', 'newHandler'] as const] }];
    assert.deepEqual(helpCoverage(extra).undescribed, ['unlockAllSheets', 'lockAllSheets', 'newHandler']);
    assert.ok(cliHelpText(MENU_ENTRY_POINTS, extra).includes('(no command mapped)'));
    // the registry: every row's function exists, and a menu handler's command is its MENU_ENTRY_POINTS entry
    const mods: Record<string, Record<string, unknown>> = {
      'ops/menuHelp.ts': mMenuHelp, 'ops/methodology.ts': mMethodology, 'ops/apiKeys.ts': mApiKeys, 'ops/diagnostics.ts': mDiagnostics,
      'ops/sheetSize.ts': mSheetSize, 'ops/priceCaches.ts': mPriceCaches, 'ops/priceChart.ts': mPriceChart,
    };
    assert.equal(OPS_COMMANDS.length, 9);
    for (const c of OPS_COMMANDS) {
      assert.equal(typeof mods[c.module][c.port], 'function', c.port);
      assert.ok(oracle().has(c.legacy), c.legacy);
      if (MENU_ENTRY_POINTS[c.legacy]) assert.equal(MENU_ENTRY_POINTS[c.legacy].entry, c.command, c.legacy);
    }
  });

  test('methodology: new tab and existing tab, call log, cells, alert', async () => {
    for (const existing of [false, true]) {
      const initial: Rows = existing ? { [METHODOLOGY_TAB]: [['old', 'x', 'y'], [1, 2, 3], [4, 5, 6]], Other: [['k']] } : { Other: [['k']] };
      const L = await openBook(initial), P = await openBook(initial);
      const la: unknown[][] = [], pa: unknown[][] = [];
      withOracleGlobals({ SpreadsheetApp: { getActiveSpreadsheet: () => legacyBook(L), getUi: () => legacyUi(la) } }, () => oracle().call('buildMethodologySheetV7'));
      buildMethodologySheet(P, { alert: (m) => { pa.push([m]); } });
      assert.deepEqual(pa, la);
      assert.deepEqual(P.getSheets().map((s) => s.getName()), L.getSheets().map((s) => s.getName()));
      const lsh = L.getSheetByName(METHODOLOGY_TAB)!, psh = P.getSheetByName(METHODOLOGY_TAB)!;
      assert.deepEqual(psh.calls, lsh.calls);
      assert.deepEqual(psh.grid(), lsh.grid());
      // coverage guards: 6 sections + 49 entries all written, the clear path taken only for the existing tab
      assert.equal(lsh.created, !existing);
      assert.equal(lsh.cleared, existing);
      assert.equal(lsh.calls.some((c) => c[0] === 'clearFormats'), existing);
      assert.equal(METHODOLOGY_SECTIONS.reduce((n, s) => n + s.entries.length, 0), 49);
      assert.equal(lsh.grid().length, 6 * 2 + 49);
      assert.equal(lsh.grid()[lsh.grid().length - 1][0], 'OWN-as-filter Final Conviction');
    }
  });

  test('api keys: present / missing / alert unavailable, never a value', () => {
    const o = oracle();
    const src = String(o.fns.checkApiKeysConfiguredV7);
    // the legacy constants are unreachable (const), so re-run its own source with them shadowed
    const verbatim = (consts: Record<string, string | undefined>, logs: string[], alerts: string[], alertThrows: boolean): void => {
      const mk = new (o.fns.checkApiKeysConfiguredV7 as any).constructor('FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'GEMINI_API_KEY', 'Logger', 'SpreadsheetApp', 'return (' + src + ')');
      mk(consts.FMP_API_KEY, consts.ALPHAVANTAGE_KEY, consts.FINNHUB_KEY, consts.GEMINI_API_KEY, { log: (m: string) => logs.push(m) },
        { getUi: () => { if (alertThrows) throw new Error('no ui'); return { alert: (m: string) => alerts.push(m) }; } })();
    };
    const seen = new Set<string>();
    const cases: Array<[Record<string, string | undefined>, boolean]> = [
      [{ FMP_API_KEY: 'SECRETA', ALPHAVANTAGE_KEY: 'SECRETB', FINNHUB_KEY: 'SECRETC', GEMINI_API_KEY: 'SECRETD' }, false],
      [{ FMP_API_KEY: '', ALPHAVANTAGE_KEY: 'SECRETB', FINNHUB_KEY: 'SECRETC', GEMINI_API_KEY: 'SECRETD' }, false],
      [{ ALPHAVANTAGE_KEY: 'SECRETB', FINNHUB_KEY: 'SECRETC', GEMINI_API_KEY: 'SECRETD' }, false],
      [{ FMP_API_KEY: 'SECRETA', ALPHAVANTAGE_KEY: 'SECRETB', FINNHUB_KEY: '', GEMINI_API_KEY: '' }, true],
      [{}, false], [{}, true],
    ];
    for (const [env, thr] of cases) {
      const L = { logs: [] as string[], alerts: [] as string[] }, P = { logs: [] as string[], alerts: [] as string[] };
      verbatim(env, L.logs, L.alerts, thr);
      const r = checkApiKeysConfigured({ env, log: (m) => { P.logs.push(m); }, alert: (m) => { if (thr) throw new Error('no ui'); P.alerts.push(m); } });
      assert.deepEqual(P, L);
      assert.ok(!JSON.stringify(P).includes('SECRET'));
      seen.add(r.missing.length + ':' + thr);
    }
    for (const k of ['0:false', '1:false', '2:true', '4:false', '4:true']) assert.ok(seen.has(k), 'coverage ' + k);
    // the real function: its constants are non-empty placeholders -> the "present" line
    const L2: string[] = [], P2: string[] = [];
    withOracleGlobals({ Logger: { log: (m: unknown) => L2.push(String(m)) } }, () => o.call('checkApiKeysConfiguredV7'));
    checkApiKeysConfigured({ env: { FMP_API_KEY: 'x', ALPHAVANTAGE_KEY: 'x', FINNHUB_KEY: 'x', GEMINI_API_KEY: 'x' }, log: (m) => { P2.push(m); }, alert: () => {} });
    assert.deepEqual(P2, L2);
  });

  test('backtest skeleton: the same stub error', () => {
    const msg = (fn: () => void): string | null => { try { fn(); } catch (e: any) { return e.message; } return null; };
    for (const [t, opts] of [['TSLA', undefined], ['X', { horizonBars: 5, warmupBars: 100 }], ['Y', null], ['Z', { horizonBars: 0, warmupBars: 0 }], [undefined, {}]] as any[]) {
      const a = msg(() => oracle().call('backtestEngineV7_SKELETON', t, opts)), b = msg(() => backtestEngineSkeleton(t, opts));
      assert.ok(a);
      assert.equal(b, a);
    }
  });

  test('FMP probe: every outcome, key never logged', async () => {
    const o = oracle();
    const url = FMP_INCOME_STATEMENT_URL + 'KEYXYZ';
    const long = (n: number) => 'x'.repeat(n);
    const cases: Array<[string, number, string]> = [
      ['500 long', 500, long(300)], ['200 object', 200, JSON.stringify({ 'Error Message': long(400) })], ['200 empty', 200, '[]'],
      ['both', 200, JSON.stringify([{ date: '2025-09-27', fillingDate: '2025-10-31', acceptedDate: '2025-10-30 18:00:00', a: 1 }])],
      ['filling only', 200, JSON.stringify([{ date: 'd', fillingDate: 'f' }])], ['accepted only', 200, JSON.stringify([{ date: 'd', acceptedDate: 'a' }])],
      ['neither', 200, JSON.stringify([{ date: 'd', revenue: 1, eps: 2 }])], ['bad json', 200, '<html>nope'], ['null row', 200, '[null]'],
    ];
    const lasts = new Set<string>();
    for (const [name, status, body] of cases) {
      const ex = [recordedGet(url, status, body)];
      const Ll: string[] = [], Pl: string[] = [];
      withOracleGlobals({ Logger: { log: (m: unknown) => Ll.push(String(m)) }, UrlFetchApp: replayUrlFetchApp(new ExchangeBook(ex)) }, () => o.call('testFMPStablePointInTimeFields_'));
      await testFMPStablePointInTimeFields({ http: new HttpClient({ transport: new ReplayTransport(new ExchangeBook(ex)) }), fmpKey: 'KEYXYZ', log: (m) => { Pl.push(m); } });
      assert.deepEqual(Pl, Ll, name);
      assert.ok(!Pl.join('\n').includes('KEYXYZ'));
      lasts.add(Ll[Ll.length - 1].slice(0, 22));
    }
    for (const p of ['HTTP 500 -- could not ', 'Got a 200 but no usabl', 'RESULT: CONFIRMED -- t', 'This means Tier 2 need', 'Error: Unexpected toke', 'Error: Cannot read pro']) assert.ok(lasts.has(p), 'coverage ' + p);
    // thrown values: an Error, a string, an object without a message
    for (const thrown of [new Error('net down'), 'oops', { message: '' }]) {
      const Ll: string[] = [], Pl: string[] = [];
      withOracleGlobals({ Logger: { log: (m: unknown) => Ll.push(String(m)) }, UrlFetchApp: { fetch: () => { throw thrown; } } }, () => o.call('testFMPStablePointInTimeFields_'));
      await testFMPStablePointInTimeFields({ http: { fetch: async () => { throw thrown; } }, fmpKey: 'k', log: (m) => { Pl.push(m); } });
      assert.deepEqual(Pl, Ll);
      assert.equal(Pl.length, 1);
    }
  });

  test('sheet size: with and without an existing report tab', async () => {
    const big = (r: number, c: number) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => i + ',' + j));
    const base: Rows = { A: big(1200, 3), B: big(3, 2), C: big(3, 2), D: [], E: big(50, 50), F: big(10, 10), G: big(2, 1) };
    for (const withReport of [false, true]) {
      const initial: Rows = { ...base, ...(withReport ? { [SHEET_SIZE_REPORT_TAB]: big(30, 4) } : {}) };
      const L = await openBook(initial), P = await openBook(initial);
      const la: unknown[][] = [], pa: unknown[][] = [];
      withOracleGlobals({ SpreadsheetApp: { getActiveSpreadsheet: () => legacyBook(L), getUi: () => legacyUi(la) } }, () => oracle().call('diagnoseSheetSizeV1Menu'));
      const rows = diagnoseSheetSize(P, { alert: portAlert(pa) });
      assert.deepEqual(pa, la);
      assert.deepEqual(P.getSheets().map((s) => s.getName()), L.getSheets().map((s) => s.getName()));
      for (const sh of L.getSheets()) {
        const ps = P.getSheetByName(sh.getName())!;
        assert.deepEqual(ps.calls, sh.calls, sh.getName());
        assert.deepEqual(ps.grid(), sh.grid(), sh.getName());
      }
      // guards: thousands separator reached, the tie B/C keeps order, an empty tab counts 0, the report tab exists either way
      assert.ok(String(la[0][0]).includes('3,600'));
      // an existing 30x4 report tab (120 cells) outranks F (100 cells); legacy ranks it the same (pa/la equal above)
      assert.deepEqual(rows.slice(0, 3).map((r) => r.name), withReport ? ['A', 'E', SHEET_SIZE_REPORT_TAB] : ['A', 'E', 'F']);
      assert.equal(rows.find((r) => r.name === 'D')!.cells, 0);
      assert.ok(L.getSheetByName(SHEET_SIZE_REPORT_TAB)!.cleared === withReport);
      assert.ok(L.getSheetByName(SHEET_SIZE_REPORT_TAB)!.calls.some((c) => c[0] === 'autoResizeColumns'));
    }
  });

  describe('price-cache cleanup', () => {
    const EXPECTED = ['💾 OLD1', '💾 Macro FRED', '💾 OLD2', '💾 OLD3', '💾 EDGE90P'];

    async function run(apply: boolean, yes: boolean, failOn?: string, initial: Rows = staleTabs()) {
      const lAl: unknown[][] = [], pAl: unknown[][] = [], lLog: string[] = [], pLog: string[] = [];
      const lss = fakeSpreadsheet(initial, failOn);
      withOracleGlobals({
        SpreadsheetApp: { getActiveSpreadsheet: () => lss, getUi: () => legacyUi(lAl, yes) },
        Logger: { log: (m: unknown) => lLog.push(String(m)) }, Date: pinnedDateClass(NOW),
      }, () => oracle().call('cleanupPriceCacheSheetsV1Menu'));
      const deleted: string[] = [];
      const book = await openBook(initial);
      const wb = new DeletableWorkbook(book, async (n) => { if (n === failOn) throw new Error('boom'); deleted.push(n); });
      const r = await cleanupPriceCacheSheets({
        workbook: wb, clock: { now: () => NOW }, alert: portAlert(pAl), confirm: (t, b) => { pAl.push([b, t]); return yes; }, log: (m) => { pLog.push(m); }, apply,
      });
      return { lAl, pAl, lLog, pLog, lNames: lss.getSheets().map((s) => s.getName()), pNames: wb.getSheets().map((s) => s.getName()), r, deleted };
    }

    test('apply + yes: selection, order, messages and deletions equal legacy', async () => {
      const a = await run(true, true);
      assert.deepEqual(a.pAl, a.lAl);
      assert.deepEqual(a.pLog, a.lLog);
      assert.deepEqual(a.pNames, a.lNames);
      // guards: the exact list (90-day boundary, a tie in legacy order, the Macro tab) and every tab kind skipped
      assert.deepEqual(a.r.candidates.map((c) => [c.name, c.daysOld]), [['💾 OLD1', 295], ['💾 Macro FRED', 264], ['💾 OLD2', 114], ['💾 OLD3', 114], ['💾 EDGE90P', 90]]);
      assert.deepEqual(a.deleted, EXPECTED);
      for (const kept of ['💾 EDGE90', '💾 FRESH', '💾 SHORT', '💾 TEXT', '💾 BAD', '💾 Script Properties', 'Other']) assert.ok(a.pNames.includes(kept), kept);
      assert.equal(a.r.mode, 'deleted');
    });

    test('apply + no: legacy "cancelled by user", nothing deleted', async () => {
      const n = await run(true, false);
      assert.deepEqual(n.pAl, n.lAl);
      assert.deepEqual(n.pLog, n.lLog);
      assert.deepEqual(n.pNames, n.lNames);
      assert.equal(n.deleted.length, 0);
      assert.equal(n.r.mode, 'cancelled');
      assert.deepEqual(n.pLog, ['Price-cache cleanup: cancelled by user.']);
    });

    test('one delete fails: logged, counted, the rest go on', async () => {
      const f = await run(true, true, '💾 OLD2');
      assert.deepEqual(f.pAl, f.lAl);
      assert.deepEqual(f.pLog, f.lLog);
      assert.deepEqual(f.pNames, f.lNames);
      assert.deepEqual(f.pLog, ['Price-cache cleanup: failed to delete 💾 OLD2: boom', 'Price-cache cleanup: deleted 4/5 stale sheets.']);
    });

    test('DRY RUN (the CLI default): shows the same list and title as the legacy dialog, deletes nothing', async () => {
      const a = await run(true, true);
      const d = await run(false, true);
      assert.equal(d.deleted.length, 0);
      assert.equal(d.pNames.length, Object.keys(staleTabs()).length);
      assert.deepEqual(d.pAl, [a.lAl[0]]); // [body, title] of the legacy confirmation dialog
      assert.deepEqual(d.pLog, ['Price-cache cleanup: dry run -- nothing deleted (pass --yes to delete).']);
      assert.equal(d.r.mode, 'dry-run');
      assert.equal(d.r.deleted, 0);
    });

    test('nothing stale, and the singular wording', async () => {
      const none = await run(true, true, undefined, { '💾 FRESH': priceTab(new Date(NOW)), Other: priceTab(new Date(0)) });
      assert.deepEqual(none.pAl, none.lAl);
      assert.equal(none.r.mode, 'nothing-stale');
      assert.deepEqual(none.pAl, [['No price-cache sheets are older than 90 days — nothing to clean up.']]);
      const one = await run(true, true, undefined, { '💾 ONLY': priceTab(new Date(NOW - 200 * DAY)) });
      assert.deepEqual(one.pAl, one.lAl);
      assert.equal(one.lAl[0][1], 'Delete 1 stale price-cache sheet?');
      assert.deepEqual(one.pAl[1], ['Deleted 1 stale price-cache sheet.']);
    });

    test('F-C3: Sheets returns serial numbers -- nothing is stale unless toDate converts them; deleter and opener', async () => {
      const tz = 'America/New_York';
      const initial: Rows = { '💾 S': priceTab(dateToSheetsSerial(new Date(NOW - 200 * DAY), tz)), '💾 FRESH': priceTab(dateToSheetsSerial(new Date(NOW - DAY), tz)) };
      const wb = async () => new DeletableWorkbook(await openBook(initial), async () => {});
      assert.equal(findStalePriceCacheSheets(await wb(), NOW).length, 0);
      assert.deepEqual(findStalePriceCacheSheets(await wb(), NOW, serialAwareDate(tz)).map((c) => c.name), ['💾 S']);

      const ctx = createContext({ mode: 'test', minLevel: LogLevel.ERROR, sleep: async () => {} });
      const sent: unknown[] = [];
      const api = { tabIds: async () => ok({ A: 7 }), formatBatch: async (_c: unknown, r: unknown) => { sent.push(r); return ok(1); } } as unknown as PriceSheetsApi;
      await sheetsTabDeleter(ctx, api)('A');
      assert.deepEqual(sent, [[{ deleteSheet: { sheetId: 7 } }]]);
      await assert.rejects(sheetsTabDeleter(ctx, api)('B'), /No sheet named "B"/);
      const e = { kind: 'permanent', detail: 'x', disclosure: 'y', attempts: 1 } as never;
      await assert.rejects(sheetsTabDeleter(ctx, { tabIds: async () => err(e), formatBatch: async () => ok(1) } as unknown as PriceSheetsApi)('A'), TabStoreError);
      await assert.rejects(sheetsTabDeleter(ctx, { tabIds: async () => ok({ A: 1 }), formatBatch: async () => err(e) } as unknown as PriceSheetsApi)('A'), TabStoreError);

      const backend = new MemoryWorkbookBackend({ '💾 A': priceTab(new Date(0)), Other: [['x']], '💾 B': priceTab(new Date(0)) } as never);
      const read: string[] = [];
      const orig = backend.readTab.bind(backend);
      backend.readTab = async (t: string) => { read.push(t); return orig(t); };
      const book = await openPriceCacheWorkbook(backend);
      assert.deepEqual(read, ['💾 A', '💾 B']);
      assert.throws(() => book.getSheetByName('Other')!.getLastRow(), /not loaded/);
      await assert.rejects(new DeletableWorkbook(book, async () => {}).deleteSheet(null), /does not exist/);
    });
  });
});
