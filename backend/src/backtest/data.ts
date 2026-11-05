/**
 * Backlog 9 (portfolio backtest): the point-in-time data layer.
 *
 * Price only (owner decision 4a): for a simulated day `t` the engine sees exactly the daily bars dated on or
 * before `t`, served as a Yahoo v8 chart body through a fake HTTP transport. Everything else the engine asks
 * for (fundamentals, 13F, options, SEC, FINRA, the AI review; macro too unless an `extra` responder serves it,
 * backlog 37) gets a 404, which the engine already
 * handles as "no data" (graceful degradation). No model or score code is touched.
 *
 * The price files are `legacy/historical_data/<TICKER>.json` (split-adjusted daily bars, no dividends).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../net/http.ts';
import { parseYahooChart } from '../fetch/yahoo.ts';
import type { Chart } from '../types/chart.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRICE_DIR = path.join(here, '..', '..', 'legacy', 'historical_data');

/** The engine's own full-history request: `range=2y` returns about this many daily bars. */
export const TWO_YEAR_BARS = 504;
/** A bar's timestamp inside a Yahoo body (the same stamp the test fixtures use). */
export const BAR_TIME_UTC = 'T13:30:00Z';

export interface PriceSeries {
  readonly ticker: string;
  /** 'YYYY-MM-DD', ascending. */
  readonly dates: readonly string[];
  readonly opens: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  /** Unix seconds. */
  readonly splits: ReadonlyArray<{ date: number; numerator: number; denominator: number }>;
}

/** The file name for a symbol: '^VIX' is stored as '_VIX'. */
export function priceFileName(symbol: string): string {
  return symbol.replace(/^\^/, '_') + '.json';
}

export function seriesFromRaw(symbol: string, raw: any): PriceSeries {
  const closes: number[] = raw.closes;
  return {
    ticker: symbol,
    dates: raw.dates,
    opens: raw.opens ?? closes,
    highs: raw.highs ?? closes,
    lows: raw.lows ?? closes,
    closes,
    volumes: raw.volumes ?? closes.map(() => 0),
    splits: raw.splits ?? [],
  };
}

export function loadSeries(symbol: string, dir: string = PRICE_DIR): PriceSeries {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, priceFileName(symbol)), 'utf8'));
  return seriesFromRaw(symbol, raw);
}

/** Index of the last bar dated on or before `day` ('YYYY-MM-DD'); -1 when none. Binary search. */
export function lastIndexOnOrBefore(s: PriceSeries, day: string): number {
  let lo = 0, hi = s.dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((s.dates[mid] as string) <= day) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * G0 / T7 (docs/models/MASTER_PLAN.md): a crypto pair ('BTC-USD', 'ETH-USD', 'SOL-USD') trades around the clock and
 * its daily bar is dated in UTC (the research download and the nightly date it in the exchange zone, UTC).
 */
export function isCryptoTicker(symbol: string): boolean {
  return /^[A-Z0-9]+-USD$/i.test(symbol);
}

/** The time zone a ticker's daily bars are dated in: UTC for crypto, the market's zone for everything else. */
export function barTimeZone(symbol: string, marketZone: string): string {
  return isCryptoTicker(symbol) ? 'UTC' : marketZone;
}

/** Index of the last bar dated strictly before `day`; -1 when none. */
export function lastIndexBefore(s: PriceSeries, day: string): number {
  const i = lastIndexOnOrBefore(s, day);
  return i >= 0 && s.dates[i] === day ? i - 1 : i;
}

/**
 * The bar a decision at the US close of `day` may use (BTC bar timing, every James plan): Yahoo's crypto bar dated D
 * closes at 00:00 UTC on D+1 (7-8 pm New York), 3-4 hours AFTER the US close, so a crypto series gives the bar of
 * D-1 (the last bar dated before `day`); any other series gives the bar of `day` itself (or the last one before it).
 */
export function decisionBarIndex(s: PriceSeries, day: string): number {
  return isCryptoTicker(s.ticker) ? lastIndexBefore(s, day) : lastIndexOnOrBefore(s, day);
}

/** Index of the bar dated exactly `day`; -1 when the ticker did not trade that day. */
export function indexOf(s: PriceSeries, day: string): number {
  const i = lastIndexOnOrBefore(s, day);
  return i >= 0 && s.dates[i] === day ? i : -1;
}

/**
 * A Yahoo v8 chart body holding bars [from, to] (both inclusive). The splits listed are only those on or
 * before the last bar served, so nothing after `t` leaks through the metadata either.
 */
export function yahooChartBody(s: PriceSeries, from: number, to: number): string {
  const idx: number[] = [];
  for (let i = Math.max(0, from); i <= to; i++) idx.push(i);
  const timestamp = idx.map((i) => Date.parse(s.dates[i] + BAR_TIME_UTC) / 1000);
  const lastTs = timestamp[timestamp.length - 1] ?? 0;
  const splits: Record<string, unknown> = {};
  for (const sp of s.splits) {
    if (sp.date <= lastTs + 86400) splits[String(sp.date)] = { date: sp.date, numerator: sp.numerator, denominator: sp.denominator, splitRatio: sp.numerator + ':' + sp.denominator };
  }
  const close = idx.map((i) => s.closes[i]);
  const meta = {
    currency: 'USD', symbol: s.ticker,
    regularMarketPrice: close[close.length - 1] ?? null,
    firstTradeDate: s.dates.length ? Date.parse(s.dates[0] + BAR_TIME_UTC) / 1000 : null,
  };
  return JSON.stringify({
    chart: {
      result: [{
        meta, timestamp, events: Object.keys(splits).length ? { splits } : undefined,
        indicators: { quote: [{ open: idx.map((i) => s.opens[i]), high: idx.map((i) => s.highs[i]), low: idx.map((i) => s.lows[i]), close, volume: idx.map((i) => s.volumes[i]) }] },
      }],
      error: null,
    },
  });
}

/** Backlog 37: a body for a non-chart request as of a day, or null (404). */
export type ExtraResponder = (url: string, day: string) => string | null;

const CHART_2Y = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/;

/**
 * The fake network for one simulated day: the engine's `range=2y` chart request for a known symbol is answered
 * with the last TWO_YEAR_BARS bars dated on or before `day`; every other request is a 404.
 */
export class PointInTimeTransport implements HttpTransport {
  readonly day: string;
  private readonly series: ReadonlyMap<string, PriceSeries>;
  private readonly bodies = new Map<string, string | null>();
  /**
   * Backlog 37: answers the other requests as of `day` (macroData.ts `macroResponder`: Nasdaq ETF history, FRED CSVs);
   * null for a request it does not serve. Absent: every other request is a 404 (v1).
   */
  private readonly extra: ExtraResponder | null;
  /**
   * How many bars a chart answer holds (LONG_HISTORY_PLAN A/B): TWO_YEAR_BARS (default, what the live '2y' cache holds)
   * or Infinity (every bar on or before the day: the long-history store merged in front of the cache).
   */
  private readonly bars: number;
  requests = 0;
  served = 0;
  constructor(series: ReadonlyMap<string, PriceSeries>, day: string, extra: ExtraResponder | null = null, bars: number = TWO_YEAR_BARS) { this.series = series; this.day = day; this.extra = extra; this.bars = bars; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests++;
    const m = CHART_2Y.exec(req.url);
    const sym = m ? decodeURIComponent(m[1] as string) : null;
    const body = sym ? this.bodyFor(sym) : this.extra ? this.extraBody(req.url) : null;
    if (body) { this.served++; return new HttpResponse(200, new TextEncoder().encode(body)); }
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
  private extraBody(url: string): string | null {
    const key = 'extra|' + url;
    if (!this.bodies.has(key)) this.bodies.set(key, (this.extra as ExtraResponder)(url, this.day));
    return this.bodies.get(key) ?? null;
  }
  bodyFor(sym: string): string | null {
    if (this.bodies.has(sym)) return this.bodies.get(sym) ?? null;
    const s = this.series.get(sym);
    let body: string | null = null;
    if (s) {
      const to = lastIndexOnOrBefore(s, this.day);
      if (to >= 0) body = yahooChartBody(s, to - this.bars + 1, to);
    }
    this.bodies.set(sym, body);
    return body;
  }
}

/**
 * The plain chart (no market context) the nightly Exit step reads, built from bars [from, to] through the same
 * Yahoo parser the live fetch uses.
 */
export function chartFromBars(s: PriceSeries, from: number, to: number): Chart | null {
  const c = parseYahooChart(yahooChartBody(s, from, to), s.ticker);
  return c as unknown as Chart | null;
}
