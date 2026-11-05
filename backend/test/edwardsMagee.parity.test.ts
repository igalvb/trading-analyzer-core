/**
 * Differential verification of the Edwards & Magee model report.
 *
 * ══ THE WHOLE POINT OF THIS FILE IS THE INJECTION ══════════════════════
 * Three of the report's seven reads come from separate daily trigger caches
 * (`dowTheoryConfirmation`, `evaluativeIndex`, `relativeStrengthRanking`)
 * which are absent in any isolated run. Left alone, every one degrades to
 * `available: false` and a parity test would compare null to null across
 * the board -- the exact vacuous-verification trap that previously hid the
 * wyckoff and macro-regime bugs.
 *
 * So all three are INJECTED with synthetic values covering every verdict
 * arm, on BOTH sides: the oracle gets an enriched copy built inside its own
 * realm, the port gets a structural clone. Nothing here is a null-to-null
 * comparison.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  buildEdwardsMageeReport, formatEdwardsMageeReport,
  edwardsMageeExclusions, edwardsMageeSourceConflict, edwardsMageeSpacingCheck,
  type EnrichedIndicators, type ModelTechPlan,
  type DowTheoryCache, type EvaluativeIndexCache, type RelativeStrengthCache,
} from '../src/analysis/models/edwardsMagee.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Every verdict the label table knows, plus an unknown one and absence. */
const DOW_CASES: (DowTheoryCache | null)[] = [
  null,
  { verdict: 'BULL_CONFIRMED', industrials: { close: 400.12 }, transports: { close: 70.5 } },
  { verdict: 'BEAR_CONFIRMED', industrials: { close: 300.0 }, transports: { close: 50.25 } },
  { verdict: 'NON_CONFIRMATION_BULL', industrials: { close: 410.0 }, transports: { close: 69.0 } },
  { verdict: 'NON_CONFIRMATION_BEAR', industrials: { close: 310.0 }, transports: { close: 51.0 } },
  { verdict: 'NEUTRAL', industrials: { close: 350.0 }, transports: { close: 60.0 } },
  // Unknown verdict: must fall through to the raw string, not undefined.
  { verdict: 'SOMETHING_NEW', industrials: { close: 1.5 }, transports: { close: 2.5 } },
];

/** OVERSOLD / OVERBOUGHT drive the synthesis; anything else is silent. */
const EI_CASES: (EvaluativeIndexCache | null)[] = [
  null,
  { pctStrong: 6.3, strong: 5, weak: 75, unavailable: 5, read: 'OVERSOLD — historical Bottom zone' },
  { pctStrong: 92.1, strong: 78, weak: 5, unavailable: 2, read: 'OVERBOUGHT — symmetric Top zone' },
  { pctStrong: 50.0, strong: 42, weak: 40, unavailable: 3, read: 'NEUTRAL — mid-range breadth' },
];

/** STRONG / WEAK drive the synthesis; MIDDLE is deliberately silent. */
const RSR_CASES: (RelativeStrengthCache | null)[] = [
  null,
  {
    categories: ['AI', 'SEMIS'], rank: 1, peerCount: 12, percentile: 99,
    read: 'STRONG — top decile',
    topPeers: [{ ticker: 'NVDA' }, { ticker: 'AVGO' }], bottomPeers: [{ ticker: 'INTC' }],
  },
  {
    categories: ['BIOTECH'], rank: 11, peerCount: 12, percentile: 8,
    read: 'WEAK — bottom decile',
    topPeers: [{ ticker: 'LLY' }], bottomPeers: [{ ticker: 'XYZ' }, { ticker: 'ABC' }],
  },
  {
    categories: ['ETF'], rank: 6, peerCount: 12, percentile: 50, read: 'MIDDLE — no edge',
    topPeers: [], bottomPeers: [],
  },
];

const PSF_CASES = [null, { level: 101.25, volumeRatio: 3.7, daysSinceCross: 42 }];

describe('Edwards & Magee model — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('the report and its formatted text match the oracle across every injected state', () => {
    const oracle = loadOracle();
    // Builds the enriched indicators INSIDE the oracle's realm. Assigning
    // my-realm objects onto a vm-realm object works for reads, but building
    // the container there keeps the oracle's view entirely its own.
    const enrich = oracle.fns.setStatusV7.constructor(
      'b', 'd', 'e', 'r', 'p',
      'var x=Object.assign({},b); x.dowTheoryConfirmation=d; x.evaluativeIndex=e;'
      + ' x.relativeStrengthRanking=r; x.progressiveStopFlag=p; return x;',
    ) as (b: unknown, d: unknown, e: unknown, r: unknown, p: unknown) => unknown;

    let comparisons = 0;
    const netReads = new Set<string>();
    const dowVerdicts = new Set<string>();
    const formattedLineCounts = new Set<number>();
    let reportsWithSpacing = 0;
    let bullishSeen = 0;
    let cautionarySeen = 0;

    // Six fixtures is enough: the variation that matters is the 168
    // injected cache combinations, not the chart.
    for (const ticker of listFixtures().slice(0, 6)) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
      const chart = buildChart(raw, raw.closes.length);
      const rawInd = oracle.call('computeAllIndicators', chart);
      const gann = oracle.call('computeGannInline', chart, rawInd);
      const conf = oracle.call('computeConfluenceTargets', rawInd, gann, null, chart);
      let plan;
      try {
        plan = oracle.call('computeTechnicalPlanV7', rawInd, gann, conf, chart, null);
      } catch {
        continue; // F-14
      }

      for (const dow of DOW_CASES) {
        for (const ei of EI_CASES) {
          for (const rsr of RSR_CASES) {
            for (const psf of PSF_CASES) {
              const indOracle = enrich(rawInd, dow, ei, rsr, psf);
              const indPort = Object.assign(
                structuredClone(rawInd) as object,
                {
                  dowTheoryConfirmation: dow, evaluativeIndex: ei,
                  relativeStrengthRanking: rsr, progressiveStopFlag: psf,
                },
              ) as EnrichedIndicators;
              const planPort = structuredClone(plan) as ModelTechPlan;

              // The oracle gets all SEVEN parameters; the port gets four.
              // If gann/confluence/chart mattered, this would diverge.
              // Explicit annotation: inferring this through the later
              // formatEdwardsMageeReportV1 call is circular (TS7022).
              const expected: Record<string, unknown> | null =
                oracle.callNormalized<Record<string, unknown> | null>(
                  'buildEdwardsMageeReportV1', ticker, indOracle, gann, conf, plan, chart, null,
                );
              const got = buildEdwardsMageeReport(ticker, indPort, planPort);
              const where = `${ticker} dow=${dow?.verdict ?? 'none'} ei=${ei?.read.slice(0, 9) ?? 'none'}`
                + ` rsr=${rsr?.read.slice(0, 6) ?? 'none'} psf=${!!psf}`;
              // `as unknown` keeps deepStrictEqual's type unification from
              // collapsing `got` to never for the assertions below.
              assert.deepStrictEqual(got as unknown, expected, where);
              comparisons++;

              assert.ok(got, 'the report should never be null on valid inputs');
              netReads.add(got.synthesis.netRead);
              dowVerdicts.add(got.dowTheory.available ? got.dowTheory.verdict : '(unavailable)');
              if (got.spacingCheck.patterns.length) reportsWithSpacing++;
              bullishSeen += got.synthesis.bullish.length;
              cautionarySeen += got.synthesis.cautionary.length;

              const expectedText: string = oracle.call<string>('formatEdwardsMageeReportV1', expected);
              assert.equal(formatEdwardsMageeReport(got), expectedText, `${where} formatted`);
              comparisons++;
              formattedLineCounts.add(expectedText.split('\n').length);
            }
          }
        }
      }
    }

    assert.ok(comparisons > 2000, `only ${comparisons} comparisons`);
    // All three synthesis outcomes, so netRead is not degenerate.
    assert.equal(netReads.size, 3, [...netReads].join(' | '));
    // Every label-table verdict, the unknown fallback, and absence.
    assert.equal(dowVerdicts.size, 7, [...dowVerdicts].sort().join(','));
    assert.ok(dowVerdicts.has('SOMETHING_NEW'), 'the unknown-verdict fallback was not exercised');
    assert.ok(dowVerdicts.has('(unavailable)'), 'the absent-cache path was not exercised');
    // Both synthesis lists actually populated, not just created.
    assert.ok(bullishSeen > 0 && cautionarySeen > 0, 'one synthesis list was always empty');
    assert.ok(reportsWithSpacing > 0, 'no report carried a spacing-check pattern');
    // The formatter's conditional branches genuinely change the output.
    assert.ok(formattedLineCounts.size >= 5,
      `formatted output only took ${formattedLineCounts.size} distinct shapes`);
  });

  test('a null report formats to the oracle wording, not a crash', () => {
    const oracle = loadOracle();
    assert.equal(
      formatEdwardsMageeReport(null),
      oracle.call('formatEdwardsMageeReportV1', null),
    );
    assert.equal(formatEdwardsMageeReport(null), 'No report — data unavailable.');
  });

  test('F-17: three of the builder\'s seven parameters are dead', () => {
    // Measured on the legacy body (:186-241) with strings and comments
    // removed: `gann`, `confluence` and `chart` each appear exactly once --
    // the parameter declaration itself -- and zero times in the body.
    //
    // The port therefore takes four parameters, not seven. The main test
    // above is the proof: it hands the oracle all seven and the port four,
    // on 2,000+ comparisons, with identical results. If any of the three
    // mattered, that would diverge.
    //
    // Reproduced as a signature SIMPLIFICATION rather than carried as dead
    // weight, because a parameter that is never read is not behaviour.
    const oracle = loadOracle();
    const raw = loadRawFixture(listFixtures()[0]);
    const chart = buildChart(raw, raw.closes.length);
    const rawInd = oracle.call('computeAllIndicators', chart);
    const gann = oracle.call('computeGannInline', chart, rawInd);
    const conf = oracle.call('computeConfluenceTargets', rawInd, gann, null, chart);

    // Deliberately feeding the oracle GARBAGE for the three dead slots.
    // It must still produce the identical report.
    const withReal = oracle.callNormalized(
      'buildEdwardsMageeReportV1', 'T', rawInd, gann, conf, {}, chart, null,
    );
    const withGarbage = oracle.callNormalized(
      'buildEdwardsMageeReportV1', 'T', rawInd, 'garbage', 42, {}, null, null,
    );
    assert.deepStrictEqual(withGarbage, withReal,
      'gann/confluence/chart are supposed to be unused -- they are not');
  });

  test('the static sections are verbatim, including the disclosed source conflict', () => {
    const oracle = loadOracle();
    // These are data, not computation, and the report prints them -- so a
    // dropped exclusion or a reworded conflict is a real content change.
    assert.deepStrictEqual(
      edwardsMageeExclusions(),
      oracle.callNormalized('edwardsMageeExclusionsV1_'),
    );
    assert.equal(edwardsMageeExclusions().length, 5);
    assert.deepStrictEqual(
      edwardsMageeSourceConflict(),
      oracle.callNormalized('edwardsMageeSourceConflictV1_'),
    );
    // The conflict is the whole point: two cited sources disagree and
    // neither is silently picked.
    const sc = edwardsMageeSourceConflict();
    assert.match(sc.schabacker, /no reliance can be placed/);
    assert.match(sc.note, /flagged honestly here rather than silently picking a side/);
  });

  test('the spacing check labels existing detections and drops unflagged ones', () => {
    const oracle = loadOracle();
    const cases: unknown[] = [
      null,
      undefined,
      [],
      // Right type, no emSpacingCheck -> dropped entirely, not reported as failing.
      [{ type: 'DOUBLE_TOP' }],
      // Wrong type, has the field -> also dropped.
      [{ type: 'HEAD_SHOULDERS', emSpacingCheck: { weeksApart: 9, magnitudePct: 20, meetsBook: true } }],
      // Both arms of meetsBook, both pattern types.
      [
        { type: 'DOUBLE_TOP', emSpacingCheck: { weeksApart: 9, magnitudePct: 22, meetsBook: true } },
        { type: 'DOUBLE_BOTTOM', emSpacingCheck: { weeksApart: 3, magnitudePct: 7, meetsBook: false } },
      ],
    ];
    for (const c of cases) {
      assert.deepStrictEqual(
        edwardsMageeSpacingCheck(c),
        oracle.callNormalized('edwardsMageeSpacingCheckV1_', c),
        JSON.stringify(c),
      );
    }
    assert.equal(edwardsMageeSpacingCheck([{ type: 'DOUBLE_TOP' }]).patterns.length, 0);
    assert.equal(edwardsMageeSpacingCheck(cases[5]).patterns.length, 2);
  });
});
