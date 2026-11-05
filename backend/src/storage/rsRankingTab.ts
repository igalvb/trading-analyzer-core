/**
 * F-57 (the user's decision: the relative-strength ranking map gets its own
 * tab). Legacy cached the whole 111-ticker map as ONE PropertiesService value;
 * it never fitted the 9 KB cap (F-56), and is close to a Sheets cell's 50,000
 * characters, so the Sheet-backed store would also refuse it some days. Here
 * every ticker is its own row, kept 30 hours (legacy's TTL).
 *
 * Layout ('💾 RS Ranking'): Ticker | SavedAt (ISO) | Ranking (JSON)
 */

import type { TabCell, TabStore } from './tabStore.ts';
import type { RelativeStrengthRanking } from '../analysis/darkPool.ts';

export const RS_RANKING_TAB = '💾 RS Ranking';
export const RS_RANKING_TTL_HOURS = 30;
const HEADER: TabCell[] = ['Ticker', 'SavedAt', 'Ranking'];

/** Rewrites the tab with this run's map (one row per ranked ticker). */
export async function writeRsRankingTab(store: TabStore, map: Readonly<Record<string, RelativeStrengthRanking>>, now: Date): Promise<number> {
  await store.ensure(RS_RANKING_TAB);
  await store.clear(RS_RANKING_TAB);
  const rows: TabCell[][] = [HEADER, ...Object.keys(map).sort().map((t) => [t, now.toISOString(), JSON.stringify(map[t])])];
  await store.write(RS_RANKING_TAB, 1, rows);
  return rows.length - 1;
}

/** One ticker's ranking, or null when absent or older than the TTL. */
export async function readRsRanking(store: TabStore, ticker: string, nowMs: number, ttlHours = RS_RANKING_TTL_HOURS): Promise<RelativeStrengthRanking | null> {
  const rows = await store.read(RS_RANKING_TAB, 3);
  if (!rows) return null;
  const r = rows.find((x) => String(x[0]).toUpperCase() === String(ticker).toUpperCase());
  if (!r) return null;
  const saved = Date.parse(String(r[1]));
  if (!Number.isFinite(saved) || (nowMs - saved) / 3600000 > ttlHours) return null;
  try { return JSON.parse(String(r[2])) as RelativeStrengthRanking; } catch { return null; }
}
