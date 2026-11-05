/**
 * Owner 2026-10-30: the LEAPS expiry comparison on the 📞 Options Decision page (analysis/options/leapsExpiryTable.ts),
 * from a fixture Cboe chain. Display only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLeapsExpiryComparison, leapsExpiryComparisonLines, attachLeapsExpiryComparison, leapsExpiryComparisonOf,
} from '../src/analysis/options/leapsExpiryTable.ts';
import { formatOptionsDecisionPage } from '../src/analysis/reportPages.ts';
import { occ } from './cboeFixtures.ts';

const NOW = Date.parse('2026-10-30T16:00:00Z');
const TZ = 'America/New_York';
const day = (ymd: string): number => Date.parse(ymd + 'T00:00:00Z');
const EXPIRIES = ['2027-06-18', '2027-12-17', '2028-01-21', '2028-03-17', '2028-06-16', '2029-01-19', '2029-12-21'];
/** Per expiry: [strike, delta, bid, ask, oi]. The 0.75 and 0.80 strikes differ; Mar 2028 has no deltas. */
function chain(): { data: { current_price: number; options: Array<Record<string, unknown>> } } {
  const options: Array<Record<string, unknown>> = [];
  EXPIRIES.forEach((e, i) => {
    const rows: Array<[number, number, number, number, number]> = [[70, 0.81, 33, 34 + i, 500], [75, 0.76, 29, 30 + i, 1200], [80, 0.70, 25, 26 + i, 300]];
    for (const [strike, delta, bid, ask, oi] of rows) {
      options.push({ option: occ('TEST', day(e), 'C', strike), delta: e === '2028-03-17' ? null : delta, bid, ask, open_interest: oi });
      options.push({ option: occ('TEST', day(e), 'P', strike), delta: -0.2, bid: 1, ask: 1.1, open_interest: 9 });
    }
  });
  return { data: { current_price: 100, options } };
}
const iso = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

describe('LEAPS expiry comparison', () => {
  const t = buildLeapsExpiryComparison(chain(), NOW, TZ)!;

  test('every call expiry 9-36 months out, sorted; out-of-window and no-delta expiries left out', () => {
    assert.deepEqual(t.blocks[0]!.rows.map((r) => iso(r.expUnix)), ['2027-12-17', '2028-01-21', '2028-06-16', '2029-01-19']);
    assert.deepEqual(t.noDelta.map(iso), ['2028-03-17']);
  });

  test('the 0.75 row: strike, cost, breakeven, rise, per year, sell-by, gate', () => {
    const r = t.blocks[0]!.rows[1]!; // Jan 21 2028, ask 32
    assert.equal(r.strike, 75); assert.equal(r.delta, 0.76); assert.equal(r.ask, 32); assert.equal(r.openInterest, 1200);
    assert.equal(r.days, 448);
    assert.equal(r.cost, 3200); assert.equal(r.breakeven, 107);
    assert.ok(Math.abs(r.rise! - 0.07) < 1e-12);
    assert.ok(Math.abs(r.perYear! - (Math.pow(1.07, 365 / 448) - 1)) < 1e-12);
    assert.equal(iso(r.sellByUnix), '2027-11-22');
    assert.equal(r.passesGate, true);
  });

  test('the 0.80 block picks the 0.81 strike', () => {
    assert.equal(t.blocks[1]!.targetDelta, 0.8);
    assert.ok(t.blocks[1]!.rows.length === 4 && t.blocks[1]!.rows.every((r) => r.strike === 70));
  });

  test("James's pick: the January nearest 19 months within 13-26 months (Jan 2028, not Jan 2029)", () => {
    assert.equal(iso(t.jamesExpUnix!), '2028-01-21');
  });

  test('lines: rows with Friday dates, marks, and the engine pick outside the window', () => {
    const inside = leapsExpiryComparisonLines(t, { strike: 75, expUnix: day('2028-06-16') / 1000 }).join('\n');
    assert.ok(inside.includes('    Fri Jan 21 2028 (448d) · $75 · 0.76 · $29.00/$32.00 · $3,200.00 · $107.00 · 7.0% · 5.7% · 1200 · 2027-11-22 · ✅  ◀ JAMES'), inside);
    assert.ok(/Fri Jun 16 2028 .*◀ ENGINE\n/.test(inside), inside);
    assert.ok(/Fri Jun 16 2028 .*\$70 .*◀ ENGINE \(its strike \$75\)/.test(inside), inside);
    const outside = leapsExpiryComparisonLines(t, { strike: 75, expUnix: day('2029-12-21') / 1000 }).join('\n');
    assert.ok(outside.includes("The engine's pick (Fri Dec 21 2029, $75) is outside this window."), outside);
    assert.ok(outside.includes('No usable delta (left out): Fri Mar 17 2028.'), outside);
  });

  test('a per-year rise over 12% fails the gate', () => {
    const c = chain(); c.data.current_price = 60;
    const r = buildLeapsExpiryComparison(c, NOW, TZ)!.blocks[0]!.rows[0]!;
    assert.equal(r.passesGate, false);
    assert.ok(leapsExpiryComparisonLines(buildLeapsExpiryComparison(c, NOW, TZ)!, null).some((l) => l.startsWith('    Fri Dec 17 2027') && l.endsWith(' · ✗')));
  });

  test('no chain: null', () => {
    assert.equal(buildLeapsExpiryComparison(null, NOW, TZ), null);
    assert.equal(buildLeapsExpiryComparison({ data: { options: [] } }, NOW, TZ), null);
  });

  test('on the Options Decision page via the LEAPS pick; the pick serialises unchanged', () => {
    const pick = { found: true, contract: { strike: 75, expUnix: day('2029-12-21') / 1000, delta: 0.76, iv: 0.4, bid: 29, ask: 36 }, allCandidates: [] };
    const before = JSON.stringify(pick);
    const base = {
      ticker: 'TEST', shortTermCall: null, decision: { action: '✅ BUY NOW', finalConviction: 80 },
      techPlan: { timing: 'BUY_NOW', regime: 'TREND_UP', stop: 90 }, fund: { score: 70 }, confluence: null, flow: { available: false }, nowMs: NOW, timeZone: TZ,
    };
    const plain = formatOptionsDecisionPage({ ...base, leapsCall: pick } as never);
    attachLeapsExpiryComparison(pick, t);
    assert.equal(JSON.stringify(pick), before);
    assert.equal(leapsExpiryComparisonOf(pick), t);
    const page = formatOptionsDecisionPage({ ...base, leapsCall: pick } as never);
    assert.ok(!plain.includes('LEAPS EXPIRY COMPARISON'));
    assert.ok(page.includes('LEAPS EXPIRY COMPARISON'), page);
    assert.ok(page.indexOf('LEAPS EXPIRY COMPARISON') < page.indexOf('OPTIONS FLOW'), page);
    assert.equal(page.replace(/\nLEAPS EXPIRY COMPARISON[\s\S]*?\n\n(?=\d+\. OPTIONS FLOW)/, '\n'), plain);
  });
});
