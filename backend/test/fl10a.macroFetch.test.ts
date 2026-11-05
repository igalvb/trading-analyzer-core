/**
 * FL-10a: direct legacy-vs-port tests for the macro fetch layer functions that
 * were only covered through their parents (refreshMacroRegimeCacheV1,
 * fetchHistoricalOHLCV_Macro, getCachedMacroRegime_):
 *   parseNasdaqHistoricalResponse_Macro, nasdaqHistoricalUrl_Macro_,
 *   fetchHistoricalOHLCV_MacroBatch, getCachedMacroSupplementalV1_,
 *   getCachedDowTheoryConfirmationV1_.
 *
 * Harness copied from fl3.macro.test.ts: legacy on a FakeSpreadsheet and
 * FakeProperties, port on MemoryTabStore and MemoryPropertyStore, same replayed
 * responses, same pinned clock; tabs, properties and Logger lines compared.
 * In the sequential-fallback scenario the request trace is not compared (the
 * port issues the batch concurrently; documented in fl3).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, FakeSpreadsheet, fakeSpreadsheetApp, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { fixturesPresent } from './fixtures.ts';
import { nasdaqHistoricalBody, recordedGet } from './macroFixtures.ts';
import { HttpClient, ReplayTransport, ExchangeBook, exchangeKey, type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { writeMacroPriceCache } from '../src/storage/macroCaches.ts';
import { nasdaqHistoricalUrl, parseNasdaqHistorical } from '../src/fetch/macro/nasdaq.ts';
import { fetchHistoricalOHLCVBatch, getCachedMacroSupplemental, getCachedDowTheoryConfirmation, type MacroDeps } from '../src/fetch/macro/refresh.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const skip = ready ? false : 'legacy/ or fixtures not populated';
const TZ = 'America/New_York';
const END = '2026-08-21';
const NOW = Date.parse(END + 'T22:00:00Z');
const HOUR = 3600000;

async function inZone<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = TZ;
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
    this.trace.push(exchangeKey(req.method, req.url));
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

const freshEnv = (): Env => ({ ss: new FakeSpreadsheet('raw'), props: new FakeProperties(new Map(), true), store: new MemoryTabStore(), kv: new MemoryPropertyStore() });

function legacy<T>(env: Env, ex: readonly RecordedExchange[], now: number, fn: (o: ReturnType<typeof loadOracle>) => T): { value: T; logs: string[]; trace: string[] } {
  const logs: string[] = [];
  const trace: string[] = [];
  const value = withOracleGlobals({
    SpreadsheetApp: fakeSpreadsheetApp(env.ss), PropertiesService: fakePropertiesService(env.props),
    UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now), Logger: { log: (m: unknown) => { logs.push(String(m)); } },
  }, () => fn(loadOracle()));
  return { value: structuredClone(value), logs, trace };
}

function depsFor(env: Env, ex: readonly RecordedExchange[], now: number): { deps: MacroDeps; logs: string[]; transport: TracingTransport } {
  const logs: string[] = [];
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  return {
    logs, transport,
    deps: { http: new HttpClient({ transport }), store: env.store, kv: env.kv, fmpKey: 'fl10a-key', timeZone: TZ, clock: { now: () => now }, log: (m) => logs.push(m), legacyFreshness: true },
  };
}

function assertSameTabs(env: Env, where: string): void {
  const names = new Set<string>([...env.ss.getSheets().map((s) => s.getName()), ...env.store.tabs.keys()]);
  for (const name of names) {
    const sh = env.ss.getSheetByName(name);
    const legacyGrid = sh ? (sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 6).getValues() : []) : null;
    assert.deepStrictEqual(env.store.snapshot(name, 6), legacyGrid, where + ' tab ' + name);
  }
}

const nasdaqExchanges = (tickers: readonly string[], end: string, bars: number): RecordedExchange[] =>
  tickers.map((t) => recordedGet(nasdaqHistoricalUrl(t), 200, nasdaqHistoricalBody(t, { end, bars })));

/** Result of a call that may throw: the value or the error message. */
function capture<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

describe('FL-10a macro fetch: Nasdaq URL and response parser', { skip }, () => {
  test('nasdaqHistoricalUrl matches nasdaqHistoricalUrl_Macro_', () => {
    const oracle = loadOracle();
    for (const t of ['SPY', 'GC=F', '^VIX', 'A B', 'é', 'BRK.B', '', 'a/b?c']) {
      assert.equal(nasdaqHistoricalUrl(t), oracle.call('nasdaqHistoricalUrl_Macro_', t), t);
    }
  });

  test('parseNasdaqHistorical matches parseNasdaqHistoricalResponse_Macro: values, order, skipped rows, throws and every log line', async () => {
    await inZone(() => {
      const row = (date: string, close: string, high: string, low: string, volume: string) => ({ date, close, high, low, volume });
      const wrap = (rows: unknown) => JSON.stringify({ data: { tradesTable: { rows } } });
      const bodies: Array<[string, number, string]> = [
        ['ok 300 bars', 200, nasdaqHistoricalBody('SPY', { end: END, bars: 300 })],
        ['holes', 200, nasdaqHistoricalBody('SPY', { end: END, bars: 300, holes: true })],
        ['no rows', 200, wrap([])],
        ['no tradesTable', 200, JSON.stringify({ data: {} })],
        ['data null', 200, JSON.stringify({ data: null })],
        ['empty array json', 200, '[]'],
        ['null json throws', 200, 'null'],
        ['bad json', 200, '{oops'],
        ['empty text', 200, ''],
        ['404', 404, ''],
        ['500', 500, 'x'],
        ['403', 403, wrap([row('01/02/2026', '1', '2', '0.5', '9')])],
        ['all unparseable', 200, wrap([row('01/02/2026', 'x', 'y', 'z', '1')])],
        ['row without date throws', 200, wrap([{ close: '1' }])],
        ['rows not an array throws', 200, wrap('abc')],
        ['dollar signs, commas and bad volume', 200, wrap([
          row('03/04/2026', '$1,234.50', '$1,300.00', '$1,200.00', '1,234,567'),
          row('03/03/2026', '$10.5', '$11', '$10', 'N/A'),
          row('03/02/2026', '$9', '$9.5', '$8.5', ''),
        ])],
        ['one bad low skips the row', 200, wrap([row('03/04/2026', '5', '6', 'n/a', '1'), row('03/03/2026', '5', '6', '4', '1')])],
        ['unsorted and duplicated dates keep reversed input order', 200, wrap([row('01/05/2026', '1', '2', '0.5', '1'), row('01/09/2026', '2', '3', '1', '1'), row('01/05/2026', '3', '4', '2', '1')])],
        ['single digit month and day', 200, wrap([row('1/2/2026', '1', '2', '0.5', '1')])],
      ];
      const oracle = loadOracle();
      for (const [label, status, body] of bodies) {
        const lLogs: string[] = [];
        const resp = { getResponseCode: () => status, getContentText: () => body };
        const L = capture(() => withOracleGlobals({ Logger: { log: (m: unknown) => { lLogs.push(String(m)); } } }, () => structuredClone(oracle.call('parseNasdaqHistoricalResponse_Macro', 'SPY', resp))));
        const pLogs: string[] = [];
        const P = capture(() => parseNasdaqHistorical('SPY', status, body, (m) => pLogs.push(m)));
        assert.deepStrictEqual(P.error, L.error, label + ' (throw)');
        assert.deepStrictEqual(P.value === undefined ? undefined : structuredClone(P.value), L.value, label);
        assert.deepStrictEqual(pLogs, lLogs, label + ' (logs)');
      }
    });
  });
});

describe('FL-10a macro fetch: batch fetch with caches', { skip }, () => {
  async function seed(env: Env, t: string, end: string, bars: number): Promise<void> {
    const d = parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end, bars }), () => {})!;
    legacy(env, [], NOW, (o) => o.call('writeMacroPriceCache_', t, d));
    await writeMacroPriceCache(env.store, t, d);
  }

  test('fetchHistoricalOHLCVBatch matches fetchHistoricalOHLCV_MacroBatch: results, tabs, logs and requests', async () => {
    await inZone(async () => {
      const T3 = ['SPY', 'TLT', 'GLD'];
      const scenarios: Array<[string, string[] | null, (env: Env) => Promise<void>, RecordedExchange[], boolean]> = [
        ['no tickers (empty array)', [], async () => {}, [], false],
        ['null tickers', null, async () => {}, [], false],
        ['everything fetched', T3, async () => {}, nasdaqExchanges(T3, END, 400), false],
        ['all fresh: no request', T3, async (env) => { for (const t of T3) await seed(env, t, END, 400); }, [], false],
        ['mixed fresh and stale', T3, async (env) => { await seed(env, 'SPY', END, 400); await seed(env, 'TLT', '2026-07-01', 300); }, nasdaqExchanges(['TLT', 'GLD'], END, 400), false],
        ['one 403 and one bad JSON', ['SPY', 'XLU', 'IYT'], async () => {}, [
          ...nasdaqExchanges(['SPY'], END, 400), recordedGet(nasdaqHistoricalUrl('XLU'), 403, ''), recordedGet(nasdaqHistoricalUrl('IYT'), 200, '{bad'),
        ], false],
        ['short history', ['SPY'], async () => {}, nasdaqExchanges(['SPY'], END, 5), false],
        ['one unrecorded: sequential fallback', ['SPY', 'TLT', 'XLB'], async () => {}, nasdaqExchanges(['SPY', 'TLT'], END, 400), true],
      ];
      for (const [label, tickers, seedFn, ex, fallback] of scenarios) {
        const env = freshEnv();
        await seedFn(env);
        const L = legacy(env, ex, NOW, (o) => o.call('fetchHistoricalOHLCV_MacroBatch', tickers));
        const P = depsFor(env, ex, NOW);
        const got = await fetchHistoricalOHLCVBatch(P.deps, tickers as never);
        assert.deepStrictEqual(structuredClone(got), L.value, label);
        assert.deepStrictEqual(P.logs, L.logs, label + ' (logs)');
        assertSameTabs(env, label);
        if (!fallback) assert.deepStrictEqual(P.transport.trace, L.trace, label + ' (requests)');
      }
    });
  });
});

describe('FL-10a macro fetch: cache-only reads', { skip }, () => {
  const SUPPLEMENTAL = { m2YoyGrowthPct: 4.2, m2AsOfDate: '2026-06-01', yieldCurveSpread: -0.12, yieldCurveInverted: true, yieldCurveAsOfDate: '2026-08-20', businessCyclePhase: null };
  const DOW = { verdict: 'CONFIRMED_UP', dia: { trend: 'up', lastDate: new Date('2026-08-20T00:00:00Z') }, iyt: null };

  test('getCachedMacroSupplemental / getCachedDowTheoryConfirmation match the legacy readers: fresh, expired, missing, corrupt, no-TTL', async () => {
    await inZone(async () => {
      const keys: Array<[string, string, unknown]> = [
        ['macroSupplementalV1', 'getCachedMacroSupplementalV1_', SUPPLEMENTAL],
        ['dowTheoryConfirmationV1', 'getCachedDowTheoryConfirmationV1_', DOW],
      ];
      const reads = async (env: Env, key: string, fn: string, at: number, where: string): Promise<void> => {
        const L = legacy(env, [], at, (o) => o.call(fn));
        const P = depsFor(env, [], at);
        const got = key === 'macroSupplementalV1' ? await getCachedMacroSupplemental(P.deps) : await getCachedDowTheoryConfirmation(P.deps);
        assert.deepStrictEqual(got, L.value, where);
      };
      for (const [key, fn, value] of keys) {
        // Missing key.
        await reads(freshEnv(), key, fn, NOW, key + ' missing');
        // Saved with the real legacy cacheSet (30h TTL), then read at several ages.
        for (const ageH of [0, 1, 29.99, 30, 30.01, 31, 500]) {
          const env = freshEnv();
          legacy(env, [], NOW, (o) => o.call('cacheSet', key, value, 30));
          env.kv.map.set(key, env.props.map.get(key)!);
          await reads(env, key, fn, NOW + ageH * HOUR, `${key} age ${ageH}h`);
        }
        // Saved without a TTL: never expires.
        const noTtl = freshEnv();
        legacy(noTtl, [], NOW, (o) => o.call('cacheSet', key, value));
        noTtl.kv.map.set(key, noTtl.props.map.get(key)!);
        await reads(noTtl, key, fn, NOW + 9999 * HOUR, key + ' no ttl');
        // Corrupt payloads and payload shapes.
        for (const raw of ['{bad', 'null', '"text"', '{"_savedAt":1,"_ttlHours":null}', '{"data":{"a":1}}', '0', '']) {
          const env = freshEnv();
          env.props.map.set(key, raw);
          env.kv.map.set(key, raw);
          await reads(env, key, fn, NOW, `${key} raw ${JSON.stringify(raw)}`);
        }
      }
    });
  });
});
