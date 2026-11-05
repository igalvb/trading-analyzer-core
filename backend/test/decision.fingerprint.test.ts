/**
 * THE END-TO-END GATE.
 *
 * This is the project's headline verification number. Every other parity test
 * fed the ORACLE's intermediate objects into one ported stage, which isolates
 * that stage but never proves the stages COMPOSE. Here nothing comes from the
 * oracle on the port's side: the chart goes into computeIndicators, and the
 * verdict comes out the far end of the port's own chain.
 *
 *   port:   chart -> computeIndicators -> computeGann -> confluence
 *                 -> computeTechScoreCore -> computeEntryPlan
 *                 -> synthesizeDecision
 *   oracle: chart -> computeAllIndicators -> computeGannInline
 *                 -> computeConfluenceTargets -> computeTechnicalPlanV7
 *                 -> synthesizeDecisionV7
 *
 * ══ WHY A SIX-FIELD FINGERPRINT AND NOT THE WHOLE REPORT ═══════════════
 * Tiers C and D of computeTechnicalPlanV7 are not ported (display-only: 8
 * additive stop/sizing/channel helpers, the drivers array, and the secular
 * read). The legacy source annotates each Tier C helper "purely additive ...
 * does not affect stop/rrToT1/rrToT2", and nothing in Tier D feeds the
 * verdict. The fingerprint is the six fields that decide what the user is
 * told to DO.
 *
 * But "the comments say it does not matter" is not evidence, so the second
 * test here goes further: with ONLY the oracle's Tier-D `secular` object
 * injected, the port reproduces the oracle's headline and every rendered
 * line, character for character. That turns the claim into a measurement --
 * the single missing secular line is demonstrably the ONLY difference Tiers
 * C and D make to the decision output.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Chart } from '../src/types/chart.ts';
import { computeIndicators } from '../src/analysis/indicators/index.ts';
import { analyzeTicker, fingerprintOf, type DecisionFingerprint } from '../src/analysis/pipeline.ts';
import { synthesizeDecision, type DecisionFundResult, type MacroRead } from '../src/analysis/decision.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Legacy's own fetchYahooChart rejects anything shorter. */
const MIN_BARS = 60;

/** Spans all four fundBands including the blocked floor. */
const FUND: DecisionFundResult[] = [
  { score: null, verdict: 'n/a' },
  { score: 72, verdict: 'Strong' },
  { score: 50, verdict: 'Mixed' },
  { score: 38, verdict: 'Weak' },
  { score: 12, verdict: 'Very weak' },
];

const MACRO: MacroRead[] = [
  { available: false },
  { available: true, regime: 'RISK_ON' },
  { available: true, regime: 'RISK_OFF' },
];

const MACRO_KEY = '_macroRegimeCache';

interface OraclePlan {
  timing: string | null;
  regime: string;
  secular: unknown;
}

interface Case {
  ticker: string;
  chart: Chart;
  oraclePlan: OraclePlan;
}

const cases: Case[] = [];
/** Tickers the ORACLE itself cannot finish. See F-14. */
const oracleCrashed: string[] = [];

before(() => {
  if (!ready) return;
  const oracle = loadOracle();
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    if (!Array.isArray(raw.closes) || raw.closes.length < MIN_BARS) continue;
    const chart = buildChart(raw, raw.closes.length);
    const ind = oracle.call('computeAllIndicators', chart);
    const gann = oracle.call('computeGannInline', chart, ind);
    const conf = oracle.call('computeConfluenceTargets', ind, gann, null, chart);
    let plan: OraclePlan;
    try {
      plan = oracle.call<OraclePlan>('computeTechnicalPlanV7', ind, gann, conf, chart, null);
    } catch {
      oracleCrashed.push(ticker);
      continue;
    }
    if (!plan || plan.timing == null) continue;
    cases.push({ ticker, chart, oraclePlan: plan });
  }
});

describe('END-TO-END decision fingerprint', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the port reproduces the oracle verdict from the raw chart, on every fixture', () => {
    const oracle = loadOracle();
    let compared = 0;
    const regimes = new Set<string>();
    const actions = new Set<string>();
    const convictions = new Set<number>();
    const bands = new Set<string>();
    const timings = new Set<string>();

    try {
      for (const c of cases) {
        // Re-assert the indicator layer here too: if this drifts, the
        // fingerprint failure below would be misleading about its cause.
        assert.deepStrictEqual(
          computeIndicators(c.chart) as unknown as Record<string, unknown>,
          oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', c.chart),
          `${c.ticker} indicator layer`,
        );

        for (const fund of FUND) {
          for (const macro of MACRO) {
            oracle.setGlobal(MACRO_KEY, macro);
            const expectedDecision = oracle.callNormalized<{
              finalConviction: number; action: string; fundBand: string; timing: string;
            }>('synthesizeDecisionV7', fund, c.oraclePlan, null, oracle.call('newDataStatusV7'));

            const expected: DecisionFingerprint = {
              ticker: c.ticker,
              finalConviction: expectedDecision.finalConviction,
              action: expectedDecision.action,
              fundBand: expectedDecision.fundBand,
              timing: expectedDecision.timing,
              regime: c.oraclePlan.regime,
            };

            const actual = fingerprintOf(analyzeTicker(c.chart, fund, null, macro));
            assert.deepStrictEqual(
              actual, expected,
              `${c.ticker} fund=${fund.score} macro=${macro.regime ?? 'unavailable'}`,
            );

            compared++;
            regimes.add(expected.regime);
            actions.add(expected.action);
            convictions.add(expected.finalConviction);
            bands.add(expected.fundBand);
            timings.add(expected.timing);
          }
        }
      }
    } finally {
      loadOracle().setGlobal(MACRO_KEY, null);
    }

    // Coverage, so this cannot pass hollowly on a shrunken fixture set.
    assert.ok(cases.length >= 24, `only ${cases.length} tickers`);
    assert.ok(compared >= 360, `only ${compared} fingerprints compared`);
    assert.ok(regimes.size >= 3, `only ${regimes.size} distinct regimes: ${[...regimes].join(',')}`);
    assert.ok(actions.size >= 15, `only ${actions.size} distinct actions`);
    assert.ok(convictions.size >= 30, `only ${convictions.size} distinct convictions`);
    assert.deepStrictEqual([...bands].sort(), ['mixed', 'own', 'unknown', 'weak']);
    assert.ok(timings.size >= 2, `only ${timings.size} distinct timings`);
  });

  test('with Tier D secular injected, every rendered line matches too', () => {
    const oracle = loadOracle();
    let compared = 0;
    try {
      for (const c of cases) {
        const technical = analyzeTicker(c.chart, FUND[1] as DecisionFundResult, null, MACRO[0] as MacroRead).technical;
        for (const fund of FUND) {
          for (const macro of MACRO) {
            oracle.setGlobal(MACRO_KEY, macro);
            const expected = oracle.callNormalized<{ headline: string; lines: string[] }>(
              'synthesizeDecisionV7', fund, c.oraclePlan, null, oracle.call('newDataStatusV7'),
            );
            // The ONLY thing taken from the oracle is the Tier-D secular
            // read. Everything else -- entry, targets, stop, R:R, sizing,
            // conviction -- is the port's own, computed from the chart.
            const withSecular = {
              ...technical.techPlan,
              secular: structuredClone(c.oraclePlan.secular) as { verdict: string; why: string } | null,
            };
            const got = synthesizeDecision(fund, withSecular, null, macro);
            assert.equal(got.headline, expected.headline, `${c.ticker} fund=${fund.score} headline`);
            assert.deepStrictEqual(got.lines, expected.lines, `${c.ticker} fund=${fund.score} lines`);
            compared++;
          }
        }
      }
    } finally {
      loadOracle().setGlobal(MACRO_KEY, null);
    }
    assert.ok(compared >= 360, `only ${compared} full renders compared`);
  });

  test('F-14: the oracle crashes on a chart with null bars; the port does not', () => {
    // Reproduced, not fixed. computeGannInline builds its pivot from
    // lows[i] without checking for a null bar (:8089 and the :8105
    // fallback), so pivot.price can be null -- and computeTechnicalPlanV7
    // :3007 then calls gann.pivot.price.toFixed(2) unguarded, killing the
    // ENTIRE tech plan and with it the ticker.
    //
    // The :8105 fallback's own comment documents fixing exactly this class
    // of bug one line down (pivot.date was undefined and crashed
    // toLocaleDateString) -- but it clamped the INDEX and never validated
    // the VALUE, so the same defect survived immediately next door.
    //
    // Trigger is a data-quality condition, not a VIX quirk: any provider gap
    // that yields a null bar at the chosen pivot does it. _VIX is simply the
    // fixture that has 182 of them.
    assert.deepStrictEqual(oracleCrashed, ['_VIX'],
      'the set of tickers the oracle cannot finish changed');

    const oracle = loadOracle();
    const raw = loadRawFixture('_VIX');
    const chart = buildChart(raw, raw.closes.length);
    const ind = oracle.call('computeAllIndicators', chart);
    const gann = oracle.call<{ pivot: { price: number | null } }>('computeGannInline', chart, ind);
    assert.equal(gann.pivot.price, null, 'the pivot price is expected to be null here');

    const conf = oracle.call('computeConfluenceTargets', ind, gann, null, chart);
    assert.throws(
      () => oracle.call('computeTechnicalPlanV7', ind, gann, conf, chart, null),
      /toFixed/,
      'the oracle is expected to throw on this chart',
    );

    // The port gets all the way to a verdict on the same chart. Not because
    // it guards pivot.price -- it never reads it -- but because the crash
    // lives in Tier D, which is display-only and therefore absent.
    const result = analyzeTicker(chart, FUND[1] as DecisionFundResult, null, MACRO[0] as MacroRead);
    assert.ok(result.decision.finalConviction >= 0);
    assert.ok(result.decision.action.length > 0);
    assert.ok(['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL'].includes(result.regime));
  });
});
