/**
 * Watchlist reader -- the sole source of truth for Buy-side candidates.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE FROM THE LEGACY VERSION: getWatchlistTickersV7
 * (fullStockAnalysisV10_9.gs:405-417) falls back to a hardcoded
 * CONFIG_V7.dailyTickers list whenever the sheet is missing or empty (:407,
 * :416). That silent in-memory fallback is removed here.
 *
 * Reason: it is the same failure mode already live in the legacy project,
 * where the Full Ticker Analysis dropdown hardcodes 12 tickers (:5893-5896)
 * while CONFIG_V7.dailyTickers holds 21 (:26) -- two lists that quietly
 * diverged with no symptom. On the Buy side that class of bug means silently
 * missed opportunities and nothing to notice.
 *
 * New behaviour: a one-time seed is WRITTEN INTO THE SHEET and then read
 * back, so what runs always equals what the user can see and edit.
 */

import type { RunContext } from '../../core/context.ts';
import type { StepResult } from '../../core/result.ts';
import { ok } from '../../core/result.ts';
import type { SheetsClient } from '../client.ts';
import { Tabs, a1 } from '../tabs.ts';
import { toUpperTicker } from '../coerce.ts';
import type { SheetRow } from '../coerce.ts';
import { activeProfile } from '../../profile/active.ts';

/** Used ONLY to seed a brand-new sheet, never as an ongoing source of truth. Profile `lists.watchlistSeed` (GENERIC_PLAN P2). */
export const WATCHLIST_SEED: readonly string[] = activeProfile().lists.watchlistSeed;

export const WATCHLIST_RANGE = a1(Tabs.WATCHLIST, 'A:A');

/**
 * Extracts tickers from raw rows. Pure, so it is directly testable.
 * Skips the header row, uppercases, trims, and DEDUPES -- a repeated ticker
 * would otherwise be analysed twice for nothing (legacy :412-414).
 */
export function parseWatchlistRows(rows: SheetRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const t = toUpperTicker(rows[r]?.[0] ?? null);
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface WatchlistResult {
  readonly tickers: string[];
  /** True when this run created and seeded the sheet. */
  readonly seeded: boolean;
}

export async function readWatchlist(ctx: RunContext, sheets: SheetsClient): Promise<StepResult<WatchlistResult>> {
  const tabsRes = await sheets.listTabs(ctx);
  if (!tabsRes.ok) return tabsRes;

  const exists = tabsRes.value.includes(Tabs.WATCHLIST);

  if (!exists) {
    ctx.log.info('Watchlist tab does not exist — creating and seeding it (one time only)');
    const created = await sheets.formatBatch(ctx, [{ addSheet: { properties: { title: Tabs.WATCHLIST } } }]);
    if (!created.ok) return created;

    const seedRows: SheetRow[] = [['Ticker'], ...WATCHLIST_SEED.map((t) => [t])];
    const written = await sheets.batchUpdate(ctx, [
      { range: a1(Tabs.WATCHLIST, `A1:A${seedRows.length}`), values: seedRows },
    ]);
    if (!written.ok) return written;

    ctx.log.info(`Seeded watchlist with ${WATCHLIST_SEED.length} tickers — edit the sheet to change them`);
    return ok({ tickers: [...WATCHLIST_SEED], seeded: true });
  }

  const read = await sheets.batchGet(ctx, [WATCHLIST_RANGE]);
  if (!read.ok) return read;

  const rows = read.value[0] ?? [];
  const tickers = parseWatchlistRows(rows);

  if (tickers.length === 0 && rows.length <= 1) {
    // Header only: genuinely new sheet, seed it. An empty sheet a user
    // deliberately cleared is indistinguishable from a fresh one here, which
    // is why the seed is written visibly rather than applied in memory.
    ctx.log.info('Watchlist is empty — seeding it (one time only)');
    const seedRows: SheetRow[] = WATCHLIST_SEED.map((t) => [t]);
    const written = await sheets.batchUpdate(ctx, [
      { range: a1(Tabs.WATCHLIST, `A2:A${seedRows.length + 1}`), values: seedRows },
    ]);
    if (!written.ok) return written;
    return ok({ tickers: [...WATCHLIST_SEED], seeded: true });
  }

  ctx.log.info(`Watchlist: ${tickers.length} ticker(s)`, { tickers });
  return ok({ tickers, seeded: false });
}
