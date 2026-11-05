/**
 * THE ORACLE -- the frozen legacy implementation, loaded and callable.
 *
 * This is the single most important piece of Phase 2's verification story.
 * The legacy .gs files are not reference documentation here; they are an
 * EXECUTABLE oracle. They load into a Node vm context with mocked Apps
 * Script globals and run directly, so the TypeScript port can be checked
 * against the original by feeding both the same real inputs and comparing
 * outputs with deepStrictEqual.
 *
 * Verified working 2026-09-13: all 10 files load into one context and expose
 * exactly 379 functions.
 *
 * WHY ONE CONTEXT: Apps Script gives every .gs file a single shared global
 * scope, which is why cross-file calls there need no imports. Recreating
 * that here is what makes the oracle work at all -- and it is also the
 * structural problem the port has to solve properly, with real modules and
 * an explicit dependency graph.
 *
 * THE ORACLE IS FROZEN: every parity number this project reports is
 * meaningful only if the thing being compared against never changed.
 * Nothing in legacy/ may be edited. oracle.test.ts asserts a checksum
 * manifest to enforce that.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gasFormatDate } from './gasFakes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_DIR = path.join(here, '..', 'legacy');

/**
 * Load order matters: the engine defines constants the models reference at
 * load time. This mirrors the order the legacy tests themselves use.
 */
export const ORACLE_FILES = [
  'fullStockAnalysisV10_9.gs',
  'dataLayerV1.gs',
  'brokerCourseModelV1.gs',
  'futuresStockAnalysisV3_3_11.gs',
  'turtleModelV1.gs',
  'darkPoolTrackerV1.gs',
  'schabackerModelV1.gs',
  'edwardsMageeModelV1.gs',
  'macro_fetchers_v0_15.gs',
  'myOptionsValueTracker.gs',
] as const;

/** Confirmed by direct count on 2026-09-13. A drift here means the oracle changed. */
export const EXPECTED_FUNCTION_COUNT = 379;

/**
 * Apps Script globals, stubbed.
 *
 * Every stub is deliberately INERT -- no network, no sheet, no mail. The 291
 * pure functions never touch any of this; the stubs exist so the files can
 * load and so an accidental I/O call fails visibly rather than silently
 * reaching the real world. UrlFetchApp returns a 404-shaped response, which
 * is exactly what the legacy tests do.
 */
function buildSandbox(): Record<string, unknown> {
  const noopResponse = {
    getResponseCode: (): number => 404,
    getContentText: (): string => '',
    getBlob: (): unknown => null,
  };

  return {
    UrlFetchApp: {
      fetch: (): unknown => noopResponse,
      fetchAll: (reqs: unknown[]): unknown[] => reqs.map(() => null),
    },
    Logger: { log: (): void => {} },
    Utilities: {
      // Timezone-correct for the one pattern legacy uses ('yyyy-MM-dd');
      // the previous stub ignored the zone and returned the UTC date.
      formatDate: gasFormatDate,
      unzip: (): unknown[] => [],
      sleep: (): void => {},
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: (): unknown => null,
      getUi: (): unknown => null,
      flush: (): void => {},
    },
    PropertiesService: {
      getScriptProperties: (): unknown => ({ getProperty: (): null => null, setProperty: (): void => {} }),
    },
    // getScriptTimeZone: a harness default, NOT the real project zone
    // (unknown -- see SCRIPT_TIME_ZONE). Override per test with fakeSession.
    Session: { getEffectiveUser: (): unknown => ({ getEmail: (): string => '' }), getScriptTimeZone: (): string => 'UTC' },
    MailApp: { sendEmail: (): void => {} },
    ScriptApp: { getProjectTriggers: (): unknown[] => [], newTrigger: (): unknown => null },
    HtmlService: {},
    console,
    Math,
    Date,
    JSON,
    isNaN,
    parseFloat,
    parseInt,
  };
}

export interface Oracle {
  /** Every legacy function, by its original name. */
  readonly fns: Record<string, (...args: unknown[]) => unknown>;
  /** Calls a legacy function by name, failing loudly if it does not exist. */
  call<T = unknown>(name: string, ...args: unknown[]): T;
  /**
   * Calls a legacy function and re-homes the result into this realm.
   *
   * PREFER THIS over call() in every differential test. Raw call() returns
   * VM-realm objects, which fail deepStrictEqual on prototype identity even
   * when the data is identical. See normalize.ts.
   */
  callNormalized<T = unknown>(name: string, ...args: unknown[]): T;
  has(name: string): boolean;
  functionNames(): string[];
  /**
   * Writes a top-level `var` in the oracle's realm.
   *
   * Needed for exactly one thing: injecting `_macroRegimeCache`
   * (fullStockAnalysisV10_9.gs:3088) so the macro-regime conviction modifier
   * can be tested. getCachedMacroRegime_ reads the sheet through a 7-function
   * chain, and in this sandbox SpreadsheetApp.getActiveSpreadsheet() returns
   * null -- so without injection it ALWAYS returns {available:false} and the
   * RISK_OFF/RISK_ON branches would be verified only against their own no-op
   * path. That is the same vacuous-verification trap that hid the wyckoff and
   * event-field bugs.
   *
   * Only works for `var`/implicit globals, not `const` (which is block-scoped
   * to the script and unreachable). `_macroRegimeCache` is a `var`, verified.
   */
  setGlobal(name: string, value: unknown): void;
  getGlobal<T = unknown>(name: string): T;
}

let cached: Oracle | null = null;

export function legacyFilesPresent(): boolean {
  return ORACLE_FILES.every((f) => fs.existsSync(path.join(LEGACY_DIR, f)));
}

/**
 * Loads the oracle. Cached -- loading ~19,400 lines per test file would be
 * wasteful, and the oracle is stateless for the pure functions we care about.
 */
export function loadOracle(): Oracle {
  if (cached) return cached;

  if (!legacyFilesPresent()) {
    const missing = ORACLE_FILES.filter((f) => !fs.existsSync(path.join(LEGACY_DIR, f)));
    throw new Error(
      `legacy/ is not populated — missing: ${missing.join(', ')}.\n` +
        `Copy the .gs files from the parent project into ${LEGACY_DIR}, ` +
        `replacing the 4 API keys at fullStockAnalysisV10_9.gs:5311-5314 with placeholders first.`,
    );
  }

  const sandbox = buildSandbox();
  // Several stubs (Date, isNaN, parseFloat, parseInt) are themselves
  // functions -- the .gs files need them present to run, but they were not
  // DEFINED by the legacy code, so they must not count as "legacy functions"
  // below. Captured before loading anything, so only genuinely new globals
  // introduced by the .gs files are counted.
  const preExistingKeys = new Set(Object.keys(sandbox));

  vm.createContext(sandbox);

  for (const file of ORACLE_FILES) {
    const src = fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8');
    try {
      vm.runInContext(src, sandbox, { filename: `legacy/${file}` });
    } catch (e) {
      throw new Error(`oracle failed to load legacy/${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const fns: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [k, v] of Object.entries(sandbox)) {
    if (preExistingKeys.has(k)) continue; // a sandbox stub, not a legacy function
    if (typeof v === 'function') fns[k] = v as (...args: unknown[]) => unknown;
  }

  cached = {
    fns,
    call<T>(name: string, ...args: unknown[]): T {
      const fn = fns[name];
      if (typeof fn !== 'function') {
        throw new Error(`oracle has no function "${name}" (did it move, or is a file missing?)`);
      }
      return fn(...args) as T;
    },
    callNormalized<T>(name: string, ...args: unknown[]): T {
      const fn = fns[name];
      if (typeof fn !== 'function') {
        throw new Error(`oracle has no function "${name}" (did it move, or is a file missing?)`);
      }
      const raw = fn(...args);
      return (raw === null || typeof raw !== 'object' ? raw : structuredClone(raw)) as T;
    },
    has: (name: string): boolean => typeof fns[name] === 'function',
    functionNames: (): string[] => Object.keys(fns).sort(),
    // The sandbox object IS the contextified global, so a plain property
    // write lands on the oracle's global scope. No vm.runInContext needed.
    setGlobal: (name: string, value: unknown): void => {
      sandbox[name] = value;
    },
    getGlobal: <T,>(name: string): T => sandbox[name] as T,
  };
  return cached;
}

// ── Checksum freeze ────────────────────────────────────────────────────
// The manifest is written once by `npm run oracle:freeze` and asserted by
// oracle.test.ts thereafter. If a legacy file is ever edited, every parity
// number silently stops meaning anything -- so this is checked, not trusted.

export const MANIFEST_PATH = path.join(LEGACY_DIR, 'checksums.json');

export function computeChecksums(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ORACLE_FILES) {
    const buf = fs.readFileSync(path.join(LEGACY_DIR, f));
    out[f] = createHash('sha256').update(buf).digest('hex');
  }
  return out;
}

export function readManifest(): Record<string, string> | null {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, string>;
}
