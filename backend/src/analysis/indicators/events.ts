/**
 * Event-driven and stop-management fields: progressiveStopFlag,
 * lockupExpiration, recentReverseSplit.
 *
 * All three return null on every real fixture -- they need conditions the
 * historical data does not contain (a volume climax during a mature uptrend, a
 * recent IPO, a recent reverse split). So like wyckoffSchematic, they are
 * verified against the oracle on SYNTHETIC charts built to trigger them.
 *
 * Verified 2026-09-21: 249 comparisons, all exact. Both branches of each field
 * exercised, plus both lockup statuses (UPCOMING and PASSED).
 */

import type { Chart, Split } from '../../types/chart.ts';
import { trendMaturity } from './slices.ts';

export type EventInput = Pick<Chart, 'closes' | 'volumes' | 'dates' | 'splits' | 'ipoDate'> & {
  /** Injectable clock. See the note on lockupExpiration -- without it, output is time-dependent. */
  readonly simulatedNow?: Date;
};

export interface ProgressiveStopRead {
  level: number;
  volumeRatio: number;
  daysSinceCross: number;
}

export interface LockupExpirationRead {
  ipoDate: Date;
  lockupDate: Date;
  daysSinceIPO: number;
  daysUntilExpiration: number;
  status: 'UPCOMING' | 'PASSED';
}

export interface RecentReverseSplitRead {
  date: Date;
  /** Formatted as "numerator:denominator", e.g. "1:10". */
  ratio: string;
  daysAgo: number;
}

const LOCKUP_DAYS = 180;
const DISPLAY_WINDOW_DAYS = 210;
const MS_PER_DAY = 86_400_000;
const RRS_LOOKBACK_BARS = 60;

/**
 * IPO lock-up expiration, when it falls inside the display window.
 *
 * ══ NON-DETERMINISM, BY DESIGN AND WORTH KNOWING ════════════════════════
 * This is the ONLY indicator field whose value depends on the current time
 * rather than solely on the price series. The legacy call site is
 *
 *     lockupExpirationV7(c.ipoDate, c.simulatedNow || new Date())
 *
 * so without an injected clock the same chart yields different output on
 * different days. Every test MUST pass simulatedNow, or it will pass today and
 * fail later -- the worst kind of flake.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Both dates are normalised to UTC midnight before differencing, so the result
 * is a whole-day count unaffected by the time-of-day component.
 *
 * Note the asymmetry in the window: 180 days to expiration but a 210-day
 * display window, so a lock-up stays visible for 30 days AFTER expiring --
 * reported as PASSED. The aftermath is treated as still relevant.
 */
export function lockupExpiration(ipoDate: Date | null, now: Date): LockupExpirationRead | null {
  if (!ipoDate) return null; // pre-coverage ticker, or the field was not carried

  const ipoDay = Date.UTC(ipoDate.getUTCFullYear(), ipoDate.getUTCMonth(), ipoDate.getUTCDate());
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceIPO = Math.floor((nowDay - ipoDay) / MS_PER_DAY);

  // Negative means a future-dated IPO -- treated as out of window, not an error.
  if (daysSinceIPO < 0 || daysSinceIPO > DISPLAY_WINDOW_DAYS) return null;

  const lockupDate = new Date(ipoDate.getTime() + LOCKUP_DAYS * MS_PER_DAY);
  const daysUntilExpiration = LOCKUP_DAYS - daysSinceIPO;

  return {
    ipoDate,
    lockupDate,
    daysSinceIPO,
    daysUntilExpiration, // negative once passed
    status: daysUntilExpiration > 0 ? 'UPCOMING' : 'PASSED',
  };
}

/**
 * The most recent REVERSE split within the lookback window.
 *
 * A reverse split is numerator < denominator (1:10 shrinks the share count);
 * a forward split (2:1) is filtered out. Reverse splits are the signal here
 * because they are frequently a distress marker -- often done to maintain an
 * exchange listing minimum.
 *
 * The cutoff is a DATE taken from the bar 60 positions back, not a bar index,
 * so splits are compared on their own timeline rather than assumed aligned to
 * the bar array. Sorted newest-first, so the most recent reverse split wins
 * when several fall in the window.
 */
export function recentReverseSplit(
  splits: readonly Split[] | null,
  dates: readonly Date[] | null,
  n: number,
): RecentReverseSplitRead | null {
  if (!splits || !splits.length || !dates || !dates.length) return null;

  const cutoffDate = dates[Math.max(0, n - RRS_LOOKBACK_BARS)] as Date;
  const recentReverse = splits
    .filter((s) => s.numerator < s.denominator) // reverse only
    .filter((s) => s.date >= cutoffDate)
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0];

  if (!recentReverse) return null;

  const daysAgo = Math.round(((dates[n - 1] as Date).getTime() - recentReverse.date.getTime()) / MS_PER_DAY);
  return {
    date: recentReverse.date,
    ratio: `${recentReverse.numerator}:${recentReverse.denominator}`,
    daysAgo,
  };
}

export interface EventsSlice {
  progressiveStopFlag: ProgressiveStopRead | null;
  lockupExpiration: LockupExpirationRead | null;
  recentReverseSplit: RecentReverseSplitRead | null;
}

/**
 * The three event-driven fields.
 *
 * progressiveStopFlag fires only on a four-way conjunction: a volume spike
 * above 3x, an up-close, an established UP trend, and at least 5 days since the
 * crossover. The last condition is what stops it firing on the crossover bar
 * itself, where the "trend" has no track record yet.
 *
 * The 0.125 stop offset is an eighth of a point -- a pre-decimalization tick
 * size, from an era when US equities quoted in fractions. It has been a fixed
 * dollar amount rather than a meaningful increment since 2001, so on a $500
 * stock it is 0.025% below the close: effectively at the close. Preserved
 * verbatim; worth knowing it is a historical artifact rather than a tuned
 * parameter.
 */
export function computeEventsSlice(c: EventInput): EventsSlice {
  const { closes, volumes, dates, splits, ipoDate, simulatedNow } = c;
  const n = closes.length;

  // Mirrors slice 8's volRatio exactly.
  const vol20avgRaw = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vol20avgRaw > 0 ? (volumes[n - 1] as number) / (vol20avgRaw || 1) : 1;

  const tm = trendMaturity(closes);
  const progressiveStopFlag: ProgressiveStopRead | null =
    n > 1 &&
    volRatio > 3.0 &&
    (closes[n - 1] as number) > (closes[n - 2] as number) &&
    tm &&
    tm.direction === 'UP' &&
    tm.daysSinceCross >= 5
      ? { level: (closes[n - 1] as number) - 0.125, volumeRatio: volRatio, daysSinceCross: tm.daysSinceCross }
      : null;

  return {
    progressiveStopFlag,
    // Falls back to the wall clock when no simulatedNow is supplied -- which is
    // exactly what makes this field time-dependent. See the note above.
    lockupExpiration: lockupExpiration(ipoDate, simulatedNow || new Date()),
    recentReverseSplit: recentReverseSplit(splits, dates, n),
  };
}
