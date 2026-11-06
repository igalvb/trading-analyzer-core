/**
 * Plan item #47 (owner 2026-11-04: KEEP): the portfolio-wide Claude Opus view in the AI run (ai/portfolioOpus.ts).
 * One extra Opus call when the Exit Opus box is ticked; it reads the whole Exit report and its text is shown first in
 * the AI SUMMARIES section (headline in the top status line) and sent to Telegram. Display only. Fake SDK throughout.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { ClaudeRequest, ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_MODEL } from '../src/ai/claudeReview.ts';
import {
  PORTFOLIO_SYSTEM_PROMPT, PORTFOLIO_VIEW_DISCLOSURE, PORTFOLIO_VIEW_FAILED, PORTFOLIO_VIEW_NO_KEY, PORTFOLIO_VIEW_TITLE,
  exitReadText, portfolioHeadline, portfolioOpusView,
} from '../src/ai/portfolioOpus.ts';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { composeServices, type Services } from '../src/compose.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import { runAiApp, aiInputsFromEnv, sendPortfolioView } from '../src/ai.ts';
import { parseAiInputs } from '../src/ai/aiDispatch.ts';
import type { GeminiTransport } from '../src/ai/geminiTransport.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { EXIT_SHEET_TAB, AI_ANCHOR } from '../src/reports/exitSheet/exitSheet.ts';
import { savedPortfolioView } from '../src/sendExit.ts';

const FAKE_KEY = 'test-key-not-real';
const BODY = [
  'IN ONE LINE',
  'Most of the money rides on one bet: the Bitcoin price.',
  'CONCENTRATION',
  'TSLA is the largest position.',
  'CORRELATED BETS',
  'IBIT and MSTR move together with Bitcoin.',
  'BIGGEST RISKS',
  'A Bitcoin drop hits several rows at once.',
  'WHAT TO TRIM FIRST',
  'Look at the miners first.',
].join('\n');

function fakeSdk(o: { body?: string; stop?: string; model?: string; throws?: unknown } = {}) {
  const requests: ClaudeRequest[] = [];
  const sdk: ClaudeSdk = {
    async create(req: ClaudeRequest): Promise<ClaudeResponse> {
      requests.push(req);
      if (o.throws) throw o.throws;
      const portfolio = req.system[0]?.text === PORTFOLIO_SYSTEM_PROMPT;
      return {
        stop_reason: o.stop ?? 'end_turn', model: o.model ?? CLAUDE_REVIEW_MODEL,
        content: [{ type: 'text', text: portfolio ? (o.body ?? BODY) : 'Opus review.' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  };
  return { sdk, requests };
}

function ctxOf(mode: 'ai' | 'nightly' = 'ai') {
  const log = new Logger({ sink: () => {}, scope: 'ai', now: () => new Date(0) });
  return createContext({ mode, runId: 'r47', logger: log, clock: { now: () => 1000 }, sleep: async () => {}, random: () => 0 });
}

describe('Plan #47: the portfolio view (unit, fake SDK)', () => {
  test('exitReadText: one line per non-empty row, cells joined, capped', () => {
    assert.equal(exitReadText([['A', '', ' b  c '], ['', ''], [1, null, 'x']]), 'A | b c\n1 | x');
    assert.ok(exitReadText([['x'.repeat(50)]], 10).startsWith('xxxxxxxxxx\n[the rest of the report was cut'));
  });

  test('portfolioHeadline: the IN ONE LINE sentence, on its own line or after a colon', () => {
    assert.equal(portfolioHeadline(BODY), 'Most of the money rides on one bet: the Bitcoin price.');
    assert.equal(portfolioHeadline('IN ONE LINE: Too much Bitcoin.\nCONCENTRATION\nx'), 'Too much Bitcoin.');
    assert.equal(portfolioHeadline('CONCENTRATION\nx'), null);
  });

  test('ok: one request on claude-opus-5-5 with the portfolio prompt and the whole Exit read; disclosure first; headline; Telegram text', async () => {
    const { sdk, requests } = fakeSdk();
    const v = await portfolioOpusView({ ctx: ctxOf(), apiKey: FAKE_KEY, sdk }, 'TSLA | HOLD\nIBIT | TRIM', 'medium');
    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.equal(r.model, CLAUDE_REVIEW_MODEL);
    assert.equal(r.model, 'claude-opus-5-5');
    assert.equal(r.output_config.effort, 'medium');
    assert.equal(r.system[0]!.text, PORTFOLIO_SYSTEM_PROMPT);
    assert.ok(r.messages[0]!.content.includes('TSLA | HOLD\nIBIT | TRIM'));
    for (const k of ['CONCENTRATION', 'CORRELATED BETS', 'Bitcoin', 'BIGGEST RISKS', 'WHAT TO TRIM FIRST']) assert.ok(PORTFOLIO_SYSTEM_PROMPT.includes(k), k);
    assert.equal(v.state, 'ok');
    assert.equal(v.paragraphs[0], PORTFOLIO_VIEW_DISCLOSURE);
    assert.ok(v.paragraphs.includes('Look at the miners first.'));
    assert.equal(v.headline, 'Most of the money rides on one bet: the Bitcoin price.');
    assert.ok(v.telegram.startsWith('📊 ' + PORTFOLIO_VIEW_TITLE));
    assert.ok(v.telegram.includes('IBIT and MSTR move together with Bitcoin.'));
  });

  test('no key: no call, one plain line', async () => {
    const { sdk, requests } = fakeSdk();
    const v = await portfolioOpusView({ ctx: ctxOf(), apiKey: '', sdk }, 'TSLA | HOLD', 'low');
    assert.equal(requests.length, 0);
    assert.equal(v.state, 'off');
    assert.deepEqual(v.paragraphs, [PORTFOLIO_VIEW_NO_KEY]);
    assert.equal(v.telegram, PORTFOLIO_VIEW_NO_KEY);
  });

  test('refusal (after the server-side fallback also declined) and a permanent error: one plain line, never thrown', async () => {
    const refused = await portfolioOpusView({ ctx: ctxOf(), apiKey: FAKE_KEY, sdk: fakeSdk({ stop: 'refusal' }).sdk }, 'x', 'low');
    assert.equal(refused.state, 'failed');
    assert.deepEqual(refused.paragraphs, [PORTFOLIO_VIEW_FAILED]);
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const f = fakeSdk({ throws: err });
    const failed = await portfolioOpusView({ ctx: ctxOf(), apiKey: FAKE_KEY, sdk: f.sdk }, 'x', 'low');
    assert.equal(failed.state, 'failed');
    assert.equal(f.requests.length, 1, 'a permanent error is not retried');
  });

  test('a fallback model answer is kept (refusal fallback on)', async () => {
    const v = await portfolioOpusView({ ctx: ctxOf(), apiKey: FAKE_KEY, sdk: fakeSdk({ model: 'claude-sonnet-fallback' }).sdk }, 'x', 'low');
    assert.equal(v.state, 'ok');
    assert.equal(v.model, 'claude-sonnet-fallback');
  });

  test('never in the nightly: no call', async () => {
    const { sdk, requests } = fakeSdk();
    const v = await portfolioOpusView({ ctx: ctxOf('nightly'), apiKey: FAKE_KEY, sdk }, 'x', 'low');
    assert.equal(requests.length, 0);
    assert.notEqual(v.state, 'ok');
  });

  test('Telegram (clean policy): a written view is NOT sent (it is in the Exit PDFs); off/failed sends one line; a failure does not throw', async () => {
    const sent: string[] = [];
    const fetchOk = (async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); }) as unknown as typeof fetch;
    const io = { out: () => {}, err: () => {} };
    const v = await portfolioOpusView({ ctx: ctxOf(), apiKey: FAKE_KEY, sdk: fakeSdk().sdk }, 'x', 'low');
    assert.equal(v.state, 'ok');
    assert.equal(await sendPortfolioView(v, { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' }, io, fetchOk), false);
    assert.equal(sent.length, 0, 'ok: silent');
    const off = await portfolioOpusView({ ctx: ctxOf(), apiKey: '', sdk: fakeSdk().sdk }, 'x', 'low');
    assert.equal(await sendPortfolioView(off, { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' }, io, fetchOk), true);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0]!.includes('\n'), 'one line');
    assert.equal(await sendPortfolioView(off, {}, io, fetchOk), false);
    const fetchBad = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    assert.equal(await sendPortfolioView(off, { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' }, io, fetchBad), false);
  });

  test('/exit message: the saved view is read back from the tab, up to the first holding', () => {
    const row = (t: string) => ({ values: [{ formattedValue: t }] });
    const tab = { data: [{ rowData: [row(AI_ANCHOR), row('Written ...'), row('▣ ' + PORTFOLIO_VIEW_TITLE), row(PORTFOLIO_VIEW_DISCLOSURE), row('IN ONE LINE'), row('Too much Bitcoin.'), row('▸ TSLA'), row('Gemini narrative')] }] };
    const v = savedPortfolioView(tab as never);
    assert.ok(v && v.includes('Too much Bitcoin.') && !v.includes('Gemini narrative'));
    assert.equal(savedPortfolioView({ data: [{ rowData: [row(AI_ANCHOR)] }] } as never), null);
  });
});

// ── end to end: offline nightly, then the AI run with a fake SDK ──────────────

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };

class FakeNet implements HttpTransport {
  private readonly bodies: Record<string, string>;
  constructor(bodies: Record<string, string>) { this.bodies = bodies; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1] as string) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}
const gemini: GeminiTransport = { configured: true, async generate() { return { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A plain narrative.' }] } }] }) }; } };

async function afterNightly(env: Record<string, string>): Promise<Services> {
  const s = await composeServices({ storage: 'memory', env: { ...ENV, ...env }, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
    initialTabs: { Portfolio: [['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'], ['TSLA', 'stock', 10, 250, '2025-03-03']], '🎯 Watchlist': [['Ticker'], ['NVDA']] } });
  const app = await buildNightlyApp(s, { skip: ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh'] });
  await runNightly(app.deps, app.options);
  return s;
}

const colA = (be: MemoryWorkbookBackend): string[] => be.grid(EXIT_SHEET_TAB).map((r) => String(r[0] ?? ''));

describe('Plan #47: end to end in the AI run', { skip: fixturesPresent() ? false : 'fixtures missing' }, () => {
  test('Exit Opus ticked: one extra Opus call over the whole Exit report; view first in the AI section, headline on top; the report above is unchanged', async () => {
    const s = await afterNightly({ ANTHROPIC_API_KEY: FAKE_KEY });
    const be = s.backend as MemoryWorkbookBackend;
    const before = be.grid(EXIT_SHEET_TAB).map((r) => [...r]);
    const anchor = colA(be).indexOf(AI_ANCHOR);
    const f = fakeSdk();
    const parsed = parseAiInputs(aiInputsFromEnv({ EFFORT: 'low', BUY: 'false', EXIT: 'true', EXIT_GEMINI: 'true', EXIT_OPUS: 'true' }));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = await runAiApp(s, parsed.plan, { geminiTransport: gemini, claudeSdk: f.sdk });
    const pf = f.requests.filter((q) => q.system[0]?.text === PORTFOLIO_SYSTEM_PROMPT);
    assert.equal(pf.length, 1, 'exactly one portfolio call');
    assert.equal(f.requests.length, 2, 'one per-ticker review (TSLA) + one portfolio view');
    const msg = pf[0]!.messages[0]!.content;
    assert.ok(msg.includes('TSLA'), 'the Exit read is sent');
    assert.ok(!msg.includes('AI review: '), 'the AI status line is not sent');
    assert.ok(!msg.includes(AI_ANCHOR), 'only the report above the AI section');
    assert.equal(r.portfolio?.state, 'ok');

    const a = colA(be);
    assert.equal(a.indexOf(AI_ANCHOR), anchor);
    assert.equal(a[anchor + 2], '▣ ' + PORTFOLIO_VIEW_TITLE, 'first block of the AI section (after its status row)');
    assert.equal(a[anchor + 3], PORTFOLIO_VIEW_DISCLOSURE);
    assert.ok(a.indexOf('▸ TSLA') > anchor + 3, 'the per-ticker summaries follow');
    const status = a.slice(0, 6).find((t) => t.startsWith('AI review: '));
    assert.ok(status && status.includes('Portfolio view (Claude Opus)') && status.includes('Most of the money rides on one bet'), 'headline on the top status line');
    const after = be.grid(EXIT_SHEET_TAB);
    for (let i = 0; i < anchor; i++) {
      if (String(before[i]?.[0] ?? '').startsWith('AI review: ')) continue;
      assert.deepEqual(after[i], before[i], 'row ' + (i + 1) + ' unchanged (display only)');
    }
  });

  test('Exit Opus not ticked: no portfolio call, no view; no key: one plain line, no call', async () => {
    const s = await afterNightly({ ANTHROPIC_API_KEY: FAKE_KEY });
    const f = fakeSdk();
    const p1 = parseAiInputs(aiInputsFromEnv({ EFFORT: 'low', BUY: 'false', EXIT: 'true', EXIT_GEMINI: 'true', EXIT_OPUS: 'false' }));
    assert.ok(p1.ok);
    if (!p1.ok) return;
    const r1 = await runAiApp(s, p1.plan, { geminiTransport: gemini, claudeSdk: f.sdk });
    assert.equal(f.requests.length, 0);
    assert.equal(r1.portfolio, null);
    assert.ok(!colA(s.backend as MemoryWorkbookBackend).includes('▣ ' + PORTFOLIO_VIEW_TITLE));

    const s2 = await afterNightly({});
    const f2 = fakeSdk();
    const p2 = parseAiInputs(aiInputsFromEnv({ EFFORT: 'low', BUY: 'false', EXIT: 'true', EXIT_GEMINI: 'false', EXIT_OPUS: 'true' }));
    assert.ok(p2.ok);
    if (!p2.ok) return;
    const r2 = await runAiApp(s2, p2.plan, { geminiTransport: gemini, claudeSdk: f2.sdk });
    assert.equal(f2.requests.length, 0);
    assert.equal(r2.portfolio?.state, 'off');
    const a = colA(s2.backend as MemoryWorkbookBackend);
    assert.equal(a[a.indexOf('▣ ' + PORTFOLIO_VIEW_TITLE) + 1], PORTFOLIO_VIEW_NO_KEY);
  });
});
