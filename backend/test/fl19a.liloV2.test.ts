/**
 * FL-19a (James's models, phase 1): G1, the layer engine, and James — LILO v2 (docs/models/plans/01-lilo-v2-original-layers.md
 * section 9): the golden-ratio geometry against James's screenshots, the anchor on NVDA, causality, the live anchor
 * on 10-year bars (G0b), the u surrogates, the book's fills, money, costs and JSON state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_MULTIPLIERS, layerPrices, upCrosses, layersAt, layerUnit, layerOf, layerTimeline, snipeLayers, pickAnchor, DEFAULT_LAYER_OPTIONS, type LayerSet,
} from '../src/analysis/models/liloLayers.ts';
import { loadSeries, type PriceSeries } from '../src/backtest/data.ts';
import { newLiloV2Book, liloV2Day, liloV2Value, LILO_V2_DEFAULT, LILO_V2_CHOSEN, type LiloV2Book, type LiloV2Options } from '../src/research/liloV2Book.ts';
import { runLiloV2, pass1, pass2 } from '../src/research/liloV2Cli.ts';
import { buildJamesLayersRead, LILO_V2_PAGE } from '../src/analysis/jamesPages.ts';
import { EXIT_TAX_RATE } from '../src/portfolio/exitTax.ts';

const PHI = (1 + Math.sqrt(5)) / 2;
const rel = (a: number, b: number, tol: number, what: string): void => assert.ok(Math.abs(a / b - 1) <= tol, what + ': ' + a + ' vs ' + b);

describe('FL-19a — the layer geometry (G1)', () => {
  test('the 11 multipliers are the golden-ratio forms', () => {
    const forms = [0, 1 - 1 / PHI, 1 / PHI, (1 + 1 / PHI) / 2, 1, Math.sqrt(PHI), PHI, PHI ** 2, PHI ** 3, PHI ** 3 + PHI, PHI ** 3 + PHI + 1];
    const recovered = [0, 0.381966, 0.618034, 0.809017, 1, 1.272019, 1.618034, 2.618034, 4.236068, 5.854102, 6.854102];
    LAYER_MULTIPLIERS.forEach((m, k) => { assert.ok(Math.abs(m - forms[k]!) < 1e-12, 'form ' + k); assert.ok(Math.abs(m - recovered[k]!) < 1e-6, 'recovered ' + k); });
  });

  test('James\'s screenshots are reproduced from their L0 and u (NVDA 2023-09-28 and 2023-11-21, BTC 2023-11-16, SOL 2023-11-01)', () => {
    const cases: Array<[string, number, number, number[]]> = [
      ['NVDA 2023-09-28', 165.11, 58.694, [165.11, 187.52398, 201.39026, 212.59725, 223.80424, 239.75996, 260.0845, 318.77874, 413.75323, 508.72773, 567.42197]],
      ['NVDA 2023-11-21', 168.99, 56.25663, [168.99, 190.47311, 203.76352, 214.50507, 225.24663, 240.53969, 260.02014, 316.27677, 407.30692, 498.33706, 554.59369]],
      ['BTC 2023-11-16', 19931, 5757.1115, [19931, 22129.50861, 23489.60291, 24588.85721, 25688.11152, 27253.45154, 29246.71443, 35003.82595, 44319.54037, 53635.2548]],
      ['SOL 2023-11-01', 19.61, 9.11854, [19.61, 23.09216, 25.24638, 26.98746, 28.72854, 31.20737, 34.36493, 43.48347, 58.23839]],
    ];
    for (const [name, L0, u, shot] of cases) {
      const ours = layerPrices(L0, u);
      shot.forEach((p, k) => rel(ours[k]!, p, 1e-4, name + ' layer ' + k));
    }
    assert.ok(Math.abs(layerPrices(165.11, 58.694)[8]! - 413.75) < 0.02 && Math.abs(layerPrices(165.11, 58.694)[10]! - 567.42) < 0.02, 'L8 413.75, L10 567.42');
  });

  test('layerOf: under L0 is -1, between L_k and L_k+1 is k, above L10 is 10; snipe layers are the highest layers under the close, at most layer 8, not bought', () => {
    const lv = layerPrices(100, 50);
    assert.equal(layerOf(99, lv), -1); assert.equal(layerOf(100, lv), 0); assert.equal(layerOf(lv[7]! + 0.01, lv), 7); assert.equal(layerOf(10_000, lv), 10);
    assert.deepEqual(snipeLayers(lv, lv[3]! + 1, [], { depth: 2, maxBuyLayer: 8 }), [3, 2]);
    assert.deepEqual(snipeLayers(lv, lv[3]! + 1, [3], { depth: 2, maxBuyLayer: 8 }), [2, 1]);
    assert.deepEqual(snipeLayers(lv, 10_000, [], { depth: 2, maxBuyLayer: 8 }), [8, 7], 'no buy above layer 8');
    assert.deepEqual(snipeLayers(lv, 10_000, [], { depth: 1, maxBuyLayer: 5 }), [5]);
  });
});

const NVDA = loadSeries('NVDA');
const at = (d: string): number => NVDA.dates.indexOf(d);

describe('FL-19a — the anchor on NVDA (split-adjusted)', () => {
  test('A2 at 2023-02-01 is the 2023-01-13 close 16.899 (James\'s 168.99 before the 10:1 split); 2023-01-12 is not a cross', () => {
    const ls = layersAt(NVDA, at('2023-02-01'), { anchor: 'A2', minAge: 63, unit: 'U1', k: 5 })!;
    assert.equal(ls.anchorDate, '2023-01-13');
    assert.ok(Math.abs(ls.L0 - 16.899) < 0.001);
    const c = upCrosses(NVDA.closes);
    assert.ok(c.includes(at('2023-01-13')) && !c.includes(at('2023-01-12')));
  });

  test('A1 at 2023-03-01 still uses the cross before (the 01-13 cross is under 63 bars old); from 63 bars on it uses 01-13', () => {
    const a = layersAt(NVDA, at('2023-03-01'), DEFAULT_LAYER_OPTIONS)!;
    assert.ok(a.anchorDate! < '2023-01-13');
    const later = layersAt(NVDA, at('2023-01-13') + 63, DEFAULT_LAYER_OPTIONS)!;
    assert.equal(later.anchorDate, '2023-01-13');
  });

  test('U1 on 2023-01-12 = 5 x the 50-day SD = 5.8704 (x10 = 58.704, the screenshot\'s 58.694); U3 = k x the 20-day average true range (7.43 at 01-13 x10)', () => {
    rel(layerUnit(NVDA, at('2023-01-12'), 'U1', 5)!, 5.8704, 0.001, 'U1');
    rel(layerUnit(NVDA, at('2023-01-13'), 'U3', 1)!, 0.743, 0.002, 'ATR20');
    rel(layerUnit(NVDA, at('2023-01-13'), 'U2', 0.35)!, 0.35 * 16.899, 0.0001, 'U2');
  });

  test('U4 with A2 or A3: no layers until the anchor is 63 bars old', () => {
    for (const anchor of ['A2', 'A3'] as const) {
      const o = { anchor, minAge: 63, unit: 'U4' as const, k: 5 };
      assert.equal(layersAt(NVDA, at('2023-02-01'), o), null, anchor);
      const ok = layersAt(NVDA, at('2023-01-13') + 63, o);
      assert.ok(ok && ok.anchorDate === '2023-01-13', anchor);
    }
    assert.equal(pickAnchor([10], 50, 'A2', 63, 'U4'), -1);
  });

  test('causal: the layers on a day never change when later bars are added', () => {
    const cut = (n: number): PriceSeries => ({ ...NVDA, dates: NVDA.dates.slice(0, n), opens: NVDA.opens.slice(0, n), highs: NVDA.highs.slice(0, n), lows: NVDA.lows.slice(0, n), closes: NVDA.closes.slice(0, n), volumes: NVDA.volumes.slice(0, n) });
    for (const d of ['2019-06-03', '2021-03-15', '2023-05-01', '2024-08-05']) for (const o of [DEFAULT_LAYER_OPTIONS, LILO_V2_CHOSEN.layers, { anchor: 'A3' as const, minAge: 63, unit: 'U4' as const, k: 5 }]) {
      const i = at(d);
      assert.deepEqual(layersAt(cut(i + 1), i, o), layersAt(NVDA, i, o), d);
      assert.deepEqual(layerTimeline(NVDA, o)[i], layersAt(NVDA, i, o), 'timeline ' + d);
    }
  });
});

describe('FL-19a — the live anchor on the 10-year bars (G0b)', () => {
  test('a last up-cross 3 years old with the price above the 200-day since: found on 10-year bars, not on 2 years', () => {
    const n = 1100, closes: number[] = [];
    for (let i = 0; i < n; i++) closes.push(i < 300 ? 100 - i * 0.15 : 55 + (i - 300) * 0.25);
    const dates = closes.map((_, i) => new Date(Date.UTC(2022, 0, 3) + i * 86_400_000).toISOString().slice(0, 10));
    const bars = { dates, closes, highs: closes.map((c) => c * 1.01), lows: closes.map((c) => c * 0.99) };
    const long = buildJamesLayersRead(bars, LILO_V2_PAGE.layers, '10y');
    assert.equal(long.status, 'ok');
    assert.ok(n - 1 - dates.indexOf(long.anchorDate!) > 504, 'the anchor is older than 2 years of bars');
    const two = buildJamesLayersRead({ dates: dates.slice(-504), closes: closes.slice(-504), highs: bars.highs.slice(-504), lows: bars.lows.slice(-504) }, LILO_V2_PAGE.layers, '2y');
    assert.equal(two.status, 'noAnchor');
  });

  test('the report page keeps the setup chosen on 2010-2019 (research LILO_V2_CHOSEN)', () => {
    assert.deepEqual(LILO_V2_PAGE.layers, LILO_V2_CHOSEN.layers);
    assert.equal(LILO_V2_PAGE.schedule, LILO_V2_CHOSEN.book.schedule);
    assert.equal(LILO_V2_PAGE.stop, LILO_V2_CHOSEN.book.stop);
    assert.equal(LILO_V2_PAGE.depth, LILO_V2_CHOSEN.book.depth);
    assert.equal(LILO_V2_PAGE.maxBuyLayer, LILO_V2_CHOSEN.book.maxBuyLayer);
  });
});

// ─────────────────────────────── the book ───────────────────────────────

const LS: LayerSet = { anchorIndex: 5, anchorDate: '2026-01-02', L0: 100, u: 40, levels: layerPrices(100, 40) };
const O: LiloV2Options = { ...LILO_V2_DEFAULT, slots: 1 };
const bar = (open: number, high: number, low: number, close: number) => ({ open, high, low, close });
const Q = { open: 500, close: 500 };

describe('FL-19a — James — LILO v2 book', () => {
  test('the first night places snipe buys at the next 2 layers under the close; a gap down through a layer fills at the open; each layer buys once', () => {
    const b = newLiloV2Book(100_000);
    const close = LS.levels[4]! + 1;
    liloV2Day(b, O, { bars: new Map([['X', bar(close, close, close, close)]]), qqq: Q, layers: new Map([['X', LS]]), fill: false });
    assert.deepEqual(b.lines.X!.orders.map((r) => r.layer), [4, 3]);
    assert.equal(b.lines.X!.orders[0]!.shares, Math.floor(25_000 / LS.levels[4]!), 'a quarter of the stock\'s budget');
    // the next day opens under layer 4: it fills at the open; the low reaches layer 3: it fills at the layer
    const open = LS.levels[4]! - 2;
    const t = liloV2Day(b, O, { bars: new Map([['X', bar(open, open, LS.levels[3]! - 0.5, LS.levels[3]! + 0.2)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true });
    const buys = t.filter((x) => x.ticker === 'X' && x.side === 'BUY');
    assert.deepEqual(buys.map((x) => x.price), [open, LS.levels[3]]);
    assert.deepEqual(b.lines.X!.bought.sort(), [3, 4]);
    assert.ok(!b.lines.X!.orders.some((r) => r.layer === 3 || r.layer === 4), 'each layer buys once per anchor');
  });

  test('layer-out: a high touching layer 6 sells 20% at the layer (A20); gaps sell several steps at the open; a new anchor resets the layers', () => {
    const b = newLiloV2Book(100_000);
    const close = LS.levels[3]! + 1;
    liloV2Day(b, O, { bars: new Map([['X', bar(close, close, close, close)]]), qqq: Q, layers: new Map([['X', LS]]), fill: false });
    liloV2Day(b, O, { bars: new Map([['X', bar(close, close, LS.levels[2]! - 1, close)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true });
    const held = b.lines.X!.shares;
    assert.ok(held > 0);
    const t = liloV2Day(b, O, { bars: new Map([['X', bar(LS.levels[5]!, LS.levels[6]! + 0.5, LS.levels[5]!, LS.levels[6]!)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true });
    const s = t.find((x) => x.ticker === 'X' && x.side === 'SELL')!;
    assert.equal(s.price, LS.levels[6]); assert.equal(s.shares, Math.round(held * 0.2));
    const g = liloV2Day(b, O, { bars: new Map([['X', bar(LS.levels[8]! + 1, LS.levels[8]! + 2, LS.levels[8]!, LS.levels[8]! + 1)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true });
    assert.deepEqual(g.filter((x) => x.ticker === 'X' && x.side === 'SELL').map((x) => x.price), [LS.levels[8]! + 1, LS.levels[8]! + 1], 'layers 7 and 8 at the open');
    const NEW: LayerSet = { ...LS, anchorIndex: 99, L0: 150, levels: layerPrices(150, 40) };
    liloV2Day(b, O, { bars: new Map([['X', bar(200, 200, 200, 200)]]), qqq: Q, layers: new Map([['X', NEW]]), fill: true });
    assert.equal(b.lines.X!.anchorIndex, 99); assert.deepEqual(b.lines.X!.bought, []); assert.equal(b.lines.X!.pt!.fired, 0, 'held shares adopt the new layers');
  });

  test('money: cash follows every trade (costs into the buy, out of the sale, the 25% tax on each gain); 10 bps on every fill; the state survives JSON between days', () => {
    const run = (cost: number, viaJson: boolean): { b: LiloV2Book; trades: ReturnType<typeof liloV2Day> } => {
      let b = newLiloV2Book(100_000);
      const o = { ...O, costBps: cost };
      const all: ReturnType<typeof liloV2Day> = [];
      const path = [LS.levels[4]! + 1, LS.levels[3]! - 0.2, LS.levels[2]! - 0.1, LS.levels[5]!, LS.levels[6]! + 0.1, LS.levels[7]! + 0.3, LS.levels[6]!, LS.levels[9]! + 1];
      path.forEach((p, k) => {
        if (viaJson) b = JSON.parse(JSON.stringify(b)) as LiloV2Book;
        all.push(...liloV2Day(b, o, { bars: new Map([['X', bar(p, p + 0.5, p - 0.5, p)]]), qqq: { open: 500 + k, close: 500 + k }, layers: new Map([['X', LS]]), fill: k > 0 }));
      });
      return { b, trades: all };
    };
    for (const cost of [0, 10]) {
      const { b, trades } = run(cost, false);
      const c = cost / 10_000;
      const cash = trades.reduce((a, x) => a + (x.side === 'BUY' ? -x.shares * x.price * (1 + c) : x.shares * x.price * (1 - c) - x.tax), 100_000);
      assert.ok(Math.abs(cash - b.cash) < 1e-6, 'cash ' + cash + ' vs ' + b.cash);
      assert.ok(trades.some((x) => x.ticker === 'X' && x.side === 'SELL' && x.tax > 0));
      for (const x of trades.filter((y) => y.side === 'SELL' && y.ticker === 'X')) assert.ok(x.tax >= 0);
      assert.deepEqual(run(cost, true).b, b, 'JSON between days changes nothing');
    }
    const plain = run(0, false).b, costly = run(10, false).b;
    assert.ok(liloV2Value(costly, () => 600) < liloV2Value(plain, () => 600), '10 bps costs money');
    for (const x of run(0, false).trades.filter((y) => y.ticker === 'X' && y.side === 'SELL')) assert.ok(x.tax <= x.shares * x.price * EXIT_TAX_RATE, 'the tax is 25% of the gain, never more than 25% of the sale');
  });

  test('a stop (P9) sells everything at the next open and blocks that anchor; the random-signal null buys one tranche on its days instead of sniping', () => {
    const b = newLiloV2Book(100_000);
    const o = { ...O, stop: 'belowL0' as const };
    const close = LS.levels[2]! + 1;
    liloV2Day(b, o, { bars: new Map([['X', bar(close, close, close, close)]]), qqq: Q, layers: new Map([['X', LS]]), fill: false });
    liloV2Day(b, o, { bars: new Map([['X', bar(close, close, LS.levels[1]! - 1, LS.levels[1]!)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true, stopHit: () => false });
    liloV2Day(b, o, { bars: new Map([['X', bar(99, 99, 95, 95)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true, stopHit: (t, l) => 95 < l.L0 });
    assert.ok(b.lines.X!.sellAll && b.blocked.X === LS.anchorIndex);
    const t = liloV2Day(b, o, { bars: new Map([['X', bar(96, 97, 94, 96)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true });
    assert.ok(t.some((x) => x.ticker === 'X' && x.side === 'SELL' && x.price === 96 && x.why.includes('stop')));
    assert.equal(b.lines.X, undefined, 'no more buys at this anchor');
    const r = newLiloV2Book(100_000);
    liloV2Day(r, O, { bars: new Map([['X', bar(close, close, close, close)]]), qqq: Q, layers: new Map([['X', LS]]), fill: false, randomBuy: new Set(['X']) });
    assert.equal(r.lines.X!.orders.length, 0); assert.ok(r.lines.X!.marketBuy > 0);
    const rt = liloV2Day(r, O, { bars: new Map([['X', bar(close + 3, close + 4, close + 2, close + 3)]]), qqq: Q, layers: new Map([['X', LS]]), fill: true, randomBuy: new Set() });
    assert.equal(rt.find((x) => x.ticker === 'X' && x.side === 'BUY')!.price, close + 3, 'at the open');
  });

  test('the research run: the pre-registered default on two stocks; pass 1 is 90 setups (under the T2 cap); pass 2 varies one knob at a time', () => {
    const inp = { series: new Map([['NVDA', NVDA], ['TSLA', loadSeries('TSLA')]]), qqq: loadSeries('QQQ') };
    const r = runLiloV2(['NVDA', 'TSLA'], inp, '2018-01-01', '2022-12-31', { name: 'd', layers: DEFAULT_LAYER_OPTIONS, book: LILO_V2_DEFAULT });
    assert.ok(r.finalTaxed > 0 && r.trades > 0 && r.maxDrawdownPct > 0 && r.cashShareByDay.size > 1000);
    assert.equal(pass1().length, 90);
    assert.ok(pass2(LILO_V2_CHOSEN).length >= 14 && pass2(LILO_V2_CHOSEN).every((s) => s.name.startsWith(LILO_V2_CHOSEN.name + ' + ')));
  });
});
