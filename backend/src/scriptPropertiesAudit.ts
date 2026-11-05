/**
 * npm run audit-script-properties: the '💾 Script Properties' audit of docs/SHEETS_CLEANUP_PLAN.md phase 4b.
 *
 * Lists every key of the tab with a status, then (only with --yes) deletes the keys no reader can use:
 *   live     a key the code reads and whose value is still in date (or has no expiry: FUND_, OPTIONS_OVERLAY)
 *   expired  a cache key past its own expiry; its reader already treats it as missing (cacheGet: age > _ttlHours;
 *            V7_PEER_: older than 24 h), so deleting it changes no result. Typical: CIK_/CUSIP_/OI_HIST_ keys
 *            of tickers that left the lists.
 *   unused   relativeStrengthRankingV1: outside legacy-parity mode the ranking lives in the '💾 RS Ranking' tab;
 *            the key is written only in parity mode, so an old value is a stale copy.
 *   unknown  a key this code does not know, or a value it cannot parse: listed, never deleted.
 *
 * Without --yes nothing is written, and the tab is never created (SheetPropertyStore.load would create it; the
 * listing reads it directly). With --yes the tab is read again just before the delete and each key is checked
 * again, so a key rewritten in between is kept. The delete rewrites only this tab (SheetPropertyStore.flush);
 * no other tab, the '💾 Macro' history included, is read or written. Values are never printed.
 * Run it while no workflow is running (my-options and the nightly rewrite this tab too).
 *
 * Exit code: 0 done, 1 a read or write failed, 2 configuration missing, unusable, or no such tab.
 */

import { processLine } from './core/logFile.ts';
import { pathToFileURL } from 'node:url';
import { createContext, type RunContext } from './core/context.ts';
import { SheetsClient, createSheetsApi, parseServiceAccount } from './sheets/client.ts';
import { Tabs, a1 } from './sheets/tabs.ts';
import { dataSheetClient } from './trimPriceTabs.ts';
import { FUNDAMENTALS_KEY_PREFIX, OPTIONS_OVERLAY_KEY, SheetPropertyStore } from './storage/kv.ts';
import { MACRO_SUPPLEMENTAL_KEY, DOW_THEORY_KEY } from './fetch/macro/refresh.ts';
import { EVALUATIVE_INDEX_KEY, FINRA_WEEK_KEY_PREFIX, RELATIVE_STRENGTH_KEY } from './analysis/darkPool.ts';
import { QQQ_NPORT_CACHE_KEY } from './fetch/etf/holdings.ts';
import { OI_HISTORY_KEY_PREFIX } from './analysis/options/conviction.ts';
import { PEER_CACHE_PREFIX, PEER_CONFIG } from './fetch/fundamentals/v7.ts';
import { FMP_RESPONSE_CACHE_PREFIX } from './fetch/fundamentals/providers.ts';

export type PropertyStatus = 'live' | 'expired' | 'unused' | 'unknown';

/** The statuses --yes deletes. */
export const DELETABLE: ReadonlySet<PropertyStatus> = new Set<PropertyStatus>(['expired', 'unused']);

export interface PropertyAudit {
  readonly key: string;
  readonly status: PropertyStatus;
  readonly reason: string;
  readonly chars: number;
  readonly updatedAt: string;
}

/** Keys written by cacheSet ({ _savedAt, _ttlHours, data }) and read by cacheGet. OI_HIST_ covers OI_HIST_V2_. */
const CACHE_SET_EXACT: ReadonlySet<string> = new Set([MACRO_SUPPLEMENTAL_KEY, DOW_THEORY_KEY, EVALUATIVE_INDEX_KEY, QQQ_NPORT_CACHE_KEY]);
const CACHE_SET_PREFIXES: readonly string[] = [FINRA_WEEK_KEY_PREFIX, 'CIK_', 'CUSIP_', OI_HISTORY_KEY_PREFIX, FMP_RESPONSE_CACHE_PREFIX];
/** Keys with no expiry that the code still reads or writes. */
const NO_EXPIRY_EXACT: ReadonlySet<string> = new Set([OPTIONS_OVERLAY_KEY]);
const NO_EXPIRY_PREFIXES: readonly string[] = [FUNDAMENTALS_KEY_PREFIX];

const HOUR_MS = 60 * 60 * 1000;

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Pure: one key's status at `nowMs`. The expiry rules are the readers' own (kv.ts cacheGet, v7.ts fetchPeerBasicMetrics). */
export function classifyProperty(key: string, value: string, nowMs: number, updatedAt = ''): PropertyAudit {
  const out = (status: PropertyStatus, reason: string): PropertyAudit => ({ key, status, reason, chars: value.length, updatedAt });
  if (key === RELATIVE_STRENGTH_KEY) return out('unused', "stale copy: the ranking is kept in the '💾 RS Ranking' tab (this key is written only in legacy-parity mode)");
  if (CACHE_SET_EXACT.has(key) || CACHE_SET_PREFIXES.some((p) => key.startsWith(p))) {
    const p = parse(value) as { _savedAt?: unknown; _ttlHours?: unknown } | undefined;
    if (!p || typeof p !== 'object') return out('unknown', 'value is not the expected cache JSON; left alone');
    if (p._ttlHours == null) return out('live', 'cache entry with no expiry');
    const ageHours = (nowMs - Number(p._savedAt)) / HOUR_MS;
    if (ageHours > Number(p._ttlHours)) return out('expired', `cache entry ${Math.floor(ageHours)} h old, expiry ${p._ttlHours} h`);
    return out('live', `cache entry ${Math.floor(Math.max(0, ageHours))} h old, expiry ${p._ttlHours} h`);
  }
  if (key.startsWith(PEER_CACHE_PREFIX)) {
    const p = parse(value) as { t?: unknown } | undefined;
    if (!p || typeof p !== 'object' || typeof p.t !== 'number') return out('unknown', 'value is not the expected peer-cache JSON; left alone');
    const ageMs = nowMs - p.t;
    if (ageMs >= PEER_CONFIG.cacheHours * HOUR_MS) return out('expired', `peer metrics ${Math.floor(ageMs / HOUR_MS)} h old, expiry ${PEER_CONFIG.cacheHours} h`);
    return out('live', `peer metrics ${Math.floor(Math.max(0, ageMs) / HOUR_MS)} h old, expiry ${PEER_CONFIG.cacheHours} h`);
  }
  if (NO_EXPIRY_EXACT.has(key) || NO_EXPIRY_PREFIXES.some((p) => key.startsWith(p))) return out('live', 'kept with no expiry');
  return out('unknown', 'key not known to this code; left alone');
}

/** Pure: the audit of a '💾 Script Properties' table (header row first, as the tab holds it). */
export function auditPropertyRows(table: ReadonlyArray<ReadonlyArray<unknown>>, nowMs: number): PropertyAudit[] {
  const out: PropertyAudit[] = [];
  for (const r of table.slice(1)) {
    const key = r[0] == null ? '' : String(r[0]);
    if (!key) continue;
    out.push(classifyProperty(key, r[1] == null ? '' : String(r[1]), nowMs, r[2] == null ? '' : String(r[2])));
  }
  return out;
}

export type AuditSheets = Pick<SheetsClient, 'listTabs' | 'batchGet' | 'batchUpdate' | 'formatBatch'>;

export interface AuditCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly makeSheets?: (env: Readonly<Record<string, string | undefined>>) => AuditSheets;
  readonly ctx?: RunContext;
  /** The tab; production '💾 Script Properties'. */
  readonly tab?: string;
}

const NAME = 'Script Properties audit';

export async function runScriptPropertiesAudit(deps: AuditCliDeps): Promise<number> {
  const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
  if (missing.length) { deps.errOut(NAME + ': missing environment variable(s): ' + missing.join(', ')); return 2; }
  let sheets: AuditSheets;
  try {
    sheets = deps.makeSheets ? deps.makeSheets(deps.env) : await dataSheetClient({ env: deps.env, out: deps.out, ctx: deps.ctx }, NAME);
  } catch (e) {
    deps.errOut(NAME + ': ' + (e instanceof Error ? e.message : 'the Google credentials are unusable'));
    return 2;
  }
  const ctx = deps.ctx ?? createContext({ mode: 'lock' });
  const tab = deps.tab ?? Tabs.SCRIPT_PROPERTIES;
  const tabs = await sheets.listTabs(ctx);
  if (!tabs.ok) { deps.errOut(NAME + ': the tab list could not be read. Details are in the log.'); return 1; }
  if (!tabs.value.includes(tab)) { deps.errOut(`${NAME}: the Sheet has no '${tab}' tab. Nothing was changed (the audit never creates it).`); return 2; }
  const read = await sheets.batchGet(ctx, [a1(tab, 'A:C')]);
  if (!read.ok) { deps.errOut(NAME + ': the tab could not be read. Details are in the log.'); return 1; }
  const now = ctx.clock.now();
  const audit = auditPropertyRows(read.value[0] ?? [], now);
  const count = (s: PropertyStatus): number => audit.filter((a) => a.status === s).length;
  const doomed = audit.filter((a) => DELETABLE.has(a.status));
  deps.out(`${NAME}: ${audit.length} key(s) in '${tab}': ${count('live')} live, ${count('expired')} expired, ${count('unused')} unused, ${count('unknown')} unknown; `
    + `${audit.reduce((n, a) => n + a.chars, 0)} characters in all.`);
  for (const a of audit) deps.out(`  ${a.status.padEnd(7)} ${a.key} (${a.reason}; ${a.chars} chars${a.updatedAt ? '; updated ' + a.updatedAt : ''})`);
  if (!deps.argv.includes('--yes')) {
    deps.out(`Dry run: nothing deleted. Run again with --yes to delete the ${doomed.length} expired or unused key(s).`);
    return 0;
  }
  if (!doomed.length) { deps.out(NAME + ': nothing to delete.'); return 0; }
  // Read again just before the delete, and check each key again: a run may have rewritten it since the listing.
  const loaded = await SheetPropertyStore.load(ctx, sheets as SheetsClient, tab);
  if (!loaded.ok) { deps.errOut(NAME + ': the tab could not be read again. Nothing was deleted.'); return 1; }
  const store = loaded.value;
  let deleted = 0;
  for (const a of doomed) {
    const value = await store.get(a.key);
    if (value === null || !DELETABLE.has(classifyProperty(a.key, value, ctx.clock.now()).status)) continue;
    await store.delete(a.key);
    deleted++;
  }
  const flushed = await store.flush(ctx);
  if (!flushed.ok) { deps.errOut(NAME + ': the tab could not be saved. Nothing was deleted: the table is written in one call.'); return 1; }
  deps.out(`${NAME}: ${deleted} key(s) deleted${deleted < doomed.length ? `, ${doomed.length - deleted} kept (rewritten since the listing)` : ''}.`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runScriptPropertiesAudit({ env: process.env, argv: process.argv.slice(2), out: (l) => console.log(l), errOut: (l) => console.error(l) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error(NAME + ': unexpected failure.'); processLine('CRITICAL', 'audit', 'stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exitCode = 1; },
  );
}
