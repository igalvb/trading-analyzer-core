/**
 * Differential verification of the Turtle model.
 *
 * ══ THE ONLY MODEL FILE WITH REAL ARITHMETIC ═══════════════════════════
 * The other models relabel what the engine already computed, so they
 * cannot diverge numerically. turtleSimulate replays the dual-channel
 * system bar by bar and produces its own entries, adds, stops, exits and
 * trade history -- so this is the one model file where a genuine numeric
 * divergence is possible, and the simulator is tested on its own before
 * the report that wraps it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  turtleSimulate, turtleRollHigh, turtleRollLow, turtleShadowS1Outcome,
  turtleCorrelatedCaps, turtleSizing, turtleWhipsaw, turtleExclusions,
  turtleDisciplineNote, turtleDateStr, buildTurtleReport, formatTurtleReport,
  TURTLE_MAX_UNITS, TURTLE_S2_WINDOW, TURTLE_CLOSELY_CORRELATED_CAP,
  TURTLE_LOOSELY_CORRELATED_CAP, TURTLE_TOTAL_DIRECTION_CAP,
  type TurtleIndicators, type TurtleTechPlan, type TurtleRsCache, type CapHolding,
} from '../src/analysis/models/turtle.ts';

const ready = legacyFilesPresent() && fixturesPresent();

const RSR_CASES: (TurtleRsCache | null)[] = [
  null,
  { categories: ['AI'], rank: 1, peerCount: 10, percentile: 99, read: 'STRONG — top decile' },
  { categories: ['BIO'], rank: 9, peerCount: 10, percentile: 5, read: 'WEAK — bottom decile' },
  // MIDDLE must contribute to neither synthesis list.
  { categories: ['ETF'], rank: 5, peerCount: 10, percentile: 50, read: 'MIDDLE' },
];

/** 55 is exactly the window; 56 is the first length that can simulate. */
const LENGTHS = [55, 56, 60, 120, 250, 400];

describe('Turtle model — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the walk-forward simulator matches the oracle bar for bar', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let unavailable = 0;
    let inPosition = 0;
    let flat = 0;
    let maxUnits = 0;
    let enteredToday = 0;
    let addedToday = 0;
    let exitedToday = 0;
    let s1Skipped = 0;
    let trades = 0;
    let wins = 0;
    let losses = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [...LENGTHS, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const expected = oracle.callNormalized('turtleSimulateV1_', chart);
        const got = turtleSimulate(chart);
        assert.deepStrictEqual(got, expected, `${ticker}@${len} simulate`);
        comparisons++;

        if (!got.available) {
          unavailable++;
          continue;
        }
        if (got.live.inPosition) {
          inPosition++;
          maxUnits = Math.max(maxUnits, got.live.units);
          if (got.live.enteredToday) enteredToday++;
          if (got.live.addedToday) addedToday++;
        } else {
          flat++;
          if (got.live.s1Skipped) s1Skipped++;
        }
        if (got.exitedToday) exitedToday++;
        trades += got.trail.length;
        wins += got.wins;
        losses += got.losses;
      }
    }

    assert.ok(comparisons > 100, `only ${comparisons} simulations`);
    // Every live state reachable, so `live` is not degenerate.
    assert.ok(unavailable > 0, 'the insufficient-history path never fired');
    assert.ok(inPosition > 0 && flat > 0, 'only one position state occurred');
    assert.equal(maxUnits, TURTLE_MAX_UNITS, 'the 4-Unit pyramid cap was never reached');
    assert.ok(enteredToday > 0 && addedToday > 0 && exitedToday > 0,
      'one of the today-flags never fired');
    // s1Skipped firing means the shadow-simulation path actually ran -- the
    // whipsaw filter would be untested otherwise.
    assert.ok(s1Skipped > 0, 'the S1 skip filter never engaged, so the shadow sim is untested');
    assert.ok(trades > 1000, `only ${trades} simulated trades`);
    // Both outcome kinds. Note these count how a trade ENDED, not P&L.
    assert.ok(wins > 0 && losses > 0, 'only one outcome kind occurred');
  });

  test('the 55-bar boundary is exact: 55 bars cannot simulate, 56 can', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture('NVDA');
    assert.equal(TURTLE_S2_WINDOW, 55);
    const at55 = turtleSimulate(buildChart(raw, 55));
    const at56 = turtleSimulate(buildChart(raw, 56));
    assert.equal(at55.available, false);
    assert.equal(at56.available, true);
    // And the refusal wording is the oracle's, not invented.
    assert.deepStrictEqual(at55, oracle.callNormalized('turtleSimulateV1_', buildChart(raw, 55)));
    assert.match((at55 as { note: string }).note, /at least 56 bars/);
  });

  test('the rolling channel is exclusive of the current bar, and null before the window fills', () => {
    const oracle = loadOracle();
    const cases: Array<[number[], number, number]> = [
      [[1, 2, 3, 4, 5], 3, 2],
      [[1, 2, 3], 0, 1],
      [[5, 1, 9], 3, 3],
      [[], 0, 1],
      [[1, 2, 3], 2, 5],
    ];
    for (const [arr, i, w] of cases) {
      assert.equal(turtleRollHigh(arr, i, w), oracle.call('turtleRollHighV1_', arr, i, w),
        `rollHigh ${JSON.stringify(arr)} i=${i} w=${w}`);
      assert.equal(turtleRollLow(arr, i, w), oracle.call('turtleRollLowV1_', arr, i, w),
        `rollLow ${JSON.stringify(arr)} i=${i} w=${w}`);
    }
    // Exclusivity, stated as an assertion: the window is [i-w, i), so a
    // breakout at i must clear bars BEFORE i, never its own high.
    assert.equal(turtleRollHigh([1, 2, 3, 99], 3, 3), 3, 'the current bar must be excluded');
    // Null, not a partial window, before enough history exists.
    assert.equal(turtleRollHigh([1, 2, 3], 2, 5), null);
  });

  test('the strict comparison matters: a flat series neither exits nor breaks out', () => {
    // The source documents finding this with its own test. Under a
    // non-strict `<=`/`>=` a perfectly flat series trivially ties its own
    // rolling window every single day, so it would "exit" daily and
    // "break out" daily. Pinned so a revert fails here.
    const flat = Array.from({ length: 120 }, () => 50);
    const chart = {
      highs: flat, lows: flat, closes: flat,
      dates: flat.map((_, i) => new Date(Date.UTC(2024, 0, 1 + i))),
    };
    const sim = turtleSimulate(chart);
    assert.equal(sim.available, true);
    assert.ok(sim.available);
    assert.equal(sim.trail.length, 0, 'a flat series must produce no trades');
    assert.equal(sim.live.inPosition, false, 'a flat series must never enter');
    // And the shadow outcome is unresolved rather than defaulted.
    assert.equal(turtleShadowS1Outcome(flat, flat, flat, 10, 50, 1), null);
    assert.deepStrictEqual(
      sim, loadOracle().callNormalized('turtleSimulateV1_', chart),
    );
  });

  test('the full report and formatted text match, across every RS state', () => {
    const oracle = loadOracle();
    const withRs = oracle.fns.setStatusV7.constructor(
      'b', 'r', 'var x=Object.assign({},b); x.relativeStrengthRanking=r; return x;',
    ) as (b: unknown, r: unknown) => unknown;

    let comparisons = 0;
    const netReads = new Set<string>();
    let whipsawAvailable = 0;
    let whipsawUnavailable = 0;
    let duplicateNote = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [60, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const rawInd = oracle.call('computeAllIndicators', chart);
        const gann = oracle.call('computeGannInline', chart, rawInd);
        const conf = oracle.call('computeConfluenceTargets', rawInd, gann, null, chart);
        let plan;
        try {
          plan = oracle.call('computeTechnicalPlanV7', rawInd, gann, conf, chart, null);
        } catch {
          continue; // F-14
        }
        for (const rsr of RSR_CASES) {
          const indOracle = withRs(rawInd, rsr);
          const indPort = Object.assign(structuredClone(rawInd) as object,
            { relativeStrengthRanking: rsr }) as TurtleIndicators;

          // Oracle gets SEVEN parameters; the port gets five.
          const expected: Record<string, unknown> | null =
            oracle.callNormalized<Record<string, unknown> | null>(
              'buildTurtleReportV1', ticker, indOracle, gann, conf, plan, chart, null,
            );
          const got = buildTurtleReport(
            ticker, indPort, structuredClone(plan) as TurtleTechPlan, chart,
          );
          const where = `${ticker}@${len} rs=${rsr?.read.slice(0, 6) ?? 'none'}`;
          assert.deepStrictEqual(got as unknown, expected, where);
          comparisons++;

          assert.ok(got);
          netReads.add(got.synthesis.netRead);
          got.whipsaw.available ? whipsawAvailable++ : whipsawUnavailable++;

          const expectedText: string = oracle.call<string>('formatTurtleReportV1', expected);
          assert.equal(formatTurtleReport(got), expectedText, `${where} formatted`);
          comparisons++;

          const lines = expectedText.split('\n');
          const i = lines.findIndex((l) => l.startsWith('4. RELATIVE'));
          if (lines[i + 1] === lines[i + 2]) duplicateNote++;
        }
      }
    }

    assert.ok(comparisons > 300, `only ${comparisons} comparisons`);
    assert.equal(netReads.size, 3, [...netReads].join(' | '));
    assert.ok(whipsawAvailable > 0 && whipsawUnavailable > 0, 'only one whipsaw branch exercised');
    // F-18, second occurrence: the duplicate tracks the unavailable RS path.
    assert.ok(duplicateNote > 0, 'the F-18 duplicate no longer reproduces in section 4');
  });

  test('F-18 (second occurrence) and the dead `|| \'\'` in section 4', () => {
    // Unavailable RS -> the note is pushed by the else AND by the
    // unconditional push, so it appears twice on consecutive lines.
    const ind = {} as TurtleIndicators;
    const report = buildTurtleReport('T', ind, {}, {});
    assert.ok(report);
    assert.equal(report.relativeStrength.available, false);
    const lines = formatTurtleReport(report).split('\n');
    const i = lines.findIndex((l) => l.startsWith('4. RELATIVE'));
    assert.equal(lines[i + 1], lines[i + 2], 'the RS note should appear twice');
    assert.match(lines[i + 1], /Relative Strength Ranking unavailable/);

    // The `|| ''` is DEAD because `+` binds tighter than `||`: the left
    // operand always carries two leading spaces and is always truthy.
    // Demonstrated directly rather than argued.
    const note = undefined as unknown as string;
    assert.equal(('  ' + note) || '', '  undefined');
    assert.equal('  ' + (note || ''), '  ');
  });

  test('sizing and whipsaw degrade with no tech plan, matching the oracle', () => {
    const oracle = loadOracle();
    const raw = loadRawFixture('NVDA');
    const chart = buildChart(raw, 400);
    const sim = turtleSimulate(chart);
    const rawSim = oracle.call('turtleSimulateV1_', chart);
    // The unavailable sizing branch never occurs on real fixtures (every
    // one has an nNormalizedPositionSize), so it is forced here.
    for (const tp of [{}, { nNormalizedPositionSize: null }]) {
      assert.deepStrictEqual(
        turtleSizing(tp as TurtleTechPlan, sim),
        oracle.callNormalized('turtleSizingV1_', tp, rawSim),
        JSON.stringify(tp),
      );
      assert.deepStrictEqual(
        turtleWhipsaw(sim, tp as TurtleTechPlan),
        oracle.callNormalized('turtleWhipsawV1_', rawSim, tp),
        JSON.stringify(tp),
      );
    }
    assert.equal(turtleSizing({}, sim).available, false);
    // With no position there is nothing to compute a whipsaw stop for.
    const flatSim = turtleSimulate(buildChart(raw, 55));
    assert.equal(turtleWhipsaw(flatSim, {}).available, false);
  });

  test('correlated caps match, and use the LOOSE tier deliberately', () => {
    const oracle = loadOracle();
    const cases: (CapHolding[] | null)[] = [
      null,
      [],
      // Null units -> reported with a note, excluded from totals.
      [{ ticker: 'A', categories: ['X'], units: null }],
      [{ ticker: 'A', categories: ['X', 'Y'], units: 5 },
        { ticker: 'B', categories: ['X'], units: 7 }],
      // 13 > 10 -> category flagged; 13 > 12 -> total flagged.
      [{ ticker: 'A', categories: ['X'], units: 13 }],
      // No categories at all: counts toward the total, no category rows.
      [{ ticker: 'A', units: 4 }, { ticker: 'B', units: 5 }, { ticker: 'C', units: 4 }],
    ];
    for (const h of cases) {
      assert.deepStrictEqual(
        turtleCorrelatedCaps(h),
        oracle.callNormalized('turtleCorrelatedCapsV1_', h),
        JSON.stringify(h),
      );
    }
    // The 6-Unit "closely correlated" cap is defined and NOT applied --
    // documented as deliberate, unlike F-12's silently-dead maxHeatPct.
    assert.equal(TURTLE_CLOSELY_CORRELATED_CAP, 6);
    assert.equal(TURTLE_LOOSELY_CORRELATED_CAP, 10);
    assert.equal(TURTLE_TOTAL_DIRECTION_CAP, 12);
    const seven = turtleCorrelatedCaps([{ ticker: 'A', categories: ['X'], units: 7 }]);
    assert.equal(seven.categoryFlags[0].flagged, false,
      '7 units exceeds the 6-Unit close tier but not the 10-Unit loose tier');
    const eleven = turtleCorrelatedCaps([{ ticker: 'A', categories: ['X'], units: 11 }]);
    assert.equal(eleven.categoryFlags[0].flagged, true);
    // Total cap is separate from the per-category cap.
    const spread = turtleCorrelatedCaps([
      { ticker: 'A', categories: ['X'], units: 7 }, { ticker: 'B', categories: ['Y'], units: 7 },
    ]);
    assert.equal(spread.totalFlagged, true, '14 > 12 total');
    assert.ok(spread.categoryFlags.every((c) => !c.flagged), 'neither category exceeds 10');
  });

  test('F-20: the exclusions list claims the correlated caps are unbuilt, but they ship', () => {
    const oracle = loadOracle();
    assert.deepStrictEqual(turtleExclusions(), oracle.callNormalized('turtleExclusionsV1_'));
    const caps = turtleExclusions().find((e) => e.item.includes('4-tier correlated-market'));
    assert.ok(caps, 'the correlated-caps exclusion entry is missing');
    // The stale claim, pinned verbatim.
    assert.match(caps.reason, /deferred to Deliverable 2/);
    assert.match(caps.reason, /not decided here/);
    // Yet the implementation exists and produces real output. Its only
    // caller is fullStockAnalysisV10_9.gs:903 (the portfolio advisory), NOT
    // this report -- verified by grep across all ten legacy files.
    const real = turtleCorrelatedCaps([{ ticker: 'A', categories: ['X'], units: 13 }]);
    assert.equal(real.categoryFlags.length, 1);
    assert.equal(real.totalFlagged, true);
    assert.ok(oracle.has('turtleCorrelatedCapsV1_'));
    // Reproduced, not corrected -- user-visible report text.
  });

  test('static sections and the date helper are verbatim', () => {
    const oracle = loadOracle();
    assert.deepStrictEqual(turtleDisciplineNote(),
      oracle.callNormalized('turtleDisciplineNoteV1_'));
    assert.equal(turtleExclusions().length, 4);
    assert.match(turtleDisciplineNote().attribution, /Richard Dennis/);
    const dates = [new Date(Date.UTC(2025, 0, 2)), new Date(Date.UTC(2025, 5, 30))];
    for (const [d, i] of [[dates, 0], [dates, 1], [dates, 9], [null, 0], [undefined, 0]] as const) {
      assert.equal(turtleDateStr(d as Date[] | null, i),
        oracle.call('turtleDateStrV1_', d, i), `dateStr idx=${i}`);
    }
    assert.equal(turtleDateStr(dates, 0), '2025-01-02');
    assert.equal(turtleDateStr(dates, 9), 'n/a', 'out of range must be n/a, not a crash');
    assert.equal(formatTurtleReport(null), oracle.call('formatTurtleReportV1', null));
  });
});
