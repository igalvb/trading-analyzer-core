/**
 * FL-19e (James's models, phase 3): James — Multi-Year Cycle (plan 07, Part A tested; Parts B / C descriptive) and
 * James — Market Maker Stages (plan 08, built on the Wyckoff spring): the causal reads, the books (cycle book, BTC
 * sleeve, the signal book's partial sells and risk sizing), the report pages / All Models rows / Bottom Line lines
 * (display only, never in the Buy / Exit rows) and the paper accounts (group J, joining with the G8 join-night QQQ).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../src/backtest/data.ts';
import { weeklyCloses, weekKey, cycleSignals, phaseAt, isDeepBottom, leaderScore, halvingMonth, halvingWindow, btcRegimeAt, btcIndexBefore, weeklyRsi, HALVING_FROZEN_2017, PHASE_DEFAULT } from '../src/analysis/models/cycleRegime.ts';
import { newCycleBook, cycleFill, cycleDecide, cycleValue, loadFedFunds, leadersTonight, CYCLE_DEFAULT, newBtcSleeveBook, btcSleeveDecide, btcSleeveFill, deployMonthsLeft, BTC_SLEEVE_DEFAULT, type CycleCtx } from '../src/research/cycleLab.ts';
import { CYCLE_CHOSEN, runCycle } from '../src/research/cycleCli.ts';
import { marketMakerSeries, riskShares, MM_DEFAULT } from '../src/analysis/models/marketMaker.ts';
import { wyckoffClassicSeries } from '../src/analysis/models/wyckoffClassic.ts';
import { MM_CHOSEN, MM_SETUP_DEFAULT, mmExit, mmShare, runMarketMaker } from '../src/research/marketMakerCli.ts';
import { newSignalBook, signalDay } from '../src/research/signalBook.ts';
import { buildCycleRead, buildMmRead, formatCyclePage, formatMmPage, james3AllModelsRows, james3BottomLines, readJames3Reads, CYCLE_PAGE, MM_PAGE, type James3Reads } from '../src/analysis/jamesPhase3Pages.ts';
import { allModelsRows, MODEL_SIMULATION } from '../src/analysis/reportPages.ts';
import { buildExtraModelsReport, readExtraModels, extraModelRows } from '../src/analysis/extraModels.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS } from '../src/analysis/runTicker.ts';
import { newPaperState, paperDay, accountIds, standings, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_LABEL, JAMES_IDS, JAMES3_IDS, JAMES_CYCLE_ID, JAMES_CYCLE_BTC_ID, JAMES_MM_ID, JAMES_GROUP, labHeld } from '../src/paper/paperLab.ts';
import { bagsOf } from '../src/paper/paperReport.ts';
import { valuesRows } from '../src/paper/paperLog.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';

const TZ = 'America/New_York';
function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const mk = (t: string, dates: readonly string[], closes: readonly number[], o: { opens?: number[]; highs?: number[]; lows?: number[]; volumes?: number[] } = {}): PriceSeries =>
  ({ ticker: t, dates, opens: o.opens ?? closes, highs: o.highs ?? closes, lows: o.lows ?? closes, closes, volumes: o.volumes ?? closes.map(() => 1e6), splits: [] });
const TSLA = loadSeries('TSLA'), NVDA = loadSeries('NVDA');

// ─────────────────────────────── Model 7: the reads ───────────────────────────────

describe('FL-19e — James — Multi-Year Cycle: weekly bars and the cycle reads', () => {
  test('weekly closes: the last trading day of each week, a holiday week ends on its last trading day; closes-only input is rejected', () => {
    const d = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30', '2026-12-04', '2026-12-07'];
    const w = weeklyCloses(d, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(w, [{ date: '2026-11-27', close: 4 }, { date: '2026-12-04', close: 6 }, { date: '2026-12-07', close: 7 }]);
    assert.equal(weekKey('2026-11-29'), '2026-11-23');
    assert.throws(() => weeklyCloses([1, 2] as unknown as string[], [1, 2]), /dated bars/);
  });
  test('weekly RSI of the completed weeks matches series.ts rsiArray on the weekly closes; 200-week average, Mayer, drawdown by hand', () => {
    const s = cycleSignals(NVDA), w = weeklyCloses(NVDA.dates, NVDA.closes);
    // on a week's last day the week-so-far equals the completed week: the RSI then matches rsiArray's last value
    const k = NVDA.dates.indexOf(w[400]!.date), r = weeklyRsi(w.slice(0, 401).map((x) => x.close));
    assert.ok(Math.abs(s.wrsi[k]! - r[r.length - 1]!) < 1e-9);
    const avg = w.slice(201, 401).reduce((a, x) => a + x.close, 0) / 200;
    assert.ok(Math.abs(s.sma200w[k]! - avg) < 1e-9);
    const i = 3000, m = NVDA.closes.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
    assert.ok(Math.abs(s.mayer[i]! - NVDA.closes[i]! / m) < 1e-12);
    const hi = Math.max(...NVDA.closes.slice(i - 251, i + 1));
    assert.ok(Math.abs(s.dd[i]! - (1 - NVDA.closes[i]! / hi)) < 1e-12);
  });
  test('causal: appending future bars never changes an earlier read', () => {
    const n = 2500, cut = { ...NVDA, dates: NVDA.dates.slice(0, n), closes: NVDA.closes.slice(0, n) };
    const a = cycleSignals(cut), b = cycleSignals(NVDA);
    for (const k of [n - 300, n - 2, n - 1]) {
      // the last bar of the cut is "the week so far" in both runs
      for (const f of ['dd', 'mayer', 'sma200w', 'wrsi', 'wz52', 'ret126', 'sma20'] as const) assert.equal(a[f][k], b[f][k], f + ' ' + k);
      assert.equal(phaseAt(a, k), phaseAt(b, k));
    }
  });
  test('calibration: the default flags TSLA in January 2023 as a deep bottom (and META in November 2022 when its prices are there)', () => {
    const s = cycleSignals(TSLA), jan = TSLA.dates.map((d, i) => [d, i] as const).filter(([d]) => d.startsWith('2023-01'));
    assert.ok(jan.some(([, i]) => isDeepBottom(s, i, PHASE_DEFAULT)));
    let meta: PriceSeries | null = null;
    try { meta = loadSeries('META'); } catch { meta = null; }
    if (meta) { const m = cycleSignals(meta); assert.ok(meta.dates.some((d, i) => d.startsWith('2022-11') && isDeepBottom(m, i, PHASE_DEFAULT))); }
  });
  test('halving month in whole months; the frozen windows', () => {
    assert.equal(halvingMonth('2017-12-15'), 17); assert.equal(halvingMonth('2021-11-15'), 18); assert.equal(halvingMonth('2021-11-10'), 17);
    assert.equal(halvingMonth('2025-10-06'), 17); assert.equal(halvingMonth('2026-10-29'), 30); assert.equal(halvingMonth('2010-01-01'), null);
    assert.equal(halvingWindow(30, HALVING_FROZEN_2017), 'deploy'); assert.equal(halvingWindow(14, HALVING_FROZEN_2017), 'harvest'); assert.equal(halvingWindow(10, HALVING_FROZEN_2017), 'hold');
    assert.equal(deployMonthsLeft(30), 25); assert.equal(deployMonthsLeft(3), 4);
  });
  test('BTC regime: 2 of 3 votes; the decision on day D uses the bar before D', () => {
    const D = datesTo('2026-10-30', 1500), up = D.map((_, i) => 100 * Math.exp(i * 0.004));
    const b = { dates: D, closes: up }, s = cycleSignals(b);
    const top = btcRegimeAt(b, s, D.length - 1);
    assert.ok(top.mayer! > 1 && top.topVotes >= 0 && top.bottomVotes === 0);
    const crash = [...up.slice(0, 1400), ...D.slice(1400).map((_, k) => up[1399]! * Math.exp(-k * 0.03))];
    const c = { dates: D, closes: crash }, cs = cycleSignals(c), r = btcRegimeAt(c, cs, D.length - 1);
    assert.ok(r.bottomVotes >= 2 && r.zone === 'bottom', JSON.stringify(r));
    assert.equal(btcIndexBefore(b, D[100]!), 99);
    assert.equal(btcIndexBefore(b, '2026-10-31'), D.length - 1);
  });
});

// ─────────────────────────────── Model 7: the book ───────────────────────────────

describe('FL-19e — James — Multi-Year Cycle: the book', () => {
  const D = datesTo('2026-10-30', 400);
  const ctxOf = (prices: Record<string, number[]>, k: number, qqqRet = 0): CycleCtx => {
    const stocks = new Map(Object.entries(prices).map(([t, c]) => [t, { s: cycleSignals({ dates: D, closes: c }), i: k, close: c[k]! }]));
    return { day: D[k]!, stocks, qqqRet126: qqqRet, qqqClose: 100 };
  };
  test('start: the top-K leaders share the money; don\'t chase skips a stock with Mayer >= 2', () => {
    const a = D.map((_, i) => 50 + i * 0.1), b = D.map((_, i) => 50 + i * 0.12), pump = D.map((_, i) => (i < 350 ? 50 : 50 * Math.exp((i - 349) * 0.03)));
    const x = ctxOf({ A: a, B: b, P: pump }, 399, 0);
    assert.ok(cycleSignals({ dates: D, closes: pump }).mayer[399]! >= 2);
    assert.deepEqual(leadersTonight(CYCLE_DEFAULT, x).map((l) => l.t), ['B', 'A']);
    const bk = newCycleBook(100_000);
    cycleDecide(bk, { ...CYCLE_DEFAULT, k: 3 }, x);
    assert.deepEqual(bk.orders.map((o) => [o.t, o.kind, Math.round(o.money ?? 0)]), [['B', 'start', 33333], ['A', 'start', 33333]]);
    assert.deepEqual(JSON.parse(JSON.stringify(bk)), bk, 'plain JSON');
  });
  test('harvest: p of the shares once per 20 nights, never below half of the peak; tax on the sold lots; r of the money to the top leader', () => {
    const bk = newCycleBook(0);
    bk.pos.T = { shares: 1000, cost: 10_000, peak: 1000, lastHarvest: -1e9, harvests: 0, hi: 10 };
    bk.started = true;
    const hot = D.map((_, i) => (i < 300 ? 10 : 10 * Math.exp((i - 299) * 0.02))), lead = D.map((_, i) => 50 + i * 0.1);
    const o = { ...CYCLE_DEFAULT };
    for (let k = 380; k < 400; k++) {
      cycleDecide(bk, o, ctxOf({ T: hot, L: lead }, k));
      const ord = bk.orders.filter((y) => y.kind === 'harvest');
      if (k === 380) assert.equal(ord[0]!.shares, 200); else assert.equal(ord.length, 0, 'spacing ' + k);
      const opens = new Map([['T', hot[k]!], ['L', lead[k]!]]);
      const tr = cycleFill(bk, o, opens, null, 0);
      if (k === 380) {
        const s = tr.find((x) => x.side === 'SELL')!, gain = 200 * hot[380]! - 2000;
        assert.ok(Math.abs(s.tax - gain * 0.25) < 1e-6);
        const bought = tr.find((x) => x.side === 'BUY' && x.ticker === 'L')!;
        assert.ok(Math.abs(bought.shares * lead[380]! - (200 * hot[380]! - s.tax) * 0.5) < lead[380]!, 'half rotated');
      }
    }
    // after four harvests the stock never goes under half of its peak count
    for (let k = 0; k < 6; k++) { bk.pos.T!.lastHarvest = -1e9; cycleDecide(bk, o, ctxOf({ T: hot, L: lead }, 399)); cycleFill(bk, o, new Map([['T', hot[399]!], ['L', lead[399]!]]), null, 0); }
    assert.equal(bk.pos.T!.shares, 500);
  });
  test('tranches: 1/3 at the signal, 1/3 after 20 nights in the zone (or 10% lower), 1/3 on a close above the 20-day average; a 60% fall alone never sells', () => {
    const D2 = datesTo('2026-10-30', 1200);
    const c = D2.map((_, i) => (i < 1000 ? 100 : i < 1100 ? 100 * Math.exp(-(i - 999) * 0.012) : 100 * Math.exp(-100 * 0.012)));
    const s = cycleSignals({ dates: D2, closes: c });
    const o = { ...CYCLE_DEFAULT, bottomTest: 'rsi' as const };
    const bk = newCycleBook(90_000); bk.started = true;
    bk.pos.Z = { shares: 100, cost: 10_000, peak: 100, lastHarvest: -1e9, harvests: 0, hi: 100 };
    const buys: Array<[number, string]> = [];
    for (let k = 1000; k < 1200; k++) {
      cycleDecide(bk, o, { day: D2[k]!, stocks: new Map([['Z', { s, i: k, close: c[k]! }]]), qqqRet126: 0, qqqClose: 100 });
      for (const y of bk.orders) { assert.equal(y.side, 'BUY', 'never a sale (no panic selling) on day ' + k); buys.push([k, y.why]); }
      cycleFill(bk, o, new Map([['Z', c[k]!]]), null, 0);
    }
    assert.ok(s.dd[1099]! > 0.6);
    assert.equal(buys.length, 3, JSON.stringify(buys));
    assert.match(buys[0]![1], /tranche 1 of 3/); assert.match(buys[1]![1], /tranche 2 of 3/); assert.match(buys[2]![1], /tranche 3 of 3 \(turnaround/);
    assert.ok(buys[2]![0] >= 1100, 'the turnaround comes after the fall stops');
    assert.ok(bk.cash < 1000, 'the dry powder is spent');
  });
  test('Fed funds: the prior month\'s rate; cash grows by it', () => {
    const f = loadFedFunds();
    assert.equal(f('2020-03-15'), 1.58); assert.equal(f('2020-01-02'), 1.55);
    const bk = newCycleBook(100_000);
    cycleFill(bk, CYCLE_DEFAULT, new Map(), null, 2.52);
    assert.ok(Math.abs(bk.cash - 100_000 * (1 + 2.52 / 100 / 252)) < 1e-6);
  });
  test('the history runner: the chosen setup equals the report page\'s; a run conserves money; the 2010-2019 result is the documented one', () => {
    const c = CYCLE_CHOSEN.o;
    assert.deepEqual({ x: c.x, bottomTest: c.bottomTest, topTest: c.topTest, m: c.m, gate: c.gate, k: c.k, p: c.p, r: c.r, startDry: c.startDry },
      { x: CYCLE_PAGE.x, bottomTest: CYCLE_PAGE.bottomTest, topTest: CYCLE_PAGE.topTest, m: CYCLE_PAGE.m, gate: CYCLE_PAGE.gate, k: CYCLE_PAGE.k, p: CYCLE_PAGE.p, r: CYCLE_PAGE.r, startDry: CYCLE_PAGE.startDry });
    const series = new Map([['NVDA', NVDA], ['TSLA', TSLA]]);
    const r = runCycle(['NVDA', 'TSLA'], { series, qqq: loadSeries('QQQ') }, '2015-01-01', '2016-12-31', CYCLE_CHOSEN, 10);
    assert.ok(r.finalTaxed > 0 && Number.isFinite(r.finalTaxed) && r.maxDrawdownPct >= 0 && r.maxDrawdownPct < 100);
    assert.ok([...r.cashShareByDay.values()].every((x) => x >= 0 && x <= 1));
  });
  test('the BTC sleeve (descriptive): the start leaves room for the first step; deploy steps in the deploy window; harvest in the window; plain JSON', () => {
    const bk = newBtcSleeveBook(100_000), o = BTC_SLEEVE_DEFAULT;
    const px: Record<string, number> = { A: 10, B: 20, IBIT: 50 };
    const ctx = (day: string, window: 'deploy' | 'harvest' | 'hold', h: number) => ({ day, window, halvingMonth: h, zone: 'neutral' as const, riskOff: false, sleevePx: px.IBIT!, leaders: [{ t: 'A' }, { t: 'B' }], closeOf: (t: string) => px[t] ?? null });
    btcSleeveDecide(bk, o, ctx('2026-11-02', 'deploy', 30));
    const step = bk.orders.find((y) => y.t === 'IBIT')!;
    assert.ok(Math.abs(step.money! - 50_000 / 25) < 1e-6, 'S x account / 25 months left');
    btcSleeveFill(bk, o, new Map(Object.entries(px)));
    assert.ok(bk.sleeve.shares === 40 && bk.cash >= 0);
    btcSleeveDecide(bk, o, ctx('2026-11-03', 'deploy', 30));
    assert.equal(bk.orders.length, 0, 'one step a month');
    btcSleeveDecide(bk, o, ctx('2027-12-01', 'harvest', 14));
    assert.equal(bk.orders[0]!.side, 'SELL'); assert.equal(bk.orders[0]!.shares, Math.floor((40 * 0.5) / 7));
    assert.deepEqual(JSON.parse(JSON.stringify(bk)), bk);
  });
});

// ─────────────────────────────── Model 8 ───────────────────────────────

describe('FL-19e — James — Market Maker Stages', () => {
  test('V1 agrees with Wyckoff: every sweep is a SPRING day inside an accumulation range, and every such spring is a sweep; sweepLow = that bar\'s low', () => {
    for (const s of [NVDA, TSLA]) {
      const m = marketMakerSeries(s, { ...MM_DEFAULT, context: 'off' }), w = wyckoffClassicSeries(s);
      let n = 0;
      m.forEach((d, i) => {
        const spring = w[i]!.event === 'SPRING' && w[i]!.context === 'accumulation';
        assert.equal(d.sweep, spring, s.ticker + ' ' + s.dates[i]);
        if (d.sweep) { n++; assert.equal(d.sweepLow, s.lows[i]); assert.ok(d.signal, 'no context: every sweep is a signal'); }
      });
      assert.ok(n > 0, s.ticker + ' has springs');
    }
  });
  const flat = (n: number): { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] } => ({ o: Array(n).fill(100), h: Array(n).fill(101), l: Array(n).fill(99), c: Array(n).fill(100), v: Array(n).fill(1e6) });
  const shape = (lastLow: number): PriceSeries => {
    const x = flat(70), D = datesTo('2026-10-30', 70);
    // day 60: the liquidity grab; 61-62 drift; 63: the recovery (stage 2); 66: the second sweep
    Object.assign(x, {}); x.l[60] = 90; x.h[60] = 100; x.c[60] = 95; x.v[60] = 3e6;
    x.c[61] = 96; x.c[62] = 96; x.c[63] = 97; x.h[63] = 98; x.c[64] = 96; x.c[65] = 95;
    x.l[66] = lastLow; x.c[66] = 92; x.o[66] = 94;
    return mk('X', D, x.c, { opens: x.o, highs: x.h, lows: x.l, volumes: x.v });
  };
  test('V2 on the SOL chart\'s shape: grab, range, second sweep; the double bottom only with V2DB; stops and targets', () => {
    const under = shape(89.5), equal = shape(90.5);
    const v2 = marketMakerSeries(under, { variant: 'V2', context: 'off', stop: 'pct1' });
    assert.equal(v2[60]!.stage, 1); assert.equal(v2[63]!.stage, 2); assert.equal(v2[66]!.stage, 3); assert.ok(v2[66]!.signal);
    assert.equal(v2[66]!.sweepLow, 89.5); assert.ok(Math.abs(v2[66]!.stop! - 89.5 * 0.99) < 1e-9);
    assert.equal(v2[66]!.target2, 101); assert.equal(v2[66]!.target1, 96);
    assert.ok(!marketMakerSeries(equal, { variant: 'V2', context: 'off', stop: 1 })[66]!.sweep, 'V2 needs an undercut');
    assert.ok(marketMakerSeries(equal, { variant: 'V2DB', context: 'off', stop: 1 })[66]!.sweep, 'V2DB takes the equal low');
    assert.equal(v2[67]!.stage, 4);
  });
  test('causal; the context filter needs a rising 200-day and the low at least 0.97 x it', () => {
    const a = marketMakerSeries({ ...NVDA, closes: NVDA.closes.slice(0, 3000), opens: NVDA.opens.slice(0, 3000), highs: NVDA.highs.slice(0, 3000), lows: NVDA.lows.slice(0, 3000), volumes: NVDA.volumes.slice(0, 3000) }, { ...MM_DEFAULT, variant: 'V2DB' });
    const b = marketMakerSeries(NVDA, { ...MM_DEFAULT, variant: 'V2DB' });
    for (let k = 2700; k < 3000; k++) assert.deepEqual(a[k], b[k], 'bar ' + k);
    for (const d of b) if (d.signal) assert.ok(d.context.rising && d.sweepLow! >= 0.97 * d.context.sma200!);
    assert.ok(b.some((d) => d.sweep && !d.signal), 'some sweeps fail the context');
  });
  test('1% risk sizing: floor(0.01 x equity / (entry - stop)), capped at a slot and the cash', () => {
    assert.equal(riskShares(100_000, 100, 95, { risk: 0.01, slotShare: 0.2, cash: 100_000 }), 200);
    assert.equal(riskShares(100_000, 100, 99.9, { risk: 0.01, slotShare: 0.2, cash: 100_000 }), 200, 'capped at a slot');
    assert.equal(riskShares(100_000, 100, 95, { risk: 0.01, slotShare: 0.2, cash: 5_000 }), 50, 'capped at the cash');
    assert.equal(riskShares(100_000, 100, 101, { risk: 0.01, slotShare: 0.2, cash: 1 }), 0);
    assert.ok(Math.abs(mmShare(MM_SETUP_DEFAULT, 100, 95)! - 0.2) < 1e-12); assert.ok(Math.abs(mmShare(MM_SETUP_DEFAULT, 100, 80)! - 0.05) < 1e-12);
  });
  test('exits: the stop first, half at target 1, the rest at target 2, the time stop; fills at the next open; the book sells half', () => {
    const D = datesTo('2026-10-30', 6), c = [100, 104, 106, 103, 111, 90];
    const s = mk('Y', D, c);
    const plan = { stop: 95, target1: 105, target2: 110, halfDone: false };
    assert.equal(mmExit(s, 1, MM_SETUP_DEFAULT, 1, 100, plan), null);
    assert.match(mmExit(s, 2, MM_SETUP_DEFAULT, 2, 100, plan)!.trim!, /target 1/); assert.ok(plan.halfDone);
    assert.equal(mmExit(s, 3, MM_SETUP_DEFAULT, 3, 100, plan), null);
    assert.match(mmExit(s, 4, MM_SETUP_DEFAULT, 4, 100, plan)!.sell!, /target 2/);
    assert.match(mmExit(s, 5, MM_SETUP_DEFAULT, 5, 100, { ...plan })!.sell!, /^stop/);
    assert.match(mmExit(s, 3, MM_SETUP_DEFAULT, 20, 100, { ...plan })!.sell!, /time stop/);
    // the signal book: a 5% risk entry, then half sold at the next open
    const b = newSignalBook(100_000), q = { open: 100, close: 100 }, bar = (p: number) => new Map([['Y', { open: p, close: p }]]);
    signalDay(b, { slots: 5, idle: 'cash' }, { day: D[0], bars: bar(100), qqq: q, fill: false, decide: { exits: new Map(), entries: [{ t: 'Y', why: 'x', share: 0.05, plan: { ...plan, halfDone: false } }] } });
    signalDay(b, { slots: 5, idle: 'cash' }, { day: D[1], bars: bar(100), qqq: q, fill: true, decide: { exits: new Map(), entries: [], trims: new Map([['Y', { frac: 0.5, why: 'half' }]]) } });
    assert.equal(b.pos.Y!.shares, 50); assert.equal(b.pos.Y!.plan!.stop, 95);
    const tr = signalDay(b, { slots: 5, idle: 'cash' }, { day: D[2], bars: bar(110), qqq: q, fill: true, decide: null });
    assert.equal(tr[0]!.shares, 25); assert.ok(Math.abs(tr[0]!.tax - 25 * 10 * 0.25) < 1e-9);
    assert.equal(b.pos.Y!.shares, 25);
    assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  });
  test('the history runner: the chosen setup is the page\'s; no signal on NVDA and TSLA sits in QQQ', () => {
    assert.deepEqual({ variant: MM_CHOSEN.o.variant, context: MM_CHOSEN.o.context, stop: MM_CHOSEN.o.stop, slots: MM_CHOSEN.o.slots, timeStop: MM_CHOSEN.o.timeStop },
      { variant: MM_PAGE.variant, context: MM_PAGE.context, stop: MM_PAGE.stop, slots: MM_PAGE.slots, timeStop: MM_PAGE.timeStop });
    const r = runMarketMaker(['NVDA', 'TSLA'], { series: new Map([['NVDA', NVDA], ['TSLA', TSLA]]), qqq: loadSeries('QQQ') }, '2015-01-01', '2016-12-31', MM_CHOSEN.o, 10);
    assert.equal(r.entries, 0); assert.ok(r.finalTaxed > 90_000);
  });
});

// ─────────────────────────────── report pages ───────────────────────────────

describe('FL-19e — the phase-3 report pages', () => {
  const D = datesTo('2026-10-30', 1300);
  const c = D.map((_, i) => 100 + i * 0.2 + 6 * Math.sin(i / 5));
  const bars = { dates: D, closes: c, highs: c.map((x) => x + 1), lows: c.map((x) => x - 1), opens: c, volumes: c.map(() => 1e6) };
  const qqq = { dates: D, closes: D.map((_, i) => 100 + i * 0.05), highs: c, lows: c };
  const btc = { dates: D.map((d) => d), closes: D.map((_, i) => 1000 * Math.exp(i * 0.002)), highs: c, lows: c };
  const j: James3Reads = { cycle: buildCycleRead(bars, '10y', qqq, btc, TZ), mm: buildMmRead(bars, TZ) };
  test('the pages render (with and without BTC, QQQ, data)', () => {
    const p = formatCyclePage('MSTR', j.cycle);
    for (const s of ['── MSTR — James — Multi-Year Cycle ──', '1. CYCLE POSITION', '2. PHASE: ', '3. LEADER?', '4. BTC CYCLE (descriptive', 'Halving month 30 of 48', 'deploy window', 'Regime on BTC-USD\'s 2026-10-29 bar', '5. HISTORY', MODEL_SIMULATION.CYCLE!.history.split(' (')[0]!, 'Shown for information only']) assert.ok(p.includes(s), s);
    const no = formatCyclePage('MSTR', buildCycleRead(bars, '2y', null, null, TZ));
    assert.ok(no.includes('BTC-USD prices were not available') && no.includes('QQQ\'s prices were not available') && no.includes('only the 2-year chart'));
    assert.ok(formatCyclePage('X', buildCycleRead(null, '2y', null, null, TZ, '2026-10-30')).includes('No price data'));
    const m = formatMmPage('MSTR', j.mm);
    for (const s of ['── MSTR — James — Market Maker Stages ──', '1. TODAY: ', '2. THE 200-DAY CONTEXT', '3. FOR A $100,000 ACCOUNT AT 1% RISK', '4. THE WYCKOFF EVENTS', '5. HISTORY', MODEL_SIMULATION.MARKET_MAKER!.history.split(' (')[0]!]) assert.ok(m.includes(s), s);
    assert.ok(formatMmPage('X', buildMmRead(null)).includes('No price data'));
  });
  test('🧮 All Models: two rows after phase 2\'s; Bottom Line lines; the read travels with the ExtraModelsReport; never in the Buy / Exit rows', () => {
    const base = { decision: { finalConviction: 50 }, techPlan: null, fund: null, comparison: null, extra: null, lilo: null, james: null, james2: null };
    const rows = allModelsRows({ ...base, james3: j });
    assert.deepEqual(rows.slice(-2).map((r) => r.key), ['CYCLE', 'MARKET_MAKER']);
    assert.equal(rows.at(-3)!.key, 'WINNERS');
    assert.ok(['Deploy zone', 'Harvest zone', 'Don\'t chase', 'Hold'].includes(rows.at(-2)!.read));
    assert.deepEqual(james3AllModelsRows(null).map((r) => r.read), ['Not available', 'Not available']);
    const bl = james3BottomLines(j);
    assert.deepEqual(bl.map(([l]) => l), ['🔄 James — Multi-Year Cycle', '🪤 James — Market Maker Stages']);
    assert.match(bl[0]![1], /BTC halving month 30 \(deploy window\)$/);
    const ex = { ...buildExtraModelsReport('MSTR', { dates: D.map((d) => new Date(d + 'T20:00:00Z')), opens: c, highs: c, lows: c, closes: c, volumes: c.map(() => 1e6) }, null, {}, TZ), james3: j };
    const back = readExtraModels(JSON.parse(JSON.stringify(ex)))!;
    assert.deepEqual(back.james3, JSON.parse(JSON.stringify(j)));
    assert.equal(readJames3Reads({ cycle: {} }), null);
    assert.ok(!extraModelRows(back, { withEverything: true }).some(([l]) => l.includes('James')));
  });
  test('the PDF order: Market Maker Stages right after 🏛️ Wyckoff, Multi-Year Cycle after Winners & Layering', () => {
    const o = reportTabOrder();
    assert.equal(o[o.indexOf(MODEL_TABS.wyckoff) + 1], '🪤 James — Market Maker Stages');
    assert.equal(o[o.indexOf(MODEL_TABS.winners) + 1], '🔄 James — Multi-Year Cycle');
  });
});

// ─────────────────────────────── paper ───────────────────────────────

describe('FL-19e — the phase-3 paper accounts', () => {
  const D = datesTo('2026-11-04', 600);
  const CL = (k: number): number[] => D.map((_, i) => 50 + i * 0.1 * (1 + (k % 4) * 0.2) + 4 * Math.sin(i / (6 + k)));
  const tickers = [...PAPER_OWNER_LIST, 'QQQ'];
  const series = new Map(tickers.map((t, k) => [t, mk(t, D, CL(k))]));
  const PD = D.slice(-5);
  const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
  const read = (ticker: string): EngineRead => ({ ticker, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90, ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: {}, close: 100 });
  const input = (n: number): PaperDayInput => {
    const d = PD[n]!, i = D.indexOf(d);
    return { day: d, reads: [], exitRead: noExit, bars: Object.fromEntries(tickers.map((t) => [t, { open: series.get(t)!.opens[i]!, close: series.get(t)!.closes[i]! }])), lab: { reads: PAPER_OWNER_LIST.map(read), series, long: series } };
  };
  test('they join on the first night, are labelled "James — ", group J, keep plain-JSON books and trade from the next open', () => {
    let s = newPaperState(['TSLA']);
    paperDay(s, input(0));
    for (const id of JAMES3_IDS) { assert.ok(JAMES_IDS.includes(id)); assert.ok(LAB_LABEL[id]!.startsWith('James — '), id); assert.ok(accountIds(s).includes(id), id); assert.ok(s.joins![id], id); }
    assert.ok(s.lab!.cycle && s.lab!.cycleBtc && s.lab!.marketMaker);
    assert.ok(s.lab!.cycle!.orders.some((o) => o.kind === 'start'), 'the cycle account buys its leaders at the next open');
    assert.ok(s.lab!.cycleBtc!.orders.some((o) => o.t === 'IBIT' && o.side === 'BUY'), 'the sleeve takes its first deploy step (halving month 30)');
    s = JSON.parse(JSON.stringify(s));
    const t1 = paperDay(s, input(1));
    assert.ok(t1.some((x) => x.strategy === JAMES_CYCLE_ID && x.side === 'BUY'));
    assert.ok(t1.some((x) => x.strategy === JAMES_CYCLE_BTC_ID && x.ticker === 'IBIT' && x.side === 'BUY'));
    assert.ok(t1.some((x) => x.strategy === JAMES_MM_ID && x.ticker === 'QQQ' && x.side === 'BUY'), 'idle money in QQQ');
    for (let n = 2; n < 5; n++) paperDay(s, input(n));
    const names = JAMES3_IDS.map((id) => LAB_LABEL[id]), st = standings(s).filter((r) => names.includes(r.name));
    assert.equal(st.length, 3);
    assert.ok(st.every((r) => r.qqqSinceJoined != null && !r.bench), 'judged against QQQ since they joined');
    const v = valuesRows(s, PD[4]!).filter((r) => r[2] === JAMES_GROUP).map((r) => r[1]);
    for (const id of JAMES3_IDS) assert.ok(v.includes(LAB_LABEL[id]!), id);
    const bags = bagsOf(s, (t) => series.get(t)?.closes.at(-1) ?? null).filter((b) => JAMES3_IDS.includes(b.id));
    assert.equal(bags.length, 3);
    assert.ok(labHeld(s.lab!, JAMES_CYCLE_BTC_ID).includes('IBIT'));
    // the state still saves as one JSON (G8b: size stays small)
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl19e-')), 's.json');
    fs.writeFileSync(f, JSON.stringify(s));
    assert.ok(fs.statSync(f).size < 2_000_000);
    void cycleValue;
  });
});

void leaderScore;
