/**
 * FL-2: the fundamentals fetch layer and the fundamental (OWN) score.
 *
 * Every fetcher is compared with the oracle on the same synthetic replies
 * (test/fundamentalsFixtures.ts): returned value, every log line, and the
 * exact sequence of requests. The legacy side runs the VERBATIM legacy
 * source (dataLayerV1.gs ranges, read from the checksum-frozen file) compiled
 * in the oracle's realm with its three key constants as parameters, so
 * "key missing" branches are reachable without editing legacy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { listFixtures } from './fixtures.ts';
import { SCENARIOS, goodBodies, exchangesOf, peerMetricReply, makeSeries, rng, seedOf, ok } from './fundamentalsFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey, scrubUrl,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { startOfDayInTz, localeDateLabel } from '../src/core/dates.ts';
import { providerKeysFromEnv, providerKeyValues, type ProviderKeys } from '../src/fetch/providerKeys.ts';
import {
  fetchFinnhubFundamentals, fetchAlphaVantageFundamentals, fetchFMPFundamentals, fetchEarningsCalendar,
  fetchInsiderTradingNet, fetchTreasuryRate10Y, type FundamentalsDeps,
} from '../src/fetch/fundamentals/providers.ts';
import { gatherFundamentals, mergeProviderFundamentals, coefficientOfVariation, classifyCV } from '../src/fetch/fundamentals/merge.ts';
import { gatherFundamentalsV7, fetchPeerBasicMetrics, fetchPeerMetricsFor, PEER_CONFIG, PEER_CACHE_PREFIX } from '../src/fetch/fundamentals/v7.ts';
import { resolveFundamentals } from '../src/fetch/fundamentals/resolve.ts';
import { seriesLatest, seriesArray } from '../src/fetch/finnhubSeries.ts';
import {
  computeFundamentalScore, peerSymbolsForScore, sectorProfile, floatTier, trendStats, percentileRank,
} from '../src/analysis/fundamentalScore.ts';
import type { PeerBasicMetrics, ProviderFundamentals } from '../src/types/fundamentals.ts';

const ready = legacyFilesPresent();
const KEY = 'fl2-test-key';
const KEYS: ProviderKeys = { fmp: KEY, alphaVantage: KEY, finnhub: KEY };
const NOW = Date.parse('2026-10-21T22:00:00Z');
const TZ = 'America/New_York';

/** Runs `fn` with the process zone set (both realms read it), restoring it after. */
async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

// ── the legacy side ─────────────────────────────────────────────────────

type LegacyFns = Record<string, (...a: unknown[]) => any>;
const bundles = new Map<string, LegacyFns>();

/** The verbatim legacy fetch functions, compiled with the three key constants as parameters. */
function legacyBundle(keys: ProviderKeys): LegacyFns {
  const id = JSON.stringify(keys);
  const hit = bundles.get(id);
  if (hit) return hit;
  const L = fs.readFileSync(path.join(LEGACY_DIR, 'dataLayerV1.gs'), 'utf8').split('\n');
  const at = (n: number): string => L[n - 1];
  assert.match(at(58), /^function gatherFundamentalsV7\(ticker, log\) \{$/);
  assert.equal(at(117), '}');
  assert.match(at(405), /^function gatherFundamentals\(ticker, log\) \{$/);
  assert.match(at(639), /^function fetchEarningsCalendarV7\(/);
  assert.equal(at(674), '}');
  assert.match(at(1051), /^function fetchInsiderTradingNet\(/);
  assert.match(at(1233), /^function fetchAlphaVantageFundamentals\(/);
  assert.match(at(1286), /^function getCachedFundamentals\(/);
  assert.equal(at(1292), '}');
  const src = [L.slice(57, 117), L.slice(404, 674), L.slice(1050, 1292)].map((x) => x.join('\n')).join('\n');
  const F = loadOracle().fns.setStatusV7.constructor as new (...a: string[]) => (...x: unknown[]) => LegacyFns;
  const names = ['gatherFundamentalsV7', 'fetchPeerBasicMetricsV7', 'gatherFundamentals', 'fetchFinnhubFundamentals', 'fetchEarningsCalendarV7',
    'fetchInsiderTradingNet', 'fetchTreasuryRate10Y', 'fetchFMPFundamentals', 'fetchAlphaVantageFundamentals', 'getCachedFundamentals', 'saveFundamentalsCache'];
  const fns = new F('FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', src + '\nreturn {' + names.join(', ') + '};')(keys.fmp, keys.alphaVantage, keys.finnhub);
  bundles.set(id, fns);
  return fns;
}

/** runAnalysisV7's fundamentals step, verbatim (fullStockAnalysisV10_9.gs:956-983). */
function legacyResolveBlock(): (...a: unknown[]) => any {
  const lines = fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n');
  assert.equal(lines[955], "    let fund = null, fundSource = 'none';", 'block start moved');
  assert.match(lines[980], /No fundamentals — technical only/, 'block end moved');
  assert.equal(lines[981], '      }');
  assert.equal(lines[982], '    }');
  const F = loadOracle().fns.setStatusV7.constructor as new (...a: string[]) => (...x: unknown[]) => any;
  return new F('ticker', 'log', 'gatherFundamentalsV7', 'saveFundamentalsCache', 'getCachedFundamentals', 'setStatusV7', 'status',
    lines.slice(955, 983).join('\n') + '\nreturn { fund, fundSource };');
}

interface Observed {
  readonly value: any;
  readonly logs: string[];
  readonly trace: string[];
}

function tracingUrlFetchApp(book: ExchangeBook, trace: string[]): Record<string, unknown> {
  const inner = replayUrlFetchApp(book) as { fetch: (u: string, p?: { method?: string }) => unknown };
  return { fetch: (url: string, params?: { method?: string }) => { trace.push(exchangeKey(params?.method, url)); return inner.fetch(url, params); } };
}

function runLegacy(keys: ProviderKeys, exchanges: readonly RecordedExchange[], call: (fns: LegacyFns, log: (m: string) => void) => unknown, props = new FakeProperties(new Map(), false)): Observed {
  const logs: string[] = [];
  const trace: string[] = [];
  const fns = legacyBundle(keys);
  const value = withOracleGlobals(
    { UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(exchanges), trace), PropertiesService: fakePropertiesService(props), Date: pinnedDateClass(NOW) },
    () => call(fns, (m) => logs.push(m)),
  );
  return { value: structuredClone(value), logs, trace };
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

function portDeps(keys: ProviderKeys, exchanges: readonly RecordedExchange[]): { deps: FundamentalsDeps; transport: TracingTransport } {
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(exchanges)));
  return { transport, deps: { http: new HttpClient({ transport }), keys, timeZone: TZ, clock: { now: () => NOW }, dateLabel: (d) => d.toLocaleDateString() } };
}

async function runPort(keys: ProviderKeys, exchanges: readonly RecordedExchange[], call: (deps: FundamentalsDeps, log: (m: string) => void) => Promise<unknown>): Promise<Observed & { urls: string[] }> {
  const logs: string[] = [];
  const { deps, transport } = portDeps(keys, exchanges);
  const value = await call(deps, (m) => logs.push(m));
  return { value: structuredClone(value), logs, trace: transport.trace, urls: transport.urls };
}

function scenarioExchanges(ticker: string, s: (typeof SCENARIOS)[number]): RecordedExchange[] {
  const good = goodBodies(ticker, { now: NOW, ...(s.gen ?? {}) });
  return exchangesOf(ticker, { ...good, ...(s.replies ? s.replies(good) : {}) });
}

const TICKERS = (): string[] => listFixtures().map((t) => (t === '_VIX' ? '^VIX' : t));
const scenario = (name: string): (typeof SCENARIOS)[number] => SCENARIOS.find((s) => s.name.startsWith(name))!;

// ── the tests ───────────────────────────────────────────────────────────

describe('FL-2a — provider fetchers', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('each fetcher matches legacy on every ticker and scenario: value, log lines, and the exact request sequence', async () => {
    await inZone(TZ, async () => {
      let compared = 0;
      const pairs: Array<[string, (f: LegacyFns, t: string, log: (m: string) => void) => unknown, (d: FundamentalsDeps, t: string, log: (m: string) => void) => Promise<unknown>]> = [
        ['finnhub', (f, t, log) => f.fetchFinnhubFundamentals(t, log), (d, t, log) => fetchFinnhubFundamentals(d, t, log)],
        ['alphavantage', (f, t, log) => f.fetchAlphaVantageFundamentals(t, log), (d, t, log) => fetchAlphaVantageFundamentals(d, t, log)],
        ['fmp', (f, t, log) => f.fetchFMPFundamentals(t, log), (d, t, log) => fetchFMPFundamentals(d, t, log)],
        ['earnings', (f, t, log) => f.fetchEarningsCalendarV7(t, log), (d, t, log) => fetchEarningsCalendar(d, t, log)],
        ['earnings, no logger', (f, t) => f.fetchEarningsCalendarV7(t, null), (d, t) => fetchEarningsCalendar(d, t, null)],
        ['insider', (f, t, log) => f.fetchInsiderTradingNet(t, log), (d, t, log) => fetchInsiderTradingNet(d, t, log)],
        ['treasury', (f, _t, log) => f.fetchTreasuryRate10Y(log), (d, _t, log) => fetchTreasuryRate10Y(d, log)],
      ];
      for (const ticker of TICKERS()) {
        for (const s of SCENARIOS) {
          const ex = scenarioExchanges(ticker, s);
          for (const [name, leg, port] of pairs) {
            const L = runLegacy(KEYS, ex, (f, log) => leg(f, ticker, log));
            const P = await runPort(KEYS, ex, (d, log) => port(d, ticker, log));
            const where = `${ticker} / ${s.name} / ${name}`;
            assert.deepStrictEqual(P.value, L.value, where);
            assert.deepStrictEqual(P.logs, L.logs, where + ' (logs)');
            assert.deepStrictEqual(P.trace, L.trace, where + ' (requests)');
            compared++;
          }
        }
      }
      assert.ok(compared > 5000, `only ${compared}`);
    });
  });

  test('keys come from the injected config: they reach the URLs, and empty keys skip exactly what legacy skips (FMP is never skipped, F-40)', async () => {
    assert.deepStrictEqual(providerKeysFromEnv({ FMP_API_KEY: 'a', ALPHAVANTAGE_KEY: 'b', FINNHUB_KEY: 'c' }), { fmp: 'a', alphaVantage: 'b', finnhub: 'c' });
    assert.deepStrictEqual(providerKeysFromEnv({}), { fmp: '', alphaVantage: '', finnhub: '' });
    assert.deepStrictEqual(providerKeyValues({ fmp: 'a', alphaVantage: '', finnhub: 'c' }), ['a', 'c']);
    await inZone(TZ, async () => {
      const ex = scenarioExchanges('AMD', scenario('all good'));
      const P = await runPort(KEYS, ex, (d, log) => gatherFundamentalsV7(d, 'AMD', log));
      assert.ok(P.urls.length >= 14, String(P.urls.length));
      for (const u of P.urls) assert.ok(u.includes('=' + KEY), u);
      for (const u of P.urls) assert.equal(scrubUrl(u).includes(KEY), false, 'the recorder would scrub every key');
      for (const keys of [
        { fmp: KEY, alphaVantage: '', finnhub: KEY }, { fmp: KEY, alphaVantage: KEY, finnhub: '' },
        { fmp: KEY, alphaVantage: '', finnhub: '' }, { fmp: '', alphaVantage: '', finnhub: '' },
      ]) {
        for (const s of [scenario('all good'), scenario('FMP core all fail'), scenario('everything fails')]) {
          const ex2 = scenarioExchanges('PLTR', s);
          const L = runLegacy(keys, ex2, (f, log) => f.gatherFundamentalsV7('PLTR', log));
          const P2 = await runPort(keys, ex2, (d, log) => gatherFundamentalsV7(d, 'PLTR', log));
          assert.deepStrictEqual(P2.value, L.value, JSON.stringify(keys) + s.name);
          assert.deepStrictEqual(P2.logs, L.logs);
          assert.deepStrictEqual(P2.trace, L.trace);
          if (!keys.fmp) assert.ok(P2.trace.some((t) => t.includes('financialmodelingprep.com')), 'FMP is called even with no key (F-40)');
          if (!keys.alphaVantage) assert.equal(P2.trace.some((t) => t.includes('alphavantage.co')), false, 'AV skipped');
          if (!keys.finnhub) assert.equal(P2.trace.some((t) => t.includes('finnhub.io')), false, 'Finnhub skipped');
        }
      }
      // The provider functions' own key guards (reached only by direct calls).
      const none = { fmp: '', alphaVantage: '', finnhub: '' };
      assert.equal(runLegacy(none, ex, (f) => f.fetchFinnhubFundamentals('AMD', null)).value, null);
      assert.equal((await runPort(none, ex, (d) => fetchFinnhubFundamentals(d, 'AMD', null))).value, null);
      assert.equal(runLegacy(none, ex, (f) => f.fetchAlphaVantageFundamentals('AMD', null)).value, null);
      assert.equal((await runPort(none, ex, (d) => fetchAlphaVantageFundamentals(d, 'AMD', null))).value, null);
    });
  });

  test('"today" for the earnings calendar is local midnight in the script zone -- exactly what setHours(0,0,0,0) gives in that zone', async () => {
    const zones = ['America/New_York', 'Asia/Jerusalem', 'UTC', 'Europe/London', 'America/Santiago', 'America/Havana', 'Asia/Beirut', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Kolkata'];
    let checked = 0;
    for (const tz of zones) {
      await inZone(tz, () => {
        const r = rng(seedOf(tz));
        for (let k = 0; k < 800; k++) {
          const t = Date.parse('2025-12-25T00:00:00Z') + Math.floor(r() * 500 * 86_400_000);
          const d = new Date(t);
          d.setHours(0, 0, 0, 0);
          assert.equal(startOfDayInTz(new Date(t), tz).getTime(), d.getTime(), `${tz} ${new Date(t).toISOString()}`);
          checked++;
        }
      });
    }
    assert.ok(checked >= 8000);
    for (const tz of ['America/New_York', 'Asia/Jerusalem']) {
      await inZone(tz, async () => {
        const ex = scenarioExchanges('MQZC', scenario('all good'));
        const L = runLegacy(KEYS, ex, (f, log) => f.fetchEarningsCalendarV7('MQZC', log));
        const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
        const P = await fetchEarningsCalendar({ http: new HttpClient({ transport }), keys: KEYS, timeZone: tz, clock: { now: () => NOW } }, 'MQZC', () => {});
        assert.deepStrictEqual(structuredClone(P), L.value, tz);
        assert.ok(P.next, tz);
      });
    }
    assert.equal(localeDateLabel(new Date('2026-10-22T02:00:00Z'), 'America/New_York'), '10/21/2026');
    assert.equal(localeDateLabel(new Date('2026-10-22T02:00:00Z'), 'Asia/Jerusalem'), '10/22/2026');
  });
});

describe('FL-2a — the merge and the v7 wrapper', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('gatherFundamentals / gatherFundamentalsV7 match legacy on every ticker and scenario, and every merge rule is exercised', async () => {
    await inZone(TZ, async () => {
      const seen = { fine: 0, shaky: 0, untrustworthy: 0, crossRef: 0, periodNote: 0, premium: 0, rateLimited: 0, noFund: 0, profileOnly: 0, series: 0, peers: 0, peersNull: 0, threeSources: 0, zeroKept: 0 };
      let compared = 0;
      for (const ticker of TICKERS()) {
        for (const s of SCENARIOS) {
          const ex = scenarioExchanges(ticker, s);
          for (const v7 of [false, true]) {
            const L = runLegacy(KEYS, ex, (f, log) => (v7 ? f.gatherFundamentalsV7 : f.gatherFundamentals)(ticker, log));
            const P = await runPort(KEYS, ex, (d, log) => (v7 ? gatherFundamentalsV7 : gatherFundamentals)(d, ticker, log));
            const where = `${ticker} / ${s.name} / ${v7 ? 'v7' : 'v6'}`;
            assert.deepStrictEqual(P.value, L.value, where);
            assert.deepStrictEqual(P.logs, L.logs, where + ' (logs)');
            assert.deepStrictEqual(P.trace, L.trace, where + ' (requests)');
            compared++;
            const fund = L.value.fund;
            if (!fund) { seen.noFund++; continue; }
            for (const c of Object.values(fund._crossRefCV) as Array<{ band: 'fine' | 'shaky' | 'untrustworthy' }>) seen[c.band]++;
            if (fund._crossRef) seen.crossRef++;
            if (fund._crossRef?.some((x: string) => x.includes('periods differ'))) seen.periodNote++;
            if (fund._premiumBlocked) seen.premium++;
            if (fund._rateLimited) seen.rateLimited++;
            if (!fund._sources.length) seen.profileOnly++;
            if (fund._sources.length === 3) seen.threeSources++;
            if (Object.values(fund).some((v) => v === 0)) seen.zeroKept++;
            if (v7 && fund._metricSeries) seen.series++;
            if (v7 && fund._peersRaw?.length) seen.peers++;
            if (v7 && fund._peersRaw === null) seen.peersNull++;
          }
        }
      }
      assert.ok(compared > 1500, `only ${compared}`);
      for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} never reached`);
    });
  });

  test('the merge rules, pinned on hand-built provider results', () => {
    const base = (src: ProviderFundamentals['_source'], over: Record<string, unknown>): ProviderFundamentals => ({
      _source: src, forwardPE: null, trailingPE: null, pegRatio: null, priceToBook: null, profitMargins: null, grossMargins: null,
      returnOnEquity: null, returnOnAssets: null, revenueGrowth: null, earningsGrowth: null, beta: null, marketCap: null, dividend: null,
      price: null, sector: null, industry: null, targetMean: null, targetHigh: null, targetLow: null, numAnalysts: null, recMean: null,
      recKey: '', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, shortRatio: null, institutionPct: null,
      _premiumBlocked: false, _rateLimited: false, ...over,
    } as ProviderFundamentals);
    const m = mergeProviderFundamentals(
      base('fmp', { trailingPE: 20, targetMean: 100, recMean: 3, recKey: 'C', sector: '', _premiumBlocked: true }),
      base('alphavantage', { trailingPE: 30, targetMean: 120, recMean: 2, sector: 'Tech', strongBuy: 4 }),
      base('finnhub', { trailingPE: 50, recMean: 1, recKey: '' }),
    )!;
    assert.equal(m.trailingPE, 20, 'ratios: FMP first');
    assert.equal(m.targetMean, 100, 'targets: FMP -> AV -> Finnhub');
    assert.equal(m.recMean, 1, 'ratings: Finnhub first');
    assert.equal(m.recKey, 'C', 'an empty string is skipped, falling through the rating order to FMP');
    assert.equal(m.strongBuy, 0, "Finnhub's 0 is a value, not a gap");
    assert.equal(m.sector, 'Tech', "FMP's '' sector is skipped");
    assert.equal(m._premiumBlocked, true);
    assert.deepStrictEqual(m._sources, ['FMP', 'AV', 'Finnhub']);
    assert.ok(m._crossRef!.includes('P/E (trailing): FMP 20.00 vs AV 30.00 vs Finnhub 50.00'), JSON.stringify(m._crossRef));
    assert.ok(m._crossRef!.includes('Rating: FMP 3.00 vs AV 2.00 vs Finnhub 1.00'));
    assert.equal(m._crossRefCV.trailingPE.band, 'untrustworthy');
    assert.equal(mergeProviderFundamentals(null, null, null), null);
    assert.equal(coefficientOfVariation([1]), null);
    assert.equal(coefficientOfVariation([1, -1]), null, 'zero mean');
    assert.equal(classifyCV(0.0999), 'fine');
    assert.equal(classifyCV(0.1), 'shaky');
    assert.equal(classifyCV(0.25), 'untrustworthy');
    assert.equal(classifyCV(null), null);
  });

  test('peers: the 24-hour V7_PEER_ cache and every failure mode match legacy, store contents included', async () => {
    const r = rng(42);
    let compared = 0;
    const seen = { hit: 0, expired: 0, corrupt: 0, fetched: 0, failed: 0, logged: 0, noKey: 0 };
    for (let k = 0; k < 400; k++) {
      const sym = 'PEER' + (k % 37);
      const reply = peerMetricReply(sym, r);
      const ex: RecordedExchange[] = r() < 0.1 ? [] : [{ request: { method: 'GET', url: scrubUrl('https://finnhub.io/api/v1/stock/metric?symbol=' + sym + '&metric=all&token=K') }, response: { status: reply.status, bodyBase64: Buffer.from(reply.body).toString('base64') } }];
      const seed = new Map<string, string>();
      const p = r();
      if (p < 0.25) { seed.set(PEER_CACHE_PREFIX + sym, JSON.stringify({ t: NOW - 3600_000, data: { revenueGrowth: 0.1, grossMargins: 0.5, netMargin: 0.1, fcfMargin: 0.05, evSales: 4 } })); seen.hit++; }
      else if (p < 0.45) { seed.set(PEER_CACHE_PREFIX + sym, JSON.stringify({ t: NOW - 25 * 3600_000, data: { evSales: 1 } })); seen.expired++; }
      else if (p < 0.55) { seed.set(PEER_CACHE_PREFIX + sym, r() < 0.5 ? '{not json' : JSON.stringify({ data: { evSales: 1 } })); seen.corrupt++; }
      const keys = r() < 0.1 ? { ...KEYS, finnhub: '' } : KEYS;
      if (!keys.finnhub) seen.noKey++;
      const withLog = r() < 0.5;
      const legacyProps = new FakeProperties(new Map(seed), true);
      const logsL: string[] = [];
      const trace: string[] = [];
      const fns = legacyBundle(keys);
      const legacy = structuredClone(withOracleGlobals(
        { UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), PropertiesService: fakePropertiesService(legacyProps), Date: pinnedDateClass(NOW) },
        () => fns.fetchPeerBasicMetricsV7(sym, withLog ? (m: string) => logsL.push(m) : null),
      ));
      const store = new MemoryPropertyStore(new Map(seed));
      const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
      const logsP: string[] = [];
      const port = structuredClone(await fetchPeerBasicMetrics({ http: new HttpClient({ transport }), keys, store, clock: { now: () => NOW } }, sym, withLog ? (m) => logsP.push(m) : null));
      assert.deepStrictEqual(port, legacy, `${k} ${sym}`);
      assert.deepStrictEqual(logsP, logsL);
      assert.deepStrictEqual(transport.trace, trace);
      assert.deepStrictEqual([...store.map], [...legacyProps.map], 'identical cache contents');
      compared++;
      if (trace.length && legacy) seen.fetched++;
      if (trace.length && !legacy) seen.failed++;
      if (logsL.length) seen.logged++;
    }
    assert.equal(compared, 400);
    for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} never reached`);
    assert.deepStrictEqual(PEER_CONFIG, { max: 5, cacheHours: 24 });
  });

  test('runAnalysisV7\'s fundamentals step (:955-983): live, cache fallback and none -- same fund, source, statuses, logs and cache contents', async () => {
    const block = legacyResolveBlock();
    await inZone(TZ, async () => {
      const seen = { live: 0, cache: 0, none: 0, profileOnlyBeta: 0 };
      for (const ticker of TICKERS().slice(0, 12)) {
        for (const s of SCENARIOS) {
          for (const cached of [false, true]) {
            const ex = scenarioExchanges(ticker, s);
            const seed = new Map<string, string>();
            if (cached) seed.set('FUND_' + ticker, JSON.stringify({ data: { _sources: ['AV'], beta: 1.2, sector: 'Technology', _nextEarnings: { date: '2026-11-01T00:00:00.000Z', dateStr: '2026-11-01' } }, date: '10/20/2026' }));
            // Parity on the logic: no 9 KB cap on either side here (the cap is F-36's own test).
            const props = new FakeProperties(new Map(seed), false);
            const fns = legacyBundle(KEYS);
            const lLogs: string[] = [];
            const lStatus: unknown[] = [];
            const legacy = structuredClone(withOracleGlobals(
              { UrlFetchApp: replayUrlFetchApp(new ExchangeBook(ex)), PropertiesService: fakePropertiesService(props), Date: pinnedDateClass(NOW) },
              () => block(ticker, (m: string) => lLogs.push(m), fns.gatherFundamentalsV7, fns.saveFundamentalsCache, fns.getCachedFundamentals,
                (_s: unknown, k: string, st: string, d: string) => lStatus.push([k, st, d]), {}),
            ));
            const store = new MemoryPropertyStore(new Map(seed));
            const { deps } = portDeps(KEYS, ex);
            const pLogs: string[] = [];
            const pStatus: unknown[] = [];
            const port = structuredClone(await resolveFundamentals(ticker, {
              gather: (t, log) => gatherFundamentalsV7(deps, t, log), store, now: () => new Date(NOW), dateLabel: (d) => d.toLocaleDateString(),
              log: (m) => pLogs.push(m), setStatus: (k, st, d) => pStatus.push([k, st, d]),
            }));
            const where = `${ticker} / ${s.name} / cached=${cached}`;
            assert.deepStrictEqual(port, legacy, where);
            assert.deepStrictEqual(pLogs, lLogs, where);
            assert.deepStrictEqual(pStatus, lStatus, where);
            assert.deepStrictEqual([...store.map], [...props.map], where + ' (cache)');
            if (legacy.fundSource.startsWith('cache')) seen.cache++;
            else if (legacy.fundSource === 'none') seen.none++;
            else seen.live++;
            if (legacy.fund && !legacy.fund._sources.length && legacy.fund.beta != null && !legacy.fundSource.startsWith('cache')) seen.profileOnlyBeta++;
          }
        }
      }
      for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} never reached`);
    });
  });

  test('F-36: with a Finnhub series attached the record outgrows the 9 KB property cap -- legacy silently saves nothing, the port saves it, series and all', async () => {
    const block = legacyResolveBlock();
    await inZone(TZ, async () => {
      const good = goodBodies('NVDA', { now: NOW });
      const metric = JSON.parse(good['fh.metric'].body);
      metric.series = makeSeries(rng(7), { size: 40 });
      const ex = exchangesOf('NVDA', { ...good, 'fh.metric': ok(metric) });
      const props = new FakeProperties(new Map(), true);
      const fns = legacyBundle(KEYS);
      withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(new ExchangeBook(ex)), PropertiesService: fakePropertiesService(props), Date: pinnedDateClass(NOW) },
        () => block('NVDA', () => {}, fns.gatherFundamentalsV7, fns.saveFundamentalsCache, fns.getCachedFundamentals, () => {}, {}));
      assert.equal(props.map.has('FUND_NVDA'), false, 'legacy: the write threw "Argument too large" and was swallowed');
      const store = new MemoryPropertyStore();
      const { deps } = portDeps(KEYS, ex);
      await resolveFundamentals('NVDA', { gather: (t, log) => gatherFundamentalsV7(deps, t, log), store, now: () => new Date(NOW), dateLabel: (d) => d.toLocaleDateString() });
      const stored = store.map.get('FUND_NVDA')!;
      assert.ok(Buffer.byteLength(stored) > 9 * 1024);
      const saved = JSON.parse(stored);
      assert.ok(saved.data._metricSeries, 'the port keeps the series in the cache');
      assert.ok(Array.isArray(saved.data._peersRaw), 'and the peers');
      assert.equal(typeof saved.data._nextEarnings.date, 'string', 'Dates come back as ISO strings on a cache hit');
      // And the legacy comment at :961 is wrong in the other direction too: a SMALL record keeps series and peers.
      const small = new FakeProperties(new Map(), true);
      const metric2 = JSON.parse(good['fh.metric'].body);
      metric2.series = makeSeries(rng(8), { size: 2 });
      const ex2 = exchangesOf('NVDA', { ...good, 'fh.metric': ok(metric2), 'fmp.earnings': ok([]), 'fmp.insider': ok([]) });
      withOracleGlobals({ UrlFetchApp: replayUrlFetchApp(new ExchangeBook(ex2)), PropertiesService: fakePropertiesService(small), Date: pinnedDateClass(NOW) },
        () => block('NVDA', () => {}, fns.gatherFundamentalsV7, fns.saveFundamentalsCache, fns.getCachedFundamentals, () => {}, {}));
      const kept = JSON.parse(small.map.get('FUND_NVDA')!);
      assert.ok(kept.data._metricSeries && kept.data._peersRaw, 'legacy DOES cache series and peers when the record fits');
    });
  });
});

describe('FL-2b — the fundamental (OWN) score', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('the helpers match legacy', () => {
    const o = loadOracle();
    const r = rng(9);
    for (let k = 0; k < 3000; k++) {
      const series = makeSeries(r) as any;
      const key = ['salesPerShare', 'netMargin', 'grossMargin', 'fcfMargin', 'evRevenueTTM', 'nope'][Math.floor(r() * 6)];
      const flat = r() < 0.3 ? null : r() < 0.5 ? NaN : r();
      const avf = r() < 0.5 ? null : r();
      const s = r() < 0.1 ? null : r() < 0.05 ? { quarterly: { [key]: 'not an array' } } : series;
      assert.deepStrictEqual(seriesLatest(s, key, flat, avf), o.callNormalized('seriesLatestV7', s, key, flat, avf));
      const max = r() < 0.5 ? undefined : Math.floor(r() * 10);
      const arr = seriesArray(s, key, max);
      assert.deepStrictEqual(arr, o.callNormalized('seriesArrayV7', s, key, max));
      assert.deepStrictEqual(trendStats(arr), o.callNormalized('trendStatsV7', arr));
      const peers = Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.1 ? null : r() < 0.05 ? NaN : r() * 10));
      const v = r() < 0.1 ? null : r() * 10;
      const hb = r() < 0.5;
      assert.equal(percentileRank(v, peers, hb), o.call('percentileRankV7', v, peers, hb));
      const f = { sector: ['Technology', 'Software—Infrastructure', 'Banks', null, ''][Math.floor(r() * 5)], industry: r() < 0.5 ? 'Semiconductors' : null, marketCap: r() * 4e11, profitMargins: r() * 0.3 };
      assert.equal(sectorProfile(f), o.call('sectorProfileV7', f));
      const fl = r() < 0.1 ? null : r() < 0.05 ? NaN : r() * 8e7;
      assert.equal(floatTier(fl), o.call('floatTierV7', fl));
    }
    assert.equal(sectorProfile(null), o.call('sectorProfileV7', null));
    assert.equal(trendStats([]), null);
    // A numeric STRING passes legacy's isNaN check and comes back as the string.
    assert.equal(seriesLatest({ quarterly: { k: [{ v: '1.5' as unknown as number }] } }, 'k', null, null), '1.5');
  });

  test('computeFundamentalScoreV7 matches legacy on every merged fund and on 4,000 random funds; peers lifted out exactly; every branch reached', async () => {
    const o = loadOracle();
    const funds: unknown[] = [];
    await inZone(TZ, async () => {
      for (const ticker of TICKERS()) {
        for (const s of SCENARIOS) {
          const P = await runPort(KEYS, scenarioExchanges(ticker, s), (d, log) => gatherFundamentalsV7(d, ticker, log));
          funds.push(P.value.fund);
        }
      }
    });
    const r = rng(1234);
    const maybe = <T>(v: T, p = 0.25): T | null => (r() < p ? null : v);
    for (let k = 0; k < 4000; k++) {
      const peersRaw = r() < 0.2 ? null : Array.from({ length: Math.floor(r() * 7) }, (_, i) => (r() < 0.1 ? 'P' + Math.max(0, i - 1) : 'P' + i));
      const cvBand = ['fine', 'shaky', 'untrustworthy'][Math.floor(r() * 3)];
      funds.push({
        sector: maybe(['Technology', 'Healthcare', 'Communication Services', 'Utilities'][Math.floor(r() * 4)]),
        industry: maybe('Software'),
        marketCap: maybe(r() * 4e11),
        profitMargins: maybe(-0.5 + r()),
        revenueGrowth: maybe(-0.4 + r() * 1.2),
        returnOnEquity: maybe(-0.4 + r()),
        targetMean: maybe(10 + r() * 300),
        price: r() < 0.1 ? 0 : maybe(10 + r() * 300),
        recMean: maybe(1 + r() * 4),
        recKey: maybe(['Buy', 'Hold', '', 'Strong Buy'][Math.floor(r() * 4)]),
        forwardPE: maybe(-10 + r() * 80, 0.5),
        trailingPE: maybe(-10 + r() * 80),
        pegRatio: maybe(-1 + r() * 4),
        _metricSeries: r() < 0.15 ? null : makeSeries(r, r() < 0.3 ? { scale: { netMargin: -0.3 - r(), fcfPerShareTTM: -2 - r() * 3, cashPerShareTTM: r() * 3, evRevenueTTM: r() * 20 } } : {}),
        _peersRaw: peersRaw,
        _crossRefCV: r() < 0.4 ? {} : { [r() < 0.5 ? 'forwardPE' : 'trailingPE']: { cv: r() * 0.6, band: cvBand } },
      });
    }
    funds.push(null, undefined, {});
    const seen: Record<string, number> = {};
    const bump = (k: string): void => { seen[k] = (seen[k] ?? 0) + 1; };
    const pr = rng(99);
    for (const fund of funds) {
      // What fetchPeerBasicMetricsV7 would return for each symbol.
      const peerResults = new Map<string, PeerBasicMetrics | null>();
      for (const sym of (fund as any)?._peersRaw ?? []) {
        if (peerResults.has(sym)) continue;
        peerResults.set(sym, pr() < 0.2 ? null : {
          revenueGrowth: pr() < 0.2 ? null : -0.2 + pr() * 0.8, grossMargins: pr(), netMargin: pr() < 0.3 ? null : pr() * 0.3,
          fcfMargin: pr() < 0.4 ? null : pr() * 0.3, evSales: pr() < 0.15 ? null : pr() * 25,
        });
      }
      const asked: string[] = [];
      const legacy = withOracleGlobals({ fetchPeerBasicMetricsV7: (sym: string, log: unknown) => { assert.equal(log, null); asked.push(sym); return peerResults.get(sym) ?? null; } },
        () => o.callNormalized<any>('computeFundamentalScoreV7', fund));
      assert.deepStrictEqual(peerSymbolsForScore(fund as any), asked, 'the lifted-out peer list is exactly what legacy fetched');
      const port = structuredClone(computeFundamentalScore(fund as any, peerResults));
      assert.deepStrictEqual(port, legacy, JSON.stringify(fund)?.slice(0, 300));
      bump('verdict ' + legacy.verdict);
      if (legacy.pricedForPerfection) bump('pricedForPerfection');
      for (const d of legacy.drivers) {
        bump(d.label);
        bump(d.label + ' / ' + d.note);
        if (d.label === 'Valuation vs peers') bump('val ' + (d.value.includes('more expensive than all') ? 'all-expensive' : d.value.includes('cheaper than all') ? 'all-cheap' : d.value.includes('% of') ? 'pct' : 'bands'));
      }
      if (legacy.profile) bump('profile ' + legacy.profile);
    }
    const must = [
      'verdict 🟢 Own-worthy', 'verdict 🟡 Decent', 'verdict ⚪ Mixed', 'verdict 🟠 Weak', 'verdict 🔴 Avoid', 'verdict N/A',
      'pricedForPerfection', 'profile TECH_GROWTH', 'profile DEFAULT',
      'Revenue/share trend', 'Revenue growth (level)', 'Margin trajectory', 'Rule of 40', 'Profitability/quality', 'Valuation vs peers',
      'Balance-sheet durability', 'Analyst view', 'P/E & PEG',
      'val all-expensive', 'val all-cheap', 'val pct', 'val bands',
      'Margin trajectory / losses narrowing — sign-aware scoring credits this even though still unprofitable',
      'Margin trajectory / losses widening — a real concern', 'Margin trajectory / losses roughly flat',
      'Margin trajectory / already profitable, and the margin is improving further',
      'Margin trajectory / still profitable, but the margin is compressing', 'Margin trajectory / profitable, margin trend is flat',
      'Analyst view / target+rating blended', 'Analyst view / target only', 'Analyst view / rating only (no target price)',
      'Balance-sheet durability / ⚠ RISK: thin runway', 'Balance-sheet durability / adequate runway',
    ];
    for (const m of must) assert.ok(seen[m] > 0, `never reached: ${m}`);
    assert.ok(Object.keys(seen).some((k) => k.includes('sources disagree substantially')), 'untrustworthy CV note');
    assert.ok(Object.keys(seen).some((k) => k.includes('some cross-source disagreement')), 'shaky CV note');
  });

  test('the lifted-out peer fetch requests exactly the peers legacy requests, through the same cache', async () => {
    const o = loadOracle();
    const r = rng(5);
    for (let k = 0; k < 60; k++) {
      const peers = ['AA', 'BB', 'AA', 'CC', 'DD'].slice(0, 1 + Math.floor(r() * 5));
      const fund = { revenueGrowth: 0.2, _peersRaw: peers, _metricSeries: { quarterly: { evRevenueTTM: [{ v: r() < 0.2 ? null : 7 }] } } };
      const ex: RecordedExchange[] = [];
      for (const sym of new Set(peers)) {
        const rep = peerMetricReply(sym, r);
        ex.push({ request: { method: 'GET', url: scrubUrl('https://finnhub.io/api/v1/stock/metric?symbol=' + sym + '&metric=all&token=K') }, response: { status: rep.status, bodyBase64: Buffer.from(rep.body).toString('base64') } });
      }
      const props = new FakeProperties(new Map(), true);
      const fns = legacyBundle(KEYS);
      const trace: string[] = [];
      const legacy = withOracleGlobals(
        { UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), PropertiesService: fakePropertiesService(props), Date: pinnedDateClass(NOW), fetchPeerBasicMetricsV7: fns.fetchPeerBasicMetricsV7 },
        () => o.callNormalized('computeFundamentalScoreV7', fund),
      );
      const store = new MemoryPropertyStore();
      const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
      const metrics = await fetchPeerMetricsFor({ http: new HttpClient({ transport }), keys: KEYS, store, clock: { now: () => NOW } }, peerSymbolsForScore(fund));
      assert.deepStrictEqual(transport.trace, trace, 'same requests, same order, cache hits included');
      assert.deepStrictEqual([...store.map], [...props.map]);
      assert.deepStrictEqual(structuredClone(computeFundamentalScore(fund, metrics)), legacy);
    }
  });
});
