/**
 * Broker Course BC-1 parity: Phases 2, 3 and 13 (18 functions).
 *
 * These three are the file's FOUNDATIONS -- P4, P5, P14 and P11 depend on
 * P2; P7 depends on P3's riskReward; P6 and P9 depend on P13. Phase
 * numbering does not match dependency order, which is why 13 is here and
 * not last.
 *
 * ══ EVERY SYNTHETIC CASE IS VERIFIED TO HIT ITS BRANCH ═════════════════
 * Real fixtures reach only 4 of the 7 candle shapes, neither MA cross, and
 * 4 of the 5 business-cycle phases. The synthetic bars below were each
 * probed against the oracle FIRST to confirm they classify as intended --
 * one candidate I assumed was 'Standard' turned out to be 'Hammer (green)'
 * because the wick tests are non-strict (`>=` and `<=`), which would have
 * made the assertion vacuous.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  candleGeometryV1, classifyCandleV1, candleContextReadV1,
  findSwingPointsV1, findSupportResistanceV1, srReliabilityContextV1,
  smaV1, smaSeriesV1, maRelationshipReadV1,
} from '../src/analysis/models/brokerCourse/technicals.ts';
import {
  fibonacciLevelsV1, fibonacciRetracementReadV1, fibonacciExtensionTargetsV1,
  flagPatternQualityV1, riskRewardV1,
  FIB_RETRACEMENT_RATIOS, FIB_EXTENSION_RATIOS,
} from '../src/analysis/models/brokerCourse/fibonacci.ts';
import {
  sharesOutstandingTrendReadV1, filingKeywordReadV1,
  businessCyclePhaseReadV1, zombieCompanyScreenV1, SEC_DILUTION_KEYWORDS,
} from '../src/analysis/models/brokerCourse/screens.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Reads a top-level `const`/`var` from the oracle's realm. */
function oracleConst<T>(name: string): T {
  const F = loadOracle().fns.setStatusV7.constructor as new (body: string) => () => unknown;
  return structuredClone(new F('return ' + name + ';')()) as T;
}

/**
 * One bar per candle shape, each PROBED against the oracle before use.
 * The last entry is a genuine 'Standard': [10,11,9,10.5] is NOT one.
 */
const SHAPE_BARS: Array<[string, [number, number, number, number]]> = [
  ['Full Green (Marubozu)', [10, 20.2, 9.8, 20]],
  ['Full Red (Marubozu)', [20, 20.2, 9.8, 10]],
  ['Hammer (red)', [10, 10.0, 9.0, 9.9]],
  ['Hammer (green)', [9.9, 10.0, 9.0, 10]],
  ['Inverted Hammer (green)', [9.9, 11, 9.9, 10]],
  ['Inverted Hammer (red)', [10, 11, 9.9, 9.9]],
  ['Doji', [10, 10.5, 9.5, 10.01]],
  ['Standard', [10, 11, 9, 10.2]],
];

describe('Broker Course P2 — charts/technicals', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('all seven candle shapes classify exactly as the oracle does', () => {
    const oracle = loadOracle();
    const seen = new Set<string>();
    for (const [expectedType, bar] of SHAPE_BARS) {
      const got = classifyCandleV1(...bar);
      assert.equal(got, oracle.call('classifyCandleV1', ...bar), `geometry ${JSON.stringify(bar)}`);
      // The probe, as an assertion: this bar really is that shape.
      assert.equal(got, expectedType, `${JSON.stringify(bar)} should be ${expectedType}`);
      seen.add(expectedType);
      assert.deepStrictEqual(
        candleGeometryV1(...bar),
        oracle.callNormalized('candleGeometryV1', ...bar),
      );
    }
    assert.equal(seen.size, 8, 'one bar per distinct shape label');

    // Degenerate inputs: nullish, NaN, and a zero-range bar.
    const bad: Array<[unknown, unknown, unknown, unknown]> = [
      [null, 1, 1, 1], [10, NaN, 9, 10], [5, 5, 5, 5], [undefined, 1, 1, 1],
    ];
    for (const b of bad) {
      assert.deepStrictEqual(
        candleGeometryV1(b[0] as number, b[1] as number, b[2] as number, b[3] as number),
        oracle.callNormalized('candleGeometryV1', ...b),
        `geometry ${JSON.stringify(b)}`,
      );
      assert.equal(
        classifyCandleV1(b[0] as number, b[1] as number, b[2] as number, b[3] as number),
        oracle.call('classifyCandleV1', ...b),
      );
    }
    // A zero-range bar has geometry but no classification.
    assert.ok(candleGeometryV1(5, 5, 5, 5) !== null);
    assert.equal(classifyCandleV1(5, 5, 5, 5), null);
  });

  test('the context read matches across every shape, trend and volume state', () => {
    const oracle = loadOracle();
    const reads = new Set<string>();
    let comparisons = 0;
    const trends = ['up', 'down', 'flat', null, undefined];
    // 1.49 and 1.5 straddle the volume-confirmation threshold.
    const vols = [null, undefined, 1.0, 1.49, 1.5, 2.0];
    for (const [, bar] of SHAPE_BARS) {
      const ct = classifyCandleV1(...bar);
      for (const tr of trends) {
        for (const rv of vols) {
          const expected = oracle.callNormalized('candleContextReadV1', ct, tr, rv);
          assert.deepStrictEqual(
            candleContextReadV1(ct, tr as string | null, rv), expected,
            `${ct} trend=${tr} vol=${rv}`,
          );
          comparisons++;
          const r = expected as { read: string } | null;
          if (r) reads.add(r.read);
        }
      }
    }
    assert.ok(comparisons > 200, `only ${comparisons} comparisons`);
    // 11 distinct read sentences before the volume suffix is appended;
    // asserting a floor rather than an exact count keeps this robust.
    assert.ok(reads.size >= 10, `only ${reads.size} distinct reads`);
    assert.equal(candleContextReadV1(null, 'up', 1), null);

    // Colour does not matter for a hammer -- the course is explicit.
    const green = candleContextReadV1('Hammer (green)', 'down', null);
    const red = candleContextReadV1('Hammer (red)', 'down', null);
    assert.equal(green?.read, red?.read, 'hammer colour must not change the read');

    // volumeConfirmed is three-state: null is "unknown", not "failed".
    assert.equal(candleContextReadV1('Doji', 'up', null)?.volumeConfirmed, null);
    assert.equal(candleContextReadV1('Doji', 'up', 1.49)?.volumeConfirmed, false);
    assert.equal(candleContextReadV1('Doji', 'up', 1.5)?.volumeConfirmed, true);
    // 'Standard' returns early, so it never gets a volume verdict.
    assert.equal(candleContextReadV1('Standard', 'up', 2.0)?.volumeConfirmed, null);
  });

  test('swings, S/R and the SMA family match on every fixture', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    const tiers = new Set<string>();
    let trendFavoredNull = 0;
    let trendFavoredBool = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      // 11 is the smallest length a window=5 scan can produce anything at.
      for (const len of [11, 30, 80, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const ch = buildChart(raw, len);

        for (const w of [undefined, 2, 5, 10]) {
          assert.deepStrictEqual(
            findSwingPointsV1(ch.highs, ch.lows, w),
            oracle.callNormalized('findSwingPointsV1', ch.highs, ch.lows, w),
            `${ticker}@${len} swings w=${w}`,
          );
          comparisons++;
        }

        for (const tol of [undefined, 0.01, 0.03, 0.1]) {
          // `undefined` vs explicit `null` is a REAL difference here --
          // see F-22. Both are exercised.
          for (const td of [undefined, null, 'up', 'down', 'flat'] as const) {
            const expected = oracle.callNormalized<{
              resistanceLevels: Array<{ tier: string; trendFavored: boolean | null }>;
              supportLevels: Array<{ tier: string; trendFavored: boolean | null }>;
            }>('findSupportResistanceV1', ch.highs, ch.lows, tol, ch.highs.length - 1, td);
            assert.deepStrictEqual(
              findSupportResistanceV1(ch.highs, ch.lows, tol, ch.highs.length - 1, td),
              expected, `${ticker}@${len} SR tol=${tol} td=${td}`,
            );
            comparisons++;
            for (const l of [...expected.resistanceLevels, ...expected.supportLevels]) {
              tiers.add(l.tier);
              l.trendFavored === null ? trendFavoredNull++ : trendFavoredBool++;
            }
          }
        }

        for (const p of [1, 50, 200, len, len + 1]) {
          assert.equal(smaV1(ch.closes, p), oracle.call('smaV1', ch.closes, p),
            `${ticker}@${len} sma ${p}`);
          assert.deepStrictEqual(smaSeriesV1(ch.closes, p),
            oracle.callNormalized('smaSeriesV1', ch.closes, p));
          comparisons += 2;
        }

        const s50 = oracle.call('smaSeriesV1', ch.closes, 50);
        const s200 = oracle.call('smaSeriesV1', ch.closes, 200);
        assert.deepStrictEqual(
          maRelationshipReadV1(structuredClone(s50) as number[], structuredClone(s200) as number[]),
          oracle.callNormalized('maRelationshipReadV1', s50, s200),
          `${ticker}@${len} MA`,
        );
        comparisons++;
      }
    }

    assert.ok(comparisons > 3000, `only ${comparisons} comparisons`);
    assert.deepStrictEqual([...tiers].sort(), ['Minor', 'Primary', 'Secondary']);
    // Both trendFavored states occur ONLY because this test passes a 5th
    // argument. Production never does -- see F-22.
    assert.ok(trendFavoredNull > 0 && trendFavoredBool > 0);

    for (const atHigh of [true, false, null]) {
      for (const lt of ['up', 'down', 'flat', null]) {
        assert.equal(srReliabilityContextV1(atHigh, lt),
          oracle.call('srReliabilityContextV1', atHigh, lt), `atHigh=${atHigh} lt=${lt}`);
      }
    }
    // Both SMA helpers refuse rather than returning a partial window --
    // and they refuse DIFFERENTLY: null vs [].
    assert.equal(smaV1([1, 2], 5), null);
    assert.deepStrictEqual(smaSeriesV1([1, 2], 5), []);
  });

  test('both MA crosses fire, which no fixture produced', () => {
    const oracle = loadOracle();
    // Probed first: these series really do trigger each cross.
    const cases: Array<[string, number[], number[]]> = [
      ['golden', [9, 11], [10, 10]],
      ['death', [11, 9], [10, 10]],
      ['none', [11, 12], [10, 10]],
    ];
    const crosses = new Set<string | null>();
    for (const [label, s50, s200] of cases) {
      const expected = oracle.callNormalized<{ cross: string | null }>(
        'maRelationshipReadV1', s50, s200,
      );
      assert.deepStrictEqual(maRelationshipReadV1(s50, s200), expected, label);
      crosses.add(expected.cross);
    }
    assert.equal(crosses.size, 3, 'golden, death and no-cross must all occur');
    assert.match(maRelationshipReadV1([9, 11], [10, 10])!.cross!, /Golden cross/);
    assert.match(maRelationshipReadV1([11, 9], [10, 10])!.cross!, /Death cross/);
    // Convergence is direction-AGNOSTIC: a 50 below the 200 and falling
    // further reads "diverging (trend strengthening)" -- correct for a
    // strengthening downtrend, and not a bullish label.
    const down = maRelationshipReadV1([9, 8], [10, 10]);
    assert.match(down!.convergence, /diverging/);
    assert.equal(down!.slope50, 'down');
    // Needs 2 points in BOTH series.
    assert.equal(maRelationshipReadV1([1], [1, 2]), null);
    assert.equal(maRelationshipReadV1([1, 2], [1]), null);
  });

  test('F-22: trendFavored is null on every level production ever produces', () => {
    // `trendDirection` is tested with `=== undefined`, and NO legacy call
    // site passes a 5th argument -- all three (:933, :1114, :1997) pass
    // exactly four. So the feature, added with a long comment quoting the
    // course verbatim on why support outranks resistance in an uptrend,
    // never fires. Reproduced, not fixed.
    const raw = loadRawFixture(listFixtures()[0]);
    const ch = buildChart(raw, 250);
    const asProduction = findSupportResistanceV1(ch.highs, ch.lows, 0.03, ch.highs.length - 1);
    const all = [...asProduction.resistanceLevels, ...asProduction.supportLevels];
    assert.ok(all.length > 0, 'no levels produced, so the test proves nothing');
    assert.ok(all.every((l) => l.trendFavored === null),
      'production-shaped call must yield trendFavored null everywhere');

    // And an explicit null is NOT the same as omitting: null !== undefined,
    // so it yields `false`, not `null`.
    const explicitNull = findSupportResistanceV1(ch.highs, ch.lows, 0.03, 0, null);
    const nulls = [...explicitNull.resistanceLevels, ...explicitNull.supportLevels];
    assert.ok(nulls.every((l) => l.trendFavored === false),
      'explicit null should yield false, not null');

    // With a real direction, support and resistance disagree as intended.
    const up = findSupportResistanceV1(ch.highs, ch.lows, 0.03, 0, 'up');
    assert.ok(up.supportLevels.every((l) => l.trendFavored === true));
    assert.ok(up.resistanceLevels.every((l) => l.trendFavored === false));
  });

  test('S/R tiering needs BOTH conditions for Primary but EITHER for Secondary', () => {
    // Asserted directly because it is easy to misread as symmetric.
    // Primary: touchCount >= 4 AND duration >= 60.
    // Secondary: touchCount >= 3 OR duration >= 60/30.
    const mk = (idxs: number[], price: number): { highs: number[]; lows: number[] } => {
      const n = Math.max(...idxs) + 10;
      const highs = Array.from({ length: n }, () => price - 5);
      const lows = Array.from({ length: n }, () => price + 5);
      for (const i of idxs) highs[i] = price;
      return { highs, lows };
    };
    // 10 touches packed into 20 bars: many touches, short duration ->
    // Secondary, NOT Primary, because Primary needs duration >= 60 too.
    const packed = mk([5, 7, 9, 11, 13, 15, 17, 19, 21, 23], 100);
    const r = findSupportResistanceV1(packed.highs, packed.lows, 0.03, 0);
    const top = r.resistanceLevels[0];
    assert.ok(top, 'expected at least one resistance level');
    assert.ok(top.touchCount >= 4, `expected >=4 touches, got ${top.touchCount}`);
    assert.ok(top.duration < 60, `expected a short duration, got ${top.duration}`);
    assert.equal(top.tier, 'Secondary', 'many touches over few bars is Secondary, not Primary');
    assert.deepStrictEqual(
      r, loadOracle().callNormalized('findSupportResistanceV1', packed.highs, packed.lows, 0.03, 0),
    );
  });
});

describe('Broker Course P3 — Fibonacci and flags', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('levels, retracement read and extensions match the oracle', () => {
    const oracle = loadOracle();
    assert.deepStrictEqual([...FIB_RETRACEMENT_RATIOS],
      oracleConst<number[]>('FIB_RETRACEMENT_RATIOS'));
    assert.deepStrictEqual([...FIB_EXTENSION_RATIOS],
      oracleConst<number[]>('FIB_EXTENSION_RATIOS'));

    let comparisons = 0;
    const anchors: Array<[number | null, number | null, string]> = [
      [100, 80, 'up'], [100, 80, 'down'],
      // high <= low, equal, and nullish -> all must refuse.
      [80, 100, 'up'], [100, 100, 'up'], [null, 80, 'up'], [100, null, 'up'],
      // An unrecognised direction falls to the 'down' arm.
      [100, 80, 'sideways'],
    ];
    for (const [hi, lo, dir] of anchors) {
      assert.deepStrictEqual(fibonacciLevelsV1(hi, lo, dir),
        oracle.callNormalized('fibonacciLevelsV1', hi, lo, dir), `levels ${hi}/${lo}/${dir}`);
      assert.deepStrictEqual(fibonacciExtensionTargetsV1(hi, lo),
        oracle.callNormalized('fibonacciExtensionTargetsV1', hi, lo));
      comparisons += 2;
      // 90 is exactly the 50% level of 80-100 -- the trendIntact boundary.
      for (const cp of [70, 80, 88.5, 90, 95, 100, 110, null]) {
        assert.deepStrictEqual(fibonacciRetracementReadV1(cp, hi, lo, dir),
          oracle.callNormalized('fibonacciRetracementReadV1', cp, hi, lo, dir),
          `read cp=${cp} ${hi}/${lo}/${dir}`);
        comparisons++;
      }
    }
    assert.ok(comparisons > 50, `only ${comparisons} comparisons`);

    // Exactly 50% retraced counts as INTACT (`<=`).
    const at50 = fibonacciRetracementReadV1(90, 100, 80, 'up');
    assert.equal(at50?.retracedFraction, 0.5);
    assert.equal(at50?.trendIntact, true);
    const past50 = fibonacciRetracementReadV1(89, 100, 80, 'up');
    assert.equal(past50?.trendIntact, false);
    // retracedFraction is NOT clamped -- beyond the swing it exceeds 1.
    const beyond = fibonacciRetracementReadV1(70, 100, 80, 'up');
    assert.ok((beyond?.retracedFraction ?? 0) > 1);
    // Keys are the ratio numbers stringified, not percentage labels -- and
    // NOT in insertion order. '0' and '1' are integer-like, so JS lists
    // them first in ascending numeric order, then the fractional string
    // keys in insertion order. Measured, after a wrong first guess.
    assert.deepStrictEqual(Object.keys(at50!.levels), ['0', '1', '0.382', '0.5', '0.618']);
    // The VALUES are what matter, and they are keyed correctly.
    assert.equal(at50!.levels[0], 100, 'ratio 0 anchors at the swing high for direction up');
    assert.equal(at50!.levels[1], 80, 'ratio 1.0 anchors at the swing low');
    assert.equal(at50!.levels[0.5], 90);
    // Extensions anchor on the LOW for both ratios, with no direction arg.
    assert.deepStrictEqual(fibonacciExtensionTargetsV1(100, 80),
      { 1.272: 80 + 1.272 * 20, 1.618: 80 + 1.618 * 20 });
  });

  test('flag quality reaches all six tiers, with volume as a hard first gate', () => {
    const oracle = loadOracle();
    const tiers = new Set<string>();
    let comparisons = 0;
    for (const pm of [null, 0, 0.1, 0.2, 0.5]) {
      for (const cr of [null, 0.02, 0.05, 0.2]) {
        for (const cb of [null, 5, 10, 30]) {
          // 1.49 / 1.5 straddle the hard gate.
          for (const bv of [null, 1.0, 1.49, 1.5, 3.0]) {
            const expected = oracle.callNormalized<{ tier: string }>(
              'flagPatternQualityV1', pm, cr, cb, bv,
            );
            assert.deepStrictEqual(flagPatternQualityV1(pm, cr, cb, bv), expected,
              `pm=${pm} cr=${cr} cb=${cb} bv=${bv}`);
            comparisons++;
            tiers.add(expected.tier);
          }
        }
      }
    }
    assert.equal(comparisons, 400);
    assert.deepStrictEqual([...tiers].sort(),
      ['Insufficient data', 'Invalid', 'Marginal', 'Moderate', 'Strong', 'Weak']);
    // The volume gate is checked BEFORE the missing-input check, so no
    // volume plus no inputs reads 'Invalid', not 'Insufficient data'.
    assert.equal(flagPatternQualityV1(null, null, null, null).tier, 'Invalid');
    assert.equal(flagPatternQualityV1(null, null, null, 2).tier, 'Insufficient data');
    // Tightness is RELATIVE to the pole, which was a real fix: a 10%
    // consolidation after a 15% move fails, after a 50% move passes.
    assert.equal(flagPatternQualityV1(0.15, 0.10, 30, 2).tightConsolidation, false);
    assert.equal(flagPatternQualityV1(0.50, 0.10, 30, 2).tightConsolidation, true);
    // 0/3 is 'Marginal' -- a valid-volume setup is never called Invalid.
    assert.equal(flagPatternQualityV1(0.1, 0.09, 5, 2).tier, 'Marginal');
  });

  test('risk:reward enforces the 1:1 floor and refuses zero risk', () => {
    const oracle = loadOracle();
    const cases: Array<[number | null, number | null, number | null]> = [
      [100, 95, 110], [100, 95, 105], [100, 95, 100], [100, 95, 102],
      [100, 100, 110], [100, 95, null], [null, 95, 110],
      // Target below entry: Math.abs means this still yields a ratio.
      [100, 105, 90],
    ];
    for (const [e, s, t] of cases) {
      assert.deepStrictEqual(riskRewardV1(e, s, t),
        oracle.callNormalized('riskRewardV1', e, s, t), `${e}/${s}/${t}`);
    }
    assert.equal(riskRewardV1(100, 100, 110), null, 'zero risk must refuse, not divide');
    // Measured, after a wrong first guess: (100, 95, 100) has reward 0 and
    // ratio 0 -- the target EQUALS entry. The 1:1 boundary is target 105,
    // i.e. entry plus the 5-point risk.
    assert.equal(riskRewardV1(100, 95, 100)?.ratio, 0, 'target == entry means zero reward');
    assert.equal(riskRewardV1(100, 95, 100)?.meetsMinimum, false);
    assert.equal(riskRewardV1(100, 95, 105)?.ratio, 1);
    assert.equal(riskRewardV1(100, 95, 105)?.meetsMinimum, true, 'exactly 1:1 passes');
    assert.equal(riskRewardV1(100, 95, 102.5)?.meetsMinimum, false);
    // Both legs are absolute, so a nonsensical setup still computes.
    assert.equal(riskRewardV1(100, 105, 90)?.ratio, 2);
  });
});

describe('Broker Course P13 — closing-gap screens', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('the dilution trend read is strict about "steadily"', () => {
    const oracle = loadOracle();
    const histories: Array<Array<{ date: string; value: number }> | null> = [
      null, [],
      [{ date: '2024-01-01', value: 100 }],
      [{ date: 'a', value: 100 }, { date: 'b', value: 110 },
        { date: 'c', value: 120 }, { date: 'd', value: 130 }, { date: 'e', value: 140 }],
      // One flat period in the middle breaks the streak entirely.
      [{ date: 'a', value: 100 }, { date: 'b', value: 110 },
        { date: 'c', value: 110 }, { date: 'd', value: 130 }],
      [{ date: 'a', value: 140 }, { date: 'b', value: 100 }],
    ];
    for (const h of histories) {
      for (const lb of [undefined, null, 0, 2, 4, 99]) {
        assert.deepStrictEqual(sharesOutstandingTrendReadV1(h, lb),
          oracle.callNormalized('sharesOutstandingTrendReadV1', h, lb),
          `${JSON.stringify(h)} lb=${lb}`);
      }
    }
    assert.equal(sharesOutstandingTrendReadV1(null), null);
    assert.equal(sharesOutstandingTrendReadV1([{ date: 'a', value: 1 }]), null, 'needs 2 points');
    const rising = sharesOutstandingTrendReadV1(histories[3]!);
    assert.equal(rising?.steadilyRising, true);
    assert.equal(rising?.periodsChecked, 4, 'default lookback is 4, not the full 5');
    // A flat quarter clears the flag even though shares still rose 30%.
    const flatMiddle = sharesOutstandingTrendReadV1(histories[4]!);
    assert.equal(flatMiddle?.steadilyRising, false);
    assert.ok((flatMiddle?.pctChange ?? 0) > 0.25,
      'pctChange is still reported, and is large, with no flag raised');
  });

  test('the filing-keyword read discloses that presence is not context', () => {
    const oracle = loadOracle();
    assert.deepStrictEqual([...SEC_DILUTION_KEYWORDS],
      oracleConst<string[]>('SEC_DILUTION_KEYWORDS_V1'));
    assert.equal(SEC_DILUTION_KEYWORDS.length, 5);
    // Annotated: a mixed array of differently-shaped literals widens to a
    // union TS will not accept as Record<string, number|null>.
    const cases: Array<Record<string, number | null> | null> = [
      null, {}, { offering: 0 }, { offering: 3, shelf: null, dilution: 1 }, { warrants: null },
    ];
    for (const h of cases) {
      assert.deepStrictEqual(filingKeywordReadV1(h),
        oracle.callNormalized('filingKeywordReadV1', h), JSON.stringify(h));
    }
    // A zero count is not "found"; a null count is skipped, not zeroed.
    assert.equal(filingKeywordReadV1({ offering: 0 })?.anyFound, false);
    assert.equal(filingKeywordReadV1({ warrants: null })?.anyFound, false);
    const found = filingKeywordReadV1({ offering: 3, shelf: null, dilution: 1 });
    assert.deepStrictEqual([...(found?.foundKeywords ?? [])], ['offering', 'dilution']);
    // The caveat is in the OUTPUT, not just a comment -- without it this
    // screen would present routine boilerplate as a dilution warning.
    assert.match(found!.read, /Word presence only, not context/);
  });

  test('all five business-cycle phases, including Expansion', () => {
    const oracle = loadOracle();
    const phases = new Set<string>();
    // [100,102,105] was probed to confirm it yields Expansion -- the
    // obvious-looking [100,101,102] does not, because q1 < q2.
    const series: Array<number[] | null> = [
      null, [1], [1, 2],
      [100, 102, 105], [100, 101, 102], [100, 101, 100],
      [100, 99, 98], [100, 99, 100], [100, 105, 107],
    ];
    for (const g of series) {
      const expected = oracle.callNormalized<{ phase: string } | null>(
        'businessCyclePhaseReadV1', g,
      );
      assert.deepStrictEqual(businessCyclePhaseReadV1(g), expected, JSON.stringify(g));
      if (expected) phases.add(expected.phase);
    }
    assert.equal(businessCyclePhaseReadV1([1, 2]), null, 'needs 3 points for two deltas');
    assert.equal(businessCyclePhaseReadV1([100, 102, 105])?.phase, 'Expansion');
    assert.equal(businessCyclePhaseReadV1([100, 99, 98])?.phase, 'Contraction');
    // "Peak" labels TWO different states, distinguished only by the
    // parenthetical -- a single negative quarter, and positive-but-
    // decelerating growth.
    const peaks = [...phases].filter((p) => p.startsWith('Peak'));
    assert.equal(peaks.length, 2, `expected two distinct Peak labels, got ${peaks.join(' / ')}`);
    assert.equal(phases.size, 5, [...phases].join(' // '));
  });

  test('the zombie screen excludes exactly zero, and flags negatives', () => {
    const oracle = loadOracle();
    for (const r of [null, 0, -2.5, 0.5, 0.999, 1.0, 2.67, 100]) {
      assert.deepStrictEqual(zombieCompanyScreenV1(r),
        oracle.callNormalized('zombieCompanyScreenV1', r), `ratio=${r}`);
    }
    assert.equal(zombieCompanyScreenV1(null), null, 'no data is distinct from zero');
    // Exactly 0 is a real AAPL value meaning near-zero NET interest
    // expense -- the opposite of distress.
    assert.equal(zombieCompanyScreenV1(0)?.isZombie, false);
    assert.match(zombieCompanyScreenV1(0)!.read, /near-zero net interest expense/);
    // Negative EBIT still flags.
    assert.equal(zombieCompanyScreenV1(-2.5)?.isZombie, true);
    assert.equal(zombieCompanyScreenV1(0.999)?.isZombie, true);
    assert.equal(zombieCompanyScreenV1(1.0)?.isZombie, false, '1.0 exactly is not a zombie');
  });
});
