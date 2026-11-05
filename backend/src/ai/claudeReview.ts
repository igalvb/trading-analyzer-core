/**
 * Claude (Opus) review client -- Phase 6, NEW (no legacy counterpart; the
 * plan is CHARACTERIZATION_PLAN_V13_dual_ai_gemini_opus s3-s5 and
 * CHARACTERIZATION_PLAN_claude_opus_integration s2). Not wired into any
 * pipeline.
 *
 * ══ CONTRACT ═══════════════════════════════════════════════════════════
 * reviewWithClaude NEVER throws. Every failure is a structured result with
 * a log-only `detail` (LogDetail) and a separate curated `disclosure`
 * sentence (ReportSentence) -- the type-level log/report split. Technical
 * detail (HTTP code, refusal, block reason) goes to the log only.
 *
 * ══ REQUEST ════════════════════════════════════════════════════════════
 * Built from the SDK-compatible subset ClaudeRequest: model, max_tokens,
 * system (one cached block), one user message, output_config.effort. By
 * construction there is no temperature, top_p, top_k, budget_tokens or
 * assistant prefill (all HTTP 400 on Opus 5), and no `thinking` key
 * (adaptive thinking is the default; the integration plan says not to set it).
 *
 * ══ RESPONSE ═══════════════════════════════════════════════════════════
 * stop_reason is checked BEFORE content is read: a refusal is HTTP 200.
 * Only `text` blocks are used (thinking blocks are skipped).
 *
 * ══ MODE + DISCLOSURE ══════════════════════════════════════════════════
 * REVIEW iff Gemini produced non-blank text; otherwise STANDALONE. The
 * first line of the returned text is the mode disclosure, prepended HERE
 * from the branch taken, not left to the prompt.
 *
 * ══ RETRY / TIMEOUT ════════════════════════════════════════════════════
 * core/errors classification: transient (429, 5xx incl. 529, network,
 * timeout) retries with truncated exponential backoff + jitter, honouring
 * Retry-After; permanent (400, 401, 403, 404, 413) never retries; unknown
 * retries once. Each attempt has its own timeout and abort signal. The
 * numbers in DEFAULT_CLAUDE_RETRY_POLICY are placeholders the plan docs do
 * not fix (OPEN QUESTIONS in the FL-7D handback).
 */

import { classify, statusOf, messageOf, TimeoutError, backoffMs, sleep as realSleep } from '../core/errors.ts';
import { logDetail, reportSentence, type FailureKind, type LogDetail, type ReportSentence } from '../core/result.ts';
import { buildGeminiReport, type FormatExpiry, type GeminiReviewInputs, type GetMacroRegime } from '../fetch/ai/geminiReview.ts';
import { buildClaudeUserMessage, claudeSystemFor, type ClaudeReviewMode } from './claudePrompts.ts';
import { framedReport, type AiFrame, type ExitPositionFacts } from './exitFraming.ts';

export type { ClaudeReviewMode } from './claudePrompts.ts';

/** The plan docs' model id (V13 dual-AI s3.1, integration plan s2). Confirm before going live (OPEN QUESTION). */
export const CLAUDE_REVIEW_MODEL = 'claude-opus-5-5';
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';
/** Integration plan s2's recommended starting value; thinking tokens count against it. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 3000;

/** Only these three are offered (dual-AI s3.2); xhigh and max exist on the API and are deliberately not exposed. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** An unset key is the empty string; reviewWithClaude then returns a 'no-key' failure without calling the SDK. */
export function claudeKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[CLAUDE_API_KEY_ENV] ?? '';
}

/** Dual-AI s4.3, verbatim. */
export const CLAUDE_DISCLOSURE = {
  review: 'Opus REVIEW mode — auditing the Gemini narrative above.',
  standaloneNotSelected: 'Opus STANDALONE mode — Gemini was not selected for this run, so this is Opus\'s own independent analysis rather than a review.',
  standaloneUnavailable: 'Opus STANDALONE mode — the Gemini narrative was unavailable for this ticker, so this is Opus\'s own independent analysis instead.',
} as const;

// ── SDK seam ────────────────────────────────────────────────────────────

export interface ClaudeRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: ReadonlyArray<{ readonly type: 'text'; readonly text: string; readonly cache_control: { readonly type: 'ephemeral' } }>;
  readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
  readonly output_config: { readonly effort: ClaudeEffort };
}

export interface ClaudeResponse {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly content?: unknown;
  readonly usage?: {
    readonly input_tokens?: number | null;
    readonly output_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  } | null;
}

export interface ClaudeCallOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

/** messages.create, as the review needs it. Tests inject a fake; production uses claudeSdk.ts. */
export interface ClaudeSdk {
  create(request: ClaudeRequest, options?: ClaudeCallOptions): Promise<ClaudeResponse>;
}

// ── results ─────────────────────────────────────────────────────────────

export type ClaudeLogLevel = 'info' | 'warn' | 'error';
export type ClaudeLog = (level: ClaudeLogLevel, message: string) => void;

export type GeminiOutcome =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'not-selected' }
  | { readonly status: 'unavailable' };

export type ClaudeFailureReason =
  | 'no-key' | 'invalid-request' | 'prompt-build'
  | 'refusal' | 'empty' | 'unexpected-stop'
  | 'transient' | 'permanent' | 'unknown';

export interface ClaudeUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

export interface ClaudeReviewSuccess {
  readonly ok: true;
  readonly mode: ClaudeReviewMode;
  /** The mandatory first line, as prepended to `text`. */
  readonly disclosureLine: string;
  /** disclosureLine + blank line + the model's text. */
  readonly text: string;
  /** The model's text alone. */
  readonly body: string;
  /** stop_reason was max_tokens: the text may end mid-thought (OPEN QUESTION: accept or fail). */
  readonly truncated: boolean;
  readonly stopReason: string;
  readonly model: string;
  readonly usage: ClaudeUsage;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface ClaudeReviewFailure {
  readonly ok: false;
  readonly mode: ClaudeReviewMode;
  readonly reason: ClaudeFailureReason;
  readonly status: number | null;
  /** Technical. Logs only; secrets scrubbed. */
  readonly detail: LogDetail;
  /** One clean sentence for the report. */
  readonly disclosure: ReportSentence;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export type ClaudeReviewResult = ClaudeReviewSuccess | ClaudeReviewFailure;

const FAILURE_SENTENCES: Readonly<Record<ClaudeFailureReason, string>> = {
  'no-key': 'The Claude Opus review is not enabled for this run (no API key is configured). Every number in this report is unaffected.',
  'invalid-request': 'The Claude Opus review could not be requested because of an internal settings problem. Every number in this report is unaffected.',
  'prompt-build': 'The Claude Opus review could not be prepared for this ticker. Every number in this report is unaffected.',
  'refusal': 'Claude Opus declined to review this ticker, so no second opinion is shown. Every number in this report is unaffected.',
  'empty': 'Claude Opus returned no review text for this ticker. Every number in this report is unaffected.',
  'unexpected-stop': 'Claude Opus did not finish its review for this ticker. Every number in this report is unaffected.',
  'transient': 'Claude Opus was temporarily unavailable for this ticker. Every number in this report is unaffected.',
  'permanent': 'Claude Opus could not provide a review for this ticker. Every number in this report is unaffected.',
  'unknown': 'Claude Opus could not provide a review for this ticker. Every number in this report is unaffected.',
};

// ── retry policy ────────────────────────────────────────────────────────

export interface ClaudeRetryPolicy {
  /** Total attempts for a transient failure (429, 5xx, network, timeout). */
  readonly maxAttemptsTransient: number;
  /** Total attempts for an unclassified failure ("retry once"). */
  readonly maxAttemptsUnknown: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Per attempt, thinking time included. */
  readonly timeoutMs: number;
}

export const DEFAULT_CLAUDE_RETRY_POLICY: ClaudeRetryPolicy = {
  maxAttemptsTransient: 3, maxAttemptsUnknown: 2, baseDelayMs: 1000, maxDelayMs: 32_000, timeoutMs: 120_000,
};

export interface ClaudeErrorClass {
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** 401 or 403: escalates to an ERROR log immediately. */
  readonly authFailure: boolean;
}

const EXTRA_TRANSIENT_STATUS = new Set([529]); // Anthropic "overloaded"
const EXTRA_PERMANENT_STATUS = new Set([413]);
const TRANSIENT_ERROR_NAMES = new Set(['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError']);

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const h = headers as Record<string, unknown>;
  if (typeof h.get === 'function') {
    const v = (h.get as (n: string) => unknown).call(h, name);
    return v == null ? null : String(v);
  }
  const v = h[name];
  return v == null ? null : String(v);
}

function retryAfterMsOf(e: unknown): number | null {
  const headers = (e as { headers?: unknown }).headers;
  const ms = Number(headerValue(headers, 'retry-after-ms'));
  if (headerValue(headers, 'retry-after-ms') !== null && isFinite(ms) && ms >= 0) return ms;
  const secs = Number(headerValue(headers, 'retry-after'));
  if (headerValue(headers, 'retry-after') !== null && isFinite(secs) && secs >= 0) return secs * 1000;
  return null;
}

/** Duck-typed on purpose (the SDK is injected): status, headers and name are all it reads. Never throws. */
export function classifyClaudeError(e: unknown): ClaudeErrorClass {
  try {
    const status = statusOf(e);
    const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
    const retryAfterMs = typeof e === 'object' && e !== null ? retryAfterMsOf(e) : null;
    const authFailure = status === 401 || status === 403;
    let kind: FailureKind;
    if (status !== null && EXTRA_TRANSIENT_STATUS.has(status)) kind = 'transient';
    else if (status !== null && EXTRA_PERMANENT_STATUS.has(status)) kind = 'permanent';
    else if (typeof name === 'string' && TRANSIENT_ERROR_NAMES.has(name)) kind = 'transient';
    else kind = classify(e);
    return { kind, status, retryAfterMs, authFailure };
  } catch {
    return { kind: 'unknown', status: null, retryAfterMs: null, authFailure: false };
  }
}

// ── request / response ──────────────────────────────────────────────────

export function buildClaudeRequest(args: {
  readonly model: string; readonly maxTokens: number; readonly effort: ClaudeEffort;
  readonly mode: ClaudeReviewMode; readonly userMessage: string; readonly frame?: AiFrame;
}): ClaudeRequest {
  return {
    model: args.model,
    max_tokens: args.maxTokens,
    system: [{ type: 'text', text: claudeSystemFor(args.mode, args.frame), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: args.userMessage }],
    output_config: { effort: args.effort },
  };
}

export type ParsedClaude =
  | { readonly ok: true; readonly body: string; readonly stopReason: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: 'refusal' | 'empty' | 'unexpected-stop'; readonly detail: string };

/** stop_reason first (a refusal is HTTP 200 and its content must not be read), then the text blocks. */
export function parseClaudeResponse(msg: unknown): ParsedClaude {
  const m = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>;
  const stop = m.stop_reason;
  if (stop === 'refusal') return { ok: false, reason: 'refusal', detail: 'stop_reason=refusal (HTTP 200); content not read' };
  if (stop !== 'end_turn' && stop !== 'stop_sequence' && stop !== 'max_tokens') {
    return { ok: false, reason: 'unexpected-stop', detail: 'stop_reason=' + String(stop) };
  }
  const blocks: unknown[] = Array.isArray(m.content) ? m.content : [];
  const body = blocks
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text).join('').trim();
  if (!body) return { ok: false, reason: 'empty', detail: 'no text content (stop_reason=' + stop + ', ' + blocks.length + ' block(s))' };
  return { ok: true, body, stopReason: stop, truncated: stop === 'max_tokens' };
}

function readUsage(u: unknown): ClaudeUsage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
  return { inputTokens: n(o.input_tokens), outputTokens: n(o.output_tokens), cacheReadInputTokens: n(o.cache_read_input_tokens), cacheCreationInputTokens: n(o.cache_creation_input_tokens) };
}

async function callOnce(sdk: ClaudeSdk, request: ClaudeRequest, timeoutMs: number): Promise<ClaudeResponse> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new TimeoutError(timeoutMs, 'claude-review')); }, timeoutMs);
  });
  // Promise.resolve().then turns a synchronous throw into a rejection; the
  // no-op catch marks a rejection that arrives after the timeout as handled.
  const call = Promise.resolve().then(() => sdk.create(request, { signal: ac.signal, timeout: timeoutMs }));
  call.catch(() => {});
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function safeMessage(e: unknown): string {
  try { return messageOf(e); } catch { return 'unprintable error'; }
}

export function scrubSecrets(text: string, apiKey: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('REDACTED');
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'REDACTED');
}

// ── one request, with the retry policy (shared by the review and the portfolio view) ──

export type ClaudeSendResult =
  | { readonly ok: true; readonly parsed: Extract<ParsedClaude, { ok: true }>; readonly response: ClaudeResponse; readonly usage: ClaudeUsage; readonly attempt: number }
  | { readonly ok: false; readonly reason: ClaudeFailureReason; readonly status: number | null; readonly detail: string; readonly attempts: number; readonly level: ClaudeLogLevel };

/**
 * Sends one request under the retry policy (transient retried with backoff and Retry-After, permanent never, unknown
 * once), then parses it (stop_reason first). Never throws for an SDK failure; `detail` is technical (log only).
 */
export async function sendClaudeRequest(sdk: ClaudeSdk, request: ClaudeRequest, policy: ClaudeRetryPolicy, o: {
  readonly sleep: (ms: number) => Promise<void>; readonly random: () => number; readonly apiKey: string; readonly label: string;
  readonly emit: (level: ClaudeLogLevel, message: string) => void;
}): Promise<ClaudeSendResult> {
  for (let attempt = 1; ; attempt++) {
    let response: ClaudeResponse;
    try {
      response = await callOnce(sdk, request, policy.timeoutMs);
    } catch (e) {
      const c = classifyClaudeError(e);
      const detail = (c.status !== null ? 'HTTP ' + c.status + ': ' : '') + safeMessage(e).substring(0, 300);
      const limit = c.kind === 'transient' ? policy.maxAttemptsTransient : c.kind === 'unknown' ? policy.maxAttemptsUnknown : 1;
      if (attempt >= limit) return { ok: false, reason: c.kind, status: c.status, detail, attempts: attempt, level: c.authFailure ? 'error' : 'warn' };
      const delay = Math.min(Math.max(backoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs, o.random), c.retryAfterMs ?? 0), policy.maxDelayMs);
      o.emit('warn', '  ' + o.label + ' attempt ' + attempt + ' failed (' + c.kind + '): ' + scrubSecrets(detail, o.apiKey) + ' -- retrying in ' + delay + 'ms');
      await o.sleep(delay);
      continue;
    }
    const parsed = parseClaudeResponse(response);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, status: null, detail: parsed.detail, attempts: attempt, level: 'warn' };
    return { ok: true, parsed, response, usage: readUsage(response && response.usage), attempt };
  }
}

// ── the review ──────────────────────────────────────────────────────────

export interface ClaudeReviewDeps {
  /** Env ANTHROPIC_API_KEY (claudeKeyFromEnv). Empty -> a 'no-key' failure, no SDK call. */
  readonly apiKey: string;
  readonly sdk: ClaudeSdk;
  /** The same getCachedMacroRegime_ seam the Gemini review takes. */
  readonly getMacroRegime: GetMacroRegime;
  readonly formatExpiry?: FormatExpiry;
  /** B3: the report's options block in plain labels (GeminiReportOptions). */
  readonly plainLabels?: boolean;
  readonly log?: ClaudeLog;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface ClaudeReviewOptions {
  /** The user's dispatch choice; no default on purpose. */
  readonly effort: ClaudeEffort;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly retry?: Partial<ClaudeRetryPolicy>;
  readonly frame?: AiFrame;
  readonly exitFacts?: ExitPositionFacts;
}

export async function reviewWithClaude(deps: ClaudeReviewDeps, inputs: GeminiReviewInputs, gemini: GeminiOutcome, options: ClaudeReviewOptions): Promise<ClaudeReviewResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const startedAt = now();
  const emit = (level: ClaudeLogLevel, message: string): void => {
    try { if (deps.log) deps.log(level, message); } catch { /* a failing logger must not fail the review */ }
  };

  const geminiText = gemini.status === 'ok' && typeof gemini.text === 'string' ? gemini.text.trim() : '';
  const mode: ClaudeReviewMode = geminiText ? 'REVIEW' : 'STANDALONE';
  const disclosureLine = mode === 'REVIEW' ? CLAUDE_DISCLOSURE.review
    : gemini.status === 'not-selected' ? CLAUDE_DISCLOSURE.standaloneNotSelected : CLAUDE_DISCLOSURE.standaloneUnavailable;

  const failure = (reason: ClaudeFailureReason, status: number | null, detail: string, attempts: number, level: ClaudeLogLevel = 'warn'): ClaudeReviewFailure => {
    const d = scrubSecrets(detail, deps.apiKey);
    emit(level, '  Claude Opus (' + mode + ') ' + reason + ' after ' + attempts + ' attempt(s): ' + d);
    return { ok: false, mode, reason, status, detail: logDetail(d), disclosure: reportSentence(FAILURE_SENTENCES[reason]), attempts, elapsedMs: now() - startedAt };
  };

  try {
    if (!deps.apiKey) return failure('no-key', null, CLAUDE_API_KEY_ENV + ' is not set', 0);
    const effort = options.effort;
    if (!(CLAUDE_EFFORTS as readonly string[]).includes(effort)) return failure('invalid-request', null, 'unsupported effort: ' + String(effort), 0);
    const model = options.model ?? CLAUDE_REVIEW_MODEL;
    const maxTokens = options.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) return failure('invalid-request', null, 'unsupported max_tokens: ' + String(maxTokens), 0);
    const policy: ClaudeRetryPolicy = { ...DEFAULT_CLAUDE_RETRY_POLICY, ...(options.retry ?? {}) };

    let request: ClaudeRequest;
    try {
      const report = await buildGeminiReport(inputs, deps.getMacroRegime, deps.formatExpiry, { plainLabels: deps.plainLabels });
      request = buildClaudeRequest({ model, maxTokens, effort, mode, frame: options.frame, userMessage: buildClaudeUserMessage(mode, inputs.ticker, framedReport(options.frame ?? 'buy', report, options.exitFacts), geminiText) });
    } catch (e) {
      return failure('prompt-build', null, safeMessage(e), 0);
    }

    const sent = await sendClaudeRequest(deps.sdk, request, policy, { sleep, random, apiKey: deps.apiKey, label: 'Claude Opus (' + mode + ')', emit });
    if (!sent.ok) return failure(sent.reason, sent.status, sent.detail, sent.attempts, sent.level);
    const { parsed, response, usage, attempt } = sent;
    const elapsedMs = now() - startedAt;
    emit(parsed.truncated ? 'warn' : 'info', '  Claude Opus (' + mode + ') review received (' + parsed.body.length + ' chars, stop=' + parsed.stopReason + ') [' + attempt + ' attempt(s), ' + elapsedMs +
      'ms, in=' + usage.inputTokens + ' out=' + usage.outputTokens + ' cache_read=' + usage.cacheReadInputTokens + ' cache_write=' + usage.cacheCreationInputTokens + ']');
    // Row 38: the server-side refusal fallback (claudeSdk.ts) answered with another model; the log says which.
    if (typeof response.model === 'string' && response.model && !response.model.startsWith(model)) emit('info', '  Claude Opus (' + mode + ') declined; answered by the fallback model ' + response.model);
    return {
      ok: true, mode, disclosureLine, text: disclosureLine + '\n\n' + parsed.body, body: parsed.body, truncated: parsed.truncated,
      stopReason: parsed.stopReason, model: typeof response.model === 'string' ? response.model : model, usage, attempts: attempt, elapsedMs,
    };
  } catch (e) {
    return failure('unknown', null, 'unexpected: ' + safeMessage(e), 0);
  }
}
