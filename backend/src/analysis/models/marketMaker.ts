/**
 * James — Market Maker Stages (docs/models/plans/08-market-maker-stages.md), built on the Wyckoff spring: James's four
 * stages (liquidity grab, the range forms and recovers, the second sweep / fakeout, then long) on daily bars.
 *
 *   - V1 "Wyckoff spring" (default): the events of `wyckoffClassicSeries`, read as they are (that file is not changed):
 *     stage 1 = SC, stage 2 = AR / ST, stage 3 = SPRING (a low under the climax low that closes back at or above it),
 *     so V1 has no double-bottom form. `sweepLow` = the low of the SPRING day.
 *   - V2 "loose stages" (C M4): stage 1 = a low under the prior 20 lows with a true range >= 2 x ATR(14) and volume >=
 *     1.5 x its 50-day average (its low = L1); stage 2 = within 3-15 days a close above L1 + 50% of that day's range;
 *     stage 3 = within 30 days of stage 1 a low under L1 (V2) or at most L1 x 1.01 (V2 + double bottom) closing back
 *     above L1.
 *   - Context [PROPOSED, D13]: the 200-day simple average rising over 20 days and the stage-3 low at least 0.97 x it.
 *   - The plan at entry: stop = the stage-3 low - 1 x ATR(14); target 1 = the median close of the range days (the
 *     volume point of control stand-in); target 2 = the range top.
 * One causal pass; future bars never change an earlier day. Display and research only.
 */

import { wyckoffClassicSeries, type WyckoffBars, type WyckoffDay } from './wyckoffClassic.ts';
import { atrSeries } from './meanReversion.ts';

export type MmVariant = 'V1' | 'V2' | 'V2DB';
/** off; rising 200-day and the low >= 1.00 / 0.97 / 0.95 x it. */
export type MmContext = 'off' | 'r100' | 'r097' | 'r095';
export interface MmOptions {
  readonly variant: MmVariant;
  readonly context: MmContext;
  /** Stop: the stage-3 low minus this many ATR(14); 'pct1' = the low - 1%. */
  readonly stop: 0.5 | 1 | 1.5 | 'pct1';
}
export const MM_DEFAULT: MmOptions = { variant: 'V1', context: 'r097', stop: 1 };
export const MM_WINDOW = 20;

export interface MmDay {
  /** 0 no setup; 1 liquidity grab; 2 range forming; 3 second sweep today (the buy signal); 4 in the trade window. */
  readonly stage: 0 | 1 | 2 | 3 | 4;
  readonly grabLow: number | null; readonly grabDay: number | null;
  readonly rangeLow: number | null; readonly rangeHigh: number | null; readonly poc: number | null;
  readonly sweepLow: number | null;
  /** Stage 3 today (before the context filter). */
  readonly sweep: boolean;
  /** Stage 3 today and the context passes: buy at the next open. */
  readonly signal: boolean;
  readonly stop: number | null; readonly target1: number | null; readonly target2: number | null;
  readonly context: { readonly sma200: number | null; readonly rising: boolean | null; readonly nearSupport: boolean | null };
  /** V1: the Wyckoff TEST after a spring (the existing model's own, later timing; the event study's control). */
  readonly test: boolean;
  /** Days since the last signal (stage 4 lasts MM_WINDOW days). */
  readonly sinceSignal: number | null;
}

export interface MmBars extends WyckoffBars { readonly dates?: readonly unknown[] }

const median = (xs: readonly number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2; };
const ctxFactor: Readonly<Record<MmContext, number | null>> = { off: null, r100: 1.0, r097: 0.97, r095: 0.95 };

function sma200Arr(c: readonly number[]): Array<number | null> {
  const out: Array<number | null> = []; let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i] as number; if (i >= 200) s -= c[i - 200] as number; out.push(i >= 199 ? s / 200 : null); }
  return out;
}

/** The raw stages (no context, no plan): per day the stage and the range. */
interface Raw { stage: 0 | 1 | 2 | 3; grabLow: number | null; grabDay: number | null; rangeLow: number | null; rangeHigh: number | null; poc: number | null; sweep: boolean; test: boolean }

function v1Raw(b: WyckoffBars, wy: readonly WyckoffDay[]): Raw[] {
  const out: Raw[] = [];
  let sc: number | null = null, ar: number | null = null, sprung = false;
  for (let i = 0; i < wy.length; i++) {
    const w = wy[i] as WyckoffDay;
    if (w.event === 'SC') { sc = i; ar = null; sprung = false; }
    if (w.event === 'AR' && sc != null) ar = i;
    const open = w.context === 'accumulation' && sc != null;
    if (!open) { sc = null; ar = null; sprung = false; }
    const sweep = open && w.event === 'SPRING';
    if (sweep) sprung = true;
    const closes: number[] = [];
    if (sweep) for (let k = ar ?? (sc as number) + 1; k < i; k++) closes.push(b.closes[k] as number);
    const stage: Raw['stage'] = sweep ? 3 : !open ? 0 : ar != null || w.phase === 'B' || w.phase === 'C' ? 2 : 1;
    out.push({ stage, grabLow: open ? (b.lows[sc as number] as number) : null, grabDay: open ? sc : null, rangeLow: open ? w.support : null, rangeHigh: open ? w.resistance : null,
      poc: sweep ? median(closes) : null, sweep, test: open && sprung && w.event === 'TEST' });
  }
  return out;
}

function v2Raw(b: WyckoffBars, doubleBottom: boolean, atr: ReadonlyArray<number | null>): Raw[] {
  const out: Raw[] = [], L = b.lows, H = b.highs, C = b.closes, V = b.volumes;
  let s1: number | null = null, l1 = 0, rng1 = 0, s2 = false, top = 0;
  for (let i = 0; i < C.length; i++) {
    let sweep = false;
    // a fresh liquidity grab (also restarts a setup that has not reached stage 2)
    let low20 = Infinity; for (let k = Math.max(0, i - 20); k < i; k++) low20 = Math.min(low20, L[k] as number);
    let v50 = 0, nv = 0; for (let k = Math.max(0, i - 50); k < i; k++) { v50 += V[k] as number; nv++; }
    const tr = i > 0 ? Math.max((H[i] as number) - (L[i] as number), Math.abs((H[i] as number) - (C[i - 1] as number)), Math.abs((L[i] as number) - (C[i - 1] as number))) : 0;
    const a = i > 0 ? atr[i - 1] ?? null : null;
    const grab = i >= 20 && a != null && nv >= 20 && (L[i] as number) < low20 && tr >= 2 * a && (V[i] as number) >= 1.5 * (v50 / nv);
    if (s1 != null && i - s1 > 30) { s1 = null; s2 = false; }
    if (s1 != null && s2 && i > s1) {
      const lo = L[i] as number, under = doubleBottom ? lo <= l1 * 1.01 : lo < l1;
      if (under && (C[i] as number) > l1) sweep = true;
      else if ((C[i] as number) < l1 * 0.97) { s1 = null; s2 = false; }
    }
    if (!sweep && grab && (s1 == null || !s2)) { s1 = i; l1 = L[i] as number; rng1 = (H[i] as number) - (L[i] as number); s2 = false; top = H[i] as number; }
    else if (s1 != null && !sweep) {
      top = Math.max(top, H[i] as number);
      if (!s2 && i - s1 >= 3 && i - s1 <= 15 && (C[i] as number) > l1 + 0.5 * rng1) s2 = true;
      else if (!s2 && i - s1 > 15) { s1 = null; }
    }
    const closes: number[] = [];
    if (sweep && s1 != null) for (let k = s1 + 1; k < i; k++) closes.push(C[k] as number);
    out.push({ stage: sweep ? 3 : s1 == null ? 0 : s2 ? 2 : 1, grabLow: s1 != null ? l1 : null, grabDay: s1, rangeLow: s1 != null ? l1 : null, rangeHigh: s1 != null ? top : null, poc: sweep ? median(closes) : null, sweep, test: false });
    if (sweep) { s1 = null; s2 = false; }
  }
  return out;
}

export function marketMakerSeries(b: MmBars, o: MmOptions = MM_DEFAULT): MmDay[] {
  const atr = atrSeries(b), sma = sma200Arr(b.closes);
  const raw = o.variant === 'V1' ? v1Raw(b, wyckoffClassicSeries(b)) : v2Raw(b, o.variant === 'V2DB', atr);
  const f = ctxFactor[o.context];
  const out: MmDay[] = [];
  let last: number | null = null;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Raw, m = sma[i] ?? null, m20 = i >= 20 ? sma[i - 20] ?? null : null;
    const rising = m != null && m20 != null ? m > m20 : null;
    const sweepLow = r.sweep ? (b.lows[i] as number) : null;
    const nearSupport = sweepLow != null && m != null ? sweepLow >= (f ?? 0.97) * m : null;
    const pass = r.sweep && (f == null || (rising === true && nearSupport === true));
    const a = atr[i] ?? null;
    const stop = sweepLow == null ? null : o.stop === 'pct1' ? sweepLow * 0.99 : a == null ? null : sweepLow - o.stop * a;
    if (pass) last = i;
    const since = last == null ? null : i - last;
    const stage: MmDay['stage'] = pass ? 3 : since != null && since > 0 && since <= MM_WINDOW && r.stage < 3 && !r.sweep ? 4 : (r.stage === 3 ? 2 : r.stage);
    out.push({ stage, grabLow: r.grabLow, grabDay: r.grabDay, rangeLow: r.rangeLow, rangeHigh: r.rangeHigh, poc: r.poc, sweepLow, sweep: r.sweep, signal: pass,
      stop, target1: r.sweep ? r.poc : null, target2: r.sweep ? r.rangeHigh : null, context: { sma200: m, rising, nearSupport }, test: r.test, sinceSignal: since });
  }
  return out;
}

/** Long-only 1%-risk size: whole shares = floor(risk x equity / (entry - stop)), capped at one slot and at the cash. */
export function riskShares(equity: number, entry: number, stop: number, o: { readonly risk: number; readonly slotShare: number; readonly cash: number }): number {
  if (!(entry > stop) || !(entry > 0)) return 0;
  const byRisk = Math.floor((o.risk * equity) / (entry - stop)), cap = Math.floor(Math.min(o.slotShare * equity, o.cash) / entry);
  return Math.max(0, Math.min(byRisk, cap));
}
