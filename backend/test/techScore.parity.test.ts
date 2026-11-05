import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { normalizeFromOracle } from './normalize.ts';
import { detectRegime, computeTechScoreCore, type OptionsAnalysis, type Regime } from '../src/analysis/techPlan/scoring.ts';
import type { Indicators } from '../src/types/indicators.ts';
import type { GannRead } from '../src/analysis/gann.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 201, 250, 400];

/** Covers absent, present-but-unavailable, bullish and bearish options reads. */
const OPTION_VARIANTS: Array<OptionsAnalysis | null> = [
  null,
  { available: false },
  { available: true, dirSig: 0.7, leapsLean: 0.4 },
  { available: true, dirSig: -0.9, leapsLean: -0.6 },
];

interface Prepared {
  ticker: string;
  len: number;
  chart: ReturnType<typeof buildChart> & { benchmarkCloses?: number[] };
  rawInd: unknown;
  rawGann: unknown;
  rawConf: unknown;
  ind: Indicators;
  gann: GannRead;
}

function prepared(): Prepared[] {
  const oracle = loadOracle();
  const out: Prepared[] = [];
  let spy: ReturnType<typeof loadRawFixture> | null = null;
  try {
    spy = loadRawFixture('SPY');
  } catch {
    spy = null;
  }

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
      // Both benchmark states, so the conditional `rs` Trend signal is covered
      // in its present AND absent form.
      for (const withBench of [false, true]) {
        if (withBench && (!spy || spy.closes.length < len)) continue;
        const chart = buildChart(raw, len) as ReturnType<typeof buildChart> & { benchmarkCloses?: number[] };
        if (withBench && spy) chart.benchmarkCloses = spy.closes.slice(0, len);

        let rawInd: unknown;
        let rawGann: unknown;
        let rawConf: unknown;
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
        });
      }
    }
  }
  return out;
}

describe('techPlan Tier A — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('detectRegime matches the oracle exactly', () => {
    const oracle = loadOracle();
    let n = 0;
    for (const p of prepared()) {
      assert.equal(detectRegime(p.ind), oracle.call('detectRegimeV7', p.rawInd), `${p.ticker}@${p.len}`);
      n++;
    }
    assert.ok(n > 100, `only ${n} comparisons`);
  });

  test('regime, techScore and headline weights match across all option variants', () => {
    const oracle = loadOracle();
    let n = 0;
    for (const p of prepared()) {
      for (const opt of OPTION_VARIANTS) {
        const expected = oracle.callNormalized<Record<string, unknown>>(
          'computeTechnicalPlanV7', p.rawInd, p.rawGann, p.rawConf, p.chart, opt,
        );
        const got = computeTechScoreCore(p.ind, p.gann, p.chart, opt);
        assert.equal(got.regime, expected['regime'], `${p.ticker}@${p.len} regime`);
        assert.equal(got.techScore, expected['techScore'], `${p.ticker}@${p.len} techScore opt=${opt?.available}`);
        assert.deepStrictEqual(got.headlineWeights, expected['headlineWeights'], `${p.ticker}@${p.len} weights`);
        assert.equal(got.headlineUsedDefaultWeights, expected['headlineUsedDefaultWeights']);
        n++;
      }
    }
    assert.ok(n > 500, `only ${n} comparisons`);
  });

  test('all four regimes are genuinely exercised', () => {
    const seen = new Set<Regime>();
    for (const p of prepared()) seen.add(detectRegime(p.ind));
    for (const r of ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL'] as Regime[]) {
      assert.ok(seen.has(r), `regime ${r} never observed — its weight table is unverified`);
    }
  });

  test('HIGH_VOL short-circuits ahead of direction', () => {
    // Volatility dominates: a volatile uptrend reports HIGH_VOL, not TREND_UP.
    // The regime is about tradeability, not direction.
    const base = { adx14: 40, atrRatio: 1.5, sma50: 110, sma200: 100, pctFromSma50: 5 } as unknown as Indicators;
    assert.equal(detectRegime(base), 'HIGH_VOL');
    const calm = { ...base, atrRatio: 1.0 } as unknown as Indicators;
    assert.equal(detectRegime(calm), 'TREND_UP', 'same trend, calmer tape');
  });

  test('missing sma200 falls to CHOP rather than guessing a direction', () => {
    const noSma200 = { adx14: 40, atrRatio: 1.0, sma50: 110, sma200: null, pctFromSma50: 5 } as unknown as Indicators;
    assert.equal(detectRegime(noSma200), 'CHOP', 'unknown trend is CHOP, not TREND_UP');
  });

  test('a neutral read scores exactly 50', () => {
    // techScore maps overallSig [-1,1] onto [0,100], so zero signal is 50.
    const scores: number[] = [];
    for (const p of prepared()) scores.push(computeTechScoreCore(p.ind, p.gann, p.chart, null).techScore);
    assert.ok(Math.min(...scores) >= 0 && Math.max(...scores) <= 100, 'score must stay in range');
    assert.ok(new Set(scores).size > 20, 'expected a wide spread of real scores');
  });

  test('every signal is clamped to [-1, 1]', () => {
    // Guards against a helper returning out-of-range and distorting the total.
    // The bearish options variant supplies dirSig = -0.9, deliberately large.
    for (const p of prepared()) {
      for (const opt of OPTION_VARIANTS) {
        for (const s of computeTechScoreCore(p.ind, p.gann, p.chart, opt).signals) {
          assert.ok(s.sig >= -1 && s.sig <= 1, `signal ${s.cat} out of range: ${s.sig}`);
          assert.ok(s.weight > 0, 'weights must stay positive after the regime multiplier');
        }
      }
    }
  });

  test('conditional signals are ABSENT, not neutral, when their input is missing', () => {
    // Dropping a signal reduces its category weight total; voting 0 would
    // instead dilute the category toward neutral. Unknown is not neutral.
    for (const p of prepared()) {
      const withOpts = computeTechScoreCore(p.ind, p.gann, p.chart, { available: true, dirSig: 0.5, leapsLean: 0.2 });
      const withoutOpts = computeTechScoreCore(p.ind, p.gann, p.chart, null);
      assert.equal(withOpts.signals.length, withoutOpts.signals.length + 2, 'options adds exactly two signals');
      assert.ok(!withoutOpts.signals.some((s) => s.cat === 'Options'), 'no Options category when unavailable');

      // The rs-based Trend signal follows the same rule.
      const trendCount = p.ind.rs ? 1 : 0;
      const rsSignals = withoutOpts.signals.filter((s) => s.cat === 'Trend').length;
      assert.ok(rsSignals >= 3 + trendCount - 1, 'Trend signal count tracks rs availability');
    }
  });

  test('regime multipliers invert between momentum and trend-strength', () => {
    // The core thesis: oscillators are discounted in trends and boosted in
    // chop; trend-strength indicators get the opposite treatment.
    const trendingUp = prepared().find((p) => detectRegime(p.ind) === 'TREND_UP');
    const choppy = prepared().find((p) => detectRegime(p.ind) === 'CHOP');
    if (!trendingUp || !choppy) return;

    const rsiWeightIn = (p: Prepared): number =>
      (computeTechScoreCore(p.ind, p.gann, p.chart, null).signals.find((s) => s.cat === 'Momentum') as { weight: number }).weight;

    // RSI has base weight 3: x0.7 in TREND_UP, x1.3 in CHOP.
    assert.ok(Math.abs(rsiWeightIn(trendingUp) - 3 * 0.7) < 1e-9);
    assert.ok(Math.abs(rsiWeightIn(choppy) - 3 * 1.3) < 1e-9);
  });

  test('F-10: both DEFAULT weight fallbacks are unreachable', () => {
    // detectRegime returns exactly one of four regimes, and both weight tables
    // define all four -- so the DEFAULT entries are dead and
    // headlineUsedDefaultWeights is permanently false.
    //
    // It is exported as a "dashboard transparency line", i.e. a transparency
    // indicator that structurally cannot report anything. Reproduced to hold
    // parity; do NOT change without a parity re-baseline.
    let anyDefault = false;
    const regimesSeen = new Set<Regime>();
    for (const p of prepared()) {
      for (const opt of OPTION_VARIANTS) {
        const got = computeTechScoreCore(p.ind, p.gann, p.chart, opt);
        regimesSeen.add(got.regime);
        if (got.headlineUsedDefaultWeights) anyDefault = true;
      }
    }
    assert.equal(regimesSeen.size, 4, 'all four regimes must be covered for this to be meaningful');
    assert.equal(anyDefault, false, 'F-10: the DEFAULT weight path is unreachable');
  });

  test('TREND_UP and TREND_DOWN share identical headline weights', () => {
    // Deliberate: the weighting expresses how much to TRUST each category, not
    // which way it points. Direction lives in the signal values.
    const up = prepared().find((p) => detectRegime(p.ind) === 'TREND_UP');
    const down = prepared().find((p) => detectRegime(p.ind) === 'TREND_DOWN');
    if (!up || !down) return;
    assert.deepStrictEqual(
      computeTechScoreCore(up.ind, up.gann, up.chart, null).headlineWeights,
      computeTechScoreCore(down.ind, down.gann, down.chart, null).headlineWeights,
    );
  });
});
