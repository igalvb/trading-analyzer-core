/**
 * The tab registry -- every real sheet tab name, hardcoded.
 *
 * HARDCODED DELIBERATELY. These names are the sheet TEMPLATE contract
 * (GENERIC_PLAN E1): every user's sheets are made from the same template, so
 * the names are the same for every user. Do not make them configurable. The
 * only per-user part is the list of the user's own personal tabs, which the
 * robot never writes or deletes (profile sheets.protectedTabs, below).
 *
 * IMMUTABILITY RULE: these strings map to REAL tabs holding the user's REAL
 * data. Renaming one orphans it -- to the Sheets API a new name is simply a
 * new, empty sheet, and the old data becomes invisible to this code while
 * silently remaining on a tab nothing reads.
 *
 * Note that several names contain the word "Cache" even though those stores
 * are being converted to append-only permanent history. That is intentional:
 * the naming rule ("the name must match actual behaviour") governs code,
 * comments, log text, and report text -- NEVER real tab names. The
 * TypeScript identifiers below drop the word; the strings must not.
 */

import { activeProfile } from '../profile/active.ts';

export const Tabs = {
  /** Two separate tables live on this one sheet. See readers/portfolio.ts. */
  PORTFOLIO: 'Portfolio',

  /** User-editable candidate list. The sole source of truth for Buy. */
  WATCHLIST: '🎯 Watchlist',

  /** Legacy flat grid, being demoted. Data preserved, never deleted. */
  WATCHLIST_SUMMARY: '🎯 Watchlist Summary',

  /** Legacy change log, being demoted. Data preserved, never deleted. */
  DECISION_HISTORY: '📈 Decision History',

  /** Append-only history. Name retained; behaviour changed. */
  INSTITUTIONAL_HISTORY: '💾 13F Cache',

  /** Append-only history. Name retained; behaviour changed. */
  BROKER_DATA_HISTORY: '💾 Broker Data Cache',

  /** Genuinely transient, recomputed each run. The word "cache" is accurate here. */
  MACRO_SNAPSHOT: '💾 Macro Snapshot',

  /** New tab, approved. Fundamentals move here off Apps Script properties. */
  FUNDAMENTALS_HISTORY: '💾 Fundamentals History',

  /** New tab, approved 2026-10-22. Replaces Apps Script's PropertiesService (storage/kv.ts SheetPropertyStore). */
  SCRIPT_PROPERTIES: '💾 Script Properties',

  /** End-of-run summary only. Full logs live in stdout. */
  LOG: '🔬 Log',

  /** Phase-0 connectivity check. Disposable. */
  SMOKE: '⚙️ Smoke Test',
} as const;

export type TabName = (typeof Tabs)[keyof typeof Tabs];

/** Per-ticker price history tabs are named by prefix + ticker. */
export const PRICE_HISTORY_PREFIX = '💾 ';

/**
 * Mirrors the legacy priceCacheSheetNameV7_ exactly, including its
 * character strip and 100-char truncation. Google Sheets disallows
 * [ ] * / \ ? : in tab names; this is a defensive net for hand-typed
 * tickers such as ^VIX, DX-Y.NYB, BRK.B.
 */
export function priceHistoryTab(ticker: string): string {
  const clean = String(ticker).replace(/[[\]*/\\?:]/g, '');
  return (PRICE_HISTORY_PREFIX + clean).slice(0, 100);
}

/**
 * Quotes a tab name for A1 notation.
 *
 * Required here, not optional: every tab name in this project contains an
 * emoji and a space, and several contain characters that need quoting. An
 * unquoted "🎯 Watchlist!A1" is not valid A1 notation.
 */
export function a1(tab: string, range?: string): string {
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

// ---- Three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d), phase 2) ---------------------------------------
//
// My Portfolio (SPREADSHEET_ID) keeps the owner's tabs; tickerAnalysisReports (REPORTS_SPREADSHEET_ID) the
// report tabs; stocksAndMarketMetadata (DATA_SPREADSHEET_ID) the machine data. Hard-coded, no config file.
// Routing is on only when My Portfolio carries the `tradingDataMigrated` flag (sheets/threeSheets.ts).
// The names below are copies of the constants in their own modules (importing them here would make import
// cycles); test/sheetRouting.test.ts pins each one against its module.

export type SheetRole = 'portfolio' | 'reports' | 'data';

/** The migration record in the data sheet (status, the two target IDs, one row per moved tab). Never deleted. */
export const MIGRATION_MARKER_TAB = '💾 Migration';

/**
 * Data tabs that do not start with '💾 '. The two option-history tabs are paper/chainSnapshot.ts's (James's models, G3);
 * the three options-read tabs are storage/optionsReadsTab.ts's (options sentiment plan A-3 and part B).
 */
export const OPTIONS_READ_TABS: readonly string[] = ['📈 Options Reads', '📦 Options Read Snapshots', '🌐 Market Options Read', '📐 Options Measures'];
export const DATA_TABS_WITHOUT_PREFIX: readonly string[] = ['_OPTIONS_SNAPSHOT', '🔬 Log', '📝 Paper State', '📉 IV History', '📦 Option Chain Snapshots', ...OPTIONS_READ_TABS];

/**
 * The user's personal tabs in My Portfolio, profile `sheets.protectedTabs` (GENERIC_PLAN P2), byte for byte. The
 * robot never writes or deletes them (the Master Lock still colours them red).
 */
export const PERSONAL_TABS: readonly string[] = activeProfile().sheets.protectedTabs;

/** Owner tabs that stay in My Portfolio (besides the personal ones). */
export const PORTFOLIO_TABS: readonly string[] = ['Portfolio', '🎯 Watchlist', '📒 Transactions', '⚙️ Smoke Test'];

/** The 10 report tabs that move from My Portfolio to the reports sheet (rows 7-13 of the inventory). */
export const MOVED_REPORT_TABS: readonly string[] = [
  '🎯 Watchlist Summary', '📈 Decision History', '🛒 Buy Report', '📤 Exit Report', 'Exit Target History',
  '🌊 Dark Pool Tracker', '📝 Paper Trading', '📒 Paper Log', '🔎 Paper Reads', '📈 Paper Values',
];

/** The 30 fixed analysis tabs every analyze run writes (phase 1 names; James's models phases 1-5 added the ten James pages). */
export const ANALYSIS_REPORT_TABS: readonly string[] = [
  '📋 Bottom Line', '📊 Price Chart', '🧮 All Models', '📊 Analysis v7', '📚 Broker Model', '📜 Schabacker Model',
  '📖 Edwards & Magee Model', '🐢 Turtle Model', '🏛️ Wyckoff Model', '🪤 James — Market Maker Stages', '📈 Trend Model', '🧩 Combo Models', '🪜 LILO Model',
  '🪜 James — LILO v2', '💰 James — Profit-Taking', '↩️ James — Mean Reversion', '🔁 James — Pair Rotation', '🏆 James — Winners & Layering', '🔄 James — Multi-Year Cycle', '✅ James — Quality Gate', '🔀 Model Comparison', '📞 Options Decision', '🎯 James — LEAPS', '⚖️ James — Option Fair Value', '📋 Dashboard', '🏆 Top 10 Conviction', '📞 CALL Table', '📉 PUT Table',
  '🧱 Gamma Wall', '📆 Near／Mid／LEAPS',
];
/** The live broker bot's report tabs (docs/live-broker; live/liveLog.ts), append-only like 📒 Paper Log. */
export const LIVE_REPORT_TABS: readonly string[] = ['💵 Live Log'];

/** The daily run watchdog's append-only log (src/watchdog.ts RUN_HEALTH_TAB; owner 2026-11-04). */
export const OPS_REPORT_TABS: readonly string[] = ['🩺 Run Health'];

/**
 * The paper test's input tabs in the reports sheet: '🤖 Claude Picks' holds the orders of the account "🤖 Claude, free
 * choice" (paper/paperClaude.ts CLAUDE_PICKS_TAB; appended by `npm run claude-order`, Status written by the paper night).
 * '🤖 Claude Ideas' is Claude's recommendations list with no money (paper/claudeIdeas.ts CLAUDE_IDEAS_TAB; appended by
 * `npm run claude-idea`, Status edited by hand; shown in the dashboard's Paper tab).
 */
export const PAPER_INPUT_TABS: readonly string[] = ['🤖 Claude Picks', '🤖 Claude Ideas'];

/** Manual-only and legacy-only report tabs. */
export const OTHER_REPORT_TABS: readonly string[] = ['📌 Position', '📖 Methodology', '📤 Exit Strategy', '🔍 Sheet Size Report'];

/** Per-ticker report names of the legacy layout (until phase 1 ships, and in legacy-parity mode). */
const PER_TICKER_REPORT_PATTERNS: readonly RegExp[] = [/^📋 Bottom Line — .+$/u, /^📊 .+ Chart$/u, /^📌 Position — .+$/u];

/**
 * Never deleted from the sheet that holds the live copy, and never read as price tabs. `💾 Migration` is
 * never deleted anywhere. The others may be removed from My Portfolio only by the migrate tool's `delete`
 * step after a verified switch (they are stale copies there by then).
 */
export const PROTECTED_TABS: readonly string[] = [
  MIGRATION_MARKER_TAB, '💾 Script Properties', '📝 Paper State', '📈 Decision History', 'Exit Target History',
  '📝 Paper Trading', '📒 Paper Log', '🔎 Paper Reads', '📈 Paper Values', '📉 IV History', '📦 Option Chain Snapshots',
  ...OPTIONS_READ_TABS, ...LIVE_REPORT_TABS, ...OPS_REPORT_TABS, ...PAPER_INPUT_TABS,
];

export function isPersonalTab(name: string): boolean {
  return PERSONAL_TABS.includes(name);
}

/** Which spreadsheet a tab lives in once routing is on. Unknown names default to the reports sheet. */
export function sheetFor(name: string): SheetRole {
  if (name.startsWith(PRICE_HISTORY_PREFIX) || DATA_TABS_WITHOUT_PREFIX.includes(name)) return 'data';
  if (PORTFOLIO_TABS.includes(name) || PERSONAL_TABS.includes(name)) return 'portfolio';
  return 'reports';
}

/** A known report name (the registry), as opposed to an unknown tab that merely routes to reports by default. */
export function isReportRegistryName(name: string): boolean {
  return MOVED_REPORT_TABS.includes(name) || ANALYSIS_REPORT_TABS.includes(name) || OTHER_REPORT_TABS.includes(name) || LIVE_REPORT_TABS.includes(name) || OPS_REPORT_TABS.includes(name) || PAPER_INPUT_TABS.includes(name)
    || PER_TICKER_REPORT_PATTERNS.some((re) => re.test(name));
}

/** The writers' allow-list: registry names plus the '💾 <TICKER>' pattern. Never a personal name. */
export function isAllowListedName(name: string): boolean {
  if (isPersonalTab(name)) return false;
  if (name.startsWith(PRICE_HISTORY_PREFIX) && name.length > PRICE_HISTORY_PREFIX.length) return true;
  return DATA_TABS_WITHOUT_PREFIX.includes(name) || PORTFOLIO_TABS.includes(name) || isReportRegistryName(name);
}
