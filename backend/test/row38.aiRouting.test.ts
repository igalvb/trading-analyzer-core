/**
 * Row 38 (V13 dual-AI plan s7 item 16, logging plan item 45c): "Routing: Buy-only writes the Buy tab and leaves
 * Exit byte-identical; Exit-only the reverse; both writes both." After one offline nightly (fixtures, memory
 * storage), the AI run is made three times with fake Gemini / Opus transports; each tab is compared as everything a
 * viewer gets: the cells, every formatting op ever applied, and the tab colour.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { composeServices, type Services } from '../src/compose.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import { runAiApp, aiInputsFromEnv } from '../src/ai.ts';
import { parseAiInputs } from '../src/ai/aiDispatch.ts';
import type { GeminiTransport } from '../src/ai/geminiTransport.ts';
import type { ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import { CLAUDE_REVIEW_MODEL } from '../src/ai/claudeReview.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';

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
const sdk = { async create(): Promise<ClaudeResponse> { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opus review.' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: CLAUDE_REVIEW_MODEL }; } } as ClaudeSdk;

/** Everything a viewer gets of one tab, as one string: cells, the formatting ops, the tab colour. */
function snapshot(be: MemoryWorkbookBackend, tab: string): string {
  const t = be.tabs.get(tab);
  assert.ok(t, 'tab exists: ' + tab);
  return JSON.stringify({ grid: be.grid(tab), formats: be.formats.get(tab) ?? [], color: t.tabColor });
}

async function afterNightly(): Promise<Services> {
  const s = await composeServices({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
    initialTabs: { Portfolio: [['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'], ['TSLA', 'stock', 10, 250, '2025-03-03']], '🎯 Watchlist': [['Ticker'], ['NVDA']] } });
  const app = await buildNightlyApp(s, { skip: ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh'] });
  await runNightly(app.deps, app.options);
  return s;
}

async function ai(s: Services, env: Record<string, string>): Promise<void> {
  const parsed = parseAiInputs(aiInputsFromEnv({ EFFORT: 'low', ...env }));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  if (parsed.ok) await runAiApp(s, parsed.plan, { geminiTransport: gemini, claudeSdk: sdk });
}

describe('Row 38: AI routing, byte-identical (dual-AI plan s7 item 16)', { skip: fixturesPresent() ? false : 'fixtures missing' }, () => {
  test('Buy-only leaves Exit byte-identical; Exit-only leaves Buy byte-identical; both writes both', async () => {
    const s = await afterNightly();
    const be = s.backend as MemoryWorkbookBackend;
    const buy0 = snapshot(be, BUY_SHEET_TAB), exit0 = snapshot(be, EXIT_SHEET_TAB);
    assert.ok(!buy0.includes('A plain narrative.') && !exit0.includes('A plain narrative.'), 'no AI text before the AI run');

    await ai(s, { BUY: 'true', BUY_GEMINI: 'true', BUY_OPUS: 'true', EXIT: 'false' });
    const buy1 = snapshot(be, BUY_SHEET_TAB), exit1 = snapshot(be, EXIT_SHEET_TAB);
    assert.notEqual(buy1, buy0, 'Buy-only wrote the Buy tab');
    assert.ok(buy1.includes('A plain narrative.'));
    assert.equal(exit1, exit0, 'Buy-only left the Exit tab byte-identical');

    await ai(s, { BUY: 'false', EXIT: 'true', EXIT_GEMINI: 'true', EXIT_OPUS: 'false' });
    const buy2 = snapshot(be, BUY_SHEET_TAB), exit2 = snapshot(be, EXIT_SHEET_TAB);
    assert.notEqual(exit2, exit1, 'Exit-only wrote the Exit tab');
    assert.ok(exit2.includes('A plain narrative.'));
    assert.equal(buy2, buy1, 'Exit-only left the Buy tab byte-identical');

    // Both: a fresh nightly, then one run with both sides on, writes both tabs.
    const s2 = await afterNightly();
    const be2 = s2.backend as MemoryWorkbookBackend;
    const b0 = snapshot(be2, BUY_SHEET_TAB), e0 = snapshot(be2, EXIT_SHEET_TAB);
    assert.equal(b0, buy0, 'the nightly is deterministic (the comparison above is meaningful)');
    assert.equal(e0, exit0);
    await ai(s2, { BUY: 'true', BUY_GEMINI: 'true', BUY_OPUS: 'false', EXIT: 'true', EXIT_GEMINI: 'true', EXIT_OPUS: 'false' });
    assert.ok(snapshot(be2, BUY_SHEET_TAB).includes('A plain narrative.'), 'both: Buy written');
    assert.ok(snapshot(be2, EXIT_SHEET_TAB).includes('A plain narrative.'), 'both: Exit written');
  });
});
