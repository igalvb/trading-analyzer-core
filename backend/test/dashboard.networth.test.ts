/**
 * The dashboard's net worth screen and growth graph (src/ledger/networth.ts, wired in src/dashboard/data.ts) from a
 * made-up ledger: live prices for holdings, static values with their dates, real estate net of the mortgage, USD and
 * ILS, sub-type allocation, ratio targets, per-person totals, the growth snapshots and flows, and the "growth without
 * deposits" math (the page's copy of the function is held equal to the TS one).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildNetWorth, buildGrowth, withoutFlows, readLedgerSources, latestFlows, convert, fxOn, subTypeTotals, ratioCards, STALE_DAYS, TARGETS_FILE,
  type LedgerSources, type LiveHolding,
} from '../src/ledger/networth.ts';
import { LEDGER_FILES, type LedgerFlow, type LedgerSnapshot } from '../src/ledger/schema.ts';
import { buildDashboard, type DashboardContext } from '../src/dashboard/data.ts';

const NOW = Date.parse('2026-11-06T20:00:00Z');
// Made-up Hebrew names (tests only; the core source carries none).
const PENSION = '\u05e7\u05e8\u05df \u05e4\u05e0\u05e1\u05d9\u05d4 ' + '\u05d3\u05d5\u05d2\u05de\u05d4';
const HOME = '\u05d3\u05d9\u05e8\u05d4 ' + '\u05dc\u05d3\u05d5\u05d2\u05de\u05d4';

const LEDGER: LedgerSources = {
  holdings: {
    schema: 1, updated: '2026-11-01',
    stocks: [
      { id: 's1', ticker: 'AAA', kind: 'stock', qty: 10, avgCost: 100, currency: 'USD', bought: '2025-01-10', subType: 'Stocks long' },
      { id: 's2', ticker: 'FND', kind: 'btcFund', qty: 20, avgCost: 30, currency: 'USD', bought: null },
      { id: 's3', ticker: 'BTC', kind: 'crypto', qty: 0.5, avgCost: 20000, currency: 'USD', bought: null, manualPrice: 80000 },
      { id: 's4', ticker: 'ZZZ', kind: 'stock', qty: 3, avgCost: null, currency: 'USD', bought: null },
    ],
    options: [{ id: 'o1', ticker: 'AAA', side: 'call', contracts: 2, strike: 150, expiry: '2027-06-17', avgPremium: 5, bought: null, currentValue: 999 }],
    closed: [],
  },
  assets: {
    schema: 1, updated: '2026-11-01',
    items: [
      { id: 'a1', group: 'pension', name: PENSION, provider: 'Track A', value: 370000, currency: 'ILS', asOf: '2026-10-31', person: 'P1' },
      { id: 'a2', group: 'realEstate', name: HOME, value: 2000000, debt: 800000, currency: 'ILS', asOf: '2026-05-01', person: 'P1' },
      { id: 'a3', group: 'cash', name: 'Bank', value: 5000, currency: 'USD', asOf: '2026-11-05' },
      { id: 'a4', group: 'funds', name: 'Study fund', value: 74000, currency: 'ILS', asOf: '2026-09-30', person: 'P2' },
    ],
  },
  watchlist: { schema: 1, updated: '2026-11-01', tickers: ['AAA', 'CCC'] },
  snapshots: [
    { schema: 1, date: '2026-11-04', fxUsdIls: 3.6, usd: { stocks: 1000 }, totalUsd: 1000, totalIls: 3600 },
    { schema: 1, date: '2026-11-05', fxUsdIls: 3.7, usd: { stocks: 1100, cash: 50 }, totalUsd: 1150, totalIls: null },
    { schema: 1, date: '2026-11-05', fxUsdIls: 3.7, usd: { stocks: 1200, cash: 50 }, totalUsd: 1250, totalIls: null },
  ],
  flows: [
    { schema: 1, id: 'f1', date: '2026-11-05', group: 'stocks', amount: 370, currency: 'ILS', source: 'owner' },
    { schema: 1, id: 'f2', date: '2026-11-05', group: 'cash', amount: -10, currency: 'USD', source: 'suggested' },
    { schema: 1, id: 'f3', date: '2026-11-05', group: 'cash', amount: 7, currency: 'USD', source: 'suggested' },
    { schema: 1, id: 'f3', date: '2026-11-05', group: 'cash', amount: 7, currency: 'USD', source: 'suggested', dismissed: true },
  ],
  targets: { schema: 1, updated: '2026-01-01', items: [{ id: 't1', name: 'AAA/BTC', value: 0.004 }, { id: 't2', name: 'BTC bag/AAA', value: 300 }, { id: 't3', name: 'QQQ/BTC', value: 1 }, { id: 't4', name: 'nonsense', value: 2 }] },
};
const LIVE: LiveHolding[] = [
  { ticker: 'AAA', group: 'stocks', kind: 'stock', price: 120, value: 1200, priceSource: 'live' },
  { ticker: 'FND', group: 'btc', kind: 'btc', price: 50, value: 1000, priceSource: 'report', subType: 'Bitcoin ETF' },
  { ticker: 'AAA', group: 'calls', kind: 'call', price: 8, value: 1600, priceSource: 'sheet', strike: 150, expiry: '2027-06-17' },
];

describe('net worth (ledger)', () => {
  test('every item, live prices for holdings, static values with dates, totals in USD and ILS', () => {
    const N = buildNetWorth({ ledger: LEDGER, live: LIVE, nowMs: NOW })!;
    assert.deepEqual(N.fx, { usdIls: 3.7, date: '2026-11-05', source: 'snapshot' });
    const by = Object.fromEntries(N.items.map((x) => [x.id, x]));
    assert.equal(by.s1!.value, 1200); assert.equal(by.s1!.source, 'live'); assert.equal(by.s1!.ils, 4440); assert.equal(by.s1!.cost, 1000);
    assert.equal(by.s2!.group, 'btcFunds'); assert.equal(by.s2!.value, 1000, 'matched to the bitcoin-fund row');
    assert.equal(by.s3!.value, 40000); assert.equal(by.s3!.source, 'manual'); assert.equal(by.s3!.group, 'crypto');
    assert.equal(by.s4!.value, null); assert.equal(by.s4!.source, null);
    assert.equal(by.o1!.value, 1600, 'the live portfolio row wins over the stored value'); assert.equal(by.o1!.name, 'AAA 150C 2027-06-17');
    assert.equal(by.a1!.name, PENSION, 'the Hebrew name exactly as written');
    assert.equal(by.a1!.usd, 100000); assert.equal(by.a1!.ils, 370000);
    assert.equal(by.a2!.net, 1200000); assert.equal(by.a2!.ageDays, 189); assert.equal(by.a2!.stale, true);
    assert.equal(by.a1!.stale, false); assert.ok(STALE_DAYS === 90);
    const g = Object.fromEntries(N.groups.map((x) => [x.id, x]));
    assert.equal(g.realEstate!.usd, r2(1200000 / 3.7)); assert.equal(g.realEstate!.debtUsd, r2(800000 / 3.7));
    assert.equal(g.stocks!.unpriced, 1);
    assert.equal(N.total.usd, r2(N.groups.reduce((s, x) => s + x.usd, 0)));
    assert.equal(N.total.ils, r2(N.total.usd * 3.7));
    assert.deepEqual(N.watchlist, ['AAA', 'CCC']);
    assert.equal(N.items.find((x) => x.id === 'a1')!.ref!.file, LEDGER_FILES.assets);
  });

  test('totals block, per-person subtotals, sub-type allocation', () => {
    const N = buildNetWorth({ ledger: LEDGER, live: LIVE, nowMs: NOW })!;
    assert.equal(N.totals.portfolio, 1200 + 1000 + 40000 + 1600);
    assert.equal(N.totals.pension, 100000);
    assert.equal(N.totals.realEstate, r2(2000000 / 3.7));
    assert.equal(N.totals.debt, r2(-800000 / 3.7));
    assert.equal(N.totals.total, N.total.usd);
    assert.equal(N.totals.ils!.pension, 370000);
    assert.deepEqual(N.persons.map((p) => [p.name, p.count]), [['P1', 2], ['P2', 1]]);
    assert.equal(N.persons[0]!.usd, r2(100000 + 1200000 / 3.7));
    assert.deepEqual(N.subTypes.map((t) => t.name), ['Crypto', 'Options', 'Stocks long', 'Bitcoin ETF', 'Stocks']);
    assert.equal(N.subTypes.reduce((s, t) => s + t.share, 0).toFixed(0), '100');
    assert.deepEqual(subTypeTotals([{ group: 'pension', subType: null, usd: 5 }]), []);
  });

  test('ratio cards: price/price, bag/price, the coin before a same-ticker fund, unknown sides', () => {
    const N = buildNetWorth({ ledger: LEDGER, live: [...LIVE, { ticker: 'BTC', group: 'btc', kind: 'btc', price: 40, value: 400, priceSource: 'live' }], nowMs: NOW, prices: new Map([['QQQ', 500]]) })!;
    const R = Object.fromEntries(N.ratios!.map((x) => [x.id, x]));
    assert.equal(R.t1!.current, Number((120 / 80000).toPrecision(6))); assert.equal(R.t1!.pctOfTarget, r2(120 / 80000 / 0.004 * 100));
    assert.equal(R.t2!.current, Number((40000 / 120).toPrecision(6)));
    assert.equal(R.t3!.current, Number((500 / 80000).toPrecision(6)), 'tonight\'s close when no holding');
    assert.equal(R.t4!.current, null); assert.equal(R.t4!.pctOfTarget, null);
    assert.equal(buildNetWorth({ ledger: { ...LEDGER, targets: null }, live: LIVE, nowMs: NOW })!.ratios, undefined, 'no targets file: no cards');
    assert.deepEqual(ratioCards({ schema: 1, updated: '2026-01-01', items: [] }, [], new Map()), []);
  });

  test('no holdings file: the live portfolio rows (not editable); no rate: ILS items unpriced in USD', () => {
    const N = buildNetWorth({ ledger: { assets: { schema: 1, updated: '2026-11-01', items: [LEDGER.assets!.items[0]!] } }, live: LIVE, nowMs: NOW })!;
    assert.equal(N.fx, null);
    assert.equal(N.items.filter((x) => x.ref === null).length, 3);
    const p = N.items.find((x) => x.group === 'pension')!;
    assert.equal(p.usd, null); assert.equal(p.ils, 370000);
    assert.equal(N.total.unpriced, 1);
    assert.equal(N.total.ils, null);
    assert.equal(buildNetWorth({ ledger: {}, live: [], nowMs: NOW }), null);
  });

  test('conversion helpers', () => {
    assert.deepEqual(convert(370, 'ILS', 3.7), [100, 370]);
    assert.deepEqual(convert(100, 'USD', null), [100, null]);
    assert.equal(fxOn(LEDGER.snapshots!, '2026-11-01'), 3.6, 'before the first: the first');
    assert.equal(fxOn(LEDGER.snapshots!, '2026-11-09'), 3.7);
  });
});

describe('growth (snapshots + flows)', () => {
  test('one snapshot per day (the last line wins), flows by id (the last line wins), dismissed dropped, suggested flagged', () => {
    const G = buildGrowth(LEDGER)!;
    assert.deepEqual(G.snapshots.map((x) => [x.date, x.totalUsd, x.totalIls]), [['2026-11-04', 1000, 3600], ['2026-11-05', 1250, 4625]]);
    assert.equal(G.start, '2026-11-04');
    assert.deepEqual(G.flows.map((f) => [f.id, f.usd, f.ils, f.suggested]), [['f1', 100, 370], ['f2', -10, -37, true]].map((x) => x.length === 3 ? [...x, false] : x));
    assert.equal(latestFlows(LEDGER.flows as LedgerFlow[]).length, 3);
    assert.equal(buildGrowth({ holdings: LEDGER.holdings }), null);
    assert.equal(buildGrowth({ snapshots: [], holdings: LEDGER.holdings })!.start, '2026-11-01', 'no snapshot yet: the ledger day');
  });

  test('withoutFlows: value minus the net money in since the first day shown', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06'];
    const vals = [1000, 1010, 2030, 1525];
    const flows = [
      { date: '2026-01-01', amount: 999 }, // on the first day: already inside value[0]
      { date: '2026-01-03', amount: 1000 }, // a weekend deposit: counts on the next day shown
      { date: '2026-01-06', amount: -500 }, // a withdrawal on its own day
    ];
    assert.deepEqual(withoutFlows(days, vals, flows), [1000, 1010, 1030, 1025]);
    assert.deepEqual(withoutFlows(days, [1000, null, 2030, 1525], []), [1000, null, 2030, 1525]);
    assert.deepEqual(withoutFlows([], [], flows), []);
    // A later window starts again: the deposit before its first day is not taken off.
    assert.deepEqual(withoutFlows(days.slice(2), vals.slice(2), flows), [2030, 2025]);
  });

  test("the page's copy of withoutFlows gives the same answers", () => {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8');
    const m = /\/\* growth-math:start[^*]*\*\/([\s\S]*?)\/\* growth-math:end \*\//.exec(html);
    assert.ok(m, 'markers in index.html');
    const page = new Function(m[1] + '\nreturn withoutFlows;')() as typeof withoutFlows;
    let seed = 7;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 30);
      const days = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString().slice(0, 10));
      const vals = days.map(() => (rnd() < 0.1 ? null : Math.round(rnd() * 1e6) / 100));
      const flows = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ date: new Date(Date.UTC(2025, 11, 25 + Math.floor(rnd() * n * 2 + 8))).toISOString().slice(0, 10), amount: Math.round((rnd() - 0.4) * 1e5) / 100 }));
      assert.deepEqual(page(days, vals, flows), withoutFlows(days, vals, flows));
    }
  });

  test('the page shows ledger names with dir="auto" and escaped', () => {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8');
    assert.match(html, /class="nm" dir="auto">\$\{esc\(x\.name\)\}/);
    assert.match(html, /fetch\('\.\/api\/edit'/);
  });
});

describe('readLedgerSources + the dashboard sections', () => {
  test('reads a data-branch folder; bad lines and newer formats are left out; absent folder = null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    assert.equal(readLedgerSources(dir, null), null);
    fs.mkdirSync(path.join(dir, 'ledger'));
    fs.writeFileSync(path.join(dir, LEDGER_FILES.holdings), JSON.stringify(LEDGER.holdings));
    fs.writeFileSync(path.join(dir, LEDGER_FILES.assets), JSON.stringify({ ...LEDGER.assets, schema: 2 }));
    fs.writeFileSync(path.join(dir, LEDGER_FILES.snapshots), LEDGER.snapshots!.map((x) => JSON.stringify(x)).join('\n') + '\n{oops\n' + JSON.stringify({ schema: 9, date: '2026-11-06', totalUsd: 1 }) + '\n');
    fs.writeFileSync(path.join(dir, TARGETS_FILE), JSON.stringify(LEDGER.targets));
    const L = readLedgerSources(dir, null)!;
    assert.equal(L.holdings!.stocks.length, 4);
    assert.equal(L.assets, null, 'a newer schema is refused');
    assert.equal(L.flows, null);
    assert.equal((L.snapshots as LedgerSnapshot[]).length, 3);
    assert.equal(L.targets!.items.length, 4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('buildDashboard: networth + growth when the ledger is there; Sheets sections unchanged; no secret shapes', () => {
    const CTX: DashboardContext = { nowMs: NOW, taxRate: 0.25, list: [], labels: { list: 'l', holdCore: 'h', holdList: 'h' }, timeZone: 'UTC', version: null };
    const d = buildDashboard({ ledger: LEDGER }, CTX);
    assert.ok(d.networth && d.growth);
    assert.ok(!d.missing.includes('networth') && !d.missing.includes('growth'));
    assert.ok(d.missing.includes('portfolio'));
    assert.equal(d.networth.items.find((x) => x.id === 's1')!.value, null, 'no portfolio rows: not priced');
    const without = buildDashboard({}, CTX);
    assert.equal(without.networth, undefined);
    assert.doesNotMatch(JSON.stringify(d), /github_pat_|sk-ant-|BEGIN [A-Z ]*PRIVATE/);
  });
});

function r2(x: number): number { return Math.round(x * 100) / 100; }

describe('net worth: ledger/prices.json (the Nightly\'s crypto prices, profile ledger.cryptoPrices)', () => {
  const s3 = (prices: LedgerSources['prices']) => buildNetWorth({ ledger: { ...LEDGER, prices }, live: LIVE, nowMs: NOW })!.items.find((x) => x.id === 's3')!;
  test('not older than holdings.json: its price wins over manualPrice (the snapshot and the screen agree)', () => {
    const x = s3({ schema: 1, date: '2026-11-05', prices: { s3: 90000 } });
    assert.deepEqual([x.value, x.source], [45000, 'nightly']);
  });
  test('older than the holdings (the owner typed since), absent, or not a price: manualPrice', () => {
    for (const p of [{ schema: 1, date: '2026-10-31', prices: { s3: 90000 } as Record<string, number> }, null, { schema: 1, date: '2026-11-05', prices: { s3: -1 } }, { schema: 1, date: '2026-11-05', prices: {} }]) {
      const x = s3(p);
      assert.deepEqual([x.value, x.source], [40000, 'manual'], JSON.stringify(p));
    }
  });
});
