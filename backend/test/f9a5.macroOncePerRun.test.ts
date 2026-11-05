/**
 * F-9a-5 (V13 row 38: "macro read twice per ticker: confirm closed"). runTickerAnalysis asks for the macro regime
 * twice (the course-model block and the macro step), and the AI review can ask again; compose.ts hands all of them
 * the one getCachedMacroRegime memo (MacroRegimeMemo) of the run, so the 9 regime caches are read, and any live
 * fetch made, once per run. This pins that on a real Analyze run (fixtures, memory storage).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { compose } from '../src/compose.ts';
import { nasdaqHistoricalUrl } from '../src/fetch/macro/nasdaq.ts';
import { MACRO_REGIME_TICKERS } from '../src/analysis/macroRegime.ts';

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };

class FakeNet implements HttpTransport {
  readonly urls: string[] = [];
  private readonly bodies: Record<string, string>;
  constructor(bodies: Record<string, string>) { this.bodies = bodies; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1]!) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}

describe('F-9a-5 — one Analyze run computes the macro regime once', { skip: fixturesPresent() ? false : 'fixtures missing' }, () => {
  test('two or more getCachedMacroRegime asks, one computation, one round of macro reads', async () => {
    const net = new FakeNet(fixtureBodies());
    const lines: string[] = [];
    const c = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: (l) => { lines.push(JSON.stringify(l)); }, sleep: async () => {} });
    let asks = 0;
    const deps = c.deps as { getCachedMacroRegime: () => Promise<unknown> };
    const real = deps.getCachedMacroRegime;
    deps.getCachedMacroRegime = () => { asks++; return real(); };
    await c.analyze('TSLA');

    assert.ok(asks >= 2, 'the ticker run asks for the macro regime more than once (' + asks + ')');
    assert.equal(lines.filter((l) => l.includes('getCachedMacroRegime_:')).length, 1, 'the regime is computed once per run');
    // No saved copies in memory, so the /analyze path fetches the stale regime ETFs live: once each, not once per ask.
    for (const t of MACRO_REGIME_TICKERS) {
      const n = net.urls.filter((u) => u === nasdaqHistoricalUrl(t)).length;
      assert.ok(n <= 2, t + ' fetched ' + n + ' times (the batch, plus at most its sequential fallback)');
    }
    const before = net.urls.length;
    await c.getMacro();
    assert.equal(net.urls.length, before, 'a later ask in the same run is served from the memo');
  });
});
