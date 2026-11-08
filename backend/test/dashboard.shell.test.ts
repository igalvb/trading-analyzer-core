/**
 * The dashboard's app shell (backend/dashboard/): the service worker, the CSP, the self-hosted chart library, and the
 * page itself run in a small stub DOM with real-shaped data and NO chart library. Regression tests for the
 * 2026-11-07 live bug: the service worker passed the CDN chart library through its own fetch(), which the site's CSP
 * (connect-src 'self') blocked, so every chart said "Chart library not loaded".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { APP_DIR, APP_FILES } from '../src/dashboard/site.ts';
import { buildDashboard, ledgerClosedHistory, withLedgerBought, type DashboardContext, type DashHolding } from '../src/dashboard/data.ts';
import { portfolioTemplateRows } from '../src/initUserSheets.ts';
import { VALUES_HEADER, LOG_HEADER, READS_HEADER } from '../src/paper/paperLog.ts';
import { RUN_HEALTH_HEADER } from '../src/watchdog.ts';
import type { TabCell } from '../src/storage/tabStore.ts';
import type { LedgerSources } from '../src/ledger/networth.ts';
import type { PriceSeries } from '../src/ledger/estimate.ts';

const read = (f: string): string => fs.readFileSync(path.join(APP_DIR, f), 'utf8');

// ---- the service worker -------------------------------------------------------------------------------------------

function loadSw(): { fire: (type: string, ev: unknown) => void; calls: string[] } {
  const listeners: Record<string, (e: unknown) => void> = {};
  const calls: string[] = [];
  const self = {
    location: { origin: 'https://dash.example.org' },
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
    skipWaiting: () => { calls.push('skipWaiting'); },
    clients: { claim: () => { calls.push('claim'); return Promise.resolve(); } },
  };
  vm.runInNewContext(read('sw.js'), { self, fetch: (r: { url: string }) => { calls.push('fetch ' + r.url); return Promise.resolve({}); }, URL });
  return { fire: (t, e) => listeners[t]!(e), calls };
}
function fetchEvent(url: string, method = 'GET'): { request: { url: string; method: string }; respondWith: (p: unknown) => void; responded: boolean } {
  const e = { request: { url, method }, responded: false, respondWith(_p: unknown) { e.responded = true; } };
  return e;
}

describe('dashboard service worker (sw.js)', () => {
  test('leaves other origins to the browser: its own fetch() would obey connect-src \'self\' and be blocked', () => {
    const sw = loadSw();
    for (const u of ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans', 'https://fonts.gstatic.com/s/x.woff2']) {
      const e = fetchEvent(u); sw.fire('fetch', e);
      assert.equal(e.responded, false, u);
    }
    assert.ok(!sw.calls.some((c) => c.startsWith('fetch')));
  });
  test('leaves non-GET requests (the Run and edit buttons) to the browser', () => {
    const sw = loadSw();
    const e = fetchEvent('https://dash.example.org/api/run', 'POST'); sw.fire('fetch', e);
    assert.equal(e.responded, false);
  });
  test('answers this site\'s own GETs from the network (a fetch handler keeps the app installable)', () => {
    const sw = loadSw();
    for (const u of ['https://dash.example.org/', 'https://dash.example.org/data/dashboard.json', 'https://dash.example.org/vendor/chart.umd.min.js']) {
      const e = fetchEvent(u); sw.fire('fetch', e);
      assert.equal(e.responded, true, u);
    }
  });
  test('updates itself at once: skipWaiting + clients.claim, a VERSION to bump, served no-cache, registered with updateViaCache none', () => {
    const sw = loadSw();
    sw.fire('install', {});
    sw.fire('activate', { waitUntil: (p: Promise<unknown>) => p });
    assert.deepEqual(sw.calls, ['skipWaiting', 'claim']);
    assert.match(read('sw.js'), /const VERSION = '\d{4}-\d{2}-\d{2}\.\d+';/);
    assert.match(read('_headers'), /\/sw\.js\n {2}Cache-Control: no-cache/);
    assert.match(read('_headers'), /\/index\.html\n {2}Cache-Control: no-cache/);
    assert.match(read('index.html'), /register\('sw\.js', \{ updateViaCache: 'none' \}\)/);
  });
});

// ---- CSP + the self-hosted chart library --------------------------------------------------------------------------

function csp(): Map<string, string[]> {
  const line = read('_headers').split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
  assert.ok(line, 'a CSP');
  const m = new Map<string, string[]>();
  for (const d of line!.split(':').slice(1).join(':').split(';')) { const [k, ...v] = d.trim().split(/\s+/); if (k) m.set(k, v); }
  return m;
}

describe('dashboard CSP and scripts', () => {
  test('script-src is the site only: no external script is needed', () => {
    const c = csp();
    assert.deepEqual(c.get('script-src'), ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(c.get('connect-src'), ["'self'"]);
    assert.deepEqual(c.get('default-src'), ["'self'"]);
  });
  test('every <script src> is a file of the site (copied by writeSite), none from another origin', () => {
    const html = read('index.html');
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(srcs, ['vendor/chart.umd.min.js']);
    for (const s of srcs) { assert.ok(!/^[a-z]+:|^\/\//i.test(s), s); assert.ok(APP_FILES.includes(s), s + ' is copied'); assert.ok(fs.existsSync(path.join(APP_DIR, s)), s); }
    assert.ok(!html.includes('cdnjs.cloudflare.com'));
  });
  test('the vendored chart library is Chart.js 4.4.1 (npm dist/chart.umd.js, its source-map line removed)', () => {
    const js = read('vendor/chart.umd.min.js');
    assert.match(js.slice(0, 200), /Chart\.js v4\.4\.1[\s\S]*Released under the MIT License/);
    assert.ok(!js.includes('sourceMappingURL'), 'no map the site does not serve');
    assert.equal(crypto.createHash('sha256').update(js).digest('hex'), VENDOR_SHA256);
  });
});
/** sha256 of vendor/chart.umd.min.js: npm chart.js@4.4.1 (tarball sha512-C74QN1bx…534Dg==) dist/chart.umd.js minus its last line. */
const VENDOR_SHA256 = '0ee28337f25838a7a5d6b1e8b2b02279ab10e80e17c217a99893a7a717f2ba05';

// ---- the page in a stub DOM, with no chart library ----------------------------------------------------------------

const NOW = Date.parse('2026-11-06T21:30:00Z');
const CTX: DashboardContext = { nowMs: NOW, taxRate: 0.25, list: ['AAA', 'BBB'], labels: { list: 'your list', holdCore: 'Hold your list', holdList: 'Hold your list' }, timeZone: 'America/New_York', version: '9.9.9', paper: { start: '2026-11-02', end: null } };

function portfolioGrid(): TabCell[][] {
  const t = portfolioTemplateRows();
  return [
    t[0] as TabCell[], t[1] as TabCell[],
    ['AAA', 'stock', '', 10, 118, 1180, 100, '', ''],
    ['FND', 'stock', 'ETF', 20, 50, 1000, 30, '', ''],
    ['COINX.', 'crypto', '', 2.5, 40, 100, 10, '', ''],
    ['TOTAL', '', '', '', '', 2280, '', '', ''],
    t[3] as TabCell[], t[4] as TabCell[], t[5] as TabCell[],
    ['AAA', 'call', 2, '2027-06-17', 150, 'CALL', 5, 1000, 1600, '', '2026-06-01'],
    t[7] as TabCell[], t[8] as TabCell[],
    ['AAA', 'call', 1, '2026-09-18', 100, 'CALL', 4, 400, 7, '2026-09-01'],
  ];
}
function series(start: string, n: number, from: number, step: number): PriceSeries {
  const dates: string[] = [], closes: number[] = [];
  for (let i = 0; i < n; i++) { dates.push(new Date(Date.parse(start + 'T12:00:00Z') + i * 86_400_000).toISOString().slice(0, 10)); closes.push(Math.round((from + i * step) * 100) / 100); }
  return { dates, closes };
}
const LEDGER: LedgerSources = {
  holdings: {
    schema: 1, updated: '2026-11-05',
    stocks: [
      { id: 's1', ticker: 'AAA', kind: 'stock', qty: 10, avgCost: 100, currency: 'USD', bought: null, lots: [{ date: '2025-01-10', qty: 6, price: 90, note: 'a long note about where this lot came from, the statement and the account, long enough to wrap twice on a phone' }, { date: '2025-06-02', qty: 4, price: 115 }] },
      { id: 's2', ticker: 'FND', kind: 'btcFund', qty: 20, avgCost: 30, currency: 'USD', bought: '2025-03-03' },
      { id: 's3', ticker: 'COINX.', kind: 'crypto', qty: 2.5, avgCost: 10, currency: 'USD', bought: null, manualPrice: 40 },
    ],
    options: [{ id: 'o1', ticker: 'AAA', side: 'call', contracts: 2, strike: 150, expiry: '2027-06-17', avgPremium: 5, bought: '2026-06-01', currentValue: 1600 }],
    closed: [
      { id: 'c1', ticker: 'AAA', kind: 'call', qty: 1, strike: 100, expiry: '2026-09-18', cost: 400, proceeds: 700, currency: 'USD', bought: '2026-09-01', sold: '2026-09-18' },
      { id: 'c2', ticker: 'OLD', kind: 'stock', qty: 5, cost: 500, proceeds: 650, currency: 'USD', bought: '2024-01-02', sold: '2025-02-03' },
      { id: 'c3', ticker: 'NOCOST', kind: 'stock', qty: 5, cost: null, proceeds: 100, currency: 'USD', bought: null, sold: '2025-02-04' },
    ],
  },
  assets: {
    schema: 1, updated: '2026-11-01',
    items: [
      { id: 'a1', group: 'pension', name: 'Pension A', provider: 'Track A', value: 370000, currency: 'ILS', asOf: '2026-10-31', person: 'P1' },
      { id: 'a2', group: 'realEstate', name: 'Home', value: 2000000, debt: 800000, currency: 'ILS', asOf: '2026-05-01', person: 'P1' },
      { id: 'a3', group: 'cash', name: 'Bank', value: 0, currency: 'USD', asOf: '2026-11-05' },
      { id: 'a4', group: 'cash', name: 'Loan', value: 0, debt: 20000, currency: 'USD', asOf: '2026-11-05' },
    ],
  },
  watchlist: { schema: 1, updated: '2026-11-01', tickers: ['AAA', 'CCC'] },
  snapshots: [{ schema: 1, date: '2026-11-05', fxUsdIls: 3.2, usd: { stocks: 1150, btcFunds: 950, crypto: 100 }, totalUsd: 2200, totalIls: 7040 }],
  flows: [
    { schema: 1, id: 'f1', date: '2025-06-02', group: 'stocks', amount: 460, currency: 'USD', source: 'migration' },
    { schema: 1, id: 'f2', date: '2026-11-04', group: 'stocks', amount: 100, currency: 'USD', source: 'suggested' },
  ],
  targets: { schema: 1, updated: '2026-01-01', items: [{ id: 't1', name: 'AAA/BTC', value: 0.004 }] },
};
function data(): unknown {
  const values: TabCell[][] = [VALUES_HEADER as TabCell[],
    ['2026-11-02', 'Engine alone', 'A original', 100500, 0.005, 'AAA'], ['2026-11-02', 'Hold QQQ', '📊 yardstick', 100200, 0.002, 'QQQ'],
    ['2026-11-03', 'Engine alone', 'A original', 101500, 0.015, 'AAA'], ['2026-11-03', 'Hold QQQ', '📊 yardstick', 100100, 0.001, 'QQQ'],
    ['2026-11-03', '🤖 Claude, free choice', 'Claude', 99800, -0.002, 'cash']];
  const log: TabCell[][] = [LOG_HEADER.slice(0, 10) as TabCell[], ['2026-11-02', 'filled', 'Engine alone', 'BOUGHT', 'AAA', '10', '$100.00', '$1,000', '', 'the engine said buy']];
  const reads: TabCell[][] = [READS_HEADER as TabCell[], ['2026-11-03', 'AAA', 121, 72, 'WAIT', 'HOLD', 'bullish', 'bullish', 'neutral', 'bearish', 'bullish', 'markup', 'bullish', 'cautionary', '+5%', 106, '$100.00 to $110.00', 130, 150, '']];
  const runs: TabCell[][] = [RUN_HEALTH_HEADER as TabCell[], ['2026-11-05', 'Nightly', 'yes (Wed)', '1', '⚠️ warnings', 9, 2, 0, 'a long problem text', 'https://github.com/x/y/actions/runs/1']];
  const priceHistory = new Map<string, PriceSeries>([['AAA', series('2020-01-02', 2500, 40, 0.03)], ['FND', series('2024-01-10', 1030, 20, 0.03)]]);
  return JSON.parse(JSON.stringify(buildDashboard({ portfolio: portfolioGrid(), paperValues: values, paperLog: log, paperReads: reads, runHealth: runs, ledger: LEDGER, priceHistory }, { ...CTX, fxUsdIls: { usdIls: 3.2, date: '2026-11-06' } })));
}

/** A stub DOM just big enough for index.html's script: every element exists, records what is written into it. */
function runPage(dash: unknown, chart: unknown): { text: () => string; errors: string[]; go: (h: string) => Promise<void>; click: (ds: Record<string, string>) => Promise<void> } {
  const writes: string[] = [], errors: string[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const els = new Map<string, unknown>();
  const mkEl = (key: string): Record<string, unknown> => {
    let html = '', txt = '';
    const el: Record<string, unknown> = {
      id: key, dataset: {}, style: {}, value: '', dir: '', tagName: 'DIV', scrollTop: 0, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {},
      insertAdjacentHTML(_p: string, h: string) { writes.push(String(h)); }, closest: () => null, matches: () => false,
      querySelector: (s: string) => doc.querySelector(s), querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0, right: 300, bottom: 200 }),
    };
    Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = String(v); writes.push(html); } });
    Object.defineProperty(el, 'textContent', { get: () => txt, set: (v) => { txt = String(v); writes.push(txt); } });
    Object.defineProperty(el, 'parentElement', { get: () => doc.querySelector(key + ' <parent>') });
    return el;
  };
  const doc = {
    querySelector: (s: string) => { if (!els.has(s)) els.set(s, mkEl(s)); return els.get(s); },
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ??= []).push(f); },
    documentElement: { dataset: {} as Record<string, string> },
    fonts: { ready: Promise.resolve() },
    activeElement: null,
  };
  const ctx: Record<string, unknown> = {
    document: doc, location: { hash: '' }, navigator: {}, innerWidth: 412, console: { log() {}, warn() {}, error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); } },
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '#336699' }), scrollTo() {}, setTimeout: (f: () => void) => { queueMicrotask(f); return 0; }, clearTimeout() {},
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners['win:' + t] ??= []).push(f); },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(dash) }),
    Chart: chart,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const html = read('index.html');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1]!, ctx);
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    text: () => writes.join('\n'),
    errors,
    go: async (h) => { (ctx.location as { hash: string }).hash = '#' + h; for (const f of listeners['win:hashchange'] ?? []) f({}); await settle(); },
    click: async (ds) => {
      const target = { dataset: ds, tagName: 'BUTTON', closest: () => target, matches: () => false };
      for (const f of listeners.click ?? []) f({ target, preventDefault() {} });
      await settle();
    },
  };
}
const VIEWS = ['networth', 'overview', 'portfolio', 'exit', 'buy', 'paper', 'history', 'analyze', 'options', 'models', 'runs', 'actions', 'settings', 'more'];
const BAD = /\bNaN\b|\bundefined\b|\[object |\bInfinity\b/;

describe('dashboard page (stub DOM, real-shaped data)', () => {
  test('with NO chart library: every tab renders, charts say the library failed to load, nothing throws', async () => {
    const p = runPage(data(), undefined);
    await p.go('networth');
    for (const v of VIEWS) await p.go(v);
    for (const c of ['USD', 'ILS', 'PCT']) { await p.go('networth'); await p.click({ nwcur: c }); for (const r of ['1M', 'YTD', '1Y', '5Y', 'All']) await p.click({ grrange: r }); }
    await p.click({ nwitem: '0' }); await p.click({ hold: '0' }); await p.click({ hist: '0' }); await p.click({ acct: '0' }); await p.click({ grinfo: '1' });
    assert.deepEqual(p.errors, []);
    const t = p.text();
    assert.ok(t.includes('Chart library failed to load'), 'the note in place of each chart');
    const bad = t.split('\n').filter((l) => BAD.test(l.replace(/<[^>]+>/g, ' ')));
    assert.deepEqual(bad.slice(0, 3), [], 'no NaN / undefined / [object] in what is shown');
    assert.ok(t.includes('OLD') && t.includes('NOCOST'), 'History lists the ledger\'s closed positions');
  });
  test('a chart library that throws breaks only its own chart: the other sections still render', async () => {
    const thrower = function Chart(): never { throw new Error('boom'); } as unknown as { getChart: () => null; defaults: unknown };
    thrower.getChart = () => null; thrower.defaults = { font: {} };
    const p = runPage(data(), thrower);
    for (const v of VIEWS) await p.go(v);
    assert.ok(p.errors.length > 0 && p.errors.every((e) => /chart .* not drawn/.test(e)), p.errors.join('; '));
    const t = p.text();
    assert.ok(t.includes('This chart could not be drawn.'));
    assert.ok(t.includes('Engine alone') && t.includes('Nightly') && t.includes('NOCOST'), 'paper, runs and history rendered');
  });
  test('a lot\'s note is its own wrapping row, not inside the nowrap date cell', async () => {
    const p = runPage(data(), undefined);
    await p.go('networth');
    const items = (JSON.parse(JSON.stringify(data())) as { networth: { items: { id: string }[] } }).networth.items;
    await p.click({ nwitem: String(items.findIndex((x) => x.id === 's1')) });
    assert.match(p.text(), /<tr class="lot-note"><td colspan="6" class="small muted" dir="auto">a long note about/);
  });
});

describe('dashboard data from the ledger (fix 2026-11-07)', () => {
  test('a holding without a sheet date takes the ledger\'s bought day or first lot, matched by ticker and kind', () => {
    const h = (ticker: string, group: DashHolding['group'], entryDate: string | null = null): DashHolding => ({ ticker, group, entryDate } as DashHolding);
    const out = withLedgerBought([h('AAA', 'stocks'), h('FND', 'btc'), h('BTC', 'btc'), h('BTC', 'crypto'), h('AAA', 'calls'), h('AAA', 'stocks', '2020-01-01')], [
      ...LEDGER.holdings!.stocks, { id: 'x', ticker: 'BTC', kind: 'btcFund', qty: 1, avgCost: 1, currency: 'USD', bought: '2024-07-31' },
    ]);
    assert.deepEqual(out.map((x) => x.entryDate), ['2025-01-10', '2025-03-03', '2024-07-31', null, null, '2020-01-01']);
  });
  test('the ledger\'s closed positions join History unless the sheet already lists the sale; USD only', () => {
    const have = [{ ticker: 'AAA', kind: 'call', date: '2026-09-18' }] as never[];
    const out = ledgerClosedHistory([...LEDGER.holdings!.closed, { id: 'i', ticker: 'ILS1', kind: 'stock', qty: 1, cost: 1, proceeds: 2, currency: 'ILS', bought: null, sold: '2025-01-01' }], 0.25, have);
    assert.deepEqual(out.map((x) => [x.label, x.gain, x.heldDays, x.source]), [['OLD', 150, 398, 'ledger'], ['NOCOST', null, null, 'ledger']]);
  });
});
