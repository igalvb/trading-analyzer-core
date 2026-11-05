/**
 * Differential verification of the Schabacker model report.
 *
 * ══ TWO INPUTS NEED INJECTING ══════════════════════════════════════════
 *  - `chart.relativeSwingPower` is an optional attach, absent in an
 *    isolated run, so the Study XII swing-power read would otherwise only
 *    ever be tested on its null branch.
 *  - `techPlan.classicalStop` is non-null on essentially every real
 *    fixture, so the unavailable branch -- and with it F-18 -- is
 *    unreachable without forcing it.
 * Both are injected on BOTH sides: the oracle gets a copy built inside its
 * own realm, the port a structural clone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import type { Indicators } from '../src/types/indicators.ts';
import {
  buildSchabackerReport, formatSchabackerReport,
  schabackerExclusions, schabackerTradingTactics, schabackerGapRead,
  schabackerPatternRead, schabackerClassicalStop,
  SCHABACKER_PATTERN_TAXONOMY, SCHABACKER_GAP_RELIABILITY,
  type ModelChart, type SchabackerTechPlan,
} from '../src/analysis/models/schabacker.ts';

const ready = legacyFilesPresent() && fixturesPresent();

const RSP_CASES = [
  null,
  { ratio: 1.35, etf: 'SMH', sector: 'Semis' },
  { ratio: 0.72, etf: 'XLV', sector: 'Health' },
  // Exactly 1.0 sits on the >= boundary: must render "0% wider than".
  { ratio: 1.0, etf: 'SPY', sector: 'Broad' },
];

describe('Schabacker model — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the report and its formatted text match the oracle, with both optional inputs injected', () => {
    const oracle = loadOracle();
    const withRsp = oracle.fns.setStatusV7.constructor(
      'c', 'r', 'var x=Object.assign({},c); x.relativeSwingPower=r; return x;',
    ) as (c: unknown, r: unknown) => unknown;
    const withStop = oracle.fns.setStatusV7.constructor(
      'p', 's', 'var x=Object.assign({},p); x.classicalStop=s; return x;',
    ) as (p: unknown, s: unknown) => unknown;

    let comparisons = 0;
    const netReads = new Set<string>();
    const priceFits = new Set<string>();
    const patternGroups = new Set<string>();
    const gapTypes = new Set<string>();
    let stopAvailable = 0;
    let stopUnavailable = 0;
    let duplicateNoteSeen = 0;
    let rspRendered = 0;

    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 60) continue;
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

        for (const rsp of RSP_CASES) {
          for (const stripStop of [false, true]) {
            const chartOracle = withRsp(chart, rsp);
            // Annotated: inferring through the later callNormalized is
            // circular (TS7022).
            const planOracle: unknown = stripStop ? withStop(plan, null) : plan;
            const chartPort = Object.assign(structuredClone(chart) as object,
              { relativeSwingPower: rsp }) as ModelChart;
            const planPort = (stripStop
              ? Object.assign(structuredClone(plan) as object, { classicalStop: null })
              : structuredClone(plan)) as SchabackerTechPlan;
            const indPort = structuredClone(rawInd) as Indicators;

            // Oracle gets all SEVEN parameters; the port gets five.
            const expected: Record<string, unknown> | null =
              oracle.callNormalized<Record<string, unknown> | null>(
                'buildSchabackerReportV1', ticker, rawInd, gann, conf, planOracle, chartOracle, null,
              );
            const got = buildSchabackerReport(ticker, indPort, planPort, chartPort);
            const where = `${ticker}@${len} rsp=${rsp?.ratio ?? 'none'} stripStop=${stripStop}`;
            assert.deepStrictEqual(got as unknown, expected, where);
            comparisons++;

            assert.ok(got, 'the report should never be null on valid inputs');
            netReads.add(got.synthesis.netRead);
            priceFits.add(got.tradingTactics.priceLevelFit.split('—')[0].trim());
            got.patternRead.patterns.forEach((p) => patternGroups.add(p.group));
            got.gapRead.gaps.forEach((g) => gapTypes.add(g.gapType));
            got.classicalStop.available ? stopAvailable++ : stopUnavailable++;
            if (got.tradingTactics.relativeSwingPower) rspRendered++;

            const expectedText: string = oracle.call<string>('formatSchabackerReportV1', expected);
            assert.equal(formatSchabackerReport(got), expectedText, `${where} formatted`);
            comparisons++;

            const textLines = expectedText.split('\n');
            const i = textLines.findIndex((l) => l.startsWith('6. CLASSICAL'));
            if (textLines[i + 1] === textLines[i + 2]) duplicateNoteSeen++;
          }
        }
      }
    }

    assert.ok(comparisons > 1000, `only ${comparisons} comparisons`);
    assert.equal(netReads.size, 3, [...netReads].join(' | '));
    // All FOUR price bands, including the $10-$15 band that only the final
    // `else` reaches -- the one a branch reorder would silently lose.
    assert.equal(priceFits.size, 4, [...priceFits].join(' | '));
    assert.deepStrictEqual([...patternGroups].sort(),
      ['context-dependent', 'continuation', 'not-covered', 'reversal']);
    assert.deepStrictEqual([...gapTypes].sort(),
      ['BREAKAWAY', 'COMMON', 'EXHAUSTION', 'ISLAND', 'RUNAWAY']);
    assert.ok(stopAvailable > 0 && stopUnavailable > 0, 'only one classicalStop branch exercised');
    assert.ok(rspRendered > 0, 'the injected relativeSwingPower never rendered');
    // F-18: the duplicate appears on EVERY unavailable case and no other.
    assert.equal(duplicateNoteSeen, stopUnavailable,
      'the F-18 duplicate no longer tracks the unavailable branch exactly');
  });

  test('F-18: the unavailable classical-stop note is printed twice, verbatim', () => {
    // Confirmed by execution, reproduced deliberately. Section 6 pushes the
    // note in its `else` and then pushes it again unconditionally.
    const report = buildSchabackerReport(
      'T',
      { chartPatterns: [], priceGaps: [], srLevels: null, roundNumber: null,
        halfwayRetracementRead: null, trendAlignedVolume: null,
        volumeProgressDivergence: null, weeklyTrend: null, roc10: null,
        mom5: null, last: 42 } as unknown as Indicators,
      { regime: 'CHOP', techScore: 50, drivers: [], classicalStop: null },
      { currentPrice: 42 },
    );
    assert.ok(report);
    assert.equal(report.classicalStop.available, false);
    const lines = formatSchabackerReport(report).split('\n');
    const i = lines.findIndex((l) => l.startsWith('6. CLASSICAL'));
    assert.equal(lines[i + 1], lines[i + 2], 'the note should appear on two consecutive lines');
    assert.match(lines[i + 1], /Classical stop unavailable/);
    // And exactly twice in the whole report, not three times.
    const count = lines.filter((l) => l.includes('Classical stop unavailable')).length;
    assert.equal(count, 2);

    // The available path prints it ONCE -- the unconditional push is the
    // intended line there, which is why only one branch doubles.
    const ok = buildSchabackerReport(
      'T',
      { chartPatterns: [], priceGaps: [], srLevels: null, roundNumber: null,
        halfwayRetracementRead: null, trendAlignedVolume: null,
        volumeProgressDivergence: null, weeklyTrend: null, roc10: null,
        mom5: null, last: 42 } as unknown as Indicators,
      {
        regime: 'CHOP', techScore: 50, drivers: [],
        classicalStop: {
          level: 40, basingPointDate: new Date(Date.UTC(2025, 0, 2)),
          basingPointPrice: 42, direction: 'long',
        },
      },
      { currentPrice: 42 },
    );
    assert.ok(ok);
    const okLines = formatSchabackerReport(ok).split('\n');
    assert.equal(okLines.filter((l) => l.includes('Study X — real swing basing point')).length, 1);
  });

  test('F-19: gann and confluence are dead parameters, transitively', () => {
    // Measured on the body with comments and string contents stripped:
    // `gann` 0 uses; `confluence` 1 use, which is the hand-off to
    // schabackerSRTrendLineReadV1_, which itself uses it 0 times.
    //
    // Proven by feeding the oracle garbage in both slots: the report must
    // be byte-identical. The port takes five parameters, not seven.
    const oracle = loadOracle();
    const raw = loadRawFixture(listFixtures()[0]);
    const chart = buildChart(raw, raw.closes.length);
    const rawInd = oracle.call('computeAllIndicators', chart);
    const gann = oracle.call('computeGannInline', chart, rawInd);
    const conf = oracle.call('computeConfluenceTargets', rawInd, gann, null, chart);
    const plan = { regime: 'CHOP', techScore: 1, drivers: [], classicalStop: null };

    const withReal = oracle.callNormalized(
      'buildSchabackerReportV1', 'T', rawInd, gann, conf, plan, chart, null,
    );
    const withGarbage = oracle.callNormalized(
      'buildSchabackerReportV1', 'T', rawInd, 'garbage', 42, plan, chart, null,
    );
    assert.deepStrictEqual(withGarbage, withReal,
      'gann/confluence are supposed to be unused -- they are not');
  });

  test('the price-level bands are checked in an order that preserves the $10-$15 gap', () => {
    const ind = { last: null } as unknown as Indicators;
    const fit = (price: number | null): string =>
      schabackerTradingTactics({ currentPrice: price }, ind).priceLevelFit;
    assert.match(fit(5), /^CAUTIONED/);
    assert.match(fit(9.99), /^CAUTIONED/);
    // The band the final `else` catches: not cautioned, not ideal.
    assert.match(fit(10), /above its \$10 caution line/);
    assert.match(fit(14.99), /above its \$10 caution line/);
    assert.match(fit(15), /^IDEAL/);
    assert.match(fit(60), /^IDEAL/);
    assert.match(fit(60.01), /^Above the book/);
    // No price at all -> 'n/a', not a guess.
    assert.equal(fit(null), 'n/a');
    // Falls back to ind.last when the chart has no currentPrice.
    assert.match(
      schabackerTradingTactics({ currentPrice: null }, { last: 20 } as unknown as Indicators).priceLevelFit,
      /^IDEAL/,
    );
  });

  test('the taxonomy and gap tables are verbatim and complete', () => {
    const oracle = loadOracle();
    // Whole-table comparison, not a sample: a dropped entry or reworded
    // citation is a real content change in a report the user reads.
    // Both tables are top-level `const`, so they are NOT properties of the
    // sandbox global and oracle.getGlobal cannot see them. They ARE visible
    // to a function compiled in the oracle's realm, because a script's
    // top-level lexical declarations persist in that realm's global lexical
    // environment -- verified by probe, not assumed.
    const readConst = oracle.fns.setStatusV7.constructor as
      new (body: string) => () => unknown;
    const grab = (name: string): Record<string, unknown> =>
      structuredClone(new readConst('return ' + name + ';')()) as Record<string, unknown>;
    const taxonomy = grab('SCHABACKER_PATTERN_TAXONOMY_V1_');
    assert.deepStrictEqual(
      Object.keys(SCHABACKER_PATTERN_TAXONOMY).sort(),
      Object.keys(taxonomy).sort(),
    );
    assert.deepStrictEqual(SCHABACKER_PATTERN_TAXONOMY, taxonomy);
    assert.equal(Object.keys(SCHABACKER_PATTERN_TAXONOMY).length, 27);
    const gapTable = grab('SCHABACKER_GAP_RELIABILITY_V1_');
    assert.deepStrictEqual(SCHABACKER_GAP_RELIABILITY, gapTable);
    assert.equal(Object.keys(SCHABACKER_GAP_RELIABILITY).length, 5);
    assert.deepStrictEqual(schabackerExclusions(),
      oracle.callNormalized('schabackerExclusionsV1_'));
    assert.equal(schabackerExclusions().length, 7);
  });

  test('pattern labelling uses strict confirmed===true, and gaps keep non-ISLAND validity null', () => {
    const oracle = loadOracle();
    // Five distinct pattern output shapes coexist in chartPatterns.ts; only
    // ones carrying a literal `confirmed: true` count as confirmed here.
    const patterns = [
      { type: 'DOUBLE_BOTTOM', confirmed: true },
      { type: 'DOUBLE_TOP', confirmed: false },
      // `status`-shaped, no `confirmed` field -> unconfirmed, so it can
      // never reach the synthesis.
      { type: 'RECTANGLE', status: 'confirmed' },
      { type: 'STAIRCASE', confirmed: true },
      { type: 'TOTALLY_UNKNOWN', confirmed: true },
    ];
    assert.deepStrictEqual(
      schabackerPatternRead(patterns),
      oracle.callNormalized('schabackerPatternReadV1_', patterns),
    );
    const read = schabackerPatternRead(patterns);
    assert.equal(read.patterns.find((p) => p.type === 'RECTANGLE')?.confirmed, false);
    assert.equal(read.patterns.find((p) => p.type === 'TOTALLY_UNKNOWN')?.group, 'not-covered');
    assert.equal(read.confirmedContinuations.length, 0, 'status-shaped patterns must not count');

    const gaps = [
      { type: 'UP', level: 10, gapType: 'EXHAUSTION', gapTypeHindsightDependent: true },
      { type: 'DOWN', level: 9, gapType: 'ISLAND', meetsStrictValidity: false },
      { type: 'UP', level: 8, gapType: 'ISLAND', meetsStrictValidity: true },
      { type: 'UP', level: 7, gapType: 'MYSTERY' },
      { type: 'UP', level: 6 },
    ];
    for (const lookback of [undefined, 0, 1, 3, 100]) {
      assert.deepStrictEqual(
        schabackerGapRead(gaps, lookback),
        oracle.callNormalized('schabackerGapReadV1_', gaps, lookback),
        `lookback=${lookback}`,
      );
    }
    const gr = schabackerGapRead(gaps);
    // "Not applicable" and "failed the test" are different claims.
    assert.equal(gr.gaps.find((g) => g.gapType === 'EXHAUSTION')?.meetsStrictValidity, null);
    assert.equal(gr.gaps.find((g) => g.gapType === 'MYSTERY')?.reliabilityNote,
      'No book-cited reliability note for this classification.');
    assert.equal(gr.gaps.length, 4, 'the gap with no gapType must be dropped');
    assert.equal(gr.mostImportant.length, 1);
  });

  test('a null report formats to the oracle wording', () => {
    const oracle = loadOracle();
    assert.equal(formatSchabackerReport(null), oracle.call('formatSchabackerReportV1', null));
    assert.equal(formatSchabackerReport(null), 'No report — data unavailable.');
    assert.deepStrictEqual(schabackerClassicalStop(null),
      oracle.callNormalized('schabackerClassicalStopV1_', null));
  });
});
