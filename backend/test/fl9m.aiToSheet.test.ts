import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBuyAiInput, toExitAiInput } from '../src/ai/aiToSheet.ts';
import { OPUS_TRUNCATED_NOTE } from '../src/ai/aiDispatch.ts';
import type { AiBatchResult, AiTickerResult, GeminiLeg, OpusLeg } from '../src/ai/aiDispatch.ts';
import type { ClaudeUsage } from '../src/ai/claudeReview.ts';
import { EFFECTS, labelledReason } from '../src/reports/messages/catalog.ts';

const RAW = /https?:|:\/\/|Error:|\bat \S+ \(|\bstatus\b|\b[45]\d\d\b|ECONN|apikey|SECRET|HTTP|\.ts:\d+/i;
const CACHE = /\bcach(?:e|ed|es|ing)\b/i;
const usage = {} as unknown as ClaudeUsage;
const DISCLOSURE = 'This part was written by Claude Opus, an AI model, reviewing the Gemini summary.';
const at = new Date(Date.UTC(2026, 9, 24, 21, 0, 0));

const okOpus = (body = 'Opus body.', truncated = false): OpusLeg =>
  ({ state: 'ok', mode: 'REVIEW', disclosureLine: DISCLOSURE, body, truncated, model: 'm', usage });
const batch = (...rs: Array<{ t: string; g: GeminiLeg; o: OpusLeg }>): AiBatchResult => ({
  frame: 'buy',
  results: rs.map((r): AiTickerResult => ({ ticker: r.t, frame: 'buy', gemini: r.g, opus: r.o, lines: ['AI SUMMARY (GEMINI)', 'x'] })),
  totals: {} as never,
  scopeLines: [],
});

test('both ok: Gemini text kept, Opus disclosure line first then body, REVIEW mode, no technical headers', () => {
  const b = batch({ t: 'AAPL', g: { state: 'ok', text: 'Gemini says hold.' }, o: okOpus() });
  const x = toExitAiInput(b, { ranAt: at, switches: { gemini: true, opus: true }, effort: 'medium' });
  assert.equal(x.opusMode, 'REVIEW');
  assert.equal(x.geminiUsed, true);
  assert.equal(x.effort, 'medium');
  assert.equal(x.entries[0]!.gemini, 'Gemini says hold.');
  assert.equal(x.entries[0]!.opus, DISCLOSURE + '\n\nOpus body.');
  assert.ok(!/AI SUMMARY|CLAUDE OPUS/.test(String(x.entries[0]!.opus) + String(x.entries[0]!.gemini)));
});

test('truncated Opus answer is kept and marked', () => {
  const b = batch({ t: 'AAPL', g: { state: 'off' }, o: okOpus('Half a sen', true) });
  const e = toExitAiInput(b, { ranAt: at, switches: { gemini: false, opus: true } }).entries[0]!;
  assert.ok(String(e.opus).startsWith(DISCLOSURE));
  assert.ok(String(e.opus).includes('Half a sen'));
  assert.ok(String(e.opus).endsWith(OPUS_TRUNCATED_NOTE));
});

test('failed providers become plain catalog sentences, never raw errors', () => {
  const gLine = labelledReason('Gemini summary for AAPL', 'RATE_LIMIT') + ' ' + EFFECTS.SCORE_UNCHANGED;
  const oLine = labelledReason('Claude Opus review for AAPL', 'AI_REVIEW_UNAVAILABLE') + ' ' + EFFECTS.SCORE_UNCHANGED;
  const b = batch({ t: 'AAPL', g: { state: 'failed', reason: 'RATE_LIMIT', line: gLine }, o: { state: 'failed', reason: 'AI_REVIEW_UNAVAILABLE', line: oLine } });
  const e = toBuyAiInput(b, { ranAt: at, switches: { gemini: true, opus: true }, candidates: [{ ticker: 'AAPL', tier: 1 }] }).entries[0]!;
  assert.equal(e.gemini, gLine);
  assert.equal(e.opus, oLine);
  assert.doesNotMatch(String(e.gemini) + String(e.opus), RAW);
});

test('a leaking failure line is replaced by the fixed catalog sentence', () => {
  const dirty = 'Gemini summary for AAPL: HTTP 400 at https://api.example.com/v1?apikey=ABC';
  const b = batch({ t: 'AAPL', g: { state: 'failed', reason: 'AI_REVIEW_UNAVAILABLE', line: dirty }, o: { state: 'off' } });
  const e = toExitAiInput(b, { ranAt: at, switches: { gemini: true, opus: false } }).entries[0]!;
  assert.equal(e.gemini, labelledReason('Gemini summary for AAPL', 'AI_REVIEW_UNAVAILABLE'));
  assert.doesNotMatch(String(e.gemini), RAW);
});

test('modes: opus off = OFF; opus on, gemini off = STANDALONE with a reason; filtered note kept', () => {
  const b = batch({ t: 'AAPL', g: { state: 'off' }, o: { state: 'off', note: 'Claude Opus review was not run for this ticker.' } });
  const off = toExitAiInput(b, { ranAt: at, switches: { gemini: false, opus: false } });
  assert.equal(off.opusMode, 'OFF');
  assert.equal(off.geminiUsed, false);
  assert.equal(off.entries[0]!.gemini, null);
  assert.equal(off.entries[0]!.opus, 'Claude Opus review was not run for this ticker.');
  const sa = toExitAiInput(b, { ranAt: at, switches: { gemini: false, opus: true } });
  assert.equal(sa.opusMode, 'STANDALONE');
  assert.equal(sa.standaloneWhy, 'NOT_RUN');
});

test('buy input carries the candidates; effort defaults to null', () => {
  const b = batch({ t: 'NVDA', g: { state: 'ok', text: 'g' }, o: { state: 'off' } });
  const c = [{ ticker: 'NVDA', tier: 2 as const }, { ticker: 'AMD', tier: 3 as const }];
  const x = toBuyAiInput(b, { ranAt: at, switches: { gemini: true, opus: false }, candidates: c });
  assert.deepEqual(x.candidates, c);
  assert.equal(x.effort, null);
  assert.equal(x.entries.length, 1);
});

test('adapter-made text never contains cache wording', () => {
  const gLine = labelledReason('Gemini summary for AAPL', 'RATE_LIMIT') + ' ' + EFFECTS.SCORE_UNCHANGED;
  const b = batch({ t: 'AAPL', g: { state: 'failed', reason: 'RATE_LIMIT', line: gLine }, o: okOpus('Body.', true) });
  const e = toExitAiInput(b, { ranAt: at, switches: { gemini: true, opus: true } }).entries[0]!;
  assert.doesNotMatch(String(e.gemini) + String(e.opus), CACHE);
});
