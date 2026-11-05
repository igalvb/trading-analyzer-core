/**
 * Differential verification of the options exit read.
 *
 * ══ THE CLOCK IS PINNED, AND IT HAS TO BQZA ══════════════════════════════
 * `daysToExpiry` derives from Date.now() in legacy (:10081), so an
 * unpinned comparison would be flaky across real time and would silently
 * stop testing the expiry rungs once the hardcoded expiries aged out.
 *
 * Verified empirically rather than assumed: the oracle's sandbox receives
 * `Date` from THIS realm (see buildSandbox in oracle.ts), so patching the
 * global Date.now pins BOTH sides to the same instant. Probed directly --
 * a function evaluated inside the vm returned the patched value. The port
 * also takes `now` as a parameter, so it is pinned twice over.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  computeOptionsPositionExitRead, parseOptionExpiry,
  EXPIRY_WARNING_DAYS_SHORT_TERM, EXPIRY_WARNING_DAYS_LEAPS,
  LEAPS_MIN_ORIGINAL_DURATION_DAYS,
} from '../src/analysis/optionsExitRead.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** 2026-01-15. Chosen so the expiries below straddle every window. */
const PINNED_NOW = Date.UTC(2026, 0, 15);

/**
 * Expiries relative to PINNED_NOW: already past, inside the 30-day
 * short-term window, inside the 60-day LEAPS window, far out, unparseable.
 */
const EXPIRIES = ["Dec19'25", "Jan20'26", "Feb10'26", "Mar19'26", "Jan15'28", 'bogus'];

/** Runs `fn` with the global clock pinned, restoring it even on throw. */
function withPinnedClock<T>(fn: () => T): T {
  const original = Date.now;
  Date.now = (): number => PINNED_NOW;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

describe('options exit read — parity', { skip: ready ? false : 'legacy/ or fixtures/ not populated' }, () => {
  test('parseOptionExpiry matches the oracle on every real and malformed form', () => {
    const oracle = loadOracle();
    const inputs: unknown[] = [
      // Broker compact forms, which is what the Transactions sheet holds.
      "Mar19'27", "JUN17'27", "Dec17'27", 'dec 17 27', "Mar19'2027",
      // Standard forms that fall through to `new Date(str)`.
      'Jan 5 2028', '2027-03-19', '03/19/2027',
      // Malformed: bad month, impossible day, empty, whitespace, nullish.
      "XXX19'27", "Mar99'27", "Feb30'27", '', '   ', null, undefined, 0,
      // Date objects, valid and invalid.
      new Date(Date.UTC(2027, 2, 19)), new Date('invalid'),
      // Two-digit year with NO windowing: '99 becomes 2099, not 1999.
      "May1'99", 'Jun 7 05',
    ];
    for (const input of inputs) {
      assert.deepStrictEqual(
        parseOptionExpiry(input),
        oracle.callNormalized('myOpt_parseDate', input),
        `parse ${JSON.stringify(input)}`,
      );
    }
    // The +2000 rule, pinned so "fixing" it to a windowed parse fails here.
    assert.deepStrictEqual(parseOptionExpiry("May1'99"), { year: 2099, month: 5, day: 1 });
    // An invalid Date object falls through to the string path, where
    // String(Invalid Date) is "Invalid Date" and fails both branches.
    assert.equal(parseOptionExpiry(new Date('invalid')), null);
    // Month 1-based, unlike Date.getMonth().
    assert.deepStrictEqual(parseOptionExpiry("Mar19'27"), { year: 2027, month: 3, day: 19 });
  });

  test('the full read matches the oracle across every expiry window', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let oracleCrashed = 0;
    let portSurvived = 0;
    const recommendations = new Set<string>();
    const errors = new Set<string>();
    let leapsAtEntry = 0;
    let shortTerm = 0;
    let warned = 0;
    let notWarned = 0;

    withPinnedClock(() => {
      for (const ticker of listFixtures()) {
        let raw;
        try {
          raw = loadRawFixture(ticker);
        } catch {
          continue;
        }
        if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
        const chart = buildChart(raw, raw.closes.length);
        const n = chart.dates.length;
        const entryDates = [0, Math.floor(n * 0.3), Math.floor(n * 0.8), n - 1]
          .map((i) => chart.dates[i].toISOString().slice(0, 10));
        // An entry before the fetched history: the stock read refuses, so
        // this exercises the "technical read unavailable" rung.
        entryDates.push('1990-01-01');

        for (const ds of entryDates) {
          for (const expiry of EXPIRIES) {
            let expected;
            try {
              expected = oracle.callNormalized<Record<string, unknown>>(
                'computeOptionsPositionExitReadV1_', ticker, 100, expiry, 5.25, ds, chart,
              );
            } catch {
              // F-14 again, via the underlying's tech plan.
              oracleCrashed++;
              const g = computeOptionsPositionExitRead(ticker, 100, expiry, 5.25, ds, chart, PINNED_NOW, { legacyHistoricalTargets: true });
              assert.ok(g, `${ticker} port should still return something`);
              portSurvived++;
              continue;
            }
            const got = computeOptionsPositionExitRead(ticker, 100, expiry, 5.25, ds, chart, PINNED_NOW, { legacyHistoricalTargets: true });
            assert.deepStrictEqual(got, expected, `${ticker} entry=${ds} expiry=${expiry}`);
            comparisons++;
            if (expected.error) {
              errors.add(String(expected.error).slice(0, 38));
            } else {
              // Normalise the day count out of the headline so the rung is
              // counted once rather than once per remaining day.
              recommendations.add(String(expected.recommendation).replace(/\(\d+d\)/, '(Nd)'));
              expected.isLeapsAtEntry ? leapsAtEntry++ : shortTerm++;
              expected.expiryWarning ? warned++ : notWarned++;
            }
          }
        }
      }
    });

    assert.ok(comparisons > 500, `only ${comparisons} comparisons`);
    assert.ok(leapsAtEntry > 0 && shortTerm > 0, 'only one LEAPS branch exercised');
    assert.ok(warned > 0 && notWarned > 0, 'only one expiryWarning branch exercised');
    assert.equal(errors.size, 1, [...errors].join(' | '));
    // Seven of the eight rungs fire on real data. The eighth is T2, absent
    // for the F-16 reason -- asserted in its own test below.
    assert.equal(recommendations.size, 7, [...recommendations].sort().join(' | '));
    for (const rung of [
      'EXPIRED',
      'HOLD',
      'HOLD (technical read unavailable)',
      'STOP HIT (underlying) — EXIT',
      'THESIS INVALIDATED (underlying) — CONSIDER EXIT',
      'EXPIRY APPROACHING (Nd) — CONSIDER EXIT',
      'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS',
    ]) {
      assert.ok(recommendations.has(rung), `rung never fired: ${rung}`);
    }
    assert.ok(oracleCrashed > 0 && portSurvived === oracleCrashed, 'F-14 asymmetry changed');
  });

  test('expiry outranks the profit rungs but not the risk rungs', () => {
    // Measured, not asserted from reading the source: 4 real cases have
    // expiryWarning AND hitT1 true with both risk rungs clear, and every
    // one reports EXPIRY APPROACHING. If the ordering were reversed these
    // would read T1 REACHED.
    let expiryOverT1 = 0;
    withPinnedClock(() => {
      for (const ticker of listFixtures()) {
        let raw;
        try {
          raw = loadRawFixture(ticker);
        } catch {
          continue;
        }
        if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
        const chart = buildChart(raw, raw.closes.length);
        const n = chart.dates.length;
        for (const i of [0, Math.floor(n * 0.3), Math.floor(n * 0.8), n - 1]) {
          const ds = chart.dates[i].toISOString().slice(0, 10);
          for (const expiry of ["Jan20'26", "Feb10'26", "Mar19'26"]) {
            const r = computeOptionsPositionExitRead(ticker, 100, expiry, 5.25, ds, chart, PINNED_NOW, { legacyHistoricalTargets: true });
            if ('error' in r && r.error) continue;
            const read = r as Extract<typeof r, { error: null }>;
            const tech = read.technical;
            if ('error' in tech && tech.error) continue;
            const t = tech as Extract<typeof tech, { error: null }>;
            if (read.expiryWarning && t.hitT1 && !t.stopBreached && !t.thesisInvalidated) {
              expiryOverT1++;
              assert.ok(read.recommendation.startsWith('EXPIRY APPROACHING'),
                `${ticker} expiry should outrank T1, got ${read.recommendation}`);
            }
            // And the risk rungs still outrank expiry.
            if (read.expiryWarning && t.stopBreached && read.daysToExpiry > 0) {
              assert.ok(read.recommendation.startsWith('STOP HIT'),
                `${ticker} stop should outrank expiry, got ${read.recommendation}`);
            }
          }
        }
      }
    });
    assert.ok(expiryOverT1 > 0, 'no case had expiry and T1 competing -- the test proved nothing');
  });

  test('the LEAPS boundary is exclusive, and measured from ENTRY not today', () => {
    const chart = buildChart(loadRawFixture('NVDA'), 500);
    assert.equal(LEAPS_MIN_ORIGINAL_DURATION_DAYS, 365);
    assert.equal(EXPIRY_WARNING_DAYS_SHORT_TERM, 30);
    assert.equal(EXPIRY_WARNING_DAYS_LEAPS, 60);

    // `>` not `>=`: a contract bought exactly 365 days before expiry is NOT
    // a LEAPS and gets the 30-day window.
    const exactly365 = computeOptionsPositionExitRead(
      'NVDA', 100, "Jan15'26", 5, '2025-01-15', chart, PINNED_NOW,
    ) as Extract<ReturnType<typeof computeOptionsPositionExitRead>, { error: null }>;
    assert.equal(exactly365.isLeapsAtEntry, false);
    assert.equal(exactly365.expiryThreshold, 30);

    const days366 = computeOptionsPositionExitRead(
      'NVDA', 100, "Jan15'26", 5, '2025-01-14', chart, PINNED_NOW,
    ) as Extract<ReturnType<typeof computeOptionsPositionExitRead>, { error: null }>;
    assert.equal(days366.isLeapsAtEntry, true);
    assert.equal(days366.expiryThreshold, 60);

    // "At entry" is the point: this contract has only days left, but it was
    // a LEAPS when bought, so it is still judged on the 60-day window.
    const agedLeaps = computeOptionsPositionExitRead(
      'NVDA', 100, "Jan20'26", 5, '2023-01-01', chart, PINNED_NOW,
    ) as Extract<ReturnType<typeof computeOptionsPositionExitRead>, { error: null }>;
    assert.equal(agedLeaps.isLeapsAtEntry, true);
    assert.equal(agedLeaps.expiryThreshold, 60);
    assert.ok(agedLeaps.daysToExpiry < 30);
  });

  test('F-16 compounds here: the options T2 rung never surfaces either', () => {
    // On the stock side T2 was 0 of 305 hits. Here it sits BELOW an extra
    // rung that fires on every contract inside its warning window, so it is
    // at least as unreachable. Measured rather than inferred.
    let hitT2 = 0;
    let t2Surfaced = 0;
    withPinnedClock(() => {
      for (const ticker of listFixtures()) {
        let raw;
        try {
          raw = loadRawFixture(ticker);
        } catch {
          continue;
        }
        if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
        const chart = buildChart(raw, raw.closes.length);
        const n = chart.dates.length;
        for (const i of [0, Math.floor(n * 0.3), Math.floor(n * 0.8), n - 1]) {
          const ds = chart.dates[i].toISOString().slice(0, 10);
          for (const expiry of EXPIRIES) {
            const r = computeOptionsPositionExitRead(ticker, 100, expiry, 5.25, ds, chart, PINNED_NOW, { legacyHistoricalTargets: true });
            if ('error' in r && r.error) continue;
            const read = r as Extract<typeof r, { error: null }>;
            const tech = read.technical;
            if ('error' in tech && tech.error) continue;
            if ((tech as Extract<typeof tech, { error: null }>).hitT2) {
              hitT2++;
              if (read.recommendation.startsWith('T2')) t2Surfaced++;
            }
          }
        }
      }
    });
    assert.ok(hitT2 > 20, `hitT2 only true ${hitT2} times -- sample too small`);
    assert.equal(t2Surfaced, 0, 'the options T2 rung now surfaces -- re-examine F-16');
  });
});
