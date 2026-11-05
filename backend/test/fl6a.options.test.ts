/**
 * FL-6a: the Cboe chain fetches, myOpt_fetchCurrentPrice, the options
 * conviction engine (parseAndScore with LEAPS OI persistence, chain context,
 * signals, the recommended call), the OPTIONS_OVERLAY write, and
 * analyzeOptionsForScoringV7 -- each compared with the oracle on the same
 * synthetic Cboe chains (test/cboeFixtures.ts): values, Logger lines,
 * request traces and PropertiesService contents.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { FakeProperties, fakePropertiesService, replayUrlFetchApp } from './gasFakes.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { rng } from './fundamentalsFixtures.ts';
import { recordedGet, cboeUrlOf, occ, chainJson, chainOptions, DAYS_ALL, MULTS, type ChainSpec } from './cboeFixtures.ts';
import {
  HttpClient, ReplayTransport, ExchangeBook, exchangeKey, type HttpTransport, type HttpRequest, type HttpResponse, type RecordedExchange,
} from '../src/net/http.ts';
import { MemoryPropertyStore, OPTIONS_OVERLAY_KEY } from '../src/storage/kv.ts';
import { cboeUrl, parseOcc, fetchCboeRaw, fetchCboeChain, fetchChain, myOptParseOcc, myOptFetchCurrentPrice, type ChainColumns } from '../src/fetch/cboe.ts';
import {
  parseAndScore, computeChainContext, interpretSignal, isLeaps, selectRecommendedCall, saveOptionsOverlay, computeOiPersistence,
  type ScoredContracts, type ScoredContract,
} from '../src/analysis/options/conviction.ts';
import { scoreColor, fmtDate, addDays, elapsed } from '../src/analysis/options/futuresHelpers.ts';
import { analyzeOptionsForScoring } from '../src/analysis/options/scoring.ts';

const ready = legacyFilesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T15:00:00Z');

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
  return { fetch: (url: string, params?: GasParams) => { trace.push(exchangeKey(params?.method, url, params?.payload)); return inner.fetch(url, params); } };
}

interface Env {
  readonly props: FakeProperties;
  readonly kv: MemoryPropertyStore;
}

const freshEnv = (): Env => ({ props: new FakeProperties(new Map(), true), kv: new MemoryPropertyStore() });

function legacy<T>(env: Env, ex: readonly RecordedExchange[], now: number, fn: (o: ReturnType<typeof loadOracle>, log: (m: unknown) => void) => T, extra: Record<string, unknown> = {}): { value: T; logs: string[]; trace: string[] } {
  const logs: string[] = [];
  const trace: string[] = [];
  const log = (m: unknown): void => { logs.push(String(m)); };
  const value = withOracleGlobals({
    PropertiesService: fakePropertiesService(env.props), UrlFetchApp: tracingUrlFetchApp(new ExchangeBook(ex), trace), Date: pinnedDateClass(now),
    Logger: { log }, hasTimeBudgetV7_: () => true, _cboeRawChainCacheV1_: {}, ...extra,
  }, () => fn(loadOracle(), log));
  return { value: structuredClone(value), logs, trace };
}

function portDeps(env: Env, ex: readonly RecordedExchange[], now: number, timeZone = TZ) {
  const logs: string[] = [];
  const transport = new TracingTransport(new ReplayTransport(new ExchangeBook(ex)));
  const log = (m: string): void => { logs.push(m); };
  return { logs, log, transport, deps: { http: new HttpClient({ transport }), memo: new Map(), kv: env.kv, timeZone, clock: { now: () => now }, log, legacyExpiryLabel: true } };
}

const spec = (over: Partial<ChainSpec> = {}): ChainSpec => ({ root: 'TSLA', spot: 400, nowMs: NOW, days: DAYS_ALL, strikeMults: MULTS, maxOi: 60000, ...over });

/** The array plus legacy's two extra properties, as plain data. */
const unpack = (a: ScoredContracts | unknown[] & { dollarFloor?: number; fullChain?: unknown }): unknown => ({ list: Array.from(a), dollarFloor: (a as { dollarFloor?: number }).dollarFloor, fullChain: (a as { fullChain?: unknown }).fullChain });

describe('FL-6a — Cboe fetches', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('parseOcc / myOpt_parseOcc / the URL', () => {
    const o = loadOracle();
    const day = Date.UTC(2027, 0, 15);
    const syms = [occ('TSLA', day, 'C', 960), occ('BRKB', day, 'P', 450.5), occ('SPXW', Date.UTC(2026, 11, 18), 'C', 5000), occ('F', Date.UTC(2026, 10, 20), 'P', 12.5), occ('X1', Date.UTC(2028, 1, 29), 'C', 0.5)];
    for (const s of syms) assert.deepStrictEqual(parseOcc(s), o.callNormalized('parseOcc', s), s);
    const mine: unknown[] = [...syms, occ('TSLA', day, 'C', 960, true), occ('tsla', day, 'P', 100).toLowerCase(), 'TSLA270115X00960000', 'A0261218C00010000', '', null, 123, 'TSLA2701C00960000', occ('ABCDEFGHI', day, 'C', 1)];
    for (const s of mine) assert.deepStrictEqual(myOptParseOcc(s), o.callNormalized('myOpt_parseOcc', s), String(s));
    assert.equal(cboeUrl('_SPX'), o.call('buildUrl', '_SPX'));
    assert.equal(cboeUrl('TSLA'), o.call('myOpt_buildUrl', 'TSLA'));
  });

  test('fetchCboeRawV1_ / fetchCboeChain / fetchChain: index fallback, failures, the per-run memo', async () => {
    const good = chainJson(1, spec(), [{ bid: 1 }, { option: occ('TSLA', Date.UTC(2027, 0, 15), 'C', 500) }]);
    const cases: Array<[string, string, RecordedExchange[]]> = [
      ['ok', 'TSLA', [recordedGet(cboeUrlOf('TSLA'), 200, good)]],
      ['index fallback', 'SPX', [recordedGet(cboeUrlOf('SPX'), 404, 'nf'), recordedGet(cboeUrlOf('_SPX'), 200, good)]],
      ['both fail', 'ZZZZ', [recordedGet(cboeUrlOf('ZZZZ'), 403, ''), recordedGet(cboeUrlOf('_ZZZZ'), 500, '')]],
      ['bad JSON, then a network error', 'BAD', [recordedGet(cboeUrlOf('BAD'), 200, '<html>')]],
      ['no options', 'NOOPT', [recordedGet(cboeUrlOf('NOOPT'), 200, '{"data":{"current_price":5}}')]],
      ['empty chain', 'EMPTY', [recordedGet(cboeUrlOf('EMPTY'), 200, '{"data":{"options":[]}}')]],
      ['lower-case ticker', 'tsla', [recordedGet(cboeUrlOf('tsla'), 200, good)]],
    ];
    for (const [label, t, ex] of cases) {
      const L = legacy(freshEnv(), ex, NOW, (o, log) => [o.call('fetchCboeRawV1_', t, log), o.call('fetchCboeRawV1_', t.toUpperCase(), log), o.call('fetchCboeChain', t, log), o.call('fetchChain', 730, t, log)]);
      const P = portDeps(freshEnv(), ex, NOW);
      const port = [await fetchCboeRaw(P.deps, t, P.log), await fetchCboeRaw(P.deps, t.toUpperCase(), P.log), await fetchCboeChain(P.deps, t, P.log), await fetchChain(P.deps, 730, t, P.log)];
      assert.deepStrictEqual(port, L.value, label);
      assert.deepStrictEqual(P.logs, L.logs, label + ' (log)');
      assert.deepStrictEqual(P.transport.trace, L.trace, label + ' (requests: one fetch per run)');
    }
  });

  test('myOpt_fetchCurrentPrice: the matching contract\'s mid, the fallbacks, the trace log', async () => {
    const day = Date.UTC(2027, 0, 15);
    const opt = (cp: 'C' | 'P', k: number, f: Record<string, unknown>) => ({ option: occ('NVDA', day, cp, k), ...f });
    const body = JSON.stringify({ data: { options: [
      { bid: 1 }, null, opt('C', 150, { bid: 10, ask: 11 }), opt('P', 150, { bid: 0, ask: 3, last_trade_price: 2.5 }), opt('C', 160, { bid: 0, ask: 0, close: 4.25 }),
      opt('C', 170, { bid: 0, ask: 0 }), { option: 'garbage' }, opt('C', 150.0005, { bid: 1, ask: 2 }),
    ] } });
    const D = { year: 2027, month: 1, day: 15 };
    const cases: Array<[string, RecordedExchange[], number, typeof D, string]> = [
      ['bid/ask mid', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 150, D, 'call'],
      ['last trade', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 150, D, 'put'],
      ['close', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 160, D, 'call'],
      ['no price at all', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 170, D, 'call'],
      ['no such contract', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 155, D, 'call'],
      ['other date', [recordedGet(cboeUrlOf('NVDA'), 200, body)], 150, { year: 2027, month: 1, day: 16 }, 'call'],
      ['empty first, index second', [recordedGet(cboeUrlOf('NVDA'), 200, '{"data":{"options":[]}}'), recordedGet(cboeUrlOf('_NVDA'), 200, body)], 150, D, 'call'],
      ['empty first, index fails', [recordedGet(cboeUrlOf('NVDA'), 200, '{"data":{"options":[]}}'), recordedGet(cboeUrlOf('_NVDA'), 404, 'x'.repeat(300))], 150, D, 'call'],
      ['both fail, one unrecorded', [recordedGet(cboeUrlOf('NVDA'), 500, '')], 150, D, 'call'],
      ['bad JSON', [recordedGet(cboeUrlOf('NVDA'), 200, '{oops'), recordedGet(cboeUrlOf('_NVDA'), 200, '{}')], 150, D, 'call'],
    ];
    for (const [label, ex, k, d, side] of cases) {
      const L = legacy(freshEnv(), ex, NOW, (o) => o.call('myOpt_fetchCurrentPrice', 'NVDA', k, d, side));
      const P = portDeps(freshEnv(), ex, NOW);
      assert.deepStrictEqual(await myOptFetchCurrentPrice(P.deps, 'NVDA', k, d, side), L.value, label);
      assert.deepStrictEqual(P.logs, L.logs, label + ' (log)');
      assert.deepStrictEqual(P.transport.trace, L.trace, label + ' (requests)');
    }
  });
});

describe('FL-6a — the conviction engine', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const scenarios: Array<[string, ChainSpec, number]> = [
    ['mega-cap', spec(), 1], ['small-cap ($ floor halves to $1M)', spec({ root: 'SNDL', spot: 5, maxOi: 3000 }), 2],
    ['market closed', spec({ closed: true }), 3], ['thin', spec({ root: 'TINY', spot: 3, maxOi: 40, days: [20, 400], strikeMults: [1, 1.2] }), 4],
    ['near only', spec({ days: [3, 10, 45] }), 5], ['puts only', spec({ putsOnly: true }), 6],
  ];

  test('parseAndScore via fetchChain, run over run (LEAPS OI persistence), in two zones -- F-62 shown', async () => {
    const seen = { floorBelow100M: 0, closed: 0, firstRun: 0, persisted: new Set<number>(), leaps2: 0 };
    for (const tz of [TZ, 'Asia/Jerusalem']) {
      await inZone(tz, async () => {
        for (const [label, s, seed] of scenarios) {
          const env = freshEnv();
          const runs: Array<[number, (i: number) => number]> = [[NOW, () => 1], [NOW + 86400000, (i) => [1.25, 1.05, 1, 0.95, 0.8, 0][i % 6]], [NOW + 32 * 86400000, () => 1]];
          for (const [at, scale] of runs) {
            const ex = [recordedGet(cboeUrlOf(s.root), 200, chainJson(seed, { ...s, nowMs: NOW, oiScale: scale }))];
            const L = legacy(env, ex, at, (o, log) => { const ch = o.call('fetchChain', 730, s.root, log); return unpack(o.call('parseAndScore', ch, log, s.root)); });
            const P = portDeps(env, ex, at, tz);
            const port = await parseAndScore(P.deps, await fetchChain(P.deps, 730, s.root, P.log), P.log, s.root);
            assert.deepStrictEqual(unpack(port), L.value, tz + ' ' + label + ' ' + new Date(at).toISOString());
            assert.deepStrictEqual(P.logs, L.logs, label + ' (log)');
            assert.deepStrictEqual([...env.kv.map].sort(), [...env.props.map].sort(), label + ' (OI history)');
            if ((port.dollarFloor ?? 1e9) < 100e6) seen.floorBelow100M++;
            if (port.length && port.every((c) => c.urgencyScore === 0 && c.holdingScore === 0)) seen.closed++;
            for (const c of port) {
              if (c.oiPersistenceIsFirstRun === true) seen.firstRun++;
              if (c.oiPersistenceIsFirstRun === false) seen.persisted.add(c.oiPersistenceScore as number);
              if (c.bucket === 'LEAPS ~2yr') seen.leaps2++;
            }
          }
        }
      });
    }
    assert.ok(seen.floorBelow100M && seen.closed && seen.firstRun && seen.leaps2, JSON.stringify({ ...seen, persisted: [...seen.persisted] }));
    assert.deepStrictEqual([...seen.persisted].sort((a, b) => a - b), [0, 25, 50, 75, 100]);
    // F-62: a 2027-01-15 expiry (00:00 UTC) is labelled the day before in New York.
    const ch: ChainColumns = { strike: [100], side: ['call'], openInterest: [1e6], volume: [1], iv: [0.5], expiration: [Date.UTC(2027, 0, 15) / 1000] };
    const env = freshEnv();
    const ny = await parseAndScore(portDeps(env, [], NOW, TZ).deps, ch, null, 'X');
    assert.equal(ny[0].expiryStr, 'Jan 14, 2027');
    // F-62 fixed (default): the real expiry day in every zone, under its own OI-history key.
    for (const zone of [TZ, 'Asia/Jerusalem', 'Pacific/Honolulu']) {
      const env2 = freshEnv();
      const fixed = await parseAndScore({ ...portDeps(env2, [], NOW, zone).deps, legacyExpiryLabel: false }, ch, null, 'X');
      assert.equal(fixed[0].expiryStr, 'Jan 15, 2027', zone);
    }
    await inZone(TZ, () => assert.equal((legacy(freshEnv(), [], NOW, (o) => unpack(o.call('parseAndScore', ch, null, 'X'))).value as { list: ScoredContract[] }).list[0].expiryStr, 'Jan 14, 2027'));
  });

  test('parseAndScore on alternate column names, odd sides and malformed chains', async () => {
    await inZone(TZ, async () => {
      const r = rng(31);
      const n = 60;
      const exp = Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 0 : Math.floor(NOW / 1000) + Math.floor(r() * 900) * 86400));
      const alt = {
        strike: Array.from({ length: n }, (_, i) => (i === 3 ? 'abc' : i === 4 ? -5 : 50 + Math.floor(r() * 100))),
        optionType: Array.from({ length: n }, (_, i) => ['C', 'P', 'call', 'put', 'X', ''][i % 6]),
        openinterest: Array.from({ length: n }, () => Math.floor(r() * 200000)), vol: Array.from({ length: n }, () => (r() < 0.5 ? 0 : Math.floor(r() * 5000))),
        impliedVolatility: Array.from({ length: n }, () => r()), expirationDate: exp,
      };
      const inputs: unknown[] = [alt, { ...alt, expirationDate: undefined }, { strike: [100, 200] }, null, undefined, { strike: 'x' }, { strike: [] }, { strike: [10], side: ['call'], openInterest: [0] }];
      for (const [i, input] of inputs.entries()) {
        const env = freshEnv();
        const L = legacy(env, [], NOW, (o, log) => unpack(o.call('parseAndScore', input, log, null)));
        const P = portDeps(env, [], NOW);
        assert.deepStrictEqual(unpack(await parseAndScore(P.deps, input as ChainColumns, P.log, null)), L.value, 'input ' + i);
        assert.deepStrictEqual(P.logs, L.logs);
        assert.deepStrictEqual([...env.kv.map], [...env.props.map]);
      }
      // computeOiPersistence directly, with a corrupt history entry.
      const env = freshEnv();
      env.props.map.set('OI_HIST_ZED', '{bad');
      env.kv.map.set('OI_HIST_ZED', '{bad');
      const lc = [{ side: 'call', strike: 10, oi: 5, expiryStr: 'Jan 1, 2028' }];
      assert.deepStrictEqual(await computeOiPersistence(portDeps(env, [], NOW).deps, 'zed', lc as never), legacy(env, [], NOW, (o) => o.call('computeOiPersistence', 'zed', lc)).value);
      assert.deepStrictEqual([...env.kv.map], [...env.props.map]);
    });
  });

  test('computeChainContext / interpretSignal / scoreColor / isLeaps on every branch', async () => {
    const o = loadOracle();
    await inZone(TZ, async () => {
      const chains: unknown[] = ['not an array', null, []];
      for (const [, s, seed] of scenarios) {
        const P = portDeps(freshEnv(), [recordedGet(cboeUrlOf(s.root), 200, chainJson(seed, s))], NOW);
        const scored = await parseAndScore(P.deps, await fetchChain(P.deps, 730, s.root), null, s.root);
        chains.push(scored.fullChain ?? [], scored);
        for (const c of scored) assert.equal(interpretSignal(c), o.call('interpretSignal', c));
      }
      const mk = (side: string, days: number, iv: number, oi: number, strike = 100) => ({ side, daysToExpiry: days, iv, oi, vol: oi / 10, strike });
      chains.push(
        [mk('call', 30, 0.9, 10), mk('call', 400, 0.5, 10), mk('put', 400, 0.5, 1)], [mk('call', 30, 0.5, 10), mk('put', 400, 0.9, 30)],
        [mk('call', 30, 0.5, 10), mk('put', 400, 0.51, 10)], [mk('put', 30, 0, 10)], [mk('call', 30, 0.4, 0)], [mk('call', 30, 0.4, 10, 0)],
      );
      for (const c of chains) assert.deepStrictEqual(computeChainContext(c), o.callNormalized('computeChainContext', c));
      for (const side of ['call', 'put']) for (const days of [30, 200, 400]) for (const dollarScore of [70, 45, 10]) for (const holdingScore of [80, 10]) for (const urgencyScore of [80, 10]) for (const ivScore of [70, 10]) {
        const c = { side, daysToExpiry: days, dollarScore, holdingScore, urgencyScore, ivScore } as never;
        assert.equal(interpretSignal(c), o.call('interpretSignal', c));
      }
    });
    for (let v = -10; v <= 110; v += 0.5) assert.equal(scoreColor(v), o.call('scoreColor', v));
    for (const b of ['Near (0–3m)', 'Mid (3–12m)', 'LEAPS ~1yr', 'LEAPS ~2yr', 'LEAPS', null]) assert.equal(isLeaps(b), o.call('isLeaps', b));
  });

  test('selectRecommendedCallV7: the expiry rule, the delta pick, the ranked candidates, the warnings', async () => {
    await inZone(TZ, async () => {
      const cases: Array<[string, string]> = [
        ['mega', chainJson(1, spec())], ['no delta field', chainJson(2, spec({ noDelta: true }))], ['puts only', chainJson(3, spec({ putsOnly: true }))],
        ['short expiries only', chainJson(4, spec({ days: [3, 10, 20] }))], ['long expiries only', chainJson(5, spec({ days: [400, 900] }))],
        ['no options', '{"data":{}}'], ['empty', '{"data":{"options":[{"bid":1}]}}'],
      ];
      for (const [label, body] of cases) {
        for (const [d, leaps] of [[0.75, true], [0.5, false], [0.3, true], [0.95, false]] as Array<[number, boolean]>) {
          for (const at of [NOW, NOW + 150 * 86400000]) {
            const ex = [recordedGet(cboeUrlOf('TSLA'), 200, body)];
            const L = legacy(freshEnv(), ex, at, (o, log) => o.call('selectRecommendedCallV7', 'TSLA', d, leaps, log));
            const P = portDeps(freshEnv(), ex, at);
            assert.deepStrictEqual(await selectRecommendedCall(P.deps, 'TSLA', d, leaps, P.log), L.value, label + ' ' + d + ' ' + leaps);
            assert.deepStrictEqual(P.logs, L.logs);
          }
        }
      }
      const none = legacy(freshEnv(), [], NOW, (o) => o.call('selectRecommendedCallV7', 'NONE', 0.5, false, null));
      assert.deepStrictEqual(await selectRecommendedCall(portDeps(freshEnv(), [], NOW).deps, 'NONE', 0.5, false, null), none.value);
    });
  });

  test('the OPTIONS_OVERLAY write is byte-identical to legacy\'s (runFullAnalysis :346-376, compiled verbatim)', async () => {
    const lines = fs.readFileSync(new URL('../legacy/futuresStockAnalysisV3_3_11.gs', import.meta.url), 'utf8').split('\n').slice(345, 376);
    assert.match(lines[0], /^  try \{$/);
    assert.match(lines[lines.length - 1], /Overlay save skipped/);
    const o = loadOracle();
    const block = new (o.fns.parseOcc.constructor as FunctionConstructor)('ticker', 'contracts', 'chainContext', 'log', lines.join('\n')) as (...a: unknown[]) => void;
    await inZone(TZ, async () => {
      const P0 = portDeps(freshEnv(), [recordedGet(cboeUrlOf('TSLA'), 200, chainJson(1, spec()))], NOW);
      const scored = await parseAndScore(P0.deps, await fetchChain(P0.deps, 730, 'TSLA'), null, 'TSLA');
      const ctx = computeChainContext(scored.fullChain);
      const cases: Array<[string, ScoredContract[], unknown]> = [
        ['full', scored, ctx], ['no ~2yr', scored.filter((c) => c.bucket !== 'LEAPS ~2yr'), ctx], ['nothing', [], ctx], ['no chain context', scored, null],
      ];
      for (const [label, contracts, cc] of cases) {
        const env = freshEnv();
        const L = legacy(env, [], NOW, (_o, log) => block('TSLA', contracts, cc, log));
        const P = portDeps(env, [], NOW);
        await saveOptionsOverlay(P.deps, 'TSLA', contracts, cc as never, P.log);
        assert.deepStrictEqual(P.logs, L.logs, label);
        assert.equal(env.kv.map.get(OPTIONS_OVERLAY_KEY), env.props.map.get(OPTIONS_OVERLAY_KEY), label);
      }
    });
  });
});

describe('FL-6a — analyzeOptionsForScoringV7', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every signal, horizon and confirm/conflict branch matches legacy', async () => {
    const o = loadOracle();
    const COLS = ['side', 'strike', 'expiryStr', 'daysToExpiry', 'oi', 'vol', 'iv', 'dollarsCommitted', 'dollarScore', 'holdingScore', 'urgencyScore', 'timeScore', 'ivScore', 'oiPersistenceScore', 'conviction', 'bucket'];
    const snaps: unknown[] = [null, undefined, { mismatch: true, ticker: 'X' }, { contracts: [] }];
    await inZone(TZ, async () => {
      for (const [seed, s] of [[1, spec()], [2, spec({ putsOnly: true })], [3, spec({ days: [3, 10, 45] })], [4, spec({ closed: true })]] as Array<[number, ChainSpec]>) {
        const P = portDeps(freshEnv(), [recordedGet(cboeUrlOf(s.root), 200, chainJson(seed, s))], NOW);
        const scored = await parseAndScore(P.deps, await fetchChain(P.deps, 730, s.root), null, s.root);
        const rows = scored.map((c) => Object.fromEntries(COLS.map((k) => [k, (c as unknown as Record<string, unknown>)[k] ?? ''])));
        const ctx = computeChainContext(scored.fullChain);
        snaps.push({ contracts: rows, context: ctx }, { contracts: rows }, { contracts: rows, context: { ...ctx, putCallRatioOI: 0.5, netBiasPct: 60 } },
          { contracts: rows, context: { ...ctx, putCallRatioOI: 1.6, netBiasPct: -60, ivRankPct: 85 } }, { contracts: rows, context: { putCallRatioOI: 0.7, ivRankPct: 10 } },
          { contracts: rows, context: { putCallRatioOI: 1.0 } }, { contracts: rows, context: { putCallRatioOI: 1.3 } },
          { contracts: rows.map((x, i) => ({ ...x, conviction: i % 3 ? x.conviction : null, dollarsCommitted: i % 5 ? x.dollarsCommitted : 0 })), context: ctx });
      }
    });
    const plans: unknown[] = [null, undefined, { techScore: 60, timeToEntry: { baseDays: 10 } }, { techScore: 40, t1Time: { baseDays: 50 } }, { techScore: 50 },
      { techScore: 70, timeToEntry: { baseDays: null }, t1Time: { baseDays: 200 } }, { techScore: null }, { techScore: 30, timeToEntry: { baseDays: 0 } }];
    const confirms = new Set<string>();
    for (const snap of snaps) for (const plan of plans) {
      const port = analyzeOptionsForScoring(snap as never, plan as never);
      assert.deepStrictEqual(port, o.callNormalized('analyzeOptionsForScoringV7', snap, plan));
      confirms.add(port.confirm);
    }
    assert.deepStrictEqual([...confirms].sort(), ['confirm', 'conflict', 'neutral']);
  });
});

describe('FL-6a — helpers', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('fmtDate / addDays (across DST, every zone) / elapsed', async () => {
    const o = loadOracle();
    for (const tz of ['America/New_York', 'Asia/Jerusalem', 'Australia/Lord_Howe', 'America/Santiago', 'UTC']) {
      await inZone(tz, () => {
        for (let k = 0; k < 300; k++) {
          const d = new Date(Date.parse('2026-01-01T00:00:00Z') + k * 29.3 * 3600_000 + (k % 13) * 1234);
          const n = [-400, -30, -7, -1, 0, 1, 7, 30, 180, 400][k % 10];
          assert.equal(addDays(d, n, tz).getTime(), (o.call('addDays', d, n) as Date).getTime(), tz + ' ' + d.toISOString() + ' ' + n);
          assert.equal(fmtDate(d), o.call('fmtDate', d));
        }
      });
    }
    const L = legacy(freshEnv(), [], NOW + 3456, (oo) => oo.call('elapsed', NOW));
    assert.equal(elapsed(NOW, NOW + 3456), L.value);
    void chainOptions;
  });
});
