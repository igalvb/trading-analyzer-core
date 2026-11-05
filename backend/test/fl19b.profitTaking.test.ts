/**
 * FL-19b (James's models, phase 1): James — Master Profit-Taking (docs/models/plans/02-master-profit-taking.md
 * section 9): the five sheets rebuilt cell by cell (with the member-found B4 fix), whole shares, gaps, the tax of each
 * step, and the overlay options of runPortfolio and liloDay (absent = today's results exactly).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sheetTable, scheduleLevels, remainingAfter, sharesToSell, newPtState, profitTakingFills, percentLevels11, sheetLeftOnTable, noteStep, PT_SCHEDULES, PT_SPEC, PT_DEFAULT, type PtSchedule,
} from '../src/analysis/models/profitTaking.ts';
import { loadSeries, type PriceSeries } from '../src/backtest/data.ts';
import { runPortfolio, type PortfolioInput } from '../src/research/portfolioLab.ts';
import { newLiloBook, liloDay, type LiloBar } from '../src/research/liloBook.ts';
import { holdWithSchedule, improves } from '../src/research/profitTakingCli.ts';
import { formatProfitTakingPage, buildJamesLayersRead, PT_PAGE } from '../src/analysis/jamesPages.ts';
import { EXIT_TAX_RATE } from '../src/portfolio/exitTax.ts';

const near = (a: number, b: number, tol = 0.005, what = ''): void => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b);
const V1 = [39557, 46502, 57739, 68978, 75920];
const V11 = [43085, 52087, 66654, 81222, 90224];
const STAG = [29811, 35914, 45791, 55667, 61771];
const ETH = [2127, 2625, 3432, 4239, 4737];
/** The five LILO layer prices padded to 11 (the schedules read layers 6-10). */
const pad = (p: readonly number[]): number[] => [0, 0, 0, 0, 0, 0, ...p];

describe('FL-19b — the sheets, cell by cell (R0 = 1)', () => {
  test('V1 2023-10-12: A20 60,902.49 (ROI 143.61%, left 15,017.51), B20 57,739.20 (left 18,180.80), C 120,257.29 (left 68,655.96)', () => {
    const a = sheetTable(25000, 1, scheduleLevels(pad(V1), 'A20'), 'A20');
    assert.deepEqual(a.columns.map((c) => +c.sold.toFixed(5)), [0.2, 0.16, 0.128, 0.1024, 0.08192]);
    near(a.columns[4]!.remaining, 0.32768, 1e-9, 'remaining');
    near(a.columns[4]!.cash, 36025.03, 0.01, 'cash'); near(a.columns[4]!.valueRemaining, 24877.47, 0.01, 'coin');
    near(a.columns[4]!.total, 60902.49, 0.01, 'total'); near(a.hodl, 75920, 1e-9, 'HODL'); near(a.leftOnTable, 15017.51, 0.01, 'left');
    near(a.strategyRoi * 100, 143.61, 0.005, 'ROI'); near(a.hodlRoi * 100, 203.68, 0.005, 'HODL ROI');
    const b = sheetTable(25000, 1, scheduleLevels(pad(V1), 'B20'), 'B20');
    assert.deepEqual(b.columns.map((c) => +c.remaining.toFixed(5)), [0.8, 0.6, 0.4, 0.2, 0]);
    near(b.columns[4]!.total, 57739.20, 0.01, 'B20 total'); near(b.leftOnTable, 18180.80, 0.01, 'B20 left'); near(b.strategyRoi * 100, 130.96, 0.005);
    const c = sheetTable(25000, 1, scheduleLevels(pad(V1), 'C'), 'C');
    assert.deepEqual(c.columns.slice(5).map((x) => +x.price.toFixed(2)), [91104, 109324.8, 131189.76, 157427.71, 188913.25]);
    near(c.columns[9]!.total, 120257.29, 0.01, 'C total'); near(c.columns[9]!.cash, 54387.31, 0.01); near(c.columns[9]!.valueRemaining, 65869.98, 0.01);
    assert.deepEqual(c.columns.slice(4).map((x) => +x.leftOnTable.toFixed(2)), [8262.65, 14480.65, 23018.17, 34425.19, 49368.56, 68655.96]);
  });

  test('V1.1 2023-12-03: A10 79,512.35 (left 10,711.65), B10 78,439.20 keeps half (left 11,784.80), C 97,305.55 (left 56,400.47)', () => {
    const a = sheetTable(20000, 1, scheduleLevels(pad(V11), 'A10'), 'A10');
    near(a.columns[4]!.remaining, 0.59049, 1e-9); near(a.columns[4]!.cash, 26235.98, 0.01); near(a.columns[4]!.valueRemaining, 53276.37, 0.01);
    near(a.columns[4]!.total, 79512.35, 0.01); near(a.leftOnTable, 10711.65, 0.01); near(a.strategyRoi * 100, 297.56, 0.005); near(a.hodlRoi * 100, 351.12, 0.005);
    const b = sheetTable(20000, 1, scheduleLevels(pad(V11), 'B10'), 'B10');
    near(b.columns[4]!.remaining, 0.5, 1e-9, 'the sheet keeps half'); near(b.columns[4]!.cash, 33327.20, 0.01); near(b.columns[4]!.valueRemaining, 45112, 0.01);
    near(b.columns[4]!.total, 78439.20, 0.01); near(b.leftOnTable, 11784.80, 0.01); near(b.strategyRoi * 100, 292.20, 0.005);
    const c = sheetTable(25000, 1, scheduleLevels(pad(STAG), 'C'), 'C');
    assert.deepEqual(c.columns.slice(5).map((x) => +x.price.toFixed(2)), [74125.2, 88950.24, 106740.29, 128088.35, 153706.01]);
    near(c.columns[9]!.total, 97305.55, 0.01);
    assert.deepEqual(c.columns.map((x) => +x.leftOnTable.toFixed(2)), [0, 610.3, 2486.93, 5163.33, 7262.49, 12321.66, 19268.07, 28549.19, 40707.61, 56400.47]);
  });

  test('ETH: A20 3,659.04 (ROI 143.94%, left 1,077.96), B20 3,432 (ROI 128.8%, left 1,305)', () => {
    const a = sheetTable(1500, 1, ETH, 'A20'), b = sheetTable(1500, 1, ETH, 'B20');
    near(a.columns[4]!.total, 3659.04, 0.01); near(a.leftOnTable, 1077.96, 0.01); near(a.strategyRoi * 100, 143.94, 0.005); near(a.hodlRoi * 100, 215.8, 0.005);
    near(b.columns[4]!.total, 3432, 0.01); near(b.leftOnTable, 1305, 0.01); near(b.strategyRoi * 100, 128.8, 0.005);
  });

  test('the B4 fix: with R0 = 3, the value if held and the money left on the table are exactly 3 x the R0 = 1 values (the original G10 = G2 would not be)', () => {
    for (const id of PT_SCHEDULES) {
      const one = sheetTable(25000, 1, scheduleLevels(pad(V1), id), id), three = sheetTable(25000, 3, scheduleLevels(pad(V1), id), id);
      near(three.hodl, 3 * one.hodl, 1e-6, id + ' HODL'); near(three.leftOnTable, 3 * one.leftOnTable, 1e-6, id + ' left');
      near(three.strategyRoi, one.strategyRoi, 1e-12, id + ' ROI on the total cost');
      assert.notEqual(+three.hodl.toFixed(2), +(scheduleLevels(pad(V1), id).at(-1) as number).toFixed(2), 'the sheet\'s G10 = G2 would give the last layer alone');
    }
  });

  test('closed forms: what is left after each schedule', () => {
    near(remainingAfter('A20'), 0.32768, 1e-12); near(remainingAfter('A10'), 0.59049, 1e-12); near(remainingAfter('B20'), 0, 1e-12);
    near(remainingAfter('B10'), 0.5, 1e-12); near(remainingAfter('C'), 0.3486784401, 1e-12);
    assert.equal(PT_DEFAULT, 'A20');
    assert.deepEqual(PT_SCHEDULES.map((id) => PT_SPEC[id].steps), [5, 5, 5, 5, 10]);
  });
});

describe('FL-19b — whole shares, gaps, the tax of each step', () => {
  test('7 shares: A20 never sells a fraction or more than held, and A / C keep the last share; B20 is fully out at layer 10, B10 keeps about half', () => {
    for (const id of PT_SCHEDULES) {
      let held = 7;
      for (let k = 0; k < PT_SPEC[id].steps; k++) {
        const n = sharesToSell(id as PtSchedule, k, 7, held);
        assert.ok(Number.isInteger(n) && n >= 0 && n <= held, id + ' step ' + k + ': ' + n);
        held -= n;
      }
      if (PT_SPEC[id].of === 'current') assert.ok(held >= 1, id + ' keeps the last share');
      if (id === 'B20') assert.equal(held, 0);
      if (id === 'B10') assert.ok(held >= 3 && held <= 4, 'B10 keeps about half: ' + held);
    }
    assert.equal(sharesToSell('A20', 0, 1, 1), 0, 'one share is never sold by A');
  });

  test('a bar opening above layer 8 when 6 and 7 had not fired sells three steps, all at the open', () => {
    const st = newPtState('A20', pad([100, 120, 150, 200, 250]), 1000);
    const f = profitTakingFills(st, { open: 160, high: 165, close: 162 }, 1000);
    assert.deepEqual(f.map((x) => [x.step, x.shares, x.price]), [[0, 200, 160], [1, 160, 160], [2, 128, 160]]);
    assert.equal(st.fired, 3);
    assert.deepEqual(profitTakingFills(st, { open: 160, high: 199, close: 170 }, 512), [], 'each layer fires once');
    const g = profitTakingFills(st, { open: 190, high: 205, close: 201 }, 512);
    assert.deepEqual(g.map((x) => [x.step, x.price]), [[3, 200]], 'a high touching layer 9 fills at the layer');
  });

  test('a step at or under the cost per share is skipped, never sold at a loss; the close trigger leaves the price to the next open', () => {
    const st = newPtState('A20', pad([100, 120, 150, 200, 250]), 100);
    const f = profitTakingFills(st, { open: 125, high: 126, close: 125 }, 100, 'intraday', 110);
    assert.deepEqual(f.map((x) => x.step), [1], 'layer 6 ($100) is under the $110 cost: skipped; layer 7 sells');
    const c = newPtState('B10', pad([100, 120, 150, 200, 250]), 50);
    const due = profitTakingFills(c, { open: 90, high: 130, close: 101 }, 50, 'close');
    assert.deepEqual(due.map((x) => [x.step, x.shares, x.price]), [[0, 5, null]], 'only the close counts; sold at the next open');
  });

  test('the sheet-faithful money left on the table of one position', () => {
    const st = newPtState('A20', pad([100, 120, 150, 200, 250]), 10);
    noteStep(st, 2, 100); noteStep(st, 2, 120);
    near(sheetLeftOnTable(st, 6)!, 10 * 120 - (200 + 240 + 6 * 120), 1e-9);
    assert.equal(sheetLeftOnTable(newPtState('A20', pad([1, 2, 3, 4, 5]), 1), 1), null);
    assert.deepEqual(percentLevels11(100).slice(6), [125, 150, 200, 250, 300]);
  });
});

// The repo's own price files (legacy/historical_data) for the overlay checks.
const BAG = ['TSLA', 'NVDA', 'GOOGL', 'AMD', 'MQZC'];
const INP: PortfolioInput = { series: new Map<string, PriceSeries>(BAG.map((t) => [t, loadSeries(t)])), reads: new Map(), qqq: loadSeries('QQQ') };

describe('FL-19b — the overlay in the research books', () => {
  test('runPortfolio without profitTaking gives exactly the results before phase 1 (values frozen from the pre-phase-1 code)', () => {
    const a = runPortfolio('trend', BAG, INP, '2015-01-01', '2022-12-31', { slots: 3, cash: 100_000, trendDays: 200 });
    assert.equal(a.finalTaxed, 747510.6735963521); assert.equal(a.trades, 86); assert.equal(a.maxDrawdownPct, 57.79166986380977);
    assert.equal(a.profitTaking, undefined);
    const b = runPortfolio('trend', BAG, INP, '2015-01-01', '2022-12-31', { slots: 2, cash: 100_000, trendDays: 150, costBps: 10 });
    assert.equal(b.finalTaxed, 905885.8258009142); assert.equal(b.trades, 70); assert.equal(b.maxDrawdownPct, 62.54941105183354);
  });

  test('runPortfolio with A20: steps sell at the layers, each paying 25% of its own gain; the check counts positions, steps and the left-on-the-table sums', () => {
    const r = runPortfolio('trend', BAG, INP, '2015-01-01', '2022-12-31', { slots: 3, cash: 100_000, trendDays: 200, profitTaking: { schedule: 'A20' } });
    const p = r.profitTaking!;
    assert.ok(p.sells > 0 && p.positions > 0 && p.helped <= p.positions);
    assert.equal([...p.sellsByTicker.values()].reduce((a, b) => a + b, 0), p.sells);
    assert.ok(r.trades > 86, 'the steps are trades too');
    assert.ok(Number.isFinite(p.leftOnTableSheet) && Number.isFinite(p.leftOnTableReal) && p.roiRatio != null);
    // the exit's random-signal null: no layers, the same number of partial sells on random held days
    const days = new Map([...p.heldDaysByTicker].map(([t, ds]) => [t, new Set(ds.filter((_, i) => i % 50 === 0))]));
    const n = runPortfolio('trend', BAG, INP, '2015-01-01', '2022-12-31', { slots: 3, cash: 100_000, trendDays: 200, profitTaking: { schedule: 'A20', randomSells: days } });
    assert.ok(n.profitTaking!.sells > 0 && n.profitTaking!.sells <= [...days.values()].reduce((a, s) => a + s.size, 0));
  });

  test('holding with a schedule: plain holding is the control; a step pays its tax and the rest stays held', () => {
    const own = holdWithSchedule(BAG, INP, '2015-01-01', '2022-12-31', 'own');
    const a20 = holdWithSchedule(BAG, INP, '2015-01-01', '2022-12-31', 'A20');
    assert.equal(own.trades, BAG.length);
    assert.ok(a20.trades > own.trades && a20.finalTaxed !== own.finalTaxed);
    assert.equal(improves({ finalTaxed: 200_000, maxDrawdownPct: 30, trades: 0 }, { finalTaxed: 210_000, maxDrawdownPct: 45, trades: 0 }), true, 'a fall cut by 15 points keeping 90%+ of the gain counts');
    assert.equal(improves({ finalTaxed: 150_000, maxDrawdownPct: 30, trades: 0 }, { finalTaxed: 210_000, maxDrawdownPct: 45, trades: 0 }), false);
  });

  test('liloDay: the option replaces T1 / T2 with the schedule; the rest is not sold when the rungs are done; the tax is per step', () => {
    const levels = pad([110, 120, 130, 140, 150]);
    const sig = new Map([['X', { rank: 1, entryLow: 95, entryHigh: 100, entryCount: 1, t1: 105, t2: 108, stop: 50 }]]);
    const run = (opts: Parameters<typeof liloDay>[7]): { trades: ReturnType<typeof liloDay>; held: number } => {
      const b = newLiloBook(100_000);
      const day = (bar: LiloBar, s: typeof sig | null): ReturnType<typeof liloDay> => liloDay(b, 1, new Map([['X', bar]]), { open: 500, close: 500 }, s, true, 0, opts);
      day({ open: 100, high: 101, low: 99, close: 100 }, sig);
      const t = [...day({ open: 99, high: 100, low: 94, close: 98 }, null), ...day({ open: 109, high: 125, low: 108, close: 121 }, null)];
      return { trades: t.filter((x) => x.ticker === 'X'), held: b.lines.X?.shares ?? 0 };
    };
    const plain = run(undefined);
    assert.ok(plain.trades.some((x) => x.why.startsWith('LILO target')), 'T1 / T2 without the option');
    const pt = run({ profitTaking: { schedule: 'A20', layersOf: () => levels } });
    const sells = pt.trades.filter((x) => x.side === 'SELL');
    assert.deepEqual(sells.map((x) => x.price), [110, 120], 'layers 6 and 7 of the schedule');
    assert.ok(sells.every((x) => x.why.startsWith('James — Profit-Taking A20')));
    const bought = pt.trades.find((x) => x.side === 'BUY')!;
    near(sells[0]!.tax, (sells[0]!.shares * 110 - sells[0]!.shares * bought.price) * EXIT_TAX_RATE, 1e-6, 'tax on the step\'s own gain');
    assert.ok(pt.held > 0, 'the rest stays held');
  });

  test('the report page\'s five tables are the sheet for 100 shares at today\'s close', () => {
    const s = loadSeries('NVDA');
    const r = buildJamesLayersRead(s, PT_PAGE.layers, '10y');
    assert.equal(r.status, 'ok');
    const page = formatProfitTakingPage('NVDA', r);
    for (const id of PT_SCHEDULES) {
      const t = sheetTable(r.close!, 100, scheduleLevels(r.levels, id), id);
      assert.ok(page.includes('Value if held to the last step: $' + t.hodl.toFixed(2) + '; money left on the table: $' + t.leftOnTable.toFixed(2)), id);
    }
    assert.ok(page.includes('This is an exit plan for shares you already own. It does not say buy.'));
    assert.ok(page.includes('[chosen]') && page.includes('James — Profit-Taking'));
  });
});
