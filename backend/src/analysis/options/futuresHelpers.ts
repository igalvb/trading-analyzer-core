/**
 * The small helpers of futuresStockAnalysisV3_3_11.gs that are not sheet
 * formatting: scoreColor :1508-1514, fmtDate :1560, addDays :1561,
 * elapsed :1562. (fmtDate and addDays have no caller anywhere in legacy;
 * ported per the standing rule.) getOrCreate / hdr / altRows are sheet
 * helpers and come with the report tabs (FL-6b).
 */

import { formatDateInTz, wallClockInTz } from '../../core/dates.ts';

/** scoreColor (:1508-1514): the 0-100 score's cell colour. */
export function scoreColor(val: number): string {
  if (val >= 80) return '#c8e6c9';
  if (val >= 60) return '#dcedc8';
  if (val >= 40) return '#fff9c4';
  if (val >= 20) return '#ffe0b2';
  return '#ffcdd2';
}

/** fmtDate (:1560): Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'). */
export function fmtDate(d: Date): string {
  return formatDateInTz(d, 'UTC');
}

function wallMs(utcMs: number, timeZone: string): number {
  const w = wallClockInTz(utcMs, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/**
 * The instant a local wall-clock reading denotes in `timeZone`, resolved as
 * JavaScript's `new Date(y, m, d, h, mi, s, ms)` does: an ambiguous reading
 * (clocks set back) is the earlier instant; a skipped one (clocks set
 * forward) moves forward by the gap.
 */
export function wallToInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset = (t: number): number => wallMs(t, timeZone) - Math.floor(t / 1000) * 1000;
  const before = offset(wall - 86400000), after = offset(wall + 86400000);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((t) => wallMs(t, timeZone) === wall - ms);
  if (valid.length) return Math.min(...valid);
  return wall - before;
}

/** addDays (:1561): `r.setDate(r.getDate() + n)` -- n calendar days, same local time of day, in the script's zone. */
export function addDays(d: Date, n: number, timeZone: string): Date {
  const t = d.getTime();
  const w = wallClockInTz(t, timeZone);
  const ms = ((t % 1000) + 1000) % 1000;
  return new Date(wallToInstant(w.year, w.month, w.day + n, w.hour, w.minute, w.second, ms, timeZone));
}

/** elapsed (:1562): seconds since `startMs`, one decimal, e.g. '3.2s'. */
export function elapsed(startMs: number, nowMs: number): string {
  return ((nowMs - startMs) / 1000).toFixed(1) + 's';
}
