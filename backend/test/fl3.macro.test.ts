/**
 * FL-3: the macro / broker-data layer -- FRED and Nasdaq fetchers, the three
 * Sheet caches, the nightly refreshes, the cache-only regime read, Dow
 * Theory confirmation and the two manual diagnostics.
 *
 * Every port is compared with the oracle on the same inputs: the same
 * replayed responses, the same pinned clock, the same starting tabs (legacy
 * on a FakeSpreadsheet, the port on MemoryTabStore -- and the tabs must end
 * identical), the same PropertiesService contents, and every Logger line.
 * The process zone is set to the script zone for each test (Apps Script's
 * toDateString/new Date() run in it) and restored afterwards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, FakeSpreadsheet, fakeSpreadsheetApp, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { fixturesPresent } from './fixtures.ts';
import { rng } from './fundamentalsFixtures.ts';
import { MACRO_SOURCES, nasdaqHistoricalBody, realFredCsv, fredCsv, monthly, shortInterestBody, recordedGet } from './macroFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { MemoryPropertyStore, cacheGet } from '../src/storage/kv.ts';
import { Tabs } from '../src/sheets/tabs.ts';
import { MemoryTabStore, SheetTabStore } from '../src/storage/tabStore.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import type { PriceSheetsApi } from '../src/storage/priceHistory.ts';
import {
  macroPriceTab, readMacroPriceCache, writeMacroPriceCache, readMacroSnapshot, writeMacroSnapshot, readBrokerDataCache, writeBrokerDataCache,
  type MacroSeries,
} from '../src/storage/macroCaches.ts';
import { fetchFredSeriesValues, fetchFredSeriesMacro, fetchM2Macro, FRED_CSV_URL } from '../src/fetch/macro/fred.ts';
import { fetchNasdaqShortInterest, fetchNasdaqShortInterestV1, fetchHistoricalOHLCV, nasdaqHistoricalUrl, parseNasdaqHistorical } from '../src/fetch/macro/nasdaq.ts';
import {
  fetchHistoricalOHLCVBatch, computeMacroSupplemental, refreshMacroRegimeCache, getCachedMacroRegime,
  fetchFMPInterestCoverage, refreshBrokerCourseDataCache, refreshMacroSnapshot,
  runMacroFetcherDiagnostics, runMacroRegimePredictiveValue, MACRO_DIAGNOSTIC_TICKERS, type MacroDeps, type MacroRegimeMemo,
} from '../src/fetch/macro/refresh.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import {
  alignSeries, pctChange, classifyMacroRegimeAt, computeDowTheoryConfirmation, dateStringInTz, MACRO_REGIME_TICKERS, DOW_THEORY_TICKERS,
} from '../src/analysis/macroRegime.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const TZ = 'America/New_York';
const END = '2026-08-21';
const NOW = Date.parse(END + 'T22:00:00Z');
const FMP_KEY = 'fl3-test-key';

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
  readonly urls: string[] = [];
  private readonly inner: HttpTransport;
  constructor(inner: HttpTransport) {
    this.inner = inner;
  }
  send(req: HttpRequest): Promise<HttpResponse> {
    this.trace.push(exchangeKey(req.method, req.url));
    this.urls.push(req.url);
    return this.inner.send(req);
  }
}

function tracingUrlFetchApp(book: ExchangeBook, trace: string[]): Record<string, unknown> {
  const inner = replayUrlFetchApp(book) as { fetch: (u: string, p?: { method?: string }) => unknown };
  return {
    fetch: (url: string, params?: { method?: string }) => { trace.push(exchangeKey(params?.method, url)); return inner.fetch(url, params); },
    fetchAll: (reqs: Array<{ url: string; method?: string }>) => reqs.map((q) => { trace.push(exchangeKey(q.method, q.url)); return inner.fetch(q.url, q); }),
  };
}

interface Env {
  readonly ss: FakeSpreadsheet;
  readonly props: FakeProperties;
  readonly store: MemoryTabStore;
  readonly kv: MemoryPropertyStore;
}

function freshEnv(): Env {
  return { ss: new FakeSpreadsheet('raw'), props: new FakeProperties(new Map(), true), store: new MemoryTabStore(), kv: new MemoryPropertyStore() };
}

/** Runs legacy with the fakes; returns its value, Logger lines and request trace. */
function legacy<T>(env: Env, ex: readonly RecordedExchange[], now: number, fn: (o: ReturnType<typeof loadOracle>) => T): { value: T; logs: string[]; trace: string[] } {
  const logs: string[] = [];
  const trace: string[] = [];
  const value = withOracleGlobals({
    SpreadsheetApp: fakeSpreadsheetApp(env.ss), PropertiesService: fakePropertiesService(env.props),
    UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now), Logger: { log: (m: unknown) => { logs.push(String(m)); } },
  }, () => fn(loadOracle()));
  return { value: structuredClone(value), logs, trace };
}

function depsFor(env: Env, ex: readonly RecordedExchange[], now: number, extra: Partial<MacroDeps> = {}): { deps: MacroDeps; logs: string[]; transport: TracingTransport } {
  const logs: string[] = [];
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  return {
    logs, transport,
    deps: { http: new HttpClient({ transport }), store: env.store, kv: env.kv, fmpKey: FMP_KEY, timeZone: TZ, clock: { now: () => now }, log: (m) => logs.push(m), legacyFreshness: true, ...extra },
  };
}

/** Every tab, both sides, cell for cell. */
function assertSameTabs(env: Env, where: string): void {
  const names = new Set<string>([...env.ss.getSheets().map((s) => s.getName()), ...env.store.tabs.keys()]);
  for (const name of names) {
    const sh = env.ss.getSheetByName(name);
    const width = 6;
    const legacyGrid = sh ? (sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), width).getValues() : []) : null;
    assert.deepStrictEqual(env.store.snapshot(name, width), legacyGrid, where + ' tab ' + name);
  }
}

function assertSameProps(env: Env, where: string): void {
  assert.deepStrictEqual([...env.kv.map].sort(), [...env.props.map].sort(), where + ' (PropertiesService)');
}

const allMacroTickers = [...MACRO_REGIME_TICKERS, ...DOW_THEORY_TICKERS];

function nasdaqExchanges(tickers: readonly string[], end: string, bars: number, tilt?: (t: string) => ((k: number, n: number) => number) | undefined, holes = false): RecordedExchange[] {
  return tickers.map((t) => recordedGet(nasdaqHistoricalUrl(t), 200, nasdaqHistoricalBody(t, { end, bars, tilt: tilt?.(t), holes })));
}

function fredExchanges(variant = 0): RecordedExchange[] {
  const m2 = monthly([2023, 1], 30, (i) => (variant === 1 && i === 17 ? '.' : 20000 + i * 35 * (variant === 2 ? -1 : 1)));
  const yc = monthly([2026, 1], 8, (i) => (variant === 1 ? -0.4 + i * 0.01 : 0.35 - i * 0.02));
  const gdpPaths: Array<(i: number) => number> = [
    (i) => 22000 + i * 50, (i) => 22000 + i * 50 - (i >= 6 ? 400 : 0), (i) => 22000 + (i < 6 ? i * 50 : 300 - (i - 5) * 60),
    (i) => 22000 + (i === 6 ? -300 : i * 40), (i) => 22000 + i * (i > 5 ? 10 : 60),
  ];
  const gdp = monthly([2024, 1], 8, gdpPaths[variant % gdpPaths.length]);
  return [
    recordedGet(FRED_CSV_URL + 'M2SL', 200, fredCsv('M2SL', m2, variant === 3 ? 'WEIRD' : 'observation_date')),
    recordedGet(FRED_CSV_URL + 'T10Y2Y', 200, fredCsv('T10Y2Y', yc)),
    recordedGet(FRED_CSV_URL + 'GDPC1', 200, fredCsv('GDPC1', gdp)),
    recordedGet(FRED_CSV_URL + 'DGS10', 200, realFredCsv('dgs10')),
    recordedGet(FRED_CSV_URL + 'FEDFUNDS', 200, realFredCsv('fedfunds')),
  ];
}

describe('FL-3 — FRED and Nasdaq fetchers', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('FRED: the three CSV readers match legacy on the real DGS10/FEDFUNDS exports and on every failure mode, logs and throws included', async () => {
    await inZone(TZ, async () => {
      const ids = ['M2SL', 'T10Y2Y', 'GDPC1', 'DGS10', 'FEDFUNDS'];
      const cases: Array<[string, RecordedExchange[]]> = [
        ['real', fredExchanges(0)], ['holes and weird header', fredExchanges(3)], ['dot values', fredExchanges(1)],
        ['404', ids.map((id) => recordedGet(FRED_CSV_URL + id, 404, 'nope'))],
        ['empty bodies', ids.map((id) => recordedGet(FRED_CSV_URL + id, 200, ''))],
        ['short rows', ids.map((id) => recordedGet(FRED_CSV_URL + id, 200, 'observation_date,' + id + '\nonly\n2026-01-01,1.5\r\n2026-02-01,abc\n'))],
        ['unrecorded', []],
      ];
      const settle = async (f: () => Promise<unknown>): Promise<unknown> => { try { return { ok: structuredClone(await f()) }; } catch (e) { return { threw: (e as Error).message }; } };
      const settleSync = (f: () => unknown): unknown => { try { return { ok: structuredClone(f()) }; } catch (e) { return { threw: (e as Error).message }; } };
      for (const [label, ex] of cases) {
        for (const id of ids) {
          const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetchFredSeriesV1', id));
          const { deps, transport } = depsFor(freshEnv(), ex, NOW);
          assert.deepStrictEqual(await fetchFredSeriesValues(deps.http, id), L.value, label + ' ' + id);
          assert.deepStrictEqual(transport.trace, L.trace);
          const L2 = legacy(freshEnv(), ex, NOW, (o) => settleSync(() => o.call('fetchFredSeries_Macro', id)));
          const P2 = depsFor(freshEnv(), ex, NOW);
          assert.deepStrictEqual(await settle(() => fetchFredSeriesMacro(P2.deps.http, id, P2.deps.log!)), L2.value, label + ' macro ' + id);
          assert.deepStrictEqual(P2.logs, L2.logs);
        }
        const L3 = legacy(freshEnv(), ex, NOW, (o) => settleSync(() => o.call('fetchM2_Macro')));
        const P3 = depsFor(freshEnv(), ex, NOW);
        assert.deepStrictEqual(await settle(() => fetchM2Macro(P3.deps.http, P3.deps.log!)), L3.value, label + ' M2');
        assert.deepStrictEqual(P3.logs, L3.logs);
      }
    });
  });

  test('Nasdaq short interest (both readers) and FMP interest coverage match legacy', async () => {
    const variants: Array<[string, number, string]> = [
      ['ok', 200, shortInterestBody('ok')], ['empty', 200, shortInterestBody('empty')], ['no interest', 200, shortInterestBody('noInterest')],
      ['number interest throws', 200, shortInterestBody('numberInterest')], ['403', 403, 'blocked'], ['bad json', 200, '{x'], ['unrecorded', 0, ''],
    ];
    for (const ticker of ['AMD', 'BRK.B', '^VIX']) {
      for (const [label, status, body] of variants) {
        const url = 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/short-interest?assetclass=stocks';
        const ex = status ? [recordedGet(url, status, body)] : [];
        for (const [name, port] of [['fetchNasdaqShortInterestV7', fetchNasdaqShortInterest], ['fetchNasdaqShortInterestV1', fetchNasdaqShortInterestV1]] as const) {
          const L = legacy(freshEnv(), ex, NOW, (o) => o.call(name, ticker));
          const { deps, transport } = depsFor(freshEnv(), ex, NOW);
          assert.deepStrictEqual(structuredClone(await port(deps.http, ticker)), L.value, ticker + ' ' + label + ' ' + name);
          assert.deepStrictEqual(transport.trace, L.trace);
        }
      }
      const fmpCases: Array<[string, number, string]> = [['ok', 200, '[{"interestCoverageRatioTTM":12.5}]'], ['zero', 200, '[{"interestCoverageRatioTTM":0}]'], ['missing', 200, '[{}]'], ['empty', 200, '[]'], ['object', 200, '{}'], ['402', 402, ''], ['bad', 200, 'x']];
      for (const [label, status, body] of fmpCases) {
        const ex = [recordedGet('https://financialmodelingprep.com/stable/ratios-ttm?symbol=' + ticker + '&apikey=K', status, body)];
        const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetchFMPInterestCoverageV1', ticker));
        const { deps, transport } = depsFor(freshEnv(), ex, NOW);
        assert.equal(await fetchFMPInterestCoverage(deps, ticker), L.value, ticker + ' ' + label);
        assert.ok(transport.urls.every((u) => u.includes('apikey=' + FMP_KEY)), 'the injected key reaches the URL');
      }
    }
  });

  test('Nasdaq history: parse and fetch match legacy (values, oldest-first order, skipped rows, every log line)', async () => {
    await inZone(TZ, async () => {
      for (const t of ['SPY', 'TLT', 'IYT']) {
        const bodies: Array<[string, number, string]> = [
          ['ok', 200, nasdaqHistoricalBody(t, { end: END, bars: 300 })], ['holes', 200, nasdaqHistoricalBody(t, { end: END, bars: 300, holes: true })],
          ['no rows', 200, JSON.stringify({ data: { tradesTable: { rows: [] } } })], ['no data', 200, JSON.stringify({ data: null })],
          ['bad json', 200, '{oops'], ['500', 500, ''], ['all unparseable', 200, JSON.stringify({ data: { tradesTable: { rows: [{ date: '01/02/2026', close: 'x', high: 'y', low: 'z', volume: '1' }] } } })],
          ['row without date throws', 200, JSON.stringify({ data: { tradesTable: { rows: [{ close: '1' }] } } })],
        ];
        for (const [label, status, body] of bodies) {
          const ex = [recordedGet(nasdaqHistoricalUrl(t), status, body)];
          const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetchHistoricalOHLCV_Macro', t));
          const P = depsFor(freshEnv(), ex, NOW);
          assert.deepStrictEqual(structuredClone(await fetchHistoricalOHLCV(P.deps.http, t, P.deps.log!)), L.value, t + ' ' + label);
          assert.deepStrictEqual(P.logs, L.logs, t + ' ' + label + ' (logs)');
          assert.deepStrictEqual(P.transport.trace, L.trace);
        }
      }
      const series = parseNasdaqHistorical('SPY', 200, nasdaqHistoricalBody('SPY', { end: END, bars: 5 }), () => {})!;
      assert.equal(series.dates[4].toISOString(), END + 'T00:00:00.000Z', 'oldest first, dated at UTC midnight');
    });
  });
});

describe('FL-3 — the three Sheet caches', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('macro price, macro snapshot and broker data: the port writes and reads exactly what legacy writes and reads', async () => {
    await inZone(TZ, async () => {
      const env = freshEnv();
      const spy = parseNasdaqHistorical('SPY', 200, nasdaqHistoricalBody('SPY', { end: END, bars: 60 }), () => {})!;
      const short: MacroSeries = { ...spy, dates: spy.dates.slice(0, 10), closes: spy.closes.slice(0, 10), highs: spy.highs.slice(0, 10), lows: spy.lows.slice(0, 10), volumes: spy.volumes.slice(0, 10) };
      for (const [t, data] of [['SPY', spy], ['A[B]*C', { ...spy, ticker: 'A[B]*C' }], ['SPY', short]] as Array<[string, MacroSeries]>) {
        legacy(env, [], NOW, (o) => o.call('writeMacroPriceCache_', t, data));
        await writeMacroPriceCache(env.store, t, data);
        assertSameTabs(env, 'write ' + t);
        assert.equal(macroPriceTab(t), loadOracle().call('macroPriceCacheSheetName_', t));
        assert.deepStrictEqual(structuredClone(await readMacroPriceCache(env.store, t)), legacy(env, [], NOW, (o) => o.call('readMacroPriceCache_', t)).value);
      }
      assert.equal(await readMacroPriceCache(env.store, 'NOPE'), null);
      // Snapshot: written twice (the header once), then read fresh and stale.
      for (const at of [NOW, NOW + 86400000]) {
        legacy(env, [], at, (o) => o.call('writeMacroSnapshotV1_', [4.1, 4.2], null, [1, 2, 3]));
        await writeMacroSnapshot(env.store, new Date(at), [4.1, 4.2], null, [1, 2, 3]);
        assertSameTabs(env, 'snapshot ' + at);
      }
      for (const at of [NOW + 2 * 86400000, NOW + 6.5 * 86400000]) {
        assert.deepStrictEqual(structuredClone(await readMacroSnapshot(env.store, at)), legacy(env, [], at, (o) => o.call('readMacroSnapshotV1_')).value, 'snapshot read ' + at);
      }
      // Broker data: insert, a second ticker, a case-insensitive upsert, stale reads.
      const writes: Array<[string, Record<string, unknown>, number]> = [
        ['amd', { shortInterest: 100, daysToCover: 2.5, settlementDate: '09/30/2026', interestCoverageRatio: null }, NOW],
        ['KO', { shortInterest: null, daysToCover: null, settlementDate: null, interestCoverageRatio: 7.5 }, NOW],
        ['AMD', { shortInterest: 0, daysToCover: 0, settlementDate: '', interestCoverageRatio: 0 }, NOW + 3600000],
      ];
      for (const [t, d, at] of writes) {
        legacy(env, [], at, (o) => o.call('writeBrokerDataCacheV1_', t, d));
        await writeBrokerDataCache(env.store, t, d as never, new Date(at));
        assertSameTabs(env, 'broker write ' + t);
      }
      for (const [t, at] of [['AMD', NOW], ['ko', NOW + 4 * 86400000], ['KO', NOW + 6 * 86400000], ['ZZZ', NOW]] as Array<[string, number]>) {
        assert.deepStrictEqual(structuredClone(await readBrokerDataCache(env.store, t, at)), legacy(env, [], at, (o) => o.call('readBrokerDataCacheV1_', t)).value, 'broker read ' + t);
      }
      // A settlement Date cell (what a real Sheet makes of the string) reads back as yyyy-mm-dd.
      await env.store.write(Tabs.BROKER_DATA_HISTORY, 2, [['AMD', new Date(NOW), 1, 1, new Date('2026-09-30T04:00:00Z'), 1]]);
      assert.equal((await readBrokerDataCache(env.store, 'AMD', NOW))!.settlementDate, '2026-09-30');
    });
  });

  test('the Sheets-API tab store round-trips dates through serials in the spreadsheet zone and keeps numbers as numbers', async () => {
    const tabs = new Map<string, { id: number; grid: unknown[][] }>();
    let nextId = 7;
    const parse = (range: string): { tab: string; row: number } => {
      const m = /^'((?:[^']|'')*)'(?:!([A-Z]+)(\d+)?(?::[A-Z]+\d*)?)?$/.exec(range)!;
      return { tab: m[1].replace(/''/g, "'"), row: m[3] ? Number(m[3]) : 1 };
    };
    const api = {
      spreadsheets: {
        get: async () => ({ data: { sheets: [...tabs].map(([title, t]) => ({ properties: { title, sheetId: t.id } })) } }),
        batchUpdate: async (p: any) => { for (const r of p.requestBody.requests) if (r.addSheet) tabs.set(r.addSheet.properties.title, { id: nextId++, grid: [] }); return { data: {} }; },
        values: {
          batchGet: async (p: any) => ({ data: { valueRanges: p.ranges.map((r: string) => { const g = tabs.get(parse(r).tab)!.grid; let last = g.length; while (last > 0 && !(g[last - 1] ?? []).some((c) => c !== '' && c != null)) last--; return { values: g.slice(0, last).map((x) => [...(x ?? [])]) }; }) } }),
          batchUpdate: async (p: any) => { for (const d of p.requestBody.data) { const { tab, row } = parse(d.range); const g = tabs.get(tab)!.grid; d.values.forEach((r: unknown[], i: number) => { g[row - 1 + i] = [...r]; }); } return { data: { totalUpdatedCells: 1 } }; },
          batchClear: async (p: any) => { for (const r of p.requestBody.ranges) tabs.get(parse(r).tab)!.grid = []; return { data: {} }; },
        },
      },
    };
    const ctx = createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });
    const client: PriceSheetsApi = new SheetsClient({ spreadsheetId: 't', api: api as never, limiter: RateLimiter.perMinute(1_000_000) });
    const store = new SheetTabStore(ctx, client, 'Asia/Jerusalem');
    const twin = new MemoryTabStore();
    const spy = parseNasdaqHistorical('SPY', 200, nasdaqHistoricalBody('SPY', { end: END, bars: 40 }), () => {})!;
    for (const s of [store, twin]) {
      await writeMacroPriceCache(s, 'SPY', spy);
      await writeMacroSnapshot(s, new Date(NOW), [1], [2], null);
      await writeBrokerDataCache(s, 'AMD', { shortInterest: 5, daysToCover: 1.5, settlementDate: '09/30/2026', interestCoverageRatio: 3 }, new Date(NOW));
    }
    assert.deepStrictEqual(structuredClone(await readMacroPriceCache(store, 'SPY')), structuredClone(await readMacroPriceCache(twin, 'SPY')));
    assert.deepStrictEqual(structuredClone(await readMacroSnapshot(store, NOW)), structuredClone(await readMacroSnapshot(twin, NOW)));
    assert.deepStrictEqual(structuredClone(await readBrokerDataCache(store, 'AMD', NOW)), structuredClone(await readBrokerDataCache(twin, 'AMD', NOW)));
    assert.equal(typeof tabs.get(macroPriceTab('SPY'))!.grid[1][0], 'number', 'a date is stored as a serial');
    assert.equal(tabs.get(Tabs.BROKER_DATA_HISTORY)!.grid[1][4], '09/30/2026', 'a date-like string stays a string (RAW)');
  });
});

describe('FL-3 — refreshes and the cache-only regime read', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('refreshMacroRegimeCacheV1: batch fetch, caches, supplemental and Dow Theory -- identical tabs, properties and logs, across fresh/stale/failure states', async () => {
    await inZone(TZ, async () => {
      const seedCache = async (env: Env, t: string, end: string, bars: number): Promise<void> => {
        const d = parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end, bars }), () => {})!;
        legacy(env, [], NOW, (o) => o.call('writeMacroPriceCache_', t, d));
        await writeMacroPriceCache(env.store, t, d);
      };
      const scenarios: Array<[string, (env: Env) => Promise<void>, RecordedExchange[]]> = [
        ['empty caches, everything fetched', async () => {}, [...nasdaqExchanges(allMacroTickers, END, 400), ...fredExchanges(0)]],
        ['some caches already fresh', async (env) => { for (const t of ['SPY', 'TLT', 'DIA']) await seedCache(env, t, END, 400); }, [...nasdaqExchanges(allMacroTickers, END, 400), ...fredExchanges(1)]],
        ['stale caches, one ticker unrecorded -> sequential fallback', async (env) => { await seedCache(env, 'GLD', '2026-07-01', 300); }, [...nasdaqExchanges(allMacroTickers.filter((t) => t !== 'XLB'), END, 400), ...fredExchanges(2)]],
        ['Nasdaq 403 for one, bad JSON for another, FRED down', async () => {}, [
          ...nasdaqExchanges(allMacroTickers.filter((t) => t !== 'XLU' && t !== 'IYT'), END, 400),
          recordedGet(nasdaqHistoricalUrl('XLU'), 403, ''), recordedGet(nasdaqHistoricalUrl('IYT'), 200, '{bad'),
          ...['M2SL', 'T10Y2Y', 'GDPC1'].map((id) => recordedGet(FRED_CSV_URL + id, 503, '')),
        ]],
        ['too little history for Dow Theory', async () => {}, [...nasdaqExchanges(allMacroTickers, END, 200), ...fredExchanges(4)]],
      ];
      for (const [label, seed, ex] of scenarios) {
        const env = freshEnv();
        await seed(env);
        const L = legacy(env, ex, NOW, (o) => o.call('refreshMacroRegimeCacheV1'));
        const P = depsFor(env, ex, NOW);
        await refreshMacroRegimeCache(P.deps);
        assert.deepStrictEqual(P.logs, L.logs, label + ' (logs)');
        assertSameTabs(env, label);
        assertSameProps(env, label);
        // In the fallback case legacy's fake fetchAll stops at the failing request; the port's concurrent batch issues them all.
        if (!label.includes('fallback')) assert.deepStrictEqual(P.transport.trace, L.trace, label + ' (requests)');
      }
    });
  });

  test('getCachedMacroRegime_: RISK_ON / RISK_OFF / unavailable, with supplemental, Dow Theory and evaluative index attached, computed once per run', async () => {
    await inZone(TZ, async () => {
      const seen: Record<string, number> = {};
      const r = rng(31);
      for (let k = 0; k < 40; k++) {
        const env = freshEnv();
        const end = ['2026-08-21', '2026-06-30', '2025-12-31', '2024-03-15', '2020-03-20', '2022-06-17'][k % 6];
        const now = Date.parse(end + 'T22:00:00Z') + (k % 7 === 3 ? 3 * 86400000 : 0);
        const tilts: Record<string, number> = Object.fromEntries(allMacroTickers.map((t) => [t, (r() - 0.5) * 0.3]));
        const fill = [...nasdaqExchanges(allMacroTickers, end, 300, (t) => (kk, n) => 1 + tilts[t] * (kk / n)), ...fredExchanges(k % 5)];
        // Fill both sides' caches with their own refresh, from the same responses.
        legacy(env, fill, now, (o) => o.call('refreshMacroRegimeCacheV1'));
        await refreshMacroRegimeCache(depsFor(env, fill, now).deps);
        if (k % 5 === 0) {
          legacy(env, [], now, (o) => o.call('cacheSet', 'evaluativeIndexV1', { pctStrong: 50, strong: 1, weak: 1, unavailable: 0, read: 'x' }, 30));
          env.kv.map.set('evaluativeIndexV1', env.props.map.get('evaluativeIndexV1')!);
        }
        loadOracle().setGlobal('_macroRegimeCache', null);
        const L = legacy(env, [], now, (o) => o.call('getCachedMacroRegime_'));
        const P = depsFor(env, [], now, { getEvaluativeIndex: () => cacheGet(env.kv, 'evaluativeIndexV1', now) });
        const memo: MacroRegimeMemo = { value: null };
        const port = structuredClone(await getCachedMacroRegime(P.deps, memo));
        assert.deepStrictEqual(port, L.value, end + ' k=' + k);
        assert.deepStrictEqual(P.logs, L.logs);
        assert.strictEqual(await getCachedMacroRegime(P.deps, memo), memo.value, 'memoised: the second call returns the same object');
        assert.equal(P.logs.length, L.logs.length, 'and logs nothing more');
        const v = L.value as { available: boolean; regime?: string };
        seen[v.available ? String(v.regime) : 'unavailable'] = 1;
      }
      loadOracle().setGlobal('_macroRegimeCache', null);
      for (const k of ['RISK_ON', 'RISK_OFF', 'unavailable']) assert.ok(seen[k], 'never reached: ' + k + ' ' + JSON.stringify(seen));
    });
  });

  test('refreshBrokerCourseDataCacheV1_ and refreshMacroSnapshotV1_: fresh rows left alone, partial data written, total failure not written', async () => {
    await inZone(TZ, async () => {
      const si = (t: string): string => 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(t) + '/short-interest?assetclass=stocks';
      const ic = (t: string): string => 'https://financialmodelingprep.com/stable/ratios-ttm?symbol=' + t + '&apikey=K';
      const env = freshEnv();
      const steps: Array<[string, string, RecordedExchange[], number]> = [
        ['both ok', 'AMD', [recordedGet(si('AMD'), 200, shortInterestBody('ok')), recordedGet(ic('AMD'), 200, '[{"interestCoverageRatioTTM":4.2}]')], NOW],
        ['fresh: nothing fetched', 'amd', [], NOW + 86400000],
        ['only FMP', 'KO', [recordedGet(si('KO'), 403, ''), recordedGet(ic('KO'), 200, '[{"interestCoverageRatioTTM":9}]')], NOW],
        ['both fail: not written', 'MQZC', [recordedGet(si('MQZC'), 500, ''), recordedGet(ic('MQZC'), 500, '')], NOW],
        ['stale: refetched and upserted', 'AMD', [recordedGet(si('AMD'), 200, shortInterestBody('empty')), recordedGet(ic('AMD'), 200, '[{"interestCoverageRatioTTM":1}]')], NOW + 6 * 86400000],
      ];
      for (const [label, t, ex, at] of steps) {
        const lLogs: string[] = [];
        legacy(env, ex, at, (o) => o.call('refreshBrokerCourseDataCacheV1_', t, (m: string) => lLogs.push(m)));
        const P = depsFor(env, ex, at);
        const pLogs: string[] = [];
        await refreshBrokerCourseDataCache(P.deps, t, (m) => pLogs.push(m));
        assert.deepStrictEqual(pLogs, lLogs, label);
        assertSameTabs(env, label);
      }
      const snapSteps: Array<[string, RecordedExchange[], number]> = [
        ['all ok (real DGS10/FEDFUNDS)', fredExchanges(0), NOW],
        ['fresh: nothing fetched', [], NOW + 86400000],
        ['stale, all down: not written', ['DGS10', 'FEDFUNDS', 'GDPC1'].map((id) => recordedGet(FRED_CSV_URL + id, 500, '')), NOW + 7 * 86400000],
        ['stale, partial', [recordedGet(FRED_CSV_URL + 'DGS10', 500, ''), recordedGet(FRED_CSV_URL + 'FEDFUNDS', 200, realFredCsv('fedfunds')), recordedGet(FRED_CSV_URL + 'GDPC1', 404, '')], NOW + 7 * 86400000],
      ];
      for (const [label, ex, at] of snapSteps) {
        const lLogs: string[] = [];
        legacy(env, ex, at, (o) => o.call('refreshMacroSnapshotV1_', (m: string) => lLogs.push(m)));
        const P = depsFor(env, ex, at);
        const pLogs: string[] = [];
        await refreshMacroSnapshot(P.deps, (m) => pLogs.push(m));
        assert.deepStrictEqual(pLogs, lLogs, label);
        assertSameTabs(env, label);
      }
    });
  });

  test('F-43: the completed-session freshness rule on the macro caches -- after the close a cache holding yesterday\'s bar is refreshed; legacy keeps it', async () => {
    await inZone(TZ, async () => {
      const prevDay = '2026-08-20';
      const requests = async (legacyFreshness: boolean): Promise<string[]> => {
        const env = freshEnv();
        for (const t of MACRO_REGIME_TICKERS) {
          await writeMacroPriceCache(env.store, t, parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end: prevDay, bars: 100 }), () => {})!);
        }
        const P = depsFor(env, nasdaqExchanges(MACRO_REGIME_TICKERS, END, 100), NOW, { legacyFreshness });
        await fetchHistoricalOHLCVBatch(P.deps, MACRO_REGIME_TICKERS);
        return P.transport.trace;
      };
      assert.deepStrictEqual(await requests(true), [], 'legacy: "yesterday" counts as fresh at 22:00 UTC');
      assert.equal((await requests(false)).length, 9, 'fixed: all nine refreshed');
      // And a Nasdaq bar dated at UTC midnight counts as its own session date (not the previous NY day).
      const env = freshEnv();
      for (const t of MACRO_REGIME_TICKERS) await writeMacroPriceCache(env.store, t, parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end: END, bars: 100 }), () => {})!);
      const P = depsFor(env, [], NOW, { legacyFreshness: false });
      assert.equal((await getCachedMacroRegime(P.deps)).available !== undefined, true);
      assert.deepStrictEqual(P.transport.trace, []);
      assert.ok(!P.logs.some((l) => l.includes('stale/missing')), 'today\'s Nasdaq bar is fresh after the close');
    });
  });
});

describe('FL-3 — regime math, Dow Theory, diagnostics', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('alignSeries / pctChange / classifyMacroRegimeAt match legacy on shifted, gapped baskets in two zones', async () => {
    const r = rng(8);
    const seen: Record<string, number> = {};
    for (const tz of ['America/New_York', 'Asia/Jerusalem']) {
      await inZone(tz, async () => {
        for (let k = 0; k < 30; k++) {
          const end = ['2026-08-21', '2023-10-27', '2020-03-23', '2018-12-24', '2015-08-24'][k % 5];
          const map: Record<string, MacroSeries> = {};
          for (const t of MACRO_REGIME_TICKERS) {
            map[t] = parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end, bars: 120, tilt: (kk, n) => 1 + (r() - 0.5) * 0.02 + (kk / n) * (r() - 0.5) * 0.4, holes: r() < 0.3 }), () => {})!;
          }
          const legacyAligned = loadOracle().callNormalized<any>('alignSeries_Macro', map);
          const aligned = alignSeries(map, tz);
          assert.deepStrictEqual(structuredClone(aligned), legacyAligned, tz + ' ' + end);
          assert.equal(aligned._dates[0], map.SPY.dates[0].toDateString(), 'toDateString in the script zone');
          for (const idx of [0, 19, 20, 60, aligned._dates.length - 1]) {
            for (const lb of [1, 20, 200]) {
              const l = loadOracle().call('classifyMacroRegimeAt_Macro', legacyAligned, idx, lb);
              assert.equal(classifyMacroRegimeAt(aligned, idx, lb), l);
              assert.equal(pctChange(aligned.SPY, idx, lb), loadOracle().call('pctChange_Macro', legacyAligned.SPY, idx, lb));
              seen[String(l)] = 1;
            }
          }
        }
      });
    }
    for (const k of ['RISK_ON', 'RISK_OFF', 'null']) assert.ok(seen[k], 'never reached: ' + k);
    assert.equal(seen.NEUTRAL, undefined, 'F-44: three binary votes never tie');
    assert.equal(dateStringInTz(new Date(NaN), TZ), 'Invalid Date');
  });

  test('computeDowTheoryConfirmationV1_: every verdict, the lag, and the needs-a-year rule match legacy', async () => {
    await inZone(TZ, async () => {
      const seen: Record<string, number> = {};
      const base = (t: string, end: string, bars: number, tilt?: (k: number, n: number) => number): MacroSeries =>
        parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end, bars, tilt }), () => {})!;
      const up = (k: number, n: number): number => (k > n - 30 ? 1 + (k - (n - 30)) * 0.02 : 1);
      const down = (k: number, n: number): number => (k > n - 30 ? 1 - (k - (n - 30)) * 0.02 : 1);
      // Hand-built series: no new extreme in the last 42 bars, and a fresh low.
      const mk = (t: string, f: (i: number) => number): MacroSeries => {
        const closes = Array.from({ length: 300 }, (_, i) => f(i));
        return { ticker: t, dates: closes.map((_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000)), closes, highs: closes, lows: closes, volumes: closes.map(() => 0) };
      };
      const quiet = (i: number): number => 100 + 20 * Math.sin(i / 15) * (i < 200 ? 1 : 0.1);
      const sinking = (i: number): number => (i < 260 ? quiet(i) : 70 - (i - 260));
      const cases: Array<[MacroSeries | null, MacroSeries | null]> = [
        [base('DIA', END, 400, up), base('IYT', END, 400, up)],
        [base('DIA', END, 400, down), base('IYT', END, 400, down)],
        [base('DIA', END, 400, up), mk('IYT', quiet)],
        [mk('DIA', sinking), mk('IYT', quiet)],
        [mk('DIA', quiet), mk('IYT', quiet)],
        [base('DIA', END, 200), base('IYT', END, 400)],
        [null, base('IYT', END, 400)],
      ];
      for (const end of ['2026-08-21', '2021-11-08', '2020-03-23', '2022-10-12', '2017-06-30']) cases.push([base('DIA', end, 300), base('IYT', end, 300)]);
      for (const [dia, iyt] of cases) {
        const l = withOracleGlobals({ readMacroPriceCache_: (t: string) => (t === 'DIA' ? dia : iyt) }, () => loadOracle().callNormalized<any>('computeDowTheoryConfirmationV1_'));
        assert.deepStrictEqual(structuredClone(computeDowTheoryConfirmation(dia, iyt)), l);
        seen[String(l.verdict)] = 1;
      }
      for (const v of ['BULL_CONFIRMED', 'BEAR_CONFIRMED', 'NON_CONFIRMATION_BULL', 'NON_CONFIRMATION_BEAR', 'NEUTRAL', 'null']) assert.ok(seen[v], 'never reached: ' + v + ' ' + JSON.stringify(seen));
    });
  });

  test('computeMacroSupplementalV1_ and the two diagnostics match legacy, logs included', async () => {
    await inZone(TZ, async () => {
      for (let v = 0; v < 6; v++) {
        const ex = v === 5 ? [] : fredExchanges(v);
        const L = legacy(freshEnv(), ex, NOW, (o) => o.call('computeMacroSupplementalV1_'));
        const P = depsFor(freshEnv(), ex, NOW);
        assert.deepStrictEqual(structuredClone(await computeMacroSupplemental(P.deps)), L.value, 'variant ' + v);
        assert.deepStrictEqual(P.logs, L.logs, 'variant ' + v + ' (logs)');
      }
      const diagEx = [
        ...Object.values(MACRO_DIAGNOSTIC_TICKERS).filter((t) => MACRO_SOURCES[t]).map((t) => recordedGet(nasdaqHistoricalUrl(t), 200, nasdaqHistoricalBody(t, { end: END, bars: 50 }))),
        recordedGet(nasdaqHistoricalUrl('GC=F'), 404, ''),
        ...fredExchanges(0),
      ];
      const L1 = legacy(freshEnv(), diagEx, NOW, (o) => o.call('testMacroFetchers'));
      const P1 = depsFor(freshEnv(), diagEx, NOW);
      await runMacroFetcherDiagnostics(P1.deps);
      assert.deepStrictEqual(P1.logs, L1.logs);
      assert.deepStrictEqual(P1.transport.trace, L1.trace);
      for (const ex of [nasdaqExchanges(MACRO_REGIME_TICKERS, END, 900), nasdaqExchanges(MACRO_REGIME_TICKERS.filter((t) => t !== 'XLV'), END, 900)]) {
        const L2 = legacy(freshEnv(), ex, NOW, (o) => o.call('testMacroRegimePredictiveValue'));
        const P2 = depsFor(freshEnv(), ex, NOW);
        await runMacroRegimePredictiveValue(P2.deps);
        assert.deepStrictEqual(P2.logs, L2.logs);
      }
    });
  });
});
