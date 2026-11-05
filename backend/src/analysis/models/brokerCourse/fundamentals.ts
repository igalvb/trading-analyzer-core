/**
 * Broker Course Phase 6 -- the dilution / pump-and-dump screen
 * (:1226-1299, 3 functions; episode 12's GEVO checklist).
 *
 * Checklist (1) revenue and (lock-up, ep.8) are computed here; (2) shares-
 * outstanding trend and (3) filing keywords come from Phase 13's screens
 * (BC-1) when their data is supplied.
 *
 * ══ THE PHASE 13 PARAMETERS ARE THREE-STATE ══════════════════════════
 * `sharesOutstandingHistory` and `filingKeywordHits` distinguish ABSENT
 * (`undefined`: "Not available — needs ..." disclosure), NULL (supplied but
 * the fetch failed: "SEC EDGAR ... failed") and data. The only call site
 * (:1984) always passes both, so the "Not available — needs ..." texts are
 * unreachable from the report builder.
 */

import { sharesOutstandingTrendReadV1, filingKeywordReadV1, type SharesOutstandingPoint } from './screens.ts';

export interface RevenueRedFlag {
  readonly isRedFlag: boolean;
  readonly revenueGrowth: number;
  readonly read: string;
}

/**
 * Checklist item (1): "minimal/negative revenue" read as growth <= 0, so
 * exactly zero IS a red flag. Single-point YoY growth only -- the course
 * asks for multi-year depth, a disclosed limitation of the fetched data.
 */
export function revenueRedFlagV1(revenueGrowth: number | null | undefined): RevenueRedFlag | null {
  if (revenueGrowth == null) return null;
  const isRedFlag = revenueGrowth <= 0;
  return {
    isRedFlag, revenueGrowth,
    read: isRedFlag
      ? 'Revenue growth is minimal/negative (' + (revenueGrowth * 100).toFixed(1) + '%) — matches the course\'s GEVO dilution-screen red flag #1 (ep.12)'
      : 'Revenue growth is positive (' + (revenueGrowth * 100).toFixed(1) + '%) — no red flag on this check',
  };
}

export interface LockupRead {
  readonly daysSinceIPO: number;
  readonly daysUntilLockupEnd: number;
  readonly status: 'UPCOMING' | 'PASSED';
  readonly read: string;
}

/**
 * IPO lock-up window (ep.8): 180 days, shown from IPO through day 210.
 *
 * ══ FLAGGED (F-27): THE TIME-OF-DAY BUG THE ENGINE ALREADY FIXED ═════
 * This is an independent copy of the engine's lockupExpirationV7 (:9115).
 * The engine records a real v9.46 fix -- zero BOTH dates to UTC midnight
 * before differencing, because Yahoo's firstTradeDate is a market-open
 * timestamp and `now` is wall clock, so the day count depended on the hour
 * of the run. This copy still differences raw timestamps, and its caller
 * passes `new Date()` (:1984). Measured on a 1,512-point day/hour grid:
 * 848 disagreements with the engine -- precisely every run before the IPO
 * timestamp's time of day (14:30 UTC in the test), where this copy counts
 * one day fewer. On day 180 a morning run reads "UPCOMING, 1 day" while
 * the engine reads "PASSED"; on IPO day before the open this returns
 * null. Reproduced, not fixed.
 */
export function lockupExpirationReadV1(
  firstTradeDate: Date | null | undefined, now: Date,
): LockupRead | null {
  if (!firstTradeDate) return null;
  const LOCKUP_DAYS = 180;
  const DISPLAY_WINDOW_DAYS = 210;
  const MS_PER_DAY = 86400000;
  const daysSinceIPO = Math.floor((+now - +firstTradeDate) / MS_PER_DAY);
  if (daysSinceIPO < 0 || daysSinceIPO > DISPLAY_WINDOW_DAYS) return null;
  const daysUntilLockupEnd = LOCKUP_DAYS - daysSinceIPO;
  const status = daysUntilLockupEnd > 0 ? 'UPCOMING' : 'PASSED';
  return {
    daysSinceIPO, daysUntilLockupEnd, status,
    read: status === 'UPCOMING'
      ? ('Lock-up expiration in ~' + daysUntilLockupEnd + ' day(s) — insider-selling pressure risk (ep.8)')
      : ('Lock-up expired ~' + Math.abs(daysUntilLockupEnd) + ' day(s) ago — recent insider-selling pressure window (ep.8)'),
  };
}

export type FundamentalsTag = 'Dilution/Pump-Dump Risk Flagged' | 'No red flags found';

export interface FundamentalsScreen {
  readonly tag: FundamentalsTag;
  readonly evidence: string[];
  readonly sharesOutstandingTrend: string;
  readonly filingKeywordSearch: string;
}

/**
 * One tag plus evidence. Any of the three red-flag checks sets the same
 * tag; evidence order is fixed: revenue, shares, filings, then lock-up
 * (lock-up never sets the tag). See the header for the three-state params.
 */
export function fundamentalsScreenReadV1(
  revenueGrowth: number | null | undefined,
  firstTradeDate: Date | null | undefined,
  now: Date,
  sharesOutstandingHistory?: readonly SharesOutstandingPoint[] | null,
  filingKeywordHits?: Record<string, number | null> | null,
): FundamentalsScreen {
  const revenueFlag = revenueRedFlagV1(revenueGrowth);
  const lockup = lockupExpirationReadV1(firstTradeDate, now);
  const sharesTrend = sharesOutstandingHistory !== undefined ? sharesOutstandingTrendReadV1(sharesOutstandingHistory) : null;
  const filingFlag = filingKeywordHits !== undefined ? filingKeywordReadV1(filingKeywordHits) : null;

  const evidence: string[] = [];
  let tag: FundamentalsTag = 'No red flags found';
  if (revenueFlag && revenueFlag.isRedFlag) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(revenueFlag.read);
  }
  if (sharesTrend && sharesTrend.steadilyRising) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(sharesTrend.read);
  }
  if (filingFlag && filingFlag.anyFound) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(filingFlag.read);
  }
  if (lockup) evidence.push(lockup.read);

  return {
    tag, evidence,
    sharesOutstandingTrend: sharesOutstandingHistory !== undefined
      ? (sharesTrend ? sharesTrend.read : 'SEC EDGAR data fetch failed or insufficient history for this ticker')
      : 'Not available — needs multi-year shares-outstanding history (Phase 13: real via SEC EDGAR when this param is supplied)',
    filingKeywordSearch: filingKeywordHits !== undefined
      ? (filingFlag ? filingFlag.read : 'SEC EDGAR filing search failed for this ticker')
      : 'Not available — needs a 10-K/10-Q text source (Phase 13: real via SEC EDGAR full-text search when this param is supplied)',
  };
}
