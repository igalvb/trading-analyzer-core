/**
 * Trend model (owner 2026-10-28): follows the 150-day trend only. NEW logic.
 *   bullish     close above the 150-day simple average AND the average higher than 20 days ago
 *   cautionary  close more than 3% under the 150-day average (the band keeps small dips from forcing a sale)
 *   mixed       anything else (keep what you have)
 * Causal: day i uses closes 0..i only.
 */

export type TrendDirection = 'bullish' | 'mixed' | 'cautionary';
export const TREND = { days: 150, slopeDays: 20, band: 0.03 } as const;

export interface TrendDay { readonly direction: TrendDirection; readonly sma: number | null; /** close / average - 1 */ readonly strength: number | null }

export function trendSeries(closes: readonly number[], days: number = TREND.days, band: number = TREND.band): TrendDay[] {
  const out: TrendDay[] = [];
  const sma: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i] as number;
    if (i >= days) sum -= closes[i - days] as number;
    const m = i >= days - 1 ? sum / days : null;
    sma.push(m);
    const c = closes[i] as number;
    const prev = i >= TREND.slopeDays ? sma[i - TREND.slopeDays] ?? null : null;
    let direction: TrendDirection = 'mixed';
    if (m != null && c > m && prev != null && m > prev) direction = 'bullish';
    else if (m != null && c < m * (1 - band)) direction = 'cautionary';
    out.push({ direction, sma: m, strength: m != null ? c / m - 1 : null });
  }
  return out;
}
