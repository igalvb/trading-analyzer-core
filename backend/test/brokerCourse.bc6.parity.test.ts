/**
 * Broker Course BC-6 parity: Phase 12 -- the comparison report (model 5
 * of 5).
 *
 * ══ ALL REAL OUTPUT, NO SYNTHETIC REPORTS ═════════════════════════════
 * The engine side is the oracle's own chain on real charts (indicators ->
 * gann -> confluence -> tech plan -> decision), driven by five fund scores
 * (the decision engine reads only score/verdict/dataWarning) including one
 * below the block floor. The Schabacker, Edwards & Magee and Turtle reports
 * are the oracle's own; the broker report is the BC-5 port's own. Every
 * one of the 16 model-presence combinations is compared, both the
 * structure and the formatted text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { buildBrokerCourseReportV1, type BrokerCourseReport } from '../src/analysis/models/brokerCourse/report.ts';
import {
  buildComparisonReportV1, formatComparisonReportV1,
  type ComparisonReport, type ComparisonTechPlan, type ComparisonDecision, type ModelReportLike,
} from '../src/analysis/models/brokerCourse/comparison.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Reads a top-level `const`/`var` from the oracle's realm. */
function oracleConst<T>(name: string): T {
  const F = loadOracle().fns.setStatusV7.constructor as new (body: string) => () => unknown;
  return structuredClone(new F('return ' + name + ';')()) as T;
}

/** Synthetic fund results: the decision engine reads only score/verdict/dataWarning. */
const FUNDS = [
  { score: 80, verdict: 'OWN', dataWarning: null },
  { score: 50, verdict: 'MIXED', dataWarning: null },
  { score: 30, verdict: 'WEAK', dataWarning: null },
  { score: 10, verdict: 'AVOID', dataWarning: null }, // below the block floor: a BLOCKED action
  { score: null, verdict: 'N/A', dataWarning: null },
];

interface RealRun {
  ticker: string;
  len: number;
  techPlan: ComparisonTechPlan;
  raw: { sch: ModelReportLike; em: ModelReportLike; tu: ModelReportLike };
  broker: BrokerCourseReport;
}

/** The real engine chain and the three real model reports, built in the oracle, per chart. */
function realRuns(): RealRun[] {
  const oracle = loadOracle();
  const out: RealRun[] = [];
  for (const ticker of listFixtures()) {
    if (ticker === '_VIX') continue;
    const raw = loadRawFixture(ticker);
    for (const len of [300, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      const chart = buildChart(raw, len);
      const ind = oracle.call('computeAllIndicators', chart);
      const gann = oracle.call('computeGannInline', chart, ind);
      const confluence = oracle.call('computeConfluenceTargets', ind, gann, null, chart);
      let techPlan: ComparisonTechPlan;
      try {
        techPlan = oracle.call<ComparisonTechPlan>('computeTechnicalPlanV7', ind, gann, confluence, chart, null);
      } catch {
        continue; // F-14: legacy's own tech plan can crash on a null pivot bar
      }
      const args = [ticker, ind, gann, confluence, techPlan, chart, undefined];
      out.push({
        ticker, len, techPlan,
        raw: {
          sch: oracle.call<ModelReportLike>('buildSchabackerReportV1', ...args),
          em: oracle.call<ModelReportLike>('buildEdwardsMageeReportV1', ...args),
          tu: oracle.call<ModelReportLike>('buildTurtleReportV1', ...args),
        },
        broker: buildBrokerCourseReportV1(ticker, {
          chart, fund: { marketCap: 2e12 }, vixLevel: 30, sharesOutstandingHistory: null, filingKeywordHits: null,
          holdings13F: null, earningsHistory: null, brokerDataCache: null, macroSnapshot: null,
          spdrHoldings: null, qqqHoldings: null, now: new Date(),
        })!,
      });
    }
  }
  return out;
}

describe('Broker Course P12 — comparison report', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every presence combination matches the oracle, on real engine and real model output', () => {
    const oracle = loadOracle();
    const version = oracleConst<{ version: string }>('CONFIG_V7').version;
    const verdicts = new Set<string>();
    const twoWay = new Set<string>();
    const same = new Set<boolean | null>();
    const existing = new Set<string>();
    const noConsensus = new Set<string>();
    let comparisons = 0;
    let multiDissent = 0;
    let splitAtTwo = 0;
    for (const run of realRuns()) {
      for (const fund of FUNDS) {
        const decision = oracle.call<ComparisonDecision>('synthesizeDecisionV7', fund, run.techPlan, null);
        for (let mask = 0; mask < 16; mask++) {
          // Production shape: the broker report is an object or null, never
          // undefined (undefined would make legacy rebuild it from scratch).
          const nm = mask & 1 ? run.broker : null;
          const s = mask & 2 ? run.raw.sch : undefined;
          const e = mask & 4 ? run.raw.em : undefined;
          const t = mask & 8 ? run.raw.tu : undefined;
          const raw = oracle.call<ComparisonReport | null>('buildComparisonReportV1',
            run.ticker, undefined, run.techPlan, decision, fund, nm, s, e, t);
          // Oracle-realm reports must be re-homed before the port touches
          // them, or its `.concat` returns VM-realm arrays (see normalize.ts).
          const got = buildComparisonReportV1(run.ticker, {
            techPlan: run.techPlan, fundScore: fund, decision, newModelReport: nm,
            schabackerReport: s && structuredClone(s), edwardsMageeReport: e && structuredClone(e),
            turtleReport: t && structuredClone(t),
          });
          const expected = raw === null ? null : structuredClone(raw);
          assert.deepStrictEqual(got, expected, `${run.ticker}@${run.len} fund=${fund.score} mask=${mask}`);
          assert.equal(formatComparisonReportV1(got, version), oracle.call('formatComparisonReportV1', raw),
            `${run.ticker}@${run.len} fund=${fund.score} mask=${mask} text`);
          comparisons += 2;
          if (!expected) continue;
          existing.add(expected.existingDirection);
          same.add(expected.sameReasoning);
          if (expected.verdict) {
            const voices = [1, nm, s, e, t].filter(Boolean).length;
            verdicts.add(expected.verdict);
            if (expected.dissentingModel && expected.dissentingModel.includes(',')) multiDissent++;
            if (expected.verdict === 'SPLIT' && voices === 2) splitAtTwo++;
            if (expected.verdict === 'NO_CONSENSUS') {
              const counts: Record<string, number> = {};
              for (const d of [expected.existingDirection, expected.newDirection, expected.schabackerDirection,
                expected.edwardsMageeDirection, expected.turtleDirection]) {
                if (d != null) counts[d] = (counts[d] || 0) + 1;
              }
              noConsensus.add(Object.values(counts).sort().reverse().join('-') + '@' + voices);
            }
          } else {
            twoWay.add(expected.agree ? 'AGREE' : 'CONFLICT');
          }
        }
      }
    }
    assert.ok(comparisons > 7000, `only ${comparisons} comparisons`);
    assert.deepStrictEqual([...verdicts].sort(), ['ALL_AGREE', 'MAJORITY', 'NO_CONSENSUS', 'SPLIT']);
    assert.deepStrictEqual([...twoWay].sort(), ['AGREE', 'CONFLICT']);
    assert.deepStrictEqual([...existing].sort(), ['bullish', 'cautionary', 'mixed']);
    assert.ok(same.has(true) && same.has(false) && same.has(null));
    // The v1.3 fix (:2496-2509): a MAJORITY names EVERY dissenter.
    assert.ok(multiDissent > 0, 'no multi-dissenter MAJORITY reached');
    // With only three directions, NO_CONSENSUS is "every voice differs"
    // only at 3 voices; at 4 it is always 2-1-1 and at 5 always 2-2-1 --
    // and the 2-2-1 case is two clean pairs, which at 4 voices reads SPLIT.
    assert.deepStrictEqual([...noConsensus].sort(), ['1-1-1@3', '2-1-1@4', '2-2-1@5']);
    assert.ok(splitAtTwo > 0, 'F-29 needs SPLIT at two voices');
  });

  test('no report at all refuses with the legacy log line', () => {
    const oracle = loadOracle();
    const run = realRuns()[0];
    const decision = oracle.call<ComparisonDecision>('synthesizeDecisionV7', FUNDS[0], run.techPlan, null);
    const portLog: string[] = [];
    const oracleLog: string[] = [];
    assert.equal(buildComparisonReportV1('ZZZ', {
      techPlan: run.techPlan, fundScore: FUNDS[0], decision, newModelReport: null,
    }, (m) => portLog.push(m)), null);
    // A null broker report (not undefined) is not rebuilt -- legacy goes
    // straight to the "nothing to compare" refusal.
    assert.equal(oracle.call('buildComparisonReportV1', 'ZZZ', (m: string) => oracleLog.push(m),
      run.techPlan, decision, FUNDS[0], null, undefined, undefined, undefined), null);
    assert.deepStrictEqual(portLog, oracleLog);
    assert.deepStrictEqual(portLog, ['Comparison: no model report available at all for ZZZ']);
    assert.equal(formatComparisonReportV1(null), oracle.call('formatComparisonReportV1', null));
  });

  test('F-29: a two-voice disagreement is printed as "SPLIT (2 vs 2, no real majority)"', () => {
    const oracle = loadOracle();
    const version = oracleConst<{ version: string }>('CONFIG_V7').version;
    let shown: string | null = null;
    for (const run of realRuns()) {
      const decision = oracle.call<ComparisonDecision>('synthesizeDecisionV7', FUNDS[0], run.techPlan, null);
      // Broker report unavailable, Schabacker present: exactly two voices,
      // the configuration legacy's own v9.92 fix (:2315-2323) supports.
      const raw = oracle.call<ComparisonReport>('buildComparisonReportV1',
        run.ticker, undefined, run.techPlan, decision, FUNDS[0], null, run.raw.sch, undefined, undefined);
      if (raw.verdict !== 'SPLIT') continue;
      const got = buildComparisonReportV1(run.ticker, {
        techPlan: run.techPlan, fundScore: FUNDS[0], decision, newModelReport: null,
        schabackerReport: structuredClone(run.raw.sch),
      })!;
      assert.deepStrictEqual(got, structuredClone(raw));
      shown = formatComparisonReportV1(got, version);
      assert.equal(shown, oracle.call('formatComparisonReportV1', raw));
      break;
    }
    assert.ok(shown, 'no two-voice SPLIT found on real data');
    const bottom = shown!.split('\n').find((l) => l.startsWith('BOTTOM LINE:'))!;
    // Two voices listed, one each way -- under a label claiming 2 vs 2.
    assert.match(bottom, /^BOTTOM LINE: SPLIT \(2 vs 2, no real majority\) \(existing engine: \w+, Schabacker model: \w+\)$/);
  });

  test('the engine label reads the version when given, and falls back without it', () => {
    const run = realRuns()[0];
    const oracle = loadOracle();
    const decision = oracle.call<ComparisonDecision>('synthesizeDecisionV7', FUNDS[1], run.techPlan, null);
    const c = buildComparisonReportV1(run.ticker, { techPlan: run.techPlan, fundScore: FUNDS[1], decision, newModelReport: run.broker })!;
    assert.match(formatComparisonReportV1(c, 'v10.9'), /\nEXISTING ENGINE \(main engine v10\.9\): /);
    assert.match(formatComparisonReportV1(c), /\nEXISTING ENGINE \(main engine\): /);
    assert.match(formatComparisonReportV1(c, ''), /\nEXISTING ENGINE \(main engine\): /);
  });
});
