/**
 * The growth graph's estimated past (src/ledger/estimate.ts) and the change chips / % lines (src/ledger/networth.ts
 * changeOver, rebase; the page's copies are held equal): today's holdings x each day's close, dated lots and buy days,
 * closed positions between their days, calls flat at cost, tickers without history, the point sampling and its size,
 * and the override by real snapshots (src/dashboard/data.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildEstimate, sampleDays, stockPieces, seriesKey, neededSeries, readPriceSeries, DAILY_DAYS, WEEKLY_DAYS, ESTIMATE_LABEL, type PriceSeries } from '../src/ledger/estimate.ts';
import { changeOver, rangeStartIndex, rangeFrom, rebase, CHANGE_RANGES, type LedgerSources } from '../src/ledger/networth.ts';
import type { LedgerHoldings, LedgerStock } from '../src/ledger/schema.ts';
import { buildDashboard, type DashboardContext } from '../src/dashboard/data.ts';

const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, k: number): string => dayStr(Date.parse(d + 'T12:00:00Z') + k * 86_400_000);
/** Weekday closes from `from` to `to`: price(d) given. */
function series(from: string, to: string, price: (d: string, i: number) => number): PriceSeries {
  const dates: string[] = [], closes: number[] = [];
  for (let d = from, i = 0; d <= to; d = addDays(d, 1)) { const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w === 0 || w === 6) continue; dates.push(d); closes.push(price(d, i++)); }
  return { dates, closes };
}
const stock = (x: Partial<LedgerStock> & Pick<LedgerStock, 'id' | 'ticker' | 'qty'>): LedgerStock => ({ kind: 'stock', avgCost: 1, currency: 'USD', bought: null, ...x });
const valueOn = (E: NonNullable<ReturnType<typeof buildEstimate>>, g: 'stocks' | 'btcFunds' | 'crypto' | 'calls', d: string): number => {
  const i = E.days.indexOf(d); assert.ok(i >= 0, 'day ' + d + ' is a point'); return (E.usd[g] as number[])[i] as number;
};

const TODAY = '2026-11-06';
// Prices: AAA always 10; BBB 20 from 2024-01-11 (a listing); FND 3; ILSX 36 (an ILS holding).
const SERIES = new Map<string, PriceSeries>([
  ['AAA', series('2019-01-02', TODAY, () => 10)],
  ['BBB', series('2024-01-11', TODAY, () => 20)],
  ['FND', series('2019-01-02', TODAY, () => 3)],
  ['ILSX', series('2019-01-02', TODAY, () => 36)],
  ['ETH-USD', series('2019-01-02', TODAY, () => 2000)],
]);

describe('estimated history (today\'s holdings x each day\'s close)', () => {
  test('lots: each dated lot from its day, the undated rest from bought (else always); dates known vs assumed', () => {
    const s = stock({ id: 'a', ticker: 'AAA', qty: 10, lots: [{ date: '2022-05-02', qty: 4, price: 1 }, { date: '2021-03-01', qty: 3, price: 1 }, { date: null, qty: 1, price: 1 }] });
    assert.deepEqual(stockPieces(s), { pieces: [{ qty: 3, start: '2021-03-01' }, { qty: 4, start: '2022-05-02' }, { qty: 3, start: null }], known: 'partly' });
    assert.equal(stockPieces({ ...s, bought: '2020-06-01' }).pieces[2]!.start, '2020-06-01');
    assert.equal(stockPieces({ ...s, bought: '2020-06-01' }).known, 'dated');
    assert.equal(stockPieces(stock({ id: 'b', ticker: 'AAA', qty: 5 })).known, 'assumed');
    // Dated lots over qty are capped at qty (lots.ts flags it).
    assert.deepEqual(stockPieces(stock({ id: 'c', ticker: 'AAA', qty: 5, lots: [{ date: '2021-01-04', qty: 4, price: 1 }, { date: '2022-01-03', qty: 4, price: 1 }] })), { pieces: [{ qty: 4, start: '2021-01-04' }, { qty: 1, start: '2022-01-03' }], known: 'dated' });
  });

  test('values per day: lots, bought, listings, closed positions, calls at cost, ILS, coins, no history', () => {
    const H: LedgerHoldings = {
      schema: 1, updated: TODAY,
      stocks: [
        stock({ id: 's1', ticker: 'AAA', qty: 10, lots: [{ date: '2022-05-02', qty: 4, price: 1 }] }), // 4 from 2022-05-02, 6 always
        stock({ id: 's2', ticker: 'BBB', qty: 2, bought: '2025-01-06' }),
        stock({ id: 's3', ticker: 'BBB', qty: 1 }), // undated, but BBB starts trading 2024-01-11
        stock({ id: 's4', ticker: 'FND', kind: 'btcFund', qty: 100 }),
        stock({ id: 's5', ticker: 'ILSX', qty: 10, currency: 'ILS' }), // 360 ILS at 3.6 = 100 USD
        stock({ id: 's6', ticker: 'ETH', kind: 'crypto', qty: 0.5 }),
        stock({ id: 's7', ticker: 'NOPE', kind: 'crypto', qty: 3, bought: '2023-01-02' }), // no series: flat at today's value
      ],
      options: [{ id: 'o1', ticker: 'AAA', side: 'call', contracts: 2, strike: 15, expiry: '2027-06-17', avgPremium: 1.5, bought: '2026-02-02' }],
      closed: [
        { id: 'c1', ticker: 'AAA', kind: 'stock', qty: 5, cost: 40, proceeds: 50, currency: 'USD', bought: '2020-03-02', sold: '2023-03-01' },
        { id: 'c2', ticker: 'AAA', kind: 'call', qty: 1, strike: 9, expiry: '2024-01-19', cost: 700, proceeds: 900, currency: 'USD', bought: '2023-06-01', sold: '2023-12-01' },
        { id: 'c3', ticker: 'AAA', kind: 'stock', qty: 9, cost: 1, proceeds: 1, currency: 'USD', bought: null, sold: null }, // no sell day: left out
      ],
    };
    const E = buildEstimate({ holdings: H, series: SERIES, fx: 3.6, today: TODAY, firstReal: '2026-10-20', staticUsd: { pension: 1000 }, todayUsd: new Map([['s7', 90]]) })!;
    assert.equal(E.label, ESTIMATE_LABEL);
    assert.equal(E.days[0], '2020-01-31', 'month ends from 2020');
    assert.equal(E.days[E.days.length - 1], '2026-10-19', 'up to the day before the first real snapshot');
    assert.ok(E.days.every((d) => d < '2026-10-20'));
    assert.deepEqual(E.staticUsd, { pension: 1000 });
    assert.deepEqual(E.coverage, { dated: 3, partly: 1, assumed: 4, closed: 2, callsAtCost: 2, noHistory: ['NOPE'], flatGroups: ['calls'] });
    // 2020-06-30: AAA 6 always + closed 5 (held from 2020-03-02) = 11 x 10; ILSX 100 USD; BBB not listed; no call.
    assert.equal(valueOn(E, 'stocks', '2020-06-30'), 110 + 100);
    assert.equal(valueOn(E, 'btcFunds', '2020-06-30'), 300);
    assert.equal(valueOn(E, 'crypto', '2020-06-30'), 1000, 'the coin from its -USD series; NOPE not yet (bought 2023)');
    assert.equal(valueOn(E, 'calls', '2020-06-30'), 0);
    // 2023-06-30: AAA 6 + lot 4 (from 2022-05-02); the closed 5 sold 2023-03-01; closed call flat at cost 700.
    assert.equal(valueOn(E, 'stocks', '2023-06-30'), 100 + 100);
    assert.equal(valueOn(E, 'calls', '2023-06-30'), 700);
    assert.equal(valueOn(E, 'crypto', '2023-06-30'), 1000 + 90, 'NOPE flat at today\'s value from its buy day');
    // 2024-06-30 (a month end): BBB listed (s3 undated: 1 x 20); s2 not before 2025-01-06; closed call gone.
    assert.equal(valueOn(E, 'stocks', '2024-06-30'), 100 + 20 + 100);
    assert.equal(valueOn(E, 'calls', '2024-06-30'), 0);
    // Within the last 90 days (daily): s2 held; the open call flat at its cost (1.5 x 100 x 2) from 2026-02-02.
    assert.equal(valueOn(E, 'stocks', '2026-10-19'), 100 + 60 + 100);
    assert.equal(valueOn(E, 'calls', '2026-10-19'), 300);
  });

  test('real snapshots override from their first day; none: up to the last bar; nothing to price: null', () => {
    const H: LedgerHoldings = { schema: 1, updated: TODAY, stocks: [stock({ id: 's1', ticker: 'AAA', qty: 1 })], options: [], closed: [] };
    const none = buildEstimate({ holdings: H, series: SERIES, fx: null, today: TODAY, firstReal: null })!;
    assert.equal(none.days[none.days.length - 1], TODAY);
    assert.equal(buildEstimate({ holdings: H, series: SERIES, fx: null, today: TODAY, firstReal: '2019-06-01' }), null, 'the real snapshots cover everything');
    assert.equal(buildEstimate({ holdings: H, series: new Map(), fx: null, today: TODAY, firstReal: null }), null);
    const ils: LedgerHoldings = { ...H, stocks: [stock({ id: 'x', ticker: 'ILSX', qty: 1, currency: 'ILS' })] };
    assert.equal(buildEstimate({ holdings: ils, series: SERIES, fx: null, today: TODAY, firstReal: null }), null, 'an ILS holding needs a rate');
  });

  test('points: month ends, then Fridays within two years, then every trading day within 90 days', () => {
    const trading = SERIES.get('AAA')!.dates;
    const days = sampleDays('2020-01-01', TODAY, trading);
    const weeklyFrom = addDays(TODAY, -WEEKLY_DAYS), dailyFrom = addDays(TODAY, -DAILY_DAYS);
    assert.ok(days.every((d, i) => i === 0 || d > days[i - 1]!), 'ascending, no repeats');
    const monthly = days.filter((d) => d < weeklyFrom), weekly = days.filter((d) => d >= weeklyFrom && d < dailyFrom), daily = days.filter((d) => d >= dailyFrom);
    assert.ok(monthly.every((d) => addDays(d, 1).slice(8) === '01'), 'month ends');
    assert.equal(monthly.length, 58);
    assert.ok(weekly.every((d) => new Date(d + 'T12:00:00Z').getUTCDay() === 5), 'Fridays');
    assert.ok(weekly.length >= 90 && weekly.length <= 92);
    assert.ok(daily.every((d) => trading.includes(d)));
    assert.ok(daily.length >= 60 && daily.length <= 66);
    assert.ok(days.length < 230);
    assert.deepEqual(sampleDays('2026-11-01', '2026-11-06', ['2026-11-02', '2026-11-03']), ['2026-11-02', '2026-11-03', '2026-11-06']);
    assert.deepEqual(sampleDays('2026-11-07', '2026-11-06', []), []);
  });

  test('size: 80 holdings since 2020 stay small (well under the 400 KB page budget)', () => {
    const big = new Map<string, PriceSeries>();
    const stocks: LedgerStock[] = [];
    for (let k = 0; k < 80; k++) {
      const t = 'T' + String(k).padStart(2, '0');
      big.set(t, series('2007-01-02', TODAY, (_d, i) => 10 + k + Math.sin(i / 9) * 3 + i / 1000));
      stocks.push(stock({ id: 'x' + k, ticker: t, qty: 7 + k, kind: k % 10 === 0 ? 'btcFund' : 'stock', lots: k % 3 ? [{ date: '2023-04-03', qty: 2, price: 9 }] : undefined }));
    }
    const E = buildEstimate({ holdings: { schema: 1, updated: TODAY, stocks, options: [], closed: [] }, series: big, fx: 3.6, today: TODAY, firstReal: null })!;
    const kb = JSON.stringify(E).length / 1024;
    assert.ok(kb < 20, 'estimate ' + kb.toFixed(1) + ' KB');
  });

  test('series keys and the price files (CSV, coins as <symbol>-USD)', () => {
    assert.equal(seriesKey({ ticker: 'IBIT', kind: 'btcFund' }), 'IBIT');
    assert.equal(seriesKey({ ticker: 'BTC', kind: 'crypto' }), 'BTC-USD', 'the coin, never the fund named BTC');
    assert.equal(seriesKey({ ticker: 'X.', kind: 'crypto', priceSymbol: 'xyz' }), 'XYZ-USD');
    const H: LedgerHoldings = { schema: 1, updated: TODAY, stocks: [stock({ id: 'a', ticker: 'AAA', qty: 1 }), stock({ id: 'b', ticker: 'BTC', kind: 'crypto', qty: 1 })], options: [], closed: [{ id: 'c', ticker: 'ZZZ', kind: 'stock', qty: 1, cost: 1, proceeds: 1, currency: 'USD', bought: null, sold: '2024-01-02' }] };
    assert.deepEqual(neededSeries(H), ['AAA', 'BTC-USD', 'ZZZ']);
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'est-'));
    fs.writeFileSync(path.join(dir, 'AAA.csv'), 'Date,Open,High,Low,Close,Volume\n2024-01-02,1,1,1,5,10\n2024-01-03,1,1,1,6,10\n');
    fs.writeFileSync(path.join(dir, 'ZZZ.csv'), 'not a price file');
    const got = readPriceSeries(dir, ['AAA', 'ZZZ', 'BTC-USD']);
    assert.deepEqual([...got.keys()], ['AAA']);
    assert.deepEqual(got.get('AAA'), { dates: ['2024-01-02', '2024-01-03'], closes: [5, 6] });
    assert.equal(readPriceSeries(path.join(dir, 'nope'), ['AAA']).size, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('change chips and % lines', () => {
  const days = ['2021-11-05', '2023-11-03', '2025-11-06', '2025-12-31', '2026-01-02', '2026-10-06', '2026-10-30', '2026-11-05', '2026-11-06'];
  const vals = [100, 150, 200, 210, 220, 300, 310, 320, 330];
  test('the range start: the last point on or before it (1D the previous point, All the first)', () => {
    assert.equal(rangeFrom('2026-11-06', 'YTD'), '2025-12-31');
    assert.equal(rangeFrom('2026-11-06', '1Y'), '2025-11-06');
    assert.equal(rangeFrom('2026-11-06', '5Y'), '2021-11-06');
    assert.equal(rangeStartIndex(days, '1D'), 7);
    assert.equal(rangeStartIndex(days, '1W'), 6);
    assert.equal(rangeStartIndex(days, '1M'), 5);
    assert.equal(rangeStartIndex(days, 'YTD'), 3);
    assert.equal(rangeStartIndex(days, '1Y'), 2);
    assert.equal(rangeStartIndex(days, '3Y'), 1);
    assert.equal(rangeStartIndex(days, '5Y'), 0);
    assert.equal(rangeStartIndex(days, 'All'), 0);
    assert.equal(rangeStartIndex(['2026-11-06'], '1D'), -1);
    assert.deepEqual(CHANGE_RANGES, ['1D', '1W', '1M', 'YTD', '1Y', '3Y', '5Y', 'All']);
  });
  test('change in money and %; empty points skipped; a zero start has no %', () => {
    assert.deepEqual(changeOver(days, vals, '1D'), { i: 7, j: 8, abs: 10, pct: 3.13 });
    assert.deepEqual(changeOver(days, vals, 'YTD'), { i: 3, j: 8, abs: 120, pct: 57.14 });
    assert.deepEqual(changeOver(days, vals, 'All'), { i: 0, j: 8, abs: 230, pct: 230 });
    assert.deepEqual(changeOver(days, [null, null, 0, 5, 5, 5, 5, 5, null], 'All'), { i: 2, j: 7, abs: 5, pct: null });
    assert.deepEqual(changeOver(days, [-100, 0, 0, 0, 0, 0, 0, 0, -50], 'All'), { i: 0, j: 8, abs: 50, pct: 50 }, 'a debt shrinking is +');
    assert.equal(changeOver(days, days.map(() => null), '1M'), null);
  });
  test('rebase: % from the base; no base, no line', () => {
    assert.deepEqual(rebase([100, 110, null, 90], 100), [0, 10, null, -10]);
    assert.deepEqual(rebase([0, 5], 0), [null, null]);
    assert.deepEqual(rebase([1, 2], null), [null, null]);
  });
  test("the page's copy of the change math gives the same answers", () => {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8');
    const m = /\/\* change-math:start[^*]*\*\/([\s\S]*?)\/\* change-math:end \*\//.exec(html);
    assert.ok(m, 'markers in index.html');
    const page = new Function(m[1] + '\nreturn { CHANGE_RANGES, rangeFrom, rangeStartIndex, changeOver, rebase };')() as { CHANGE_RANGES: string[]; rangeFrom: typeof rangeFrom; rangeStartIndex: typeof rangeStartIndex; changeOver: typeof changeOver; rebase: typeof rebase };
    assert.deepEqual(page.CHANGE_RANGES, [...CHANGE_RANGES]);
    let seed = 3;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 40);
      let d = '2019-01-01';
      const ds = Array.from({ length: n }, () => (d = addDays(d, 1 + Math.floor(rnd() * 60))));
      const vs = ds.map(() => (rnd() < 0.15 ? null : rnd() < 0.05 ? 0 : Math.round((rnd() - 0.2) * 1e6) / 100));
      for (const r of [...CHANGE_RANGES, '3M']) {
        assert.deepEqual(page.rangeStartIndex(ds, r), rangeStartIndex(ds, r));
        assert.deepEqual(page.changeOver(ds, vs, r), changeOver(ds, vs, r));
        if (ds.length) assert.equal(page.rangeFrom(ds[ds.length - 1]!, r), rangeFrom(ds[ds.length - 1]!, r));
      }
      assert.deepEqual(page.rebase(vs, vs[0] ?? null), rebase(vs, vs[0] ?? null));
    }
  });
});

describe('the dashboard JSON (data.ts)', () => {
  const ctx: DashboardContext = { nowMs: Date.parse('2026-11-06T21:00:00Z'), taxRate: 0.25, list: [], labels: { list: 'l', holdCore: 'h', holdList: 'h' }, timeZone: 'America/New_York' };
  const holdings: LedgerHoldings = { schema: 1, updated: '2026-11-01', stocks: [stock({ id: 's1', ticker: 'AAA', qty: 10, manualPrice: 10 })], options: [], closed: [] };
  test('growth.estimate before the first snapshot, static groups at today\'s value; real snapshots kept as they are', () => {
    const ledger: LedgerSources = {
      holdings,
      assets: { schema: 1, updated: '2026-11-01', items: [{ id: 'a1', group: 'pension', name: 'P', value: 360, currency: 'ILS', asOf: '2026-11-01' }] },
      snapshots: [{ schema: 1, date: '2026-11-03', fxUsdIls: 3.6, usd: { stocks: 99, pension: 100 }, totalUsd: 199, totalIls: null }],
    };
    const d = buildDashboard({ ledger, priceHistory: SERIES }, ctx);
    const E = d.growth!.estimate!;
    assert.ok(E, 'an estimate');
    assert.equal(E.days[E.days.length - 1], '2026-11-02');
    assert.equal((E.usd.stocks as number[])[0], 100);
    assert.deepEqual(E.staticUsd, { pension: 100 });
    assert.deepEqual(d.growth!.snapshots.map((s) => s.date), ['2026-11-03']);
    assert.ok(JSON.stringify(d).length < 400 * 1024);
    // No price history: no estimate (the field is absent).
    assert.equal(buildDashboard({ ledger }, ctx).growth!.estimate, undefined);
  });
  test('the graph exists with the estimate alone (no snapshot, no flow yet)', () => {
    const d = buildDashboard({ ledger: { holdings }, priceHistory: SERIES }, ctx);
    assert.ok(d.growth && d.growth.estimate && d.growth.snapshots.length === 0);
    assert.ok(!d.missing.includes('growth'));
    assert.ok(buildDashboard({ ledger: { holdings } }, ctx).missing.includes('growth'));
  });
});
