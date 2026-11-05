/**
 * Row 38: the Exit report's Google Sheets call count, pinned (V13 plan: the nightly's Sheets calls are the run-time
 * cost under the ~50 calls/minute quota; F-B7-1). A real nightly through composeServices on a fake Google API
 * (fixtures, one spreadsheet), run twice from the same starting sheet: once without the Exit report step and once
 * with it. The difference is what the Exit report costs. If this number goes UP, a change made the Exit report
 * read or write more often: find out why before raising the pin. If it goes DOWN, lower the pin.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { FakeGoogle } from './fakeGoogleSheets.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { composeServices } from '../src/compose.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { buildNightlyApp } from '../src/app/nightlyApp.ts';
import { runNightly } from '../src/jobs/nightly/nightly.ts';
import type { NightlyStepId } from '../src/jobs/nightly/steps.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';

/**
 * Today's count (2026-10-31): 3 = the grouped report flush (C3) of a new Exit tab: one batchUpdate that adds the
 * tab, one values write, one formatting batchUpdate. The holdings, charts and analysis come from the run's shared
 * reads and cache (no extra read).
 * See the header before changing it.
 */
export const EXIT_REPORT_SHEETS_CALLS = 3;
export const EXIT_REPORT_SHEETS_METHODS: readonly string[] = ['batchUpdate', 'values.batchUpdate', 'batchUpdate'];

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', SPREADSHEET_ID: 'P' };

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

/** Every step but the stock analysis and (optionally) the Exit report is skipped. */
const SKIP_ALWAYS: NightlyStepId[] = ['darkPool.tracker', 'darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh', 'options.chains', 'analysis.summary', 'buy.report', 'options.reads', 'fundamentals.history', 'paper.trade', 'live.dryRun'];

async function nightlyCalls(withExit: boolean): Promise<{ calls: number; exitTab: boolean; methods: string[] }> {
  const g = new FakeGoogle();
  g.addBook('P', 'My Portfolio', {
    Portfolio: [['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'], ['TSLA', 'stock', 10, 250, '2025-03-03']],
    '🎯 Watchlist': [['Ticker'], ['NVDA']],
    '💾 Script Properties': [['Key', 'Value', 'UpdatedAt']],
  });
  const s = await composeServices({
    storage: 'sheets', env: ENV, sheetsApi: g.api as never, sheetsLimiter: RateLimiter.perMinute(1_000_000), transport: new FakeNet(fixtureBodies()),
    clock: clockAfterFixtures(), mode: 'nightly', noAi: true, logSink: () => {}, sleep: async () => {},
  });
  const app = await buildNightlyApp(s, { skip: withExit ? SKIP_ALWAYS : [...SKIP_ALWAYS, 'exit.report'], concurrency: 1 });
  await runNightly(app.deps, app.options);
  await s.flushStores();
  const exitTab = (g.books.get('P')?.tabs ?? []).some((t) => t.title === EXIT_SHEET_TAB);
  return { calls: g.calls.length, exitTab, methods: g.calls.map((c) => c.method) };
}

describe('Row 38: the Exit report Sheets call count', { skip: fixturesPresent() ? false : 'fixtures missing' }, () => {
  test('the Exit report costs exactly EXIT_REPORT_SHEETS_CALLS Google Sheets calls (one held stock, one watchlist stock)', async () => {
    const without = await nightlyCalls(false);
    const withExit = await nightlyCalls(true);
    assert.equal(without.exitTab, false);
    assert.equal(withExit.exitTab, true, 'the Exit report tab was written');
    const cost = withExit.calls - without.calls;
    assert.equal(cost, EXIT_REPORT_SHEETS_CALLS, 'Exit report Sheets calls: ' + cost + ' (pinned ' + EXIT_REPORT_SHEETS_CALLS + ')');
    // Which calls: the per-method counts of the two runs differ by exactly EXIT_REPORT_SHEETS_METHODS.
    const count = (ms: readonly string[]): Map<string, number> => { const m = new Map<string, number>(); for (const x of ms) m.set(x, (m.get(x) ?? 0) + 1); return m; };
    const a = count(withExit.methods), b = count(without.methods);
    const extra = [...a.keys()].flatMap((k) => Array<string>(Math.max(0, (a.get(k) ?? 0) - (b.get(k) ?? 0))).fill(k)).sort();
    const fewer = [...b.keys()].filter((k) => (b.get(k) ?? 0) > (a.get(k) ?? 0));
    assert.deepEqual(fewer, [], 'the Exit report removes no call');
    assert.deepEqual(extra, [...EXIT_REPORT_SHEETS_METHODS].sort());
  });
});
