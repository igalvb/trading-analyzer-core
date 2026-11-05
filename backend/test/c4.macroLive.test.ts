/**
 * C4 (fix plan 2026-10-30): the market regime when a saved macro copy is stale.
 *
 * Before: getCachedMacroRegime is cache-only, so any of the 9 regime ETF copies stale (the Nightly late) made the
 * regime "unavailable" in /analyze. After (deps.liveWhenStale, set for /analyze outside legacy parity): only the
 * stale ETFs are fetched live through the nightly's Nasdaq request, the regime is classified from memory, nothing
 * is written back, and the read is labelled 'live (cache stale)'. Legacy freshness or no flag: unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { nasdaqHistoricalBody, recordedGet } from './macroFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { writeMacroPriceCache, macroPriceTab } from '../src/storage/macroCaches.ts';
import { nasdaqHistoricalUrl, parseNasdaqHistorical } from '../src/fetch/macro/nasdaq.ts';
import { getCachedMacroRegime, MACRO_LIVE_SOURCE, type MacroDeps } from '../src/fetch/macro/refresh.ts';
import { MACRO_REGIME_TICKERS } from '../src/analysis/macroRegime.ts';

const ready = fixturesPresent();
const TZ = 'America/New_York';
const END = '2026-08-21'; // a Friday
const NOW = Date.parse(END + 'T22:00:00Z'); // 18:00 New York, after the close
const STALE_END = '2026-08-14';

class TracingTransport implements HttpTransport {
  readonly trace: string[] = [];
  private readonly inner: HttpTransport;
  constructor(inner: HttpTransport) {
    this.inner = inner;
  }
  send(req: HttpRequest): Promise<HttpResponse> {
    this.trace.push(exchangeKey(req.method, req.url));
    return this.inner.send(req);
  }
}

const series = (t: string, end: string) => parseNasdaqHistorical(t, 200, nasdaqHistoricalBody(t, { end, bars: 260 }), () => {})!;

async function envWith(staleTickers: readonly string[]): Promise<MemoryTabStore> {
  const store = new MemoryTabStore();
  for (const t of MACRO_REGIME_TICKERS) await writeMacroPriceCache(store, t, series(t, staleTickers.includes(t) ? STALE_END : END));
  return store;
}

function deps(store: MemoryTabStore, ex: readonly RecordedExchange[], extra: Partial<MacroDeps>): { deps: MacroDeps; trace: string[]; logs: string[] } {
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  const logs: string[] = [];
  return {
    trace: transport.trace, logs,
    deps: { http: new HttpClient({ transport }), store, kv: new MemoryPropertyStore(), fmpKey: 'c4', timeZone: TZ, clock: { now: () => NOW }, log: (m) => logs.push(String(m)), ...extra },
  };
}

const liveEx = (tickers: readonly string[]): RecordedExchange[] =>
  tickers.map((t) => recordedGet(nasdaqHistoricalUrl(t), 200, nasdaqHistoricalBody(t, { end: END, bars: 260 })));

const snapshotAll = (store: MemoryTabStore): unknown => MACRO_REGIME_TICKERS.map((t) => store.snapshot(macroPriceTab(t), 6));

describe('C4 — /analyze fetches stale regime ETFs live, classifies in memory, writes nothing', { skip: ready ? false : 'fixtures missing' }, () => {
  test('two stale copies: only those two are fetched, the regime is available and labelled live; the saved copies are untouched', async () => {
    const stale = ['TLT', 'GLD'].filter((t) => MACRO_REGIME_TICKERS.includes(t));
    assert.equal(stale.length, 2, 'both are regime tickers');
    const store = await envWith(stale);
    const before = structuredClone(snapshotAll(store));
    const P = deps(store, liveEx(stale), { liveWhenStale: true });
    const read = await getCachedMacroRegime(P.deps);
    assert.deepStrictEqual(P.trace.sort(), stale.map((t) => exchangeKey('GET', nasdaqHistoricalUrl(t))).sort());
    assert.equal(read.available, true);
    assert.ok(read.regime);
    assert.equal(read.source, MACRO_LIVE_SOURCE);
    assert.deepStrictEqual(snapshotAll(store), before, 'nothing written back');
    assert.ok(P.logs.some((l) => l.includes(MACRO_LIVE_SOURCE)));

    // The same regime as if every copy were fresh.
    const fresh = await envWith([]);
    const F = deps(fresh, [], {});
    const want = await getCachedMacroRegime(F.deps);
    assert.equal(read.regime, want.regime);
    assert.equal(want.source, undefined, 'a cache read carries no source label');
  });

  test('a failed live fetch: unavailable, as before, and nothing written', async () => {
    const store = await envWith(['SPY']);
    const before = structuredClone(snapshotAll(store));
    const P = deps(store, [recordedGet(nasdaqHistoricalUrl('SPY'), 500, 'down')], { liveWhenStale: true });
    const read = await getCachedMacroRegime(P.deps);
    assert.equal(read.available, false);
    assert.equal(read.source, undefined);
    assert.deepStrictEqual(snapshotAll(store), before);
  });

  test('all fresh: no request at all, cache read', async () => {
    const P = deps(await envWith([]), [], { liveWhenStale: true });
    const read = await getCachedMacroRegime(P.deps);
    assert.deepStrictEqual(P.trace, []);
    assert.equal(read.available, true);
    assert.equal(read.source, undefined);
  });

  test('legacy (legacyFreshness) and the nightly (no flag): cache-only, unavailable, no request', async () => {
    for (const extra of [{ liveWhenStale: true, legacyFreshness: true }, {}] as Partial<MacroDeps>[]) {
      const P = deps(await envWith(['TLT']), liveEx(['TLT']), extra);
      const read = await getCachedMacroRegime(P.deps);
      assert.deepStrictEqual(P.trace, [], JSON.stringify(extra));
      assert.equal(read.available, false);
      assert.ok(P.logs.some((l) => l.includes('not fetched live')));
    }
  });
});
