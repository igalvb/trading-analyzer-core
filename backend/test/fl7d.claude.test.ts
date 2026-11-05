/**
 * FL-7D part 2: the Claude (Opus) review client. There is NO legacy oracle
 * for it (greenfield), so it is verified three ways: against a scripted fake
 * SDK (every branch of mode, parsing, retry and failure), against the real
 * @anthropic-ai/sdk over a fake fetch (the wire request and error mapping),
 * and -- the one cross-check with legacy -- against the Gemini report the
 * ORACLE builds (Opus must be fed the same distilled report).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { legacyFilesPresent } from './oracle.ts';
import { genGeminiCase, captureOracleGemini } from './fl7dFixtures.ts';
import {
  reviewWithClaude, parseClaudeResponse, classifyClaudeError, claudeKeyFromEnv, buildClaudeRequest,
  CLAUDE_REVIEW_MODEL, CLAUDE_DISCLOSURE, CLAUDE_DEFAULT_MAX_TOKENS, DEFAULT_CLAUDE_RETRY_POLICY, CLAUDE_EFFORTS,
  type ClaudeSdk, type ClaudeRequest, type ClaudeResponse, type ClaudeCallOptions, type ClaudeReviewDeps, type ClaudeReviewResult,
  type ClaudeEffort, type GeminiOutcome, type ClaudeReviewOptions,
} from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_SYSTEM, CLAUDE_STANDALONE_SYSTEM } from '../src/ai/claudePrompts.ts';
import { createAnthropicSdk } from '../src/ai/claudeSdk.ts';
import { GEMINI_PROMPT_RULES } from '../src/fetch/ai/geminiReview.ts';

const ready = legacyFilesPresent();
// Made-up keys, built from parts so the file holds no secret-shaped text (generic guard R7); the code sees the whole key.
const KEY = 'sk-' + 'ant-test-0123456789abcdef';
const CASE = genGeminiCase(11);
const INPUTS = CASE.inputs;

type Step = { readonly response: unknown } | { readonly throws: unknown } | { readonly hang: true };

class FakeSdk implements ClaudeSdk {
  readonly requests: ClaudeRequest[] = [];
  readonly options: Array<ClaudeCallOptions | undefined> = [];
  private readonly steps: Step[];
  constructor(steps: Step[]) {
    this.steps = steps;
  }
  create(request: ClaudeRequest, options?: ClaudeCallOptions): Promise<ClaudeResponse> {
    this.requests.push(request);
    this.options.push(options);
    const step = this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)];
    if ('throws' in step) return Promise.reject(step.throws);
    if ('hang' in step) return new Promise<ClaudeResponse>(() => {});
    return Promise.resolve(step.response as ClaudeResponse);
  }
}

class SyncThrowSdk implements ClaudeSdk {
  calls = 0;
  create(): Promise<ClaudeResponse> {
    this.calls++;
    throw new Error('boom, synchronously');
  }
}

class ApiErr extends Error {
  status: number;
  headers: unknown;
  constructor(status: number, message: string, headers?: unknown) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.headers = headers;
  }
}

const okMsg = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: 'let me think' }, { type: 'text', text }],
  usage: { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
  ...extra,
});

const seenReasons = new Set<string>();
const seenModes = new Set<string>();
let truncatedSeen = false;
let successSeen = false;

function harness(sdk: ClaudeSdk, over: Partial<ClaudeReviewDeps> = {}) {
  const sleeps: number[] = [];
  const logs: Array<[string, string]> = [];
  let t = 0;
  const deps: ClaudeReviewDeps = {
    apiKey: KEY, sdk, getMacroRegime: () => CASE.macro, log: (l, m) => { logs.push([l, m]); },
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, now: () => (t += 10), ...over,
  };
  return { deps, sleeps, logs };
}

async function run(sdk: ClaudeSdk, gemini: GeminiOutcome, opts: Partial<ClaudeReviewOptions> = {}, over: Partial<ClaudeReviewDeps> = {}, inputs = INPUTS) {
  const h = harness(sdk, over);
  const result: ClaudeReviewResult = await reviewWithClaude(h.deps, inputs, gemini, { effort: 'low', ...opts });
  seenModes.add(result.mode);
  if (result.ok) { successSeen = true; if (result.truncated) truncatedSeen = true; } else seenReasons.add(result.reason);
  return { result, sdk, sleeps: h.sleeps, logs: h.logs };
}

function allKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

const GEMINI_OK: GeminiOutcome = { status: 'ok', text: 'AT A GLANCE\n- Gemini says it is fine.' };

describe('FL-7D — Claude (Opus) review client', () => {
  test('REVIEW mode: request shape, disclosure line, usage, and no forbidden parameters', async () => {
    const sdk = new FakeSdk([{ response: okMsg('CLAIM CHECK\n- all traced.') }]);
    const { result, logs } = await run(sdk, { status: 'ok', text: '  AT A GLANCE\n- Gemini says it is fine.  ' });
    assert.ok(result.ok);
    assert.equal(result.mode, 'REVIEW');
    assert.equal(result.disclosureLine, CLAUDE_DISCLOSURE.review);
    assert.equal(result.text, CLAUDE_DISCLOSURE.review + '\n\nCLAIM CHECK\n- all traced.');
    assert.equal(result.body, 'CLAIM CHECK\n- all traced.');
    assert.equal(result.truncated, false);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.model, 'claude-opus-5-5');
    assert.deepEqual(result.usage, { inputTokens: 3000, outputTokens: 1500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 0 });
    assert.equal(result.attempts, 1);

    assert.equal(sdk.requests.length, 1);
    const req = sdk.requests[0];
    assert.deepEqual(Object.keys(req).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(CLAUDE_REVIEW_MODEL, 'claude-opus-5-5');
    assert.equal(req.max_tokens, 3000);
    assert.equal(CLAUDE_DEFAULT_MAX_TOKENS, 3000);
    assert.deepEqual(req.output_config, { effort: 'low' });
    assert.equal(req.system.length, 1);
    assert.equal(req.system[0].text, CLAUDE_REVIEW_SYSTEM);
    assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
    assert.ok(req.messages[0].content.includes('<briefing>\nAT A GLANCE\n- Gemini says it is fine.\n</briefing>'), 'the Gemini text is passed trimmed');
    assert.ok(req.system[0].text.includes('fundamental.canonicalRevenueGrowthPct verbatim'), 'the revenue-growth clamp is inherited');
    for (const h of ['CLAIM CHECK', 'OVERSTATEMENT CHECK', 'OMISSION CHECK', 'DISAGREEMENT ADJUDICATION', 'FALSIFICATION TRIGGER', 'VERDICT']) assert.ok(req.system[0].text.includes(h + '\n'), h);
    const keys = allKeys(req);
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'budget_tokens', 'thinking']) assert.ok(!keys.has(forbidden), forbidden + ' must never be sent');
    assert.ok(!JSON.stringify(req).includes(KEY), 'the API key is not part of the request');
    assert.equal(sdk.options[0]?.timeout, DEFAULT_CLAUDE_RETRY_POLICY.timeoutMs);
    assert.ok(sdk.options[0]?.signal instanceof AbortSignal);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'info');
    assert.ok(logs[0][1].includes('cache_read=2000'));
  });

  test('STANDALONE mode: its own prompt, never mentions a review, and the disclosure names the real reason', async () => {
    const cases: Array<[GeminiOutcome, string]> = [
      [{ status: 'not-selected' }, CLAUDE_DISCLOSURE.standaloneNotSelected],
      [{ status: 'unavailable' }, CLAUDE_DISCLOSURE.standaloneUnavailable],
      [{ status: 'ok', text: '   \n ' }, CLAUDE_DISCLOSURE.standaloneUnavailable],
    ];
    for (const [gemini, line] of cases) {
      const sdk = new FakeSdk([{ response: okMsg('AT A GLANCE\n- standalone body.') }]);
      const { result } = await run(sdk, gemini);
      assert.ok(result.ok);
      assert.equal(result.mode, 'STANDALONE');
      assert.equal(result.disclosureLine, line);
      assert.ok(result.text.startsWith(line + '\n\n'));
      const req = sdk.requests[0];
      assert.equal(req.system[0].text, CLAUDE_STANDALONE_SYSTEM);
      assert.ok(req.system[0].text.includes(GEMINI_PROMPT_RULES), 'the two-score and revenue-growth constraints are inherited');
      assert.ok(req.system[0].text.includes('AT A GLANCE\n') && req.system[0].text.includes('BOTTOM LINE\n'));
      assert.ok(!/gemini|briefing to audit|audit/i.test(req.system[0].text + req.messages[0].content), 'STANDALONE must not reference a review that never happened');
      assert.ok(!req.messages[0].content.includes('<briefing>'));
    }
  });

  test('effort maps straight onto output_config.effort; model and max_tokens are overridable; bad values never reach the SDK', async () => {
    for (const effort of CLAUDE_EFFORTS) {
      const sdk = new FakeSdk([{ response: okMsg('x') }]);
      await run(sdk, GEMINI_OK, { effort });
      assert.deepEqual(sdk.requests[0].output_config, { effort });
    }
    const sdk = new FakeSdk([{ response: okMsg('x') }]);
    await run(sdk, GEMINI_OK, { model: 'claude-opus-test', maxTokens: 1234 });
    assert.equal(sdk.requests[0].model, 'claude-opus-test');
    assert.equal(sdk.requests[0].max_tokens, 1234);
    for (const bad of [{ effort: 'xhigh' }, { effort: 'max' }, { effort: undefined }, { effort: 'low', maxTokens: 0 }, { effort: 'low', maxTokens: 2.5 }]) {
      const s = new FakeSdk([{ response: okMsg('x') }]);
      const { result } = await run(s, GEMINI_OK, bad as unknown as Partial<ClaudeReviewOptions>);
      assert.ok(!result.ok && result.reason === 'invalid-request', JSON.stringify(bad));
      assert.equal(s.requests.length, 0);
    }
    const r = buildClaudeRequest({ model: 'm', maxTokens: 5, effort: 'high', mode: 'STANDALONE', userMessage: 'u' });
    assert.deepEqual(r.output_config, { effort: 'high' });
  });

  test('no API key: structured failure, SDK untouched, key name in the log only', async () => {
    const sdk = new FakeSdk([{ response: okMsg('x') }]);
    const { result, logs } = await run(sdk, GEMINI_OK, {}, { apiKey: '' });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'no-key');
    assert.equal(result.attempts, 0);
    assert.equal(sdk.requests.length, 0);
    assert.ok(result.detail.includes('ANTHROPIC_API_KEY'));
    assert.ok(!result.disclosure.includes('ANTHROPIC_API_KEY'), 'the report sentence carries no technical detail');
    assert.equal(logs[0][0], 'warn');
    assert.equal(claudeKeyFromEnv({}), '');
    assert.equal(claudeKeyFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x123456' }), 'sk-ant-x123456');
  });

  test('refusal arrives as HTTP 200: stop_reason is checked before content, which is never read', async () => {
    const sdk = new FakeSdk([{ response: okMsg('SECRET REFUSAL BODY', { stop_reason: 'refusal' }) }]);
    const { result } = await run(sdk, GEMINI_OK);
    assert.ok(!result.ok);
    assert.equal(result.reason, 'refusal');
    assert.equal(sdk.requests.length, 1, 'a refusal is not retried');
    assert.ok(!JSON.stringify(result).includes('SECRET REFUSAL BODY'));
    assert.ok(result.disclosure.includes('declined'));
  });

  test('response parsing: stop reasons, thinking blocks, truncation and garbage', async () => {
    const t = parseClaudeResponse(okMsg('  body  ', { stop_reason: 'max_tokens' }));
    assert.deepEqual(t, { ok: true, body: 'body', stopReason: 'max_tokens', truncated: true });
    assert.deepEqual(parseClaudeResponse(okMsg('a', { stop_reason: 'stop_sequence' })), { ok: true, body: 'a', stopReason: 'stop_sequence', truncated: false });
    const two = parseClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'one ' }, { type: 'thinking', thinking: 'x', text: 'NOT THIS' }, { type: 'text', text: 'two' }] });
    assert.deepEqual(two, { ok: true, body: 'one two', stopReason: 'end_turn', truncated: false });
    const garbage: unknown[] = [
      null, undefined, 5, 'x', {}, { stop_reason: 'end_turn' }, { stop_reason: 'end_turn', content: 'x' },
      { stop_reason: 'end_turn', content: [null, 5, { type: 'text' }, { type: 'text', text: 5 }, { type: 'thinking', thinking: 't' }] },
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'hi' }] }, { stop_reason: 'pause_turn' },
      { stop_reason: 'model_context_window_exceeded', content: [{ type: 'text', text: 'hi' }] }, { stop_reason: null, content: [{ type: 'text', text: 'hi' }] },
    ];
    const reasons = new Set<string>();
    for (const g of garbage) {
      const p = parseClaudeResponse(g);
      assert.ok(!p.ok, JSON.stringify(g));
      if (!p.ok) reasons.add(p.reason);
    }
    assert.deepEqual([...reasons].sort(), ['empty', 'unexpected-stop']);
    for (const g of garbage) {
      const { result } = await run(new FakeSdk([{ response: g }]), GEMINI_OK);
      assert.ok(!result.ok, 'through the client: ' + JSON.stringify(g));
    }
    const { result, logs } = await run(new FakeSdk([{ response: okMsg('cut off mid', { stop_reason: 'max_tokens' }) }]), GEMINI_OK);
    assert.ok(result.ok && result.truncated);
    assert.equal(logs[0][0], 'warn');
  });

  test('429 then 429 then success: retried with exponential backoff and jitter, 3 attempts', async () => {
    const sdk = new FakeSdk([{ throws: new ApiErr(429, 'rate limited') }, { throws: new ApiErr(429, 'rate limited') }, { response: okMsg('finally') }]);
    const { result, sleeps, logs } = await run(sdk, GEMINI_OK);
    assert.ok(result.ok);
    assert.equal(result.attempts, 3);
    assert.equal(sdk.requests.length, 3);
    assert.deepEqual(sleeps, [1500, 2500], 'backoffMs(1)=1000+500, backoffMs(2)=2000+500 with random()=0.5');
    assert.equal(logs.filter(([l]) => l === 'warn').length, 2);
  });

  test('transient failures exhaust after maxAttemptsTransient; 5xx, 529, connection errors and timeouts are all transient', async () => {
    const errs: unknown[] = [new ApiErr(500, 'oops'), new ApiErr(502, 'bad gateway'), new ApiErr(503, 'down'), new ApiErr(529, 'overloaded'), new ApiErr(408, 'slow'), Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }), Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }), Object.assign(new Error('socket'), { code: 'ECONNRESET' })];
    for (const e of errs) {
      const sdk = new FakeSdk([{ throws: e }]);
      const { result, sleeps } = await run(sdk, GEMINI_OK);
      assert.ok(!result.ok, String(e));
      assert.equal(result.reason, 'transient', String(e));
      assert.equal(result.attempts, DEFAULT_CLAUDE_RETRY_POLICY.maxAttemptsTransient);
      assert.equal(sdk.requests.length, 3);
      assert.equal(sleeps.length, 2);
    }
    const sdk = new FakeSdk([{ throws: new ApiErr(503, 'down') }]);
    const { result } = await run(sdk, GEMINI_OK, { retry: { maxAttemptsTransient: 5, baseDelayMs: 10, maxDelayMs: 100 } });
    assert.ok(!result.ok && result.attempts === 5);
  });

  test('Retry-After is honoured (seconds, ms, Headers object) and capped at maxDelayMs', async () => {
    const mk = (headers: unknown): FakeSdk => new FakeSdk([{ throws: new ApiErr(429, 'slow down', headers) }, { response: okMsg('x') }]);
    const cases: Array<[unknown, number]> = [
      [{ 'retry-after': '7' }, 7000], [{ 'retry-after-ms': '250' }, 1500], [{ 'retry-after-ms': '4000', 'retry-after': '1' }, 4000],
      [new Headers({ 'retry-after': '3' }), 3000], [{ 'retry-after': '600' }, 32000], [{ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, 1500], [undefined, 1500],
    ];
    for (const [headers, expected] of cases) {
      const { result, sleeps } = await run(mk(headers), GEMINI_OK);
      assert.ok(result.ok);
      assert.deepEqual(sleeps, [expected], JSON.stringify(headers));
    }
  });

  test('permanent failures (400, 401, 403, 404, 413) never retry; auth failures log at ERROR immediately', async () => {
    for (const status of [400, 401, 403, 404, 413]) {
      const sdk = new FakeSdk([{ throws: new ApiErr(status, 'nope ' + status) }]);
      const { result, sleeps, logs } = await run(sdk, GEMINI_OK);
      assert.ok(!result.ok, String(status));
      assert.equal(result.reason, 'permanent');
      assert.equal(result.status, status);
      assert.equal(result.attempts, 1);
      assert.equal(sdk.requests.length, 1, 'no retry storm');
      assert.deepEqual(sleeps, []);
      assert.equal(logs[logs.length - 1][0], status === 401 || status === 403 ? 'error' : 'warn');
      assert.ok(result.detail.startsWith('HTTP ' + status + ': '));
      assert.ok(!result.disclosure.includes(String(status)), 'no HTTP code in the report sentence');
    }
  });

  test('unclassified failures retry exactly once', async () => {
    const sdk = new FakeSdk([{ throws: new Error('something strange') }]);
    const { result, sleeps } = await run(sdk, GEMINI_OK);
    assert.ok(!result.ok);
    assert.equal(result.reason, 'unknown');
    assert.equal(result.attempts, 2);
    assert.equal(sdk.requests.length, 2);
    assert.deepEqual(sleeps, [1500]);
  });

  test('a hung call is aborted at the per-attempt timeout and retried as transient', async () => {
    const sdk = new FakeSdk([{ hang: true }]);
    const { result } = await run(sdk, GEMINI_OK, { retry: { timeoutMs: 15, maxAttemptsTransient: 2 } });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'transient');
    assert.equal(result.attempts, 2);
    assert.ok(result.detail.includes('exceeded its 15ms limit'));
    assert.equal(sdk.options.length, 2);
    assert.ok(sdk.options.every((o) => o?.signal?.aborted === true), 'every hung attempt was aborted');
    assert.equal(sdk.options[0]?.timeout, 15);
  });

  test('a synchronous SDK throw and a failing logger cannot escape', async () => {
    const sdk = new SyncThrowSdk();
    const { result } = await run(sdk, GEMINI_OK, {}, { log: () => { throw new Error('logger down'); } });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'unknown');
    assert.equal(sdk.calls, 2);
    assert.ok(result.detail.includes('boom, synchronously'));
  });

  test('malformed report inputs become a prompt-build failure; the SDK is never called', async () => {
    const sdk = new FakeSdk([{ response: okMsg('x') }]);
    const { result } = await run(sdk, GEMINI_OK, {}, {}, { ...INPUTS, chart: null } as unknown as typeof INPUTS);
    assert.ok(!result.ok);
    assert.equal(result.reason, 'prompt-build');
    assert.equal(result.attempts, 0);
    assert.equal(sdk.requests.length, 0);
    const macro = await run(new FakeSdk([{ response: okMsg('x') }]), GEMINI_OK, {}, { getMacroRegime: () => { throw new Error('macro cache exploded'); } });
    assert.ok(!macro.result.ok && macro.result.reason === 'prompt-build' && macro.result.detail.includes('macro cache exploded'));
  });

  test('secrets never leave: the key is scrubbed from the detail, the logs and the whole result', async () => {
    const sdk = new FakeSdk([{ throws: new ApiErr(400, 'invalid x-api-key ' + KEY + ' / sk-' + 'ant-api03-ABCdef_123-456') }]);
    const { result, logs } = await run(sdk, GEMINI_OK);
    assert.ok(!result.ok);
    assert.ok(result.detail.includes('REDACTED'));
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(!JSON.stringify(result).includes('sk-ant-api03'));
    assert.ok(!JSON.stringify(logs).includes(KEY));
    assert.ok(!JSON.stringify(logs).includes('sk-ant-api03'));
  });

  test('never throws: hostile thrown values and hostile SDK responses all end in a structured result', async () => {
    const hostile: unknown[] = [
      null, undefined, 'a string', 42, {}, [], Symbol('s'), new Error(''), { message: 5 }, Object.create(null),
      { get status(): number { throw new Error('status getter'); } }, { get message(): string { throw new Error('message getter'); } },
      new Proxy({}, { get() { throw new Error('trap'); } }), { status: 'x', headers: 7 }, { status: 429, headers: { get() { throw new Error('headers.get'); } } },
    ];
    for (const e of hostile) {
      const { result } = await run(new FakeSdk([{ throws: e }]), GEMINI_OK, { retry: { maxAttemptsTransient: 2 } });
      assert.equal(result.ok, false);
      assert.ok(result.attempts >= 1);
    }
    assert.deepEqual(classifyClaudeError(new Proxy({}, { get() { throw new Error('trap'); } })), { kind: 'unknown', status: null, retryAfterMs: null, authFailure: false });
  });

  test('the real @anthropic-ai/sdk over a fake fetch: wire request, SDK retries off, error mapping', async () => {
    const API_KEY = 'sk-' + 'ant-adapter-0123456789abcdef';
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [
      { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after': '2' } },
      { status: 200, body: okMsg('over the wire') },
    ];
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      const rep = replies[Math.min(calls.length, replies.length - 1)];
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'content-type': 'application/json', ...(rep.headers ?? {}) } });
    }) as unknown as typeof fetch;
    const sdk = createAnthropicSdk(API_KEY, { fetch: fakeFetch });
    const { result, sleeps } = await run(sdk, GEMINI_OK, { effort: 'medium' }, { apiKey: API_KEY });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.body, 'over the wire');
    assert.equal(calls.length, 2, 'one HTTP call per attempt: the SDK must not retry on its own');
    assert.deepEqual(sleeps, [2000], 'Retry-After from a real SDK error reached the policy');
    for (const c of calls) {
      assert.ok(c.url.startsWith('https://api.anthropic.com/v1/messages'), c.url);
      assert.equal(c.headers.get('x-api-key'), API_KEY);
      assert.equal(c.headers.get('anthropic-version'), '2023-06-01');
      // Row 38: the server-side refusal fallback (plan s8 Q4 = yes): `fallbacks: "default"` + its beta header; betas is not in the body.
      assert.deepEqual(Object.keys(c.body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
      assert.equal(c.body.fallbacks, 'default');
      assert.equal(c.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');      assert.deepEqual(c.body.output_config, { effort: 'medium' });
      assert.equal(c.body.model, 'claude-opus-5-5');
    }
    // 401 through the real SDK's error class: permanent, one call.
    calls.length = 0;
    replies.splice(0, replies.length, { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const auth = await run(createAnthropicSdk(API_KEY, { fetch: fakeFetch }), GEMINI_OK, {}, { apiKey: API_KEY });
    assert.ok(!auth.result.ok);
    assert.equal(auth.result.reason, 'permanent');
    assert.equal(auth.result.status, 401);
    assert.equal(calls.length, 1);
    // A refusal through the real SDK.
    calls.length = 0;
    replies.splice(0, replies.length, { status: 200, body: okMsg('REFUSED TEXT', { stop_reason: 'refusal' }) });
    const refusal = await run(createAnthropicSdk(API_KEY, { fetch: fakeFetch }), GEMINI_OK, {}, { apiKey: API_KEY });
    assert.ok(!refusal.result.ok && refusal.result.reason === 'refusal');
    // Row 38: Opus declined, the server-side fallback answered (a `fallback` block, then text; `model` = the fallback).
    calls.length = 0;
    replies.splice(0, replies.length, { status: 200, body: okMsg('fallback answer', { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: 'fallback answer' }] }) });
    const fb = await run(createAnthropicSdk(API_KEY, { fetch: fakeFetch }), GEMINI_OK, {}, { apiKey: API_KEY });
    assert.ok(fb.result.ok, JSON.stringify(fb.result));
    assert.equal(fb.result.body, 'fallback answer');
    assert.equal(fb.result.model, 'claude-opus-4-8');
    assert.ok(JSON.stringify(fb.logs).includes('answered by the fallback model claude-opus-4-8'));
    assert.equal(calls.length, 1);
  });

  test('cross-check with legacy: Opus is fed the SAME distilled report the oracle builds for Gemini', { skip: ready ? false : 'legacy/ not populated' }, async () => {
    let checked = 0;
    for (let seed = 0; seed < 24; seed++) {
      const c = genGeminiCase(seed);
      const cap = captureOracleGemini(c);
      assert.ok(cap);
      const prompt: string = JSON.parse(cap.payload).contents[0].parts[0].text;
      const marker = 'REPORT (JSON):\n';
      const reportJson = prompt.slice(prompt.indexOf(marker) + marker.length);
      const rev = new FakeSdk([{ response: okMsg('x') }]);
      await run(rev, GEMINI_OK, {}, { getMacroRegime: () => c.macro }, c.inputs);
      assert.ok(rev.requests[0].messages[0].content.startsWith('Ticker: ' + c.inputs.ticker + '\n\nREPORT (JSON):\n' + reportJson + '\n\nBRIEFING TO AUDIT'), 'REVIEW seed ' + seed);
      const sa = new FakeSdk([{ response: okMsg('x') }]);
      await run(sa, { status: 'unavailable' }, {}, { getMacroRegime: () => c.macro }, c.inputs);
      assert.equal(sa.requests[0].messages[0].content, 'Ticker: ' + c.inputs.ticker + '\n\nREPORT (JSON):\n' + reportJson, 'STANDALONE seed ' + seed);
      checked++;
    }
    assert.equal(checked, 24);
  });

  test('coverage guard: every mode, every failure reason, success and truncation were exercised', () => {
    assert.deepEqual([...seenModes].sort(), ['REVIEW', 'STANDALONE']);
    for (const r of ['no-key', 'invalid-request', 'prompt-build', 'refusal', 'empty', 'unexpected-stop', 'transient', 'permanent', 'unknown']) assert.ok(seenReasons.has(r), 'reason never produced: ' + r);
    assert.ok(successSeen && truncatedSeen);
    assert.deepEqual([...CLAUDE_EFFORTS], ['low', 'medium', 'high'] as ClaudeEffort[]);
  });
});
