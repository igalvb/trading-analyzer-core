/**
 * The NYSE calendar for the live bot's freshness gate (R4; phase 1 rail "Freshness"): weekends, the exchange's
 * full-day holidays and its 1 pm half days, in New York time.
 *
 * The paper test (paper/paperJob.ts) has no calendar table: a trading day there is a day with a QQQ bar, and a day
 * counts as closed once New York is past 16:30 (or the bar is from an earlier day). This module states the same days
 * as rules so a missing bar (a late or failed Nightly) can be told apart from a holiday, with the same 30 minutes
 * after the close before a day counts as closed (13:30 on a half day).
 *
 * Rules (NYSE): New Year's Day (a Saturday one is not moved to Friday), Martin Luther King Jr. Day, Washington's
 * Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day, Thanksgiving, Christmas;
 * a Saturday holiday moves to Friday, a Sunday one to Monday. Half days (close 13:00): July 3 when it is a trading
 * day, the day after Thanksgiving, December 24 when it is a trading day.
 */

export const NY_TZ = 'America/New_York';
/** Minutes after the close before a day counts as closed (paper/paperJob.ts: 16:30). */
export const SETTLE_MINUTES = 30;

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, day: number): Date => new Date(Date.UTC(y, m - 1, day));
const addDays = (day: string, n: number): string => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const weekday = (day: string): number => new Date(day + 'T12:00:00Z').getUTCDay();

/** The n-th (1-based) weekday `wd` of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) { const first = utc(y, m, 1); const off = (wd - first.getUTCDay() + 7) % 7; return iso(utc(y, m, 1 + off + 7 * (n - 1))); }
  const last = utc(y, m + 1, 0); const off = (last.getUTCDay() - wd + 7) % 7; return iso(utc(y, m, last.getUTCDate() - off));
}

/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(utc(y, month, day));
}

/** A fixed-date holiday moved off the weekend (Saturday -> Friday, Sunday -> Monday). */
function observed(day: string): string { const w = weekday(day); return w === 6 ? addDays(day, -1) : w === 0 ? addDays(day, 1) : day; }

const holidayCache = new Map<number, Map<string, string>>();

/** The NYSE full-day holidays of a year: date -> name. */
export function nyseHolidays(y: number): ReadonlyMap<string, string> {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const h = new Map<string, string>();
  const ny = iso(utc(y, 1, 1));
  if (weekday(ny) !== 6) h.set(observed(ny), "New Year's Day");
  h.set(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  h.set(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  h.set(addDays(easter(y), -2), 'Good Friday');
  h.set(nthWeekday(y, 5, 1, -1), 'Memorial Day');
  if (y >= 2022) h.set(observed(iso(utc(y, 6, 19))), 'Juneteenth');
  h.set(observed(iso(utc(y, 7, 4))), 'Independence Day');
  h.set(nthWeekday(y, 9, 1, 1), 'Labor Day');
  h.set(nthWeekday(y, 11, 4, 4), 'Thanksgiving');
  h.set(observed(iso(utc(y, 12, 25))), 'Christmas');
  holidayCache.set(y, h);
  return h;
}

export function holidayName(day: string): string | null { return nyseHolidays(Number(day.slice(0, 4))).get(day) ?? null; }

export function isTradingDay(day: string): boolean { const w = weekday(day); return w !== 0 && w !== 6 && holidayName(day) == null; }

export function isHalfDay(day: string): boolean {
  if (!isTradingDay(day)) return false;
  const y = Number(day.slice(0, 4));
  return day === iso(utc(y, 7, 3)) || day === addDays(nthWeekday(y, 11, 4, 4), 1) || day === iso(utc(y, 12, 24));
}

/** The close in minutes after midnight New York time, or null on a day without trading. */
export function closeMinutes(day: string): number | null { return isTradingDay(day) ? (isHalfDay(day) ? 13 * 60 : 16 * 60) : null; }

export function previousTradingDay(day: string): string { let d = addDays(day, -1); while (!isTradingDay(d)) d = addDays(d, -1); return d; }

/** New York's date and minutes after midnight at `nowMs`. */
export function nyClock(nowMs: number): { readonly day: string; readonly minutes: number } {
  const d = new Date(nowMs);
  const day = d.toLocaleDateString('en-CA', { timeZone: NY_TZ });
  const [hh, mm] = d.toLocaleTimeString('en-GB', { timeZone: NY_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':');
  return { day, minutes: Number(hh) * 60 + Number(mm) };
}

/** The last trading day whose close is at least SETTLE_MINUTES behind `nowMs` (the day a fresh Nightly decides on). */
export function lastClosedTradingDay(nowMs: number): string {
  const { day, minutes } = nyClock(nowMs);
  const close = closeMinutes(day);
  return close != null && minutes >= close + SETTLE_MINUTES ? day : previousTradingDay(day);
}

export function nextTradingDay(day: string): string { let d = addDays(day, 1); while (!isTradingDay(d)) d = addDays(d, 1); return d; }

/** The open, in minutes after midnight New York time (also on half days). */
export const OPEN_MINUTES = 9 * 60 + 30;

/** The moment (ms) of `minutes` after midnight New York time on `day` (EST or EDT, whichever holds that day). */
export function nyMoment(day: string, minutes: number): number {
  const base = Date.parse(day + 'T00:00:00Z') + minutes * 60_000;
  for (const h of [4, 5]) { const t = base + h * 3_600_000; const c = nyClock(t); if (c.day === day && c.minutes === minutes) return t; }
  return base + 5 * 3_600_000;
}
