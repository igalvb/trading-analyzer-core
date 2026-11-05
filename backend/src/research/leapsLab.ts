/**
 * James — LEAPS (model 3) on history (docs/models/plans/03-james-leaps-method.md section 6): one book that runs
 *   6.1  EXACT: James's fire-sale timing, buying SHARES (same slots, idle money in QQQ, the trend-200 sell), and
 *   6.2  APPROXIMATE: the same decision days (or a stock model's holdings, "twin"), buying synthetic LEAPS priced by
 *        research/optionsSim.ts (model 4f) — every figure from it is labelled approximate.
 * Mechanics (master T1): decide at the close, fill at the next open, 25% tax on every gain, values after the tax on what
 * is still held (calls at the mid), deepest fall; `costBps` on every stock and QQQ trade; calls pay the half-spread h.
 *
 * Entries (mode F, defaults fixed in advance, 2.2 B): a market fire sale (QQQ >= 20% under its 52-week closing high;
 * an episode ends 60 trading days after its last such close; one buy per stock per episode; no turnaround) OR a stock
 * fire sale (>= 40% under its 52-week high with a z <= -2 close in the last 20 days, then a turnaround within 20 days);
 * never at z >= +2; deepest fall first; 5 slots of equity / 5; one contract allowed up to 1.5 x a slot; synthetic LEAPS
 * only after a stock has traded 252 bars (the share runs keep the same rule, so both see the same days).
 * Exits: X1 sell at 60 days to expiry (re-buy when the stock's 200-day trend is not broken), X2 the same at 30, X3 hold
 * to expiry and exercise (shares then follow the trend-200 sell), X3c sell to close 2 days before expiry when the
 * extrinsic is above $0.05; X4 spike trim (a third at z >= +2, once per 60 days); X5 thesis stop (a close under the
 * fire-sale low); the delta cap (exposure <= 1.0 x equity; trimmed back above 1.2 x).
 * The trend-200 sell of a fire-sale position is ARMED only once the stock has closed above its 200-day average after
 * the buy (a fire-sale buy is by construction under it) [PROPOSED; plan 03 says only "the trend-200 rule"].
 */

import type { PriceSeries } from '../backtest/data.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { trendSeries, type TrendDay } from '../analysis/models/trendFollow.ts';
import { marketFireSale, stockFireSale, zSeries, FIRE_SALE_DEFAULT, type FireSaleOptions, type MarketDay, type StockDay } from '../analysis/options/fireSale.ts';
import { sigmaAt, simMid, simDelta, simExpiry, simContract, calDays, SIM, type SimPricer } from './optionsSim.ts';

export type LeapsExit = 'roll60' | 'roll30' | 'expiry' | 'expiryClose';
export interface LeapsRunOptions {
  readonly entry: 'fire' | 'twin';
  readonly instrument: 'leaps' | 'shares';
  readonly fire: FireSaleOptions;
  readonly market: boolean; readonly stock: boolean;
  readonly pick: 'james' | 'engine';
  readonly delta: number;
  readonly exit: LeapsExit;
  readonly trim: boolean; readonly thesisStop: boolean;
  readonly deltaCap: number | null;
  readonly slots: number; readonly onePlus: number;
  readonly sim: SimPricer;
  /** Break-even per year gate on the synthetic ask (James's pick only); null = off. */
  readonly beGate: number | null;
  readonly costBps?: number;
  /** Twin: tonight's wanted stocks per decision day (a stock model's holdings after its decisions). */
  readonly want?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Random-signal null: these decision days replace the fire-sale buy signal (ticker -> days). */
  readonly buyDays?: ReadonlyMap<string, ReadonlySet<string>>;
}

export const LEAPS_FIRE_DEFAULT: LeapsRunOptions = {
  entry: 'fire', instrument: 'leaps', fire: FIRE_SALE_DEFAULT, market: true, stock: true, pick: 'james', delta: 0.75, exit: 'expiry',
  trim: false, thesisStop: false, deltaCap: null, slots: 5, onePlus: 1.5, sim: { k: SIM.k, h: SIM.h, floor: SIM.floor }, beGate: 0.12,
};

interface Opt { t: string; K: number; exp: string; n: number; cost: number; entry: string; mid: number; delta: number; lastTrim: number; fsLow: number }
interface Shs { shares: number; cost: number; armed: boolean; fsLow: number }
interface BuyOrder { t: string; why: string; fsLow: number; n?: number; K?: number; exp?: string; dollars?: number; episode: number | null }
interface SellOrder { kind: 'opt' | 'shs'; t: string; ref?: Opt; n?: number; why: string }

export interface LeapsEntry { readonly day: string; readonly t: string; readonly why: string; readonly episode: number | null; readonly kind: 'market' | 'stock' | 'twin' | 'roll' | 'random' }
export interface LeapsResult {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>;
  readonly buysByTicker: Map<string, number>;
  readonly entries: LeapsEntry[];
  readonly exercises: number; readonly expiredWorthless: number; readonly skippedGate: number;
  /** Delta exposure / equity: average over days with a position, and the peak. */
  readonly avgExposure: number; readonly peakExposure: number;
  /** Share of days holding any call. */
  readonly daysInLeapsPct: number;
  /** Days without any call (for the best-days check: no LEAPS on the day). */
  readonly noLeapsByDay: Map<string, number>;
}

const TREND = new WeakMap<PriceSeries, TrendDay[]>();
const trendOf = (s: PriceSeries): TrendDay[] => { let x = TREND.get(s); if (!x) { x = trendSeries(s.closes, 200); TREND.set(s, x); } return x; };
const FS = new WeakMap<PriceSeries, Map<string, StockDay[]>>();
const fsOf = (s: PriceSeries, o: FireSaleOptions): StockDay[] => { let m = FS.get(s); if (!m) { m = new Map(); FS.set(s, m); } const k = JSON.stringify(o); let x = m.get(k); if (!x) { x = stockFireSale(s.closes, o); m.set(k, x); } return x; };
const MK = new WeakMap<PriceSeries, Map<string, MarketDay[]>>();
const mkOf = (s: PriceSeries, o: FireSaleOptions): MarketDay[] => { let m = MK.get(s); if (!m) { m = new Map(); MK.set(s, m); } const k = o.marketDrop + '|' + o.episodeGap + '|' + o.highBars; let x = m.get(k); if (!x) { x = marketFireSale(s.closes, o); m.set(k, x); } return x; };
const ZS = new WeakMap<PriceSeries, Array<number | null>>();
const zOf = (s: PriceSeries): Array<number | null> => { let x = ZS.get(s); if (!x) { x = zSeries(s.closes, 20).z; ZS.set(s, x); } return x; };

export function runLeaps(bag: readonly string[], inp: { series: ReadonlyMap<string, PriceSeries>; qqq: PriceSeries }, start: string, end: string, o: LeapsRunOptions, cash0 = 100_000): LeapsResult {
  const c = (o.costBps ?? 0) / 10_000, h = o.sim.h;
  const live = bag.filter((t) => inp.series.has(t));
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const at = (t: string, d: string): number | null => idx.get(t)?.get(d) ?? null;
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const mk = mkOf(inp.qqq, o.fire);
  let cash = cash0, reserve = 0, peak = cash0, dd = 0, trades = 0, exercises = 0, worthless = 0, skippedGate = 0, expSum = 0, expDays = 0, expPeak = 0, inLeaps = 0;
  const qqq = { shares: 0, cost: 0 };
  let opts: Opt[] = [];
  const shs = new Map<string, Shs>();
  let buys: BuyOrder[] = [], sells: SellOrder[] = [];
  const boughtEp = new Map<string, number>();
  const entries: LeapsEntry[] = [], buysByTicker = new Map<string, number>(), cashShareByDay = new Map<string, number>(), noLeapsByDay = new Map<string, number>();
  const last = new Map<string, number>();
  const sigma = (t: string, i: number): number | null => sigmaAt(ser(t), i, o.sim);
  const optMid = (x: Opt, d: string, S: number, i: number): number => { const s = sigma(x.t, i); return s == null ? Math.max(S - x.K, 0) : simMid(S, x.K, d, x.exp, s); };
  const taxed = (v: number, cost: number): number => v - Math.max(0, v - cost) * EXIT_TAX_RATE;
  const sellQqq = (n: number, px: number): void => { n = Math.min(n, qqq.shares); if (n <= 0) return; const part = (qqq.cost * n) / qqq.shares, v = n * px * (1 - c); qqq.shares -= n; qqq.cost -= part; cash += taxed(v, part); };
  const buyQqq = (dollars: number, px: number): void => { const n = Math.floor(dollars / (px * (1 + c))); if (n <= 0) return; cash -= n * px * (1 + c); qqq.shares += n; qqq.cost += n * px * (1 + c); };
  const equity = (d: string, which: 'opens' | 'closes'): number => {
    let e = cash + qqq.shares * ((at('QQQ', d) != null ? ser('QQQ')[which][at('QQQ', d)!] : last.get('QQQ')) ?? 0);
    for (const [t, x] of shs) e += x.shares * (last.get(t) ?? x.cost / x.shares);
    for (const x of opts) e += x.n * x.mid * 100;
    return e;
  };
  const exposure = (): number => { let v = 0; for (const x of opts) v += x.n * 100 * x.delta * (last.get(x.t) ?? 0); for (const [t, x] of shs) v += x.shares * (last.get(t) ?? 0); return v; };
  const heldTickers = (): Set<string> => new Set([...opts.map((x) => x.t), ...shs.keys(), ...buys.map((b) => b.t)]);

  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string, qk = at('QQQ', d)!;
    const qOpen = inp.qqq.opens[qk] as number, qClose = inp.qqq.closes[qk] as number;
    // 1. the open
    if (n > 0) {
      for (const s of sells) {
        const k = at(s.t, d); if (k == null) { continue; }
        const S = ser(s.t).opens[k] as number;
        if (s.kind === 'opt' && s.ref && opts.includes(s.ref)) {
          const x = s.ref, m = Math.min(s.n ?? x.n, x.n), sg = sigma(x.t, k - 1);
          const px = (sg == null ? Math.max(S - x.K, 0) : simMid(S, x.K, d, x.exp, sg)) * (1 - h);
          const part = (x.cost * m) / x.n;
          cash += taxed(m * px * 100, part); x.n -= m; x.cost -= part; trades++;
          if (x.n <= 0) opts = opts.filter((y) => y !== x);
        } else if (s.kind === 'shs') {
          const x = shs.get(s.t); if (!x) continue;
          cash += taxed(x.shares * S * (1 - c), x.cost); shs.delete(s.t); trades++;
        }
      }
      sells = [];
      // price tonight's buys at the open (sigma as of the decision close), then fund them from QQQ
      const priced = buys.map((b) => {
        const k = at(b.t, d); if (k == null) return null;
        const S = ser(b.t).opens[k] as number;
        if (o.instrument === 'shares') return { b, k, S, unit: S * (1 + c), n: Math.floor((b.dollars ?? 0) / (S * (1 + c))) };
        const sg = sigma(b.t, k - 1); if (sg == null) return null;
        const ask = simMid(S, b.K as number, d, b.exp as string, sg) * (1 + h);
        return { b, k, S, unit: ask * 100, n: b.n as number };
      }).filter((x): x is NonNullable<typeof x> => !!x && x.n > 0);
      const need = priced.reduce((s, x) => s + x.n * x.unit, 0) + reserve - cash;
      if (need > 0 && qqq.shares) sellQqq(Math.ceil(need / (qOpen * (1 - c))), qOpen);
      for (const x of priced) {
        const m = Math.min(x.n, Math.floor(Math.max(0, cash - reserve) / x.unit));
        if (m <= 0) continue;
        cash -= m * x.unit; trades++;
        buysByTicker.set(x.b.t, (buysByTicker.get(x.b.t) ?? 0) + 1);
        if (o.instrument === 'shares') { const y = shs.get(x.b.t); if (y) { y.shares += m; y.cost += m * x.unit; } else shs.set(x.b.t, { shares: m, cost: m * x.unit, armed: false, fsLow: x.b.fsLow }); }
        else opts.push({ t: x.b.t, K: x.b.K as number, exp: x.b.exp as string, n: m, cost: m * x.unit, entry: d, mid: x.unit / 100 / (1 + h), delta: o.delta, lastTrim: -999, fsLow: x.b.fsLow });
      }
      buys = [];
      if (cash - reserve >= qOpen * (1 + c)) buyQqq(cash - reserve, qOpen);
    }
    // 2. the close: marks, expiries
    last.set('QQQ', qClose);
    for (const t of live) { const k = at(t, d); if (k != null) last.set(t, ser(t).closes[k] as number); }
    for (const x of [...opts]) {
      const k = at(x.t, d); if (k == null) continue;
      const S = ser(x.t).closes[k] as number;
      if (d >= x.exp) {
        // expiry: exercise if ITM by $0.01+, else worthless (master: long-only; exercise with cash only)
        if (S >= x.K + 0.01) {
          const needCash = x.K * 100 * x.n;
          if (cash < needCash) { const afford = Math.floor(cash / (x.K * 100)); const sell = x.n - afford; const part = (x.cost * sell) / x.n; cash += taxed(sell * (S - x.K) * (1 - h) * 100, part); x.n -= sell; x.cost -= part; trades++; }
          if (x.n > 0) {
            cash -= x.K * 100 * x.n; reserve = Math.max(0, reserve - x.K * 100 * x.n);
            const y = shs.get(x.t), add = { shares: 100 * x.n, cost: x.K * 100 * x.n + x.cost };
            if (y) { y.shares += add.shares; y.cost += add.cost; } else shs.set(x.t, { ...add, armed: false, fsLow: x.fsLow });
            exercises++; trades++;
          }
        } else { worthless++; reserve = Math.max(0, reserve - x.K * 100 * x.n); }
        opts = opts.filter((y) => y !== x);
        continue;
      }
      x.mid = optMid(x, d, S, k);
      const sg = sigma(x.t, k); x.delta = sg == null ? (S > x.K ? 1 : 0) : simDelta(S, x.K, d, x.exp, sg);
    }
    // 3. decisions for the next open
    if (n < days.length - 1) {
      const eqNow = equity(d, 'closes');
      const want = o.entry === 'twin' ? (o.want?.get(d) ?? new Set<string>()) : null;
      const trendOk = (t: string): boolean => { const k = at(t, d); return k != null && trendOf(ser(t))[k]?.direction !== 'cautionary'; };
      // shares: the armed trend-200 sell; a twin sells what its stock model no longer holds
      for (const [t, x] of shs) {
        const k = at(t, d); if (k == null) continue;
        const tr = trendOf(ser(t))[k]; const cl = ser(t).closes[k] as number;
        if (tr?.sma != null && cl > tr.sma) x.armed = true;
        const out = want ? !want.has(t) : (x.armed && tr?.direction === 'cautionary') || (o.thesisStop && cl < x.fsLow);
        if (out) sells.push({ kind: 'shs', t, why: want ? 'the stock model sells' : 'trend-200 sell' });
      }
      // calls: the exit rule
      for (const x of opts) {
        const k = at(x.t, d); if (k == null) continue;
        const S = ser(x.t).closes[k] as number, left = calDays(d, x.exp);
        let why: string | null = null;
        if (want && !want.has(x.t)) why = 'the stock model sells';
        else if (o.thesisStop && S < x.fsLow) why = 'thesis stop';
        else if ((o.exit === 'roll60' && left <= 60) || (o.exit === 'roll30' && left <= 30)) {
          why = 'roll';
          const again = want ? want.has(x.t) : trendOk(x.t);
          if (again) queueBuy(x.t, d, k, eqNow / o.slots, 'roll', null, x.fsLow, true);
        } else if (o.exit === 'expiryClose' && left <= 3) {
          const sg = sigma(x.t, k), bid = (sg == null ? Math.max(S - x.K, 0) : simMid(S, x.K, d, x.exp, sg)) * (1 - h);
          if (bid - Math.max(S - x.K, 0) > 0.05) why = 'sell to close: extrinsic above $0.05';
        }
        if ((o.exit === 'expiry' || o.exit === 'expiryClose') && !why && left <= 7 && left > 0 && S > x.K) {
          // the expiry checklist: cash for the exercise, raised from QQQ at the next open; contracts that cannot be covered are sold
          const needCash = x.K * 100 * x.n, avail = cash + qqq.shares * qClose - reserve;
          if (!(x as Opt & { reserved?: boolean }).reserved) {
            if (avail < needCash) { const cover = Math.max(0, Math.floor(avail / (x.K * 100))); if (x.n - cover > 0) sells.push({ kind: 'opt', t: x.t, ref: x, n: x.n - cover, why: 'not enough cash to exercise' }); reserve += cover * x.K * 100; }
            else reserve += needCash;
            (x as Opt & { reserved?: boolean }).reserved = true;
          }
        }
        if (why) { sells.push({ kind: 'opt', t: x.t, ref: x, why }); continue; }
        if (o.trim && x.n >= 3 && (zOf(ser(x.t))[k] ?? 0) >= 2 && k - x.lastTrim >= 60) { sells.push({ kind: 'opt', t: x.t, ref: x, n: Math.floor(x.n / 3), why: 'spike trim' }); x.lastTrim = k; }
      }
      // the delta cap: back to 1.0 x equity once above 1.2 x
      if (o.deltaCap != null && o.instrument === 'leaps') {
        const ex = exposure();
        if (ex > 1.2 * o.deltaCap * eqNow && ex > 0) {
          const f = 1 - (o.deltaCap * eqNow) / ex;
          for (const x of opts) { const m = Math.ceil(x.n * f); if (m > 0 && !sells.some((s) => s.ref === x)) sells.push({ kind: 'opt', t: x.t, ref: x, n: Math.min(m, x.n), why: 'delta cap' }); }
        }
      }
      // entries
      const held = heldTickers();
      const sold = new Set(sells.filter((s) => s.kind === 'shs' || (s.ref && (s.n == null || s.n >= s.ref.n))).map((s) => s.t));
      const occupied = [...held].filter((t) => !sold.has(t) || buys.some((b) => b.t === t)).length;
      let free = o.slots - occupied;
      const cands: Array<{ t: string; k: number; dd: number; why: string; kind: LeapsEntry['kind']; ep: number | null; fsLow: number }> = [];
      const mday = mk[qk];
      for (const t of live) {
        if (held.has(t)) continue;
        const k = at(t, d); if (k == null || k < SIM.listedDays) continue;
        const s = ser(t), fs = fsOf(s, o.fire)[k]!, cl = s.closes[k] as number;
        if (want) { if (want.has(t)) cands.push({ t, k, dd: -1, why: 'the stock model buys', kind: 'twin', ep: null, fsLow: 0 }); continue; }
        if ((zOf(s)[k] ?? 0) >= 2) continue;
        let low = cl; for (let q = Math.max(0, k - 20); q <= k; q++) low = Math.min(low, s.closes[q] as number);
        if (o.buyDays) { if (o.buyDays.get(t)?.has(d)) cands.push({ t, k, dd: fs.dd, why: 'random day (null)', kind: 'random', ep: null, fsLow: low }); continue; }
        const qTurn = !o.fire.marketTurnaround || ((): boolean => { const z = zOf(inp.qqq)[qk]; return z != null && z > 0; })();
        if (o.market && mday?.on && mday.episode != null && boughtEp.get(t) !== mday.episode && qTurn) cands.push({ t, k, dd: fs.dd, why: 'market fire sale: QQQ ' + Math.round(mday.dd * 100) + '% under its 52-week high', kind: 'market', ep: mday.episode, fsLow: low });
        else if (o.stock && fs.buy) cands.push({ t, k, dd: fs.dd, why: 'stock fire sale (' + Math.round(fs.dd * 100) + '% under its 52-week high), ' + (fs.why ?? ''), kind: 'stock', ep: null, fsLow: low });
      }
      cands.sort((a, b) => b.dd - a.dd || a.t.localeCompare(b.t));
      for (const x of cands) {
        if (free <= 0) break;
        if (queueBuy(x.t, d, x.k, eqNow / o.slots, x.why, x.ep, x.fsLow, false, x.kind)) { free--; if (x.ep != null) boughtEp.set(x.t, x.ep); }
      }
    }
    // 4. mark the day
    const eq = equity(d, 'closes');
    peak = Math.max(peak, eq); dd = Math.max(dd, peak > 0 ? (1 - eq / peak) * 100 : 0);
    cashShareByDay.set(d, eq > 0 ? Math.min(1, Math.max(0, cash) / eq) : 1);
    noLeapsByDay.set(d, opts.length ? 0 : 1);
    if (opts.length) inLeaps++;
    const ex = exposure();
    if (ex > 0 && eq > 0) { expSum += ex / eq; expDays++; expPeak = Math.max(expPeak, ex / eq); }
  }
  let v = cash + taxed(qqq.shares * (last.get('QQQ') ?? 0), qqq.cost);
  for (const [t, x] of shs) v += taxed(x.shares * (last.get(t) ?? 0), x.cost);
  for (const x of opts) v += taxed(x.n * x.mid * 100, x.cost);
  return { finalTaxed: v, maxDrawdownPct: dd, trades, cashShareByDay, buysByTicker, entries, exercises, expiredWorthless: worthless, skippedGate, avgExposure: expDays ? expSum / expDays : 0, peakExposure: expPeak, daysInLeapsPct: days.length ? (inLeaps / days.length) * 100 : 0, noLeapsByDay };

  /** Queue a buy for the next open: shares for `slot` dollars, or the synthetic contract (James's or the engine's pick, gates, one-contract rule, delta cap). */
  function queueBuy(t: string, d: string, k: number, slot: number, why: string, ep: number | null, fsLow: number, roll: boolean, kind: LeapsEntry['kind'] = 'roll'): boolean {
    if (o.instrument === 'shares') { buys.push({ t, why, fsLow, dollars: slot, episode: ep }); entries.push({ day: d, t, why, episode: ep, kind: roll ? 'roll' : kind }); return true; }
    const s = ser(t), S = s.closes[k] as number, sg = sigma(t, k);
    const exp = simExpiry(d, o.pick);
    if (sg == null || !exp) return false;
    const deltas = o.pick === 'engine' ? [o.delta] : [o.delta, o.delta + 0.05, o.delta - 0.05, o.delta + 0.10, o.delta - 0.10].filter((x) => x > 0.05 && x < 0.99);
    let ct: ReturnType<typeof simContract> | null = null;
    for (const dl of deltas) { const x = simContract(S, d, exp, sg, dl, o.sim.h); if (o.pick === 'engine' || o.beGate == null || (x.bemYear != null && x.bemYear <= o.beGate)) { ct = x; break; } }
    if (!ct) { skippedGate++; return false; }
    let n = Math.floor(slot / (ct.ask * 100));
    if (n <= 0 && ct.ask * 100 <= o.onePlus * slot) n = 1;
    if (o.deltaCap != null) {
      const room = o.deltaCap * equity(d, 'closes') - exposure() - buys.reduce((a, b) => a + (b.n ?? 0) * 100 * o.delta * (last.get(b.t) ?? 0), 0);
      n = Math.min(n, Math.floor(Math.max(0, room) / (100 * ct.delta * S)));
    }
    if (n <= 0) return false;
    buys.push({ t, why, fsLow, n, K: ct.K, exp: ct.exp, episode: ep });
    entries.push({ day: d, t, why, episode: ep, kind: roll ? 'roll' : kind });
    return true;
  }
}
