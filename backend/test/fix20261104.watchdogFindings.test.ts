/**
 * The watchdog's first real run (4 Nov 2026 Nightly) found three problems:
 *  1. MSTR's SEC shares-outstanding history "gave up" at ERROR: a two-class filer has no undimensioned
 *     CommonStockSharesOutstanding / EntityCommonStockSharesOutstanding (companyconcept 404) -> fallback concepts, and
 *     when none has data, ONE WARNING saying the screen is skipped.
 *  2. FMP ratios-ttm 402s repeated every night: the broker-data refresh (and the 13F CUSIP lookup) did not honour the
 *     remembered 402 -> every FMP caller skips a known 402 for 7 days.
 *  3. "GitHub minutes this month: ~0": billable timing missing / all 0 -> jobs, then the run duration, rounded up.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { fetchSharesOutstandingHistory, SHARES_OUTSTANDING_FALLBACKS } from '../src/fetch/sec/edgar.ts';
import { fetchStep } from '../src/core/fetchStep.ts';
import { TappingTransport } from '../src/net/httpTap.ts';
import { createContext } from '../src/core/context.ts';
import { Logger, LogLevel, type LogLine } from '../src/core/logger.ts';
import { refreshBrokerCourseDataCache, fetchFMPInterestCoverage } from '../src/fetch/macro/refresh.ts';
import { fmp402Key, FMP_402_TTL_MS } from '../src/fetch/fundamentals/providers.ts';
import { fetch13FCusip } from '../src/fetch/sec/thirteenF.ts';
import { readActionsMinutes, jobsMinutes, type FetchLike } from '../src/reports/digest/actionsMinutes.ts';

const NOW = Date.parse('2026-11-04T08:00:00Z');

class MapTransport implements HttpTransport {
  readonly urls: string[] = [];
  private readonly routes: Array<[string, number, string]>;
  constructor(routes: Array<[string, number, string]>) { this.routes = routes; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const r = this.routes.find(([k]) => req.url.includes(k));
    return new HttpResponse(r ? r[1] : 404, new TextEncoder().encode(r ? r[2] : ''));
  }
}
const httpOf = (t: HttpTransport): HttpClient => new HttpClient({ transport: t });
const ctxOf = (lines: LogLine[]) => createContext({
  mode: 'test', logger: new Logger({ minLevel: LogLevel.DEBUG, sink: (l) => { lines.push(l); } }), backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {},
  clock: { now: () => NOW },
});

/**
 * Shaped like MSTR's companyconcept answer for WeightedAverageNumberOfSharesOutstandingBasic (class A + B together,
 * no dimension): each 10-Q carries the quarter AND the year-to-date period with the same end; the 10-K the year.
 */
const MSTR_WA_BASIC = JSON.stringify({
  cik: 1050446, taxonomy: 'us-gaap', tag: 'WeightedAverageNumberOfSharesOutstandingBasic', entityName: 'Strategy Inc',
  units: { shares: [
    { start: '2024-01-01', end: '2024-12-31', val: 207_000_000, fy: 2024, fp: 'FY', form: '10-K', filed: '2025-02-18' },
    { start: '2025-01-01', end: '2025-03-31', val: 256_000_000, fy: 2025, fp: 'Q1', form: '10-Q', filed: '2025-05-05' },
    { start: '2025-04-01', end: '2025-06-30', val: 271_000_000, fy: 2025, fp: 'Q2', form: '10-Q', filed: '2025-08-04' },
    { start: '2025-01-01', end: '2025-06-30', val: 263_000_000, fy: 2025, fp: 'Q2', form: '10-Q', filed: '2025-08-04' },
    { start: '2025-07-01', end: '2025-09-30', val: 283_000_000, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-11-03' },
    { start: '2025-01-01', end: '2025-09-30', val: 270_000_000, fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-11-03' },
  ] },
});

describe('1. SEC shares-outstanding: two-class filers (MSTR)', () => {
  test('us-gaap and dei 404 -> the company-wide weighted-average basic shares; the quarter wins over year-to-date', async () => {
    const t = new MapTransport([['/us-gaap/WeightedAverageNumberOfSharesOutstandingBasic', 200, MSTR_WA_BASIC]]);
    const h = await fetchSharesOutstandingHistory({ http: httpOf(t) }, '0001050446', { deiFallback: true });
    assert.deepEqual(h, [
      { date: '2024-12-31', value: 207_000_000 }, { date: '2025-03-31', value: 256_000_000 },
      { date: '2025-06-30', value: 271_000_000 }, { date: '2025-09-30', value: 283_000_000 },
    ]);
    assert.equal(t.urls.length, 3, 'us-gaap, dei, then weighted-average basic');
    assert.equal(SHARES_OUTSTANDING_FALLBACKS[0], 'dei/EntityCommonStockSharesOutstanding');
  });

  test('a provider failure on a fallback is not read as "no concept"; legacy stops at the first 404', async () => {
    const t = new MapTransport([['/dei/', 503, '']]);
    assert.equal(await fetchSharesOutstandingHistory({ http: httpOf(t) }, '0001050446', { deiFallback: true }), null);
    assert.equal(t.urls.length, 2);
    const legacy = new MapTransport([['/us-gaap/WeightedAverageNumberOfSharesOutstandingBasic', 200, MSTR_WA_BASIC]]);
    assert.equal(await fetchSharesOutstandingHistory({ http: httpOf(legacy) }, '0001050446'), null);
    assert.equal(legacy.urls.length, 1);
  });

  test('no concept at all: ONE WARNING that the screen is skipped, no ERROR', async () => {
    const lines: LogLine[] = [];
    const ctx = ctxOf(lines);
    const tap = new TappingTransport(new MapTransport([]));
    const http = httpOf(tap);
    const r = await fetchStep({ ctx, tap }, { key: 'dilutionScreen', source: 'SEC shares-outstanding history MSTR', noDataNote: 'skipped for this ticker' },
      () => fetchSharesOutstandingHistory({ http }, '0001050446', { deiFallback: true }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'NO_DATA_FOR_TICKER');
    assert.equal(lines.filter((l) => l.level >= LogLevel.ERROR).length, 0);
    const warns = lines.filter((l) => l.level === LogLevel.WARNING);
    assert.deepEqual(warns.map((l) => l.message), ['SEC shares-outstanding history MSTR found no data [NO_DATA_FOR_TICKER]: skipped for this ticker']);
  });

  test('without the note (every other step) the old ERROR stays', async () => {
    const lines: LogLine[] = [];
    await fetchStep({ ctx: ctxOf(lines) }, { key: 'darkPool', source: 'FINRA' }, async () => null);
    assert.ok(lines.some((l) => l.level === LogLevel.ERROR && l.message.startsWith('FINRA gave up')));
  });
});

describe('2. FMP: every caller honours the remembered 402', () => {
  const base = { store: new MemoryTabStore(), fmpKey: 'k', timeZone: 'America/New_York', clock: { now: () => NOW }, plainText: true };

  test('broker-data ratios-ttm: the first 402 is remembered; the next run does not ask and logs at INFO', async () => {
    const kv = new MemoryPropertyStore();
    const t = new MapTransport([['financialmodelingprep.com', 402, 'Premium'], ['api.nasdaq.com', 404, '']]);
    await refreshBrokerCourseDataCache({ ...base, http: httpOf(t), kv, fmp402Memory: true }, 'MSTR', () => {});
    assert.equal(t.urls.filter((u) => u.includes('financialmodelingprep')).length, 1);
    assert.ok(Number(await kv.get(fmp402Key('ratios-ttm', 'MSTR'))) === NOW);
    const logs: string[] = [];
    const t2 = new MapTransport([['financialmodelingprep.com', 402, 'Premium']]);
    let why = '';
    assert.equal(await fetchFMPInterestCoverage({ http: httpOf(t2), kv, fmpKey: 'k', clock: { now: () => NOW + 86400000 }, fmp402Memory: true, log: (m) => logs.push(m) }, 'MSTR', (r) => { why = r; }), null);
    assert.equal(t2.urls.length, 0, 'a known 402 is not asked again');
    assert.match(why, /402, remembered/);
    assert.match(logs[0] ?? '', /not on the free plan for MSTR \(HTTP 402 within 7 days\) -- skipped/);
    assert.doesNotMatch(logs[0] ?? '', /^\s*⚠/, 'INFO, not WARNING');
    // After 7 days it asks again.
    const t3 = new MapTransport([['financialmodelingprep.com', 402, 'Premium']]);
    await fetchFMPInterestCoverage({ http: httpOf(t3), kv, fmpKey: 'k', clock: { now: () => NOW + FMP_402_TTL_MS + 1 }, fmp402Memory: true }, 'MSTR');
    assert.equal(t3.urls.length, 1);
  });

  test('a 402 remembered by fetchFMPFundamentals (same key) is honoured by the broker-data refresh; legacy always asks', async () => {
    const kv = new MemoryPropertyStore();
    await kv.set(fmp402Key('ratios-ttm', 'MSTR'), String(NOW - 3600000));
    const t = new MapTransport([['financialmodelingprep.com', 402, 'Premium']]);
    await fetchFMPInterestCoverage({ http: httpOf(t), kv, fmpKey: 'k', clock: { now: () => NOW }, fmp402Memory: true }, 'MSTR');
    assert.equal(t.urls.length, 0);
    await fetchFMPInterestCoverage({ http: httpOf(t), kv, fmpKey: 'k', clock: { now: () => NOW } }, 'MSTR');
    assert.equal(t.urls.length, 1);
  });

  test('13F CUSIP lookup: FMP profile 402 remembered and skipped', async () => {
    const kv = new MemoryPropertyStore();
    const t = new MapTransport([['financialmodelingprep.com', 402, 'Premium']]);
    const deps = { http: httpOf(t), kv, fmpKey: 'k', clock: { now: () => NOW }, fmp402Memory: true };
    assert.equal(await fetch13FCusip(deps, 'MSTR'), null);
    assert.equal(await fetch13FCusip(deps, 'MSTR'), null);
    assert.equal(t.urls.length, 1);
  });
});

describe('3. GitHub minutes: billable missing or 0', () => {
  const ENV = { GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: 'owner/TradingAnalyzerBackEnd' };
  const run = (id: number, startIso: string, mins: number, extra: Record<string, unknown> = {}) =>
    ({ id, status: 'completed', conclusion: 'success', run_started_at: startIso, updated_at: new Date(Date.parse(startIso) + mins * 60_000).toISOString(), ...extra });
  const fake = (runs: unknown[], timing: (id: number) => unknown, jobs: (id: number) => unknown) => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const u = new URL(url);
      const tm = /\/runs\/(\d+)\/timing$/.exec(u.pathname), jm = /\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      const body = tm ? timing(Number(tm[1])) : jm ? jobs(Number(jm[1])) : { total_count: runs.length, workflow_runs: runs };
      if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetchImpl, urls };
  };
  const job = (startIso: string, secs: number, conclusion = 'success') => ({ conclusion, started_at: startIso, completed_at: new Date(Date.parse(startIso) + secs * 1000).toISOString() });

  test('{billable:{}} and all-zero billable -> each job rounded up; no jobs -> the run duration rounded up', async () => {
    const runs = [
      run(1, '2026-11-02T03:23:00Z', 8.2),
      run(2, '2026-11-03T03:23:00Z', 8.5),
      run(3, '2026-11-04T03:23:00Z', 2.5),
      run(4, '2026-11-04T05:00:00Z', 0.05), // a 3-second run: a 0 is believed
    ];
    const gh = fake(runs, (id) => (id === 1 ? { billable: {} }
      : id === 2 ? { billable: { UBUNTU: { total_ms: 0, jobs: 2, job_runs: [{ job_id: 1, duration_ms: 0 }, { job_id: 2, duration_ms: 0 }] } } }
      : id === 3 ? { billable: {}, run_duration_ms: 150_000 }
      : { billable: { UBUNTU: { total_ms: 0, jobs: 1, job_runs: [{ job_id: 1, duration_ms: 0 }] } } }),
    (id) => (id === 1 ? { total_count: 2, jobs: [job('2026-11-02T03:23:05Z', 30), job('2026-11-02T03:24:00Z', 7 * 60 + 1)] }
      : id === 2 ? { total_count: 3, jobs: [job('2026-11-03T03:23:05Z', 8 * 60 + 10), job('2026-11-03T03:31:30Z', 0, 'skipped'), job('2026-11-03T03:31:00Z', 20)] }
      : 403));
    const r = await readActionsMinutes({ env: ENV, now: NOW, fetchImpl: gh.fetchImpl });
    // run 1: 1 + 8; run 2: 9 + 1; run 3: no jobs -> run_duration_ms 2.5 min -> 3; run 4: 0
    assert.equal(r.minutes, 9 + 10 + 3 + 0);
    assert.equal(r.jobCalls, 3);
    assert.ok(!gh.urls.some((u) => u.includes('/runs/4/jobs')), 'a run of a few seconds is not looked up');
  });

  test('jobsMinutes: skipped / unfinished jobs left out; no timing = null', () => {
    assert.equal(jobsMinutes({ jobs: [job('2026-11-02T03:23:00Z', 61), { conclusion: null, started_at: '2026-11-02T03:23:00Z', completed_at: null }] }), 2);
    assert.equal(jobsMinutes({ jobs: [] }), null);
    assert.equal(jobsMinutes(null), null);
  });
});
