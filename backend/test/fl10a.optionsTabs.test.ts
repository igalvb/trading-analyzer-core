/**
 * FL-10a: direct legacy-vs-port tests for the options tab builders in
 * futuresStockAnalysisV3_3_11.gs that were only covered through
 * runFullAnalysis: buildTop10, writeConvictionTable, writeBucketMiniTable,
 * buildBucketBreakdown, buildDashboard, buildCallTable, buildPutTable,
 * buildGammaWall, saveOptionsSnapshotV7, getOrCreate, hdr, altRows.
 *
 * Pattern copied from fl6b.reports.test.ts: twin ReportWorkbooks on the
 * in-memory backend, legacy run in the oracle against one, the port against
 * the other, and the complete recorded call log of every tab plus the final
 * cells compared. Dates are pinned and the zone fixed.
 *
 * Known deliberate deviation (F-73): the Top 10 tab is blue in the port; the
 * legacy red tab-colour call is mapped to the new colour before comparing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent, type Oracle } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import {
  buildTop10, writeConvictionTable, writeBucketMiniTable, buildBucketBreakdown, buildDashboard, buildCallTable,
  buildPutTable, buildGammaWall, saveOptionsSnapshot, getOrCreate, hdr, altRows,
  OptionsTabs, OPTIONS_SNAPSHOT_SHEET, TOP10_TAB_COLOR, LEGACY_TOP10_TAB_COLOR,
} from '../src/reports/options/tabs.ts';
import type { ChainContext, RecommendedCall, ScoredContracts } from '../src/analysis/options/conviction.ts';

const ready = legacyFilesPresent();
const skip = ready ? false : 'legacy/ not populated';
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T15:00:00Z');
const T = { nowMs: NOW, timeZone: TZ, legacyText: true }; // oracle comparisons: legacy's tab text
const EXP = Date.UTC(2027, 0, 15) / 1000;

function inZoneSync<T2>(fn: () => T2): T2 {
  const saved = process.env.TZ;
  process.env.TZ = TZ;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

function legacy<T2>(fn: (o: Oracle) => T2): T2 {
  return inZoneSync(() => withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => fn(loadOracle())));
}

async function twin(initial: Record<string, unknown[][]> = {}): Promise<{ L: ReportWorkbook; P: ReportWorkbook }> {
  const mk = (): Promise<ReportWorkbook> => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
  return { L: await mk(), P: await mk() };
}

function sameBooks(L: ReportWorkbook, P: ReportWorkbook, where: string): void {
  const names = (b: ReportWorkbook): string[] => b.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names(P), names(L), where + ' (tabs)');
  for (const sh of L.getSheets()) {
    const ps = P.getSheetByName(sh.getName())!;
    const expected = sh.getName() === OptionsTabs.TOP10
      ? sh.calls.map((c) => (c[0] === 'setTabColor' && c[1] === LEGACY_TOP10_TAB_COLOR ? ['setTabColor', TOP10_TAB_COLOR] : c))
      : sh.calls;
    assert.deepStrictEqual(ps.calls, expected, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.calls, L.calls, where + ' (workbook calls)');
}

function rngOf(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUCKETS = [['Near (0–3m)', 30], ['Mid (3–12m)', 200], ['LEAPS ~1yr', 500], ['LEAPS ~2yr', 800]] as const;
const SCORES = [0, 19, 20, 39, 40, 59, 60, 64, 65, 69, 70, 79, 80, 100];

interface MkOpts { closed?: boolean; floor?: number; onlySide?: 'call' | 'put' }

/** Deterministic scored contracts, sorted by conviction like parseAndScore. Call twice for two independent copies. */
function mk(seed: number, n: number, o: MkOpts = {}): ScoredContracts {
  const r = rngOf(seed);
  const pick = <V,>(a: readonly V[]): V => a[Math.floor(r() * a.length)] as V;
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const [bucket, days] = pick(BUCKETS);
    const oi = r() < 0.1 ? 0 : Math.floor(r() * 60000);
    const dollars = i === 0 ? 1e9 : i === 1 ? 999.6e6 : Math.round(10 ** (6 + r() * 3.9));
    out.push({
      side: o.onlySide ?? (r() < 0.5 ? 'call' : 'put'),
      strike: 100 + Math.floor(r() * 24) * 2.5,
      vol: o.closed ? 0 : Math.floor(oi * r() * 0.8),
      oi,
      iv: r() < 0.1 ? 0 : Math.round(r() * 100) / 100,
      dollarsCommitted: dollars,
      holdingRaw: r() * 100,
      urgencyRaw: r() * 10,
      daysToExpiry: days + Math.floor(r() * 20),
      expiryStr: 'Jan ' + (1 + Math.floor(r() * 28)) + ' 2027',
      bucket,
      expiry: null,
      ivPremium: r(),
      dollarScore: pick(SCORES),
      holdingScore: pick(SCORES),
      urgencyScore: pick(SCORES),
      timeScore: pick(SCORES),
      ivScore: pick(SCORES),
      oiPersistenceScore: r() < 0.1 ? null : pick(SCORES),
      oiPersistenceIsFirstRun: r() < 0.5 ? true : r() < 0.5 ? false : null,
      conviction: pick(SCORES),
    });
  }
  out.sort((a, b) => (b['conviction'] as number) - (a['conviction'] as number));
  const arr = out as unknown as ScoredContracts;
  if (o.floor !== undefined) arr.dollarFloor = o.floor;
  return arr;
}

const SCENARIOS: Array<[string, () => ScoredContracts]> = [
  ['full', () => mk(1, 60)],
  ['market closed', () => mk(2, 30, { closed: true })],
  ['empty', () => mk(3, 0)],
  ['calls only', () => mk(4, 12, { onlySide: 'call' })],
  ['puts only', () => mk(5, 12, { onlySide: 'put' })],
  ['single', () => mk(6, 1)],
  ['small floor', () => mk(7, 25, { floor: 50e6 })],
  ['big floor', () => mk(8, 25, { floor: 2e9 })],
  ['zero floor', () => mk(9, 25, { floor: 0 })],
];

const cand = (strike: number, delta: number, dd: number, iv = 0.45) => ({
  strike, expUnix: EXP, symbol: 'X', delta, theta: -0.1, gamma: 0.01, bid: 5.5, ask: 5.75, iv, deltaDistance: dd,
});
const foundCall = (n: number, iv = 0.45): RecommendedCall => ({
  found: true, contract: cand(400, 0.74, 0.01, iv), expUnix: EXP, deltaFieldSeen: true,
  allCandidates: [cand(400, 0.74, 0.01, iv), ...Array.from({ length: n - 1 }, (_, i) => cand(405 + i * 5, 0.7 - i * 0.03, 0.05 + i * 0.03, iv))],
});
const notFound: RecommendedCall = { found: false, reason: 'no expiry far enough out' };

const CTX_FULL: ChainContext = {
  putCallRatioOI: 0.85, putCallRatioVol: 1.2, frontIV: 0.55, backIV: 0.4, ivRankPct: 72, termNote: 'Backwardation', netBiasPct: -12, netBiasNote: 'Bearish (net -12%)',
};
const CTX_NULL: ChainContext = {
  putCallRatioOI: null, putCallRatioVol: null, frontIV: null, backIV: null, ivRankPct: null, termNote: 'n/a', netBiasPct: null, netBiasNote: 'n/a',
};
const CTX_ZERO: ChainContext = { ...CTX_FULL, ivRankPct: 0, putCallRatioOI: 0, frontIV: 0 };

describe('FL-10a options tabs: sheet helpers', { skip }, () => {
  test('getOrCreate, hdr and altRows match the oracle', async () => {
    const { L, P } = await twin({ Existing: [['keep']] });
    const lh = legacy((o) => {
      const a = o.call<{ getName(): string }>('getOrCreate', L, 'Existing');
      const b = o.call<{ getName(): string }>('getOrCreate', L, 'Brand New');
      return [a.getName(), b.getName()];
    });
    assert.deepStrictEqual([getOrCreate(P, 'Existing').getName(), getOrCreate(P, 'Brand New').getName()], lh);
    const sL = L.getSheetByName('Brand New')!;
    const sP = P.getSheetByName('Brand New')!;
    for (const [row, text, bg, size, cols] of [[1, 'Title', '#112233', 13, 6], [3, 'No size', '#445566', 0, 4], [5, '', '#ffffff', 11, 1]] as const) {
      legacy((o) => o.call('hdr', sL, row, text, bg, size, cols));
      hdr(sP, row, text, bg, size, cols);
    }
    for (const [start, rows, cols] of [[10, 0, 3], [12, 1, 3], [15, 5, 4]] as const) {
      legacy((o) => o.call('altRows', sL, start, rows, cols, '#aaaaaa', '#bbbbbb'));
      altRows(sP, start, rows, cols, '#aaaaaa', '#bbbbbb');
    }
    sameBooks(L, P, 'helpers');
  });
});

describe('FL-10a options tabs: conviction and bucket tables', { skip }, () => {
  test('writeConvictionTable matches the oracle for every scenario, open and closed market', async () => {
    for (const [label, make] of SCENARIOS) {
      for (const closed of [false, true]) {
        const { L, P } = await twin();
        const sL = L.insertSheet('T');
        const sP = P.insertSheet('T');
        const rowsL = make().slice(0, 10);
        const rowsP = make().slice(0, 10);
        const floor = make().dollarFloor || 100e6;
        legacy((o) => o.call('writeConvictionTable', sL, rowsL, 5, closed, '#e8f5e9', '#f1f8e9', '#43a047', floor));
        writeConvictionTable(sP, rowsP, 5, closed, '#e8f5e9', '#f1f8e9', '#43a047', floor);
        sameBooks(L, P, `${label} closed=${closed}`);
      }
    }
  });

  test('writeBucketMiniTable matches the oracle, including the returned row count and empty messages', async () => {
    for (const [label, make] of SCENARIOS) {
      for (const persist of [false, true]) {
        for (const emptyMsg of [undefined, 'No contracts here']) {
          const { L, P } = await twin();
          const sL = L.insertSheet('T');
          const sP = P.insertSheet('T');
          const a = legacy((o) => o.call<number>('writeBucketMiniTable', sL, make().slice(0, 5), 3, '#', '#00695c', persist, emptyMsg));
          const b = writeBucketMiniTable(sP, make().slice(0, 5), 3, '#', '#00695c', persist, emptyMsg);
          assert.equal(b, a, `${label} persist=${persist} (rows written)`);
          sameBooks(L, P, `${label} persist=${persist} msg=${String(emptyMsg)}`);
        }
      }
    }
  });

  test('buildBucketBreakdown matches the oracle for every scenario and chain context', async () => {
    for (const [label, make] of SCENARIOS) {
      for (const [cl, ctx] of [['full', CTX_FULL], ['nulls', CTX_NULL], ['zeros', CTX_ZERO]] as const) {
        const { L, P } = await twin({ [OptionsTabs.BUCKETS]: [['stale']] });
        legacy((o) => o.call('buildBucketBreakdown', L, make(), 'TSLA', ctx));
        buildBucketBreakdown(P, make(), 'TSLA', ctx, T);
        sameBooks(L, P, `${label} ctx=${cl}`);
      }
    }
  });
});

describe('FL-10a options tabs: top 10, dashboard, call/put tables', { skip }, () => {
  test('buildTop10 matches the oracle across scenarios, recommended calls and earnings', async () => {
    const recs: Array<[string, () => RecommendedCall | null, () => RecommendedCall | null]> = [
      ['both found', () => foundCall(8), () => foundCall(2)],
      ['one candidate, no iv', () => foundCall(1, 0), () => foundCall(6)],
      ['none found', () => notFound, () => null],
      ['null and null', () => null, () => null],
    ];
    const earnings = [null, { dateStr: '2026-12-01' }, { dateStr: '2028-01-01' }];
    for (const [label, make] of SCENARIOS) {
      for (const [rl, leaps, short] of recs) {
        for (const e of earnings) {
          const { L, P } = await twin({ [OptionsTabs.TOP10]: [['stale', 'content']] });
          legacy((o) => o.call('buildTop10', L, make(), 'TSLA', leaps(), short(), e));
          buildTop10(P, make(), 'TSLA', leaps(), short(), e, T);
          sameBooks(L, P, `${label} / ${rl} / earnings ${JSON.stringify(e)}`);
        }
      }
    }
  });

  test('buildDashboard matches the oracle for every scenario', async () => {
    for (const [label, make] of SCENARIOS) {
      const { L, P } = await twin({ [OptionsTabs.DASHBOARD]: [['stale']] });
      legacy((o) => o.call('buildDashboard', L, make(), 'TSLA'));
      buildDashboard(P, make(), 'TSLA', T);
      sameBooks(L, P, label);
    }
  });

  test('buildCallTable and buildPutTable match the oracle for every scenario', async () => {
    for (const [label, make] of SCENARIOS) {
      const { L, P } = await twin({ [OptionsTabs.CALLS]: [['stale']] });
      legacy((o) => { o.call('buildCallTable', L, make(), 'TSLA'); o.call('buildPutTable', L, make(), 'TSLA'); });
      buildCallTable(P, make(), 'TSLA');
      buildPutTable(P, make(), 'TSLA');
      sameBooks(L, P, label);
    }
  });
});

describe('FL-10a options tabs: gamma wall and snapshot', { skip }, () => {
  test('buildGammaWall matches the oracle for arrays of every size and for non-array input', async () => {
    const inputs: Array<[string, () => unknown]> = [
      ...SCENARIOS.map(([l, m]) => [l, m] as [string, () => unknown]),
      ['3 strikes', () => mk(21, 3)],
      ['4 strikes', () => mk(22, 4)],
      ['null', () => null],
      ['undefined', () => undefined],
      ['string', () => 'x'],
      ['plain object', () => ({ side: 'call', strike: 100, oi: 5, vol: 1 })],
      ['zero call OI', () => [{ side: 'put', strike: 100, oi: 50, vol: 3 }, { side: 'call', strike: 105, oi: 0, vol: 0 }]],
    ];
    for (const [label, make] of inputs) {
      const { L, P } = await twin();
      legacy((o) => o.call('buildGammaWall', L, make(), 'TSLA'));
      buildGammaWall(P, make(), 'TSLA');
      sameBooks(L, P, label);
    }
  });

  test('saveOptionsSnapshot matches saveOptionsSnapshotV7: return value, meta JSON, rows, hidden tab', async () => {
    const underlyings: unknown[] = [400, 0, null, undefined, NaN, Infinity, '12.5', -3];
    const tickers: unknown[] = ['tsla', 'TSLA', '', null, undefined];
    for (const [label, make] of SCENARIOS) {
      for (const [cl, ctx] of [['ctx', CTX_FULL], ['no ctx', null]] as const) {
        for (const u of underlyings) {
          const { L, P } = await twin({ [OPTIONS_SNAPSHOT_SHEET]: [['old', 'data'], ['more', 'rows']] });
          const t = tickers[Math.floor(Math.abs(Number(u) || 0)) % tickers.length];
          const a = legacy((o) => o.call<number>('saveOptionsSnapshotV7', L, t, make(), ctx, u));
          const b = saveOptionsSnapshot(P, t as string, make(), ctx, u as number, T);
          assert.equal(b, a, `${label} ${cl} underlying=${String(u)} (count)`);
          sameBooks(L, P, `${label} ${cl} underlying=${String(u)} ticker=${String(t)}`);
        }
      }
    }
  });

  test('saveOptionsSnapshot writes blanks for missing contract fields exactly like legacy', async () => {
    const sparse = (): ScoredContracts => [{ side: 'call', strike: 100, oi: 5 }, { side: 'put', strike: undefined, iv: null, bucket: 'Near (0–3m)' }] as unknown as ScoredContracts;
    const { L, P } = await twin();
    const a = legacy((o) => o.call<number>('saveOptionsSnapshotV7', L, 'abc', sparse(), null, 10));
    const b = saveOptionsSnapshot(P, 'abc', sparse(), null, 10, T);
    assert.equal(b, a);
    sameBooks(L, P, 'sparse');
  });
});
