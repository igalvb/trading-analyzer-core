/**
 * James — Mean Reversion's +2 SD trim (plan 05 section 2c): the long-only stand-in for James's call selling at +2 SD.
 * An overlay on a held basket: a close with z_n >= +2 sells `size` of the stock's shares at the next open (oldest lots
 * first, 25% tax on the gain); the same number of shares is bought back at the next open after a close with z_n <= 0
 * (variant: z_n <= -2) or after `maxWait` trading days, whichever comes first; no new trim within `coolDown` days of the
 * last one. The trimmed money waits in cash. Equal money in each stock trading on the first day, bought at its first
 * open (as holdBag); the shared `costBps` on every trade. No short, no option, never sells more than held.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { zSeries } from '../analysis/models/meanReversion.ts';

export interface TrimOptions {
  /** off = plain hold (the control). */
  readonly on: boolean;
  readonly n: number; readonly size: number; readonly buyBack: 'mean' | 'minus2'; readonly maxWait: number; readonly coolDown: number;
}
export const TRIM_DEFAULT: TrimOptions = { on: true, n: 20, size: 0.2, buyBack: 'mean', maxWait: 39, coolDown: 10 };

export interface TrimResult { readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trims: number; readonly boughtBackLower: number; readonly taxPaid: number }

interface Lot { shares: number; px: number }

const zCache = new WeakMap<PriceSeries, Map<number, Array<number | null>>>();
const zOf = (s: PriceSeries, n: number): Array<number | null> => { let m = zCache.get(s); if (!m) zCache.set(s, (m = new Map())); let z = m.get(n); if (!z) m.set(n, (z = zSeries(s.closes, n))); return z; };

export function runTrim(series: readonly PriceSeries[], days: readonly string[], cash: number, o: TrimOptions, costBps = 0): TrimResult {
  const c = costBps / 10_000, first = days[0] as string;
  const live = series.filter((s) => (s.dates[0] as string) <= first);
  let money = cash, taxPaid = 0, trims = 0, lower = 0, peak = 0, dd = 0;
  const st = live.map((s) => {
    const idx = new Map(s.dates.map((d, i) => [d, i])), i0 = idx.get(first) ?? s.dates.findIndex((d) => d >= first);
    const pc = (s.opens[i0] as number) * (1 + c), n = Math.floor(cash / live.length / pc);
    money -= n * pc;
    return { s, idx, z: zOf(s, o.n), lots: [{ shares: n, px: pc }] as Lot[], last: s.opens[i0] as number, out: 0, trimPx: 0, since: -1, lastTrim: -1e9, act: '' as '' | 'trim' | 'back' };
  });
  days.forEach((d, di) => {
    for (const x of st) {
      const k = x.idx.get(d);
      if (k == null) continue;
      // the open: yesterday's decision
      if (x.act === 'trim') {
        const held = x.lots.reduce((a, l) => a + l.shares, 0), n = Math.floor(held * o.size), px = x.s.opens[k] as number;
        if (n > 0) {
          let left = n, cost = 0;
          while (left > 0 && x.lots.length) { const l = x.lots[0]!, q = Math.min(left, l.shares); cost += q * l.px; l.shares -= q; left -= q; if (!l.shares) x.lots.shift(); }
          const v = n * px, fee = v * c, tax = Math.max(0, v - fee - cost) * EXIT_TAX_RATE;
          money += v - fee - tax; taxPaid += tax; trims++; x.out = n; x.trimPx = px; x.since = 0; x.lastTrim = di;
        }
      } else if (x.act === 'back' && x.out > 0) {
        const px = x.s.opens[k] as number, pc = px * (1 + c), n = Math.min(x.out, Math.floor(Math.max(0, money) / pc));
        if (n > 0) { money -= n * pc; x.lots.push({ shares: n, px: pc }); if (px < x.trimPx) lower++; }
        x.out = 0; x.since = -1;
      }
      x.act = '';
      x.last = x.s.closes[k] as number;
      // the close: tonight's decision
      if (!o.on || di === days.length - 1) continue;
      const z = x.z[k];
      if (x.out > 0) {
        x.since++;
        if ((z != null && z <= (o.buyBack === 'mean' ? 0 : -2)) || x.since >= o.maxWait) x.act = 'back';
      } else if (z != null && z >= 2 && di - x.lastTrim >= o.coolDown) x.act = 'trim';
    }
    const v = money + st.reduce((a, x) => a + x.lots.reduce((s, l) => s + l.shares, 0) * x.last, 0);
    peak = Math.max(peak, v); dd = Math.max(dd, (1 - v / peak) * 100);
  });
  let fin = money;
  for (const x of st) for (const l of x.lots) { const val = l.shares * x.last; fin += val - Math.max(0, val - l.shares * l.px) * EXIT_TAX_RATE; }
  return { finalTaxed: live.length ? fin : cash, maxDrawdownPct: dd, trims, boughtBackLower: lower, taxPaid };
}
