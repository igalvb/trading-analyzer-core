/**
 * Cboe delayed option quotes -- keyless, the whole chain (every expiry) in
 * one request. Ported exactly:
 *   dataLayerV1.gs _cboeRawChainCacheV1_ :1631, fetchCboeRawV1_ :1633-1660,
 *     fetchCboeChain :1662-1685, fetchChain :1687-1691,
 *     myOpt_buildUrl :1953-1955, myOpt_parseOcc :1957-1979, myOpt_fetchCurrentPrice :1981-2037
 *   futuresStockAnalysisV3_3_11.gs buildUrl :393-395, parseOcc :400-409
 *
 * Deliberate differences, disclosed:
 *  - _cboeRawChainCacheV1_ (an execution-scoped global) is a memo owned by
 *    the run (`CboeRawMemo`), same dedupe: one fetch per ticker per run, a
 *    failure cached too.
 *  - fetchCboeRawV1_'s hasTimeBudgetV7_ skip is not ported: the 6-minute
 *    budget is replaced by per-request and per-step timeouts (standing rule),
 *    so the fetch branch is always taken.
 *  - myOpt_fetchCurrentPrice's `deadline: 55` was never a real UrlFetchApp
 *    option (legacy's own v3.3.3 note); the HTTP client's timeout applies.
 */

import type { HttpClient } from '../net/http.ts';

export const CBOE_OPTIONS_URL_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';

/** buildUrl (futures :393-395) and myOpt_buildUrl (dataLayer :1953-1955) -- the same URL. */
export function cboeUrl(ticker: string): string {
  return CBOE_OPTIONS_URL_BASE + ticker + '.json';
}

export interface OccParts {
  readonly strike: number;
  readonly side: 'call' | 'put';
  /** The expiry date at 00:00 UTC, in Unix seconds. */
  readonly expUnix: number;
}

/** parseOcc (futures :400-409): an OCC symbol read from the right (root length varies). */
export function parseOcc(sym: string): OccParts {
  const strike = parseInt(sym.slice(-8), 10) / 1000;
  const cp = sym.slice(-9, -8);
  const ymd = sym.slice(-15, -9);
  const yy = 2000 + parseInt(ymd.slice(0, 2), 10);
  const mm = parseInt(ymd.slice(2, 4), 10);
  const dd = parseInt(ymd.slice(4, 6), 10);
  const expUnix = Math.floor(Date.UTC(yy, mm - 1, dd) / 1000);
  return { strike, side: cp === 'C' ? 'call' : 'put', expUnix };
}

/** One entry of Cboe's data.options (only the fields legacy reads are typed). */
export interface CboeOption {
  readonly option?: string;
  readonly open_interest?: number;
  readonly volume?: number;
  readonly iv?: number;
  readonly delta?: number | null;
  readonly theta?: number;
  readonly gamma?: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly last_trade_price?: number;
  readonly close?: number;
  readonly [field: string]: unknown;
}

export interface CboeChainJson {
  readonly data?: { readonly options?: CboeOption[]; readonly current_price?: number | null; readonly [field: string]: unknown };
  readonly [field: string]: unknown;
}

/** _cboeRawChainCacheV1_: ticker (upper case) -> the raw JSON, or null; one per run. */
export type CboeRawMemo = Map<string, CboeChainJson | null>;

export type CboeLog = (message: string) => void;

/** Options sentiment P0: the size and parse time of each chain fetched (ticker upper case). */
export type CboeFetchStats = Map<string, { readonly bytes: number; readonly parseMs: number }>;

export interface CboeDeps {
  readonly http: HttpClient;
  readonly memo: CboeRawMemo;
  readonly log?: CboeLog;
  /** Options sentiment P0 (optional): filled with each fetched chain's JSON size and parse time. */
  readonly stats?: CboeFetchStats;
}

const errMessage = (e: unknown): unknown => (e as { message?: unknown }).message;

/**
 * fetchCboeRawV1_ (dataLayer :1633-1660): the ticker's chain, then the
 * index form ('_SPX' etc.) if that fails; null if both fail. Memoised per run.
 */
export async function fetchCboeRaw(deps: CboeDeps, ticker: string, log: CboeLog | null = null): Promise<CboeChainJson | null> {
  const key = String(ticker).toUpperCase();
  if (deps.memo.has(key)) return deps.memo.get(key) as CboeChainJson | null;
  const urls = [cboeUrl(ticker), cboeUrl('_' + ticker)];
  let json: CboeChainJson | null = null;
  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = await deps.http.fetch({ url: urls[u], muteHttpExceptions: true });
      const code = resp.status;
      if (code === 200) {
        if (!deps.stats) { json = JSON.parse(resp.text()); break; }
        const text = resp.text(), t0 = performance.now();
        json = JSON.parse(text);
        deps.stats.set(key, { bytes: text.length, parseMs: performance.now() - t0 });
        break;
      }
      if (log) log('   CBOE HTTP ' + code + ' for ' + urls[u]);
    } catch (e) {
      if (log) log('   CBOE error: ' + errMessage(e));
    }
  }
  deps.memo.set(key, json);
  return json;
}

/** The columnar chain the scorer reads (fetchCboeChain's shape). */
export interface ChainColumns {
  readonly s?: 'ok';
  readonly underlying?: number | null;
  readonly strike: readonly number[];
  readonly side?: readonly string[];
  readonly openInterest?: readonly number[];
  readonly volume?: readonly number[];
  readonly iv?: readonly number[];
  readonly expiration?: readonly number[];
  readonly [alternateKey: string]: unknown;
}

/** fetchCboeChain (dataLayer :1662-1685): the raw chain as parallel columns. */
export async function fetchCboeChain(deps: CboeDeps, ticker: string, log: CboeLog | null = null): Promise<ChainColumns | null> {
  return chainColumnsOf(await fetchCboeRaw(deps, ticker, log));
}

/** A raw Cboe chain as the scorer's parallel columns (fetchCboeChain without the fetch); null without options. */
export function chainColumnsOf(json: CboeChainJson | null | undefined): ChainColumns | null {
  if (!json || !json.data || !json.data.options) return null;
  const opts = json.data.options;
  const strike: number[] = [], side: string[] = [], openInterest: number[] = [], volume: number[] = [], iv: number[] = [], expiration: number[] = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o.option) continue;
    const p = parseOcc(o.option);
    strike.push(p.strike);
    side.push(p.side);
    expiration.push(p.expUnix);
    openInterest.push(o.open_interest || 0);
    volume.push(o.volume || 0);
    iv.push(o.iv || 0);
  }
  return { s: 'ok', underlying: json.data.current_price || null, strike, side, openInterest, volume, iv, expiration };
}

/** fetchChain (dataLayer :1687-1691). `days` is unused, as in legacy (the whole chain comes back). */
export async function fetchChain(deps: CboeDeps, days: number, ticker: string, log: CboeLog | null = null): Promise<ChainColumns | null> {
  void days;
  const chain = await fetchCboeChain(deps, ticker, log);
  if (!chain || !chain.strike || chain.strike.length === 0) return null;
  return chain;
}

export interface MyOptOcc {
  readonly strike: number;
  readonly side: 'call' | 'put';
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** myOpt_parseOcc (dataLayer :1957-1979): root + YYMMDD or YYYYMMDD + C/P + strike x 1000; null if it does not match. */
export function myOptParseOcc(sym: unknown): MyOptOcc | null {
  if (!sym || typeof sym !== 'string') return null;
  const match = sym.match(/^([A-Z1-9]+?)(\d{6}|\d{8})([CP])(\d{8})$/i);
  if (!match) return null;
  const dateStr = match[2];
  const cp = match[3].toUpperCase();
  const strikeRaw = parseInt(match[4], 10) / 1000;
  let yy: number, mm: number, dd: number;
  if (dateStr.length === 6) {
    yy = 2000 + parseInt(dateStr.slice(0, 2), 10);
    mm = parseInt(dateStr.slice(2, 4), 10);
    dd = parseInt(dateStr.slice(4, 6), 10);
  } else {
    yy = parseInt(dateStr.slice(0, 4), 10);
    mm = parseInt(dateStr.slice(4, 6), 10);
    dd = parseInt(dateStr.slice(6, 8), 10);
  }
  return { strike: strikeRaw, side: cp === 'C' ? 'call' : 'put', year: yy, month: mm, day: dd };
}

export const MYOPT_FETCH_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

export type MyOptPrice = { readonly found: true; readonly mid: number | null } | { readonly found: false; readonly reason: string };

/**
 * myOpt_fetchCurrentPrice (dataLayer :1981-2037): one held contract's
 * current mid (bid/ask midpoint, else last trade, else close). Every URL
 * tried is written to the log (Logger.log in legacy).
 */
export async function myOptFetchCurrentPrice(
  deps: { readonly http: HttpClient; readonly log?: CboeLog }, ticker: string, strike: number,
  parsedDate: { readonly year: number; readonly month: number; readonly day: number }, side: string,
): Promise<MyOptPrice> {
  const urls = [cboeUrl(ticker), cboeUrl('_' + ticker)];
  let json: CboeChainJson | null = null;
  const debug: string[] = [];
  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = await deps.http.fetch({ url: urls[u], method: 'GET', headers: MYOPT_FETCH_HEADERS, muteHttpExceptions: true });
      const code = resp.status;
      const bodySnippet = resp.text().slice(0, 200);
      debug.push(urls[u] + ' -> HTTP ' + code + ' | ' + bodySnippet);
      if (code === 200) {
        json = JSON.parse(resp.text());
        if (json && json.data && json.data.options && json.data.options.length > 0) break;
      }
    } catch (e) {
      debug.push(urls[u] + ' -> EXCEPTION: ' + e);
    }
  }
  if (deps.log) deps.log('🔎 ' + ticker + ' fetch trace:\n' + debug.join('\n'));
  if (!json || !json.data || !json.data.options) return { found: false, reason: 'no chain data returned for ' + ticker };
  const opts = json.data.options;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o || !o.option) continue;
    const p = myOptParseOcc(o.option);
    if (!p) continue;
    if (Math.abs(p.strike - strike) > 0.001) continue;
    if (p.side !== side) continue;
    if (p.year !== parsedDate.year || p.month !== parsedDate.month || p.day !== parsedDate.day) continue;
    const bid = Number(o.bid) || 0;
    const ask = Number(o.ask) || 0;
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (Number(o.last_trade_price) || Number(o.close) || null);
    return { found: true, mid };
  }
  const targetReadable = parsedDate.year + '-' + String(parsedDate.month).padStart(2, '0') + '-' + String(parsedDate.day).padStart(2, '0');
  return { found: false, reason: 'no contract for $' + strike + ' ' + side.toUpperCase() + ' ' + targetReadable };
}
