/**
 * James — LEAPS, model 3 (docs/models/plans/03-james-leaps-method.md section 2.2 B): when James buys — in a "fire
 * sale". Causal: day i uses closes 0..i only.
 *
 *   market fire sale  QQQ closes >= 20% below its 52-week (252-bar) closing high. An EPISODE starts on the first
 *                     such close and ends after 60 trading days with no such close; at most one buy per stock per
 *                     episode. No turnaround wait (James bought GOOG and TSLA "during the C19 DIP", March 2020).
 *   stock fire sale   the stock closes >= 40% below its 52-week closing high AND some close of the last 20 days had
 *                     z <= -2 (z = (close - 20-day average) / 20-day SD); then a TURNAROUND within 20 trading days of
 *                     the first such day (James on COIN: "I need to see the turnaround"):
 *                       a  a close back above the 20-day average (default)
 *                       b  a higher low (a 5-day swing low above the fire-sale low, confirmed 2 days later), then a
 *                          close above the highest close since the fire-sale low
 *                       c  3 higher closes in a row
 *                     A new arm needs a new onset of the condition (it lapsed, then holds again).
 *   never buy         while z >= +2 (overextended; the covered-call deck mirrored for a buyer).
 * Every threshold is [PROPOSED] in plan 03 (James defines no "fire sale"); the defaults are fixed in advance.
 */

export interface FireSaleOptions {
  readonly marketDrop: number; readonly episodeGap: number;
  readonly stockDrop: number; readonly zLevel: number; readonly zLookback: number;
  readonly turnaround: 'a' | 'b' | 'c' | 'none';
  readonly window: number;
  /** A market fire sale waits for a turnaround of QQQ (variant; default no). */
  readonly marketTurnaround: boolean;
  readonly highBars: number; readonly zBars: number;
}
export const FIRE_SALE_DEFAULT: FireSaleOptions = { marketDrop: 0.20, episodeGap: 60, stockDrop: 0.40, zLevel: -2, zLookback: 20, turnaround: 'a', window: 20, marketTurnaround: false, highBars: 252, zBars: 20 };

/** Drawdown from the trailing `bars`-bar closing high (0.3 = 30% below), per day. */
export function drawdownSeries(closes: readonly number[], bars = 252): number[] {
  const out: number[] = [];
  const dq: number[] = []; // indices of a decreasing deque of closes
  for (let i = 0; i < closes.length; i++) {
    while (dq.length && (closes[dq[dq.length - 1]!] as number) <= (closes[i] as number)) dq.pop();
    dq.push(i);
    while ((dq[0] as number) <= i - bars) dq.shift();
    const hi = closes[dq[0]!] as number;
    out.push(hi > 0 ? 1 - (closes[i] as number) / hi : 0);
  }
  return out;
}

/** The 20-day z-score and average (sample SD), null before 20 closes. */
export function zSeries(closes: readonly number[], n = 20): { z: Array<number | null>; sma: Array<number | null> } {
  const z: Array<number | null> = [], sma: Array<number | null> = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) { z.push(null); sma.push(null); continue; }
    let s = 0; for (let k = i - n + 1; k <= i; k++) s += closes[k] as number;
    const m = s / n;
    let v = 0; for (let k = i - n + 1; k <= i; k++) v += ((closes[k] as number) - m) ** 2;
    const sd = Math.sqrt(v / (n - 1));
    sma.push(m); z.push(sd > 0 ? ((closes[i] as number) - m) / sd : 0);
  }
  return { z, sma };
}

export interface MarketDay { readonly dd: number; readonly on: boolean; /** episode number (1, 2, ...) while an episode lasts; null otherwise */ readonly episode: number | null; readonly episodeStart: number | null }

/** QQQ's fire-sale state per day. */
export function marketFireSale(qqqCloses: readonly number[], o: Pick<FireSaleOptions, 'marketDrop' | 'episodeGap' | 'highBars'> = FIRE_SALE_DEFAULT): MarketDay[] {
  const dd = drawdownSeries(qqqCloses, o.highBars);
  const out: MarketDay[] = [];
  let ep = 0, start: number | null = null, lastOn = -Infinity;
  for (let i = 0; i < qqqCloses.length; i++) {
    const on = (dd[i] as number) >= o.marketDrop - 1e-12;
    if (on) { if (start == null || i - lastOn > o.episodeGap) { ep++; start = i; } lastOn = i; }
    const active = start != null && i - lastOn <= o.episodeGap;
    if (!active) start = null;
    out.push({ dd: dd[i] as number, on, episode: active ? ep : null, episodeStart: active ? start : null });
  }
  return out;
}

/** The episodes of a series: [start index, last "on" index]. */
export function episodesOf(m: readonly MarketDay[]): Array<{ id: number; start: number; lastOn: number }> {
  const out: Array<{ id: number; start: number; lastOn: number }> = [];
  m.forEach((x, i) => {
    if (x.episode == null) return;
    const e = out.find((y) => y.id === x.episode);
    if (!e) out.push({ id: x.episode, start: i, lastOn: i }); else if (x.on) e.lastOn = i;
  });
  return out;
}

export interface StockDay {
  readonly dd: number; readonly z: number | null; readonly sma20: number | null;
  /** The stock fire-sale condition holds today (the drop and a z <= -2 close in the last 20). */
  readonly signal: boolean;
  /** The first signal day of the current arm (null when not armed). */
  readonly armedSince: number | null;
  /** Today completes the turnaround (or, with turnaround 'none', the first signal day): buy at the next open. */
  readonly buy: boolean;
  readonly why: string | null;
}

/** The stock's fire-sale state per day. */
export function stockFireSale(closes: readonly number[], o: FireSaleOptions = FIRE_SALE_DEFAULT): StockDay[] {
  const dd = drawdownSeries(closes, o.highBars), { z, sma } = zSeries(closes, o.zBars);
  const out: StockDay[] = [];
  let armed: number | null = null, low = Infinity, lowAt = -1, higherLow = false, ups = 0, prevSignal = false;
  for (let i = 0; i < closes.length; i++) {
    let zMin = Infinity;
    for (let k = Math.max(0, i - o.zLookback + 1); k <= i; k++) { const v = z[k]; if (v != null) zMin = Math.min(zMin, v); }
    const signal = (dd[i] as number) >= o.stockDrop - 1e-12 && zMin <= o.zLevel;
    const c = closes[i] as number;
    let buy = false, why: string | null = null;
    if (armed != null && i - armed > o.window) armed = null; // the window ran out: disarmed
    if (signal && !prevSignal && armed == null) { armed = i; low = c; lowAt = i; higherLow = false; ups = 0; if (o.turnaround === 'none') { buy = true; why = 'stock fire sale: ' + Math.round((dd[i] as number) * 100) + '% below its 52-week high'; } }
    else if (armed != null) {
      if (c < low) { low = c; lowAt = i; higherLow = false; }
      ups = i > 0 && c > (closes[i - 1] as number) ? ups + 1 : 0;
      if (o.turnaround === 'a' && sma[i] != null && c > (sma[i] as number)) { buy = true; why = 'turnaround: a close back above the 20-day average'; }
      if (o.turnaround === 'c' && ups >= 3) { buy = true; why = 'turnaround: 3 higher closes in a row'; }
      if (o.turnaround === 'b') {
        // a swing low at i-2 (lowest of i-4..i), above the fire-sale low, after the low
        const k = i - 2;
        if (!higherLow && k - 2 > lowAt && k >= 2) {
          let lowest = true; for (let q = k - 2; q <= i; q++) if ((closes[q] as number) < (closes[k] as number)) lowest = false;
          if (lowest && (closes[k] as number) > low) higherLow = true;
        }
        if (higherLow) { let hi = -Infinity; for (let q = lowAt; q < i; q++) hi = Math.max(hi, closes[q] as number); if (c > hi) { buy = true; why = 'turnaround: a higher low, then a close above the high since the low'; } }
      }
    }
    out.push({ dd: dd[i] as number, z: z[i] ?? null, sma20: sma[i] ?? null, signal, armedSince: armed, buy, why });
    if (buy) armed = null;
    prevSignal = signal;
  }
  return out;
}

/** The z >= +2 guard (never open a new call into a spike). */
export const overextended = (z: number | null): boolean => z != null && z >= 2;
