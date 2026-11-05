/**
 * Append-only permanent history writers.
 *
 * The legacy stores overwrote in place -- find the row matching a key and
 * replace it (write13FCacheV1_ at dataLayerV1.gs:931-950,
 * writeBrokerDataCacheV1_ at :989-1014), and fundamentals lived in Apps
 * Script properties as a single overwritten value per ticker (:1286-1292).
 * All three kept exactly one snapshot and discarded everything before it.
 *
 * Here they become real history: ONE NEW ROW PER FETCH, never overwriting.
 * appendPriceCacheV7_ (fullStockAnalysisV10_9.gs:6061-6084) already worked
 * this way and is the reference pattern.
 *
 * Retention: these grow forever, by decision. Cleanup is manual, via a tool.
 * No automatic or silent deletion -- deleting a user's real historical data
 * is not something this system does on its own.
 */

import type { RunContext } from '../../core/context.ts';
import type { StepResult } from '../../core/result.ts';
import { ok } from '../../core/result.ts';
import type { SheetsClient } from '../client.ts';
import { Tabs, a1 } from '../tabs.ts';
import type { SheetRow, SheetValue } from '../coerce.ts';
import { toDate, toStringSafe } from '../coerce.ts';

export const HistoryHeaders = {
  INSTITUTIONAL: ['CUSIP', 'QuarterTag', 'FetchedAt', 'JSON'] as const,
  BROKER_DATA: ['Ticker', 'FetchedAt', 'ShortInterest', 'DaysToCover', 'SettlementDate', 'InterestCoverageRatio'] as const,
  /** Requirement K (owner 2026-11-04): one row per ticker per day a value changed; storage/fundamentalsHistory.ts. */
  FUNDAMENTALS: [
    'Date', 'Ticker', 'RevenueGrowth', 'EarningsGrowth', 'GrossMargin', 'ProfitMargin', 'ReturnOnEquity',
    'ForwardPE', 'TrailingPE', 'PEG', 'PriceToBook', 'DebtToEquity', 'CurrentRatio',
    'AnalystTarget', 'Analysts', 'RatingScore', 'Rating',
    'ShortInterest', 'DaysToCover', 'ShortPctFloat', 'Holders13F', 'Shares13F', 'Source',
  ] as const,
} as const;

export interface HistorySpec {
  readonly tab: string;
  readonly headers: readonly string[];
  /** Column index (0-based) holding the lookup key. */
  readonly keyIndex: number;
  /** Column index (0-based) holding the FetchedAt timestamp. */
  readonly timestampIndex: number;
}

export const INSTITUTIONAL_HISTORY: HistorySpec = {
  tab: Tabs.INSTITUTIONAL_HISTORY,
  headers: HistoryHeaders.INSTITUTIONAL,
  keyIndex: 0,
  timestampIndex: 2,
};

export const BROKER_DATA_HISTORY: HistorySpec = {
  tab: Tabs.BROKER_DATA_HISTORY,
  headers: HistoryHeaders.BROKER_DATA,
  keyIndex: 0,
  timestampIndex: 1,
};

export const FUNDAMENTALS_HISTORY: HistorySpec = {
  tab: Tabs.FUNDAMENTALS_HISTORY,
  headers: HistoryHeaders.FUNDAMENTALS,
  keyIndex: 1,
  timestampIndex: 0,
};

/**
 * Ensures a history tab exists with its header row.
 *
 * Creating a tab is additive and safe. This never touches an existing tab's
 * contents -- if the tab is already there, nothing happens at all.
 */
export async function ensureHistoryTab(
  ctx: RunContext,
  sheets: SheetsClient,
  spec: HistorySpec,
  existingTabs: readonly string[],
): Promise<StepResult<boolean>> {
  if (existingTabs.includes(spec.tab)) return ok(false);

  ctx.log.info(`Creating history tab "${spec.tab}"`);
  const created = await sheets.formatBatch(ctx, [{ addSheet: { properties: { title: spec.tab } } }]);
  if (!created.ok) return created;

  const written = await sheets.batchUpdate(ctx, [
    { range: a1(spec.tab, `A1:${colLetter(spec.headers.length)}1`), values: [[...spec.headers]] },
  ]);
  if (!written.ok) return written;

  return ok(true);
}

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/**
 * Appends one or more history rows. Never overwrites.
 *
 * Batched per tab per run rather than one call per row -- the whole point of
 * the batching discipline.
 */
export async function appendHistory(
  ctx: RunContext,
  sheets: SheetsClient,
  spec: HistorySpec,
  rows: readonly SheetRow[],
): Promise<StepResult<number>> {
  if (rows.length === 0) return ok(0);
  const res = await sheets.append(ctx, a1(spec.tab, 'A:A'), rows);
  if (!res.ok) return res;
  ctx.log.debug(`appended ${res.value} history row(s) to "${spec.tab}"`);
  return ok(res.value);
}

/**
 * Picks the most recent row per key from an append-only history.
 *
 * This is the semantic change that makes the readers different from their
 * legacy counterparts, which found the FIRST matching row (dataLayerV1.gs:915,
 * :952). With history present, the first match is the OLDEST record -- so a
 * literal port would silently read stale data forever.
 */
export function latestByKey(rows: SheetRow[], spec: HistorySpec, hasHeader = true): Map<string, SheetRow> {
  const out = new Map<string, SheetRow>();
  const times = new Map<string, number>();

  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const key = toStringSafe(row[spec.keyIndex] as SheetValue).toUpperCase();
    if (key === '') continue;

    const ts = toDate(row[spec.timestampIndex] as SheetValue);
    const t = ts ? ts.getTime() : Number.NEGATIVE_INFINITY;

    const prev = times.get(key);
    if (prev === undefined || t >= prev) {
      times.set(key, t);
      out.set(key, row);
    }
  }
  return out;
}

/**
 * Whether a stored record is too old to use.
 *
 * Mirrors the legacy convention (dataLayerV1.gs:964): stale is treated as
 * UNAVAILABLE, never shown as silently outdated. Returning null here makes
 * the caller fetch fresh data, which is the correct behaviour.
 */
export function isFresh(row: SheetRow | undefined, spec: HistorySpec, maxAgeDays: number, now = Date.now()): boolean {
  if (!row) return false;
  const ts = toDate(row[spec.timestampIndex] as SheetValue);
  if (!ts) return false;
  return (now - ts.getTime()) / 86_400_000 <= maxAgeDays;
}
