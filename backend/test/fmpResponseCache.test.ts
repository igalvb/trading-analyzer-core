/**
 * Owner 2026-11-01 (FMP free plan, ~250 calls/day): FMP's fundamentals answers are kept 24 h per endpoint + ticker
 * in the property store, except `profile` (its price must be the run's own). A second run within 24 h asks only
 * the profile; after 24 h it asks everything again; a 429 (or a 402,
 * or any other failure) is not cached; only the fields read are kept. The broker data's interest coverage shares
 * the ratios-ttm entry. Unset (parity / legacy, FMP_RESPONSE_CACHE=off): every run asks.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import {
  fetchFMPFundamentals, fmpCacheKey, fmp402Key, FMP_RESPONSE_CACHE_HOURS, type FundamentalsDeps,
} from '../src/fetch/fundamentals/providers.ts';
import { fetchFMPInterestCoverage } from '../src/fetch/macro/refresh.ts';
import { classifyProperty } from '../src/scriptPropertiesAudit.ts';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-01T15:00:00Z');
const TTL = FMP_RESPONSE_CACHE_HOURS * 3600000;

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

const BODIES: Record<string, string> = {
  profile: JSON.stringify([{ beta: 1.2, marketCap: 3e12, lastDividend: 1, price: 200, sector: 'Tech', industry: 'Hardware', companyName: 'Apple Inc.', description: 'x'.repeat(2000), cusip: '037833100' }]),
  'ratios-ttm': JSON.stringify([{ priceToEarningsRatioTTM: 30, priceToBookRatioTTM: 40, netProfitMarginTTM: 0.25, debtToEquityRatioTTM: 1.5, interestCoverageRatioTTM: 29.1, unusedTTM: 7 }]),
  'key-metrics-ttm': JSON.stringify([{ returnOnEquityTTM: 1.5, returnOnAssetsTTM: 0.3, other: 1 }]),
  'financial-growth': JSON.stringify([{ revenueGrowth: 0.05, netIncomeGrowth: 0.1, other: 1 }]),
  'price-target-consensus': JSON.stringify([{ targetConsensus: 250, targetHigh: 300, targetLow: 180 }]),
  'ratings-snapshot': '[]',
};
const endpointOf = (u: string): string => u.split('?')[0]!.split('/').pop()!;
const ok = (u: string): [number, string] => (u.includes('financialmodelingprep.com') ? [200, BODIES[endpointOf(u)] ?? '[]'] : [404, '']);
const fmpCalls = (n: Net): number => n.urls.filter((u) => u.includes('financialmodelingprep.com')).length;

function deps(net: Net, kv: MemoryPropertyStore | null, now = NOW, responseCache = true): FundamentalsDeps {
  return {
    http: new HttpClient({ transport: net }), keys: { fmp: 'F', finnhub: '', alphaVantage: '' }, timeZone: TZ, clock: { now: () => now }, withCompanyName: true,
    ...(kv ? { fmpFreePlan: { kv, earningsMemo: new Map(), responseCache } } : {}),
  };
}

describe('FMP 24 h response cache (owner 2026-11-01)', () => {
  test('a second run within 24 h makes 0 cached-endpoint calls (only the live profile) and gives the same result; after 24 h it fetches again', async () => {
    const kv = new MemoryPropertyStore();
    const n1 = new Net(ok);
    const f1 = await fetchFMPFundamentals(deps(n1, kv), 'AAPL');
    assert.equal(fmpCalls(n1), 6);
    assert.ok(f1 && f1.trailingPE === 30 && f1._companyName === 'Apple Inc.');

    const n2 = new Net(ok);
    const logs: string[] = [];
    const f2 = await fetchFMPFundamentals(deps(n2, kv, NOW + TTL - 60000), 'AAPL', (m) => logs.push(m));
    assert.deepEqual(n2.urls.map(endpointOf), ['profile'], 'within 24 h only the profile (live price) is asked');
    assert.deepStrictEqual(f2, f1);
    assert.ok(logs.includes('  FMP: 5/5 cacheable endpoints from the 24 h cache for AAPL (5 FMP calls saved)'), logs.join('\n'));

    const n3 = new Net(ok);
    const f3 = await fetchFMPFundamentals(deps(n3, kv, NOW + TTL + 1), 'AAPL');
    assert.equal(fmpCalls(n3), 6, 'asked again after 24 h');
    assert.deepStrictEqual(f3, f1);

    // Another ticker is not served from AAPL's entries.
    const n4 = new Net(ok);
    await fetchFMPFundamentals(deps(n4, kv, NOW + 1000), 'MSFT');
    assert.equal(fmpCalls(n4), 6);
  });

  test('the price is never older than the run: profile is not cached, a later run sees the new price', async () => {
    const kv = new MemoryPropertyStore();
    const f1 = await fetchFMPFundamentals(deps(new Net(ok), kv), 'AAPL');
    assert.equal(f1!.price, 200);
    assert.equal(kv.map.has(fmpCacheKey('profile', 'AAPL')), false, 'profile never written');
    const moved = (u: string): [number, string] => (endpointOf(u) === 'profile'
      ? [200, JSON.stringify([{ beta: 1.2, marketCap: 3.3e12, lastDividend: 1, price: 220, sector: 'Tech', industry: 'Hardware', companyName: 'Apple Inc.' }])]
      : ok(u));
    const n2 = new Net(moved);
    const f2 = await fetchFMPFundamentals(deps(n2, kv, NOW + 3600000), 'AAPL');
    assert.equal(f2!.price, 220, "this run's price");
    assert.equal(f2!.marketCap, 3.3e12);
    assert.equal(f2!.trailingPE, 30, 'ratios from the cache');
    assert.deepEqual(n2.urls.map(endpointOf), ['profile']);
  });

  test('only the fields read are kept; an empty 200 is kept as "no rows"', async () => {
    const kv = new MemoryPropertyStore();
    await fetchFMPFundamentals(deps(new Net(ok), kv), 'AAPL');
    const ratios = JSON.parse(kv.map.get(fmpCacheKey('ratios-ttm', 'AAPL'))!);
    assert.equal(ratios._ttlHours, 24);
    assert.deepEqual(ratios.data.v, { priceToEarningsRatioTTM: 30, priceToBookRatioTTM: 40, netProfitMarginTTM: 0.25, debtToEquityRatioTTM: 1.5, interestCoverageRatioTTM: 29.1 });
    assert.ok(kv.map.get(fmpCacheKey('ratios-ttm', 'AAPL'))!.length < 250);
    assert.deepEqual(JSON.parse(kv.map.get(fmpCacheKey('rating', 'AAPL'))!).data, { v: null });
    // The audit knows the key (expires like any cacheSet entry).
    assert.equal(classifyProperty(fmpCacheKey('ratios-ttm', 'AAPL'), kv.map.get(fmpCacheKey('ratios-ttm', 'AAPL'))!, NOW + TTL + 3600000).status, 'expired');
  });

  test('a 429 / "Limit Reach" is not cached: the next run asks that endpoint again', async () => {
    const kv = new MemoryPropertyStore();
    const limited = (u: string): [number, string] => {
      const e = endpointOf(u);
      if (e === 'ratios-ttm') return [429, 'Too Many Requests'];
      if (e === 'key-metrics-ttm') return [200, '{"Error Message":"Limit Reach . Please upgrade your plan"}'];
      if (e === 'financial-growth') return [500, 'oops'];
      if (e === 'price-target-consensus') return [402, 'Premium'];
      return ok(u);
    };
    const n1 = new Net(limited);
    const f1 = await fetchFMPFundamentals(deps(n1, kv), 'AAPL');
    assert.equal(f1!._rateLimited, true);
    for (const e of ['ratios-ttm', 'metrics-ttm', 'growth', 'target']) assert.equal(kv.map.has(fmpCacheKey(e, 'AAPL')), false, e + ' not cached');
    assert.ok(kv.map.has(fmp402Key('target', 'AAPL')), 'the 402 is still remembered (7 days) as before');

    const n2 = new Net(ok);
    const logs: string[] = [];
    await fetchFMPFundamentals(deps(n2, kv, NOW + 60000), 'AAPL', (m) => logs.push(m));
    assert.deepEqual(n2.urls.map(endpointOf).sort(), ['financial-growth', 'key-metrics-ttm', 'profile', 'ratios-ttm'], 'only the failed endpoints (and the live profile) are asked (the 402 is skipped)');
    assert.ok(logs.includes('  FMP: 1/5 cacheable endpoints from the 24 h cache for AAPL (1 FMP call saved)'), logs.join('\n'));
  });

  test('off (parity / legacy / FMP_RESPONSE_CACHE=off): every run asks and nothing is written', async () => {
    const kv = new MemoryPropertyStore();
    const n = new Net(ok);
    await fetchFMPFundamentals(deps(n, kv, NOW, false), 'AAPL');
    await fetchFMPFundamentals(deps(n, kv, NOW, false), 'AAPL');
    assert.equal(fmpCalls(n), 12);
    assert.equal(kv.map.size, 0);
    const nL = new Net(ok);
    await fetchFMPFundamentals(deps(nL, null), 'AAPL');
    await fetchFMPFundamentals(deps(nL, null), 'AAPL');
    assert.equal(fmpCalls(nL), 12);
  });

  test('the broker data interest coverage shares the ratios-ttm entry (one call a day for both)', async () => {
    const kv = new MemoryPropertyStore();
    const clock = { now: () => NOW };
    const n = new Net(ok);
    const http = new HttpClient({ transport: n });
    assert.equal(await fetchFMPInterestCoverage({ http, fmpKey: 'F', kv, clock, fmpResponseCache: true }, 'AAPL'), 29.1);
    assert.equal(fmpCalls(n), 1);
    const n2 = new Net(ok);
    await fetchFMPFundamentals(deps(n2, kv, NOW + 1000), 'AAPL');
    assert.deepEqual(n2.urls.map(endpointOf).includes('ratios-ttm'), false, 'fundamentals reuse the broker fetch');
    assert.equal(fmpCalls(n2), 5);
    assert.equal(await fetchFMPInterestCoverage({ http: new HttpClient({ transport: n2 }), fmpKey: 'F', kv, clock, fmpResponseCache: true }, 'AAPL'), 29.1);
    assert.equal(fmpCalls(n2), 5, 'served from the cache');
    // A 429 is not cached; unset = legacy (always asks, nothing written).
    const kv2 = new MemoryPropertyStore();
    const n429 = new Net(() => [429, '']);
    let why = '';
    assert.equal(await fetchFMPInterestCoverage({ http: new HttpClient({ transport: n429 }), fmpKey: 'F', kv: kv2, clock, fmpResponseCache: true }, 'AAPL', (r) => { why = r; }), null);
    assert.equal(why, 'HTTP 429');
    assert.equal(kv2.map.size, 0);
    const nL = new Net(ok);
    await fetchFMPInterestCoverage({ http: new HttpClient({ transport: nL }), fmpKey: 'F', kv: kv2 }, 'AAPL');
    await fetchFMPInterestCoverage({ http: new HttpClient({ transport: nL }), fmpKey: 'F', kv: kv2 }, 'AAPL');
    assert.equal(fmpCalls(nL), 2);
    assert.equal(kv2.map.size, 0);
  });
});
