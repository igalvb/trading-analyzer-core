/**
 * FL-9b: the two hand-kept lists the parity gate (parityGate.ts) reads.
 *
 * PARITY_ALIASES  reviewed renames. The port has the same logic under another name (srLevelsV7 is found by itself
 *                 because the gate strips version suffixes; these are the ones it cannot guess). The gate checks
 *                 every alias target is really declared in src/, so a rename that later disappears fails loudly.
 *                 Targets were read in the source on 2026-10-24 (file in the note).
 * PARITY_WAIVERS  "no port, on purpose". Needs a plain reason, a reference and a date. The gate fails on a
 *                 function with no port and no waiver, on a waiver for an unknown function, and on a STALE waiver
 *                 (the function has since been ported). One entry (owner 2026-11-04); every other function has a
 *                 port, an alias or a mapping.
 *                 Add an entry only after the user agrees a function is not needed; never to silence the gate.
 */
import type { ParityAlias, ParityWaiver } from './parityGate.ts';

export const PARITY_ALIASES: readonly ParityAlias[] = [
  // dataLayerV1.gs
  { legacy: 'fetchAllOrSequentialV1_', symbol: 'fetchAll', kind: 'port', note: 'HttpClient.fetchAll, net/http.ts' },
  { legacy: 'fetchFredSeriesV1', symbol: 'fetchFredSeriesValues', kind: 'port', note: 'fetch/macro/fred.ts' },
  { legacy: 'parseNasdaqHistoricalResponse_Macro', symbol: 'parseNasdaqHistorical', kind: 'port', note: 'fetch/macro/nasdaq.ts' },
  { legacy: 'nasdaqHistoricalUrl_Macro_', symbol: 'nasdaqHistoricalUrl', kind: 'port', note: 'fetch/macro/nasdaq.ts' },
  { legacy: 'fetchHistoricalOHLCV_Macro', symbol: 'fetchHistoricalOHLCV', kind: 'port', note: 'fetch/macro/nasdaq.ts' },
  { legacy: 'macroPriceCacheSheetName_', symbol: 'macroPriceTab', kind: 'port', note: 'storage/macroCaches.ts' },
  { legacy: 'fetchHistoricalOHLCV_MacroBatch', symbol: 'fetchHistoricalOHLCVBatch', kind: 'port', note: 'fetch/macro/refresh.ts' },
  { legacy: 'fetchM2_Macro', symbol: 'fetchM2Macro', kind: 'port', note: 'fetch/macro/fred.ts' },
  { legacy: 'fetchFredSeries_Macro', symbol: 'fetchFredSeriesMacro', kind: 'port', note: 'fetch/macro/fred.ts' },
  { legacy: 'myOpt_buildUrl', symbol: 'cboeUrl', kind: 'port', note: 'fetch/cboe.ts (also replaces futures buildUrl)' },
  { legacy: 'myOpt_parseOcc', symbol: 'parseOcc', kind: 'port', note: 'fetch/cboe.ts' },
  { legacy: 'myOpt_fetchCurrentPrice', symbol: 'myOptFetchCurrentPrice', kind: 'port', note: 'fetch/cboe.ts' },
  // fullStockAnalysisV10_9.gs
  { legacy: 'priceCacheSheetNameV7_', symbol: 'priceHistoryTab', kind: 'port', note: 'sheets/tabs.ts' },
  { legacy: 'readPriceCacheV7_', symbol: 'PriceHistoryStore', kind: 'port', note: 'storage/priceHistory.ts, method read' },
  { legacy: 'writePriceCacheV7_', symbol: 'PriceHistoryStore', kind: 'port', note: 'storage/priceHistory.ts, method write' },
  { legacy: 'appendPriceCacheV7_', symbol: 'PriceHistoryStore', kind: 'port', note: 'storage/priceHistory.ts, method append' },
  { legacy: 'computeAllIndicators', symbol: 'computeIndicators', kind: 'port', note: 'analysis/indicators/index.ts' },
  { legacy: 'computeGannInline', symbol: 'computeGann', kind: 'port', note: 'analysis/gann.ts' },
  // futuresStockAnalysisV3_3_11.gs
  { legacy: 'buildUrl', symbol: 'cboeUrl', kind: 'port', note: 'fetch/cboe.ts' },
  { legacy: 'onOpen', symbol: 'LEGACY_MENUS', kind: 'mapped', note: 'menus become CLI commands: reports/options/ui.ts LEGACY_MENUS + MENU_ENTRY_POINTS' },
  // macro_fetchers_v0_15.gs
  { legacy: 'installMacroRegimeCacheTriggerV1', symbol: 'NIGHTLY_STEPS', kind: 'mapped', note: 'the daily trigger becomes the nightly step macro.refresh (jobs/nightly/steps.ts) and the nightly cron (workflows/schedule.ts)' },
  { legacy: 'testMacroFetchers', symbol: 'runMacroFetcherDiagnostics', kind: 'port', note: 'fetch/macro/refresh.ts' },
  { legacy: 'alignSeries_Macro', symbol: 'alignSeries', kind: 'port', note: 'analysis/macroRegime.ts' },
  { legacy: 'pctChange_Macro', symbol: 'pctChange', kind: 'port', note: 'analysis/macroRegime.ts' },
  { legacy: 'classifyMacroRegimeAt_Macro', symbol: 'classifyMacroRegimeAt', kind: 'port', note: 'analysis/macroRegime.ts' },
  { legacy: 'testMacroRegimePredictiveValue', symbol: 'macroRegimePredictiveValue', kind: 'port', note: 'analysis/macroRegime.ts' },
  // myOptionsValueTracker.gs
  { legacy: 'myOpt_parseDate', symbol: 'myOptParseDate', kind: 'port', note: 'jobs/myOptions.ts' },
  { legacy: 'myOpt_findTable', symbol: 'myOptFindTable', kind: 'port', note: 'jobs/myOptions.ts' },
  // schabackerModelV1.gs
  { legacy: 'schabackerSRTrendLineReadV1_', symbol: 'schabackerSrTrendLineRead', kind: 'port', note: 'analysis/models/schabacker.ts' },
];

export const PARITY_WAIVERS: readonly ParityWaiver[] = [
  { legacy: 'buildWatchlistSummarySheetV7', reason: "The '🎯 Watchlist Summary' tab is unused; the port was removed and the tab is no longer written (the Buy report covers the ranking).", ref: 'owner decision 2026-11-04, docs/V13_BACKEND_CHECKPOINT_STATUS.md backlog row 39', recordedOn: '2026-11-04' },
];
