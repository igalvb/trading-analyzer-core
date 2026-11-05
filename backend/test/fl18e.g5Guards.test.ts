/**
 * FL-18e (James's models, phase 0, G5 b-e; docs/models/MASTER_PLAN.md section 6 T1, T2, T4-T6): the shared `costBps`
 * in the research engines and yardsticks (unset = today's results exactly), the sweep guard, the random-signal null,
 * random bags without QQQ / SPY / ^VIX, the universe minus the 14, and the "join when listed" yardstick. Fixtures only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolio, runPortfolioNull, holdBag, type PortfolioInput } from '../src/research/portfolioLab.ts';
import { holdLab } from '../src/research/lab.ts';
import { newLiloBook, liloDay } from '../src/research/liloBook.ts';
import { holdCurve, benchmarksFor, benchRows, reportTable, JOIN_WHEN_LISTED_NOTE } from '../src/research/benchmarks.ts';
import { sweepGuard, randomSignalDays, randomSignalNull, nullVerdict, mulberry32, quantile, SWEEP_CAP, type SweepSetup } from '../src/research/guards.ts';
import { randomBags, universeMinusList, OWNER_BAG } from '../src/research/portfolioCli.ts';
import { RESEARCH_UNIVERSE } from '../src/research/fetchPrices.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import type { CompactRead } from '../src/research/computeReads.ts';

const ser = (t: string, dates: string[], px: number[]): PriceSeries => ({ ticker: t, dates, opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1), splits: [] });
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
const read = (d: string, dir: string): CompactRead => ({ d, ok: 1, c: 50, tm: 'WAIT_PULLBACK', ep: null, st: null, ec: null, v: 'MAJORITY', dir, wy: null, lz: null, cl: null });
/** fl15c's fixture: Turtle buys AAA on 01-02's read (fills 01-03 at 10) and sells on 01-04's (fills 01-05 at 15). */
const inp = (dirs: Record<string, string> = { '2024-01-02': 'mmmmb', '2024-01-04': 'mmmmc' }): PortfolioInput => ({
  series: new Map([['AAA', ser('AAA', days, [10, 10, 12, 15, 15])], ['BBB', ser('BBB', days, [20, 20, 20, 20, 20])]]),
  reads: new Map([['AAA', new Map(Object.entries(dirs).map(([d, x]) => [d, read(d, x)]))], ['BBB', new Map()]]),
  qqq: ser('QQQ', days, [100, 100, 100, 100, 100]),
});
const longDates = (): string[] => { const out: string[] = []; const d = new Date('2009-12-01T12:00:00Z'); while (d.toISOString() < '2026-10-28') { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };

describe('FL-18e — G5(b) costBps', () => {
  test('unset and 0 give the same result, field for field (free play, trims, QQQ funding, idle money)', () => {
    const dates = longDates();
    const wave = (base: number, f: number) => dates.map((_, i) => base * 1.0004 ** i * (1 + 0.15 * Math.sin(i / f)));
    const p: PortfolioInput = { series: new Map([['AAA', ser('AAA', dates, wave(50, 40))], ['BBB', ser('BBB', dates, wave(20, 25))]]), reads: new Map(), qqq: ser('QQQ', dates, wave(100, 60)) };
    for (const o of [{ slots: 1, cash: 100_000 }, { slots: 2, cash: 100_000, free: true }, { slots: 1, cash: 100_000, idle: 'qqqTrend' as const, exit: 'trend' as const }]) {
      const a = runPortfolio('trend', ['AAA', 'BBB'], p, '2010-01-01', '2026-10-27', o), b = runPortfolio('trend', ['AAA', 'BBB'], p, '2010-01-01', '2026-10-27', { ...o, costBps: 0 });
      assert.ok(a.trades > 4, 'the fixture trades');
      assert.deepEqual(b, a);
      const c = runPortfolio('trend', ['AAA', 'BBB'], p, '2010-01-01', '2026-10-27', { ...o, costBps: 10 });
      assert.ok(c.finalTaxed < a.finalTaxed, 'a cost only takes money away');
    }
  });

  test('runPortfolio at 10 bps: every buy and sell pays it (QQQ included); the cost of a buy is in its basis', () => {
    // all in QQQ at 100.10 a share: 999 shares, 0.10 left; flat, so no tax and no exit cost at the end
    assert.ok(close(runPortfolio('turtle', ['AAA', 'BBB'], inp({}), '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000, costBps: 10 }).finalTaxed, 99_900.1));
    // 01-03: 200 QQQ sold for a slot (19,980 after 20 cost, at a loss: no tax); 1,996 AAA at 10.01 = 19,979.96.
    // 01-05: AAA sold for 29,940 - 29.94 cost; gain 9,930.10, tax 2,482.525; 274 QQQ bought at 100.10. End: 1,073 QQQ at 100 + 0.275 cash.
    const r = runPortfolio('turtle', ['AAA', 'BBB'], inp(), '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000, costBps: 10 });
    assert.equal(r.trades, 2);
    assert.ok(close(r.finalTaxed, 107_300.275), String(r.finalTaxed));
    assert.deepEqual([...r.buysByTicker], [['AAA', 1]]);
  });

  test('the yardsticks pay it once, at the entry: holdLab, holdBag, benchmarksFor', () => {
    const s = ser('QQQ', ['2024-01-02', '2024-01-03'], [100, 200]);
    // 999 shares at 100.10 = 99,999.90; worth 199,800; tax on 99,800.10
    assert.ok(close(holdLab(s, '2024-01-01', '2024-12-31', 100_000, 10)!, 174_850.075));
    assert.equal(holdLab(s, '2024-01-01', '2024-12-31', 100_000, 0), holdLab(s, '2024-01-01', '2024-12-31', 100_000));
    const dates = ['2010-01-04', '2010-01-05', '2010-01-06', '2020-01-02', '2020-01-03', '2024-01-02', '2024-01-03'];
    const qqq = ser('QQQ', dates, [100, 50, 200, 100, 100, 100, 100]);
    const p: PortfolioInput = { series: new Map([['AAA', ser('AAA', dates, [10, 10, 30, 10, 10, 10, 10])], ['BBB', ser('BBB', dates, [10, 5, 10, 10, 10, 10, 10])]]), reads: new Map(), qqq };
    const bm = benchmarksFor(['AAA', 'BBB'], p, 100_000, { costBps: 10 });
    assert.ok(close(bm.qqq[0]!.finalTaxed, 174_850.075));
    // 4,995 of each at 10.01: AAA worth 149,850 (tax 24,962.5125), BBB 49,950 (a loss)
    assert.ok(close(bm.list[0]!.finalTaxed, 174_837.5875));
    assert.ok(close(holdBag(['AAA', 'BBB'], p, '2010-01-01', '2019-12-31', 100_000, 10), 174_837.5875));
    assert.deepEqual(benchmarksFor(['AAA', 'BBB'], p, 100_000, { costBps: 0 }), benchmarksFor(['AAA', 'BBB'], p, 100_000));
  });

  test('liloDay at 10 bps: parking in QQQ and a stop sale pay it; 0 is the paper test\'s default', () => {
    const b = newLiloBook(10_000);
    liloDay(b, 3, new Map(), { open: 100, close: 100 }, null, true, 10);
    assert.equal(b.qqq.shares, 99);
    assert.ok(close(b.cash, 90.1) && close(b.qqq.cost, 9_909.9));
    const b0 = newLiloBook(10_000), bd = newLiloBook(10_000);
    liloDay(b0, 3, new Map(), { open: 100, close: 100 }, null, true, 0); liloDay(bd, 3, new Map(), { open: 100, close: 100 }, null);
    assert.deepEqual(b0, bd);
    const s = newLiloBook(0);
    s.lines.AAA = { shares: 100, cost: 1_000, buyRungs: [], sellRungs: [], stop: 9, age: 0, reserved: 0, funded: true };
    const t = liloDay(s, 3, new Map([['AAA', { open: 9.5, high: 9.5, low: 8, close: 8.5 }]]), null, null, true, 10);
    assert.equal(t[0]!.why, 'LILO stop');
    assert.ok(close(s.cash, 900 - 0.9), 'sold at the stop, 0.90 cost, a loss: no tax');
  });
});

describe('FL-18e — G5(e) "join when listed" yardstick', () => {
  const dd = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07'];
  const aaa = ser('AAA', dd, [10, 10, 10, 20]), late = ser('NEW', dd.slice(2), [5, 15]);
  test('a stock listed inside the period joins with its equal share, waiting in cash until its first open', () => {
    const plain = holdCurve([aaa, late], dd, 100_000), join = holdCurve([aaa, late], dd, 100_000, { join: true });
    assert.equal(plain.finalTaxed, 100_000 + 100_000 * 0.75, 'plain: AAA alone, doubled');
    // join: 5,000 AAA (worth 100,000, tax 12,500) and 10,000 NEW bought at 5 on 01-06 (worth 150,000, tax 25,000)
    assert.equal(join.finalTaxed, 87_500 + 125_000);
    assert.deepEqual([...join.cashShareByDay!.values()], [0.5, 0.5, 0, 0]);
    assert.equal(holdCurve([aaa], dd, 100_000, { join: true }).finalTaxed, plain.finalTaxed, 'nothing joins: the same as the plain one');
  });
  test('benchmarksFor gives it; benchRows and reportTable show it with the note', () => {
    const dates = ['2010-01-04', '2010-01-05', '2020-01-02', '2020-01-03', '2024-01-02', '2024-01-03'];
    const p: PortfolioInput = { series: new Map([['AAA', ser('AAA', dates, [10, 20, 10, 20, 10, 20])], ['NEW', ser('NEW', dates.slice(3), [10, 10, 10])]]), reads: new Map(), qqq: ser('QQQ', dates, [100, 100, 100, 100, 100, 100]) };
    const bm = benchmarksFor(['AAA', 'NEW'], p, 100_000);
    assert.equal(bm.list[1]!.finalTaxed, 175_000, 'plain: NEW is not trading on 2020-01-02');
    assert.equal(bm.listJoin[1]!.finalTaxed, 87_500 + 50_000, 'join: half waits for NEW, flat');
    assert.equal(bm.listJoin[2]!.finalTaxed, bm.list[2]!.finalTaxed, 'both trade on the first day');
    const rows = benchRows(bm, 100_000, 1, ['fall']);
    assert.equal(rows.length, 3);
    assert.match(rows[2]!, /^\| \*\*Hold your list equally \(join when listed\)\*\* \| \+75% \| \+38% \| /);
    const table = reportTable(bm, [], p.qqq, 100_000);
    assert.ok(table.includes(JOIN_WHEN_LISTED_NOTE) && table.some((l) => l.startsWith('| **Hold your list equally (join when listed)**')));
  });
});

describe('FL-18e — G5(c) sweep guard (T1, T2)', () => {
  const grid = (inS: (a: number, b: number) => number): SweepSetup[] => [0, 1, 2].flatMap((a) => [0, 1, 2].map((b) => ({ name: 'a' + a + 'b' + b, knobs: { a, b }, finals: [inS(a, b), 100 + 10 * a, 200 - 10 * b] })));
  const qqq = [150, 150, 150];
  test('the pick is the best 2010-2019 setup; stable neighbourhood keeps it; out-of-sample percentile, share beating QQQ, median and spread', () => {
    const g = sweepGuard(grid((a, b) => 140 + 10 * a + 10 * b), 'a0b0', qqq);
    assert.equal(g.defaultSetup.name, 'a0b0');
    assert.equal(g.picked.name, 'a2b2');
    assert.equal(g.neighbours, 2); assert.equal(g.neighboursBeatingQqq, 2); assert.equal(g.stable, true);
    assert.equal(g.chosen.name, 'a2b2');
    assert.equal(g.periods[0], null, '2010-2019 is in-sample');
    assert.deepEqual(g.periods[1], { percentile: 100, beatingQqqPct: 0, median: 110, q1: 100, q3: 120 });
    assert.ok(close(g.periods[2]!.percentile, 100 / 3) && g.periods[2]!.beatingQqqPct === 100 && g.periods[2]!.median === 190);
  });
  test('the pick is never chosen on a later period, and an unstable pick falls back to the pre-registered default', () => {
    const g = sweepGuard(grid((a, b) => (a === 2 && b === 2 ? 200 : 100)), 'a1b1', qqq);
    assert.equal(g.picked.name, 'a2b2', 'best in 2010-2019, although a0b0 is best in 2024-2026');
    assert.equal(g.stable, false);
    assert.equal(g.chosen.name, 'a1b1');
    assert.equal(g.periods[1]!.percentile, (6 / 9) * 100);
    assert.equal(sweepGuard(grid(() => 0), 'a0b0', qqq, { inSample: 1 }).picked.name, 'a2b0', 'a later window only where a plan states it');
    assert.equal(sweepGuard([{ name: 'only', knobs: { a: 0 }, finals: [200, 1, 1] }], 'only', qqq).stable, false, 'no neighbour: unstable');
  });
  test('the first pass is capped and must hold the default', () => {
    const many = Array.from({ length: SWEEP_CAP + 1 }, (_, k) => ({ name: 's' + k, knobs: { a: k }, finals: [k, k, k] }));
    assert.throws(() => sweepGuard(many, 's0', qqq), /over the cap of 100/);
    assert.doesNotThrow(() => sweepGuard(many.slice(0, SWEEP_CAP), 's0', qqq));
    assert.throws(() => sweepGuard(grid(() => 1), 'nope', qqq), /pre-registered default/);
  });
  test('quantile is linear between ranks', () => {
    assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
    assert.equal(quantile([1, 2, 3, 4, 5], 0.95), 4.8);
    assert.ok(Number.isNaN(quantile([], 0.5)));
  });
});

describe('FL-18e — G5(c) random-signal null (T2e)', () => {
  test('random days: the model\'s count per stock, the stock\'s own days, no repeats, the same on every run', () => {
    const daysOf = (t: string): string[] => (t === 'AAA' ? days : days.slice(0, 2));
    const r = randomSignalDays(new Map([['AAA', 3], ['BBB', 5]]), daysOf, mulberry32(7));
    assert.equal(r.get('AAA')!.size, 3);
    assert.deepEqual([...r.get('BBB')!].sort(), days.slice(0, 2), 'capped at the days there are');
    assert.ok([...r.get('AAA')!].every((d) => days.includes(d)));
    assert.deepEqual(randomSignalDays(new Map([['AAA', 3]]), daysOf, mulberry32(7)), randomSignalDays(new Map([['AAA', 3]]), daysOf, mulberry32(7)));
    const n = randomSignalNull(new Map([['AAA', 2]]), daysOf, (b) => [...b.get('AAA')!].reduce((a, d) => a + days.indexOf(d), 0));
    assert.equal(n.values.length, 100);
    assert.ok(n.p95 >= n.median && n.values.every((v) => v >= 1 && v <= 7));
  });
  test('runPortfolio takes the buy days in place of the model\'s buy; its sell rule stays', () => {
    const p = inp();
    const model = runPortfolio('turtle', ['AAA', 'BBB'], p, '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000 });
    const same = runPortfolio('turtle', ['AAA', 'BBB'], inp({ '2024-01-04': 'mmmmc' }), '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000, buyDays: new Map([['AAA', new Set(['2024-01-02'])]]) });
    assert.equal(same.finalTaxed, model.finalTaxed, 'the model\'s own buy day, given as a random day: the same run');
    const nul = runPortfolioNull('turtle', ['AAA', 'BBB'], p, '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000 }, model);
    assert.equal(nul.values.length, 100);
    assert.deepEqual(nul, runPortfolioNull('turtle', ['AAA', 'BBB'], p, '2024-01-01', '2024-12-31', { slots: 5, cash: 100_000 }, model), 'seeded');
    assert.ok(nul.values.every((v) => v <= model.finalTaxed + 1e-6), 'no random day beats buying at 10 before the 01-04 sell');
    assert.ok(nul.values.some((v) => v < model.finalTaxed), 'some random days buy later or never sell');
    assert.throws(() => runPortfolioNull('turtle', ['AAA'], p, '2024-01-01', '2024-12-31', { slots: 1, cash: 100_000, rebalanceDays: 5 }, model), /fill mode/);
  });
  test('the verdict: above the null\'s 95th percentile in-sample and above its median out-of-sample', () => {
    const nul = { values: [], median: 10, p95: 20 };
    assert.equal(nullVerdict({ model: 21, nul }, [{ model: 11, nul }, { model: 11, nul }]).passes, true);
    assert.equal(nullVerdict({ model: 19, nul }, [{ model: 11, nul }]).passes, false);
    assert.deepEqual(nullVerdict({ model: 21, nul }, [{ model: 11, nul }, { model: 10, nul }]).aboveMedianOutOfSample, [true, false]);
  });
});

describe('FL-18e — G5(d) random bags and the universe minus the 14 (T5)', () => {
  test('random bags never draw QQQ, SPY, ^VIX (or James\'s extra tickers), and are unchanged otherwise', () => {
    const plain = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    assert.deepEqual(randomBags(plain, 3, 4), [['B', 'C', 'D', 'G'], ['A', 'E', 'F', 'H'], ['A', 'B', 'C', 'H']], 'the same bags as before G5');
    assert.deepEqual(randomBags([...plain, 'QQQ', 'SPY', '^VIX', '_VIX', 'BTC-USD'], 3, 4), randomBags(plain, 3, 4));
    for (const b of randomBags(RESEARCH_UNIVERSE, 20, 12)) assert.ok(!b.some((t) => ['QQQ', 'SPY', '^VIX'].includes(t)), b.join());
  });
  test('the universe minus the 14 keeps the deep losers and leaves out the list and the index funds', () => {
    const u = universeMinusList(RESEARCH_UNIVERSE);
    assert.ok(!u.some((t) => OWNER_BAG.includes(t) || ['QQQ', 'SPY', '^VIX'].includes(t)));
    for (const t of ['INTC', 'WBA', 'BA', 'PYPL', 'F', 'MQZA', 'DECK', 'POOL']) assert.ok(u.includes(t), t);
    assert.equal(u.length, RESEARCH_UNIVERSE.length - OWNER_BAG.length - 3);
  });
});
