/**
 * Broker Course BC-5 parity: Phase 11 -- breakout context, the report
 * builder and its formatter.
 *
 * ══ EVERY I/O CALL IS STUBBED IN THE ORACLE, AND RESTORED ═════════════
 * The legacy builder reaches seven I/O globals (13F pair, earnings
 * calendar, two Sheet caches, two ETF fetchers). Each case replaces them
 * via oracle.setGlobal and restores them in a `finally`; the port receives
 * the same data as explicit inputs, resolved the way legacy resolves it.
 * Without this, every report section fed by I/O would compare null to
 * null (the vacuity trap).
 *
 * Real data: all 26 stock fixtures at fixed lengths, at each fixture's
 * first real golden- and death-cross bar, at a bar ending a real
 * staircase, and at CQZB/HQZA just after their real reverse splits. Every
 * synthesis rule and all three net reads are asserted to occur.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent, FIXTURE_DIR } from './fixtures.ts';
import { trailing52WeekRangeV1 } from '../src/analysis/models/brokerCourse/stockIdCard.ts';
import { detectPriceGapsV1 } from '../src/analysis/models/brokerCourse/gaps.ts';
import { staircasePatternReadV1 } from '../src/analysis/models/brokerCourse/playerMapping.ts';
import {
  breakoutContextReadV1, buildBrokerCourseReportV1, formatBrokerCourseReportV1,
  type BrokerCourseReport, type Holdings13F,
} from '../src/analysis/models/brokerCourse/report.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Every legacy global the builder reaches I/O through, stubbed per case. */
const STUBBED = ['fetch13FCusipV7', 'fetchInstitutional13FHoldingsV7', 'fetchEarningsCalendarV7',
  'readBrokerDataCacheV1_', 'readMacroSnapshotV1_', 'fetchSpdrEtfTopHoldingsV1', 'fetchQqqTopHoldingsV1'] as const;

/** Runs `fn` with the oracle's I/O globals replaced, ALWAYS restoring them. */
function withStubs<T>(stubs: Partial<Record<(typeof STUBBED)[number], unknown>>, fn: () => T): T {
  const oracle = loadOracle();
  const saved = STUBBED.map((n) => [n, oracle.getGlobal(n)] as const);
  try {
    for (const n of STUBBED) oracle.setGlobal(n, stubs[n] ?? (() => null));
    return fn();
  } finally {
    for (const [n, v] of saved) oracle.setGlobal(n, v);
  }
}

/** A FRED CSV parsed exactly as fetchFredSeriesV1 does. */
function fred(file: string): number[] {
  const out: number[] = [];
  for (const l of fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8').split('\n').slice(1)) {
    const v = parseFloat(l.split(',')[1]);
    if (!isNaN(v)) out.push(v);
  }
  return out;
}

/** First chart lengths whose LAST bar is a golden / death cross (rolling SMAs, confirmed by the oracle downstream). */
function crossLengths(closes: readonly number[]): number[] {
  const out: number[] = [];
  let g = 0;
  let d = 0;
  const sma = (end: number, p: number): number => {
    let s = 0;
    for (let i = end - p; i < end; i++) s += closes[i];
    return s / p;
  };
  for (let L = 202; L <= closes.length && (!g || !d); L++) {
    const now = sma(L, 50) - sma(L, 200);
    const prev = sma(L - 1, 50) - sma(L - 1, 200);
    if (!g && prev <= 0 && now > 0) { g = L; out.push(L); }
    if (!d && prev >= 0 && now < 0) { d = L; out.push(L); }
  }
  return out;
}

const DAY = 86400000;

describe('Broker Course P11 — report assembly', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('breakout context: every edge, and the engine\'s own read agrees on real charts', () => {
    const oracle = loadOracle();
    for (const px of [null, 96.9, 97, 100]) {
      for (const hi of [null, 100]) {
        for (const roc of [null, -0.31, -0.30, 0, 0.10, 0.11]) {
          for (const tol of [undefined, null, 0.05]) {
            assert.deepStrictEqual(breakoutContextReadV1(px, hi, roc, tol),
              oracle.callNormalized('breakoutContextReadV1', px, hi, roc, tol), `${px}/${hi}/${roc}/${tol}`);
          }
        }
      }
    }
    // Both thresholds strict; near-ATH inclusive at exactly 3% below.
    assert.equal(breakoutContextReadV1(97, 100, null).nearATH, true);
    assert.equal(breakoutContextReadV1(null, 100, -0.30).longTermDowntrend, false);
    assert.equal(breakoutContextReadV1(null, 100, 0.10).longTermTrend, 'flat');
    // The engine computes its own breakoutContext (:7539-7543). Production-
    // shaped on real charts, the two classifications agree everywhere.
    let compared = 0;
    for (const ticker of listFixtures()) {
      if (ticker === '_VIX') continue;
      const raw = loadRawFixture(ticker);
      for (let cut = 0; cut < 1200; cut += 120) {
        const L = raw.closes.length - cut;
        if (L < 300) continue;
        const ch = buildChart(raw, L);
        const eng = oracle.call<{ breakoutContext: string }>('computeAllIndicators', ch).breakoutContext;
        const r52 = trailing52WeekRangeV1(ch.highs, ch.lows, ch.dates);
        const roc = (ch.currentPrice - ch.closes[L - 1 - 252]) / ch.closes[L - 1 - 252];
        const b = breakoutContextReadV1(ch.currentPrice, r52 ? r52.high : null, roc);
        const mine = b.nearATH ? 'near 52wk/ATH — favorable breakout context'
          : b.longTermDowntrend ? 'long-term downtrend — weaker breakout context' : 'neutral';
        assert.equal(mine, eng, `${ticker}@${L}`);
        compared++;
      }
    }
    assert.ok(compared > 150, `only ${compared}`);
  });

  test('the assembled report and its formatted text match the oracle, all I/O injected', () => {
    const oracle = loadOracle();
    const dgs10 = fred('dgs10.csv');
    const fedfunds = fred('fedfunds.csv');
    const synth = new Set<string>();
    const nets = new Set<string>();
    let comparisons = 0;
    let with13F = 0;
    let withEarnings = 0;
    let withLockup = 0;
    const holdings13F: Holdings13F = {
      BlackRock: { latest: { holdings: { shares: 1234567, value: 2.5e9 }, date: '2026-06-30' }, prior: { holdings: { shares: 1200000, value: 2.2e9 }, date: '2026-03-31' } },
      Vanguard: { latest: { holdings: { shares: 900000, value: 1.8e9 }, date: '2026-06-30' }, prior: null },
      'State Street': { latest: { holdings: null }, prior: { holdings: { shares: 50000, value: 9e7 }, date: '2026-03-31' } },
      Berkshire: { latest: null, prior: null },
    };
    // Real filers, but no position anywhere: filtered to null.
    const empty13F: Holdings13F = { BlackRock: { latest: { holdings: null }, prior: null } };
    for (const ticker of listFixtures()) {
      // _VIX is an index the harness fills with synthetic O/H/L/V.
      if (ticker === '_VIX') continue;
      const raw = loadRawFixture(ticker);
      const N = raw.closes.length;
      const lens = new Set<number>([61, 300, N, ...crossLengths(raw.closes)]);
      // A length ending on a real staircase, so the one bullish rule no
      // fixed length reaches is exercised on real bars.
      for (let L = N; L > Math.max(30, N - 400); L--) {
        if (staircasePatternReadV1(raw.closes.slice(0, L), (raw.volumes ?? []).slice(0, L), 20)?.isStaircase) {
          lens.add(L);
          break;
        }
      }
      if (ticker === 'CQZB' || ticker === 'HQZA') {
        const full = buildChart(raw);
        const rs = full.splits.find((s) => s.numerator < s.denominator)!;
        lens.add(full.dates.findIndex((d) => d >= rs.date) + 31);
      }
      for (const len of lens) {
        if (len > N || len < 30) continue;
        const base = buildChart(raw, len);
        const gaps = detectPriceGapsV1(base.opens, base.closes, base.dates, 0.02);
        const lastGap = gaps[gaps.length - 1];
        const gapDay = lastGap
          ? new Date(Date.UTC(lastGap.date.getUTCFullYear(), lastGap.date.getUTCMonth(), lastGap.date.getUTCDate()))
          : new Date(0);
        const T0 = Date.now();
        // Vacuity trap: none of these inputs exists in an isolated run.
        const scenarios = [
          { fund: null, vix: null, cache: null, macro: null, so: null, filing: null, cusip: null, h13: null, earn: null, recentIpo: false },
          {
            fund: { marketCap: 2e12, shareFloat: 5e9, revenueGrowth: -0.05, sector: 'Tech', industry: 'Semis', _sources: ['FMP'],
              _earningsHistory: [{ date: gapDay, epsActual: 1.2, epsEstimated: 1, revenueActual: 110, revenueEstimated: 100 }] },
            vix: 18,
            cache: { shortInterest: 2e9, daysToCover: 3, settlementDate: '2026-09-15', interestCoverageRatio: 0 },
            macro: { dgs10: dgs10.slice(-60), fedfunds: fedfunds.slice(-24), gdpSeries: [100, 102, 105] },
            so: [{ date: 'a', value: 1 }, { date: 'b', value: 2 }, { date: 'c', value: 3 }], filing: { offering: 1 },
            cusip: 'X', h13: holdings13F, earn: null, recentIpo: false,
          },
          {
            fund: { marketCap: 1e9, shareFloat: 8e6, revenueGrowth: 0.2 }, vix: 45,
            cache: { shortInterest: 3e6, daysToCover: 1, settlementDate: null, interestCoverageRatio: 0.5 },
            macro: { dgs10: null, fedfunds: fedfunds.slice(-24), gdpSeries: null },
            so: [{ date: 'a', value: 2 }, { date: 'b', value: 2 }], filing: {} as Record<string, number | null>, cusip: 'X', h13: empty13F,
            earn: { next: null, history: [{ date: new Date(gapDay.getTime() - DAY), epsActual: 0.5, epsEstimated: 0.6, revenueActual: null, revenueEstimated: null }] },
            recentIpo: false,
          },
          { fund: {}, vix: 0, cache: { shortInterest: null, interestCoverageRatio: 3 }, macro: null, so: null, filing: null,
            cusip: 'X', h13: null, earn: null, recentIpo: true },
        ];
        for (const [si, sc] of scenarios.entries()) {
          // The lock-up read uses legacy's wall clock; an IPO ~100.5 days
          // back keeps both sides on the same day count.
          const chart = sc.recentIpo ? { ...base, ipoDate: new Date(T0 - 100.5 * DAY) } : base;
          const spdr = ticker === 'SPY' && si === 1 ? { holdings: [{ ticker: 'NVDA', weightPct: 7.9 }], top10ConcentrationPct: 7.9 } : null;
          const now = new Date();
          const raw0 = withStubs({
            fetch13FCusipV7: () => sc.cusip,
            fetchInstitutional13FHoldingsV7: () => sc.h13,
            fetchEarningsCalendarV7: () => sc.earn,
            readBrokerDataCacheV1_: () => sc.cache,
            readMacroSnapshotV1_: () => sc.macro,
            fetchSpdrEtfTopHoldingsV1: () => spdr,
          }, () => oracle.call<BrokerCourseReport>('buildBrokerCourseReportV1',
            ticker, undefined, chart, sc.vix, sc.fund, null, sc.so, sc.filing));
          // The same inputs, resolved the way the legacy builder resolves them.
          const port = buildBrokerCourseReportV1(ticker, {
            chart, fund: sc.fund, vixLevel: sc.vix, sharesOutstandingHistory: sc.so, filingKeywordHits: sc.filing,
            holdings13F: sc.cusip ? sc.h13 : null,
            earningsHistory: sc.earn ? sc.earn.history : undefined,
            brokerDataCache: sc.cache, macroSnapshot: sc.macro,
            spdrHoldings: spdr, qqqHoldings: null, now,
          })!;
          assert.deepStrictEqual(port, structuredClone(raw0), `${ticker}@${len} scenario ${si}`);
          assert.equal(formatBrokerCourseReportV1(port), oracle.call('formatBrokerCourseReportV1', raw0), `${ticker}@${len} scenario ${si} text`);
          comparisons += 2;
          for (const b of port.synthesis.bullish) synth.add('+' + b);
          for (const c of port.synthesis.cautionary) synth.add('-' + c);
          nets.add(port.synthesis.netRead);
          if (port.institutional13F) with13F++;
          if (port.news.earningsGap) withEarnings++;
          if (port.fundamentalsScreen.evidence.some((e) => e.startsWith('Lock-up'))) withLockup++;
        }
      }
    }
    assert.ok(comparisons > 900, `only ${comparisons} comparisons`);
    assert.equal(nets.size, 3);
    // Every synthesis rule fires at least once (both technique tags too).
    // Matched by prefix on the FULL line -- a first draft truncated lines
    // and hand-typed truncated needles, and got one wrong.
    const needles = [
      '+Player Mapping: institutional', '-Player Mapping: speculative', '-Fundamentals: dilution',
      '-Fibonacci: retracement', '+Technicals: golden cross', '-Technicals: death cross',
      '-News: recent reverse split', '+News: Short Squeeze', '+Technique: Secondary-Day',
      '+Technique: Counter-Trend', '-Macro: interest coverage', '-VIX: Normal regime',
    ];
    const missing = needles.filter((nd) => ![...synth].some((l) => l.startsWith(nd)));
    assert.deepStrictEqual(missing, [], 'synthesis rules that never fired');
    assert.ok(with13F > 0 && withEarnings > 0 && withLockup > 0, `${with13F}/${withEarnings}/${withLockup}`);
  });

  test('a missing chart refuses with exactly legacy\'s two log lines', () => {
    const oracle = loadOracle();
    const portLog: string[] = [];
    const oracleLog: string[] = [];
    assert.equal(buildBrokerCourseReportV1('ZZZ', {
      chart: null, fund: null, vixLevel: null, sharesOutstandingHistory: null, filingKeywordHits: null,
      holdings13F: null, earningsHistory: null, brokerDataCache: null, macroSnapshot: null,
      spdrHoldings: null, qqqHoldings: null, now: new Date(),
    }, (m) => portLog.push(m)), null);
    // Legacy: existingFund given (no fundamentals fetch); its own chart
    // fetch fails in the sandbox, so the ID card refuses first.
    assert.equal(oracle.call('buildBrokerCourseReportV1', 'ZZZ', (m: string) => oracleLog.push(m), null, null, null, null, null, null), null);
    assert.deepStrictEqual(portLog, oracleLog);
    assert.deepStrictEqual(portLog, ['  ID Card: chart fetch failed for ZZZ', 'Report: ID card build failed for ZZZ']);
    assert.equal(formatBrokerCourseReportV1(null), oracle.call('formatBrokerCourseReportV1', null));
  });

  test('F-28: an interest-coverage ratio of 0 is "not a zombie" in the screen and "zombie" in the synthesis', () => {
    const oracle = loadOracle();
    const chart = buildChart(loadRawFixture('GOOGL'), 600);
    const fund = { marketCap: 2e12, shareFloat: 5e9, revenueGrowth: 0.1 };
    const cache = { shortInterest: null, interestCoverageRatio: 0 };
    const raw0 = withStubs({ readBrokerDataCacheV1_: () => cache, fetchEarningsCalendarV7: () => null },
      () => oracle.call<BrokerCourseReport>('buildBrokerCourseReportV1', 'GOOGL', undefined, chart, 30, fund, null, null, null));
    const port = buildBrokerCourseReportV1('GOOGL', {
      chart, fund, vixLevel: 30, sharesOutstandingHistory: null, filingKeywordHits: null, holdings13F: null,
      earningsHistory: undefined, brokerDataCache: cache, macroSnapshot: null, spdrHoldings: null, qqqHoldings: null,
      now: new Date(),
    })!;
    assert.deepStrictEqual(port, structuredClone(raw0));
    // The screen (BC-1, a documented real fix): exactly 0 is NOT a zombie.
    assert.match(port.macro.zombieCompanyScreen, /not a zombie-company profile/);
    assert.ok(!port.macro.evidence.some((e) => /zombie/.test(e)), 'not-zombie is never put in evidence');
    // The synthesis re-tests `< 1.0` raw and calls it a zombie anyway.
    assert.ok(port.synthesis.cautionary.includes('Macro: interest coverage below 1.0 — standard academic zombie-company profile'));
    // And the text the user reads carries ONLY the wrong verdict.
    const text = formatBrokerCourseReportV1(port);
    assert.equal(text, oracle.call('formatBrokerCourseReportV1', raw0));
    assert.match(text, /\[-\] Macro: interest coverage below 1\.0 — standard academic zombie-company profile/);
    assert.doesNotMatch(text, /not a zombie-company profile/);
  });
});
