/**
 * C2 (fix plan 2026-10-30, owner: free only): FMP's free plan refuses some tickers (HTTP 402).
 *  - the earnings date then comes from Finnhub's free calendar/earnings;
 *  - a 402 is remembered per endpoint + ticker for 7 days in the key-value store, and those calls are skipped;
 *  - insider trading (402 for every ticker) is never asked;
 *  - the earnings calendar is fetched once per ticker per run.
 * Parity / legacy (no fmpFreePlan): unchanged.
 * Also: the Chandelier row says "already above price (stop hit if held)" instead of a negative distance.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import {
  fetchEarningsCalendar, fetchInsiderTradingNet, fetchFMPFundamentals, fmp402Key, FMP_402_TTL_MS, type FundamentalsDeps,
} from '../src/fetch/fundamentals/providers.ts';
import { chandelierDistanceText, CHANDELIER_ABOVE_PRICE } from '../src/reports/dashboard/dashboard.ts';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { compose, ANALYSIS_TAB } from '../src/compose.ts';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-30T15:00:00Z');
const DAY = 86400000;

class Net implements HttpTransport {
  readonly urls: string[] = [];
  private readonly route: (url: string) => [number, string];
  constructor(route: (url: string) => [number, string]) { this.route = route; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const [status, body] = this.route(req.url);
    return new HttpResponse(status, new TextEncoder().encode(body));
  }
}

const FINNHUB_CAL = JSON.stringify({ earningsCalendar: [
  { date: '2027-02-04', symbol: 'MSTR', epsEstimate: 1 },
  { date: '2026-11-03', symbol: 'MSTR', epsEstimate: 1 },
  { date: '2026-07-30', symbol: 'MSTR', epsActual: 2 },
] });

/** FMP 402 for everything, Finnhub serves the calendar. */
const refusing = (): Net => new Net((u) => (u.includes('financialmodelingprep.com') ? [402, 'Restricted Endpoint: This endpoint is not available under your current subscription'] : u.includes('finnhub.io/api/v1/calendar/earnings') ? [200, FINNHUB_CAL] : [404, '']));

function deps(net: Net, kv: MemoryPropertyStore | null, now = NOW): FundamentalsDeps {
  return {
    http: new HttpClient({ transport: net }), keys: { fmp: 'F', finnhub: 'H', alphaVantage: '' }, timeZone: TZ, clock: { now: () => now },
    ...(kv ? { fmpFreePlan: { kv, earningsMemo: new Map() } } : {}),
  };
}

const fmpCalls = (n: Net, path: string): number => n.urls.filter((u) => u.includes('financialmodelingprep.com/stable/' + path)).length;
const finnhubCalls = (n: Net): number => n.urls.filter((u) => u.includes('finnhub.io/api/v1/calendar/earnings')).length;

describe('C2 — FMP free plan: Finnhub earnings date, known 402s skipped for 7 days, no insider call', () => {
  test('earnings: a 402 falls back to Finnhub (date only), is remembered, and the calendar is memoised per run', async () => {
    const kv = new MemoryPropertyStore();
    const net = refusing();
    const d = deps(net, kv);
    const logs: string[] = [];
    const cal = await fetchEarningsCalendar(d, 'MSTR', (m) => logs.push(m));
    assert.equal(cal.next?.dateStr, '2026-11-03', 'the soonest date from today on');
    assert.equal(cal.next?.date.toISOString(), '2026-11-03T00:00:00.000Z');
    assert.deepEqual(cal.history, [], 'history stays empty, as after the 402');
    assert.equal(fmpCalls(net, 'earnings'), 1);
    assert.equal(finnhubCalls(net), 1);
    assert.match(net.urls.find((u) => u.includes('calendar/earnings'))!, /from=2026-10-30&to=2027-10-30&symbol=MSTR&token=H$/);
    assert.equal(await kv.get(fmp402Key('earnings', 'MSTR')), String(NOW));
    assert.ok(logs.some((l) => l.includes('Finnhub [calendar/earnings]: next 2026-11-03')));

    // Same run: memoised (the dashboard, the options report and the broker course each ask).
    const again = await fetchEarningsCalendar(d, 'MSTR');
    assert.equal(again, cal);
    assert.equal(net.urls.length, 2);

    // Next run (new memo, same store), 6 days later: FMP is not asked.
    const net2 = refusing();
    const cal2 = await fetchEarningsCalendar(deps(net2, kv, NOW + 6 * DAY), 'MSTR');
    assert.equal(fmpCalls(net2, 'earnings'), 0);
    assert.equal(finnhubCalls(net2), 1);
    assert.equal(cal2.next?.dateStr, '2027-02-04', 'Nov 3 is past by then');

    // After 7 days FMP is asked again.
    const net3 = refusing();
    await fetchEarningsCalendar(deps(net3, kv, NOW + FMP_402_TTL_MS + 1), 'MSTR');
    assert.equal(fmpCalls(net3, 'earnings'), 1);
  });

  test('earnings: FMP 200 is used as before (no Finnhub call, nothing remembered); legacy (no plan) never asks Finnhub', async () => {
    const kv = new MemoryPropertyStore();
    const fmpOk = new Net((u) => (u.includes('financialmodelingprep.com/stable/earnings') ? [200, JSON.stringify([{ date: '2026-11-20', epsEstimated: 1.1 }, { date: '2026-08-01', epsActual: 1 }])] : [404, '']));
    const cal = await fetchEarningsCalendar(deps(fmpOk, kv), 'NVDA');
    assert.equal(cal.next?.dateStr, '2026-11-20');
    assert.equal(cal.history.length, 2);
    assert.equal(finnhubCalls(fmpOk), 0);
    assert.equal(kv.map.size, 0);

    const legacy = refusing();
    const lc = await fetchEarningsCalendar(deps(legacy, null), 'MSTR');
    assert.deepEqual(lc, { next: null, history: [] });
    assert.equal(finnhubCalls(legacy), 0);
    await fetchEarningsCalendar(deps(legacy, null), 'MSTR');
    assert.equal(fmpCalls(legacy, 'earnings'), 2, 'legacy: no memo');
  });

  test('earnings: no Finnhub key, or Finnhub fails -> no date (as before)', async () => {
    const kv = new MemoryPropertyStore();
    const d = { ...deps(refusing(), kv), keys: { fmp: 'F', finnhub: '', alphaVantage: '' } };
    assert.deepEqual(await fetchEarningsCalendar(d, 'MSTR'), { next: null, history: [] });
    const bad = new Net((u) => (u.includes('financialmodelingprep.com') ? [402, ''] : [500, '']));
    assert.deepEqual(await fetchEarningsCalendar(deps(bad, new MemoryPropertyStore()), 'MSTR'), { next: null, history: [] });
  });

  test('insider trading: never asked on the free plan; legacy still asks', async () => {
    const net = refusing();
    assert.equal(await fetchInsiderTradingNet(deps(net, new MemoryPropertyStore()), 'MSTR'), null);
    assert.equal(net.urls.length, 0);
    const legacy = refusing();
    assert.equal(await fetchInsiderTradingNet(deps(legacy, null), 'MSTR'), null);
    assert.equal(fmpCalls(legacy, 'insider-trading'), 1);
  });

  test('fundamentals: each refused endpoint is remembered per ticker and skipped for 7 days; the result is the same', async () => {
    const PROFILE = JSON.stringify([{ beta: 1.5, marketCap: 1e9, price: 10, sector: 'Tech', industry: 'Software' }]);
    const route = (u: string): [number, string] => (u.includes('/stable/profile?symbol=MSTR') ? [200, PROFILE] : u.includes('financialmodelingprep.com') ? [402, 'Premium'] : [404, '']);
    const kv = new MemoryPropertyStore();
    const n1 = new Net(route);
    const f1 = await fetchFMPFundamentals(deps(n1, kv), 'MSTR');
    assert.equal(n1.urls.length, 6);
    assert.deepEqual([...kv.map.keys()].sort(), ['growth', 'metrics-ttm', 'rating', 'ratios-ttm', 'target'].map((e) => fmp402Key(e, 'MSTR')).sort());
    const n2 = new Net(route);
    const logs: string[] = [];
    const f2 = await fetchFMPFundamentals(deps(n2, kv, NOW + DAY), 'MSTR', (m) => logs.push(m));
    assert.deepEqual(n2.urls.map((u) => u.split('?')[0]!.split('/').pop()), ['profile'], 'only the profile is asked');
    assert.deepStrictEqual(f2, f1, 'same result, premium-blocked flag included');
    assert.equal(f2!._premiumBlocked, true);
    assert.ok(logs.some((l) => l.includes('FMP [ratios-ttm] not on the free plan for MSTR')));
    // Another ticker is asked in full.
    const n3 = new Net(route);
    await fetchFMPFundamentals(deps(n3, kv), 'MQZC');
    assert.equal(n3.urls.length, 6);
    // Legacy (no plan): every endpoint asked every time.
    const nL = new Net(route);
    const dL = deps(nL, null);
    await fetchFMPFundamentals(dL, 'MSTR');
    await fetchFMPFundamentals(dL, 'MSTR');
    assert.equal(nL.urls.length, 12);
  });
});

describe('Chandelier: a stop above the price is not a negative distance', () => {
  test('chandelierDistanceText', () => {
    assert.equal(chandelierDistanceText(100, 95.5, false), '$4.50');
    assert.equal(chandelierDistanceText(100, 104.2, false), CHANDELIER_ABOVE_PRICE);
    assert.equal(CHANDELIER_ABOVE_PRICE, 'already above price (stop hit if held)');
    assert.equal(chandelierDistanceText(100, 100, false), '$0.00');
    assert.equal(chandelierDistanceText(100, 104.2, true), '$-4.20', 'legacy text unchanged');
  });

  test('the Analysis tab: the distance cell is a positive $ amount or the sentence, never negative', { skip: fixturesPresent() ? false : 'fixtures missing' }, async () => {
    const bodies = fixtureBodies();
    const net = new Net((u) => {
      const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(u);
      const t = m ? decodeURIComponent(m[1]!) : null;
      return t && bodies[t] ? [200, bodies[t]!] : [404, 'not found'];
    });
    const c = await compose({ storage: 'memory', env: { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ }, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    await c.analyze('TSLA');
    const grid = c.workbook.getSheetByName(ANALYSIS_TAB)!.grid();
    const at = grid.findIndex((r) => r[0] === 'Trailing stop (Chandelier)');
    assert.ok(at >= 0);
    const cell = String(grid[at + 1]![3]);
    assert.ok(cell === CHANDELIER_ABOVE_PRICE || /^\$\d/.test(cell), cell);
  });
});
