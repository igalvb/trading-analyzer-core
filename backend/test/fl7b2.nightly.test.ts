/**
 * FL-7c: one night through the REAL composition (compose + nightlyApp + runNightly),
 * memory storage, a scripted network (Yahoo charts from the fixtures, 404 elsewhere).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { composeServices } from '../src/compose.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { runNightly, buildPlainSummary } from '../src/jobs/nightly/nightly.ts';
import { NIGHTLY_ORDER } from '../src/jobs/nightly/steps.ts';
import { nightlyMain } from '../src/nightly.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { DECISION_HISTORY_SHEET } from '../src/stores/decisionHistory.ts';
import { WATCHLIST_SUMMARY_SHEET } from '../src/stores/watchlist.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';

const ready = fixturesPresent();

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

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };
const PORTFOLIO = [
  ['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'],
  ['TSLA', 'stock', 10, 250, '2025-03-03'],
  ['ETH-USD', 'crypto', 1, 2000, ''],
  [],
  ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'Purchase Data'],
  ['NVDA', 2, '2027-01-15', 150, 'CALL', 12.5, '2025-06-01'],
];
const WATCHLIST = [['Ticker'], ['NVDA'], ['IBIT'], ['ZZZZ']];

describe('FL-7c — the nightly composition, one night, offline', { skip: ready ? false : 'fixtures missing' }, () => {
  test('every step in order; one analysis per ticker; Buy, Exit, Summary and Decision History written once; plain text only', async () => {
    const net = new FakeNet(fixtureBodies());
    const s = await composeServices({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
      initialTabs: { Portfolio: PORTFOLIO, '🎯 Watchlist': WATCHLIST } });
    const app = await buildNightlyApp(s, { skip: ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength'] });
    assert.deepStrictEqual(app.watchlist, ['NVDA', 'IBIT', 'ZZZZ']);
    assert.deepStrictEqual(app.portfolio.skippedCrypto, ['ETH-USD']);
    const summary = await runNightly(app.deps, app.options);
    assert.deepStrictEqual(summary.steps.map((x) => x.id), [...NIGHTLY_ORDER]);
    const byId = Object.fromEntries(summary.steps.map((x) => [x.id, x.state]));
    assert.equal(byId['analysis.tickers'], 'degraded', 'ZZZZ has no price data');
    assert.equal(byId['buy.report'], 'degraded');
    assert.ok(byId['exit.report'] === 'ok' || byId['exit.report'] === 'degraded');
    assert.deepStrictEqual(summary.tickers.map((t) => t.ticker).sort(), ['IBIT', 'NVDA', 'TSLA', 'ZZZZ']);
    // F3: one chart fetch per ticker for the analysis, however many consumers read it.
    assert.equal(app.cache.size, 4);
    const tslaCharts = net.urls.filter((u) => /chart\/TSLA\?interval=1d&range=2y/.test(u)).length;
    assert.equal(tslaCharts, 1, 'TSLA analysed once (Exit reuses the cached price history)');
    const be = s.backend as MemoryWorkbookBackend;
    for (const tab of [BUY_SHEET_TAB, EXIT_SHEET_TAB, DECISION_HISTORY_SHEET]) assert.ok(be.grid(tab).length > 1, tab + ' written');
    assert.equal(be.grid(WATCHLIST_SUMMARY_SHEET).length, 0, 'owner 2026-11-04: the Watchlist Summary tab is no longer written');
    const dh = be.grid(DECISION_HISTORY_SHEET).slice(1).map((r) => String(r[1]));
    assert.deepStrictEqual(dh.sort(), ['IBIT', 'NVDA'], 'one Decision History row per analysed watchlist ticker (the Buy pipeline writes)');
    assertNoReportLeaks(be.grid(BUY_SHEET_TAB));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
    // F-N9: per-ticker dashboards were rendered into scratch workbooks, not the real one.
    assert.equal(be.grid('📊 Analysis v7').length, 0);
    const plain = buildPlainSummary(summary).join('\n');
    assert.doesNotMatch(plain, /https?:|HTTP \d{3}|apikey/);
  });

  test('the dark-pool steps throw instead of swallowing (F-N1): a total failure is retried and reported', async () => {
    const s = await composeServices({ storage: 'memory', env: ENV, transport: new FakeNet({}), clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
      initialTabs: { Portfolio: PORTFOLIO, '🎯 Watchlist': [['Ticker']] } });
    const app = await buildNightlyApp(s, { skip: ['darkPool.tracker', 'darkPool.relativeStrength', 'macro.refresh', 'analysis.tickers', 'analysis.summary', 'buy.report', 'exit.report'] });
    const summary = await runNightly(app.deps, app.options);
    const ei = summary.steps.find((x) => x.id === 'darkPool.evaluativeIndex')!;
    assert.equal(ei.state, 'failed');
    assert.equal(ei.attempts, 3);
    assert.match(String(ei.reason), /Evaluative Index was not refreshed/);
  });

  test('nightlyMain (--memory): plain summary on stdout, exit 0 for a partial night', async () => {
    const out: string[] = [];
    const code = await nightlyMain(['--memory'], { out: (x) => { out.push(x); }, err: () => {}, env: ENV }, { transport: new FakeNet(fixtureBodies()) as never, clock: clockAfterFixtures(), initialTabs: { Portfolio: PORTFOLIO, '🎯 Watchlist': [['Ticker'], ['NVDA']] } });
    assert.equal(code, 0);
    assert.ok(out.join('').length > 20);
    assert.doesNotMatch(out.join(''), /https?:|apikey/);
  });
});
