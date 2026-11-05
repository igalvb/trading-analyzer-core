/**
 * FL-7a-1: the legacy typeof-guard table (every site), direct oracle parity
 * for the 12 sub-functions that had only indirect coverage, the signal
 * engine (scoreAllSignalsV7_), the data-status record and the run logger.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { rng } from './fundamentalsFixtures.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { GUARD_SITES } from './guardSites.ts';
import { scoreAllSignals, categoryOf, doubleTopBottomMarketCapContext, shortSqueezeSetup } from '../src/analysis/signals.ts';
import { newDataStatus, setStatus } from '../src/analysis/dataStatus.ts';
import { makeLogger } from '../src/reports/runLog.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { dpoDelayedBreakout } from '../src/analysis/indicators/slices.ts';
import { timeToPriceATR, timeToPriceGann } from '../src/analysis/techPlan/entryPlan.ts';
import {
  edwardsMageeDowTheory, edwardsMageeEvaluativeIndex, edwardsMageeFanTrendChannel, edwardsMageePositionRisk, edwardsMageeRelativeStrength, edwardsMageeStops,
} from '../src/analysis/models/edwardsMagee.ts';
import { schabackerMeasuringRules, schabackerTrendRead } from '../src/analysis/models/schabacker.ts';
import { turtleRelativeStrength } from '../src/analysis/models/turtle.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T15:00:00Z');

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

interface Pipeline { ticker: string; chart: any; ind: any; gann: any; plan: any }

/** Oracle indicators, Gann and tech plan for the first fixtures with >= 250 bars, re-homed into this realm. */
function pipelines(n: number): Pipeline[] {
  const o = loadOracle();
  const out: Pipeline[] = [];
  for (const ticker of listFixtures()) {
    if (out.length >= n) break;
    let raw;
    try { raw = loadRawFixture(ticker); } catch { continue; }
    if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
    const chart = buildChart(raw, raw.closes.length);
    const ind = o.callNormalized<any>('computeAllIndicators', chart);
    const gann = o.callNormalized<any>('computeGannInline', chart, ind);
    const conf = o.callNormalized<any>('computeConfluenceTargets', ind, gann, null, chart);
    let plan;
    try { plan = o.callNormalized<any>('computeTechnicalPlanV7', ind, gann, conf, chart, null); } catch { continue; }
    out.push({ ticker, chart, ind, gann, plan });
  }
  return out;
}

function guardScan(): Array<{ file: string; line: number; fn: string; guarded: string; op: string }> {
  const rows: Array<{ file: string; line: number; fn: string; guarded: string; op: string }> = [];
  for (const f of fs.readdirSync(new URL('../legacy/', import.meta.url)).filter((x) => x.endsWith('.gs')).sort()) {
    const L = fs.readFileSync(new URL('../legacy/' + f, import.meta.url), 'utf8').split('\n');
    let fn = '(top)';
    L.forEach((l, i) => {
      const m = /^\s*function\s+([A-Za-z0-9_$]+)/.exec(l);
      if (m && !/^\s{4,}/.test(l)) fn = m[1];
      for (const g of l.matchAll(/typeof\s+([A-Za-z0-9_$]+)\s*(===|!==|==|!=)\s*["']function["']/g)) {
        rows.push({ file: f.replace(/\.gs$/, ''), line: i + 1, fn, guarded: g[1], op: g[2] });
      }
    });
  }
  return rows;
}

describe('FL-7a-1 — the typeof-guard table', { skip: legacyFilesPresent() ? false : 'legacy/ not populated' }, () => {
  test('every legacy guard site is in the table, exactly; every port target exists', () => {
    const scanned = guardScan();
    const key = (r: { file: string; line: number; guarded: string; op: string; fn: string }): string => r.file + ':' + r.line + ':' + r.guarded + ':' + r.op + ':' + r.fn;
    assert.deepStrictEqual(GUARD_SITES.map(key), scanned.map(key));
    assert.equal(scanned.length, 64);
    assert.equal(GUARD_SITES.filter((g) => g.kind !== 'COMMENT').length, 62);
    assert.equal(scanned.filter((g) => g.op === '===').length, 54, 'the coordinator\'s count of the === form');
    assert.deepStrictEqual(GUARD_SITES.filter((g) => g.kind === 'PENDING').map(key), [], 'every PENDING site is closed (V13 row 38)');
    for (const g of GUARD_SITES) {
      if (g.port) {
        const [file, sym] = g.port.split('#');
        const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
        assert.match(text, new RegExp('export (async )?function ' + sym + '\\b'), g.port);
      }
      if (g.at) assert.ok(fs.existsSync(new URL('../' + g.at, import.meta.url)), g.at);
      if (g.kind === 'CALL') {
        const sym = (g.port as string).split('#')[1];
        assert.match(fs.readFileSync(new URL('../' + g.at, import.meta.url), 'utf8'), new RegExp('\\b' + sym + '\\b'), g.at + ' calls ' + sym);
      }
      if (g.kind === 'PENDING' || g.kind === 'PARAM') assert.ok(g.part, 'pending sites name their FL part');
      if (g.kind === 'REMOVED') assert.ok(g.guarded === 'hasTimeBudgetV7_' || g.fn === 'buildExitStrategyReportV7', key(g) + ': REMOVED is the time-budget guard or the removed Exit Strategy tab writer (owner 2026-11-04)');
    }
  });
});

describe('FL-7a-1 — direct parity for 12 sub-functions', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('Edwards & Magee, Schabacker, Turtle sub-reads, timeToPriceATR/Gann, dpoDelayedBreakout', () => {
    const o = loadOracle();
    const P = pipelines(6);
    assert.ok(P.length >= 4, 'fixtures');
    const DOW = [null, { verdict: 'BULL_CONFIRMED', industrials: { close: 400.12 }, transports: { close: 70.5 } }, { verdict: 'NON_CONFIRMATION_BEAR', industrials: { close: 310 }, transports: { close: 51 } }, { verdict: 'ODD', industrials: { close: 1 }, transports: { close: 2 } }];
    const EI = [null, { pctStrong: 6.3, strong: 5, weak: 75, unavailable: 5, read: 'OVERSOLD — x' }, { pctStrong: 92.1, strong: 78, weak: 5, unavailable: 2, read: 'OVERBOUGHT — y' }];
    const RSR = [null, { categories: ['AI'], rank: 1, peerCount: 12, percentile: 99, read: 'STRONG — top', topPeers: [{ ticker: 'NVDA' }], bottomPeers: [{ ticker: 'INTC' }] }, { categories: ['B'], rank: 11, peerCount: 12, percentile: 8, read: 'WEAK — bottom', topPeers: [], bottomPeers: [] }];
    const PSF = [null, { level: 101.25, volumeRatio: 3.7, daysSinceCross: 42 }];
    let n = 0;
    for (const p of P) {
      for (const dow of DOW) for (const ei of EI) for (const rsr of RSR) for (const psf of PSF) {
        const ind = { ...p.ind, dowTheoryConfirmation: dow, evaluativeIndex: ei, relativeStrengthRanking: rsr, progressiveStopFlag: psf };
        assert.deepStrictEqual(edwardsMageeDowTheory(structuredClone(ind) as never), o.callNormalized('edwardsMageeDowTheoryV1_', ind));
        assert.deepStrictEqual(edwardsMageeEvaluativeIndex(structuredClone(ind) as never), o.callNormalized('edwardsMageeEvaluativeIndexV1_', ind));
        assert.deepStrictEqual(edwardsMageeRelativeStrength(structuredClone(ind) as never), o.callNormalized('edwardsMageeRelativeStrengthV1_', ind));
        assert.deepStrictEqual(edwardsMageeStops(structuredClone(p.plan) as never, structuredClone(ind) as never), o.callNormalized('edwardsMageeStopsV1_', p.plan, ind));
        assert.deepStrictEqual(turtleRelativeStrength(structuredClone(ind) as never), o.callNormalized('turtleRelativeStrengthV1_', ind));
        n += 5;
      }
      assert.deepStrictEqual(edwardsMageePositionRisk(structuredClone(p.plan) as never), o.callNormalized('edwardsMageePositionRiskV1_', p.plan));
      assert.deepStrictEqual(edwardsMageeFanTrendChannel(structuredClone(p.plan) as never), o.callNormalized('edwardsMageeFanTrendChannelV1_', p.plan));
      assert.deepStrictEqual(schabackerTrendRead(structuredClone(p.ind) as never, structuredClone(p.plan) as never), o.callNormalized('schabackerTrendReadV1_', p.ind, p.plan));
      for (const regime of ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL']) {
        const plan = { ...p.plan, regime };
        assert.deepStrictEqual(schabackerTrendRead(structuredClone(p.ind) as never, structuredClone(plan) as never), o.callNormalized('schabackerTrendReadV1_', p.ind, plan));
      }
      const pats = [p.ind.chartPatterns, [], null, [{ type: 'BULL_FLAG', targetPrice: 120, date1: new Date(NOW) }, { type: 'DOUBLE_TOP', neckline: 90, peak: 100 }, { type: 'HEAD_AND_SHOULDERS', neckline: 80, head: 100 }, { type: 'RECTANGLE', top: 110, bottom: 100 }]];
      for (const cp of pats) assert.deepStrictEqual(schabackerMeasuringRules(structuredClone(cp) as never), o.callNormalized('schabackerMeasuringRulesV1_', cp));
      for (const target of [p.chart.currentPrice * 0.8, p.chart.currentPrice, p.chart.currentPrice * 1.3]) {
        assert.deepStrictEqual(timeToPriceGann(structuredClone(p.gann) as never, target), o.callNormalized('timeToPriceGannV7', p.gann, target));
      }
      for (const end of [60, 120, 200, p.chart.closes.length]) {
        const c = p.chart.closes.slice(0, end), v = p.chart.volumes.slice(0, end);
        for (const isDPO of [true, false]) assert.deepStrictEqual(dpoDelayedBreakout(c, v, isDPO), o.callNormalized('dpoDelayedBreakoutV7', c, v, isDPO));
      }
      n += 4;
    }
    for (const cp of [50, 100]) for (const target of [40, 100, 160]) for (const atr of [null, 0, 2, 5]) for (const regime of ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', 'X']) {
      assert.deepStrictEqual(timeToPriceATR(cp, target, atr, regime), o.callNormalized('timeToPriceATRV7', cp, target, atr, regime));
    }
    assert.equal(timeToPriceGann(null, 10), o.callNormalized('timeToPriceGannV7', null, 10));
    // A DPO delayed breakout that triggers: volume fades, then resurges, and the close breaks the window high.
    const closes = Array.from({ length: 40 }, (_, i) => (i < 39 ? 100 + Math.sin(i) : 104));
    const vols = Array.from({ length: 40 }, (_, i) => (i < 25 ? 5e6 - i * 1e5 : 2e6 + (i - 25) * 3e5));
    const trig = o.callNormalized<{ triggered?: boolean } | null>('dpoDelayedBreakoutV7', closes, vols, true);
    assert.deepStrictEqual(dpoDelayedBreakout(closes, vols, true), trig);
    assert.ok(n > 1000, String(n));
  });
});

describe('FL-7a-1 — scoreAllSignalsV7_', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('every signal row, category score, conflict, conviction and verdict matches the oracle', async () => {
    const o = loadOracle();
    const P = pipelines(6);
    const r = rng(77);
    const d = (days: number): Date => new Date(NOW - days * 86400000);
    const ENRICH: Array<Record<string, unknown>> = [
      {},
      {
        darkPoolShare: { darkPoolSharePct: 0.27, weekStartDate: '2026-10-05', tier: 'T1', elevated: true },
        macroSupplemental: { yieldCurveSpread: -0.42, yieldCurveInverted: true, yieldCurveAsOfDate: '2026-10-20', m2YoyGrowthPct: 3.1, m2AsOfDate: '2026-09-01', businessCyclePhase: { phase: 'EXPANSION' } },
        dowTheoryConfirmation: { verdict: 'BULL_CONFIRMED', lagTradingDays: 0, industrials: { close: 400.12 }, transports: { close: 70.5 } },
        evaluativeIndex: { pctStrong: 62.5, strong: 60, weak: 36, unavailable: 15, read: 'neutral' },
        playerMapping: { tag: 'STAIRCASE', evidence: ['higher lows', 'rising volume'] }, zombieCompanyScreen: { isZombie: true, read: 'ICR 0.4' },
        sharesOutstandingTrend: { steadilyRising: true, read: 'up 4 quarters' }, filingKeywordScreen: { anyFound: true, read: 'offering x3' },
        relativeStrengthRanking: { rank: 2, peerCount: 12, categories: ['AI', 'SEMI'], percentile: 92, read: 'STRONG' },
        progressiveStopFlag: { volumeRatio: 3.25 }, climaxVolume: true,
        wyckoffSchematic: { phase: 'ACCUMULATION', stage: 'SOS/SOW', read: 'Accumulation SOS' },
        trendAlignedVolume: { aligned: false, trendDir: 'up', avgUpDayVolume: 3.2e6, avgDownDayVolume: 4.1e6 },
        volumeProgressDivergence: { flagged: true, avgRecentVolume: 9e6, avgBaseVolume: 4e6, netProgressPct: 0.012 },
        trendMaturity: { maturity: 'NEW', monthsSinceCross: 1.3, direction: 'golden', foundCross: false },
        roundNumber: { near: true, nearest: 100, distPct: 0.012 },
        chartPatterns: [{ type: 'DOUBLE_TOP', date1: d(60), date2: d(18) }, { type: 'BEAR_FLAG' }, { type: 'BEAR_FLAG' }, { type: 'BULL_TRAP' }, { type: 'SCALLOP_SERIES' }, { type: 'BEAR_TRAP' }, { type: 'ROUNDING_TOP' }, { type: 'INVERSE_HEAD_AND_SHOULDERS' }, { type: 'DOUBLE_BOTTOM' }, { type: 'RECTANGLE' }, { type: 'TRIPLE_TOP' }, { type: 'PENNANT' }],
        singleCandle: { type: 'HAMMER', courseDirection: 'bullish', note: 'long lower wick' },
        weeklyVolatility: { tier: 'Hot', read: 'hot week' }, monthlyVolatility: { tier: 'Coiled', read: 'coiled month' },
        srLevels: { resistanceLevels: [{ level: 123.456, tier: 'PRIMARY', touchCount: 4, trendFavored: true }], supportLevels: [{ level: 98.7, tier: 'MINOR', touchCount: 2, trendFavored: false }] },
        srMultiTimeframe: { resistance: { level: 123.4, strength: 'WEEKLY+MONTHLY' }, support: { level: 98.7, strength: 'DAILY_ONLY' } },
        speculativeSpike: { isSpike: true, read: 'spike' }, dpoSignature: { triggered: true, read: 'DPO read' },
        secondaryDay: { triggered: true, yesterdayHigh: 101.5, yesterdayVolRatio: 2.4 },
        lockupExpiration: { status: 'UPCOMING', daysUntilExpiration: 12, lockupDate: new Date(Date.UTC(2026, 10, 4)) },
        recentReverseSplit: { ratio: '1:10', daysAgo: 30, date: new Date(Date.UTC(2026, 8, 23)) },
        monthlyStructure: { monthlyTrend: 'above', monthlySma: 88.123, monthsAvailable: 24 },
      },
      {
        dowTheoryConfirmation: { verdict: 'NEW_THING', lagTradingDays: 7, industrials: { close: 1 }, transports: { close: 2 } },
        macroSupplemental: { yieldCurveSpread: null, m2YoyGrowthPct: null, businessCyclePhase: null },
        playerMapping: { tag: 'UNCLEAR', evidence: [] }, zombieCompanyScreen: { isZombie: false, read: 'fine' },
        sharesOutstandingTrend: { steadilyRising: false, read: 'flat' }, filingKeywordScreen: { anyFound: false, read: 'none' },
        wyckoffSchematic: { phase: 'DISTRIBUTION', stage: 'LPS/LPSY', read: 'Distribution' },
        trendMaturity: { maturity: 'MATURE', monthsSinceCross: 14.2, direction: 'death', foundCross: true },
        chartPatterns: [{ type: 'DOUBLE_BOTTOM', date1: d(40), date2: d(5) }],
        weeklyVolatility: { tier: 'Normal', read: 'n' }, monthlyVolatility: { tier: 'Normal', read: 'n' },
        srLevels: { resistanceLevels: [], supportLevels: [] }, srMultiTimeframe: { resistance: { level: 1, strength: 'DAILY_ONLY' }, support: { level: 1, strength: 'WEEKLY' } },
        lockupExpiration: { status: 'EXPIRED', daysUntilExpiration: -40, lockupDate: new Date(Date.UTC(2026, 8, 13)) },
        monthlyStructure: { monthlyTrend: 'below', monthlySma: 120, monthsAvailable: 11 },
        pctFromSma20: null, pctFromSma200: null, sma200: null, pctFromSma50: null, goldenCross: false, deathCross: false, sma150: 0,
      },
    ];
    const FUNDS: unknown[] = [
      null,
      { forwardPE: 12.3, pegRatio: 0.8, revenueGrowth: 0.31, earningsGrowth: 0.25, profitMargins: 0.21, returnOnEquity: 0.33, targetMean: 300, targetHigh: 400, targetLow: 200, numAnalysts: 41, recMean: 1.8, recKey: 'buy', beta: 1.7, marketCap: 3.1e12, shareFloat: 2.4e9, dividend: 1, price: 100, grossMargins: 0.62, sector: 'Tech', industry: 'Semis' },
      { forwardPE: null, trailingPE: 55, pegRatio: 2.4, revenueGrowth: -0.15, earningsGrowth: -0.2, profitMargins: -0.05, returnOnEquity: -0.1, targetMean: 10, recMean: 3.9, beta: 0.6, marketCap: 250e6, shareFloat: 8e6, grossMargins: 0, sector: 'Bio' },
      { marketCap: 5e9, shareFloat: 45e6, dividend: 5, price: 100, beta: 1.0 },
    ];
    const SHORTS: unknown[] = [undefined, null, { shortInterest: 2e9, daysToCover: 3, settlementDate: '2026-10-15' }];
    const CACHED = [null, { shortInterest: null, daysToCover: null, settlementDate: null }, { shortInterest: 9e8, daysToCover: 2, settlementDate: '2026-10-01' }];
    const REGIMES = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', null, 'WEIRD'];
    const seen = { verdicts: new Set<string>(), conflicts: 0, fundNull: 0, fundScored: 0, defaultW: 0, squeeze: 0 };
    await inZone(TZ, async () => {
      for (const p of P) {
        for (const enrich of ENRICH) {
          const ind = { ...p.ind, ...enrich, last: enrich === ENRICH[1] ? p.ind.high52 : p.ind.last };
          for (const fund of FUNDS) for (const regime of REGIMES) for (const si of SHORTS) {
            const cached = CACHED[Math.floor(r() * 3)];
            const expected = withOracleGlobals({ readBrokerDataCacheV1_: () => cached, Date: pinnedDateClass(NOW) }, () => o.callNormalized<any>('scoreAllSignalsV7_', ind, fund, p.gann, p.chart, regime, si));
            const got = await scoreAllSignals({ timeZone: TZ, readBrokerData: async () => cached as never }, structuredClone(ind), structuredClone(fund), structuredClone(p.gann), structuredClone(p.chart), regime, si as never);
            assert.deepStrictEqual(got, expected, p.ticker + ' ' + regime + ' ' + JSON.stringify(si));
            seen.verdicts.add(got.longVerdict); seen.verdicts.add(got.shortVerdict);
            if (got.shortConflict.conflict || got.longConflict.conflict) seen.conflicts++;
            if (got.fundScore === null) seen.fundNull++; else seen.fundScored++;
            if (got.usedDefaultWeights) seen.defaultW++;
            if (got.longSignals.some((s) => s.name === 'Short Squeeze Setup')) seen.squeeze++;
          }
        }
      }
    });
    assert.ok(seen.verdicts.size >= 4 && seen.conflicts && seen.fundNull && seen.fundScored && seen.defaultW && seen.squeeze, JSON.stringify({ ...seen, verdicts: [...seen.verdicts] }));
    for (const name of ['RSI(14)', 'Golden/Death Cross', 'Volume vs 20d', 'ATR Regime', '52wk Range', 'Fibonacci Level', 'Breakout Context', 'Market Cap', '📐 Gann Angular', 'Relative Strength vs SPY', 'Monthly Structure (10mo SMA)']) {
      assert.equal(categoryOf(name), o.call('categoryOfV7_', name), name);
    }
    for (const [t, mc, rt] of [['DOUBLE_TOP', 3e12, 30], ['DOUBLE_BOTTOM', 50e9, null], ['DOUBLE_TOP', 3e9, 5], ['DOUBLE_BOTTOM', 500e6, 2], ['DOUBLE_TOP', 1e6, 2], ['TRIPLE_TOP', 3e12, 2], ['DOUBLE_TOP', 0, 1]] as Array<[string, number, number | null]>) {
      assert.deepStrictEqual(doubleTopBottomMarketCapContext(t, mc, rt), o.callNormalized('doubleTopBottomMarketCapContextV7', t, mc, rt));
    }
    for (const [s, c, h] of [[0.25, 100, 101], [0.25, 90, 100], [0.1, 100, 100], [null, 1, 1], [0.3, null, 1], [0.3, 1, null]] as Array<[number | null, number | null, number | null]>) {
      assert.deepStrictEqual(shortSqueezeSetup(s, c, h), o.callNormalized('shortSqueezeSetupV7', s, c, h));
    }
  });
});

describe('FL-7a-1 — newDataStatusV7 / setStatusV7 / makeLogger', { skip: legacyFilesPresent() ? false : 'legacy/ not populated' }, () => {
  test('the data-status record and its updates match the oracle', () => {
    const o = loadOracle();
    assert.deepStrictEqual(newDataStatus(), o.callNormalized('newDataStatusV7'));
    const r = rng(5);
    const keys = [...Object.keys(newDataStatus()), 'nope', ''];
    const mine = newDataStatus();
    const theirs = o.call<Record<string, unknown>>('newDataStatusV7');
    for (let i = 0; i < 300; i++) {
      const k = keys[Math.floor(r() * keys.length)];
      const st = ['ok', 'degraded', 'failed', 'pending'][Math.floor(r() * 4)];
      const det = r() < 0.3 ? undefined : r() < 0.5 ? null : 'detail ' + i;
      setStatus(mine as never, k, st, det as never);
      o.call('setStatusV7', theirs, k, st, det);
    }
    assert.deepStrictEqual(mine, structuredClone(theirs));
    setStatus(null, 'price', 'ok');
    o.call('setStatusV7', null, 'price', 'ok');
  });

  test('makeLogger appends to the 🔬 Log tab exactly as legacy did', async () => {
    await inZone(TZ, async () => {
      for (const initial of [{}, { '🔬 Log': [['old line 1'], ['old line 2']] }, { '🔬 Log': [] as unknown[][] }]) {
        const mk = async () => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
        const L = await mk(), P = await mk();
        withOracleGlobals({ Date: pinnedDateClass(NOW), SpreadsheetApp: { getActiveSpreadsheet: () => L, flush: () => {} } }, () => {
          const log = loadOracle().call<(m: string) => void>('makeLogger', L);
          for (let i = 0; i < 5; i++) log('line ' + i);
        });
        const plog = makeLogger(P, { timeZone: TZ, clock: { now: () => NOW } });
        for (let i = 0; i < 5; i++) plog('line ' + i);
        const sh = (b: ReportWorkbook) => b.getSheetByName('🔬 Log')!;
        assert.deepStrictEqual(sh(P).calls, sh(L).calls);
        assert.deepStrictEqual(sh(P).grid(), sh(L).grid());
      }
    });
  });
});
