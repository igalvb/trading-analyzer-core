/**
 * GENERIC_PLAN P1 (§3c): where a profile comes from, first found wins:
 *   1. PROFILE_JSON env   (tests, CI, replay)
 *   2. PROFILE_FILE env   (a path; local runs)
 *   3. the `⚙️ Profile` tab of the user's My Portfolio sheet (GitHub runs; read by the caller, parsed here)
 *   4. the built-in fallback the caller passes (the owner profile, phases P2-P8 only; removed in P9)
 * P1: nothing calls this yet.
 */

import fs from 'node:fs';
import { validateProfile, type ProfileResult } from './schema.ts';

/** The profile tab (open question Q3 default: a sheet tab). Two columns: Key (dotted, e.g. tax.rate) | Value. */
export const PROFILE_TAB = '⚙️ Profile';

export type ProfileSource = 'PROFILE_JSON' | 'PROFILE_FILE' | 'sheet' | 'built-in' | 'none';
export type LoadedProfile = ProfileResult & { readonly source: ProfileSource };

/**
 * The `⚙️ Profile` tab's rows as a profile input. A value is JSON when it parses (numbers, true/false, lists, pairs,
 * maps); otherwise a comma-separated text is a list for list keys and plain text for the rest. A header row "Key" and
 * blank rows are skipped.
 */
export function profileInputFromRows(rows: readonly (readonly unknown[])[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = String(r[0] ?? '').trim();
    if (!key || key.toLowerCase() === 'key') continue;
    const raw = r[1];
    let v: unknown = raw;
    if (typeof raw === 'string') {
      const s = raw.trim();
      try { v = JSON.parse(s); } catch { v = /^(lists|paper\.fixedUniverse|research|live\.allowList|sheets\.protectedTabs|sheets\.portfolio\.endMarkers)/.test(key) ? s.split(',').map((x) => x.trim()).filter(Boolean) : s; }
    }
    let o = out;
    const parts = key.split('.');
    for (const p of parts.slice(0, -1)) o = (o[p] && typeof o[p] === 'object' ? o[p] : (o[p] = {})) as Record<string, unknown>;
    o[parts[parts.length - 1] as string] = v;
  }
  return out;
}

export interface LoadOptions {
  /** The `⚙️ Profile` tab's rows, when the caller read them (null = no such tab). */
  readonly sheetRows?: readonly (readonly unknown[])[] | null;
  /** The built-in fallback (P2-P8: the owner profile). */
  readonly fallback?: unknown;
  readonly readFile?: (path: string) => string;
}

export function loadProfile(env: Readonly<Record<string, string | undefined>>, o: LoadOptions = {}): LoadedProfile {
  const json = (env.PROFILE_JSON ?? '').trim();
  if (json) {
    try { return { ...validateProfile(JSON.parse(json)), source: 'PROFILE_JSON' }; } catch { return { ok: false, errors: ['PROFILE_JSON is not valid JSON'], source: 'PROFILE_JSON' }; }
  }
  const file = (env.PROFILE_FILE ?? '').trim();
  if (file) {
    let text: string;
    try { text = (o.readFile ?? ((p) => fs.readFileSync(p, 'utf8')))(file); } catch { return { ok: false, errors: ['PROFILE_FILE could not be read'], source: 'PROFILE_FILE' }; }
    try { return { ...validateProfile(JSON.parse(text)), source: 'PROFILE_FILE' }; } catch { return { ok: false, errors: ['PROFILE_FILE is not valid JSON'], source: 'PROFILE_FILE' }; }
  }
  if (o.sheetRows && o.sheetRows.length) return { ...validateProfile(profileInputFromRows(o.sheetRows)), source: 'sheet' };
  if (o.fallback !== undefined) return { ...validateProfile(o.fallback), source: 'built-in' };
  return { ok: false, errors: ['no profile: set PROFILE_JSON, PROFILE_FILE or the ' + PROFILE_TAB + ' tab'], source: 'none' };
}
