/**
 * P0 (fix plan 2026-10-30): the price is frozen during market hours.
 *
 * Before: a saved history whose last bar is today counted as fresh, so a bar saved at 10:00 New York (and its
 * META currentPrice) was reused all day (F-32). After (outside legacy-parity mode): a cached last bar that may
 * still be in progress -- today's bar with no save time at/after 16:00 New York, or any bar whose META `savedAt`
 * is before its session's close -- is refreshed from the '1mo' increment: that bar is REPLACED, newer bars are
 * appended, currentPrice / prevClose come from the fetch, and the completed bars are never rewritten.
 * The legacy flag (legacyFreshness) keeps the old behaviour exactly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRawFixture, fixturesPresent } from './fixtures.ts';
import { yahooJson, recorded } from './yahooFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { fetchYahooChart } from '../src/fetch/chart.ts';
import { yahooChartUrl, parseYahooChart } from '../src/fetch/yahoo.ts';
import {
  MemoryPriceHistoryStore, isLastBarPossiblyPartial, isRegularSessionOpen, encodePriceMeta, decodePriceHistory, validDateCell,
} from '../src/storage/priceHistory.ts';
import type { FetchedChart } from '../src/types/chart.ts';

const ready = fixturesPresent();
const DAY = '2026-08-19'; // a Wednesday (EDT: 10:00 New York = 14:00 UTC, 16:00 = 20:00 UTC)
const at = (hhmmUtc: string, day = DAY): number => Date.parse(`${day}T${hhmmUtc}:00Z`);
const PARTIAL_CLOSE = 111.11; // the 10:00 price saved with the bar

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

function setup(): { raw: ReturnType<typeof loadRawFixture>; i: number; partialSeed: FetchedChart; ex: RecordedExchange[]; livePrice: number } {
  const raw = loadRawFixture('AMD');
  const i = raw.dates.indexOf(DAY);
  assert.ok(i > 300 && raw.dates[i + 1] === '2026-08-20');
  // The cache as saved at 10:00: today's bar with the 10:00 price as its close and as META currentPrice.
  const partialSeed = parseYahooChart(yahooJson(raw, { from: i - 300, to: i + 1, overrideClose: { [i]: PARTIAL_CLOSE }, regularMarketPrice: PARTIAL_CLOSE }), 'AMD')!;
  const livePrice = raw.closes[i] as number;
  const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i - 20, to: i + 1, regularMarketPrice: livePrice }))];
  return { raw, i, partialSeed, ex, livePrice };
}

async function storeWith(seed: FetchedChart, savedAt?: number): Promise<MemoryPriceHistoryStore> {
  const s = new MemoryPriceHistoryStore();
  await s.write('AMD', savedAt === undefined ? seed : { ...seed, savedAt });
  return s;
}

async function run(store: MemoryPriceHistoryStore, ex: readonly RecordedExchange[], nowMs: number, legacy = false): Promise<{ result: FetchedChart | null; trace: string[] }> {
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  const result = await fetchYahooChart({
    http: new HttpClient({ transport }), store, clock: { now: () => nowMs }, legacyFreshness: legacy, legacySplitMerge: legacy,
  }, 'AMD');
  return { result, trace: transport.trace };
}

const META = (store: MemoryPriceHistoryStore): any => JSON.parse(store.snapshot('AMD')![0][1] as string);
const ONE_MONTH = exchangeKey('GET', yahooChartUrl('AMD', '1mo'));

describe('P0 — a bar of today saved during the session is refreshed', { skip: ready ? false : 'fixtures missing' }, () => {
  test("cache with today's 10:00 bar, run at 14:35 New York: refetch, price updated, earlier bars untouched", async () => {
    const { partialSeed, ex, livePrice, raw, i } = setup();
    const store = await storeWith(partialSeed, at('14:00'));
    const before = store.snapshot('AMD')!;
    const now = at('18:35');
    const { result, trace } = await run(store, ex, now);
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    assert.ok(result);
    assert.equal(result.currentPrice, livePrice);
    assert.notEqual(result.currentPrice, PARTIAL_CLOSE);
    assert.equal(result.prevClose, raw.closes[i - 1]);
    const n = partialSeed.closes.length;
    assert.equal(result.closes.length, n, 'no bar added or lost');
    assert.equal(result.closes[n - 1], livePrice, "today's bar replaced");
    assert.equal(result.highs[n - 1], raw.highs![i]);
    assert.deepStrictEqual(result.closes.slice(0, n - 1), partialSeed.closes.slice(0, n - 1), 'completed bars untouched');
    assert.deepStrictEqual(result.dates.map((d) => d.getTime()), partialSeed.dates.map((d) => d.getTime()));
    assert.equal(result.savedAt, undefined, 'the save time is not part of the returned chart');
    const after = store.snapshot('AMD')!;
    assert.deepStrictEqual(after.slice(1, -1), before.slice(1, -1), 'the saved completed rows are byte-identical');
    assert.equal(after[after.length - 1][4], livePrice, 'the saved last row is the refreshed bar');
    assert.equal(META(store).currentPrice, livePrice);
    assert.equal(META(store).savedAt, new Date(now).toISOString(), 'stamped with this save time');
  });

  test('same cache after 16:15 New York with a post-close save: no fetch', async () => {
    const { partialSeed } = setup();
    const store = await storeWith(partialSeed, at('20:05')); // saved 16:05
    const { result, trace } = await run(store, [], at('20:15'));
    assert.deepStrictEqual(trace, []);
    assert.equal(result!.currentPrice, PARTIAL_CLOSE, 'the saved (final) values are used as they are');
    assert.equal(result!.savedAt, undefined);
  });

  test('after the close, a bar saved before 16:00 is refreshed once, then final', async () => {
    const { partialSeed, ex, livePrice } = setup();
    const store = await storeWith(partialSeed, at('14:00'));
    const first = await run(store, ex, at('20:15'));
    assert.deepStrictEqual(first.trace, [ONE_MONTH]);
    assert.equal(first.result!.currentPrice, livePrice);
    const second = await run(store, ex, at('20:30'));
    assert.deepStrictEqual(second.trace, [], 'the post-close save is final');
    assert.equal(second.result!.currentPrice, livePrice);
  });

  test('the same run reading the ticker again within 5 minutes reuses the refreshed bar; later it refreshes again', async () => {
    const { partialSeed, ex, livePrice } = setup();
    const store = await storeWith(partialSeed, at('14:00'));
    assert.deepStrictEqual((await run(store, ex, at('18:35'))).trace, [ONE_MONTH]);
    const again = await run(store, ex, at('18:39'));
    assert.deepStrictEqual(again.trace, [], 'refreshed 4 minutes ago');
    assert.equal(again.result!.currentPrice, livePrice);
    assert.equal(again.result!.savedAt, undefined);
    assert.deepStrictEqual((await run(store, ex, at('18:41'))).trace, [ONE_MONTH], '6 minutes later: refreshed again');
  });

  test('a cache of today with no save time (saved before this fix) counts as in progress', async () => {
    const { partialSeed, ex, livePrice } = setup();
    const { trace, result } = await run(await storeWith(partialSeed), ex, at('18:35'));
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    assert.equal(result!.currentPrice, livePrice);
  });

  test('next morning: yesterday\'s bar saved mid-session is replaced by its final values; newer bars appended', async () => {
    const { raw, i, partialSeed, livePrice } = setup();
    const store = await storeWith(partialSeed, at('14:00'));
    // Thursday 11:00 New York: the increment carries Wednesday's final bar and Thursday's bar so far.
    const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i - 20, to: i + 2 }))];
    const now = at('15:00', '2026-08-20');
    const { trace, result } = await run(store, ex, now);
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    const n = partialSeed.closes.length;
    assert.equal(result!.closes.length, n + 1);
    assert.equal(result!.closes[n - 1], livePrice, "Wednesday's final close");
    assert.equal(result!.closes[n], raw.closes[i + 1]);
    assert.deepStrictEqual(result!.closes.slice(0, n - 1), partialSeed.closes.slice(0, n - 1));
    assert.equal(META(store).savedAt, new Date(now).toISOString(), "Thursday's bar is today's: stamped");
  });

  test('a stale cache (two sessions behind) whose last bar was saved mid-session: that bar is replaced, the newer ones appended', async () => {
    const { raw, i, partialSeed, livePrice } = setup();
    const store = await storeWith(partialSeed, at('14:00'));
    const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i - 20, to: i + 3 }))];
    const { trace, result } = await run(store, ex, at('22:00', '2026-08-21'));
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    const n = partialSeed.closes.length;
    assert.equal(result!.closes.length, n + 2);
    assert.equal(result!.closes[n - 1], livePrice, "Wednesday's mid-session bar replaced by its final values");
    assert.deepStrictEqual(result!.closes.slice(0, n - 1), partialSeed.closes.slice(0, n - 1));
    assert.equal(META(store).savedAt, new Date(at('22:00', '2026-08-21')).toISOString(), "Friday's bar, saved after the close");
  });

  test('gap 1: 10:30 New York, cache ending yesterday (saved after yesterday\'s close): fetch, today\'s bar appended, live price', async () => {
    const { raw, i } = setup();
    const seed = parseYahooChart(yahooJson(raw, { from: i - 300, to: i + 1 }), 'AMD')!; // ends Wed 08-19
    const store = await storeWith(seed, at('20:30')); // saved Wed 16:30
    const before = store.snapshot('AMD')!;
    const live = 123.45;
    const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i - 20, to: i + 2, regularMarketPrice: live }))];
    const now = at('14:30', '2026-08-20'); // Thu 10:30 EDT
    const { trace, result } = await run(store, ex, now);
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    const n = seed.closes.length;
    assert.equal(result!.closes.length, n + 1);
    assert.equal(result!.currentPrice, live, 'the live price');
    assert.equal(result!.closes[n], raw.closes[i + 1], "today's bar so far");
    assert.equal(result!.prevClose, raw.closes[i]);
    assert.deepStrictEqual(result!.closes.slice(0, n), seed.closes, 'every cached (completed) bar untouched');
    assert.deepStrictEqual(store.snapshot('AMD')!.slice(1, n + 2), before.slice(1, n + 2), 'saved rows unchanged');
    assert.equal(META(store).savedAt, new Date(now).toISOString(), "today's bar stamped");
    // within 5 minutes: reused; later: refreshed (as a bar of today)
    assert.deepStrictEqual((await run(store, ex, now + 3 * 60_000)).trace, []);
    assert.deepStrictEqual((await run(store, ex, now + 10 * 60_000)).trace, [ONE_MONTH]);
  });

  test('gap 1: a failed fetch during the session uses the cache as before', async () => {
    const { raw, i } = setup();
    const seed = parseYahooChart(yahooJson(raw, { from: i - 300, to: i + 1 }), 'AMD')!;
    const { trace, result } = await run(await storeWith(seed), [recorded(yahooChartUrl('AMD', '1mo'), 'oops', 500)], at('14:30', '2026-08-20'));
    assert.deepStrictEqual(trace, [ONE_MONTH]);
    assert.equal(result!.currentPrice, seed.currentPrice);
    assert.equal(result!.closes.length, seed.closes.length);
  });

  test('gap 1: 08:00 New York pre-market, weekend and holiday -> no fetch (a completed bar with no save time is final)', async () => {
    const { raw } = setup();
    const ending = (day: string): FetchedChart => {
      const j = raw.dates.indexOf(day);
      assert.ok(j > 300, day);
      return parseYahooChart(yahooJson(raw, { from: j - 300, to: j + 1 }), 'AMD')!;
    };
    const cases: Array<[string, FetchedChart, number]> = [
      ['Thu 08:00 pre-market', ending('2026-08-19'), at('12:00', '2026-08-20')],
      ['Saturday 11:00', ending('2026-08-21'), at('15:00', '2026-08-22')],
      ['Independence Day (observed) 11:00', ending('2026-07-02'), at('15:00', '2026-07-03')],
    ];
    for (const [label, seed, now] of cases) {
      const { trace } = await run(await storeWith(seed), [], now);
      assert.deepStrictEqual(trace, [], label);
    }
    assert.equal(isRegularSessionOpen(new Date(at('13:29', '2026-08-20'))), false, '09:29');
    assert.equal(isRegularSessionOpen(new Date(at('13:30', '2026-08-20'))), true, '09:30');
    assert.equal(isRegularSessionOpen(new Date(at('19:59', '2026-08-20'))), true, '15:59');
    assert.equal(isRegularSessionOpen(new Date(at('20:00', '2026-08-20'))), false, '16:00');
    assert.equal(isRegularSessionOpen(new Date(at('15:00', '2026-11-26'))), false, 'Thanksgiving');
    assert.equal(isRegularSessionOpen(new Date('2026-11-27T15:00:00Z')), true, 'the day after (early close treated as 16:00)');
  });

  test('gap 1: legacy flag keeps the old behaviour during the session', async () => {
    const { raw, i } = setup();
    const seed = parseYahooChart(yahooJson(raw, { from: i - 300, to: i + 1 }), 'AMD')!;
    const ex = [recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i - 20, to: i + 2 }))];
    const { trace, result } = await run(await storeWith(seed), ex, at('14:30', '2026-08-20'), true);
    assert.deepStrictEqual(trace, []);
    assert.equal(result!.currentPrice, seed.currentPrice);
  });

  test('legacy flag: the old behaviour (the 10:00 bar and price are reused, nothing stamped)', async () => {
    const { partialSeed, ex } = setup();
    const store = await storeWith(partialSeed);
    const before = store.snapshot('AMD');
    const { result, trace } = await run(store, ex, at('18:35'), true);
    assert.deepStrictEqual(trace, []);
    assert.equal(result!.currentPrice, PARTIAL_CLOSE);
    assert.deepStrictEqual(store.snapshot('AMD'), before);
    // and a legacy save of today's bar carries no savedAt
    const fresh = new MemoryPriceHistoryStore();
    await run(fresh, [recorded(yahooChartUrl('AMD', '2y'), yahooJson(setup().raw, { from: setup().i - 400, to: setup().i + 1 }))], at('18:35'), true);
    assert.equal('savedAt' in META(fresh), false);
  });
});

describe('P0 — the save-time rule and its META encoding', () => {
  const bar = (iso: string): FetchedChart => ({ dates: [new Date(iso)] } as unknown as FetchedChart);
  test('isLastBarPossiblyPartial', () => {
    const today = '2026-08-19T13:30:00Z';
    assert.equal(isLastBarPossiblyPartial(bar(today), new Date(at('18:35'))), true, 'today, no save time');
    assert.equal(isLastBarPossiblyPartial({ ...bar(today), savedAt: at('14:00') }, new Date(at('18:35'))), true);
    assert.equal(isLastBarPossiblyPartial({ ...bar(today), savedAt: at('19:59') }, new Date(at('20:15'))), true, '15:59 save');
    assert.equal(isLastBarPossiblyPartial({ ...bar(today), savedAt: at('20:00') }, new Date(at('20:15'))), false, '16:00 save');
    assert.equal(isLastBarPossiblyPartial(bar('2026-08-18T13:30:00Z'), new Date(at('18:35'))), false, 'yesterday, no save time');
    assert.equal(isLastBarPossiblyPartial({ ...bar('2026-08-18T13:30:00Z'), savedAt: at('14:00', '2026-08-18') }, new Date(at('18:35'))), true);
    assert.equal(isLastBarPossiblyPartial({ ...bar('2026-08-18T13:30:00Z'), savedAt: at('14:00') }, new Date(at('18:35'))), false, 'saved the next day');
    // Friday's bar saved mid-session, read on Saturday
    assert.equal(isLastBarPossiblyPartial({ ...bar('2026-08-21T13:30:00Z'), savedAt: at('15:00', '2026-08-21') }, new Date(at('15:00', '2026-08-22'))), true);
  });

  test('savedAt is the last META key, only when set; decoded back; legacy META text unchanged', () => {
    const c = { ticker: 'X', currentPrice: 1, prevClose: 0.9, currency: 'USD', ipoDate: null, splits: [], dates: [new Date(at('13:30'))], opens: [1], highs: [1], lows: [1], closes: [1], volumes: [1] } as unknown as FetchedChart;
    const plain = encodePriceMeta(c);
    assert.equal(plain, '{"ticker":"X","currentPrice":1,"prevClose":0.9,"currency":"USD","ipoDate":null,"splits":[]}');
    const stamped = encodePriceMeta({ ...c, savedAt: at('14:00') });
    assert.equal(stamped, plain.slice(0, -1) + ',"savedAt":"2026-08-19T14:00:00.000Z"}');
    const back = decodePriceHistory('X', stamped, [[new Date(at('13:30')), 1, 1, 1, 1, 1]], validDateCell)!;
    assert.equal(back.savedAt, at('14:00'));
    assert.equal('savedAt' in decodePriceHistory('X', plain, [[new Date(at('13:30')), 1, 1, 1, 1, 1]], validDateCell)!, false);
  });
});
