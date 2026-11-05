/**
 * Owner-approved fixes from docs/FIX_PLAN_2026-10-30.md: A3, A4, A5, B2, D7-D20 (report text and display).
 * Every fix is off in legacy-parity mode; these tests pin the fixed (production) side and, where cheap, that the
 * legacy side is unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { refreshBrokerCourseDataCache, fetchFMPInterestCoverage } from '../src/fetch/macro/refresh.ts';
import { fetchSharesOutstandingHistory } from '../src/fetch/sec/edgar.ts';
import { gatherFundamentalsV7 } from '../src/fetch/fundamentals/v7.ts';
import { dataSheetClient } from '../src/trimPriceTabs.ts';
import { MIGRATED_FLAG } from '../src/sheets/threeSheets.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { FakeGoogle } from './fakeGoogleSheets.ts';
import { buildGeminiPrompt, buildGeminiReport, confidenceWord } from '../src/fetch/ai/geminiReview.ts';
import { computeConfluenceTargets } from '../src/analysis/confluence.ts';
import { computeIndicators } from '../src/analysis/indicators/index.ts';
import { computeGann } from '../src/analysis/gann.ts';
import { computeTechnicalPlan } from '../src/analysis/techPlan/plan.ts';
import { slope } from '../src/analysis/series.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Chart } from '../src/types/chart.ts';
import { volumeVs20dText } from '../src/analysis/signals.ts';
import { sessionFractionElapsed, liveBarFraction } from '../src/core/marketSession.ts';
import { trendModel, everythingModel } from '../src/analysis/extraModels.ts';
import { recentSrLevels, srLevels } from '../src/analysis/indicators/srLevels.ts';
import { ReportWorkbook, SheetsWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { formatOpsToRequests } from '../src/sheets/formatOps.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { ok } from '../src/core/result.ts';
import { roundNumberText, shortDate, countDistinct, assumedAccountText } from '../src/analysis/models/modelText.ts';
import { buildSchabackerReport, formatSchabackerReport } from '../src/analysis/models/schabacker.ts';
import { buildEdwardsMageeReport, formatEdwardsMageeReport } from '../src/analysis/models/edwardsMagee.ts';
import { buildTurtleReport, formatTurtleReport } from '../src/analysis/models/turtle.ts';
import { buildTop10 } from '../src/reports/options/tabs.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { ACCOUNT } from '../src/analysis/decision.ts';
import { showPriceChart, chartWorkbook, PRICE_CHART_TAB, type ChartStore } from '../src/ops/priceChart.ts';
import { openBook, bars } from './fl7c1Fixtures.ts';
import { formatBrokerCourseReportV1 } from '../src/analysis/models/brokerCourse/report.ts';

const TZ = 'America/New_York';

/** A transport answering by URL substring; records every URL. */
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

describe('A3 — broker-data cache message names the real reason', () => {
  test('FMP 402 + Nasdaq 404: "not in the FMP plan (402)" and "HTTP 404", never "transient"', async () => {
    const logs: string[] = [];
    const t = new MapTransport([['api.nasdaq.com', 404, ''], ['financialmodelingprep.com', 402, 'Premium']]);
    await refreshBrokerCourseDataCache({ http: httpOf(t), store: new MemoryTabStore(), kv: new MemoryPropertyStore(), fmpKey: 'k', timeZone: TZ, clock: { now: () => Date.parse('2026-10-30T14:00:00Z') }, plainText: true }, 'SQZA', (m) => logs.push(m));
    const line = logs.find((l) => l.includes('NOT written')) ?? '';
    assert.match(line, /FMP interest coverage: not in the FMP plan \(402\)/);
    assert.match(line, /Nasdaq short interest: HTTP 404/);
    assert.doesNotMatch(line, /transient/);
  });
  test('an empty FMP list is "no data"; the return value is unchanged (null)', async () => {
    let why = '';
    const t = new MapTransport([['financialmodelingprep.com', 200, '[]']]);
    assert.equal(await fetchFMPInterestCoverage({ http: httpOf(t), fmpKey: 'k' }, 'X', (r) => { why = r; }), null);
    assert.equal(why, 'no data');
  });
});

describe('A4 — SQZA: non-US peers and the SEC dei shares fallback', () => {
  test('peers with a "." are dropped before the cap (production); legacy keeps them', async () => {
    const peers = JSON.stringify(['SQZA', '000660.KS', '005930.KS', '042700.KQ', 'MQZC', 'WDC', 'STX', 'SNDK', 'NTAP']);
    const routes: Array<[string, number, string]> = [
      ['stock/metric', 200, JSON.stringify({ metric: { peTTM: 20, netProfitMarginTTM: 10 }, series: {} })],
      ['stock/profile2', 200, JSON.stringify({ name: 'SK hynix Inc.', marketCapitalization: 100000 })],
      ['stock/recommendation', 200, '[]'],
      ['stock/peers', 200, peers],
    ];
    const deps = (withName: boolean) => ({ http: httpOf(new MapTransport(routes)), keys: { fmp: 'f', alphaVantage: '', finnhub: 'h' }, timeZone: TZ, clock: { now: () => Date.parse('2026-10-30T14:00:00Z') }, withCompanyName: withName });
    const fixed = await gatherFundamentalsV7(deps(true), 'SQZA', undefined, { usPeersOnly: true });
    assert.deepEqual(fixed.fund?._peersRaw, ['MQZC', 'WDC', 'STX', 'SNDK', 'NTAP']);
    assert.equal(fixed.fund?._companyName, 'SK hynix Inc.', 'D18: the profile name is kept for the AI prompt');
    const legacy = await gatherFundamentalsV7(deps(false), 'SQZA');
    assert.deepEqual(legacy.fund?._peersRaw, ['000660.KS', '005930.KS', '042700.KQ', 'MQZC', 'WDC']);
    assert.equal(legacy.fund?._companyName, undefined, 'legacy: no extra field');
  });
  test('us-gaap 404 -> dei/EntityCommonStockSharesOutstanding; legacy stops at the 404', async () => {
    const body = JSON.stringify({ units: { shares: [{ end: '2026-06-30', val: 700, filed: '2026-08-01' }, { end: '2025-12-31', val: 690, filed: '2026-03-01' }] } });
    const t = new MapTransport([['/us-gaap/', 404, ''], ['/dei/EntityCommonStockSharesOutstanding', 200, body]]);
    assert.deepEqual(await fetchSharesOutstandingHistory({ http: httpOf(t) }, '0001234567', { deiFallback: true }), [{ date: '2025-12-31', value: 690 }, { date: '2026-06-30', value: 700 }]);
    const t2 = new MapTransport([['/us-gaap/', 404, ''], ['/dei/', 200, body]]);
    assert.equal(await fetchSharesOutstandingHistory({ http: httpOf(t2) }, '0001234567'), null);
    assert.equal(t2.urls.length, 1);
  });
});

describe('A5 — audit-script-properties uses the data spreadsheet after the move', () => {
  test('flag set -> the data spreadsheet; not set -> My Portfolio', async () => {
    const g = new FakeGoogle();
    g.addBook('P', 'My Portfolio');
    g.addBook('D', 'Data');
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'P', DATA_SPREADSHEET_ID: 'D' };
    const out: string[] = [];
    const ctx = createContext({ mode: 'lock' });
    const lim = RateLimiter.perMinute(1_000_000);
    assert.equal((await dataSheetClient({ env, out: (l) => out.push(l), ctx, api: g.api, limiter: lim }, 'Script Properties audit')).spreadsheetId, 'P');
    g.books.get('P')!.metadata.set(MIGRATED_FLAG, 'x');
    assert.equal((await dataSheetClient({ env, out: (l) => out.push(l), ctx, api: g.api, limiter: lim }, 'Script Properties audit')).spreadsheetId, 'D');
    assert.ok(out.includes('Script Properties audit: working on the data spreadsheet (the move is done).'));
  });
});

describe('B2 / D18 — AI prompt: fixed confidence words, method agreement, company name', () => {
  test('confidence words: >=70 high, 50-69 medium, <50 low', () => {
    assert.deepEqual([70, 69, 50, 49, 22].map(confidenceWord), ['high', 'medium', 'medium', 'low', 'low']);
  });
  const inputs = (plain: boolean) => ({
    ticker: 'AQZB', plainPrompt: plain,
    fundResult: { score: 79, verdict: 'Own-worthy', drivers: [] },
    techPlan: { techScore: 51, regime: 'CHOP', timing: 'WAIT_PULLBACK', entryPrice: 269.8, entryLow: 267.26, entryHigh: 272.34, entryConfidencePct: 56, stop: 235.75, rrToT1: 6.75, rrToT2: 14 },
    decision: { action: 'SET_LIMIT', finalConviction: 47 },
    ind: {}, confluence: { entryConfidence: 'HIGH (6/12 methods in zone)' },
    fund: { _companyName: 'Astera Labs, Inc.' }, chart: { currentPrice: 268.05 }, optAnalysis: null,
  });
  test('plain: the report carries the word, the agreement label and the name; the prompt binds them', async () => {
    const r = await buildGeminiReport(inputs(true), () => null);
    assert.equal(r.technical.confidenceWord, 'medium');
    assert.equal(r.technical.methodAgreement, 'HIGH (6/12 methods in zone)');
    assert.equal(r.companyName, 'Astera Labs, Inc.');
    const p = buildGeminiPrompt('AQZB', r);
    assert.match(p, /COMPANY NAME: the company is "Astera Labs, Inc." \(ticker AQZB\)/);
    assert.match(p, /70% or more = high, 50-69% = medium, under 50% = low/);
    assert.match(p, /"medium confidence \(56%\)"/);
    assert.match(p, /Call it "method agreement", never "confidence"/);
  });
  test('legacy: no new fields, prompt unchanged', async () => {
    const r = await buildGeminiReport(inputs(false), () => null);
    assert.equal(r.technical.confidenceWord, undefined);
    assert.equal(r.companyName, undefined);
    assert.doesNotMatch(buildGeminiPrompt('AQZB', r), /COMPANY NAME|CONFIDENCE WORDS/);
  });
});

describe('D7 — SMA200 projection exclusion reason', { skip: fixturesPresent() ? false : 'fixtures not populated' }, () => {
  test('plain: "the 12-month projection ($X) is below the current price"; "declining" only on a negative slope', () => {
    let seen = 0, rising = 0;
    for (const ticker of listFixtures()) {
      for (const bars of [260, 400, 600]) {
        const chart = buildChart(loadRawFixture(ticker), bars) as unknown as Chart;
        if (chart.closes.length < 210) continue;
        const ind = computeIndicators(chart);
        const gann = computeGann(chart);
        const legacy = computeConfluenceTargets(ind, gann, null, chart);
        const plain = computeConfluenceTargets(ind, gann, null, chart, { plainText: true });
        const L = legacy.allExitMethods.find((m) => m.name === 'SMA200 trend (12mo proj)');
        const P = plain.allExitMethods.find((m) => m.name === 'SMA200 trend (12mo proj)');
        assert.deepEqual({ ...plain, allExitMethods: [], exitMethods: [] }, { ...legacy, allExitMethods: [], exitMethods: [] }, 'only the reason text differs');
        if (!L || !L.excluded || L.price == null) continue;
        assert.equal(L.exclusionReason, 'the projected trend (based on current slope) is below current price -- SMA200 is currently declining');
        const s = slope(chart.closes, 60);
        assert.equal(P!.exclusionReason, 'the 12-month projection ($' + L.price.toFixed(2) + ') is below the current price' + (s < 0 ? ' -- the 60-day price trend it projects is declining' : ''));
        seen++;
        if (s >= 0) rising++;
      }
    }
    assert.ok(seen > 0, 'at least one fixture excludes the projection');
    assert.ok(rising > 0 && rising < seen, 'both branches (rising and falling slope) were exercised');
  });
});

describe('D8 — Volume vs 20d during market hours', () => {
  test('0.20x at 10:12 NY (11% of the session) is on pace for ~1.8x, not "Normal volume"', () => {
    const f = sessionFractionElapsed(Date.parse('2026-10-30T14:12:00Z'))!;
    assert.ok(Math.abs(f - 42 / 390) < 1e-9);
    const row = volumeVs20dText(0.2, f);
    assert.match(row.display, /^0\.20x so far \(11% of the session\) — on pace for 1\.86x$/);
    assert.match(row.note, /^High volume pace/);
  });
  test('market closed: 0.20x is "Low volume", 1.0x normal, 2x high', () => {
    assert.deepEqual(volumeVs20dText(0.2, null), { display: '0.20x LOW', note: 'Low volume' });
    assert.equal(volumeVs20dText(1, null).note, 'Normal volume');
    assert.equal(volumeVs20dText(2, null).note, 'High volume confirms move');
  });
  test('session clock: weekend and after-hours are null; the live bar must be today', () => {
    assert.equal(sessionFractionElapsed(Date.parse('2026-10-31T15:00:00Z')), null, 'Saturday');
    assert.equal(sessionFractionElapsed(Date.parse('2026-10-30T20:30:00Z')), null, '16:30 NY');
    const now = Date.parse('2026-10-30T14:12:00Z');
    assert.ok(liveBarFraction([new Date('2026-10-29T13:30:00Z'), new Date('2026-10-30T13:30:00Z')], now)! > 0);
    assert.equal(liveBarFraction([new Date('2026-10-29T13:30:00Z')], now), null, 'yesterday\'s bar is complete');
  });
});

describe('D9 — "price", not "close", while the session is live', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
  test('trend and everything models', () => {
    assert.match(trendModel(closes, 200, 'price').summary, /— price \$229\.50 is/);
    assert.match(trendModel(closes, 200).summary, /— close \$229\.50 is/);
    assert.match(everythingModel(null, null, closes, 'price').detail.join('\n') + '', /Sell check: price \$229\.50/);
  });
});

describe('D10 — support/resistance from the last year, on the right side of price', () => {
  test('IPO-period levels are dropped; resistance is above price, support below', () => {
    const n = 500, highs: number[] = [], lows: number[] = [];
    for (let i = 0; i < n; i++) {
      const base = i < 200 ? 95 : 250 + 30 * Math.sin(i / 6);
      highs.push(base + 3 + (i % 11 === 0 ? 4 : 0));
      lows.push(base - 3 - (i % 13 === 0 ? 4 : 0));
    }
    const price = 268;
    const all = srLevels(highs, lows);
    assert.ok(all.resistanceLevels.some((l) => l.level < 150), 'the full history has an IPO-period level');
    const r = recentSrLevels({ highs, lows, volumes: [] }, price);
    assert.ok(r.resistanceLevels.every((l) => l.level > price && l.level <= price * 1.5));
    assert.ok(r.supportLevels.every((l) => l.level < price && l.level >= price * 0.5));
    assert.ok(r.resistanceLevels.length > 0 && r.supportLevels.length > 0);
  });
});

describe('D11 — stale merges no longer swallow rewritten rows', () => {
  test('the unmerge (clearFormats) and the value clear go BEFORE the values, in one request', async () => {
    const calls: unknown[] = [];
    const api = {
      tabIds: async () => ok({ 'Existing': 7 }),
      batchGet: async () => ok([[['old']]]),
      batchUpdate: async (_c: unknown, u: unknown) => { calls.push(['values', u]); return ok(1); },
      batchClear: async (_c: unknown, r: unknown) => { calls.push(['clear', r]); return ok(1); },
      formatBatch: async (_c: unknown, r: unknown) => { calls.push(['format', r]); return ok(1); },
    };
    const ctx = createContext({ mode: 'lock', logLevel: LogLevel.ERROR } as never);
    const ss = await ReportWorkbook.open(new SheetsWorkbookBackend(ctx, api as never, TZ), ['Existing']);
    const sh = ss.getSheetByName('Existing')!;
    sh.clearContents(); sh.clearFormats();
    sh.getRange(1, 1, 1, 4).setValues([['$235.75', '1.50×ATR', 'CHOP → 1.50×', '$34.05']]);
    sh.getRange(2, 1, 1, 14).merge().setValue('note');
    await ss.flush();
    assert.deepEqual(calls[0], ['format', [...formatOpsToRequests(7, [{ op: 'clearFormats' }]), { updateCells: { range: { sheetId: 7 }, fields: 'userEnteredValue' } }]]);
    assert.equal((calls[1] as unknown[])[0], 'values');
    assert.deepEqual(calls[2], ['format', formatOpsToRequests(7, [{ op: 'merge', range: { row: 2, col: 1, numRows: 1, numCols: 14 } }])]);
    assert.equal(calls.length, 3, 'same number of calls as before (values clear replaced)');
  });
});

describe('D12-D15, D20 — model tab text', () => {
  test('helpers', () => {
    assert.equal(roundNumberText({ nearest: 300, increment: 100, distPct: 0.1191942311585113, near: false }), 'the nearest round number is $300 (a multiple of $100), 11.9% away -- too far to act as a level now');
    assert.equal(shortDate(new Date('2026-09-15T20:30:00Z'), TZ), 'Sep 15, 2026');
    assert.deepEqual(countDistinct(['a', 'b', 'a', 'a'], (x) => x).map((x) => [x.item, x.count]), [['a', 3], ['b', 1]]);
    assert.equal(assumedAccountText(), 'of an assumed $' + ACCOUNT.size.toLocaleString('en-US') + ' account');
  });
  test('fixtures: plain text has no raw JSON, no Date#toString, no repeated pattern lines, one RS line; legacy unchanged', { skip: fixturesPresent() ? false : 'fixtures not populated' }, () => {
    let checked = 0, legacyGmt = 0;
    for (const ticker of listFixtures().slice(0, 12)) {
      const chart = buildChart(loadRawFixture(ticker), 500) as unknown as Chart;
      if (chart.closes.length < 220) continue;
      const ind = computeIndicators(chart);
      const gann = computeGann(chart);
      const conf = computeConfluenceTargets(ind, gann, null, chart);
      const plan = computeTechnicalPlan(ind, gann, conf, chart as never, {} as never);
      const sch = buildSchabackerReport(ticker, ind, plan as never, chart as never, () => {});
      const em = buildEdwardsMageeReport(ticker, ind as never, plan as never, () => {});
      const tu = buildTurtleReport(ticker, ind as never, plan as never, chart as never, () => {});
      const opts = { plainText: true, timeZone: TZ };
      const s = formatSchabackerReport(sch, opts), e = formatEdwardsMageeReport(em, opts), t = formatTurtleReport(tu, opts);
      for (const txt of [s, e, t]) {
        assert.doesNotMatch(txt, /GMT[+-]\d{4}/, ticker + ': no Date#toString');
        assert.doesNotMatch(txt, /Near round number: \{/, ticker + ': no raw JSON');
      }
      const patternLines = s.split('\n').filter((l) => l.startsWith('  - ') && /\[(reversal|continuation|not-covered)/.test(l));
      assert.equal(new Set(patternLines).size, patternLines.length, ticker + ': no repeated pattern line');
      const rsLines = t.split('\n').filter((l) => l.includes('Relative Strength Ranking unavailable'));
      assert.ok(rsLines.length <= 1, ticker + ': RS line once');
      if (/% of account/.test(formatTurtleReport(tu))) assert.match(t, /% of an assumed \$10,000 account/);
      assert.doesNotMatch(formatSchabackerReport(sch, {}), /assumed/, 'legacy text unchanged');
      if (/GMT[+-]\d{4}/.test(formatSchabackerReport(sch) + formatEdwardsMageeReport(em))) legacyGmt++;
      checked++;
    }
    assert.ok(checked > 0);
    assert.ok(legacyGmt > 0, 'the legacy side printed Date#toString somewhere, so the date fix was exercised');
  });
});

describe('D16 — Top 10: the strike list is written once (merged)', () => {
  test('mergeTextRows: one cell per line; legacy fills all 13 cells', async () => {
    const pick = {
      found: true as const, expUnix: Date.parse('2029-01-19T00:00:00Z') / 1000, deltaFieldSeen: true,
      contract: { strike: 270, expUnix: Date.parse('2029-01-19T00:00:00Z') / 1000, delta: 0.75, iv: 0.74, bid: 114, ask: 122 },
      allCandidates: [270, 280, 260].map((k, i) => ({ strike: k, expUnix: 0, delta: 0.75 - i * 0.01, iv: 0.7, bid: 100, ask: 110, deltaDistance: i * 0.01 })),
    };
    const run = async (merge: boolean) => {
      const backend = new MemoryWorkbookBackend();
      const ss = await ReportWorkbook.open(backend, ['*']);
      const contracts = Object.assign([], { dollarFloor: 25e6 });
      buildTop10(ss, contracts as never, 'AQZB', pick as never, null, null, { nowMs: Date.parse('2026-10-30T14:12:00Z'), timeZone: TZ }, { mergeTextRows: merge });
      await ss.flush();
      return backend.grid('🏆 Top 10 Conviction');
    };
    const rowsWith = (g: unknown[][], s: string) => g.filter((r) => String(r[0]).startsWith(s));
    const fixed = await run(true);
    const head = rowsWith(fixed, 'Other strikes considered')[0]!;
    assert.equal(head.filter((c) => String(c).startsWith('Other strikes')).length, 1);
    const legacy = await run(false);
    assert.equal(rowsWith(legacy, 'Other strikes considered')[0]!.filter((c) => String(c).startsWith('Other strikes')).length, 13);
  });
});

describe('D19 — Broker "Last gap" uses the Price Gaps table\'s list', () => {
  const report = {
    ticker: 'AQZB',
    idCard: { price: 268.05, marketCapTier: 'Large Cap', floatTier: 'Normal float', atrPct: 0.085, atrFlag: 'x', relativeVolumeRead: 'x', weeklyVolatilityRead: null, monthlyVolatilityRead: null },
    playerMapping: { tag: 'Mixed', evidence: [] },
    fundamentalsScreen: { tag: 'ok', evidence: [], sharesOutstandingTrend: '', filingKeywordSearch: '' },
    technical: { lastCandleType: 'Standard', candleContext: null, srReliability: 'x', maRelationship: null, fibRead: null, vix: null },
    news: { lastGap: { type: 'DOWN', sizePct: -0.067 }, gapType: 'Island', gapCapContext: 'Large Cap — informational', earningsGap: { epsSurprisePct: 5 }, reverseSplit: null, squeezeSetup: null, shortInterestNote: null },
    technique: { tag: 't', evidence: [] }, risk: { evidence: [] }, macro: { evidence: [] },
    synthesis: { netRead: 'n', bullish: [], cautionary: [] }, institutional13F: null,
  };
  const gaps = [
    { date: new Date('2026-10-22T13:30:00Z'), type: 'DOWN', sizePct: -0.002, gapType: 'COMMON', filled: true },
    { date: new Date('2026-10-30T13:30:00Z'), type: 'DOWN', sizePct: -0.015, gapType: 'COMMON', filled: false },
  ];
  test('plain: the last gap of the analysis list, same size and class as the table', () => {
    const t = formatBrokerCourseReportV1(report as never, { plainText: true, timeZone: TZ, analysisGaps: gaps });
    assert.match(t, /Last gap: DOWN -1\.5% on Oct 30, 2026 — Common, still open \| .* \(same gap list as the Price Gaps table\)/);
    assert.doesNotMatch(t, /-6\.7%|Earnings-linked/);
    assert.match(formatBrokerCourseReportV1(report as never, { plainText: true, analysisGaps: [] }), /Last gap: none in the last ~3 months/);
  });
  test('legacy: its own detector\'s gap', () => {
    assert.match(formatBrokerCourseReportV1(report as never), /Last gap: DOWN -6\.7% — Island \| Large Cap/);
  });
});

describe('D17 — Price Chart: the Entry label is not written into the Date column', () => {
  const PLAN = { entryLow: 95, entryHigh: 99, entryCount: 3, stop: 90, t1: { price: 120 }, t2: { price: 140 }, regime: 'TREND_UP' };
  const run = async (legacy: boolean) => {
    const ss = await openBook({});
    const store: ChartStore = new Map();
    const res = await showPriceChart({
      workbook: chartWorkbook(ss, store), fetchChart: async () => bars(260), entryLadder: () => [], exitLadder: () => [],
      alert: () => {}, log: () => {}, dailyTickers: ['AMD'], legacyTabName: legacy,
    }, { ticker: 'AMD', techPlan: PLAN } as never);
    const sh = ss.getSheetByName(legacy ? '📊 AMD Chart' : PRICE_CHART_TAB)!;
    return { res: res!, grid: sh.getDataRange().getValues() };
  };
  test('fixed: column A holds the header and dates only; the label sits in its own column', async () => {
    const { res, grid } = await run(false);
    const col = res.headers.length;
    assert.ok(grid.slice(1).every((r) => r[0] instanceof Date || r[0] === ''), 'dates only in column A');
    assert.equal(grid[0]![col], 'Note');
    assert.equal(grid[1]![col], res.entryLabel);
    assert.match(res.entryLabel, /^Entry ~\$97\.00/);
  });
  test('legacy keeps the label in row headers+3 of column A', async () => {
    const { res, grid } = await run(true);
    assert.equal(grid[res.headers.length + 2]![0], res.entryLabel);
  });
});
