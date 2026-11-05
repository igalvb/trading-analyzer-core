/**
 * Owner decision 2026-11-01: Analyze (one stock) asks Claude Opus for a second opinion after Gemini
 * (src/ai/analyzeOpus.ts). Offline: memory storage, the FL-7c fixtures, a fake Claude SDK.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { runTickerJob, type TickerJob } from '../src/ticker.ts';
import { telegramSummary } from '../src/analyzeReport.ts';
import { ANALYSIS_TAB } from '../src/analysis/runTicker.ts';
import { ANALYZE_OPUS_NO_KEY, opusVerdict } from '../src/ai/analyzeOpus.ts';
import { CLAUDE_REVIEW_MODEL, type ClaudeRequest, type ClaudeSdk } from '../src/ai/claudeReview.ts';

const ready = fixturesPresent();
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };
const KEY = 'fake-anthropic-test-key-0123456789';

class FakeNet implements HttpTransport {
  readonly urls: string[] = [];
  private readonly bodies: Record<string, string>;
  constructor(bodies: Record<string, string>) { this.bodies = bodies; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1] as string) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}

const OPUS_TEXT = 'BOTTOM LINE\n- Opus fake view of TSLA.\n\nVERDICT\n- AGREE WITH CAVEATS. Fine.';

function fakeSdk(behaviour: 'ok' | 'throw' = 'ok'): ClaudeSdk & { calls: ClaudeRequest[] } {
  const calls: ClaudeRequest[] = [];
  return {
    calls,
    async create(req) {
      calls.push(req);
      if (behaviour === 'throw') throw Object.assign(new Error('bad request'), { status: 400 });
      return { model: CLAUDE_REVIEW_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: OPUS_TEXT }], usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

const quiet = { out: () => {}, err: () => {} };

async function run(args: readonly string[], env: Record<string, string>, sdk?: ClaudeSdk): Promise<TickerJob> {
  return runTickerJob(['TSLA', '--memory', '--stock-only', ...args], { ...quiet, env: { ...ENV, ...env } }, {
    transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), ...(sdk ? { claudeSdk: sdk } : {}),
  });
}

function tabText(job: TickerJob): string {
  const sh = job.workbook!.getSheetByName(ANALYSIS_TAB)!;
  return sh.getDataRange().getValues().map((r) => r.join(' ')).join('\n');
}

describe('Analyze: Claude Opus second opinion', { skip: ready ? false : 'fixtures missing' }, () => {
  test('opusVerdict reads the VERDICT line', () => {
    assert.equal(opusVerdict(OPUS_TEXT), 'AGREE WITH CAVEATS');
    assert.equal(opusVerdict('VERDICT\n- DISAGREE. No.'), 'DISAGREE');
    assert.equal(opusVerdict('no verdict here'), null);
  });

  test('with a key: Opus answers, its view sits under Gemini on the Analysis page; numbers unchanged', async () => {
    const sdk = fakeSdk();
    const job = await run(['--opus'], { ANTHROPIC_API_KEY: KEY }, sdk);
    const plain = await run([], {});
    assert.equal(job.code, 0);
    assert.equal(sdk.calls.length, 1);
    assert.equal(sdk.calls[0]!.model, CLAUDE_REVIEW_MODEL);
    assert.equal(job.art!.opusReview!.state, 'ok');
    const text = tabText(job);
    assert.ok(text.indexOf('AI ANALYST REVIEW') < text.indexOf('AI SECOND OPINION  (Claude Opus)'), 'Opus right after Gemini');
    assert.match(text, /Opus fake view of TSLA/);
    assert.match(job.art!.opusReview!.summary, /Opus second opinion/);
    assert.match(telegramSummary(job), /🧠 Opus second opinion/);
    // display only: every score and decision is the same as the run without Opus
    assert.deepEqual(job.art!.result!.decision, plain.art!.result!.decision);
    assert.deepEqual(job.art!.result!.fundResult.score, plain.art!.result!.fundResult.score);
    assert.ok(!tabText(plain).includes('AI SECOND OPINION'), 'no section without --opus');
    assert.equal(plain.art!.opusReview, undefined);
  });

  test('no Anthropic key: no call, one plain line, the run goes on', async () => {
    const sdk = fakeSdk();
    const job = await run(['--opus'], {}, sdk);
    assert.equal(job.code, 0);
    assert.equal(sdk.calls.length, 0);
    assert.equal(job.art!.opusReview!.summary, ANALYZE_OPUS_NO_KEY);
    assert.ok(tabText(job).includes(ANALYZE_OPUS_NO_KEY));
    assert.ok(telegramSummary(job).includes(ANALYZE_OPUS_NO_KEY));
  });

  test('Opus fails: one plain line, never fails the run, no technical text in the report', async () => {
    const job = await run(['--opus'], { ANTHROPIC_API_KEY: KEY }, fakeSdk('throw'));
    assert.equal(job.code, 0);
    assert.equal(job.art!.opusReview!.state, 'failed');
    const text = tabText(job);
    assert.match(text, /Claude Opus review for TSLA/);
    assert.ok(!/HTTP 400|bad request/.test(text), 'technical detail stays in the log');
  });

  test('--no-ai with --opus: Opus is not called', async () => {
    const sdk = fakeSdk();
    const job = await run(['--opus', '--no-ai'], { ANTHROPIC_API_KEY: KEY }, sdk);
    assert.equal(sdk.calls.length, 0);
    assert.equal(job.art!.opusReview!.state, 'off');
  });
});
