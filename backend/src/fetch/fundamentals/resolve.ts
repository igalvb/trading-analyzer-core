/**
 * The fundamentals step of runAnalysisV7 (fullStockAnalysisV10_9.gs:955-983):
 * live v7 fundamentals if they carry any data, otherwise the FUND_ cache,
 * otherwise none -- with the same three statuses and log lines.
 *
 * "Carry any data" is legacy's test: at least one named source, or a beta.
 * A live result is saved to the cache every time.
 *
 * F-36: legacy's comment at :961 says the cache does not keep the series or
 * peers. It does whenever the whole record fits PropertiesService's 9 KB
 * value cap; when it does not -- expected whenever Finnhub's series is
 * attached -- legacy's write fails silently and the cache keeps an OLDER
 * record. The port's store has no cap (kv.ts, sanctioned), so it always
 * saves, series included. A cache hit's Date fields come back as ISO
 * strings (JSON round trip) on both.
 *
 * FL-7a-2b additions, none active in legacy mode (every option absent):
 *   stampFetchedAt  the saved record also carries `fetchedAt` (ISO), the
 *                   copy's real age (legacy's `date` is a locale label).
 *   onSavedCopy     told whether a saved copy was used or refused, its save
 *                   time and why -- the caller writes the log line and the
 *                   plain report line (the data-quality box).
 *   fallback        the user's saved-copy rule (approved; default OFF until
 *                   the score-input list is confirmed): reuse the copy only
 *                   if it is at most `maxAgeDays` old AND no earnings report
 *                   came out since it was saved. Absent = legacy: any saved
 *                   copy is used.
 *   seriesStore     F-36 option B (default OFF): series and peers live in
 *                   their own tab and are merged back on a saved-copy run.
 */

import type { StepStateValue } from '../../core/status.ts';
import type { ReasonCode } from '../../reports/messages/catalog.ts';
import { getCachedFundamentals, saveFundamentalsCache, type CachedFundamentals, type OnStoreError, type PropertyStore } from '../../storage/kv.ts';
import type { FundamentalsSeriesStore } from '../../storage/fundamentalsSeriesTab.ts';
import type { GatherResult, MergedFundamentals } from '../../types/fundamentals.ts';

export interface FundamentalsFallbackPolicy {
  /** The setting (FUND_FALLBACK_MAX_AGE_DAYS); the user's value is 30. */
  readonly maxAgeDays: number;
  /** true when an earnings report came out after `savedAtMs`; null = cannot tell. */
  readonly earningsSince: (ticker: string, savedAtMs: number, saved: MergedFundamentals, nowMs: number) => Promise<boolean | null> | boolean | null;
}

export interface SavedCopyVerdict {
  readonly accepted: boolean;
  readonly savedAt: Date | null;
  /** Technical, for the log. */
  readonly why: string;
}

export interface ResolveFundamentalsDeps {
  /** gatherFundamentalsV7, bound to its dependencies. */
  readonly gather: (ticker: string, log: (msg: string) => void) => Promise<GatherResult>;
  readonly store: PropertyStore;
  /** For the cache's date label. Defaults to the real clock. */
  readonly now?: () => Date;
  /** Legacy `toLocaleDateString()`. Pass core/dates.ts localeDateLabel bound to the script zone. */
  readonly dateLabel?: (d: Date) => string;
  readonly log?: (msg: string) => void;
  /** setStatusV7(status, key, state, detail). */
  readonly setStatus?: (key: string, state: StepStateValue, detail: string, reasonCode?: ReasonCode) => void;
  readonly onStoreError?: OnStoreError;
  readonly stampFetchedAt?: boolean;
  readonly onSavedCopy?: (verdict: SavedCopyVerdict) => void;
  readonly fallback?: FundamentalsFallbackPolicy | null;
  readonly seriesStore?: FundamentalsSeriesStore | null;
}

export interface ResolvedFundamentals {
  /** Live: the v7 record. Cache hit: the stored record, Dates as ISO strings. */
  readonly fund: MergedFundamentals | null;
  readonly fundSource: string;
}

/** When the saved copy was made: `fetchedAt` if stamped, else legacy's en-US 'M/D/YYYY' label (noon UTC of that day), else null. */
export function savedAtOf(cached: CachedFundamentals<unknown> & { readonly fetchedAt?: unknown }): Date | null {
  if (typeof cached.fetchedAt === 'string') {
    const d = new Date(cached.fetchedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(cached.date ?? '').trim());
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 12)) : null;
}

/**
 * The default earnings check, from the saved record itself: a report came out
 * since the save when the saved next-earnings date is already past, or the
 * saved history holds a report dated after the save. A record carrying
 * neither field cannot be checked (null); an empty history with no next date
 * (an ETF) has no earnings at all (false).
 */
export function earningsSinceFromSavedCopy(_ticker: string, savedAtMs: number, saved: MergedFundamentals, nowMs: number): boolean | null {
  const s = saved as unknown as Record<string, unknown>;
  const next = s['_nextEarnings'] as { date?: unknown } | null | undefined;
  const hist = s['_earningsHistory'] as Array<{ date?: unknown }> | null | undefined;
  if (next === undefined && hist === undefined) return null;
  const t = (v: unknown): number => (v == null ? NaN : new Date(v as string).getTime());
  if (next && Number.isFinite(t(next.date)) && t(next.date) <= nowMs && t(next.date) > savedAtMs - 86400000) return true;
  if (Array.isArray(hist) && hist.some((h) => Number.isFinite(t(h && h.date)) && t(h.date) > savedAtMs)) return true;
  return false;
}

export async function judgeSavedCopy(
  ticker: string, cached: CachedFundamentals<MergedFundamentals>, policy: FundamentalsFallbackPolicy, nowMs: number,
): Promise<SavedCopyVerdict> {
  const savedAt = savedAtOf(cached);
  if (!savedAt) return { accepted: false, savedAt: null, why: 'the saved copy has no readable save date' };
  const days = Math.floor((nowMs - savedAt.getTime()) / 86400000);
  if (days > policy.maxAgeDays) return { accepted: false, savedAt, why: 'the saved copy is ' + days + ' days old, over the ' + policy.maxAgeDays + '-day limit' };
  const since = await policy.earningsSince(ticker, savedAt.getTime(), cached.data, nowMs);
  if (since === true) return { accepted: false, savedAt, why: 'an earnings report came out after the copy was saved' };
  if (since === null) return { accepted: false, savedAt, why: 'the saved copy could not be checked against the earnings calendar' };
  return { accepted: true, savedAt, why: 'the saved copy is ' + days + ' days old and no earnings report came out since' };
}

export async function resolveFundamentals(ticker: string, deps: ResolveFundamentalsDeps): Promise<ResolvedFundamentals> {
  const log = deps.log ?? ((): void => {});
  const setStatus = deps.setStatus ?? ((): void => {});
  const nowDate = (): Date => (deps.now ? deps.now() : new Date());
  let fund: MergedFundamentals | null = null;
  let fundSource = 'none';
  log('📡 Fundamentals (v7: FMP+AV+Finnhub + series + peers)...');
  const g = await deps.gather(ticker, log);
  if (g.fund && (g.fund._sources.length || g.fund.beta != null)) {
    fund = g.fund;
    fundSource = g.source;
    const at = nowDate();
    let toSave: unknown = fund;
    if (deps.seriesStore) {
      try {
        await deps.seriesStore.save(ticker, fund._metricSeries ?? null, fund._peersRaw ?? null, at);
        toSave = { ...fund, _metricSeries: undefined, _peersRaw: undefined };
      } catch (e) {
        deps.onStoreError?.(e);
      }
    }
    await saveFundamentalsCache(deps.store, ticker, toSave, at, deps.onStoreError, deps.dateLabel, deps.stampFetchedAt ? { fetchedAt: at.toISOString() } : undefined);
    setStatus('fundamentals', 'ok', 'live: ' + (fund._sources.length ? fund._sources.join('+') : 'profile-only'));
    setStatus('series', fund._metricSeries ? 'ok' : 'degraded',
      fund._metricSeries ? '' : 'Finnhub series unavailable — OWN score uses flat levels only (no growth/margin trend, no peer valuation)', fund._metricSeries ? undefined : 'NO_DATA_FOR_TICKER');
    setStatus('peers', (fund._peersRaw && fund._peersRaw.length) ? 'ok' : 'degraded',
      (fund._peersRaw && fund._peersRaw.length) ? fund._peersRaw.length + ' peers' : 'No peers — valuation scored on absolute bands, not vs peers', (fund._peersRaw && fund._peersRaw.length) ? undefined : 'NO_DATA_FOR_TICKER');
    log('✅ Fundamentals: ' + (fund._sources.length ? fund._sources.join('+') : 'profile-only') +
      (fund._metricSeries ? ' + series' : '') + (fund._peersRaw ? ' + ' + fund._peersRaw.length + ' peers' : ''));
  } else {
    let cached = await getCachedFundamentals<MergedFundamentals>(deps.store, ticker, deps.onStoreError);
    if (cached && deps.fallback) {
      const verdict = await judgeSavedCopy(ticker, cached, deps.fallback, nowDate().getTime());
      deps.onSavedCopy?.(verdict);
      if (!verdict.accepted) {
        log('⚠️ Saved fundamentals not used: ' + verdict.why);
        cached = null;
      }
    } else if (cached) {
      deps.onSavedCopy?.({ accepted: true, savedAt: savedAtOf(cached), why: 'legacy rule: any saved copy is used' });
    }
    let merged = false;
    if (cached && deps.seriesStore) {
      try {
        const s = await deps.seriesStore.load(ticker);
        if (s) { cached = { ...cached, data: { ...cached.data, _metricSeries: s.series as never, _peersRaw: s.peers } }; merged = true; }
      } catch (e) {
        deps.onStoreError?.(e);
      }
    }
    if (cached) {
      fund = cached.data;
      fundSource = 'cache (' + cached.date + ')';
      setStatus('fundamentals', 'degraded', 'OWN score from CACHED fundamentals (' + cached.date + ')', 'PROVIDER_NO_RESPONSE');
      if (merged) {
        // F-36 option B: the saved copy carries its series and peers, so the score sees them as on a live run.
        const f = cached.data;
        setStatus('series', f._metricSeries ? 'ok' : 'degraded', f._metricSeries ? 'from the saved copy' : 'Finnhub series unavailable — OWN score uses flat levels only (no growth/margin trend, no peer valuation)', f._metricSeries ? undefined : 'NO_DATA_FOR_TICKER');
        setStatus('peers', (f._peersRaw && f._peersRaw.length) ? 'ok' : 'degraded', (f._peersRaw && f._peersRaw.length) ? f._peersRaw.length + ' peers (saved copy)' : 'No peers — valuation scored on absolute bands, not vs peers', (f._peersRaw && f._peersRaw.length) ? undefined : 'NO_DATA_FOR_TICKER');
        log('⚠️ Using cached fundamentals (' + cached.date + ') with their saved series and peers');
      } else {
        setStatus('series', 'degraded', 'Series unavailable on a cache hit — OWN score uses flat levels only', 'NOT_RUN');
        setStatus('peers', 'degraded', 'Peers unavailable on a cache hit — valuation on absolute bands', 'NOT_RUN');
        log('⚠️ Using cached fundamentals (' + cached.date + ') — series/peers unavailable on a cache hit');
      }
    } else {
      setStatus('fundamentals', 'failed', 'No fundamentals available — OWN score N/A, decision is TECHNICAL-ONLY', 'NO_DATA_FOR_TICKER');
      setStatus('series', 'failed', '', 'NOT_RUN');
      setStatus('peers', 'failed', '', 'NOT_RUN');
      log('⚠️ No fundamentals — technical only');
    }
  }
  return { fund, fundSource };
}
