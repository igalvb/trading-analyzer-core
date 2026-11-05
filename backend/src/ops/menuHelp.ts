/**
 * showMenuHelpV7 (fullStockAnalysisV10_9.gs:5554-5608), and the `cli help` text.
 *
 * Legacy built one HTML string and showed it in a modal dialog. The text is
 * kept as data (MENU_HELP_SECTIONS) so the same descriptions feed both the
 * exact legacy HTML (menuHelpHtml, parity-tested against the oracle) and the
 * CLI help (cliHelpText), where each item is shown with the command that
 * replaced it (MENU_ENTRY_POINTS in reports/options/ui.ts).
 *
 * Legacy rule: "the help must always be updated with the menu". helpCoverage()
 * checks it; it finds two Master Lock items the legacy help never described
 * and one label that differs (F-C2). The legacy HTML keeps those gaps; the
 * CLI text fills them.
 */

import { LEGACY_MENUS, MENU_ENTRY_POINTS, type EntryPoint, type LegacyMenu } from '../reports/options/ui.ts';

export const MENU_HELP_TITLE = 'What do these menu items do?';
export const MENU_HELP_WIDTH = 420;
export const MENU_HELP_HEIGHT = 620;

export interface HelpItem {
  readonly handler: string;
  readonly label: string;
  readonly description: string;
}

export interface HelpSection {
  readonly title: string;
  readonly items: readonly HelpItem[];
}

export const MENU_HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: '🚀 Options Analysis menu',
    items: [
      { handler: 'runFullAnalysis', label: '▶ Run Analysis (Default: ticker)', description: 'Zero-click — instantly re-runs the options analysis on whatever ticker is currently your default. Fastest way to refresh a check you already ran.' },
      { handler: 'selectTickerAndRun', label: '📊 Select Ticker & Run', description: 'Same options analysis, but asks you for a symbol first — use this to check a different ticker.' },
      { handler: 'showRecommendedCallV7', label: '📞 Find Recommended Call', description: 'Small, standalone tool — just tells you the single best-scored call contract for a ticker, without running the full report.' },
      { handler: 'diagnose', label: '🔬 Diagnose API connection', description: 'Checks the CBOE options-chain connection directly and tells you what\'s wrong if a ticker\'s options data won\'t load.' },
    ],
  },
  {
    title: '📈 Stock Analysis menu — quick-run',
    items: [
      { handler: 'runCompleteTickerAnalysisV7', label: '🚀 Full Ticker Analysis (Options + Stock + Chart)', description: 'The fastest way to fully analyze one ticker — asks for a symbol once, then runs options analysis, stock analysis, and opens the price chart, all for that same ticker, in the correct order. Solves the "options data only shows up if it\'s the same ticker as your last stock analysis" issue by making that automatic.' },
      { handler: 'runAnalysisV7FromMenu', label: '📊 Run Stock Analysis (v7)', description: 'The main one — opens a ticker picker, runs the full engine (fundamentals, technicals, Gann, options), builds the dashboard. Use this instead of Full Ticker Analysis above when you don\'t need options data refreshed, or want to reuse an existing options run.' },
      { handler: 'showPriceChartV7', label: '📊 Show Price Chart', description: 'Opens a real price chart (up to 2 years of daily data, SMA50/SMA200, entry/exit/stop/target lines when available) for whichever ticker\'s dashboard you last built.' },
    ],
  },
  {
    title: '📈 Stock Analysis menu — portfolio-wide',
    items: [
      { handler: 'buildExitStrategyReportV7Menu', label: '📤 Build Exit Strategy Report', description: 'Reads your real Portfolio sheet directly (both the stock/crypto table and the options table) and gives each real held position a Thesis / Trailing Stop / Targets / Expiry / Confidence / Summary read, plus a portfolio-wide diversification and correlated-exposure advisory at the bottom.' },
      { handler: 'installExitStrategyTriggerV1', label: '⏰ Install Exit Strategy Nightly Trigger (~1am)', description: 'One-time setup — schedules the report above to run automatically overnight. Click once.' },
    ],
  },
  {
    title: '📈 Stock Analysis menu — daily/watchlist automation',
    items: [
      { handler: 'runDailyAutomationV7', label: '🎯 Run Watchlist / Daily Check Now', description: 'Manually runs the daily check on every ticker in your 🎯 Watchlist sheet (creates it, seeded with your current default ticker, the first time you click this). Logs every result to 📈 Decision History and emails you only if a decision genuinely changed.' },
      { handler: 'installDailyTriggerV7', label: '⏰ Install Daily Auto-Run Trigger', description: 'One-time setup — makes the item above happen automatically every morning (~7 AM). Needs nothing from you, just click it once.' },
    ],
  },
  {
    title: '📈 Stock Analysis menu — diagnostics & maintenance',
    items: [
      { handler: 'checkApiKeysConfiguredV7', label: '🔑 Check API Keys Configured', description: 'Confirms your API keys (FMP, Alpha Vantage, Finnhub, Gemini) are present. Currently these are hardcoded directly in the script file (not Script Properties) — this check will always pass unless the file itself was edited incorrectly.' },
      { handler: 'cleanupPriceCacheSheetsV1Menu', label: '🧹 Clean Up Old Price Caches', description: 'Deletes stale per-ticker price-cache sheets you no longer need, to keep the spreadsheet from accumulating clutter.' },
      { handler: 'diagnoseSheetSizeV1Menu', label: '🔍 Diagnose Sheet Size (read-only)', description: 'Reports how large your spreadsheet has gotten (sheet count, cell count) — read-only, changes nothing, just tells you.' },
    ],
  },
  {
    title: '📈 Stock Analysis menu — docs',
    items: [
      { handler: 'buildMethodologySheetV7', label: '📖 Build Methodology Sheet', description: 'Writes a real, in-sheet explanation of how the engine\'s scoring/technical methodology works — a reference, not a live report.' },
      { handler: 'showMenuHelpV7', label: '❓ What do these do?', description: 'This dialog.' },
    ],
  },
];

const HELP_HEAD = `<!DOCTYPE html><html><head><base target="_top">
  <style>
    body{font-family:Arial,sans-serif;padding:16px 20px;color:#333;font-size:13px}
    h2{margin:18px 0 6px 0;color:#455a64;font-size:12px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #cfd8dc;padding-bottom:3px}
    h2:first-child{margin-top:0}
    h3{margin:10px 0 3px 0;color:#1a237e;font-size:14px}
    p{margin:0 0 4px 0;color:#555;line-height:1.45}
  </style></head><body>
    `;

/** The legacy markup has no special character other than '&' (checked against the oracle). */
const esc = (s: string): string => s.replace(/&/g, '&amp;');

/** The exact HTML showMenuHelpV7 built, from the section data above. */
export function menuHelpHtml(sections: readonly HelpSection[] = MENU_HELP_SECTIONS): string {
  return HELP_HEAD + sections.map((s) =>
    '<h2>' + esc(s.title) + '</h2>\n    ' + s.items.map((i) => '<h3>' + esc(i.label) + '</h3>\n    <p>' + esc(i.description) + '</p>').join('\n    '),
  ).join('\n\n    ') + '\n  </body></html>';
}

export interface MenuHelpDeps {
  /** HtmlService.createHtmlOutput(html).setWidth(w).setHeight(h) + ui.showModalDialog(output, title). */
  showModalDialog(html: string, title: string, width: number, height: number): void;
}

/** showMenuHelpV7: the legacy modal dialog, for a host that has one. */
export function showMenuHelp(deps: MenuHelpDeps): void {
  deps.showModalDialog(menuHelpHtml(), MENU_HELP_TITLE, MENU_HELP_WIDTH, MENU_HELP_HEIGHT);
}

export interface HelpCoverage {
  /** Menu handlers the legacy help never describes. */
  readonly undescribed: readonly string[];
  /** Help items whose handler is in no menu. */
  readonly orphaned: readonly string[];
  /** Help items whose label differs from the menu item's label: [handler, help label, menu label]. */
  readonly labelDrift: ReadonlyArray<readonly [string, string, string]>;
}

/** The legacy rule "the help must always match the menu", as a check. */
export function helpCoverage(menus: readonly LegacyMenu[] = LEGACY_MENUS, sections: readonly HelpSection[] = MENU_HELP_SECTIONS): HelpCoverage {
  const menuLabel = new Map<string, string>();
  for (const m of menus) for (const it of m.items) if (it) menuLabel.set(it[1], it[0]);
  const helped = new Map<string, string>();
  for (const s of sections) for (const i of s.items) helped.set(i.handler, i.label);
  return {
    undescribed: [...menuLabel.keys()].filter((h) => !helped.has(h)),
    orphaned: [...helped.keys()].filter((h) => !menuLabel.has(h)),
    labelDrift: [...helped].filter(([h, l]) => menuLabel.has(h) && menuLabel.get(h) !== l).map(([h, l]) => [h, l, menuLabel.get(h) as string] as const),
  };
}

/** Handlers the legacy help never described (the Master Lock menu): written for the CLI help. */
const UNDESCRIBED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  unlockAllSheets: 'Clears the red lock colour from every tab.',
  lockAllSheets: 'Colours every tab red, the lock marker. Nothing reverts edits in the backend (F-73).',
};

/** Where the legacy description is wrong for the CLI (a spreadsheet dialog, hardcoded keys, click-once triggers). */
const CLI_DESCRIPTIONS: Readonly<Record<string, string>> = {
  showPriceChartV7: 'Writes a price chart as an HTML file under out/: the last 126 trading days of closes, high/low, SMA50/SMA200, and the entry/stop/target lines when a plan is supplied.',
  checkApiKeysConfiguredV7: 'Confirms the four API keys (FMP_API_KEY, ALPHAVANTAGE_KEY, FINNHUB_KEY, GEMINI_API_KEY) are set in the environment (.env locally, repository secrets in CI). Prints names only, never values.',
  cleanupPriceCacheSheetsV1Menu: 'Lists price-cache tabs whose last bar is over 90 days old. A dry run by default; it deletes them only with --yes.',
  installExitStrategyTriggerV1: 'Not a command: the schedule is the workflow cron.',
  installDailyTriggerV7: 'Not a command: the schedule is the workflow cron.',
};

/**
 * `cli help`: the legacy help's sections and descriptions, each item with the
 * command that replaced it (MENU_ENTRY_POINTS), then the menu items the legacy
 * help forgot.
 */
export function cliHelpText(entryPoints: Readonly<Record<string, EntryPoint>> = MENU_ENTRY_POINTS, menus: readonly LegacyMenu[] = LEGACY_MENUS): string {
  const menuLabel = new Map<string, string>();
  for (const m of menus) for (const it of m.items) if (it) menuLabel.set(it[1], it[0]);
  const entryLine = (handler: string): string => {
    const ep = entryPoints[handler];
    return ep ? ep.entry + (ep.note ? '  (' + ep.note + ')' : '') : '(no command mapped)';
  };
  const lines: string[] = ['What do these commands do?', 'Each item of the old spreadsheet menus is one command; "was" shows the old menu item.', ''];
  const described = new Set<string>();
  for (const s of MENU_HELP_SECTIONS) {
    lines.push('== ' + s.title + ' ==');
    for (const i of s.items) {
      described.add(i.handler);
      lines.push(entryLine(i.handler), '  was: ' + (menuLabel.get(i.handler) ?? i.label), '  ' + (CLI_DESCRIPTIONS[i.handler] ?? i.description), '');
    }
  }
  for (const m of menus) {
    const rest = m.items.filter((it): it is readonly [string, string] => it !== null && !described.has(it[1]));
    if (!rest.length) continue;
    lines.push('== ' + m.menu + ' (not in the legacy help) ==');
    for (const [label, handler] of rest) lines.push(entryLine(handler), '  was: ' + label, '  ' + (UNDESCRIBED_DESCRIPTIONS[handler] ?? ''), '');
  }
  return lines.join('\n');
}
