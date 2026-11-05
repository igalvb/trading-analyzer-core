/**
 * fetchYahooChart (dataLayerV1.gs:342-383): the cache-first chart fetch.
 *
 *   1. A fresh cached history (last bar today or yesterday, UTC) is returned
 *      as stored -- including its stored currentPrice (F-33).
 *   2. Otherwise, if the cache is at most 25 days old, a '1mo' fetch supplies
 *      the bars strictly newer than the last cached one; they are appended
 *      and the merged series returned. Cached bars are NEVER rewritten, which
 *      is the root of F-31 (splits) and F-32 (a bar cached mid-session).
 *   3. Otherwise (or when step 2 yields nothing new) a full '2y' fetch
 *      replaces the tab; fewer than 60 bars is null and nothing is stored.
 *      A failed fetch is null even when a stale cache exists (F-33).
 *
 * Two departures from legacy, approved by the user on 2026-10-22, each
 * behind a flag that restores legacy exactly (the FL-1 parity tests set both):
 *  - F-30: a cache is fresh only if, on top of legacy's rule, its last bar
 *    is on or after the most recent completed NYSE session
 *    (storage/priceHistory.ts isPriceCacheFreshForSession);
 *  - F-31: an increment that reports a split the cache has not seen is not
 *    merged; the full 2y history is refetched instead (hasUnseenSplit).
 * Everything else -- F-33 -- is still exactly legacy.
 *
 * P0 (approved 2026-10-30; off when `legacyFreshness` is set): F-32 fixed. A fresh cache whose last bar may
 * still be an in-progress session bar (storage/priceHistory.ts isLastBarPossiblyPartial: today's bar while the
 * session is open, or any bar saved before its 16:00 New York close) is refreshed: one '1mo' fetch REPLACES that
 * last bar, appends any newer bars, and supplies currentPrice / prevClose. Every earlier (completed) bar is kept
 * exactly as cached. A failed refresh returns the cache as before. The save time is the `savedAt` key that this
 * function writes into META when the bar it saves last is the current New York day's session.
 * And while the regular session is open (isRegularSessionOpen: weekday, not an NYSE holiday, 09:30-16:00 New
 * York), a fresh cache that ends on an earlier, completed session gets today's bar so far appended from the same
 * '1mo' fetch, with the live currentPrice / prevClose -- /analyze always uses the live price during market hours.
 */

import type { HttpClient } from '../net/http.ts';
import type { Clock } from '../core/context.ts';
import type { FetchedChart } from '../types/chart.ts';
import { fetchYahooChartRaw } from './yahoo.ts';
import {
  isPriceCacheFresh, isPriceCacheFreshForSession, isLastBarPossiblyPartial, isRegularSessionOpen, marketDay, type PriceHistoryStore,
} from '../storage/priceHistory.ts';

const INCREMENTAL_GAP_CEILING_DAYS = 25;
const MIN_FULL_HISTORY_BARS = 60;
/** P0: an in-progress bar saved less than this long ago is reused, not fetched again (one run reads a ticker several times). */
export const PARTIAL_BAR_REUSE_MS = 5 * 60_000;

export interface ChartDeps {
  readonly http: HttpClient;
  readonly store: PriceHistoryStore;
  /** Defaults to the real clock. Legacy read `new Date()` / `Date.now()` directly. */
  readonly clock?: Clock;
  /**
   * Use legacy's freshness rule alone (last bar UTC-dated today or
   * yesterday). Default false: the completed-session rule (F-30). True only
   * in legacy-parity tests.
   */
  readonly legacyFreshness?: boolean;
  /**
   * Merge an increment even when it reports a split the cache has not seen
   * (legacy, F-31). Default false: refetch the full 2y history instead.
   */
  readonly legacySplitMerge?: boolean;
}

/**
 * F-31: a split in the increment, dated after the first cached bar, that the
 * cache's META does not already list. The cached bars before it are then
 * unadjusted, and merging would leave a one-bar discontinuity.
 */
export function hasUnseenSplit(cached: FetchedChart, incremental: FetchedChart): boolean {
  const first = cached.dates[0].getTime();
  const known = cached.splits || [];
  return (incremental.splits || []).some((s) =>
    s.date.getTime() > first &&
    !known.some((k) => k.date.getTime() === s.date.getTime() && k.numerator === s.numerator && k.denominator === s.denominator));
}

/** The chart without its META save time (the callers never see it). */
function withoutSavedAt(c: FetchedChart): FetchedChart {
  if (c.savedAt === undefined) return c;
  const { savedAt: _drop, ...rest } = c;
  return rest;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export async function fetchYahooChart(deps: ChartDeps, ticker: string): Promise<FetchedChart | null> {
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());
  const legacy = !!deps.legacyFreshness;
  const rawCached = await deps.store.read(ticker);
  const cached = rawCached && legacy ? withoutSavedAt(rawCached) : rawCached;
  /** P0: what goes to the store. Stamped with the save time only when its last bar is today's (New York) session. */
  const toSave = (c: FetchedChart): FetchedChart => {
    const plain = withoutSavedAt(c);
    if (legacy || !plain.dates.length) return plain;
    const t = now();
    return utcDay(plain.dates[plain.dates.length - 1]) === marketDay(t) ? { ...plain, savedAt: t } : plain;
  };
  const fresh = legacy ? isPriceCacheFresh : isPriceCacheFreshForSession;
  if (fresh(cached, new Date(now()))) {
    // P0: a bar refreshed moments ago (the same run reading the ticker again: chart page, dark pool...) is reused.
    const savedAt = cached && typeof cached.savedAt === 'number' ? cached.savedAt : null;
    const justSaved = savedAt !== null && now() - savedAt >= 0 && now() - savedAt < PARTIAL_BAR_REUSE_MS;
    if (legacy || justSaved) return withoutSavedAt(cached as FetchedChart);
    const nowDate = new Date(now());
    const c = cached as FetchedChart;
    if (isLastBarPossiblyPartial(c, nowDate)) {
      const refreshed = await refreshPartialLastBar(deps, ticker, c, toSave);
      if (refreshed !== 'full') return refreshed;
    } else if (isRegularSessionOpen(nowDate) && utcDay(c.dates[c.dates.length - 1]) < marketDay(now())) {
      // P0 (gap 1): the session is open and the cache ends on a completed earlier session -- append today's bar
      // so far and take the live price; the cached bars stay exactly as they are.
      const refreshed = await refreshPartialLastBar(deps, ticker, c, toSave, false);
      if (refreshed !== 'full') return refreshed;
    } else {
      return withoutSavedAt(c);
    }
  } else if (cached && cached.dates && cached.dates.length) {
    const lastCachedDate = cached.dates[cached.dates.length - 1];
    const daysSinceLastCache = Math.floor((now() - lastCachedDate.getTime()) / 86400000);
    if (daysSinceLastCache <= INCREMENTAL_GAP_CEILING_DAYS && !legacy && isLastBarPossiblyPartial(cached, new Date(now()))) {
      // P0: a stale cache whose last bar was saved mid-session -- replace that bar too, not only append after it.
      const refreshed = await refreshPartialLastBar(deps, ticker, cached, toSave);
      if (refreshed !== 'full' && refreshed.dates.length > cached.dates.length) return refreshed;
      // nothing newer came back (or a split): fall through to the full 2y refetch, as the legacy path would
    } else if (daysSinceLastCache <= INCREMENTAL_GAP_CEILING_DAYS) {
      const incremental = await fetchYahooChartRaw(deps.http, ticker, '1mo');
      if (incremental && (deps.legacySplitMerge || !hasUnseenSplit(cached, incremental))) {
        const newIdx = incremental.dates.findIndex((d) => d.getTime() > lastCachedDate.getTime());
        if (newIdx !== -1) {
          const newCount = incremental.dates.length - newIdx;
          const merged: FetchedChart = {
            opens: cached.opens.concat(incremental.opens.slice(newIdx)),
            highs: cached.highs.concat(incremental.highs.slice(newIdx)),
            lows: cached.lows.concat(incremental.lows.slice(newIdx)),
            closes: cached.closes.concat(incremental.closes.slice(newIdx)),
            volumes: cached.volumes.concat(incremental.volumes.slice(newIdx)),
            dates: cached.dates.concat(incremental.dates.slice(newIdx)),
            ticker,
            currentPrice: incremental.currentPrice,
            prevClose: incremental.prevClose,
            currency: incremental.currency,
            ipoDate: incremental.ipoDate || cached.ipoDate,
            splits: (incremental.splits && incremental.splits.length) ? incremental.splits : cached.splits,
          };
          await deps.store.append(ticker, toSave(merged), newCount);
          return merged;
        }
      }
    }
  }

  const result = await fetchYahooChartRaw(deps.http, ticker, '2y');
  if (!result || result.closes.length < MIN_FULL_HISTORY_BARS) return null;
  await deps.store.write(ticker, toSave(result));
  return result;
}

/**
 * P0: replace the cached last bar (possibly partial) with the same session's bar from a '1mo' fetch and append
 * any newer bars. Completed bars (all but the last cached one) are never rewritten. 'full' means "do the full 2y
 * refetch instead" (the increment reports a split the cache has not seen, F-31). A failed fetch keeps the cache.
 */
async function refreshPartialLastBar(
  deps: ChartDeps, ticker: string, cached: FetchedChart, toSave: (c: FetchedChart) => FetchedChart, replaceLast = true,
): Promise<FetchedChart | 'full'> {
  const incremental = await fetchYahooChartRaw(deps.http, ticker, '1mo');
  if (!incremental || !incremental.dates.length) return withoutSavedAt(cached);
  if (!deps.legacySplitMerge && hasUnseenSplit(cached, incremental)) return 'full';
  const keep = cached.dates.length - 1;
  const lastDay = utcDay(cached.dates[keep]);
  // replaceLast false (the live-session append): the cached last bar is final and is kept as it is.
  const sameIdx = replaceLast ? incremental.dates.findIndex((d) => utcDay(d) === lastDay) : -1;
  const newerIdx = incremental.dates.findIndex((d) => utcDay(d) > lastDay);
  if (!replaceLast && newerIdx === -1) return withoutSavedAt(cached); // no bar of today yet: the cache, as before
  // After the completed bars: the refreshed last bar (or the cached one when the increment does not carry that
  // session), then every newer session.
  const from = sameIdx !== -1 ? sameIdx : newerIdx;
  const headLen = sameIdx !== -1 ? keep : keep + 1;
  const pick = <T>(cachedArr: readonly T[], incArr: readonly T[]): T[] => {
    const head = cachedArr.slice(0, headLen);
    return from === -1 ? head : head.concat(incArr.slice(from));
  };
  const merged: FetchedChart = {
    opens: pick(cached.opens, incremental.opens),
    highs: pick(cached.highs, incremental.highs),
    lows: pick(cached.lows, incremental.lows),
    closes: pick(cached.closes, incremental.closes),
    volumes: pick(cached.volumes, incremental.volumes),
    dates: pick(cached.dates, incremental.dates),
    ticker,
    currentPrice: incremental.currentPrice,
    prevClose: incremental.prevClose,
    currency: incremental.currency,
    ipoDate: incremental.ipoDate || cached.ipoDate,
    splits: (incremental.splits && incremental.splits.length) ? incremental.splits : cached.splits,
  };
  await deps.store.write(ticker, toSave(merged));
  return merged;
}
