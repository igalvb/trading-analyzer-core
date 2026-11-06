/**
 * The 5 Nov 2026 Nightly logs:
 *  1. BUG: the paper-list-only tickers (analysed only by paper.trade) never had a broker-course data cache row, so their
 *     zombie screen read "not yet available" every night. The nightly now refreshes it before EVERY analysis of the run.
 *  2. Noise, log level only (report status unchanged):
 *     - options snapshot for another ticker in the nightly (one shared _OPTIONS_SNAPSHOT): DEBUG 'skipped'
 *     - zombie screen without data because FMP ratios-ttm is a remembered 402 (free plan): DEBUG 'skipped'
 *     - "Broker data cache NOT written" for an ETF / fund: INFO
 *     - "No peers" for an ETF / fund: DEBUG 'skipped'
 *     - SEC shares-outstanding "found no data" when every concept URL was a 404: INFO
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { TappingTransport } from '../src/net/httpTap.ts';
import { Logger, LogLevel, levelOfText, type LogLine } from '../src/core/logger.ts';
import { createContext } from '../src/core/context.ts';
import { fetchStep } from '../src/core/fetchStep.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { readBrokerDataCache } from '../src/storage/macroCaches.ts';
import { refreshBrokerCourseDataCache } from '../src/fetch/macro/refresh.ts';
import { resolveFundamentals } from '../src/fetch/fundamentals/resolve.ts';
import { isEtfOrFund } from '../src/fetch/etf/kind.ts';
import { composeServices } from '../src/compose.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { runTickerAnalysisDetailed, ANALYSIS_TAB, type TickerAnalysisDeps } from '../src/analysis/runTicker.ts';
import { getOrCreate, OPTIONS_SNAPSHOT_SHEET } from '../src/reports/options/tabs.ts';
import { loadRawFixture, fixturesPresent, type RawFixture } from './fixtures.ts';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 10, 5, 8, 0);
const FAKE_FMP_KEY = ['fake', 'fmp', 'key'].join('-');

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

describe('1. the nightly refreshes the broker-course data cache for every analysed ticker (paper list too)', () => {
  test('a ticker in neither the portfolio nor the watchlist gets a cache row; one FMP ratios-ttm call across a retry', async () => {
    const net = new MapTransport([['financialmodelingprep.com/stable/ratios-ttm?symbol=PAPERX', 200, JSON.stringify([{ interestCoverageRatioTTM: 7.5 }])]]);
    const s = await composeServices({ storage: 'memory', env: { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ, FMP_API_KEY: FAKE_FMP_KEY }, transport: net, clock: { now: () => NOW }, mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
      initialTabs: { Portfolio: [['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data']], '🎯 Watchlist': [['Ticker'], ['NVDA']] } });
    const app = await buildNightlyApp(s);
    assert.ok(!app.watchlist.includes('PAPERX'));
    assert.equal(await readBrokerDataCache(s.tabStore, 'PAPERX', NOW), null, 'no row before');
    await app.cache.get('PAPERX'); // what paper.trade does for a paper-list ticker
    const row = await readBrokerDataCache(s.tabStore, 'PAPERX', NOW);
    assert.ok(row, 'a cache row was written');
    assert.equal(row!.interestCoverageRatio, 7.5);
    app.cache.forget('PAPERX');
    await app.cache.get('PAPERX'); // a retried attempt: the fresh row is left alone
    assert.equal(net.urls.filter((u) => u.includes('ratios-ttm?symbol=PAPERX')).length, 1, 'at most one FMP call per ticker per day');
  });
});

describe('2a. broker data cache not written: INFO for an ETF / fund, WARNING otherwise', () => {
  const base = { store: new MemoryTabStore(), fmpKey: FAKE_FMP_KEY, timeZone: TZ, clock: { now: () => NOW }, plainText: true };
  const lineFor = async (ticker: string, routes: Array<[string, number, string]>): Promise<string> => {
    const logs: string[] = [];
    await refreshBrokerCourseDataCache({ ...base, http: httpOf(new MapTransport(routes)), kv: new MemoryPropertyStore() }, ticker, (m) => logs.push(m));
    const l = logs.find((m) => /Broker data cache not written/i.test(m));
    assert.ok(l, 'a line is logged');
    return l!;
  };
  test('GBTC (Bitcoin ETF), no data from either source -> INFO, names the reasons', async () => {
    const l = await lineFor('GBTC', [['financialmodelingprep.com', 402, 'Premium']]);
    assert.equal(levelOfText(l), 'info');
    assert.match(l, /ETF \/ fund/);
    assert.match(l, /not in the FMP plan \(402\)/);
  });
  test('a stock -> WARNING as before', async () => {
    assert.equal(levelOfText(await lineFor('ZZZQ', [['financialmodelingprep.com', 402, 'Premium']])), 'warning');
  });
  test('an ETF with a provider failure behind it (HTTP 503) -> still WARNING', async () => {
    assert.equal(levelOfText(await lineFor('GBTC', [['api.nasdaq.com', 503, '']])), 'warning');
  });
  test('isEtfOrFund: the reference lists only', () => {
    for (const t of ['GBTC', 'ibit', 'SPY', 'XLK', 'QQQ']) assert.equal(isEtfOrFund(t), true, t);
    for (const t of ['NVDA', 'SQZA', '', null]) assert.equal(isEtfOrFund(t), false, String(t));
  });
});

describe('2b. no peers: DEBUG for an ETF / fund (status unchanged), WARNING otherwise', () => {
  const fundNoPeers = { _sources: ['fmp'], beta: 1, _metricSeries: null, _peersRaw: [] };
  const peersCall = async (ticker: string) => {
    const calls: Array<[string, string, string | undefined]> = [];
    await resolveFundamentals(ticker, {
      gather: async () => ({ fund: fundNoPeers as never, source: 'live' }), store: new MemoryPropertyStore(), now: () => new Date(NOW),
      setStatus: (k, st, _d, _rc, ls) => { if (k === 'peers') calls.push([k, st, ls]); },
    });
    return calls;
  };
  test('ETF -> degraded, log state skipped', async () => assert.deepEqual(await peersCall('FBTC'), [['peers', 'degraded', 'skipped']]));
  test('stock -> degraded, log state as the status', async () => assert.deepEqual(await peersCall('NVDA'), [['peers', 'degraded', undefined]]));
});

describe('2c. SEC "found no data": INFO when every request was a 404, WARNING otherwise', () => {
  const run = async (transport: HttpTransport, fn: (h: HttpClient) => Promise<unknown>) => {
    const lines: LogLine[] = [];
    const tap = new TappingTransport(transport);
    const r = await fetchStep({ ctx: ctxOf(lines), tap }, { key: 'dilutionScreen', source: 'SEC shares-outstanding history SQZA', noDataNote: 'skipped' }, () => fn(httpOf(tap)));
    assert.equal(r.ok, false);
    return lines.filter((l) => l.level >= LogLevel.INFO && /found no data|gave up/.test(l.message)).map((l) => l.level);
  };
  test('all concept URLs 404 (a new issuer) -> one INFO', async () => {
    assert.deepEqual(await run(new MapTransport([]), async (h) => { await h.fetch({ url: 'https://data.sec.gov/a', muteHttpExceptions: true }); await h.fetch({ url: 'https://data.sec.gov/b', muteHttpExceptions: true }); return null; }), [LogLevel.INFO]);
  });
  test('a 200 with nothing usable -> WARNING as before', async () => {
    assert.deepEqual(await run(new MapTransport([['sec.gov', 200, '{}']]), async (h) => { await h.fetch({ url: 'https://data.sec.gov/a', muteHttpExceptions: true }); return null; }), [LogLevel.WARNING]);
  });
  test('a 503 is a provider failure -> ERROR "gave up", never hidden', async () => {
    assert.deepEqual(await run(new MapTransport([['sec.gov', 503, '']]), async (h) => { await h.fetch({ url: 'https://data.sec.gov/a', muteHttpExceptions: true }); return null; }), [LogLevel.ERROR]);
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

describe('2d. options snapshot mismatch and zombie-without-data: log level only', { skip: fixturesPresent() ? false : 'price fixtures not present' }, () => {
  const run = async (over: Partial<TickerAnalysisDeps>) => {
    const charts: Record<string, unknown> = { TSLA: tailChart(loadRawFixture('TSLA'), 504), SPY: tailChart(loadRawFixture('SPY'), 504), '^VIX': tailChart(loadRawFixture('_VIX'), 300, '^VIX') };
    const lines: LogLine[] = [];
    const snap = [['META', JSON.stringify({ ticker: 'AQZB' })], ['strike'], [100]];
    const book = await ReportWorkbook.open(new MemoryWorkbookBackend({ [OPTIONS_SNAPSHOT_SHEET]: snap }), ['*']);
    const ctx = createContext({ mode: 'test', runId: 'lvl', logger: new Logger({ minLevel: LogLevel.DEBUG, sink: (l) => { lines.push(l); }, scope: 'nightly', now: () => new Date(0) }), clock: { now: () => NOW }, sleep: async () => {}, random: () => 0, backoffBaseMs: 1, backoffMaxMs: 2 });
    const deps: TickerAnalysisDeps = {
      ss: book, timeZone: TZ, clock: { now: () => NOW }, ctx,
      fetchYahooChart: async (t) => (charts[t] ? structuredClone(charts[t]) : null) as never,
      fetchLongRangeCloses: async () => null,
      gatherFundamentals: async () => ({ fund: null, source: 'none' }) as never,
      fundamentalsStore: new MemoryPropertyStore(),
      fetchPeerMetrics: async (syms) => new Map(syms.map((x) => [x, null as never])),
      getTickerDarkPoolShare: async () => null,
      getCachedMacroRegime: async () => ({ available: true, regime: 'RISK_ON' }),
      readBrokerDataCache: async () => null,
      fetchSecEdgarCIK: async () => null,
      fetchSharesOutstandingHistory: async () => null,
      fetchSecFilingKeywordHits: async () => null,
      getCachedRelativeStrengthRanking: async () => null,
      fetchGeminiReview: async () => null,
      aiUnavailable: true,
      buildBrokerCourseReport: async () => null,
      render: { dashboard: () => { getOrCreate(book, ANALYSIS_TAB); }, failureSheet: () => { getOrCreate(book, ANALYSIS_TAB); }, textReport: () => {} },
      ...over,
    };
    const art = await runTickerAnalysisDetailed(deps, 'TSLA');
    const sec = (k: string) => lines.filter((l) => l.message.startsWith('section ' + k + ' ')).map((l) => [l.level, l.message]);
    return { art, options: sec('options'), zombie: sec('zombieCompanyScreen') };
  };

  test('nightly (shared snapshot, FMP plan gap): DEBUG skipped; the status entries are still degraded with the same text', async () => {
    const { art, options, zombie } = await run({ optionsSnapshotShared: true, interestCoverageNotInPlan: async () => true });
    assert.deepEqual(options, [[LogLevel.DEBUG, 'section options skipped']]);
    assert.deepEqual(zombie, [[LogLevel.DEBUG, 'section zombieCompanyScreen skipped']]);
    assert.equal(art.status.options.state, 'degraded');
    assert.match(String(art.status.options.detail), /Snapshot is for AQZB — run Options Analysis on TSLA/);
    assert.equal(art.status.zombieCompanyScreen.state, 'degraded');
    assert.equal(art.status.zombieCompanyScreen.reasonCode, 'NO_DATA_FOR_TICKER');
  });

  test('otherwise (the one-stock run, no plan gap): WARNING degraded as before', async () => {
    const { options, zombie } = await run({ interestCoverageNotInPlan: async () => false });
    assert.deepEqual(options, [[LogLevel.WARNING, 'section options degraded']]);
    assert.deepEqual(zombie, [[LogLevel.WARNING, 'section zombieCompanyScreen degraded']]);
  });
});
