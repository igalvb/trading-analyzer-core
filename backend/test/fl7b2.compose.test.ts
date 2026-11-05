/**
 * FL-7a-2b: the production wiring, end to end, offline (replaces
 * fl7a2.compose.test.ts). compose() builds the real dependency graph; the
 * network is a scripted transport serving Yahoo charts built from the
 * fixtures and 404 for everything else (no keys), or 503 for SPY.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { compose, composeServices, settingsFromEnv, TICKER_RUN_PRELOAD, ANALYSIS_TAB, MODEL_TABS } from '../src/compose.ts';
import { main, renderRunText, dataQualityBox, DETAILS_IN_LOG } from '../src/cli.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { writeRsRankingTab } from '../src/storage/rsRankingTab.ts';
import type { LogLine } from '../src/core/logger.ts';

const ready = fixturesPresent();

class FakeNet implements HttpTransport {
  readonly urls: string[] = [];
  private readonly bodies: Record<string, string>;
  private readonly failing: Set<string>;
  constructor(bodies: Record<string, string>, failing: string[] = []) { this.bodies = bodies; this.failing = new Set(failing); }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1]) : null;
    if (t && this.failing.has(t)) return new HttpResponse(503, new TextEncoder().encode('Service Unavailable'));
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}



const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };

describe('FL-7a-2b — compose + CLI, offline', { skip: ready ? false : 'fixtures missing' }, () => {
  test('a clean run: dashboard and all five model tabs; the box is catalog text with one pointer to the log', async () => {
    const lines: LogLine[] = [];
    const net = new FakeNet(fixtureBodies());
    const c = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: (l) => { lines.push(l); }, sleep: async () => {} });
    const art = await c.analyze('TSLA');
    assert.equal(art.aborted, undefined);
    assert.ok(c.workbook.getSheetByName(ANALYSIS_TAB)!.grid().length > 40);
    const text = renderRunText(art, c.workbook, c.timeZone);
    for (const tab of Object.values(MODEL_TABS)) assert.ok(text.includes('══════ ' + tab), tab);
    const box = dataQualityBox(art);
    assert.equal(box[0], 'Data quality');
    assert.equal(box.filter((l) => l === DETAILS_IN_LOG).length, 1);
    assert.ok(box.includes('Warning: Fundamentals: The provider returned no data for this ticker. The score uses price and chart signals only.'), box.join('\n'));
    assert.ok(box.includes('Note: AI narrative: This step did not run. The report has no AI summary.'), box.join('\n'));
    for (const l of box) assert.deepStrictEqual(findReportLeaks(l), [], l);
    assert.ok(lines.some((l) => /HTTP 404 GET https:\/\/financialmodelingprep\.com/.test(l.message)), 'the real error is in the log');
    assert.ok(net.urls.every((u) => !u.includes('contact@example.org')));
    // The run's status carries FL-9g reason codes outside parity mode.
    assert.equal(art.status.fundamentals.reasonCode, 'NO_DATA_FOR_TICKER');
  });

  test('SPY outage: 3 tries, the run degrades instead of aborting (F-34); parity mode keeps one try and no box', async () => {
    const net = new FakeNet(fixtureBodies(), ['SPY']);
    const c = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    const art = await c.analyze('TSLA');
    assert.equal(art.aborted, undefined);
    assert.equal(net.urls.filter((u) => /chart\/SPY\?interval=1d&range=2y/.test(u)).length, 3);
    assert.ok(dataQualityBox(art).includes('Warning: S&P 500 comparison: The data provider did not respond. Treat the result with less confidence.'));
    const net2 = new FakeNet(fixtureBodies(), ['SPY']);
    const p = await compose({ storage: 'memory', env: ENV, transport: net2, clock: clockAfterFixtures(), logSink: () => {}, legacyParity: true });
    const art2 = await p.analyze('TSLA');
    assert.equal(net2.urls.filter((u) => /chart\/SPY\?interval=1d&range=2y/.test(u)).length, 1);
    assert.deepStrictEqual(art2.dataQuality, []);
    assert.equal(art2.status.fundamentals.reasonCode, undefined, 'parity: no reason codes');
  });

  test('saved fundamentals: reported with their date; the rule (FUND_FALLBACK_RULES=on) refuses a 40-day-old copy', async () => {
    const clock = clockAfterFixtures();
    const DAY = 86400000;
    const record = (days: number) => JSON.stringify({ data: { _sources: ['FMP'], beta: 1.2, sector: 'Consumer Cyclical', forwardPE: 60, _earningsHistory: [] }, date: 'x', fetchedAt: new Date(clock.now() - days * DAY).toISOString() });
    const legacyRule = await compose({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock, logSink: () => {}, sleep: async () => {} });
    await legacyRule.kv.set('FUND_TSLA', record(40));
    const a = await legacyRule.analyze('TSLA');
    assert.ok(a.fund, 'default (rule off): legacy uses any saved copy');
    assert.ok(dataQualityBox(a).some((l) => /^Warning: Fundamentals from \w{3} \d+, 40 days old, used because the provider returned no data for this ticker\. The score uses the saved data\.$/.test(l)), dataQualityBox(a).join('\n'));
    const ruled = await compose({ storage: 'memory', env: { ...ENV, FUND_FALLBACK_RULES: 'on' }, transport: new FakeNet(fixtureBodies()), clock, logSink: () => {}, sleep: async () => {} });
    await ruled.kv.set('FUND_TSLA', record(40));
    const b = await ruled.analyze('TSLA');
    assert.equal(b.fund, null);
    assert.ok(dataQualityBox(b).some((l) => /^Warning: Fundamentals: The saved copy from \w{3} \d+, 40 days old is too old to trust\. The score uses price and chart signals only\.$/.test(l)), dataQualityBox(b).join('\n'));
    // The live fetch saves a stamped copy (production).
    const keyed = await compose({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock, logSink: () => {} });
    assert.equal(await keyed.kv.get('FUND_TSLA'), null);
  });

  test('F-57: the RS ranking is read from its own tab; settings and the F-84 preload', async () => {
    const c = await compose({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    const rk = { categories: ['EV'], peerCount: 5, rank: 2, percentile: 80, read: 'STRONG', topPeers: [], bottomPeers: [] };
    await writeRsRankingTab(c.tabStore, { TSLA: rk }, new Date(clockAfterFixtures().now()));
    const art = await c.analyze('TSLA');
    assert.deepStrictEqual(art.ind!.relativeStrengthRanking, rk);
    const p = await composeServices({ storage: 'memory', env: ENV, legacyParity: true });
    assert.deepStrictEqual(p.settings, { fundFallbackRules: false, fundFallbackMaxAgeDays: 30, fundSeriesTab: false, rsRankingTab: false, legacyExpiryLabel: true, calendarWeekSteps: false, legacyReportText: true });
    assert.deepStrictEqual(settingsFromEnv({ FUND_FALLBACK_RULES: 'on', FUND_FALLBACK_MAX_AGE_DAYS: '14', FUND_SERIES_TAB: 'ON' }, false),
      { fundFallbackRules: true, fundFallbackMaxAgeDays: 14, fundSeriesTab: true, rsRankingTab: true, legacyExpiryLabel: false, calendarWeekSteps: true, legacyReportText: false });
    for (const t of [ANALYSIS_TAB, ...Object.values(MODEL_TABS), '🔬 Log', '_OPTIONS_SNAPSHOT', '📒 Transactions']) assert.ok(TICKER_RUN_PRELOAD.includes(t), t);
    // phase 1: the two fixed report tabs that used to carry the ticker in their name
    for (const t of ['📋 Bottom Line', '📊 Price Chart']) assert.ok(TICKER_RUN_PRELOAD.includes(t), t);
  });

  test('the CLI: usage errors and an empty ticker refused before any fetch', async () => {
    const out: string[] = [], err: string[] = [];
    const io = { out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); }, env: ENV };
    assert.equal(await main([], io), 2);
    assert.equal(await main(['analyze', '  '], io), 2);
    assert.ok(err.join('').includes('Please give a ticker symbol'));
  });
});
