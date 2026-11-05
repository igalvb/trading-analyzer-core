/**
 * Owner decision 2026-10-30: the short-term call's exit rule reads the WEEKLY chart (the owner trades swings of weeks
 * to years). It replaces the D3 "+50% on the call's price or the 30-day exit" text. DISPLAY ONLY: nothing here feeds a
 * score, the conviction, the verdict, the timing or a Buy report tier.
 *
 * Sell when ANY of:
 *   1. out of steam after a gain: the stock is up since the reference price AND at least 2 of
 *        a. the weekly MACD crossed below its signal (this week or last week),
 *        b. the weekly RSI fell back under 60 after being above 70 within the last 8 weeks,
 *        c. the last weekly close is below the 50-day average;
 *   2. the stock reached the engine's sell zone or T1 AND weekly momentum is weakening (the weekly MACD histogram
 *      fell 2 weeks in a row);
 *   3. the stock closed below the engine's stop;
 *   4. the hard limit: 30 days before expiry.
 * Keep while the weekly trend is up: the weekly close above the 10-week average and the weekly MACD above its signal.
 *
 * Weekly bars are built from the daily chart: one bar per Monday-Friday week, its close = the week's last daily close
 * (Friday's, or the last trading day before a Friday holiday). The current week is partial until Friday's close; it is
 * labelled so. MACD (12, 26, 9) and RSI (14) use the same series helpers as the daily indicators (series.ts).
 */

import { emaArray, rsiArray, sma } from '../series.ts';
import { nyDate } from '../../core/marketSession.ts';

const DAY_MS = 86_400_000;

export interface WeeklyBar {
  /** The week's Monday (yyyy-MM-dd). */
  readonly weekOf: string;
  /** The last daily bar in the week (yyyy-MM-dd). */
  readonly lastDay: string;
  readonly close: number;
  readonly days: number;
}
export interface WeeklySeries { readonly bars: readonly WeeklyBar[]; readonly partial: boolean }

/** A bar's session date is its UTC calendar date (the same rule as core/marketSession.ts liveBarFraction). */
const dayOf = (d: Date | number | string): string | null => {
  const t = new Date(d as never).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const dowOf = (day: string): number => new Date(day + 'T00:00:00Z').getUTCDay();
const mondayOf = (day: string): string => new Date(Date.parse(day + 'T00:00:00Z') - ((dowOf(day) + 6) % 7) * DAY_MS).toISOString().slice(0, 10);

/**
 * Weekly bars from daily dates and closes. `partial` is true for the current week while it can still get bars: the
 * last daily bar is today's unfinished bar (`liveBar`), or `nowMs` is a weekday (New York) of the same week and the
 * last bar is not a Friday. Without `nowMs`, a week not ending on a Friday counts as partial.
 */
export function weeklyBars(dates: readonly (Date | number | string)[], closes: readonly number[], opts: { readonly nowMs?: number; readonly liveBar?: boolean } = {}): WeeklySeries {
  const bars: WeeklyBar[] = [];
  const n = Math.min(dates.length, closes.length);
  for (let i = 0; i < n; i++) {
    const day = dayOf(dates[i]!), c = closes[i];
    if (!day || typeof c !== 'number' || !Number.isFinite(c)) continue;
    const wk = mondayOf(day), last = bars[bars.length - 1];
    if (last && last.weekOf === wk) bars[bars.length - 1] = { weekOf: wk, lastDay: day, close: c, days: last.days + 1 };
    else bars.push({ weekOf: wk, lastDay: day, close: c, days: 1 });
  }
  const last = bars[bars.length - 1];
  let partial = false;
  if (last) {
    if (opts.liveBar) partial = true;
    else if (dowOf(last.lastDay) !== 5) {
      if (opts.nowMs == null) partial = true;
      else { const today = nyDate(opts.nowMs), dow = dowOf(today); partial = dow >= 1 && dow <= 5 && mondayOf(today) === last.weekOf; }
    }
  }
  return { bars, partial };
}

export interface WeeklyMacd { readonly macd: readonly number[]; readonly signal: readonly number[]; readonly hist: readonly number[] }

/** MACD (12, 26, 9) at every bar where the signal exists (the three arrays end on the last bar and have the same length). */
export function macdSeries(closes: readonly number[]): WeeklyMacd {
  const e12 = emaArray(closes, 12), e26 = emaArray(closes, 26);
  const off = e12.length - e26.length;
  const line = e26.map((v, i) => (e12[i + off] as number) - v);
  const signal = emaArray(line, 9);
  const macd = line.slice(line.length - signal.length);
  return { macd, signal, hist: macd.map((m, i) => m - (signal[i] as number)) };
}

export interface ShortTermExitInput {
  readonly dates?: readonly (Date | number | string)[] | null;
  readonly closes?: readonly number[] | null;
  /** Today's price (the live price in the session). */
  readonly price?: number | null;
  /** The price the gain is measured from; for a new pick, today's price (refIsToday). */
  readonly refPrice?: number | null;
  readonly refIsToday?: boolean;
  readonly stop?: number | null;
  readonly t1?: number | null;
  /** The engine's sell zone (confluence exitLow: the zone starts there). */
  readonly sellZoneLow?: number | null;
  /** Calendar days to the call's expiry. */
  readonly daysLeft?: number | null;
  readonly nowMs?: number;
  /** The last daily bar is today's unfinished session bar. */
  readonly liveBar?: boolean;
}

export interface ExitTriggerRead {
  readonly n: 1 | 2 | 3 | 4;
  /** true = sell, false = keep, null = not available. */
  readonly sell: boolean | null;
  /** "✅ keep — ..." / "⚠️ sell: ..." / "not available — ...". */
  readonly reading: string;
}
export interface ShortTermExitRead {
  /** "Weekly bars: ..." (how they were built; the partial week named). */
  readonly weekLine: string;
  readonly triggers: readonly ExitTriggerRead[];
  /** The keep condition: true = weekly trend up. */
  readonly trendUp: boolean | null;
  readonly keepReading: string;
  readonly anySell: boolean;
}

/** Owner 2026-10-30 thresholds. */
export const WEEKLY_EXIT = {
  rsiHigh: 70, rsiBack: 60, rsiLookbackWeeks: 8, dailyAvgDays: 50, weeklyAvgWeeks: 10, minSigns: 2, expiryDays: 30,
} as const;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const usd = (n: number): string => '$' + n.toFixed(2);
const f2 = (n: number): string => n.toFixed(2);
const keep = (s: string): string => '✅ keep — ' + s;
const sellR = (s: string): string => '⚠️ sell: ' + s;
const na = (s: string): string => 'not available — ' + s;

export function readShortTermExit(inp: ShortTermExitInput): ShortTermExitRead {
  const dates = inp.dates ?? [], closes = inp.closes ?? [];
  const wk = weeklyBars(dates, closes, { ...(inp.nowMs != null ? { nowMs: inp.nowMs } : {}), ...(inp.liveBar ? { liveBar: true } : {}) });
  const wc = wk.bars.map((b) => b.close);
  const lastW = wk.bars[wk.bars.length - 1];
  const m = macdSeries(wc);
  const k = m.macd.length;
  const rsi = rsiArray(wc, 14);
  const avg50 = sma(closes.filter((c) => Number.isFinite(c)), WEEKLY_EXIT.dailyAvgDays);
  const avg10w = sma(wc, WEEKLY_EXIT.weeklyAvgWeeks);
  const lastClose = num(closes[closes.length - 1]);
  const price = num(inp.price) ?? lastClose;
  const ref = num(inp.refPrice) ?? (inp.refIsToday ? price : null);
  const weekLine = !lastW ? 'Weekly bars: not available (no daily chart this run).'
    : 'Weekly bars: built from the daily chart (' + wk.bars.length + ' weeks, Friday closes); '
      + (wk.partial ? 'this week (from ' + lastW.weekOf + ') is partial: ' + lastW.days + ' day' + (lastW.days === 1 ? '' : 's') + ' through ' + lastW.lastDay + (inp.liveBar ? ', today\'s session still open' : '') + '.'
        : 'the last week is complete (through ' + lastW.lastDay + ').');

  // 1. out of steam after a gain
  const t1: ExitTriggerRead = (() => {
    if (k < 3 || rsi.length < 1 || avg50 == null || !lastW) return { n: 1, sell: null, reading: na('not enough weekly history for the weekly MACD / RSI (needs about 36 weeks)') };
    const below = (i: number): boolean => (m.macd[i] as number) < (m.signal[i] as number);
    const a = below(k - 1) && (!below(k - 2) || !below(k - 3));
    const rsiNow = rsi[rsi.length - 1] as number, rsiPeak = Math.max(...rsi.slice(-WEEKLY_EXIT.rsiLookbackWeeks));
    const b = rsiNow < WEEKLY_EXIT.rsiBack && rsiPeak > WEEKLY_EXIT.rsiHigh;
    const c = lastW.close < avg50;
    const count = [a, b, c].filter(Boolean).length;
    const signs = count + ' of 3 signs (MACD ' + (a ? 'crossed below its signal' : below(k - 1) ? 'below its signal, no fresh cross' : 'above its signal') + '; RSI ' + rsiNow.toFixed(0)
      + (b ? ', back under ' + WEEKLY_EXIT.rsiBack + ' after ' + rsiPeak.toFixed(0) : ', 8-week high ' + rsiPeak.toFixed(0)) + '; weekly close ' + usd(lastW.close) + (c ? ' below' : ' above') + ' the 50-day average ' + usd(avg50) + ')';
    if (price == null || ref == null) return { n: 1, sell: null, reading: na('no reference price; ' + signs) };
    const up = price > ref;
    if (!up) return { n: 1, sell: false, reading: keep((inp.refIsToday ? 'new pick: today\'s price ' + usd(ref) + ' is the entry, so the stock is not up yet' : 'the stock (' + usd(price) + ') is not up since ' + usd(ref)) + '; ' + signs + '.') };
    const sell = count >= WEEKLY_EXIT.minSigns;
    const gain = 'up ' + ((price / ref - 1) * 100).toFixed(1) + '% since ' + usd(ref) + ', ' + signs;
    return { n: 1, sell, reading: sell ? sellR(gain + '.') : keep(gain + ' (needs ' + WEEKLY_EXIT.minSigns + ').') };
  })();

  // 2. sell zone or T1 reached and weekly momentum weakening
  const t2: ExitTriggerRead = (() => {
    const zone = num(inp.sellZoneLow), tgt = num(inp.t1);
    if (zone == null && tgt == null) return { n: 2, sell: null, reading: na('no sell zone or T1 this run') };
    if (price == null) return { n: 2, sell: null, reading: na('no price') };
    const hits = [zone != null && price >= zone ? 'the sell zone (' + usd(zone) + ')' : null, tgt != null && price >= tgt ? 'T1 (' + usd(tgt) + ')' : null].filter(Boolean) as string[];
    const h = m.hist;
    const momentum = k >= 3 ? ((h[k - 1] as number) < (h[k - 2] as number) && (h[k - 2] as number) < (h[k - 3] as number)) : null;
    const mText = momentum == null ? 'weekly MACD histogram not available' : 'weekly MACD histogram ' + f2(h[k - 3] as number) + ' → ' + f2(h[k - 2] as number) + ' → ' + f2(h[k - 1] as number) + (momentum ? ' (falling 2 weeks in a row)' : ' (not falling 2 weeks in a row)');
    if (!hits.length) return { n: 2, sell: false, reading: keep(usd(price) + ' has not reached ' + [zone != null ? 'the sell zone (' + usd(zone) + ')' : null, tgt != null ? 'T1 (' + usd(tgt) + ')' : null].filter(Boolean).join(' or ') + '; ' + mText + '.') };
    if (momentum == null) return { n: 2, sell: null, reading: na(usd(price) + ' reached ' + hits.join(' and ') + ', but the ' + mText) };
    return { n: 2, sell: momentum, reading: (momentum ? sellR : keep)(usd(price) + ' reached ' + hits.join(' and ') + '; ' + mText + '.') };
  })();

  // 3. closed below the stop
  const t3: ExitTriggerRead = (() => {
    const stop = num(inp.stop);
    if (stop == null) return { n: 3, sell: null, reading: na('no stop this run') };
    const c = lastClose ?? price;
    if (c == null) return { n: 3, sell: null, reading: na('no close') };
    const what = inp.liveBar ? 'today\'s price ' + usd(c) + ' (session still open; it counts at the close)' : 'the last close ' + usd(c);
    return c < stop ? { n: 3, sell: true, reading: sellR(what + ' is below the stop ' + usd(stop) + '.') } : { n: 3, sell: false, reading: keep(what + ' is above the stop ' + usd(stop) + '.') };
  })();

  // 4. hard limit 30 days before expiry
  const t4: ExitTriggerRead = (() => {
    const d = num(inp.daysLeft);
    if (d == null) return { n: 4, sell: null, reading: na('no expiry') };
    return d <= WEEKLY_EXIT.expiryDays ? { n: 4, sell: true, reading: sellR(d + ' days to expiry (the limit is ' + WEEKLY_EXIT.expiryDays + ').') }
      : { n: 4, sell: false, reading: keep(d + ' days to expiry, ' + (d - WEEKLY_EXIT.expiryDays) + ' before the ' + WEEKLY_EXIT.expiryDays + '-day limit.') };
  })();

  // keep while the weekly trend is up
  let trendUp: boolean | null = null, keepReading = na('not enough weekly history (needs about 34 weeks)');
  if (k >= 1 && avg10w != null && lastW) {
    const above = lastW.close > avg10w, mUp = (m.macd[k - 1] as number) > (m.signal[k - 1] as number);
    trendUp = above && mUp;
    keepReading = (trendUp ? '✅ weekly trend up' : '⚠️ weekly trend not up') + ' — weekly close ' + usd(lastW.close) + (above ? ' above' : ' not above') + ' the 10-week average ' + usd(avg10w)
      + '; weekly MACD ' + f2(m.macd[k - 1] as number) + (mUp ? ' above' : ' not above') + ' its signal ' + f2(m.signal[k - 1] as number) + '.';
  }
  const triggers = [t1, t2, t3, t4];
  return { weekLine, triggers, trendUp, keepReading, anySell: triggers.some((t) => t.sell === true) };
}
