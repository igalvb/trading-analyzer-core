/**
 * FL-7a-2b: the saved-copy rule (approved; default OFF in compose until the
 * score-input list is confirmed), the fetched-at stamp, and F-36 option B's
 * series tab. Legacy mode (no option) is unchanged -- fl2.fundamentals keeps
 * comparing it with the oracle.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { tabSeriesStore, FUNDAMENTALS_SERIES_TAB } from '../src/storage/fundamentalsSeriesTab.ts';
import {
  resolveFundamentals, judgeSavedCopy, savedAtOf, earningsSinceFromSavedCopy, type SavedCopyVerdict, type FundamentalsFallbackPolicy,
} from '../src/fetch/fundamentals/resolve.ts';

const NOW = Date.parse('2026-10-24T20:00:00Z');
const DAY = 86400000;
const fundOf = (extra: Record<string, unknown> = {}) => ({ _sources: ['FMP'], beta: 1.1, sector: 'Technology', forwardPE: 30, _metricSeries: { quarterly: { evRevenueTTM: [{ period: '2026-06-30', v: 9 }] } }, _peersRaw: ['AMD', 'INTC'], ...extra });
const live = (f: unknown) => async () => ({ fund: f as never, source: 'FMP' });
const down = async () => ({ fund: null, source: 'none' });
const policy = (over: Partial<FundamentalsFallbackPolicy> = {}): FundamentalsFallbackPolicy => ({ maxAgeDays: 30, earningsSince: earningsSinceFromSavedCopy, ...over });

describe('FL-7a-2b — fundamentals saved-copy rule', () => {
  test('stamp, then a run with the live fetch down: within 30 days and no earnings since -> used, reported with its date', async () => {
    const store = new MemoryPropertyStore();
    await resolveFundamentals('NVDA', { gather: live(fundOf({ _nextEarnings: { date: new Date(NOW + 20 * DAY).toISOString() }, _earningsHistory: [] })), store, now: () => new Date(NOW - 12 * DAY), stampFetchedAt: true, dateLabel: () => '10/12/2026' });
    const rec = JSON.parse((await store.get('FUND_NVDA'))!);
    assert.equal(rec.fetchedAt, new Date(NOW - 12 * DAY).toISOString());
    const seen: SavedCopyVerdict[] = [];
    const r = await resolveFundamentals('NVDA', { gather: down, store, now: () => new Date(NOW), fallback: policy(), onSavedCopy: (v) => seen.push(v) });
    assert.ok(r.fund);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accepted, true);
    assert.equal(seen[0].savedAt!.getTime(), NOW - 12 * DAY);
  });

  test('refused: too old, an earnings report since, or no way to check; legacy mode accepts any copy', async () => {
    const rec = (days: number, data: Record<string, unknown>) => ({ data: fundOf(data), date: 'x', fetchedAt: new Date(NOW - days * DAY).toISOString() });
    assert.match((await judgeSavedCopy('X', rec(31, { _earningsHistory: [] }) as never, policy(), NOW)).why, /31 days old, over the 30-day limit/);
    assert.match((await judgeSavedCopy('X', rec(5, { _nextEarnings: { date: new Date(NOW - 2 * DAY).toISOString() } }) as never, policy(), NOW)).why, /earnings report came out/);
    assert.match((await judgeSavedCopy('X', rec(5, { _earningsHistory: [{ date: new Date(NOW - 1 * DAY).toISOString() }] }) as never, policy(), NOW)).why, /earnings report came out/);
    assert.match((await judgeSavedCopy('X', rec(5, {}) as never, policy(), NOW)).why, /could not be checked/);
    assert.equal((await judgeSavedCopy('X', rec(5, { _earningsHistory: [] }) as never, policy(), NOW)).accepted, true, 'an ETF: no earnings at all');
    assert.equal((await judgeSavedCopy('X', rec(5, { _earningsHistory: [] }) as never, policy({ maxAgeDays: 3 }), NOW)).accepted, false, 'the age limit is a setting');
    // Legacy label only ('M/D/YYYY'), no stamp.
    assert.equal(savedAtOf({ data: {}, date: '10/1/2026' })!.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.equal(savedAtOf({ data: {}, date: '1.10.2026' }), null);
    assert.equal((await judgeSavedCopy('X', { data: fundOf() as never, date: 'nope' }, policy(), NOW)).accepted, false);
    // Refused -> no fundamentals, the legacy "technical only" statuses.
    const store = new MemoryPropertyStore();
    await store.set('FUND_X', JSON.stringify(rec(40, { _earningsHistory: [] })));
    const st: string[] = [];
    const r = await resolveFundamentals('X', { gather: down, store, now: () => new Date(NOW), fallback: policy(), setStatus: (k, s) => st.push(k + ':' + s) });
    assert.equal(r.fund, null);
    assert.deepStrictEqual(st, ['fundamentals:failed', 'series:failed', 'peers:failed']);
    const legacy = await resolveFundamentals('X', { gather: down, store, now: () => new Date(NOW) });
    assert.ok(legacy.fund, 'no policy = legacy: any saved copy is used');
  });

  test('F-36 option B: series and peers in their own tab, merged back on a saved-copy run', async () => {
    const tabs = new MemoryTabStore();
    const seriesStore = tabSeriesStore(tabs);
    const store = new MemoryPropertyStore();
    const big = { quarterly: { evRevenueTTM: Array.from({ length: 4000 }, (_, i) => ({ period: 'p' + i, v: i })) } };
    await resolveFundamentals('AMD', { gather: live(fundOf({ _metricSeries: big })), store, now: () => new Date(NOW), seriesStore });
    const rec = JSON.parse((await store.get('FUND_AMD'))!);
    assert.equal(rec.data._metricSeries, undefined, 'the property no longer carries the series');
    assert.ok(JSON.stringify(big).length > 45000, 'the series spans more than one cell');
    const r = await resolveFundamentals('AMD', { gather: down, store, now: () => new Date(NOW), seriesStore });
    assert.deepStrictEqual(r.fund!._metricSeries, big);
    assert.deepStrictEqual(r.fund!._peersRaw, ['AMD', 'INTC']);
    // Upsert, not append.
    await resolveFundamentals('AMD', { gather: live(fundOf({ _metricSeries: { a: 1 } })), store, now: () => new Date(NOW), seriesStore });
    assert.equal(tabs.snapshot(FUNDAMENTALS_SERIES_TAB, 3)!.length, 2, 'header + one row');
    assert.deepStrictEqual((await seriesStore.load('amd'))!.series, { a: 1 });
  });
});
