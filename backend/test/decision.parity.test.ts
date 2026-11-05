/**
 * Differential verification of the decision engine against the oracle.
 *
 * This is the last link in the chain: every indicator, pattern, confluence
 * level and tech-plan field exists to feed this function. If this matches,
 * the port produces the same verdicts as the legacy system.
 *
 * ══ WHAT MAKES THIS TEST NON-VACUOUS ══════════════════════════════════
 * Two of the engine's adjustments could pass a naive parity test while
 * never actually running:
 *
 *  1. THE MACRO MODIFIER. Legacy reads it from the sheet inside the decision
 *     function; in the sandbox that always yields {available:false}, so both
 *     sides would agree by both skipping it. Fixed by injecting the oracle's
 *     own `_macroRegimeCache` global (a `var` at :3088, read by an
 *     unconditional early return at :3128) across four macro states, and by
 *     asserting the MEASURED conviction deltas are exactly +2 / -4 / 0.
 *
 *  2. THE R:R GATE. Only 2 of 48 real fixture plans have rrToT1 < 1.0, and
 *     none sit near the interesting part of the squared curve. Fixed with
 *     synthetic plans whose rrToT1 straddles every branch boundary, plus an
 *     assertion that the resulting curve is monotone and hits its documented
 *     endpoints (no reduction at 1.0, the full 40% at 0 and below).
 *
 * The same trap, unaddressed, is what let the wyckoffSchematic and
 * event-field bugs survive earlier rounds.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { StatusAccumulator, StepState } from '../src/core/status.ts';
import type { ExitTarget } from '../src/analysis/techPlan/entryPlan.ts';
import {
  synthesizeDecision, computePositionSize, fundBandOf, ACCOUNT,
  type DecisionTechPlan, type DecisionFundResult, type DecisionOptions,
} from '../src/analysis/decision.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** The 8 fields synthesizeDecisionV7 returns. convNotes is port-only. */
const FIELDS = [
  'headline', 'action', 'lines', 'fundBand', 'timing',
  'finalConviction', 'dataWarnings', 'optionsConfirm',
] as const;

/**
 * Fundamental scores chosen to land on every boundary, not merely inside
 * every band: 57 and 56 straddle own/mixed, 43 and 42 straddle mixed/weak,
 * 21 and 20 straddle the block floor (which is `<=`, so 20 IS blocked).
 */
const FUND: DecisionFundResult[] = [
  { score: null, verdict: 'n/a' },
  { score: 95, verdict: 'Exceptional' },
  { score: 70, verdict: 'Strong' },
  { score: 57, verdict: 'Good' },
  { score: 56, verdict: 'Mixed' },
  { score: 50, verdict: 'Mixed' },
  { score: 43, verdict: 'Mixed' },
  { score: 42, verdict: 'Weak' },
  { score: 30, verdict: 'Weak' },
  { score: 21, verdict: 'Weak' },
  { score: 20, verdict: 'Very weak' },
  { score: 0, verdict: 'Very weak' },
  { score: 42, verdict: 'Weak', dataWarning: 'fundamentals from stale cache' },
  { score: null, verdict: 'n/a', dataWarning: 'no fundamentals' },
];

/** leapsLean values straddle both +/-0.5 thresholds. */
const OPT: (DecisionOptions | null)[] = [
  null,
  { available: false, confirm: 'neutral', notes: [] },
  { available: true, confirm: 'confirm', leapsLean: 0.6, notes: ['calls bid', 'skew flat'] },
  { available: true, confirm: 'confirm', leapsLean: 0.2, notes: ['calls bid'] },
  { available: true, confirm: 'conflict', leapsLean: -0.7, notes: ['puts bid'] },
  { available: true, confirm: 'neutral', leapsLean: 0, notes: [] },
];

interface MacroState { available: boolean; regime?: string }
/** `null` means "do not inject" -- exercises the real unavailable path. */
const MACRO: (MacroState | null)[] = [
  null,
  { available: false },
  { available: true, regime: 'RISK_ON' },
  { available: true, regime: 'RISK_OFF' },
  { available: true, regime: 'NEUTRAL' },
];

const MACRO_KEY = '_macroRegimeCache';

interface Prep { ticker: string; len: number; raw: unknown; port: DecisionTechPlan }

const prep: Prep[] = [];

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
    if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
    // Two lengths per ticker: a fixed 250 and the full series, so plans
    // differ in regime and timing rather than being 33 variations of one.
    for (const len of [250, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      const chart = buildChart(raw, len);
      let plan: Record<string, unknown>;
      try {
        const ind = oracle.call('computeAllIndicators', chart);
        const gann = oracle.call('computeGannInline', chart, ind);
        const conf = oracle.call('computeConfluenceTargets', ind, gann, null, chart);
        plan = oracle.call('computeTechnicalPlanV7', ind, gann, conf, chart, null);
      } catch {
        continue;
      }
      if (!plan || plan.timing == null) continue;
      // The oracle's own tech plan is the input to BOTH sides, so this test
      // isolates the decision logic from tech-plan parity (covered by
      // techScore.parity.test.ts and entryPlan.parity.test.ts).
      prep.push({ ticker, len, raw: plan, port: structuredClone(plan) as unknown as DecisionTechPlan });
    }
  }
});

/** Resets the injected cache so later tests see the natural path. */
function clearMacro(): void {
  loadOracle().setGlobal(MACRO_KEY, null);
}

describe('decision engine — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('all 8 returned fields match the oracle across every input combination', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    const bands = new Set<string>();
    const timings = new Set<string>();
    let blocked = 0;
    let sizeShown = 0;
    let sizeOmitted = 0;

    try {
      for (const p of prep) {
        timings.add(String(p.port.timing));
        for (const f of FUND) {
          for (const op of OPT) {
            for (const mc of MACRO) {
              oracle.setGlobal(MACRO_KEY, mc);
              // When nothing is injected, hand the port the oracle's real
              // return value so both sides see byte-identical macro input.
              const macroRead = mc === null
                ? oracle.callNormalized<MacroState>('getCachedMacroRegime_')
                : mc;

              const legacyStatus = oracle.call<Record<string, { state: string }>>('newDataStatusV7');
              const expected = oracle.callNormalized<Record<string, unknown>>(
                'synthesizeDecisionV7', f, p.raw, op, legacyStatus,
              );

              const acc = new StatusAccumulator();
              const got = synthesizeDecision(f, p.port, op, macroRead, acc) as unknown as Record<string, unknown>;

              const where = `${p.ticker}@${p.len} fund=${f.score} opt=${op?.confirm ?? 'none'} macro=${mc?.regime ?? String(mc?.available)}`;
              for (const k of FIELDS) {
                assert.deepStrictEqual(got[k], expected[k], `${where} ${k}`);
                comparisons++;
              }

              // The status write happens on a different mechanism (see
              // core/status.ts) but must fire under the same condition and
              // reach the same state. 'pending' is the legacy no-write value.
              const legacyState = structuredClone(legacyStatus).macroRegime.state;
              const entry = acc.get('macroRegime');
              assert.equal(entry ? entry.state : StepState.PENDING, legacyState, `${where} macroRegime state`);
              comparisons++;

              bands.add(String(expected.fundBand));
              if (/BLOCKED/.test(String(expected.action))) blocked++;
              const lines = expected.lines as string[];
              lines.some((l) => l.startsWith('Size: ')) ? sizeShown++ : sizeOmitted++;
            }
          }
        }
      }
    } finally {
      clearMacro();
    }

    // Coverage assertions, so a future refactor that quietly stops
    // exercising a branch fails here rather than passing hollowly.
    assert.ok(prep.length >= 20, `only ${prep.length} tech plans`);
    assert.ok(comparisons > 100_000, `only ${comparisons} comparisons`);
    assert.deepStrictEqual([...bands].sort(), ['mixed', 'own', 'unknown', 'weak']);
    assert.deepStrictEqual([...timings].sort(), ['AVOID', 'BUY_NOW', 'WAIT_PULLBACK']);
    assert.ok(blocked > 0, 'the fundamentals-block path never fired');
    assert.ok(sizeShown > 0 && sizeOmitted > 0, 'only one Size-line branch was exercised');
  });

  test('the macro modifier moves conviction by exactly +2 / -4 / 0', () => {
    const oracle = loadOracle();
    const plan = syntheticPlan({ techScore: 60 });
    const fund: DecisionFundResult = { score: 80, verdict: 'Strong' };
    const conv: Record<string, number> = {};
    try {
      for (const mc of [
        { available: false },
        { available: true, regime: 'RISK_ON' },
        { available: true, regime: 'RISK_OFF' },
        { available: true, regime: 'NEUTRAL' },
      ]) {
        oracle.setGlobal(MACRO_KEY, mc);
        const legacyStatus = oracle.call('newDataStatusV7');
        const viaOracle = oracle.callNormalized<{ finalConviction: number }>(
          'synthesizeDecisionV7', fund, plan, null, legacyStatus,
        ).finalConviction;
        const viaPort = synthesizeDecision(fund, plan, null, mc).finalConviction;
        assert.equal(viaPort, viaOracle, `macro ${mc.regime ?? 'unavailable'}`);
        conv[mc.available ? String(mc.regime) : 'unavailable'] = viaPort;
      }
    } finally {
      clearMacro();
    }
    // techScore 60 is deliberately mid-range: no clamp at either end can
    // mask the adjustment.
    assert.equal(conv.RISK_ON - conv.unavailable, 2, JSON.stringify(conv));
    assert.equal(conv.RISK_OFF - conv.unavailable, -4, JSON.stringify(conv));
    assert.equal(conv.NEUTRAL, conv.unavailable, JSON.stringify(conv));
  });

  test('the R:R gate follows the documented squared curve', () => {
    const fund: DecisionFundResult = { score: 80, verdict: 'Strong' };
    const at = (rr: number): number =>
      synthesizeDecision(fund, syntheticPlan({ techScore: 100, rrToT1: rr }), null, { available: false })
        .finalConviction;

    // Endpoints are arithmetic, not observed-and-blessed:
    //   rr=1.0   -> frac 0,    reduction 0      -> 100
    //   rr=0.5   -> frac 0.5,  0.25 * 0.40 = 10% -> 90
    //   rr<=0    -> frac 1,    full 40%          -> 60
    assert.equal(at(3.0), 100);
    assert.equal(at(1.0), 100);
    assert.equal(at(0.5), 90);
    assert.equal(at(0), 60);
    assert.equal(at(-2), 60, 'an inverted target must clamp, not overshoot');
    assert.ok(at(0.999) >= at(0.75) && at(0.75) > at(0.5) && at(0.5) > at(0.25),
      'the curve must be monotone decreasing');
    // A flat penalty would make these two equal. The whole point of the
    // squared curve is that they are not.
    assert.notEqual(at(0.99), at(0.1));
  });

  test('every branch boundary matches on synthetic plans', () => {
    const oracle = loadOracle();
    const variants: DecisionTechPlan[] = [
      ...[null, 3.0, 1.5, 1.49, 1.0, 0.999, 0.75, 0.5, 0.01, 0, -0.5, -2]
        .map((rr) => syntheticPlan({ rrToT1: rr as number | null })),
      syntheticPlan({ timing: 'WAIT_PULLBACK' }),
      syntheticPlan({ timing: 'AVOID' }),
      syntheticPlan({ timeToEntry: null }),
      syntheticPlan({ t1: null, t1Time: null }),
      syntheticPlan({ t2: null, t2Time: null }),
      syntheticPlan({ t1: target(110, 1) }),
      syntheticPlan({ t1: target(110, 4) }),
      syntheticPlan({ secular: null }),
      syntheticPlan({ rrToT2: null }),
      syntheticPlan({ dataWarning: 'RS unavailable' }),
      syntheticPlan({ techScore: 0 }),
      syntheticPlan({ techScore: 100 }),
      syntheticPlan({ techScore: 97 }),
      // stop above entry -> perShareRisk <= 0 -> no Size line
      syntheticPlan({ stop: 105 }),
      // one share costs more than the whole account -> no Size line
      syntheticPlan({ entryPrice: 50_000, entryLow: 49_000, entryHigh: 51_000, stop: 40_000 }),
      // affordable shares exceed the account -> cash-account cap path
      syntheticPlan({ entryPrice: 300, entryLow: 295, entryHigh: 305, stop: 299 }),
    ];

    let comparisons = 0;
    let gateFired = 0;
    let thinNote = 0;
    try {
      for (const plan of variants) {
        for (const f of FUND) {
          for (const op of OPT) {
            for (const mc of MACRO) {
              oracle.setGlobal(MACRO_KEY, mc);
              const macroRead = mc === null
                ? oracle.callNormalized<MacroState>('getCachedMacroRegime_')
                : mc;
              const legacyStatus = oracle.call<Record<string, { state: string }>>('newDataStatusV7');
              const expected = oracle.callNormalized<Record<string, unknown>>(
                'synthesizeDecisionV7', f, plan, op, legacyStatus,
              );
              const acc = new StatusAccumulator();
              const got = synthesizeDecision(f, plan, op, macroRead, acc) as unknown as Record<string, unknown>;
              const where = `rr=${plan.rrToT1} tech=${plan.techScore} entry=${plan.entryPrice} fund=${f.score}`;
              for (const k of FIELDS) {
                assert.deepStrictEqual(got[k], expected[k], `${where} ${k}`);
                comparisons++;
              }
              const entry = acc.get('macroRegime');
              assert.equal(entry ? entry.state : StepState.PENDING,
                structuredClone(legacyStatus).macroRegime.state, `${where} macroRegime state`);
              comparisons++;
              const joined = (expected.lines as string[]).join('');
              if (joined.includes('R:R gate')) gateFired++;
              if (joined.includes('R:R note')) thinNote++;
            }
          }
        }
      }
    } finally {
      clearMacro();
    }
    assert.ok(comparisons > 15_000, `only ${comparisons} comparisons`);
    assert.ok(gateFired > 0, 'the R:R gate never fired');
    assert.ok(thinNote > 0, 'the thin-R:R note never fired');
  });

  test('convNotes is exactly what the rendered Final Conviction line embeds', () => {
    const oracle = loadOracle();
    let checked = 0;
    try {
      oracle.setGlobal(MACRO_KEY, { available: true, regime: 'RISK_OFF' });
      for (const f of FUND) {
        for (const op of OPT) {
          const d = synthesizeDecision(f, syntheticPlan({ rrToT1: 0.8 }), op,
            { available: true, regime: 'RISK_OFF' });
          const line = d.lines.find((l) => l.startsWith('Final Conviction: '));
          const rebuilt = `Final Conviction: ${d.finalConviction}/100`
            + (d.convNotes.length ? `   [${d.convNotes.join(', ')}]` : '');
          assert.equal(line, rebuilt, `fund=${f.score} opt=${op?.confirm ?? 'none'}`);
          assert.ok(d.convNotes.length > 0, 'the trace should never be empty here');
          checked++;
        }
      }
    } finally {
      clearMacro();
    }
    assert.ok(checked >= 80, `only ${checked} traces checked`);
  });

  test('computePositionSize matches the oracle, including every null path', () => {
    const oracle = loadOracle();
    let cases = 0;
    let nulls = 0;
    let sized = 0;
    for (const entry of [100, 300, 50_000, 0.5, NaN, Infinity, 10]) {
      for (const stop of [95, 99.99, 100, 105, NaN, 0, -5]) {
        for (const conv of [0, 1, 50, 99, 100, 150, -20]) {
          const got = computePositionSize(entry, stop, conv);
          assert.deepStrictEqual(
            got,
            oracle.callNormalized('computePositionSizeV7_', entry, stop, conv),
            `entry=${entry} stop=${stop} conv=${conv}`,
          );
          got === null ? nulls++ : sized++;
          cases++;
        }
      }
    }
    assert.equal(cases, 343);
    assert.ok(nulls > 0 && sized > 0, 'only one outcome branch was exercised');
    // convScale is the documented 0.5..1.0 ramp, asserted directly.
    assert.equal(computePositionSize(100, 95, 0)?.convScale, 0.5);
    assert.equal(computePositionSize(100, 95, 100)?.convScale, 1.0);
    assert.equal(computePositionSize(100, 95, 150)?.convScale, 1.0, 'conviction must clamp at 100');
    assert.equal(computePositionSize(100, 95, -20)?.convScale, 0.5, 'conviction must clamp at 0');
  });

  test('ACCOUNT carries the legacy CONFIG_V7.account values', () => {
    assert.equal(ACCOUNT.size, 10_000);
    assert.equal(ACCOUNT.riskPct, 1);
  });

  test('fundBandOf lands on the 57 and 43 boundaries', () => {
    const expected: [number | null, string][] = [
      [null, 'unknown'], [100, 'own'], [57, 'own'], [56, 'mixed'],
      [43, 'mixed'], [42, 'weak'], [0, 'weak'],
    ];
    for (const [score, band] of expected) assert.equal(fundBandOf(score), band, `score ${score}`);
  });
});

/**
 * A fully-shaped ExitTarget.
 *
 * low/high/basis/count are required by ExitTarget but are never read by the
 * decision engine -- only `price` and `promotionHops` are. Filled in with
 * plausible values rather than cast away, so a future field the engine DOES
 * read cannot slip in as undefined.
 */
function target(price: number, promotionHops?: number): ExitTarget {
  return {
    price, low: price - 1, high: price + 1, basis: ['synthetic'], count: 1,
    ...(promotionHops == null ? {} : { promoted: true, promotionHops }),
  };
}

/**
 * A tech plan with every field the decision engine reads, overridable.
 *
 * Defaults are chosen so the BASE case triggers nothing: rrToT1 2.0 clears
 * both R:R branches, techScore 70 clamps at neither end, and the stop sits
 * below entry so sizing succeeds. Any note that appears in a variant is
 * therefore attributable to that variant's override alone.
 */
function syntheticPlan(over: Partial<DecisionTechPlan> = {}): DecisionTechPlan {
  return {
    timing: 'BUY_NOW',
    techScore: 70,
    entryPrice: 100, entryLow: 98, entryHigh: 102, entryConfidencePct: 65,
    timeToEntry: { humanText: '3 days' },
    t1: target(110), t1Time: { humanText: '2 weeks' },
    t2: target(120), t2Time: { humanText: '6 weeks' },
    stop: 95, rrToT1: 2.0, rrToT2: 4.0,
    stopAtSpot: 95, rrToT1AtSpot: 2.0, rrToT2AtSpot: 4.0,
    secular: { verdict: 'YES', why: 'durable' },
    ...over,
  } as DecisionTechPlan;
}
