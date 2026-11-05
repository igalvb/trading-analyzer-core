/**
 * The report message catalog. Report text is clean, short, plain English; the technical story (status codes, URLs,
 * exception text, attempts, durations) goes to the LOG only. Everything here is a fixed sentence chosen by a
 * reason code: classifyError() reads an error to PICK a code and never copies any of the error's text.
 */

import { HttpStatusError } from '../../net/http.ts';
import { TimeoutError, statusOf, messageOf } from '../../core/errors.ts';

export const REPORT_TIME_ZONE = 'America/New_York';

export const REASON_CODES = [
  'PROVIDER_NO_RESPONSE', 'RATE_LIMIT', 'NO_DATA_FOR_TICKER', 'SAVED_COPY_TOO_OLD', 'RESPONSE_UNREADABLE',
  'MARKET_CLOSED_OR_STALE', 'AI_REVIEW_UNAVAILABLE', 'EMAIL_NOT_SENT', 'SECTION_UNAVAILABLE', 'SHEET_UNREADABLE',
  'TABLE_EMPTY', 'FIELD_MISSING', 'INPUT_INVALID_ENTRY_PRICE', 'NOT_RUN', 'SHEET_LOCK_FAILED', 'SHEET_UNLOCK_FAILED',
  'NOT_SAVED_YET', 'LONG_ONLY_NOT_COVERED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Severity = 'Note' | 'Warning';

const REASONS: Readonly<Record<ReasonCode, { readonly clause: string; readonly severity: Severity }>> = {
  PROVIDER_NO_RESPONSE: { clause: 'the data provider did not respond', severity: 'Warning' },
  RATE_LIMIT: { clause: 'the request limit was reached', severity: 'Warning' },
  NO_DATA_FOR_TICKER: { clause: 'the provider returned no data for this ticker', severity: 'Warning' },
  SAVED_COPY_TOO_OLD: { clause: 'the saved copy is too old to trust', severity: 'Warning' },
  RESPONSE_UNREADABLE: { clause: 'the response could not be read', severity: 'Warning' },
  MARKET_CLOSED_OR_STALE: { clause: 'the latest price is from an earlier session', severity: 'Note' },
  AI_REVIEW_UNAVAILABLE: { clause: 'the AI review was not available', severity: 'Note' },
  EMAIL_NOT_SENT: { clause: 'the email could not be sent', severity: 'Warning' },
  SECTION_UNAVAILABLE: { clause: 'this section could not be built', severity: 'Warning' },
  SHEET_UNREADABLE: { clause: 'the sheet could not be read', severity: 'Warning' },
  TABLE_EMPTY: { clause: 'there are no rows to show', severity: 'Note' },
  FIELD_MISSING: { clause: 'the provider data is missing a needed value', severity: 'Warning' },
  INPUT_INVALID_ENTRY_PRICE: { clause: 'the entry price must be a positive number', severity: 'Warning' },
  NOT_RUN: { clause: 'this step did not run', severity: 'Note' },
  SHEET_LOCK_FAILED: { clause: 'the sheet tabs could not be locked again, so lock them with the Master Lock menu', severity: 'Warning' },
  SHEET_UNLOCK_FAILED: { clause: 'the sheet tabs could not be unlocked, so nothing was written', severity: 'Warning' },
  // L-2: a read with no usable saved copy (never saved, or not saved recently); the read cannot tell which.
  NOT_SAVED_YET: { clause: 'the nightly job has not saved a recent copy yet', severity: 'Warning' },
  LONG_ONLY_NOT_COVERED: { clause: 'not covered: this report handles long stocks and long calls only', severity: 'Note' },
};

/** The fixed effect sentences. dataQualityLines accepts only these keys, so no free text can reach a report. */
export const EFFECTS = {
  PRICE_CHART_ONLY: 'The score uses price and chart signals only.',
  SCORE_UNCHANGED: 'The score is not affected.',
  SECTION_LEFT_OUT: 'This section is left out of the report.',
  USES_SAVED_DATA: 'The score uses the saved data.',
  LOWER_CONFIDENCE: 'Treat the result with less confidence.',
  NO_AI_SUMMARY: 'The report has no AI summary.',
  NOT_EMAILED: 'The report is saved but was not emailed.',
  SOURCE_LEFT_OUT: 'This source is left out of the result.',
} as const;
export type EffectCode = keyof typeof EFFECTS;

function sentenceCase(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The reason as a lower-case clause with no final period, e.g. 'the request limit was reached'. */
export function reasonSentence(code: ReasonCode): string { return REASONS[code].clause; }
/** The reason as a finished sentence, e.g. 'The request limit was reached.' */
export function reasonLine(code: ReasonCode): string { return sentenceCase(REASONS[code].clause) + '.'; }
/** 'Note' or 'Warning'. Nothing else is ever shown. */
export function severityOf(code: ReasonCode): Severity { return REASONS[code].severity; }
/** One short line for a named part of a report, e.g. 'Exit ladder: This section could not be built.' */
export function labelledReason(label: string, code: ReasonCode): string { return label + ': ' + reasonLine(code); }

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/**
 * Picks a reason code for any thrown value. The error's text is read only to choose a code (rate-limit and
 * no-data wording from providers); it is never copied into the result. Unknown -> RESPONSE_UNREADABLE.
 */
export function classifyError(err: unknown): ReasonCode {
  if (err instanceof TimeoutError) return 'PROVIDER_NO_RESPONSE';
  if (err instanceof SyntaxError) return 'RESPONSE_UNREADABLE';
  const status = err instanceof HttpStatusError ? err.status : statusOf(err);
  if (status !== null) {
    if (status === 429) return 'RATE_LIMIT';
    if (status === 404 || status === 410) return 'NO_DATA_FOR_TICKER';
    if (status === 408 || status === 401 || status === 403 || status >= 500) return 'PROVIDER_NO_RESPONSE';
    return 'RESPONSE_UNREADABLE';
  }
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o['code'] === 'string' && NETWORK_CODES.has(o['code'])) return 'PROVIDER_NO_RESPONSE';
    if (o['name'] === 'AbortError' || o['name'] === 'TimeoutError') return 'PROVIDER_NO_RESPONSE';
  }
  const m = messageOf(err).toLowerCase();
  if (/limit reach|rate limit|quota exceeded|too many requests/.test(m)) return 'RATE_LIMIT';
  if (/\bno data\b|\bno results?\b|\bnot found\b|\bempty (?:response|result|data)\b/.test(m)) return 'NO_DATA_FOR_TICKER';
  if (/fetch failed|network|socket|timed? ?out|timeout/.test(m)) return 'PROVIDER_NO_RESPONSE';
  return 'RESPONSE_UNREADABLE';
}

export interface QualityItem {
  /** Plain source name, e.g. 'Fundamentals'. */
  readonly label: string;
  readonly reasonCode: ReasonCode;
  readonly effect: EffectCode;
  /** When saved data was reused: the day it was saved. */
  readonly savedDate?: Date;
  readonly now: Date;
}

function nyDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function nyShortDate(d: Date, now: Date): string {
  const sameYear = nyDay(d).slice(0, 4) === nyDay(now).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TIME_ZONE, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}
function ageDays(saved: Date, now: Date): number {
  const [y1, m1, d1] = nyDay(saved).split('-').map(Number);
  const [y2, m2, d2] = nyDay(now).split('-').map(Number);
  return Math.max(0, Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000));
}

/** 'Oct 12, 12 days old' (or 'Oct 24, saved today' / 'Oct 23, 1 day old'). Days are New York calendar days. */
export function dataAgeText(saved: Date, now: Date): string {
  const n = ageDays(saved, now);
  const age = n === 0 ? 'saved today' : n === 1 ? '1 day old' : n + ' days old';
  return nyShortDate(saved, now) + ', ' + age;
}

/** One line per issue. The effect text comes from the fixed EFFECTS list. */
export function dataQualityLine(item: QualityItem): string {
  const sev = severityOf(item.reasonCode);
  const effect = EFFECTS[item.effect];
  const validSaved = item.savedDate && !Number.isNaN(item.savedDate.getTime()) ? item.savedDate : undefined;
  if (!validSaved) return sev + ': ' + item.label + ': ' + reasonLine(item.reasonCode) + ' ' + effect;
  const age = dataAgeText(validSaved, item.now);
  if (item.reasonCode === 'SAVED_COPY_TOO_OLD') return sev + ': ' + item.label + ': The saved copy from ' + age + ' is too old to trust. ' + effect;
  return sev + ': ' + item.label + ' from ' + age + ', used because ' + reasonSentence(item.reasonCode) + '. ' + effect;
}

/** The compact per-ticker block: a 'Data quality' header, then one line per issue. */
export function dataQualityLines(items: readonly QualityItem[]): string[] {
  if (items.length === 0) return ['Data quality', 'No data issues.'];
  return ['Data quality', ...items.map(dataQualityLine)];
}
