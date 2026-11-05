/**
 * Parity for the three event-driven fields, verified on SYNTHETIC charts.
 *
 * All three are null on every real fixture, so a fixture-only comparison would
 * be vacuous. These charts are built to trigger each condition.
 *
 * Every case passes an explicit simulatedNow. lockupExpiration reads the wall
 * clock otherwise, which would make these tests pass today and fail later.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  computeEventsSlice, lockupExpiration, recentReverseSplit, type EventInput,
} from '../src/analysis/indicators/events.ts';

const ready = legacyFilesPresent();
const FIXED_NOW = new Date('2026-09-21T00:00:00Z');
const BASE = new Date('2026-01-01T00:00:00Z');
const MS_DAY = 86_400_000;
const LAST_DATE = new Date(BASE.getTime() + 259 * MS_DAY);

interface SynthOpts {
  n?: number;
  finalVolSpike?: boolean;
  finalUp?: boolean;
  finalDown?: boolean;
  splits?: Array<{ date: Date; numerator: number; denominator: number }>;
  ipoDate?: Date | null;
  simulatedNow?: Date;
}

/**
 * A steadily rising 260-bar series, so sma50 sits above sma200 and
 * trendMaturity reports an established UP trend -- the precondition
 * progressiveStopFlag needs before its other three conditions can matter.
 */
function synth(opts: SynthOpts = {}): EventInput & { highs: number[]; lows: number[]; opens: number[] } {
  const n = opts.n ?? 260;
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const opens: number[] = [];
  const volumes: number[] = [];
  const dates: Date[] = [];

  for (let i = 0; i < n; i++) {
    let c = 50 + i * 0.4;
    if (opts.finalUp && i === n - 1) c = (closes[i - 1] as number) + 2;
    if (opts.finalDown && i === n - 1) c = (closes[i - 1] as number) - 2;
    closes.push(c);
    opens.push(c);
    highs.push(c + 0.5);
    lows.push(c - 0.5);
    volumes.push(opts.finalVolSpike && i === n - 1 ? 10_000_000 : 1_000_000);
    dates.push(new Date(BASE.getTime() + i * MS_DAY));
  }

  return {
    closes, highs, lows, opens, volumes, dates,
    splits: opts.splits ?? [],
    ipoDate: opts.ipoDate !== undefined ? opts.ipoDate : (dates[0] as Date),
    simulatedNow: opts.simulatedNow ?? FIXED_NOW,
  };
}

describe('event fields — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('all three match the oracle on synthetic triggering charts', () => {
    const oracle = loadOracle();
    const CASES: Array<[string, ReturnType<typeof synth>]> = [
      ['spike + up close', synth({ finalVolSpike: true, finalUp: true })],
      ['spike + DOWN close', synth({ finalVolSpike: true, finalDown: true })],
      ['up close, no spike', synth({ finalUp: true })],
      ['lockup upcoming', synth({ ipoDate: new Date('2026-06-23T00:00:00Z') })],
      ['lockup passed', synth({ ipoDate: new Date('2026-03-05T00:00:00Z') })],
      ['lockup outside window', synth({ ipoDate: new Date('2025-11-25T00:00:00Z') })],
      ['no ipoDate', synth({ ipoDate: null })],
      ['reverse split 1:10', synth({ splits: [{ date: new Date(LAST_DATE.getTime() - 20 * MS_DAY), numerator: 1, denominator: 10 }] })],
      ['forward split only', synth({ splits: [{ date: new Date(LAST_DATE.getTime() - 20 * MS_DAY), numerator: 2, denominator: 1 }] })],
      ['reverse split too old', synth({ splits: [{ date: new Date(LAST_DATE.getTime() - 200 * MS_DAY), numerator: 1, denominator: 10 }] })],
      ['two reverses, newest wins', synth({ splits: [
        { date: new Date(LAST_DATE.getTime() - 50 * MS_DAY), numerator: 1, denominator: 5 },
        { date: new Date(LAST_DATE.getTime() - 10 * MS_DAY), numerator: 1, denominator: 20 },
      ] })],
    ];

    const nonNull = { progressiveStopFlag: 0, lockupExpiration: 0, recentReverseSplit: 0 };
    for (const [label, chart] of CASES) {
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const got = computeEventsSlice(chart) as unknown as Record<string, unknown>;
      for (const k of Object.keys(nonNull) as Array<keyof typeof nonNull>) {
        assert.deepStrictEqual(got[k], all[k], `${label}: ${k}`);
        if (all[k]) nonNull[k]++;
      }
    }

    // Guards the premise: if these stopped triggering, every assertion above
    // would be null-to-null and prove nothing.
    for (const [k, v] of Object.entries(nonNull)) {
      assert.ok(v > 0, `${k} never fired — verification would be vacuous`);
    }
  });

  test('they remain null on every real fixture, and agree there too', () => {
    if (!fixturesPresent()) return;
    const oracle = loadOracle();
    let compared = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
      const chart = { ...buildChart(raw), simulatedNow: FIXED_NOW } as unknown as EventInput;
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const got = computeEventsSlice(chart);
      assert.deepStrictEqual(got.progressiveStopFlag, all['progressiveStopFlag'], `${ticker}`);
      assert.deepStrictEqual(got.lockupExpiration, all['lockupExpiration'], `${ticker}`);
      assert.deepStrictEqual(got.recentReverseSplit, all['recentReverseSplit'], `${ticker}`);
      compared++;
    }
    assert.ok(compared > 0);
  });

  test('progressiveStopFlag requires ALL FOUR conditions', () => {
    // Spike + up-close + UP trend + 5 days since crossover. Removing any one
    // must suppress it.
    const firing = computeEventsSlice(synth({ finalVolSpike: true, finalUp: true })).progressiveStopFlag;
    assert.ok(firing, 'all four conditions met');
    assert.ok(firing.volumeRatio > 3.0);
    assert.ok(firing.daysSinceCross >= 5);

    assert.equal(
      computeEventsSlice(synth({ finalVolSpike: true, finalDown: true })).progressiveStopFlag,
      null,
      'a down close must suppress it',
    );
    assert.equal(
      computeEventsSlice(synth({ finalUp: true })).progressiveStopFlag,
      null,
      'no volume spike must suppress it',
    );
  });

  test('the stop level is exactly an eighth of a point below the close', () => {
    // 0.125 is a pre-decimalization tick size, fixed in dollars since 2001 --
    // a historical artifact, not a tuned parameter.
    const chart = synth({ finalVolSpike: true, finalUp: true });
    const got = computeEventsSlice(chart).progressiveStopFlag;
    assert.ok(got);
    assert.equal(got.level, (chart.closes[chart.closes.length - 1] as number) - 0.125);
  });

  test('lockup window is asymmetric: 180 days to expiry, 210 days of display', () => {
    const ipo = new Date('2026-01-01T00:00:00Z');
    const at = (days: number): Date => new Date(ipo.getTime() + days * MS_DAY);

    assert.equal(lockupExpiration(ipo, at(0))?.status, 'UPCOMING');
    assert.equal(lockupExpiration(ipo, at(179))?.status, 'UPCOMING');
    assert.equal(lockupExpiration(ipo, at(180))?.status, 'PASSED', 'day 180 is PASSED, not UPCOMING');
    assert.equal(lockupExpiration(ipo, at(210))?.status, 'PASSED', 'still visible 30 days after expiry');
    assert.equal(lockupExpiration(ipo, at(211)), null, 'outside the display window');
    assert.equal(lockupExpiration(ipo, at(-1)), null, 'a future-dated IPO is out of window');
    assert.equal(lockupExpiration(null, at(0)), null);
  });

  test('lockup day counting ignores time-of-day', () => {
    // Both sides normalise to UTC midnight, so any two instants on the same
    // calendar day give the same result.
    const ipo = new Date('2026-01-01T23:59:00Z');
    const a = lockupExpiration(ipo, new Date('2026-03-01T00:00:01Z'));
    const b = lockupExpiration(ipo, new Date('2026-03-01T23:59:59Z'));
    assert.deepStrictEqual(a, b);
  });

  test('only REVERSE splits count, newest wins, and the window is a date cutoff', () => {
    const dates = Array.from({ length: 100 }, (_, i) => new Date(BASE.getTime() + i * MS_DAY));
    const last = dates[99] as Date;
    const mk = (daysAgo: number, num: number, den: number) => ({
      date: new Date(last.getTime() - daysAgo * MS_DAY),
      numerator: num,
      denominator: den,
    });

    // Forward splits are ignored entirely.
    assert.equal(recentReverseSplit([mk(10, 2, 1)], dates, 100), null);
    // Reverse split outside the 60-bar window.
    assert.equal(recentReverseSplit([mk(80, 1, 10)], dates, 100), null);
    // In-window reverse split.
    const hit = recentReverseSplit([mk(10, 1, 10)], dates, 100);
    assert.equal(hit?.ratio, '1:10');
    assert.equal(hit?.daysAgo, 10);
    // Newest of several wins.
    const newest = recentReverseSplit([mk(50, 1, 5), mk(10, 1, 20)], dates, 100);
    assert.equal(newest?.ratio, '1:20');
    // Degenerate inputs.
    assert.equal(recentReverseSplit([], dates, 100), null);
    assert.equal(recentReverseSplit(null, dates, 100), null);
    assert.equal(recentReverseSplit([mk(10, 1, 10)], null, 100), null);
  });
});
