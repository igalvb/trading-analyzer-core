/**
 * FL-1b: the two departures from legacy in fetchYahooChart that the user
 * approved on 2026-10-22, each behind an explicit legacy flag (the FL-1
 * parity tests set both flags and still match the oracle):
 *
 *   F-30, freshness -- a cache is fresh only if, ON TOP of legacy's rule,
 *     its last bar is on or after the most recent COMPLETED NYSE session
 *     (16:00 America/New_York, Monday-Friday; no holiday calendar exists in
 *     the repo, so holidays are not known -- see the handback);
 *   F-31, splits -- an incremental refresh that reports a split the cache
 *     has not seen (dated after its first bar) is not merged; the full 2y
 *     history is refetched instead.
 *
 * Proven narrow: outside exactly those two situations, the fixed and the
 * legacy behaviour make the same requests, return the same chart and leave
 * the same tab.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRawFixture, fixturesPresent } from './fixtures.ts';
import { BAR_TIME_UTC, yahooJson, recorded } from './yahooFixtures.ts';
import { rng } from './fundamentalsFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey,
  type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { fetchYahooChart } from '../src/fetch/chart.ts';
import { yahooChartUrl, parseYahooChart } from '../src/fetch/yahoo.ts';
import {
  MemoryPriceHistoryStore, isPriceCacheFresh, isPriceCacheFreshForSession, lastCompletedSessionDate, MARKET_TIME_ZONE,
  isLastBarPossiblyPartial, isRegularSessionOpen,
} from '../src/storage/priceHistory.ts';
import { formatDateInTz, wallClockInTz } from '../src/core/dates.ts';
import type { FetchedChart } from '../src/types/chart.ts';

const ready = fixturesPresent();
const DAY = 86_400_000;

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

type Mode = 'legacy' | 'fixed';

interface Run {
  readonly result: any;
  readonly trace: string[];
  readonly snapshot: unknown;
  /** P0: the META save time the fixed mode stamps on a tab whose last bar is today's session (removed from `snapshot`). */
  readonly savedAt?: string;
}

/** Splits the P0 `savedAt` key out of the META cell, leaving the exact legacy META text. */
function splitSavedAt(snapshot: unknown): { snapshot: unknown; savedAt?: string } {
  const grid = snapshot as any[][] | null;
  if (!grid || !grid[0] || typeof grid[0][1] !== 'string') return { snapshot };
  const meta = JSON.parse(grid[0][1]);
  if (!('savedAt' in meta)) return { snapshot };
  const savedAt = meta.savedAt as string;
  delete meta.savedAt;
  const copy = grid.map((r) => [...r]);
  copy[0][1] = JSON.stringify(meta);
  return { snapshot: copy, savedAt };
}

async function run(mode: Mode, store: MemoryPriceHistoryStore, exchanges: readonly RecordedExchange[], nowMs: number, ticker: string): Promise<Run> {
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(exchanges)));
  const legacy = mode === 'legacy';
  const result = await fetchYahooChart({
    http: new HttpClient({ transport }), store, clock: { now: () => nowMs }, legacyFreshness: legacy, legacySplitMerge: legacy,
  }, ticker);
  const split = splitSavedAt(store.snapshot(ticker));
  if (legacy) assert.equal(split.savedAt, undefined, 'legacy never stamps savedAt');
  return { result: result && structuredClone(result), trace: transport.trace, ...split };
}

async function seeded(ticker: string, data: FetchedChart): Promise<MemoryPriceHistoryStore> {
  const s = new MemoryPriceHistoryStore();
  await s.write(ticker, data);
  return s;
}

const nyDate = (ms: number): string => formatDateInTz(new Date(ms), MARKET_TIME_ZONE);
const lastBarDay = (c: { dates: Date[] }): string => c.dates[c.dates.length - 1].toISOString().slice(0, 10);

describe('FL-1b — the completed-session freshness rule (F-30)', { skip: ready ? false : 'fixtures missing' }, () => {
  test('the most recent completed NYSE session, around the close, weekends and both DST regimes', () => {
    const cases: Array<[string, string]> = [
      ['2026-10-21T19:59:00Z', '2026-10-20'], // Wed 15:59 EDT: today's session still open
      ['2026-10-21T20:00:00Z', '2026-10-21'], // Wed 16:00 EDT: closed
      ['2026-10-21T22:00:00Z', '2026-10-21'], // the nightly cron slot
      ['2026-10-22T03:59:00Z', '2026-10-21'], // Wed 23:59 EDT
      ['2026-10-22T04:00:00Z', '2026-10-21'], // Thu 00:00 EDT, before the open
      ['2026-10-24T15:00:00Z', '2026-10-23'], // Saturday
      ['2026-10-25T23:00:00Z', '2026-10-23'], // Sunday
      ['2026-10-26T13:00:00Z', '2026-10-23'], // Monday 09:00 EDT
      ['2026-11-03T20:59:00Z', '2026-11-02'], // Tue 15:59 EST
      ['2026-11-03T21:00:00Z', '2026-11-03'], // Tue 16:00 EST
    ];
    for (const [now, want] of cases) assert.equal(lastCompletedSessionDate(new Date(now)), want, now);
    assert.equal(new Date('2026-10-21').getUTCDay(), 3);
    assert.equal(new Date('2026-11-03').getUTCDay(), 2);
  });

  test('the fixed rule is exactly "last bar >= most recent completed session"; it differs from legacy in two named situations only', () => {
    const r = rng(77);
    let tooStrict = 0; // legacy fresh, fixed stale
    let weekend = 0; // legacy stale, fixed fresh
    let checked = 0;
    for (let k = 0; k < 40000; k++) {
      const now = Date.parse('2026-01-01T00:00:00Z') + Math.floor(r() * 364 * DAY);
      // A cached last bar on a weekday within the week before (or the day after) now.
      let bar = Date.parse(new Date(now - Math.floor(r() * 7) * DAY + DAY * (r() < 0.05 ? 1 : 0)).toISOString().slice(0, 10) + 'T00:00:00Z');
      while ([0, 6].includes(new Date(bar).getUTCDay())) bar -= DAY;
      const barMs = bar + (r() < 0.5 ? 13.5 : 14.5) * 3600_000;
      const cached = { dates: [new Date(barMs - 30 * DAY), new Date(barMs)] } as unknown as FetchedChart;
      const legacy = isPriceCacheFresh(cached, new Date(now));
      const fixed = isPriceCacheFreshForSession(cached, new Date(now));
      checked++;
      const barDay = new Date(barMs).toISOString().slice(0, 10);
      assert.equal(fixed, barDay >= lastCompletedSessionDate(new Date(now)), 'the whole rule');
      const w = wallClockInTz(now, MARKET_TIME_ZONE);
      const wd = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
      if (legacy && !fixed) {
        tooStrict++;
        assert.ok(wd >= 2 && wd <= 5, 'only Tuesday to Friday (NY)');
        assert.ok(w.hour * 60 + w.minute >= 16 * 60, 'only after the 16:00 close');
        assert.equal(new Date(now).toISOString().slice(0, 10), nyDate(now), 'only while UTC is still on the same calendar day');
        assert.equal(barDay, new Date(now - DAY).toISOString().slice(0, 10), "only with yesterday's bar cached");
      }
      // (the 5% "bar dated tomorrow" samples above are an artefact; they are not a real situation and are not classified)
      if (!legacy && fixed && barDay <= new Date(now).toISOString().slice(0, 10)) {
        weekend++;
        // Live-run finding 2026-10-25: legacy's "today or yesterday" rule called Friday's bar stale all weekend.
        assert.ok([0, 1, 6].includes(wd), 'only Saturday, Sunday or Monday (NY): the latest completed session is older than yesterday');
        assert.equal(barDay, lastCompletedSessionDate(new Date(now)), "and the cached bar is that session's bar");
      }
    }
    assert.ok(tooStrict > 100, `tooStrict=${tooStrict}`);
    assert.ok(weekend > 100, `weekend=${weekend}`);
    assert.ok(checked === 40000);
    // The case that was visible in the first live run (Sunday 2026-10-25, Friday's bar cached):
    const fri = { dates: [new Date('2026-10-22T13:30:00Z'), new Date('2026-10-23T13:30:00Z')] } as unknown as FetchedChart;
    assert.equal(isPriceCacheFresh(fri, new Date('2026-10-25T14:45:00Z')), false);
    assert.equal(isPriceCacheFreshForSession(fri, new Date('2026-10-25T14:45:00Z')), true);
  });

  test('outside that situation, the fixed and legacy fetches are identical -- including every weekday daytime run on a legacy-fresh cache', async () => {
    const raw = loadRawFixture('AMD');
    assert.deepStrictEqual(raw.splits ?? [], [], 'AMD: no split in range');
    const N = raw.closes.length;
    const r = rng(2026);
    const seen = { same: 0, differ: 0, daytimeFresh: 0, weekend: 0, todayBar: 0, liveSession: 0 };
    for (let k = 0; k < 600; k++) {
      const L = N - 2 - Math.floor(r() * 25);
      const lastTs = Date.parse(raw.dates[L - 1] + BAR_TIME_UTC);
      const now = Date.parse(raw.dates[L - 1] + 'T00:00:00Z') + Math.floor(r() * 7 * DAY);
      const w = wallClockInTz(now, MARKET_TIME_ZONE);
      const sessionOpen = w.hour * 60 + w.minute >= 9 * 60 + 30;
      let upTo = L;
      while (upTo < N && (raw.dates[upTo] < nyDate(now) || (raw.dates[upTo] === nyDate(now) && sessionOpen))) upTo++;
      const ex = [
        recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: upTo - 21, to: upTo })),
        recorded(yahooChartUrl('AMD', '2y'), yahooJson(raw, { from: upTo - 504, to: upTo })),
      ];
      const seed = parseYahooChart(yahooJson(raw, { from: L - 300, to: L }), 'AMD')!;
      const legacy = await run('legacy', await seeded('AMD', seed), ex, now, 'AMD');
      const fixed = await run('fixed', await seeded('AMD', seed), ex, now, 'AMD');
      const legacyFresh = isPriceCacheFresh(seed, new Date(now));
      const sessionFresh = isPriceCacheFreshForSession(seed, new Date(now));
      const differs = legacyFresh && !sessionFresh; // fixed refreshes a cache legacy would keep
      // P0: the cached last bar is today's (New York) session and has no post-close save time -> refreshed.
      const todayBar = sessionFresh && isLastBarPossiblyPartial(seed, new Date(now));
      if (todayBar) assert.equal(lastBarDay(seed as never), nyDate(now), 'P0 only ever touches a cache whose last bar is today (no savedAt in the seed)');
      const weekendSkip = !legacyFresh && sessionFresh; // fixed keeps a cache legacy would refetch (weekend)
      const wd = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
      const daytime = wd >= 1 && wd <= 5 && sessionOpen && w.hour < 16;
      if (daytime && isPriceCacheFresh(seed, new Date(now))) {
        seen.daytimeFresh++;
        assert.equal(differs, false, 'a weekday daytime run on a legacy-fresh cache never differs');
      }
      if (fixed.savedAt !== undefined) {
        assert.equal(lastBarDay(fixed.result), nyDate(now), 'savedAt is stamped only when the saved last bar is today');
        assert.equal(fixed.savedAt, new Date(now).toISOString());
      } else if (fixed.trace.length) {
        assert.notEqual(lastBarDay(fixed.result), nyDate(now), 'a saved bar of today always carries savedAt');
      }
      if (todayBar) {
        assert.deepStrictEqual(legacy.trace, [], 'legacy reuses the cached bar of today');
        assert.deepStrictEqual(fixed.trace, [exchangeKey('GET', yahooChartUrl('AMD', '1mo'))], 'the fix refetches the 1mo increment');
        const n = seed.closes.length;
        assert.deepStrictEqual(fixed.result.closes.slice(0, n - 1), [...seed.closes.slice(0, n - 1)], 'completed bars untouched');
        assert.deepStrictEqual(fixed.result.dates.slice(0, n - 1), structuredClone([...seed.dates.slice(0, n - 1)]));
        assert.equal(lastBarDay(fixed.result), nyDate(now), "today's bar replaced in place");
        seen.todayBar++;
      } else if (sessionFresh && isRegularSessionOpen(new Date(now)) && lastBarDay(seed as never) < nyDate(now)) {
        // P0 gap 1: the session is open and the cache ends on an earlier session -> today's bar appended, live price.
        assert.deepStrictEqual(fixed.trace, [exchangeKey('GET', yahooChartUrl('AMD', '1mo'))], 'the fix fetches the 1mo increment');
        const n = seed.closes.length;
        assert.deepStrictEqual(fixed.result.closes.slice(0, n), [...seed.closes], 'every cached bar untouched');
        if (raw.dates.includes(nyDate(now))) {
          assert.equal(lastBarDay(fixed.result), nyDate(now), "today's bar appended");
          assert.equal(fixed.result.currentPrice, raw.closes[raw.dates.indexOf(nyDate(now))], 'live price');
        }
        seen.liveSession++;
      } else if (weekendSkip) {
        assert.deepStrictEqual(fixed.trace, [], 'fixed: the cache already holds the latest completed session, no request');
        assert.ok(legacy.trace.length >= 1, 'legacy: refetches it');
        assert.equal(lastBarDay(fixed.result), lastCompletedSessionDate(new Date(now)), 'fixed: exactly the latest completed session');
        assert.ok(lastBarDay(legacy.result) >= lastBarDay(fixed.result), 'legacy: the same bar, or also an in-progress bar of today (Monday daytime)');
        seen.weekend++;
      } else if (!differs) {
        assert.deepStrictEqual({ result: fixed.result, trace: fixed.trace, snapshot: fixed.snapshot }, legacy, `k=${k} now=${new Date(now).toISOString()}`);
        seen.same++;
      } else {
        assert.deepStrictEqual(legacy.trace, [], 'legacy treats the cache as fresh');
        assert.ok(fixed.trace.length >= 1, 'the fix refreshes it');
        assert.ok(lastBarDay(fixed.result) > lastBarDay(legacy.result), 'and gets the completed bar');
        seen.differ++;
      }
    }
    for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} never reached`);
  });

  test('before/after on five 22:00 UTC nights: legacy analyses yesterday\'s bar every other night, the fix analyses the day\'s bar every night', async () => {
    const raw = loadRawFixture('AMD');
    const i0 = raw.dates.indexOf('2026-08-14');
    assert.ok(i0 > 0 && raw.dates[i0 + 5] === '2026-08-21', 'Fri 08-14, then Mon 08-17 .. Fri 08-21');
    const out: Record<Mode, string[]> = { legacy: [], fixed: [] };
    for (const mode of ['legacy', 'fixed'] as const) {
      const store = await seeded('AMD', parseYahooChart(yahooJson(raw, { from: i0 - 300, to: i0 + 1 }), 'AMD')!);
      for (let j = 1; j <= 5; j++) {
        const ex = [
          recorded(yahooChartUrl('AMD', '1mo'), yahooJson(raw, { from: i0 + j - 20, to: i0 + j + 1 })),
          recorded(yahooChartUrl('AMD', '2y'), yahooJson(raw, { from: i0 + j - 503, to: i0 + j + 1 })),
        ];
        const res = await run(mode, store, ex, Date.parse(raw.dates[i0 + j] + 'T22:00:00Z'), 'AMD');
        out[mode].push(lastBarDay(res.result));
      }
    }
    assert.deepStrictEqual(out.legacy, ['2026-08-17', '2026-08-17', '2026-08-19', '2026-08-19', '2026-08-21']);
    assert.deepStrictEqual(out.fixed, ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']);
  });
});

describe('FL-1b — a split reported by the increment forces a full refetch (F-31)', { skip: ready ? false : 'fixtures missing' }, () => {
  const nvda = (): { raw: ReturnType<typeof loadRawFixture>; si: number } => {
    const raw = loadRawFixture('NVDA');
    const split = (raw.splits ?? []).find((s) => s.numerator === 10)!;
    const si = raw.dates.findIndex((d) => Date.parse(d + 'T00:00:00Z') >= split.date * 1000);
    return { raw, si };
  };

  test('before/after on NVDA\'s 10:1 split: legacy merges unadjusted history (a ~90% one-bar drop), the fix refetches 2y and the series is continuous', async () => {
    const { raw, si } = nvda();
    const preSplit = parseYahooChart(yahooJson(raw, { from: si - 300, to: si, scale: () => 10, withSplits: false }), 'NVDA')!;
    const twoY = yahooJson(raw, { from: si + 4 - 504, to: si + 4 });
    const ex = [recorded(yahooChartUrl('NVDA', '1mo'), yahooJson(raw, { from: si - 15, to: si + 4 })), recorded(yahooChartUrl('NVDA', '2y'), twoY)];
    const now = Date.parse(raw.dates[si + 3] + 'T22:00:00Z');
    const legacy = await run('legacy', await seeded('NVDA', preSplit), ex, now, 'NVDA');
    const fixed = await run('fixed', await seeded('NVDA', preSplit), ex, now, 'NVDA');
    const join = legacy.result.closes.length - 4;
    assert.ok(legacy.result.closes[join] / legacy.result.closes[join - 1] < 0.15, 'legacy: the discontinuity');
    assert.deepStrictEqual(legacy.trace, [exchangeKey('GET', yahooChartUrl('NVDA', '1mo'))]);
    assert.deepStrictEqual(fixed.trace, [exchangeKey('GET', yahooChartUrl('NVDA', '1mo')), exchangeKey('GET', yahooChartUrl('NVDA', '2y'))]);
    assert.deepStrictEqual(fixed.result, structuredClone(parseYahooChart(twoY, 'NVDA')), 'the fix returns the adjusted 2y history');
    assert.ok(fixed.result);
    const c: readonly number[] = fixed.result.closes;
    for (let i = 1; i < c.length; i++) assert.ok(c[i] / c[i - 1] > 0.6 && c[i] / c[i - 1] < 1.6, `continuous at ${i}`);
    assert.equal((fixed.snapshot as unknown[]).length, c.length + 2, 'the tab was rewritten in full');
    assert.ok(fixed.result.splits.some((s: { numerator: number }) => s.numerator === 10));
  });

  test('no false trigger: a split already in the cache, or dated before the first cached bar, merges exactly as legacy does', async () => {
    const { raw, si } = nvda();
    const cases: Array<[string, FetchedChart, number]> = [
      ['split already recorded in META', parseYahooChart(yahooJson(raw, { from: si - 300, to: si + 2 }), 'NVDA')!, si + 2],
      ['split before the first cached bar', parseYahooChart(yahooJson(raw, { from: si + 5, to: si + 200, withSplits: false }), 'NVDA')!, si + 200],
    ];
    for (const [label, seed, end] of cases) {
      const ex = [recorded(yahooChartUrl('NVDA', '1mo'), yahooJson(raw, { from: end - 15, to: end + 3 }))];
      const now = Date.parse(raw.dates[end + 2] + 'T22:00:00Z') + 2 * DAY;
      const legacy = await run('legacy', await seeded('NVDA', seed), ex, now, 'NVDA');
      const fixed = await run('fixed', await seeded('NVDA', seed), ex, now, 'NVDA');
      assert.deepStrictEqual(fixed, legacy, label);
      assert.equal(legacy.trace.length, 1, label + ': one incremental request, merged');
    }
  });
});
