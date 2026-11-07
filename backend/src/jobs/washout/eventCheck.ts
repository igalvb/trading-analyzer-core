/**
 * The event check (owner-approved build 2026-11-07; profile `alerts.eventCheck`: off | on, default off). DISPLAY AND
 * ALERT TEXT ONLY: no buy / sell rule, score, tier or verdict of the engine reads anything here.
 *
 * When the market falls sharply (the index, QQQ, -5% or more in 5 trading days, or -3% or more in 1 day) or a held /
 * watchlist stock does (-8% or more in 1 day, or its W1 washout fires), the fall is classified:
 *   TYPE (deterministic):
 *     company   the stock fell at least 2x its sector ETF (or fell while its sector did not)
 *     sector    the sector ETF (chips: SMH / SOXX) fell at least 2x the index (or fell while the index did not)
 *     market    the index fell and most of the sector ETFs fell with it
 *   SIGNALS of a long fall, each yes / no / not known (missing data is "not known", never "no"):
 *     cut forecasts   analyst mean target cut 10%+ or the mean rating score 0.5+ worse vs the value 30 days ago
 *                     (💾 Fundamentals History + tonight's analysis); for the market: half or more of the stocks
 *     credit stress   high yield (HYG) vs Treasuries (IEF), the ratio down 3%+ over 20 trading days
 *     rates           TLT down 5%+ over 20 trading days, or the 10-year yield (Macro Snapshot DGS10) up 0.40+ points
 *     grinding        5+ weeks of lower weekly closes in a row (vs a sharp drop; "a bounce" = 3%+ off the 5-day low)
 *   VERDICT (one line):
 *     long-type signs (cut forecasts + credit stress)   both yes
 *     likely months (policy / rates)                    rates, grinding, cut forecasts or credit stress yes
 *     likely short (sell-the-news / panic)              otherwise
 *   SIZING HINT (the owner's rules): normal size per stock; a big loan only on a short black swan (market-wide, the
 *   index -10% in 5 days or VIX 35+) with strong companies washing out and the long-type signs known to be absent;
 *   no loan on long-type signs.
 * Optional: ONE AI sentence naming the news cause (Gemini, free; only when the run has a Gemini key and AI is on),
 * labelled "AI, unverified". Never Opus. Quiet nights: nothing at all (and no extra fetch).
 */

import { washoutReadLast, WASHOUTS } from '../../analysis/washout.ts';
import { STRONG_FUNDAMENTALS, WASHOUT_MAX_BAR_AGE_DAYS, type WashoutCandidate } from './washoutAlert.ts';
import type { FundPoint } from '../exit/businessAlerts.ts';
import { SPDR_ETF_TICKERS } from '../../fetch/etf/holdings.ts';

// ── thresholds (ONE place) ─────────────────────────────────────────────────────────────────────────────────────────

export const EVENT_RULES = {
  /** Market trigger: the index's change over 5 trading days at or below this, or over 1 day at or below marketFall1d. */
  marketFall5d: -0.05,
  marketFall1d: -0.03,
  /** Stock trigger: a 1-day change at or below this (or the W1 washout). */
  stockFall1d: -0.08,
  /** "Fell at least 2x": stock vs its sector ETF, sector ETF vs the index. */
  ratio: 2,
  /** A sector ETF counts as "down" at or below this change (1-day window / 5-day window). */
  sectorDown1d: -0.01,
  sectorDown5d: -0.02,
  /** "Most sectors": at least this share of the sector ETFs with data. */
  mostSectors: 0.6,
  /** Cut forecasts: vs the value in force this many days before tonight. */
  cutLookbackDays: 30,
  targetCut: 0.10,
  ratingWorse: 0.5,
  /** Market-level cut forecasts: at least this share of the stocks whose answer is known. */
  marketCutShare: 0.5,
  /** Credit stress: the HYG / IEF ratio down this much over creditDays trading days. */
  creditDays: 20,
  creditFall: 0.03,
  /** Rates: TLT down this much over ratesDays trading days, or the 10-year yield up yieldRise points. */
  ratesDays: 20,
  tltFall: 0.05,
  yieldRise: 0.40,
  /** Grinding: this many lower weekly closes in a row. */
  grindWeeks: 5,
  /** A bounce: the last close this much above the lowest close of the last bounceDays bars. */
  bounce: 0.03,
  bounceDays: 5,
  /** A black swan: a market-wide fall with the index this far down in 5 days, or VIX at or above blackSwanVix. */
  blackSwanFall5d: -0.10,
  blackSwanVix: 35,
  /** The sizing hint's normal size per stock and the loan rate the bars compare with. */
  normalSize: 5_000,
  loanRate: 0.06,
  /** At most this many AI sentences a night. */
  maxAi: 4,
} as const;

/** The sector ETFs for "most sectors": the SPDR sectors the nightly already charts (not SPY, XLRE, XLC). */
export const BROAD_SECTORS: readonly string[] = SPDR_ETF_TICKERS.filter((t) => !['SPY', 'XLRE', 'XLC'].includes(t));
/** The chip ETFs (a semiconductor stock's sector, and the tech-led market check). */
export const CHIP_ETFS: readonly string[] = ['SMH', 'SOXX'];
/** Credit proxy: high yield vs Treasuries (each read raw: no price tab is created). */
export const CREDIT_PAIR = { hy: 'HYG', safe: 'IEF' } as const;
export const RATES_ETF = 'TLT';

export type Tri = boolean | null;
export type FallType = 'market' | 'sector' | 'company';
export type EventVerdict = 'short' | 'months' | 'long';

export const VERDICT_TEXT: Readonly<Record<EventVerdict, string>> = {
  short: 'likely short (sell-the-news / panic)',
  months: 'likely months (policy / rates)',
  long: 'long-type signs (cut forecasts + credit stress)',
};
export const TYPE_TEXT: Readonly<Record<FallType, string>> = { market: 'market-wide', sector: 'sector', company: 'company-specific' };

export interface Series { readonly dates: readonly string[]; readonly closes: readonly number[] }
export interface Sig { readonly v: Tri; readonly text: string }
export interface EventSignals { readonly cuts: Sig; readonly credit: Sig; readonly rates: Sig; readonly grinding: Sig; readonly bounce: Tri }

export interface EventCheck {
  /** 'MARKET' or the ticker. */
  readonly subject: string;
  /** What set it off ("QQQ -6.1% in 5 days", "NVDA -9.0% today", "NVDA washout"). */
  readonly trigger: string;
  readonly type: FallType | null;
  readonly typeText: string;
  readonly signals: EventSignals;
  readonly verdict: EventVerdict;
  readonly sizing: string;
  /** The AI sentence (already labelled), when one was asked for and answered. */
  readonly ai?: string | null;
}

export interface EventStock {
  readonly ticker: string;
  readonly held: boolean;
  readonly series: Series;
  /** The engine's fundamentals score tonight (null = none). */
  readonly fundScore: number | null;
  /** The stock's sector ETF (chips -> SMH); null = not known. */
  readonly sectorEtf: string | null;
  /** Stored fundamentals history (dates before tonight) and tonight's point. */
  readonly history: readonly FundPoint[];
  readonly latest: FundPoint | null;
}

export interface EventNightInput {
  readonly today: string;
  readonly index: { readonly ticker: string; readonly series: Series | null };
  /** ETF -> its daily closes (null = not available). Holds BROAD_SECTORS, CHIP_ETFS and each stock's sector ETF. */
  readonly sectors: Readonly<Record<string, Series | null>>;
  readonly hy: Series | null;
  readonly safe: Series | null;
  readonly tlt: Series | null;
  /** The latest 10-year yield values, oldest first (Macro Snapshot DGS10); null = none. */
  readonly dgs10: readonly number[] | null;
  readonly vix: number | null;
  readonly stocks: readonly EventStock[];
}

export interface EventNight {
  readonly today: string;
  /** The market check; null = no sharp market fall tonight. */
  readonly market: EventCheck | null;
  /** One per triggered stock. */
  readonly stocks: readonly EventCheck[];
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const dayMs = (d: string): number => Date.parse(d + 'T12:00:00Z');
const pct = (x: number, dp = 1): string => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(dp) + '%';
const yn = (v: Tri): string => (v === true ? 'yes' : v === false ? 'no' : 'not known');
const addDays = (d: string, n: number): string => new Date(dayMs(d) + n * 86_400_000).toISOString().slice(0, 10);

/** The change over the last `days` bars; null with too few bars or a bad close. */
export function changeOver(s: Series | null | undefined, days: number): number | null {
  if (!s) return null;
  const n = s.closes.length, a = s.closes[n - 1 - days], b = s.closes[n - 1];
  return n > days && fin(a) && fin(b) && a > 0 ? b / a - 1 : null;
}

/** The last bar is tonight's (not older than the washout alert's 4 calendar days). */
export function freshBar(s: Series | null | undefined, today: string): boolean {
  const d = s && s.dates.length ? s.dates[s.dates.length - 1] : null;
  return !!d && dayMs(today) - dayMs(d) <= WASHOUT_MAX_BAR_AGE_DAYS * 86_400_000 && dayMs(d) <= dayMs(today);
}

// ── triggers ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Trigger { readonly window: 1 | 5; readonly text: string; readonly washout: boolean }

/** The market trigger from the index's closes; null = no sharp fall. */
export function marketTrigger(ticker: string, s: Series | null, today: string): Trigger | null {
  if (!freshBar(s, today)) return null;
  const r1 = changeOver(s, 1), r5 = changeOver(s, 5), R = EVENT_RULES;
  if (r5 != null && r5 <= R.marketFall5d + 1e-12) return { window: 5, text: ticker + ' ' + pct(r5) + ' in 5 days' + (r1 != null ? ' (' + pct(r1) + ' today)' : ''), washout: false };
  if (r1 != null && r1 <= R.marketFall1d + 1e-12) return { window: 1, text: ticker + ' ' + pct(r1) + ' today', washout: false };
  return null;
}

/** A stock's trigger: a 1-day drop of 8%+ (window 1), else its W1 washout (window 5); null = neither. */
export function stockTrigger(ticker: string, s: Series, today: string): Trigger | null {
  if (!freshBar(s, today)) return null;
  const r1 = changeOver(s, 1);
  if (r1 != null && r1 <= EVENT_RULES.stockFall1d + 1e-12) return { window: 1, text: ticker + ' ' + pct(r1) + ' today', washout: washoutReadLast(s.closes, WASHOUTS.W1).fired };
  if (washoutReadLast(s.closes, WASHOUTS.W1).fired) return { window: 5, text: ticker + ' washout', washout: true };
  return null;
}

// ── type ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const win = (w: 1 | 5): string => (w === 1 ? '1 day' : '5 days');

/** The market fall's type: market-wide (most sectors down), else sector (chips or the worst sector 2x the index). */
export function classifyMarket(indexTicker: string, idxRet: number | null, sectorRets: Readonly<Record<string, number | null>>, w: 1 | 5): { type: FallType | null; text: string } {
  const R = EVENT_RULES, down = w === 1 ? R.sectorDown1d : R.sectorDown5d;
  const broad = BROAD_SECTORS.map((e) => [e, sectorRets[e]] as const).filter((x): x is readonly [string, number] => fin(x[1]));
  const nDown = broad.filter((x) => x[1] <= down + 1e-12).length;
  if (idxRet == null) return { type: null, text: 'type not known (' + indexTicker + ' not available)' };
  if (broad.length && nDown / broad.length >= R.mostSectors - 1e-12) return { type: 'market', text: TYPE_TEXT.market + ' (' + nDown + ' of ' + broad.length + ' sectors down)' };
  const twice = (r: number): boolean => (idxRet < 0 ? r <= R.ratio * idxRet + 1e-12 : r <= down);
  const chips = CHIP_ETFS.map((e) => [e, sectorRets[e]] as const).filter((x): x is readonly [string, number] => fin(x[1])).sort((a, b) => a[1] - b[1]);
  if (chips.length && twice(chips[0]![1])) return { type: 'sector', text: 'sector: chips (' + chips[0]![0] + ' ' + pct(chips[0]![1]) + ' vs ' + indexTicker + ' ' + pct(idxRet) + ')' };
  const worst = broad.slice().sort((a, b) => a[1] - b[1])[0];
  if (worst && twice(worst[1])) return { type: 'sector', text: 'sector: ' + worst[0] + ' ' + pct(worst[1]) + ' vs ' + indexTicker + ' ' + pct(idxRet) };
  if (!broad.length) return { type: null, text: 'type not known (no sector ETF data)' };
  return { type: 'sector', text: 'sector: a tech-led fall (only ' + nDown + ' of ' + broad.length + ' sectors down, ' + win(w) + ')' };
}

/** A stock's fall type: company (2x its sector), sector (the sector 2x the index), else market. */
export function classifyStock(ticker: string, stockRet: number | null, sectorEtf: string | null, sectorRet: number | null, indexTicker: string, idxRet: number | null): { type: FallType | null; text: string } {
  const R = EVENT_RULES;
  if (stockRet == null) return { type: null, text: 'type not known (no ' + ticker + ' change)' };
  const s = ticker + ' ' + pct(stockRet);
  const twice = (a: number, b: number): boolean => (b < 0 ? a <= R.ratio * b + 1e-12 : a < 0);
  if (sectorEtf && sectorRet != null) {
    if (twice(stockRet, sectorRet)) return { type: 'company', text: TYPE_TEXT.company + ' (' + s + ' vs ' + sectorEtf + ' ' + pct(sectorRet) + ')' };
    if (idxRet != null && twice(sectorRet, idxRet)) return { type: 'sector', text: 'sector (' + sectorEtf + ' ' + pct(sectorRet) + ' vs ' + indexTicker + ' ' + pct(idxRet) + ')' };
    if (idxRet != null) return { type: 'market', text: TYPE_TEXT.market + ' (' + s + ', ' + sectorEtf + ' ' + pct(sectorRet) + ', ' + indexTicker + ' ' + pct(idxRet) + ')' };
    return { type: null, text: 'type not known (' + indexTicker + ' not available)' };
  }
  if (idxRet == null) return { type: null, text: 'type not known (no sector ETF or ' + indexTicker + ' data)' };
  if (twice(stockRet, idxRet)) return { type: 'company', text: TYPE_TEXT.company + ' (' + s + ' vs ' + indexTicker + ' ' + pct(idxRet) + '; sector ETF not known)' };
  return { type: 'market', text: TYPE_TEXT.market + ' (' + s + ' vs ' + indexTicker + ' ' + pct(idxRet) + ')' };
}

// ── signals ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The value of `key` in force on `day` (the last point dated on or before it with the value set). */
function valueOn(pts: readonly FundPoint[], key: 'analystTarget' | 'ratingScore', day: string): { v: number; date: string } | null {
  let best: { v: number; date: string } | null = null;
  for (const p of pts) {
    const v = p[key];
    if (p.date && p.date <= day && fin(v) && (!best || p.date > best.date)) best = { v, date: p.date };
  }
  return best;
}

/** A stock's cut forecasts: target cut 10%+ or rating score 0.5+ worse vs 30 days ago. */
export function cutsOf(history: readonly FundPoint[], latest: FundPoint | null, today: string): Sig {
  const R = EVENT_RULES, base = addDays(today, -R.cutLookbackDays);
  const past = history.filter((p) => p.date && p.date < today);
  const parts: string[] = [];
  let known = false, cut = false;
  const t = latest?.analystTarget, tb = valueOn(past, 'analystTarget', base);
  if (fin(t) && tb && tb.v > 0) {
    known = true;
    const ch = t / tb.v - 1;
    if (ch <= -R.targetCut + 1e-12) { cut = true; parts.push('target ' + pct(ch, 0) + ' since ' + tb.date); }
  }
  const r = latest?.ratingScore, rb = valueOn(past, 'ratingScore', base);
  if (fin(r) && rb) {
    known = true;
    if (r - rb.v >= R.ratingWorse - 1e-9) { cut = true; parts.push('rating ' + rb.v.toFixed(1) + ' → ' + r.toFixed(1)); }
  }
  if (!known) return { v: null, text: 'not known (no history ' + R.cutLookbackDays + ' days back)' };
  return cut ? { v: true, text: 'yes (' + parts.join(', ') + ')' } : { v: false, text: 'no' };
}

/** The market's cut forecasts: half or more of the stocks whose answer is known. */
export function marketCutsOf(each: readonly Tri[]): Sig {
  const known = each.filter((x) => x !== null), yes = known.filter((x) => x === true).length;
  if (!known.length) return { v: null, text: 'not known (no history ' + EVENT_RULES.cutLookbackDays + ' days back)' };
  const v = yes / known.length >= EVENT_RULES.marketCutShare - 1e-12;
  return { v, text: (v ? 'yes' : 'no') + ' (' + yes + ' of ' + known.length + ' stocks)' };
}

/** Credit stress: the HYG / IEF ratio over the last creditDays common dates. */
export function creditOf(hy: Series | null, safe: Series | null): Sig {
  const R = EVENT_RULES, label = CREDIT_PAIR.hy + ' vs ' + CREDIT_PAIR.safe;
  if (!hy || !safe) return { v: null, text: 'not known (' + label + ' not available)' };
  const m = new Map<string, number>();
  hy.dates.forEach((d, i) => { const c = hy.closes[i]; if (fin(c) && c > 0) m.set(d, c); });
  const ratio: number[] = [];
  safe.dates.forEach((d, i) => { const c = safe.closes[i], h = m.get(d); if (fin(c) && c > 0 && h != null) ratio.push(h / c); });
  if (ratio.length <= R.creditDays) return { v: null, text: 'not known (' + label + ': too few days)' };
  const ch = ratio[ratio.length - 1]! / ratio[ratio.length - 1 - R.creditDays]! - 1;
  return { v: ch <= -R.creditFall + 1e-12, text: (ch <= -R.creditFall + 1e-12 ? 'yes' : 'no') + ' (' + label + ' ' + pct(ch) + ' in ' + R.creditDays + ' days)' };
}

/** Rates: TLT down 5%+ over 20 days, or the 10-year yield up 0.40+ points over the stored values. */
export function ratesOf(tlt: Series | null, dgs10: readonly number[] | null): Sig {
  const R = EVENT_RULES, parts: string[] = [];
  let known = false, hit = false;
  const t = changeOver(tlt, R.ratesDays);
  if (t != null) { known = true; parts.push(RATES_ETF + ' ' + pct(t)); if (t <= -R.tltFall + 1e-12) hit = true; }
  const y = (dgs10 ?? []).filter(fin);
  if (y.length >= 2) {
    known = true;
    const rise = y[y.length - 1]! - y[Math.max(0, y.length - 1 - R.ratesDays)]!;
    parts.push('10y ' + (rise >= 0 ? '+' : '−') + Math.abs(rise).toFixed(2) + ' pts');
    if (rise >= R.yieldRise - 1e-9) hit = true;
  }
  if (!known) return { v: null, text: 'not known (' + RATES_ETF + ' / 10y yield not available)' };
  return { v: hit, text: (hit ? 'yes' : 'no') + ' (' + parts.join(', ') + ')' };
}

/** The Monday of a 'YYYY-MM-DD' (the week key). */
const weekOf = (d: string): string => { const t = dayMs(d), wd = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - wd * 86_400_000).toISOString().slice(0, 10); };

/** The last close of each calendar week, oldest first. */
export function weeklyCloses(s: Series): number[] {
  const out: number[] = [];
  let key = '';
  s.dates.forEach((d, i) => {
    const c = s.closes[i];
    if (!fin(c)) return;
    const k = weekOf(d);
    if (k === key) out[out.length - 1] = c; else { out.push(c); key = k; }
  });
  return out;
}

/** Grinding: 5+ lower weekly closes in a row, ending at this week. */
export function grindingOf(s: Series | null): Sig {
  const R = EVENT_RULES;
  if (!s) return { v: null, text: 'not known (no chart)' };
  const w = weeklyCloses(s);
  if (w.length < R.grindWeeks + 1) return { v: null, text: 'not known (fewer than ' + (R.grindWeeks + 1) + ' weeks)' };
  let n = 0;
  for (let k = w.length - 1; k > 0 && w[k]! < w[k - 1]!; k--) n++;
  return { v: n >= R.grindWeeks, text: (n >= R.grindWeeks ? 'yes' : 'no') + ' (' + n + ' lower week' + (n === 1 ? '' : 's') + ' in a row)' };
}

/** A bounce: the last close 3%+ above the lowest close of the last 5 bars. */
export function bounceOf(s: Series | null): Tri {
  const R = EVENT_RULES;
  if (!s || s.closes.length < R.bounceDays) return null;
  const last = s.closes.slice(-R.bounceDays).filter(fin);
  if (last.length < R.bounceDays) return null;
  return last[last.length - 1]! >= Math.min(...last) * (1 + R.bounce) - 1e-12;
}

// ── verdict and sizing ─────────────────────────────────────────────────────────────────────────────────────────────

export function verdictOf(s: Pick<EventSignals, 'cuts' | 'credit' | 'rates' | 'grinding'>): EventVerdict {
  if (s.cuts.v === true && s.credit.v === true) return 'long';
  if (s.rates.v === true || s.grinding.v === true || s.cuts.v === true || s.credit.v === true) return 'months';
  return 'short';
}

const usd0 = (x: number): string => '$' + (x >= 1000 && x % 1000 === 0 ? x / 1000 + 'k' : String(x));

/**
 * The owner's sizing rule for the verdict. `blackSwan` = a market-wide fall of black-swan size; `strongWashout` = a
 * strong company (fundamentals >= 70) is washing out (for the market: at least one tonight).
 */
export function sizingOf(v: EventVerdict, s: Pick<EventSignals, 'cuts' | 'credit'>, blackSwan: boolean, strongWashout: boolean): string {
  const R = EVENT_RULES, normal = 'normal ' + usd0(R.normalSize) + ' per stock';
  if (v === 'long') return 'sizing: no loan (long-type signs); ' + normal + ' at most';
  if (v === 'months') return 'sizing: ' + normal + '; no big loan (not a short black swan)';
  if (blackSwan && strongWashout && s.cuts.v === false && s.credit.v === false) {
    return 'sizing: a short black swan with strong companies washing out: the big-loan case (only if ' + EVENT_RULES.loanRate * 100
      + '% loan < QQQ after tax, the stock beats QQQ, the payment covered after a 50% fall)';
  }
  if (s.cuts.v === null || s.credit.v === null) return 'sizing: ' + normal + '; no big loan (long-type signs not ruled out: data not known)';
  return 'sizing: ' + normal + '; a big loan only on a short black swan with strong companies washing out';
}

// ── the night (pure) ───────────────────────────────────────────────────────────────────────────────────────────────

const strongWash = (st: EventStock): boolean => fin(st.fundScore) && st.fundScore >= STRONG_FUNDAMENTALS && washoutReadLast(st.series.closes, WASHOUTS.W1).fired;

/** Any trigger tonight (the market or a stock)? Used to skip every extra fetch on quiet nights. */
export function anyTrigger(indexTicker: string, index: Series | null, stocks: readonly { readonly ticker: string; readonly series: Series }[], today: string): boolean {
  return !!marketTrigger(indexTicker, index, today) || stocks.some((s) => !!stockTrigger(s.ticker, s.series, today));
}

/** Tonight's event checks; null on a quiet night (no trigger). */
export function eventNight(x: EventNightInput): EventNight | null {
  const R = EVENT_RULES, idx = x.index.series, it = x.index.ticker;
  const mTrig = marketTrigger(it, idx, x.today);
  const sTrigs = x.stocks.map((st) => ({ st, t: stockTrigger(st.ticker, st.series, x.today) })).filter((z): z is { st: EventStock; t: Trigger } => !!z.t);
  if (!mTrig && !sTrigs.length) return null;
  const credit = creditOf(x.hy, x.safe), rates = ratesOf(x.tlt, x.dgs10);
  const cutsBy = new Map(x.stocks.map((st) => [st.ticker, cutsOf(st.history, st.latest, x.today)] as const));
  let market: EventCheck | null = null;
  let blackSwan = false;
  if (mTrig) {
    const rets: Record<string, number | null> = {};
    for (const e of [...BROAD_SECTORS, ...CHIP_ETFS]) rets[e] = changeOver(x.sectors[e], mTrig.window);
    const ty = classifyMarket(it, changeOver(idx, mTrig.window), rets, mTrig.window);
    const r5 = changeOver(idx, 5);
    blackSwan = ty.type === 'market' && ((r5 != null && r5 <= R.blackSwanFall5d + 1e-12) || (x.vix != null && x.vix >= R.blackSwanVix));
    const signals: EventSignals = { cuts: marketCutsOf([...cutsBy.values()].map((s) => s.v)), credit, rates, grinding: grindingOf(idx), bounce: bounceOf(idx) };
    const verdict = verdictOf(signals);
    market = { subject: 'MARKET', trigger: mTrig.text, type: ty.type, typeText: ty.text, signals, verdict, sizing: sizingOf(verdict, signals, blackSwan, x.stocks.some(strongWash)) };
  }
  const stocks: EventCheck[] = sTrigs.map(({ st, t }) => {
    const etf = st.sectorEtf ? st.sectorEtf.toUpperCase() : null;
    const ty = classifyStock(st.ticker, changeOver(st.series, t.window), etf, etf ? changeOver(x.sectors[etf], t.window) : null, it, changeOver(idx, t.window));
    const signals: EventSignals = { cuts: cutsBy.get(st.ticker)!, credit, rates, grinding: grindingOf(st.series), bounce: bounceOf(st.series) };
    const verdict = verdictOf(signals);
    return { subject: st.ticker, trigger: t.text, type: ty.type, typeText: ty.text, signals, verdict, sizing: sizingOf(verdict, signals, blackSwan, strongWash(st)) };
  });
  return { today: x.today, market, stocks };
}

// ── the lines ──────────────────────────────────────────────────────────────────────────────────────────────────────

const signalsText = (s: EventSignals): string =>
  'cut forecasts: ' + s.cuts.text + ' · credit stress: ' + s.credit.text + ' · rates: ' + s.rates.text + ' · grinding: ' + s.grinding.text
  + (s.grinding.v !== true ? ' (a sharp drop' + (s.bounce === true ? ' with a bounce' : s.bounce === false ? ', no bounce yet' : '') + ')' : '');

/** What goes after a washout alert line ("⚡ Event check: ..."). */
export function eventSuffix(c: EventCheck): string {
  return '⚡ Event check: ' + c.typeText + '; ' + signalsText(c.signals) + '; ' + VERDICT_TEXT[c.verdict] + '; ' + c.sizing + '.' + (c.ai ? ' ' + c.ai : '');
}

/**
 * The Buy report's "Event check" block: the market check, then each stock check not already shown next to a washout
 * line (`shown`). Empty = no block (a quiet night).
 */
export function eventBlockLines(n: EventNight | null, shown: ReadonlySet<string> = new Set()): string[] {
  if (!n) return [];
  const out: string[] = [];
  const m = n.market;
  if (m) {
    out.push('Market: ' + m.trigger + ': ' + m.typeText + '.');
    out.push('Signals: ' + signalsText(m.signals) + '.');
    out.push('Verdict: ' + VERDICT_TEXT[m.verdict] + '. ' + m.sizing.charAt(0).toUpperCase() + m.sizing.slice(1) + '.');
    if (m.ai) out.push(m.ai);
  }
  for (const c of n.stocks) {
    if (shown.has(c.subject)) continue;
    out.push(c.trigger + ': ' + c.typeText + '; ' + signalsText(c.signals) + '; ' + VERDICT_TEXT[c.verdict] + '; ' + c.sizing + '.' + (c.ai ? ' ' + c.ai : ''));
  }
  return out;
}

/** The block's heading. */
export const EVENT_BLOCK_HEADING = '⚡ Event check (display only: no rule or score changes)';

// ── the optional AI sentence (Gemini; never Opus) ──────────────────────────────────────────────────────────────────

export const AI_LABEL = 'AI, unverified:';

export function aiPrompt(c: EventCheck, today: string): string {
  const what = c.subject === 'MARKET' ? 'the US stock market fall (' + c.trigger + ', ' + c.typeText + ')' : 'the fall of ' + c.subject + ' (' + c.trigger + ', ' + c.typeText + ')';
  return 'In ONE sentence of at most 30 words, name the most likely news cause of ' + what + ' as of ' + today
    + ', with the date of that news. If you do not know, answer exactly: cause not known. No advice.';
}

/** The first sentence of the answer, at most 240 characters, labelled; null for an empty answer. */
export function aiSentence(text: string | null | undefined): string | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const first = (t.match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim();
  return AI_LABEL + ' ' + (first.length > 240 ? first.slice(0, 237) + '...' : first);
}

/** Adds the AI sentence to the market check and the first stock checks (at most maxAi calls). A failed call = no line. */
export async function withAi(n: EventNight, ask: ((prompt: string) => Promise<string | null>) | null, log: (m: string) => void): Promise<EventNight> {
  if (!ask) return n;
  let calls = 0;
  const one = async (c: EventCheck): Promise<EventCheck> => {
    if (calls >= EVENT_RULES.maxAi) return c;
    calls++;
    const a = aiSentence(await ask(aiPrompt(c, n.today)).catch((e: unknown) => { log('event check: AI sentence not available for ' + c.subject + ': ' + String(e)); return null; }));
    return a ? { ...c, ai: a } : c;
  };
  const market = n.market ? await one(n.market) : null;
  const stocks: EventCheck[] = [];
  for (const c of n.stocks) stocks.push(await one(c));
  return { ...n, market, stocks };
}

// ── gathering (I/O; only on a night with a trigger) ────────────────────────────────────────────────────────────────

export interface EventGatherDeps {
  readonly today: string;
  readonly indexTicker: string;
  /** Tonight's held / watchlist stocks (the washout alert's candidates). */
  readonly candidates: () => Promise<readonly WashoutCandidate[]>;
  /** A chart the run already caches (the index, sector ETFs, TLT, ^VIX); null = none. */
  readonly chart: (ticker: string) => Promise<Series | null>;
  /** A chart read raw (HYG, IEF: no price tab is created); null = none. */
  readonly rawChart: (ticker: string) => Promise<Series | null>;
  /** The stock's sector ETF from tonight's analysis (chips -> SMH); null = not known. */
  readonly sectorEtf: (ticker: string) => Promise<string | null>;
  /** Tonight's fundamentals point from the analysis; null = none. */
  readonly latest: (ticker: string) => Promise<FundPoint | null>;
  /** The stored fundamentals history by ticker; null = none. */
  readonly history: () => Promise<ReadonlyMap<string, readonly FundPoint[]> | null>;
  /** The Macro Snapshot's DGS10 values; null = none. */
  readonly dgs10: () => Promise<readonly number[] | null>;
  /** Gemini, one sentence (null when the run has no Gemini key or AI is off). Never Opus. */
  readonly ai: ((prompt: string) => Promise<string | null>) | null;
}

/** Tonight's event night; null on a quiet night (then nothing but the index chart and the candidates was read). */
export async function gatherEventNight(d: EventGatherDeps, log: (m: string) => void): Promise<EventNight | null> {
  const safe = <T>(what: string, p: Promise<T>, fb: T): Promise<T> => p.catch((e: unknown) => { log('event check: ' + what + ' not available: ' + String(e)); return fb; });
  const index = await safe(d.indexTicker, d.chart(d.indexTicker), null);
  const cands = await safe('stocks', d.candidates(), [] as readonly WashoutCandidate[]);
  const base = cands.map((c) => { const n = Math.min(c.dates.length, c.closes.length); return { c, series: { dates: c.dates.slice(0, n), closes: c.closes.slice(0, n) } }; });
  if (!anyTrigger(d.indexTicker, index, base.map((b) => ({ ticker: b.c.ticker.toUpperCase(), series: b.series })), d.today)) return null;
  const hist = await safe('fundamentals history', d.history(), null);
  const stocks: EventStock[] = [];
  for (const b of base) {
    const t = b.c.ticker.toUpperCase();
    stocks.push({
      ticker: t, held: b.c.held, series: b.series, fundScore: b.c.fundScore,
      sectorEtf: await safe('sector of ' + t, d.sectorEtf(t), null),
      history: hist?.get(t) ?? [], latest: await safe('fundamentals of ' + t, d.latest(t), null),
    });
  }
  const sectors: Record<string, Series | null> = {};
  for (const e of new Set([...BROAD_SECTORS, ...CHIP_ETFS, ...stocks.map((s) => s.sectorEtf).filter((e): e is string => !!e)])) sectors[e] = await safe(e, d.chart(e), null);
  const vixS = await safe('^VIX', d.chart('^VIX'), null);
  const vix = vixS && vixS.closes.length ? vixS.closes[vixS.closes.length - 1] ?? null : null;
  const night = eventNight({
    today: d.today, index: { ticker: d.indexTicker, series: index }, sectors,
    hy: await safe(CREDIT_PAIR.hy, d.rawChart(CREDIT_PAIR.hy), null), safe: await safe(CREDIT_PAIR.safe, d.rawChart(CREDIT_PAIR.safe), null),
    tlt: await safe(RATES_ETF, d.chart(RATES_ETF), null), dgs10: await safe('10y yield', d.dgs10(), null),
    vix: fin(vix) ? vix : null, stocks,
  });
  if (!night) return null;
  const out = await withAi(night, d.ai, log);
  log('event check: ' + (out.market ? 'market ' + VERDICT_TEXT[out.market.verdict] : 'no market fall') + '; ' + out.stocks.length + ' stock(s)' + (out.stocks.length ? ' (' + out.stocks.map((c) => c.subject).join(', ') + ')' : ''));
  return out;
}

/** Profile `alerts.eventCheck`: 'on' = the event check; 'off' (the default) = nothing at all. */
export const eventCheckOn = (p: { readonly alerts: { readonly eventCheck?: string } }): boolean => p.alerts.eventCheck === 'on';

/** Sector ETF of a stock from its analysis: chips -> SMH, else the analysis' sector ETF; null = not known. */
export function sectorEtfOf(industry: unknown, sectorRsEtf: unknown): string | null {
  if (typeof industry === 'string' && /semiconductor/i.test(industry)) return 'SMH';
  return typeof sectorRsEtf === 'string' && /^[A-Z]{2,5}$/.test(sectorRsEtf) ? sectorRsEtf : null;
}
