/**
 * Options sentiment plan (docs/OPTIONS_SENTIMENT_PLAN.md) P0, P1 (shadow) and P3 (market read, display only). Synthetic
 * Cboe chains (test/cboeFixtures.ts) and a counting fake HTTP: Cboe is not reachable from the test machines.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { fetchCboeRaw, type CboeChainJson } from '../src/fetch/cboe.ts';
import { chainJson, cboeUrlOf, occ, DAYS_ALL, MULTS, type ChainSpec } from './cboeFixtures.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { computeChainContext, parseAndScore } from '../src/analysis/options/conviction.ts';
import { MIN_DAYS_FOR_IV_CONTEXT } from '../src/analysis/options/labels.ts';
import { saveOptionsSnapshot, OPTIONS_SNAPSHOT_SHEET } from '../src/reports/options/tabs.ts';
import { readOptionsSnapshot } from '../src/reports/options/run.ts';
import { analyzeOptionsForScoring } from '../src/analysis/options/scoring.ts';
import {
  checksOf, computeOptionsShadow, confirmOf, deltaDollarBias, gateRead, optionsMarketHours, optionsNightDay, readOfChain, shadowLine, snapshotReadOf,
  tradingDaysBetween, OPTIONS_READ_APPLIED, type OptionsRead,
} from '../src/analysis/options/nightlyRead.ts';
import { hedgingRead, marketReadLine, marketReadOf, skewAt } from '../src/analysis/options/marketRead.ts';
import { optionsRunReport, recordOptionsNight, runOptionsChains, shadowInputOf } from '../src/jobs/options/optionsNight.ts';
import {
  loadLatestRead, readMarketOptions, readOptionsSnapshotRows, saveLatestRead, MARKET_OPTIONS_TAB, OPTIONS_READS_HEADER, OPTIONS_READS_TAB,
  OPTIONS_READ_SNAPSHOTS_TAB,
} from '../src/storage/optionsReadsTab.ts';
import { optionsTonight } from '../src/paper/paperJob.ts';
import { optionsSeedFor } from '../src/app/nightlyApp.ts';
import { buildPlainSummary, optionsGap, type RunSummary } from '../src/jobs/nightly/summary.ts';
import { sheetFor, PROTECTED_TABS, isAllowListedName } from '../src/sheets/tabs.ts';
import { runTickerAnalysisDetailed, ANALYSIS_TAB, type TickerAnalysisDeps } from '../src/analysis/runTicker.ts';
import { getOrCreate } from '../src/reports/options/tabs.ts';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import { loadRawFixture, fixturesPresent, type RawFixture } from './fixtures.ts';
import { buildGeminiReport, type GeminiReviewInputs } from '../src/fetch/ai/geminiReview.ts';

const TZ = 'America/New_York';
/** Thursday 2026-10-29, 23:23 New York (03:23 UTC Friday): the nightly hour. */
const NOW = Date.UTC(2026, 9, 30, 3, 23);
const spec = (root: string, over: Partial<ChainSpec> = {}): ChainSpec => ({ root, spot: 400, nowMs: NOW, days: DAYS_ALL, strikeMults: MULTS, maxOi: 60000, ...over });
const json = (seed: number, s: ChainSpec): CboeChainJson => JSON.parse(chainJson(seed, s)) as CboeChainJson;

/** A fake Cboe: serves the given bodies, counts every request. */
function fakeCboe(bodies: Record<string, string>): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async send(req: HttpRequest) {
      calls.push(req.url);
      const t = Object.keys(bodies).find((k) => req.url === cboeUrlOf(k));
      return new HttpResponse(t ? 200 : 404, new TextEncoder().encode(t ? bodies[t]! : 'not found'));
    },
  };
  return { http: new HttpClient({ transport }), calls };
}

describe('A-2: the nightly read equals Analyze\'s snapshot for the same chain (OI persistence frozen at 50)', () => {
  test('same contracts, same context, same options scoring', async () => {
    const j = json(7, spec('AAA'));
    const read = await readOfChain(j, 'AAA', '2026-10-29', NOW, TZ);
    assert.equal(read.status, 'ok');
    // Analyze's path, first run (no OI history -> 50, the same as frozen)
    const kv = new MemoryPropertyStore();
    const { chainColumnsOf } = await import('../src/fetch/cboe.ts');
    const contracts = await parseAndScore({ kv, timeZone: TZ, clock: { now: () => NOW } as never }, chainColumnsOf(j), null, 'AAA');
    const ctx = computeChainContext(contracts.fullChain || contracts, { minIvDays: MIN_DAYS_FOR_IV_CONTEXT });
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    saveOptionsSnapshot(wb, 'AAA', contracts, ctx, j.data?.current_price ?? null, { nowMs: NOW, timeZone: TZ });
    const analyze = readOptionsSnapshot(wb, 'AAA', NOW, TZ)!;
    const nightly = (await snapshotReadOf(read, NOW, TZ))!;
    assert.deepEqual(nightly.contracts, analyze.contracts);
    assert.deepEqual(nightly.context, analyze.context);
    assert.deepEqual(analyzeOptionsForScoring(nightly, null, { plainLabels: true }), analyzeOptionsForScoring(analyze, null, { plainLabels: true }));
    assert.equal(nightly.ticker, 'AAA');
  });

  test('a second night with OI history in Analyze\'s kv: the nightly read stays at 50 and writes no OI_HIST_V2_ key', async () => {
    const r = await readOfChain(json(7, spec('AAA', { oiScale: (i) => 1 + (i % 3) * 0.2 })), 'AAA', '2026-10-29', NOW, TZ);
    const at = r.fields.indexOf('oiPersistenceScore'), bucket = r.fields.indexOf('bucket');
    const leaps = r.rows.filter((x) => String(x[bucket]).startsWith('LEAPS'));
    assert.ok(leaps.length > 0);
    for (const x of leaps) assert.equal(x[at], 50);
  });

  test('signals match analyzeOptionsForScoring; no chain / no options -> "no chain"', async () => {
    const r = await readOfChain(json(3, spec('BBB')), 'BBB', '2026-10-29', NOW, TZ);
    const opt = analyzeOptionsForScoring((await snapshotReadOf(r, NOW, TZ))!, null);
    assert.equal(r.signals!.dirSig, opt.dirSig);
    assert.equal(r.signals!.leapsLean, opt.leapsLean);
    assert.equal((await readOfChain(null, 'X', '2026-10-29', NOW, TZ)).status, 'no chain');
    assert.equal((await readOfChain({ data: { options: [] } }, 'X', '2026-10-29', NOW, TZ)).status, 'no chain');
  });
});

describe('P0 checks', () => {
  test('total volume, delta / iv present, size and parse time', async () => {
    const closed = json(5, spec('CCC', { closed: true, noDelta: true }));
    const c = checksOf(closed);
    assert.equal(c.totalVolume, 0);
    assert.equal(c.withDelta, 0);
    assert.ok(c.withIv > 0 && c.contracts > c.withIv - 1);
    const r = await readOfChain(closed, 'CCC', '2026-10-29', NOW, TZ);
    assert.equal(r.marketClosed, true, 'volume 0 at the nightly hour: the market-closed formula');
    const { http } = fakeCboe({ CCC: chainJson(5, spec('CCC')) });
    const stats = new Map();
    await fetchCboeRaw({ http, memo: new Map(), stats }, 'CCC');
    assert.ok(stats.get('CCC').bytes > 1000);
    assert.ok(stats.get('CCC').parseMs >= 0);
  });
});

describe('A-1: one fetch per ticker of the union; the paper step adds 0 Cboe calls', () => {
  test('union = stocks + paper list + SPY + QQQ, each once; paper reuses the memo', async () => {
    const bodies: Record<string, string> = { AAA: chainJson(1, spec('AAA')), BBB: chainJson(2, spec('BBB')), PPP: chainJson(4, spec('PPP')), SPY: chainJson(8, spec('SPY', { spot: 600 })), QQQ: chainJson(9, spec('QQQ', { spot: 500 })) };
    const { http, calls } = fakeCboe(bodies);
    const memo = new Map(), stats = new Map(), logs: string[] = [];
    const store = new MemoryTabStore(), kv = new MemoryPropertyStore();
    const night = await runOptionsChains({ cboe: { http, memo, stats }, store, kv, timeZone: TZ, now: () => NOW, log: (m) => logs.push(m), fetchChart: async () => null }, ['AAA', 'bbb', 'AAA'], ['PPP', 'AAA']);
    assert.deepEqual(new Set(calls), new Set(['AAA', 'BBB', 'PPP', 'SPY', 'QQQ'].map(cboeUrlOf)));
    assert.equal(calls.length, 5, 'one request per ticker (all had a chain)');
    assert.deepEqual(night.stocks, ['AAA', 'BBB']);
    assert.deepEqual([...night.reads.keys()].sort(), ['AAA', 'BBB', 'PPP']);
    assert.ok(!memo.has('SPY') && !memo.has('QQQ'), 'the ETF chains are dropped once read');
    assert.equal(night.market.filter((m) => m.status === 'ok').length, 2);
    assert.ok(logs.some((l) => l.startsWith('options P0 summary: 3 of 3 stock chains read for 2026-10-29')));
    assert.ok(logs.some((l) => l.startsWith('options P0 SPY: ok')));
    const before = calls.length;
    await optionsTonight({ http, memo }, ['AAA', 'PPP'], NOW, () => {}, TZ);
    assert.equal(calls.length, before, 'the paper list is all memo hits');
    assert.ok((await store.read(MARKET_OPTIONS_TAB, 3))!.length === 3, 'header + SPY + QQQ');
  });

  test('a ticker without a chain is "no chain"; the step does not throw', async () => {
    const { http } = fakeCboe({ AAA: chainJson(1, spec('AAA')) });
    const night = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store: new MemoryTabStore(), kv: new MemoryPropertyStore(), timeZone: TZ, now: () => NOW, log: () => {}, fetchChart: async () => null }, ['AAA', 'ZZZ'], []);
    assert.equal(night.reads.get('ZZZ')!.status, 'no chain');
    assert.equal(night.gated.get('ZZZ')!.fresh, false);
    assert.equal(night.marketLine, null);
    assert.ok(shadowInputOf(night, 'aaa'));
    assert.equal(shadowInputOf(night, 'ZZZ'), null);
  });
});

describe('A-4: each scratch would hold its own ticker (go-live path; shadow keeps today\'s seed)', () => {
  test('optionsSeedFor seeds the ticker\'s own snapshot only when applied', async () => {
    const { http } = fakeCboe({ AAA: chainJson(1, spec('AAA')), BBB: chainJson(2, spec('BBB')) });
    const night = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store: new MemoryTabStore(), kv: new MemoryPropertyStore(), timeZone: TZ, now: () => NOW, log: () => {}, fetchChart: async () => null }, ['AAA', 'BBB'], []);
    // Go-live (owner 2026-11-06): the owner profile applies the read; the shadow path is still tested explicitly.
    assert.equal(OPTIONS_READ_APPLIED, true, 'applied for the owner');
    assert.equal(await optionsSeedFor(night, 'AAA', false), null, 'shadow: the scratch keeps the shared snapshot');
    assert.ok(await optionsSeedFor(night, 'AAA'), 'applied by default for the owner');
    for (const t of ['AAA', 'BBB']) {
      const seed = (await optionsSeedFor(night, t, true))!;
      const wb = await ReportWorkbook.open(new MemoryWorkbookBackend(seed as never), ['*']);
      const snap = readOptionsSnapshot(wb, t, NOW, TZ)!;
      assert.equal(snap.ticker, t);
      assert.ok(!snap.mismatch && snap.contracts!.length > 0);
      assert.ok(seed[OPTIONS_SNAPSHOT_SHEET]);
    }
  });
});

describe('A-5: dates and the staleness gate (weekdays, no holiday calendar)', () => {
  test('trading days and the night day', () => {
    assert.equal(tradingDaysBetween('2026-10-30', '2026-11-02'), 1, 'Fri -> Mon');
    assert.equal(tradingDaysBetween('2026-10-28', '2026-11-02'), 3, 'Wed -> Mon');
    assert.equal(tradingDaysBetween('2026-11-02', '2026-11-02'), 0);
    assert.equal(optionsNightDay(NOW, TZ), '2026-10-29', '23:23 New York Thursday');
    assert.equal(optionsNightDay(Date.UTC(2026, 9, 31, 3, 23), TZ), '2026-10-30', 'a Friday-night run');
    assert.equal(optionsNightDay(Date.UTC(2026, 10, 1, 3, 23), TZ), '2026-10-30', 'Saturday night -> Friday');
    // Owner 2026-11-05: a market-hours run must not take the night's slot (seen 4 Nov 10:03 New York).
    assert.equal(optionsMarketHours(Date.UTC(2026, 10, 4, 15, 3), TZ), true, 'Wed 10:03 New York');
    assert.equal(optionsMarketHours(Date.UTC(2026, 10, 5, 3, 23), TZ), false, 'the nightly, 22:23 New York');
    assert.equal(optionsMarketHours(Date.UTC(2026, 10, 4, 13, 0), TZ), false, '08:00 New York');
    assert.equal(optionsMarketHours(Date.UTC(2026, 10, 7, 16, 0), TZ), false, 'Saturday noon');
    assert.equal(optionsMarketHours(NOW, TZ), false);
    assert.equal(optionsNightDay(Date.UTC(2026, 9, 30, 5, 30), TZ), '2026-10-29', '01:30 Friday is still Thursday\'s session');
  });

  test('tonight wins; Fri -> Mon stored ok; Wed -> Mon stale; nothing -> not applied', async () => {
    const ok = (day: string): OptionsRead => ({ v: 1, day, ticker: 'AAA', status: 'ok', asOfUtc: '', cboeTime: null, spot: 1, marketClosed: false, checks: checksOf(null), context: null, signals: null, c2: null, fields: [], rows: [[1]] });
    const none: OptionsRead = { ...ok('2026-11-02'), status: 'no chain', rows: [] };
    assert.equal(gateRead(ok('2026-11-02'), ok('2026-10-30'), '2026-11-02').source, 'tonight');
    const fri = gateRead(none, ok('2026-10-30'), '2026-11-02');
    assert.deepEqual([fri.source, fri.fresh, fri.ageTradingDays], ['stored', true, 1]);
    const wed = gateRead(none, ok('2026-10-28'), '2026-11-02');
    assert.deepEqual([wed.source, wed.fresh, wed.note], ['stored', false, 'Options read is 3 trading days old']);
    assert.equal(gateRead(none, null, '2026-11-02').fresh, false);
  });

  test('a failed fetch falls back to the stored read (kv), and the gate is applied', async () => {
    const kv = new MemoryPropertyStore();
    const fri = await readOfChain(json(1, spec('AAA')), 'AAA', '2026-10-30', NOW, TZ);
    assert.equal(await saveLatestRead(kv, fri, NOW), true);
    const mon = Date.UTC(2026, 10, 3, 4, 23); // Monday 23:23 New York
    const { http } = fakeCboe({});
    const night = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store: new MemoryTabStore(), kv, timeZone: TZ, now: () => mon, log: () => {}, fetchChart: async () => null }, ['AAA'], []);
    const g = night.gated.get('AAA')!;
    assert.deepEqual([night.day, g.source, g.fresh, g.read?.day], ['2026-11-02', 'stored', true, '2026-10-30']);
    assert.ok(night.snaps.get('AAA'));
    const wed = Date.UTC(2026, 10, 5, 4, 23);
    const late = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store: new MemoryTabStore(), kv, timeZone: TZ, now: () => wed, log: () => {}, fetchChart: async () => null }, ['AAA'], []);
    assert.equal(late.gated.get('AAA')!.fresh, false);
    assert.equal(late.snaps.has('AAA'), false);
    assert.equal((await loadLatestRead(kv, 'aaa', mon))!.day, '2026-10-30');
  });
});

describe('A-3: the two append-only tabs, written once per day', () => {
  test('rows with the shadow columns, snapshots read back, a second run writes nothing', async () => {
    const { http } = fakeCboe({ AAA: chainJson(1, spec('AAA')) });
    const store = new MemoryTabStore(), kv = new MemoryPropertyStore();
    const night = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store, kv, timeZone: TZ, now: () => NOW, log: () => {}, fetchChart: async () => null }, ['AAA', 'ZZZ'], []);
    const shadow = { ticker: 'AAA', readDay: night.day, source: 'tonight' as const, ageTradingDays: 0, confirm: 'confirm' as const, dirSig: 0.5, leapsLean: 0.1, techNow: 60, techIfApplied: 63, convictionNow: 60, convictionIfApplied: 71, timingNow: 'BUY_NOW', timingIfApplied: 'BUY_NOW', actionNow: 'a', actionIfApplied: 'b', techExOptions: 60, c3Confirm: 'confirm' as const, c2DirSig: 0.2, c2Confirm: 'neutral' as const };
    const line = await recordOptionsNight({ store, kv, now: () => NOW, log: () => {} }, night, async (t) => (t === 'AAA' ? shadow : null));
    assert.match(line, /2 row\(s\) stored for 2026-10-29, 1 with contracts, 1 kept/);
    const rows = (await store.read(OPTIONS_READS_TAB, OPTIONS_READS_HEADER.length))!;
    assert.equal(rows.length, 3);
    const col = (k: string): number => OPTIONS_READS_HEADER.indexOf(k);
    const aaa = rows.find((r) => r[1] === 'AAA')!, zzz = rows.find((r) => r[1] === 'ZZZ')!;
    // Go-live (owner 2026-11-06, profile options.applied on for the owner): the row says applied.
    assert.equal(aaa[col('Applied')], 'yes');
    assert.equal(aaa[col('If applied: options')], 'CONFIRM');
    assert.equal(aaa[col('Conviction if applied')], 71);
    assert.equal(aaa[col('C-3 options')], 'CONFIRM');
    assert.equal(aaa[col('C-2 options')], 'NEUTRAL');
    assert.equal(zzz[col('Status')], 'no chain');
    const snaps = readOptionsSnapshotRows((await store.read(OPTIONS_READ_SNAPSHOTS_TAB, 4))!);
    assert.deepEqual(snaps.get('AAA')!.get('2026-10-29')!.rows, night.reads.get('AAA')!.rows);
    assert.match(await recordOptionsNight({ store, kv, now: () => NOW, log: () => {} }, night, async () => null), /already stored/);
    const day = new MemoryTabStore();
    assert.match(await recordOptionsNight({ store: day, kv, now: () => Date.UTC(2026, 10, 4, 15, 3), log: () => {}, timeZone: TZ }, night, async () => null), /not stored .*market hours/);
    assert.equal(await day.read(OPTIONS_READS_TAB, OPTIONS_READS_HEADER.length), null, 'a market-hours run writes no rows');
    assert.equal((await store.read(OPTIONS_READS_TAB, 3))!.length, 3);
  });

  test('the new tabs route to the data sheet and are protected', () => {
    for (const t of [OPTIONS_READS_TAB, OPTIONS_READ_SNAPSHOTS_TAB, MARKET_OPTIONS_TAB]) {
      assert.equal(sheetFor(t), 'data');
      assert.ok(isAllowListedName(t));
      assert.ok(PROTECTED_TABS.includes(t));
    }
  });
});

describe('A-7: run summary counting', () => {
  const base: RunSummary = { runId: 'r', startedAtMs: 0, finishedAtMs: 0, durationMs: 0, overall: 'ok', steps: [], tickers: [], stepCounts: { ok: 0, degraded: 0, failed: 0, skipped: 0 }, tickerCounts: { ok: 0, degraded: 0, failed: 0, skipped: 0 } };
  test('shadow: shown, not a gap; applied: a missing read is a gap', () => {
    const o = { day: '2026-10-29', stocks: 3, readTonight: 1, stored: ['BBB'], missing: ['CCC'], applied: false };
    const lines = buildPlainSummary({ ...base, options: o });
    assert.equal(lines[0], 'Nightly run finished: everything completed.');
    assert.ok(lines.includes('Options reads (not yet applied): 1 of 3 stocks read tonight; a stored read used for BBB; missing for CCC.'));
    assert.equal(optionsGap(o), false);
    const live = buildPlainSummary({ ...base, options: { ...o, applied: true } });
    assert.equal(live[0], 'Nightly run finished with some gaps.');
    assert.ok(buildPlainSummary(base).every((l) => !l.startsWith('Options reads')));
  });
  test('optionsRunReport counts the nightly stocks only', async () => {
    const { http } = fakeCboe({ AAA: chainJson(1, spec('AAA')) });
    const night = await runOptionsChains({ cboe: { http, memo: new Map(), stats: new Map() }, store: new MemoryTabStore(), kv: new MemoryPropertyStore(), timeZone: TZ, now: () => NOW, log: () => {}, fetchChart: async () => null }, ['AAA', 'ZZZ'], ['PPP']);
    assert.deepEqual(optionsRunReport(night), { day: '2026-10-29', stocks: 2, applied: true, readTonight: 1, stored: [], missing: ['ZZZ'] });
    assert.equal(optionsRunReport(null), null);
  });
});

describe('A-8: the shadow ("if applied"); the real decision is untouched', () => {
  test('re-runs plan and decide with the read; C-3 uses the tech score without options', async () => {
    const r = await readOfChain(json(1, spec('AAA')), 'AAA', '2026-10-29', NOW, TZ);
    const snap = (await snapshotReadOf(r, NOW, TZ))!;
    const techPlan = { techScore: 60, timing: 'WAIT_PULLBACK' };
    const decision = { finalConviction: 58, action: 'HOLD' };
    const frozen = JSON.stringify([techPlan, decision]);
    const seen: boolean[] = [];
    const sh = computeOptionsShadow('AAA', {
      gated: gateRead(r, null, '2026-10-29'), snap, techPlan, decision, optAnalysis: analyzeOptionsForScoring(null, null),
      plan: (opt) => { seen.push(opt.available); return { techScore: opt.available ? 64 : 60, timing: 'WAIT_PULLBACK' } as { techScore: number; timing: string; options?: unknown }; },
      decide: (tech, opt) => ({ finalConviction: tech.techScore + (opt.confirm === 'confirm' ? 8 : opt.confirm === 'conflict' ? -10 : 0), action: 'X' }),
    })!;
    assert.equal(JSON.stringify([techPlan, decision]), frozen, 'inputs not changed');
    assert.deepEqual(seen, [true], 'tech ex options reused from tonight (options were not available)');
    assert.equal(sh.techIfApplied, 64);
    assert.equal(sh.techExOptions, 60);
    assert.equal(sh.c3Confirm, confirmOf(60, sh.dirSig));
    assert.equal(sh.convictionIfApplied, 64 + (sh.confirm === 'confirm' ? 8 : sh.confirm === 'conflict' ? -10 : 0));
    assert.match(shadowLine(sh), /^AAA — options read 2026-10-29, not yet applied: [A-Z]+, [+-]?\d+ conviction if applied \(58 → \d+\), tech 60 → 64\.$/);
  });
  test('a stale read gives no shadow', async () => {
    const r = await readOfChain(json(1, spec('AAA')), 'AAA', '2026-10-26', NOW, TZ);
    const none: OptionsRead = { ...r, day: '2026-10-29', status: 'no chain', rows: [] };
    const g = gateRead(none, r, '2026-10-30');
    assert.equal(g.fresh, false);
    assert.equal(computeOptionsShadow('AAA', { gated: g, snap: await snapshotReadOf(r, NOW, TZ), techPlan: { techScore: 1, timing: 'x' }, decision: { finalConviction: 1, action: 'x' }, optAnalysis: analyzeOptionsForScoring(null, null), plan: () => { throw new Error('not called'); }, decide: () => { throw new Error('not called'); } }), null);
  });
});

describe('C-2 shadow: the net $ bias weighted by delta-dollars', () => {
  test('mirror strikes: the strike-weighted bias leans to calls, the delta-dollar bias is 0', () => {
    const exp = Math.floor(NOW / 86400000) * 86400000 + 60 * 86400000;
    const o = (cp: 'C' | 'P', k: number, d: number) => ({ option: occ('MMM', exp, cp, k), open_interest: 1000, volume: 10, iv: 0.3, delta: d, bid: 5, ask: 5.2 });
    const j = { data: { current_price: 100, options: [o('C', 110, 0.3), o('P', 90, -0.3)] } } as CboeChainJson;
    assert.equal(deltaDollarBias(j, 100).netBiasPct, 0);
    assert.equal(deltaDollarBias(j, 100).basis, 'delta');
    const noDelta = { data: { current_price: 100, options: [{ ...o('C', 110, 0), delta: null, bid: 2, ask: 2 }, { ...o('P', 90, 0), delta: null, bid: 2, ask: 2 }] } } as unknown as CboeChainJson;
    assert.deepEqual(deltaDollarBias(noDelta, 100), { netBiasPct: 0, basis: 'premium' });
  });
});

describe('Part B: the market read (display only, feeds no score)', () => {
  const exp = (d: number): number => Math.floor(NOW / 86400000) * 86400000 + d * 86400000;
  const opt = (cp: 'C' | 'P', d: number, k: number, iv: number, delta: number | null, oi = 100, vol = 10) => ({ option: occ('SPY', exp(d), cp, k), open_interest: oi, volume: vol, iv, ...(delta == null ? {} : { delta }) });
  const chain = (withDelta: boolean, ivFront: number): CboeChainJson => ({ data: { current_price: 100, options: [
    opt('C', 30, 95, ivFront, withDelta ? 0.7 : null), opt('C', 30, 100, ivFront, withDelta ? 0.5 : null), opt('C', 30, 105, ivFront - 0.02, withDelta ? 0.25 : null),
    opt('P', 30, 95, ivFront + 0.04, withDelta ? -0.25 : null, 300), opt('P', 30, 100, ivFront + 0.01, withDelta ? -0.5 : null, 150), opt('P', 30, 105, ivFront, withDelta ? -0.7 : null),
    opt('C', 90, 100, 0.2, null), opt('C', 90, 105, 0.2, null), opt('C', 365, 100, 0.22, null), opt('C', 365, 105, 0.22, null), opt('P', 365, 95, 0.25, null, 400),
  ] } });
  test('P/C, skew by delta and by moneyness, term ratio, VIX check, hedging read', () => {
    const r = marketReadOf({ day: '2026-10-29', etf: 'SPY', json: chain(true, 0.16), nowMs: NOW, closes: Array.from({ length: 30 }, (_, i) => 100 + (i % 2)), vix: { level: 16, closes: [12, 30, 16] } });
    assert.equal(r.status, 'ok');
    assert.equal(r.pcOi, Math.round((950 / 700) * 1000) / 1000);
    assert.equal(r.pcOi60, Math.round((550 / 300) * 1000) / 1000);
    assert.equal(r.skewMethod, '25-delta');
    assert.equal(r.skewPts, 6);
    assert.equal(r.iv30, 0.16);
    assert.equal(r.term, 'normal');
    assert.equal(r.check, 'ok');
    assert.equal(r.vixRangePct, Math.round(((16 - 12) / 18) * 100));
    assert.equal(r.ivPct, null);
    const nd = marketReadOf({ day: '2026-10-29', etf: 'SPY', json: chain(false, 0.3), nowMs: NOW, vix: { level: 16, closes: [16] } });
    assert.equal(nd.skewMethod, '95/105 strike');
    assert.equal(nd.term, 'inverted');
    assert.equal(nd.read, 'hedging heavy');
    assert.equal(nd.check, 'check', 'SPY IV 30% vs VIX 16: a gap above 5 points');
    assert.equal(hedgingRead(2, 'normal'), 'hedging light');
    assert.equal(skewAt([], 0, 100).method, 'none');
    assert.match(marketReadLine([r, nd])!, /^Market options \(2026-10-29, display only, feeds no score\): SPY P\/C 1\.36, skew 6\.0 pts, term normal, IV 30d 16% vs RV20 \d+%, IV history 0 of 252 nights \(hedging normal\); SPY/);
    assert.equal(marketReadLine([{ ...r, status: 'no chain' }]), null);
  });
  test('stored rows read back: history and the latest line', async () => {
    const { http } = fakeCboe({ SPY: JSON.stringify(chain(true, 0.16)) });
    const store = new MemoryTabStore();
    const d = { cboe: { http, memo: new Map(), stats: new Map() }, store, kv: new MemoryPropertyStore(), timeZone: TZ, log: () => {}, fetchChart: async () => null };
    await runOptionsChains({ ...d, now: () => NOW }, [], []);
    await runOptionsChains({ ...d, cboe: { http, memo: new Map(), stats: new Map() }, now: () => NOW + 86400000 }, [], []);
    const m = await readMarketOptions(store);
    assert.deepEqual(m.ivHistory.get('SPY'), [0.16, 0.16]);
    assert.equal(m.latest.length, 1);
    assert.equal(m.latest[0]!.day, '2026-10-30');
    assert.match(marketReadLine(m.latest)!, /SPY P\/C 1\.36/);
  });
});

/** The last `n` bars of a fixture, shaped like fetchYahooChart's result (as test/fl7a2.runTicker.test.ts). */
function tailChart(raw: RawFixture, n: number, ticker = raw.ticker) {
  const len = raw.closes.length, from = Math.max(0, len - n);
  const sl = <T,>(a: T[] | undefined, d: T[]): T[] => (a ?? d).slice(from);
  const closes = raw.closes.slice(from);
  const dates = raw.dates.slice(from).map((d) => new Date(d + 'T00:00:00Z'));
  return {
    ticker, dates, opens: sl(raw.opens, raw.closes), highs: sl(raw.highs, raw.closes), lows: sl(raw.lows, raw.closes), closes,
    volumes: sl(raw.volumes, raw.closes.map(() => 0)), splits: [],
    ipoDate: new Date(raw.dates[0] + 'T00:00:00Z'), currentPrice: closes[closes.length - 1], prevClose: closes[closes.length - 2], currency: 'USD',
  };
}

describe('A-8 end to end: a real (non-parity) ticker run with the shadow hook', { skip: fixturesPresent() ? false : 'price fixtures not present' }, () => {
  test('the shadow is computed and the result (fundamentals, tech plan, decision) is exactly the run without it', async () => {
    const charts: Record<string, unknown> = { TSLA: tailChart(loadRawFixture('TSLA'), 504), SPY: tailChart(loadRawFixture('SPY'), 504), '^VIX': tailChart(loadRawFixture('_VIX'), 300, '^VIX') };
    const spot = (charts.TSLA as { currentPrice: number }).currentPrice;
    const read = await readOfChain(json(11, spec('TSLA', { spot })), 'TSLA', '2026-10-29', NOW, TZ);
    const snap = (await snapshotReadOf(read, NOW, TZ))!;
    const run = async (withShadow: boolean) => {
      const book = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
      const ctx = createContext({ mode: 'test', runId: 'osp', logger: new Logger({ sink: () => {}, scope: 'osp', now: () => new Date(0) }), clock: { now: () => NOW }, sleep: async () => {}, random: () => 0 });
      const deps: TickerAnalysisDeps = {
        ss: book, timeZone: TZ, clock: { now: () => NOW }, ctx,
        fetchYahooChart: async (t) => (charts[t] ? structuredClone(charts[t]) : null) as never,
        fetchLongRangeCloses: async () => null,
        gatherFundamentals: async () => ({ fund: null, source: 'none' }) as never,
        fundamentalsStore: new MemoryPropertyStore(),
        fetchPeerMetrics: async (syms) => new Map(syms.map((x) => [x, null as never])),
        getTickerDarkPoolShare: async () => null,
        getCachedMacroRegime: async () => ({ available: true, regime: 'RISK_ON' }),
        readBrokerDataCache: async () => null,
        fetchSecEdgarCIK: async () => null,
        fetchSharesOutstandingHistory: async () => null,
        fetchSecFilingKeywordHits: async () => null,
        getCachedRelativeStrengthRanking: async () => null,
        fetchGeminiReview: async () => null,
        aiUnavailable: true,
        buildBrokerCourseReport: async () => null,
        render: { dashboard: () => { getOrCreate(book, ANALYSIS_TAB); }, failureSheet: () => { getOrCreate(book, ANALYSIS_TAB); }, textReport: () => {} },
        ...(withShadow ? { optionsShadow: (t: string) => (t === 'TSLA' ? { gated: gateRead(read, null, '2026-10-29'), snap } : null) } : {}),
      };
      return runTickerAnalysisDetailed(deps, 'TSLA');
    };
    const plain = await run(false), shadowed = await run(true);
    assert.ok(plain.result && shadowed.result);
    assert.equal(plain.optionsShadow, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(shadowed.result)), JSON.parse(JSON.stringify(plain.result)), 'the decision is unchanged');
    assert.equal(shadowed.optAnalysis!.available, false, 'options not applied (no _OPTIONS_SNAPSHOT in the scratch)');
    const sh = shadowed.optionsShadow!;
    assert.ok(sh, 'shadow computed');
    assert.equal(sh.techNow, plain.result!.techPlan.techScore);
    assert.equal(sh.convictionNow, plain.result!.decision.finalConviction);
    assert.equal(sh.techExOptions, plain.result!.techPlan.techScore);
    assert.ok(['confirm', 'conflict', 'neutral'].includes(sh.confirm));
  });
});

describe('Part B in the AI prompt: the market line is added to macroBackdrop as text', () => {
  test('present -> appended; absent -> unchanged', async () => {
    const base = { ticker: 'TSLA', fundResult: { score: 72 }, techPlan: { techScore: 60, timing: 'BUY_NOW', entryPrice: 100 }, decision: { action: 'BUY', finalConviction: 70 }, ind: {}, fund: null,
      chart: { currentPrice: 105, vixContext: { level: 16, high52: 30, low52: 12, rangePct: 22, read: 'normal' } }, optAnalysis: null } as unknown as GeminiReviewInputs;
    const line = 'Market options (2026-10-29, display only, feeds no score): SPY P/C 1.36 (hedging normal).';
    const a = await buildGeminiReport(base, () => null);
    const b = await buildGeminiReport(base, () => null, undefined, { marketOptionsLine: line });
    assert.equal(a.macroBackdrop, 'normal');
    assert.equal(b.macroBackdrop, 'normal; ' + line);
    assert.deepEqual({ ...b, macroBackdrop: a.macroBackdrop }, a, 'nothing else changes');
  });
});
