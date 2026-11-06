/**
 * FL-19f (James's models, phase 4): James — LEAPS (plan 03) and James — Option Fair Value (plan 04): James's January
 * pick and its gates, the fire sale and the turnaround (causal), the paper engine's new exits (hold to expiry and
 * exercise, the expiry checklist, the spike trim, the one-contract rule, the delta cap) with the engine twins
 * unchanged, the fair-value tool, the approximate backtester's calendar / strike solver / no lookahead, the history
 * book, the report pages / All Models rows / Bottom Line lines (display only) and the "E James LEAPS" paper accounts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadSeries, type PriceSeries } from '../src/backtest/data.ts';
import { selectJamesLeaps, jamesJanuary, jamesJanuaryDate, jamesCallsOf, breakEvenOf, thirdFriday, attachJamesCalls, jamesCallsOfPick, JAMES_LEAPS, type JamesCall } from '../src/analysis/options/leapsPick.ts';
import { buildLeapsExpiryComparison } from '../src/analysis/options/leapsExpiryTable.ts';
import { marketFireSale, stockFireSale, episodesOf, drawdownSeries, FIRE_SALE_DEFAULT } from '../src/analysis/options/fireSale.ts';
import { fairValueOf, shortCallGuard, scenarioGrid, atmIvOf } from '../src/analysis/options/fairValue.ts';
import { bsGreeks, bsCall } from '../src/analysis/options/blackScholes.ts';
import { normInv, strikeForDelta, simExpiry, simMid, sigmaAt, SIM } from '../src/research/optionsSim.ts';
import { runLeaps, LEAPS_FIRE_DEFAULT } from '../src/research/leapsLab.ts';
import { leapsNight, newLeapsAccount, leapsValue, leapsHeld, type LeapsNight, type LeapsAccount } from '../src/paper/paperLeaps.ts';
import { buildJamesLeapsRead, buildFairValueRead, formatJamesLeapsPage, formatFairValuePage, james4AllModelsRows, james4BottomLines, readJames4Reads, optionsDecisionJamesLines, JAMES4_HISTORY } from '../src/analysis/jamesPhase4Pages.ts';
import { allModelsRows, MODEL_SIMULATION, formatOptionsDecisionPage } from '../src/analysis/reportPages.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS } from '../src/analysis/runTicker.ts';
import { newPaperState, paperDay, accountIds, standings, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_LABEL, JAMES_LEAPS_IDS, JAMES_LEAPS_SETUPS, JAMES_LEAPS_GROUP, labHeld, type JamesNightPick } from '../src/paper/paperLab.ts';
import { bagsOf } from '../src/paper/paperReport.ts';
import { valuesRows } from '../src/paper/paperLog.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import type { CboeChainJson } from '../src/fetch/cboe.ts';
import { RESULTS } from '../src/profile/results.ts';
/** Cases that read a results pack (profile `results`): skipped under a profile that names none (the test profile);
 *  a copy with its own pack runs them with its profile (npm test does not). */
const NEEDS_PACK = RESULTS ? false : 'needs a results pack (the profile names none)';

const DAY = 86_400;
const unix = (d: string): number => Date.parse(d + 'T00:00:00Z') / 1000;
const occ = (t: string, exp: string, k: number): string => t + exp.slice(2, 4) + exp.slice(5, 7) + exp.slice(8, 10) + 'C' + String(Math.round(k * 1000)).padStart(8, '0');
function chainOf(t: string, spot: number, exps: readonly string[], now: number, o: { iv?: number; spread?: number; oi?: number; noDelta?: boolean } = {}): CboeChainJson {
  const options: Array<Record<string, unknown>> = [];
  for (const e of exps) for (let k = Math.round(spot * 0.4); k <= spot * 1.4; k += Math.max(1, Math.round(spot / 50))) {
    const T = (unix(e) - now) / DAY / 365, g = bsGreeks({ S: spot, K: k, T, sigma: o.iv ?? 0.4, r: 0.04 }), mid = bsCall({ S: spot, K: k, T, sigma: o.iv ?? 0.4, r: 0.04 }), h = (o.spread ?? 0.02) / 2;
    options.push({ option: occ(t, e, k), bid: +(mid * (1 - h)).toFixed(2), ask: +(mid * (1 + h)).toFixed(2), iv: o.iv ?? 0.4, delta: o.noDelta ? null : g.delta, open_interest: o.oi ?? 500 });
  }
  return { data: { options: options as never, current_price: spot } };
}
const NOW = unix('2026-10-29') + 21 * 3600;
const mk = (t: string, dates: readonly string[], closes: readonly number[]): PriceSeries => ({ ticker: t, dates, opens: closes, highs: closes, lows: closes, closes, volumes: closes.map(() => 1e6), splits: [] });
function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}

// ─────────────────────────────── the pick ───────────────────────────────

describe('FL-19f — James — LEAPS: the January pick and its gates', () => {
  test('the January closest to 19 months within 13-26 months, for a decision in every month; 29 Oct 2026 -> Jan 2028, 20 Mar 2020 -> Jan 2022; = the expiry table\'s James mark', () => {
    assert.equal(jamesJanuaryDate('2026-10-29'), '2028-01-21');
    assert.equal(jamesJanuaryDate('2020-03-20'), '2022-01-21');
    for (let m = 1; m <= 12; m++) {
      const day = '2027-' + String(m).padStart(2, '0') + '-15', e = jamesJanuaryDate(day)!, months = (unix(e) - unix(day)) / DAY / 30.4375;
      assert.ok(e.slice(5, 7) === '01' && months >= 12.9 && months <= 26.1, day + ' -> ' + e);
      const other = [2028, 2029, 2030].map((y) => thirdFriday(y, 1)).filter((x) => x !== e).map((x) => Math.abs((unix(x) - unix(day)) / DAY / 30.4375 - 19));
      const inWin = [2028, 2029, 2030].map((y) => thirdFriday(y, 1)).filter((x) => { const mm = (unix(x) - unix(day)) / DAY / 30.4375; return mm >= 13 && mm <= 26; });
      if (inWin.length > 1) assert.ok(Math.abs(months - 19) <= Math.min(...other) + 0.5, day);
    }
    assert.equal(thirdFriday(2028, 1), '2028-01-21');
    const json = chainOf('TSLA', 400, ['2027-06-17', '2028-01-21', '2029-01-19'], NOW);
    assert.equal(buildLeapsExpiryComparison(json, NOW * 1000, 'America/New_York')!.jamesExpUnix, jamesJanuary(jamesCallsOf(json).map((c) => c.expUnix), '2026-10-29'));
  });
  test('delta nearest the target (0.60 / 0.75 / 0.85); a missing Cboe delta uses Black-Scholes from the iv; a stored snapshot (no symbol) gives the same contract', () => {
    const json = chainOf('TSLA', 400, ['2028-01-21', '2029-01-19'], NOW), calls = jamesCallsOf(json);
    for (const d of JAMES_LEAPS.deltas) {
      const p = selectJamesLeaps(calls, 400, NOW, '2026-10-29', d);
      assert.equal(p.expUnix, unix('2028-01-21'));
      const best = Math.min(...calls.filter((c) => c.expUnix === p.expUnix).map((c) => Math.abs((c.delta as number) - d)));
      assert.ok(Math.abs(p.nearest!.delta - d) <= best + 1e-12);
      // at 40% IV the 0.60 contract fails the 12%/yr break-even (a near-the-money LEAPS is mostly time value); deeper ones pass
      if (d >= 0.75) assert.ok(p.contract && p.contract.symbol?.startsWith('TSLA280121C'), JSON.stringify(p.reason));
      else assert.match(p.reason ?? '', /break-even/);
    }
    const noD = jamesCallsOf(chainOf('TSLA', 400, ['2028-01-21'], NOW, { noDelta: true }));
    const q = selectJamesLeaps(noD, 400, NOW, '2026-10-29', 0.75);
    assert.equal(q.nearest!.deltaSource, 'black-scholes');
    assert.equal(q.nearest!.strike, selectJamesLeaps(calls, 400, NOW, '2026-10-29', 0.75).nearest!.strike);
    const snap: JamesCall[] = calls.map(({ symbol: _s, ...c }) => c);
    assert.equal(selectJamesLeaps(snap, 400, NOW, '2026-10-29', 0.75).contract!.strike, selectJamesLeaps(calls, 400, NOW, '2026-10-29', 0.75).contract!.strike);
    const pick = attachJamesCalls({ found: true }, calls, 400);
    assert.equal(jamesCallsOfPick(pick)!.calls.length, calls.length);
    assert.equal(JSON.stringify(pick), '{"found":true}', 'non-enumerable: the pick serialises as before');
  });
  test('the break-even gate: GOOG (S 1000, K 1000, ask 190, 672 days) = +19.0%, +9.9% a year: passes at 12%, fails at 8%', () => {
    const b = breakEvenOf(1000, 1000, 190, 672);
    assert.equal(b.breakEven, 1190);
    assert.ok(Math.abs(b.bem - 0.19) < 1e-12 && Math.abs((b.bemYear as number) - 0.099) < 0.001);
    const c: JamesCall = { strike: 1000, expUnix: NOW + 672 * DAY, bid: 188, ask: 190, iv: 0.34, delta: 0.61, oi: 1000 };
    assert.ok(selectJamesLeaps([{ ...c, expUnix: unix('2028-01-21') }], 1000, unix('2028-01-21') - 672 * DAY, '2026-03-19', 0.6, { beGate: 0.12 }).contract);
    assert.equal(selectJamesLeaps([{ ...c, expUnix: unix('2028-01-21') }], 1000, unix('2028-01-21') - 672 * DAY, '2026-03-19', 0.6, { beGate: 0.08 }).contract, null);
  });
  test('liquidity: a zero bid or a wide spread fails and steps to a neighbour within 0.10 delta; nothing passing = "no liquid contract" with the reasons', () => {
    const calls = jamesCallsOf(chainOf('TSLA', 400, ['2028-01-21'], NOW));
    const near = selectJamesLeaps(calls, 400, NOW, '2026-10-29', 0.75).nearest!;
    const broken = calls.map((c) => (c.strike === near.strike ? { ...c, bid: 0 } : c));
    const p = selectJamesLeaps(broken, 400, NOW, '2026-10-29', 0.75);
    assert.notEqual(p.contract!.strike, near.strike);
    assert.ok(Math.abs(p.contract!.delta - 0.75) <= 0.1);
    const wide = jamesCallsOf(chainOf('TSLA', 400, ['2028-01-21'], NOW, { spread: 0.3 }));
    const w = selectJamesLeaps(wide, 400, NOW, '2026-10-29', 0.75);
    assert.equal(w.contract, null);
    assert.match(w.reason!, /^no liquid contract: .*spread/);
    assert.match(selectJamesLeaps(jamesCallsOf(chainOf('TSLA', 400, ['2028-01-21'], NOW, { oi: 10 })), 400, NOW, '2026-10-29', 0.75).reason!, /open interest/);
    assert.equal(selectJamesLeaps([], 400, NOW, '2026-10-29', 0.75).reason, 'no chain');
  });
});

// ─────────────────────────────── the fire sale ───────────────────────────────

describe('FL-19f — the fire sale and the turnaround (causal)', () => {
  const flat = (n: number, v: number): number[] => Array(n).fill(v) as number[];
  test('market: 20% under the 52-week high triggers, 19.9% does not; on the real QQQ, 2022-2023 is one episode and the 2010-2026 episodes are Dec 2018, Mar-Apr 2020, 2022-23, Apr 2025', () => {
    assert.equal(marketFireSale([...flat(10, 100), 80])[10]!.on, true);
    assert.equal(marketFireSale([...flat(10, 100), 80.1])[10]!.on, false);
    const q = loadSeries('QQQ'), eps = episodesOf(marketFireSale(q.closes)).map((e) => q.dates[e.start]!).filter((d) => d >= '2010');
    assert.deepEqual(eps.map((d) => d.slice(0, 7)), ['2018-12', '2020-03', '2022-03', '2025-04']);
    const m = marketFireSale(q.closes), a = q.dates.indexOf('2022-05-05'), b = q.dates.indexOf('2023-01-31');
    assert.equal(m[a]!.episode, m[b]!.episode);
  });
  test('stock: 40% under its high with a -2 SD close arms; the default waits for a close above the 20-day average; "none" buys on the signal; the window disarms; causal', () => {
    const c = [...flat(60, 100), ...Array.from({ length: 10 }, (_, i) => 95 - i * 4), 55, 54, 53, 54, 53, 52, 60, 65, 70, 75, 80, 85];
    const a = stockFireSale(c), i0 = a.findIndex((x) => x.signal);
    assert.ok(i0 > 0 && a[i0]!.dd >= 0.4 && a[i0]!.armedSince === i0 && !a[i0]!.buy);
    const buyAt = a.findIndex((x) => x.buy);
    assert.ok(buyAt > i0 && c[buyAt]! > (a[buyAt]!.sma20 as number), 'a close back above the 20-day average');
    assert.ok(stockFireSale(c, { ...FIRE_SALE_DEFAULT, turnaround: 'none' })[i0]!.buy);
    const never = [...c.slice(0, i0 + 1), ...flat(30, c[i0]! - 1)];
    const n = stockFireSale(never, { ...FIRE_SALE_DEFAULT, window: 5 });
    assert.ok(!n.some((x) => x.buy) && n[i0 + 6]!.armedSince == null, 'the window ran out');
    // causal: changing the future leaves the past unchanged
    const t = loadSeries('TSLA'), k = 2500, cut = stockFireSale(t.closes.slice(0, k + 1)), full = stockFireSale(t.closes);
    assert.deepEqual(cut[k], full[k]);
    assert.deepEqual(marketFireSale(t.closes.slice(0, k + 1))[k], marketFireSale(t.closes)[k]);
    assert.ok(Math.abs(drawdownSeries([100, 120, 90])[2]! - 0.25) < 1e-12);
  });
});

// ─────────────────────────────── the paper engine ───────────────────────────────

describe('FL-19f — paperLeaps: the new exits; the engine twins unchanged', () => {
  const exp = unix('2028-01-21'), now = unix('2026-10-28');
  const pick = { symbol: 'NVDA280121C00100000', strike: 100, expUnix: exp, bid: 49, ask: 50 };
  const night = (o: Partial<LeapsNight>): LeapsNight => ({ qqq: { open: 500, close: 500 }, quote: () => ({ bid: 51, ask: 52 }), pick: () => pick, nowUnix: now, want: new Set(['NVDA']), slots: 3, fill: true, decide: true, ...o });
  test('no options = the engine twins exactly (trades, state, JSON keys)', () => {
    const a = newLeapsAccount(100_000), b = newLeapsAccount(100_000);
    const seq: Array<Partial<LeapsNight>> = [{ fill: false }, {}, { nowUnix: exp - 59 * DAY }, { nowUnix: exp - 58 * DAY, quote: () => ({ bid: 70, ask: 71 }), want: new Set() }];
    for (const x of seq) assert.deepEqual(leapsNight(a, night(x)), leapsNight(b, night(x), {}));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(Object.keys(a).sort(), ['cash', 'held', 'orders', 'qqq']);
  });
  test('hold to expiry: no 60-day sale; the checklist holds the cash back; ITM by $0.01 at the close exercises (cost basis strike + premium), $0.00 expires worthless; the shares follow the armed trend-200 sell', () => {
    const run = (close: number): { a: LeapsAccount; t: ReturnType<typeof leapsNight> } => {
      const a = newLeapsAccount(100_000), o = { exit: 'expiry' as const };
      const n = (x: Partial<LeapsNight>): LeapsNight => night({ stock: () => ({ open: close, close }), ...x });
      leapsNight(a, n({ fill: false }), o); leapsNight(a, n({}), o);
      leapsNight(a, n({ nowUnix: exp - 30 * DAY }), o);
      assert.ok(!a.orders.length, 'no sale at 60 days');
      leapsNight(a, n({ nowUnix: exp - 6 * DAY }), o);
      if (close > 100) assert.equal(a.reserve, 100 * 100 * a.held[0]!.contracts, 'the exercise cash is held back');
      const t = leapsNight(a, n({ nowUnix: exp + 20 * 3600 }), o);
      return { a, t };
    };
    const itm = run(100.01);
    assert.equal(itm.a.held.length, 0);
    assert.equal(itm.a.shares!.NVDA!.shares, 600);
    assert.equal(itm.a.shares!.NVDA!.cost, 600 * 100 + 6 * 52 * 100);
    assert.ok(itm.t.some((x) => x.why.startsWith('exercised at expiry')));
    assert.ok(leapsHeld(itm.a).includes('NVDA (shares)'));
    const otm = run(100);
    assert.ok(!otm.a.shares?.NVDA && otm.t.some((x) => x.why.startsWith('expired worthless')));
    // the shares: not sold while the trend is broken before it was ever above (armed); sold once armed and broken
    const a = itm.a, o = { exit: 'expiry' as const };
    leapsNight(a, night({ nowUnix: exp + 2 * DAY, stock: () => ({ open: 90, close: 90 }), trend: () => ({ above: false, broken: true }) }), o);
    assert.deepEqual(a.shareSells ?? [], []);
    leapsNight(a, night({ nowUnix: exp + 3 * DAY, stock: () => ({ open: 120, close: 120 }), trend: () => ({ above: true, broken: false }) }), o);
    leapsNight(a, night({ nowUnix: exp + 4 * DAY, stock: () => ({ open: 95, close: 95 }), trend: () => ({ above: false, broken: true }) }), o);
    const s = leapsNight(a, night({ nowUnix: exp + 5 * DAY, stock: () => ({ open: 94, close: 94 }), trend: () => ({ above: false, broken: true }) }), o);
    assert.ok(s.some((x) => x.ticker === 'NVDA' && x.side === 'SELL' && x.price === 94));
    assert.ok(leapsValue(a, 500, () => 94) > 0);
  });
  test('the checklist sells the contracts that cannot be covered (5 days before), and the one-contract rule and the delta cap', () => {
    const a = newLeapsAccount(100_000), o = { exit: 'expiry' as const };
    const n = (x: Partial<LeapsNight>): LeapsNight => night({ stock: () => ({ open: 300, close: 300 }), ...x });
    leapsNight(a, n({ fill: false }), o); leapsNight(a, n({}), o);
    a.cash = 1_000; a.qqq = { shares: 0, cost: 0 };
    leapsNight(a, n({ nowUnix: exp - 6 * DAY }), o);
    const sell = a.orders.find((x) => x.side === 'SELL')!;
    assert.ok(sell.partial && sell.contracts === a.held[0]!.contracts, 'nothing can be covered: every contract is sold to close early');
    // one contract up to 1.5 x a slot
    const big = { ...pick, ask: 400, bid: 399 };
    const b = newLeapsAccount(100_000);
    leapsNight(b, night({ fill: false, pick: () => big }), {});
    assert.equal(b.orders.length, 0, '$40,000 a contract > a $33,333 slot');
    leapsNight(b, night({ fill: false, pick: () => big }), { onePlus: 1.5 });
    assert.equal(b.orders[0]!.contracts, 1);
    // the delta cap: exposure after the buy within 1.0 x equity
    const c = newLeapsAccount(100_000);
    leapsNight(c, night({ fill: false, want: new Set(['NVDA', 'AMD', 'MQZC']), pick: (t) => ({ ...pick, symbol: t, delta: 0.8 }), stock: () => ({ open: 150, close: 150 }) }), { deltaCap: 1 });
    const ex = c.orders.reduce((s, x) => s + x.contracts * 100 * 0.8 * 150, 0);
    assert.ok(ex <= 100_000 + 1e-6 && ex > 50_000, String(ex));
  });
  test('X4: a third on a +2 SD close, not again within 60 days', () => {
    const a = newLeapsAccount(100_000), o = { trim: true };
    leapsNight(a, night({ fill: false }), o); leapsNight(a, night({}), o);
    leapsNight(a, night({ nowUnix: now + 10 * DAY, spike: () => true }), o);
    assert.equal(a.orders[0]!.contracts, 2);
    leapsNight(a, night({ nowUnix: now + 11 * DAY, spike: () => false }), o);
    assert.equal(a.held[0]!.contracts, 4);
    leapsNight(a, night({ nowUnix: now + 40 * DAY, spike: () => true }), o);
    assert.equal(a.orders.length, 0, 'within 60 days');
  });
});

// ─────────────────────────────── model 4 ───────────────────────────────

describe('FL-19f — James — Option Fair Value and the approximate backtester', () => {
  test('fair value of the GOOG point: break-even 1190, +19.0%, +9.9% a year, time value 19% of the price, time cost per delta about 17% a year', () => {
    const exp = NOW + 672 * DAY, f = fairValueOf({ strike: 1000, expUnix: exp, bid: 190, ask: 190, iv: 0.34, delta: 0.61 }, 1000, NOW, { rv20: null, rv60: 0.513, rv252: 0.325 }, 0.01);
    assert.equal(f.breakEven, 1190);
    assert.ok(Math.abs((f.moveNeeded as number) - 0.19) < 1e-12 && Math.abs((f.moveNeededPerYear as number) - 0.099) < 0.001);
    assert.ok(Math.abs((f.tvPct as number) - 0.19) < 1e-12);
    assert.ok(Math.abs((f.yearlyTimeCostPerDelta as number) - 0.169) < 0.002);
    assert.equal(f.refName, 'RV252');
    assert.ok(Math.abs((f.rich as number) - (190 / bsCall({ S: 1000, K: 1000, T: 672 / 365, sigma: 0.325, r: 0.01 }) - 1)) < 1e-9 && !f.richFlag);
    assert.ok(Math.abs((f.impliedFromMid as number) - 0.34) < 0.002);
    assert.equal(atmIvOf([{ strike: 90, expUnix: 1, iv: 0.3 }, { strike: 110, expUnix: 1, iv: 0.5 }], 1, 100), 0.4);
    assert.equal(scenarioGrid({ strike: 100, expUnix: NOW + 400 * DAY }, 100, NOW, 0.4, 0.04).length, 3);
  });
  test('the short-term guard: z 2.0 blocks, 1.99 does not; earnings in 5 trading days blocks, 6 does not; no date = "unknown", not "clear"', () => {
    assert.equal(shortCallGuard({ z: 2, tradingDaysToEarnings: 10 }).ok, false);
    assert.equal(shortCallGuard({ z: 1.99, tradingDaysToEarnings: 10 }).ok, true);
    assert.equal(shortCallGuard({ z: 0, tradingDaysToEarnings: 5 }).ok, false);
    assert.equal(shortCallGuard({ z: 0, tradingDaysToEarnings: 6 }).ok, true);
    assert.equal(shortCallGuard({ z: 0, tradingDaysToEarnings: null }).earnings, 'unknown');
  });
  test('backtester: the January third Fridays 2020-2030; the strike-for-delta solver hits the target; the engine\'s expiry; no lookahead', () => {
    for (let y = 2020; y <= 2030; y++) { const d = new Date(thirdFriday(y, 1) + 'T00:00:00Z'); assert.equal(d.getUTCDay(), 5); assert.ok(d.getUTCDate() >= 15 && d.getUTCDate() <= 21); }
    assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
    for (const dl of [0.6, 0.75, 0.85]) { const K = strikeForDelta(100, 1.5, 0.45, 0.03, dl); assert.ok(Math.abs(bsGreeks({ S: 100, K, T: 1.5, sigma: 0.45, r: 0.03 }).delta - dl) < 0.005); }
    assert.equal(simExpiry('2026-10-29', 'james'), '2028-01-21');
    assert.equal(simExpiry('2026-10-29', 'engine'), '2029-01-19');
    const s = loadSeries('NVDA'), i = 3000, cut: PriceSeries = { ...s, dates: s.dates.slice(0, i + 1), opens: s.opens.slice(0, i + 1), highs: s.highs.slice(0, i + 1), lows: s.lows.slice(0, i + 1), closes: s.closes.slice(0, i + 1), volumes: s.volumes.slice(0, i + 1) };
    const p = { k: 1, h: 0.03, floor: SIM.floor };
    assert.equal(sigmaAt(cut, i, p), sigmaAt(s, i, p));
    assert.equal(simMid(s.closes[i]!, s.closes[i]!, s.dates[i]!, jamesJanuaryDate(s.dates[i]!)!, sigmaAt(s, i, p)!), simMid(cut.closes[i]!, cut.closes[i]!, cut.dates[i]!, jamesJanuaryDate(cut.dates[i]!)!, sigmaAt(cut, i, p)!));
  });
  test('the history book: shares and synthetic LEAPS on the same decisions; the market episodes buy once per stock; a twin buys what its model holds', () => {
    const bag = ['NVDA', 'AMD', 'MQZC', 'TSLA'], series = new Map(bag.map((t) => [t, loadSeries(t)])), qqq = loadSeries('QQQ');
    const sh = runLeaps(bag, { series, qqq }, '2020-01-01', '2021-12-31', { ...LEAPS_FIRE_DEFAULT, instrument: 'shares', stock: false });
    const mk2020 = sh.entries.filter((e) => e.kind === 'market');
    assert.ok(mk2020.length >= 3 && mk2020.every((e) => e.day.startsWith('2020-03') || e.day.startsWith('2020-04')));
    assert.equal(new Set(mk2020.map((e) => e.t)).size, mk2020.length, 'one buy per stock per episode');
    const lp = runLeaps(bag, { series, qqq }, '2020-01-01', '2021-12-31', { ...LEAPS_FIRE_DEFAULT, stock: false, exit: 'roll60' });
    assert.deepEqual(lp.entries.filter((e) => e.kind === 'market').map((e) => e.day + e.t), mk2020.map((e) => e.day + e.t));
    assert.ok(lp.daysInLeapsPct > 50 && lp.peakExposure > 1);
    const cap = runLeaps(bag, { series, qqq }, '2020-01-01', '2021-12-31', { ...LEAPS_FIRE_DEFAULT, stock: false, deltaCap: 1 });
    assert.ok(cap.peakExposure <= 1.25, String(cap.peakExposure));
    const want = new Map(qqq.dates.filter((d) => d >= '2021-01-01' && d <= '2021-06-30').map((d) => [d, new Set(['NVDA'])]));
    const tw = runLeaps(bag, { series, qqq }, '2021-01-01', '2021-06-30', { ...LEAPS_FIRE_DEFAULT, entry: 'twin', want, exit: 'roll60', slots: 3 });
    assert.deepEqual([...new Set(tw.entries.map((e) => e.t))], ['NVDA']);
  });
});

// ─────────────────────────────── pages ───────────────────────────────

describe('FL-19f — the phase-4 report pages (display only)', () => {
  const D = datesTo('2026-10-29', 300);
  const up = D.map((_, i) => 100 + i * 0.2), crash = D.map((_, i) => (i < 250 ? 100 + i * 0.2 : i < 291 ? 150 - (i - 249) : 109 - (i - 290) * 6));
  const chain = { calls: jamesCallsOf(chainOf('TSLA', 150, ['2028-01-21', '2029-01-19'], NOW)), spot: 150 };
  test('every verdict word for its case; disclaimer; "James — " on both pages; the tabs follow 📞 Options Decision', { skip: NEEDS_PACK }, () => {
    const calm = buildJamesLeapsRead({ dates: D, closes: up }, { dates: D, closes: up }, chain, NOW * 1000, true);
    assert.equal(calm.verdict, 'WAIT FOR A FIRE SALE');
    assert.equal(buildJamesLeapsRead({ dates: D, closes: up }, { dates: D, closes: crash }, chain, NOW * 1000, true).verdict, 'BUY (market fire sale, gates pass)');
    assert.equal(buildJamesLeapsRead({ dates: D, closes: up }, { dates: D, closes: up }, null, NOW * 1000, false).verdict, 'NO CHAIN');
    const armed = buildJamesLeapsRead({ dates: D, closes: crash }, { dates: D, closes: up }, chain, NOW * 1000, true);
    assert.equal(armed.verdict, 'WAIT FOR TURNAROUND');
    const thin = { calls: jamesCallsOf(chainOf('TSLA', 150, ['2028-01-21'], NOW, { spread: 0.4 })), spot: 150 };
    assert.equal(buildJamesLeapsRead({ dates: D, closes: up }, { dates: D, closes: crash }, thin, NOW * 1000, true).verdict, 'NO LIQUID CONTRACT');
    const page = formatJamesLeapsPage('TSLA', calm);
    assert.match(page, /James — LEAPS/); assert.match(page, /Shown for information only/); assert.match(page, /Jan-2028/); assert.match(page, /0\.85/);
    assert.match(page, new RegExp(JAMES4_HISTORY!.leapsCap.replace(/[+/]/g, '\\$&')));
    const fair = buildFairValueRead({ dates: D, closes: up }, null, null, calm, chain, NOW * 1000, 0.04);
    const fp = formatFairValuePage('TSLA', fair);
    assert.match(fp, /James — Option Fair Value/); assert.match(fp, /JAMES — LEAPS 0\.75/); assert.match(fp, /IV RANK: collecting/); assert.match(fp, /at expiry/);
    const o = reportTabOrder();
    assert.equal(o[o.indexOf(MODEL_TABS.optionsDecision) + 1], '🎯 James — LEAPS');
    assert.equal(o[o.indexOf(MODEL_TABS.optionsDecision) + 2], '⚖️ James — Option Fair Value');
  });
  test('📞 Options Decision: unchanged without the read; one numbered block at the end with it; All Models rows and Bottom Line lines', () => {
    const base = { ticker: 'TSLA', leapsCall: { found: false, reason: 'no chain data returned for TSLA' }, shortTermCall: null, decision: null, techPlan: null, fund: null, confluence: null, flow: null, nowMs: NOW * 1000, timeZone: 'America/New_York' } as const;
    const read = buildJamesLeapsRead({ dates: D, closes: up }, { dates: D, closes: up }, chain, NOW * 1000, true);
    const a = formatOptionsDecisionPage(base), b = formatOptionsDecisionPage({ ...base, jamesLeaps: read });
    assert.equal(formatOptionsDecisionPage({ ...base, jamesLeaps: null }), a);
    assert.ok(b.includes('. JAMES — LEAPS (model 3, display only): WAIT FOR A FIRE SALE'));
    assert.equal(b.replace(/\n\n\d+\. JAMES — LEAPS[^\n]*/, ''), a);
    assert.deepEqual(optionsDecisionJamesLines(null, 3), []);
    const j = { leaps: read, fair: buildFairValueRead({ dates: D, closes: up }, null, null, read, chain, NOW * 1000, 0.04) };
    assert.ok(readJames4Reads(JSON.parse(JSON.stringify(j))));
    assert.equal(readJames4Reads({ leaps: {} }), null);
    const rows = allModelsRows({ decision: null, techPlan: null, fund: null, comparison: null, extra: null, lilo: null, james4: j });
    const r = rows.filter((x) => x.key.startsWith('JAMES_'));
    assert.deepEqual(r.map((x) => x.key), ['JAMES_LEAPS', 'JAMES_FAIR_VALUE']);
    assert.equal(r[0]!.read, 'Wait for a fire sale');
    assert.equal(r[0]!.history, MODEL_SIMULATION.JAMES_LEAPS!.history);
    assert.ok(james4AllModelsRows(null).every((x) => x.read === 'Not available'));
    assert.deepEqual(james4BottomLines(j)[0], ['🎯 James — LEAPS', 'WAIT FOR A FIRE SALE']);
    assert.ok(!allModelsRows({ decision: null, techPlan: null, fund: null, comparison: null, extra: null, lilo: null }).some((x) => x.key.startsWith('JAMES_L')));
  });
});

// ─────────────────────────────── paper ───────────────────────────────

describe('FL-19f — the "E James LEAPS" paper accounts', () => {
  const D = datesTo('2026-11-04', 400);
  const CL = (k: number): number[] => D.map((_, i) => 50 + i * 0.1 * (1 + (k % 4) * 0.2) + 3 * Math.sin(i / (6 + k)));
  const qq = D.map((_, i) => (i < 390 ? 400 + i * 0.3 : 517 - (i - 389) * 14));
  const tickers = [...PAPER_OWNER_LIST, 'QQQ'];
  const series = new Map(tickers.map((t, k) => [t, t === 'QQQ' ? mk(t, D, qq) : mk(t, D, CL(k))]));
  const PD = D.slice(-5);
  const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
  const read = (ticker: string): EngineRead => ({ ticker, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90, ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: {}, close: 100 });
  const exp = unix('2028-01-21');
  const jamesPick = (t: string, delta: number): JamesNightPick => ({ symbol: t + '-J' + delta, strike: 40, expUnix: exp, bid: 20, ask: 20.4, delta, iv: 0.4, why: 'Jan-2028 $40 call' });
  const input = (n: number): PaperDayInput => {
    const d = PD[n]!, i = D.indexOf(d);
    return {
      day: d, reads: [], exitRead: noExit, bars: Object.fromEntries(tickers.map((t) => [t, { open: series.get(t)!.opens[i]!, close: series.get(t)!.closes[i]! }])),
      lab: { reads: PAPER_OWNER_LIST.map(read), series, long: series, options: { quote: () => ({ bid: 20, ask: 20.4 }), pick: () => null, nowUnix: unix(d) + 21 * 3600, jamesPick } },
    };
  };
  test('they join on the first night (group E, "James — "), buy in the market fire sale once per stock per episode, and are judged against QQQ since they joined', () => {
    assert.equal(JAMES_LEAPS_IDS.length, 9);
    let s = newPaperState(['TSLA']);
    paperDay(s, input(0));
    for (const id of JAMES_LEAPS_IDS) { assert.ok(LAB_LABEL[id]!.startsWith('James — '), id); assert.ok(accountIds(s).includes(id), id); assert.ok(s.joins![id], id); }
    s = JSON.parse(JSON.stringify(s));
    for (let n = 1; n < 5; n++) paperDay(s, input(n));
    const fire = s.lab!.leaps!['james.leaps.fire.d75']!;
    assert.ok(fire.held.length >= 1 && fire.held.length <= 5, 'bought in the fire sale, at most 5 slots: ' + fire.held.length);
    const mem = s.lab!.jamesLeapsBought!['james.leaps.fire.d75']!;
    assert.ok(Object.keys(mem).length >= fire.held.length);
    const cap = s.lab!.leaps!['james.leaps.fire.d75.cap']!;
    const ex = cap.held.reduce((x, h) => x + h.contracts * 100 * (h.delta ?? 0.75) * (series.get(h.ticker)!.closes.at(-1) as number), 0);
    assert.ok(ex <= 1.25 * 100_000, 'the capped account stays near 1 x equity: ' + ex);
    assert.ok(s.lab!.leaps!['james.leaps.fire.d60']!.held.every((h) => h.symbol.endsWith('0.6')));
    const names = JAMES_LEAPS_IDS.map((id) => LAB_LABEL[id]), st = standings(s).filter((r) => names.includes(r.name));
    assert.equal(st.length, 9);
    assert.ok(st.every((r) => r.qqqSinceJoined != null && !r.bench));
    const v = valuesRows(s, PD[4]!).filter((r) => r[2] === JAMES_LEAPS_GROUP);
    assert.equal(v.length, 9);
    assert.equal(bagsOf(s, (t) => series.get(t)?.closes.at(-1) ?? null).filter((b) => b.group === JAMES_LEAPS_GROUP).length, 9);
    assert.ok(labHeld(s.lab!, 'james.leaps.fire.d75').some((x) => x.includes(' call ')));
    assert.ok(JSON.stringify(s).length < 2_000_000);
    assert.deepEqual(JAMES_LEAPS_SETUPS.filter((x) => x.entry === 'fire').map((x) => x.slots), [5, 5, 5, 5, 5, 5, 5]);
  });
});
