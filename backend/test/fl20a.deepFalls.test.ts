/**
 * FL-20a (row 42, the deep falls; docs/models/results/deep-falls.md): the fall-cutting overlays on runPortfolio
 * (research/fallOverlay.ts). Absent or never triggered = the host exactly; the market cut at 0% = the existing
 * 'exitAll' market filter on the 200-day; the market cut at 50% keeps half the book in cash while QQQ is down; the
 * ATR stop sells after a drop and blocks the rebuy for 20 days; the position cap trims a runaway winner; the vol target
 * scales the book down; the helpers (ATR, volatility, scale steps, the drawdown brake, the Calmar choice, the pass rule)
 * and the pre-registered list.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PriceSeries } from '../src/backtest/data.ts';
import { runPortfolio, type PortfolioInput, type PortfolioOptions } from '../src/research/portfolioLab.ts';
import { atrSeries, annualVol, volScale, bookReturns, newDdBrake, ddStep, chooseByCalmar, passRule, FALL_CANDIDATES } from '../src/research/fallOverlay.ts';
import { DF_HOSTS } from '../src/research/deepFallsCli.ts';

function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const mk = (t: string, dates: readonly string[], closes: readonly number[]): PriceSeries =>
  ({ ticker: t, dates, opens: closes, highs: closes, lows: closes, closes, volumes: closes.map(() => 2e6), splits: [] } as unknown as PriceSeries);

const D = datesTo('2021-12-31', 520);
// QQQ: up for 300 days, then down hard for 120, then up again
const qPath = D.map((_, i) => (i < 300 ? 100 + i * 0.2 : i < 420 ? 160 - (i - 300) * 0.5 : 100 + (i - 420) * 0.6));
const Q = mk('QQQ', D, qPath);
const A = mk('AAA', D, D.map((_, i) => 50 + i * 0.5));
const start = D[260]!, end = D.at(-1)!;
const base: PortfolioOptions = { slots: 1, cash: 100_000, trendDays: 200 };
const inpA: PortfolioInput = { series: new Map([['AAA', A]]), reads: new Map(), qqq: Q };

describe('FL-20a — fall overlays in runPortfolio', () => {
  test('absent = unchanged; overlays that never trigger give the host exactly (and carry fall stats)', () => {
    const h = runPortfolio('trend', ['AAA'], inpA, start, end, base);
    assert.equal(h.fallStats, undefined);
    for (const ov of [{ kind: 'cap', w: 10 }, { kind: 'dd', y: 0.99 }] as const) {
      const r = runPortfolio('trend', ['AAA'], inpA, start, end, { ...base, fallOverlay: ov });
      assert.equal(r.finalTaxed, h.finalTaxed, ov.kind); assert.equal(r.trades, h.trades); assert.equal(r.maxDrawdownPct, h.maxDrawdownPct);
      assert.ok(r.fallStats); assert.equal(r.fallStats!.rescales, 0); assert.equal(r.fallStats!.trims, 0);
    }
  });
  test('market cut at 0% = the existing exitAll market filter on the 200-day', () => {
    const a = runPortfolio('trend', ['AAA'], inpA, start, end, { ...base, marketFilter: 'exitAll', marketDays: 200 });
    const b = runPortfolio('trend', ['AAA'], inpA, start, end, { ...base, fallOverlay: { kind: 'mkt', x: 0 } });
    assert.equal(b.finalTaxed, a.finalTaxed); assert.equal(b.maxDrawdownPct, a.maxDrawdownPct);
    assert.ok(b.fallStats!.rescales >= 1, 'cut when QQQ turned down');
  });
  test('market cut at 50%: about half the account in cash while QQQ is down, none before', () => {
    const r = runPortfolio('trend', ['AAA'], inpA, start, end, { ...base, fallOverlay: { kind: 'mkt', x: 0.5 } });
    const shares = [...r.cashShareByDay.values()];
    assert.ok(Math.max(...shares) > 0.45 && Math.max(...shares) < 0.6, 'max cash share ' + Math.max(...shares));
    assert.ok((r.cashShareByDay.get(D[280]!) ?? 1) < 0.05, 'no cash before the market turns down');
    assert.ok(r.fallStats!.scaledDaysPct > 5);
  });
  test('ATR stop: sold after a sharp drop, no rebuy for 20 trading days', () => {
    // up 0.5 a day, a 25% drop on day 330, then up again (the 200-day trend stays up, so only the stop sells)
    const closes = D.map((_, i) => { const up = 50 + i * 0.5; return i < 330 ? up : up * 0.75 + (i - 330) * 0.6; });
    const S = mk('AAA', D, closes);
    const inp: PortfolioInput = { series: new Map([['AAA', S]]), reads: new Map(), qqq: mk('QQQ', D, D.map((_, i) => 100 + i * 0.1)) };
    const held: string[] = [];
    const r = runPortfolio('trend', ['AAA'], inp, start, end, { ...base, fallOverlay: { kind: 'atr', k: 4 }, onDecide: (d, want) => { if (want.includes('AAA')) held.push(d); } });
    assert.ok(r.fallStats!.stops >= 1);
    const iStop = D.indexOf(D[330]!);
    const gap = held.filter((d) => D.indexOf(d) >= iStop);
    assert.ok(gap.length > 0, 'bought back later');
    assert.ok(D.indexOf(gap[0]!) - iStop >= 20, 'rebuy at least 20 days after the stop: ' + (D.indexOf(gap[0]!) - iStop));
    const h = runPortfolio('trend', ['AAA'], inp, start, end, base);
    assert.equal(h.buysByTicker.get('AAA'), 1, 'the host never sold');
  });
  test('position cap: a runaway winner is trimmed back to one slot; the cash goes to QQQ', () => {
    const W = mk('WWW', D, D.map((_, i) => 10 * 1.01 ** i)), F = mk('FFF', D, D.map((_, i) => 50 + i * 0.05));
    const inp: PortfolioInput = { series: new Map([['WWW', W], ['FFF', F]]), reads: new Map(), qqq: mk('QQQ', D, D.map((_, i) => 100 + i * 0.1)) };
    const o: PortfolioOptions = { slots: 2, cash: 100_000, trendDays: 200 };
    const h = runPortfolio('trend', ['WWW', 'FFF'], inp, start, end, o), r = runPortfolio('trend', ['WWW', 'FFF'], inp, start, end, { ...o, fallOverlay: { kind: 'cap', w: 0.6 } });
    assert.ok(r.fallStats!.trims > 0);
    assert.ok(r.qqqShare > h.qqqShare, 'trimmed money parked in QQQ');
    assert.ok(r.finalTaxed < h.finalTaxed, 'trimming the winner costs return here');
  });
  test('vol target: a wild stock scales the book down (cash on scaled days)', () => {
    const V = mk('VVV', D, D.map((_, i) => (50 + i * 0.4) * (i % 2 ? 1.06 : 0.94)));
    const inp: PortfolioInput = { series: new Map([['VVV', V]]), reads: new Map(), qqq: mk('QQQ', D, D.map((_, i) => 100 + i * 0.1)) };
    const r = runPortfolio('trend', ['VVV'], inp, start, end, { ...base, fallOverlay: { kind: 'vol', target: 0.4 } });
    assert.ok(r.fallStats!.scaledDaysPct > 50, 'scaled ' + r.fallStats!.scaledDaysPct);
    assert.ok(Math.max(...r.cashShareByDay.values()) > 0.5);
  });
});

describe('FL-20a — helpers, the choice and the pass rule', () => {
  test('ATR: simple average true range with gaps', () => {
    const s = { ...mk('X', ['a', 'b', 'c', 'd'], [10, 12, 9, 9]), highs: [11, 13, 10, 10], lows: [9, 11, 8, 8] } as unknown as PriceSeries;
    const a = atrSeries(s, 2);
    assert.ok(Number.isNaN(a[0]!));
    assert.equal(a[1], (2 + 3) / 2); // TR b = max(2, |13-10|, |11-10|) = 3
    assert.equal(a[2], (3 + 4) / 2); // TR c = max(2, |10-12|, |8-12|) = 4
    assert.equal(a[3], (4 + 2) / 2);
  });
  test('volatility, scale steps, book returns', () => {
    assert.equal(annualVol([0.01]), 0);
    assert.ok(Math.abs(annualVol([0.01, -0.01, 0.01, -0.01]) - Math.sqrt((4 * 0.0001) / 3 * 252)) < 1e-12);
    assert.equal(volScale(0.4, 0.2), 1); assert.equal(volScale(0.4, 0.8), 0.5); assert.equal(volScale(0.4, 0.7), 0.5); assert.equal(volScale(0.3, 3), 0.25); assert.equal(volScale(0.4, 0), 1);
    const X = mk('X', ['a', 'b', 'c'], [100, 110, 99]), Y = mk('Y', ['a', 'b', 'c'], [10, 10, 10]);
    const ix = (t: string, d: string): number => ['a', 'b', 'c'].indexOf(d);
    const r = bookReturns(new Map([['X', 300], ['Y', 100]]), (t) => (t === 'X' ? X : Y), ix, 'c', 2);
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0]! - 0.75 * 0.1) < 1e-12 && Math.abs(r[1]! - 0.75 * -0.1) < 1e-12);
  });
  test('drawdown brake: on at -Y from the high, off above the account\'s own average (high reset)', () => {
    const b = newDdBrake();
    assert.equal(ddStep(b, 100, 0.2, 3), false);
    assert.equal(ddStep(b, 85, 0.2, 3), false);
    assert.equal(ddStep(b, 80, 0.2, 3), true, '-20%');
    assert.equal(ddStep(b, 78, 0.2, 3), true, 'still under the 3-day average');
    assert.equal(ddStep(b, 90, 0.2, 3), false, 'above the average (82.7)');
    assert.equal(b.peak, 90);
  });
  test('the Calmar choice and the pass rule', () => {
    assert.equal(chooseByCalmar([{ finalTaxed: 300_000, maxDrawdownPct: 50 }, { finalTaxed: 250_000, maxDrawdownPct: 30 }, { finalTaxed: 250_000, maxDrawdownPct: 30.0001 }], 100_000, 10), 1);
    const host = { finals: [1_000_000, 389_000, 411_000], fall: 57 };
    const yard = [0, 287_000, 390_000];
    assert.deepEqual(passRule({ cand: { finals: [500_000, 370_000, 400_000], fall: 42 }, host, yardMax: yard, cash: 100_000 }), { shallower: true, kept: true, beats: true, pass: true });
    assert.equal(passRule({ cand: { finals: [500_000, 370_000, 400_000], fall: 43 }, host, yardMax: yard, cash: 100_000 }).shallower, false);
    assert.equal(passRule({ cand: { finals: [500_000, 350_000, 400_000], fall: 40 }, host, yardMax: yard, cash: 100_000 }).kept, false, '+250% < 90% of +289%');
    assert.equal(passRule({ cand: { finals: [500_000, 370_000, 385_000], fall: 40 }, host, yardMax: yard, cash: 100_000 }).beats, false);
  });
  test('the pre-registered list: 5 overlays x 3 settings, the two hosts', () => {
    assert.equal(FALL_CANDIDATES.length, 15);
    for (const f of ['MKT', 'DD', 'VOL', 'CAP', 'ATR']) assert.equal(FALL_CANDIDATES.filter((c) => c.family === f).length, 3);
    assert.deepEqual(DF_HOSTS.map((h) => h.key), ['combo', 'trend200']);
  });
});
