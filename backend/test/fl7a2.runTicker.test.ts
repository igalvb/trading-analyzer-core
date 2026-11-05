/**
 * FL-7a-2: runTickerAnalysis against the oracle's runAnalysisV7, in legacy
 * parity mode, end to end. Both sides run the real analysis (indicators,
 * Gann, confluence, fundamental score, options read, tech plan, decision,
 * the three screens, Schabacker / Edwards & Magee / Turtle and the
 * comparison report) on the same fixture charts; only the network and cache
 * boundaries are stubbed, identically on both sides. Compared: the '🔬 Log'
 * tab cell for cell, every renderer call with its arguments (the dashboard's
 * 20, the failure sheet's, every model tab's text and colour), the
 * PropertiesService contents, the return value, and which tab ends active.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, gasFormatDate } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { loadRawFixture, fixturesPresent, type RawFixture } from './fixtures.ts';
import { makeSeries, rng } from './fundamentalsFixtures.ts';
import { normalizeFromOracle } from './normalize.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { getOrCreate } from '../src/reports/options/tabs.ts';
import { runTickerAnalysisDetailed, ANALYSIS_TAB, type TickerAnalysisDeps, type DashboardArgs } from '../src/analysis/runTicker.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T21:30:00Z');

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

/** The last `n` bars of a fixture, shaped like fetchYahooChart's result. */
function tailChart(raw: RawFixture, n: number, ticker = raw.ticker) {
  const len = raw.closes.length, from = Math.max(0, len - n);
  const sl = <T,>(a: T[] | undefined, d: T[]): T[] => (a ?? d).slice(from);
  const closes = raw.closes.slice(from);
  const dates = raw.dates.slice(from).map((d) => new Date(d + 'T00:00:00Z'));
  return {
    ticker, dates, opens: sl(raw.opens, raw.closes), highs: sl(raw.highs, raw.closes), lows: sl(raw.lows, raw.closes), closes,
    volumes: sl(raw.volumes, raw.closes.map(() => 0)),
    splits: (raw.splits ?? []).map((s) => ({ date: new Date(s.date * 1000), numerator: s.numerator, denominator: s.denominator })),
    ipoDate: new Date(raw.dates[0] + 'T00:00:00Z'), currentPrice: closes[closes.length - 1], prevClose: closes[closes.length - 2], currency: 'USD',
  };
}

function fundFor(sector: string | null, withSeries: boolean, peers: string[] | null) {
  return {
    _source: 'merged', forwardPE: 34.2, trailingPE: 61.8, pegRatio: 1.7, priceToBook: 12.1, profitMargins: 0.081, grossMargins: 0.182,
    returnOnEquity: 0.094, returnOnAssets: 0.041, revenueGrowth: 0.12, earningsGrowth: -0.2, beta: 2.1, marketCap: 1.1e12,
    dividend: null, price: 330, sector, industry: 'Auto Manufacturers', targetMean: 310, targetHigh: 500, targetLow: 120, numAnalysts: 40,
    recMean: 2.6, recKey: 'hold', strongBuy: 8, buy: 12, hold: 15, sell: 4, strongSell: 2, shortRatio: null, institutionPct: null,
    debtToEquity: 0.18, currentRatio: 1.9, fcfPerShare: 1.1, quickRatio: 1.4, shareFloat: 2.8e9, _premiumBlocked: false, _rateLimited: false,
    _sources: ['FMP', 'Finnhub'], _crossRef: null, _crossRefCV: {},
    _metricSeries: withSeries ? makeSeries(rng(7), { size: 10 }) : null, _peersRaw: peers,
  };
}

interface Case {
  readonly label: string;
  readonly ticker: unknown;
  readonly charts: Record<string, ReturnType<typeof tailChart> | 'throw' | null>;
  readonly gather: () => { fund: unknown; source: string };
  readonly cachedFund?: unknown;
  readonly peerMetrics?: Record<string, unknown>;
  readonly darkPool: unknown | 'throw';
  readonly macro: unknown;
  readonly broker: { interestCoverageRatio: number | null; shortInterest: number | null; daysToCover: number | null; settlementDate: string | null } | null;
  readonly cik: string | null;
  readonly so: unknown;
  readonly hits: unknown;
  readonly rs: unknown;
  readonly gemini: string | null;
  readonly brokerReport: null | 'throw';
  readonly ladder?: [boolean, boolean];
  readonly runs?: number;
}

interface Recorded {
  dashboard: unknown[];
  failure: unknown[];
  text: unknown[];
  gemini: unknown[];
  brokerArgs: unknown[];
}

const DECISION_KEYS = ['headline', 'action', 'lines', 'fundBand', 'timing', 'finalConviction', 'dataWarnings', 'optionsConfirm'];

function pick(o: any, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o && k in o) out[k] = o[k];
  return out;
}

/** The dashboard's 20 positional arguments, comparable across realms. Decision on legacy's keys. */
function dashboardTuple(a: unknown[]): unknown {
  const [, ticker, chart, ind, gann, confluence, fundResult, techPlan, decision, fund, optAnalysis, fundSource, aiReview, status, ls, lo, leaps, shortT, inst, si] = a;
  return normalizeFromOracle({ ticker, chart, ind, gann, confluence, fundResult, techPlan, decision: pick(decision, DECISION_KEYS), fund, optAnalysis, fundSource, aiReview, status, ls, lo, leaps, shortT, inst, si });
}

function stubsFor(c: Case) {
  const chartOf = (t: string) => {
    const v = c.charts[t];
    if (v === 'throw') throw new Error('Yahoo fetch exploded for ' + t);
    return v ? structuredClone(v) : null;
  };
  return { chartOf };
}

function legacyRun(c: Case, book: ReportWorkbook, props: FakeProperties, rec: Recorded): unknown {
  const { chartOf } = stubsFor(c);
  return withOracleGlobals({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, flush: () => {} },
    PropertiesService: fakePropertiesService(props), Date: pinnedDateClass(NOW), Logger: { log: () => {} },
    Utilities: { formatDate: gasFormatDate },
    hasTimeBudgetV7_: () => true,
    fetchYahooChart: chartOf,
    fetchYahooChartLongRange_: () => null,
    gatherFundamentalsV7: () => structuredClone(c.gather()),
    fetchPeerBasicMetricsV7: (sym: string) => (c.peerMetrics && c.peerMetrics[sym] ? structuredClone(c.peerMetrics[sym]) : null),
    getTickerDarkPoolShareV1_: () => { if (c.darkPool === 'throw') throw new Error('FINRA down'); return structuredClone(c.darkPool); },
    getCachedMacroRegime_: () => structuredClone(c.macro),
    readBrokerDataCacheV1_: () => structuredClone(c.broker),
    fetchSecEdgarCIKV1: () => c.cik,
    fetchSharesOutstandingHistoryV1: () => structuredClone(c.so),
    fetchSecFilingKeywordHitsV1: () => structuredClone(c.hits),
    getCachedRelativeStrengthRankingV1_: () => structuredClone(c.rs),
    fetchGeminiReviewV7: (...a: unknown[]) => { rec.gemini.push(normalizeFromOracle({ ticker: a[0], fundResult: a[1], techPlan: a[2], decision: pick(a[3], DECISION_KEYS), leaps: a[11], short: a[12] })); return c.gemini; },
    buildBrokerCourseReportV1: (...a: unknown[]) => {
      rec.brokerArgs.push(normalizeFromOracle({ ticker: a[0], vix: a[3], cik: a[5], so: a[6], hits: a[7] }));
      if (c.brokerReport === 'throw') throw new Error('SEC EDGAR 503');
      return null;
    },
    buildDashboardV7: (...a: unknown[]) => { rec.dashboard.push(dashboardTuple(a)); getOrCreate(book, ANALYSIS_TAB); },
    buildFailureSheetV7: (_ss: unknown, ticker: unknown, status: unknown, err: any) => { rec.failure.push(normalizeFromOracle({ ticker, status, msg: err && err.message })); getOrCreate(book, ANALYSIS_TAB); },
    writeTextReportToSheetV7: (sh: any, text: unknown, color: unknown) => { rec.text.push([sh.getName(), text, color]); },
  }, () => loadOracle().call('runAnalysisV7', c.ticker, c.ladder?.[0], c.ladder?.[1], undefined, undefined));
}

async function portRun(c: Case, book: ReportWorkbook, kv: MemoryPropertyStore, rec: Recorded) {
  const { chartOf } = stubsFor(c);
  const deps: TickerAnalysisDeps = {
    ss: book, timeZone: TZ, clock: { now: () => NOW }, legacyParity: true,
    fetchYahooChart: async (t) => chartOf(t) as never,
    fetchLongRangeCloses: async () => null,
    gatherFundamentals: async () => structuredClone(c.gather()) as never,
    fundamentalsStore: kv,
    dateLabel: (d) => d.toLocaleDateString(),
    fetchPeerMetrics: async (syms) => new Map(syms.map((s) => [s, (c.peerMetrics && c.peerMetrics[s] ? structuredClone(c.peerMetrics[s]) : null) as never])),
    getTickerDarkPoolShare: async () => { if (c.darkPool === 'throw') throw new Error('FINRA down'); return structuredClone(c.darkPool); },
    getCachedMacroRegime: async () => structuredClone(c.macro) as never,
    readBrokerDataCache: async () => structuredClone(c.broker),
    fetchSecEdgarCIK: async () => c.cik,
    fetchSharesOutstandingHistory: async () => structuredClone(c.so) as never,
    fetchSecFilingKeywordHits: async () => structuredClone(c.hits) as never,
    getCachedRelativeStrengthRanking: async () => structuredClone(c.rs),
    fetchGeminiReview: async (a) => { rec.gemini.push(structuredClone({ ticker: a.ticker, fundResult: a.fundResult, techPlan: a.techPlan, decision: pick(a.decision, DECISION_KEYS), leaps: a.leapsCall, short: a.shortTermCall })); return c.gemini; },
    buildBrokerCourseReport: async (ticker, _log, _chart, vix, _fund, cik, so, hits) => {
      rec.brokerArgs.push(structuredClone({ ticker, vix, cik, so, hits }));
      if (c.brokerReport === 'throw') throw new Error('SEC EDGAR 503');
      return null;
    },
    render: {
      dashboard: (a: DashboardArgs) => {
        rec.dashboard.push(structuredClone({
          ticker: a.ticker, chart: a.chart, ind: a.ind, gann: a.gann, confluence: a.confluence, fundResult: a.fundResult, techPlan: a.techPlan,
          decision: pick(a.decision, DECISION_KEYS), fund: a.fund, optAnalysis: a.optAnalysis, fundSource: a.fundSource, aiReview: a.aiReview, status: a.status,
          ls: a.ladderStock, lo: a.ladderOptions, leaps: a.leapsCall, shortT: a.shortTermCall, inst: a.institutional13F, si: a.shortInterestData,
        }));
        assert.deepStrictEqual(a.dataQuality, [], 'no data-quality box in parity mode');
        getOrCreate(book, ANALYSIS_TAB);
      },
      failureSheet: (_ss, ticker, status, err: any) => { rec.failure.push(structuredClone({ ticker, status, msg: err && err.message })); getOrCreate(book, ANALYSIS_TAB); },
      textReport: (sh, text, color) => { rec.text.push([sh.getName(), text, color]); },
    },
  };
  return runTickerAnalysisDetailed(deps, c.ticker, c.ladder?.[0], c.ladder?.[1]);
}

describe('FL-7a-2 — runTickerAnalysis vs runAnalysisV7 (legacy parity mode)', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('every log line, renderer call, property and the return value, across seven scenarios', async () => {
    await inZone(TZ, async () => {
      const tsla = tailChart(loadRawFixture('TSLA'), 504);
      const spy = tailChart(loadRawFixture('SPY'), 504);
      const vix = tailChart(loadRawFixture('_VIX'), 300, '^VIX');
      const xlk = tailChart(loadRawFixture('SMH'), 504, 'XLK');
      const nvda = tailChart(loadRawFixture('NVDA'), 504);
      const base = {
        darkPool: { tier: 'T1', weekStartDate: '2026-10-05', atsShareVolume: 1.2e7, darkPoolSharePct: 0.14, elevated: false },
        macro: {
          available: true, regime: 'RISK_ON', supplemental: { m2YoY: 0.04, yieldCurve10y2y: 0.31 },
          dowTheory: {
            verdict: 'NON_CONFIRMATION_BULL', asOfDate: '2026-10-22T00:00:00.000Z', lagTradingDays: 1,
            industrials: { ticker: 'DIA', newHigh: true, newLow: false, close: 455.2, extremeHighDate: '2026-10-20T00:00:00.000Z', extremeLowDate: null },
            transports: { ticker: 'IYT', newHigh: false, newLow: false, close: 68.1, extremeHighDate: null, extremeLowDate: null },
          },
          evaluativeIndex: { pctStrong: 61.3, strong: 68, weak: 43, unavailable: 0, total: 111, read: 'neutral', asOfDate: '2026-10-23T09:45:00.000Z' },
        },
        broker: { interestCoverageRatio: 14.2, shortInterest: 8e7, daysToCover: 1.1, settlementDate: '2026-10-15' },
        cik: '0001318605',
        so: [{ date: '2025-06-30', value: 3.20e9 }, { date: '2025-09-30', value: 3.21e9 }, { date: '2025-12-31', value: 3.22e9 }, { date: '2026-03-31', value: 3.24e9 }, { date: '2026-06-30', value: 3.25e9 }],
        hits: { offering: 2, shelf: 0, warrants: 1, convertible: 3, dilution: 0 },
        rs: { categories: ['EV / Autos', 'Mega-cap Tech'], peerCount: 11, rank: 3, percentile: 82, read: 'leader (top quintile)', topPeers: [{ ticker: 'NVDA', score: 2.1 }, { ticker: 'TSLA', score: 1.4 }], bottomPeers: [{ ticker: 'F', score: -0.6 }] },
        gemini: 'A plain review.',
        brokerReport: null as null | 'throw',
      };
      const peers = { RIVN: { evSales: 3.1, revenueGrowth: 0.4, fcfMargin: -0.3, grossMargins: 0.1 }, F: { evSales: 0.4, revenueGrowth: 0.02, fcfMargin: 0.04, grossMargins: 0.15 }, GM: { evSales: 0.6, revenueGrowth: 0.05, fcfMargin: 0.06, grossMargins: 0.13 } };
      const cases: Case[] = [
        { label: 'full live run, sector + SPY + VIX, series + peers, ladders', ticker: ' tsla ', charts: { TSLA: tsla, SPY: spy, '^VIX': vix, XLK: xlk }, gather: () => ({ fund: fundFor('Technology', true, ['RIVN', 'F', 'GM']), source: 'FMP+Finnhub' }), peerMetrics: peers, ...base, ladder: [true, false], runs: 2 },
        { label: 'no SPY, VIX throws, no fundamentals, Gemini down, broker throws', ticker: 'NVDA', charts: { NVDA: nvda, SPY: null, '^VIX': 'throw' }, gather: () => ({ fund: null, source: 'none' }), ...base, gemini: null, brokerReport: 'throw', darkPool: 'throw', broker: null, cik: null },
        { label: 'cached fundamentals, unmapped sector, no CIK history', ticker: 'NVDA', charts: { NVDA: nvda, SPY: spy, '^VIX': vix }, gather: () => ({ fund: null, source: 'none' }), cachedFund: { data: fundFor('Semis', false, null), date: '10/20/2026' }, ...base, so: null, hits: null, macro: { available: false, supplemental: null, dowTheory: null, evaluativeIndex: null } },
        { label: 'live fundamentals without series or peers', ticker: 'TSLA', charts: { TSLA: tsla, SPY: spy, '^VIX': vix }, gather: () => ({ fund: fundFor(null, false, null), source: 'FMP' }), ...base, darkPool: null },
        { label: 'no price data', ticker: 'ZZZZ', charts: {}, gather: () => ({ fund: null, source: 'none' }), ...base },
        { label: 'SPY fetch throws (F-34: legacy aborts)', ticker: 'TSLA', charts: { TSLA: tsla, SPY: 'throw', '^VIX': vix }, gather: () => ({ fund: fundFor(null, false, null), source: 'FMP' }), ...base },
        { label: 'three bars only: legacy still completes (fetchYahooChart normally refuses < 60)', ticker: 'TSLA', charts: { TSLA: tailChart(loadRawFixture('TSLA'), 3), SPY: spy, '^VIX': vix }, gather: () => ({ fund: null, source: 'none' }), ...base },
      ];
      let compared = 0;
      for (const c of cases) {
        const mk = async () => ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
        const L = { book: await mk(), props: new FakeProperties(new Map(), true), rec: { dashboard: [], failure: [], text: [], gemini: [], brokerArgs: [] } as Recorded };
        const P = { book: await mk(), kv: new MemoryPropertyStore(), rec: { dashboard: [], failure: [], text: [], gemini: [], brokerArgs: [] } as Recorded };
        if (c.cachedFund) {
          L.props.setProperty('FUND_' + String(c.ticker).trim().toUpperCase(), JSON.stringify(c.cachedFund));
          await P.kv.set('FUND_' + String(c.ticker).trim().toUpperCase(), JSON.stringify(c.cachedFund));
        }
        for (let run = 0; run < (c.runs ?? 1); run++) {
          const lv = normalizeFromOracle(legacyRun(c, L.book, L.props, L.rec));
          const art = await portRun(c, P.book, P.kv, P.rec);
          const pv = structuredClone(art.result ? { fundResult: art.result.fundResult, techPlan: art.result.techPlan, decision: pick(art.result.decision, DECISION_KEYS) } : undefined);
          const lvPicked = lv ? { ...(lv as any), decision: pick((lv as any).decision, DECISION_KEYS) } : lv;
          const where = c.label + ' run ' + (run + 1);
          assert.deepStrictEqual(pv, lvPicked, where + ' (return)');
          const logOf = (b: ReportWorkbook) => b.getSheetByName('🔬 Log')!.grid();
          assert.deepStrictEqual(logOf(P.book), logOf(L.book), where + ' (🔬 Log)');
          for (const k of ['dashboard', 'failure', 'text', 'gemini', 'brokerArgs'] as const) assert.deepStrictEqual(P.rec[k], L.rec[k], where + ' (' + k + ')');
          assert.deepStrictEqual(P.book.calls, L.book.calls, where + ' (workbook calls)');
          const active = (b: ReportWorkbook) => b.getSheets().filter((s) => s.calls.some((x) => x[0] === 'activate')).map((s) => s.getName());
          assert.deepStrictEqual(active(P.book), active(L.book), where + ' (activated tab)');
          if (!(c.gather().fund as any)?._metricSeries) assert.deepStrictEqual([...P.kv.map].sort(), [...L.props.map].sort(), where + ' (properties)');
          compared++;
        }
        // The scenario really reached where it says it does.
        const log = P.book.getSheetByName('🔬 Log')!.grid().map((r) => String(r[0]));
        const reached = (s: string) => log.some((l) => l.includes(s));
        const runs = c.runs ?? 1;
        if (/no price|throws \(/.test(c.label)) {
          assert.equal(P.rec.dashboard.length, 0, c.label);
          assert.equal(P.rec.failure.length, runs, c.label);
          assert.ok(reached(/no price/.test(c.label) ? '❌ Price data failed' : '❌ v7 aborted'), c.label);
        } else {
          assert.equal(P.rec.dashboard.length, runs, c.label);
          for (const s of ['✅ Decision:', '🎯 Tech score:', 'Run Summary']) assert.ok(reached(s), c.label + ': ' + s);
          if (process.env.SHOW_LOG === c.label.slice(0, 4)) console.log(log.join('\n'));
          if (c.label.startsWith('full')) {
            assert.equal(P.rec.text.length, 5 * runs, c.label + ' model tabs');
            assert.ok(!reached('model report failed') && !reached('report build failed'), 'every model builds in the full scenario');
          }
        }
      }
      assert.equal(compared, 8);
    });
  });
});
