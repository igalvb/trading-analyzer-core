/**
 * FL-18b: Sheets cleanup phase 4b (docs/SHEETS_CLEANUP_PLAN.md). `audit-script-properties` lists the
 * '💾 Script Properties' keys (read-only, never creates the tab) and deletes only expired or unused keys,
 * only with --yes, touching no other tab. The nightly fetches FRED's GDPC1 once instead of twice, with
 * the same values.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { sheets_v4 } from 'googleapis';
import { classifyProperty, auditPropertyRows, runScriptPropertiesAudit, type AuditSheets } from '../src/scriptPropertiesAudit.ts';
import { MemoryPropertyStore, cacheGet } from '../src/storage/kv.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { HttpClient, HttpResponse, type HttpRequest } from '../src/net/http.ts';
import { FRED_CSV_URL } from '../src/fetch/macro/fred.ts';
import {
  computeMacroSupplemental, refreshMacroRegimeCache, refreshMacroSnapshot, MACRO_SUPPLEMENTAL_KEY, type MacroDeps,
} from '../src/fetch/macro/refresh.ts';
import { MACRO_SNAPSHOT_HEADER } from '../src/storage/macroCaches.ts';
import { Tabs } from '../src/sheets/tabs.ts';
import type { ValueRangeUpdate } from '../src/sheets/client.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 9, 29, 12);
const H = 3_600_000;
const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, clock: { now: () => NOW } });
const cached = (data: unknown, savedAt: number, ttl: number | null) => JSON.stringify({ _savedAt: savedAt, _ttlHours: ttl, data });

/** key -> [value, expected status]. */
const KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['macroSupplementalV1', cached({ m2: 1 }, NOW - 2 * H, 30), 'live'],
  ['dowTheoryConfirmationV1', cached({ v: 'x' }, NOW - 31 * H, 30), 'expired'],
  ['evaluativeIndexV1', cached({}, NOW - 1 * H, 30), 'live'],
  ['relativeStrengthRankingV1', cached({ TSLA: {} }, NOW - 1 * H, 30), 'unused'],
  ['darkPoolFinraWeek_T1', cached('2026-10-19', NOW - 40 * H, 30), 'expired'],
  ['CIK_TSLA', cached('0001318605', NOW - 10 * 24 * H, 24 * 90), 'live'],
  ['CIK_OLDCO', cached('0000000001', NOW - 100 * 24 * H, 24 * 90), 'expired'],
  ['CUSIP_OLDCO', cached('123456789', NOW - 91 * 24 * H, 24 * 90), 'expired'],
  ['OI_HIST_V2_TSLA', cached({ contracts: {} }, NOW - 24 * H, 24 * 30), 'live'],
  ['OI_HIST_GONE', cached({ contracts: {} }, NOW - 31 * 24 * H, 24 * 30), 'expired'],
  ['QQQ_NPORT_HOLDINGS_V1', cached([], NOW - 1 * H, 24 * 30), 'live'],
  ['V7_PEER_MSFT', JSON.stringify({ t: NOW - 1 * H, data: {} }), 'live'],
  ['V7_PEER_IBM', JSON.stringify({ t: NOW - 25 * H, data: {} }), 'expired'],
  ['FUND_TSLA', JSON.stringify({ data: { pe: 1 }, date: '1/1/2020' }), 'live'],
  ['OPTIONS_OVERLAY', JSON.stringify({ a: 1 }), 'live'],
  ['CIK_BROKEN', 'not json', 'unknown'],
  ['someoneElsesKey', 'v', 'unknown'],
];

describe('FL-18b — classifyProperty', () => {
  test('every known key family, with the readers\' own expiry rules', () => {
    for (const [k, v, s] of KEYS) assert.equal(classifyProperty(k, v, NOW).status, s, k);
  });
  test('"expired" agrees with cacheGet: an expired key already reads as missing, a live one does not', async () => {
    const kv = new MemoryPropertyStore(new Map(KEYS.map(([k, v]) => [k, v])));
    for (const [k, v, s] of KEYS) {
      if (!v.includes('_savedAt')) continue;
      const got = await cacheGet(kv, k, NOW);
      if (s === 'expired') assert.equal(got, null, k);
      if (s === 'live') assert.notEqual(got, null, k);
    }
  });
  test('the exact boundary: age == TTL is live (cacheGet uses age > TTL); peer 24 h is expired (reader uses < 24 h)', () => {
    assert.equal(classifyProperty('CIK_X', cached('1', NOW - 30 * H, 30), NOW).status, 'live');
    assert.equal(classifyProperty('V7_PEER_X', JSON.stringify({ t: NOW - 24 * H, data: {} }), NOW).status, 'expired');
  });
  test('auditPropertyRows skips the header and blank keys', () => {
    const a = auditPropertyRows([['Key', 'Value', 'UpdatedAt'], ['', 'x', ''], ['FUND_A', '{}', '2026-10-29T00:00:00Z']], NOW);
    assert.deepEqual(a.map((x) => [x.key, x.status, x.updatedAt]), [['FUND_A', 'live', '2026-10-29T00:00:00Z']]);
  });
});

/** An in-memory spreadsheet behind the SheetsClient methods the audit and SheetPropertyStore use. */
class MemBook {
  readonly tabs = new Map<string, SheetRow[]>();
  readonly writes: string[] = [];
  readonly formats: sheets_v4.Schema$Request[] = [];
  /** Called before each batchGet (simulates another run writing in between). */
  beforeRead: (n: number) => void = () => {};
  private reads = 0;
  private tabOf(range: string): string { return range.replace(/^'/, '').replace(/'!.*$|'$/, '').replace(/''/g, "'"); }
  readonly api: AuditSheets = {
    listTabs: async () => ({ ok: true, value: [...this.tabs.keys()] }),
    batchGet: async (_c: unknown, ranges: readonly string[]) => {
      this.beforeRead(++this.reads);
      return { ok: true, value: ranges.map((r) => structuredClone(this.tabs.get(this.tabOf(r)) ?? [])) };
    },
    batchUpdate: async (_c: unknown, updates: readonly ValueRangeUpdate[]) => {
      for (const u of updates) {
        const tab = this.tabOf(u.range);
        this.writes.push(tab);
        const rows = this.tabs.get(tab)!;
        u.values.forEach((vals, i) => { rows[i] = [...vals]; });
        while (rows.length && !(rows[rows.length - 1] ?? []).some((v) => v !== '' && v != null)) rows.pop();
      }
      return { ok: true, value: updates.length };
    },
    formatBatch: async (_c: unknown, reqs: readonly sheets_v4.Schema$Request[]) => { this.formats.push(...reqs); return { ok: true, value: reqs.length }; },
  } as unknown as AuditSheets;
}

function book(): MemBook {
  const b = new MemBook();
  b.tabs.set(Tabs.SCRIPT_PROPERTIES, [['Key', 'Value', 'UpdatedAt'], ...KEYS.map(([k, v]) => [k, v, '2026-10-01T00:00:00.000Z'])]);
  const macro: SheetRow[] = [['Date', 'High', 'Low', 'Close', 'Volume']];
  for (let i = 0; i < 2514; i++) macro.push([40000 + i, 2 + i, 1 + i, 1.5 + i, 100 + i]);
  b.tabs.set('💾 Macro SPY', macro);
  b.tabs.set('💾 RS Ranking', [['Ticker', 'SavedAt', 'Ranking'], ['TSLA', '2026-10-29', '{}']]);
  return b;
}

describe('FL-18b — npm run audit-script-properties', () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'x' };
  const run = (b: MemBook, argv: string[], out: string[] = []) =>
    runScriptPropertiesAudit({ env, argv, out: (l) => out.push(l), errOut: (l) => out.push('ERR ' + l), makeSheets: () => b.api, ctx: ctx() });
  const deletable = KEYS.filter(([, , s]) => s === 'expired' || s === 'unused').map(([k]) => k);

  test('the npm script is registered', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['audit-script-properties'], /src\/scriptPropertiesAudit\.ts$/);
  });

  test('without --yes: a listing only, no write of any kind, values never printed', async () => {
    const b = book();
    const before = structuredClone([...b.tabs]);
    const out: string[] = [];
    assert.equal(await run(b, [], out), 0);
    assert.match(out[0]!, /^Script Properties audit: 17 key\(s\) in '💾 Script Properties': 8 live, 6 expired, 1 unused, 2 unknown; /);
    assert.equal(out.filter((l) => l.startsWith('  ')).length, KEYS.length);
    assert.ok(out.some((l) => l.startsWith('  unused  relativeStrengthRankingV1 (')));
    assert.ok(out.some((l) => l.startsWith('  expired CIK_OLDCO (cache entry 2400 h old, expiry 2160 h')));
    assert.match(out[out.length - 1]!, /^Dry run: nothing deleted\. Run again with --yes to delete the 7 expired or unused key\(s\)\.$/);
    assert.ok(!out.join('\n').includes('0001318605'), 'no value is printed');
    assert.deepEqual(b.writes, []);
    assert.deepEqual(b.formats, []);
    assert.deepEqual([...b.tabs], before);
  });

  test('--yes: expired and unused keys deleted, live and unknown kept, the Macro history and other tabs untouched', async () => {
    const b = book();
    const macroBefore = structuredClone(b.tabs.get('💾 Macro SPY'));
    const rsBefore = structuredClone(b.tabs.get('💾 RS Ranking'));
    const out: string[] = [];
    assert.equal(await run(b, ['--yes'], out), 0);
    assert.equal(out[out.length - 1], 'Script Properties audit: 7 key(s) deleted.');
    const left = b.tabs.get(Tabs.SCRIPT_PROPERTIES)!;
    assert.deepEqual(left[0], ['Key', 'Value', 'UpdatedAt']);
    assert.deepEqual(left.slice(1).map((r) => r[0]), KEYS.map(([k]) => k).filter((k) => !deletable.includes(k)));
    for (const r of left.slice(1)) assert.equal(r[1], KEYS.find(([k]) => k === r[0])![1], 'value kept byte for byte: ' + r[0]);
    assert.deepEqual(b.writes, [Tabs.SCRIPT_PROPERTIES]);
    assert.deepEqual(b.formats, []);
    assert.deepEqual(b.tabs.get('💾 Macro SPY'), macroBefore);
    assert.deepEqual(b.tabs.get('💾 RS Ranking'), rsBefore);
    // A second run finds nothing to delete and writes nothing.
    const again: string[] = [];
    assert.equal(await run(b, ['--yes'], again), 0);
    assert.equal(again[again.length - 1], 'Script Properties audit: nothing to delete.');
    assert.deepEqual(b.writes, [Tabs.SCRIPT_PROPERTIES]);
  });

  test('--yes re-checks each key just before the delete: a key rewritten since the listing is kept', async () => {
    const b = book();
    b.beforeRead = (n) => {
      if (n !== 2) return;
      const row = b.tabs.get(Tabs.SCRIPT_PROPERTIES)!.find((r) => r[0] === 'CIK_OLDCO')!;
      row[1] = cached('0000000001', NOW, 24 * 90);
    };
    const out: string[] = [];
    assert.equal(await run(b, ['--yes'], out), 0);
    assert.equal(out[out.length - 1], 'Script Properties audit: 6 key(s) deleted, 1 kept (rewritten since the listing).');
    assert.ok(b.tabs.get(Tabs.SCRIPT_PROPERTIES)!.some((r) => r[0] === 'CIK_OLDCO'));
  });

  test('no Script Properties tab: exit 2, and the tab is never created', async () => {
    const b = book();
    b.tabs.delete(Tabs.SCRIPT_PROPERTIES);
    for (const argv of [[], ['--yes']]) {
      const out: string[] = [];
      assert.equal(await run(b, argv, out), 2);
      assert.match(out[0]!, /^ERR Script Properties audit: the Sheet has no '💾 Script Properties' tab/);
    }
    assert.deepEqual(b.formats, []);
    assert.deepEqual(b.writes, []);
    assert.ok(!b.tabs.has(Tabs.SCRIPT_PROPERTIES));
  });

  test('missing configuration: exit 2, names only', async () => {
    const err: string[] = [];
    assert.equal(await runScriptPropertiesAudit({ env: {}, argv: ['--yes'], out: () => {}, errOut: (l) => err.push(l) }), 2);
    assert.match(err[0]!, /GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID/);
  });
});

describe('FL-18b — one GDPC1 fetch per night', () => {
  const gdpCsv = 'observation_date,GDPC1\n' + Array.from({ length: 12 }, (_, i) => `20${14 + i}-01-01,${(20000 + i * 300 + (i % 3) * 50).toFixed(1)}`).join('\n') + '\n';
  function deps(over: Partial<MacroDeps> = {}): { deps: MacroDeps; urls: string[]; store: MemoryTabStore; kv: MemoryPropertyStore } {
    const urls: string[] = [];
    const transport = {
      send: async (req: HttpRequest): Promise<HttpResponse> => {
        urls.push(req.url);
        const body = req.url === FRED_CSV_URL + 'GDPC1' ? gdpCsv : req.url.startsWith(FRED_CSV_URL) ? 'observation_date,X\n2026-01-01,4.1\n2026-02-01,4.2\n' : '';
        return new HttpResponse(body ? 200 : 404, new TextEncoder().encode(body));
      },
    };
    const store = new MemoryTabStore();
    const kv = new MemoryPropertyStore();
    return { deps: { http: new HttpClient({ transport }), store, kv, fmpKey: 'k', timeZone: 'America/New_York', clock: { now: () => NOW }, ...over }, urls, store, kv };
  }
  const gdpCalls = (urls: readonly string[]) => urls.filter((u) => u === FRED_CSV_URL + 'GDPC1').length;

  test('the nightly macro.refresh shape ({ ...macroDeps, gdpOnce: {} }): one GDPC1 request, the same snapshot and business-cycle phase as two', async () => {
    const legacy = deps();
    await refreshMacroRegimeCache(legacy.deps);
    await refreshMacroSnapshot(legacy.deps, null);
    assert.equal(gdpCalls(legacy.urls), 2);

    const one = deps();
    const once = { ...one.deps, gdpOnce: {} };
    await refreshMacroRegimeCache(once);
    await refreshMacroSnapshot(once, null);
    assert.equal(gdpCalls(one.urls), 1);

    assert.deepEqual(one.store.snapshot(Tabs.MACRO_SNAPSHOT, MACRO_SNAPSHOT_HEADER.length), legacy.store.snapshot(Tabs.MACRO_SNAPSHOT, MACRO_SNAPSHOT_HEADER.length));
    const a = await cacheGet<{ businessCyclePhase: unknown }>(one.kv, MACRO_SUPPLEMENTAL_KEY, NOW);
    const b = await cacheGet<{ businessCyclePhase: unknown }>(legacy.kv, MACRO_SUPPLEMENTAL_KEY, NOW);
    assert.ok(a && a.businessCyclePhase);
    assert.deepEqual(a, b);
    assert.equal(one.urls.length, legacy.urls.length - 1, 'only the GDPC1 duplicate is saved');
  });

  test('a failed GDPC1 response is shared too, with each reader\'s own legacy outcome', async () => {
    const urls: string[] = [];
    const http = new HttpClient({ transport: { send: async (req: HttpRequest) => { urls.push(req.url); return new HttpResponse(503, new Uint8Array()); } } });
    const logs: string[] = [];
    const d: MacroDeps = { http, store: new MemoryTabStore(), kv: new MemoryPropertyStore(), fmpKey: 'k', timeZone: 'America/New_York', clock: { now: () => NOW }, log: (m) => logs.push(m), gdpOnce: {} };
    const s = await computeMacroSupplemental(d);
    assert.equal(s.businessCyclePhase, null);
    assert.ok(logs.includes('GDPC1 fetch failed: HTTP 503'));
    await refreshMacroSnapshot(d, null);
    assert.equal(gdpCalls(urls), 1);
  });

  test('without the memo (parity tests, ad-hoc calls) both readers still fetch, as legacy', async () => {
    const d = deps();
    await computeMacroSupplemental(d.deps);
    await computeMacroSupplemental(d.deps);
    assert.equal(gdpCalls(d.urls), 2);
  });
});
