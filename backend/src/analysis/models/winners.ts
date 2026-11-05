/**
 * James — Winners & Layering (docs/models/plans/09-winners-and-layering.md): pure, causal reads for one day.
 * James's rules (source D): buy dips in the few big winners; the price decides how hard you layer (only 1-2% adds at
 * high prices); cut your losers; keep a firm grip on your winners (no profit target). Every number but "1-2%" is ours
 * ([PROPOSED], swept). Day i uses bars 0..i only. Used by the history test (research/bigWinnersCli.ts), the report page
 * and the paper test.
 */

import { rsiArray } from '../series.ts';

export interface WBars { readonly closes: readonly number[]; readonly highs: readonly number[] }
export type WinnerRanking = '12m' | '6mVsQqq' | '3y';
export const RANK_BARS: Readonly<Record<WinnerRanking, number>> = { '12m': 252, '6mVsQqq': 126, '3y': 756 };

/** W2: the ranking score at bar i (null without the history): 12-month return, 6-month return minus QQQ's, or 3-year return. */
export function rankScore(b: WBars, i: number, r: WinnerRanking, qqq?: { readonly closes: readonly number[]; readonly i: number }): number | null {
  const n = RANK_BARS[r];
  if (i < n || i >= b.closes.length) return null;
  const own = (b.closes[i] as number) / (b.closes[i - n] as number) - 1;
  if (r !== '6mVsQqq') return own;
  if (!qqq || qqq.i < n) return null;
  return own - ((qqq.closes[qqq.i] as number) / (qqq.closes[qqq.i - n] as number) - 1);
}

export type Zone = 'High' | 'Middle' | 'Deep';
export interface ZoneOptions { readonly hi: number; readonly deep: number; readonly extendedOn: boolean }
export const ZONE_DEFAULT: ZoneOptions = { hi: 0.15, deep: 0.40, extendedOn: true };

/** The 200-day simple average at every bar (null before 200 closes). */
export function sma200Series(closes: readonly number[]): Array<number | null> {
  const out: Array<number | null> = []; let s = 0;
  for (let i = 0; i < closes.length; i++) { s += closes[i] as number; if (i >= 200) s -= closes[i - 200] as number; out.push(i >= 199 ? s / 200 : null); }
  return out;
}
const maxHigh = (b: WBars, i: number, n: number): number => { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, b.highs[k] as number); return m; };

/**
 * Z2 / Z4: the drawdown of the close from its 52-week high (the highest high of the last 252 bars), the zone (High under
 * `hi`, Middle under `deep`, Deep at or beyond it; 14.99% is High, 15% Middle, 40% Deep) and "extended" (close above
 * 0.95 x the 52-week high or more than 20% above the 200-day average), which forces High-zone sizes.
 */
export function zoneOf(b: WBars, i: number, sma200: number | null, o: ZoneOptions = ZONE_DEFAULT): { readonly drawdown: number; readonly zone: Zone; readonly extended: boolean; readonly sizeZone: Zone } {
  const hi52 = maxHigh(b, i, 252), c = b.closes[i] as number, drawdown = 1 - c / hi52;
  const dd = Math.round(drawdown * 1e9) / 1e9;
  const zone: Zone = dd < o.hi ? 'High' : dd < o.deep ? 'Middle' : 'Deep';
  const extended = o.extendedOn && (c > 0.95 * hi52 || (sma200 != null && c > 1.2 * sma200));
  return { drawdown, zone, extended, sizeZone: extended ? 'High' : zone };
}

export type DipRule = 'dd20' | 'dd50' | 'rsi35';
/** Z1: the dip — a close at least 10% under its 20-day high, 15% under its 50-day high, or RSI(14) < 35. */
export function dipFires(b: WBars, i: number, rule: DipRule, rsi?: ReadonlyArray<number | null>): boolean {
  const c = b.closes[i] as number;
  if (rule === 'dd20') return c <= 0.9 * maxHigh(b, i, 20);
  if (rule === 'dd50') return c <= 0.85 * maxHigh(b, i, 50);
  const r = rsi ? rsi[i] : rsiAt(b.closes, i);
  return r != null && r < 35;
}
/** RSI(14) at every bar (rsiArray aligned to the bars; null before it starts). */
export function rsiSeries(closes: readonly number[]): Array<number | null> {
  const r = rsiArray(closes, 14), out: Array<number | null> = Array(closes.length).fill(null);
  r.forEach((v, j) => { out[j + 14] = v; });
  return out;
}
function rsiAt(closes: readonly number[], i: number): number | null { return rsiSeries(closes.slice(0, i + 1))[i] ?? null; }

/** C1: closes in a row under the 200-day average, ending at bar i. */
export function closesUnder200(closes: readonly number[], sma: ReadonlyArray<number | null>, i: number): number {
  let n = 0;
  for (let k = i; k >= 0; k--) { const m = sma[k]; if (m == null || (closes[k] as number) >= m) break; n++; }
  return n;
}

export type TieBreak = 'T-A' | 'T-B' | 'T-C';
export type WinnersState = 'CUT' | 'ADD' | 'HOLD';
export interface StateInput {
  readonly held: boolean; readonly winner: boolean; readonly longTermWinner: boolean; readonly qqqAbove200: boolean;
  readonly dip: boolean; readonly spacingOk: boolean; readonly capOk: boolean;
  readonly close: number; readonly sma200: number | null; readonly closesUnder200: number; readonly cutAfter: number;
  readonly tieBreak: TieBreak;
  /** C2 / C3 / the grip variant fired (cut regardless of the tie-break). */
  readonly otherCut: boolean;
}
/**
 * Plan 09 section 2c, checked in this order, exactly one state a day: CUT (held, and a cut rule fires: the trend cut
 * where the tie-break applies it, or C2 / C3) — then ADD (a winner, the dip, spacing and caps pass, and the stock may be
 * bought here: T-A only above the 200-day; T-B also under it for a 3-year winner while QQQ is above its 200-day; T-C
 * anywhere) — else HOLD (no profit target).
 */
export function stateOf(x: StateInput): WinnersState {
  const trendCut = x.tieBreak === 'T-A' || (x.tieBreak === 'T-B' && !x.longTermWinner);
  if (x.held && (x.otherCut || (trendCut && x.closesUnder200 >= x.cutAfter))) return 'CUT';
  const above = x.sma200 != null && x.close > x.sma200;
  const mayBuy = x.tieBreak === 'T-C' || above || (x.tieBreak === 'T-B' && x.longTermWinner && x.qqqAbove200);
  if (x.winner && x.dip && x.spacingOk && x.capOk && mayBuy) return 'ADD';
  return 'HOLD';
}
