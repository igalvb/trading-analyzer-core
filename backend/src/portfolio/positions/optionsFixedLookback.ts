/**
 * computeOptionsPositionExitReadFixedLookbackV1_ (fullStockAnalysisV10_9.gs:10005-10055).
 *
 * The options exit read for a position with NO entry date on file (the
 * Portfolio sheet's sub-tables). Its sibling computeOptionsPositionExitRead
 * (analysis/optionsExitRead.ts, :10072-10130) needs an entry date to classify
 * a contract as LEAPS-at-entry; this one cannot, so EVERY contract gets the
 * single 60-day (LEAPS) warning floor. That warns a short-term contract a
 * little early (safe) and never warns a LEAPS late (unsafe). The reason text
 * says so.
 *
 * The technical read is the UNDERLYING's, over a fixed trailing window, with
 * the underlying's close at the start of that window standing in for an
 * entry price (never the option premium; avgPremium is carried for display).
 * It reuses computePositionExitReadFixedLookback (analysis/exitRead.ts,
 * :9936-9986), already ported and not duplicated here.
 *
 * Structural changes (the same two as the sibling port):
 *  - chart is a parameter, not "existingChart || fetchYahooChart(ticker)".
 *    The caller fetches (chart ?? await fetchChart(ticker)); null means the
 *    fetch failed and gives legacy's "Could not fetch data" error.
 *  - the clock is a parameter (default Date.now()) so the expiry rungs are
 *    testable.
 *
 * Ladder (first match wins): EXPIRED, technical unavailable, STOP HIT,
 * THESIS INVALIDATED, EXPIRY APPROACHING, T2, T1, HOLD. Reproduced as found:
 * the T2 rung cannot surface in practice (see F-J3 in the FL-J handback).
 */

import type { Chart } from '../../types/chart.ts';
import {
  computePositionExitReadFixedLookback, EXIT_GENERIC_LOOKBACK_TRADING_DAYS,
  type ExitReadError, type FixedLookbackExitRead, type ExitReadOptions,
} from '../../analysis/exitRead.ts';
import { parseOptionExpiry, EXPIRY_WARNING_DAYS_LEAPS } from '../../analysis/optionsExitRead.ts';

const MS_PER_DAY = 86_400_000;

export interface OptionsFixedLookbackRead {
  readonly error: null;
  readonly ticker: string;
  readonly strike: number;
  readonly expiryStr: string;
  readonly avgPremium: number;
  readonly daysToExpiry: number;
  /** Always 60 here: no entry date, so no LEAPS / short-term classification. */
  readonly expiryThreshold: number;
  readonly expiryWarning: boolean;
  /** The underlying's close at the start of the lookback window. */
  readonly underlyingProxyEntryPrice: number;
  /** The UNDERLYING's read. May itself be an error object. */
  readonly technical: FixedLookbackExitRead | ExitReadError;
  readonly recommendation: string;
  readonly reason: string;
}

export function computeOptionsPositionExitReadFixedLookback(
  ticker: string,
  strike: number,
  expiryStr: string,
  avgPremium: number,
  chart: Chart | null | undefined,
  lookbackTradingDays?: number | null,
  now: number = Date.now(),
  opts: ExitReadOptions = {},
): OptionsFixedLookbackRead | ExitReadError {
  // "||" not "??", as in legacy: an explicit 0 falls back to 800.
  const lookback = lookbackTradingDays || EXIT_GENERIC_LOOKBACK_TRADING_DAYS;
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };

  const parsedExpiry = parseOptionExpiry(expiryStr);
  if (!parsedExpiry) {
    return { error: 'Could not parse expiry date "' + expiryStr + '" for ' + ticker + ' $' + strike + '.' };
  }
  // LOCAL time, matching legacy.
  const expiryDate = new Date(parsedExpiry.year, parsedExpiry.month - 1, parsedExpiry.day);
  const daysToExpiry = Math.round((expiryDate.getTime() - now) / MS_PER_DAY);

  const expiryThreshold = EXPIRY_WARNING_DAYS_LEAPS;
  const expiryWarning = daysToExpiry <= expiryThreshold;

  const closes = chart.closes;
  const lookbackStart = Math.max(0, closes.length - lookback);
  const underlyingProxyEntryPrice = closes[lookbackStart];
  const technical = computePositionExitReadFixedLookback(ticker, underlyingProxyEntryPrice, chart, lookback, opts);
  const techErr = 'error' in technical ? technical.error : null;
  const techOk = techErr === null ? (technical as FixedLookbackExitRead) : null;

  let recommendation: string;
  let reason: string;
  if (daysToExpiry <= 0) {
    recommendation = 'EXPIRED';
    reason = 'Expiry date (' + expiryStr + ') has passed — this position should not still be open; '
      + 'check the Portfolio sheet.';
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
    reason = 'Inside the ' + expiryThreshold + '-day time-decay warning window (single, safer LEAPS-floor '
      + 'threshold used for all contracts -- no entry date on file to classify LEAPS vs short-term), '
      + 'independent of the underlying\'s own technical picture.';
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
    error: null, ticker, strike, expiryStr, avgPremium, daysToExpiry, expiryThreshold, expiryWarning,
    underlyingProxyEntryPrice, technical, recommendation, reason,
  };
}
