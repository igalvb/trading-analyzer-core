/**
 * The phone dashboard's data (src/dashboard/data.ts) and site folder (src/dashboard/site.ts), with fake tabs: the
 * Exit and Buy grids are made by the real sheet builders, the Portfolio grid from the template layout, so a change in
 * those layouts shows up here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { formatStockSignals, formatOptionsSignals } from '../src/reports/exit/exitReport.ts';
import { buildExitSheet, EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import type { ExitHoldingInput, ExitReportInput } from '../src/reports/exitSheet/types.ts';
import { buildBuySheet } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB, NCOLS } from '../src/reports/buySheet/text.ts';
import type { BuyCandidateInput } from '../src/reports/buySheet/types.ts';
import { portfolioTemplateRows } from '../src/initUserSheets.ts';
import { MemoryTabStore, type TabCell } from '../src/storage/tabStore.ts';
import { VALUES_HEADER, LOG_HEADER, READS_HEADER } from '../src/paper/paperLog.ts';
import { RUN_HEALTH_HEADER } from '../src/watchdog.ts';
import { TRANSACTIONS_HEADERS } from '../src/portfolio/transactions.ts';
import {
  buildDashboard, readDashboardSources, parseExitReport, parseBuyReport, parseTransactions, verdictKeyOf, dayOf, asOfText, DASHBOARD_SCHEMA, DASHBOARD_TABS,
  type DashboardSources, type DashboardContext,
} from '../src/dashboard/data.ts';
import { writeSite, iconPng, APP_FILES } from '../src/dashboard/site.ts';

const NOW = Date.parse('2026-11-06T04:40:00Z');
const CTX: DashboardContext = { nowMs: NOW, taxRate: 0.25, list: ['AAA', 'BBB'], labels: { list: 'your list', holdCore: 'Hold your list', holdList: 'Hold your list' }, timeZone: 'Europe/London', version: '1.1.0', paper: { start: '2026-11-02', end: null } };

function stock(ticker: string, stop: number, breached = false): ExitHoldingInput {
  return {
    ticker, kind: 'STOCK', position: { quantity: 10, avgCost: 100, entryDate: '2025-01-10', currentPrice: 120 },
    signals: formatStockSignals({ chandelierSinceEntry: stop, stopBreached: breached, t1: 140, t2: 160, entryDateStr: '2025-01-10' }, true),
    levels: { stopLevel: stop, stopBasis: 'SINCE_ENTRY', stopBreached: breached, thesisInvalidated: false, t1: 140, hitT1: false, t2: 160, hitT2: false },
    models: [], dataHealth: [],
  } as ExitHoldingInput;
}
async function exitGrid(): Promise<TabCell[][]> {
  const option: ExitHoldingInput = {
    ticker: 'BBB', kind: 'OPTION', position: { quantity: 2, avgCost: 3, entryDate: '2026-06-01', currentPrice: 5 },
    option: { right: 'CALL', strike: 50, expiry: '2026-12-18', daysToExpiry: 42, expiryThreshold: 30, expiryWarning: false, underlyingPrice: 48 },
    signals: formatOptionsSignals({ daysToExpiry: 42, expiryThreshold: 30, expiryWarning: false, technical: { chandelierSinceEntry: 40, t1: 60, t2: 70 } }, true, 2),
    levels: { stopLevel: 40, stopBasis: 'SINCE_ENTRY', stopBreached: false, thesisInvalidated: false, t1: 60, hitT1: false, t2: 70, hitT2: false }, models: [], dataHealth: [],
  };
  const input: ExitReportInput = { runAt: new Date(NOW), holdings: [stock('AAA', 110), stock('BBB', 130, true), option], skipped: { crypto: ['COINX'], otherStock: [], blankTickerRowCount: 0 }, dataHealth: [] };
  const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
  const ss = await ReportWorkbook.open(be, ['*']);
  buildExitSheet(ss, input);
  await ss.flush();
  return be.grid(EXIT_SHEET_TAB) as TabCell[][];
}
async function buyGrid(): Promise<TabCell[][]> {
  const cand = (ticker: string, rank: number, conviction: number, action: string, low: number, high: number): BuyCandidateInput => ({
    ticker, status: 'ok', tier: 1, rank, slot: rank, buyNow: false, blocked: false, conviction, entryConfidencePct: 64, ownScore: 72, ownBand: 'own', timing: 'WAIT_PULLBACK', regime: 'TREND_UP', action,
    entryZone: { low, center: (low + high) / 2, high }, timeToEntry: null, stop: low * 0.9, rrToT1: 2, rrToT2: 3, t1: high * 1.2, t2: high * 1.4, entryLadder: { rungs: [], percents: [] },
    sizing: null, sizingText: null, models: null, comparison: null, options: null, held: null, addToPosition: false, opportunityCost: [], promotion: null, change: null,
    bitcoinGroup: false, dataHealth: [], note: null, techScore: 61,
  } as BuyCandidateInput);
  const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
  const ss = await ReportWorkbook.open(be, ['*']);
  buildBuySheet(ss, { runAt: new Date(NOW), candidates: [cand('CCC', 1, 82, '✅ BUY NOW', 48, 52), cand('DDD', 2, 70, '⏳ GREAT COMPANY — SET A BUY LIMIT', 90, 95)], seeded: false, portfolioOk: true });
  await ss.flush();
  return be.grid(BUY_SHEET_TAB, NCOLS) as TabCell[][];
}
function portfolioGrid(): TabCell[][] {
  const t = portfolioTemplateRows();
  // template: [0] note, [1] stock header, [2] blank, [3] note, [4] OPEN, [5] options header, [6] blank, [7] CLOSED, [8] closed header
  return [
    t[0] as TabCell[], t[1] as TabCell[],
    ['AAA', 'stock', '', 10, 118, 1180, 100, '', ''],
    ['BBB', 'stock', 'ETF', 5, 125, 625, 140, '2024-03-01', ''],
    ['COINX', 'crypto', '', 2.5, 40, 100, 10, '', ''],
    ['TOTAL', '', '', '', '', 1905, '', '', ''],
    t[3] as TabCell[], t[4] as TabCell[], t[5] as TabCell[],
    ['BBB', 'call', 2, '2026-12-18', 50, 'CALL', 3, 600, 1000, '', '2026-06-01'],
    t[7] as TabCell[], t[8] as TabCell[],
    ['AAA', 'call', 1, '2026-09-18', 100, 'CALL', 4, 400, 7, '2026-09-01'],
    ['DDD', 'call', 3, '2025-03-21', 80, 'CALL', 2, 600, 1, '2025-02-14'],
  ];
}
const values = (): TabCell[][] => [VALUES_HEADER as TabCell[],
  ['2026-11-02', 'Engine alone', 'A original', 100500, 0.005, 'AAA'], ['2026-11-02', 'Hold QQQ', '📊 yardstick', 100200, 0.002, 'QQQ'],
  ['2026-11-03', 'Engine alone', 'A original', 101500, 0.015, 'AAA, BBB'], ['2026-11-03', 'Hold QQQ', '📊 yardstick', 100100, 0.001, 'QQQ'],
  ['2026-11-03', '🤖 Claude, free choice', 'Claude', 99800, -0.002, 'cash']];
const log = (): TabCell[][] => [LOG_HEADER.slice(0, 10) as TabCell[],
  ['2026-11-02', 'filled', 'Engine alone', 'BOUGHT', 'AAA', '10', '$100.00', '$1,000', '', 'the engine said buy'],
  ['2026-11-03', 'filled', 'Engine alone', 'BOUGHT', 'BBB', '5', '$50.00', '$250', '', 'entry zone']];
const reads = (): TabCell[][] => [READS_HEADER as TabCell[],
  ['2026-11-02', 'AAA', 115, 70, 'WAIT', 'HOLD', 'bullish', 'bullish', 'neutral', 'bearish', 'bullish', 'markup', 'bullish', 'cautionary', '+5%', 105, '', 130, 150, ''],
  ['2026-11-03', 'AAA', 121, 72, 'WAIT', 'HOLD', 'bullish', 'bullish', 'neutral', 'bearish', 'bullish', 'markup', 'bullish', 'cautionary', '+5%', 106, '$100.00 to $110.00', 130, 150, ''],
  ['2026-11-03', 'CCC', 51, 82, 'BUY_NOW', 'BUY', 'bullish', '', '', '', '', '', '', '', '', '', '', '', '', '']];
const runs = (): TabCell[][] => [RUN_HEALTH_HEADER as TabCell[],
  ['2026-11-04', 'Nightly', 'yes (Tue)', '1', '✅ ok', 9, 2, 0, '', 'https://github.com/x/y/actions/runs/1'],
  ['2026-11-05', 'Nightly', 'yes (Wed)', '1', '❌ failed', 4, 0, 1, 'the sheet refused', 'https://github.com/x/y/actions/runs/2'],
  ['2026-11-05', 'My Options', 'yes', '1', '⚠️ slow', 3, 0, 0, '', 'javascript:alert(1)']];

async function sources(): Promise<DashboardSources> {
  return { portfolio: portfolioGrid(), exitReport: await exitGrid(), buyReport: await buyGrid(), paperValues: values(), paperLog: log(), paperReads: reads(), runHealth: runs() };
}

describe('dashboard data', () => {
  test('the Exit and Buy report tables are read through their fixed headers', async () => {
    const ex = parseExitReport(await exitGrid());
    assert.deepEqual(ex.map((x) => [x.ticker, x.kind]).sort(), [['AAA', 'STOCK'], ['BBB', 'OPTION'], ['BBB', 'STOCK']]);
    const opt = ex.find((x) => x.kind === 'OPTION')!;
    assert.equal(opt.strike, 50);
    const breached = ex.find((x) => x.ticker === 'BBB' && x.kind === 'STOCK')!;
    assert.match(breached.stopText, /breached/);
    assert.ok(ex.every((x) => x.action.length > 0));
    const buy = parseBuyReport(await buyGrid(), new Map([['CCC', 51], ['DDD', 100]]));
    assert.deepEqual(buy.map((b) => [b.rank, b.ticker, b.verdictKey]), [[1, 'CCC', 'BUY NOW'], [2, 'DDD', 'SET A BUY LIMIT']]);
    assert.deepEqual(buy[0]!.zone, [48, 52]);
    assert.equal(buy[0]!.zoneState, 'in');
    assert.equal(buy[1]!.zoneState, 'above');
    assert.equal(buy[0]!.conviction, 82);
  });

  test('portfolio: every holding, crypto included and marked, options, groups and totals', async () => {
    const d = buildDashboard(await sources(), CTX);
    const P = d.portfolio!;
    assert.deepEqual(P.holdings.map((h) => [h.label.split(' ')[0], h.kind, h.group]), [['AAA', 'stock', 'stocks'], ['BBB', 'etf', 'stocks'], ['COINX', 'crypto', 'crypto'], ['BBB', 'call', 'calls']]);
    const aaa = P.holdings[0]!;
    assert.equal(aaa.price, 121, 'tonight\'s close from the paper reads wins over the sheet');
    assert.equal(aaa.priceSource, 'live');
    assert.equal(aaa.value, 1210);
    assert.equal(aaa.gain, 210);
    assert.equal(aaa.tax, 52.5);
    assert.equal(aaa.afterTax, 157.5);
    const coin = P.holdings[2]!;
    assert.equal(coin.analysed, false);
    assert.equal(coin.note, 'not analysed (crypto)');
    assert.equal(coin.price, 40);
    assert.equal(coin.priceSource, 'sheet');
    assert.equal(coin.value, 100);
    assert.equal(coin.action, null);
    const call = P.holdings[3]!;
    assert.equal(call.value, 1000);
    assert.equal(call.cost, 600);
    assert.equal(call.dte, 42);
    assert.ok(call.action, 'the option row is joined to its Exit line');
    assert.equal(P.holdings[1]!.action !== null, true);
    assert.deepEqual(P.groups.map((g) => [g.id, g.count]), [['stocks', 2], ['crypto', 1], ['calls', 1]]);
    const bbb = P.holdings[1]!;
    assert.equal(bbb.priceSource, 'report', 'no paper-read close: the Exit report\'s current price of the same run beats the sheet\'s');
    assert.equal(bbb.price, 120);
    assert.equal(P.total.value, 1210 + 600 + 100 + 1000);
  });

  test('history: the CLOSED section, and stock sales matched first in first out', () => {
    const d = buildDashboard({ portfolio: portfolioGrid() }, CTX);
    const H = d.history!;
    const aaa = H.items.find((x) => x.ticker === 'AAA')!;
    assert.equal(aaa.cost, 400);
    assert.equal(aaa.proceeds, 700);
    assert.equal(aaa.gain, 300);
    assert.equal(aaa.tax, 75);
    assert.equal(aaa.date, '2026-09-01');
    const ddd = H.items.find((x) => x.ticker === 'DDD')!;
    assert.equal(ddd.gain, -300);
    assert.equal(ddd.tax, 0);
    assert.deepEqual(H.years, [{ year: 2026, count: 1, gain: 300, tax: 75 }, { year: 2025, count: 1, gain: -300, tax: 0 }]);
    const tx = parseTransactions([TRANSACTIONS_HEADERS as TabCell[],
      [46000, 'EEE', 'Stock', 'BUY', 10, 10, '', '', ''], [46010, 'EEE', 'Stock', 'BUY', 10, 20, '', '', ''], [46400, 'EEE', 'Stock', 'SELL', 15, 30, '', '', '']], 0.25);
    assert.equal(tx.length, 1);
    assert.equal(tx[0]!.cost, 200, '10 at $10 + 5 at $20');
    assert.equal(tx[0]!.proceeds, 450);
    assert.equal(tx[0]!.heldDays, 400);
  });

  test('paper: every account, series on the days, the trade log by account, weekly summaries', async () => {
    const d = buildDashboard(await sources(), CTX);
    const P = d.paper!;
    assert.deepEqual(P.days, ['2026-11-02', '2026-11-03']);
    assert.equal(P.accounts.length, 3);
    const eng = P.accounts.find((a) => a.name === 'Engine alone')!;
    assert.deepEqual(eng.series, [100500, 101500]);
    assert.equal(eng.buysThisWeek, 2);
    const claude = P.accounts.find((a) => /Claude/.test(a.name))!;
    assert.deepEqual(claude.series, [null, 99800], 'joined late');
    assert.equal(P.trades['Engine alone']!.length, 2);
    assert.equal(P.weekly.length, 1);
    assert.equal(P.weekly[0]!.partial, true);
    assert.match(P.weekly[0]!.caption, /Paper week/);
    assert.equal(P.accounts[P.accounts.length - 1]!.yardstick, true, 'the yardsticks come last');
  });

  test('models, runs, minutes; unsafe links dropped; nothing secret-shaped', async () => {
    const d = buildDashboard(await sources(), CTX);
    assert.equal(d.models!.day, '2026-11-03');
    const engine = d.models!.rows.find((r) => r.model === 'Engine')!;
    assert.deepEqual([engine.bull, engine.neutral, engine.bear], [2, 0, 0]);
    const wy = d.models!.rows.find((r) => r.model === 'Trend 200')!;
    assert.equal(wy.bear, 1);
    assert.deepEqual(d.runs!.items.map((r) => r.status), ['warn', 'fail', 'ok'], 'newest first');
    assert.equal(d.runs!.items[0]!.link, '', 'only https://github.com/ links pass');
    assert.deepEqual(d.minutes, { used: 16, cap: 2000, source: 'run-health' });
    const withGh = buildDashboard(await sources(), { ...CTX, minutes: { used: 812, cap: 2000 } });
    assert.deepEqual(withGh.minutes, { used: 812, cap: 2000, source: 'github' });
    const json = JSON.stringify(d);
    assert.doesNotMatch(json, /(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, 'no sheet-id shape');
    assert.doesNotMatch(json, /private_key|BEGIN [A-Z ]*PRIVATE|github_pat_|sk-ant-/);
  });

  test('schema, as-of text, missing sections, never throws on junk', () => {
    const d = buildDashboard({}, CTX);
    assert.equal(d.schema, DASHBOARD_SCHEMA);
    assert.equal(d.asOfText, 'Thu 5 Nov 2026, 23:40 NY');
    assert.deepEqual(d.missing, ['portfolio', 'exit', 'buy', 'history', 'paper', 'ideas', 'options', 'models', 'decisions', 'runs']);
    assert.equal(d.user.taxRate, 0.25);
    const junk = buildDashboard({ portfolio: [[null as never, {} as never]], exitReport: [['x']], paperValues: [['nope']], runHealth: [[1, 2, 3]], optionsReads: [['?']] }, CTX);
    assert.ok(junk.missing.includes('portfolio') && junk.missing.includes('paper'));
    assert.equal(asOfText(Date.parse('2026-07-01T16:05:00Z')), 'Wed 1 Jul 2026, 12:05 NY');
  });

  test('helpers', () => {
    assert.equal(verdictKeyOf('⏳ GREAT COMPANY — SET A BUY LIMIT · you hold it'), 'SET A BUY LIMIT');
    assert.equal(verdictKeyOf('✅ BUY NOW'), 'BUY NOW');
    assert.equal(dayOf(46000), '2025-12-09');
    assert.equal(dayOf('11/3/2026'), '2026-11-03');
    assert.equal(dayOf(12), null, 'a small number is not a date');
  });

  test('readDashboardSources: a tab that fails is null, one line, the rest are read', async () => {
    const store = new MemoryTabStore();
    await store.ensure('🩺 Run Health');
    await store.write('🩺 Run Health', 1, runs());
    const failing = { ...store, read: (tab: string, n: number) => (tab === 'Portfolio' ? Promise.reject(new Error('quota')) : store.read(tab, n)) } as unknown as MemoryTabStore;
    const lines: string[] = [];
    const src = await readDashboardSources(failing, (m) => lines.push(m));
    assert.equal(src.portfolio, null);
    assert.equal(src.runHealth!.length, 4);
    assert.equal(src.paperValues, null, 'missing tab');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Portfolio could not be read \(quota\)/);
    assert.equal(DASHBOARD_TABS.length, 14);
  });
});

describe('dashboard site folder', () => {
  test('writes the app shell, the data, the function, the headers and the icons', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    const files = writeSite(dir, '{"schema":1}');
    for (const f of [...APP_FILES, 'data/dashboard.json', 'apple-touch-icon.png', 'icon-512.png']) assert.ok(files.includes(f) && fs.existsSync(path.join(dir, f)), f);
    const png = fs.readFileSync(path.join(dir, 'apple-touch-icon.png'));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 180);
    const headers = fs.readFileSync(path.join(dir, '_headers'), 'utf8');
    assert.match(headers, /\/data\/\*\n {2}Cache-Control: no-store/);
    assert.match(headers, /X-Frame-Options: DENY/);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'), 'Chart.js 4.4.1 pinned');
    assert.ok(html.includes("fetch('./data/dashboard.json'"));
    assert.ok(html.includes('rel="manifest"') && html.includes('apple-touch-icon') && html.includes('name="theme-color"'));
    assert.doesNotMatch(html, /Mockup|SAMPLE/);
    assert.ok(!html.includes('claude-order') && !/data-run="claude/.test(html), 'no Claude order button');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.display, 'standalone');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('iconPng is a valid PNG of the asked size', () => {
    const p = iconPng(512);
    assert.equal(p.readUInt32BE(16), 512);
    assert.equal(p.subarray(12, 16).toString('ascii'), 'IHDR');
  });
});

test('fix 2026-11-06: a closed option whose Sell Price is the contract total is not multiplied by 100', async () => {
  const { parseClosed } = await import('../src/dashboard/data.ts');
  const grid = [['CLOSED positions'], ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'Sell Price', 'Sell Date'],
    ['AAPL', 'options', '1', "Mar19'27", '120', 'CALL', '48.1', '4810', '$9,049.00', '19:05:34 10/09/26'],
    ['KO', 'options', '2', "Jan15'27", '60', 'CALL', '3.5', '700', '5.25', '10:00:00 10/10/26']];
  const [a, k] = parseClosed(grid as never, 0.25);
  assert.equal(a!.proceeds, 9049); assert.equal(a!.gain, 4239);
  assert.equal(k!.proceeds, 1050); assert.equal(k!.gain, 350);
});

describe('fixes 2026-11-06 from the QA on the real sheets', () => {
  // A hand-made Exit report in the tab's fixed layout (exitSheet/text.ts): the run line, the table of contents, the
  // needs-attention lines and two holding sections.
  const exitTab = (): TabCell[][] => [
    ['📤 EXIT REPORT'], ['Run time: Nov 5, 2026, 11:49 PM EST'], [''],
    ['Holding', 'Action', 'Gain/loss', 'Stop and targets', 'Flags', 'Jump'],
    ['QQQX call $38 2027-12-17', 'REVIEW', '+8.1%', 'stop $38.40', '', ''],
    ['QQQX call $38 2027-06-17', 'HOLD', '+8.0%', 'stop $38.40', '', ''],
    ['FUNDX', 'HOLD', '+44.9%', 'stop $59.09', '', ''],
    ['WEAK', 'REVIEW', '-12.8%', '⚠ stop breached', '', ''],
    ['BTC', 'HOLD', '-26.4%', 'stop $30.03', '', ''],
    [''], ['⚠ NEEDS ATTENTION'], ['QQQX call $38 2027-12-17', 'REVIEW — the December call'], ['WEAK', 'REVIEW — the weekly trend is broken'], [''],
    ['═══ FUNDX ═══'], ['Current price', '$66.17'], ['Trailing stop', '$59.09, weekly stop'], ['Target 1', '$74.04 — not reached (11.9% above the current price)'], ['Target 2', 'no valid target'],
    ['═══ WEAK ═══'], ['Current price', '$45.95'], ['Trailing stop', '$73.87, weekly stop'], ['Target 1', 'no valid target'], ['Target 2', 'no valid target'],
  ];
  const pf = (): TabCell[][] => {
    const t = portfolioTemplateRows();
    return [t[0] as TabCell[], t[1] as TabCell[],
      ['FUNDX', 'stock', '', 850, 35.01, 29758.5, 45.67, '', ''],
      ['WEAK', 'stock', '', 20, 45.95, 919, 52.7, '', ''],
      ['BTC', 'stock', 'bitcoin etf', 240, 33.63, 8071.2, 45.67, '', ''],
      ['BTC', 'crypto', 'bitcoin', 0.37, 76031.5, 28131.66, 30000, '', ''],
      t[3] as TabCell[], t[4] as TabCell[], t[5] as TabCell[],
      ['QQQX', 'options', 1, "DEC17'27", 38, 'CALL', 10.82, 1082, 1170, '', '2026-06-02'],
      ['QQQX', 'options', 4, "JUN17'27", 38, 'CALL', 8.42, 3368, 3640, '', '2026-06-02']];
  };
  const targets = (): TabCell[][] => [['Date', 'Holding', 'Ticker', 'T1', 'T2'], ['2026-11-04', 'FUNDX', 'FUNDX', 76.01, 101.31], ['2026-11-04', 'WEAK', 'WEAK', 74.44, 140.8]];

  test('Exit "as of" is the report\'s run day, not the target-history day', () => {
    const d = buildDashboard({ exitReport: exitTab(), exitTargets: targets() }, CTX);
    assert.equal(d.exit!.asOf, '2026-11-05');
    assert.equal(d.exit!.runTime, 'Nov 5, 2026, 11:49 PM EST');
    assert.equal(d.exit!.targetsDay, '2026-11-04');
  });

  test('two calls of one ticker and strike get their own Exit line (matched by expiry)', () => {
    const d = buildDashboard({ portfolio: pf(), exitReport: exitTab() }, CTX);
    const calls = d.portfolio!.holdings.filter((h) => h.group === 'calls');
    assert.deepEqual(calls.map((h) => [h.expiry, h.action, h.why]), [['2027-12-17', 'REVIEW', 'REVIEW — the December call'], ['2027-06-17', 'HOLD', null]]);
    assert.equal(calls[1]!.value, 3640);
    assert.equal(calls[1]!.price, 9.1, 'call price = value / (contracts x 100)');
  });

  test('a stale sheet price gives way to the report\'s; targets and stop come from the report\'s own section', () => {
    const d = buildDashboard({ portfolio: pf(), exitReport: exitTab(), exitTargets: targets() }, CTX);
    const f = d.portfolio!.holdings.find((h) => h.ticker === 'FUNDX')!;
    assert.equal(f.price, 66.17);
    assert.equal(f.priceSource, 'report');
    assert.deepEqual([f.value, f.gain, f.tax, f.afterTax], [56244.5, 17425, 4356.25, 13068.75]);
    assert.deepEqual([f.t1, f.t2], [74.04, null], 'this run\'s targets, not the older remembered ones');
    const w = d.portfolio!.holdings.find((h) => h.ticker === 'WEAK')!;
    assert.equal(w.stop, 73.87, 'the breached stop keeps its level');
    assert.match(w.stopText!, /breached/);
    assert.deepEqual([w.t1, w.t2], [null, null]);
    assert.equal(w.tax, 0, 'no tax on a loss');
  });

  test('the bitcoin fund BTC and the coin BTC are labelled apart; crypto keeps the sheet\'s price', () => {
    const d = buildDashboard({ portfolio: pf(), exitReport: exitTab() }, CTX);
    const btc = d.portfolio!.holdings.filter((h) => h.ticker === 'BTC');
    assert.deepEqual(btc.map((h) => [h.label, h.kind, h.priceSource]), [['BTC (Grayscale mini)', 'btc', 'sheet'], ['Bitcoin', 'crypto', 'sheet']]);
    assert.equal(btc[0]!.action, 'HOLD', 'the fund gets the Exit line');
    assert.equal(btc[1]!.action, null, 'the coin does not');
    assert.equal(btc[1]!.value, 28131.66);
  });

  test('log rows of an account\'s part ("X, shares half") fold into the account', () => {
    const vals: TabCell[][] = [VALUES_HEADER as TabCell[], ['2026-11-03', 'Everything together (3 positions)', 'D everything', 99000, -0.01, 'AAA'], ['2026-11-03', 'Hold QQQ', '📊 yardstick', 100100, 0.001, 'QQQ']];
    const lg: TabCell[][] = [LOG_HEADER.slice(0, 10) as TabCell[],
      ['2026-11-03', 'filled', 'Everything together, shares half', 'BOUGHT', 'AAA', '10', '$100.00', '$1,000', '', 'why'],
      ['2026-11-03', 'filled', 'Everything together, LEAPS half', 'BOUGHT', 'AAA $100 call 2029-01-19', '1', '$20.00', '$2,000', '', 'why']];
    const d = buildDashboard({ paperValues: vals, paperLog: lg }, CTX);
    const t = d.paper!.trades['Everything together (3 positions)']!;
    assert.equal(t.length, 2);
    assert.deepEqual(t.map((r) => r[1]), ['filled · shares half', 'filled · LEAPS half']);
    assert.equal(Object.keys(d.paper!.trades).length, 1);
    assert.equal(d.paper!.accounts.find((a) => a.name.startsWith('Everything'))!.buysThisWeek, 2);
  });

  test('🤖 Claude Ideas: newest first, open / closed, tonight\'s close against the zone', async () => {
    const { CLAUDE_IDEAS_HEADER } = await import('../src/paper/claudeIdeas.ts');
    const grid: TabCell[][] = [CLAUDE_IDEAS_HEADER as TabCell[],
      ['2026-11-02 10:00', 'AAA', 'stock', 'BUY', '$100 - $110', '90', '140', '3-6 months', 'pullback', 'open'],
      ['2026-11-03 10:00', 'CCC', 'call', 'WAIT', '$40 - $45', '35', '60', '6 months', 'wait', 'closed: never reached the zone']];
    const d = buildDashboard({ claudeIdeas: grid, paperReads: reads() }, CTX);
    const [c, a] = d.ideas!.items;
    assert.deepEqual([c!.ticker, c!.open, c!.outcome, c!.kind, c!.zoneState, c!.distancePct], ['CCC', false, 'never reached the zone', 'call', 'above', 13.33]);
    assert.deepEqual([a!.ticker, a!.open, a!.zone, a!.stop, a!.target, a!.price, a!.zoneState], ['AAA', true, [100, 110], 90, 140, 121, 'above']);
    assert.equal(a!.day, '2026-11-02');
  });
});
