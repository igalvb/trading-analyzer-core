/**
 * SYNTHETIC Cboe delayed-quote chains for FL-6, in Cboe's JSON shape
 * (data.options[] with OCC symbols, open_interest, volume, iv, greeks,
 * bid/ask/last/close; data.current_price). OCC symbols are built here
 * independently of src/fetch/cboe.ts. Real recordings are still needed --
 * see the FL-6a handback.
 */

import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';
import { rng } from './fundamentalsFixtures.ts';

export function recordedGet(url: string, status: number, body: string): RecordedExchange {
  return { request: { method: 'GET', url: scrubUrl(url) }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}

export const cboeUrlOf = (t: string): string => 'https://cdn.cboe.com/api/global/delayed_quotes/options/' + t + '.json';

/** An OCC symbol: root + YYMMDD + C/P + strike x 1000 (8 digits). */
export function occ(root: string, expiryUtcDay: number, cp: 'C' | 'P', strike: number, eightDigitYear = false): string {
  const d = new Date(expiryUtcDay);
  const y = eightDigitYear ? String(d.getUTCFullYear()) : String(d.getUTCFullYear()).slice(2);
  return root + y + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + cp + String(Math.round(strike * 1000)).padStart(8, '0');
}

export interface ChainSpec {
  readonly root: string;
  readonly spot: number;
  readonly nowMs: number;
  readonly days: readonly number[];
  readonly strikeMults: readonly number[];
  readonly maxOi: number;
  readonly closed?: boolean;
  readonly noDelta?: boolean;
  readonly putsOnly?: boolean;
  /** Multiplies every open interest (for run-over-run persistence tests). */
  readonly oiScale?: (i: number) => number;
}

export function chainOptions(seed: number, s: ChainSpec): Array<Record<string, unknown>> {
  const r = rng(seed);
  const today = Math.floor(s.nowMs / 86400000) * 86400000;
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  for (const d of s.days) {
    const exp = today + d * 86400000;
    for (const m of s.strikeMults) {
      const strike = Math.round(s.spot * m * 2) / 2;
      for (const cp of (s.putsOnly ? ['P'] : ['C', 'P']) as Array<'C' | 'P'>) {
        const oiBase = r() < 0.1 ? 0 : Math.floor(r() * s.maxOi * Math.exp(-Math.abs(Math.log(m)) * 2));
        const oi = Math.round(oiBase * (s.oiScale ? s.oiScale(i) : 1));
        const vol = s.closed ? 0 : (r() < 0.3 ? 0 : Math.floor(r() * oi * (r() < 0.1 ? 8 : 0.5)));
        const iv = r() < 0.08 ? 0 : Math.round((0.3 + r() * 0.5 + (d < 30 ? 0.2 : 0)) * 10000) / 10000;
        const moneyness = cp === 'C' ? s.spot - strike : strike - s.spot;
        const deltaAbs = Math.max(0.01, Math.min(0.99, 0.5 + moneyness / (s.spot * 0.8)));
        const delta = cp === 'C' ? deltaAbs : -deltaAbs;
        const bid = Math.max(0, Math.round((Math.max(0, moneyness) + s.spot * 0.05 * Math.sqrt(d / 365)) * 100) / 100);
        const o: Record<string, unknown> = {
          option: occ(s.root, exp, cp, strike), bid, ask: Math.round((bid * 1.05 + 0.05) * 100) / 100, iv, open_interest: oi, volume: vol,
          gamma: Math.round(r() * 1000) / 100000, theta: -Math.round(r() * 100) / 100, vega: 0.1, rho: 0.01,
          last_trade_price: r() < 0.5 ? Math.round(bid * 102) / 100 : 0, close: Math.round(bid * 101) / 100,
        };
        if (!s.noDelta && r() > 0.05) o.delta = Math.round(delta * 10000) / 10000;
        out.push(o);
        i++;
      }
    }
  }
  return out;
}

export function chainJson(seed: number, s: ChainSpec, extra: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({ timestamp: '2026-10-23 15:00:00', data: { symbol: s.root, current_price: s.spot, options: [...chainOptions(seed, s), ...extra] } });
}

export const DAYS_ALL: readonly number[] = [3, 10, 20, 45, 80, 120, 200, 300, 400, 600, 760, 900];
export const MULTS: readonly number[] = [0.3, 0.45, 0.6, 0.75, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.35, 1.5, 1.8, 2.2, 3];
