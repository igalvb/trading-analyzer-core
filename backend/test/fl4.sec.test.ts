/**
 * FL-4: SEC EDGAR (CIK, shares outstanding, filing keyword search), the
 * institutional 13F chain with its quarter-keyed Sheet cache, and the ETF
 * top-holdings readers (State Street .xlsx through the new ZIP reader, QQQ
 * through NPORT-P).
 *
 * Every port is compared with the oracle on the same synthetic responses
 * (test/secFixtures.ts): returned value, request sequence (as a multiset for
 * the concurrent 13F rounds), PropertiesService contents and the cache tab,
 * cell for cell.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, FakeSpreadsheet, fakeSpreadsheetApp, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { rng } from './fundamentalsFixtures.ts';
import {
  recordedGet, submissionsBody, indexBody, infoTableXml, nportXml, COMPANY_TICKERS, sharesConceptBody, zipBytes, gasUnzip, spdrXlsx, type InfoRow,
} from './secFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey, secUserAgent,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { unzip, ZipFormatError } from '../src/net/unzip.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { Tabs } from '../src/sheets/tabs.ts';
import {
  fetchSecEdgarCIK, fetchSharesOutstandingHistory, fetchSecFilingKeywordHits, secUserAgentsFromEnv, SEC_DILUTION_KEYWORDS,
} from '../src/fetch/sec/edgar.ts';
import {
  INSTITUTIONAL_13F_FILERS, parse13FInfoTable, sum13FPerCikResults, fetch13FCusip, fetch13FInfoTableUrl, fetch13FSingleCik,
  fetch13FForFiler, fetch13FBatched, fetchInstitutional13FHoldings, expected13FQuarterTag, read13FCache, write13FCache,
} from '../src/fetch/sec/thirteenF.ts';
import {
  fetchSpdrEtfTopHoldings, fetchQqqTopHoldings, parseSpdrSharedStrings, parseSpdrHoldings, spdrCellValue, spdrHoldingsUrl, SPDR_ETF_TICKERS,
} from '../src/fetch/etf/holdings.ts';

const ready = legacyFilesPresent();
const NOW = Date.parse('2026-10-21T22:00:00Z');
const FMP_KEY = 'fl4-test-key';
const EMAIL = 'contact@example.org';

class TracingTransport implements HttpTransport {
  readonly trace: string[] = [];
  readonly agents: Array<[string, string | undefined]> = [];
  private readonly inner: HttpTransport;
  constructor(inner: HttpTransport) {
    this.inner = inner;
  }
  send(req: HttpRequest): Promise<HttpResponse> {
    this.trace.push(exchangeKey(req.method, req.url));
    this.agents.push([new URL(req.url).hostname, req.headers?.['User-Agent']]);
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

const freshEnv = (mode: 'raw' | 'sheets' = 'raw'): Env => ({ ss: new FakeSpreadsheet(mode), props: new FakeProperties(new Map(), true), store: new MemoryTabStore(), kv: new MemoryPropertyStore() });

function legacy<T>(env: Env, ex: readonly RecordedExchange[], now: number, fn: (o: ReturnType<typeof loadOracle>) => T): { value: T; trace: string[]; threw?: string } {
  const trace: string[] = [];
  const utilities = loadOracle().getGlobal<Record<string, unknown>>('Utilities');
  let value: T = undefined as T;
  let threw: string | undefined;
  withOracleGlobals({
    SpreadsheetApp: fakeSpreadsheetApp(env.ss), PropertiesService: fakePropertiesService(env.props),
    UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now), Utilities: { ...utilities, unzip: gasUnzip },
  }, () => { try { value = structuredClone(fn(loadOracle())); } catch (e) { threw = (e as Error).message; } });
  return { value, trace, threw };
}

function portDeps(env: Env, ex: readonly RecordedExchange[], now: number, agents?: Readonly<Record<string, string>>) {
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  return { transport, deps: { http: new HttpClient({ transport, userAgentByHost: agents }), kv: env.kv, store: env.store, fmpKey: FMP_KEY, clock: { now: () => now } } };
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

function assertSameState(env: Env, where: string): void {
  assert.deepStrictEqual([...env.kv.map].sort(), [...env.props.map].sort(), where + ' (properties)');
  const sh = env.ss.getSheetByName(Tabs.INSTITUTIONAL_HISTORY);
  const legacyGrid = sh ? (sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 4).getValues() : []) : null;
  assert.deepStrictEqual(env.store.snapshot(Tabs.INSTITUTIONAL_HISTORY, 4), legacyGrid, where + ' (13F cache tab)');
}

// ── a synthetic 13F universe ────────────────────────────────────────────

const ALL_CIKS = Object.values(INSTITUTIONAL_13F_FILERS).flat() as string[];
const TARGET = '67066G104';
const subUrl = (cik: string): string => 'https://data.sec.gov/submissions/CIK' + ('0000000000' + cik).slice(-10) + '.json';
const arch = (cik: string, acc: string): string => 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + acc.replace(/-/g, '') + '/';

interface Universe {
  readonly ex: RecordedExchange[];
}

function universe(seed: number, mode: 'ok' | 'allSubsFail' | 'allDataFail' | 'no13F' | 'messy'): Universe {
  const r = rng(seed);
  const ex: RecordedExchange[] = [];
  for (const cik of ALL_CIKS) {
    const accs = [0, 1, 2].map((k) => '000' + cik.slice(0, 3) + '-26-' + String(100 + k + Math.floor(r() * 50)).padStart(6, '0'));
    if (mode === 'allSubsFail') { ex.push(recordedGet(subUrl(cik), 503, '')); continue; }
    if (mode === 'messy' && r() < 0.15) { if (r() < 0.5) ex.push(recordedGet(subUrl(cik), 500, '')); else ex.push(recordedGet(subUrl(cik), 200, '{bad')); continue; }
    if (mode === 'messy' && r() < 0.08) continue; // unrecorded: a network error
    const forms: Array<[string, string, string]> = mode === 'no13F'
      ? [['SC 13G', accs[0], '2026-10-01'], ['4', accs[1], '2026-09-01']]
      : [['13F-HR/A', accs[2], '2026-10-01'], ['13F-HR', accs[0], '2026-08-14'], ['SC 13G', accs[2], '2026-07-01'], ['13F-HR', accs[1], '2026-05-15'], ['13F-HR', accs[2], '2026-02-14']];
    ex.push(recordedGet(subUrl(cik), 200, submissionsBody(forms)));
    for (const [k, acc] of [[0, accs[0]], [1, accs[1]]] as Array<[number, string]>) {
      const name = 'infotable' + k + '.xml';
      if (mode === 'messy' && r() < 0.1) { ex.push(recordedGet(arch(cik, acc) + 'index.json', 200, indexBody(['primary_doc.xml', 'x.txt']))); continue; }
      if (mode === 'messy' && r() < 0.05) { ex.push(recordedGet(arch(cik, acc) + 'index.json', 404, '')); continue; }
      ex.push(recordedGet(arch(cik, acc) + 'index.json', 200, indexBody(['primary_doc.xml', name, 'R1.htm'])));
      if (mode === 'allDataFail') { ex.push(recordedGet(arch(cik, acc) + name, 403, '')); continue; }
      if (mode === 'messy' && r() < 0.1) { ex.push(recordedGet(arch(cik, acc) + name, 403, '')); continue; }
      const rows: InfoRow[] = [{ cusip: '037833100', issuer: 'APPLE INC', shares: '1000', value: '200000' }];
      if (r() < 0.8) rows.push({ cusip: TARGET, issuer: 'NVIDIA CORPORATION', shares: String(Math.floor(r() * 1e6)), value: String(Math.floor(r() * 1e9)) });
      if (r() < 0.5) rows.push({ cusip: TARGET, issuer: 'NVIDIA CORPORATION', shares: String(Math.floor(r() * 1e5)), value: String(Math.floor(r() * 1e8)) });
      if (r() < 0.3) rows.push({ issuer: 'NO CUSIP' }, { cusip: TARGET, issuer: 'NVIDIA CORPORATION' });
      ex.push(recordedGet(arch(cik, acc) + name, 200, infoTableXml(rows)));
    }
  }
  return { ex };
}

describe('FL-4 — the ZIP reader (Utilities.unzip replacement)', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('reads stored and deflated entries, skips directories, and rejects what is not a ZIP', () => {
    const z = zipBytes([['a.txt', 'hello', 'store'], ['dir/', '', 'store'], ['dir/b.xml', '<x>ü€</x>'.repeat(200), 'deflate'], ['empty', '', 'deflate']]);
    const entries = unzip(z);
    assert.deepStrictEqual(entries.map((e) => [e.name, e.text()]), [['a.txt', 'hello'], ['dir/b.xml', '<x>ü€</x>'.repeat(200)], ['empty', '']]);
    assert.deepStrictEqual(gasUnzip({ getBytes: () => Array.from(new Int8Array(z.buffer, z.byteOffset, z.byteLength)) }).map((f) => [f.getName(), f.getDataAsString()]), entries.map((e) => [e.name, e.text()]), 'the two independent readers agree');
    for (const bad of [new Uint8Array(0), new TextEncoder().encode('<html>Not Found</html>'), z.slice(0, z.length - 5)]) {
      assert.throws(() => unzip(bad), ZipFormatError);
    }
  });
});

describe('FL-4 — SEC EDGAR lookups', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('CIK, shares-outstanding history and dilution keyword hits match legacy, caches included', async () => {
    const ctUrl = 'https://www.sec.gov/files/company_tickers.json';
    for (const [label, status, body] of [['ok', 200, COMPANY_TICKERS], ['500', 500, ''], ['bad', 200, '{x'], ['unrecorded', 0, '']] as Array<[string, number, string]>) {
      for (const t of ['AAPL', 'qqq', 'AMD', 'SMH']) {
        const ex = status ? [recordedGet(ctUrl, status, body)] : [];
        for (const preCached of [false, true]) {
          const env = freshEnv();
          if (preCached) {
            legacy(env, [], NOW - 3600_000, (o) => o.call('cacheSet', 'CIK_' + t.toUpperCase(), '0000099999', 24 * 90));
            env.kv.map.set('CIK_' + t.toUpperCase(), env.props.map.get('CIK_' + t.toUpperCase())!);
          }
          const L = legacy(env, ex, NOW, (o) => o.call('fetchSecEdgarCIKV1', t));
          const { deps, transport } = portDeps(env, ex, NOW);
          assert.equal(await fetchSecEdgarCIK(deps, t), L.value, label + ' ' + t + ' cached=' + preCached);
          assert.deepStrictEqual(transport.trace, L.trace);
          assertSameState(env, label + ' ' + t);
        }
      }
    }
    const concept = (cik: string): string => 'https://data.sec.gov/api/xbrl/companyconcept/CIK' + cik + '/us-gaap/CommonStockSharesOutstanding.json';
    const bodies: Array<[string, number, string]> = [
      ['restated periods', 200, sharesConceptBody([['2025-03-31', 101, '2025-05-01'], ['2024-12-31', 99, '2025-02-01'], ['2025-03-31', 102, '2026-02-01'], ['2024-06-30', 95, '2024-08-01'], ['2025-03-31', 100, '2025-04-01']])],
      ['empty', 200, sharesConceptBody([])], ['no units', 200, '{}'], ['404', 404, ''], ['bad', 200, '<html>'],
    ];
    for (const [label, status, body] of bodies) {
      const ex = [recordedGet(concept('0000320193'), status, body)];
      const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetchSharesOutstandingHistoryV1', '0000320193'));
      const { deps } = portDeps(freshEnv(), ex, NOW);
      assert.deepStrictEqual(await fetchSharesOutstandingHistory(deps, '0000320193'), L.value, label);
    }
    assert.equal(await fetchSharesOutstandingHistory(portDeps(freshEnv(), [], NOW).deps, null), loadOracle().call('fetchSharesOutstandingHistoryV1', null));
    const search = (kw: string, since: string | null): string => 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent('"' + kw + '"') + '&ciks=0000320193' + (since ? '&dateRange=custom&startdt=' + since + '&enddt=2026-10-21' : '');
    for (const since of [null, '2025-10-21']) {
      const ex = SEC_DILUTION_KEYWORDS.map((kw, i) => recordedGet(search(kw, since), i === 3 ? 500 : 200, i === 1 ? '{"hits":{}}' : i === 2 ? '{bad' : JSON.stringify({ hits: { total: { value: i * 7, relation: 'eq' } } })));
      const L = legacy(freshEnv(), ex.slice(0, 4), NOW, (o) => o.call('fetchSecFilingKeywordHitsV1', '320193', since));
      const P = portDeps(freshEnv(), ex.slice(0, 4), NOW);
      // Legacy: one try per keyword (production retries 5xx / network errors: test/fix20261105.secSearchRetry.test.ts).
      assert.deepStrictEqual(await fetchSecFilingKeywordHits(P.deps, '320193', since, { retries: 0 }), L.value, 'since=' + since);
      assert.deepStrictEqual(P.transport.trace, L.trace, 'keywords in order, the window ending today (UTC)');
    }
  });

  test('SEC requests carry the real contact from SEC_CONTACT_EMAIL; other hosts keep their own User-Agent', async () => {
    assert.throws(() => secUserAgentsFromEnv({}), /SEC_CONTACT_EMAIL/);
    const agents = secUserAgentsFromEnv({ SEC_CONTACT_EMAIL: EMAIL });
    const ex = [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(spdrHoldingsUrl('SPY'), 404, '')];
    const { deps, transport } = portDeps(freshEnv(), ex, NOW, agents);
    await fetchSecEdgarCIK(deps, 'AAPL');
    await fetchSpdrEtfTopHoldings(deps, 'SPY');
    assert.deepStrictEqual(transport.agents, [['www.sec.gov', secUserAgent(EMAIL)], ['www.ssga.com', 'Mozilla/5.0']]);
  });
});

describe('FL-4 — the 13F chain', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('parse13FInfoTableV7_ / sum13FPerCikResultsV1_ / expected13FQuarterTagV1_ match legacy', () => {
    const o = loadOracle();
    const xml = infoTableXml([
      { cusip: TARGET, issuer: 'NVIDIA', shares: '10', value: '100' }, { cusip: TARGET, issuer: 'NVIDIA B', shares: '5', value: '50' },
      { issuer: 'NONE', shares: '1' }, { cusip: 'X1', issuer: 'X', shares: 'abc', value: '' }, { cusip: 'X2' },
    ]);
    assert.deepStrictEqual(parse13FInfoTable(xml), o.callNormalized('parse13FInfoTableV7_', xml));
    assert.deepStrictEqual(parse13FInfoTable(''), o.callNormalized('parse13FInfoTableV7_', ''));
    const per = [
      { latest: { date: '2026-08-14', holdings: { issuer: 'N', shares: 1, value: 2 } }, prior: null },
      null,
      { latest: { date: '2026-08-10', holdings: null }, prior: { date: '2026-05-15', holdings: { issuer: 'N2', shares: 3, value: 4 } } },
      { latest: { date: '2026-08-01', holdings: { issuer: 'N3', shares: 5, value: 6 } }, prior: undefined },
    ];
    assert.deepStrictEqual(sum13FPerCikResults(per as never), o.callNormalized('sum13FPerCikResultsV1_', per));
    assert.deepStrictEqual(sum13FPerCikResults([]), o.callNormalized('sum13FPerCikResultsV1_', []));
    for (let k = 0; k < 800; k++) {
      const d = new Date(Date.parse('2025-01-01T00:00:00Z') + k * 0.6 * 86400000 + (k % 7) * 3600_000);
      assert.equal(expected13FQuarterTag(d), o.call('expected13FQuarterTagV1_', d), d.toISOString());
    }
    assert.equal(expected13FQuarterTag(new Date('2026-10-21T22:00:00Z')), '2026Q2');
  });

  test('fetch13FCusipV7: FMP profile lookup, 90-day cache, failures not cached', async () => {
    for (const t of ['NVDA', 'brk.b']) {
      const url = 'https://financialmodelingprep.com/stable/profile?symbol=' + encodeURIComponent(t) + '&apikey=K';
      for (const [label, status, body] of [['ok', 200, JSON.stringify([{ symbol: t, cusip: TARGET }])], ['no cusip', 200, '[{}]'], ['empty', 200, '[]'], ['429', 429, ''], ['bad', 200, 'x']] as Array<[string, number, string]>) {
        const env = freshEnv();
        const ex = [recordedGet(url, status, body)];
        const L = legacy(env, ex, NOW, (o) => o.call('fetch13FCusipV7', t));
        const P = portDeps(env, ex, NOW);
        assert.equal(await fetch13FCusip(P.deps, t), L.value, t + ' ' + label);
        assertSameState(env, t + ' ' + label);
        // A second call hits the cache (when there is one) on both sides.
        const L2 = legacy(env, [], NOW + 3600_000, (o) => o.call('fetch13FCusipV7', t));
        assert.equal(await fetch13FCusip(portDeps(env, [], NOW + 3600_000).deps, t), L2.value);
      }
    }
  });

  test('the batched 3-round fetch and the sequential per-filer path match legacy, including safeToCache', async () => {
    const seen = { safe: 0, unsafe: 0, holdings: 0, nullHoldings: 0 };
    for (const [mode, seeds] of [['ok', [1, 2]], ['messy', [3, 4, 5, 6, 7, 8]], ['allSubsFail', [9]], ['allDataFail', [10]], ['no13F', [11]]] as Array<[Parameters<typeof universe>[1], number[]]>) {
      for (const seed of seeds) {
        const { ex } = universe(seed, mode);
        for (const cusip of [TARGET, '037833100', null]) {
          const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetch13FBatchedV1_', ALL_CIKS, cusip));
          const P = portDeps(freshEnv(), ex, NOW);
          const port = structuredClone(await fetch13FBatched(P.deps, ALL_CIKS, cusip));
          assert.deepStrictEqual(port, L.value, mode + ' ' + seed + ' ' + cusip);
          // The port issues each round concurrently; compare the requests as a multiset when nothing was unrecorded.
          if (!L.trace.some((t) => !ex.some((x) => exchangeKey(x.request.method, x.request.url) === t))) assert.deepStrictEqual(sorted(P.transport.trace), sorted(L.trace));
          if ((L.value as any).__meta.safeToCache) seen.safe++; else seen.unsafe++;
          for (const v of Object.values(L.value as Record<string, any>)) {
            if (v && v.latest && v.latest.holdings) seen.holdings++;
            if (v && v.latest && v.latest.holdings === null) seen.nullHoldings++;
          }
          for (const filer of Object.keys(INSTITUTIONAL_13F_FILERS)) {
            const cik = INSTITUTIONAL_13F_FILERS[filer];
            const Ls = legacy(freshEnv(), ex, NOW, (o) => o.call('fetch13FForFilerV7_', cik, cusip));
            const Ps = portDeps(freshEnv(), ex, NOW);
            assert.deepStrictEqual(structuredClone(await fetch13FForFiler(Ps.deps, cik, cusip)), Ls.value, 'sequential ' + filer);
            assert.deepStrictEqual(Ps.transport.trace, Ls.trace, 'sequential requests ' + filer);
          }
        }
      }
    }
    for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, k + ' never reached');
    // fetch13FInfoTableUrlV7_ has no try: a failure throws on both sides.
    const L = legacy(freshEnv(), [], NOW, (o) => o.call('fetch13FInfoTableUrlV7_', '93751', '0001-26-000001'));
    await assert.rejects(fetch13FInfoTableUrl(portDeps(freshEnv(), [], NOW).deps, '93751', '0001-26-000001'), (e: Error) => e.message === L.threw);
    const { ex } = universe(1, 'ok');
    assert.deepStrictEqual(structuredClone(await fetch13FSingleCik(portDeps(freshEnv(), ex, NOW).deps, '93751', TARGET)), legacy(freshEnv(), ex, NOW, (o) => o.call('fetch13FSingleCikV7_', '93751', TARGET)).value);
  });

  test('fetchInstitutional13FHoldingsV7: quarter-keyed cache hit, refetch when the quarter advances, never caching an SEC outage', async () => {
    const env = freshEnv();
    const steps: Array<[string, number, RecordedExchange[]]> = [
      ['cold, SEC down: result not cached', NOW, universe(9, 'allSubsFail').ex],
      ['cold, ok: cached under 2026Q2', NOW, universe(1, 'ok').ex],
      ['same quarter: cache hit, no requests', NOW + 20 * 86400000, []],
      ['quarter advanced: refetched and upserted', Date.parse('2026-11-20T12:00:00Z'), universe(2, 'messy').ex],
      ['no 13F anywhere: safe, cached', Date.parse('2027-03-01T12:00:00Z'), universe(11, 'no13F').ex],
    ];
    for (const [label, at, ex] of steps) {
      for (const cusip of [TARGET, 'OTHER9999']) {
        const L = legacy(env, ex, at, (o) => o.call('fetchInstitutional13FHoldingsV7', cusip));
        const P = portDeps(env, ex, at);
        assert.deepStrictEqual(structuredClone(await fetchInstitutional13FHoldings(P.deps, cusip)), L.value, label + ' ' + cusip);
        assertSameState(env, label + ' ' + cusip);
        if (label.startsWith('same quarter')) assert.deepStrictEqual(P.transport.trace, []);
      }
    }
    // A malformed cache cell is a miss on both sides.
    await env.store.write(Tabs.INSTITUTIONAL_HISTORY, 2, [[TARGET, '2027Q4', 'x', '{broken']]);
    env.ss.getSheetByName(Tabs.INSTITUTIONAL_HISTORY)!.getRange(2, 1, 1, 4).setValues([[TARGET, '2027Q4', 'x', '{broken']]);
    assert.deepStrictEqual(structuredClone(await read13FCache(env.store, TARGET)), legacy(env, [], NOW, (o) => o.call('read13FCacheV1_', TARGET)).value);
  });

  test('F-49: on a real Sheet a numeric-looking CUSIP loses its leading zero, so legacy never hits its own 13F cache and appends a row every run; the RAW port does not', async () => {
    const env = freshEnv('sheets');
    const cusip = '037833100';
    const data = { BlackRock: { latest: null, prior: null } };
    for (let k = 0; k < 3; k++) legacy(env, [], NOW, (o) => o.call('write13FCacheV1_', cusip, '2026Q2', data));
    const sh = env.ss.getSheetByName(Tabs.INSTITUTIONAL_HISTORY)!;
    assert.equal(sh.getLastRow(), 4, 'legacy: three rows for one CUSIP');
    assert.equal(sh.getRange(2, 1).getValue(), 37833100, 'the CUSIP was coerced to a number');
    assert.equal(legacy(env, [], NOW, (o) => o.call('read13FCacheV1_', cusip)).value, null, 'and never reads back');
    for (let k = 0; k < 3; k++) await write13FCache(env.store, cusip, '2026Q2', data, new Date(NOW));
    assert.equal(env.store.snapshot(Tabs.INSTITUTIONAL_HISTORY, 4)!.length, 2, 'port: one row');
    assert.ok(await read13FCache(env.store, cusip), 'and it reads back');
  });
});

describe('FL-4 — ETF top holdings', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('State Street .xlsx: unzip + shared strings + sheet parse match legacy on every shape', async () => {
    const r = rng(77);
    const make = (n: number): Array<[string, string, number | null]> => Array.from({ length: n }, (_, i) => ['Company & Co <' + i + '> "Q" \'' + i + '\'', 'T' + i, i === 4 ? null : Math.round((9 - i * 0.7 + r()) * 1000) / 1000]);
    const variants: Array<[string, number, Uint8Array | string]> = [
      ['deflated, 15 rows', 200, spdrXlsx(make(15), { footer: true })], ['stored, rich text', 200, spdrXlsx(make(12), { deflate: false, richText: true })],
      ['only 3 holdings', 200, spdrXlsx(make(3), { footer: true })], ['no holdings', 200, spdrXlsx([])], ['missing sheet1', 200, spdrXlsx(make(5), { missingSheet: true })],
      ['HTML error page with 200', 200, '<html>Access Denied</html>'], ['404', 404, ''],
    ];
    for (const ticker of ['SPY', 'XLRE', 'QQQ', 'spy']) {
      for (const [label, status, body] of variants) {
        const ex = [recordedGet(spdrHoldingsUrl(ticker), status, body)];
        const L = legacy(freshEnv(), ex, NOW, (o) => o.call('fetchSpdrEtfTopHoldingsV1', ticker));
        const P = portDeps(freshEnv(), ex, NOW);
        assert.deepStrictEqual(structuredClone(await fetchSpdrEtfTopHoldings(P.deps, ticker)), L.value, ticker + ' ' + label);
        assert.deepStrictEqual(P.transport.trace, L.trace);
      }
    }
    const o = loadOracle();
    const sst = '<sst><si><t>A&amp;B</t></si><si><r><t>Hel</t></r><r><t xml:space="preserve">lo</t></r></si><si><t/></si></sst>';
    assert.deepStrictEqual(parseSpdrSharedStrings(sst), o.callNormalized('parseSpdrSharedStringsV1_', sst));
    for (const c of ['<c r="A6" t="s"><v>1</v></c>', '<c r="E6"><v>7.25</v></c>', '<c r="B6"/>', '<c r="A6" t="s"><v>9</v></c>']) {
      assert.deepStrictEqual(spdrCellValue(c, ['x', 'y']), o.callNormalized('spdrCellValueV1_', c, ['x', 'y']));
    }
    const sheet = '<sheetData><row r="5"><c r="A5" t="s"><v>0</v></c></row><row r="6"><c r="A6" t="s"><v>0</v></c><c r="B6" t="s"><v>1</v></c><c r="E6"><v>3</v></c></row><row r="7"><c r="A7" t="s"><v>0</v></c></row><row r="8"><c r="A8" t="s"><v>1</v></c><c r="B8" t="s"><v>0</v></c></row></sheetData>';
    for (const n of [1, 2, 10]) assert.deepStrictEqual(parseSpdrHoldings(sheet, ['N', 'T'], n), o.callNormalized('parseSpdrHoldingsV1_', sheet, ['N', 'T'], n));
    assert.equal(SPDR_ETF_TICKERS.length, 12);
  });

  test('QQQ via NPORT-P: CIK lookup, newest NPORT-P, issuer summing, top 10, 30-day cache -- identical to legacy', async () => {
    const cik = '0001067839';
    const sub = 'https://data.sec.gov/submissions/CIK' + cik + '.json';
    const doc = (acc: string): string => 'https://www.sec.gov/Archives/edgar/data/1067839/' + acc.replace(/-/g, '') + '/primary_doc.xml';
    const records: Array<[string | null, string | null]> = [
      ['NVIDIA Corp', '9.1'], ['Apple Inc', '8.4'], ['Microsoft Corp', '8.0'], ['Alphabet Inc', '2.5'], [' Alphabet Inc ', '2.4'], ['Amazon.com Inc', '5.5'],
      ['Broadcom Inc', '5.0'], ['Meta Platforms Inc', '3.9'], ['Tesla Inc', '3.1'], ['Costco', '2.6'], ['Netflix', '2.2'], ['AMD', '1.6'], ['Cash', 'N/A'], [null, '1'], ['NoPct', null],
    ];
    const cases: Array<[string, RecordedExchange[]]> = [
      ['ok', [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(sub, 200, submissionsBody([['N-CSR', 'a-1', '2026-09-01'], ['NPORT-P', '0001752724-26-111111', '2026-08-28'], ['NPORT-P', '0001752724-26-000001', '2026-05-28']])), recordedGet(doc('0001752724-26-111111'), 200, nportXml(records))]],
      ['no NPORT-P', [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(sub, 200, submissionsBody([['N-CSR', 'a-1', '2026-09-01']]))]],
      ['doc 404', [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(sub, 200, submissionsBody([['NPORT-P', 'b-2', '2026-08-28']])), recordedGet(doc('b-2'), 404, '')]],
      ['empty doc', [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(sub, 200, submissionsBody([['NPORT-P', 'b-2', '2026-08-28']])), recordedGet(doc('b-2'), 200, nportXml([]))]],
      ['no CIK', [recordedGet('https://www.sec.gov/files/company_tickers.json', 500, '')]],
      ['submissions without filings', [recordedGet('https://www.sec.gov/files/company_tickers.json', 200, COMPANY_TICKERS), recordedGet(sub, 200, '{}')]],
    ];
    for (const [label, ex] of cases) {
      const env = freshEnv();
      for (const [t, at] of [['QQQ', NOW], ['QQQ', NOW + 86400000], ['SPY', NOW], ['QQQ', NOW + 31 * 86400000]] as Array<[string, number]>) {
        const L = legacy(env, ex, at, (o) => o.call('fetchQqqTopHoldingsV1', t));
        const P = portDeps(env, ex, at);
        assert.deepStrictEqual(structuredClone(await fetchQqqTopHoldings(P.deps, t)), L.value, label + ' ' + t + ' ' + at);
        assert.deepStrictEqual(P.transport.trace, L.trace, label + ' (requests)');
        assertSameState(env, label);
      }
    }
  });
});
