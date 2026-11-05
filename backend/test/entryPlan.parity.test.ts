import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { normalizeFromOracle } from './normalize.ts';
import { computeTechScoreCore } from '../src/analysis/techPlan/scoring.ts';
import {
  computeEntryPlan, timeToPrice, deriveExitTargets, historicalCadence,
  computeStopRR, formatDuration, driftFactor, clusterBeyond, type Timing,
} from '../src/analysis/techPlan/entryPlan.ts';
import type { Indicators } from '../src/types/indicators.ts';
import type { GannRead } from '../src/analysis/gann.ts';
import type { ConfluenceTargets } from '../src/analysis/confluence.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 201, 250, 400];

/** Includes an ivRank above and below the 80 penalty threshold. */
const OPTION_VARIANTS = [
  null,
  { available: false },
  { available: true, dirSig: 0.5, leapsLean: 0.2, ivRank: 50 },
  { available: true, dirSig: 0.5, leapsLean: 0.2, ivRank: 90 },
];

/** The 16 Tier-B fields of computeTechnicalPlanV7's return value. */
const TIER_B_FIELDS = [
  'timing', 'entryPrice', 'entryLow', 'entryHigh', 'entryConfidencePct', 'timeToEntry',
  't1', 't1Time', 't2', 't2Time',
  'stop', 'rrToT1', 'rrToT2', 'stopAtSpot', 'rrToT1AtSpot', 'rrToT2AtSpot',
] as const;

interface Prep {
  ticker: string; len: number;
  chart: ReturnType<typeof buildChart>;
  rawInd: unknown; rawGann: unknown; rawConf: unknown;
  ind: Indicators; gann: GannRead; conf: ConfluenceTargets;
}

function prepared(): Prep[] {
  const oracle = loadOracle();
  const out: Prep[] = [];
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    if (!Array.isArray(raw.closes) || !Array.isArray(raw.highs) || raw.closes.length < 250) continue;
    for (const len of [...LENGTHS, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      const chart = buildChart(raw, len);
      let rawInd: unknown, rawGann: unknown, rawConf: unknown;
      try {
        rawInd = oracle.call('computeAllIndicators', chart);
        rawGann = oracle.call('computeGannInline', chart, rawInd);
        rawConf = oracle.call('computeConfluenceTargets', rawInd, rawGann, null, chart);
      } catch {
        continue;
      }
      out.push({
        ticker, len, chart, rawInd, rawGann, rawConf,
        ind: normalizeFromOracle(rawInd) as Indicators,
        gann: normalizeFromOracle(rawGann) as GannRead,
        conf: normalizeFromOracle(rawConf) as ConfluenceTargets,
      });
    }
  }
  return out;
}

describe('techPlan Tier B — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('all 16 Tier-B fields match the oracle across every option variant', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    for (const p of prepared()) {
      for (const opt of OPTION_VARIANTS) {
        const expected = oracle.callNormalized<Record<string, unknown>>(
          'computeTechnicalPlanV7', p.rawInd, p.rawGann, p.rawConf, p.chart, opt,
        );
        const core = computeTechScoreCore(p.ind, p.gann, p.chart, opt);
        const got = computeEntryPlan(p.ind, p.gann, p.conf, p.chart, opt, core.regime, core.overallSig) as unknown as Record<string, unknown>;
        for (const f of TIER_B_FIELDS) {
          assert.deepStrictEqual(got[f], expected[f], `${p.ticker}@${p.len} ${f} ivRank=${opt?.ivRank}`);
          comparisons++;
        }
      }
    }
    assert.ok(comparisons > 3000, `only ${comparisons} field comparisons`);
  });

  test('the three helpers match the oracle directly', () => {
    const oracle = loadOracle();
    for (const p of prepared()) {
      assert.deepStrictEqual(
        timeToPrice(p.chart.currentPrice, p.conf.entryCenter, { atr: p.ind.atr14, regime: 'CHOP', gann: p.gann, closes: p.chart.closes }),
        oracle.callNormalized('timeToPriceV7', p.chart.currentPrice, p.conf.entryCenter, { atr: p.ind.atr14, regime: 'CHOP', gann: p.rawGann, closes: p.chart.closes }),
        `${p.ticker}@${p.len} timeToPrice`,
      );
      assert.deepStrictEqual(
        deriveExitTargets(p.conf, p.ind.atr14, p.conf.entryCenter),
        oracle.callNormalized('deriveExitTargetsV7', p.rawConf, p.ind.atr14, p.conf.entryCenter),
        `${p.ticker}@${p.len} deriveExitTargets`,
      );
      assert.deepStrictEqual(
        historicalCadence(p.chart.closes, 0.05),
        oracle.callNormalized('historicalCadenceV7', p.chart.closes, 0.05),
        `${p.ticker}@${p.len} historicalCadence`,
      );
    }
  });

  test('all three timing values are genuinely produced', () => {
    const seen = new Set<Timing>();
    for (const p of prepared()) {
      const core = computeTechScoreCore(p.ind, p.gann, p.chart, null);
      seen.add(computeEntryPlan(p.ind, p.gann, p.conf, p.chart, null, core.regime, core.overallSig).timing);
    }
    for (const t of ['AVOID', 'BUY_NOW', 'WAIT_PULLBACK'] as Timing[]) {
      assert.ok(seen.has(t), `timing ${t} never observed`);
    }
  });

  test('BUY_NOW is reachable only from TREND_UP, and AVOID wins outright', () => {
    // Priority order is the whole logic: a cheap price in CHOP never yields
    // BUY_NOW, and a strongly negative signal overrides everything.
    for (const p of prepared()) {
      for (const opt of OPTION_VARIANTS) {
        const core = computeTechScoreCore(p.ind, p.gann, p.chart, opt);
        const plan = computeEntryPlan(p.ind, p.gann, p.conf, p.chart, opt, core.regime, core.overallSig);
        if (plan.timing === 'BUY_NOW') {
          assert.equal(core.regime, 'TREND_UP');
          assert.ok(p.chart.currentPrice <= plan.entryHigh * 1.02);
        }
        if (core.regime === 'TREND_DOWN' || core.overallSig <= -0.35) {
          assert.equal(plan.timing, 'AVOID', 'AVOID must win outright');
        }
      }
    }
  });

  test('elevated IV subtracts exactly 8 confidence points', () => {
    // The only difference between the two option variants is ivRank 50 vs 90.
    for (const p of prepared()) {
      const lowIv = { available: true, dirSig: 0.5, leapsLean: 0.2, ivRank: 50 };
      const highIv = { available: true, dirSig: 0.5, leapsLean: 0.2, ivRank: 90 };
      const coreLow = computeTechScoreCore(p.ind, p.gann, p.chart, lowIv);
      const coreHigh = computeTechScoreCore(p.ind, p.gann, p.chart, highIv);
      // dirSig/leapsLean are identical, so the score core is unchanged.
      assert.equal(coreLow.techScore, coreHigh.techScore);
      const a = computeEntryPlan(p.ind, p.gann, p.conf, p.chart, lowIv, coreLow.regime, coreLow.overallSig);
      const b = computeEntryPlan(p.ind, p.gann, p.conf, p.chart, highIv, coreHigh.regime, coreHigh.overallSig);
      assert.equal(b.entryConfidencePct, Math.max(0, a.entryConfidencePct - 8));
    }
  });

  test('the T1 promotion loop fires, is capped, and marks itself', () => {
    // T1 closer than one ATR to entry is not a real target -- T2 is promoted
    // into T1 and a fresh T2 found. Capped at 5 hops so tightly-clustered
    // targets cannot loop until the method list empties.
    let promoted = 0;
    for (const p of prepared()) {
      const { t1 } = deriveExitTargets(p.conf, p.ind.atr14, p.conf.entryCenter);
      if (t1.promoted) {
        promoted++;
        assert.ok((t1.promotionHops as number) >= 1 && (t1.promotionHops as number) <= 5, 'hops must stay within the cap');
      } else {
        assert.equal(t1.promotionHops, undefined, 'unpromoted targets carry no hop count');
      }
    }
    assert.ok(promoted > 0, 'the promotion path was never exercised');
  });

  test('T2 never reuses a method already consumed by T1', () => {
    for (const p of prepared()) {
      const { t1, t2 } = deriveExitTargets(p.conf, p.ind.atr14, p.conf.entryCenter);
      if (!t2) continue;
      const overlap = t2.basis.filter((name) => t1.basis.includes(name));
      assert.deepEqual(overlap, [], 'T1 and T2 must draw on disjoint methods');
      assert.ok(t2.price > t1.high, 'T2 must sit beyond T1');
    }
  });

  test('stop multipliers are tightest in trends and widest in HIGH_VOL', () => {
    // Counter-intuitive but deliberate: a trend should not retrace far before
    // the thesis is wrong; a volatile tape needs room to avoid a noise stop.
    const t1 = { price: 120, low: 118, high: 122, basis: [], count: 1 };
    assert.equal(computeStopRR(100, 10, 'TREND_UP', t1, null).stop, 100 - 12.5);
    assert.equal(computeStopRR(100, 10, 'TREND_DOWN', t1, null).stop, 100 - 12.5);
    assert.equal(computeStopRR(100, 10, 'CHOP', t1, null).stop, 100 - 15);
    assert.equal(computeStopRR(100, 10, 'HIGH_VOL', t1, null).stop, 100 - 20);
    // A missing target yields null, never a fabricated ratio.
    assert.equal(computeStopRR(100, 10, 'CHOP', null, null).rr1, null);
  });

  test('entry-based and spot-based stops diverge when price is outside the zone', () => {
    let differed = 0;
    for (const p of prepared()) {
      const core = computeTechScoreCore(p.ind, p.gann, p.chart, null);
      const plan = computeEntryPlan(p.ind, p.gann, p.conf, p.chart, null, core.regime, core.overallSig);
      if (Math.abs(plan.entryPrice - p.chart.currentPrice) > 1e-9) {
        assert.notEqual(plan.stop, plan.stopAtSpot, 'the two stops must differ when entry != spot');
        differed++;
      }
    }
    assert.ok(differed > 0, 'expected cases where price sits outside the entry zone');
  });

  test('time estimators decline independently and the estimate degrades', () => {
    // Each contributor may return null; the combined estimate just loses a
    // method rather than failing. With none available it returns null.
    assert.equal(timeToPriceATRFree(), null);
    function timeToPriceATRFree(): unknown {
      return timeToPrice(100, 110, { atr: 0, regime: 'CHOP', gann: null, closes: [] });
    }
    for (const p of prepared()) {
      const est = timeToPrice(p.chart.currentPrice, p.conf.entryCenter, {
        atr: p.ind.atr14, regime: 'CHOP', gann: p.gann, closes: p.chart.closes,
      });
      if (!est) continue;
      assert.equal(est.methods.length, est.methodCount);
      assert.ok(est.minDays <= est.baseDays && est.baseDays <= est.maxDays);
      // The range suffix appears only with more than one contributor, so a
      // single estimate cannot imply false precision.
      if (est.methodCount === 1) assert.ok(!est.humanText.includes('range'));
      else assert.ok(est.humanText.includes('range'));
    }
  });

  test('duration formatting uses the almost-equal sign and correct pluralisation', () => {
    assert.equal(formatDuration(null), 'N/A');
    assert.equal(formatDuration(1), '≈1 trading day');
    assert.equal(formatDuration(5), '≈5 trading days');
    assert.equal(formatDuration(20), '≈4 wks');
    assert.equal(formatDuration(5.2), '≈5 trading days');
    assert.ok(formatDuration(100).endsWith(' mo'));
    assert.ok(formatDuration(3).startsWith('≈'), 'U+2248, not ~');
  });

  test('drift factor is regime-aware and its default IS reachable', () => {
    // Unlike the dead DEFAULT entries in scoring.ts (F-10), this is a switch
    // over a string parameter, so an unexpected value genuinely reaches it.
    assert.equal(driftFactor('TREND_UP'), 0.45);
    assert.equal(driftFactor('HIGH_VOL'), 0.3);
    assert.equal(driftFactor('CHOP'), 0.2);
    assert.equal(driftFactor('SOMETHING_ELSE'), 0.35, 'default arm is live here');
  });

  test('clusterBeyond returns null when nothing remains above the floor', () => {
    assert.equal(clusterBeyond([], new Set(), 100), null);
    assert.equal(clusterBeyond(null, new Set(), 100), null);
    const methods = [{ name: 'A', price: 50, type: 'target' as const }];
    assert.equal(clusterBeyond(methods, new Set(), 100), null, 'below the floor');
    assert.equal(clusterBeyond(methods, new Set(['A']), 10), null, 'already used');
  });
});
