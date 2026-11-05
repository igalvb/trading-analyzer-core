/**
 * Gemini transport seam + 429 retry layer -- NEW (legacy fetchGeminiReviewV7,
 * dataLayerV1.gs:119-283, made ONE call and returned null on any non-200;
 * it had no retry). The response parsing is a port of geminiReview.ts
 * fetchGeminiReview (:312-334): non-200, no candidate (blockReason), empty
 * text, then stripStrayMarkdown (dataLayerV1.gs:279).
 *
 * The retry is a fix outside model logic, so it sits behind a named flag:
 * `retry429` (default TRUE = fixed). `retry429: false` is the legacy-parity
 * mode: exactly one attempt. The API key lives in the transport adapter only
 * (injected parameter); this layer never sees it, and log detail is scrubbed.
 *
 * NEVER throws: every failure is a structured result (reason + log-only detail).
 */

import { classify, messageOf, backoffMs, sleep as realSleep } from '../core/errors.ts';
import { logDetail, type LogDetail } from '../core/result.ts';
import { GEMINI_ENDPOINT, GEMINI_MODEL, buildGeminiPayload, stripStrayMarkdown } from '../fetch/ai/geminiReview.ts';
import type { HttpClient } from '../net/http.ts';

export interface GeminiTransportRequest {
  readonly model: string;
  readonly body: ReturnType<typeof buildGeminiPayload>;
  readonly timeoutMs?: number;
}

export interface GeminiTransportResponse {
  readonly status: number;
  readonly text: string;
  /** From a Retry-After header, in ms, when the provider sent one. */
  readonly retryAfterMs?: number | null;
}

export interface GeminiTransport {
  /** False when no API key is configured: the layer then fails fast without calling generate. */
  readonly configured?: boolean;
  generate(req: GeminiTransportRequest): Promise<GeminiTransportResponse>;
}

export type GeminiFailureReason = 'no-key' | 'rate-limit' | 'http' | 'network' | 'blocked' | 'empty' | 'unreadable';

export type GeminiGenResult =
  | { readonly ok: true; readonly text: string; readonly attempts: number }
  | { readonly ok: false; readonly reason: GeminiFailureReason; readonly status: number | null; readonly detail: LogDetail; readonly attempts: number };

export interface GeminiRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}

/** Placeholders the plan does not fix (open question 5 in the FL-9a report). */
export const DEFAULT_GEMINI_RETRY_POLICY: GeminiRetryPolicy = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 32_000, timeoutMs: 60_000 };

export interface GeminiGenDeps {
  readonly transport: GeminiTransport;
  readonly model?: string;
  /** Named flag, default true. false = legacy parity (one attempt). */
  readonly retry429?: boolean;
  readonly policy?: Partial<GeminiRetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (level: 'info' | 'warn', message: string) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function scrubGemini(s: string): string {
  return s.replace(/key=[^&\s"']+/gi, 'key=REDACTED').replace(/AIza[0-9A-Za-z_-]{20,}/g, 'REDACTED');
}

type Parsed = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'blocked' | 'empty' | 'unreadable'; readonly detail: string };

function parseGeminiBody(text: string): Parsed {
  let json: any;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: 'unreadable', detail: 'response was not valid JSON' }; }
  const cand = json && json.candidates && json.candidates[0];
  if (!cand) {
    const fb = json && json.promptFeedback && json.promptFeedback.blockReason;
    return { ok: false, reason: 'blocked', detail: 'no candidate' + (fb ? ' (blocked: ' + String(fb) + ')' : '') };
  }
  let out = '';
  if (cand.content && cand.content.parts) out = cand.content.parts.map((p: any) => p.text || '').join('').trim();
  if (!out) return { ok: false, reason: 'empty', detail: 'empty text' };
  return { ok: true, text: stripStrayMarkdown(out) };
}

export async function generateGeminiText(deps: GeminiGenDeps, prompt: string): Promise<GeminiGenResult> {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const policy: GeminiRetryPolicy = { ...DEFAULT_GEMINI_RETRY_POLICY, ...(deps.policy ?? {}) };
  const maxAttempts = deps.retry429 === false ? 1 : Math.max(1, policy.maxAttempts);
  const emit = (level: 'info' | 'warn', m: string): void => { try { if (deps.log) deps.log(level, m); } catch { /* logger must not fail the call */ } };
  const fail = (reason: GeminiFailureReason, status: number | null, detail: string, attempts: number): GeminiGenResult =>
    ({ ok: false, reason, status, detail: logDetail(scrubGemini(detail)), attempts });

  if (deps.transport.configured === false) return fail('no-key', null, 'GEMINI_API_KEY is not set', 0);

  const body = buildGeminiPayload(prompt);
  const model = deps.model ?? GEMINI_MODEL;

  for (let attempt = 1; ; attempt++) {
    let res: GeminiTransportResponse;
    try {
      res = await deps.transport.generate({ model, body, timeoutMs: policy.timeoutMs });
    } catch (e) {
      const kind = classify(e);
      const detail = messageOf(e).substring(0, 200);
      if (kind !== 'transient' || attempt >= maxAttempts) return fail('network', null, detail, attempt);
      const delay = Math.min(backoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs, random), policy.maxDelayMs);
      emit('warn', '  Gemini attempt ' + attempt + ' failed (transient): ' + scrubGemini(detail) + ' -- retrying in ' + delay + 'ms');
      await sleep(delay);
      continue;
    }

    if (res.status !== 200) {
      const detail = 'HTTP ' + res.status + ': ' + String(res.text).substring(0, 120);
      const reason: GeminiFailureReason = res.status === 429 ? 'rate-limit' : 'http';
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= maxAttempts) return fail(reason, res.status, detail, attempt);
      const base = backoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs, random);
      const delay = Math.min(Math.max(base, res.retryAfterMs ?? 0), policy.maxDelayMs);
      emit('warn', '  Gemini attempt ' + attempt + ' got ' + scrubGemini(detail).substring(0, 60) + ' -- retrying in ' + delay + 'ms');
      await sleep(delay);
      continue;
    }

    const parsed = parseGeminiBody(res.text);
    if (!parsed.ok) return fail(parsed.reason, 200, parsed.detail, attempt);
    emit('info', '  Gemini review received (' + parsed.text.length + ' chars) [' + attempt + ' attempt(s)]');
    return { ok: true, text: parsed.text, attempts: attempt };
  }
}

function retryAfterOf(headers: Readonly<Record<string, string>> | undefined): number | null {
  if (!headers) return null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'retry-after') {
      const secs = Number(headers[k]);
      return isFinite(secs) && secs >= 0 ? secs * 1000 : null;
    }
  }
  return null;
}

/** Production adapter over the project's HttpClient. The key is a parameter (env GEMINI_API_KEY via geminiKeyFromEnv). */
export function createGeminiHttpTransport(http: HttpClient, apiKey: string): GeminiTransport {
  return {
    configured: apiKey !== '',
    async generate(req: GeminiTransportRequest): Promise<GeminiTransportResponse> {
      const url = GEMINI_ENDPOINT + req.model + ':generateContent?key=' + encodeURIComponent(apiKey);
      const res = await http.fetch({ url, method: 'POST', contentType: 'application/json', payload: JSON.stringify(req.body), muteHttpExceptions: true, timeoutMs: req.timeoutMs });
      return { status: res.status, text: res.text(), retryAfterMs: retryAfterOf(res.headers) };
    },
  };
}
