/**
 * James — Pair Rotation (docs/models/plans/06-pair-rotation.md; G4 "pair engine"): one pot always long ONE of two
 * stocks (never short), swapped when the price ratio R = A / B (split-adjusted closes) is stretched. James's IADSS and
 * "ATR model" settings are not in the files (D12): two stand-ins, each [PROPOSED] and swept:
 *
 *   - Z:   z_t = (ln R_t - SMA_n(ln R)) / SD_n(ln R) (population SD); z >= +k -> hold B (A is rich), z <= -k -> hold A.
 *   - ATR: middle = EMA_n(R); band = middle ± m x ATR(20) of synthetic ratio bars (high = H_A / L_B, low = L_A / H_B,
 *          close = C_A / C_B; Wilder); R under the lower band -> hold A, over the upper band -> hold B.
 *   - "confirmed": act on the first close back inside the band after a close beyond it.
 *   - otherwise keep what is held; a swap is followed by `coolDown` days without another.
 *
 * Causal: day i uses bars 0..i. Pure; used by the history test (research/pairCli.ts), the report page and the paper test.
 */

import { stdDev, emaArray, wilderArray } from '../series.ts';
import { activeProfile } from '../../profile/active.ts';

export interface PairLeg { readonly dates: readonly string[]; readonly opens: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[]; readonly closes: readonly number[] }
export interface AlignedPair { readonly dates: string[]; readonly ia: number[]; readonly ib: number[] }

/** The dates both legs trade, with each leg's bar index. */
export function alignPair(a: PairLeg, b: PairLeg): AlignedPair {
  const mb = new Map(b.dates.map((d, i) => [d, i]));
  const dates: string[] = [], ia: number[] = [], ib: number[] = [];
  a.dates.forEach((d, i) => { const j = mb.get(d); if (j != null) { dates.push(d); ia.push(i); ib.push(j); } });
  return { dates, ia, ib };
}

export interface RatioBars { readonly high: number[]; readonly low: number[]; readonly close: number[] }
export function ratioBars(a: PairLeg, b: PairLeg, al: AlignedPair): RatioBars {
  return {
    high: al.ia.map((i, k) => (a.highs[i] as number) / (b.lows[al.ib[k] as number] as number)),
    low: al.ia.map((i, k) => (a.lows[i] as number) / (b.highs[al.ib[k] as number] as number)),
    close: al.ia.map((i, k) => (a.closes[i] as number) / (b.closes[al.ib[k] as number] as number)),
  };
}

/** z of ln R over n days (null before n). */
export function pairZSeries(ratio: readonly number[], n: number): Array<number | null> {
  const l = ratio.map((r) => Math.log(r));
  return l.map((_, i) => {
    if (i < n - 1) return null;
    const w = l.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n, sd = stdDev(w);
    return sd > 0 ? ((l[i] as number) - m) / sd : null;
  });
}

/** The ATR band around EMA_n(R): Wilder ATR(atrN) of the synthetic ratio bars. */
export function pairAtrBand(rb: RatioBars, emaN: number, m: number, atrN = 20): Array<{ lower: number; middle: number; upper: number } | null> {
  const e = emaArray(rb.close, emaN);
  const tr: number[] = [];
  for (let i = 1; i < rb.close.length; i++) { const pc = rb.close[i - 1] as number; tr.push(Math.max((rb.high[i] as number) - (rb.low[i] as number), Math.abs((rb.high[i] as number) - pc), Math.abs((rb.low[i] as number) - pc))); }
  const w = wilderArray(tr, atrN);
  return rb.close.map((_, i) => {
    const ei = i - (emaN - 1), wi = i - atrN;
    if (ei < 0 || wi < 0) return null;
    const mid = e[ei] as number, atr = w[wi] as number;
    return { lower: mid - m * atr, middle: mid, upper: mid + m * atr };
  });
}

export type PairLegId = 'A' | 'B';
export interface PairOptions {
  readonly signal: 'Z' | 'ATR';
  /** Lookback: z window, or the EMA length of the ATR middle line. */
  readonly n: number;
  /** k (Z) or m (ATR). */
  readonly band: number;
  readonly confirmed: boolean;
  readonly coolDown: number;
  readonly start: 'cheaper' | 'A' | 'B';
}
export const PAIR_DEFAULT: PairOptions = { signal: 'Z', n: 20, band: 2, confirmed: false, coolDown: 1, start: 'cheaper' };

export interface PairDay { readonly R: number; readonly z: number | null; readonly lower: number | null; readonly middle: number | null; readonly upper: number | null; readonly hold: PairLegId | null; readonly swap: boolean }

/** One causal pass: per aligned day the ratio, the z, the band and the leg the model holds after tonight's close. */
export function pairStateSeries(rb: RatioBars, o: PairOptions): PairDay[] {
  const z = pairZSeries(rb.close, o.n), band = o.signal === 'ATR' ? pairAtrBand(rb, o.n, o.band) : null;
  let hold: PairLegId | null = null, beyond: 'hi' | 'lo' | null = null, since = 1e9;
  return rb.close.map((R, i) => {
    const zi = z[i] ?? null, bi = band ? band[i] ?? null : null;
    const pos: 'hi' | 'lo' | 'in' | null = o.signal === 'Z' ? (zi == null ? null : zi >= o.band ? 'hi' : zi <= -o.band ? 'lo' : 'in') : (bi == null ? null : R > bi.upper ? 'hi' : R < bi.lower ? 'lo' : 'in');
    let want: PairLegId | null = null;
    if (pos != null) {
      if (!o.confirmed) want = pos === 'hi' ? 'B' : pos === 'lo' ? 'A' : null;
      else { if (pos === 'in' && beyond) want = beyond === 'hi' ? 'B' : 'A'; beyond = pos === 'in' ? null : pos; }
    }
    let swap = false;
    since++;
    if (hold == null && pos != null) {
      hold = o.start === 'A' ? 'A' : o.start === 'B' ? 'B' : (o.signal === 'Z' ? (zi as number) < 0 : R < (bi as { middle: number }).middle) ? 'A' : 'B';
      since = 1e9;
    } else if (hold != null && want != null && want !== hold && since > o.coolDown) { hold = want; swap = true; since = 0; }
    return { R, z: zi, lower: bi?.lower ?? null, middle: bi?.middle ?? null, upper: bi?.upper ?? null, hold, swap };
  });
}

/** The configured pairs (plan 06 section 2b; D8), profile `models.pairs` (GENERIC_PLAN P2); none = the model has no pairs. */
export const PAIRS: ReadonlyArray<readonly [string, string]> = activeProfile().models.pairs;
/** The pair(s) a ticker is a leg of. */
export const pairsOf = (t: string): Array<readonly [string, string]> => PAIRS.filter(([a, b]) => a === t || b === t);
