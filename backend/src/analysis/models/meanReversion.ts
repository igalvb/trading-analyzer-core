/**
 * James — Mean Reversion ±2 SD (docs/models/plans/05-mean-reversion-2sd.md): the distance of the close from its n-day
 * average in standard deviations, z_n(t) = (close_t - SMA_n(t)) / SD_n(t), with SD the POPULATION standard deviation of
 * the last n closes (analysis/series.ts stdDev, the same as the Bollinger slice), so z = ±2 is exactly the engine's
 * 20-day Bollinger band. James's IADSS settings are not in the files (D7): n, k, "confirmed" and every exit are ours.
 *
 * Causal: day i uses bars 0..i only. Pure; used by the history test (research/meanRevCli.ts), the report page
 * (analysis/jamesPhase2Pages.ts) and the paper test.
 */

import { stdDev, wilderArray } from '../series.ts';

export interface MrBars { readonly closes: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[] }

/** z_n at every bar (null before n closes, or a flat window). */
export function zSeries(closes: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i] as number;
    if (i >= n) sum -= closes[i - n] as number;
    if (i < n - 1) { out.push(null); continue; }
    const w = closes.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n, sd = stdDev(w);
    out.push(sd > 0 ? ((closes[i] as number) - m) / sd : null);
  }
  return out;
}

/** The n-day average and population SD at bar i (null before n closes). */
export function bandAt(closes: readonly number[], i: number, n: number): { sma: number; sd: number } | null {
  if (i < n - 1) return null;
  const w = closes.slice(i - n + 1, i + 1);
  return { sma: w.reduce((a, b) => a + b, 0) / n, sd: stdDev(w) };
}

/**
 * Wilder's ADX(14) at every bar, exactly as computeTrendStrengthSlice computes it on the bars up to that day (bars
 * whose smoothed true range is 0 are skipped, as there). null until the ADX has its 14 DX values.
 */
export function adxSeries(b: MrBars): Array<number | null> {
  const n = b.closes.length;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = b.highs[i] as number, l = b.lows[i] as number, pc = b.closes[i - 1] as number;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - (b.highs[i - 1] as number), dn = (b.lows[i - 1] as number) - l;
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const sTR = wilderArray(tr, 14), sP = wilderArray(pdm, 14), sM = wilderArray(mdm, 14);
  // sTR[j] covers true ranges 0..j+13, i.e. bars 1..j+14
  const out: Array<number | null> = Array(n).fill(null);
  let adx: number | null = null, seed: number[] = [];
  for (let j = 0; j < sTR.length; j++) {
    const bar = j + 14;
    if (sTR[j] !== 0) {
      const p = (100 * (sP[j] as number)) / (sTR[j] as number), m = (100 * (sM[j] as number)) / (sTR[j] as number);
      const dx = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
      if (adx == null) { seed.push(dx); if (seed.length === 14) { adx = seed.reduce((a, c) => a + c, 0) / 14; seed = []; } }
      else adx = (adx * 13 + dx) / 14;
    }
    out[bar] = adx;
  }
  return out;
}

export type MrState = 'normal' | 'buyZone' | 'confirmedBuy' | 'trimZone';
export type MrEntry = 'E1' | 'E2' | 'E3';

/**
 * The entry signal per bar (plan 05 section 2b): E1 "unconfirmed" = a close with z <= -k; E2 "confirmed" = the first
 * close back above the lower band (z > -k) after a run of closes at or under it that began at most `m` days before;
 * E3 "turnaround" = after a close with z <= -k, the first close above the prior day's high within 5 days.
 */
export function entrySignals(b: MrBars, z: ReadonlyArray<number | null>, entry: MrEntry, k: number, m = 5): boolean[] {
  const out: boolean[] = Array(z.length).fill(false);
  let runStart = -1, lastLow = -1, e3Used = -1;
  for (let i = 0; i < z.length; i++) {
    const zi = z[i];
    const low = zi != null && zi <= -k;
    if (entry === 'E1') { out[i] = low; continue; }
    if (entry === 'E2') {
      if (low) { if (runStart < 0) runStart = i; continue; }
      if (runStart >= 0) { if (zi != null && i - runStart <= m) out[i] = true; runStart = -1; }
      continue;
    }
    // E3
    if (low) { lastLow = i; continue; }
    if (lastLow >= 0 && i - lastLow <= 5 && e3Used !== lastLow && i > 0 && (b.closes[i] as number) > (b.highs[i - 1] as number)) { out[i] = true; e3Used = lastLow; }
  }
  return out;
}

/** The page's state for the last bar: Buy zone (z <= -2), Confirmed buy (E2 today), Trim zone (z >= +2), Normal. */
export function stateAt(b: MrBars, z: ReadonlyArray<number | null>, i: number, k = 2, m = 5): MrState {
  const zi = z[i];
  if (zi == null) return 'normal';
  if (zi <= -k) return 'buyZone';
  if (zi >= k) return 'trimZone';
  return entrySignals({ closes: b.closes.slice(0, i + 1), highs: b.highs.slice(0, i + 1), lows: b.lows.slice(0, i + 1) }, z.slice(0, i + 1), 'E2', k, m)[i] ? 'confirmedBuy' : 'normal';
}

/** Wilder's ATR(14) at every bar (as computeAtrSlice on the bars up to that day); null before it has 14 true ranges. */
export function atrSeries(b: MrBars, n = 14): Array<number | null> {
  const tr: number[] = [];
  for (let i = 1; i < b.closes.length; i++) {
    const h = b.highs[i] as number, l = b.lows[i] as number, pc = b.closes[i - 1] as number;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const w = wilderArray(tr, n), out: Array<number | null> = Array(b.closes.length).fill(null);
  w.forEach((v, j) => { out[j + n] = v; });
  return out;
}

/** One causal pass for a page or a test: per day z10 / z20 / z50, the 20-day band, ADX(14) and the state. */
export interface MeanRevDay { readonly z10: number | null; readonly z20: number | null; readonly z50: number | null; readonly sma: number | null; readonly lower: number | null; readonly upper: number | null; readonly adx14: number | null; readonly state: MrState }
export function meanRevSeries(b: MrBars, k = 2): MeanRevDay[] {
  const z10 = zSeries(b.closes, 10), z20 = zSeries(b.closes, 20), z50 = zSeries(b.closes, 50), adx = adxSeries(b);
  const e2 = entrySignals(b, z20, 'E2', k);
  return b.closes.map((_, i) => {
    const band = bandAt(b.closes, i, 20), zi = z20[i] ?? null;
    const state: MrState = zi == null ? 'normal' : zi <= -k ? 'buyZone' : zi >= k ? 'trimZone' : e2[i] ? 'confirmedBuy' : 'normal';
    return { z10: z10[i] ?? null, z20: zi, z50: z50[i] ?? null, sma: band?.sma ?? null, lower: band ? band.sma - k * band.sd : null, upper: band ? band.sma + k * band.sd : null, adx14: adx[i] ?? null, state };
  });
}
