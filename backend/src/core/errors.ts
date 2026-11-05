/**
 * Failure classification -- decides whether retrying could plausibly help.
 *
 * Deliberately starts small. The default for anything unrecognised is
 * 'unknown', which retries exactly once. That is the user's own stated
 * fallback ("if that is complicated than just retry always") applied as the
 * default, which means the system behaves sensibly with an almost-empty
 * classifier and improves as real failure modes are observed.
 */

import type { FailureKind } from './result.ts';

/** HTTP statuses that are worth retrying. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** HTTP statuses where retrying is pure waste. */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 410, 422]);

/**
 * Network-level error codes that mean "try again", not "this is broken".
 * Node surfaces these on the error object as `code`.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Body substrings that indicate rate limiting even when the status does not.
 *
 * Not hypothetical: legacy/dataLayerV1.gs:1134 detects FMP rate limiting by
 * looking for the literal string "Limit Reach" in the response body, because
 * FMP does not always return 429.
 */
const TRANSIENT_BODY_MARKERS = ['limit reach', 'rate limit', 'quota exceeded', 'too many requests', 'try again later'];

export function statusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  for (const k of ['status', 'code', 'statusCode']) {
    const v = o[k];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  const response = o['response'];
  if (typeof response === 'object' && response !== null) {
    const s = (response as Record<string, unknown>)['status'];
    if (typeof s === 'number') return s;
  }
  return null;
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const m = (e as Record<string, unknown>)['message'];
    if (typeof m === 'string') return m;
  }
  return String(e);
}

export function classify(e: unknown): FailureKind {
  if (e instanceof TimeoutError) return 'transient';

  const status = statusOf(e);
  if (status !== null) {
    if (TRANSIENT_STATUS.has(status)) return 'transient';
    if (PERMANENT_STATUS.has(status)) return 'permanent';
  }

  if (typeof e === 'object' && e !== null) {
    const code = (e as Record<string, unknown>)['code'];
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';
  }

  const msg = messageOf(e).toLowerCase();
  if (TRANSIENT_BODY_MARKERS.some((m) => msg.includes(m))) return 'transient';

  // "Ticker not found" and friends: retrying cannot invent data that
  // does not exist. Kept narrow deliberately -- a wrong 'permanent' call
  // silently drops recoverable data, which is worse than a wasted retry.
  if (msg.includes('not found') && status === null) return 'permanent';

  return 'unknown';
}

/** Raised when a step exceeds its own time limit. Always transient. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, label: string) {
    super(`step "${label}" exceeded its ${timeoutMs}ms limit`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Truncated exponential backoff with jitter, per Google's documented
 * formula: min((2^n) + random_ms, maximum_backoff).
 *
 * The jitter matters: without it, N parallel callers that hit the same 429
 * all retry at the same instant and collide again.
 */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 32_000, rand: () => number = Math.random): number {
  const exponential = Math.pow(2, Math.max(0, attempt - 1)) * baseMs;
  const jitter = Math.floor(rand() * 1000);
  return Math.min(exponential + jitter, maxMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
