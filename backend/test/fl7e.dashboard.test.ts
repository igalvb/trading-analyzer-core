/**
 * FL-7e: the dashboard writer (hdrV7, buildDashboardV7 and its helpers) against
 * the oracle. Legacy and port run on twin ReportWorkbooks with independently
 * built, identical inputs; the tests compare every recorded range call of every
 * tab, the cells, the thrown message, the data-status record after the run and
 * the injected 13F / time-budget calls. V8 block coverage over the legacy
 * functions guards that every branch is reached (see UNREACHABLE).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector/promises';
import { pathToFileURL } from 'node:url';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { fakeSession } from './gasFakes.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { transactionsGrid, snapshotGrid, TX_SHEET, SNAPSHOT_TAB } from './fl7b1Fixtures.ts';
import { ReportWorkbook, MemoryWorkbookBackend, callsToFormatOps } from '../src/sheets/reportSheet.ts';
import { classifyEarningsGapV1 } from '../src/analysis/models/brokerCourse/gaps.ts';
import { TZ, NOW, DEFAULT_FAKES, legacyBook, legacySheet, pipelines, makeScenarios, type Scenario, type Inputs, type ScenarioKit } from './fl7eFixtures.ts';
import { buildDashboard, DASHBOARD_TAB, DASHBOARD_VERSION, GEMINI_MODEL, type DashboardDeps } from '../src/reports/dashboard/dashboard.ts';
import { hdr, scoreBar, colorVerdictRow9, gapMarketCapContext, renderAiReview, buildDataStatusBanner, classifyGapCause } from '../src/reports/dashboard/helpers.ts';
import { DashRange, DashSheet } from '../src/reports/dashboard/sheetAdapter.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LEG_PATH = path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs');

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

interface Pair { lerr: string | null; perr: string | null; L: ReportWorkbook; P: ReportWorkbook; a: Inputs; b: Inputs; lcalls: unknown[][]; pcalls: unknown[][] }

/** Runs the oracle's buildDashboardV7 and the port on twin workbooks and identical, independently built inputs. */
async function runPair(o: ReturnType<typeof loadOracle>, sc: Scenario): Promise<Pair> {
  const F = { ...DEFAULT_FAKES, ...(sc.fakes ?? {}) };
  const initial = sc.initial ?? {};
  const mk = () => ReportWorkbook.open(new MemoryWorkbookBackend(structuredClone(initial) as never), sc.preload ?? ['*']);
  const L = await mk(), P = await mk();
  const a = sc.build(), b = sc.build();
  let fake: any = null;
  if (sc.scores) {
    fake = withOracleGlobals({ Date: pinnedDateClass(NOW), readBrokerDataCacheV1_: () => null }, () => o.callNormalized<any>('scoreAllSignalsV7_', structuredClone(a.ind), structuredClone(a.fund), structuredClone(a.gann), structuredClone(a.chart), a.techPlan.regime, a.existingShortInterest));
    sc.scores(fake, a);
  }
  if (sc.post) { sc.post(a); sc.post(b); }
  const lcalls: unknown[][] = [], pcalls: unknown[][] = [];
  let lerr: string | null = null, perr: string | null = null;
  const holdings = () => structuredClone(F.holdings);
  const thrown = (e: any): string => String(e && e.message !== undefined ? e.message : e);
  withOracleGlobals({
    Date: pinnedDateClass(NOW), Session: fakeSession(TZ), SpreadsheetApp: { getActiveSpreadsheet: () => legacyBook(L), flush: () => {}, getUi: () => null },
    readBrokerDataCacheV1_: () => null,
    fetch13FCusipV7: (t: string) => { lcalls.push(['cusip', t]); if (F.cusipThrows) throw new Error(F.cusipThrows); return F.cusip; },
    fetchInstitutional13FHoldingsV7: (c: string) => { lcalls.push(['holdings', c]); if (F.holdingsThrows !== undefined) { if (F.holdingsThrows === '') throw 'plain string'; throw new Error(F.holdingsThrows); } return holdings(); },
    hasTimeBudgetV7_: (m: number) => { lcalls.push(['budget', m]); return F.budget; },
    ...(fake ? { scoreAllSignalsV7_: () => fake } : {}),
  }, () => {
    try { o.call('buildDashboardV7', legacyBook(L), a.ticker, a.chart, a.ind, a.gann, a.confluence, a.fundResult, a.techPlan, a.decision, a.fund, a.opts, a.fundSource, a.aiReview, a.status, a.ladderStock, a.ladderOptions, a.leaps, a.shortTerm, a.existing13F, a.existingShortInterest); } catch (e) { lerr = thrown(e); }
  });
  const deps: DashboardDeps = {
    nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, legacyReportText: true,
    fetch13FCusip: async (t) => { pcalls.push(['cusip', t]); if (F.cusipThrows) throw new Error(F.cusipThrows); return F.cusip; },
    fetchInstitutional13FHoldings: async (c) => { pcalls.push(['holdings', c]); if (F.holdingsThrows !== undefined) { if (F.holdingsThrows === '') throw 'plain string'; throw new Error(F.holdingsThrows); } return holdings(); },
    hasTimeBudget: (m) => { pcalls.push(['budget', m]); return F.budget; },
    scoreAll: fake ? ((async () => fake) as never) : undefined, sheetsParsedLabels: sc.sheetsParsedLabels ?? false,
  };
  try { await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest, deps); } catch (e) { perr = thrown(e); }
  return { lerr, perr, L, P, a, b, lcalls, pcalls };
}

const cellText = (wb: ReportWorkbook, tab = DASHBOARD_TAB): string => wb.getSheetByName(tab)!.grid().flat().filter((v) => typeof v === 'string').join('\n');

/** Lines of `src` (1-based, within each [name, from, to]) holding code V8 counted as never executed (an untaken branch, ternary arm or || / && right side counts). */
function uncoveredLines(cov: any[], url: string, src: string, ranges: ReadonlyArray<readonly [string, number, number]>): Record<string, number[]> {
  const script = cov.find((c) => c.url === url);
  assert.ok(script, 'coverage has no script ' + url);
  const counts = new Int32Array(src.length).fill(1);
  const all: Array<{ s: number; e: number; c: number }> = [];
  for (const f of script.functions) for (const r of f.ranges) all.push({ s: r.startOffset, e: r.endOffset, c: r.count });
  all.sort((x, y) => x.s - y.s || y.e - x.e);
  for (const r of all) counts.fill(r.c, r.s, Math.min(r.e, src.length));
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const out: Record<string, number[]> = {};
  for (const [name, a, b] of ranges) {
    const lines: number[] = [];
    for (let ln = a; ln <= b; ln++) {
      const s = starts[ln - 1], e = ln < starts.length ? starts[ln] : src.length;
      const t = src.slice(s, e).trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      let z = false;
      for (let k = s; k < e; k++) if (counts[k] === 0 && !/\s/.test(src[k])) { z = true; break; }
      if (z) lines.push(ln);
    }
    out[name] = lines;
  }
  return out;
}

/**
 * Legacy lines of the dashboard and its helpers that NO scenario can reach, with the reason.
 * Every other line must be reached (V8 block coverage during the run). If the test lists extra
 * lines, either add a scenario that reaches them or document why they cannot be reached.
 */
const UNREACHABLE: Record<string, Record<number, string>> = {
  hdrV7: {},
  buildDashboardV7: {
    3465: 'the per-row catch around a banner row: getRange / merge / setValue on a fixed 14-column range cannot throw',
    3476: '`r.meta || {}`: renderAiReviewV7_ always returns a meta object',
    3480: '`if (m.italic)`: renderAiReviewV7_ never sets italic',
    3484: 'the per-row catch of the AI review: nothing in the row can throw',
    3966: '`scores.shortW || {}`: Object.entries(scores.shortW) at :3931 already threw for a missing shortW (F-E5)',
    3967: '`scores.longW || {}`: same, longW (F-E5)',
    4313: 'the per-row catch of the Gann fan table: f0 is checked non-null just above and its level/pct are numbers, so toFixed cannot throw',
    4519: 'the per-row catch of the options table: the rows are fixed 5-wide',
    4538: 'the outer catch of Key levels: only hdrV7 and a fixed-width setValues sit outside the per-row try',
    4551: 'the per-paragraph catch of the summary: fixed 14-column merges cannot throw',
  },
  colorVerdictRow9V7_: {},
  buildNarrativeV7_: {},
  buildDataStatusBannerV7: {},
  renderAiReviewV7_: {},
  gapMarketCapContextV7: {},
  classifyGapCauseV7: {},
  scoreBar: {},
};
const LEGACY_RANGES = [
  ['hdrV7', 3438, 3440], ['buildDashboardV7', 3442, 4559], ['colorVerdictRow9V7_', 5022, 5028], ['buildNarrativeV7_', 5030, 5121], ['buildDataStatusBannerV7', 5130, 5159],
  ['renderAiReviewV7_', 8878, 8895], ['gapMarketCapContextV7', 8674, 8682], ['classifyGapCauseV7', 8455, 8473], ['scoreBar', 8988, 8988],
] as const;

/** The same measure over the port's own files: an arm the port never took shows up here. */
function reportPortCoverage(cov: any[], documented: number): void {
  let portUncovered = 0;
  for (const [label, rel] of [['dashboard', 'src/reports/dashboard/dashboard.ts'], ['helpers', 'src/reports/dashboard/helpers.ts']] as const) {
    const file = path.resolve(rel);
    const psrc = fs.readFileSync(file, 'utf8');
    const u = uncoveredLines(cov, pathToFileURL(file).href, psrc, [[label, 1, psrc.split('\n').length]]);
    portUncovered += u[label].length;
    console.log('port ' + label + ' lines never reached: ' + u[label].join(','));
  }
  // The oracle scenarios run legacyReportText, so the plain-mode Data quality box (F-82, F-E2: pre-header 13F step,
  // dashboard.ts ~124-149 and its row helpers) is never reached here. test/fl7b3.integration.test.ts tests it directly.
  const PLAIN_MODE_ONLY_LINES = 35;
  // Fix plan 2026-10-30 (docs/FIX_PLAN_2026-10-30.md) added plain-mode-only arms to dashboard.ts: the E1 buy-limit
  // label block, 'Method agreement', expiry/LEAPS wording, whole-chain put/call text. They are tested directly in
  // test/e1.atBuyLimit.test.ts, test/fixPlan20261030.test.ts and test/fix20261030.reportFixes.test.ts.
  const FIX_PLAN_20261030_PLAIN_LINES = 12;
  // B1 option B (display only): the 🧱 NEXT RESISTANCE row, plain mode only; tested directly below and in test/b1.optionB.test.ts.
  const NEXT_RESISTANCE_PLAIN_LINES = 9;
  // Owner 2026-11-01: the Claude Opus second-opinion section (Analyze only, deps.opusReview); tested in test/analyzeOpus.test.ts.
  const ANALYZE_OPUS_LINES = 11;
  assert.ok(portUncovered <= documented + PLAIN_MODE_ONLY_LINES + FIX_PLAN_20261030_PLAIN_LINES + NEXT_RESISTANCE_PLAIN_LINES + ANALYZE_OPUS_LINES + 12,'port lines never reached (' + portUncovered + ') stay close to the documented unreachable legacy lines (' + documented + ')');
}

let MAIN: { kit: ScenarioKit; results: Map<string, Pair> } | null = null;

describe('FL-7e — dashboard writer (hdrV7, buildDashboardV7 and its helpers)', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('legacy boundaries: start text and closing brace of every ported function', () => {
    const lines = fs.readFileSync(LEG_PATH, 'utf8').split('\n');
    const ranges: Array<[number, number, string]> = [
      [3438, 3440, 'function hdrV7(sh, row, text, color, fontSize, colSpan) {'],
      [3442, 4559, 'function buildDashboardV7(ss, ticker, chart, ind, gann, confluence, fundResult, techPlan, decision, fund, opts, fundSource, aiReview, status, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg, existingInstitutional13F, existingShortInterest) {'],
      [5022, 5028, 'function colorVerdictRow9V7_('], [5030, 5121, 'function buildNarrativeV7_('], [5130, 5159, 'function buildDataStatusBannerV7(status) {'],
      [8878, 8895, 'function renderAiReviewV7_(text) {'], [8674, 8682, 'function gapMarketCapContextV7(gap, marketCap) {'], [8455, 8473, 'function classifyGapCauseV7(gap, earningsHistory) {'],
      [8817, 8823, 'function fmtExpiryV7_(v) {'],
    ];
    for (const [a, b, text] of ranges) {
      assert.ok(lines[a - 1].startsWith(text), a + ': ' + lines[a - 1]);
      assert.equal(lines[b - 1], '}', 'closing brace of ' + a);
    }
    assert.ok(lines[8988 - 1].startsWith('function scoreBar(score){'));
    assert.equal(lines.slice(3442, 4558).filter((l) => /^ {2}function /.test(l)).length, 0, 'guard: no top-level helper hides inside buildDashboardV7');
    assert.equal(lines.slice(3442, 4558).filter((l) => /^ {4,}function (writeContractLine|biggestDriver|traceLine)\(/.test(l)).length, 3, 'the three nested helpers the port keeps as inner functions');
  });

  test('legacy constants the port copies', () => {
    const src = fs.readFileSync(LEG_PATH, 'utf8');
    assert.match(src, /^ {2}tab: {5}'📊 Analysis v7',$/m);
    assert.match(src, /^ {2}version: 'v10\.9' \/\//m);
    assert.match(src, /^const GEMINI_MODEL {5}= 'gemini-flash-lite-latest';$/m);
    assert.equal(DASHBOARD_TAB, '📊 Analysis v7');
    assert.equal(DASHBOARD_VERSION, 'v10.9');
    assert.equal(GEMINI_MODEL, 'gemini-flash-lite-latest');
  });

  test('guard: the zone and locale the Date/number text depends on are really pinned', async () => {
    await inZone(TZ, () => {
      assert.equal(new Date(Date.UTC(2026, 0, 1, 12)).getTimezoneOffset(), 300, 'process zone is America/New_York');
      assert.equal((1234567).toLocaleString(), '1,234,567', 'process locale groups with commas (en-US)');
      assert.equal(new Date(NOW).toLocaleString(), new Date(NOW).toLocaleString('en-US', { timeZone: TZ }));
    });
  });

  test('every scenario equals the oracle; helpers equal the oracle; every legacy branch is reached; the findings hold', async () => {
    await inZone(TZ, async () => {
      const o = loadOracle();
      const pipes = pipelines(o, { listFixtures, loadRawFixture, buildChart }, 4);
      assert.equal(pipes.length, 4, 'guard: four real tickers with >= 250 bars');
      const kit = makeScenarios(o, pipes, { TX_SHEET, SNAPSHOT_TAB, transactionsGrid, snapshotGrid });
      assert.ok(kit.scenarios.length >= 200, 'guard: scenario count ' + kit.scenarios.length);
      assert.equal(new Set(kit.scenarios.map((s) => s.name)).size, kit.scenarios.length, 'guard: scenario names are unique');
      const results = new Map<string, Pair>();
      const session = new inspector.Session();
      session.connect();
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      let cov: any[];
      try {
        for (const sc of kit.scenarios) {
          const r = await runPair(o, sc);
          results.set(sc.name, r);
          assert.equal(r.perr, r.lerr, sc.name + ': thrown message');
          assert.deepStrictEqual(r.P.getSheets().map((s) => s.getName()), r.L.getSheets().map((s) => s.getName()), sc.name + ': tabs');
          if (sc.portDiffers) {
            // F-B2 echo (F-E8): the Sheets-label default merges the SELL typed 'Jan 15, 2027' and prints option expiries as the parsed Date would
            const ls = r.L.getSheetByName(DASHBOARD_TAB)!, ps = r.P.getSheetByName(DASHBOARD_TAB)!;
            assert.equal(ps.calls.length, ls.calls.length, sc.name + ': same number of calls');
            const diff = ls.calls.map((c, k) => (JSON.stringify(c) === JSON.stringify(ps.calls[k]) ? -1 : k)).filter((k) => k >= 0);
            assert.ok(diff.length >= 2 && diff.length <= 6, sc.name + ': differing calls ' + diff.length);
            for (const k of diff) assert.match(JSON.stringify(ls.calls[k]), /You hold|Biggest bets|Jan 15, 2027|Portfolio data issues/, sc.name + ': only the position line, the warning count and expiry labels differ');
            continue;
          }
          for (const ls of r.L.getSheets()) {
            const ps = r.P.getSheetByName(ls.getName())!;
            assert.deepStrictEqual(ps.calls, ls.calls, sc.name + ': call log of ' + ls.getName());
            assert.deepStrictEqual(ps.grid(), ls.grid(), sc.name + ': cells of ' + ls.getName());
          }
          assert.deepStrictEqual(r.b.status, r.a.status, sc.name + ': data status after the run');
          assert.deepStrictEqual(r.pcalls, r.lcalls, sc.name + ': 13F / time-budget calls');
        }
        await helperChecks(o);
        cov = (await session.post('Profiler.takePreciseCoverage')).result;
      } finally {
        await session.post('Profiler.stopPreciseCoverage');
        session.disconnect();
      }
      MAIN = { kit, results };

      // ---- branch reach: legacy ----------------------------------------------------------------
      const src = fs.readFileSync(LEG_PATH, 'utf8');
      const srcLines = src.split('\n');
      const actual = uncoveredLines(cov, 'legacy/fullStockAnalysisV10_9.gs', src, LEGACY_RANGES);
      console.log('legacy lines never reached:\n' + Object.entries(actual).map(([k, v]) => '  ' + k + ': ' + v.map((n) => n + ' ' + srcLines[n - 1].trim().slice(0, 70)).join(' || ')).join('\n'));
      for (const [name, lines] of Object.entries(actual)) {
        assert.deepStrictEqual(lines.filter((n) => !(n in UNREACHABLE[name])), [], name + ': legacy lines no scenario reaches that are not documented as unreachable');
      }
      // ---- branch reach: the port --------------------------------------------------------------
      reportPortCoverage(cov, Object.values(UNREACHABLE).reduce((n, m) => n + Object.keys(m).length, 0));

      // ---- witnesses that the interesting branches really produced their text -------------------
      const names = [...results.keys()];
      console.log('scenarios where both sides threw (same message): ' + names.filter((n) => results.get(n)!.lerr !== null).join(' | '));
      const T = (n: string): string => cellText(results.get(n)!.L);
      const has = (n: string, s: string): void => assert.ok(T(n).includes(s), n + ' -> ' + s);
      has('regime TREND_UP BUY_NOW', 'Near current price — plan says buy now');
      has('regime TREND_DOWN AVOID', 'Plan says AVOID');
      has('regime CHOP WAIT_PULLBACK', 'Wait for the zone');
      has('opts: conflict, puts', 'CONFLICT');
      has('opts: absent', 'No options snapshot for PLTR');
      has('ladder stock+options, empty ladders', 'ladder unavailable for this run');
      has('ladder options requested, no options data', 'no usable options data');
      assert.ok(!T('contracts: neither').includes('RECOMMENDED CONTRACT'), 'neither pick: the section is omitted');
      has('13F: fetch, holdings real', 'NEW position');
      has('13F: closed positions only', 'now CLOSED');
      has('status: failed only, no detail', 'PARTIAL DATA');
      has('status: all ok', 'All data sources OK');
      has('bare ' + pipes[0].ticker, 'No fundamental signal data');
      for (const v of ['BUY', 'HOLD']) assert.ok(names.some((n) => results.get(n)!.a.decision.action === v), 'guard: decision action ' + v);
      const verdicts = new Set<string>();
      for (const n of names) for (const c of results.get(n)!.L.getSheetByName(DASHBOARD_TAB)!.calls) if (c[0] === 'range:setValues' && String((c[5] as any)[0][0]).startsWith('SHORT (Days')) verdicts.add(String((c[5] as any)[0][2]));
      assert.ok(verdicts.size >= 2, 'guard: at least two different technical verdicts reached: ' + [...verdicts].join(' / '));

      // ---- the findings, demonstrated -----------------------------------------------------------
      const POS = 'position: stock + options with and without snapshot, warnings';
      has(POS, 'YOUR POSITION'); has(POS, 'no recent options snapshot'); has(POS, 'Portfolio data issues');
      assert.ok(!T('position: tabs not loaded -> silently absent').includes('YOUR POSITION'), 'F-E1: tabs not loaded -> no position section, no error');
      assert.ok(!T('position: none for this ticker').includes('YOUR POSITION'));
      // F-E2 the banner is drawn before the 13F step sets its status
      assert.equal(results.get('13F: fetch, time budget exhausted')!.a.status.institutionalHoldings.state, 'skipped');
      assert.ok(!/time budget|13F|Institutional holdings/.test(T('13F: fetch, time budget exhausted')), 'F-E2: a skipped 13F is nowhere on its own dashboard');
      // F-E3 raw error text reaches the sheet and the status detail
      assert.match(T('break: ladder'), /LILO ladder error: Cannot read properties of undefined \(reading 'toFixed'\)/);
      assert.match(T('break: macro range'), /Macro range error: Cannot read properties of undefined/);
      assert.equal(results.get('13F: holdings fetch throws')!.a.status.institutionalHoldings.detail, 'SEC EDGAR returned 503');
      // F-E4 vertical alignment and cell notes are in the call log; whether formatOps forwards them depends on EDIT #1/#2
      const pcalls = results.get('full ' + pipes[0].ticker)!.P.getSheetByName(DASHBOARD_TAB)!.calls;
      assert.ok(pcalls.some((c) => c[0] === 'range:setVerticalAlignment') && pcalls.some((c) => c[0] === 'range:setNote'), 'guard: both calls were made');
      console.log('F-E4: callsToFormatOps forwards verticalAlignment/note: ' + callsToFormatOps(pcalls).some((op) => ['verticalAlignment', 'note'].includes((op as { op: string }).op)));
      // F-E5 a missing shortW stops the cross-reference section, the rest runs
      const W = 'scores: weights missing (the cross-reference section stops, the rest runs)';
      assert.match(T(W), /Cross-reference error: Cannot convert undefined or null to object/);
      has(W, 'GANN ANGULAR SUMMARY');
    });
  });

  test('port-only: default deps, custom tab / version / model, and the adapter passthrough', async () => {
    assert.ok(MAIN, 'runs after the scenario test');
    await inZone(TZ, async () => {
      const { kit, results } = MAIN!;
      const sc = kit.scenarios.find((s) => s.name === 'bare ' + kit.pipes[0].ticker)!;
      const open = () => ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
      const run = async (extra: Partial<DashboardDeps>) => {
        const P = await open();
        const b = sc.build();
        await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest,
          { nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, fetch13FCusip: async () => null, fetchInstitutional13FHoldings: async () => null, ...extra });
        return P;
      };
      const P1 = await run({ legacyReportText: true });
      assert.deepStrictEqual(P1.getSheetByName(DASHBOARD_TAB)!.calls, results.get(sc.name)!.L.getSheetByName(DASHBOARD_TAB)!.calls, 'no hasTimeBudget / scoreAll given: same as legacy');
      const P2 = await run({ tab: 'My Tab', version: 'v99', geminiModel: 'model-x' });
      assert.equal(P2.getSheetByName(DASHBOARD_TAB), null);
      const t2 = cellText(P2, 'My Tab');
      assert.match(t2, /Investor Briefing v99/);
      assert.match(t2, /\(Gemini model-x\)/);
      const calls: unknown[] = [];
      const stub: any = { sheet: { calls: [] as unknown[] }, row: 1, col: 2, numRows: 1, numCols: 3, setVerticalAlignment(a: string) { calls.push(['native', a]); return this; } };
      new DashRange(stub).setVerticalAlignment('top').setNote('n');
      assert.deepStrictEqual(calls, [['native', 'top']]);
      assert.deepStrictEqual(stub.sheet.calls, [['range:setNote', 1, 2, 1, 3, 'n']]);
      const wb = await open();
      const ds = new DashSheet(wb.insertSheet('T'));
      ds.getRange(2, 1, 1, 3).merge().setValue('x').setVerticalAlignment('top').setNote('n');
      assert.deepStrictEqual(wb.getSheetByName('T')!.calls.map((c) => c[0]), ['range:merge', 'range:setValue', 'range:setVerticalAlignment', 'range:setNote']);
    });
  });

  test('plain mode (F-82, F-E2, F-E1): a Data quality box replaces the banner, the 13F step is in it, a broken position read says so', async () => {
    assert.ok(MAIN, 'runs after the scenario test');
    await inZone(TZ, async () => {
      const { kit } = MAIN!;
      const run = async (name: string, F: Partial<typeof DEFAULT_FAKES>, extra: Partial<DashboardDeps> = {}) => {
        const sc = kit.scenarios.find((s) => s.name === name)!;
        const P = await ReportWorkbook.open(new MemoryWorkbookBackend(structuredClone(sc.initial ?? {}) as never), sc.preload ?? ['*']);
        const b = sc.build();
        if (sc.post) sc.post(b);
        const f = { ...DEFAULT_FAKES, ...(sc.fakes ?? {}), ...F };
        const details: string[] = [];
        await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest, {
          nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, onReportDetail: (l) => details.push(l), sheetsParsedLabels: false,
          fetch13FCusip: async () => { if (f.cusipThrows) throw new Error(f.cusipThrows); return f.cusip; },
          fetchInstitutional13FHoldings: async () => { if (f.holdingsThrows) throw new Error(f.holdingsThrows); return structuredClone(f.holdings); },
          hasTimeBudget: () => f.budget, ...extra,
        });
        const grid = P.getSheetByName(DASHBOARD_TAB)!.grid().map((r) => r.filter((v) => typeof v === 'string' && v !== '').join(' | '));
        return { b, grid, text: grid.join('\n'), details };
      };
      const at = (g: string[], s: string): number => g.findIndex((l) => l.includes(s));
      const bare = 'bare ' + kit.pipes[0].ticker;
      const skipped = await run(bare, { budget: false });
      assert.ok(!/All data sources OK|PARTIAL DATA/.test(skipped.text), 'no legacy banner');
      assert.ok(at(skipped.grid, 'Data quality') >= 0 && at(skipped.grid, 'Data quality') < at(skipped.grid, 'PRICE SNAPSHOT'), 'the box is at the top');
      assert.ok(skipped.text.includes('Note: Institutional holdings: This step did not run. This source is left out of the result.'), skipped.grid.slice(0, 6).join('\n'));
      assert.equal(skipped.b.status.institutionalHoldings.state, 'skipped');
      // L-1, L-3: with no AI review the report says it was not run and the header does not name Gemini.
      assert.equal(skipped.b.aiReview, null);
      assert.ok(skipped.text.includes('The AI review was not run for this report. Every number below is unaffected.'));
      assert.ok(!/GEMINI_API_KEY|Script Properties|\+ Gemini AI/.test(skipped.text), 'no Apps Script setup hint, no Gemini in the header');
      const withAi = await run('full ' + kit.pipes[0].ticker, {});
      assert.ok(withAi.b.aiReview, 'the full scenario has an AI review');
      assert.ok(withAi.text.includes('Options Intelligence + Gemini AI   |   Source: '), 'header names Gemini when the review is there');
      assert.ok(!withAi.text.includes('The AI review was not run'));
      const failed = await run(bare, { cusip: 'CUSIP1', holdingsThrows: 'SEC EDGAR returned 503' });
      assert.match(failed.text, /Warning: Institutional holdings: /);
      assert.ok(!failed.text.includes('503'), 'no raw error on the sheet');
      assert.equal(failed.b.status.institutionalHoldings.detail, 'SEC EDGAR returned 503', 'the status (log side) keeps the detail');
      const given = await run(bare, { budget: false }, { dataQuality: [{ label: 'Fundamentals', reasonCode: 'RATE_LIMIT', effect: 'PRICE_CHART_ONLY', now: new Date(NOW) }] });
      assert.ok(given.text.includes('Warning: Fundamentals: The request limit was reached. The score uses price and chart signals only.'));
      assert.ok(at(given.grid, 'Fundamentals: The request') < at(given.grid, 'Institutional holdings'));
      const pos = await run('position: tabs not loaded -> silently absent', {});
      assert.ok(pos.text.includes('Your position: The sheet could not be read.'), 'F-E1: one plain line');
      assert.ok(pos.details.some((l) => l.startsWith('YOUR POSITION section failed: ')));
    });
  });

  test('E1 (option A): price inside / below the buy zone with timing WAIT_PULLBACK -> the entry row says AT YOUR BUY LIMIT; legacy text unchanged', async () => {
    assert.ok(MAIN, 'runs after the scenario test');
    await inZone(TZ, async () => {
      const { kit } = MAIN!;
      const sc = kit.scenarios.find((s) => s.name === 'bare ' + kit.pipes[0].ticker)!;
      const entryRow = async (shift: (cp: number) => { lo: number; hi: number; stop: number }, legacyReportText = false): Promise<string[]> => {
        const P = await ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
        const b = sc.build();
        const cp = b.chart.currentPrice as number;
        const { lo, hi, stop } = shift(cp);
        b.techPlan = { ...b.techPlan, timing: 'WAIT_PULLBACK', entryLow: lo, entryHigh: hi, entryPrice: (lo + hi) / 2, stop };
        b.confluence = { ...b.confluence, entryLow: lo, entryHigh: hi, entryCenter: (lo + hi) / 2 };
        await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest,
          { nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, fetch13FCusip: async () => null, fetchInstitutional13FHoldings: async () => null, legacyReportText });
        return P.getSheetByName(DASHBOARD_TAB)!.grid().find((r) => r[0] === '📥 ENTRY (Buy Zone)')!.map(String);
      };
      const inside = await entryRow((cp) => ({ lo: cp * 0.98, hi: cp * 1.02, stop: cp * 0.9 }));
      assert.match(inside[6], /^✅ AT YOUR BUY LIMIT — price \$[\d.]+ is inside the buy zone/);
      assert.match(inside[6], /Stop \$[\d.]+, risk \$[\d.]+\/share \(10\.0%\) at today's price\.$/);
      assert.match(inside[5], /% from now — price is already inside the buy zone$/);
      const below = await entryRow((cp) => ({ lo: cp * 1.01, hi: cp * 1.03, stop: cp * 0.95 }));
      assert.match(below[6], /is below the buy zone/);
      assert.match(below[5], /price is already below the buy zone$/);
      const above = await entryRow((cp) => ({ lo: cp * 0.9, hi: cp * 0.95, stop: cp * 0.85 }));
      assert.equal(above[6], 'Wait for the zone — plan says buy on a dip');
      const underStop = await entryRow((cp) => ({ lo: cp * 1.05, hi: cp * 1.08, stop: cp * 1.01 }));
      assert.equal(underStop[6], 'Wait for the zone — plan says buy on a dip', 'at or below the stop: no label');
      const legacy = await entryRow((cp) => ({ lo: cp * 0.98, hi: cp * 1.02, stop: cp * 0.9 }), true);
      assert.equal(legacy[6], 'Wait for the zone — plan says buy on a dip');
      assert.match(legacy[5], /% from now$/);
    });
  });

  test('B1 option B (display only): a 🧱 NEXT RESISTANCE row under the exit row, from the nearest valid cluster 1 ATR above the entry; legacy text has none', async () => {
    assert.ok(MAIN, 'runs after the scenario test');
    await inZone(TZ, async () => {
      const { kit } = MAIN!;
      const sc = kit.scenarios.find((s) => s.name === 'bare ' + kit.pipes[0].ticker)!;
      const grid = async (legacyReportText: boolean): Promise<string[][]> => {
        const P = await ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
        const b = sc.build();
        const cp = b.chart.currentPrice as number, atr = b.ind.atr14 as number;
        const tm = (name: string, price: number, excluded = false) => ({ name, price, type: 'target', ...(excluded ? { excluded: true, exclusionReason: 'test' } : {}) });
        // entry = today's price; a valid pair 2 ATR up, the biggest cluster 10 ATR up, an excluded method 1.5 ATR up
        const all = [tm('X excluded', cp + 1.5 * atr, true), tm('Near A', cp + 2 * atr), tm('Near B', cp + 2.1 * atr), tm('Far A', cp + 10 * atr), tm('Far B', cp + 10.2 * atr), tm('Far C', cp + 10.4 * atr)];
        b.confluence = { ...b.confluence, allExitMethods: all, exitMethods: all.slice(3), exitLow: cp + 10 * atr, exitHigh: cp + 10.4 * atr, exitCenter: cp + 10.2 * atr, exitCount: 3 };
        b.techPlan = { ...b.techPlan, entryPrice: cp, stop: cp - 1.5 * atr, t1: { price: cp + 10.2 * atr }, rrToT1: 10.2 / 1.5 };
        await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest,
          { nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, fetch13FCusip: async () => null, fetchInstitutional13FHoldings: async () => null, legacyReportText });
        return P.getSheetByName(DASHBOARD_TAB)!.grid().map((r) => r.map(String));
      };
      const plain = await grid(false);
      const exitAt = plain.findIndex((r) => r[0] === '📤 EXIT (Sell Zone)');
      const nr = plain[exitAt + 1]!;
      assert.equal(nr[0], '🧱 NEXT RESISTANCE');
      assert.equal(nr[4], 'Near A | Near B', 'the excluded method is skipped; the nearest valid cluster');
      assert.match(nr[6], /^Next resistance: \$[\d.]+ \(\+\d+%, Near A, Near B\) · R:R to it 1\.37 \(T1 \$[\d.]+ and its R:R 6\.80 unchanged\)$/);
      assert.equal(plain[exitAt + 3]![0], '📋  ALL PRICE METHODS — Entry (short) & Exit (long)', 'one blank row, then the methods table as before');
      const legacy = await grid(true);
      const lx = legacy.findIndex((r) => r[0] === '📤 EXIT (Sell Zone)');
      assert.ok(!legacy.some((r) => r[0] === '🧱 NEXT RESISTANCE'));
      assert.equal(legacy[lx + 2]![0], '📋  ALL PRICE METHODS — Entry (short) & Exit (long)', 'legacy layout unchanged');
    });
  });
});

/** hdrV7, scoreBar, colorVerdictRow9V7_, the banner, the AI-review renderer, the gap helpers: legacy vs port on their own inputs. */
async function helperChecks(o: ReturnType<typeof loadOracle>): Promise<void> {
  const open = () => ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
  const sheets = async () => { const L = await open(), P = await open(); return { ls: L.insertSheet('T'), ps: P.insertSheet('T') }; };
  for (const args of [[3, 'title', '#123456'], [3, 'title', '#123456', 12, 5], [1, '', '#000', 0, 0]] as Array<[number, string, string, number?, number?]>) {
    const { ls, ps } = await sheets();
    o.call('hdrV7', legacySheet(ls), ...args);
    hdr(new DashSheet(ps), ...args);
    assert.deepStrictEqual(ps.calls, ls.calls, 'hdr ' + JSON.stringify(args));
  }
  for (const c of [-5, 0, 10, 49.9, 50, 64.9, 65, 80, 100, NaN]) {
    const { ls, ps } = await sheets();
    o.call('colorVerdictRow9V7_', legacySheet(ls), 4, c);
    colorVerdictRow9(new DashSheet(ps), 4, c);
    assert.deepStrictEqual(ps.calls, ls.calls, 'colorVerdictRow9 ' + c);
  }
  for (const s of [-5, 0, 4, 5, 55, 99.9, 100, 150, NaN, 'x', null, undefined]) assert.equal(scoreBar(s as never), o.call('scoreBar', s), 'scoreBar ' + String(s));
  const st = (f: (s: any) => void) => { const s = o.callNormalized<any>('newDataStatusV7'); f(s); return s; };
  for (const status of [null, undefined, st(() => undefined), st((s) => { s.price.state = 'failed'; s.price.detail = 'd'; s.gann.state = 'failed'; }), st((s) => { s.peers.state = 'skipped'; s.options.state = 'degraded'; }),
    st((s) => { s.darkPool.state = 'degraded'; s.darkPool.detail = ''; }), { price: null, gann: { label: 'g', state: 'failed' } }, {}]) {
    assert.deepStrictEqual(buildDataStatusBanner(structuredClone(status), { legacyReportText: true }), o.callNormalized('buildDataStatusBannerV7', status), 'banner ' + JSON.stringify(status)?.slice(0, 60));
  }
  for (const text of ['', '   ', 'A', 'SUMMARY', 'Risks:', 'Mixed Case Header:', '- b1\n• b2\n* b3\n-nob', '**bold** `code` ### h', 'x'.repeat(60) + ':', 'LINE ONE\r\nline two\r\n\r\n', 'ALL CAPS WITH 123 & (SYMBOLS)/?', 5, null, undefined, { toString: () => 'obj' }]) {
    assert.deepStrictEqual(renderAiReview(text), o.callNormalized('renderAiReviewV7_', text), 'renderAiReview ' + JSON.stringify(text)?.slice(0, 40));
  }
  for (const mc of [0, null, undefined, 1e8, 3e8, 2e9, 1e10, 2e11, 3e12]) for (const sizePct of [0.03, 0.0299, -0.05, 0, -0.03]) {
    assert.deepStrictEqual(gapMarketCapContext({ sizePct }, mc), o.callNormalized('gapMarketCapContextV7', { sizePct }, mc), 'gapMarketCap ' + mc + ' ' + sizePct);
  }
  const ev = (iso: string, extra: object = {}) => ({ date: new Date(iso), epsActual: 1.1, epsEstimated: 1, revenueActual: 11, revenueEstimated: 10, ...extra });
  const gap = { date: new Date('2026-08-05T13:30:00Z') };
  for (const hist of [null, undefined, [], [ev('2026-08-05T00:00:00Z')], [ev('2026-08-04T00:00:00Z'), ev('2026-08-05T00:00:00Z'), ev('2026-08-06T00:00:00Z')], [ev('2026-08-06T00:00:00Z'), ev('2026-08-04T00:00:00Z')], [ev('2026-07-01T00:00:00Z')],
    [ev('2026-08-05T00:00:00Z', { epsActual: null })], [ev('2026-08-05T00:00:00Z', { epsEstimated: 0 })], [ev('2026-08-05T00:00:00Z', { epsEstimated: -2, epsActual: -1, revenueEstimated: null })]]) {
    const expected = o.callNormalized('classifyGapCauseV7', gap, hist);
    assert.deepStrictEqual(classifyGapCause(structuredClone(gap), structuredClone(hist) as never), expected, 'classifyGapCause ' + JSON.stringify(hist)?.slice(0, 50));
    assert.deepStrictEqual(classifyEarningsGapV1(structuredClone(gap), structuredClone(hist) as never), expected);
  }
}

describe('fix plan 2026-10-30 — the dashboard in plain mode (A2, B3, D4, D6); legacy text unchanged', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the recommended contract prints the OCC date (Fri Jan 19 2029), the pick rules, IV vs this chain and the whole-chain P/C bands', async () => {
    assert.ok(MAIN, 'runs after the scenario test');
    await inZone(TZ, async () => {
      const { kit } = MAIN!;
      const sc = kit.scenarios.find((s) => s.name === 'full ' + kit.pipes[0].ticker)!;
      const OCC_290119 = Date.UTC(2029, 0, 19) / 1000; // parseOcc('...290119C...').expUnix: 00:00 UTC
      const run = async (legacyReportText: boolean) => {
        const P = await ReportWorkbook.open(new MemoryWorkbookBackend(structuredClone(sc.initial ?? {}) as never), sc.preload ?? ['*']);
        const b = sc.build();
        if (sc.post) sc.post(b);
        b.leaps = { found: true, contract: { strike: 400, expUnix: OCC_290119, delta: 0.75, iv: 0.5, bid: 100, ask: 101 } };
        b.opts = { ...(b.opts ?? {}), available: true, dirSig: 0.5, confirm: 'confirm', putCallOI: 0.92, netBiasPct: 12, ivRank: 85, leapsLean: 0.3, topCall: null, topPut: null, leapCall: null, leapPut: null, horizon: null };
        await buildDashboard(P, b.ticker, b.chart, b.ind, b.gann, b.confluence, b.fundResult, b.techPlan, b.decision, b.fund, b.opts, b.fundSource, b.aiReview, b.status, b.ladderStock, b.ladderOptions, b.leaps, b.shortTerm, b.existing13F, b.existingShortInterest,
          { nowMs: NOW, timeZone: TZ, readBrokerData: async () => null, fetch13FCusip: async () => null, fetchInstitutional13FHoldings: async () => null, legacyReportText, sheetsParsedLabels: false });
        return cellText(P);
      };
      const plain = await run(false);
      assert.ok(plain.includes('LEAPS (the furthest expiry at least 180 days out, target delta 0.75): $400 call, exp Fri Jan 19 2029'), plain);
      assert.ok(plain.includes('Short-term (the nearest expiry with 60 to 180 days left, target delta 0.50)'));
      assert.ok(!plain.includes('Thu Jan 18 2029'));
      assert.ok(plain.includes('IV vs this chain (percentile)'));
      assert.ok(!plain.includes('IV %ile'));
      assert.ok(plain.includes('Put/call OI (whole chain) 0.92 — balanced (neutral)'));
      assert.ok(plain.includes('Put/call bands: up to 0.60 bullish'));
      assert.ok(plain.includes('IV vs this chain (percentile) 85th'), 'the narrative uses the same words');
      const legacy = await run(true);
      assert.ok(legacy.includes('LEAPS (>1yr, target delta 0.75): $400 call, exp Thu Jan 18 2029'), 'legacy text kept (the New York date)');
      assert.ok(legacy.includes('IV %ile') && legacy.includes('Put/Call <0.7 = upside positioning'));
    });
  });
});
