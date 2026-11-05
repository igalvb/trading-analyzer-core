/**
 * The key-value store that replaces Apps Script's PropertiesService, and
 * the legacy functions built directly on it.
 *
 * ══ EVERYTHING THAT USED PropertiesService LANDS HERE ════════════════
 * The business-logic sub-plan marked 14 PropertiesService uses "deleted"
 * (fundamentals -> '💾 Fundamentals History'). Under the standing rule --
 * every piece of legacy logic is ported -- the rest need a home, and this
 * is it:
 *   cacheGet/cacheSet (futuresStockAnalysisV3_3_11.gs:669-689) and their
 *     8 keys: CIK, CUSIP, NPORT, FINRA week T1/T2, evaluative index, RS
 *     ranking, macro supplemental, Dow theory
 *   V7_PEER_ (fetchPeerBasicMetricsV7, dataLayerV1.gs:88-117) -- FL-2
 *   FUND_ (dataLayerV1.gs:1286-1292) -- ported verbatim below; FL-2 adds
 *     the append-only Fundamentals History Phase 1 decided on
 *   OPTIONS_OVERLAY (written futures :356, read :8737-8739 below)
 *   the LEAPS open-interest snapshot (futures :694-706) -- FL-6
 *
 * ══ ONE SANCTIONED BEHAVIOUR CHANGE ═════════════════════════════════
 * PropertiesService refused values over 9 KB, and legacy cacheSet
 * swallowed that, so large values were silently never cached (refetched
 * every run). The Sheet-backed store has no 9 KB cap (a cell's 50,000
 * characters is enforced in set(), so one oversized value cannot fail the
 * whole flush -- F-57); the master plan
 * lists the 9 KB problem as one to solve. Pinned by a test either way.
 *
 * Legacy swallowed every store error and returned null/false. The return
 * values are kept; the silence is not -- each function takes an optional
 * onError (sub-plan §3.6).
 */

import type { SheetsClient } from '../sheets/client.ts';
import { a1 } from '../sheets/tabs.ts';
import type { RunContext } from '../core/context.ts';
import { ok, type StepResult } from '../core/result.ts';

export interface PropertyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store. Tests share its Map with the oracle's fake properties. */
export class MemoryPropertyStore implements PropertyStore {
  readonly map: Map<string, string>;
  constructor(map: Map<string, string> = new Map()) {
    this.map = map;
  }
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export const PROPERTY_STORE_HEADER: readonly string[] = ['Key', 'Value', 'UpdatedAt'];

/** The most characters a Google Sheets cell holds; a longer write fails the whole batch. */
export const SHEET_CELL_CHAR_LIMIT = 50000;

/**
 * A Sheet-backed store: read everything at load, mutate in memory, write
 * once at flush (the SheetsClient pattern). Values are written RAW so a
 * JSON payload that looks like a date or number is never coerced by Sheets.
 *
 * The tab name is passed in -- production uses Tabs.SCRIPT_PROPERTIES
 * ('💾 Script Properties', approved by the user 2026-10-22) -- so tests can
 * point the store at any tab.
 */
export class SheetPropertyStore implements PropertyStore {
  private readonly client: SheetsClient;
  private readonly tab: string;
  private readonly rows: Map<string, { value: string; updatedAt: string }>;
  private readonly now: () => number;
  private loadedRowCount: number;
  private dirty = false;

  private constructor(
    client: SheetsClient, tab: string, rows: Map<string, { value: string; updatedAt: string }>,
    loadedRowCount: number, now: () => number,
  ) {
    this.client = client;
    this.tab = tab;
    this.rows = rows;
    this.loadedRowCount = loadedRowCount;
    this.now = now;
  }

  /** Loads the tab, creating it (empty) if it does not exist yet. */
  static async load(ctx: RunContext, client: SheetsClient, tab: string): Promise<StepResult<SheetPropertyStore>> {
    const tabs = await client.listTabs(ctx);
    if (!tabs.ok) return tabs;
    if (!tabs.value.includes(tab)) {
      const created = await client.formatBatch(ctx, [{ addSheet: { properties: { title: tab } } }]);
      if (!created.ok) return created;
      return ok(new SheetPropertyStore(client, tab, new Map(), 0, () => ctx.clock.now()));
    }
    const read = await client.batchGet(ctx, [a1(tab, 'A:C')]);
    if (!read.ok) return read;
    const table = read.value[0] ?? [];
    const rows = new Map<string, { value: string; updatedAt: string }>();
    for (const r of table.slice(1)) {
      const key = r[0] == null ? '' : String(r[0]);
      if (!key) continue;
      rows.set(key, { value: r[1] == null ? '' : String(r[1]), updatedAt: r[2] == null ? '' : String(r[2]) });
    }
    return ok(new SheetPropertyStore(client, tab, rows, table.length, () => ctx.clock.now()));
  }

  async get(key: string): Promise<string | null> {
    const r = this.rows.get(key);
    return r ? r.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    if (value.length > SHEET_CELL_CHAR_LIMIT) {
      throw new Error(`SheetPropertyStore: the value for ${key} is ${value.length} characters; a Sheets cell holds at most ${SHEET_CELL_CHAR_LIMIT}`);
    }
    this.rows.set(key, { value, updatedAt: new Date(this.now()).toISOString() });
    this.dirty = true;
  }

  async delete(key: string): Promise<void> {
    if (this.rows.delete(key)) this.dirty = true;
  }

  /** Rewrites the table once; rows left over from deletions are blanked. */
  async flush(ctx: RunContext): Promise<StepResult<number>> {
    if (!this.dirty) return ok(0);
    const values: string[][] = [[...PROPERTY_STORE_HEADER]];
    for (const [k, r] of this.rows) values.push([k, r.value, r.updatedAt]);
    const total = Math.max(values.length, this.loadedRowCount);
    while (values.length < total) values.push(['', '', '']);
    const res = await this.client.batchUpdate(ctx, [{ range: a1(this.tab, `A1:C${total}`), values }]);
    if (res.ok) {
      this.dirty = false;
      this.loadedRowCount = this.rows.size + 1;
    }
    return res;
  }
}

export type OnStoreError = (e: unknown) => void;

/**
 * cacheSet (futuresStockAnalysisV3_3_11.gs:669-674). Payload byte-identical
 * to legacy: { _savedAt, _ttlHours, data }.
 *
 * Quirk kept: `ttlHours || null` stores 0 (and undefined) as null, which
 * cacheGet treats as NEVER expiring. Every legacy caller passes a positive
 * TTL (30, 24*30, 24*90), so this is latent.
 */
export async function cacheSet(
  store: PropertyStore, key: string, value: unknown, ttlHours?: number | null,
  now: number = Date.now(), onError?: OnStoreError,
): Promise<boolean> {
  try {
    const payload = { _savedAt: now, _ttlHours: ttlHours || null, data: value };
    await store.set(key, JSON.stringify(payload));
    return true;
  } catch (e) {
    onError?.(e);
    return false;
  }
}

/**
 * cacheGet (futuresStockAnalysisV3_3_11.gs:676-689). Expired is strictly
 * `age > ttl`; a negative TTL is expired immediately; anything stored as a
 * Date comes back as its ISO string (a JSON round trip). Returns
 * `undefined` -- not null -- if the stored payload has no `data` key,
 * exactly as legacy does.
 */
export async function cacheGet<T = unknown>(
  store: PropertyStore, key: string, now: number = Date.now(), onError?: OnStoreError,
): Promise<T | null | undefined> {
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (payload._ttlHours != null) {
      const ageHours = (now - payload._savedAt) / (1000 * 60 * 60);
      if (ageHours > payload._ttlHours) return null;
    }
    return payload.data;
  } catch (e) {
    onError?.(e);
    return null;
  }
}

export interface CachedFundamentals<F = unknown> {
  readonly data: F;
  readonly date: string;
}

export const FUNDAMENTALS_KEY_PREFIX = 'FUND_';

/** getCachedFundamentals (dataLayerV1.gs:1286-1288). */
export async function getCachedFundamentals<F = unknown>(
  store: PropertyStore, ticker: string, onError?: OnStoreError,
): Promise<CachedFundamentals<F> | null> {
  try {
    const r = await store.get(FUNDAMENTALS_KEY_PREFIX + ticker);
    return r ? JSON.parse(r) : null;
  } catch (e) {
    onError?.(e);
    return null;
  }
}

/**
 * saveFundamentalsCache (dataLayerV1.gs:1290-1292). The `date` label is
 * legacy's `toLocaleDateString()`; its text depends on locale and zone, so
 * production passes `dateLabel` = core/dates.ts localeDateLabel bound to
 * the script zone (en-US M/D/YYYY). The default is the runtime's own
 * toLocaleDateString(), as before. The engine shows it as "cache (<date>)".
 */
export async function saveFundamentalsCache(
  store: PropertyStore, ticker: string, fund: unknown, now: Date = new Date(), onError?: OnStoreError,
  dateLabel: (d: Date) => string = (d) => d.toLocaleDateString(),
  /** Extra record fields (production: `fetchedAt`, the ISO save instant). Absent = legacy's exact {data, date}. */
  extra?: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await store.set(FUNDAMENTALS_KEY_PREFIX + ticker, JSON.stringify({ data: fund, date: dateLabel(now), ...(extra ?? {}) }));
  } catch (e) {
    onError?.(e);
  }
}

export const OPTIONS_OVERLAY_KEY = 'OPTIONS_OVERLAY';

/**
 * getCachedOptions (fullStockAnalysisV10_9.gs:8737-8739). No legacy
 * caller reads this (F-24 class); the key is still written at
 * futuresStockAnalysisV3_3_11.gs:356. Ported anyway.
 */
export async function getCachedOptions<T = unknown>(store: PropertyStore, onError?: OnStoreError): Promise<T | null> {
  try {
    const r = await store.get(OPTIONS_OVERLAY_KEY);
    return r ? JSON.parse(r) : null;
  } catch (e) {
    onError?.(e);
    return null;
  }
}
