/**
 * Owner decision 2026-10-30: the short-term call's weekly-chart exit rule (analysis/options/weeklyExit.ts) and its
 * lines on the 📞 Options Decision page. Display only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyBars, macdSeries, readShortTermExit, type ShortTermExitInput } from '../src/analysis/options/weeklyExit.ts';
import { shortTermExitPlanLines, formatOptionsDecisionPage } from '../src/analysis/reportPages.ts';

const DAY = 86_400_000;
/** n weekdays (bars at 14:30 UTC) ending on `end`. */
function weekdays(n: number, end = '2026-10-23'): Date[] {
  const out: Date[] = [];
  for (let t = Date.parse(end + 'T14:30:00Z'); out.length < n; t -= DAY) { const d = new Date(t); if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) out.unshift(d); }
  return out;
}
/** Daily closes that walk linearly to each weekly close (5 bars a week). */
function daily(weekly: readonly number[]): number[] {
  const o: number[] = [];
  weekly.forEach((b, i) => { const a = i ? weekly[i - 1]! : weekly[0]!; for (let j = 1; j <= 5; j++) o.push(a + (b - a) * j / 5); });
  return o;
}
const BASE = Array.from({ length: 50 }, (_, i) => 100 + i * 0.3);
const RALLY = Array.from({ length: 6 }, (_, i) => 115 + (i + 1) * 6); // 121 ... 151: weekly RSI far above 70
const UP = Array.from({ length: 60 }, (_, i) => 100 + i * 1.5 + (i % 3 === 0 ? -1 : 0));
const SAT = Date.parse('2026-10-24T15:00:00Z');

function read(weekly: readonly number[], over: Partial<ShortTermExitInput> = {}) {
  const closes = daily(weekly);
  return readShortTermExit({ dates: weekdays(closes.length), closes, price: closes[closes.length - 1]!, refIsToday: true, stop: 90, t1: 400, sellZoneLow: null, daysLeft: 90, nowMs: SAT, ...over });
}

describe('weekly bars from the daily chart', () => {
  test('one bar per week, the Friday close; the current week is partial and labelled', () => {
    const dates = weekdays(8, '2026-10-28'); // Mon 10-19 .. Wed 10-28
    const closes = [1, 2, 3, 4, 5, 6, 7, 8];
    const w = weeklyBars(dates, closes, { nowMs: Date.parse('2026-10-28T18:00:00Z') });
    assert.deepEqual(w.bars.map((b) => [b.weekOf, b.lastDay, b.close, b.days]), [['2026-10-19', '2026-10-23', 5, 5], ['2026-10-26', '2026-10-28', 8, 3]]);
    assert.equal(w.partial, true);
    // the next Monday: last week (ending on a Wednesday) is done
    assert.equal(weeklyBars(dates, closes, { nowMs: Date.parse('2026-11-02T18:00:00Z') }).partial, false);
    // a Friday bar during the session is still partial; after the close it is complete
    const fri = weekdays(5, '2026-10-30');
    assert.equal(weeklyBars(fri, [1, 2, 3, 4, 5], { nowMs: Date.parse('2026-10-30T17:00:00Z'), liveBar: true }).partial, true);
    assert.equal(weeklyBars(fri, [1, 2, 3, 4, 5], { nowMs: Date.parse('2026-10-30T21:00:00Z') }).partial, false);
    // the label
    const r = readShortTermExit({ dates, closes, nowMs: Date.parse('2026-10-28T18:00:00Z'), liveBar: true });
    assert.match(r.weekLine, /this week \(from 2026-10-26\) is partial: 3 days through 2026-10-28, today's session still open\./);
  });

  test('macdSeries: the three arrays end on the last bar', () => {
    const m = macdSeries(UP);
    assert.equal(m.macd.length, UP.length - 25 - 8);
    assert.equal(m.signal.length, m.macd.length);
    assert.ok(Math.abs(m.hist[m.hist.length - 1]! - (m.macd[m.macd.length - 1]! - m.signal[m.signal.length - 1]!)) < 1e-12);
  });
});

describe('the short-term exit rule: each trigger and the keep case', () => {
  test('keep: a steady weekly uptrend, below T1, above the stop, far from expiry', () => {
    const r = read(UP);
    assert.equal(r.anySell, false);
    assert.deepEqual(r.triggers.map((t) => t.sell), [false, false, false, false]);
    assert.match(r.triggers[0]!.reading, /^✅ keep — new pick: today's price \$188\.50 is the entry, so the stock is not up yet; 0 of 3 signs/);
    assert.equal(r.trendUp, true);
    assert.match(r.keepReading, /^✅ weekly trend up — weekly close \$188\.50 above the 10-week average \$181\.45; weekly MACD [\d.]+ above its signal/);
    assert.match(r.weekLine, /the last week is complete \(through 2026-10-23\)/);
  });

  test('1. out of steam after a gain: up since the reference AND 2 of 3 signs', () => {
    const steam = [...BASE, ...RALLY, 145, 138, 130];
    const r = read(steam, { refPrice: 110, refIsToday: false });
    assert.equal(r.triggers[0]!.sell, true);
    assert.match(r.triggers[0]!.reading, /^⚠️ sell: up 18\.2% since \$110\.00, 2 of 3 signs \(MACD above its signal; RSI 57, back under 60 after 100; weekly close \$130\.00 below the 50-day average \$133\.75\)\./);
    assert.equal(r.anySell, true);
    // the same chart, but the stock is not up since the reference: keep
    const notUp = read(steam, { refPrice: 140, refIsToday: false });
    assert.equal(notUp.triggers[0]!.sell, false);
    assert.match(notUp.triggers[0]!.reading, /not up since \$140\.00/);
    // a new pick (today's price is the entry) is never "up"
    assert.equal(read(steam).triggers[0]!.sell, false);
    // only 1 sign: keep
    const one = read([...BASE, ...RALLY, 150, 149], { refPrice: 110, refIsToday: false });
    assert.equal(one.triggers[0]!.sell, false);
    assert.match(one.triggers[0]!.reading, /needs 2/);
  });

  test('1a. the weekly MACD cross below its signal counts in the week it happens and the next', () => {
    const fall = [...BASE, ...RALLY, 145, 136, 128, 122, 118, 116];
    const m = macdSeries(fall);
    const off = fall.length - m.macd.length;
    const crossAt = m.macd.findIndex((v, i) => i + off >= BASE.length + RALLY.length && v < m.signal[i]! && m.macd[i - 1]! >= m.signal[i - 1]!);
    assert.ok(crossAt > 0, 'the series crosses');
    const upTo = fall.slice(0, off + crossAt + 1);
    const r = read(upTo, { refPrice: 100, refIsToday: false });
    assert.match(r.triggers[0]!.reading, /MACD crossed below its signal/);
    assert.equal(r.triggers[0]!.sell, true);
    assert.match(r.triggers[0]!.reading, /^⚠️ sell: up 22\.0% since \$100\.00, 3 of 3 signs/);
    assert.match(read(fall.slice(0, off + crossAt + 2), { refPrice: 100, refIsToday: false }).triggers[0]!.reading, /MACD crossed below its signal/, 'still counts the week after');
    assert.match(read(fall.slice(0, off + crossAt + 3), { refPrice: 100, refIsToday: false }).triggers[0]!.reading, /MACD below its signal, no fresh cross/, 'not 2 weeks after');
  });

  test('2. sell zone or T1 reached AND the weekly MACD histogram falling 2 weeks in a row', () => {
    const stall = [...BASE, ...RALLY, 153, 154, 154.5];
    const r = read(stall, { t1: 150 });
    assert.equal(r.triggers[1]!.sell, true);
    assert.match(r.triggers[1]!.reading, /^⚠️ sell: \$154\.50 reached T1 \(\$150\.00\); weekly MACD histogram 3\.87 → 3\.85 → 3\.60 \(falling 2 weeks in a row\)\./);
    const zone = read(stall, { t1: null, sellZoneLow: 152 });
    assert.equal(zone.triggers[1]!.sell, true);
    assert.match(zone.triggers[1]!.reading, /reached the sell zone \(\$152\.00\)/);
    // reached, but momentum still rising: keep
    const rising = read(UP, { t1: 150 });
    assert.equal(rising.triggers[1]!.sell, false);
    assert.match(rising.triggers[1]!.reading, /^✅ keep — \$188\.50 reached T1 \(\$150\.00\); .*not falling 2 weeks in a row/);
    // momentum falling, but not reached: keep
    assert.equal(read(stall, { t1: 200 }).triggers[1]!.sell, false);
  });

  test('3. closed below the engine\'s stop', () => {
    const r = read(UP, { stop: 190 });
    assert.equal(r.triggers[2]!.sell, true);
    assert.equal(r.triggers[2]!.reading, '⚠️ sell: the last close $188.50 is below the stop $190.00.');
    const live = read(UP, { stop: 190, liveBar: true });
    assert.match(live.triggers[2]!.reading, /today's price \$188\.50 \(session still open; it counts at the close\)/);
  });

  test('4. hard limit 30 days before expiry', () => {
    assert.equal(read(UP, { daysLeft: 31 }).triggers[3]!.sell, false);
    const r = read(UP, { daysLeft: 30 });
    assert.equal(r.triggers[3]!.sell, true);
    assert.equal(r.triggers[3]!.reading, '⚠️ sell: 30 days to expiry (the limit is 30).');
  });

  test('the keep condition fails when the weekly close drops under the 10-week average', () => {
    const r = read([...BASE, ...RALLY, 145, 138, 130]);
    assert.equal(r.trendUp, false);
    assert.match(r.keepReading, /^⚠️ weekly trend not up — weekly close \$130\.00 not above the 10-week average/);
  });

  test('too little history: not available, never a sell', () => {
    const r = read(BASE.slice(0, 20));
    assert.equal(r.triggers[0]!.sell, null);
    assert.equal(r.trendUp, null);
    assert.equal(r.triggers[3]!.sell, false, 'the hard limit needs no chart');
  });
});

describe('the Options Decision page prints the rule with today\'s reading', () => {
  test('shortTermExitPlanLines with a chart', () => {
    const closes = daily([...BASE, ...RALLY, 153, 154, 154.5]);
    const lines = shortTermExitPlanLines({ stop: 90, t1: { price: 150 }, t1Time: { baseDays: 20 } }, 90,
      { chart: { dates: weekdays(closes.length), closes, currentPrice: 154.5 }, sellZoneLow: 160, nowMs: SAT });
    assert.deepEqual(lines.slice(0, 3), [
      '  - Read on the WEEKLY chart (owner rule 2026-10-30, for swings of weeks to years). Weekly bars: built from the daily chart (59 weeks, Friday closes); the last week is complete (through 2026-10-23).',
      '  - Reference price: today\'s price $154.50 (a new pick: today\'s price is the entry; "up" means up from it).',
      '  - Sell when ANY of these happens:',
    ]);
    assert.ok(lines.includes('    2. The stock reached the engine\'s sell zone (from $160.00) or T1 (stock at $150.00, expected in about 28 days) AND weekly momentum is weakening (the weekly MACD histogram fell 2 weeks in a row).'));
    assert.ok(lines.includes('      Today: ⚠️ sell: $154.50 reached T1 ($150.00); weekly MACD histogram 3.87 → 3.85 → 3.60 (falling 2 weeks in a row).'));
    assert.ok(lines.includes('    3. The stock closed below the engine\'s stop ($90.00).'));
    assert.ok(lines.includes('      Today: ✅ keep — the last close $154.50 is above the stop $90.00.'));
    assert.ok(lines[lines.length - 2]!.startsWith('  - Keep while the weekly trend is up'));
    assert.match(lines[lines.length - 1]!, /^ {6}Today: ✅ weekly trend up/);
  });

  test('the page passes the chart and the sell zone to the short-term pick; LEAPS keeps its 60-day exit', () => {
    const NOW = Date.UTC(2026, 9, 24, 15);
    const exp = (days: number): number => Math.floor(NOW / DAY + days) * 86400;
    const pick = (expUnix: number, strike: number) => ({ found: true, contract: { strike, expUnix, delta: 0.6, iv: 0.5, bid: 10, ask: 11 }, allCandidates: [] });
    const closes = daily(UP);
    const page = formatOptionsDecisionPage({
      ticker: 'TEST', leapsCall: pick(exp(400), 100), shortTermCall: pick(exp(90), 120), decision: { action: '✅ BUY NOW', finalConviction: 80 },
      techPlan: { timing: 'BUY_NOW', regime: 'TREND_UP', stop: 150, entryHigh: 190, entryLow: 180, t1: { price: 220 }, t2: { price: 250 } }, fund: { score: 70 },
      confluence: { entryLow: 180, entryHigh: 190, entryCount: 3, exitLow: 210 }, flow: { available: false }, nowMs: NOW, timeZone: 'America/New_York',
      chart: { dates: weekdays(closes.length), closes, currentPrice: 188.5 },
    });
    assert.ok(page.includes('or T1 (stock at $220.00) AND weekly momentum'), page);
    assert.ok(page.includes("the engine's sell zone (from $210.00)"), page);
    assert.ok(page.includes('      Today: ✅ keep — the last close $188.50 is above the stop $150.00.'), page);
    assert.ok(page.includes('  - Sell everything 60 days before expiry, whatever the price.'), page);
    assert.ok(!page.includes('+50%'), page);
  });
});
