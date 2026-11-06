/**
 * Fix 2026-11-05: SEC full-text search (efts.sec.gov/LATEST/search-index) answered HTTP 500 a few times a night
 * (live logs 4 and 5 Nov). edgar.ts turned that into a null count with no retry, and filingKeywordReadV1 skipped
 * nulls, so the dilution screen could say "No recent filings match ..." and report ok: a false clean result.
 *  a) 5xx / network errors on one keyword's search are retried twice with a short backoff (parity: one try).
 *  b) a keyword still unanswered is named ("could not check: offering, shelf") and the section is degraded.
 *  c) when every keyword answers, the read and the status are unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { fetchSecFilingKeywordHits, SEC_DILUTION_KEYWORDS, KEYWORD_SEARCH_RETRIES } from '../src/fetch/sec/edgar.ts';
import { filingKeywordRead, filingKeywordReadV1 } from '../src/analysis/models/brokerCourse/screens.ts';
import { fundamentalsScreenReadV1 } from '../src/analysis/models/brokerCourse/fundamentals.ts';
import { Logger, LogLevel } from '../src/core/logger.ts';
import { createContext } from '../src/core/context.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { runTickerAnalysisDetailed, ANALYSIS_TAB, type TickerAnalysisDeps } from '../src/analysis/runTicker.ts';
import { getOrCreate } from '../src/reports/options/tabs.ts';
import { loadRawFixture, fixturesPresent, type RawFixture } from './fixtures.ts';

const NOW = Date.UTC(2026, 10, 5, 8, 0);
const CIK = '0000320193';

type Answer = number | 'throw' | { status: number; body: string };
const ok = (total: number): Answer => ({ status: 200, body: JSON.stringify({ hits: { total: { value: total } } }) });

/** Per keyword, a queue of answers (the last one repeats). */
class ScriptedSec implements HttpTransport {
  readonly calls: string[] = [];
  private readonly script: Record<string, Answer[]>;
  constructor(script: Record<string, Answer[]>) { this.script = script; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const kw = decodeURIComponent(new URL(req.url).searchParams.get('q') ?? '').replace(/"/g, '');
    this.calls.push(kw);
    const q = this.script[kw] ?? [ok(0)];
    const a = q.length > 1 ? q.shift()! : q[0]!;
    if (a === 'throw') throw new Error('socket hang up');
    if (typeof a === 'number') return new HttpResponse(a, new TextEncoder().encode('Internal Server Error'));
    return new HttpResponse(a.status, new TextEncoder().encode(a.body));
  }
}

const allOk = (): Record<string, Answer[]> => ({ offering: [ok(2)], shelf: [ok(0)], warrants: [ok(1)], convertible: [ok(3)], dilution: [ok(0)] });

async function search(script: Record<string, Answer[]>, retries?: number) {
  const t = new ScriptedSec(script);
  const sleeps: number[] = [];
  const hits = await fetchSecFilingKeywordHits({ http: new HttpClient({ transport: t }), clock: { now: () => NOW } }, CIK, '2025-11-05',
    { ...(retries !== undefined ? { retries } : {}), sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  return { hits, calls: t.calls, sleeps };
}

describe('a) the keyword search retries 5xx and network errors', () => {
  test('all 200: one call per keyword, no waits, counts as before', async () => {
    const r = await search(allOk());
    assert.deepEqual(r.calls, [...SEC_DILUTION_KEYWORDS]);
    assert.deepEqual(r.sleeps, []);
    assert.deepEqual(r.hits, { offering: 2, shelf: 0, warrants: 1, convertible: 3, dilution: 0 });
  });

  test('500 then 200: the keyword is answered after one retry with a short backoff', async () => {
    const r = await search({ ...allOk(), offering: [500, ok(4)], shelf: ['throw', ok(0)] });
    assert.deepEqual(r.hits, { offering: 4, shelf: 0, warrants: 1, convertible: 3, dilution: 0 });
    assert.deepEqual(r.calls, ['offering', 'offering', 'shelf', 'shelf', 'warrants', 'convertible', 'dilution']);
    assert.deepEqual(r.sleeps, [500, 500]);
  });

  test('persistent 500: 1 + 2 tries, then null', async () => {
    const r = await search({ ...allOk(), offering: [500], shelf: [503] });
    assert.equal(KEYWORD_SEARCH_RETRIES, 2);
    assert.equal(r.calls.filter((k) => k === 'offering').length, 3);
    assert.equal(r.calls.filter((k) => k === 'shelf').length, 3);
    assert.deepEqual(r.sleeps, [500, 1000, 500, 1000]);
    assert.deepEqual(r.hits, { offering: null, shelf: null, warrants: 1, convertible: 3, dilution: 0 });
  });

  test('4xx is not retried; retries: 0 (legacy parity) is one try', async () => {
    const r404 = await search({ ...allOk(), offering: [404] });
    assert.equal(r404.calls.filter((k) => k === 'offering').length, 1);
    assert.equal(r404.hits!.offering, null);
    const legacy = await search({ ...allOk(), offering: [500, ok(4)] }, 0);
    assert.equal(legacy.calls.filter((k) => k === 'offering').length, 1);
    assert.equal(legacy.hits!.offering, null);
    assert.deepEqual(legacy.sleeps, []);
  });
});

describe('b/c) the read names unchecked keywords; unchanged when all answer', () => {
  test('all answered: identical to filingKeywordReadV1 (both arms)', () => {
    const cases: Array<Record<string, number | null>> = [{ offering: 2, shelf: 0, warrants: 1, convertible: 3, dilution: 0 }, { offering: 0, shelf: 0, warrants: 0, convertible: 0, dilution: 0 }, {}];
    for (const h of cases) {
      assert.deepStrictEqual(filingKeywordRead(h), filingKeywordReadV1(h));
    }
    assert.equal(filingKeywordRead(null), null);
  });

  test('persistent 500 with no hits elsewhere: never "No recent filings match the course\'s red-flag keyword list"', () => {
    const r = filingKeywordRead({ offering: null, shelf: null, warrants: 0, convertible: 0, dilution: 0 })!;
    assert.equal(r.anyFound, false);
    assert.deepEqual(r.uncheckedKeywords, ['offering', 'shelf']);
    assert.match(r.read, /could not check: offering, shelf/);
    assert.match(r.read, /\(warrants, convertible, dilution\)/);
    assert.doesNotMatch(r.read, /red-flag keyword list/);
  });

  test('nothing answered, and found + unchecked', () => {
    const none = filingKeywordRead({ offering: null, shelf: null, warrants: null, convertible: null, dilution: null })!;
    assert.match(none.read, /^Filing keyword search incomplete — could not check: offering, shelf, warrants, convertible, dilution/);
    const mixed = filingKeywordRead({ offering: 3, shelf: null, warrants: 0, convertible: 0, dilution: 0 })!;
    assert.equal(mixed.anyFound, true);
    assert.match(mixed.read, /^Recent filings mention: offering .*Word presence only.* Also could not check: shelf/);
  });

  test('the broker report fundamentals screen carries the same text', () => {
    const s = fundamentalsScreenReadV1(0.1, null, new Date(NOW), undefined, { offering: null, shelf: 0, warrants: 0, convertible: 0, dilution: 0 });
    assert.match(s.filingKeywordSearch, /could not check: offering/);
    const clean = fundamentalsScreenReadV1(0.1, null, new Date(NOW), undefined, { offering: 0, shelf: 0, warrants: 0, convertible: 0, dilution: 0 });
    assert.equal(clean.filingKeywordSearch, 'No recent filings match the course\'s red-flag keyword list');
  });
});

function tailChart(raw: RawFixture, n: number, ticker = raw.ticker) {
  const len = raw.closes.length, from = Math.max(0, len - n);
  const sl = <T,>(a: T[] | undefined, d: T[]): T[] => (a ?? d).slice(from);
  const closes = raw.closes.slice(from);
  const dates = raw.dates.slice(from).map((d) => new Date(d + 'T00:00:00Z'));
  return {
    ticker, dates, opens: sl(raw.opens, raw.closes), highs: sl(raw.highs, raw.closes), lows: sl(raw.lows, raw.closes), closes,
    volumes: sl(raw.volumes, raw.closes.map(() => 0)), splits: [],
    ipoDate: new Date(raw.dates[0] + 'T00:00:00Z'), currentPrice: closes[closes.length - 1], prevClose: closes[closes.length - 2], currency: 'USD',
  };
}

describe('b/c) runTicker: dilutionScreen degraded when a keyword could not be checked', { skip: fixturesPresent() ? false : 'price fixtures not present' }, () => {
  const run = async (hits: Record<string, number | null>) => {
    const charts: Record<string, unknown> = { TSLA: tailChart(loadRawFixture('TSLA'), 504), SPY: tailChart(loadRawFixture('SPY'), 504), '^VIX': tailChart(loadRawFixture('_VIX'), 300, '^VIX') };
    const book = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    const ctx = createContext({ mode: 'test', runId: 'sec', logger: new Logger({ minLevel: LogLevel.ERROR, sink: () => {}, scope: 'nightly', now: () => new Date(0) }), clock: { now: () => NOW }, sleep: async () => {}, random: () => 0, backoffBaseMs: 1, backoffMaxMs: 2 });
    const deps: TickerAnalysisDeps = {
      ss: book, timeZone: 'America/New_York', clock: { now: () => NOW }, ctx,
      fetchYahooChart: async (t) => (charts[t] ? structuredClone(charts[t]) : null) as never,
      fetchLongRangeCloses: async () => null,
      gatherFundamentals: async () => ({ fund: null, source: 'none' }) as never,
      fundamentalsStore: new MemoryPropertyStore(),
      fetchPeerMetrics: async (syms) => new Map(syms.map((x) => [x, null as never])),
      getTickerDarkPoolShare: async () => null,
      getCachedMacroRegime: async () => ({ available: true, regime: 'RISK_ON' }),
      readBrokerDataCache: async () => null,
      fetchSecEdgarCIK: async () => CIK,
      fetchSharesOutstandingHistory: async () => null,
      fetchSecFilingKeywordHits: async () => structuredClone(hits),
      getCachedRelativeStrengthRanking: async () => null,
      fetchGeminiReview: async () => null,
      aiUnavailable: true,
      buildBrokerCourseReport: async () => null,
      render: { dashboard: () => { getOrCreate(book, ANALYSIS_TAB); }, failureSheet: () => { getOrCreate(book, ANALYSIS_TAB); }, textReport: () => {} },
    };
    return runTickerAnalysisDetailed(deps, 'TSLA');
  };

  test('all keywords answered: ok, as before', async () => {
    const art = await run({ offering: 0, shelf: 0, warrants: 0, convertible: 0, dilution: 0 });
    assert.equal(art.status.dilutionScreen.state, 'ok');
  });

  test('persistent 500 on two keywords: degraded, naming them', async () => {
    const art = await run({ offering: null, shelf: null, warrants: 0, convertible: 0, dilution: 0 });
    assert.equal(art.status.dilutionScreen.state, 'degraded');
    assert.equal(art.status.dilutionScreen.detail, 'SEC full-text search could not check: offering, shelf');
    assert.equal(art.status.dilutionScreen.reasonCode, 'PROVIDER_NO_RESPONSE');
  });
});
