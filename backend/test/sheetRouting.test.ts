/**
 * Three spreadsheets, phase 2 (docs/SHEETS_CLEANUP_PLAN.md (d), (g) "sheetRouting.test"): sheetFor pinned against
 * every name of the inventory, the allow-list and its exceptions, the byte-exact deny-list, listTabs dedupe,
 * the protected names, the shared limiter.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANALYSIS_REPORT_TABS, MIGRATION_MARKER_TAB, MOVED_REPORT_TABS, OTHER_REPORT_TABS, PERSONAL_TABS, PORTFOLIO_TABS, PROTECTED_TABS, Tabs,
  isAllowListedName, isPersonalTab, sheetFor,
} from '../src/sheets/tabs.ts';
import { RoutingFormatter, RoutingTabStore, RoutingWorkbookBackend, SheetAllowListError, allowListRefusal } from '../src/sheets/routing.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { MemoryTabFormatter } from '../src/sheets/formatOps.ts';
import { ANALYSIS_TAB, MODEL_TABS } from '../src/analysis/runTicker.ts';
import { OptionsTabs, OPTIONS_SNAPSHOT_SHEET } from '../src/reports/options/tabs.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/text.ts';
import { EXIT_TARGET_HISTORY_SHEET } from '../src/stores/exitTargetHistory.ts';
import { DECISION_HISTORY_SHEET } from '../src/stores/decisionHistory.ts';
import { WATCHLIST_SHEET, WATCHLIST_SUMMARY_SHEET, getOrCreateWatchlistSheet } from '../src/stores/watchlist.ts';
import { DARK_POOL_TRACKER_TAB } from '../src/sheets/writers/darkPoolTracker.ts';
import { PAPER_STATE_TAB, PAPER_TAB } from '../src/paper/paperJob.ts';
import { LOG_TAB, READS_TAB, VALUES_TAB } from '../src/paper/paperLog.ts';
import { TRANSACTIONS_SHEET } from '../src/portfolio/transactions.ts';
import { METHODOLOGY_TAB } from '../src/ops/methodology.ts';
import { EXIT_STRATEGY_TAB } from '../src/reports/exit/exitReport.ts';
import { SHEET_SIZE_REPORT_TAB } from '../src/ops/sheetSize.ts';
import { RS_RANKING_TAB } from '../src/storage/rsRankingTab.ts';
import { FUNDAMENTALS_SERIES_TAB } from '../src/storage/fundamentalsSeriesTab.ts';
import { MYOPT_PORTFOLIO_SHEET_NAME } from '../src/jobs/myOptions.ts';
import { CLEANUP_PROTECTED_TABS } from '../src/app/menuCommands.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { SheetsClient, createSheetsLimiter } from '../src/sheets/client.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { FakeGoogle } from './fakeGoogleSheets.ts';
import { BulkPriceHistoryStore } from '../src/storage/bulkPriceHistory.ts';
import { planTrim } from '../src/trimPriceTabs.ts';

const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

const DATA_126 = ['MQZC', 'SQZB', 'AVGO', 'DELL', 'HQZA', '^VIX', 'BTC-USD', 'BTC', 'SQZA', 'GOOG', 'GOOGL'].map((t) => '💾 ' + t);
const MACRO_11 = ['SPY', 'TLT', 'GLD', 'XLP', 'XLU', 'XLV', 'XLY', 'XLI', 'XLB', 'DIA', 'IYT'].map((t) => '💾 Macro ' + t);
const CACHES_5 = ['💾 Macro Snapshot', '💾 13F Cache', '💾 Broker Data Cache', '💾 RS Ranking', '💾 Script Properties'];

describe('sheetFor: every name of the inventory (plan (a)) in its spreadsheet', () => {
  test('rows 1-4 -> data (price, Macro, caches, snapshot, log, paper state, the marker)', () => {
    for (const n of [...DATA_126, ...MACRO_11, ...CACHES_5, '_OPTIONS_SNAPSHOT', '🔬 Log', '📝 Paper State', MIGRATION_MARKER_TAB, '💾 Fundamentals History', '💾 Fundamentals Series']) {
      assert.equal(sheetFor(n), 'data', n);
    }
  });
  test('rows 5, 6, 14 and the owner/smoke tabs -> portfolio', () => {
    for (const n of ['Portfolio', '🎯 Watchlist', '📒 Transactions', '⚙️ Smoke Test', ...PERSONAL_TABS]) assert.equal(sheetFor(n), 'portfolio', n);
  });
  test('rows 7-13, the 30 fixed analysis tabs and the manual/legacy report tabs -> reports', () => {
    for (const n of [...MOVED_REPORT_TABS, ...ANALYSIS_REPORT_TABS, ...OTHER_REPORT_TABS, '📋 Bottom Line — TSLA', '📊 TSLA Chart', '📌 Position — TSLA']) {
      assert.equal(sheetFor(n), 'reports', n);
    }
  });
  test('the copied names equal the constants in their own modules', () => {
    assert.deepEqual(new Set(MOVED_REPORT_TABS), new Set([WATCHLIST_SUMMARY_SHEET, DECISION_HISTORY_SHEET, BUY_SHEET_TAB, EXIT_SHEET_TAB, EXIT_TARGET_HISTORY_SHEET, DARK_POOL_TRACKER_TAB, PAPER_TAB, LOG_TAB, READS_TAB, VALUES_TAB]));
    for (const n of [ANALYSIS_TAB, ...Object.values(MODEL_TABS), OptionsTabs.TOP10, OptionsTabs.DASHBOARD, OptionsTabs.CALLS, OptionsTabs.PUTS, OptionsTabs.GAMMA, OptionsTabs.BUCKETS]) {
      assert.ok(ANALYSIS_REPORT_TABS.includes(n), n);
    }
    assert.equal(ANALYSIS_REPORT_TABS.length, 30);
    for (const n of [METHODOLOGY_TAB, EXIT_STRATEGY_TAB, SHEET_SIZE_REPORT_TAB]) assert.ok(OTHER_REPORT_TABS.includes(n), n);
    assert.ok(PORTFOLIO_TABS.includes(TRANSACTIONS_SHEET) && PORTFOLIO_TABS.includes(WATCHLIST_SHEET) && PORTFOLIO_TABS.includes(MYOPT_PORTFOLIO_SHEET_NAME) && PORTFOLIO_TABS.includes(Tabs.SMOKE));
    for (const n of [OPTIONS_SNAPSHOT_SHEET, OptionsTabs.LOG, PAPER_STATE_TAB, RS_RANKING_TAB, FUNDAMENTALS_SERIES_TAB, Tabs.SCRIPT_PROPERTIES]) assert.equal(sheetFor(n), 'data', n);
  });
  test('the counts of the inventory: 15 personal tabs, 10 moved reports', () => {
    assert.equal(PERSONAL_TABS.length, 15);
    assert.equal(MOVED_REPORT_TABS.length, 10);
  });
});

describe('deny-list: the 15 personal names byte for byte', () => {
  test('names match byte for byte: a lookalike is neither personal nor allow-listed', () => {
    const t = PERSONAL_TABS.find((n) => n.includes(' '))!;
    assert.ok(isPersonalTab(t));
    assert.ok(!isPersonalTab(t.replace(' ', '  ')), 'a lookalike is not the personal tab');
    assert.ok(!isAllowListedName(t.replace(' ', '  ')), 'and it is not allow-listed either');
  });
  test('no personal name is ever allow-listed', () => {
    for (const n of PERSONAL_TABS) assert.ok(!isAllowListedName(n), n);
  });
});

describe('allow-list (routed runs)', () => {
  test('registry names and 💾 <TICKER> pass in their own spreadsheet; anything else is refused', () => {
    assert.equal(allowListRefusal('💾 TSLA', 'write'), null);
    assert.equal(allowListRefusal(BUY_SHEET_TAB, 'write'), null);
    assert.equal(allowListRefusal('🔬 Log', 'create'), null);
    assert.match(String(allowListRefusal('Random Owner Tab', 'write')), /not a tab this program owns/);
    assert.match(String(allowListRefusal('💾 ', 'write')), /not a tab/);
    assert.match(String(allowListRefusal('DASHBOARD', 'write')), /not a tab/);
    assert.match(String(allowListRefusal(BUY_SHEET_TAB, 'write', 'data')), /belongs in the reports/);
  });
  test('My Portfolio: only Portfolio may be written; 🎯 Watchlist only created when missing; nothing else', () => {
    assert.equal(allowListRefusal('Portfolio', 'write'), null);
    assert.equal(allowListRefusal('🎯 Watchlist', 'create'), null);
    assert.match(String(allowListRefusal('🎯 Watchlist', 'write')), /only the Portfolio tab/);
    assert.match(String(allowListRefusal('📒 Transactions', 'create')), /only the Portfolio tab/);
    assert.match(String(allowListRefusal('⚙️ Smoke Test', 'write')), /only the Portfolio tab/, 'smoke writes it through its own entry point (smoke.ts), never through the routed stores');
  });

  const backends = () => ({
    portfolio: new MemoryWorkbookBackend({ Portfolio: [['Ticker']], '🎯 Watchlist': [['Ticker'], ['TSLA']], DASHBOARD: [['mine']], [BUY_SHEET_TAB]: [['stale copy']] }),
    reports: new MemoryWorkbookBackend({ [BUY_SHEET_TAB]: [['live']] }),
    data: new MemoryWorkbookBackend({ '💾 TSLA': [['META']], [BUY_SHEET_TAB]: [['wrong place']] }),
  });

  test('listTabs merges the three and keeps each name once, from the sheet sheetFor names; readTab routes', async () => {
    const b = backends();
    const r = new RoutingWorkbookBackend(b, { strict: true });
    const names = (await r.listTabs()).map((t) => t.name);
    assert.deepEqual(names.filter((n) => n === BUY_SHEET_TAB), [BUY_SHEET_TAB], 'deduped');
    assert.deepEqual(new Set(names), new Set(['Portfolio', '🎯 Watchlist', 'DASHBOARD', BUY_SHEET_TAB, '💾 TSLA']));
    assert.deepEqual(await r.readTab(BUY_SHEET_TAB), [['live']]);
    assert.deepEqual(await r.readTab('💾 TSLA'), [['META']]);
  });

  test('writes land in the routed sheet; a refused write throws in strict mode and is skipped (logged) otherwise', async () => {
    const b = backends();
    const wb = await ReportWorkbook.open(new RoutingWorkbookBackend(b, { strict: true }), ['*']);
    wb.getSheetByName(BUY_SHEET_TAB)!.getRange(1, 1).setValue('new');
    wb.getSheetByName('Portfolio')!.getRange(2, 1).setValue('MSTR');
    await wb.flush();
    assert.deepEqual(b.reports.grid(BUY_SHEET_TAB), [['new']]);
    assert.deepEqual(b.portfolio.grid(BUY_SHEET_TAB), [['stale copy']], 'the stale copy in My Portfolio is untouched');
    assert.deepEqual(b.portfolio.grid('Portfolio'), [['Ticker'], ['MSTR']]);

    const strict = await ReportWorkbook.open(new RoutingWorkbookBackend(backends(), { strict: true }), ['*']);
    strict.getSheetByName('DASHBOARD')!.getRange(1, 1).setValue('robot');
    await assert.rejects(strict.flush(), SheetAllowListError);

    const logged: string[] = [];
    const b3 = backends();
    const soft = await ReportWorkbook.open(new RoutingWorkbookBackend(b3, { onRefuse: (m) => logged.push(m) }), ['*']);
    soft.getSheetByName('🎯 Watchlist')!.getRange(3, 1).setValue('NVDA');
    soft.insertSheet('Owner Notes').getRange(1, 1).setValue('x');
    await soft.flush();
    assert.equal(logged.length, 2);
    assert.deepEqual(b3.portfolio.grid('🎯 Watchlist'), [['Ticker'], ['TSLA']], 'the watchlist is never overwritten');
    assert.ok(!b3.reports.tabs.has('Owner Notes') && !b3.portfolio.tabs.has('Owner Notes'));
  });

  test('tab-colour changes are never refused (the Master Lock colours every tab)', async () => {
    const b = backends();
    const wb = await ReportWorkbook.open(new RoutingWorkbookBackend(b, { strict: true }), ['*']);
    wb.getSheetByName('DASHBOARD')!.setTabColor('#d50000');
    await wb.flush();
    assert.equal(b.portfolio.tabs.get('DASHBOARD')!.tabColor, '#d50000');
  });

  test('getOrCreateWatchlistSheet creates 🎯 Watchlist only when it is missing, and never overwrites it', async () => {
    const empty = { portfolio: new MemoryWorkbookBackend({ Portfolio: [] }), reports: new MemoryWorkbookBackend(), data: new MemoryWorkbookBackend() };
    const wb = await ReportWorkbook.open(new RoutingWorkbookBackend(empty, { strict: true }), ['*']);
    getOrCreateWatchlistSheet(wb);
    await wb.flush();
    assert.deepEqual(empty.portfolio.grid('🎯 Watchlist'), [['Ticker']]);
    const b = backends();
    const wb2 = await ReportWorkbook.open(new RoutingWorkbookBackend(b, { strict: true }), ['*']);
    getOrCreateWatchlistSheet(wb2);
    await wb2.flush();
    assert.deepEqual(b.portfolio.grid('🎯 Watchlist'), [['Ticker'], ['TSLA']]);
  });

  test('RoutingTabStore: data tabs to data, report tabs to reports, refusals', async () => {
    const st = { portfolio: new MemoryTabStore(), reports: new MemoryTabStore(), data: new MemoryTabStore() };
    const r = new RoutingTabStore(st, { strict: true });
    await r.ensure(PAPER_STATE_TAB); await r.write(PAPER_STATE_TAB, 1, [['state']]);
    await r.ensure(DARK_POOL_TRACKER_TAB); await r.write(DARK_POOL_TRACKER_TAB, 1, [['dp']]);
    await r.ensure(LOG_TAB);
    assert.deepEqual(st.data.snapshot(PAPER_STATE_TAB, 1), [['state']]);
    assert.deepEqual(st.reports.snapshot(DARK_POOL_TRACKER_TAB, 1), [['dp']]);
    assert.ok(st.reports.tabs.has(LOG_TAB) && !st.data.tabs.has(LOG_TAB));
    assert.deepEqual(await r.read(PAPER_STATE_TAB, 1), [['state']]);
    await assert.rejects(r.ensure('Personal tab 10'), SheetAllowListError);
    await assert.rejects(r.ensure('⚙️ Smoke Test'), SheetAllowListError);
    await assert.rejects(r.clear('🎯 Watchlist'), SheetAllowListError);
  });

  test('RoutingFormatter formats on the sheet that holds the tab', async () => {
    const f = { portfolio: new MemoryTabFormatter(), reports: new MemoryTabFormatter(), data: new MemoryTabFormatter() };
    await new RoutingFormatter(f).apply(DARK_POOL_TRACKER_TAB, [{ op: 'frozenRows', count: 1 }]);
    assert.ok(f.reports.applied.has(DARK_POOL_TRACKER_TAB) && !f.portfolio.applied.has(DARK_POOL_TRACKER_TAB));
  });
});

describe('allow-list exceptions tied to one entry point (source checks)', () => {
  const src = (rel: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8');
  const allSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allSrc(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  test('smoke.ts writes only ⚙️ Smoke Test, on SPREADSHEET_ID', () => {
    const t = src('src/smoke.ts');
    assert.match(t, /const SMOKE_TAB = '⚙️ Smoke Test';/);
    assert.deepEqual([...t.matchAll(/title: ([A-Za-z_]+)/g)].map((m) => m[1]), ['SMOKE_TAB']);
    assert.deepEqual([...t.matchAll(/const range = `\$\{([A-Z_]+)\}!/g)].map((m) => m[1]), ['SMOKE_TAB']);
    assert.ok(!t.includes('REPORTS_SPREADSHEET_ID') && !t.includes('DATA_SPREADSHEET_ID'));
  });
  test('only the migrate tool writes the developer-metadata flags', () => {
    const files = allSrc(path.resolve(import.meta.dirname, '..', 'src')).filter((f) => /DeveloperMetadata/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(files.map((f) => path.relative(path.resolve(import.meta.dirname, '..'), f)), [path.join('src', 'sheets', 'migration.ts')]);
  });
});

describe('protected names', () => {
  test('💾 Migration and the stateful tabs are protected; cleanup-price-caches hides the marker', () => {
    for (const n of [MIGRATION_MARKER_TAB, '💾 Script Properties', '📝 Paper State', '📈 Decision History', 'Exit Target History', PAPER_TAB, LOG_TAB, READS_TAB, VALUES_TAB]) {
      assert.ok(PROTECTED_TABS.includes(n), n);
    }
    assert.ok(CLEANUP_PROTECTED_TABS.has(MIGRATION_MARKER_TAB));
    assert.ok(CLEANUP_PROTECTED_TABS.has(Tabs.SCRIPT_PROPERTIES));
  });

  test('trim-price-tabs never touches 💾 Migration, even if it looked like a price tab', () => {
    const grid = { sheetId: 9, title: MIGRATION_MARKER_TAB, rowCount: 100, columnCount: 26 };
    const head = new Map([[MIGRATION_MARKER_TAB, [['META', 'x'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']]]]);
    const p = planTrim([grid], head as never, new Map());
    assert.deepEqual(p.trim, []);
    assert.deepEqual(p.kept, [{ title: MIGRATION_MARKER_TAB, reason: 'protected' }]);
  });

  test('the bulk price read skips 💾 Migration', async () => {
    const g = new FakeGoogle();
    g.addBook('D', 'data', { '💾 TSLA': [['META', '{}'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']], [MIGRATION_MARKER_TAB]: [['Status', 'VERIFIED']] });
    const client = new SheetsClient({ spreadsheetId: 'D', api: g.api, limiter: RateLimiter.perMinute(100_000) });
    const store = new BulkPriceHistoryStore(ctx(), client, 'UTC');
    await store.read('TSLA');
    const ranges = g.calls.filter((x) => x.method === 'values.batchGet').flatMap((x) => x.ranges ?? []);
    assert.deepEqual(ranges, ["'💾 TSLA'!A1:F"], 'the marker is not read as a price tab');
  });
});

describe('one shared limiter for the three spreadsheets', () => {
  test('three clients, one limiter: at most 55 calls in any 60 s window', async () => {
    let t = 0;
    const stamps: number[] = [];
    const limiter = createSheetsLimiter(() => t, async (ms) => { t += ms; });
    const g = new FakeGoogle();
    for (const id of ['P', 'R', 'D']) g.addBook(id, id, { A: [['x']] });
    const clients = ['P', 'R', 'D'].map((id) => new SheetsClient({ spreadsheetId: id, api: g.api, limiter }));
    for (let i = 0; i < 300; i++) {
      await clients[i % 3]!.listTabs(ctx());
      stamps.push(t);
    }
    let worst = 0;
    for (let i = 0; i < stamps.length; i++) {
      let n = 0;
      for (let j = i; j < stamps.length && stamps[j]! - stamps[i]! < 60_000; j++) n++;
      worst = Math.max(worst, n);
    }
    assert.ok(worst <= 55, 'worst window held ' + worst);
    assert.ok(worst >= 50, 'and the limit is actually used: ' + worst);
  });
});

test('the nightly option-history tabs (paper/chainSnapshot.ts) route to the data sheet and are protected', async () => {
  const { IV_HISTORY_TAB, CHAIN_SNAPSHOT_TAB } = await import('../src/paper/chainSnapshot.ts');
  const tabs = await import('../src/sheets/tabs.ts');
  for (const t of [IV_HISTORY_TAB, CHAIN_SNAPSHOT_TAB]) {
    assert.equal(tabs.sheetFor(t), 'data');
    assert.ok(tabs.isAllowListedName(t));
    assert.ok(tabs.PROTECTED_TABS.includes(t));
  }
});
