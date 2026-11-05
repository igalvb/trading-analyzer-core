/**
 * FL-18b (James's models, phase 0, G3): the nightly option-chain snapshot. It reads only the chains the paper night
 * already fetched (no extra Cboe call), stores one light row per ticker in 📉 IV History and the contracts (the two
 * Januaries nearest 12-27 months out, the ~30-day at-the-money calls, the engine pick) in 📦 Option Chain Snapshots,
 * never writes a night twice, and never stops the paper night.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { occ } from './cboeFixtures.ts';
import {
  chainCalls, pickJanuaries, atmIv, atmCalls, nearestExpiry, tickerNight, snapshotRows, readSnapshots, snapshotCalls, recordChainNight, ivRankOverTime,
  IV_HISTORY_TAB, CHAIN_SNAPSHOT_TAB, IV_HISTORY_HEADER, SNAPSHOT_CELL_CHARS, IV_RANK_NIGHTS, type ChainCall,
} from '../src/paper/chainSnapshot.ts';
import { runPaperNight } from '../src/paper/paperJob.ts';
import { PAPER_OWNER_LIST } from '../src/paper/paperLab.ts';
import type { CboeChainJson } from '../src/fetch/cboe.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const NOW = Date.parse('2026-10-29T23:00:00Z');
const NOW_UNIX = Math.floor(NOW / 1000);
const EXPIRIES = ['2026-11-06', '2026-11-27', '2027-01-08', '2027-01-15', '2027-10-15', '2028-01-21', '2029-01-19'];

/** A chain around `spot`: calls and puts on every expiry, delta falling with the strike; Jan 2028 has vega and theo. */
function chain(root: string, spot: number, opts: { noIv?: boolean } = {}): CboeChainJson {
  const options: Array<Record<string, unknown>> = [];
  for (const e of EXPIRIES) {
    const exp = Date.parse(e + 'T00:00:00Z');
    for (const m of [0.5, 0.7, 0.85, 0.95, 1, 1.05, 1.15, 1.3, 1.6]) {
      const strike = Math.round(spot * m);
      for (const cp of ['C', 'P'] as const) {
        const delta = cp === 'C' ? Math.max(0.02, Math.min(0.98, 1.4 - 0.9 * m)) : -0.3;
        const o: Record<string, unknown> = { option: occ(root, exp, cp, strike), bid: Math.max(0.05, spot - strike + 5), ask: Math.max(0.1, spot - strike + 6), iv: opts.noIv ? 0 : 0.3 + 0.1 * Math.abs(1 - m) + (e === '2026-11-27' ? 0.05 : 0), delta, open_interest: 100, volume: 5 };
        if (e === '2028-01-21') { o.vega = 0.55; o.theo = 12.3; }
        options.push(o);
      }
    }
  }
  return { data: { current_price: spot, options } } as CboeChainJson;
}

const series = (t: string, n = 300): PriceSeries => {
  const dates: string[] = [], closes: number[] = [];
  const d = new Date('2025-09-01T12:00:00Z');
  while (dates.length < n) { if (d.getUTCDay() % 6) { dates.push(d.toISOString().slice(0, 10)); closes.push(100 * (1 + 0.01 * Math.sin(dates.length))); } d.setUTCDate(d.getUTCDate() + 1); }
  return { ticker: t, dates, opens: closes, highs: closes, lows: closes, closes, volumes: closes.map(() => 1), splits: [] };
};

describe('FL-18b — G3 chain snapshot, the pieces', () => {
  test('the two Januaries nearest 12-27 months out: Jan 2028 (14.8 mo) and Jan 2029 (26.7 mo); a year with several January expiries counts once', () => {
    const calls = chainCalls(chain('NVDA', 200));
    assert.ok(calls.every((c) => c.strike > 0) && calls.length === EXPIRIES.length * 9, 'calls only');
    assert.deepEqual(pickJanuaries(calls, NOW_UNIX).map((e) => new Date(e * 1000).toISOString().slice(0, 10)), ['2028-01-21', '2029-01-19']);
    // without the LEAPS Januaries, the nearest January (one per year) is taken
    const short = calls.filter((c) => new Date(c.expUnix * 1000).getUTCFullYear() < 2028);
    assert.deepEqual(pickJanuaries(short, NOW_UNIX).length, 1);
  });

  test('ATM IV: linear between the strikes around the price; one-sided chains use the nearest; zero IV skipped', () => {
    const e = 1_800_000_000;
    const mk = (strike: number, iv: number | null): ChainCall => ({ strike, expUnix: e, iv, bid: 1, ask: 2, delta: 0.5, oi: 1, vega: null, theo: null, rho: null });
    assert.equal(atmIv([mk(90, 0.3), mk(110, 0.5)], e, 100), 0.4);
    assert.equal(atmIv([mk(90, 0.3), mk(95, 0), mk(110, 0.5)], e, 100), 0.4, 'the zero-IV strike is skipped');
    assert.equal(atmIv([mk(110, 0.5), mk(120, 0.6)], e, 100), 0.5);
    assert.equal(atmIv([mk(90, 0)], e, 100), null);
    assert.deepEqual(atmCalls([mk(80, 1), mk(90, 1), mk(100, 1), mk(105, 1), mk(110, 1), mk(120, 1)], e, 100).map((c) => c.strike), [90, 100, 105, 110]);
  });

  test('the ~30-day and ~1-year expiries', () => {
    const calls = chainCalls(chain('NVDA', 200));
    const day = (x: number | null): string => new Date((x as number) * 1000).toISOString().slice(0, 10);
    assert.equal(day(nearestExpiry(calls, NOW_UNIX, 30, 7)), '2026-11-27');
    assert.equal(day(nearestExpiry(calls, NOW_UNIX, 365, 180)), '2027-10-15');
  });

  test('one ticker: the light row and the snapshot; the snapshot round-trips through the tab, split into parts when long', () => {
    const s = series('NVDA');
    const pick = { symbol: occ('NVDA', Date.parse('2029-01-19T00:00:00Z'), 'C', 170), strike: 170, expUnix: Date.parse('2029-01-19T00:00:00Z') / 1000, bid: 40, ask: 41 };
    const x = tickerNight(s.dates[s.dates.length - 1]!, { ticker: 'NVDA', chain: chain('NVDA', 200), pick, series: s }, NOW_UNIX);
    const row = Object.fromEntries(IV_HISTORY_HEADER.map((h, i) => [h, x.row[i]]));
    assert.equal(row['Status'], 'ok');
    assert.equal(row['Spot'], 200);
    assert.equal(row['~30-day expiry'], '2026-11-27');
    assert.equal(row['Januaries stored'], '2028-01-21, 2029-01-19');
    assert.equal(row['Contracts stored'], 9 + 9 + 4, 'two whole Januaries and four ATM calls');
    assert.equal(row['Vega in feed'], 'yes');
    assert.ok(typeof row['RV252'] === 'number' && typeof row['ATM IV ~30 days'] === 'number');
    assert.equal(row['Engine LEAPS pick'], pick.symbol);
    const rows = snapshotRows(x.snapshot!);
    assert.equal(rows.length, 1);
    const back = readSnapshots(rows).get('NVDA')!.get(x.snapshot!.day)!;
    assert.deepEqual(back, x.snapshot);
    // a long snapshot is split and joined back in order
    const big = { ...x.snapshot!, expiries: { ...x.snapshot!.expiries, '2030-01-18': { role: 'january' as const, rows: Array.from({ length: 3000 }, (_, i) => [i, 1.25, 1.5, 0.33, 0.5, 10, null, null, null]) } } };
    const parts = snapshotRows(big);
    assert.ok(parts.length > 1 && parts.every((p) => String(p[3]).length <= SNAPSHOT_CELL_CHARS));
    assert.deepEqual(readSnapshots([...parts].reverse()).get('NVDA')!.get(big.day), big);
  });

  test('a later pick is rebuilt from the stored January: the 0.75-delta call of Jan 2029 equals the one picked on the live chain', () => {
    const live = chain('NVDA', 200);
    const x = tickerNight('2026-10-29', { ticker: 'NVDA', chain: live, pick: null }, NOW_UNIX);
    const closest = (cs: ChainCall[]): number => cs.filter((c) => c.delta != null).sort((a, b) => Math.abs(a.delta! - 0.75) - Math.abs(b.delta! - 0.75) || a.strike - b.strike)[0]!.strike;
    const jan29 = Date.parse('2029-01-19T00:00:00Z') / 1000;
    assert.equal(closest(snapshotCalls(x.snapshot!, '2029-01-19')), closest(chainCalls(live).filter((c) => c.expUnix === jan29)));
    assert.deepEqual(snapshotCalls(x.snapshot!, '2029-01-19').map((c) => c.strike), chainCalls(live).filter((c) => c.expUnix === jan29).map((c) => c.strike).sort((a, b) => a - b));
  });

  test('no chain: a "no chain" row and no snapshot', () => {
    const x = tickerNight('2026-10-29', { ticker: 'XYZ', chain: null, pick: null, series: series('XYZ') }, NOW_UNIX);
    assert.equal(x.row[2], 'no chain');
    assert.equal(x.snapshot, null);
  });

  test('IV rank over time is null until 252 nights are stored', () => {
    assert.equal(ivRankOverTime(Array(IV_RANK_NIGHTS - 1).fill(0.3), 0.5), null);
    assert.equal(ivRankOverTime(Array.from({ length: IV_RANK_NIGHTS }, (_, i) => i), 126), 50);
  });

  test('recordChainNight: one row per ticker per night in each tab; a retried night writes nothing', async () => {
    const store = new MemoryTabStore();
    const nights = [{ ticker: 'NVDA', chain: chain('NVDA', 200), pick: null }, { ticker: 'XYZ', chain: null, pick: null }];
    assert.deepEqual(await recordChainNight(store, '2026-10-29', nights, NOW_UNIX), { withChain: 1, rows: 2 });
    assert.deepEqual(await recordChainNight(store, '2026-10-29', nights, NOW_UNIX), { withChain: 1, rows: 0 });
    assert.equal((await store.read(IV_HISTORY_TAB, 3))!.length, 3, 'header + 2 rows');
    assert.equal((await store.read(CHAIN_SNAPSHOT_TAB, 3))!.length, 2, 'header + NVDA');
  });
});

describe('FL-18b — G3 in the paper night', () => {
  const days = (() => { const out: string[] = []; const d = new Date('2025-09-01T12:00:00Z'); while (out.length < 330) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; })();
  const chartOf = (upTo: string) => (t: string) => {
    const ds = days.filter((d) => d <= upTo);
    const px = ds.map((_, i) => (t === 'QQQ' ? 500 : 50 + i * 0.3));
    return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never;
  };
  const analysis = async (t: string) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: {}, texts: {} }) as never;

  test('the snapshot uses only the chains the night fetched (one Cboe call per list stock, none added; no QQQ or SPY); a failed chain is a "no chain" row', async () => {
    const store = new MemoryTabStore();
    const calls: string[] = [];
    const http = {
      fetch: async (req: { url: string }) => {
        calls.push(req.url);
        const t = decodeURIComponent(req.url.split('/').pop()!.replace('.json', ''));
        if (t === 'MQZC' || t === '_MQZC') return { status: 500, text: () => '' };
        return { status: 200, text: () => JSON.stringify(chain(t, 100)) };
      },
    };
    let upTo = '2026-10-28';
    const deps = { store, timeZone: 'America/New_York', watchlist: [], log: () => {}, now: () => Date.parse(upTo + 'T23:00:00Z'), fetchChart: async (t: string) => chartOf(upTo)(t), analysis, cboe: { http: http as never, memo: new Map() } };
    await runPaperNight(deps);
    const first = calls.length;
    assert.equal(first, PAPER_OWNER_LIST.length + 1, 'one call per list stock (MQZC tried twice: the plain and the index form), nothing else');
    assert.ok(!calls.some((u) => /\/(QQQ|SPY)\.json$/.test(u)), 'QQQ and SPY are not fetched');
    const iv = (await store.read(IV_HISTORY_TAB, 3))!;
    assert.equal(iv.length, 1 + PAPER_OWNER_LIST.length, 'a row per list stock');
    assert.equal(iv.find((r) => r[1] === 'MQZC')![2], 'no chain');
    assert.equal(iv.filter((r) => r[2] === 'ok').length, PAPER_OWNER_LIST.length - 1);
    // the next night: new rows, still no extra call beyond one chain per stock
    upTo = '2026-10-29';
    deps.cboe.memo = new Map();
    await runPaperNight(deps);
    assert.equal(calls.length, 2 * first);
    assert.equal((await store.read(IV_HISTORY_TAB, 3))!.length, 1 + 2 * PAPER_OWNER_LIST.length);
  });

  test('a failing snapshot store never stops the paper night', async () => {
    const inner = new MemoryTabStore();
    const store = {
      read: (t: string, n: number) => inner.read(t, n), clear: (t: string) => inner.clear(t), write: (t: string, r: number, rows: never) => inner.write(t, r, rows),
      ensure: async (t: string) => { if (t === IV_HISTORY_TAB) throw new Error('Sheets said no'); return inner.ensure(t); },
    };
    const logs: string[] = [];
    const http = { fetch: async (req: { url: string }) => ({ status: 200, text: () => JSON.stringify(chain(req.url.split('/').pop()!.replace('.json', ''), 100)) }) };
    const out = await runPaperNight({ store, timeZone: 'America/New_York', watchlist: [], log: (m: string) => logs.push(m), now: () => Date.parse('2026-10-28T23:00:00Z'), fetchChart: async (t: string) => chartOf('2026-10-28')(t), analysis, cboe: { http: http as never, memo: new Map() } });
    assert.match(out, /decisions made/);
    assert.ok(logs.some((m) => m.startsWith('option snapshot failed')), logs.join('\n'));
  });
});
