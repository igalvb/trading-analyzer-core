/**
 * FL-1: the price layer -- Yahoo chart parsing, the per-ticker price
 * history tabs, the cache-first fetchYahooChart, the 3/5/10-year trailing
 * performance, and the sector-RS / SPY / VIX context attached before
 * analysis.
 *
 * Every port is compared with the oracle on the same inputs: the same
 * replayed responses (both sides must request exactly the same URLs), the
 * same pinned clock, and the same starting tab contents (the legacy side on
 * a FakeSpreadsheet, the port on MemoryPriceHistoryStore -- and the two
 * tabs must end identical too).
 *
 * The responses are SYNTHETIC, built from legacy/historical_data
 * (yahooFixtures.ts). Three findings are demonstrated, not just described:
 * F-30 (freshness vs a nightly run after the close), F-31 (a split leaves
 * the cached history unadjusted) and F-32 (a bar cached mid-session is never
 * corrected; mechanism only, premise unconfirmed).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { sheets_v4 } from 'googleapis';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeSpreadsheet, fakeSpreadsheetApp, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { BAR_TIME_UTC, yahooJson, recorded } from './yahooFixtures.ts';
import { HttpClient, ReplayTransport, ExchangeBook, type RecordedExchange } from '../src/net/http.ts';
import { priceHistoryTab } from '../src/sheets/tabs.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { createContext, type RunContext } from '../src/core/context.ts';
import type { StepError } from '../src/core/result.ts';
import { LogLevel } from '../src/core/logger.ts';
import { computeIndicators } from '../src/analysis/indicators/index.ts';
import { computeTrailingPerfSlice, computeLongRangeTrailingPerf } from '../src/analysis/indicators/slices.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import { yahooChartUrl, yahooLongRangeUrl, parseYahooChart, fetchYahooChartRaw, fetchYahooChartLongRange } from '../src/fetch/yahoo.ts';
import { fetchYahooChart } from '../src/fetch/chart.ts';
import {
  PRICE_HISTORY_HEADER, dateToSheetsSerial, sheetsSerialToDate, isPriceCacheFresh,
  MemoryPriceHistoryStore, SheetPriceHistoryStore, type PriceCell, type PriceSheetsApi,
} from '../src/storage/priceHistory.ts';
import { SECTOR_ETF, attachMarketContext } from '../src/fetch/marketContext.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const DAY = 86_400_000;

const quietCtx = (): RunContext =>
  createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

const httpOver = (exchanges: readonly RecordedExchange[]): HttpClient =>
  new HttpClient({ transport: new ReplayTransport(new ExchangeBook(exchanges)) });

/** The legacy tab's used range, six columns wide (null: no tab). */
function oracleGridOf(ss: FakeSpreadsheet, ticker: string): unknown[][] | null {
  const sh = ss.getSheetByName(priceHistoryTab(ticker));
  if (!sh) return null;
  const last = sh.getLastRow();
  const out: unknown[][] = [];
  for (let r = 1; r <= last; r++) out.push(sh.getRange(r, 1, 1, 6).getValues()[0]);
  return out;
}

interface Run {
  readonly result: any;
  readonly misses: string[];
}

function legacyChartRun(ss: FakeSpreadsheet, exchanges: readonly RecordedExchange[], nowMs: number, ticker: string): Run {
  const book = new ExchangeBook(exchanges);
  const result = withOracleGlobals(
    { SpreadsheetApp: fakeSpreadsheetApp(ss), UrlFetchApp: replayUrlFetchApp(book), Date: pinnedDateClass(nowMs) },
    () => loadOracle().callNormalized('fetchYahooChart', ticker),
  );
  return { result, misses: book.misses };
}

async function portChartRun(store: MemoryPriceHistoryStore, exchanges: readonly RecordedExchange[], nowMs: number, ticker: string): Promise<Run> {
  const book = new ExchangeBook(exchanges);
  // Legacy parity: both FL-1b fixes switched off (fl1b.chart.fixes.test.ts covers them).
  const result = await fetchYahooChart({
    http: new HttpClient({ transport: new ReplayTransport(book) }), store, clock: { now: () => nowMs }, legacyFreshness: true, legacySplitMerge: true,
  }, ticker);
  return { result: result && structuredClone(result), misses: book.misses };
}

/** The same starting tab on both sides, each written by its own writer. */
async function seedBoth(ticker: string, data: FetchedChart): Promise<{ ss: FakeSpreadsheet; store: MemoryPriceHistoryStore }> {
  const ss = new FakeSpreadsheet('raw');
  withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => loadOracle().call('writePriceCacheV7_', ticker, data));
  const store = new MemoryPriceHistoryStore();
  await store.write(ticker, data);
  return { ss, store };
}

describe('FL-1 — Yahoo parsing', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('fetchYahooChartRaw_ / fetchYahooChartLongRange_ parse identically to legacy, on every fixture and every degenerate response', async () => {
    let compared = 0;
    for (const t of listFixtures()) {
      const raw = loadRawFixture(t);
      const ticker = t === '_VIX' ? '^VIX' : t;
      const bodies = [
        yahooJson(raw),
        yahooJson(raw, { to: Math.min(40, raw.closes.length) }),
        // Provider gaps: a null close (bar dropped), null open/low/volume
        // (backfilled), a zero high and a zero open (backfilled too).
        yahooJson(raw, { mutate: (q) => { q.close[3] = null; q.open[5] = null; q.high[6] = 0; q.low[7] = null; q.volume[8] = null; q.open[9] = 0; } }),
        yahooJson(raw, { regularMarketPrice: null, currency: null, firstTradeDate: null, withSplits: false }),
        yahooJson(raw, { regularMarketPrice: 0 }),
      ];
      for (const body of bodies) {
        for (const range of ['2y', '1mo'] as const) {
          const ex = [recorded(yahooChartUrl(ticker, range), body)];
          const book = new ExchangeBook(ex);
          const legacy = withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(book) }, () => loadOracle().callNormalized('fetchYahooChartRaw_', ticker, range));
          assert.deepStrictEqual(book.misses, [], 'legacy requested exactly the URL the port builds');
          const port = await fetchYahooChartRaw(httpOver(ex), ticker, range);
          assert.deepStrictEqual(port && structuredClone(port), legacy, `${t} ${range}`);
          compared++;
        }
        const lex = [recorded(yahooLongRangeUrl(ticker), body)];
        const lbook = new ExchangeBook(lex);
        const legacyLong = withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(lbook) }, () => loadOracle().callNormalized('fetchYahooChartLongRange_', ticker));
        assert.deepStrictEqual(lbook.misses, []);
        assert.deepStrictEqual(await fetchYahooChartLongRange(httpOver(lex), ticker), legacyLong);
        compared++;
      }
    }
    assert.ok(compared > 400, `only ${compared}`);

    // Every failure mode returns null on both sides.
    const url = yahooChartUrl('AAA', '2y');
    const failures: Array<[string, number]> = [
      ['{}', 200], ['not json', 200], ['{"chart":{"result":[]}}', 200],
      ['{"chart":{"result":[{"meta":{},"timestamp":[1],"indicators":{"quote":[{"open":[null],"high":[null],"low":[null],"close":[null],"volume":[null]}]}}]}}', 200],
      ['{"chart":{"result":[{"meta":{}}]}}', 200], ['x', 404], ['x', 500],
    ];
    for (const [body, status] of failures) {
      const ex = [recorded(url, body, status)];
      const legacy = withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(new ExchangeBook(ex)) }, () => loadOracle().call('fetchYahooChartRaw_', 'AAA', '2y'));
      assert.equal(legacy, null, body);
      assert.equal(await fetchYahooChartRaw(httpOver(ex), 'AAA', '2y'), null, body);
    }
    // An unrecorded URL is a thrown fetch error inside legacy's try: null.
    assert.equal(withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(new ExchangeBook([])) }, () => loadOracle().call('fetchYahooChartRaw_', 'AAA', '2y')), null);
    assert.equal(await fetchYahooChartRaw(httpOver([]), 'AAA', '2y'), null);

    // The null-close skip and the `||` backfills, pinned (dataLayerV1.gs:311-314).
    const raw = loadRawFixture('AMD');
    const parsed = parseYahooChart(yahooJson(raw, { to: 12, mutate: (q) => { q.close[3] = null; q.open[5] = null; q.high[6] = 0; q.volume[8] = null; } }), 'AMD')!;
    assert.equal(parsed.closes.length, 11, 'the null-close bar is dropped entirely');
    assert.equal(parsed.opens[4], parsed.closes[4], 'a null open is backfilled with the close');
    assert.equal(parsed.highs[5], parsed.closes[5], 'a ZERO high is backfilled too -- `||`, not `??`');
    assert.equal(parsed.volumes[7], 0);
    assert.equal(yahooChartUrl('^VIX', '2y').includes('/%5EVIX?'), true);
  });

  test('the 3/5/10-year trailing performance now comes from the long-range closes, exactly as legacy computes it', () => {
    const oracle = loadOracle();
    let compared = 0;
    let nonNull = 0;
    for (const t of listFixtures()) {
      const raw = loadRawFixture(t);
      for (const len of [300, 1300, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        // A 10y fetch ending at the chart's last bar: up to 2,521 closes.
        const longCloses = raw.closes.slice(Math.max(0, len - 2521), len).filter((v) => v != null);
        const legacy = withOracleGlobals({ fetchYahooChartLongRange_: () => longCloses },
          () => oracle.callNormalized<any>('computeAllIndicators', chart)).trailingPerf;
        assert.deepStrictEqual(computeTrailingPerfSlice(chart, longCloses).trailingPerf, legacy, `${t}@${len}`);
        assert.deepStrictEqual(computeIndicators(chart, { longCloses }).trailingPerf, legacy, `${t}@${len} via computeIndicators`);
        // Without long closes, the slice is what it was before FL-1: all three null.
        const without = computeTrailingPerfSlice(chart).trailingPerf;
        assert.deepStrictEqual(without, computeIndicators(chart).trailingPerf);
        assert.deepStrictEqual([without?.threeYear, without?.fiveYear, without?.tenYear], [null, null, null]);
        compared++;
        if (legacy && legacy.tenYear != null) nonNull++;
      }
    }
    assert.ok(compared > 50, `only ${compared}`);
    assert.ok(nonNull > 10, 'the ten-year figure is genuinely exercised');
    const cases: number[][] = [
      [], [5], [1, 2],
      Array.from({ length: 800 }, (_, i) => 100 + i),
      Array.from({ length: 2600 }, (_, i) => (i === 2600 - 1 - 2520 ? 0 : 50 + i)),
    ];
    for (const lc of cases) {
      assert.deepStrictEqual(computeLongRangeTrailingPerf(lc), oracle.callNormalized('computeLongRangeTrailingPerf_', lc));
    }
    assert.equal(computeLongRangeTrailingPerf(cases[4])!.tenYear, null, 'a zero past close is falsy: null, not a division');
  });
});

describe('FL-1 — price storage', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('tab names, the freshness rule, and Sheets serial dates', () => {
    const oracle = loadOracle();
    for (const t of ['AAPL', '^VIX', 'BRK.B', 'DX-Y.NYB', 'A[B]*C/D\\E?F:G', 'X'.repeat(120)]) {
      assert.equal(priceHistoryTab(t), oracle.call('priceCacheSheetNameV7_', t), t);
    }
    const NOW = Date.parse('2026-10-21T22:00:00Z');
    for (const last of ['2026-10-21T13:30:00Z', '2026-10-20T13:30:00Z', '2026-10-19T13:30:00Z', '2026-10-21T23:59:59Z', '2026-10-20T00:00:00Z', '2026-10-22T13:30:00Z']) {
      const cached = { dates: [new Date('2026-01-01T13:30:00Z'), new Date(last)] } as unknown as FetchedChart;
      const legacy = withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => oracle.call('isPriceCacheFreshV7_', cached));
      assert.equal(isPriceCacheFresh(cached, new Date(NOW)), legacy, last);
    }
    assert.equal(isPriceCacheFresh(null, new Date(NOW)), false);
    // Serial anchors: serial 25569 is 1970-01-01 00:00 in the sheet's own zone.
    assert.equal(dateToSheetsSerial(new Date('1970-01-01T00:00:00Z'), 'UTC'), 25569);
    assert.equal(dateToSheetsSerial(new Date('1970-01-01T05:00:00Z'), 'America/New_York'), 25569);
    for (const tz of ['UTC', 'America/New_York', 'Asia/Jerusalem']) {
      for (let k = 0; k < 400; k++) {
        const d = new Date(Date.parse('2026-02-20T13:30:00Z') + k * 7.5 * 3600 * 1000);
        assert.equal(sheetsSerialToDate(dateToSheetsSerial(d, tz), tz).getTime(), d.getTime(), `${tz} ${d.toISOString()}`);
      }
    }
  });

  test('the port\'s store writes, appends and reads exactly what legacy writes, appends and reads', async () => {
    const oracle = loadOracle();
    for (const t of ['AMD', 'CQZA', '_VIX', 'NVDA']) {
      const raw = loadRawFixture(t);
      const ticker = t === '_VIX' ? '^VIX' : t;
      const data = parseYahooChart(yahooJson(raw, { to: Math.min(raw.closes.length, 400) }), ticker)!;
      const { ss, store } = await seedBoth(ticker, data);
      assert.deepStrictEqual(store.snapshot(ticker), oracleGridOf(ss, ticker), `${t} write`);
      const legacyRead = withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => oracle.callNormalized('readPriceCacheV7_', ticker));
      assert.deepStrictEqual(structuredClone(await store.read(ticker)), legacyRead, `${t} read`);
      const more = parseYahooChart(yahooJson(raw, { to: Math.min(raw.closes.length, 405) }), ticker)!;
      for (const n of [0, 3]) {
        withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => oracle.call('appendPriceCacheV7_', ticker, more, n));
        await store.append(ticker, more, n);
        assert.deepStrictEqual(store.snapshot(ticker), oracleGridOf(ss, ticker), `${t} append ${n}`);
      }
    }
    // Malformed rows are skipped, a broken META makes the whole tab
    // unreadable -- on both sides.
    const store = new MemoryPriceHistoryStore();
    const ss = new FakeSpreadsheet('raw');
    const tab = priceHistoryTab('ZZZ');
    const grid: PriceCell[][] = [
      ['META', '{"ticker":"ZZZ","currentPrice":5}'], [...PRICE_HISTORY_HEADER],
      ['not a date', 1, 1, 1, 1, 1], [new Date('2026-01-02T13:30:00Z'), 1, 2, 0.5, 1.5, 100],
    ];
    store.tabs.set(tab, grid.map((r) => [...r]));
    const sh = ss.insertSheet(tab);
    grid.forEach((r, i) => sh.getRange(i + 1, 1, 1, r.length).setValues([r]));
    const legacy = withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => oracle.callNormalized<any>('readPriceCacheV7_', 'ZZZ'));
    assert.deepStrictEqual(structuredClone(await store.read('ZZZ')), legacy);
    assert.equal(legacy.dates.length, 1);
    assert.equal(legacy.currency, 'USD');
    sh.getRange(1, 2).setValue('{broken');
    store.tabs.get(tab)![0][1] = '{broken';
    assert.equal(withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => oracle.call('readPriceCacheV7_', 'ZZZ')), null);
    assert.equal(await store.read('ZZZ'), null);
  });

  test('the Sheets-API store round-trips through serial dates, clears on rewrite, and appends after the last row', async () => {
    const tabs = new Map<string, { id: number; grid: unknown[][] }>();
    const formats: object[] = [];
    let nextId = 100;
    const parse = (range: string): { tab: string; row: number; col: number } => {
      const m = /^'((?:[^']|'')*)'(?:!([A-Z]+)(\d+)?(?::[A-Z]+\d*)?)?$/.exec(range)!;
      return { tab: m[1].replace(/''/g, "'"), row: m[3] ? Number(m[3]) : 1, col: m[2] ? m[2].charCodeAt(0) - 64 : 1 };
    };
    // A minimal in-memory Sheets API: tabs, values, trailing-empty-row trimming as the real API does.
    const api = {
      spreadsheets: {
        get: async () => ({ data: { sheets: [...tabs].map(([title, t]) => ({ properties: { title, sheetId: t.id } })) } }),
        batchUpdate: async (p: any) => {
          for (const r of p.requestBody.requests) {
            if (r.addSheet) tabs.set(r.addSheet.properties.title, { id: nextId++, grid: [] });
            else formats.push(r);
          }
          return { data: {} };
        },
        values: {
          batchGet: async (p: any) => ({
            data: {
              valueRanges: p.ranges.map((range: string) => {
                const g = tabs.get(parse(range).tab)!.grid;
                let last = g.length;
                while (last > 0 && !(g[last - 1] ?? []).some((c) => c !== '' && c != null)) last--;
                const colA = /!A:A$/.test(range);
                return { values: g.slice(0, last).map((r) => (colA ? [(r ?? [])[0] ?? ''] : [...(r ?? [])])) };
              }),
            },
          }),
          batchUpdate: async (p: any) => {
            let cells = 0;
            for (const d of p.requestBody.data) {
              const { tab, row, col } = parse(d.range);
              const g = tabs.get(tab)!.grid;
              d.values.forEach((r: unknown[], i: number) => {
                const target = (g[row - 1 + i] = g[row - 1 + i] ?? []);
                r.forEach((v, j) => { target[col - 1 + j] = v; cells++; });
              });
            }
            return { data: { totalUpdatedCells: cells } };
          },
          batchClear: async (p: any) => {
            for (const r of p.requestBody.ranges) tabs.get(parse(r).tab)!.grid = [];
            return { data: {} };
          },
        },
      },
    };
    const client: PriceSheetsApi = new SheetsClient({ spreadsheetId: 't', api: api as unknown as sheets_v4.Sheets, limiter: RateLimiter.perMinute(1_000_000) });
    const ctx = quietCtx();
    const errors: StepError[] = [];
    const store = new SheetPriceHistoryStore(ctx, client, 'America/New_York', (e) => errors.push(e));
    const raw = loadRawFixture('AMD');
    const data = parseYahooChart(yahooJson(raw, { to: 300 }), 'AMD')!;
    assert.equal(await store.read('AMD'), null, 'no tab, no cache');
    await store.write('AMD', data);
    const back = await store.read('AMD');
    const twin = new MemoryPriceHistoryStore();
    await twin.write('AMD', data);
    assert.deepStrictEqual(structuredClone(back), structuredClone(await twin.read('AMD')), 'same chart as the grid store reads back');
    assert.equal(back!.dates[0].getTime(), data.dates[0].getTime(), 'the exact bar instant survives the serial round trip');
    const tab = tabs.get(priceHistoryTab('AMD'))!;
    assert.equal(typeof tab.grid[2][0], 'number', 'dates are written as serial numbers, as a real date cell holds them');
    assert.ok(formats.length >= 2, 'header and date-column formatting requested');
    const more = parseYahooChart(yahooJson(raw, { to: 304 }), 'AMD')!;
    await store.append('AMD', more, 4);
    assert.equal(tab.grid.length, 306);
    assert.equal((await store.read('AMD'))!.closes.length, 304);
    // A rewrite clears first: a shorter history leaves no stale tail behind.
    await store.write('AMD', parseYahooChart(yahooJson(raw, { to: 100 }), 'AMD')!);
    assert.equal((await store.read('AMD'))!.closes.length, 100);
    assert.deepStrictEqual(errors, []);
    // A fresh store (no remembered row count) still appends after the real last row.
    const store2 = new SheetPriceHistoryStore(ctx, client, 'America/New_York');
    await store2.append('AMD', parseYahooChart(yahooJson(raw, { to: 102 }), 'AMD')!, 2);
    assert.equal((await store2.read('AMD'))!.closes.length, 102);
  });
});

describe('FL-1 — fetchYahooChart (cache-first)', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every path matches legacy: no cache, short history, fresh, incremental, no-new-bars, long gap, failed fetches', async () => {
    for (const t of ['AMD', 'NVDA', '_VIX', 'CQZA']) {
      const raw = loadRawFixture(t);
      const ticker = t === '_VIX' ? '^VIX' : t;
      const N = raw.closes.length;
      const L = N - 10;
      const lastTs = (i: number): number => Date.parse(raw.dates[i] + BAR_TIME_UTC);
      const full = (to: number): RecordedExchange => recorded(yahooChartUrl(ticker, '2y'), yahooJson(raw, { from: Math.max(0, to - 504), to }));
      const month = (to: number): RecordedExchange => recorded(yahooChartUrl(ticker, '1mo'), yahooJson(raw, { from: Math.max(0, to - 21), to }));
      const seed = parseYahooChart(yahooJson(raw, { from: Math.max(0, L - 504), to: L }), ticker)!;
      const scenarios: Array<[string, boolean, RecordedExchange[], number]> = [
        ['no cache', false, [full(L)], lastTs(L - 1) + DAY / 3],
        ['fresh: last bar today', true, [], lastTs(L - 1) + 8 * 3600 * 1000],
        ['fresh: last bar yesterday', true, [], lastTs(L - 1) + DAY + 8 * 3600 * 1000],
        ['incremental', true, [month(L + 3)], lastTs(L + 2) + 8 * 3600 * 1000],
        ['incremental, nothing new -> full', true, [month(L), full(L + 3)], lastTs(L + 2) + 3 * DAY],
        ['gap over 25 days -> full', true, [full(N)], lastTs(L - 1) + 40 * DAY],
        ['incremental 404 -> full', true, [recorded(yahooChartUrl(ticker, '1mo'), 'x', 404), full(L + 3)], lastTs(L + 2) + 3 * DAY],
        ['everything fails, stale cache NOT used', true, [recorded(yahooChartUrl(ticker, '1mo'), 'x', 500), recorded(yahooChartUrl(ticker, '2y'), 'x', 500)], lastTs(L + 2) + 3 * DAY],
      ];
      for (const [label, cached, ex, now] of scenarios) {
        const { ss, store } = cached ? await seedBoth(ticker, seed) : { ss: new FakeSpreadsheet('raw'), store: new MemoryPriceHistoryStore() };
        const legacy = legacyChartRun(ss, ex, now, ticker);
        const port = await portChartRun(store, ex, now, ticker);
        assert.deepStrictEqual(port.result, legacy.result, `${t}: ${label}`);
        assert.deepStrictEqual(port.misses, legacy.misses, `${t}: ${label} (same requests)`);
        assert.deepStrictEqual(store.snapshot(ticker), oracleGridOf(ss, ticker), `${t}: ${label} (same stored tab)`);
      }
    }
    // Under 60 bars: null, nothing stored.
    const raw = loadRawFixture('SQZB');
    const ex = [recorded(yahooChartUrl('SQZB', '2y'), yahooJson(raw))];
    const legacy = legacyChartRun(new FakeSpreadsheet('raw'), ex, Date.now(), 'SQZB');
    const store = new MemoryPriceHistoryStore();
    const port = await portChartRun(store, ex, Date.now(), 'SQZB');
    assert.equal(legacy.result, null);
    assert.equal(port.result, null);
    assert.equal(store.snapshot('SQZB'), null);
  });

  test('F-30: with a nightly run after the close, every other night analyses a cache that is one completed bar short', async () => {
    const raw = loadRawFixture('AMD');
    const N = raw.closes.length;
    // The night of day D at 22:00 UTC -- after the US close, the new cron's
    // slot. The cache was filled the previous night, so its last bar is D-1:
    // "yesterday" to isPriceCacheFreshV7_.
    const D = N - 1;
    const nightOf = (i: number): number => Date.parse(raw.dates[i] + 'T22:00:00Z');
    const seed = parseYahooChart(yahooJson(raw, { from: D - 300, to: D }), 'AMD')!;
    const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: D - 20, to: D + 1 }))];
    const { ss, store } = await seedBoth('AMD', seed);
    const legacy = legacyChartRun(ss, ex, nightOf(D), 'AMD');
    const port = await portChartRun(store, ex, nightOf(D), 'AMD');
    assert.deepStrictEqual(port.result, legacy.result);
    // Day D's completed bar exists upstream (it is in the recorded
    // response), but the cache counts as fresh and is returned as stored.
    assert.notEqual(raw.dates[D - 1], raw.dates[D]);
    assert.equal(legacy.result.dates[legacy.result.dates.length - 1].toISOString().slice(0, 10), raw.dates[D - 1]);
    assert.equal(legacy.result.closes.length, seed.closes.length, 'nothing was fetched or appended');
  });

  test('F-31: an incremental refresh after a split leaves every cached bar unadjusted, permanently', async () => {
    const raw = loadRawFixture('NVDA');
    const split = (raw.splits ?? []).find((s) => s.numerator === 10)!;
    assert.ok(split, 'the NVDA fixture carries its 10:1 split');
    const si = raw.dates.findIndex((d) => Date.parse(d + 'T00:00:00Z') >= split.date * 1000);
    // What the cache held when last written, before the split: real,
    // unadjusted prices -- ten times today's split-adjusted history.
    const preSplit = parseYahooChart(yahooJson(raw, { from: si - 300, to: si, scale: () => 10, withSplits: false }), 'NVDA')!;
    const ex = [recorded(yahooChartUrl('NVDA', '1mo'), yahooJson(raw, { from: si - 15, to: si + 4 }))];
    const now = Date.parse(raw.dates[si + 3] + 'T22:00:00Z');
    const { ss, store } = await seedBoth('NVDA', preSplit);
    const legacy = legacyChartRun(ss, ex, now, 'NVDA');
    const port = await portChartRun(store, ex, now, 'NVDA');
    assert.deepStrictEqual(port.result, legacy.result);
    assert.deepStrictEqual(store.snapshot('NVDA'), oracleGridOf(ss, 'NVDA'));
    const closes: number[] = legacy.result.closes;
    const join = closes.length - 4;
    const step = closes[join] / closes[join - 1];
    const trueStep = raw.closes[si] / raw.closes[si - 1];
    assert.ok(step < 0.15, `merged series drops ${((1 - step) * 100).toFixed(1)}% in one bar at the split`);
    assert.ok(trueStep > 0.85 && trueStep < 1.15, 'the real adjusted series has no such jump');
    assert.ok(legacy.result.splits.some((s: { numerator: number }) => s.numerator === 10), 'the split IS recorded in META -- the bars are just never re-adjusted');
    // The next incremental refresh keeps the discontinuity: history is never rewritten.
    const ex2 = [recorded(yahooChartUrl('NVDA', '1mo'), yahooJson(raw, { from: si - 10, to: si + 8 }))];
    const later = await portChartRun(store, ex2, Date.parse(raw.dates[si + 7] + 'T22:00:00Z'), 'NVDA');
    assert.ok(later.result.closes[join] / later.result.closes[join - 1] < 0.15);
  });

  test('F-32, mechanism only (premise unconfirmed): a bar cached mid-session is never replaced by its final values', async () => {
    const raw = loadRawFixture('MQZC');
    const N = raw.closes.length;
    const D = N - 3;
    // A refresh whose response carries day D's bar with an INTRADAY close
    // (2% below its final), under the same timestamp the final bar will have.
    // The premise -- that Yahoo stamps a partial bar exactly like the final
    // one -- needs a real recording. The clock is set late enough that the
    // seeded cache is not "fresh".
    const intradayClose = raw.closes[D] * 0.98;
    const seed = parseYahooChart(yahooJson(raw, { from: D - 300, to: D - 1 }), 'MQZC')!;
    const intraday = [recorded(yahooChartUrl('MQZC', '1mo'), yahooJson(raw, { from: D - 20, to: D + 1, overrideClose: { [D]: intradayClose } }))];
    const firstRun = Date.parse(raw.dates[D] + 'T15:00:00Z') + 3 * DAY;
    const { ss, store } = await seedBoth('MQZC', seed);
    legacyChartRun(ss, intraday, firstRun, 'MQZC');
    await portChartRun(store, intraday, firstRun, 'MQZC');
    // Later, after the close: the response now carries the FINAL bar for
    // day D with the same timestamp -- and it is skipped as "not new".
    const finalEx = [recorded(yahooChartUrl('MQZC', '1mo'), yahooJson(raw, { from: D - 18, to: D + 3 }))];
    const later = Date.parse(raw.dates[D + 2] + 'T22:00:00Z') + 2 * DAY;
    const legacy = legacyChartRun(ss, finalEx, later, 'MQZC');
    const port = await portChartRun(store, finalEx, later, 'MQZC');
    assert.deepStrictEqual(port.result, legacy.result);
    const dIdx = legacy.result.dates.findIndex((d: Date) => d.toISOString().slice(0, 10) === raw.dates[D]);
    assert.ok(dIdx >= 0);
    assert.equal(legacy.result.closes[dIdx], intradayClose, 'day D keeps its intraday close');
  });
});

describe('FL-1 — sector RS, SPY alignment, VIX context (runAnalysisV7 :993-1140)', { skip: ready ? false : 'legacy/ not populated' }, () => {
  /** The verbatim legacy block, compiled in the oracle's realm (the file is checksum-frozen). */
  function legacyAttachBlock(): (...a: unknown[]) => unknown {
    const lines = fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n');
    assert.equal(lines[992], '    if (fund && fund.sector) {', 'block start moved');
    assert.match(lines[1139], /VIX fetch error/, 'block end moved');
    const F = loadOracle().fns.setStatusV7.constructor as new (...a: string[]) => (...x: unknown[]) => unknown;
    return new F('chart', 'fund', 'fetchYahooChart', 'log', 'setStatusV7', 'status', lines.slice(992, 1140).join('\n') + '\nreturn chart;');
  }

  test('identical attached fields, logs and statuses on real charts, across fund, SPY and VIX outcomes', async () => {
    const run = legacyAttachBlock();
    const parsed = (t: string, to?: number): FetchedChart => parseYahooChart(yahooJson(loadRawFixture(t), to ? { to } : {}), t === '_VIX' ? '^VIX' : t)!;
    const SPY = parsed('SPY');
    const QQQ = parsed('QQQ');
    const VIX = parsed('_VIX');
    const vixNoPrice: FetchedChart = { ...VIX, currentPrice: undefined as unknown as number };
    // No fixture pair shows VIX rising while SPY is flat over 5 days, so the
    // divergence flag would never fire; synthesize both tails (probed
    // against the legacy block before being asserted).
    const tail = (c: FetchedChart, xs: number[]): FetchedChart => ({ ...c, closes: c.closes.slice(0, -xs.length).concat(xs), currentPrice: xs[xs.length - 1] });
    const vixRising = tail(VIX, [15, 16, 17, 18, 19]);
    const spyFlat = tail(SPY, [500, 500.5, 501, 500.8, 501.2]);
    const funds: Array<{ sector?: string } | null> = [null, { sector: 'Technology' }, { sector: 'Financial' }, { sector: 'Weird Sector' }, { sector: 'Energy' }, { sector: 'Healthcare' }, {}];
    const sectorCharts: Record<string, FetchedChart | null | 'throw'> = { XLK: QQQ, XLF: SPY, XLE: null, XLV: 'throw' };
    let compared = 0;
    const seen = { rs: 0, rsp: 0, div: 0, flagged: 0, course: 0, spyDegraded: 0, vixFail: 0, vixErr: 0 };
    for (const t of ['AMD', 'JPM', 'KO', 'PLTR', 'AQZB', 'CQZA', 'IBIT']) {
      const raw = loadRawFixture(t);
      for (const len of [70, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = parsed(t, len);
        const full = len === raw.closes.length;
        for (const fund of funds) {
          for (const spy of full ? [SPY, spyFlat, null] : [SPY, null]) {
            for (const vix of full ? [VIX, vixRising, null, 'throw', vixNoPrice] as const : [VIX, null, 'throw', vixNoPrice] as const) {
              const fetchOf = (tk: string): FetchedChart | null => {
                const v = tk === 'SPY' ? spy : tk === '^VIX' ? vix : sectorCharts[tk];
                if (v === 'throw') throw new Error('Exception: Request failed for ' + tk + ' (simulated network error)');
                return (v ?? null) as FetchedChart | null;
              };
              const lLog: string[] = [];
              const lStatus: unknown[] = [];
              const legacyChart = structuredClone(run({ ...chart }, fund, fetchOf, (m: string) => lLog.push(m), (_s: unknown, k: string, st: string, d: string) => lStatus.push([k, st, d]), {}));
              const pLog: string[] = [];
              const pStatus: unknown[] = [];
              const portChart = await attachMarketContext(chart, fund, {
                fetchChart: async (tk) => fetchOf(tk), log: (m) => pLog.push(m), setStatus: (k, st, d) => pStatus.push([k, st, d]),
              });
              const label = `${t}@${len} fund=${JSON.stringify(fund)} spy=${spy === spyFlat ? 'flat' : !!spy} vix=${typeof vix === 'string' ? vix : vix === vixRising ? 'rising' : !!vix}`;
              assert.deepStrictEqual(structuredClone(portChart), legacyChart, label);
              assert.deepStrictEqual(pLog, lLog, label);
              assert.deepStrictEqual(pStatus, lStatus, label);
              compared++;
              const c = legacyChart as any;
              if (c.sectorRS) seen.rs++;
              if (c.relativeSwingPower) seen.rsp++;
              if (c.vixContext?.divergence5d) seen.div++;
              if (c.vixContext?.divergence5d?.flagged) seen.flagged++;
              if (c.vixContext?.courseRead) seen.course++;
              if (lStatus.some((s: any) => s[1] === 'degraded')) seen.spyDegraded++;
              if (lLog.some((m) => m.includes('VIX fetch failed'))) seen.vixFail++;
              if (lLog.some((m) => m.includes('VIX fetch error'))) seen.vixErr++;
            }
          }
        }
      }
    }
    assert.ok(compared > 500, `only ${compared}`);
    for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} never reached`);
    // A VIX quote with no price still leaves a vixContext behind: the throw
    // comes from the log line AFTER the object is attached, and is caught.
    const odd = await attachMarketContext(parsed('AMD'), null, { fetchChart: async (tk) => (tk === '^VIX' ? vixNoPrice : SPY) });
    assert.ok(odd.vixContext, 'vixContext survives the caught toFixed throw');
  });

  test('the sector map is legacy\'s, verbatim', () => {
    const lines = fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n');
    const F = loadOracle().fns.setStatusV7.constructor as new (...a: string[]) => () => unknown;
    const legacyMap = structuredClone(new F(lines.slice(993, 999).join('\n') + '\nreturn SECTOR_ETF;')());
    assert.deepStrictEqual({ ...SECTOR_ETF }, legacyMap);
  });
});
