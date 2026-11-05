/**
 * Price-series types.
 *
 * These shapes are currently implicit in the legacy code -- assembled ad hoc
 * by fetchYahooChart and readPriceCacheV7_ and passed around untyped.
 * Writing them down is where much of TypeScript's value is realised for this
 * port: the act of declaring each field's real optionality surfaces
 * inconsistencies that were previously invisible.
 *
 * Where a legacy inconsistency IS found, record it in the flagged-findings
 * register -- do not silently "fix" it. The port reproduces behaviour.
 */

export interface Split {
  readonly date: Date;
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * A daily OHLCV series plus quote metadata.
 *
 * The six parallel arrays are index-aligned; `dates[i]` describes the bar at
 * `closes[i]`. That invariant is assumed everywhere in the engine and is
 * asserted by isValidChart().
 */
export interface Chart {
  readonly ticker: string;
  readonly dates: readonly Date[];
  readonly opens: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  readonly splits: readonly Split[];
  /** Null when the provider gave no first-trade date. Never invented. */
  readonly ipoDate: Date | null;
  readonly currentPrice: number;
  readonly prevClose: number;
  readonly currency: string;
  /** Broad-market context, attached by the caller when available. */
  readonly vixContext?: { readonly read: string } | null;
  /**
   * Benchmark (SPY) closes, aligned to THIS chart's dates by the caller and
   * therefore the same length. Supplied by the Stage-0 shared-data layer,
   * which fetches SPY once per run and shares it across every ticker.
   *
   * Absent means relative strength is simply not computed — `rs` returns null.
   * Mirrors the legacy `c.benchmarkCloses` field exactly.
   */
  readonly benchmarkCloses?: readonly number[] | null;
}

/**
 * A chart exactly as the fetch layer produces it (dataLayerV1.gs:285-383,
 * fullStockAnalysisV10_9.gs:5991-6014), before any market context is
 * attached (fetch/marketContext.ts adds benchmarkCloses and vixContext).
 *
 * Differs from Chart in prevClose, on purpose: legacy sets
 * `prevClose = closes[len - 2]`, which is undefined for a one-bar response
 * and is stored that way in the price-history META. Chart's `number` is the
 * analysis-side contract; the two meet in the pipeline (FL-7).
 */
export type FetchedChart = Omit<Chart, 'prevClose' | 'vixContext' | 'benchmarkCloses'> & {
  readonly prevClose: number | undefined;
  /**
   * P0 (2026-10-30): when the price tab was saved (epoch ms), from the META JSON. Present only on a tab whose
   * last bar was the current session when saved (outside legacy-parity mode); fetchYahooChart strips it from
   * the chart it returns. See storage/priceHistory.ts isLastBarPossiblyPartial.
   */
  readonly savedAt?: number;
};

export function barCount(chart: Chart): number {
  return chart.closes.length;
}

export function lastClose(chart: Chart): number | null {
  return chart.closes.length > 0 ? (chart.closes[chart.closes.length - 1] ?? null) : null;
}

/**
 * Verifies the index-alignment invariant.
 *
 * Cheap, and worth running on any chart assembled from an external source.
 * A ragged chart does not throw in the engine -- it silently produces
 * indicator values computed over mismatched bars, which is far worse.
 */
export function isValidChart(chart: Chart): boolean {
  const n = chart.closes.length;
  if (n === 0) return false;
  return (
    chart.dates.length === n &&
    chart.opens.length === n &&
    chart.highs.length === n &&
    chart.lows.length === n &&
    chart.volumes.length === n
  );
}
