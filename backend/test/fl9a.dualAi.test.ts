/**
 * FL-9a: dual-AI wiring. Fake transports only; no network, no keys.
 * Exit-frame Opus tests depend on the claudeReview.ts patch (frame + exitFacts options).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { LogLine } from '../src/core/logger.ts';
import type { GeminiReviewInputs } from '../src/fetch/ai/geminiReview.ts';
import { buildGeminiPrompt, buildGeminiReport } from '../src/fetch/ai/geminiReview.ts';
import type { ClaudeRequest, ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_MODEL, CLAUDE_DISCLOSURE } from '../src/ai/claudeReview.ts';
import { generateGeminiText, type GeminiTransport, type GeminiTransportRequest, type GeminiTransportResponse } from '../src/ai/geminiTransport.ts';
import { buildGeminiBuyPrompt, buildGeminiExitPrompt, framedReport, type ExitPositionFacts } from '../src/ai/exitFraming.ts';
import { claudeSystemFor } from '../src/ai/claudePrompts.ts';
import {
  OPUS_TRUNCATED_NOTE, parseAiInputs, runAiBatch, runAiForTicker, type AiDispatchDeps, type AiSideSwitches, type AiTickerRequest,
} from '../src/ai/aiDispatch.ts';

const RAW = /https?:|:\/\/|Error:|\bat \S+ \(|\bstatus\b|\b[45]\d\d\b|ECONN|apikey|SECRET|HTTP/i;

const FACTS: ExitPositionFacts = { entryPrice: 100, currentPrice: 130, unrealizedPct: 30, trailingStop: 120, afterTaxPct: 22.5, taxRatePct: 25 };

function inputs(ticker: string): GeminiReviewInputs {
  return {
    ticker, fundResult: { score: 7, verdict: 'Good', profile: 'GENERAL', drivers: [] }, techPlan: { techScore: 6, regime: 'UP', timing: 'WAIT' },
    decision: { action: 'HOLD', finalConviction: 60 }, ind: {}, fund: null, chart: { currentPrice: 130 }, optAnalysis: null,
  };
}
const req = (ticker: string, withFacts = false): AiTickerRequest => ({ ticker, inputs: inputs(ticker), ...(withFacts ? { exitFacts: FACTS } : {}) });

const gOk = (text: string): GeminiTransportResponse => ({ status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) });

function geminiScript(script: Array<GeminiTransportResponse | Error>, seen: GeminiTransportRequest[] = []): GeminiTransport {
  let i = 0;
  return {
    async generate(r) {
      seen.push(r);
      const step = script[Math.min(i++, script.length - 1)] as GeminiTransportResponse | Error;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function claudeFake(over: { stop?: string; text?: string; fail?: (r: ClaudeRequest, n: number) => Error | null } = {}) {
  const requests: ClaudeRequest[] = [];
  const sdk: ClaudeSdk = {
    async create(r): Promise<ClaudeResponse> {
      requests.push(r);
      const e = over.fail ? over.fail(r, requests.length) : null;
      if (e) throw e;
      return { stop_reason: over.stop ?? 'end_turn', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: over.text ?? 'OPUS BODY' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, model: CLAUDE_REVIEW_MODEL };
    },
  };
  return { sdk, requests };
}

function mk(mode: 'ai' | 'nightly' = 'ai') {
  const lines: LogLine[] = [];
  const sleeps: number[] = [];
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'ai', now: () => new Date(0) });
  const ctx = createContext({ mode, runId: 'r1', logger: log, clock: { now: () => 1000 }, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  return { ctx, lines, sleeps };
}

function deps(over: Partial<AiDispatchDeps> & { gemini?: GeminiTransport; sdk?: ClaudeSdk; mode?: 'ai' | 'nightly' } = {}) {
  const m = mk(over.mode ?? 'ai');
  const d: AiDispatchDeps = {
    ctx: m.ctx, geminiTransport: over.gemini ?? geminiScript([gOk('GEM **text**')]), claudeSdk: over.sdk ?? claudeFake().sdk,
    claudeApiKey: 'k-test-123456', getMacroRegime: () => null, ...over,
  };
  return { d, ...m };
}

const BOTH: AiSideSwitches = { gemini: true, opus: true };

test('parseAiInputs: defaults, combos, bad values', () => {
  const def = parseAiInputs({});
  assert.ok(def.ok);
  if (def.ok) { assert.equal(def.plan.effort, 'medium'); assert.equal(def.plan.buy, null); assert.equal(def.plan.exit, null); }
  const p = parseAiInputs({ buy: 'true', buy_opus: 'true', exit: 'true', exit_gemini: 'false', effort: 'high' });
  assert.ok(p.ok);
  if (p.ok) { assert.deepEqual(p.plan.buy, { gemini: true, opus: true }); assert.deepEqual(p.plan.exit, { gemini: false, opus: false }); assert.equal(p.plan.effort, 'high'); }
  const bad = parseAiInputs({ effort: 'max' });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.doesNotMatch(bad.message, RAW);
  assert.ok(!parseAiInputs({ buy: 'maybe' }).ok);
});

test('gemini 429: retries, honours Retry-After, then succeeds', async () => {
  const seen: GeminiTransportRequest[] = [];
  const sleeps: number[] = [];
  const t = geminiScript([{ status: 429, text: 'slow down', retryAfterMs: 5000 }, { status: 429, text: 'slow down' }, gOk('fine **x**')], seen);
  const r = await generateGeminiText({ transport: t, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 }, 'PROMPT');
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.attempts, 3); assert.equal(r.text, 'fine x'); }
  assert.equal(sleeps.length, 2);
  assert.ok((sleeps[0] as number) >= 5000);
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.model, 'gemini-flash-lite-latest');
  assert.deepEqual(seen[0]?.body.generationConfig, { temperature: 0.4, maxOutputTokens: 1024 });
});

test('gemini 429 exhausted -> rate-limit; retry429 false -> one attempt (legacy parity)', async () => {
  const t = geminiScript([{ status: 429, text: 'x' }]);
  const a = await generateGeminiText({ transport: t, sleep: async () => {}, random: () => 0 }, 'P');
  assert.ok(!a.ok);
  if (!a.ok) { assert.equal(a.reason, 'rate-limit'); assert.equal(a.attempts, 4); }
  const b = await generateGeminiText({ transport: t, retry429: false, sleep: async () => {}, random: () => 0 }, 'P');
  assert.ok(!b.ok);
  if (!b.ok) assert.equal(b.attempts, 1);
});

test('gemini: 400 never retries; blocked/empty/unreadable/no-key/network mapped; key scrubbed', async () => {
  let r = await generateGeminiText({ transport: geminiScript([{ status: 400, text: 'bad' }]), sleep: async () => {} }, 'P');
  assert.ok(!r.ok && r.reason === 'http' && r.attempts === 1);
  r = await generateGeminiText({ transport: geminiScript([{ status: 200, text: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) }]), sleep: async () => {} }, 'P');
  assert.ok(!r.ok && r.reason === 'blocked');
  r = await generateGeminiText({ transport: geminiScript([gOk('   ')]), sleep: async () => {} }, 'P');
  assert.ok(!r.ok && r.reason === 'empty');
  r = await generateGeminiText({ transport: geminiScript([{ status: 200, text: 'not json' }]), sleep: async () => {} }, 'P');
  assert.ok(!r.ok && r.reason === 'unreadable');
  let called = 0;
  r = await generateGeminiText({ transport: { configured: false, async generate() { called++; return gOk('x'); } }, sleep: async () => {} }, 'P');
  assert.ok(!r.ok && r.reason === 'no-key' && called === 0);
  r = await generateGeminiText({ transport: geminiScript([Object.assign(new Error('fetch failed?key=AIzaSyAAAAAAAAAAAAAAAAAAAAAA'), { code: 'ECONNRESET' })]), sleep: async () => {}, random: () => 0 }, 'P');
  assert.ok(!r.ok && r.reason === 'network');
  if (!r.ok) assert.doesNotMatch(String(r.detail), /AIza/);
});

test('prompts: buy is the legacy prompt; exit is hold/trim/exit and forbids buying', () => {
  const report = { ticker: 'AAA', price: 1 };
  assert.equal(buildGeminiBuyPrompt('AAA', report), buildGeminiPrompt('AAA', report));
  const x = buildGeminiExitPrompt('AAA', report);
  assert.match(x, /ALREADY HOLDS/);
  assert.match(x, /MUST NOT recommend buying/);
  for (const h of ['WHAT\'S CHANGED SINCE ENTRY', 'THE EXIT CASE', 'TAX\n- the after-tax figure', '25% of the gain', 'canonicalRevenueGrowthPct', 'not tax advice']) assert.ok(x.includes(h), h);
  assert.doesNotMatch(x, /holding period|days held|holding term/i);
  assert.doesNotMatch(x, /THE TIMING \(IS NOW A GOOD TIME TO BUY\?\)/);
  assert.throws(() => framedReport('exit', report));
  assert.equal(framedReport('buy', report), report);
  assert.equal(framedReport('exit', report, FACTS)['position'].entryPrice, 100);
  assert.equal(claudeSystemFor('REVIEW'), claudeSystemFor('REVIEW', 'buy'));
  assert.match(claudeSystemFor('STANDALONE', 'exit'), /MUST NOT recommend buying/);
  assert.doesNotMatch(claudeSystemFor('STANDALONE', 'exit'), /audit/i);
  assert.match(claudeSystemFor('REVIEW', 'exit'), /AUDIT/);
});

test('both on -> Gemini then Opus REVIEW, disclosure first, effort + model passed, no banned params', async () => {
  const c = claudeFake();
  const { d } = deps({ sdk: c.sdk });
  const r = await runAiForTicker(d, 'buy', req('AAA'), BOTH, 'low');
  assert.equal(r.gemini.state, 'ok');
  assert.equal(r.opus.state, 'ok');
  if (r.opus.state === 'ok') { assert.equal(r.opus.mode, 'REVIEW'); assert.equal(r.opus.disclosureLine, CLAUDE_DISCLOSURE.review); }
  const q = c.requests[0] as ClaudeRequest;
  assert.equal(q.model, 'claude-opus-5-5');
  assert.deepEqual(q.output_config, { effort: 'low' });
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(k in q), k);
  assert.match(q.system[0]?.text ?? '', /AUDIT/);
  assert.match(q.messages[0]?.content ?? '', /<briefing>[\s\S]*GEM text[\s\S]*<\/briefing>/);
  const i = r.lines.indexOf(CLAUDE_DISCLOSURE.review);
  assert.ok(i > 0);
  assert.equal(r.lines[0], 'AI SUMMARY (GEMINI)');
});

test('gemini off -> STANDALONE "not selected"; no briefing in request; no Gemini call', async () => {
  const seen: GeminiTransportRequest[] = [];
  const c = claudeFake();
  const { d } = deps({ gemini: geminiScript([gOk('x')], seen), sdk: c.sdk });
  const r = await runAiForTicker(d, 'buy', req('AAA'), { gemini: false, opus: true }, 'medium');
  assert.equal(seen.length, 0);
  assert.equal(r.gemini.state, 'off');
  if (r.opus.state === 'ok') { assert.equal(r.opus.mode, 'STANDALONE'); assert.equal(r.opus.disclosureLine, CLAUDE_DISCLOSURE.standaloneNotSelected); } else assert.fail('opus should be ok');
  assert.doesNotMatch(c.requests[0]?.system[0]?.text ?? '', /audit/i);
  assert.doesNotMatch(c.requests[0]?.messages[0]?.content ?? '', /briefing/i);
});

test('gemini fails (400) -> STANDALONE "unavailable"; Gemini failure line is plain catalog text', async () => {
  const { d } = deps({ gemini: geminiScript([{ status: 400, text: 'bad' }]) });
  const r = await runAiForTicker(d, 'buy', req('AAA'), BOTH, 'high');
  assert.equal(r.gemini.state, 'failed');
  if (r.gemini.state === 'failed') {
    assert.equal(r.gemini.line, 'Gemini summary for AAA: The AI review was not available. The score is not affected.');
    assert.doesNotMatch(r.gemini.line, RAW);
  }
  if (r.opus.state === 'ok') { assert.equal(r.opus.mode, 'STANDALONE'); assert.equal(r.opus.disclosureLine, CLAUDE_DISCLOSURE.standaloneUnavailable); } else assert.fail('opus should run standalone');
});

test('gemini 429 exhaustion shows the request-limit wording, never a code', async () => {
  const { d } = deps({ gemini: geminiScript([{ status: 429, text: 'x' }]) });
  const r = await runAiForTicker(d, 'buy', req('AAA'), { gemini: true, opus: false }, 'medium');
  assert.equal(r.gemini.state, 'failed');
  assert.equal(r.lines[0], 'Gemini summary for AAA: The request limit was reached. The score is not affected.');
  assert.doesNotMatch(r.lines.join('\n'), RAW);
});

test('Opus truncated (max_tokens): answer kept and marked', async () => {
  const c = claudeFake({ stop: 'max_tokens', text: 'partial thou' });
  const { d } = deps({ sdk: c.sdk });
  const r = await runAiForTicker(d, 'buy', req('AAA'), { gemini: false, opus: true }, 'medium');
  assert.equal(r.opus.state, 'ok');
  if (r.opus.state === 'ok') { assert.equal(r.opus.truncated, true); assert.equal(r.opus.body, 'partial thou'); }
  assert.ok(r.lines.includes('partial thou'));
  assert.ok(r.lines.includes(OPUS_TRUNCATED_NOTE));
  assert.doesNotMatch(OPUS_TRUNCATED_NOTE, RAW);
  const full = await runAiForTicker(deps({ sdk: claudeFake().sdk }).d, 'buy', req('AAA'), { gemini: false, opus: true }, 'medium');
  assert.ok(!full.lines.includes(OPUS_TRUNCATED_NOTE));
});

test('both off: no calls, no lines; one off each way', async () => {
  const seen: GeminiTransportRequest[] = [];
  const c = claudeFake();
  const { d } = deps({ gemini: geminiScript([gOk('G')], seen), sdk: c.sdk });
  const none = await runAiForTicker(d, 'buy', req('AAA'), { gemini: false, opus: false }, 'medium');
  assert.equal(seen.length + c.requests.length, 0);
  assert.deepEqual(none.lines, []);
  const gOnly = await runAiForTicker(d, 'buy', req('AAA'), { gemini: true, opus: false }, 'medium');
  assert.equal(c.requests.length, 0);
  assert.equal(gOnly.gemini.state, 'ok');
  assert.equal(gOnly.opus.state, 'off');
});

test('Opus failures degrade only the Opus leg, in plain words (429, refusal)', async () => {
  const rl = claudeFake({ fail: () => Object.assign(new Error('HTTP 429 rate limited'), { status: 429 }) });
  const a = await runAiForTicker(deps({ sdk: rl.sdk, claudeRetry: { maxAttemptsTransient: 1 } }).d, 'buy', req('AAA'), BOTH, 'medium');
  assert.equal(a.gemini.state, 'ok');
  assert.equal(a.opus.state, 'failed');
  if (a.opus.state === 'failed') { assert.equal(a.opus.line, 'Claude Opus review for AAA: The request limit was reached. The score is not affected.'); assert.doesNotMatch(a.opus.line, RAW); }
  const refuse = claudeFake({ stop: 'refusal' });
  const b = await runAiForTicker(deps({ sdk: refuse.sdk }).d, 'buy', req('AAA'), BOTH, 'medium');
  assert.equal(b.opus.state, 'failed');
  assert.doesNotMatch(b.lines.join('\n').replace(/AI SUMMARY[\s\S]*?\n\n/, ''), RAW);
});

test('transient Opus 429 then success retries inside the review', async () => {
  const c = claudeFake({ fail: (_r, n) => (n === 1 ? Object.assign(new Error('slow'), { status: 429 }) : null) });
  const { d, sleeps } = deps({ sdk: c.sdk });
  const r = await runAiForTicker(d, 'buy', req('AAA'), { gemini: false, opus: true }, 'medium');
  assert.equal(r.opus.state, 'ok');
  assert.equal(c.requests.length, 2);
  assert.ok(sleeps.length >= 1);
});

test('batch: one ticker failing degrades only that ticker', async () => {
  const t: GeminiTransport = {
    async generate(r) {
      const text = r.body.contents[0]?.parts[0]?.text ?? '';
      return text.includes('"ticker":"BBB"') ? { status: 400, text: 'bad' } : gOk('summary');
    },
  };
  const { d } = deps({ gemini: t });
  const b = await runAiBatch(d, 'buy', [req('AAA'), req('BBB'), req('CCC')], { gemini: true, opus: false }, 'medium');
  assert.deepEqual(b.results.map((x) => x.gemini.state), ['ok', 'failed', 'ok']);
  assert.equal(b.totals.geminiOk, 2);
  assert.equal(b.totals.geminiFailed, 1);
  assert.equal(b.scopeLines[0], 'AI analysis covered: AAA, CCC.');
  assert.match(b.scopeLines[1] ?? '', /^Not covered: BBB\. Gemini summary for BBB: The AI review was not available\./);
  assert.doesNotMatch(b.scopeLines.join('\n'), RAW);
});

test('batch: bounded concurrency, order kept, token totals summed', async () => {
  let inflight = 0, peak = 0;
  const t: GeminiTransport = {
    async generate() { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setImmediate(r)); inflight--; return gOk('s'); },
  };
  const { d } = deps({ gemini: t });
  const reqs = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => req(x));
  const b = await runAiBatch(d, 'buy', reqs, BOTH, 'medium', { concurrency: 2 });
  assert.ok(peak <= 2, 'peak ' + peak);
  assert.deepEqual(b.results.map((x) => x.ticker), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(b.totals.opusOk, 6);
  assert.equal(b.totals.inputTokens, 60);
  assert.equal(b.totals.cacheReadTokens, 12);
});

test('batch: opusFilter skips Opus with a plain note; none selected -> scope says so', async () => {
  const c = claudeFake();
  const { d } = deps({ sdk: c.sdk });
  const b = await runAiBatch(d, 'buy', [req('AAA'), req('BBB')], BOTH, 'medium', { opusFilter: (t) => t === 'AAA' });
  assert.equal(c.requests.length, 1);
  assert.equal(b.results[1]?.opus.state, 'off');
  assert.ok((b.results[1]?.lines ?? []).includes('Claude Opus review was not run for this ticker.'));
  const n = await runAiBatch(d, 'buy', [req('AAA')], { gemini: false, opus: false }, 'medium');
  assert.deepEqual(n.scopeLines, ['AI analysis was not selected for this report.']);
});

test('nightly mode: zero AI calls (asserted)', async () => {
  const seen: GeminiTransportRequest[] = [];
  const c = claudeFake();
  const { d } = deps({ mode: 'nightly', gemini: geminiScript([gOk('x')], seen), sdk: c.sdk });
  const r = await runAiForTicker(d, 'buy', req('AAA'), BOTH, 'medium');
  assert.equal(seen.length + c.requests.length, 0);
  assert.deepEqual(r.lines, []);
});

test('exit frame: needs facts; with facts uses exit prompts and a position block (requires claudeReview patch)', async () => {
  const seen: GeminiTransportRequest[] = [];
  const c = claudeFake();
  const { d } = deps({ gemini: geminiScript([gOk('exit summary')], seen), sdk: c.sdk });
  const missing = await runAiForTicker(d, 'exit', req('AAA', false), BOTH, 'medium');
  assert.equal(missing.gemini.state, 'failed');
  assert.equal(missing.opus.state, 'failed');
  assert.doesNotMatch(missing.lines.join('\n'), RAW);

  const ok = await runAiForTicker(d, 'exit', req('AAA', true), BOTH, 'medium');
  assert.equal(ok.gemini.state, 'ok');
  assert.equal(ok.opus.state, 'ok');
  assert.match(seen[seen.length - 1]?.body.contents[0]?.parts[0]?.text ?? '', /ALREADY HOLDS[\s\S]*"position":\{"entryPrice":100/);
  const q = c.requests[c.requests.length - 1] as ClaudeRequest;
  assert.match(q.system[0]?.text ?? '', /MUST NOT recommend buying/);
  assert.match(q.messages[0]?.content ?? '', /"position":\{"entryPrice":100/);
});

test('exit report matches buy report plus position (distilled report reused, not rebuilt)', async () => {
  const rep = await buildGeminiReport(inputs('AAA'), () => null);
  const ex = framedReport('exit', rep, FACTS);
  const { position, ...rest } = ex;
  assert.deepEqual(rest, rep);
  assert.equal(position.taxRatePct, 25);
  assert.ok(!('holdingTerm' in position) && !('holdingDays' in position));
  assert.equal(position.bitcoinEtfSharedThesis, false);
});

test('technical detail reaches the log only, never the report lines', async () => {
  const { d, lines } = deps({ gemini: geminiScript([{ status: 503, text: 'overloaded https://example.test/x?key=AIzaSyAAAAAAAAAAAAAAAAAAAAAA' }]), geminiPolicy: { maxAttempts: 2 } });
  const r = await runAiForTicker(d, 'buy', req('AAA'), { gemini: true, opus: false }, 'medium');
  assert.doesNotMatch(r.lines.join('\n'), RAW);
  const logged = JSON.stringify(lines);
  assert.match(logged, /503/);
  assert.doesNotMatch(logged, /AIzaSy/);
});
