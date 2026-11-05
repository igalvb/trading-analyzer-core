/**
 * FL-5: FINRA ATS (dark-pool) data, the Dark Pool Tracker report and tab,
 * the per-ticker dark-pool read, the Evaluative Index, the relative-strength
 * ranking, the three daily trigger handlers and their schedules.
 *
 * Everything is compared with the oracle on the same synthetic FINRA
 * responses (test/darkPoolFixtures.ts) and the same charts (the oracle's
 * fetchYahooChart is replaced): return values, Logger lines, request
 * traces, PropertiesService contents, and the tracker tab cell for cell AND
 * formatting call for call (legacy's Sheet calls are recorded).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, FakeSheet, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { rng } from './fundamentalsFixtures.ts';
import { probePayload, batchPayload, recordedPost, atsRows, fakeChart, type FakeChart, type AtsKind } from './darkPoolFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey, assertNoSecrets, RecordingTransport, HttpResponse,
  type HttpTransport, type HttpRequest, type RecordedExchange,
} from '../src/net/http.ts';
import { MemoryPropertyStore, SheetPropertyStore, cacheSet } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { ok } from '../src/core/result.ts';
import { mostRecentMonday, findLatestPublishedFinraWeek, fetchFinraAtsWeeklyBatch, finraCompareFilter } from '../src/fetch/finra/ats.ts';
import {
  DARK_POOL_WATCHLIST, darkPoolUniverse, extractAtsWeeklyShare, buildDarkPoolTrackerReport, getTickerDarkPoolShare, computeEvaluativeIndex,
  computeRelativeStrengthRanking, getCachedEvaluativeIndex, getCachedRelativeStrengthRanking, getCachedFinraWeek, RELATIVE_STRENGTH_KEY,
  type DarkPoolChart,
} from '../src/analysis/darkPool.ts';
import { DARK_POOL_TRACKER_TAB } from '../src/sheets/writers/darkPoolTracker.ts';
import {
  refreshDarkPoolTracker, refreshEvaluativeIndex, refreshRelativeStrengthRanking, DARK_POOL_DAILY_JOBS, runDarkPoolDailyJobs, type DarkPoolJobDeps,
} from '../src/jobs/darkPool.ts';
import { MemoryTabFormatter, SheetTabFormatter, formatOpsToRequests, hexColor, type FormatOp } from '../src/sheets/formatOps.ts';

const ready = legacyFilesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T09:00:00Z'); // Fri 05:00 New York; this week's Monday is 2026-10-19

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

class TracingTransport implements HttpTransport {
  readonly trace: string[] = [];
  private readonly inner: HttpTransport;
  constructor(inner: HttpTransport) {
    this.inner = inner;
  }
  send(req: HttpRequest): Promise<HttpResponse> {
    this.trace.push(exchangeKey(req.method, req.url, req.payload));
    return this.inner.send(req);
  }
}

interface GasParams { readonly method?: string; readonly payload?: string }

function tracingUrlFetchApp(book: ExchangeBook, trace: string[]): Record<string, unknown> {
  const inner = replayUrlFetchApp(book) as { fetch: (u: string, p?: GasParams) => unknown };
  return {
    fetch: (url: string, params?: GasParams) => { trace.push(exchangeKey(params?.method, url, params?.payload)); return inner.fetch(url, params); },
    fetchAll: (reqs: Array<GasParams & { url: string }>) => reqs.map((q) => { trace.push(exchangeKey(q.method, q.url, q.payload)); return inner.fetch(q.url, q); }),
  };
}

// ── a Spreadsheet fake that records every formatting call ─────────────

type Op = unknown[];

class RecSpreadsheet {
  readonly sheets = new Map<string, { inner: FakeSheet; ops: Op[] }>();
  getSheetByName(name: string): unknown {
    return this.sheets.has(name) ? this.wrap(name) : null;
  }
  insertSheet(name: string): unknown {
    this.sheets.set(name, { inner: new FakeSheet(name, 'raw'), ops: [] });
    return this.wrap(name);
  }
  grid(name: string): unknown[][] | null {
    const s = this.sheets.get(name);
    if (!s) return null;
    const last = s.inner.getLastRow();
    return last ? s.inner.getRange(1, 1, last, 4).getValues() : [];
  }
  ops(name: string): Op[] {
    return this.sheets.get(name)?.ops ?? [];
  }
  private wrap(name: string): Record<string, unknown> {
    const s = this.sheets.get(name)!;
    const rangeOf = (r: number, c: number, nr = 1, nc = 1): Record<string, unknown> => {
      const inner = s.inner.getRange(r, c, nr, nc);
      const range: Record<string, unknown> = {};
      const rec = (k: string) => (v?: unknown) => { s.ops.push(v === undefined ? [k, r, c, nr, nc] : [k, r, c, nr, nc, v]); return range; };
      Object.assign(range, {
        setValue: (v: unknown) => { inner.setValue(v); return range; },
        setValues: (v: unknown[][]) => { inner.setValues(v); return range; },
        merge: rec('merge'), setFontWeight: rec('fontWeight'), setFontSize: rec('fontSize'), setBackground: rec('background'), setFontColor: rec('fontColor'), setWrap: rec('wrap'),
      });
      return range;
    };
    return {
      getRange: rangeOf,
      clearContents: () => { s.inner.clearContents(); },
      clearFormats: () => { s.ops.push(['clearFormats']); },
      setTabColor: (c: string) => { s.ops.push(['tabColor', c]); },
      setColumnWidths: (a: number, n: number, w: number) => { s.ops.push(['columnWidths', a, n, w]); },
      setFrozenRows: (n: number) => { s.ops.push(['frozenRows', n]); },
      getLastRow: () => s.inner.getLastRow(),
    };
  }
}

function tuple(o: FormatOp): Op {
  switch (o.op) {
    case 'clearFormats': return ['clearFormats'];
    case 'tabColor': return ['tabColor', o.color];
    case 'merge': return ['merge', o.range.row, o.range.col, o.range.numRows, o.range.numCols];
    case 'columnWidths': return ['columnWidths', o.start, o.count, o.width];
    case 'frozenRows': return ['frozenRows', o.count];
    case 'rowHeight': return ['rowHeight', o.row, o.height];
    case 'hidden': return ['hidden', o.value];
    default: return [o.op, o.range.row, o.range.col, o.range.numRows, o.range.numCols, o.value];
  }
}

// ── both sides ────────────────────────────────────────────────────────

type ChartSource = (t: string) => DarkPoolChart | null;

interface Env {
  readonly ss: RecSpreadsheet;
  readonly props: FakeProperties;
  readonly kv: MemoryPropertyStore;
  readonly store: MemoryTabStore;
  readonly formatter: MemoryTabFormatter;
}

const freshEnv = (limits = true): Env => ({ ss: new RecSpreadsheet(), props: new FakeProperties(new Map(), limits), kv: new MemoryPropertyStore(), store: new MemoryTabStore(), formatter: new MemoryTabFormatter() });

function legacy<T>(env: Env, ex: readonly RecordedExchange[], now: number, charts: ChartSource, fn: (o: ReturnType<typeof loadOracle>) => T, extra: Record<string, unknown> = {}): { value: T; logs: string[]; trace: string[] } {
  const logs: string[] = [];
  const trace: string[] = [];
  const value = withOracleGlobals({
    SpreadsheetApp: { getActiveSpreadsheet: () => env.ss }, PropertiesService: fakePropertiesService(env.props),
    UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now), Logger: { log: (m: unknown) => { logs.push(String(m)); } },
    fetchYahooChart: (t: string) => charts(t), ...extra,
  }, () => fn(loadOracle()));
  return { value: structuredClone(value), logs, trace };
}

function portDeps(env: Env, ex: readonly RecordedExchange[], now: number, charts: ChartSource, extra: Partial<DarkPoolJobDeps> = {}): { deps: DarkPoolJobDeps; logs: string[]; transport: TracingTransport } {
  const logs: string[] = [];
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  return {
    logs, transport,
    deps: {
      http: new HttpClient({ transport }), kv: env.kv, store: env.store, formatter: env.formatter, timeZone: TZ, clock: { now: () => now },
      fetchChart: async (t: string) => charts(t), log: (m: string) => { logs.push(m); }, ...extra,
    },
  };
}

function assertSameState(env: Env, where: string): void {
  assert.deepStrictEqual([...env.kv.map].sort(), [...env.props.map].sort(), where + ' (properties)');
  assert.deepStrictEqual(env.store.snapshot(DARK_POOL_TRACKER_TAB, 4), env.ss.grid(DARK_POOL_TRACKER_TAB), where + ' (tracker tab values)');
  assert.deepStrictEqual((env.formatter.applied.get(DARK_POOL_TRACKER_TAB) ?? []).map(tuple), env.ss.ops(DARK_POOL_TRACKER_TAB), where + ' (tracker tab formatting)');
}

/** Copies a legacy cacheSet into the port's store (same payload, byte for byte). */
function seedCache(env: Env, key: string, value: unknown, ttl: number, at: number): void {
  legacy(env, [], at, () => null, (o) => o.call('cacheSet', key, value, ttl));
  env.kv.map.set(key, env.props.map.get(key)!);
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const weekBack = (k: number): string => new Date(Date.UTC(2026, 9, 19 - 7 * k)).toISOString().slice(0, 10);
const UNIVERSE = darkPoolUniverse();

/** A synthetic FINRA week: probes, a Tier-1 and a Tier-2 answer per ticker, and charts. */
function scenario(seed: number, t1Back: number | null, t2Back: number | null, misses: boolean): { ex: RecordedExchange[]; charts: ChartSource } {
  const r = rng(seed);
  const ex: RecordedExchange[] = [];
  for (const [tier, back] of [['T1', t1Back], ['T2', t2Back]] as Array<[string, number | null]>) {
    for (let k = 0; k < 8; k++) {
      const p = probePayload(weekBack(k), tier);
      if (back !== null && k === back) { ex.push(recordedPost(p, 200, JSON.stringify([{ weekStartDate: weekBack(k), tierIdentifier: tier }]))); break; }
      const pick = k % 5;
      if (pick === 0) ex.push(recordedPost(p, 204, ''));
      else if (pick === 1) ex.push(recordedPost(p, 200, '[]'));
      else if (pick === 2) ex.push(recordedPost(p, 200, '  [] \n'));
      else if (pick === 3) ex.push(recordedPost(p, 500, '{"error":"x"}'));
      // pick 4: unrecorded -- a network error
    }
  }
  const t1Week = t1Back === null ? null : weekBack(t1Back);
  const t2Week = t2Back === null ? null : weekBack(t2Back);
  const charts = new Map<string, DarkPoolChart | 'throw' | null>();
  UNIVERSE.forEach((t, i) => {
    if (t1Week) {
      const x = r();
      const p = batchPayload(t, 'T1', t1Week);
      const kinds: AtsKind[] = ['agg', 'firms', 'mixed', 'aggZero'];
      if (x < 0.55) ex.push(recordedPost(p, 200, JSON.stringify(atsRows(t, 'T1', t1Week, kinds[Math.floor(r() * 4)], r))));
      else if (x < 0.7) ex.push(recordedPost(p, 200, '[]'));
      else if (x < 0.75) ex.push(recordedPost(p, 200, ''));
      else if (x < 0.85) ex.push(recordedPost(p, 204, ''));
      else if (x < 0.92) ex.push(recordedPost(p, 200, '{not json'));
      else if (!misses) ex.push(recordedPost(p, 200, '[]'));
    }
    if (t2Week) {
      const x = r();
      const p = batchPayload(t, 'T2', t2Week);
      if (x < 0.5) ex.push(recordedPost(p, 200, JSON.stringify(atsRows(t, 'T2', t2Week, 'firms', r))));
      else if (x < 0.8) ex.push(recordedPost(p, 200, '[]'));
      else ex.push(recordedPost(p, 204, ''));
    }
    const c = r();
    charts.set(t, c < 0.05 ? null : c < 0.1 ? 'throw' : c < 0.14 ? { ...fakeChart(seed * 1000 + i, 4, 0), currentPrice: 9 } : c < 0.18 ? { ...fakeChart(seed * 1000 + i, 30, 0), volumes: [0, 0, 0, 0, 0] } : fakeChart(seed * 1000 + i, 260, (r() - 0.45) * 0.004));
  });
  return { ex, charts: (t) => { const c = charts.get(t); if (c === 'throw') throw new Error('chart fetch failed for ' + t); return c ?? null; } };
}

const quietCtx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

describe('FL-5 — FINRA ATS fetches', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('mostRecentMondayV1_ matches legacy in every zone, across DST and midnight-less days', async () => {
    const o = loadOracle();
    for (const tz of ['America/New_York', 'Asia/Jerusalem', 'UTC', 'Pacific/Kiritimati', 'America/Santiago', 'Australia/Lord_Howe']) {
      await inZone(tz, () => {
        for (let k = 0; k < 700; k++) {
          const t = Date.parse('2026-01-01T00:00:00Z') + k * 13.37 * 3600_000;
          const expected = (o.call('mostRecentMondayV1_', new Date(t)) as Date).getTime();
          assert.equal(mostRecentMonday(new Date(t), tz).getTime(), expected, tz + ' ' + new Date(t).toISOString());
        }
      });
    }
    assert.deepStrictEqual(finraCompareFilter('a', 'b'), o.callNormalized('finraCompareFilterV1_', 'a', 'b'));
  });

  test('findLatestPublishedFinraWeekV1_: the backward probe walk, request for request', async () => {
    for (const tz of [TZ, 'Asia/Jerusalem']) {
      await inZone(tz, async () => {
        for (const [seed, t1, t2] of [[1, 2, 4], [2, 0, 7], [3, null, null], [4, 3, 1]] as Array<[number, number | null, number | null]>) {
          const { ex } = scenario(seed, t1, t2, false);
          for (const at of [NOW, Date.parse('2026-10-19T03:30:00Z'), Date.parse('2026-10-19T04:30:00Z'), Date.parse('2026-10-25T23:00:00Z')]) {
            for (const tier of ['T1', 'T2']) {
              const L = legacy(freshEnv(), ex, at, () => null, (o) => o.call('findLatestPublishedFinraWeekV1_', tier));
              const P = portDeps(freshEnv(), ex, at, () => null, { timeZone: tz });
              assert.equal(await findLatestPublishedFinraWeek(P.deps, tier), L.value, tz + ' ' + seed + ' ' + tier + ' ' + new Date(at).toISOString());
              assert.deepStrictEqual(P.transport.trace, L.trace);
            }
          }
        }
      });
    }
  });

  test('F-55: across the spring DST change legacy probes Sundays and finds nothing; calendar steps find the week', async () => {
    await inZone(TZ, async () => {
      const at = Date.parse('2026-03-20T15:00:00Z');
      const ex = [recordedPost(probePayload('2026-03-02', 'T1'), 200, '[{"weekStartDate":"2026-03-02"}]')];
      const L = legacy(freshEnv(), ex, at, () => null, (o) => o.call('findLatestPublishedFinraWeekV1_', 'T1'));
      assert.equal(L.value, null, 'legacy: nothing found');
      assert.ok(L.trace[2].includes('"2026-03-01"'), 'legacy\'s third probe is Sunday 2026-03-01');
      const legacyMode = portDeps(freshEnv(), ex, at, () => null);
      assert.equal(await findLatestPublishedFinraWeek(legacyMode.deps, 'T1'), null);
      assert.deepStrictEqual(legacyMode.transport.trace, L.trace, 'the default reproduces legacy exactly');
      const fixed = portDeps(freshEnv(), ex, at, () => null, { calendarWeekSteps: true });
      assert.equal(await findLatestPublishedFinraWeek(fixed.deps, 'T1'), '2026-03-02');
      assert.deepStrictEqual(fixed.transport.trace.map((k) => /"weekStartDate","fieldValue":"([\d-]+)"/.exec(k)![1]), ['2026-03-16', '2026-03-09', '2026-03-02']);
      // Away from the spring change both modes agree.
      const { ex: ex2 } = scenario(1, 2, 4, false);
      const a = portDeps(freshEnv(), ex2, NOW, () => null);
      const b = portDeps(freshEnv(), ex2, NOW, () => null, { calendarWeekSteps: true });
      assert.equal(await findLatestPublishedFinraWeek(a.deps, 'T2'), await findLatestPublishedFinraWeek(b.deps, 'T2'));
      assert.deepStrictEqual(a.transport.trace, b.transport.trace);
    });
  });

  test('fetchFinraAtsWeeklyBatchV1_: rows, [], null per ticker; the sequential fallback when a request throws', async () => {
    await inZone(TZ, async () => {
      for (const [seed, misses] of [[5, false], [6, true], [7, true]] as Array<[number, boolean]>) {
        const { ex } = scenario(seed, 1, 2, misses);
        for (const [tickers, tier, week] of [[UNIVERSE, 'T1', weekBack(1)], [UNIVERSE.slice(0, 9), 'T2', weekBack(2)], [[], 'T1', weekBack(1)], [UNIVERSE, 'T1', null], [['ZZZZ'], 'T1', weekBack(1)]] as Array<[string[], string, string | null]>) {
          const L = legacy(freshEnv(), ex, NOW, () => null, (o) => o.call('fetchFinraAtsWeeklyBatchV1_', tickers, tier, week));
          const P = portDeps(freshEnv(), ex, NOW, () => null);
          assert.deepStrictEqual(await fetchFinraAtsWeeklyBatch(P.deps, tickers, tier, week), L.value, seed + ' ' + tier + ' ' + tickers.length);
          if (!misses) assert.deepStrictEqual(sorted(P.transport.trace), sorted(L.trace));
        }
      }
    });
  });
});

describe('FL-5 — the Dark Pool Tracker', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('extractAtsWeeklyShareV1_', () => {
    const o = loadOracle();
    const r = rng(9);
    const cases: unknown[] = [null, undefined, [], [{ summaryTypeCode: 'OTHER', totalWeeklyShareQuantity: 5 }]];
    for (const k of ['agg', 'firms', 'mixed', 'aggZero'] as AtsKind[]) for (let i = 0; i < 5; i++) cases.push(atsRows('X', 'T1', '2026-10-05', k, r));
    cases.push([{ summaryTypeCode: 'ATS_W_SMBL' }], [{ summaryTypeCode: 'ATS_W_SMBL_FIRM' }, { summaryTypeCode: 'ATS_W_SMBL_FIRM', totalWeeklyShareQuantity: 3 }]);
    for (const c of cases) assert.deepStrictEqual(extractAtsWeeklyShare(c as never), o.call('extractAtsWeeklyShareV1_', c));
  });

  test('buildDarkPoolTrackerReportV1_ and refreshDarkPoolTrackerV1: report, caches, logs, requests, and the tab (values and formatting), twice', async () => {
    await inZone(TZ, async () => {
      const seen = { elevated: 0, t1: 0, t2: 0, noTier: 0, nullPct: 0 };
      for (const [seed, t1, t2, misses] of [[11, 2, 4, false], [12, 0, null, true], [13, null, 3, false], [14, null, null, false], [15, 1, 1, true]] as Array<[number, number | null, number | null, boolean]>) {
        const { ex, charts } = scenario(seed, t1, t2, misses);
        const env1 = freshEnv();
        const L = legacy(env1, ex, NOW, charts, (o) => o.call('buildDarkPoolTrackerReportV1_', (m: unknown) => { void m; }));
        const P = portDeps(env1, ex, NOW, charts);
        const report = await buildDarkPoolTrackerReport(P.deps, () => {});
        assert.deepStrictEqual(structuredClone(report), L.value, 'report ' + seed);
        if (!misses) assert.deepStrictEqual(sorted(P.transport.trace), sorted(L.trace), 'requests ' + seed);
        for (const cat of report.categories) for (const row of cat.rows) {
          if (row.elevated) seen.elevated++;
          if (row.tier === 'T1') seen.t1++; else if (row.tier === 'T2') seen.t2++; else seen.noTier++;
          if (row.darkPoolSharePct == null) seen.nullPct++;
        }
        const env = freshEnv();
        for (const at of [NOW, NOW + 86400_000]) {
          const Lr = legacy(env, ex, at, charts, (o) => o.call('refreshDarkPoolTrackerV1'));
          const Pr = portDeps(env, ex, at, charts);
          await refreshDarkPoolTracker(Pr.deps);
          assert.deepStrictEqual(Pr.logs, Lr.logs, 'logs ' + seed);
          assertSameState(env, 'refresh ' + seed + ' at ' + new Date(at).toISOString());
        }
      }
      for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, k + ' never reached');
    });
  });

  test('a failure inside the refresh is logged, and the tab keeps its last good data', async () => {
    await inZone(TZ, async () => {
      const { ex, charts } = scenario(11, 2, 4, false);
      const env = freshEnv();
      legacy(env, ex, NOW, charts, (o) => o.call('refreshDarkPoolTrackerV1'));
      await refreshDarkPoolTracker(portDeps(env, ex, NOW, charts).deps);
      // The store now refuses to write: legacy's equivalent is a sheet that throws.
      const broken = { getActiveSpreadsheet: () => { throw new Error('Service Spreadsheets failed'); } };
      const Lr = legacy(env, ex, NOW, charts, (o) => o.call('refreshDarkPoolTrackerV1'), { SpreadsheetApp: broken });
      const Pr = portDeps(env, ex, NOW, charts, { store: { ...env.store, ensure: async () => { throw new Error('Service Spreadsheets failed'); } } as unknown as MemoryTabStore });
      await refreshDarkPoolTracker(Pr.deps);
      assert.deepStrictEqual(Pr.logs, Lr.logs);
      assert.match(Pr.logs[Pr.logs.length - 1], /^refreshDarkPoolTrackerV1 failed \(non-fatal, sheet keeps its last good data\): Service Spreadsheets failed$/);
      assertSameState(env, 'after the failed refresh');
    });
  });

  test('getTickerDarkPoolShareV1_: cached weeks only, Tier 1 then Tier 2, the analysis\'s own chart', async () => {
    await inZone(TZ, async () => {
      const w1 = weekBack(2), w2 = weekBack(4);
      const r = rng(21);
      const ex = [
        recordedPost(batchPayload('NVDA', 'T1', w1), 200, JSON.stringify(atsRows('NVDA', 'T1', w1, 'agg', r))),
        recordedPost(batchPayload('ODD', 'T1', w1), 200, '[]'), recordedPost(batchPayload('ODD', 'T2', w2), 200, JSON.stringify(atsRows('ODD', 'T2', w2, 'firms', r))),
        recordedPost(batchPayload('NONE', 'T1', w1), 204, ''), recordedPost(batchPayload('NONE', 'T2', w2), 200, '[]'),
        recordedPost(batchPayload('ERR', 'T1', w1), 500, ''),
      ];
      const charts: Array<[string, unknown]> = [
        ['ok', fakeChart(1, 30, 0)], ['null', null], ['short', fakeChart(2, 4, 0)], ['zero volume', { ...fakeChart(3, 10, 0), volumes: [0, 0, 0, 0, 0, 0] }],
        ['malformed volumes', { volumes: '1234567' }], ['huge share', { volumes: [1, 1, 1, 1, 1] }],
      ];
      for (const [weeks, label] of [[[w1, w2], 'both'], [[w1, null], 'T1 only'], [[null, w2], 'T2 only'], [[null, null], 'none']] as Array<[[string | null, string | null], string]>) {
        for (const ticker of ['NVDA', 'ODD', 'NONE', 'ERR', 'MISSING']) {
          for (const [cl, chart] of charts) {
            const env = freshEnv();
            if (weeks[0]) seedCache(env, 'darkPoolFinraWeek_T1', weeks[0], 30, NOW - 3600_000);
            if (weeks[1]) seedCache(env, 'darkPoolFinraWeek_T2', weeks[1], 30, NOW - 3600_000);
            const L_logs: string[] = [];
            const L = legacy(env, ex, NOW, () => null, (o) => o.call('getTickerDarkPoolShareV1_', ticker, chart, (m: unknown) => { L_logs.push(String(m)); }));
            const P = portDeps(env, ex, NOW, () => null);
            const P_logs: string[] = [];
            const port = await getTickerDarkPoolShare(P.deps, ticker, chart as DarkPoolChart, (m) => { P_logs.push(m); });
            assert.deepStrictEqual(port, L.value, label + ' ' + ticker + ' ' + cl);
            assert.deepStrictEqual(P_logs, L_logs, label + ' ' + ticker + ' ' + cl + ' (log)');
            assert.deepStrictEqual(P.transport.trace, L.trace);
          }
        }
      }
      // The week caches expire after 30 h on both sides.
      const env = freshEnv();
      seedCache(env, 'darkPoolFinraWeek_T1', w1, 30, NOW - 31 * 3600_000);
      assert.equal(await getCachedFinraWeek(portDeps(env, [], NOW, () => null).deps, 'T1'), legacy(env, [], NOW, () => null, (o) => o.call('getCachedFinraWeekV1_', 'T1')).value);
    });
  });
});

describe('FL-5 — Evaluative Index and relative-strength ranking', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const basket = (strongCount: number, extra: (t: string, i: number) => unknown = () => undefined): ChartSource => (t) => {
    const i = UNIVERSE.indexOf(t);
    const e = extra(t, i);
    if (e === 'throw') throw new Error('boom');
    if (e !== undefined) return e as DarkPoolChart;
    return fakeChart(500 + i, 260, i < strongCount ? 0.004 : -0.004);
  };

  test('computeEvaluativeIndexV1_ / refreshEvaluativeIndexV1 / getCachedEvaluativeIndexV1_ on every read', async () => {
    const cases: Array<[string, ChartSource]> = [
      ['oversold', basket(5)], ['overbought', basket(UNIVERSE.length)], ['neutral, with gaps', basket(60, (t, i) => (i % 9 === 0 ? null : i % 9 === 1 ? 'throw' : i % 9 === 2 ? fakeChart(i, 199, 0.01) : undefined))],
      ['all unavailable', () => null], ['a malformed chart aborts the whole index', basket(40, (t, i) => (i === 7 ? { closes: 'x'.repeat(250) } : undefined))],
      ['exactly 9%', basket(Math.round(UNIVERSE.length * 0.09), (t, i) => (i >= 100 ? null : undefined))],
    ];
    const reads = new Set<string>();
    for (const [label, charts] of cases) {
      const L = legacy(freshEnv(), [], NOW, charts, (o) => o.call('computeEvaluativeIndexV1_'));
      const port = await computeEvaluativeIndex(portDeps(freshEnv(), [], NOW, charts).deps);
      assert.deepStrictEqual(port, L.value, label);
      reads.add(port.read);
      const env = freshEnv();
      const Lr = legacy(env, [], NOW, charts, (o) => o.call('refreshEvaluativeIndexV1'));
      const Pr = portDeps(env, [], NOW, charts);
      await refreshEvaluativeIndex(Pr.deps);
      assert.deepStrictEqual(Pr.logs, Lr.logs, label + ' (log)');
      assert.deepStrictEqual([...env.kv.map], [...env.props.map], label + ' (cache)');
      for (const at of [NOW + 29 * 3600_000, NOW + 31 * 3600_000]) {
        assert.deepStrictEqual(await getCachedEvaluativeIndex(portDeps(env, [], at, charts).deps), legacy(env, [], at, charts, (o) => o.call('getCachedEvaluativeIndexV1_')).value);
      }
    }
    assert.equal(reads.size, 4, 'OVERSOLD, OVERBOUGHT, neutral and unavailable all reached: ' + [...reads].join(' | '));
  });

  test('computeRelativeStrengthRankingV1_ for every ticker; refreshRelativeStrengthRankingV1_ and the cached read', async () => {
    const charts = basket(0, (t, i) => {
      const r = rng(900 + i)();
      if (r < 0.05) return null;
      if (r < 0.08) return 'throw';
      if (r < 0.13) return fakeChart(i, 83, 0.001);
      if (t === 'IREN') return { ...fakeChart(i, 260, 0), highs: undefined };
      return fakeChart(700 + i, 84 + Math.floor(rng(i)() * 200), (rng(i * 7)() - 0.5) * 0.006);
    });
    const percentiles = new Set<string>();
    for (const t of [...UNIVERSE, 'ZZZZ', '']) {
      const L = legacy(freshEnv(), [], NOW, charts, (o) => o.call('computeRelativeStrengthRankingV1_', t));
      const port = await computeRelativeStrengthRanking(portDeps(freshEnv(), [], NOW, charts).deps, t);
      assert.deepStrictEqual(port, L.value, t);
      if (port) percentiles.add(port.read.split(' ')[0]);
    }
    assert.deepStrictEqual([...percentiles].sort(), ['STRONG', 'WEAK', 'middling']);
    const env = freshEnv(false);
    const Lr = legacy(env, [], NOW, charts, (o) => o.call('refreshRelativeStrengthRankingV1_'));
    const Pr = portDeps(env, [], NOW, charts);
    await refreshRelativeStrengthRanking(Pr.deps);
    assert.deepStrictEqual(Pr.logs, Lr.logs);
    assert.deepStrictEqual([...env.kv.map], [...env.props.map], 'same payload, byte for byte (no 9 KB limit on the legacy side here)');
    for (const t of ['NVDA', 'IREN', 'ZZZZ', 'TSLA']) {
      assert.deepStrictEqual(await getCachedRelativeStrengthRanking(portDeps(env, [], NOW + 3600_000, charts).deps, t), legacy(env, [], NOW + 3600_000, charts, (o) => o.call('getCachedRelativeStrengthRankingV1_', t)).value, t);
    }
    console.log('FL-5 measurement: relativeStrengthRankingV1 payload = ' + env.kv.map.get(RELATIVE_STRENGTH_KEY)!.length + ' characters');
  });

  test('F-56: the ranking map exceeds Apps Script\'s 9 KB property limit, so legacy never cached it; the port does', async () => {
    const charts = basket(50);
    const env = freshEnv(true);
    legacy(env, [], NOW, charts, (o) => o.call('refreshRelativeStrengthRankingV1_'));
    assert.equal(env.props.map.has(RELATIVE_STRENGTH_KEY), false, 'legacy: cacheSet swallowed "Argument too large"');
    assert.equal(legacy(env, [], NOW, charts, (o) => o.call('getCachedRelativeStrengthRankingV1_', 'NVDA')).value, null, 'so every report saw "unavailable"');
    await refreshRelativeStrengthRanking(portDeps(env, [], NOW, charts).deps);
    const size = env.kv.map.get(RELATIVE_STRENGTH_KEY)!.length;
    assert.ok(size > 9 * 1024, 'payload ' + size);
    assert.ok(await getCachedRelativeStrengthRanking(portDeps(env, [], NOW, charts).deps, 'NVDA'));
    console.log('FL-5 measurement: F-56 payload = ' + size + ' characters (Sheets cell limit 50000)');
  });
});

describe('FL-5 — triggers, the workflow step, formatting plumbing', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('each legacy installer\'s schedule (and its idempotency check) is the job table\'s', () => {
    for (const job of DARK_POOL_DAILY_JOBS) {
      for (const existing of [[], ['someOtherHandler'], [job.handler, job.handler]]) {
        const created: Array<Record<string, unknown>> = [];
        const scriptApp = {
          getProjectTriggers: () => existing.map((h) => ({ getHandlerFunction: () => h })),
          newTrigger: (handler: string) => {
            const t: Record<string, unknown> = { handler };
            const b: Record<string, (...a: any[]) => unknown> = {
              timeBased: () => b, everyDays: (n: number) => { t.everyDays = n; return b; }, atHour: (h: number) => { t.atHour = h; return b; },
              nearMinute: (m: number) => { t.nearMinute = m; return b; }, create: () => { created.push(t); return t; },
            };
            return b;
          },
        };
        const L = legacy(freshEnv(), [], NOW, () => null, (o) => o.call(job.installer), { ScriptApp: scriptApp });
        const already = existing.filter((h) => h === job.handler).length;
        if (already) {
          assert.deepStrictEqual(created, []);
          assert.match(L.logs[0], new RegExp('already installed \\(' + already + ' found\\)'));
        } else {
          assert.deepStrictEqual(created, [{ handler: job.handler, everyDays: job.everyDays, atHour: job.atHour, ...(job.nearMinute === null ? {} : { nearMinute: job.nearMinute }) }]);
        }
      }
    }
    assert.deepStrictEqual(DARK_POOL_DAILY_JOBS.map((j) => j.handler), ['refreshDarkPoolTrackerV1', 'refreshEvaluativeIndexV1', 'refreshRelativeStrengthRankingV1_']);
  });

  test('runDarkPoolDailyJobs runs the three handlers in order, each under its own step', async () => {
    await inZone(TZ, async () => {
      const { ex, charts } = scenario(11, 2, 4, false);
      const env = freshEnv(false);
      legacy(env, ex, NOW, charts, (o) => { o.call('refreshDarkPoolTrackerV1'); o.call('refreshEvaluativeIndexV1'); o.call('refreshRelativeStrengthRankingV1_'); });
      const P = portDeps(env, ex, NOW, charts);
      const ctx = quietCtx();
      const results = await runDarkPoolDailyJobs(ctx, P.deps);
      assert.deepStrictEqual(results.map((r) => r.ok), [true, true, true]);
      assert.deepStrictEqual(P.logs.map((l) => l.split(':')[0]), ['Dark Pool Tracker', 'refreshDarkPoolTrackerV1', 'refreshEvaluativeIndexV1', 'refreshRelativeStrengthRankingV1_']);
      assertSameState(env, 'daily jobs');
    });
  });

  test('format ops become Sheets requests; SheetTabFormatter sends one batch per tab', async () => {
    assert.deepStrictEqual(hexColor('#fff'), { red: 1, green: 1, blue: 1 });
    assert.deepStrictEqual(hexColor('#01579b'), { red: 1 / 255, green: 0x57 / 255, blue: 0x9b / 255 });
    assert.throws(() => hexColor('blue'));
    const R = { row: 3, col: 1, numRows: 1, numCols: 4 };
    const ops: FormatOp[] = [
      { op: 'clearFormats' }, { op: 'tabColor', color: '#01579b' }, { op: 'merge', range: R }, { op: 'fontWeight', range: R, value: 'bold' },
      { op: 'fontSize', range: R, value: 11 }, { op: 'fontColor', range: R, value: '#b71c1c' }, { op: 'background', range: R, value: '#e1f5fe' },
      { op: 'wrap', range: R, value: true }, { op: 'columnWidths', start: 1, count: 4, width: 150 }, { op: 'frozenRows', count: 1 },
    ];
    const g = { sheetId: 7, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 4 };
    assert.deepStrictEqual(formatOpsToRequests(7, ops), [
      { unmergeCells: { range: { sheetId: 7 } } }, { updateCells: { range: { sheetId: 7 }, fields: 'userEnteredFormat' } },
      { updateSheetProperties: { properties: { sheetId: 7, tabColor: hexColor('#01579b') }, fields: 'tabColor' } },
      { mergeCells: { range: g, mergeType: 'MERGE_ALL' } },
      { repeatCell: { range: g, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: g, cell: { userEnteredFormat: { textFormat: { fontSize: 11 } } }, fields: 'userEnteredFormat.textFormat.fontSize' } },
      { repeatCell: { range: g, cell: { userEnteredFormat: { textFormat: { foregroundColor: hexColor('#b71c1c') } } }, fields: 'userEnteredFormat.textFormat.foregroundColor' } },
      { repeatCell: { range: g, cell: { userEnteredFormat: { backgroundColor: hexColor('#e1f5fe') } }, fields: 'userEnteredFormat.backgroundColor' } },
      { repeatCell: { range: g, cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } },
      { updateDimensionProperties: { range: { sheetId: 7, dimension: 'COLUMNS', startIndex: 0, endIndex: 4 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
      { updateSheetProperties: { properties: { sheetId: 7, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    ]);
    const batches: unknown[][] = [];
    const api = { tabIds: async () => ok({ [DARK_POOL_TRACKER_TAB]: 7 }), formatBatch: async (_c: unknown, reqs: readonly unknown[]) => { batches.push([...reqs]); return ok(reqs.length); } };
    const f = new SheetTabFormatter(quietCtx(), api as never);
    await f.apply(DARK_POOL_TRACKER_TAB, ops);
    await f.apply(DARK_POOL_TRACKER_TAB, []);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 11);
    await assert.rejects(f.apply('nope', ops), /no tab named nope/);
  });

  test('POST bodies are part of the replay key, recorded, and checked for secrets', async () => {
    const a = recordedPost(batchPayload('A', 'T1', '2026-10-05'), 200, '[1]');
    const b = recordedPost(batchPayload('B', 'T1', '2026-10-05'), 200, '[2]');
    const http = new HttpClient({ transport: new ReplayTransport(new ExchangeBook([a, b])) });
    const req = (t: string): HttpRequest => ({ url: 'https://api.finra.org/data/group/otcMarket/name/weeklySummary', method: 'POST', payload: batchPayload(t, 'T1', '2026-10-05'), muteHttpExceptions: true });
    assert.equal((await http.fetch(req('B'))).text(), '[2]');
    assert.equal((await http.fetch(req('A'))).text(), '[1]');
    await assert.rejects(http.fetch(req('C')), /no recorded response/);
    const rec = new RecordingTransport({ send: async () => new HttpResponse(200, new Uint8Array(0)) });
    await rec.send(req('A'));
    await rec.send({ url: 'https://example.com/x' });
    assert.deepStrictEqual(rec.exchanges().map((x) => x.request), [{ method: 'POST', url: req('A').url, payload: req('A').payload }, { method: 'GET', url: 'https://example.com/x' }]);
    assert.throws(() => assertNoSecrets([{ request: { method: 'POST', url: 'https://x', payload: '{"key":"supersecret"}' }, response: { status: 200, bodyBase64: '' } }], ['supersecret']), /contains a secret/);
    assert.equal(exchangeKey('get', 'https://x'), 'GET https://x', 'GET keys unchanged');
    assert.equal(Object.keys(DARK_POOL_WATCHLIST).length, 14);
    assert.equal(UNIVERSE.length, 111);
  });

  test('F-57: the Sheet-backed store refuses a value over a cell\'s 50,000 characters instead of failing the whole flush', async () => {
    const client = { listTabs: async () => ok([]), formatBatch: async () => ok(1) };
    const loaded = await SheetPropertyStore.load(quietCtx(), client as never, 'T');
    assert.ok(loaded.ok);
    const s = loaded.value;
    const errors: unknown[] = [];
    assert.equal(await cacheSet(s, 'big', 'x'.repeat(50_000), 30, NOW, (e) => { errors.push(e); }), false);
    assert.match(String(errors[0]), /at most 50000/);
    assert.equal(await s.get('big'), null);
    assert.equal(await cacheSet(s, 'fits', 'x'.repeat(40_000), 30, NOW), true);
  });
});

describe('A1 (fix plan 2026-10-30) — FINRA asks for JSON; a CSV answer is not a published week', () => {
  class HeaderTransport implements HttpTransport {
    readonly requests: HttpRequest[] = [];
    private readonly respond: (req: HttpRequest) => HttpResponse | 'throw';
    constructor(respond: (req: HttpRequest) => HttpResponse | 'throw') {
      this.respond = respond;
    }
    async send(req: HttpRequest): Promise<HttpResponse> {
      this.requests.push(req);
      const r = this.respond(req);
      if (r === 'throw') throw new Error('network');
      return r;
    }
  }
  const body = (s: string): Uint8Array => new TextEncoder().encode(s);
  const CSV = '"weekStartDate","tierIdentifier","issueSymbolIdentifier","totalWeeklyShareQuantity"\n"2026-10-12","T1","TSLA",123\n';
  const deps = (t: HttpTransport) => ({ http: new HttpClient({ transport: t }), timeZone: TZ, clock: { now: () => NOW } });

  test('every FINRA request (probes, batch, sequential fallback) carries Accept: application/json', async () => {
    let n = 0;
    const t = new HeaderTransport((req) => (req.payload?.includes('issueSymbolIdentifier') && n++ === 1 ? 'throw' : new HttpResponse(200, body('[]'))));
    assert.equal(await findLatestPublishedFinraWeek(deps(t), 'T1'), null);
    await fetchFinraAtsWeeklyBatch(deps(t), ['AAPL', 'TSLA', 'NVDA'], 'T1', '2026-10-12');
    assert.equal(t.requests.length, 8 + 3 + 3, 'all 8 probes, the concurrent batch and the one-by-one retry were sent');
    for (const r of t.requests) {
      assert.equal(r.headers?.Accept, 'application/json', r.payload);
      assert.equal(r.method, 'POST');
      assert.equal(r.contentType, 'application/json');
    }
  });

  test('a 200 CSV body is rejected by the week finder, and the batch reads it as null', async () => {
    const csv = new HeaderTransport(() => new HttpResponse(200, body(CSV)));
    assert.equal(await findLatestPublishedFinraWeek(deps(csv), 'T1'), null, 'no week accepted from CSV');
    assert.equal(csv.requests.length, 8, 'every probe was tried and rejected');
    assert.deepStrictEqual(await fetchFinraAtsWeeklyBatch(deps(csv), ['TSLA'], 'T1', '2026-10-12'), { TSLA: null });
    // A JSON object (an error envelope) is not a published week either; a non-empty JSON array is.
    const obj = new HeaderTransport(() => new HttpResponse(200, body('{"rows":[1]}')));
    assert.equal(await findLatestPublishedFinraWeek(deps(obj), 'T1'), null);
    const rows = new HeaderTransport(() => new HttpResponse(200, body('[{"weekStartDate":"2026-10-19"}]')));
    assert.equal(await findLatestPublishedFinraWeek(deps(rows), 'T1'), '2026-10-19');
  });
});
