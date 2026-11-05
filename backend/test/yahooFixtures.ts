/**
 * Synthetic Yahoo v8 chart responses built from the real price fixtures in
 * legacy/historical_data, for replay through ExchangeBook.
 *
 * SYNTHETIC: the JSON shape follows the fields legacy reads
 * (chart.result[0].meta / timestamp / events.splits / indicators.quote[0]);
 * it is not a recorded Yahoo response. Bars are stamped 13:30 UTC. Real
 * recordings are still needed to confirm the shape -- see the FL-1 handback.
 */

import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';
import type { RawFixture } from './fixtures.ts';

export const BAR_TIME_UTC = 'T13:30:00Z';

export interface QuoteArrays {
  open: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  close: Array<number | null>;
  volume: Array<number | null>;
}

export interface YahooJsonOptions {
  /** First fixture bar index (inclusive). Default 0. */
  readonly from?: number;
  /** Last fixture bar index (exclusive). Default: all bars. */
  readonly to?: number;
  /** undefined: the last close; null: field present but null. */
  readonly regularMarketPrice?: number | null;
  readonly currency?: string | null;
  readonly firstTradeDate?: number | null;
  /** Include the fixture's splits up to the last bar. Default true. */
  readonly withSplits?: boolean;
  /** Multiplies prices (and divides volume) at fixture index i -- e.g. to undo a split adjustment. */
  readonly scale?: (i: number) => number;
  /** Edits the quote arrays in place (indices relative to `from`). */
  readonly mutate?: (q: QuoteArrays) => void;
  /** Replaces closes by ABSOLUTE fixture index. */
  readonly overrideClose?: Readonly<Record<number, number>>;
}

export function yahooJson(raw: RawFixture, o: YahooJsonOptions = {}): string {
  const from = o.from ?? 0;
  const to = o.to ?? raw.closes.length;
  const idx = Array.from({ length: to - from }, (_, k) => from + k);
  const s = o.scale ?? ((): number => 1);
  const pick = (arr: ReadonlyArray<number | null> | undefined, scaleIt: boolean): Array<number | null> =>
    idx.map((i) => {
      const v = (arr ?? raw.closes)[i];
      return v == null ? null : scaleIt ? v * s(i) : v;
    });
  const close = pick(raw.closes, true);
  for (const [k, v] of Object.entries(o.overrideClose ?? {})) close[Number(k) - from] = v;
  const volumes = raw.volumes;
  const q: QuoteArrays = {
    open: pick(raw.opens, true),
    high: pick(raw.highs, true),
    low: pick(raw.lows, true),
    close,
    volume: volumes ? idx.map((i) => volumes[i] / s(i)) : idx.map(() => null),
  };
  o.mutate?.(q);
  const timestamp = idx.map((i) => Date.parse(raw.dates[i] + BAR_TIME_UTC) / 1000);
  const lastTs = timestamp[timestamp.length - 1];
  const splits: Record<string, unknown> = {};
  if (o.withSplits !== false) {
    for (const sp of raw.splits ?? []) {
      if (sp.date <= lastTs + 86400) {
        splits[String(sp.date)] = { date: sp.date, numerator: sp.numerator, denominator: sp.denominator, splitRatio: sp.numerator + ':' + sp.denominator };
      }
    }
  }
  const lastClose = [...close].reverse().find((v) => v != null) ?? null;
  const meta: Record<string, unknown> = {
    currency: o.currency === undefined ? 'USD' : o.currency,
    symbol: raw.ticker,
    regularMarketPrice: o.regularMarketPrice === undefined ? lastClose : o.regularMarketPrice,
    firstTradeDate: o.firstTradeDate === undefined ? Date.parse(raw.dates[0] + BAR_TIME_UTC) / 1000 : o.firstTradeDate,
  };
  return JSON.stringify({
    chart: {
      result: [{ meta, timestamp, events: Object.keys(splits).length ? { splits } : undefined, indicators: { quote: [q] } }],
      error: null,
    },
  });
}

/** One recorded GET exchange, URL scrubbed as the recorder would store it. */
export function recorded(url: string, body: string, status = 200): RecordedExchange {
  return { request: { method: 'GET', url: scrubUrl(url) }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}
