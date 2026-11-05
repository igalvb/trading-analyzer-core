/**
 * The regular NYSE session (09:30-16:00 New York, Monday-Friday; no holiday calendar, as in storage/priceHistory.ts F-41).
 * Used by report wording only (D8 intraday volume pace, D9 "price" vs "close"); never by a score.
 */

import { wallClockInTz } from './dates.ts';

const NY = 'America/New_York';
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const SESSION_MIN = CLOSE_MIN - OPEN_MIN;

/** yyyy-MM-dd in New York. */
export function nyDate(ms: number): string {
  const w = wallClockInTz(ms, NY);
  return w.year + '-' + String(w.month).padStart(2, '0') + '-' + String(w.day).padStart(2, '0');
}

/** The share of today's regular session already elapsed (0 < f < 1), or null outside the session. At least one minute. */
export function sessionFractionElapsed(nowMs: number): number | null {
  const w = wallClockInTz(nowMs, NY);
  const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  if (dow < 1 || dow > 5) return null;
  const m = w.hour * 60 + w.minute + w.second / 60;
  if (m < OPEN_MIN || m >= CLOSE_MIN) return null;
  return Math.max(m - OPEN_MIN, 1) / SESSION_MIN;
}

/**
 * The fraction of the session behind the chart's LAST bar when that bar is today's unfinished session bar, else null
 * (market closed, or the last bar is an earlier, complete day). A bar's session date is its UTC calendar date
 * (Yahoo 13:30/14:30 UTC, Nasdaq 00:00 UTC -- the same rule as isPriceCacheFreshForSession).
 */
export function liveBarFraction(dates: readonly (Date | number | string)[] | null | undefined, nowMs: number): number | null {
  const f = sessionFractionElapsed(nowMs);
  if (f == null || !dates || !dates.length) return null;
  const last = new Date(dates[dates.length - 1] as never);
  if (isNaN(last.getTime())) return null;
  return last.toISOString().slice(0, 10) === nyDate(nowMs) ? f : null;
}
