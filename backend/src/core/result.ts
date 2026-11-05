/**
 * StepResult<T> -- the return type of every real step in this system.
 *
 * A discriminated union, so TypeScript REFUSES to let you read `.value`
 * without first checking `.ok`. With strictNullChecks on, this makes the
 * single most common bug class in the legacy codebase -- a value that was
 * silently null because an upstream fetch quietly failed -- structurally
 * unrepresentable rather than merely discouraged.
 */

/**
 * Whether retrying could plausibly change the outcome.
 *
 * Grounded in failure modes this system has actually experienced, not
 * invented ones. See legacy/dataLayerV1.gs:683 (transient rate limit,
 * deliberately not cached), :755-767 (SEC outage misread as "no holders"),
 * :1134 (FMP 429), :1519-1525 (Nasdaq + FMP both down).
 */
export type FailureKind = 'transient' | 'permanent' | 'unknown';

/**
 * A branded string that may ONLY appear in logs, never in report text.
 *
 * The brand exists to enforce the log-vs-report separation rule at COMPILE
 * TIME: report renderers accept only `ReportSentence`, so passing a
 * `LogDetail` into report output is a type error, not something a reviewer
 * has to catch. The brand is type-level only and erases at runtime, so it
 * is compatible with `erasableSyntaxOnly`.
 */
export type LogDetail = string & { readonly __brand: 'LogDetail' };

/**
 * A curated, human-readable sentence intended for the user-facing report.
 *
 * One clean sentence, no jargon, no internal error text. Written by the
 * person who knows what the failure means, at the moment the step is
 * written -- not retrofitted later by someone guessing.
 */
export type ReportSentence = string & { readonly __brand: 'ReportSentence' };

/** Marks a technical string as log-only. */
export function logDetail(s: string): LogDetail {
  return s as LogDetail;
}

/** Marks a curated human sentence as safe for report output. */
export function reportSentence(s: string): ReportSentence {
  return s as ReportSentence;
}

export interface StepError {
  readonly kind: FailureKind;
  /** Short technical summary. Log-facing only. */
  readonly detail: LogDetail;
  /** The curated sentence shown to the user. */
  readonly disclosure: ReportSentence;
  /** How many attempts were made in total (1 = no retry happened). */
  readonly attempts: number;
  /** The original thrown value, if any. Never rendered anywhere. */
  readonly cause?: unknown;
}

export type StepResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StepError };

export function ok<T>(value: T): StepResult<T> {
  return { ok: true, value };
}

export function err<T>(error: StepError): StepResult<T> {
  return { ok: false, error };
}

/**
 * Returns the value if the step succeeded, otherwise a caller-supplied
 * fallback. The explicit fallback is the point: there is no way to
 * accidentally get `undefined` out of a failed step.
 */
export function valueOr<T>(r: StepResult<T>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * "No data, and that is fine" is DELIBERATELY distinct from "failure".
 *
 * Conflating them is a real bug this codebase has already suffered:
 * legacy/dataLayerV1.gs:755-771 documents an all-null 13F result caused by
 * a transient SEC outage being persisted as a genuine "this ticker has no
 * institutional holders" finding -- poisoning the stored data for an entire
 * quarter. A step that legitimately found nothing returns ok(null).
 */
export type Maybe<T> = T | null;
