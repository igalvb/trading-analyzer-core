/**
 * Every `typeof X === / !== 'function'` site in legacy/ (64; 2 are inside
 * comments, so 62 code sites) and how the port resolves it. Kept honest by
 * test/fl7a1.test.ts, which rescans legacy and requires this table to match
 * site for site, and checks every named port target exists.
 *
 * kind:
 *   CALL     the guarded function is ported; the port module `at` calls it directly
 *   LIFTED   the guarded call became an input the run supplies (the resolver / compose.ts, FL-7a-2)
 *   PENDING  the site sits in a function still being ported (`part`); its target already exists.
 *            None left: the 20 PENDING rows were re-checked against src/ on 2026-10-31 (V13 row 38) and
 *            closed as CALL or LIFTED; test/fl7a1.test.ts now requires zero PENDING.
 *   REMOVED  hasTimeBudgetV7_: replaced by per-step timeouts (standing rule); and the two sites in
 *            buildExitStrategyReportV7, whose port (the old '📤 Exit Strategy' tab writer) was removed
 *            (owner 2026-11-04, backlog row 39)
 *   PARAM    a parameter check, kept as it is
 *   COMMENT  inside a comment, not code
 */

export type GuardKind = 'CALL' | 'LIFTED' | 'PENDING' | 'REMOVED' | 'PARAM' | 'COMMENT';

export interface GuardSite {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly guarded: string;
  readonly op: '===' | '!==';
  readonly kind: GuardKind;
  /** 'src/path.ts#export' of the ported guarded function. */
  readonly port?: string;
  /** The port module that holds the (resolved) call site. */
  readonly at?: string;
  readonly part?: '7a-2' | '7b' | '7c';
}

const kv = (s: string): string => 'src/storage/kv.ts#' + s;
const mc = (s: string): string => 'src/storage/macroCaches.ts#' + s;
const tf = (s: string): string => 'src/fetch/sec/thirteenF.ts#' + s;
const rf = (s: string): string => 'src/fetch/macro/refresh.ts#' + s;
const ed = (s: string): string => 'src/fetch/sec/edgar.ts#' + s;
const sc = (s: string): string => 'src/analysis/models/brokerCourse/screens.ts#' + s;
const FRESH = 'src/storage/priceHistory.ts#isPriceCacheFresh';
const RS = 'src/analysis/darkPool.ts#getCachedRelativeStrengthRanking';
const MYO = (s: string): string => 'src/jobs/myOptions.ts#' + s;

export const GUARD_SITES: readonly GuardSite[] = [
  { file: 'brokerCourseModelV1', line: 1611, fn: 'riskOverlayReadV1', guarded: 'hasTimeBudgetV7_', op: '!==', kind: 'REMOVED' },
  { file: 'brokerCourseModelV1', line: 1942, fn: 'buildBrokerCourseReportV1', guarded: 'hasTimeBudgetV7_', op: '!==', kind: 'REMOVED' },
  { file: 'brokerCourseModelV1', line: 2040, fn: 'buildBrokerCourseReportV1', guarded: 'fetchEarningsCalendarV7', op: '===', kind: 'LIFTED', port: 'src/fetch/fundamentals/providers.ts#fetchEarningsCalendar', at: 'src/analysis/models/brokerCourse/report.ts' },
  { file: 'brokerCourseModelV1', line: 2064, fn: 'buildBrokerCourseReportV1', guarded: 'readBrokerDataCacheV1_', op: '===', kind: 'LIFTED', port: mc('readBrokerDataCache'), at: 'src/analysis/models/brokerCourse/report.ts' },
  { file: 'brokerCourseModelV1', line: 2097, fn: 'buildBrokerCourseReportV1', guarded: 'readMacroSnapshotV1_', op: '===', kind: 'LIFTED', port: mc('readMacroSnapshot'), at: 'src/analysis/models/brokerCourse/report.ts' },
  { file: 'dataLayerV1', line: 437, fn: 'gatherFundamentals', guarded: 'X', op: '!==', kind: 'COMMENT' },
  { file: 'dataLayerV1', line: 440, fn: 'hasTimeBudgetSafe_', guarded: 'hasTimeBudgetV7_', op: '!==', kind: 'REMOVED' },
  { file: 'dataLayerV1', line: 678, fn: 'fetch13FCusipV7', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 686, fn: 'fetch13FCusipV7', guarded: 'cacheSet', op: '===', kind: 'CALL', port: kv('cacheSet'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 853, fn: 'fetchInstitutional13FHoldingsV7', guarded: 'expected13FQuarterTagV1_', op: '===', kind: 'CALL', port: tf('expected13FQuarterTag'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 854, fn: 'fetchInstitutional13FHoldingsV7', guarded: 'read13FCacheV1_', op: '===', kind: 'CALL', port: tf('read13FCache'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 869, fn: 'fetchInstitutional13FHoldingsV7', guarded: 'fetch13FBatchedV1_', op: '===', kind: 'CALL', port: tf('fetch13FBatched'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 891, fn: 'fetchInstitutional13FHoldingsV7', guarded: 'write13FCacheV1_', op: '===', kind: 'CALL', port: tf('write13FCache'), at: 'src/fetch/sec/thirteenF.ts' },
  { file: 'dataLayerV1', line: 1339, fn: 'fetchQqqTopHoldingsV1', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/fetch/etf/holdings.ts' },
  { file: 'dataLayerV1', line: 1379, fn: 'fetchQqqTopHoldingsV1', guarded: 'cacheSet', op: '===', kind: 'CALL', port: kv('cacheSet'), at: 'src/fetch/etf/holdings.ts' },
  { file: 'dataLayerV1', line: 1422, fn: 'fetchSecEdgarCIKV1', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/fetch/sec/edgar.ts' },
  { file: 'dataLayerV1', line: 1436, fn: 'fetchSecEdgarCIKV1', guarded: 'cacheSet', op: '===', kind: 'CALL', port: kv('cacheSet'), at: 'src/fetch/sec/edgar.ts' },
  { file: 'dataLayerV1', line: 1512, fn: 'refreshBrokerCourseDataCacheV1_', guarded: 'readBrokerDataCacheV1_', op: '===', kind: 'CALL', port: mc('readBrokerDataCache'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1528, fn: 'refreshBrokerCourseDataCacheV1_', guarded: 'writeBrokerDataCacheV1_', op: '===', kind: 'CALL', port: mc('writeBrokerDataCache'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1542, fn: 'refreshMacroSnapshotV1_', guarded: 'readMacroSnapshotV1_', op: '===', kind: 'CALL', port: mc('readMacroSnapshot'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1554, fn: 'refreshMacroSnapshotV1_', guarded: 'writeMacroSnapshotV1_', op: '===', kind: 'CALL', port: mc('writeMacroSnapshot'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1643, fn: 'fetchCboeRawV1_', guarded: 'hasTimeBudgetV7_', op: '===', kind: 'REMOVED' },
  { file: 'dataLayerV1', line: 1786, fn: 'fetchHistoricalOHLCV_MacroBatch', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1848, fn: 'computeMacroSupplementalV1_', guarded: 'businessCyclePhaseReadV1', op: '===', kind: 'CALL', port: sc('businessCyclePhaseReadV1'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1859, fn: 'refreshMacroRegimeCacheV1', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1861, fn: 'refreshMacroRegimeCacheV1', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1885, fn: 'refreshMacroRegimeCacheV1', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1887, fn: 'refreshMacroRegimeCacheV1', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1903, fn: 'getCachedMacroSupplementalV1_', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'dataLayerV1', line: 1907, fn: 'getCachedDowTheoryConfirmationV1_', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'fullStockAnalysisV10_9', line: 494, fn: 'runDailyAutomationV7', guarded: 'refreshMacroSnapshotV1_', op: '===', kind: 'LIFTED', port: rf('refreshMacroSnapshot'), at: 'src/jobs/automation/dailyAutomation.ts' },
  { file: 'fullStockAnalysisV10_9', line: 511, fn: 'runDailyAutomationV7', guarded: 'refreshBrokerCourseDataCacheV1_', op: '===', kind: 'LIFTED', port: rf('refreshBrokerCourseDataCache'), at: 'src/jobs/automation/dailyAutomation.ts' },
  { file: 'fullStockAnalysisV10_9', line: 787, fn: 'findOptionsSnapshotContractV7_', guarded: 'readOptionsSnapshotV7', op: '===', kind: 'CALL', port: 'src/reports/options/run.ts#readOptionsSnapshot', at: 'src/portfolio/transactions.ts' },
  { file: 'fullStockAnalysisV10_9', line: 868, fn: 'computePortfolioBullPhaseAdvisoryV1_', guarded: 'getCachedMacroRegime_', op: '===', kind: 'LIFTED', port: rf('getCachedMacroRegime'), at: 'src/reports/exit/exitReport.ts' },
  { file: 'fullStockAnalysisV10_9', line: 896, fn: 'computePortfolioBullPhaseAdvisoryV1_', guarded: 'getCachedRelativeStrengthRankingV1_', op: '===', kind: 'LIFTED', port: RS, at: 'src/reports/exit/exitReport.ts' },
  { file: 'fullStockAnalysisV10_9', line: 897, fn: 'computePortfolioBullPhaseAdvisoryV1_', guarded: 'computeNNormalizedPositionSizeV1_', op: '===', kind: 'CALL', port: 'src/analysis/techPlan/additive.ts#computeNNormalizedPositionSize', at: 'src/reports/exit/exitReport.ts' },
  { file: 'fullStockAnalysisV10_9', line: 903, fn: 'computePortfolioBullPhaseAdvisoryV1_', guarded: 'turtleCorrelatedCapsV1_', op: '===', kind: 'CALL', port: 'src/analysis/models/turtle.ts#turtleCorrelatedCaps', at: 'src/reports/exit/exitReport.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1113, fn: 'runAnalysisV7', guarded: 'vixRegimeReadV1', op: '===', kind: 'CALL', port: 'src/analysis/models/brokerCourse/vixSqueeze.ts#vixRegimeReadV1', at: 'src/fetch/marketContext.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1216, fn: 'runAnalysisV7', guarded: 'playerMappingReadV1', op: '!==', kind: 'CALL', port: 'src/analysis/models/brokerCourse/playerMapping.ts#playerMappingReadV1', at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1242, fn: 'runAnalysisV7', guarded: 'readBrokerDataCacheV1_', op: '!==', kind: 'LIFTED', port: mc('readBrokerDataCache'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1242, fn: 'runAnalysisV7', guarded: 'zombieCompanyScreenV1', op: '!==', kind: 'CALL', port: sc('zombieCompanyScreenV1'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1279, fn: 'runAnalysisV7', guarded: 'fetchSecEdgarCIKV1', op: '!==', kind: 'LIFTED', port: ed('fetchSecEdgarCIK'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1300, fn: 'runAnalysisV7', guarded: 'fetchSharesOutstandingHistoryV1', op: '===', kind: 'LIFTED', port: ed('fetchSharesOutstandingHistory'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1300, fn: 'runAnalysisV7', guarded: 'sharesOutstandingTrendReadV1', op: '===', kind: 'CALL', port: sc('sharesOutstandingTrendReadV1'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1307, fn: 'runAnalysisV7', guarded: 'fetchSecFilingKeywordHitsV1', op: '===', kind: 'LIFTED', port: ed('fetchSecFilingKeywordHits'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1307, fn: 'runAnalysisV7', guarded: 'filingKeywordReadV1', op: '===', kind: 'CALL', port: sc('filingKeywordReadV1'), at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1342, fn: 'runAnalysisV7', guarded: 'getCachedRelativeStrengthRankingV1_', op: '===', kind: 'LIFTED', port: RS, at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 1555, fn: 'runAnalysisV7', guarded: 'buildTurtleReportV1', op: '!==', kind: 'CALL', port: 'src/analysis/models/turtle.ts#buildTurtleReport', at: 'src/analysis/runTicker.ts' },
  { file: 'fullStockAnalysisV10_9', line: 3135, fn: 'getCachedMacroRegime_', guarded: 'getCachedMacroSupplementalV1_', op: '===', kind: 'CALL', port: rf('getCachedMacroSupplemental'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'fullStockAnalysisV10_9', line: 3138, fn: 'getCachedMacroRegime_', guarded: 'getCachedDowTheoryConfirmationV1_', op: '===', kind: 'CALL', port: rf('getCachedDowTheoryConfirmation'), at: 'src/fetch/macro/refresh.ts' },
  { file: 'fullStockAnalysisV10_9', line: 3142, fn: 'getCachedMacroRegime_', guarded: 'getCachedEvaluativeIndexV1_', op: '===', kind: 'LIFTED', port: 'src/analysis/darkPool.ts#getCachedEvaluativeIndex', at: 'src/fetch/macro/refresh.ts' },
  { file: 'fullStockAnalysisV10_9', line: 3148, fn: 'getCachedMacroRegime_', guarded: 'isPriceCacheFreshV7_', op: '===', kind: 'CALL', port: FRESH, at: 'src/fetch/macro/refresh.ts' },
  { file: 'fullStockAnalysisV10_9', line: 4821, fn: 'scoreAllSignalsV7_', guarded: 'readBrokerDataCacheV1_', op: '===', kind: 'LIFTED', port: mc('readBrokerDataCache'), at: 'src/analysis/signals.ts' },
  { file: 'fullStockAnalysisV10_9', line: 5171, fn: 'logDataStatusSummaryV7', guarded: 'log', op: '!==', kind: 'PARAM', part: '7b' },
  { file: 'fullStockAnalysisV10_9', line: 9629, fn: 'scanWatchlistV7', guarded: 'getWatchlistTickersV7', op: '===', kind: 'LIFTED', port: 'src/stores/watchlist.ts#getWatchlistTickers', at: 'src/stores/watchlist.ts' },
  { file: 'fullStockAnalysisV10_9', line: 9801, fn: 'computePositionExitReadV1_', guarded: 'computeClassicalStopTrailingV1_', op: '===', kind: 'CALL', port: 'src/analysis/exitRead.ts#computeClassicalStopTrailing', at: 'src/analysis/exitRead.ts' },
  { file: 'fullStockAnalysisV10_9', line: 9810, fn: 'computePositionExitReadV1_', guarded: 'turtlePyramidLadderForRealEntryV1_', op: '===', kind: 'CALL', port: 'src/analysis/exitRead.ts#turtlePyramidLadderForRealEntry', at: 'src/analysis/exitRead.ts' },
  { file: 'fullStockAnalysisV10_9', line: 10010, fn: 'computeOptionsPositionExitReadFixedLookbackV1_', guarded: 'myOpt_parseDate', op: '===', kind: 'CALL', port: 'src/analysis/optionsExitRead.ts#parseOptionExpiry', at: 'src/portfolio/positions/optionsFixedLookback.ts' },
  { file: 'fullStockAnalysisV10_9', line: 10076, fn: 'computeOptionsPositionExitReadV1_', guarded: 'myOpt_parseDate', op: '===', kind: 'CALL', port: 'src/analysis/optionsExitRead.ts#parseOptionExpiry', at: 'src/analysis/optionsExitRead.ts' },
  { file: 'fullStockAnalysisV10_9', line: 10245, fn: 'buildExitStrategyReportV7', guarded: 'findPortfolioStockTableV1_', op: '===', kind: 'REMOVED', port: MYO('findPortfolioStockTable') },
  { file: 'fullStockAnalysisV10_9', line: 10246, fn: 'buildExitStrategyReportV7', guarded: 'myOpt_findTable', op: '===', kind: 'REMOVED', port: MYO('myOptFindTable') },
  { file: 'futuresStockAnalysisV3_3_11', line: 654, fn: 'describeResult', guarded: 'x', op: '===', kind: 'COMMENT' },
  { file: 'futuresStockAnalysisV3_3_11', line: 694, fn: 'computeOiPersistence', guarded: 'cacheGet', op: '===', kind: 'CALL', port: kv('cacheGet'), at: 'src/analysis/options/conviction.ts' },
  { file: 'futuresStockAnalysisV3_3_11', line: 706, fn: 'computeOiPersistence', guarded: 'cacheSet', op: '===', kind: 'CALL', port: kv('cacheSet'), at: 'src/analysis/options/conviction.ts' },
];
