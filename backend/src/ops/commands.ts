/**
 * FL-7c1: the legacy function -> port function -> CLI command table for the
 * ops/diagnostics functions. The menu handlers' commands must equal
 * MENU_ENTRY_POINTS in reports/options/ui.ts (the test asserts it).
 */

export interface OpsCommand {
  readonly legacy: string;
  readonly port: string;
  /** Path under src/. */
  readonly module: string;
  readonly command: string;
  readonly note?: string;
}

export const OPS_COMMANDS: readonly OpsCommand[] = [
  { legacy: 'showPriceChartV7', port: 'showPriceChart', module: 'ops/priceChart.ts', command: 'cli: chart TICKER', note: 'renderPriceChartHtml (ops/priceChartHtml.ts) writes out/<TICKER>-chart.html' },
  { legacy: 'findStalePriceCacheSheetsV1_', port: 'findStalePriceCacheSheets', module: 'ops/priceCaches.ts', command: 'cli: cleanup-price-caches [--yes]', note: 'the selection step of cleanup' },
  { legacy: 'cleanupPriceCacheSheetsV1Menu', port: 'cleanupPriceCacheSheets', module: 'ops/priceCaches.ts', command: 'cli: cleanup-price-caches [--yes]', note: 'a dry run unless --yes' },
  { legacy: 'diagnoseSheetSizeV1Menu', port: 'diagnoseSheetSize', module: 'ops/sheetSize.ts', command: 'cli: sheet-size' },
  { legacy: 'buildMethodologySheetV7', port: 'buildMethodologySheet', module: 'ops/methodology.ts', command: 'cli: methodology' },
  { legacy: 'showMenuHelpV7', port: 'cliHelpText', module: 'ops/menuHelp.ts', command: 'cli: help', note: 'menuHelpHtml / showMenuHelp keep the legacy dialog text' },
  { legacy: 'checkApiKeysConfiguredV7', port: 'checkApiKeysConfigured', module: 'ops/apiKeys.ts', command: 'cli: check-keys' },
  { legacy: 'testFMPStablePointInTimeFields_', port: 'testFMPStablePointInTimeFields', module: 'ops/diagnostics.ts', command: 'cli: probe-fmp' },
  { legacy: 'backtestEngineV7_SKELETON', port: 'backtestEngineSkeleton', module: 'ops/diagnostics.ts', command: 'none', note: 'an intentional stub that throws' },
];
