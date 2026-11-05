/**
 * Differential verification of the position exit reads.
 *
 * The oracle's chart is handed to BOTH sides, so the one structural
 * difference (legacy fetches inside the function, the port requires a
 * chart) cannot mask a real divergence.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Indicators } from '../src/types/indicators.ts';
import type { StopDirection } from '../src/analysis/techPlan/stops.ts';
import {
  computePositionExitRead, computePositionExitReadFixedLookback,
  computeClassicalStopTrailing, turtlePyramidLadderForRealEntry,
  exitRecommendation, EXIT_GENERIC_LOOKBACK_TRADING_DAYS,
} from '../src/analysis/exitRead.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const DIRECTIONS: StopDirection[] = ['long', 'short'];

describe('position exit reads — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('both reads and both trailing opinions match the oracle', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let oracleCrashed = 0;
    let portSurvived = 0;
    const recommendations = new Set<string>();
    const errors = new Set<string>();
    let trailingFired = 0;
    let trailingNull = 0;
    let totalShifts = 0;
    let turtleAvailable = 0;
    let turtleUnavailable = 0;
    let turtleStoppedOut = 0;
    let maxUnits = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
      for (const len of [250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const n = chart.dates.length;

        // Entry dates spread across the series, plus both out-of-range ends.
        const entryDates = [0, 1, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.9), n - 1]
          .map((i) => chart.dates[i].toISOString().slice(0, 10));
        entryDates.push('1990-01-01', '2099-01-01');

        for (const ds of entryDates) {
          for (const ep of [chart.closes[0], chart.closes[Math.floor(n / 2)] * 1.2, 0, -5, NaN]) {
            let expected;
            try {
              expected = oracle.callNormalized<Record<string, unknown>>(
                'computePositionExitReadV1_', ticker, ep, ds, chart,
              );
            } catch {
              // F-14 reaches the exit path too (:9814 -> :3007). The port
              // has no Tier D, so it completes. Asserted, not glossed over.
              oracleCrashed++;
              const g = computePositionExitRead(ticker, ep, ds, chart, { legacyHistoricalTargets: true });
              assert.equal('error' in g ? g.error : 'missing', null,
                `${ticker}@${len} port should still produce a read where legacy dies`);
              portSurvived++;
              continue;
            }
            const got = computePositionExitRead(ticker, ep, ds, chart, { legacyHistoricalTargets: true });
            assert.deepStrictEqual(got, expected, `${ticker}@${len} ds=${ds} ep=${ep}`);
            comparisons++;
            if (expected.error) {
              errors.add(String(expected.error).slice(0, 40));
            } else {
              recommendations.add(String(expected.recommendation));
              const ct = expected.classicalTrailing as { shiftCount: number } | null;
              if (ct) {
                trailingFired++;
                totalShifts += ct.shiftCount;
              } else {
                trailingNull++;
              }
              const tp = expected.turtlePyramid as { available: boolean; stoppedOut?: boolean; units?: number } | null;
              if (tp && tp.available) {
                turtleAvailable++;
                if (tp.stoppedOut) turtleStoppedOut++;
                maxUnits = Math.max(maxUnits, tp.units ?? 0);
              } else {
                turtleUnavailable++;
              }
            }
          }
        }

        // `0` must fall back to 800 (legacy uses `||`, not `??`).
        for (const lb of [undefined, 0, 1, 50, 800, 100_000]) {
          for (const ep of [chart.closes[0], 0, NaN]) {
            let expected;
            try {
              expected = oracle.callNormalized<Record<string, unknown>>(
                'computePositionExitReadFixedLookbackV1_', ticker, ep, chart, lb,
              );
            } catch {
              oracleCrashed++;
              const g = computePositionExitReadFixedLookback(ticker, ep, chart, lb, { legacyHistoricalTargets: true });
              assert.equal('error' in g ? g.error : 'missing', null);
              portSurvived++;
              continue;
            }
            assert.deepStrictEqual(
              computePositionExitReadFixedLookback(ticker, ep, chart, lb, { legacyHistoricalTargets: true }),
              expected, `${ticker}@${len} fixedLookback lb=${lb} ep=${ep}`,
            );
            comparisons++;
            if (!expected.error) recommendations.add(String(expected.recommendation));
          }
        }

        const rawInd = oracle.call('computeAllIndicators', chart);
        const ind = oracle.callNormalized<Indicators>('computeAllIndicators', chart);

        // Out-of-range entry indices on purpose: null, negative, past the end.
        for (const ei of [null, -1, 0, 5, 20, Math.floor(n / 2), n - 1, n + 5]) {
          for (const d of DIRECTIONS) {
            assert.deepStrictEqual(
              computeClassicalStopTrailing(chart, ind, d, ei),
              oracle.callNormalized('computeClassicalStopTrailingV1_', chart, rawInd, d, ei),
              `${ticker}@${len} trailing ei=${ei} ${d}`,
            );
            comparisons++;
          }
        }
        for (const ei of [null, -1, 0, 19, 20, 25, Math.floor(n / 2), n - 1]) {
          for (const ep of [10, chart.closes[0], 0, NaN]) {
            assert.deepStrictEqual(
              turtlePyramidLadderForRealEntry(chart, ei, ep),
              oracle.callNormalized('turtlePyramidLadderForRealEntryV1_', chart, ei, ep),
              `${ticker}@${len} turtle ei=${ei} ep=${ep}`,
            );
            comparisons++;
          }
        }
      }
    }

    assert.ok(comparisons > 5000, `only ${comparisons} comparisons`);
    // All three user-facing error strings are reachable.
    assert.equal(errors.size, 3, `expected 3 distinct errors, saw ${[...errors].join(' | ')}`);
    // Four of the five ladder rungs occur on real data. The fifth (T2) does
    // not -- see the dedicated F-16 test below, which proves why.
    assert.equal(recommendations.size, 4, [...recommendations].join(' | '));
    assert.ok(trailingFired > 0 && trailingNull > 0, 'trailing stop exercised only one branch');
    assert.ok(totalShifts > 0, 'the trailing stop never ratcheted');
    assert.ok(turtleAvailable > 0 && turtleUnavailable > 0, 'turtle exercised only one branch');
    assert.ok(turtleStoppedOut > 0, 'the turtle ladder never stopped out');
    assert.equal(maxUnits, 4, 'the 4-unit pyramid cap was never reached');
    // F-14 must still reproduce here, and the port must still survive it.
    assert.ok(oracleCrashed > 0, 'F-14 no longer reaches the exit path');
    assert.equal(portSurvived, oracleCrashed);
  });

  test('the recommendation ladder is strictly risk-before-reward, all 16 combinations', () => {
    // Testing the ladder directly rather than hunting charts: 16 boolean
    // combinations is total coverage, where fixture search is not.
    const L = [false, true];
    for (const stop of L) {
      for (const thesis of L) {
        for (const t2 of L) {
          for (const t1 of L) {
            const got = exitRecommendation(stop, thesis, t2, t1);
            const want = stop ? 'STOP HIT — EXIT'
              : thesis ? 'THESIS INVALIDATED — CONSIDER EXIT'
                : t2 ? 'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST'
                  : t1 ? 'T1 REACHED — CONSIDER PARTIAL PROFITS'
                    : 'HOLD';
            assert.equal(got, want, `stop=${stop} thesis=${thesis} t2=${t2} t1=${t1}`);
          }
        }
      }
    }
    // A stopped-out winner reads STOP HIT, never T2. That is the contract.
    assert.equal(exitRecommendation(true, false, true, true), 'STOP HIT — EXIT');
    assert.equal(exitRecommendation(false, true, true, true), 'THESIS INVALIDATED — CONSIDER EXIT');
    assert.equal(exitRecommendation(false, false, true, true),
      'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST');
  });

  test('F-16: the T2 rung never surfaces, because the stop rung always shadows it', () => {
    // Not "T2 is rare" -- measured: hitT2 was true 305 times across 792
    // real reads and was shadowed by stopBreached in ALL 305, never once by
    // AVOID. T1 fares barely better: true 553 times, surfaced 44 times.
    //
    // Cause: hitT1/hitT2 compare a HISTORICAL MAXIMUM (highest high since
    // entry) against targets recomputed from TODAY's price, while
    // stopBreached compares today's price against that same maximum minus
    // 3 ATR. Giving back more than 3 ATR from the peak trips the stop,
    // which outranks both profit rungs.
    //
    // Reproduced, not fixed. This test fails if that stops being true.
    const oracle = loadOracle();
    let reads = 0;
    let hitT2 = 0;
    let t2ShadowedByStop = 0;
    let t2Surfaced = 0;
    let hitT1 = 0;
    let t1Surfaced = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
      for (const len of [250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const n = chart.dates.length;
        for (let frac = 0; frac < 1; frac += 0.1) {
          const i = Math.floor(n * frac);
          if (i >= n) continue;
          const ds = chart.dates[i].toISOString().slice(0, 10);
          const r = computePositionExitRead(ticker, chart.closes[i], ds, chart, { legacyHistoricalTargets: true });
          if ('error' in r && r.error) continue;
          const read = r as Extract<typeof r, { error: null }>;
          reads++;
          if (read.hitT2) {
            hitT2++;
            if (read.recommendation.startsWith('T2')) t2Surfaced++;
            else if (read.stopBreached) t2ShadowedByStop++;
          }
          if (read.hitT1) {
            hitT1++;
            if (read.recommendation.startsWith('T1')) t1Surfaced++;
          }
        }
      }
    }

    assert.ok(reads > 400, `only ${reads} reads`);
    assert.ok(hitT2 > 100, `hitT2 only true ${hitT2} times -- sample too small to conclude`);
    assert.equal(t2Surfaced, 0, 'T2 now surfaces -- F-16 has changed, re-examine the finding');
    assert.equal(t2ShadowedByStop, hitT2, 'every T2 hit should be shadowed by the stop rung');
    // The contrast: T1 does surface, just rarely. So the ladder is not
    // simply dead -- it is specifically T2 that is unreachable.
    assert.ok(t1Surfaced > 0 && t1Surfaced < hitT1, `T1 surfaced ${t1Surfaced} of ${hitT1}`);
  });

  test('the fixed-lookback read omits since-entry fields, and says which read it is', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture('NVDA');
    const chart = buildChart(raw, raw.closes.length);
    const r = computePositionExitReadFixedLookback('NVDA', chart.closes[0], chart, undefined, { legacyHistoricalTargets: true });
    assert.ok(!('error' in r) || r.error === null);
    const read = r as Extract<typeof r, { error: null }>;
    // Deliberate omissions: no entry date means no holding period and no
    // entry bar, so a daysHeld or a trailing ladder would be fabricated.
    assert.ok(!('daysHeld' in read));
    assert.ok(!('classicalTrailing' in read));
    assert.ok(!('turtlePyramid' in read));
    assert.equal(read.lookbackTradingDays, EXIT_GENERIC_LOOKBACK_TRADING_DAYS);
    assert.equal(EXIT_GENERIC_LOOKBACK_TRADING_DAYS, 800);
    // And it matches the oracle, including the explicit disclosure wording.
    assert.deepStrictEqual(
      read,
      oracle.callNormalized('computePositionExitReadFixedLookbackV1_', 'NVDA', chart.closes[0], chart, undefined),
    );
    if (read.stopBreached) {
      assert.ok(read.reason.includes('NOT since your actual entry'),
        'the stop reason must disclose that this is a generic lookback');
    }
    // 0 falls back to 800 rather than producing an empty window.
    const zero = computePositionExitReadFixedLookback('NVDA', chart.closes[0], chart, 0, { legacyHistoricalTargets: true });
    assert.equal((zero as Extract<typeof zero, { error: null }>).lookbackTradingDays, 800);
  });
});
