/**
 * Calendar-date formatting in an explicit time zone -- the port of Apps
 * Script's Utilities.formatDate for the ONE pattern legacy actually uses.
 *
 * ══ MEASURED, NOT ASSUMED ═══════════════════════════════════════════════
 * 12 live calls across 4 legacy files, every one with pattern 'yyyy-MM-dd'
 * (the business-logic sub-plan's "22" counted comment mentions too):
 *   'UTC'               brokerCourseModelV1.gs:1983, dataLayerV1.gs:1477,
 *                       fullStockAnalysisV10_9.gs:1320,
 *                       futuresStockAnalysisV3_3_11.gs:1560
 *   'America/New_York'  dataLayerV1.gs:1567
 *   Session.getScriptTimeZone()
 *                       fullStockAnalysisV10_9.gs:3648, :3661, :3671, :3681,
 *                       :3718, :4021, :4039
 * Only 'yyyy-MM-dd' is implemented; any other pattern THROWS rather than
 * being half-supported -- a silently wrong date string is exactly the
 * failure this module exists to prevent.
 *
 * Why the zone is never optional: for several hours every night the same
 * instant is a different calendar day in New York and in UTC. An
 * off-by-one there silently moves which bar is "today".
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone -- deliberately not caught.
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

export type DatePattern = 'yyyy-MM-dd';

/**
 * `Utilities.formatDate(date, timeZone, 'yyyy-MM-dd')`.
 *
 * Realm-safe Date check (a Date built in the oracle's vm realm is not an
 * `instanceof` this realm's Date). Invalid Dates and unknown zones throw.
 */
export function formatDateInTz(date: Date, timeZone: string, pattern: DatePattern = 'yyyy-MM-dd'): string {
  if (pattern !== 'yyyy-MM-dd') {
    throw new Error(`formatDateInTz: unsupported pattern "${String(pattern)}" — the legacy code only ever uses 'yyyy-MM-dd'`);
  }
  if (Object.prototype.toString.call(date) !== '[object Date]' || Number.isNaN(date.getTime())) {
    throw new RangeError('formatDateInTz: not a valid Date');
  }
  const parts = formatterFor(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`formatDateInTz: no "${type}" part for zone ${timeZone}`);
    return p.value;
  };
  return part('year').padStart(4, '0') + '-' + part('month') + '-' + part('day');
}

export const SCRIPT_TIME_ZONE_ENV = 'SCRIPT_TIME_ZONE';

/**
 * Replaces Session.getScriptTimeZone(). The legacy project's zone is a
 * project setting stored in appsscript.json, which is not in this
 * repository -- so it is REQUIRED configuration, never guessed. Validated
 * on read.
 */
export function scriptTimeZone(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const tz = env[SCRIPT_TIME_ZONE_ENV];
  if (!tz) {
    throw new Error(`${SCRIPT_TIME_ZONE_ENV} is not set. It replaces Session.getScriptTimeZone(); set it to the legacy Apps Script project's time zone (Project Settings), e.g. "America/New_York".`);
  }
  formatterFor(tz);
  return tz;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock reading of `utcMs` in `timeZone`. */
export function wallClockInTz(utcMs: number, timeZone: string): WallClock {
  let f = wallFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    wallFormatters.set(timeZone, f);
  }
  const p = f.formatToParts(new Date(utcMs));
  const g = (t: Intl.DateTimeFormatPartTypes): number => Number((p.find((x) => x.type === t) as Intl.DateTimeFormatPart).value);
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute'), second: g('second') };
}

/** Wall clock minus UTC, in ms, for `timeZone` at the instant `utcMs`. */
function zoneOffsetAt(utcMs: number, timeZone: string): number {
  const w = wallClockInTz(utcMs, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Local midnight of `date`'s calendar day in `timeZone` -- what
 * `d.setHours(0, 0, 0, 0)` gives when the runtime's zone is `timeZone`
 * (Apps Script evaluates it in the script's zone). Where midnight does not
 * exist (a clock jump at 00:00) the result is the first instant after the
 * gap, as JS does. Verified against setHours across ten zones, DST and
 * half-hour zones included (fl2.fundamentals.test.ts).
 */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const w = wallClockInTz(date.getTime(), timeZone);
  const wall = Date.UTC(w.year, w.month - 1, w.day);
  const first = wall - zoneOffsetAt(wall, timeZone);
  const second = wall - zoneOffsetAt(first, timeZone);
  const isMidnightOfDay = (t: number): boolean => {
    const x = wallClockInTz(t, timeZone);
    return x.year === w.year && x.month === w.month && x.day === w.day && x.hour === 0 && x.minute === 0 && x.second === 0;
  };
  if (isMidnightOfDay(second)) return new Date(second);
  if (isMidnightOfDay(first)) return new Date(first);
  // No midnight that day: the first instant after the gap.
  return new Date(Math.max(first, second));
}

/** `date.toLocaleDateString()` as Apps Script prints it in the script's zone (en-US M/D/YYYY). */
export function localeDateLabel(date: Date, timeZone: string): string {
  return date.toLocaleDateString('en-US', { timeZone });
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A2 (fix plan 2026-10-30): an option expiry as "Fri Jan 19 2029". OCC expiries
 * are stored at 00:00 UTC (fetch/cboe.ts parseOcc), so the date is read in UTC;
 * printing it in New York time showed the day before. Accepts Unix seconds or a
 * Date; anything else prints 'Invalid Date' (as toDateString does).
 */
export function occExpiryText(exp: unknown): string {
  const d = exp instanceof Date ? exp : new Date((typeof exp === 'number' ? exp : NaN) * 1000);
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  return WEEKDAYS_SHORT[d.getUTCDay()] + ' ' + MONTHS_SHORT[d.getUTCMonth()] + ' ' + String(d.getUTCDate()).padStart(2, '0') + ' ' + String(d.getUTCFullYear()).padStart(4, '0');
}
