/**
 * FL-0: the fetch layer's infrastructure -- dates in an explicit zone, the
 * HTTP client (replay, limits, User-Agent, Apps Script error semantics),
 * the key-value store, and the Apps Script fakes that let the oracle's
 * real cache code run.
 *
 * Every legacy function ported here is checked against the oracle on the
 * same inputs; the fakes are checked by driving the oracle's OWN cache
 * readers and writers (dataLayerV1.gs) through them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { sheets_v4 } from 'googleapis';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import {
  FakeProperties, fakePropertiesService, FakeSpreadsheet, fakeSpreadsheetApp, gasFormatDate,
  replayUrlFetchApp, GAS_PROPERTY_VALUE_LIMIT_BYTES, type CoercionMode,
} from './gasFakes.ts';
import { formatDateInTz, scriptTimeZone, type DatePattern } from '../src/core/dates.ts';
import {
  scrubUrl, exchangeKey, assertNoSecrets, ExchangeBook, ReplayTransport, ReplayMissError, RecordingTransport,
  LiveTransport, HttpClient, HttpResponse, HttpStatusError, secUserAgents,
  type HttpRequest, type HttpTransport, type RecordedExchange,
} from '../src/net/http.ts';
import {
  MemoryPropertyStore, SheetPropertyStore, cacheSet, cacheGet, getCachedFundamentals, saveFundamentalsCache,
  getCachedOptions, OPTIONS_OVERLAY_KEY,
} from '../src/storage/kv.ts';
import { TimeoutError } from '../src/core/errors.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { Tabs } from '../src/sheets/tabs.ts';
import { createContext, type RunContext } from '../src/core/context.ts';
import { ok } from '../src/core/result.ts';
import { LogLevel } from '../src/core/logger.ts';

const ready = legacyFilesPresent();
const T = (iso: string): Date => new Date(iso);

/**
 * Pins Date.now for the duration of `fn`. NOTE: this does NOT affect a
 * no-argument `new Date()`, which reads the real clock -- tests of legacy
 * code that stamps rows with `new Date()` must time reads relative to the
 * stamp actually written (see the broker-data cache test).
 */
function withPinnedNow<R>(now: number, fn: () => R): R {
  const original = Date.now;
  Date.now = (): number => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function exchange(url: string, status: number, body: string, method = 'GET'): RecordedExchange {
  return { request: { method, url: scrubUrl(url) }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}

const quietCtx = (): RunContext =>
  createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

describe('FL-0 — formatDateInTz', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('hand-computed DST and year boundaries, in all three zone kinds legacy uses', () => {
    const cases: Array<[string, string, string]> = [
      ['2026-03-08T06:59:59Z', 'America/New_York', '2026-03-08'],
      ['2026-03-08T04:59:59Z', 'America/New_York', '2026-03-07'],
      ['2026-03-08T07:00:00Z', 'America/New_York', '2026-03-08'],
      ['2026-11-01T03:59:59Z', 'America/New_York', '2026-10-31'],
      ['2026-11-01T04:00:00Z', 'America/New_York', '2026-11-01'],
      ['2026-11-02T04:59:59Z', 'America/New_York', '2026-11-01'],
      ['2026-11-02T05:00:00Z', 'America/New_York', '2026-11-02'],
      ['2026-01-01T04:59:59Z', 'America/New_York', '2025-12-31'],
      ['2026-01-01T05:00:00Z', 'America/New_York', '2026-01-01'],
      ['2025-12-31T23:59:59Z', 'UTC', '2025-12-31'],
      ['2026-01-01T00:00:00Z', 'UTC', '2026-01-01'],
      ['2025-12-31T21:59:59Z', 'Asia/Jerusalem', '2025-12-31'],
      ['2025-12-31T22:00:00Z', 'Asia/Jerusalem', '2026-01-01'],
      ['2026-06-30T20:59:59Z', 'Asia/Jerusalem', '2026-06-30'],
      ['2026-06-30T21:00:00Z', 'Asia/Jerusalem', '2026-07-01'],
    ];
    for (const [iso, tz, want] of cases) assert.equal(formatDateInTz(T(iso), tz), want, `${iso} in ${tz}`);
  });

  test('matches the oracle across every half hour of a DST week and a year boundary', () => {
    const oracle = loadOracle();
    const windows = ['2026-03-05T00:00:00Z', '2026-10-29T00:00:00Z', '2025-12-29T00:00:00Z', '2026-03-24T00:00:00Z'];
    let compared = 0;
    for (const start of windows) {
      for (let k = 0; k < 7 * 48; k++) {
        const d = new Date(Date.parse(start) + k * 30 * 60 * 1000);
        for (const tz of ['UTC', 'America/New_York', 'Asia/Jerusalem']) {
          // The oracle's own Utilities.formatDate (an independent implementation).
          assert.equal(formatDateInTz(d, tz),
            oracle.getGlobal<{ formatDate: typeof gasFormatDate }>('Utilities').formatDate(d, tz, 'yyyy-MM-dd'),
            `${d.toISOString()} ${tz}`);
          compared++;
        }
        // Legacy's own UTC formatter (futuresStockAnalysisV3_3_11.gs:1560).
        assert.equal(oracle.call('fmtDate', d), formatDateInTz(d, 'UTC'), 'legacy fmtDate');
      }
    }
    assert.ok(compared > 4000);
  });

  test('refuses what it cannot do faithfully', () => {
    assert.throws(() => formatDateInTz(T('2026-01-01T00:00:00Z'), 'UTC', 'MM/dd/yyyy' as DatePattern), /unsupported pattern/);
    assert.throws(() => formatDateInTz(new Date(NaN), 'UTC'), RangeError);
    assert.throws(() => formatDateInTz(T('2026-01-01T00:00:00Z'), 'Not/AZone'), RangeError);
    assert.throws(() => scriptTimeZone({}), /SCRIPT_TIME_ZONE is not set/);
    assert.throws(() => scriptTimeZone({ SCRIPT_TIME_ZONE: 'Not/AZone' }), RangeError);
    assert.equal(scriptTimeZone({ SCRIPT_TIME_ZONE: 'America/New_York' }), 'America/New_York');
  });
});

describe('FL-0 — net/http', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('API keys never reach a recording key, under every legacy parameter form', () => {
    assert.equal(scrubUrl('https://financialmodelingprep.com/stable/earnings?symbol=AAPL&apikey=SECRET1'),
      'https://financialmodelingprep.com/stable/earnings?symbol=AAPL&apikey=REDACTED');
    assert.equal(scrubUrl('https://financialmodelingprep.com/stable/profile?apikey=SECRET1&symbol=X'),
      'https://financialmodelingprep.com/stable/profile?apikey=REDACTED&symbol=X');
    assert.equal(scrubUrl('https://finnhub.io/api/v1/stock/metric?symbol=A&metric=all&token=SECRET2'),
      'https://finnhub.io/api/v1/stock/metric?symbol=A&metric=all&token=REDACTED');
    assert.equal(scrubUrl('https://www.alphavantage.co/query?function=OVERVIEW&symbol=A&apiKey=SECRET3'),
      'https://www.alphavantage.co/query?function=OVERVIEW&symbol=A&apiKey=REDACTED');
    assert.equal(exchangeKey(undefined, 'https://x.test/a?apikey=1'), exchangeKey('get', 'https://x.test/a?apikey=2'));
    const rec = [exchange('https://x.test/a?apikey=REAL_SECRET_VALUE', 200, '{"echo":"REAL_SECRET_VALUE"}')];
    assert.throws(() => assertNoSecrets(rec, ['REAL_SECRET_VALUE']), /contains a secret/);
    assert.doesNotThrow(() => assertNoSecrets([exchange('https://x.test/a', 200, '{}')], ['REAL_SECRET_VALUE', '']));
  });

  test('replay: recorded order per URL, the last repeating, misses loud', async () => {
    const book = new ExchangeBook([exchange('https://x.test/a', 200, 'one'), exchange('https://x.test/a', 200, 'two'), exchange('https://x.test/b', 404, 'nf')]);
    const t = new ReplayTransport(book);
    assert.equal((await t.send({ url: 'https://x.test/a' })).text(), 'one');
    assert.equal((await t.send({ url: 'https://x.test/a' })).text(), 'two');
    assert.equal((await t.send({ url: 'https://x.test/a' })).text(), 'two');
    assert.equal((await t.send({ url: 'https://x.test/b' })).status, 404);
    await assert.rejects(t.send({ url: 'https://x.test/c' }), ReplayMissError);
    assert.deepStrictEqual(book.misses, ['GET https://x.test/c']);
  });

  test('muteHttpExceptions keeps Apps Script\'s default: unmuted 4xx/5xx throws', async () => {
    const client = new HttpClient({ transport: new ReplayTransport(new ExchangeBook([exchange('https://x.test/b', 404, 'nf'), exchange('https://x.test/c', 503, 'down')])) });
    await assert.rejects(client.fetch({ url: 'https://x.test/b' }), (e: unknown) => e instanceof HttpStatusError && e.status === 404);
    assert.equal((await client.fetch({ url: 'https://x.test/b', muteHttpExceptions: true })).status, 404);
    await assert.rejects(client.fetch({ url: 'https://x.test/c?token=s3cret' }), ReplayMissError);
    await assert.rejects(client.fetch({ url: 'https://x.test/c' }), (e: unknown) => e instanceof HttpStatusError && e.status === 503);
  });

  test('SEC hosts get the contact User-Agent and are held to their concurrency ceiling', async () => {
    const seen: HttpRequest[] = [];
    let active = 0;
    let peak = 0;
    const slow: HttpTransport = {
      async send(req) {
        seen.push(req);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new HttpResponse(200, new TextEncoder().encode('ok'));
      },
    };
    const client = new HttpClient({ transport: slow, userAgentByHost: secUserAgents('contact@example.org') });
    const urls = Array.from({ length: 12 }, (_, i) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${i}.json`);
    const res = await client.fetchAll(urls.map((url) => ({ url, headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' } })));
    assert.equal(res.length, 12);
    assert.equal(client.limiter.peakFor('data.sec.gov'), 3);
    assert.ok(peak <= 3, `peak ${peak}`);
    assert.ok(seen.every((r) => r.headers!['User-Agent'] === 'Mozilla/5.0 contact@example.org'));
    assert.ok(seen.every((r) => Object.keys(r.headers!).filter((k) => k.toLowerCase() === 'user-agent').length === 1));
    seen.length = 0;
    await client.fetch({ url: 'https://api.nasdaq.com/x', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nasdaq.com/' } });
    assert.deepStrictEqual(seen[0].headers, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nasdaq.com/' });
  });

  test('fetchAll matches legacy fetchAllOrSequentialV1_ (dataLayerV1.gs:735-741) on the same recordings', async () => {
    const recs = [
      exchange('https://www.sec.gov/a', 200, 'A'),
      exchange('https://www.sec.gov/b', 404, 'B-missing'),
      exchange('https://www.sec.gov/c', 500, 'C-error'),
    ];
    const urls = ['https://www.sec.gov/a', 'https://www.sec.gov/b', 'https://www.sec.gov/zz-unrecorded', 'https://www.sec.gov/c'];
    for (const mute of [true, false]) {
      const reqs = urls.map((url) => ({ url, muteHttpExceptions: mute }));
      const legacy = withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(new ExchangeBook(recs)) },
        () => loadOracle().call<Array<{ getResponseCode(): number; getContentText(): string } | null>>('fetchAllOrSequentialV1_', reqs));
      const port = await new HttpClient({ transport: new ReplayTransport(new ExchangeBook(recs)) }).fetchAll(reqs);
      assert.deepStrictEqual(
        port.map((r) => (r ? [r.status, r.text()] : null)),
        legacy.map((r) => (r ? [r.getResponseCode(), r.getContentText()] : null)),
        `mute=${mute}`,
      );
    }
    assert.deepStrictEqual(await new HttpClient({ transport: new ReplayTransport(new ExchangeBook([])) }).fetchAll([]), []);
    assert.deepStrictEqual(loadOracle().callNormalized('fetchAllOrSequentialV1_', []), []);
  });

  test('a hung request is cut off by its own timeout, and recording scrubs as it goes', async () => {
    const hanging = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    await assert.rejects(new LiveTransport(hanging).send({ url: 'https://x.test/slow?apikey=K', timeoutMs: 20 }),
      (e: unknown) => e instanceof TimeoutError && /apikey=REDACTED/.test((e as Error).message));
    const fake = (async () => new Response('hello', { status: 201, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const rec = new RecordingTransport(new LiveTransport(fake));
    const r = await rec.send({ url: 'https://finnhub.io/q?token=K1&symbol=A' });
    assert.equal(r.status, 201);
    assert.equal(r.text(), 'hello');
    assert.deepStrictEqual(rec.exchanges()[0].request, { method: 'GET', url: 'https://finnhub.io/q?token=REDACTED&symbol=A' });
    const back = await new ReplayTransport(new ExchangeBook(rec.exchanges())).send({ url: 'https://finnhub.io/q?token=OTHER&symbol=A' });
    assert.equal(back.text(), 'hello');
  });
});

describe('FL-0 — storage/kv', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('cacheSet/cacheGet are byte-compatible with legacy (futuresStockAnalysisV3_3_11.gs:669-689), both directions', async () => {
    const shared = new Map<string, string>();
    const props = new FakeProperties(shared);
    const store = new MemoryPropertyStore(shared);
    const NOW = Date.parse('2026-10-21T12:00:00Z');
    const H = 3600 * 1000;
    const values: unknown[] = [{ a: 1, b: [1, 2] }, 'str', 0, false, null, [], { d: new Date(NOW) }];
    for (const [i, v] of values.entries()) {
      for (const ttl of [undefined, null, 0, 30, -1]) {
        const k1 = `L${i}_${ttl}`;
        const k2 = `P${i}_${ttl}`;
        withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () =>
          withPinnedNow(NOW, () => loadOracle().call('cacheSet', k1, v, ttl)));
        await cacheSet(store, k2, v, ttl, NOW);
        assert.equal(shared.get(k2), shared.get(k1), `stored bytes v=${JSON.stringify(v)} ttl=${ttl}`);
        for (const age of [0, 30 * H, 30 * H + 1, 1000 * H]) {
          const legacyRead = withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () =>
            withPinnedNow(NOW + age, () => loadOracle().callNormalized('cacheGet', k2)));
          assert.deepStrictEqual(await cacheGet(store, k1, NOW + age), legacyRead, `read v=${JSON.stringify(v)} ttl=${ttl} age=${age}`);
        }
      }
    }
    // The quirks, pinned: `ttlHours || null` makes 0 mean NEVER expire;
    // expiry is strictly `>` the TTL; a negative TTL is expired at once;
    // and a Date comes back as its ISO string (JSON round trip).
    await cacheSet(store, 'z', 'v', 0, NOW);
    assert.equal(await cacheGet(store, 'z', NOW + 10_000 * H), 'v');
    await cacheSet(store, 't', 'v', 30, NOW);
    assert.equal(await cacheGet(store, 't', NOW + 30 * H), 'v');
    assert.equal(await cacheGet(store, 't', NOW + 30 * H + 1), null);
    await cacheSet(store, 'n', 'v', -1, NOW);
    assert.equal(await cacheGet(store, 'n', NOW), null);
    await cacheSet(store, 'd', { at: new Date(NOW) }, 30, NOW);
    assert.deepStrictEqual(await cacheGet(store, 'd', NOW), { at: '2026-10-21T12:00:00.000Z' });
    shared.set('bad', '{not json');
    const errs: unknown[] = [];
    assert.equal(await cacheGet(store, 'bad', NOW, (e) => errs.push(e)), null);
    assert.equal(errs.length, 1, 'the swallowed parse error is reported, not silent');
    assert.equal(await cacheGet(store, 'missing', NOW), null);
  });

  test('the 9 KB property cap: legacy silently fails to cache, the port does not', async () => {
    const props = new FakeProperties();
    const big = 'x'.repeat(GAS_PROPERTY_VALUE_LIMIT_BYTES);
    withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () => {
      loadOracle().call('cacheSet', 'big', big, 30);
      assert.equal(loadOracle().call('cacheGet', 'big'), null, 'legacy cacheSet swallows "Argument too large"');
    });
    const store = new MemoryPropertyStore();
    assert.equal(await cacheSet(store, 'big', big, 30), true);
    assert.equal(await cacheGet(store, 'big'), big);
  });

  test('the fundamentals and options-overlay property caches match legacy', async () => {
    const shared = new Map<string, string>();
    const props = new FakeProperties(shared);
    const store = new MemoryPropertyStore(shared);
    const fund = { marketCap: 1e12, revenueGrowth: 0.1, _sources: ['FMP'] };
    const now = new Date('2026-10-21T12:00:00Z');
    withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () =>
      withPinnedNow(now.getTime(), () => loadOracle().call('saveFundamentalsCache', 'AAA', fund)));
    await saveFundamentalsCache(store, 'BBB', fund, now);
    const legacyStored = JSON.parse(shared.get('FUND_AAA')!);
    assert.deepStrictEqual(JSON.parse(shared.get('FUND_BBB')!).data, legacyStored.data);
    assert.equal(typeof legacyStored.date, 'string');
    for (const t of ['AAA', 'BBB', 'NONE']) {
      const legacy = withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () => loadOracle().callNormalized('getCachedFundamentals', t));
      assert.deepStrictEqual(await getCachedFundamentals(store, t), legacy, t);
    }
    shared.set(OPTIONS_OVERLAY_KEY, JSON.stringify({ ticker: 'X', calls: [1] }));
    const legacyOpt = withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () => loadOracle().callNormalized('getCachedOptions'));
    assert.deepStrictEqual(await getCachedOptions(store), legacyOpt);
    shared.set(OPTIONS_OVERLAY_KEY, '{broken');
    assert.equal(await getCachedOptions(store), null);
    assert.equal(withOracleGlobals({ PropertiesService: fakePropertiesService(props) }, () => loadOracle().call('getCachedOptions')), null);
  });

  test('the Sheet-backed store loads, creates its tab, flushes once, and clears deleted rows', async () => {
    const calls: string[] = [];
    let table: string[][] = [];
    const tabs = new Set<string>();
    const api = {
      spreadsheets: {
        get: async () => { calls.push('get'); return { data: { sheets: [...tabs].map((title) => ({ properties: { title } })) } }; },
        batchUpdate: async (p: { requestBody: { requests: Array<{ addSheet?: { properties: { title: string } } }> } }) => {
          calls.push('format');
          for (const r of p.requestBody.requests) if (r.addSheet) tabs.add(r.addSheet.properties.title);
          return { data: {} };
        },
        values: {
          batchGet: async () => { calls.push('batchGet'); return { data: { valueRanges: [{ values: table }] } }; },
          batchUpdate: async (p: { requestBody: { data: Array<{ values: string[][] }> } }) => {
            calls.push('batchUpdate');
            table = p.requestBody.data[0].values.filter((r) => r.some((c) => c !== ''));
            return { data: { totalUpdatedCells: p.requestBody.data[0].values.length * 3 } };
          },
        },
      },
    } as unknown as sheets_v4.Sheets;
    const client = new SheetsClient({ spreadsheetId: 'test', api });
    const ctx = quietCtx();
    const TAB = '💾 Script Properties';
    const first = await SheetPropertyStore.load(ctx, client, TAB);
    assert.ok(first.ok);
    assert.deepStrictEqual(calls, ['get', 'format'], 'missing tab is created, nothing read');
    const s = first.value;
    await cacheSet(s, 'cikMap', { AAPL: 320193 }, 24 * 90, Date.parse('2026-10-21T00:00:00Z'));
    await s.set('raw', 'v');
    assert.deepStrictEqual(await s.flush(ctx), ok(9));
    assert.deepStrictEqual(await s.flush(ctx), ok(0), 'nothing dirty, no second write');
    calls.length = 0;
    const again = await SheetPropertyStore.load(ctx, client, TAB);
    assert.ok(again.ok);
    assert.deepStrictEqual(calls, ['get', 'batchGet']);
    assert.deepStrictEqual(await cacheGet(again.value, 'cikMap', Date.parse('2026-10-22T00:00:00Z')), { AAPL: 320193 });
    await again.value.delete('raw');
    await again.value.flush(ctx);
    assert.deepStrictEqual(table.map((r) => r[0]), ['Key', 'cikMap'], 'the deleted row is blanked, not left behind');
  });
});

describe('FL-0 — Apps Script fakes drive the real legacy cache code', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('legacy cache tab names are exactly Phase 1\'s tab registry', () => {
    const F = loadOracle().fns.setStatusV7.constructor as new (body: string) => () => unknown;
    const get = (n: string): unknown => new F('return ' + n + ';')();
    assert.equal(get('CACHE_13F_SHEET_NAME_V1'), Tabs.INSTITUTIONAL_HISTORY);
    assert.equal(get('CACHE_BROKER_DATA_SHEET_NAME_V1'), Tabs.BROKER_DATA_HISTORY);
    assert.equal(get('CACHE_MACRO_SNAPSHOT_SHEET_NAME_V1'), Tabs.MACRO_SNAPSHOT);
    assert.equal(get('BROKER_DATA_CACHE_STALE_DAYS_V1'), 5);
  });

  test('broker-data cache round trip, and the real Sheets date coercion the legacy reader defends against', () => {
    const D = 86400000;
    // The writer stamps its row with `new Date()`, which pinning Date.now
    // does NOT affect -- so every read is timed relative to the timestamp
    // the legacy code actually wrote, read back from the fake sheet.
    const run = (mode: CoercionMode, readOffsetMs: number): unknown => {
      const ss = new FakeSpreadsheet(mode);
      return withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => {
        loadOracle().call('writeBrokerDataCacheV1_', 'aapl',
          { shortInterest: 1.5e8, daysToCover: 2.4, settlementDate: '09/15/2026', interestCoverageRatio: 0 });
        const sheet = ss.getSheetByName(Tabs.BROKER_DATA_HISTORY);
        assert.ok(sheet, 'legacy created the tab on first write');
        const written = (sheet.getRange(2, 2).getValue() as Date).getTime();
        return withPinnedNow(written + readOffsetMs, () => loadOracle().callNormalized('readBrokerDataCacheV1_', 'AAPL'));
      });
    };
    const raw = run('raw', D) as Record<string, unknown>;
    assert.equal(raw.settlementDate, '09/15/2026');
    assert.equal(raw.shortInterest, 1.5e8);
    assert.equal(raw.interestCoverageRatio, 0, "a real 0 survives -- `=== ''`, not falsy");
    // Real Sheets turns "09/15/2026" into a Date on write; the legacy reader
    // (dataLayerV1.gs:974-975) re-stringifies it. Same data, different text.
    const coerced = run('sheets', D) as Record<string, unknown>;
    assert.equal(coerced.settlementDate, '2026-09-15');
    assert.ok(run('raw', 5 * D) !== null, 'exactly 5 days old is still fresh');
    assert.equal(run('raw', 5 * D + 1), null, 'one ms past 5 days is stale');
    // Writing the same ticker again overwrites its row (the legacy
    // semantics; Phase 1 makes the real tab append-only).
    const ss = new FakeSpreadsheet('raw');
    withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => {
      loadOracle().call('writeBrokerDataCacheV1_', 'AAPL', { shortInterest: 1 });
      loadOracle().call('writeBrokerDataCacheV1_', 'MSFT', { shortInterest: 2 });
      loadOracle().call('writeBrokerDataCacheV1_', 'aapl', { shortInterest: 3 });
    });
    assert.equal(ss.getSheetByName(Tabs.BROKER_DATA_HISTORY)!.getLastRow(), 3, 'header + 2 tickers');
    assert.equal(ss.getSheetByName(Tabs.BROKER_DATA_HISTORY)!.getRange(2, 3).getValue(), 3, 'AAPL overwritten in place');
  });

  test('macro snapshot round trip, through the same fakes', () => {
    const NOW = Date.parse('2026-10-21T12:00:00Z');
    const ss = new FakeSpreadsheet('sheets');
    const snap = withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(ss) }, () => withPinnedNow(NOW, () => {
      loadOracle().call('writeMacroSnapshotV1_', [4.1, 4.2], [5.25, 5.0], [100, 102, 105]);
      return loadOracle().callNormalized<Record<string, unknown>>('readMacroSnapshotV1_');
    }));
    assert.deepStrictEqual({ dgs10: snap.dgs10, fedfunds: snap.fedfunds, gdpSeries: snap.gdpSeries },
      { dgs10: [4.1, 4.2], fedfunds: [5.25, 5.0], gdpSeries: [100, 102, 105] });
    assert.equal(withOracleGlobals({ SpreadsheetApp: fakeSpreadsheetApp(new FakeSpreadsheet()) }, () => loadOracle().call('readMacroSnapshotV1_')), null);
    // And with no fake at all, the default sandbox still returns null, as every earlier checkpoint relies on.
    assert.equal(loadOracle().call('readMacroSnapshotV1_'), null);
  });
});
