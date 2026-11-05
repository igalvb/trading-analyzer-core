/**
 * James — Winners & Layering's book (docs/models/plans/09-winners-and-layering.md section 5): partial adds sized by the
 * price zone, cuts, the winner ranking, idle money in QQQ. Decide at the close (`winnersDecide`), fill at the next open
 * (`winnersDay`): cuts first, then the adds (each a share of the account at the open, funded from QQQ, never over the
 * per-name cap, never with money the account does not have: no leverage), then the spare money into QQQ (or cash).
 * Average cost per stock; 25% tax (EXIT_TAX_RATE) on every sale's gain, QQQ included; the shared `costBps` (G5).
 * Plain-JSON state, so the paper test keeps it between nights. Named winners* (research/winnersCli.ts is another report).
 *
 * Controls (plan 09 stage 1) run on the same book: 'compound' (top-N bought equally at the start, sold only on a weekly
 * close under the 200-day or a 35% fall from the position's high, no adds), 'monthly' (every re-rank, 4% of the account
 * into the current top-N, no zones or dips), 'lump' (top-N at the start, held), 'bottom' (the same rules on the
 * bottom-N ranked: does "winners" matter?).
 */

import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { rankScore, zoneOf, dipFires, sma200Series, rsiSeries, closesUnder200, stateOf, ZONE_DEFAULT, type WinnerRanking, type DipRule, type TieBreak, type Zone, type ZoneOptions } from '../analysis/models/winners.ts';

export interface WinnersOptions {
  readonly mode: 'layer' | 'compound' | 'monthly' | 'lump' | 'bottom';
  /** W1 */ readonly n: number;
  /** W2 */ readonly ranking: WinnerRanking;
  /** W3 */ readonly rerankDays: number;
  /** Z1 */ readonly dip: DipRule;
  /** Z2, Z4 */ readonly zones: ZoneOptions;
  /** Z3: add size as a share of the account, per zone */ readonly sizes: Readonly<Record<Zone, number>>;
  /** Z5 */ readonly spacingDays: number; readonly spacingPct: number;
  /** G6: the largest share of the account in one stock */ readonly cap: number;
  /** 2c */ readonly tieBreak: TieBreak;
  /** C1 */ readonly cutAfter: number;
  /** C2: cut at this fall from the average cost (0 = off) */ readonly costStop: number;
  /** C3 "faster horse" (on for T-B and T-C, which cut by it) */ readonly fasterHorse: boolean;
  /** C4 */ readonly rebuyDays: number;
  /** G1g: 'trail30' = a 30% trailing stop from the high since entry */ readonly grip: 'none' | 'trail30';
  readonly idle: 'qqq' | 'cash' | 'qqqTrend';
  readonly costBps?: number;
}
/** The pre-registered default (plan 09 section 6): N 4, 12-month ranking, -10% from the 20-day high, zones 1.5 / 4 / 8%, T-A, no profit target, cap 25%, idle QQQ, no sleeve. */
export const WINNERS_DEFAULT: WinnersOptions = {
  mode: 'layer', n: 4, ranking: '12m', rerankDays: 21, dip: 'dd20', zones: ZONE_DEFAULT, sizes: { High: 0.015, Middle: 0.04, Deep: 0.08 },
  spacingDays: 5, spacingPct: 0.05, cap: 0.25, tieBreak: 'T-A', cutAfter: 5, costStop: 0, fasterHorse: false, rebuyDays: 20, grip: 'none', idle: 'qqq', costBps: 0,
};

export interface WPos { shares: number; cost: number; lastAddPx: number; lastAddDay: number; high: number; entryDay: number }
export interface WinnersBook {
  cash: number; qqq: { shares: number; cost: number }; pos: Record<string, WPos>;
  /** Trading days seen (the book's clock). */
  day: number;
  /** The current ranking (best first) and the day it was made. */
  rank: string[]; rankDay: number;
  /** Days each stock has been out of the top 2N (C3). */
  outDays: Record<string, number>;
  /** C4: the day of each stock's last cut. */
  cutDay: Record<string, number>;
  toSell: Record<string, string>;
  toAdd: Array<{ t: string; share: number; why: string; zone: Zone | 'start' }>;
  /** The sleeve's target share of the account (0 = none) and its ticker (IBIT); MSTR counts toward it. */
  sleeve?: { readonly ticker: string; readonly target: number; readonly countsAlso: readonly string[] };
  started: boolean;
}
export const newWinnersBook = (cash: number, sleeve?: WinnersBook['sleeve']): WinnersBook => ({ cash, qqq: { shares: 0, cost: 0 }, pos: {}, day: 0, rank: [], rankDay: -1e9, outDays: {}, cutDay: {}, toSell: {}, toAdd: [], ...(sleeve ? { sleeve } : {}), started: false });

export interface WTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string; readonly zone?: Zone | 'start' | 'sleeve' }

/** One day's fills at the open (last night's decisions), then the spare money. */
export function winnersDay(b: WinnersBook, o: Pick<WinnersOptions, 'cap' | 'idle' | 'costBps'>, x: { readonly opens: ReadonlyMap<string, number>; readonly qqqOpen: number | null; readonly fill: boolean; readonly idleOut?: boolean }): WTrade[] {
  const out: WTrade[] = [];
  b.day++;
  if (!x.fill || x.qqqOpen == null) return out;
  const c = (o.costBps ?? 0) / 10_000, q = x.qqqOpen;
  const sellQqq = (n: number, why: string): void => {
    n = Math.min(n, b.qqq.shares); if (n <= 0) return;
    const cost = (b.qqq.cost * n) / b.qqq.shares, fee = n * q * c, tax = Math.max(0, n * q - fee - cost) * EXIT_TAX_RATE;
    b.qqq.shares -= n; b.qqq.cost -= cost; b.cash += n * q - fee - tax; out.push({ ticker: 'QQQ', side: 'SELL', shares: n, price: q, tax, why });
  };
  for (const [t, why] of Object.entries(b.toSell)) {
    const p = b.pos[t], px = x.opens.get(t);
    if (!p || px == null) continue;
    const v = p.shares * px, fee = v * c, tax = Math.max(0, v - fee - p.cost) * EXIT_TAX_RATE;
    b.cash += v - fee - tax; delete b.pos[t]; b.cutDay[t] = b.day;
    out.push({ ticker: t, side: 'SELL', shares: p.shares, price: px, tax, why });
  }
  b.toSell = {};
  const idleQqq = o.idle === 'qqq' || (o.idle === 'qqqTrend' && !x.idleOut);
  if (!idleQqq && b.qqq.shares) sellQqq(b.qqq.shares, 'idle money to cash');
  const adds = b.toAdd.filter((a) => x.opens.has(a.t));
  if (adds.length) {
    let eq = b.cash + b.qqq.shares * q;
    for (const [t, p] of Object.entries(b.pos)) eq += p.shares * (x.opens.get(t) ?? p.cost / p.shares);
    const money = adds.map((a) => {
      const px = x.opens.get(a.t) as number, have = (b.pos[a.t]?.shares ?? 0) * px;
      return Math.max(0, Math.min(a.share * eq, (a.zone === 'start' ? 1 : o.cap) * eq - have));
    });
    const need = money.reduce((s, m) => s + m, 0) - b.cash;
    if (need > 0) sellQqq(Math.ceil(need / (q * (1 - c))), 'money for the adds');
    adds.forEach((a, k) => {
      const px = x.opens.get(a.t) as number, pc = px * (1 + c), n = Math.floor(Math.min(money[k] as number, b.cash) / pc);
      if (n <= 0) return;
      b.cash -= n * pc;
      const p = b.pos[a.t];
      if (p) { p.shares += n; p.cost += n * pc; p.lastAddPx = px; p.lastAddDay = b.day; }
      else b.pos[a.t] = { shares: n, cost: n * pc, lastAddPx: px, lastAddDay: b.day, high: px, entryDay: b.day };
      out.push({ ticker: a.t, side: 'BUY', shares: n, price: px, tax: 0, why: a.why, zone: a.zone });
    });
  }
  b.toAdd = [];
  if (idleQqq) {
    const pc = q * (1 + c), n = Math.floor(b.cash / pc);
    if (n > 0) { b.cash -= n * pc; b.qqq.shares += n; b.qqq.cost += n * pc; out.push({ ticker: 'QQQ', side: 'BUY', shares: n, price: q, tax: 0, why: 'spare money' }); }
  }
  return out;
}

/** One stock's bars up to tonight (index `i` = tonight's close). */
export interface WCtx { readonly closes: readonly number[]; readonly highs: readonly number[]; readonly i: number; readonly date: string }

const smaCache = new WeakMap<readonly number[], Array<number | null>>(), rsiCache = new WeakMap<readonly number[], Array<number | null>>();
const smaOf = (c: readonly number[]): Array<number | null> => { let m = smaCache.get(c); if (!m) smaCache.set(c, (m = sma200Series(c))); return m; };
const rsiOf = (c: readonly number[]): Array<number | null> => { let m = rsiCache.get(c); if (!m) rsiCache.set(c, (m = rsiSeries(c))); return m; };

export interface WDecideInput {
  readonly stocks: ReadonlyMap<string, WCtx>;
  readonly qqq: WCtx;
  /** Random-signal null: tonight's random add days replace the winner / dip / spacing tests. */
  readonly randomAdd?: ReadonlySet<string> | null;
  /** The stocks the ranking leaves out (the sleeve's IBIT when the sleeve is on). */
  readonly notRanked?: ReadonlySet<string>;
}

/** Tonight's ranking (best first) of the stocks with the history. */
export function rankTonight(o: Pick<WinnersOptions, 'ranking'>, x: Pick<WDecideInput, 'stocks' | 'qqq' | 'notRanked'>, ranking: WinnerRanking = o.ranking): Array<{ t: string; score: number }> {
  const out: Array<{ t: string; score: number }> = [];
  for (const [t, s] of x.stocks) {
    if (x.notRanked?.has(t)) continue;
    const v = rankScore(s, s.i, ranking, { closes: x.qqq.closes, i: x.qqq.i });
    if (v != null) out.push({ t, score: v });
  }
  return out.sort((a, b) => b.score - a.score || a.t.localeCompare(b.t));
}

/** Tonight's decisions (sets `toSell` / `toAdd` for the next open). Returns the states for the log. */
export function winnersDecide(b: WinnersBook, o: WinnersOptions, x: WDecideInput, closeOf: (t: string) => number | null): Map<string, string> {
  const states = new Map<string, string>();
  const qs = x.qqq, qSma = smaOf(qs.closes)[qs.i], qAbove = qSma != null && (qs.closes[qs.i] as number) > qSma;
  // the account at tonight's close (for the caps)
  let eq = b.cash + b.qqq.shares * (qs.closes[qs.i] as number);
  for (const [t, p] of Object.entries(b.pos)) eq += p.shares * (closeOf(t) ?? p.cost / p.shares);
  if (b.day - b.rankDay >= o.rerankDays || !b.rank.length) {
    const r = rankTonight(o, x);
    b.rank = (o.mode === 'bottom' ? [...r].reverse() : r).map((y) => y.t);
    if (b.rank.length) b.rankDay = b.day;
  }
  const top = new Set(b.rank.slice(0, o.n)), top2 = new Set(b.rank.slice(0, 2 * o.n));
  const lt = o.tieBreak === 'T-B' ? new Set(rankTonight(o, x, '3y').slice(0, o.n).map((y) => y.t)) : new Set<string>();
  for (const t of x.stocks.keys()) b.outDays[t] = top2.has(t) ? 0 : (b.outDays[t] ?? 0) + 1;
  const sleeveT = b.sleeve?.ticker;
  // controls that buy at the start
  if (!b.started && b.rank.length >= o.n && (o.mode === 'compound' || o.mode === 'lump')) {
    b.started = true;
    for (const t of b.rank.slice(0, o.n)) b.toAdd.push({ t, share: 1 / o.n, why: (o.mode === 'lump' ? 'lump sum' : 'compounding hold') + ': a top-' + o.n + ' winner at the start', zone: 'start' });
    return states;
  }
  const fh = o.fasterHorse || o.tieBreak !== 'T-A';
  for (const [t, s] of x.stocks) {
    if (t === sleeveT && b.sleeve) continue;
    const p = b.pos[t], c = s.closes[s.i] as number, sma = smaOf(s.closes)[s.i] ?? null;
    if (p) p.high = Math.max(p.high, c);
    if (o.mode === 'lump') continue;
    if (o.mode === 'compound') {
      if (!p) continue;
      const friday = new Date(s.date + 'T12:00:00Z').getUTCDay() === 5;
      if ((friday && sma != null && c < sma) || c < 0.65 * p.high) { b.toSell[t] = friday && sma != null && c < sma ? 'compounding hold: a Friday close under the 200-day average' : 'compounding hold: 35% under the position\'s high'; states.set(t, 'CUT'); }
      continue;
    }
    const under = closesUnder200(s.closes, smaOf(s.closes), s.i);
    let otherCut: string | null = null;
    if (p && o.costStop && c < (1 - o.costStop) * (p.cost / p.shares)) otherCut = 'cost stop: ' + Math.round(o.costStop * 100) + '% under the average cost';
    if (p && o.grip === 'trail30' && c < 0.7 * p.high) otherCut = '30% trailing stop from the high since entry';
    if (p && fh && (b.outDays[t] ?? 0) >= 63) {
      const k = s.i - 126, qk = qs.i - 126;
      if (k >= 0 && qk >= 0 && c / (s.closes[k] as number) - 1 < (qs.closes[qs.i] as number) / (qs.closes[qk] as number) - 1 - 0.10) otherCut = 'faster horse: out of the top ' + 2 * o.n + ' for 63 days and 10% behind QQQ over 6 months';
    }
    if (o.mode === 'monthly') {
      if (p && under >= o.cutAfter) { b.toSell[t] = 'cut: ' + under + ' closes in a row under the 200-day average'; states.set(t, 'CUT'); }
      continue;
    }
    const z = zoneOf(s, s.i, sma, o.zones);
    const recentlyCut = b.cutDay[t] != null && b.day - (b.cutDay[t] as number) < o.rebuyDays;
    const rebuyOk = !recentlyCut && (b.cutDay[t] == null || !!p || (sma != null && c > sma && (smaOf(s.closes)[s.i - 20] ?? Infinity) < sma));
    const spacingOk = !p || (b.day - p.lastAddDay >= o.spacingDays && c <= (1 - o.spacingPct) * p.lastAddPx);
    const capOk = ((p?.shares ?? 0) * c) / eq < o.cap - 1e-9;
    const random = x.randomAdd ? x.randomAdd.has(t) : null;
    const st = stateOf({
      held: !!p, winner: random ?? (top.has(t) && rebuyOk), longTermWinner: lt.has(t), qqqAbove200: qAbove, dip: random ?? dipFires(s, s.i, o.dip, o.dip === 'rsi35' ? rsiOf(s.closes) : undefined),
      spacingOk: random ?? spacingOk, capOk, close: c, sma200: sma, closesUnder200: under, cutAfter: o.cutAfter, tieBreak: o.tieBreak, otherCut: !!otherCut,
    });
    states.set(t, st);
    if (st === 'CUT') b.toSell[t] = otherCut ?? 'cut: ' + under + ' closes in a row under the 200-day average';
    else if (st === 'ADD') b.toAdd.push({ t, share: o.sizes[z.sizeZone], zone: z.sizeZone, why: (random ? 'random day (null)' : 'dip in a top-' + o.n + ' winner') + ', ' + z.zone + ' zone (' + (z.drawdown * 100).toFixed(0) + '% under the 52-week high' + (z.extended ? ', extended: High size' : '') + '), ' + (o.sizes[z.sizeZone] * 100).toFixed(1) + '% of the account' });
  }
  if (o.mode === 'monthly' && b.rankDay === b.day) for (const t of top) if (!b.toSell[t] && x.stocks.has(t)) b.toAdd.push({ t, share: 0.04 / o.n, why: 'monthly buying of the top ' + o.n, zone: 'High' });
  // the BTC-insurance sleeve: top up to the target (MSTR held counts), never sell
  if (b.sleeve && sleeveT && x.stocks.has(sleeveT)) {
    const sc = x.stocks.get(sleeveT)!, px = sc.closes[sc.i] as number;
    const held = b.sleeve.countsAlso.concat([sleeveT]).reduce((a, t) => a + (b.pos[t]?.shares ?? 0) * (t === sleeveT ? px : (closeOf(t) ?? 0)), 0);
    if (held / eq < b.sleeve.target - 0.0025) b.toAdd.push({ t: sleeveT, share: b.sleeve.target - held / eq, why: 'BTC-insurance sleeve: top up to ' + (b.sleeve.target * 100).toFixed(1) + '% (MSTR counted)', zone: 'start' });
  }
  return states;
}

export function winnersValue(b: WinnersBook, closeOf: (t: string) => number | null): number {
  const taxed = (s: number, cost: number, px: number): number => s * px - Math.max(0, s * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.qqq.shares ? taxed(b.qqq.shares, b.qqq.cost, closeOf('QQQ') ?? b.qqq.cost / b.qqq.shares) : 0);
  for (const [t, p] of Object.entries(b.pos)) v += taxed(p.shares, p.cost, closeOf(t) ?? p.cost / p.shares);
  return v;
}
export function winnersEquity(b: WinnersBook, closeOf: (t: string) => number | null): number {
  let v = b.cash + b.qqq.shares * (closeOf('QQQ') ?? 0);
  for (const [t, p] of Object.entries(b.pos)) v += p.shares * (closeOf(t) ?? p.cost / p.shares);
  return v;
}
export const winnersHeld = (b: WinnersBook): string[] => Object.keys(b.pos).sort();
