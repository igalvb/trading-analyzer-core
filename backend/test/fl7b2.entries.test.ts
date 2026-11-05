/**
 * FL-7c: the CLI entries every workflow calls (npm run nightly / ai / ticker / my-options),
 * offline: memory storage, a scripted network, fake AI transports.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { composeServices } from '../src/compose.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import { tickerMain } from '../src/ticker.ts';
import { myOptionsMain } from '../src/myOptions.ts';
import { aiMain, runAiApp, aiInputsFromEnv } from '../src/ai.ts';
import { parseAiInputs } from '../src/ai/aiDispatch.ts';
import type { GeminiTransport } from '../src/ai/geminiTransport.ts';
import type { ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_MODEL } from '../src/ai/claudeReview.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';

const ready = fixturesPresent();
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };

class FakeNet implements HttpTransport {
  readonly urls: string[] = [];
  private readonly bodies: Record<string, string>;
  constructor(bodies: Record<string, string>) { this.bodies = bodies; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1]) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}

const PORTFOLIO = [
  ['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'],
  ['TSLA', 'stock', 10, 250, '2025-03-03'],
];

describe('FL-7c — CLI entries, offline', { skip: ready ? false : 'fixtures missing' }, () => {
  test('ticker: empty ticker refused (F-G1); --stock-only prints the report; the full flow runs options first, then the chart file', async () => {
    const err: string[] = [];
    assert.equal(await tickerMain([], { out: () => {}, err: (x) => { err.push(x); }, env: ENV }), 2);
    assert.match(err.join(''), /Please give a ticker symbol/);
    const out: string[] = [];
    const code = await tickerMain(['TSLA', '--memory', '--stock-only', '--no-ai'], { out: (x) => { out.push(x); }, err: () => {}, env: ENV }, { transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures() });
    assert.equal(code, 0);
    assert.match(out.join(''), /══════ TSLA — 📊 Analysis v7 ══════/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl7c-chart-'));
    const net = new FakeNet(fixtureBodies());
    const out2: string[] = [];
    const code2 = await tickerMain(['TSLA', '--memory', '--no-ai'], { out: (x) => { out2.push(x); }, err: () => {}, env: ENV }, { transport: net, clock: clockAfterFixtures(), outDir: dir });
    assert.equal(code2, 0);
    assert.ok(net.urls.some((u) => /cboe/i.test(u)), 'the options step ran (its chain fetch was attempted)');
    assert.ok(fs.existsSync(path.join(dir, 'TSLA-chart.html')), 'the price chart file was written');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('my-options: runs on a workbook without the options table and says so plainly', async () => {
    const out: string[] = [];
    const code = await myOptionsMain(['--memory'], { out: (x) => { out.push(x); }, err: () => {}, env: ENV }, { transport: new FakeNet({}), clock: clockAfterFixtures(), initialTabs: { Portfolio: PORTFOLIO } });
    assert.equal(code, 0);
    assert.ok(out.join('').trim().length > 0);
  });

  test('ai: bad inputs refused; after a nightly, Buy and Exit AI summaries are written in place, plain text only', async () => {
    const err: string[] = [];
    assert.equal(await aiMain(['--memory'], { out: () => {}, err: (x) => { err.push(x); }, env: { ...ENV, BUY: 'maybe' } }), 1);
    assert.match(err.join(''), /AI run settings were not understood/);
    const s = await composeServices({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
      initialTabs: { Portfolio: PORTFOLIO, '🎯 Watchlist': [['Ticker'], ['NVDA']] } });
    const app = await buildNightlyApp(s, { skip: ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh'] });
    await runNightly(app.deps, app.options);
    const gemini: GeminiTransport = { configured: true, async generate() { return { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A plain narrative.' }] } }] }) }; } };
    const sdk: ClaudeSdk = { async create(): Promise<ClaudeResponse> { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opus review.' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: CLAUDE_REVIEW_MODEL }; } } as ClaudeSdk;
    const parsed = parseAiInputs(aiInputsFromEnv({ BUY: 'true', BUY_GEMINI: 'true', BUY_OPUS: 'true', EXIT: 'true', EXIT_GEMINI: 'true', EXIT_OPUS: 'false', EFFORT: 'low' }));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = await runAiApp(s, parsed.plan, { geminiTransport: gemini, claudeSdk: sdk });
    assert.match(String(r.buy), /Buy report: AI summaries written for 1 stocks/);
    assert.match(String(r.exit), /Exit report: AI summaries written for 1 holdings/);
    const be = s.backend as MemoryWorkbookBackend;
    assert.ok(be.grid(BUY_SHEET_TAB).flat().some((c) => String(c).includes('A plain narrative.')));
    assert.ok(be.grid(EXIT_SHEET_TAB).flat().some((c) => String(c).includes('A plain narrative.')));
    assertNoReportLeaks(be.grid(BUY_SHEET_TAB));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
  });
});
