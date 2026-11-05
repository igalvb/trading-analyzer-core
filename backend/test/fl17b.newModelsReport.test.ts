/**
 * FL-17b: Wyckoff (original method), Trend 150, Trend 200 and the Turtle + Schabacker + E&M 2-of-3 combo in the
 * per-ticker reports (model tab / Analyze PDF, Bottom Line, Buy and Exit reports). Display only: the reads must
 * not touch any input, score, the 5-model agreement count or a Buy tier.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { reasonLine } from '../src/reports/messages/catalog.ts';
import {
  buildExtraModelsReport, comboModel, trendModel, wyckoffClassicModel, engineWyckoffRead, formatExtraModelsReport, readExtraModels, extraModelRows,
  EXTRA_MODEL_NAMES, ENGINE_WYCKOFF_NAME, EXTRA_MODELS_DISCLAIMER, type ExtraModelsChart,
} from '../src/analysis/extraModels.ts';
import { trendSeries } from '../src/analysis/models/trendFollow.ts';
import { wyckoffClassicSeries } from '../src/analysis/models/wyckoffClassic.ts';
import { buildBottomLineSummary, bottomLineTabName } from '../src/reports/bottomLine/summarySheet.ts';
import { buildBuySheet } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB, NCOLS as BUY_NCOLS } from '../src/reports/buySheet/text.ts';
import type { BuyCandidateInput } from '../src/reports/buySheet/types.ts';
import { buildExitSheet, EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import type { ExitHoldingInput } from '../src/reports/exitSheet/types.ts';
import { formatStockSignals } from '../src/reports/exit/exitReport.ts';
import { toBuyAnalysis, toExitBundle } from '../src/app/analysisCache.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS, type TickerArtifacts } from '../src/analysis/runTicker.ts';
import { formatWyckoffPage, formatTrendPage, formatComboPage } from '../src/analysis/reportPages.ts';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { compose } from '../src/compose.ts';

const TZ = 'America/New_York';

/** A synthetic daily chart: `n` bars of a steady drift (pct per day), small ranges, flat volume. */
function chartOf(n: number, drift: number, start = 100): ExtraModelsChart {
  const closes: number[] = [], opens: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [], dates: Date[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + drift + (i % 2 ? 0.002 : -0.002));
    opens.push(o); closes.push(c); highs.push(Math.max(o, c) * 1.005); lows.push(Math.min(o, c) * 0.995); volumes.push(1_000_000);
    dates.push(new Date(Date.UTC(2025, 0, 2) + i * 86400000));
  }
  return { dates, opens, highs, lows, closes, volumes };
}

const CMP = { turtleDirection: 'bullish', schabackerDirection: 'bullish', edwardsMageeDirection: 'mixed' };

describe('FL-17b — the four newer models, display only', () => {
  test('combo: 2 of 3 bullish -> bullish, 2 of 3 cautionary -> cautionary, else mixed; fewer than 2 reads -> not available', () => {
    assert.equal(comboModel(CMP).direction, 'bullish');
    assert.equal(comboModel({ turtleDirection: 'cautionary', schabackerDirection: 'bullish', edwardsMageeDirection: 'cautionary' }).direction, 'cautionary');
    assert.equal(comboModel({ turtleDirection: 'bullish', schabackerDirection: 'cautionary', edwardsMageeDirection: 'mixed' }).direction, 'mixed');
    assert.equal(comboModel({ turtleDirection: 'mixed', schabackerDirection: 'mixed', edwardsMageeDirection: 'mixed' }).direction, 'mixed');
    assert.equal(comboModel({ turtleDirection: 'bullish', schabackerDirection: 'bullish', edwardsMageeDirection: null }).direction, 'bullish');
    assert.equal(comboModel({ turtleDirection: 'bullish', schabackerDirection: null }).direction, null);
    assert.equal(comboModel(null).direction, null);
    assert.equal(comboModel(CMP).summary, 'Bullish — 2 of 3 bullish (Turtle bullish, Schabacker bullish, Edwards & Magee mixed).');
  });

  test('trend 150 / 200: the last day of trendSeries, with the average and the distance from it', () => {
    const up = chartOf(260, 0.003);
    for (const days of [150, 200] as const) {
      const r = trendModel(up.closes, days);
      const last = trendSeries(up.closes, days).at(-1)!;
      assert.equal(r.direction, last.direction);
      assert.equal(r.direction, 'bullish');
      assert.ok(r.summary.includes('above the ' + days + '-day average ($' + last.sma!.toFixed(2) + ')'), r.summary);
      assert.ok(r.summary.includes((last.strength! * 100).toFixed(1) + '% above'), r.summary);
      assert.ok(r.summary.endsWith('average rising.'), r.summary);
    }
    const down = chartOf(260, -0.004);
    assert.equal(trendModel(down.closes, 200).direction, 'cautionary');
    assert.match(trendModel(down.closes, 200).summary, /^Cautionary — close \$[\d.]+ is [\d.]+% below the 200-day average/);
    const short = chartOf(170, 0.003);
    assert.equal(trendModel(short.closes, 150).direction, 'bullish');
    assert.equal(trendModel(short.closes, 200).direction, null);
    assert.equal(trendModel(short.closes, 200).summary, 'Not enough price history (needs 200 trading days).');
  });

  test('wyckoff (original method): the last day of wyckoffClassicSeries, and causal (later bars never change an earlier read)', () => {
    const ch = chartOf(300, 0.001);
    const r = wyckoffClassicModel(ch, TZ);
    assert.equal(r.direction, wyckoffClassicSeries(ch).at(-1)!.direction);
    assert.equal(r.name, 'Wyckoff (original method)');
    const cut = 200;
    const prefix: ExtraModelsChart = { dates: ch.dates.slice(0, cut), opens: ch.opens.slice(0, cut), highs: ch.highs.slice(0, cut), lows: ch.lows.slice(0, cut), closes: ch.closes.slice(0, cut), volumes: ch.volumes.slice(0, cut) };
    assert.equal(wyckoffClassicModel(prefix, TZ).direction, wyckoffClassicSeries(ch)[cut - 1]!.direction);
    const empty = wyckoffClassicModel({ dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] }, TZ);
    assert.equal(empty.direction, null);
  });

  test('the older engine Wyckoff read is kept and labelled', () => {
    assert.equal(engineWyckoffRead({ wyckoffSchematic: null }).found, false);
    const e = engineWyckoffRead({ wyckoffSchematic: { phase: 'ACCUMULATION', stage: 'SOS/SOW', read: 'Sign of strength above the range' } });
    assert.equal(e.summary, 'Accumulation, stage SOS/SOW — Sign of strength above the range');
    assert.equal(ENGINE_WYCKOFF_NAME, 'Wyckoff (older engine read, rectangle-based)');
  });

  test('the report: inputs are not touched; tab text, rows, round trip, no leaks', () => {
    const ch = chartOf(260, 0.003);
    const ind = { wyckoffSchematic: null, rsi14: 55 };
    const freeze = <T>(o: T): T => { Object.freeze(o); for (const v of Object.values(o as object)) if (v && typeof v === 'object') freeze(v); return o; };
    freeze(ch); freeze(ind); const cmp = freeze({ ...CMP });
    const r = buildExtraModelsReport('TEST', ch, cmp, ind, TZ);
    assert.deepEqual(r.models.map((m) => m.name), Object.values(EXTRA_MODEL_NAMES));
    const text = formatExtraModelsReport(r);
    assert.ok(text.startsWith('── TEST — Wyckoff, Trend and Combo Models ──'));
    assert.ok(text.includes(EXTRA_MODELS_DISCLAIMER));
    for (const n of [...Object.values(EXTRA_MODEL_NAMES), ENGINE_WYCKOFF_NAME]) assert.ok(text.includes(n.toUpperCase() + ': '), n);
    const back = readExtraModels(JSON.parse(JSON.stringify(r)));
    assert.deepEqual(back, r);
    const rows = extraModelRows(r);
    assert.deepEqual(rows.map(([l]) => l), [...Object.values(EXTRA_MODEL_NAMES), ENGINE_WYCKOFF_NAME]);
    for (const [, t] of rows) assert.deepEqual(findReportLeaks(t), [], t);
    for (const l of text.split('\n')) assert.deepEqual(findReportLeaks(l), [], l);
    assert.equal(readExtraModels(null), null);
    assert.equal(readExtraModels({ models: 'x' }), null);
  });

  test('Bottom Line: one line per model after LILO; none when absent or in legacy mode; a "did not run" line for null', async () => {
    const r = buildExtraModelsReport('TEST', chartOf(260, 0.003), CMP, {}, TZ);
    const tp = { techScore: 60, timing: 'BUY_NOW', regime: 'TREND_UP', entryCount: 0, entryLow: 1, entryHigh: 2 };
    const run = async (extra: unknown, legacy = false): Promise<string[][]> => {
      const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
      buildBottomLineSummary(wb, 'TEST', { score: 70, verdict: 'Good' }, tp, { action: 'BUY', finalConviction: 70 }, null, null, {
        clock: { now: () => Date.UTC(2026, 9, 28, 15) }, timeZone: TZ, legacyReportText: legacy, ...(extra !== undefined ? { extraModels: extra } : {}),
      });
      return wb.getSheetByName(bottomLineTabName('TEST', legacy))!.grid().map((row) => row.map((v) => String(v ?? '')));
    };
    const withRows = await run(r);
    const labels = withRows.map((row) => row[0]);
    const lilo = labels.indexOf('🪜 LILO Ladder');
    assert.deepEqual(labels.slice(lilo + 1, lilo + 6), [
      '🏛️ Wyckoff (original method)', '📈 Trend 150 (150-day average)', '📈 Trend 200 (200-day average)', '🧩 Turtle + Schabacker + E&M (2 of 3)', '🏛️ Wyckoff (older engine read, rectangle-based)',
    ]);
    assert.equal(withRows[lilo + 4]![1], r.models[3]!.summary);
    const base = await run(undefined);
    assert.equal(base.length, withRows.length - 5);
    assert.deepEqual(base.map((x) => x[0]), labels.filter((l) => !/Wyckoff|Trend|Turtle \+/.test(l!)));
    assert.equal((await run(r, true)).length, (await run(undefined, true)).length);
    const none = await run(null);
    assert.ok(none.some((row) => row[0] === '🏛️ Wyckoff, Trend and Combo models' && row[1] === reasonLine('NOT_RUN')));
  });

  test('Buy report: the rows sit under the 5 models; the agreement line and the tier are unchanged; nothing when absent', async () => {
    const r = buildExtraModelsReport('NVDA', chartOf(260, 0.003), CMP, {}, TZ);
    const MODELS = (['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'] as const).map((m) => ({ model: m, stance: 'BULLISH', score: null }));
    const cand = (extra: Partial<BuyCandidateInput>): BuyCandidateInput => ({
      ticker: 'NVDA', status: 'ok', tier: 1, rank: 1, slot: 1, buyNow: true, blocked: false, conviction: 80, entryConfidencePct: 60, ownScore: 70, ownBand: 'own',
      timing: 'BUY_NOW', regime: 'TREND_UP', action: '✅ BUY NOW', entryZone: { low: 98, center: 101, high: 104 }, timeToEntry: null, stop: 92, rrToT1: 2, rrToT2: 3, t1: 120, t2: 135,
      entryLadder: { rungs: [], percents: [] }, sizing: null, sizingText: null, models: MODELS, comparison: { agreeCount: 5, totalCount: 5, majority: 'BULLISH', dissenters: [] },
      options: null, held: null, addToPosition: false, opportunityCost: [], promotion: null, change: null, bitcoinGroup: false, dataHealth: ['Data quality', 'No data issues.'], note: null,
      ...extra,
    } as BuyCandidateInput);
    const sheet = async (c: BuyCandidateInput) => {
      const be = new MemoryWorkbookBackend({});
      const ss = await ReportWorkbook.open(be, ['*']);
      const res = buildBuySheet(ss, { runAt: new Date('2026-10-28T20:00:00Z'), candidates: [c], seeded: false, portfolioOk: true });
      await ss.flush();
      return { res, g: be.grid(BUY_SHEET_TAB, BUY_NCOLS).map((row) => row.map((v) => String(v ?? ''))) };
    };
    const a = await sheet(cand({ extraModels: r }));
    const b = await sheet(cand({}));
    assert.deepEqual(a.res.tiers, b.res.tiers);
    const colA = a.g.map((row) => row[0]);
    const agree = colA.findIndex((t) => /5 of 5/.test(t!));
    assert.ok(agree > 0, 'agreement line present');
    assert.equal(b.g.map((row) => row[0]).find((t) => /5 of 5/.test(t!)), colA[agree], 'agreement line unchanged');
    assert.ok(colA[agree + 1]!.startsWith('More model reads'));
    assert.deepEqual(colA.slice(agree + 2, agree + 7), [...Object.values(EXTRA_MODEL_NAMES), ENGINE_WYCKOFF_NAME]);
    assert.equal(a.g[agree + 2]![1], r.models[0]!.summary);
    assert.equal(b.g.length, a.g.length - 6);
    assert.ok(!b.g.flat().some((t) => t.includes('Wyckoff (original method)')));
  });

  test('Exit report: the rows sit under the 5 models; nothing when absent', async () => {
    const r = buildExtraModelsReport('TSLA', chartOf(260, -0.004), CMP, {}, TZ);
    const hold = (extra: Partial<ExitHoldingInput>): ExitHoldingInput => ({
      ticker: 'TSLA', kind: 'STOCK', position: { quantity: 10, avgCost: 200, entryDate: '2025-01-10', currentPrice: 250 },
      signals: formatStockSignals({ chandelierSinceEntry: 210, t1: 260, t2: 300, hitT1: false, hitT2: false, entryDateStr: '2025-01-10' }, true),
      levels: { stopLevel: 210, stopBasis: 'SINCE_ENTRY', stopBreached: false, thesisInvalidated: false, t1: 260, hitT1: false, t2: 300, hitT2: false },
      models: (['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'] as const).map((m) => ({ model: m, stance: 'BULLISH' as const, score: null })),
      comparison: { agreeCount: 5, totalCount: 5, majority: 'BULLISH', dissenters: [] }, dataHealth: [], ...extra,
    } as ExitHoldingInput);
    const sheet = async (h: ExitHoldingInput) => {
      const be = new MemoryWorkbookBackend({});
      const ss = await ReportWorkbook.open(be, ['*']);
      buildExitSheet(ss, { runAt: new Date('2026-10-28T20:00:00Z'), holdings: [h], skipped: { crypto: [], otherStock: [], blankTickerRowCount: 0 }, dataHealth: [] } as never);
      await ss.flush();
      return be.grid(EXIT_SHEET_TAB).map((row) => row.map((v) => String(v ?? '')));
    };
    const a = await sheet(hold({ extraModels: r }));
    const b = await sheet(hold({}));
    const colA = a.map((row) => row[0]);
    const at = colA.indexOf(EXTRA_MODEL_NAMES.TREND_200);
    assert.ok(at > 0);
    assert.ok(a[at]![1]!.startsWith('Cautionary — close $'), a[at]![1]);
    assert.equal(colA[at - 3]!.startsWith('More model reads'), true);
    assert.equal(b.length, a.length - 6);
    for (const t of a.flat()) assert.deepEqual(findReportLeaks(t), [], t);
  });

  test('the nightly projections carry the reads only when the run made them', () => {
    const r = buildExtraModelsReport('X', chartOf(260, 0.003), CMP, {}, TZ);
    const art = (extra: unknown): TickerArtifacts => ({
      ticker: 'X', status: {} as never, dataQuality: [], texts: {}, result: { fundResult: {} as never, techPlan: {} as never, decision: {} as never },
      reports: { comparison: null, ...(extra !== undefined ? { extraModels: extra as never } : {}) },
    });
    assert.equal(toBuyAnalysis(art(r)).extraModels, r);
    assert.equal(toExitBundle(art(r)).extraModels, r);
    assert.ok(!('extraModels' in toBuyAnalysis(art(undefined))));
    assert.ok(!('extraModels' in toExitBundle(art(null))));
  });

  test('the Analyze PDF reads the model pages (FL-17e: split into Wyckoff, Trend and Combo, before the comparison)', () => {
    const order = reportTabOrder();
    for (const t of [MODEL_TABS.wyckoff, MODEL_TABS.trend, MODEL_TABS.combo]) assert.ok(order.indexOf(t) > 0 && order.indexOf(t) < order.indexOf(MODEL_TABS.comparison), t);
  });

  const B = fixturesPresent() ? fixtureBodies() : {};
  const net: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
      const t = m ? decodeURIComponent(m[1]!) : null;
      if (t && B[t]) return new HttpResponse(200, new TextEncoder().encode(B[t]));
      return new HttpResponse(404, new TextEncoder().encode('not found'));
    },
  };
  test('end to end (offline fixtures): the run writes the tab from its own chart and comparison', { skip: fixturesPresent() ? false : 'fixtures missing' }, async () => {
    const c = await compose({ storage: 'memory', env: { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ }, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    const art = await c.analyze('TSLA');
    assert.equal(art.aborted, undefined);
    const extra = art.reports.extraModels!;
    assert.ok(extra && extra.models.length === 4);
    const cmp = art.reports.comparison!;
    assert.deepEqual(extra.models[3], comboModel(cmp));
    assert.deepEqual(extra.models[1], trendModel(art.chart!.closes, 150));
    // FL-17e: the shared tab is split into three pages, each written from the same report.
    assert.equal(art.texts[MODEL_TABS.wyckoff], formatWyckoffPage(extra, 'TSLA'));
    assert.equal(art.texts[MODEL_TABS.trend], formatTrendPage(extra, 'TSLA'));
    assert.equal(art.texts[MODEL_TABS.combo], formatComboPage(extra, 'TSLA'));
    for (const t of [MODEL_TABS.wyckoff, MODEL_TABS.trend, MODEL_TABS.combo]) assert.ok(c.workbook.getSheetByName(t), t + ' written');
  });
});
