/**
 * FL-17d: the paper test's year-long record (owner 2026-10-29): every decision and fill with its reason and the
 * models' reads, every stock's reads, every account's value, appended night by night, never twice.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { runPaperNight } from '../src/paper/paperJob.ts';
import { appendNight, LOG_TAB, READS_TAB, VALUES_TAB } from '../src/paper/paperLog.ts';
import { PAPER_OWNER_LIST } from '../src/paper/paperLab.ts';
import { loadPaper, savePaper, PAPER_TAB } from '../src/paper/paperJob.ts';
import { newPaperState, PAPER_START } from '../src/paper/paperTrading.ts';

const days = (() => { const out: string[] = []; const d = new Date('2025-09-01T12:00:00Z'); while (out.length < 330) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; })();

describe('FL-17d — paper log', () => {
  test('two nights: decisions, fills, reads and values are appended with the reasons; a night is never written twice', async () => {
    const store = new MemoryTabStore();
    let upTo = '2026-10-28';
    const chart = (t: string) => {
      const ds = days.filter((d) => d <= upTo);
      const px = ds.map((_, i) => (t === 'QQQ' ? 500 : 50 + i * 0.3));
      return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never;
    };
    const cmp = { existingDirection: 'bullish', newDirection: 'mixed', schabackerDirection: 'bullish', edwardsMageeDirection: 'mixed', turtleDirection: 'bullish', verdict: 'MAJORITY' };
    const analysis = async (t: string) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: t === 'NVDA' ? { comparison: cmp } : {}, texts: {} }) as never;
    const deps = { store, timeZone: 'America/New_York', watchlist: [], log: () => {}, now: () => Date.parse(upTo + 'T23:00:00Z'), fetchChart: async (t: string) => chart(t), analysis };
    await runPaperNight(deps);
    upTo = '2026-10-29';
    await runPaperNight(deps);
    const log = (await store.read(LOG_TAB, 11))!;
    if (process.env.SHOW_LOG) for (const r of log.slice(0, 14)) console.log(r.join(' | '));
    assert.equal(log[0]![0], 'Day');
    assert.ok(log.length > 1, 'something was logged');
    for (const r of log.slice(1)) assert.ok(String(r[9]).length > 0, 'every action has a reason: ' + JSON.stringify(r));
    const reads = (await store.read(READS_TAB, 19))!;
    assert.equal(reads.filter((r) => r[0] === '2026-10-29').length, new Set([...PAPER_OWNER_LIST, 'TSLA', 'AVGO', 'GOOGL', 'MSTR', 'SQZB', 'IBIT']).size, 'one row per stock per night');
    const values = (await store.read(VALUES_TAB, 6))!;
    assert.ok(values.some((r) => r[0] === '2026-10-29' && r[1] === 'Hold QQQ'));
    assert.ok(values.some((r) => r[0] === '2026-10-29' && String(r[2]).startsWith('D')));
    assert.equal(await appendNight(store, READS_TAB, ['Day'], '2026-10-29', [['2026-10-29', 'X']]), 0, 'a retried night is not written twice');
  });

  test('every night: a short message and the report file (standings + every account\'s holdings); an old test is restarted and its tabs cleared', async () => {
    const store = new MemoryTabStore();
    const old = newPaperState(['TSLA']);
    (old as { start: string }).start = '2026-10-28';
    old.lastDay = '2026-10-28';
    await savePaper(store, { state: old, trades: [] });
    await store.ensure(LOG_TAB); await store.write(LOG_TAB, 1, [['Day'], ['2026-10-28', 'old row']]);
    let upTo = '2026-10-28';
    const chart = (t: string) => {
      const ds = days.filter((d) => d <= upTo);
      const px = ds.map((_, i) => (t === 'QQQ' ? 500 : 50 + i * 0.3));
      return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never;
    };
    const cmp = { existingDirection: 'bullish', newDirection: 'mixed', schabackerDirection: 'bullish', edwardsMageeDirection: 'mixed', turtleDirection: 'bullish', verdict: 'MAJORITY' };
    const analysis = async (t: string) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: t === 'NVDA' ? { comparison: cmp } : {}, texts: {} }) as never;
    const sent: Array<{ method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: { body: unknown }) => { sent.push({ method: String(url).split('/').pop() as string, body: init.body }); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); }) as unknown as typeof fetch;
    const deps = { store, timeZone: 'America/New_York', watchlist: [], log: () => {}, now: () => Date.parse(upTo + 'T23:00:00Z'), fetchChart: async (t: string) => chart(t), analysis,
      telegram: { deps: { token: 't', fetchImpl }, chatId: '1' } };
    await runPaperNight(deps);
    assert.equal((await loadPaper(store))!.state.start, PAPER_START, 'restarted');
    assert.ok(!(await store.read(LOG_TAB, 2))!.some((r) => r[1] === 'old row'), 'the old log is cleared');
    assert.equal(sent.length, 0, 'the decide night has no values yet: nothing sent');
    upTo = '2026-10-29';
    await runPaperNight(deps);
    assert.deepEqual(sent.map((x) => x.method), ['sendMessage', 'sendDocument']);
    const msg = JSON.parse(String(sent[0]!.body)).text as string;
    assert.ok(msg.includes('Top 5:') && msg.includes('📊 Hold QQQ') && msg.includes('📊 Hold your 14'), msg);
    const file = sent[1]!.body as FormData;
    const html = await (file.get('document') as Blob).text();
    for (const want of ['Standings', 'What each account holds', 'Everything together', 'Turtle (list', 'Hold your 14 equally', 'Cash']) assert.ok(html.includes(want), want);
    assert.ok((await store.read(PAPER_TAB, 1))!.length > 3);
  });
});
