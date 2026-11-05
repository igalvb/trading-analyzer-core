/**
 * James — LILO v2, the original layers, across several stocks (docs/models/plans/01-lilo-v2-original-layers.md).
 *
 * Layers from G1 (analysis/models/liloLayers.ts): 11 golden-ratio levels above the anchor (the close of a 200-day
 * up-cross). Layer in with "snipe layers" (S4): resting limit buys at the next one or two unfilled layers below the
 * close, up to layer 8 (P3, P4); each layer buys once per anchor (equal money per filled layer, P5). Layer out at
 * layers 6-10 by James's profit-taking schedule (models/profitTaking.ts, P8). No stop, no buy-back above the sell
 * layer, orders without expiry (P9, P11, P13). At most `slots` stocks at a time, each with 1/slots of the account
 * when it takes its place (P6); money not set aside for tonight's resting orders waits in QQQ (P12). 25% tax on every
 * sale's gain (QQQ included); the shared `costBps` (G5) on every buy and sell.
 *
 * Choices the plan leaves open, with the default used here (listed in docs/models/results/phase1.md):
 *   - a free place goes to the stock whose nearest snipe layer is closest under its close (the plan gives no rank);
 *   - a stock keeps its place while it holds shares or has resting orders (P13: orders rest until filled);
 *   - money is set aside each night only for the orders resting for the next day (the rest of the stock's budget
 *     stays in QQQ), so the cash share is the "unfilled-order reserve" of the best-days check;
 *   - P2 of plan 02: a sell layer at or under the position's cost per share is skipped (never sold at a loss);
 *   - B schedules: r0 = the shares held when the first step is due, plus any later buy;
 *   - a stop (P9 variants) blocks that anchor: no more buys until a new up-cross.
 *
 * Plain JSON state (as liloBook.ts), so the paper test can keep it between nights.
 */

import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { snipeLayers, DEFAULT_LAYER_OPTIONS, type LayerSet, type LayerOptions } from '../analysis/models/liloLayers.ts';
import { newPtState, profitTakingFills, noteStep, type PtSchedule, type PtState } from '../analysis/models/profitTaking.ts';

export interface LiloV2Bar { readonly open: number; readonly high: number; readonly low: number; readonly close: number }

export type LiloV2Stop = 'none' | 'belowL0' | 'trend200' | 'below200x5';

export interface LiloV2Options {
  /** P6: stocks at a time (5). */
  readonly slots: number;
  /** P5: tranches per stock's budget (4). */
  readonly tranches: number;
  /** P5 variant: 'lowerBigger' = layers 0-2 buy twice the money of layers 3+. */
  readonly weights?: 'equal' | 'lowerBigger';
  /** P3: snipe layers below the close (2). */
  readonly depth: number;
  /** P4: the highest layer bought (8). */
  readonly maxBuyLayer: number;
  /** P7: one tranche at the next open when the stock takes its place (false). */
  readonly firstBuy: boolean;
  /** P8: the layer-out schedule ('A20'), or 'none' (hold). */
  readonly schedule: PtSchedule | 'none';
  /** P9 (the caller decides it at the close and passes `stopHit`). */
  readonly stop: LiloV2Stop;
  /** P12: where idle money waits (the caller passes `idleOut` for 'qqqTrend'). */
  readonly idle: 'qqq' | 'cash' | 'qqqTrend';
  /** P1: 'adopt' = held shares take a new anchor's layers at once (A1, A3); 'whenFlat' = only once the stock is flat (A2). */
  readonly reanchor: 'adopt' | 'whenFlat';
  readonly costBps?: number;
}

/** The pre-registered default (plan 01 section 6), with the default layers A1-63, U1 k=5. */
export const LILO_V2_DEFAULT: LiloV2Options = { slots: 5, tranches: 4, weights: 'equal', depth: 2, maxBuyLayer: 8, firstBuy: false, schedule: 'A20', stop: 'none', idle: 'qqq', reanchor: 'adopt', costBps: 0 };

/** A whole setup: the layers (G1) and the book's options. */
export interface LiloV2Setup { readonly name: string; readonly layers: LayerOptions; readonly book: LiloV2Options }
export const LILO_V2_DEFAULT_SETUP: LiloV2Setup = { name: 'default: A1-63, U1 k=5, A20', layers: DEFAULT_LAYER_OPTIONS, book: LILO_V2_DEFAULT };
/**
 * The setup the sweep chose on 2010-2019 only (research/liloV2Cli.ts --sweep, pass 1 + pass 2 at 10 bps,
 * docs/models/results/phase1.md): A3, U2 c = 0.35, no layer-out, stop 3% under the 200-day average. Used by the
 * profit-taking matrix's LILO v2 row and the paper account (the report page keeps the same values in
 * analysis/jamesPages.ts LILO_V2_PAGE; a test keeps them equal); `--sweep` warns when a rerun chooses otherwise.
 */
export const LILO_V2_CHOSEN: LiloV2Setup = {
  name: 'A3, U2 c=0.35, none + stop 3% under the 200-day',
  layers: { anchor: 'A3', minAge: 63, unit: 'U2', k: 0.35 },
  book: { ...LILO_V2_DEFAULT, schedule: 'none', stop: 'trend200' },
};

export interface LiloV2Order { layer: number; price: number; shares: number }
export interface LiloV2Line {
  shares: number; cost: number;
  /** The money this stock may have invested (1/slots of the account when it took its place). */
  budget: number;
  anchorIndex: number; L0: number; u: number; levels: number[];
  /** Layers bought at this anchor (each buys once). */
  bought: number[];
  orders: LiloV2Order[];
  /** A market buy (one tranche) at the next open: P7 or the random-signal null. */
  marketBuy: number;
  /** A sale of every share at the next open (stop). */
  sellAll: string | null;
  pt: PtState | null;
}
export interface LiloV2Book {
  cash: number; qqq: { shares: number; cost: number }; lines: Record<string, LiloV2Line>;
  /** Anchors closed by a stop (ticker -> anchor bar index): no more buys until a new up-cross. */
  blocked: Record<string, number>;
}
export interface LiloV2Trade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string }

export const newLiloV2Book = (cash: number): LiloV2Book => ({ cash, qqq: { shares: 0, cost: 0 }, lines: {}, blocked: {} });

export interface LiloV2DayInput {
  /** Today's bars of the stocks. */
  readonly bars: ReadonlyMap<string, LiloV2Bar>;
  readonly qqq: { readonly open: number; readonly close: number } | null;
  /** The layers in force at today's close (bars up to today); null = no decisions tonight. */
  readonly layers: ReadonlyMap<string, LayerSet | null> | null;
  /** false: the close only (the first night). */
  readonly fill: boolean;
  /** P9: the stop rule fires at today's close for this stock. */
  readonly stopHit?: (ticker: string, line: LiloV2Line) => boolean;
  /** P12 'qqqTrend': QQQ's trend is down tonight (idle money goes to cash). */
  readonly idleOut?: boolean;
  /** Random-signal null (master T2e): tonight's random buy days; replaces the snipe orders (one tranche at the next open). */
  readonly randomBuy?: ReadonlySet<string> | null;
}

const trancheOf = (o: LiloV2Options, budget: number, layer: number): number => {
  if (o.weights !== 'lowerBigger') return budget / o.tranches;
  // layers 0-2 twice the money of layers 3+: weights 2, 2, 2, 1, 1, ... normalised over `tranches` average buys
  return (budget / o.tranches) * (layer <= 2 ? 4 / 3 : 2 / 3);
};

export { snipeLayers };

/**
 * One trading day: the open (stop sales and market buys, then the money for tonight's resting orders from QQQ and the
 * rest into QQQ), the day (limit buys at layers, the schedule's sells at layers 6-10), the close (new layers, stops,
 * places for new stocks, tonight's snipe orders).
 */
export function liloV2Day(b: LiloV2Book, o: LiloV2Options, x: LiloV2DayInput): LiloV2Trade[] {
  const out: LiloV2Trade[] = [];
  const c = (o.costBps ?? 0) / 10_000;
  const sellQqq = (n: number, px: number, why: string): void => {
    n = Math.min(n, b.qqq.shares); if (n <= 0) return;
    const cost = (b.qqq.cost * n) / b.qqq.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    b.qqq.shares -= n; b.qqq.cost -= cost; b.cash += n * px - fee - tax;
    out.push({ ticker: 'QQQ', side: 'SELL', shares: n, price: px, tax, why });
  };
  const sellStock = (t: string, l: LiloV2Line, n: number, px: number, why: string): void => {
    n = Math.min(n, l.shares); if (n <= 0) return;
    const cost = (l.cost * n) / l.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    l.shares -= n; l.cost -= cost; b.cash += n * px - fee - tax;
    out.push({ ticker: t, side: 'SELL', shares: n, price: px, tax, why });
  };
  const buyStock = (t: string, l: LiloV2Line, n: number, px: number, why: string): void => {
    const pc = px * (1 + c);
    n = Math.min(n, Math.floor((b.cash + 1e-6) / pc)); if (n <= 0) return;
    b.cash -= n * pc; l.shares += n; l.cost += n * pc;
    if (l.pt && l.pt.fired > 0) l.pt.r0 += n;
    out.push({ ticker: t, side: 'BUY', shares: n, price: px, tax: 0, why });
  };
  const reserveOf = (): number => Object.values(b.lines).reduce((a, l) => a + l.orders.reduce((s, r) => s + r.shares * r.price * (1 + c), 0), 0);
  const idleQqq = o.idle === 'qqq' || (o.idle === 'qqqTrend' && !x.idleOut);

  // 1. the open
  if (x.fill && x.qqq) {
    for (const [t, l] of Object.entries(b.lines)) {
      const bar = x.bars.get(t);
      if (bar && l.sellAll && l.shares) { sellStock(t, l, l.shares, bar.open, l.sellAll); l.pt = null; }
      if (bar) l.sellAll = null;
    }
    const market = Object.entries(b.lines).filter(([t, l]) => l.marketBuy > 0 && x.bars.has(t));
    const need = reserveOf() + market.reduce((a, [, l]) => a + l.marketBuy, 0) - b.cash;
    if (need > 0) sellQqq(Math.ceil(need / (x.qqq.open * (1 - c))), x.qqq.open, 'money for James — LILO v2 orders');
    for (const [t, l] of market) {
      const px = x.bars.get(t)!.open;
      buyStock(t, l, Math.floor(l.marketBuy / (px * (1 + c))), px, 'James — LILO v2: one tranche at the open');
      l.marketBuy = 0;
    }
    if (!idleQqq && b.qqq.shares) sellQqq(b.qqq.shares, x.qqq.open, 'idle money to cash');
    const spare = b.cash - reserveOf();
    const pc = x.qqq.open * (1 + c), n = idleQqq ? Math.floor(spare / pc) : 0;
    if (n > 0) { b.cash -= n * pc; b.qqq.shares += n; b.qqq.cost += n * pc; out.push({ ticker: 'QQQ', side: 'BUY', shares: n, price: x.qqq.open, tax: 0, why: 'spare money' }); }
  }

  // 2. the day: limit buys at the layers, then the schedule's limit sells at layers 6-10
  for (const [t, l] of x.fill ? Object.entries(b.lines) : []) {
    const bar = x.bars.get(t);
    if (!bar) continue;
    for (const r of [...l.orders].sort((p, q) => q.price - p.price)) {
      if (bar.low > r.price) continue;
      l.orders = l.orders.filter((z) => z !== r);
      if (!l.bought.includes(r.layer)) l.bought.push(r.layer);
      buyStock(t, l, r.shares, Math.min(r.price, bar.open), 'James — LILO v2 snipe L' + r.layer + ' $' + r.price.toFixed(2));
    }
    if (l.shares && o.schedule !== 'none') {
      l.pt ??= newPtState(o.schedule, l.levels, l.shares);
      if (l.pt.fired === 0) l.pt.r0 = l.shares;
      for (const f of profitTakingFills(l.pt, bar, l.shares, 'intraday', l.cost / l.shares)) {
        const px = f.price as number;
        noteStep(l.pt, Math.min(f.shares, l.shares), px);
        sellStock(t, l, f.shares, px, 'James — LILO v2 layer-out L' + (6 + Math.min(f.step, 4)) + (f.step >= 5 ? ' x1.2^' + (f.step - 4) : '') + ', ' + o.schedule);
      }
    }
  }

  // 3. the close
  if (x.layers && x.qqq) {
    const closeOf = (t: string, l: LiloV2Line): number => x.bars.get(t)?.close ?? (l.shares ? l.cost / l.shares : 0);
    let equity = b.cash + b.qqq.shares * x.qqq.close;
    for (const [t, l] of Object.entries(b.lines)) equity += l.shares * closeOf(t, l);
    // the lines held: new anchors, stops, tonight's orders
    for (const [t, l] of Object.entries(b.lines)) {
      const bar = x.bars.get(t);
      if (!bar) continue;
      const ls = x.layers.get(t) ?? null;
      if (ls && ls.anchorIndex !== l.anchorIndex && (o.reanchor === 'adopt' || !l.shares)) {
        l.anchorIndex = ls.anchorIndex; l.L0 = ls.L0; l.u = ls.u; l.levels = [...ls.levels]; l.bought = []; l.orders = [];
        l.pt = l.shares && o.schedule !== 'none' ? newPtState(o.schedule, l.levels, l.shares) : null;
        if (o.firstBuy && !x.randomBuy) l.marketBuy = trancheOf(o, l.budget, 0);
      }
      if (l.shares && o.stop !== 'none' && x.stopHit?.(t, l)) { l.sellAll = 'James — LILO v2 stop (' + o.stop + ')'; l.orders = []; b.blocked[t] = l.anchorIndex; continue; }
      if (x.randomBuy) { l.orders = []; if (x.randomBuy.has(t) && l.cost + trancheOf(o, l.budget, 0) <= l.budget * 1.0001) l.marketBuy = trancheOf(o, l.budget, 0); }
      else if (b.blocked[t] === l.anchorIndex || !ls || ls.anchorIndex !== l.anchorIndex) l.orders = [];
      else {
        let room = l.budget - l.cost;
        l.orders = [];
        for (const k of snipeLayers(l.levels, bar.close, l.bought, o)) {
          const px = l.levels[k] as number, money = Math.min(trancheOf(o, l.budget, k), room), n = Math.floor(money / (px * (1 + c)));
          if (n <= 0) break;
          l.orders.push({ layer: k, price: px, shares: n }); room -= n * px * (1 + c);
        }
      }
      if (!l.shares && !l.orders.length && !l.marketBuy && !l.sellAll) delete b.lines[t];
    }
    // free places: new stocks
    const free = o.slots - Object.keys(b.lines).length;
    if (free > 0) {
      const cands: Array<{ t: string; ls: LayerSet; dist: number }> = [];
      for (const [t, ls] of x.layers) {
        const bar = x.bars.get(t);
        if (!ls || !bar || b.lines[t] || b.blocked[t] === ls.anchorIndex) continue;
        if (x.randomBuy) { if (x.randomBuy.has(t)) cands.push({ t, ls, dist: 0 }); continue; }
        const k = snipeLayers(ls.levels, bar.close, [], o)[0];
        if (k == null && !o.firstBuy) continue;
        cands.push({ t, ls, dist: k == null ? 1 : 1 - (ls.levels[k] as number) / bar.close });
      }
      cands.sort((p, q) => p.dist - q.dist || p.t.localeCompare(q.t));
      for (const { t, ls } of cands.slice(0, free)) {
        const budget = equity / o.slots, bar = x.bars.get(t)!;
        const l: LiloV2Line = { shares: 0, cost: 0, budget, anchorIndex: ls.anchorIndex, L0: ls.L0, u: ls.u, levels: [...ls.levels], bought: [], orders: [], marketBuy: 0, sellAll: null, pt: null };
        if (x.randomBuy || o.firstBuy) l.marketBuy = trancheOf(o, budget, 0);
        if (!x.randomBuy) {
          let room = budget - l.marketBuy;
          for (const k of snipeLayers(l.levels, bar.close, [], o)) {
            const px = l.levels[k] as number, n = Math.floor(Math.min(trancheOf(o, budget, k), room) / (px * (1 + c)));
            if (n <= 0) break;
            l.orders.push({ layer: k, price: px, shares: n }); room -= n * px * (1 + c);
          }
        }
        if (l.orders.length || l.marketBuy) b.lines[t] = l;
      }
    }
  }
  return out;
}

/** Value after the tax on what is still held. */
export function liloV2Value(b: LiloV2Book, closeOf: (t: string) => number | null): number {
  const taxed = (shares: number, cost: number, px: number): number => shares * px - Math.max(0, shares * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.qqq.shares ? taxed(b.qqq.shares, b.qqq.cost, closeOf('QQQ') ?? b.qqq.cost / b.qqq.shares) : 0);
  for (const [t, l] of Object.entries(b.lines)) if (l.shares) v += taxed(l.shares, l.cost, closeOf(t) ?? l.cost / l.shares);
  return v;
}

/** The stocks held (with shares). */
export const liloV2Held = (b: LiloV2Book): string[] => Object.keys(b.lines).filter((t) => b.lines[t]!.shares > 0).sort();
