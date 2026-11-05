/**
 * SYNTHETIC FINRA weeklySummary responses and price charts for FL-5. The
 * request bodies are built here independently of src/fetch/finra/ats.ts (same
 * JSON, written out by hand) so a body mismatch fails the replay. Real
 * recordings are still needed -- see the FL-5 handback.
 */

import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';
import { rng } from './fundamentalsFixtures.ts';

export const FINRA_URL = 'https://api.finra.org/data/group/otcMarket/name/weeklySummary';

const eq = (fieldName: string, fieldValue: string): Record<string, string> => ({ compareType: 'EQUAL', fieldName, fieldValue });

export const probePayload = (date: string, tier: string): string =>
  JSON.stringify({ compareFilters: [eq('weekStartDate', date), eq('tierIdentifier', tier)], limit: 1 });

export const batchPayload = (ticker: string, tier: string, week: string): string =>
  JSON.stringify({ compareFilters: [eq('issueSymbolIdentifier', ticker), eq('weekStartDate', week), eq('tierIdentifier', tier)], limit: 50 });

export function recordedPost(payload: string, status: number, body: string): RecordedExchange {
  return { request: { method: 'POST', url: scrubUrl(FINRA_URL), payload }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}

export type AtsKind = 'agg' | 'firms' | 'mixed' | 'aggZero';

/** weeklySummary rows in FINRA's shape. */
export function atsRows(ticker: string, tier: string, week: string, kind: AtsKind, r: () => number): Array<Record<string, unknown>> {
  const base = { issueSymbolIdentifier: ticker, issueName: ticker + ' Inc', tierIdentifier: tier, weekStartDate: week, lastUpdateDate: week };
  const agg = { ...base, summaryTypeCode: 'ATS_W_SMBL', totalWeeklyShareQuantity: kind === 'aggZero' ? 0 : Math.floor(r() * 4e6), totalWeeklyTradeCount: 1000 };
  const firms = [0, 1, 2].map((k) => ({ ...base, summaryTypeCode: 'ATS_W_SMBL_FIRM', marketParticipantName: 'VENUE ' + k, totalWeeklyShareQuantity: k === 2 && r() < 0.5 ? undefined : Math.floor(r() * 1e6) }));
  if (kind === 'agg' || kind === 'aggZero') return [agg];
  if (kind === 'firms') return firms;
  return [...firms, agg];
}

export interface FakeChart {
  readonly closes: number[];
  readonly highs: number[];
  readonly lows: number[];
  readonly volumes: number[];
  readonly currentPrice: number;
}

/** A random walk with a drift per bar; drift > 0 puts SMA50 above SMA200. */
export function fakeChart(seed: number, bars: number, drift: number): FakeChart {
  const r = rng(seed);
  const closes: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [];
  let p = 50 + r() * 100;
  for (let i = 0; i < bars; i++) {
    p = Math.max(1, p * (1 + drift + (r() - 0.5) * 0.02));
    const c = Math.round(p * 100) / 100;
    closes.push(c);
    highs.push(Math.round(c * (1 + r() * 0.02) * 100) / 100);
    lows.push(Math.round(c * (1 - r() * 0.02) * 100) / 100);
    volumes.push(Math.floor(1e6 + r() * 4e6));
  }
  return { closes, highs, lows, volumes, currentPrice: closes[closes.length - 1] };
}
