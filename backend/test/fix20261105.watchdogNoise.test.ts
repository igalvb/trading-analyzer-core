/**
 * The 5 Nov 2026 watchdog flagged two WARNING patterns that are not failures:
 *  1. SEC XBRL companyconcept / companyfacts 404s (the company does not file that tag; edgar.ts falls back) -> DEBUG.
 *     Other hosts' 404s and every 5xx stay WARNING.
 *  2. "section aiReview degraded" on every nightly ticker: the nightly runs with AI deliberately off -> the technical
 *     log says 'skipped' at DEBUG. The report's status (and so the report text) is unchanged: still 'degraded'.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { TappingTransport, isExpectedMiss } from '../src/net/httpTap.ts';
import { Logger, LogLevel, type LogLine } from '../src/core/logger.ts';
import { createContext } from '../src/core/context.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { runTickerAnalysisDetailed, ANALYSIS_TAB, type TickerAnalysisDeps } from '../src/analysis/runTicker.ts';
import { getOrCreate } from '../src/reports/options/tabs.ts';
import { loadRawFixture, fixturesPresent, type RawFixture } from './fixtures.ts';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 10, 5, 8, 0);

class StatusTransport implements HttpTransport {
  private readonly status: number;
  constructor(status: number) { this.status = status; }
  async send(_req: HttpRequest): Promise<HttpResponse> { return new HttpResponse(this.status, new TextEncoder().encode('nope')); }
}

const CONCEPT = 'https://data.sec.gov/api/xbrl/companyconcept/CIK0001050446/us-gaap/CommonStockSharesOutstanding.json';
const FACTS = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001050446.json';

async function levelOf(status: number, url: string): Promise<number | undefined> {
  const lines: LogLine[] = [];
  const tap = new TappingTransport(new StatusTransport(status), { log: new Logger({ minLevel: LogLevel.DEBUG, sink: (l) => { lines.push(l); } }) });
  await tap.send({ url });
  assert.equal(tap.events.length, 1, 'the event is still recorded');
  return lines.find((l) => l.message.startsWith('HTTP ' + status))?.level;
}

describe('1. SEC companyconcept / companyfacts 404 logs at DEBUG', () => {
  test('SEC XBRL 404s -> DEBUG', async () => {
    assert.equal(await levelOf(404, CONCEPT), LogLevel.DEBUG);
    assert.equal(await levelOf(404, FACTS), LogLevel.DEBUG);
  });
  test('other hosts / paths 404, and SEC 5xx / 403 -> WARNING as before', async () => {
    assert.equal(await levelOf(404, 'https://finnhub.io/api/v1/stock/metric?symbol=TSLA'), LogLevel.WARNING);
    assert.equal(await levelOf(404, 'https://data.sec.gov/submissions/CIK0001050446.json'), LogLevel.WARNING);
    assert.equal(await levelOf(500, CONCEPT), LogLevel.WARNING);
    assert.equal(await levelOf(503, FACTS), LogLevel.WARNING);
    assert.equal(await levelOf(403, CONCEPT), LogLevel.WARNING);
  });
  test('isExpectedMiss is narrow', () => {
    assert.equal(isExpectedMiss(404, CONCEPT), true);
    assert.equal(isExpectedMiss(404, 'https://evil.example/https://data.sec.gov/api/xbrl/companyfacts/x'), false);
    assert.equal(isExpectedMiss(429, CONCEPT), false);
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

describe('2. aiReview with AI deliberately off: skipped in the log, report status unchanged', { skip: fixturesPresent() ? false : 'price fixtures not present' }, () => {
  const run = async (aiUnavailable: boolean) => {
    const charts: Record<string, unknown> = { TSLA: tailChart(loadRawFixture('TSLA'), 504), SPY: tailChart(loadRawFixture('SPY'), 504), '^VIX': tailChart(loadRawFixture('_VIX'), 300, '^VIX') };
    const lines: LogLine[] = [];
    const book = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    const ctx = createContext({ mode: 'test', runId: 'noai', logger: new Logger({ minLevel: LogLevel.DEBUG, sink: (l) => { lines.push(l); }, scope: 'nightly', now: () => new Date(0) }), clock: { now: () => NOW }, sleep: async () => {}, random: () => 0, backoffBaseMs: 1, backoffMaxMs: 2 });
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
      aiUnavailable,
      buildBrokerCourseReport: async () => null,
      render: { dashboard: () => { getOrCreate(book, ANALYSIS_TAB); }, failureSheet: () => { getOrCreate(book, ANALYSIS_TAB); }, textReport: () => {} },
    };
    const art = await runTickerAnalysisDetailed(deps, 'TSLA');
    return { art, ai: lines.filter((l) => l.message.startsWith('section aiReview')) };
  };

  test('AI off (nightly noAi): one DEBUG "section aiReview skipped"; the status entry is still degraded', async () => {
    const { art, ai } = await run(true);
    assert.deepEqual(ai.map((l) => [l.level, l.message]), [[LogLevel.DEBUG, 'section aiReview skipped']]);
    assert.equal(art.status.aiReview.state, 'degraded', 'report status (and so the report text) unchanged');
    assert.equal(art.status.aiReview.reasonCode, 'AI_REVIEW_UNAVAILABLE');
  });

  test('AI requested and it returned nothing: still a WARNING "degraded"', async () => {
    const { art, ai } = await run(false);
    assert.deepEqual(ai.map((l) => [l.level, l.message]), [[LogLevel.WARNING, 'section aiReview degraded']]);
    assert.equal(art.status.aiReview.state, 'degraded');
  });
});
