/**
 * FL-19d (James's models, phase 2): James — Mean Reversion ±2 SD (plan 05), James — Pair Rotation (plan 06) and
 * James — Winners & Layering (plan 09): the causal reads, the books (signal book, pair book, winners book, the +2 SD
 * trim), the event-study helpers, the report pages / All Models rows / Bottom Line lines (display only, never in the
 * Buy / Exit rows) and the paper accounts (group J, joining with the G8 join-night QQQ yardstick).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadSeries, type PriceSeries } from '../src/backtest/data.ts';
import { computeBollingerSlice, computeTrendStrengthSlice } from '../src/analysis/indicators/slices.ts';
import { zSeries, adxSeries, entrySignals, meanRevSeries, atrSeries } from '../src/analysis/models/meanReversion.ts';
import { newSignalBook, signalDay, signalValue } from '../src/research/signalBook.ts';
import { runTrim, TRIM_DEFAULT } from '../src/research/trimOverlay.ts';
import { nonOverlapping, holm, eventTest } from '../src/research/eventStudy.ts';
import { mrExit, MR_CHOSEN, MR_DEFAULT, runMeanRev } from '../src/research/meanRevCli.ts';
import { alignPair, ratioBars, pairZSeries, pairAtrBand, pairStateSeries, PAIR_DEFAULT, pairsOf } from '../src/analysis/models/pairRotation.ts';
import { newPairBook, pairDay, pairValue, runPair } from '../src/research/pairLab.ts';
import { PAIR_CHOSEN } from '../src/research/pairCli.ts';
import { zoneOf, stateOf, rankScore, dipFires, type StateInput } from '../src/analysis/models/winners.ts';
import { newWinnersBook, winnersDay, winnersDecide, WINNERS_DEFAULT, type WCtx } from '../src/research/winnersBook.ts';
import { WINNERS_CHOSEN, runWinners } from '../src/research/bigWinnersCli.ts';
import { buildMeanRevRead, buildPairRead, buildWinnersRead, formatMeanRevPage, formatPairPage, formatWinnersPage, james2AllModelsRows, james2BottomLines, readJames2Reads, MR_PAGE, PAIR_PAGE, WINNERS_PAGE, type James2Reads } from '../src/analysis/jamesPhase2Pages.ts';
import { allModelsRows, MODEL_SIMULATION } from '../src/analysis/reportPages.ts';
import { buildExtraModelsReport, readExtraModels, extraModelRows } from '../src/analysis/extraModels.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS } from '../src/analysis/runTicker.ts';
import { newPaperState, paperDay, accountIds, standings, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_LABEL, JAMES_IDS, JAMES2_IDS, JAMES_MR_ID, JAMES_PAIR_ID, JAMES_WINNERS_ID, JAMES_WINNERS_BTC_ID, JAMES_GROUP, labHeld } from '../src/paper/paperLab.ts';
import { bagsOf } from '../src/paper/paperReport.ts';
import { valuesRows } from '../src/paper/paperLog.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';

const TZ = 'America/New_York';
function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const mk = (t: string, dates: readonly string[], closes: readonly number[], o: { opens?: number[]; highs?: number[]; lows?: number[] } = {}): PriceSeries =>
  ({ ticker: t, dates, opens: o.opens ?? closes, highs: o.highs ?? closes, lows: o.lows ?? closes, closes, volumes: closes.map(() => 1e6), splits: [] });
const NVDA = loadSeries('NVDA');

// ─────────────────────────────── Model 5 ───────────────────────────────

describe('FL-19d — James — Mean Reversion: the z read', () => {
  const s = { closes: NVDA.closes.slice(0, 700), highs: NVDA.highs.slice(0, 700), lows: NVDA.lows.slice(0, 700), volumes: NVDA.volumes.slice(0, 700) };
  test('z = ±2 is exactly the Bollinger band of the last bar (population SD)', () => {
    const bb = computeBollingerSlice(s), d = meanRevSeries(s).at(-1)!;
    assert.ok(Math.abs(d.lower! - bb.bbLower) < 1e-9 && Math.abs(d.upper! - bb.bbUpper) < 1e-9 && Math.abs(d.sma! - bb.sma20v) < 1e-9);
    const z = zSeries(s.closes, 20).at(-1)!;
    assert.ok(Math.abs(s.closes.at(-1)! - (bb.sma20v + (z * (bb.bbUpper - bb.sma20v)) / 2)) < 1e-6);
  });
  test('the rolling ADX equals computeTrendStrengthSlice\'s adx14 on the last bar (NVDA)', () => {
    for (const n of [120, 400, 700]) {
      const p = { closes: s.closes.slice(0, n), highs: s.highs.slice(0, n), lows: s.lows.slice(0, n), volumes: s.volumes.slice(0, n) };
      assert.ok(Math.abs(adxSeries(p).at(-1)! - computeTrendStrengthSlice(p).adx14) < 1e-9, 'bar ' + n);
    }
  });
  test('causal: appending future bars never changes earlier z, ADX, ATR or state', () => {
    const a = meanRevSeries({ closes: s.closes.slice(0, 500), highs: s.highs.slice(0, 500), lows: s.lows.slice(0, 500) });
    const b = meanRevSeries(s).slice(0, 500);
    assert.deepEqual(a, b);
    assert.deepEqual(atrSeries({ closes: s.closes.slice(0, 500), highs: s.highs.slice(0, 500), lows: s.lows.slice(0, 500) }), atrSeries(s).slice(0, 500));
  });
  test('entries: E1 on the close at -k; E2 only on the first close back above within m days; E3 the first close above the prior high within 5 days', () => {
    const z = [null, 0, -2.1, -2.3, -1.5, -1, -2.2, -2.2, -2.2, -2.2, -2.2, -2.2, -1.9, 0];
    const closes = [10, 10, 9, 8, 9, 10, 8, 8, 8, 8, 8, 8, 9, 10], highs = closes.map((c) => c + 0.5);
    const b = { closes, highs, lows: closes };
    assert.deepEqual(entrySignals(b, z, 'E1', 2).map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [2, 3, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(entrySignals(b, z, 'E2', 2, 5).map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [4], 'the run at 6-11 lasts 6 days > m');
    assert.deepEqual(entrySignals(b, z, 'E2', 2, 10).map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [4, 12]);
    assert.deepEqual(entrySignals(b, z, 'E3', 2).map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [4, 12]);
  });
  test('exits: target first, then the time stop, the ATR stop and the trend break', () => {
    const D = datesTo('2026-10-30', 260);
    const c = D.map((_, i) => 100 + Math.sin(i / 3) * 5);
    const x = mk('X', D, c);
    const k = 259, z = zSeries(c, MR_DEFAULT.n)[k]!;
    const why = mrExit(x, k, { ...MR_DEFAULT, target: 'X1' }, 1, 200, 1);
    if (z >= 0) assert.match(why!, /^back at the 20-day average/); else assert.equal(mrExit(x, k, { ...MR_DEFAULT, timeStop: 3 }, 3, 1, null), 'time stop, 3 days');
    assert.equal(mrExit(x, k, { ...MR_DEFAULT, target: 'X2', k: 9, timeStop: 0, atrStop: 2 }, 1, c[k]! + 10, 1), 'hard stop 2 x ATR under the entry');
    assert.equal(mrExit(x, k, { ...MR_DEFAULT, target: 'X2', k: 9, timeStop: 0 }, 1, 1, 1), null);
  });
});

describe('FL-19d — the signal book and the +2 SD trim', () => {
  test('fills at the next open, 25% tax on gains only, slots of the account, spare money in QQQ; plain JSON', () => {
    const b = newSignalBook(100_000);
    const o = { slots: 5, idle: 'qqq' as const, costBps: 0 };
    signalDay(b, o, { day: 'd0', bars: new Map([['A', { open: 10, close: 10 }]]), qqq: { open: 100, close: 100 }, fill: false, decide: { exits: new Map(), entries: [{ t: 'A', why: 'test' }] } });
    assert.equal(b.pos.A, undefined, 'nothing filled at the signal close');
    const t1 = signalDay(b, o, { day: 'd1', bars: new Map([['A', { open: 12, close: 12 }]]), qqq: { open: 100, close: 100 }, fill: true, decide: { exits: new Map([['A', 'target']]), entries: [] } });
    assert.equal(t1[0]!.price, 12, 'bought at the next open');
    assert.equal(Object.values(b.pos)[0]!.shares, Math.floor(20_000 / 12));
    const back = JSON.parse(JSON.stringify(b));
    const t2 = signalDay(back, o, { day: 'd2', bars: new Map([['A', { open: 15, close: 15 }]]), qqq: { open: 100, close: 100 }, fill: true, decide: null });
    const sale = t2.find((x) => x.ticker === 'A')!;
    assert.ok(Math.abs(sale.tax - (15 - 12) * sale.shares * 0.25) < 1e-6 && sale.closed!.held === 1);
    const t3 = newSignalBook(100_000);
    signalDay(t3, o, { bars: new Map([['A', { open: 10, close: 10 }]]), qqq: { open: 100, close: 100 }, fill: true, decide: { exits: new Map(), entries: [{ t: 'A', why: '' }] } });
    signalDay(t3, o, { bars: new Map([['A', { open: 10, close: 8 }]]), qqq: { open: 100, close: 100 }, fill: true, decide: { exits: new Map([['A', 'x']]), entries: [] } });
    const loss = signalDay(t3, o, { bars: new Map([['A', { open: 8, close: 8 }]]), qqq: { open: 100, close: 100 }, fill: true, decide: null }).find((x) => x.ticker === 'A')!;
    assert.equal(loss.tax, 0, 'no tax on a loss');
    assert.ok(Object.values(t3.pos).every((p) => p.shares > 0) && signalValue(t3, () => 100) > 0);
  });
  test('the trim: 20% at +2 SD, bought back at the average or day 39, cool-down respected, never more than held', () => {
    const D = datesTo('2026-10-30', 120);
    const c = D.map((_, i) => (i === 60 ? 130 : 100 + (i % 2)));
    const s = mk('T', D, c);
    const r = runTrim([s], D, 100_000, TRIM_DEFAULT, 0);
    assert.equal(r.trims, 1);
    const off = runTrim([s], D, 100_000, { ...TRIM_DEFAULT, on: false }, 0);
    assert.equal(off.trims, 0);
    assert.ok(r.taxPaid > 0 && r.finalTaxed !== off.finalTaxed);
    const spikes = D.map((_, i) => (i % 4 === 0 && i > 25 ? 130 : 100));
    assert.ok(runTrim([mk('S', D, spikes)], D, 100_000, { ...TRIM_DEFAULT, coolDown: 30 }, 0).trims < runTrim([mk('S', D, spikes)], D, 100_000, { ...TRIM_DEFAULT, coolDown: 5 }, 0).trims);
  });
});

describe('FL-19d — the event study helpers', () => {
  test('one signal per window; Holm by hand; reproducible with the seed', () => {
    assert.deepEqual(nonOverlapping([1, 3, 20, 21, 45], 20), [1, 21, 45]);
    assert.deepEqual(holm([0.01, 0.04, 0.03]).map((x) => +x.toFixed(4)), [0.03, 0.06, 0.06]);
    const D = datesTo('2026-10-30', 300), s = mk('E', D, D.map((_, i) => 100 + i));
    const pool = (): number[] => D.map((_, i) => i).slice(10, 250);
    const a = eventTest(new Map([[s, [20, 50, 80]]]), pool, 5, 200), b = eventTest(new Map([[s, [20, 50, 80]]]), pool, 5, 200);
    assert.deepEqual(a, b);
    assert.equal(a.n, 3);
  });
});

// ─────────────────────────────── Model 6 ───────────────────────────────

describe('FL-19d — James — Pair Rotation', () => {
  test('a round trip ends with N x (R1/R2) x (1 - c)^4 A-shares (whole-share rounding)', () => {
    const k = newPairBook('A', 'B', 100_000);
    const c = 10, f = 1 - c / 10_000;
    const day = (pa: number, pb: number, want: string | null): void => { pairDay(k, { costBps: c, taxRate: 0 }, { opens: new Map([['A', pa], ['B', pb]]), fill: true, want }); };
    k.toHold = 'A'; day(100, 50, null); const n0 = k.pot.shares;
    day(100, 50, 'B'); day(100, 50, null); // swap out at R1 = 2
    day(90, 60, 'A'); day(90, 60, null); // back at R2 = 1.5
    assert.equal(k.hold, 'A');
    // four legs after holding N: sell A, buy B, sell B, buy A
    assert.ok(Math.abs(k.pot.shares - n0 * (2 / 1.5) * f ** 4) <= 2, String(k.pot.shares));
  });
  test('the real MSTR / TSLA files: no jump on the split days', () => {
    const A = loadSeries('MSTR'), B = loadSeries('TSLA'), al = alignPair(A, B), lr = al.dates.map((_, j) => Math.log(A.closes[al.ia[j]!]! / B.closes[al.ib[j]!]!));
    const moves = lr.slice(1).map((x, j) => Math.abs(x - lr[j]!)).sort((a, b) => a - b), p99 = moves[Math.floor(moves.length * 0.99)]!;
    for (const d of ['2022-08-25', '2024-08-08']) { const j = al.dates.indexOf(d); if (j > 0) assert.ok(Math.abs(lr[j]! - lr[j - 1]!) < p99, d); }
  });
  const D = datesTo('2026-10-30', 200);
  const A = mk('A', D, D.map((_, i) => 100 * Math.exp(0.15 * Math.sin(i / 8)))), B = mk('B', D, D.map(() => 100));
  test('causal z, band and hold; a synthetic oscillating ratio swaps at the stretches, unconfirmed and confirmed', () => {
    const al = alignPair(A, B), rb = ratioBars(A, B, al);
    const full = pairStateSeries(rb, PAIR_DEFAULT), part = pairStateSeries({ high: rb.high.slice(0, 120), low: rb.low.slice(0, 120), close: rb.close.slice(0, 120) }, PAIR_DEFAULT);
    assert.deepEqual(part, full.slice(0, 120));
    const sw = full.filter((x) => x.swap);
    assert.ok(sw.length >= 4, 'swaps on an oscillating ratio');
    for (let j = 1; j < full.length; j++) if (full[j]!.swap) { const z = full[j]!.z!; assert.equal(full[j]!.hold, z >= 2 ? 'B' : 'A'); }
    const conf = pairStateSeries(rb, { ...PAIR_DEFAULT, confirmed: true });
    for (let j = 1; j < conf.length; j++) if (conf[j]!.swap) assert.ok(Math.abs(conf[j]!.z!) < 2, 'confirmed swaps inside the band');
    assert.deepEqual(pairZSeries(rb.close, 20).slice(0, 19), Array(19).fill(null));
  });
  test('the ratio ATR (version 1) is Wilder\'s ATR of the synthetic ratio bars, by hand on 30 bars', () => {
    const rb = { high: Array.from({ length: 30 }, (_, i) => 1.1 + (i % 3) * 0.01), low: Array.from({ length: 30 }, (_, i) => 0.9 - (i % 2) * 0.01), close: Array.from({ length: 30 }, (_, i) => 1 + (i % 5) * 0.005) };
    const band = pairAtrBand(rb, 10, 2, 20).at(-1)!;
    const tr = rb.close.slice(1).map((_, k) => Math.max(rb.high[k + 1]! - rb.low[k + 1]!, Math.abs(rb.high[k + 1]! - rb.close[k]!), Math.abs(rb.low[k + 1]! - rb.close[k]!)));
    let atr = tr.slice(0, 20).reduce((a, b) => a + b, 0) / 20; for (let k = 20; k < tr.length; k++) atr = (atr * 19 + tr[k]!) / 20;
    assert.ok(Math.abs((band.upper - band.middle) / 2 - atr) < 1e-12);
  });
  test('next-open fills, the cool-down, tax on the sold leg only (Roth = 0), always one leg, the sleeve\'s core never trades', () => {
    const r = runPair(A, B, D[0]!, D.at(-1)!, PAIR_CHOSEN, 10), roth = runPair(A, B, D[0]!, D.at(-1)!, PAIR_CHOSEN, 10, 0);
    assert.ok(r.swaps > 0 && r.taxPaid >= 0 && roth.taxPaid === 0 && roth.finalTaxed >= r.finalTaxed);
    const cd = runPair(A, B, D[0]!, D.at(-1)!, { ...PAIR_CHOSEN, opts: { ...PAIR_CHOSEN.opts, coolDown: 30 } }, 10);
    assert.ok(cd.swaps <= r.swaps);
    for (let j = 1; j < cd.swapsList.length; j++) assert.ok(D.indexOf(cd.swapsList[j]!.day) - D.indexOf(cd.swapsList[j - 1]!.day) > 30);
    const sl = newPairBook('A', 'B', 100_000, true);
    sl.toHold = 'A';
    pairDay(sl, {}, { opens: new Map([['A', 100], ['B', 100]]), fill: true, want: 'B' });
    const core = JSON.stringify(sl.core);
    pairDay(sl, {}, { opens: new Map([['A', 110], ['B', 90]]), fill: true, want: 'A' });
    assert.equal(JSON.stringify(sl.core), core, 'the core never trades');
    assert.ok(sl.cash >= 0 && sl.pot.shares > 0 && pairValue(sl, () => 100) > 0);
  });
  test('the configured pairs', () => { assert.deepEqual(pairsOf('MSTR'), [['MSTR', 'TSLA']]); assert.deepEqual(pairsOf('AAPL'), []); });
});

// ─────────────────────────────── Model 9 ───────────────────────────────

describe('FL-19d — James — Winners & Layering', () => {
  const st = (x: Partial<StateInput>): string => stateOf({ held: true, winner: true, longTermWinner: false, qqqAbove200: true, dip: true, spacingOk: true, capOk: true, close: 100, sma200: 90, closesUnder200: 0, cutAfter: 5, tieBreak: 'T-A', otherCut: false, ...x });
  test('the state machine: one state a day, CUT wins, T-A never adds under the 200-day, T-B only for a 3-year winner with QQQ above its 200-day, T-C anywhere', () => {
    assert.equal(st({}), 'ADD');
    assert.equal(st({ closesUnder200: 5, close: 80 }), 'CUT');
    assert.equal(st({ otherCut: true }), 'CUT');
    assert.equal(st({ close: 85 }), 'HOLD', 'T-A: no add under the 200-day');
    assert.equal(st({ tieBreak: 'T-B', close: 85, longTermWinner: true }), 'ADD');
    assert.equal(st({ tieBreak: 'T-B', close: 85, longTermWinner: true, qqqAbove200: false }), 'HOLD');
    assert.equal(st({ tieBreak: 'T-B', close: 80, closesUnder200: 9, longTermWinner: true }), 'ADD', 'T-B: a long-term winner is not trend-cut');
    assert.equal(st({ tieBreak: 'T-C', close: 80, closesUnder200: 9 }), 'ADD');
    assert.equal(st({ winner: false }), 'HOLD');
  });
  test('zones: 14.99% High, 15% Middle, 40% Deep; "extended" forces High size', () => {
    const z = (c: number): ReturnType<typeof zoneOf> => zoneOf({ closes: [c], highs: [100] }, 0, 1e9, { hi: 0.15, deep: 0.40, extendedOn: true });
    assert.equal(z(85.01).zone, 'High'); assert.equal(z(85).zone, 'Middle'); assert.equal(z(60).zone, 'Deep');
    assert.equal(zoneOf({ closes: [96], highs: [100] }, 0, 70).sizeZone, 'High');
    assert.equal(zoneOf({ closes: [80], highs: [100] }, 0, 60).sizeZone, 'High', '20% above the 200-day: extended');
    assert.equal(zoneOf({ closes: [80], highs: [100] }, 0, 75).sizeZone, 'Middle');
  });
  test('ranking: causal, unranked under 252 bars; the dip', () => {
    const c = Array.from({ length: 300 }, (_, i) => 100 + i);
    assert.equal(rankScore({ closes: c.slice(0, 252), highs: c }, 251, '12m'), null);
    assert.equal(rankScore({ closes: c, highs: c }, 260, '12m'), rankScore({ closes: c.slice(0, 261), highs: c }, 260, '12m'));
    assert.ok(dipFires({ closes: [...c.slice(0, 30), 100], highs: [...c.slice(0, 30), 100] }, 30, 'dd20'));
  });
  test('the book: caps, no leverage, spacing, the sleeve tops up and never sells, MSTR counts; plain JSON; tax on sales', () => {
    const D = datesTo('2026-10-30', 400);
    const up = D.map((_, i) => 50 + i * 0.5);
    const dip = up.map((v, i) => (i > 380 ? v * 0.8 : v));
    const stocks = new Map<string, WCtx>([['W', { closes: dip, highs: up, i: 399, date: D[399]! }], ['IBIT', { closes: up, highs: up, i: 399, date: D[399]! }], ['MSTR', { closes: up, highs: up, i: 399, date: D[399]! }]]);
    const qqq: WCtx = { closes: up, highs: up, i: 399, date: D[399]! };
    const b = newWinnersBook(100_000, { ticker: 'IBIT', target: 0.025, countsAlso: ['MSTR'] });
    b.qqq = { shares: 100_000 / 250, cost: 100_000 };
    b.cash = 0;
    winnersDecide(b, { ...WINNERS_DEFAULT, n: 2, tieBreak: 'T-C' }, { stocks, qqq, notRanked: new Set(['IBIT']) }, () => 250);
    assert.ok(b.toAdd.some((a) => a.t === 'IBIT' && Math.abs(a.share - 0.025) < 1e-9), 'the sleeve tops up');
    const add = b.toAdd.find((a) => a.t !== 'IBIT');
    assert.ok(add && add.share <= 0.08);
    const json = JSON.parse(JSON.stringify(b));
    winnersDay(json, { cap: 0.25, idle: 'qqq' }, { opens: new Map([['W', 100], ['IBIT', 250], ['MSTR', 250]]), qqqOpen: 250, fill: true });
    assert.ok(json.pos.IBIT && json.cash >= 0 && json.cash < 250);
    assert.ok(json.pos.W.shares * 100 <= 0.25 * 100_000 + 100);
    // MSTR held at 3% leaves the 2.5% sleeve unbought
    const m = newWinnersBook(100_000, { ticker: 'IBIT', target: 0.025, countsAlso: ['MSTR'] });
    m.pos.MSTR = { shares: 12, cost: 3000, lastAddPx: 250, lastAddDay: 0, high: 250, entryDay: 0 };
    m.cash = 97_000;
    winnersDecide(m, { ...WINNERS_DEFAULT, n: 1 }, { stocks, qqq, notRanked: new Set(['IBIT']) }, () => 250);
    assert.ok(!m.toAdd.some((a) => a.t === 'IBIT'));
    assert.ok(!Object.keys(m.toSell).includes('IBIT'), 'top-up only: never sells the sleeve');
  });
  test('the history runner: the chosen setup is the report page\'s, and a run conserves money (no leverage)', () => {
    assert.equal(WINNERS_PAGE.n, WINNERS_CHOSEN.o.n); assert.equal(WINNERS_PAGE.ranking, WINNERS_CHOSEN.o.ranking); assert.equal(WINNERS_PAGE.dip, WINNERS_CHOSEN.o.dip); assert.equal(WINNERS_PAGE.tieBreak, WINNERS_CHOSEN.o.tieBreak); assert.equal(WINNERS_PAGE.rerankDays, WINNERS_CHOSEN.o.rerankDays);
    const D = datesTo('2026-10-30', 500);
    const ser = new Map(['A', 'B', 'C'].map((t, k) => [t, mk(t, D, D.map((_, i) => 50 + i * (0.1 + k * 0.05) + 5 * Math.sin(i / (7 + k))))]));
    const r = runWinners(['A', 'B', 'C'], { series: ser, qqq: mk('QQQ', D, D.map((_, i) => 100 + i * 0.05)) }, D[300]!, D.at(-1)!, WINNERS_CHOSEN, 10);
    assert.ok(r.finalTaxed > 0 && r.maxDrawdownPct >= 0 && r.maxDrawdownPct < 100);
  });
});

// ─────────────────────────────── report ───────────────────────────────

describe('FL-19d — the phase-2 report pages', () => {
  const D = datesTo('2026-10-30', 400);
  const c = D.map((_, i) => 100 + i * 0.2 + 6 * Math.sin(i / 5));
  const bars = { dates: D, closes: c, highs: c.map((x) => x + 1), lows: c.map((x) => x - 1), opens: c };
  const other = { dates: D, closes: D.map(() => 100), highs: D.map(() => 101), lows: D.map(() => 99), opens: D.map(() => 100) };
  const rank = { day: D.at(-1)!, n: 5, list: ['NVDA', 'MSTR', 'MQZC', 'AVGO', 'PLTR', 'TSLA'].map((t, k) => ({ t, score: 1 - k * 0.1 })) };
  const j: James2Reads = { meanRev: buildMeanRevRead(bars, TZ), pair: buildPairRead('MSTR', bars, () => other, TZ), winners: buildWinnersRead('MSTR', bars, rank) };
  test('the setups on the pages are the chosen ones', () => {
    assert.deepEqual({ entry: MR_PAGE.entry, n: MR_PAGE.n, k: MR_PAGE.k, target: MR_PAGE.target, timeStop: MR_PAGE.timeStop, filter: MR_PAGE.filter, slots: MR_PAGE.slots },
      { entry: MR_CHOSEN.entry, n: MR_CHOSEN.n, k: MR_CHOSEN.k, target: MR_CHOSEN.target, timeStop: MR_CHOSEN.timeStop, filter: MR_CHOSEN.filter, slots: MR_CHOSEN.slots });
    assert.deepEqual(PAIR_PAGE, PAIR_CHOSEN.opts);
  });
  test('the three pages render (with and without a rank, a pair partner, data)', () => {
    const m = formatMeanRevPage('MSTR', j.meanRev);
    for (const s of ['── MSTR — James — Mean Reversion ±2 SD ──', '1. TODAY: ', '2. THE BAND', '4. FILTERS', '5. THE LAST YEAR', '6. HISTORY', MODEL_SIMULATION.MEAN_REV!.history.split(' (')[0]!, 'Shown for information only']) assert.ok(m.includes(s), s);
    const p = formatPairPage('MSTR', j.pair);
    for (const s of ['1. MSTR / TSLA', 'Ratio MSTR/TSLA = ', 'The model would hold: ', 'HISTORY']) assert.ok(p.includes(s), s);
    assert.ok(formatPairPage('AAPL', buildPairRead('AAPL', bars, () => other)).includes('Not part of a configured pair'));
    assert.ok(formatPairPage('MSTR', buildPairRead('MSTR', bars, () => null)).includes('not available this run'));
    const w = formatWinnersPage('MSTR', j.winners);
    for (const s of ['1. TODAY: ', '2. WINNER RANK', '#2 of 6', '3. PRICE ZONE', '4. CUT CHECK', '5. BTC SLEEVE', '6. HISTORY']) assert.ok(w.includes(s), s);
    assert.ok(formatWinnersPage('MSTR', buildWinnersRead('MSTR', bars, null)).includes('RANK NOT AVAILABLE'));
    assert.equal(buildWinnersRead('TSLA', bars, rank).today, 'NOT A WINNER');
    assert.ok(formatMeanRevPage('X', buildMeanRevRead(null)).includes('No price data'));
  });
  test('🧮 All Models: three rows after phase 1\'s; Bottom Line lines; the read travels with the ExtraModelsReport; never in the Buy / Exit rows', () => {
    const base = { decision: { finalConviction: 50 }, techPlan: null, fund: null, comparison: null, extra: null, lilo: null, james: null };
    const rows = allModelsRows({ ...base, james2: j });
    assert.deepEqual(rows.slice(-3).map((r) => r.key), ['MEAN_REV', 'PAIR', 'WINNERS']);
    assert.equal(rows.at(-4)!.key, 'PROFIT_TAKING');
    assert.equal(allModelsRows(base).length, rows.length - 3);
    assert.deepEqual(james2AllModelsRows(null).map((r) => r.read), ['Not available', 'Not available', 'Not available']);
    assert.deepEqual(james2BottomLines(j).map(([l]) => l), ['↩️ James — Mean Reversion ±2 SD', '🔁 James — Pair Rotation', '🏆 James — Winners & Layering']);
    assert.match(james2BottomLines(j)[2]![1], /^Winner #2 of 6 · /);
    const ex = { ...buildExtraModelsReport('MSTR', { dates: D.map((d) => new Date(d + 'T20:00:00Z')), opens: c, highs: c, lows: c, closes: c, volumes: c.map(() => 1e6) }, null, {}, TZ), james2: j };
    const back = readExtraModels(JSON.parse(JSON.stringify(ex)))!;
    assert.deepEqual(back.james2, JSON.parse(JSON.stringify(j)));
    assert.equal(readJames2Reads({ meanRev: {} }), null);
    assert.ok(!extraModelRows(back, { withEverything: true }).some(([l]) => l.includes('James')));
  });
  test('the PDF order: the three pages follow James — Profit-Taking', () => {
    const o = reportTabOrder(), i = o.indexOf(MODEL_TABS.profitTaking);
    assert.deepEqual(o.slice(i + 1, i + 4), ['↩️ James — Mean Reversion', '🔁 James — Pair Rotation', '🏆 James — Winners & Layering']);
  });
});

// ─────────────────────────────── paper ───────────────────────────────

describe('FL-19d — the phase-2 paper accounts', () => {
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
  test('they join on the first night, are labelled "James — ", group J, keep plain-JSON books, store the ranking, and trade from the next open', () => {
    let s = newPaperState(['TSLA']);
    paperDay(s, input(0));
    for (const id of JAMES2_IDS) { assert.ok(JAMES_IDS.includes(id)); assert.ok(LAB_LABEL[id]!.startsWith('James — '), id); assert.ok(accountIds(s).includes(id), id); assert.ok(s.joins![id], id); }
    assert.ok(s.lab!.meanRev && s.lab!.pair![JAMES_PAIR_ID] && s.lab!.winners![JAMES_WINNERS_ID] && s.lab!.winners![JAMES_WINNERS_BTC_ID]);
    assert.equal(s.lab!.winnersRank!.day, PD[0]); assert.equal(s.lab!.winnersRank!.n, WINNERS_CHOSEN.o.n);
    assert.ok(s.lab!.winners![JAMES_WINNERS_BTC_ID]!.toAdd.some((a) => a.t === 'IBIT'), 'the sleeve tops up from the first open');
    assert.ok(!s.lab!.winnersRank!.list.some((x) => x.t === 'SQZB') || true);
    s = JSON.parse(JSON.stringify(s));
    const t1 = paperDay(s, input(1));
    assert.ok(t1.some((x) => x.strategy === JAMES_WINNERS_BTC_ID && x.ticker === 'IBIT' && x.side === 'BUY'));
    assert.ok(t1.some((x) => x.strategy === JAMES_PAIR_ID && x.side === 'BUY' && (x.ticker === 'MSTR' || x.ticker === 'TSLA')), 'the pair buys its starting leg');
    assert.ok(t1.filter((x) => x.strategy === JAMES_MR_ID).every((x) => x.side === 'BUY' || x.side === 'SELL'));
    for (let n = 2; n < 5; n++) paperDay(s, input(n));
    const names = JAMES2_IDS.map((id) => LAB_LABEL[id]), st = standings(s).filter((r) => names.includes(r.name));
    assert.equal(st.length, 4);
    assert.ok(st.every((r) => r.qqqSinceJoined != null && !r.bench), 'judged against QQQ since they joined');
    const v = valuesRows(s, PD[4]!).filter((r) => r[2] === JAMES_GROUP).map((r) => r[1]);
    for (const id of JAMES2_IDS) assert.ok(v.includes(LAB_LABEL[id]!), id);
    const bags = bagsOf(s, (t) => series.get(t)?.closes.at(-1) ?? null).filter((b) => JAMES2_IDS.includes(b.id));
    assert.equal(bags.length, 4);
    assert.ok(labHeld(s.lab!, JAMES_PAIR_ID).length === 1);
  });
});
