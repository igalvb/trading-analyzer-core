/**
 * Options position exit read -- closes the exit-read family.
 *
 *   computeOptionsPositionExitRead  (:10072-10130)
 *   parseOptionExpiry               (myOptionsValueTracker.gs:32-56)
 *
 * An options position has a second clock the stock side does not: the
 * contract expires whether or not the thesis plays out. So this wraps the
 * stock read and inserts a time-decay rung into its ladder.
 *
 * ══ THE TECHNICAL READ IS THE UNDERLYING'S, NOT THE OPTION'S ═══════════
 * `technical` comes from computePositionExitRead on the UNDERLYING, using
 * the underlying's close on the entry bar as the entry price -- NOT the
 * option premium. That is correct and deliberate: stops, targets and thesis
 * are properties of the stock's chart. The premium (`avgPremium`) is
 * carried through for display and never enters any comparison.
 *
 * Consequence worth knowing: `technical.unrealizedPct` is the UNDERLYING's
 * move, not the option's P&L, which is leveraged and decaying. Reproduced
 * as found.
 *
 * ══ ONE STRUCTURAL CHANGE: THE CLOCK IS INJECTABLE ═════════════════════
 * Legacy computes `daysToExpiry` from `Date.now()` (:10081), which makes
 * the function non-reproducible -- the same inputs give different output
 * tomorrow. `now` is a parameter here, defaulting to Date.now() so
 * production behaviour is unchanged. Without it there is no way to test the
 * expiry rungs at all, which is the same reason the events slice takes
 * `simulatedNow`.
 */

import type { Chart } from '../types/chart.ts';
import {
  computePositionExitRead, type PositionExitRead, type ExitReadError, type ExitReadOptions,
} from './exitRead.ts';

/** Days before expiry at which a short-dated contract is flagged (:9919). */
export const EXPIRY_WARNING_DAYS_SHORT_TERM = 30;
/** Days before expiry at which a LEAPS is flagged (:9920). */
export const EXPIRY_WARNING_DAYS_LEAPS = 60;
/** Original duration above which a contract counts as a LEAPS (:9921). */
export const LEAPS_MIN_ORIGINAL_DURATION_DAYS = 365;

const MS_PER_DAY = 86_400_000;

export interface ParsedExpiry {
  readonly year: number;
  /** 1-based, unlike Date's getMonth(). */
  readonly month: number;
  readonly day: number;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parses an expiry from the broker-style formats the Transactions sheet
 * actually contains.
 *
 * Three paths, in order: an actual Date object, the compact broker form
 * ("Mar19'27", "JUN17'27", "Dec 17 27"), then a plain `new Date(str)`
 * fallback.
 *
 * ══ TWO THINGS REPRODUCED DELIBERATELY ═════════════════════════════════
 * 1. A two-digit year gets +2000, so "27" is 2027. There is no windowing --
 *    "99" becomes 2099, not 1999. Fine for option expiries, which are
 *    always near-future, and wrong for anything else. Not generalised.
 * 2. The fallback uses `new Date(str)`, whose behaviour for ambiguous input
 *    is engine- and locale-dependent. Carried as-is rather than replaced
 *    with a stricter parser, because changing it would change which rows
 *    of the user's real sheet parse.
 *
 * Returns a plain {year, month, day} rather than a Date on purpose: the
 * caller builds the Date in LOCAL time, and handing back a Date here would
 * invite a UTC/local mix-up.
 */
export function parseOptionExpiry(val: unknown): ParsedExpiry | null {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return { year: val.getFullYear(), month: val.getMonth() + 1, day: val.getDate() };
  }
  const str = String(val || '').trim();
  if (!str) return null;

  const mShort = str.match(/^([A-Za-z]{3})\s*(\d{1,2})['\s]*(\d{2,4})$/);
  if (mShort) {
    const mm = MONTHS[mShort[1].toLowerCase()];
    const dd = parseInt(mShort[2], 10);
    let yy = parseInt(mShort[3], 10);
    if (yy < 100) yy += 2000;
    if (mm && dd && yy) return { year: yy, month: mm, day: dd };
  }

  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return null;
}

export type OptionsExitRecommendation =
  | 'EXPIRED'
  | 'HOLD (technical read unavailable)'
  | 'STOP HIT (underlying) — EXIT'
  | 'THESIS INVALIDATED (underlying) — CONSIDER EXIT'
  | `EXPIRY APPROACHING (${number}d) — CONSIDER EXIT`
  | 'T2 REACHED (underlying) — CONSIDER TRIMMING'
  | 'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS'
  | 'HOLD';

export interface OptionsPositionExitRead {
  readonly error: null;
  readonly ticker: string;
  readonly strike: number;
  readonly expiryStr: string;
  readonly avgPremium: number;
  readonly daysToExpiry: number;
  readonly isLeapsAtEntry: boolean;
  readonly expiryThreshold: number;
  readonly expiryWarning: boolean;
  readonly underlyingEntryPrice: number;
  /** The UNDERLYING's read. May itself be an error object. */
  readonly technical: PositionExitRead | ExitReadError;
  readonly recommendation: string;
  readonly reason: string;
}

/**
 * The options exit read.
 *
 * ══ THE LADDER, AND WHERE EXPIRY SITS IN IT ════════════════════════════
 *   1. EXPIRED                  defensive -- should never appear
 *   2. technical unavailable    the underlying read failed
 *   3. STOP HIT (underlying)
 *   4. THESIS INVALIDATED
 *   5. EXPIRY APPROACHING       <-- the only rung the stock read lacks
 *   6. T2 REACHED
 *   7. T1 REACHED
 *   8. HOLD
 *
 * Expiry sits BELOW the two risk rungs and ABOVE both profit rungs. That
 * ordering is a real judgement, not an accident: a broken chart matters
 * regardless of time left, but running out of time matters more than having
 * reached a target. Every signal is still returned in `technical`, so
 * nothing is hidden by losing the headline.
 *
 * Note F-16 compounds here. The T2/T1 rungs already almost never surface on
 * the stock side (measured: T2 0 of 305, T1 44 of 553), and here they sit
 * below an additional rung that fires on every contract inside its warning
 * window. An options T2 read is correspondingly even rarer.
 *
 * `expiryThreshold` is 60 days for a contract that was a LEAPS AT ENTRY,
 * 30 otherwise -- and "at entry" is the point. A LEAPS with 20 days left is
 * still judged on the 60-day window, because `originalDurationDays` is
 * measured from entry to expiry, not from today.
 */
export function computeOptionsPositionExitRead(
  ticker: string,
  strike: number,
  expiryStr: string,
  avgPremium: number,
  earliestEntryDateStr: string,
  chart: Chart,
  now: number = Date.now(),
  opts: ExitReadOptions = {},
): OptionsPositionExitRead | ExitReadError {
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };

  const parsedExpiry = parseOptionExpiry(expiryStr);
  if (!parsedExpiry) {
    return {
      error: 'Could not parse expiry date "' + expiryStr + '" for ' + ticker + ' $' + strike + '.',
    };
  }
  // LOCAL time, matching legacy. A UTC construction here would shift
  // daysToExpiry by a day for anyone east or west of the server.
  const expiryDate = new Date(parsedExpiry.year, parsedExpiry.month - 1, parsedExpiry.day);
  const entryDate = new Date(earliestEntryDateStr);

  const daysToExpiry = Math.round((expiryDate.getTime() - now) / MS_PER_DAY);
  const originalDurationDays = Math.round(
    (expiryDate.getTime() - entryDate.getTime()) / MS_PER_DAY,
  );
  const isLeapsAtEntry = originalDurationDays > LEAPS_MIN_ORIGINAL_DURATION_DAYS;
  const expiryThreshold = isLeapsAtEntry ? EXPIRY_WARNING_DAYS_LEAPS : EXPIRY_WARNING_DAYS_SHORT_TERM;
  const expiryWarning = daysToExpiry <= expiryThreshold;

  // The underlying's close on the entry bar. Falls back to the FIRST close
  // when the entry predates the fetched history -- which silently uses a
  // wrong entry price rather than erroring, unlike the stock read, which
  // refuses outright in the same situation. Reproduced as found; the
  // divergence between the two is legacy's, not the port's.
  const entryIdx = chart.dates.findIndex((d) => d.getTime() >= entryDate.getTime());
  const underlyingEntryPrice = entryIdx !== -1 ? chart.closes[entryIdx] : chart.closes[0];
  const technical = computePositionExitRead(ticker, underlyingEntryPrice, earliestEntryDateStr, chart, opts);
  const techErr = 'error' in technical ? technical.error : null;
  const techOk = techErr === null ? (technical as PositionExitRead) : null;

  let recommendation: string;
  let reason: string;
  if (daysToExpiry <= 0) {
    recommendation = 'EXPIRED';
    reason = 'Expiry date (' + expiryStr + ') has passed — this position should not still be open; '
      + 'check the Transactions sheet.';
  } else if (techErr) {
    recommendation = 'HOLD (technical read unavailable)';
    reason = techErr;
  } else if (techOk && techOk.stopBreached) {
    recommendation = 'STOP HIT (underlying) — EXIT';
    reason = techOk.reason;
  } else if (techOk && techOk.thesisInvalidated) {
    recommendation = 'THESIS INVALIDATED (underlying) — CONSIDER EXIT';
    reason = techOk.reason;
  } else if (expiryWarning) {
    recommendation = 'EXPIRY APPROACHING (' + daysToExpiry + 'd) — CONSIDER EXIT';
    reason = 'Inside the ' + expiryThreshold + '-day real time-decay warning window for a '
      + (isLeapsAtEntry ? 'LEAPS' : 'short-term')
      + ' contract (theta accelerates as expiry nears), independent of the underlying\'s own '
      + 'technical picture.';
  } else if (techOk && techOk.hitT2) {
    recommendation = 'T2 REACHED (underlying) — CONSIDER TRIMMING';
    reason = techOk.reason;
  } else if (techOk && techOk.hitT1) {
    recommendation = 'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS';
    reason = techOk.reason;
  } else {
    recommendation = 'HOLD';
    reason = 'No stop breach, no thesis change, not near expiry, targets not yet reached.';
  }

  return {
    error: null, ticker, strike, expiryStr, avgPremium, daysToExpiry, isLeapsAtEntry,
    expiryThreshold, expiryWarning, underlyingEntryPrice, technical, recommendation, reason,
  };
}
