/**
 * FL-J: the position exit reads against the oracle.
 *
 *   analyzePositionV7                              :9846-9883   (new port: portfolio/positions/analyzePosition.ts)
 *   computeOptionsPositionExitReadFixedLookbackV1_ :10005-10055 (new port: portfolio/positions/optionsFixedLookback.ts)
 *   computePositionExitReadFixedLookbackV1_        :9936-9986   (already ported, analysis/exitRead.ts; direct oracle test: exitRead.parity.test.ts)
 *   computeOptionsPositionExitReadV1_              :10072-10130 (already ported, analysis/optionsExitRead.ts; direct oracle test: optionsExitRead.parity.test.ts)
 *
 * Legacy and port run on twin ReportWorkbooks (Memory backend); the tests
 * compare return values, the complete recorded call log of every tab, the
 * final cells, alerts, fetch calls, Logger lines, and a legacy throw (F-J1).
 * The clock is pinned on both sides. The four legacy functions log nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { ReportWorkbook, MemoryWorkbookBackend, type ReportSheet } from '../src/sheets/reportSheet.ts';
import { TZ, NOW } from './fl7b1Fixtures.ts';
import { EXIT_GENERIC_LOOKBACK_TRADING_DAYS, computePositionExitRead } from '../src/analysis/exitRead.ts';
import { EXPIRY_WARNING_DAYS_LEAPS } from '../src/analysis/optionsExitRead.ts';
import { computeOptionsPositionExitReadFixedLookback } from '../src/portfolio/positions/optionsFixedLookback.ts';
import {
  analyzePosition, analyzePositionFromRead, positionRows, positionBackground, POSITION_SHEET_PREFIX, POSITION_TAB,
  POSITION_BG_EXIT, POSITION_BG_PARTIAL, POSITION_BG_HOLD,
  type AnalyzePositionResult, type PositionBook, type PositionTabRead,
} from '../src/portfolio/positions/analyzePosition.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LEG = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n') : [];
type Ch = ReturnType<typeof buildChart>;
type Written = Extract<AnalyzePositionResult, { status: 'written' }>;
const HIT_CRASH = 'hitT1 is not defined';

async function inZone<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = TZ;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

interface Legacy<T> { value: T | undefined; error: string | null; logs: string[] }
/** Runs a legacy function with the clock pinned and Logger captured; a throw is returned, not hidden. */
function legacy<T = unknown>(name: string, args: unknown[], globals: Record<string, unknown> = {}, raw = false): Legacy<T> {
  const logs: string[] = [];
  const o = loadOracle();
  try {
    const value = withOracleGlobals({ Date: pinnedDateClass(NOW), Logger: { log: (m: unknown) => { logs.push(String(m)); } }, ...globals },
      () => (raw ? o.call(name, ...args) : o.callNormalized(name, ...args)));
    return { value: value as T, error: null, logs };
  } catch (e) {
    return { value: undefined, error: String(e), logs };
  }
}

function realCharts(): Array<{ label: string; chart: Ch }> {
  const out: Array<{ label: string; chart: Ch }> = [];
  for (const ticker of listFixtures()) {
    if (ticker === '_VIX') continue; // no OHLC: the oracle crashes (tested on its own, F-J2)
    let raw;
    try { raw = loadRawFixture(ticker); } catch { continue; }
    if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
    const n = raw.closes.length;
    const lens = ['NVDA', 'TSLA', 'PLTR', 'MSTR'].includes(ticker) ? [600, n] : [600];
    for (const len of lens) out.push({ label: ticker + '@' + Math.min(len, n), chart: buildChart(raw, Math.min(len, n)) });
  }
  return out;
}

const RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['analyzePositionV7', 9846, 9883], ['computePositionExitReadFixedLookbackV1_', 9936, 9986],
  ['computeOptionsPositionExitReadFixedLookbackV1_', 10005, 10055], ['computeOptionsPositionExitReadV1_', 10072, 10130],
];

describe('FL-J — legacy boundaries and constants', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('every range starts and ends where the port says; the four functions never log; constants match', () => {
    for (const [name, a, b] of RANGES) {
      assert.ok(LEG[a - 1].startsWith('function ' + name + '('), name + ' starts at ' + a + ': ' + LEG[a - 1]);
      assert.equal(LEG[b - 1], '}', name + ' closes at column 0 on ' + b);
      assert.ok(LEG[b].trim() === '' || LEG[b].startsWith('//'), name + ' is followed by a boundary at ' + (b + 1));
      const body = LEG.slice(a - 1, b).join('\n');
      assert.ok(!body.includes('Logger.log'), name + ' has no Logger call (so legacy logs nothing to compare)');
    }
    const src = LEG.join('\n');
    assert.ok(src.includes('const EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1 = ' + EXIT_GENERIC_LOOKBACK_TRADING_DAYS + ';'));
    assert.ok(src.includes('const EXIT_STRATEGY_EXPIRY_WARNING_DAYS_LEAPS_V1 = ' + EXPIRY_WARNING_DAYS_LEAPS + ';'));
    assert.ok(src.includes("sh = ss.insertSheet('" + POSITION_SHEET_PREFIX + "' + ticker);"));
    for (const c of [POSITION_BG_EXIT, POSITION_BG_PARTIAL, POSITION_BG_HOLD]) assert.ok(src.includes("'" + c + "'"), c);
    // F-J1: hitT1 is used by analyzePositionV7 (once, in the colour expression) and never declared in it
    const fn = LEG.slice(9845, 9883).join('\n');
    assert.equal((fn.match(/hitT1/g) ?? []).length, 1, 'hitT1 occurs once and is never declared');
    assert.ok(!/(const|let|var)\s[^;]*\bhitT1\b/.test(fn));
    const o = loadOracle();
    for (const f of ['computeClassicalStopTrailingV1_', 'turtlePyramidLadderForRealEntryV1_', 'fetchYahooChart', 'computePositionExitReadV1_']) assert.ok(o.has(f), f);
  });
});

describe('FL-J — computeOptionsPositionExitReadFixedLookback against the oracle', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  const EXPIRIES = ["Sep18'26", "Nov20'26", "Dec18'26", "Feb19'27", 'bogus']; // past, inside 30, inside 60, outside, unparseable (NOW = 2026-10-23)
  const LOOKBACKS: Array<number | undefined> = [undefined, 1, 50, 100000];
  const norm = (s: unknown): string => String(s).replace(/\(\d+d\)/, '(Nd)');

  function both(ticker: string, strike: number, expiry: string, chart: unknown, lb: number | null | undefined, label: string) {
    const leg = legacy<Record<string, unknown>>('computeOptionsPositionExitReadFixedLookbackV1_', [ticker, strike, expiry, 5.25, chart, lb]);
    assert.equal(leg.error, null, label + ' oracle threw: ' + leg.error);
    assert.deepStrictEqual(leg.logs, [], label + ' legacy logs');
    const got = computeOptionsPositionExitReadFixedLookback(ticker, strike, expiry, 5.25, chart as Ch, lb, NOW, { legacyHistoricalTargets: true });
    assert.deepStrictEqual(got, leg.value, label);
    return leg.value as Record<string, any>;
  }

  test('real charts x lookbacks x expiry windows: results equal, and every reachable rung is reached', async () => {
    await inZone(() => {
      const recs = new Set<string>();
      const errs = new Set<string>();
      const tech = { stop: 0, thesis: 0, t1: 0, t2: 0, techError: 0, warnedClear: 0 };
      let n = 0;
      for (const { label, chart } of realCharts()) {
        for (const lb of LOOKBACKS) {
          for (const ex of EXPIRIES) {
            const r = both(chart.ticker, 100, ex, chart, lb, label + ' lb=' + lb + ' ' + ex);
            n++;
            if (r.error) { errs.add(String(r.error).slice(0, 25)); continue; }
            recs.add(norm(r.recommendation));
            const t = r.technical;
            if (t.error) tech.techError++;
            else {
              if (t.stopBreached) tech.stop++;
              if (t.thesisInvalidated) tech.thesis++;
              if (t.hitT1) tech.t1++;
              if (t.hitT2) tech.t2++;
              if (r.expiryWarning && r.daysToExpiry > 0 && !t.stopBreached && !t.thesisInvalidated) tech.warnedClear++;
            }
          }
        }
      }
      assert.ok(n > 400, 'only ' + n + ' comparisons');
      assert.deepStrictEqual([...errs], ['Could not parse expiry da']);
      for (const rung of [
        'EXPIRED', 'HOLD', 'STOP HIT (underlying) — EXIT', 'THESIS INVALIDATED (underlying) — CONSIDER EXIT',
        'EXPIRY APPROACHING (Nd) — CONSIDER EXIT', 'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS',
      ]) assert.ok(recs.has(rung), 'rung never fired: ' + rung);
      assert.ok(tech.stop > 0 && tech.thesis > 0 && tech.t1 > 0 && tech.warnedClear > 0, JSON.stringify(tech));
      // F-J3 (MODEL, F-16 again): the underlying reached T2 in many reads but the T2 rung never surfaces.
      assert.ok(tech.t2 > 20, 'hitT2 only true ' + tech.t2 + ' times');
      assert.ok(!recs.has('T2 REACHED (underlying) — CONSIDER TRIMMING'), 'the T2 rung now surfaces -- re-examine F-J3');
    });
  });

  test('technical-unavailable rung, window edges and an empty chart', async () => {
    await inZone(() => {
      const base = buildChart(loadRawFixture('NVDA'), 600);
      const withClose0 = (v: number): Ch => ({ ...base, closes: [v, ...base.closes.slice(1)] });
      const empty: Ch = { ...base, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
      const seen = new Set<string>();
      for (const [name, chart] of [['zero', withClose0(0)], ['negative', withClose0(-3)], ['nan', withClose0(NaN)], ['empty', empty]] as const) {
        for (const ex of EXPIRIES) {
          const r = both('NVDA', 100, ex, chart, 100000, name + ' ' + ex);
          if (!r.error) seen.add(norm(r.recommendation) + ' | ' + String(r.reason).slice(0, 30));
        }
      }
      assert.ok([...seen].some((s) => s.startsWith('HOLD (technical read unavailable) | Entry price (avg cost)')), [...seen].join(' / '));
      assert.ok([...seen].some((s) => s.startsWith('EXPIRED')), 'EXPIRED beats an unavailable technical read');
      // 0 and null fall back to 800 (legacy "||"); 1 is a one-bar window
      const r800 = both('NVDA', 100, "Feb19'27", base, 0, 'lb 0');
      assert.equal(r800.technical.lookbackTradingDays, EXIT_GENERIC_LOOKBACK_TRADING_DAYS);
      assert.equal(r800.expiryThreshold, 60);
      both('NVDA', 100, "Feb19'27", base, null, 'lb null');
      assert.equal(both('NVDA', 100, "Feb19'27", base, 1, 'lb 1').underlyingProxyEntryPrice, base.closes[base.closes.length - 1]);
    });
  });

  test('chart missing: the fetch is the caller\'s; with the oracle fetch injected both give the same error and read', async () => {
    await inZone(() => {
      const chart = buildChart(loadRawFixture('NVDA'), 600);
      const calls: string[] = [];
      const noChart = legacy<Record<string, unknown>>('computeOptionsPositionExitReadFixedLookbackV1_', ['NVDA', 100, "Dec18'26", 5.25, undefined, undefined],
        { fetchYahooChart: (t: string) => { calls.push(t); return null; } });
      assert.deepStrictEqual(calls, ['NVDA']);
      assert.deepStrictEqual(computeOptionsPositionExitReadFixedLookback('NVDA', 100, "Dec18'26", 5.25, null, undefined, NOW, { legacyHistoricalTargets: true }), noChart.value);
      assert.equal((noChart.value as { error: string }).error, 'Could not fetch data for NVDA.');
      // the chart error comes before the expiry parse in legacy too
      const bothBad = legacy<Record<string, unknown>>('computeOptionsPositionExitReadFixedLookbackV1_', ['NVDA', 100, 'bogus', 5.25, null, undefined], { fetchYahooChart: () => null });
      assert.deepStrictEqual(computeOptionsPositionExitReadFixedLookback('NVDA', 100, 'bogus', 5.25, undefined, undefined, NOW, { legacyHistoricalTargets: true }), bothBad.value);
      // the fetch returns a chart and none was passed: same as passing it; a passed chart never fetches
      const calls2: string[] = [];
      const viaFetch = legacy<Record<string, unknown>>('computeOptionsPositionExitReadFixedLookbackV1_', ['NVDA', 100, "Dec18'26", 5.25, undefined, 50],
        { fetchYahooChart: (t: string) => { calls2.push(t); return chart; } });
      assert.deepStrictEqual(calls2, ['NVDA']);
      assert.deepStrictEqual(computeOptionsPositionExitReadFixedLookback('NVDA', 100, "Dec18'26", 5.25, chart, 50, NOW, { legacyHistoricalTargets: true }), viaFetch.value);
      const calls3: string[] = [];
      legacy('computeOptionsPositionExitReadFixedLookbackV1_', ['NVDA', 100, "Dec18'26", 5.25, chart, 50], { fetchYahooChart: (t: string) => { calls3.push(t); return null; } });
      assert.deepStrictEqual(calls3, []);
    });
  });

  test('_VIX (no OHLC): the oracle crashes inside the technical read, the port returns a read (F-J2)', async () => {
    await inZone(() => {
      const chart = buildChart(loadRawFixture('_VIX'), 600);
      const leg = legacy('computeOptionsPositionExitReadFixedLookbackV1_', ['VIX', 100, "Dec18'26", 5.25, chart, 50]);
      assert.ok(leg.error && leg.error.includes("reading 'toFixed'"), String(leg.error));
      const got = computeOptionsPositionExitReadFixedLookback('VIX', 100, "Dec18'26", 5.25, chart, 50, NOW, { legacyHistoricalTargets: true });
      assert.ok(!('error' in got) || got.error === null);
    });
  });
});

// ── analyzePosition ──────────────────────────────────────────────────────

type Initial = Record<string, unknown[][]>;
async function twin(initial: Initial = {}) {
  const mk = async (): Promise<ReportWorkbook> => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
  return { L: await mk(), P: await mk() };
}

/** The legacy side needs sheet.autoResizeColumns; ReportSheet may not have it yet, so it is added (and recorded) here. */
function shimBook(b: ReportWorkbook): PositionBook {
  const shim = (s: ReportSheet): ReportSheet => {
    if (typeof (s as unknown as { autoResizeColumns?: unknown }).autoResizeColumns !== 'function') {
      Object.defineProperty(s, 'autoResizeColumns', { configurable: true, value: (a: number, n: number) => { s.calls.push(['autoResizeColumns', a, n]); return s; } });
    }
    return s;
  };
  return { getSheetByName: (n: string) => { const s = b.getSheetByName(n); return s ? shim(s) : null; }, insertSheet: (n: string) => shim(b.insertSheet(n)) };
}

function assertSameBooks(L: ReportWorkbook, P: ReportWorkbook, where: string): void {
  const names = (b: ReportWorkbook) => b.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names(P), names(L), where + ' (tabs)');
  for (const sh of L.getSheets()) {
    const ps = P.getSheetByName(sh.getName())!;
    assert.deepStrictEqual(ps.calls, sh.calls, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.calls, L.calls, where + ' (workbook calls)');
}

const OLD_TAB = (ticker: string): Initial => ({ [POSITION_SHEET_PREFIX + ticker]: [['old', 'x'], ['y', 'z'], ['k', 'v']] });

type Outcome = 'written' | 'alert' | 'hit-crash' | 'oracle-crashed';
interface Run { outcome: Outcome; alerts: string[]; fetches: string[]; res: AnalyzePositionResult | null; L: ReportWorkbook; P: ReportWorkbook }

/** analyzePositionV7 and analyzePosition on twin workbooks; everything observable must be equal, including the throw. */
async function runBoth(label: string, ticker: string, price: unknown, dateStr: unknown, chart: unknown, initial: Initial = {}): Promise<Run> {
  const { L, P } = await twin(initial);
  const alerts: string[] = [];
  const fetchL: string[] = [];
  const fetchP: string[] = [];
  const portLog: string[] = [];
  const leg = legacy('analyzePositionV7', [ticker, price, dateStr], {
    SpreadsheetApp: { getActiveSpreadsheet: () => shimBook(L), getUi: () => ({ alert: (m: unknown) => { alerts.push(String(m)); } }) },
    fetchYahooChart: (t: string) => { fetchL.push(t); return chart; },
  }, true);
  let res: AnalyzePositionResult | null = null;
  let portErr: unknown = null;
  try {
    res = await analyzePosition(P, ticker, price as number, dateStr as string, { fetchChart: (t) => { fetchP.push(t); return chart as Ch | null; }, log: (l) => portLog.push(l), legacyHistoricalTargets: true, legacyHitReferenceError: true });
  } catch (e) { portErr = e; }
  assert.ok(portLog.length >= 2, label + ' the port logs');
  assert.deepStrictEqual(leg.logs, [], label + ' legacy logs nothing');
  if (leg.error && leg.error.includes("reading 'toFixed'")) return { outcome: 'oracle-crashed', alerts, fetches: fetchP, res, L, P };
  assert.deepStrictEqual(fetchP, fetchL, label + ' fetch calls');
  if (leg.error) {
    assert.equal(leg.error, 'ReferenceError: ' + HIT_CRASH, label + ' unexpected oracle error');
    assert.ok(portErr instanceof ReferenceError && portErr.message === HIT_CRASH, label + ' the port throws the same ReferenceError: ' + String(portErr));
    assertSameBooks(L, P, label + ' (partial write before the throw)');
    return { outcome: 'hit-crash', alerts, fetches: fetchP, res, L, P };
  }
  assert.equal(portErr, null, label + ' the port threw: ' + String(portErr));
  assert.deepStrictEqual(res!.status === 'alert' ? [res!.alert] : [], alerts, label + ' alerts');
  assertSameBooks(L, P, label);
  if (res!.status === 'written') {
    assert.deepStrictEqual(P.getSheetByName(res!.sheetName)!.grid(), res!.rows.map((r) => [...r]), label + ' rows are the cells');
  } else {
    assert.equal(P.getSheets().length, Object.keys(initial).length, label + ' an alert touches no tab');
  }
  return { outcome: res!.status, alerts, fetches: fetchP, res, L, P };
}

describe('FL-J — analyzePosition against the oracle', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('real charts x entry points, new tab and existing tab: calls, cells, alerts, fetches and the F-J1 throw equal', async () => {
    await inZone(async () => {
      const cov = { written: 0, crash: 0, created: 0, cleared: 0, classicalNull: 0, classicalSome: 0, turtleNA: 0, turtleLive: 0, negative: 0, positive: 0, n: 0 };
      let k = 0;
      for (const { label, chart } of realCharts()) {
        const m = chart.closes.length;
        for (const f of [0, 0.1, 0.3, 0.55, 0.8, 0.95, 1]) {
          const i = Math.min(m - 1, Math.floor(m * f));
          const ds = chart.dates[i].toISOString().slice(0, 10);
          const initial = k++ % 2 ? OLD_TAB(chart.ticker) : {};
          const out = await runBoth(label + ' entry#' + i, chart.ticker, chart.closes[i], ds, chart, initial);
          assert.ok(out.outcome === 'written' || out.outcome === 'hit-crash', label + ' ' + out.outcome);
          cov.n++;
          out.outcome === 'written' ? cov.written++ : cov.crash++;
          Object.keys(initial).length ? cov.cleared++ : cov.created++;
          const rd = computePositionExitRead(chart.ticker, chart.closes[i], ds, chart);
          const r = rd as Extract<typeof rd, { error: null }>;
          r.classicalTrailing ? cov.classicalSome++ : cov.classicalNull++;
          r.turtlePyramid && r.turtlePyramid.available ? cov.turtleLive++ : cov.turtleNA++;
          r.unrealizedPct >= 0 ? cov.positive++ : cov.negative++;
        }
      }
      assert.ok(cov.n > 150, JSON.stringify(cov));
      for (const key of ['written', 'crash', 'created', 'cleared', 'classicalNull', 'classicalSome', 'turtleNA', 'turtleLive', 'negative', 'positive'] as const) assert.ok(cov[key] > 0, 'never reached: ' + key + ' ' + JSON.stringify(cov));
    });
  });

  test('input problems: each alert, no tab touched, a bad price never fetches', async () => {
    await inZone(async () => {
      const chart = buildChart(loadRawFixture('NVDA'), 600);
      const empty: Ch = { ...chart, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
      const mid = chart.dates[300].toISOString().slice(0, 10);
      const cases: Array<[string, unknown, unknown, unknown, number]> = [
        ['price NaN', NaN, mid, chart, 0], ['price 0', 0, mid, chart, 0], ['price negative', -5, mid, chart, 0],
        ['price string', '150', mid, chart, 0], ['price undefined', undefined, mid, chart, 0],
        ['fetch fails', 100, mid, null, 1], ['date after data', 100, '2100-01-01', chart, 1], ['date before history', 100, '1990-01-01', chart, 1],
        ['date undefined', 100, undefined, chart, 1], ['date empty', 100, '', chart, 1], ['date garbage', 100, 'not a date', chart, 1],
        ['empty chart', 100, mid, empty, 1],
      ];
      const seen = new Set<string>();
      for (const [name, price, date, ch, fetches] of cases) {
        const r = await runBoth(name, 'NVDA', price, date, ch, OLD_TAB('NVDA'));
        assert.equal(r.outcome, 'alert', name);
        assert.equal(r.fetches.length, fetches, name + ' fetch count');
        seen.add(r.alerts[0].slice(0, 20));
      }
      assert.deepStrictEqual([...seen].sort(), ['Could not fetch data', 'Entry date is after ', 'Entry date is before', 'Entry price must be '].sort());
    });
  });

  test('model functions not loaded (legacy typeof guards): both optional rows read N/A', async () => {
    await inZone(async () => {
      const chart = buildChart(loadRawFixture('NVDA'), 600);
      const price = chart.closes[300];
      const ds = chart.dates[300].toISOString().slice(0, 10);
      const off = { computeClassicalStopTrailingV1_: undefined, turtlePyramidLadderForRealEntryV1_: undefined };
      const rd = legacy<any>('computePositionExitReadV1_', ['NVDA', price, ds, chart], off);
      assert.equal(rd.error, null);
      assert.equal(rd.value.classicalTrailing, null);
      assert.equal(rd.value.turtlePyramid, null);
      for (const initial of [{}, OLD_TAB('NVDA')]) {
        const { L, P } = await twin(initial);
        const leg = legacy('analyzePositionV7', ['NVDA', price, ds], {
          ...off, SpreadsheetApp: { getActiveSpreadsheet: () => shimBook(L), getUi: () => ({ alert: () => { throw new Error('no alert expected'); } }) },
          fetchYahooChart: () => chart,
        }, true);
        // a stopped / invalidated read is written; any other read hits the F-J1 throw. The cells are compared either way.
        let res: AnalyzePositionResult | null = null;
        try { res = analyzePositionFromRead(P, 'NVDA', price, ds, rd.value, { legacyHitReferenceError: true }); } catch (e) { assert.equal(leg.error, 'ReferenceError: ' + HIT_CRASH); assert.ok(e instanceof ReferenceError); }
        if (res) assert.equal(leg.error, null);
        assertSameBooks(L, P, 'models off');
        const rows = positionRows(price, ds, rd.value);
        assert.equal(rows[5][1], 'N/A (no qualifying pre-entry basing point found)');
        assert.equal(rows[6][1], 'N/A (model not loaded)');
        assert.deepStrictEqual(P.getSheetByName(POSITION_SHEET_PREFIX + 'NVDA')!.grid(), rows.map((r) => [...r]));
      }
    });
  });

  test('every row branch, forced through the oracle by stubbing the read (336 reads); non-red reads hit the F-J1 throw on both sides', async () => {
    await inZone(async () => {
      const classical = [null, { available: true, currentLevel: 123.456, shiftCount: 0 }, { available: true, currentLevel: 123.456, shiftCount: 1 }, { available: true, currentLevel: 99.995, shiftCount: 3 }];
      const turtle = [
        null,
        { available: false, note: 'Invalid entry index/price for this chart.' },
        { available: false, note: '' },
        { available: true, n: 2, units: 2, unitFills: [], stop: 99.5, stoppedOut: true, stoppedOutIdx: 5, nextAddTrigger: null },
        { available: true, n: 2, units: 1, unitFills: [], stop: 90, stoppedOut: false, stoppedOutIdx: null, nextAddTrigger: 101.255 },
        { available: true, n: 2, units: 4, unitFills: [], stop: 110, stoppedOut: false, stoppedOutIdx: null, nextAddTrigger: null },
        { available: true, n: 2, units: 3, unitFills: [], stop: 105.005, stoppedOut: false, stoppedOutIdx: null, nextAddTrigger: 0 },
      ];
      const t1s = [null, 0, 150.456];
      const t2s = [null, 160];
      const pcts = [-0.05, 0, 0.1234];
      const cov = { red: 0, crash: 0, shift0: 0, shift1: 0, shiftMany: 0, classicalNA: 0, stopped: 0, nextAdd: 0, maxUnits: 0, turtleNote: 0, turtleNoModel: 0, t1NA: 0, t2NA: 0, t1Zero: 0, neg: 0, zero: 0, pos: 0 };
      for (let i = 0; i < 336; i++) {
        const flags = i % 16;
        const read = {
          error: null, ticker: 'XYZ', entryPrice: 100, entryDateStr: '2026-01-02', cp: 101.005 + i, unrealizedPct: pcts[i % 3], daysHeld: i % 7,
          highestHighSinceEntry: 130.1 + i, chandelierSinceEntry: 95.555 + i, stopBreached: !!(flags & 1), classicalTrailing: classical[i % 4], turtlePyramid: turtle[i % 7],
          t1: t1s[i % 3], t2: t2s[i % 2], hitT1: !!(flags & 4), hitT2: !!(flags & 8), thesisInvalidated: !!(flags & 2),
          recommendation: 'REC ' + i, reason: 'why ' + i,
        };
        const { L, P } = await twin(i % 3 === 0 ? OLD_TAB('XYZ') : {});
        const alerts: string[] = [];
        const leg = legacy('analyzePositionV7', ['XYZ', 100, '2026-01-02'], {
          computePositionExitReadV1_: () => read,
          SpreadsheetApp: { getActiveSpreadsheet: () => shimBook(L), getUi: () => ({ alert: (m: unknown) => { alerts.push(String(m)); } }) },
        }, true);
        const red = !!(flags & 3);
        if (red) {
          assert.equal(leg.error, null, 'stub ' + i + ': ' + leg.error);
          const w = analyzePositionFromRead(P, 'XYZ', 100, '2026-01-02', read as never, { legacyHitReferenceError: true }) as Written;
          assert.equal(w.background, POSITION_BG_EXIT);
          assert.equal(w.recommendationRow, 11);
          cov.red++;
        } else {
          assert.equal(leg.error, 'ReferenceError: ' + HIT_CRASH, 'stub ' + i);
          assert.throws(() => analyzePositionFromRead(P, 'XYZ', 100, '2026-01-02', read as never, { legacyHitReferenceError: true }), (e: unknown) => e instanceof ReferenceError && e.message === HIT_CRASH);
          cov.crash++;
        }
        assertSameBooks(L, P, 'stub ' + i);
        assert.deepStrictEqual(alerts, []);
        const rows = positionRows(100, '2026-01-02', read as never);
        assert.equal(rows.length, 12);
        const c = String(rows[5][1]); const t = String(rows[6][1]); const tg = String(rows[8][1]);
        if (c.startsWith('N/A')) cov.classicalNA++; else if (c.includes('(0 real shifts')) cov.shift0++; else if (c.includes('(1 real shift ')) cov.shift1++; else cov.shiftMany++;
        if (t.includes('STOPPED OUT')) cov.stopped++; else if (t.includes('next add')) cov.nextAdd++; else if (t.includes('at max Units')) cov.maxUnits++;
        else if (t.includes('Invalid entry')) cov.turtleNote++; else if (t === 'N/A (model not loaded)') cov.turtleNoModel++;
        if (tg.startsWith('N/A')) cov.t1NA++; if (tg.endsWith('/ N/A')) cov.t2NA++; if (read.t1 === 0 && tg.startsWith('N/A')) cov.t1Zero++;
        const u = String(rows[2][1]); u.startsWith('-') ? cov.neg++ : u.startsWith('+0.0') ? cov.zero++ : cov.pos++;
      }
      for (const [key, v] of Object.entries(cov)) assert.ok(v > 0, 'never reached: ' + key);
    });
  });

  test('F-J1 fixed by default: the colour the legacy line meant, for all 16 flag combinations; the parity flag keeps the throw', async () => {
    const mk = (flags: number): PositionTabRead => ({
      cp: 10, unrealizedPct: 0.1, daysHeld: 3, highestHighSinceEntry: 12, chandelierSinceEntry: 9, stopBreached: !!(flags & 1), classicalTrailing: null, turtlePyramid: null,
      t1: 11, t2: 12, hitT1: !!(flags & 4), hitT2: !!(flags & 8), thesisInvalidated: !!(flags & 2), recommendation: 'R' as any, reason: 'W',
    });
    const seen = new Set<string>();
    for (let flags = 0; flags < 16; flags++) {
      const { P } = await twin({});
      const r = mk(flags);
      const expected = flags & 3 ? POSITION_BG_EXIT : flags & 12 ? POSITION_BG_PARTIAL : POSITION_BG_HOLD;
      assert.equal(positionBackground(r), expected);
      const w = analyzePositionFromRead(P, 'ZZZ', 10, '2026-01-02', r as never) as Written;
      assert.equal(w.background, expected);
      // phase 1: the fixed '📌 Position' tab; row 1 names the ticker, so RECOMMENDATION is on row 12
      assert.deepStrictEqual(P.getSheetByName(POSITION_TAB)!.calls.at(-2), ['range:setBackground', 12, 1, 1, 2, expected]);
      assert.equal(w.recommendationRow, 12);
      assert.equal(P.getSheetByName(POSITION_TAB)!.grid()[0][0], '📌 ZZZ — Position check');
      seen.add(expected);
      if (!(flags & 3)) { const { P: P2 } = await twin({}); assert.throws(() => analyzePositionFromRead(P2, 'ZZZ', 10, '2026-01-02', r as never, { legacyHitReferenceError: true }), ReferenceError); }
    }
    assert.equal(seen.size, 3);
  });

  test('_VIX (no OHLC): the oracle crashes in the read, the port survives (F-J2)', async () => {
    await inZone(async () => {
      const chart = buildChart(loadRawFixture('_VIX'), 600);
      const out = await runBoth('vix', 'VIX', chart.closes[100], chart.dates[100].toISOString().slice(0, 10), chart);
      assert.equal(out.outcome, 'oracle-crashed');
      assert.ok(out.res !== null, 'the port produced a result where the oracle crashed');
    });
  });
});
