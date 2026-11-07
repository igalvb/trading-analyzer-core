/**
 * The Washout ADD alert (owner 2026-11-07): the shared W1 signal (analysis/washout.ts, the research lab's function)
 * at its edges, the market regime from QQQ, the alert line, Strong fundamentals only, the 10-trading-day dedupe,
 * silent nights, profile alerts.washout (off = nothing), the Buy report line and the dashboard badge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { washoutAt, washoutInd, washoutReadLast, marketRegime, regimeWords, WASHOUTS, MIN_BARS, type WashoutInd } from '../src/analysis/washout.ts';
import { indicators, washoutAt as labWashoutAt } from '../src/research/washoutRotationLab.ts';
import {
  washoutNight, washoutLine, sendWashoutAlerts, gatherWashoutNight, tradingDaysSince, readWashoutLast, washoutAlertsOn,
  WASHOUT_LAST_KEY, STRONG_FUNDAMENTALS, WASHOUT_DEDUPE_TRADING_DAYS, type WashoutCandidate,
} from '../src/jobs/washout/washoutAlert.ts';
import { runWashoutAlerts } from '../src/nightly.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';
import { parseBuyReport } from '../src/dashboard/data.ts';
import { T as BUY_TEXT } from '../src/reports/buySheet/text.ts';

function weekdays(from: string, n: number): string[] {
  const out: string[] = []; let t = Date.parse(from + 'T00:00:00Z');
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); t += 86_400_000; }
  return out;
}
/** 300 bars of a steady rise, then a fall of 5% a bar for `fall` bars (the last bar is the night). */
function shape(fall = 6): number[] {
  const c: number[] = [];
  for (let i = 0; i < 300; i++) c.push(100 * 1.002 ** i + (i % 2 ? 0.3 : -0.3));
  const top = c[c.length - 1]!;
  for (let k = 1; k <= fall; k++) c.push(top * (1 - 0.05 * k));
  return c;
}
const ind = (z: number | null, close: number, hi: number, dir: number, n = MIN_BARS): WashoutInd => ({
  s: { closes: [...new Array(n - 1).fill(hi), close] }, z: [...new Array(n - 1).fill(0), z], hi252: new Array(n).fill(hi), dir150: [...new Array(n - 1).fill(1), dir],
});

describe('the W1 signal (shared with the research lab)', () => {
  test('edges: -2.5 SD and 20% off fire (inclusive); just inside does not; trend flat or falling does not; too little history does not', () => {
    const i = MIN_BARS - 1;
    assert.equal(washoutAt(ind(-2.5, 80, 100, 1), i, WASHOUTS.W1), true);
    assert.equal(washoutAt(ind(-2.49, 80, 100, 1), i, WASHOUTS.W1), false);
    assert.equal(washoutAt(ind(-3, 80.01, 100, 1), i, WASHOUTS.W1), false);
    assert.equal(washoutAt(ind(-3, 70, 100, 0), i, WASHOUTS.W1), false);
    assert.equal(washoutAt(ind(-3, 70, 100, -1), i, WASHOUTS.W1), false);
    assert.equal(washoutAt(ind(null, 70, 100, 1), i, WASHOUTS.W1), false);
    assert.equal(washoutAt(ind(-3, 70, 100, 1, MIN_BARS - 1), MIN_BARS - 2, WASHOUTS.W1), false);
  });
  test('the live read at the last close = the research lab on the same bars', () => {
    const c = shape(), dates = weekdays('2020-01-01', c.length);
    const lab = indicators({ ticker: 'X', dates, opens: c, highs: c, lows: c, closes: c, volumes: c.map(() => 1), splits: [] });
    const live = washoutInd(c);
    for (let k = 0; k < c.length; k++) assert.equal(washoutAt(live, k, WASHOUTS.W1), labWashoutAt(lab, k, WASHOUTS.W1), 'bar ' + k);
    const r = washoutReadLast(c);
    assert.equal(r.fired, true);
    assert.ok(r.sdUnder! >= 2.5 && r.offHigh! >= 0.2 && r.trendRising);
    assert.equal(washoutReadLast(shape(2)).fired, false, '10% off: not a washout');
    assert.equal(washoutReadLast([]).fired, false);
  });
});

describe('market regime from QQQ', () => {
  const rise = (n: number): number[] => Array.from({ length: n }, (_, i) => 100 * 1.001 ** i);
  test('bull, correction in a bull market, bear (20% off or the 200-day falling), too short = null', () => {
    const up = rise(400);
    assert.equal(marketRegime(up)!.regime, 'bull');
    const top = up[up.length - 1]!;
    assert.equal(marketRegime([...up, top * 0.95])!.regime, 'bull', '5% off, above a rising 200-day');
    const c = marketRegime([...up, top * 0.88])!;
    assert.equal(c.regime, 'correction'); assert.ok(c.rising200);
    assert.equal(marketRegime([...up, top * 0.8])!.regime, 'bear', '20% off');
    const down = Array.from({ length: 400 }, (_, i) => 200 * 0.999 ** i);
    const d = marketRegime([...down, down[399]! * 1.3])!;
    assert.equal(d.rising200, false); assert.equal(d.regime, 'bear', 'the 200-day falling');
    // below a still-rising 200-day but less than 10% off: a correction, not a bull
    const flat = [...rise(380), ...new Array(40).fill(100 * 1.001 ** 379)];
    const f = marketRegime([...flat, flat[flat.length - 1]! * 0.93]);
    assert.ok(f && f.rising200 && !f.above200); assert.equal(f.regime, 'correction');
    assert.equal(marketRegime(rise(219)), null);
    assert.equal(regimeWords('bear'), 'bear market: smaller size');
  });
});

describe('the alert night', () => {
  const c = shape(), dates = weekdays('2025-01-01', c.length), today = dates[dates.length - 1]!;
  const cand = (o: Partial<WashoutCandidate> = {}): WashoutCandidate => ({ ticker: 'MU', held: true, dates, closes: c, fundScore: 80, ...o });
  test('one line: SDs under, % off the high, trend, add level, loan bar, regime; 1-2 lines short', () => {
    const n = washoutNight([cand()], 'bull', {}, today);
    assert.equal(n.hits.length, 1);
    const h = n.hits[0]!;
    assert.match(h.line, /^🟢 Washout: MU closed \d+\.\d SD under its 20-day average, \d+% off its high, long trend still rising — an add level \(long-term, no stop\)\. Loan bar: beats QQQ\? · market: bull\.$/);
    assert.ok(h.line.length <= 300 && !h.line.includes('\n'));
    assert.match(washoutNight([cand({ held: false })], 'bear', {}, today).hits[0]!.line, /a buy level .* bear market: smaller size\.$/);
    assert.match(washoutNight([cand()], 'correction', {}, today).hits[0]!.line, /market: correction in a bull market\.$/);
    assert.equal(washoutLine('X', { fired: true, sdUnder: 2.66, offHigh: 0.414, trendRising: true, bars: 300 }, true, null).includes('2.7 SD under') && washoutLine('X', { fired: true, sdUnder: 2.66, offHigh: 0.414, trendRising: true, bars: 300 }, true, null).includes('41% off'), true);
  });
  test('Strong fundamentals only (>= 70; no score = no alert); a stale bar is not tonight; no signal = no hit', () => {
    assert.equal(washoutNight([cand({ fundScore: null })], 'bull', {}, today).hits.length, 0);
    assert.equal(washoutNight([cand({ fundScore: STRONG_FUNDAMENTALS - 0.5 })], 'bull', {}, today).hits.length, 0);
    assert.equal(washoutNight([cand({ fundScore: STRONG_FUNDAMENTALS })], 'bull', {}, today).hits.length, 1);
    assert.equal(washoutNight([cand()], 'bull', {}, '2030-01-01').hits.length, 0, 'the chart stopped days ago');
    assert.equal(washoutNight([cand({ closes: shape(2), dates: dates.slice(0, 302) })], 'bull', {}, dates[301]!).hits.length, 0);
    assert.equal(washoutNight([cand(), cand()], 'bull', {}, today).hits.length, 1, 'a ticker once');
  });
  test('dedupe: at most one line per stock per 10 of its trading days', () => {
    assert.equal(tradingDaysSince(dates, dates[dates.length - 10]!), 9);
    const nine = washoutNight([cand()], 'bull', { MU: dates[dates.length - 10]! }, today);
    assert.equal(nine.hits[0]!.deduped, true);
    const ten = washoutNight([cand()], 'bull', { MU: dates[dates.length - 11]! }, today);
    assert.equal(ten.hits[0]!.deduped, false);
    assert.equal(washoutNight([cand()], 'bull', { AAA: today }, today).hits[0]!.deduped, false, 'another stock\'s line does not count');
    assert.ok(WASHOUT_DEDUPE_TRADING_DAYS === 10);
  });
});

describe('sending (Telegram clean: one line per stock, silent otherwise)', () => {
  const c = shape(), dates = weekdays('2025-01-01', c.length), today = dates[dates.length - 1]!;
  const night = (last: Record<string, string> = {}) => washoutNight([
    { ticker: 'MU', held: true, dates, closes: c, fundScore: 80 }, { ticker: 'NVDA', held: false, dates, closes: c, fundScore: 75 },
    { ticker: 'QUIET', held: true, dates: dates.slice(0, 302), closes: shape(2), fundScore: 90 },
  ], 'bull', last, today);
  test('one line per new washout, the day recorded; the next night it is deduped and nothing is sent', async () => {
    const kv = new MemoryPropertyStore(), sent: string[] = [];
    const send = async (l: string): Promise<boolean> => { sent.push(l); return true; };
    assert.deepEqual(await sendWashoutAlerts({ kv, send, log: () => {} }, night()), ['MU', 'NVDA']);
    assert.equal(sent.length, 2); assert.ok(sent.every((l) => l.startsWith('🟢 Washout: ')));
    assert.deepEqual(await readWashoutLast(kv), { MU: today, NVDA: today });
    sent.length = 0;
    assert.deepEqual(await sendWashoutAlerts({ kv, send, log: () => {} }, night(await readWashoutLast(kv))), []);
    assert.equal(sent.length, 0);
  });
  test('a silent night sends nothing and writes nothing; a line that failed to send is not recorded', async () => {
    const kv = new MemoryPropertyStore();
    let calls = 0;
    assert.deepEqual(await sendWashoutAlerts({ kv, send: async () => { calls++; return true; }, log: () => {} }, { hits: [], regime: 'bull' }), []);
    assert.equal(calls, 0); assert.equal(kv.map.size, 0);
    assert.deepEqual(await sendWashoutAlerts({ kv, send: async () => false, log: () => {} }, night()), []);
    assert.equal(await kv.get(WASHOUT_LAST_KEY), null);
    await kv.set(WASHOUT_LAST_KEY, '{oops');
    assert.deepEqual(await readWashoutLast(kv), {});
  });
  test('gather: holdings and watchlist once each (held wins), fundamentals from the engine, the regime from the index', async () => {
    const kv = new MemoryPropertyStore();
    const up = Array.from({ length: 400 }, (_, i) => 100 * 1.001 ** i);
    const n = await gatherWashoutNight({
      held: ['mu'], watchlist: ['MU', 'NVDA', 'NOCHART'], kv, today,
      chart: async (t) => (t === 'NOCHART' ? null : { dates, closes: c }), fundScore: async (t) => (t === 'NVDA' ? null : 80), indexCloses: async () => up,
    }, () => {});
    assert.deepEqual(n.hits.map((h) => [h.ticker, h.held]), [['MU', true]]);
    assert.equal(n.regime, 'bull');
  });
});

describe('profile alerts.washout', () => {
  test('default off; on / off accepted; anything else refused', () => {
    const p = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(p.ok && p.profile.alerts.washout === 'off' && !washoutAlertsOn(p.profile));
    const on = validateProfile({ ...EXAMPLE_PROFILE_INPUT, alerts: { washout: 'on' } });
    assert.ok(on.ok && washoutAlertsOn(on.profile));
    const bad = validateProfile({ ...EXAMPLE_PROFILE_INPUT, alerts: { washout: 'yes' } });
    assert.ok(!bad.ok && bad.errors.includes('alerts.washout must be one of off, on'));
  });
  test('off (the app gives no night): nothing is sent, nothing stored', async () => {
    const kv = new MemoryPropertyStore();
    let calls = 0;
    const tg = { deps: { token: 't', fetchImpl: (async () => { calls++; return new Response('{"ok":true}'); }) as typeof fetch }, chatId: 'c' };
    assert.deepEqual(await runWashoutAlerts({ washout: async () => null }, kv, tg, () => {}), []);
    assert.equal(calls, 0); assert.equal(kv.map.size, 0);
  });
});

describe('Buy report line and dashboard badge', () => {
  test('the Buy report\'s washout line marks that stock on the dashboard; no line, no field', () => {
    const header = [...BUY_TEXT.rankingColumns];
    const grid = [
      ['🟢 Washout: MU closed 2.7 SD under its 20-day average, 41% off its high, long trend still rising — an add level (long-term, no stop). Loan bar: beats QQQ? · market: bull.'],
      header, ['#1 MU', '80', 'Strong', 'ok', '$90 - $100', 'BUY', '', '2026-11-06'], ['#2 AMD', '70', 'Strong', 'ok', '$90 - $100', 'WAIT', '', '2026-11-06'],
    ];
    const items = parseBuyReport(grid as never, new Map());
    assert.equal(items.length, 2);
    assert.match(items.find((x) => x.ticker === 'MU')!.washout!, /^🟢 Washout: MU /);
    assert.equal('washout' in items.find((x) => x.ticker === 'AMD')!, false);
  });
});
