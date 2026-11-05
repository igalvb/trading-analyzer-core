/**
 * Readers for Finnhub's `/stock/metric` "series" block -- the quarterly and
 * annual history of each metric, newest point first.
 *
 * seriesLatestV7 (fullStockAnalysisV10_9.gs:1658-1672) and seriesArrayV7
 * (:1674-1681), ported exactly. They live in the fetch layer because the
 * peer-metrics fetcher (dataLayerV1.gs:111-112) uses them too.
 *
 * Kept as in legacy: `isNaN` coerces, so a numeric STRING passes the check
 * and is returned as the string.
 */

export interface SeriesPoint {
  readonly period?: string;
  readonly v: number | null;
}

export interface FinnhubMetricSeries {
  readonly quarterly?: Readonly<Record<string, readonly SeriesPoint[]>>;
  readonly annual?: Readonly<Record<string, readonly SeriesPoint[]>>;
}

type SeriesLike = FinnhubMetricSeries | null | undefined;

/** quarterly[key][0].v -> annual[key][0].v -> flatFallback -> avFallback -> null. Never fabricates. */
export function seriesLatest(series: SeriesLike, key: string, flatFallback: number | null, avFallback: number | null): number | null {
  try {
    if (series && series.quarterly && Array.isArray(series.quarterly[key]) && series.quarterly[key].length) {
      const v = series.quarterly[key][0] && series.quarterly[key][0].v;
      if (v != null && !isNaN(v)) return v;
    }
    if (series && series.annual && Array.isArray(series.annual[key]) && series.annual[key].length) {
      const v = series.annual[key][0] && series.annual[key][0].v;
      if (v != null && !isNaN(v)) return v;
    }
  } catch {
    /* as legacy */
  }
  if (flatFallback != null && !isNaN(flatFallback)) return flatFallback;
  if (avFallback != null && !isNaN(avFallback)) return avFallback;
  return null;
}

/** Up to `maxPoints` (default 8) usable points, quarterly preferred, else annual. */
export function seriesArray(series: SeriesLike, key: string, maxPoints?: number): SeriesPoint[] {
  try {
    const src = (series && series.quarterly && Array.isArray(series.quarterly[key]) && series.quarterly[key].length)
      ? series.quarterly[key]
      : (series && series.annual && Array.isArray(series.annual[key])) ? series.annual[key] : [];
    return src.filter((p) => p && p.v != null && !isNaN(p.v)).slice(0, maxPoints || 8);
  } catch {
    return [];
  }
}
