/**
 * Options sentiment plan part B (docs/OPTIONS_SENTIMENT_PLAN.md section 3): the market-wide options read from the SPY
 * and QQQ chains. DISPLAY ONLY: it feeds no score (not macroRegime, not the tech score, conviction, timing, tier or the
 * paper test). Changing that needs the section 5 forward test and an owner yes.
 *
 *   Put/call OI        whole chain, and expiries <= 60 days only (index P/C sits above 1: hedging; never the stock bands)
 *   Put/call volume    whole chain (0 / null when Cboe reports no volume at the nightly hour, P0)
 *   Skew               ~30-day expiry: IV of the 25-delta put minus IV of the 25-delta call, in vol points; without
 *                      delta: IV of the put nearest the 95% strike minus the call nearest the 105% strike
 *   Term structure     ATM IV ~30 / ~90 / ~365 days (atmIv); 30d ÷ 365d; "inverted" above 1
 *   IV vs history      ATM 30d IV vs RV20; the percentile of ATM 30d IV over the stored nights (null until 252 nights);
 *                      interim reference: VIX within its 52-week range
 *   Sanity check       SPY ATM 30d IV vs VIX ÷ 100: a gap above 5 vol points flags a parse problem (logged)
 *   Plain read         "hedging heavy" (skew >= 7 pts or term inverted), "hedging light" (skew <= 3 pts, term not
 *                      inverted), else "hedging normal". A display label, not a tested signal.
 */

import { parseOcc, type CboeChainJson } from '../../fetch/cboe.ts';
import { atmIv, chainCalls, ivRankOverTime, nearestExpiry, IV_RANK_NIGHTS } from '../../paper/chainSnapshot.ts';
import { realizedVol } from './blackScholes.ts';

export const MARKET_OPTIONS_ETFS: readonly string[] = ['SPY', 'QQQ'];
export const SKEW_HEAVY_PTS = 7;
export const SKEW_LIGHT_PTS = 3;
export const VIX_GAP_FLAG_PTS = 5;

export type HedgingRead = 'hedging heavy' | 'hedging normal' | 'hedging light' | 'n/a';

export interface MarketOptionsRead {
  readonly day: string;
  readonly etf: string;
  readonly status: 'ok' | 'no chain';
  readonly spot: number | null;
  readonly pcOi: number | null;
  readonly pcOi60: number | null;
  readonly pcVol: number | null;
  readonly totalVolume: number;
  readonly skewPts: number | null;
  readonly skewMethod: '25-delta' | '95/105 strike' | 'none';
  readonly exp30: string | null;
  readonly iv30: number | null;
  readonly iv90: number | null;
  readonly iv365: number | null;
  readonly termRatio: number | null;
  readonly term: 'inverted' | 'normal' | 'n/a';
  readonly rv20: number | null;
  readonly ivVsRv: number | null;
  /** Percentile of tonight's ATM 30d IV over the stored nights; null until IV_RANK_NIGHTS nights. */
  readonly ivPct: number | null;
  /** Stored nights before tonight (for "N of 252 nights"). */
  readonly nights: number;
  readonly vix: number | null;
  readonly vixRangePct: number | null;
  /** SPY only: (ATM 30d IV - VIX / 100) in vol points. */
  readonly vixGapPts: number | null;
  readonly check: 'ok' | 'check' | '';
  readonly read: HedgingRead;
  readonly bytes: number | null;
  readonly parseMs: number | null;
}

interface Opt { readonly side: 'call' | 'put'; readonly strike: number; readonly expUnix: number; readonly oi: number; readonly vol: number; readonly iv: number | null; readonly delta: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null, dp: number): number | null => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const DAY = 86_400;

function optsOf(json: CboeChainJson | null): Opt[] {
  const out: Opt[] = [];
  for (const o of json?.data?.options ?? []) {
    if (!o.option) continue;
    const p = parseOcc(String(o.option));
    if (!(p.strike > 0)) continue;
    const iv = num(o.iv);
    out.push({ side: p.side, strike: p.strike, expUnix: p.expUnix, oi: Number(o.open_interest) || 0, vol: Number(o.volume) || 0, iv: iv != null && iv > 0 ? iv : null, delta: num(o.delta) });
  }
  return out;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Skew at one expiry, in vol points (put IV minus call IV). */
export function skewAt(opts: readonly Opt[], expUnix: number, spot: number): { pts: number | null; method: MarketOptionsRead['skewMethod'] } {
  const at = opts.filter((o) => o.expUnix === expUnix && o.iv != null);
  const nearest = <T>(xs: readonly T[], dist: (x: T) => number): T | null => xs.reduce<T | null>((b, x) => (b == null || dist(x) < dist(b) ? x : b), null);
  const puts = at.filter((o) => o.side === 'put' && o.delta != null), calls = at.filter((o) => o.side === 'call' && o.delta != null);
  const p25 = nearest(puts, (o) => Math.abs(Math.abs(o.delta as number) - 0.25)), c25 = nearest(calls, (o) => Math.abs(Math.abs(o.delta as number) - 0.25));
  if (p25 && c25) return { pts: ((p25.iv as number) - (c25.iv as number)) * 100, method: '25-delta' };
  const p95 = nearest(at.filter((o) => o.side === 'put'), (o) => Math.abs(o.strike - spot * 0.95));
  const c105 = nearest(at.filter((o) => o.side === 'call'), (o) => Math.abs(o.strike - spot * 1.05));
  if (p95 && c105) return { pts: ((p95.iv as number) - (c105.iv as number)) * 100, method: '95/105 strike' };
  return { pts: null, method: 'none' };
}

export function hedgingRead(skewPts: number | null, term: MarketOptionsRead['term']): HedgingRead {
  if (skewPts == null && term === 'n/a') return 'n/a';
  if ((skewPts != null && skewPts >= SKEW_HEAVY_PTS) || term === 'inverted') return 'hedging heavy';
  if (skewPts != null && skewPts <= SKEW_LIGHT_PTS) return 'hedging light';
  return 'hedging normal';
}

export interface MarketReadInputs {
  readonly day: string;
  readonly etf: string;
  readonly json: CboeChainJson | null;
  readonly nowMs: number;
  /** The ETF's daily closes up to tonight (RV20); empty when not fetched. */
  readonly closes?: readonly number[];
  /** ATM 30d IV of the stored nights before tonight (oldest first). */
  readonly ivHistory?: readonly number[];
  /** VIX: tonight's level and its daily closes (52-week range). */
  readonly vix?: { readonly level: number; readonly closes: readonly number[] } | null;
  readonly stats?: { readonly bytes: number; readonly parseMs: number } | null;
}

/** One ETF's market read. A chain that is missing or has no options reads "no chain". */
export function marketReadOf(x: MarketReadInputs): MarketOptionsRead {
  const nowUnix = Math.floor(x.nowMs / 1000);
  const opts = optsOf(x.json);
  const spot = num(x.json?.data?.current_price) ?? (x.closes && x.closes.length ? (x.closes[x.closes.length - 1] as number) : null);
  const hist = x.ivHistory ?? [];
  const vix = x.vix && Number.isFinite(x.vix.level) ? x.vix : null;
  const v52 = vix ? vix.closes.slice(-252) : [];
  const vHi = v52.length ? Math.max(...v52) : null, vLo = v52.length ? Math.min(...v52) : null;
  const vixRangePct = vix && vHi != null && vLo != null ? (vHi > vLo ? ((vix.level - vLo) / (vHi - vLo)) * 100 : 50) : null;
  const base = { day: x.day, etf: x.etf, spot, nights: hist.length, vix: vix ? vix.level : null, vixRangePct: round(vixRangePct, 0), bytes: x.stats ? x.stats.bytes : null, parseMs: x.stats ? Math.round(x.stats.parseMs) : null };
  if (!opts.length || spot == null) {
    return { ...base, status: 'no chain', pcOi: null, pcOi60: null, pcVol: null, totalVolume: 0, skewPts: null, skewMethod: 'none', exp30: null, iv30: null, iv90: null, iv365: null, termRatio: null, term: 'n/a', rv20: null, ivVsRv: null, ivPct: null, vixGapPts: null, check: '', read: 'n/a' };
  }
  const sum = (xs: readonly Opt[], f: (o: Opt) => number): number => xs.reduce((s, o) => s + f(o), 0);
  const calls = opts.filter((o) => o.side === 'call'), puts = opts.filter((o) => o.side === 'put');
  const near = (o: Opt): boolean => o.expUnix - nowUnix <= 60 * DAY;
  const pcOi = ratio(sum(puts, (o) => o.oi), sum(calls, (o) => o.oi));
  const pcOi60 = ratio(sum(puts.filter(near), (o) => o.oi), sum(calls.filter(near), (o) => o.oi));
  const pcVol = ratio(sum(puts, (o) => o.vol), sum(calls, (o) => o.vol));
  const cc = chainCalls(x.json);
  const e30 = nearestExpiry(cc, nowUnix, 30, 7), e90 = nearestExpiry(cc, nowUnix, 90, 45), e365 = nearestExpiry(cc, nowUnix, 365, 180);
  const iv30 = e30 == null ? null : atmIv(cc, e30, spot), iv90 = e90 == null ? null : atmIv(cc, e90, spot), iv365 = e365 == null ? null : atmIv(cc, e365, spot);
  const skew = e30 == null ? { pts: null, method: 'none' as const } : skewAt(opts, e30, spot);
  const termRatio = iv30 != null && iv365 != null && iv365 > 0 ? iv30 / iv365 : null;
  const term: MarketOptionsRead['term'] = termRatio == null ? 'n/a' : termRatio > 1 ? 'inverted' : 'normal';
  const rv20 = x.closes ? realizedVol(x.closes, 20) : null;
  const vixGap = x.etf === 'SPY' && iv30 != null && vix ? (iv30 - vix.level / 100) * 100 : null;
  return {
    ...base, status: 'ok',
    pcOi: round(pcOi, 3), pcOi60: round(pcOi60, 3), pcVol: round(pcVol, 3), totalVolume: sum(opts, (o) => o.vol),
    skewPts: round(skew.pts, 2), skewMethod: skew.method, exp30: e30 == null ? null : new Date(e30 * 1000).toISOString().slice(0, 10),
    iv30: round(iv30, 4), iv90: round(iv90, 4), iv365: round(iv365, 4), termRatio: round(termRatio, 3), term,
    rv20: round(rv20, 4), ivVsRv: iv30 != null && rv20 ? round(iv30 / rv20, 3) : null,
    ivPct: iv30 == null ? null : round(ivRankOverTime(hist, iv30), 0),
    vixGapPts: round(vixGap, 2), check: vixGap == null ? '' : Math.abs(vixGap) > VIX_GAP_FLAG_PTS ? 'check' : 'ok',
    read: hedgingRead(skew.pts, term),
  };
}

const pct = (v: number | null): string => (v == null ? 'n/a' : Math.round(v * 100) + '%');

/** One ETF in words: "SPY P/C 1.40, skew 6.1 pts, term normal, IV 30d 15% vs RV20 11% (hedging normal)". */
export function marketReadText(r: MarketOptionsRead): string {
  if (r.status !== 'ok') return r.etf + ': no chain tonight';
  const bits = [r.etf + ' P/C ' + (r.pcOi == null ? 'n/a' : r.pcOi.toFixed(2)), 'skew ' + (r.skewPts == null ? 'n/a' : r.skewPts.toFixed(1) + ' pts'), 'term ' + r.term,
    'IV 30d ' + pct(r.iv30) + ' vs RV20 ' + pct(r.rv20)];
  if (r.ivPct != null) bits.push('IV percentile ' + r.ivPct);
  else if (r.iv30 != null) bits.push('IV history ' + r.nights + ' of ' + IV_RANK_NIGHTS + ' nights');
  return bits.join(', ') + ' (' + r.read + ')';
}

/** The one line for the reports and the AI prompt; null when no ETF had a chain. */
export function marketReadLine(reads: readonly MarketOptionsRead[]): string | null {
  const ok = reads.filter((r) => r.status === 'ok');
  if (!ok.length) return null;
  return 'Market options (' + ok[0]!.day + ', display only, feeds no score): ' + ok.map(marketReadText).join('; ') + '.';
}
