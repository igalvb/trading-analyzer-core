/**
 * The ledger's crypto prices (docs/LEDGER.md "Crypto prices"): replaces the sheet's time-triggered scripts that wrote
 * the plain-text USD price of https://cryptoprices.cc/<SYM>/ into price cells. Used by the Nightly's ledger part
 * (ledger/night.ts) only when profile `ledger.cryptoPrices` is 'on'.
 *
 *   fetchCryptoPrices   symbol -> USD price; each symbol: one request with a timeout, one retry; the body must be a
 *                       plain positive finite number. Never throws: a symbol it cannot price is absent from the map,
 *                       and ONE warning line names all of them.
 *   cryptoPriceSymbol   the API symbol of a holding: its `priceSymbol` (the migration fills it from the sheet's
 *                       script cells), else the ticker without trailing dots.
 */

import type { LedgerStock } from './schema.ts';
import { orElse } from '../core/guard.ts';

export const CRYPTO_PRICES_URL = 'https://cryptoprices.cc/';
export const CRYPTO_PRICES_TIMEOUT_MS = 10_000;

export interface CryptoFetchResponse {
  readonly status: number;
  readonly text: string;
}

export interface CryptoPricesDeps {
  /** One GET; may throw (network error). `timeoutMs` is a hint: the call is also cut off here at that time. */
  readonly fetch: (url: string, timeoutMs: number) => Promise<CryptoFetchResponse>;
  readonly log: { readonly warn: (m: string) => void };
  readonly timeoutMs?: number;
}

const NUMBER = /^\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** A body that is a plain positive finite number (surrounding whitespace allowed); null otherwise. */
export function parseCryptoPrice(body: string): number | null {
  const t = body.trim();
  if (!NUMBER.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cryptoPriceSymbol(s: Pick<LedgerStock, 'ticker' | 'priceSymbol'>): string {
  const p = s.priceSymbol?.trim();
  return p ? p : s.ticker.replace(/\.+$/, '');
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out after ' + ms + ' ms')), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
});

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One request; a failure (status, body, network, timeout) is a reason, never a throw. */
function priceOnce(symbol: string, d: CryptoPricesDeps, ms: number): Promise<{ price: number | null; why: string }> {
  return withTimeout(Promise.resolve().then(() => d.fetch(CRYPTO_PRICES_URL + encodeURIComponent(symbol) + '/', ms)), ms).then(
    (r) => {
      if (r.status < 200 || r.status >= 300) return { price: null, why: 'HTTP ' + r.status };
      const p = parseCryptoPrice(String(r.text));
      return p == null ? { price: null, why: 'not a price: "' + String(r.text).trim().slice(0, 30) + '"' } : { price: p, why: '' };
    },
    (e: unknown) => ({ price: null, why: messageOf(e) }),
  );
}

export async function fetchCryptoPrices(symbols: readonly string[], d: CryptoPricesDeps): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const failed: string[] = [];
  const ms = d.timeoutMs ?? CRYPTO_PRICES_TIMEOUT_MS;
  const unique = [...new Set(symbols.map((s) => String(s).trim()).filter((s) => s !== ''))];
  await Promise.all(unique.map(async (sym) => {
    let r = await priceOnce(sym, d, ms);
    if (r.price == null) r = await priceOnce(sym, d, ms);
    if (r.price != null) out.set(sym, r.price); else failed.push(sym + ' (' + r.why + ')');
  }));
  // A logger that throws must not fail the caller (null logger: the fallback, no second line).
  if (failed.length) orElse(null, 'crypto prices warning', () => d.log.warn('crypto prices: no price from cryptoprices.cc for ' + failed.sort().join(', ') + '; their manual price is kept'), undefined);
  return out;
}
