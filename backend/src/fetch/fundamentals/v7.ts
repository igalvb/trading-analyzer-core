/**
 * gatherFundamentalsV7 (dataLayerV1.gs:58-86) and fetchPeerBasicMetricsV7
 * (:88-117): the v7 wrapper adds Finnhub's metric series and peer list to
 * the merged fundamentals, and the peer fetcher reads one peer's basic
 * metrics through a 24-hour cache ('V7_PEER_' + symbol).
 *
 * Kept from legacy: the wrapper fetches /stock/metric a SECOND time (the
 * Finnhub provider already fetched the same URL, F-38); a failure in the
 * series parse skips the peers fetch (one try around both); peers are
 * self-excluded case-insensitively and capped at CONFIG_V7.peers.max.
 */

import type { HttpClient } from '../../net/http.ts';
import type { Clock } from '../../core/context.ts';
import type { PropertyStore } from '../../storage/kv.ts';
import type { ProviderKeys } from '../providerKeys.ts';
import { seriesLatest, type FinnhubMetricSeries } from '../finnhubSeries.ts';
import { gatherFundamentals } from './merge.ts';
import { errText, nowOf, FINNHUB_BASE, type FundamentalsDeps, type FundLog } from './providers.ts';
import type { GatherResult, PeerBasicMetrics } from '../../types/fundamentals.ts';

/** CONFIG_V7.peers (fullStockAnalysisV10_9.gs:17). */
export const PEER_CONFIG = { max: 5, cacheHours: 24 } as const;

export const PEER_CACHE_PREFIX = 'V7_PEER_';

/** gatherFundamentalsV7 (dataLayerV1.gs:58-86). */
export interface GatherV7Options {
  /** A4: drop non-US peer symbols (any symbol with a '.', e.g. 000660.KS) BEFORE the cap; FMP/Finnhub refuse them every run. Unset = legacy. */
  readonly usPeersOnly?: boolean;
}

export async function gatherFundamentalsV7(deps: FundamentalsDeps, ticker: string, log?: FundLog, opts: GatherV7Options = {}): Promise<GatherResult> {
  const g = await gatherFundamentals(deps, ticker, log);
  const fund = g.fund;
  if (!fund) return { fund: null, source: g.source };

  let series: FinnhubMetricSeries | null = null;
  let peers: string[] | null = null;
  try {
    if (typeof deps.keys.finnhub === 'string' && deps.keys.finnhub) {
      const T = encodeURIComponent(ticker);
      const mmRes = await deps.http.fetch({ url: FINNHUB_BASE + 'stock/metric?symbol=' + T + '&metric=all&token=' + deps.keys.finnhub, muteHttpExceptions: true });
      if (mmRes.status === 200) {
        const mm = JSON.parse(mmRes.text() || '{}');
        series = mm.series || null;
      }
      const peersRes = await deps.http.fetch({ url: FINNHUB_BASE + 'stock/peers?symbol=' + T + '&token=' + deps.keys.finnhub, muteHttpExceptions: true });
      if (peersRes.status === 200) {
        const arr = JSON.parse(peersRes.text() || '[]');
        if (Array.isArray(arr)) {
          const self = ticker.toUpperCase();
          peers = arr.filter((t) => typeof t === 'string' && t.toUpperCase() !== self && !(opts.usPeersOnly && t.indexOf('.') >= 0)).slice(0, PEER_CONFIG.max);
        }
      }
    }
  } catch (e) {
    if (log) log('  ⚠️ v7 series/peers fetch: ' + errText(e, 60));
  }

  fund._metricSeries = series;
  fund._peersRaw = peers;
  return { fund, source: g.source };
}

export interface PeerMetricsDeps {
  readonly http: HttpClient;
  readonly keys: ProviderKeys;
  readonly store: PropertyStore;
  readonly clock?: Clock;
}

/** fetchPeerBasicMetricsV7 (dataLayerV1.gs:88-117). A failed peer is null and is not cached. */
export async function fetchPeerBasicMetrics(deps: PeerMetricsDeps, sym: string, log?: FundLog): Promise<PeerBasicMetrics | null> {
  const cacheKey = PEER_CACHE_PREFIX + sym;
  try {
    const raw = await deps.store.get(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && cached.t && (nowOf(deps) - cached.t) < PEER_CONFIG.cacheHours * 3600 * 1000) return cached.data;
    }
  } catch {
    /* fall through to a fresh fetch */
  }
  try {
    if (!deps.keys.finnhub) return null;
    const url = FINNHUB_BASE + 'stock/metric?symbol=' + encodeURIComponent(sym) + '&metric=all&token=' + deps.keys.finnhub;
    const res = await deps.http.fetch({ url, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    const d = JSON.parse(res.text() || '{}');
    const m = d.metric || null, series = d.series || null;
    if (!m) return null;
    const num = (v: unknown): number | null => { if (v == null) return null; const n = parseFloat(v as string); return isNaN(n) ? null : n; };
    const pct = (v: unknown): number | null => { const n = num(v); return n == null ? null : n / 100; };
    const data: PeerBasicMetrics = {
      revenueGrowth: pct(m.revenueGrowthTTMYoy != null ? m.revenueGrowthTTMYoy : m.revenueGrowthQuarterlyYoy),
      grossMargins: pct(m.grossMarginTTM),
      netMargin: pct(m.netProfitMarginTTM),
      fcfMargin: seriesLatest(series, 'fcfMargin', null, null),
      evSales: seriesLatest(series, 'evRevenueTTM', null, null),
    };
    try {
      await deps.store.set(cacheKey, JSON.stringify({ t: nowOf(deps), data }));
    } catch {
      /* as legacy */
    }
    return data;
  } catch (e) {
    if (log) log('  Peer metric error (' + sym + '): ' + errText(e, 40));
    return null;
  }
}

/**
 * The peer fetches legacy makes inside computeFundamentalScoreV7
 * (fullStockAnalysisV10_9.gs:1819), lifted out: one fetchPeerBasicMetrics
 * per symbol, in order, duplicates included, with no logger (legacy passes
 * null). Pass analysis/fundamentalScore.ts peerSymbolsForScore(fund).
 */
export async function fetchPeerMetricsFor(deps: PeerMetricsDeps, symbols: readonly string[]): Promise<Map<string, PeerBasicMetrics | null>> {
  const out = new Map<string, PeerBasicMetrics | null>();
  for (const sym of symbols) out.set(sym, await fetchPeerBasicMetrics(deps, sym, null));
  return out;
}
