/**
 * Yahoo Finance v8 chart endpoint: the raw fetch, its parser, and the
 * closes-only 10-year fetch.
 *
 * Ports dataLayerV1.gs:285-340 (fetchYahooChartRaw_) and :385-403
 * (fetchYahooChartLongRange_) exactly, including their quirks:
 *  - a bar with a null close is dropped entirely;
 *  - open/high/low are backfilled with the close via `||`, so a ZERO is
 *    backfilled too, not only a null; volume falls back to 0 the same way;
 *  - currentPrice is regularMarketPrice || last close (a 0 price falls back);
 *  - prevClose is closes[len - 2], undefined for a one-bar response;
 *  - every failure (non-200, bad JSON, empty result, thrown fetch) is null.
 *
 * Requests are muted (muteHttpExceptions: true), as legacy's were, so a 4xx
 * or 5xx is a status check here, not a throw.
 */

import type { HttpClient } from '../net/http.ts';
import type { FetchedChart, Split } from '../types/chart.ts';

const YAHOO_CHART_ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

/** The two ranges legacy requests with the full OHLCV fetch. */
export type YahooRange = '1mo' | '2y';

export function yahooChartUrl(ticker: string, range: YahooRange): string {
  return YAHOO_CHART_ENDPOINT + encodeURIComponent(ticker) + '?interval=1d&range=' + range + '&includePrePost=false&events=div,splits';
}

export function yahooLongRangeUrl(ticker: string): string {
  return YAHOO_CHART_ENDPOINT + encodeURIComponent(ticker) + '?interval=1d&range=10y&includePrePost=false';
}

interface YahooSplitEvent {
  readonly date: number;
  readonly numerator: number;
  readonly denominator: number;
}

/** The body-parsing half of fetchYahooChartRaw_ (dataLayerV1.gs:297-337). */
export function parseYahooChart(body: string, ticker: string): FetchedChart | null {
  try {
    const json = JSON.parse(body);
    const r = json.chart && json.chart.result && json.chart.result[0];
    if (!r) return null;
    const q = r.indicators.quote[0];
    const n = r.timestamp.length;
    const opens: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    const volumes: number[] = [];
    const dates: Date[] = [];
    for (let i = 0; i < n; i++) {
      if (q.close[i] == null) continue;
      opens.push(q.open[i] || q.close[i]);
      highs.push(q.high[i] || q.close[i]);
      lows.push(q.low[i] || q.close[i]);
      closes.push(q.close[i]);
      volumes.push(q.volume[i] || 0);
      dates.push(new Date(r.timestamp[i] * 1000));
    }
    if (!closes.length) return null;
    const splitEvents: YahooSplitEvent[] = (r.events && r.events.splits) ? Object.values(r.events.splits) : [];
    const splits: Split[] = splitEvents.map((s) => ({ date: new Date(s.date * 1000), numerator: s.numerator, denominator: s.denominator }));
    return {
      opens, highs, lows, closes, volumes, dates, ticker,
      currentPrice: r.meta.regularMarketPrice || closes[closes.length - 1],
      prevClose: closes[closes.length - 2],
      currency: r.meta.currency || 'USD',
      ipoDate: r.meta.firstTradeDate ? new Date(r.meta.firstTradeDate * 1000) : null,
      splits,
    };
  } catch {
    return null;
  }
}

/** fetchYahooChartRaw_ (dataLayerV1.gs:285-340). */
export async function fetchYahooChartRaw(http: HttpClient, ticker: string, range: YahooRange): Promise<FetchedChart | null> {
  try {
    const res = await http.fetch({ url: yahooChartUrl(ticker, range), headers: YAHOO_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    return parseYahooChart(res.text(), ticker);
  } catch {
    return null;
  }
}

/** The body-parsing half of fetchYahooChartLongRange_ (dataLayerV1.gs:391-401). */
export function parseYahooLongRange(body: string): number[] | null {
  try {
    const json = JSON.parse(body);
    const r = json.chart && json.chart.result && json.chart.result[0];
    if (!r) return null;
    const q = r.indicators.quote[0];
    const n = r.timestamp.length;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (q.close[i] != null) closes.push(q.close[i]);
    }
    if (closes.length < 2) return null;
    return closes;
  } catch {
    return null;
  }
}

/**
 * G0b (docs/models/MASTER_PLAN.md section 4): the dated 10-year daily OHLC fetch James's models need (plan 01's live
 * LILO anchor, plan 07's 200-week averages and weekly RSI, plan 09's 3-year rank: 756+ bars, more than the 2-year
 * chart holds). Same body and parser as the 2-year chart (parseYahooChart: dates, opens, highs, lows, closes,
 * volumes, splits), with range=10y. Not cached; a failure is null. The closes-only fetch below stays as legacy had it.
 */
export function yahooLongRangeBarsUrl(ticker: string): string {
  return YAHOO_CHART_ENDPOINT + encodeURIComponent(ticker) + '?interval=1d&range=10y&includePrePost=false&events=div,splits';
}

export async function fetchYahooChartLongRangeBars(http: HttpClient, ticker: string): Promise<FetchedChart | null> {
  try {
    const res = await http.fetch({ url: yahooLongRangeBarsUrl(ticker), headers: YAHOO_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    return parseYahooChart(res.text(), ticker);
  } catch {
    return null;
  }
}

/**
 * James's models, phase 1: the SAME single request as fetchYahooChartLongRange (same URL, headers and closes), whose
 * body also yields the dated 10-year bars for the display-only James pages, so they add no HTTP call. `bars` is null
 * when the body has no usable chart.
 */
export async function fetchYahooLongRangeWithBars(http: HttpClient, ticker: string): Promise<{ closes: number[] | null; bars: FetchedChart | null }> {
  try {
    const res = await http.fetch({ url: yahooLongRangeUrl(ticker), headers: YAHOO_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return { closes: null, bars: null };
    const body = res.text();
    let bars: FetchedChart | null = null;
    try { bars = parseYahooChart(body, ticker); } catch { bars = null; }
    return { closes: parseYahooLongRange(body), bars };
  } catch {
    return { closes: null, bars: null };
  }
}

/** fetchYahooChartLongRange_ (dataLayerV1.gs:385-403): 10y of closes, nothing else. */
export async function fetchYahooChartLongRange(http: HttpClient, ticker: string): Promise<number[] | null> {
  try {
    const res = await http.fetch({ url: yahooLongRangeUrl(ticker), headers: YAHOO_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    return parseYahooLongRange(res.text());
  } catch {
    return null;
  }
}
