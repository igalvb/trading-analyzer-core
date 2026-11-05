/**
 * FL-7a-2: computeTechnicalPlan against the oracle's computeTechnicalPlanV7,
 * the whole object, on every fixture at several lengths, with and without
 * a SPY benchmark, across four options reads. The port's side is end to
 * end (its own indicators, Gann and confluence from the chart).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Chart } from '../src/types/chart.ts';
import { computeIndicators } from '../src/analysis/indicators/index.ts';
import { computeGann } from '../src/analysis/gann.ts';
import { computeConfluenceTargets } from '../src/analysis/confluence.ts';
import { computeTechnicalPlan, type PlanOptions } from '../src/analysis/techPlan/plan.ts';

const ready = legacyFilesPresent() && fixturesPresent();

const OPTION_VARIANTS: Array<PlanOptions | null> = [
  null,
  { available: false },
  { available: true, dirSig: 0.7, leapsLean: 0.4, ivRank: 22 },
  { available: true, dirSig: -0.9, leapsLean: -0.6, ivRank: 81 },
];

describe('FL-7a-2 — computeTechnicalPlan', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the whole plan object equals computeTechnicalPlanV7, key for key', () => {
    const oracle = loadOracle();
    let spy: ReturnType<typeof loadRawFixture> | null = null;
    try { spy = loadRawFixture('SPY'); } catch { spy = null; }
    let compared = 0, crashedBoth = 0;
    const regimes = new Set<string>();
    for (const ticker of listFixtures()) {
      const raw = loadRawFixture(ticker);
      if (!Array.isArray(raw.closes) || raw.closes.length < 60) continue;
      for (const len of [60, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        for (const withBench of [false, true]) {
          if (withBench && (!spy || spy.closes.length < len)) continue;
          const chart = buildChart(raw, len) as ReturnType<typeof buildChart> & { benchmarkCloses?: number[] };
          if (withBench && spy) chart.benchmarkCloses = spy.closes.slice(0, len);
          for (const opt of OPTION_VARIANTS) {
            let expected: unknown, legacyError: unknown = null;
            try {
              const ind = oracle.call('computeAllIndicators', chart);
              const gann = oracle.call('computeGannInline', chart, ind);
              const conf = oracle.call('computeConfluenceTargets', ind, gann, null, chart);
              expected = oracle.callNormalized('computeTechnicalPlanV7', ind, gann, conf, chart, opt);
            } catch (e) { legacyError = e; }
            const run = () => {
              const ind = computeIndicators(chart as unknown as Chart);
              const gann = computeGann(chart as unknown as Chart);
              const conf = computeConfluenceTargets(ind, gann, null, chart as unknown as Chart);
              return computeTechnicalPlan(ind, gann, conf, chart, opt);
            };
            if (legacyError) {
              assert.throws(run, (e: Error) => e.message === (legacyError as Error).message, `${ticker}@${len} throws like legacy`);
              crashedBoth++;
              continue;
            }
            const got = structuredClone(run());
            assert.deepStrictEqual(got, expected, `${ticker}@${len} bench=${withBench} opt=${JSON.stringify(opt)}`);
            assert.deepStrictEqual(Object.keys(got), Object.keys(expected as object), `${ticker}@${len} key order`);
            regimes.add(got.regime);
            compared++;
          }
        }
      }
    }
    assert.ok(compared >= 300, `only ${compared} plans compared (${crashedBoth} crashed on both sides)`);
    assert.ok(regimes.size >= 3, `only regimes ${[...regimes].join(',')}`);
  });
});
