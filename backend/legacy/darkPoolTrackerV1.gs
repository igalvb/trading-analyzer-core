// ══════════════════════════════════════════════════════════════════════
//  darkPoolTrackerV1.gs — Dark Pool / Off-Exchange Volume Tracker
//  Backlog item from 2026-08-31 (user shared a screenshot of a multi-
//  category watchlist tracking "AvgVol%" per ticker; user's own words on
//  what that metric actually is: "Dark pool data options trading outside
//  the stock market"). Data source resolved and LIVE-VERIFIED the same
//  session via a real `curl` test (HTTP 200, no auth) before any of this
//  was written — not assumed from FINRA's own (partly stale/misleading)
//  developer docs, which describe a DIFFERENT, OAuth-gated query API.
//
//  Real, disclosed design decision, same day: user's own explicit call —
//  this runs on a DAILY BACKGROUND TRIGGER, same pattern as
//  macro_fetchers_v0_11.gs's `refreshMacroRegimeCacheV1`/
//  `installMacroRegimeCacheTriggerV1` — NOT a synchronous menu action.
//  Real reason: 85 tickers × network calls (FINRA + Yahoo) is a genuine
//  risk against Apps Script's 6-minute INTERACTIVE execution cap — this
//  project has already hit that exact class of bug twice (v9.62, v9.70).
//  A time-driven trigger gets a much larger ~30-minute ceiling and, if it
//  ever does time out on some rare day, only that standalone execution
//  dies — the sheet just keeps showing whatever it last successfully
//  cached, never blocking or corrupting anything else in this project.
//
//  Same Apps Script project, shared global scope as the other files here
//  (reuses `fetchYahooChart` verbatim — zero new data source for the
//  price/volume side, only the FINRA side is genuinely new).
// ══════════════════════════════════════════════════════════════════════

// Version tracking, same discipline as CONFIG_V7.version/OPTIONS_ENGINE_VERSION/
// BROKER_COURSE_MODEL_VERSION -- UPDATE THIS on every real change, per the
// 2026-09-06 standing rule ("versioning is for all the scripts"). First
// real version marker for this file (previously edited in place with no marker).
const DARK_POOL_TRACKER_VERSION = 'v1.1'; // v1.1 (2026-09-07): Pass 3 of the fetch/analyze separation refactor (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md) -- this file's own 2 real fetch-owning functions (findLatestPublishedFinraWeekV1_, fetchFinraAtsWeeklyBatchV1_) MOVED VERBATIM to dataLayerV1.gs. The 3 real trigger handlers (refreshDarkPoolTrackerV1/refreshEvaluativeIndexV1/refreshRelativeStrengthRankingV1_) stay here -- deliberately NOT moved, since they wrap ANALYSIS functions (buildDarkPoolTrackerReportV1_/computeEvaluativeIndexV1_/computeRelativeStrengthRankingV1_), not raw fetch+cache plumbing like Pass 2's refreshBrokerCourseDataCacheV1_ -- moving them would blur the fetch/analyze boundary the wrong way. Real Apps Script shared global scope means every real call site needed ZERO changes.

// ── Ticker watchlist, transcribed exactly from the user's own screenshot
//    (2026-08-31) — 14 categories, user's explicit confirmed choice over
//    inventing a different list or reusing docs/DEFAULT_WATCHLIST.md
//    (that one is a flat, 22-ticker PORTFOLIO list for test harnesses —
//    a different purpose, explicitly scoped elsewhere, not this). Some
//    tickers legitimately repeat across categories (e.g. TSLA in both
//    "Main Mega Cap" and "EV") — matches the screenshot exactly, not a
//    transcription error. ──────────────────────────────────────────────
// (var, not const -- top-level `const` bindings aren't reachable as
// `sandbox.X` properties from a Node `vm.runInContext` caller, a real
// harness quirk hit while testing this; identical real behavior in Apps
// Script either way, purely a test-visibility fix.)
var DARK_POOL_WATCHLIST_V1 = {
  'SPY/QQQ':               ['IVV','VOO','SPY','QQQ','DIA','IWM'],
  'Sector':                ['XLI','XLB','XBI','SOXX','XLF','SMH','XLE'],
  'ETFs':                  ['XBIL','IXN','IEUR','IGV','VXUS'],
  'World ETF':             ['EWJ','EPOL','EFA','IEFA','EFV','IEMG','EWZ'],
  'Main Mega Cap':         ['NFLX','GOOGL','GOOG','META','NVDA','AMZN','AAPL','AVGO','AMD','TSLA','CRM','MSFT'],
  'Technology':            ['ACN','KEYS','JBL','INGM','CTSH','G','NOK','CLS','HPE','CSCO','COHR','IONQ','APH'],
  'Crypto':                ['HODL','CORZ','IREN','IBIT'],
  'Semiconductors':        ['SLAB','MCHP','VSH','NXPI','AMKR','MPWR','KLAC','UMC','MRVL','ON','INTC','CRDO','TXN','QCOM','AMAT'],
  'EV':                    ['GM','TSLA','F'],
  'Communication Services (XLC)': ['CNK','ROKU','NWSA','CMCSA','RCI','WBD','VZ'],
  'Travel':                ['NCLH','CCL'],
  'Software':              ['TENB','RELY','APPF','WEX','ADP','KVYO','SNOW','DT','GDDY','U','FTNT','PANW','ORCL','UBER','NOW','NBIS','PLTR'],
  'Insurance':             ['STC','MFC','AON','UNM','OSCR'],
  'Biotech (XBI)':         ['GPCR','APGE','HRMY','HALO','CRNX','EXEL','DYN','ROIV','MRNA']
};

// ── FINRA OTC Transparency — real, free, LIVE-VERIFIED endpoint ────────
// Confirmed via a direct curl test (2026-08-31): HTTP 200, no API key/
// OAuth needed. This is a DIFFERENT, public endpoint from the OAuth-gated
// general query API described in FINRA's own developer.finra.org docs —
// don't confuse the two. `weekStartDate` and `tierIdentifier` are real
// partition keys; both must be EQUAL-filtered together or the API 400s.
var FINRA_ATS_WEEKLY_URL_V1 = 'https://api.finra.org/data/group/otcMarket/name/weeklySummary';

function finraCompareFilterV1_(fieldName, fieldValue) {
  return { compareType: 'EQUAL', fieldName: fieldName, fieldValue: fieldValue };
}

// Most recent Monday on/before `d` — FINRA's own `weekStartDate` is always
// a Monday (report start day).
function mostRecentMondayV1_(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffDays = (day === 0) ? 6 : (day - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffDays);
}

// Real, disclosed reason this probe exists: FINRA's own publish lag isn't
// a fixed offset (their spec says "~2-week delay" for Tier1, "~4-week
// delay" for Tier2/OTC, but real-world variance around holidays/processing
// means the exact most-recent-published Monday isn't reliably computable
// from today's date alone). Querying a too-recent week returns HTTP 204
// (no content), not an error — this walks backward, one real Monday at a
// time, until real data appears, bounded by MAX_WEEKS_BACK so a genuine
// outage degrades to null rather than looping forever.

// Real, concurrent batch fetch — same `UrlFetchApp.fetchAll()` pattern
// already validated in this project (`fetchHistoricalOHLCV_MacroBatch`,
// macro_fetchers_v0_8+.gs) rather than N sequential round-trips for N
// tickers. Same real, disclosed sequential-fallback-on-throw convention.

// Real per-ticker aggregate: prefer the FINRA-precomputed single
// `ATS_W_SMBL` row when present (avoids any double-count risk); otherwise
// sum the per-venue `ATS_W_SMBL_FIRM` rows. An empty/null `rows` input
// after a successful HTTP fetch means genuinely zero ATS activity that
// week for this ticker/tier — a real `0`, not a failure (distinguished by
// the caller, which only calls this when the fetch itself succeeded).
function extractAtsWeeklyShareV1_(rows) {
  if (!rows) return null;
  const agg = rows.find(r => r.summaryTypeCode === 'ATS_W_SMBL');
  if (agg) return agg.totalWeeklyShareQuantity || 0;
  const firmRows = rows.filter(r => r.summaryTypeCode === 'ATS_W_SMBL_FIRM');
  if (!firmRows.length) return 0;
  return firmRows.reduce((s, r) => s + (r.totalWeeklyShareQuantity || 0), 0);
}

// Reasoned, disclosed default — NOT empirically validated for this
// specific watchlist, same standing caveat as every other threshold in
// this project. Typical market-wide ATS (dark-pool) share runs roughly
// 12-15% of consolidated volume across S&P 500-class names (public,
// widely-cited FINRA/Cboe market-structure figures) — this flags rows
// meaningfully above that baseline, not an empirically backtested cutoff.
var DARK_POOL_ELEVATED_THRESHOLD_PCT_V1 = 0.20;

// ── Top-level builder ───────────────────────────────────────────────────
// Real, deliberate design: determines the latest-published week ONCE per
// tier (2 probe calls total), not per-ticker — FINRA's publish lag is a
// regulatory reporting deadline, the same for every ticker within a tier,
// not stock-specific. Every ticker then tries Tier1 first (most of this
// watchlist is mega-caps/ETFs/S&P500-class names), falling back to Tier2
// only on a real empty result — bounding this to at most 2 real FINRA
// network rounds total, not up to 170 individual requests.
function buildDarkPoolTrackerReportV1_(log) {
  const t1Week = findLatestPublishedFinraWeekV1_('T1');
  const t2Week = findLatestPublishedFinraWeekV1_('T2');
  if (log) log('Dark Pool Tracker: latest published week — Tier1 ' + (t1Week || 'n/a') + ', Tier2 ' + (t2Week || 'n/a'));
  // 2026-09-01, real fix: cache these so runAnalysisV7's own per-ticker
  // read (getTickerDarkPoolShareV1_ below) never has to repeat the
  // backward-probe walk — same cacheSet/cacheGet (PropertiesService)
  // mechanism already used elsewhere in this project (CIK/CUSIP/13F small
  // facts, futuresStockAnalysisV3_3_3.gs). TTL 30h -- survives until
  // tomorrow's trigger run refreshes it, same cadence as the data itself.
  if (t1Week) cacheSet('darkPoolFinraWeek_T1', t1Week, 30);
  if (t2Week) cacheSet('darkPoolFinraWeek_T2', t2Week, 30);

  const allTickers = [];
  Object.keys(DARK_POOL_WATCHLIST_V1).forEach(cat => {
    DARK_POOL_WATCHLIST_V1[cat].forEach(t => { if (allTickers.indexOf(t) === -1) allTickers.push(t); });
  });

  const t1Rows = t1Week ? fetchFinraAtsWeeklyBatchV1_(allTickers, 'T1', t1Week) : {};
  const needsT2 = allTickers.filter(t => !t1Rows[t] || !t1Rows[t].length);
  const t2Rows = (t2Week && needsT2.length) ? fetchFinraAtsWeeklyBatchV1_(needsT2, 'T2', t2Week) : {};

  const perTicker = {};
  allTickers.forEach(t => {
    const usedT1 = t1Rows[t] && t1Rows[t].length;
    const rows = usedT1 ? t1Rows[t] : (t2Rows[t] || null);
    const tier = usedT1 ? 'T1' : (t2Rows[t] ? 'T2' : null);
    const week = tier === 'T1' ? t1Week : (tier === 'T2' ? t2Week : null);
    perTicker[t] = { atsShareVolume: rows ? extractAtsWeeklyShareV1_(rows) : null, tier: tier, weekStartDate: week };
  });

  // Real weekly tape-volume approximation — reuses this project's own
  // already-cached `fetchYahooChart` (zero new data source for this half).
  allTickers.forEach(t => {
    const info = perTicker[t];
    let chart = null;
    try { chart = fetchYahooChart(t); } catch (e) { chart = null; }
    info.price = chart ? chart.currentPrice : null;
    if (info.atsShareVolume == null || !chart || !chart.volumes || chart.volumes.length < 5) {
      info.approxWeeklyTapeVolume = null; info.darkPoolSharePct = null; info.elevated = false;
      return;
    }
    const recentVol = chart.volumes.slice(-5).reduce((a, b) => a + b, 0);
    info.approxWeeklyTapeVolume = recentVol;
    info.darkPoolSharePct = recentVol > 0 ? (info.atsShareVolume / recentVol) : null;
    info.elevated = info.darkPoolSharePct != null && info.darkPoolSharePct > DARK_POOL_ELEVATED_THRESHOLD_PCT_V1;
  });

  return {
    generatedAt: new Date(),
    t1Week: t1Week, t2Week: t2Week,
    categories: Object.keys(DARK_POOL_WATCHLIST_V1).map(cat => ({
      category: cat,
      rows: DARK_POOL_WATCHLIST_V1[cat].map(t => Object.assign({ ticker: t }, perTicker[t] || {}))
    }))
  };
}

// ── Per-ticker live read, real fix 2026-09-01 ──────────────────────────
// User's own real, correct call: the 85-ticker watchlist tab is fine as a
// separate background scan, but the underlying DATA needs to actually
// reach the engine's real per-ticker analysis, not just sit in its own
// isolated tab. This is the consumption side: cache-only week lookup (no
// probe-walk on the interactive path, matching getCachedMacroRegime_'s
// own "cache-only" discipline) + exactly ONE live FINRA fetch for the
// SINGLE ticker actually being analyzed — cheap (not the 85-ticker batch),
// so it's safe to call synchronously inside runAnalysisV7, unlike the full
// watchlist scan. Works for ANY ticker, not just the ones in
// DARK_POOL_WATCHLIST_V1.
function getCachedFinraWeekV1_(tierIdentifier) {
  return cacheGet('darkPoolFinraWeek_' + tierIdentifier); // null if the daily trigger hasn't run/cached yet -- real, disclosed, non-fatal
}

// `chart` is the SAME already-fetched Yahoo chart object runAnalysisV7
// already has in scope for this ticker — zero new Yahoo call, matches the
// same reuse discipline as the 85-ticker version above.
function getTickerDarkPoolShareV1_(ticker, chart, log) {
  try {
    const t1Week = getCachedFinraWeekV1_('T1');
    const t2Week = getCachedFinraWeekV1_('T2');
    if (!t1Week && !t2Week) {
      if (log) log('Dark Pool: no cached FINRA week yet (daily trigger hasn\'t run) — skipped for ' + ticker);
      return null;
    }
    let rows = null, tier = null, week = null;
    if (t1Week) {
      const t1Result = fetchFinraAtsWeeklyBatchV1_([ticker], 'T1', t1Week);
      if (t1Result[ticker] && t1Result[ticker].length) { rows = t1Result[ticker]; tier = 'T1'; week = t1Week; }
    }
    if (!rows && t2Week) {
      const t2Result = fetchFinraAtsWeeklyBatchV1_([ticker], 'T2', t2Week);
      if (t2Result[ticker] && t2Result[ticker].length) { rows = t2Result[ticker]; tier = 'T2'; week = t2Week; }
    }
    const atsShareVolume = rows ? extractAtsWeeklyShareV1_(rows) : null;
    if (atsShareVolume == null || !chart || !chart.volumes || chart.volumes.length < 5) return null;
    const recentVol = chart.volumes.slice(-5).reduce((a, b) => a + b, 0);
    const darkPoolSharePct = recentVol > 0 ? (atsShareVolume / recentVol) : null;
    return {
      tier: tier, weekStartDate: week, atsShareVolume: atsShareVolume,
      darkPoolSharePct: darkPoolSharePct,
      elevated: darkPoolSharePct != null && darkPoolSharePct > DARK_POOL_ELEVATED_THRESHOLD_PCT_V1
    };
  } catch (e) {
    if (log) log('Dark Pool: per-ticker read failed for ' + ticker + ' (non-fatal): ' + (e && e.message ? e.message : e));
    return null;
  }
}

// ── Sheet writer ────────────────────────────────────────────────────────
const DARK_POOL_TRACKER_SHEET_NAME_V1 = '🌊 Dark Pool Tracker';

function writeDarkPoolTrackerSheetV1_(ss, report) {
  let sh = ss.getSheetByName(DARK_POOL_TRACKER_SHEET_NAME_V1);
  if (!sh) sh = ss.insertSheet(DARK_POOL_TRACKER_SHEET_NAME_V1);
  else { sh.clearContents(); sh.clearFormats(); }
  sh.setTabColor('#01579b');

  let row = 1;
  sh.getRange(row, 1, 1, 4).merge()
    .setValue('🌊 Dark Pool Tracker — updated ' + report.generatedAt.toLocaleString() +
      '  ·  FINRA OTC Transparency ATS data — Tier1 week ' + (report.t1Week || 'n/a') +
      ', Tier2 week ' + (report.t2Week || 'n/a') +
      '  ·  flagged = dark-pool share > ' + (DARK_POOL_ELEVATED_THRESHOLD_PCT_V1 * 100).toFixed(0) + '% (reasoned default, not backtested)')
    .setFontWeight('bold').setFontSize(11).setBackground('#01579b').setFontColor('#fff').setWrap(true);
  row += 2;

  report.categories.forEach(cat => {
    sh.getRange(row, 1, 1, 4).merge().setValue(cat.category).setFontWeight('bold').setBackground('#e1f5fe');
    row++;
    sh.getRange(row, 1, 1, 4).setValues([['Ticker', 'Dark Pool Vol (shares)', 'Price', 'Dark Pool %']]).setFontWeight('bold').setBackground('#f5f5f5');
    row++;
    cat.rows.forEach(r => {
      const pctDisplay = r.darkPoolSharePct != null ? (r.darkPoolSharePct * 100).toFixed(1) + '%' : 'n/a';
      const volDisplay = r.atsShareVolume != null ? r.atsShareVolume : 'n/a';
      const priceDisplay = r.price != null ? r.price : 'n/a';
      sh.getRange(row, 1, 1, 4).setValues([[r.ticker, volDisplay, priceDisplay, pctDisplay]]);
      if (r.elevated) sh.getRange(row, 1, 1, 4).setBackground('#ffcdd2').setFontColor('#b71c1c').setFontWeight('bold');
      row++;
    });
    row++;
  });

  sh.setColumnWidths(1, 4, 150);
  sh.setFrozenRows(1);
}

// ── Daily background trigger — same pattern as macro_fetchers_v0_11.gs's
//    refreshMacroRegimeCacheV1/installMacroRegimeCacheTriggerV1. Real,
//    disclosed non-fatal error handling: this runs unattended; a failure
//    here just leaves the sheet showing its last good data, never blocks
//    or crashes anything else in this project. ─────────────────────────
function refreshDarkPoolTrackerV1() {
  try {
    const report = buildDarkPoolTrackerReportV1_(Logger.log);
    writeDarkPoolTrackerSheetV1_(SpreadsheetApp.getActiveSpreadsheet(), report);
    Logger.log('refreshDarkPoolTrackerV1: sheet refreshed OK, Tier1 week ' + (report.t1Week || 'n/a') + ', Tier2 week ' + (report.t2Week || 'n/a') + '.');
  } catch (e) {
    Logger.log('refreshDarkPoolTrackerV1 failed (non-fatal, sheet keeps its last good data): ' + (e && e.message ? e.message : e));
  }
}

// Idempotent, same pattern as installMacroRegimeCacheTriggerV1/
// installDailyTriggerV7 — checks for an existing trigger with this
// handler name first so re-running this doesn't create duplicates.
function installDarkPoolTrackerTriggerV1() {
  const HANDLER = 'refreshDarkPoolTrackerV1';
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === HANDLER);
  if (existing.length > 0) {
    Logger.log('Dark Pool Tracker trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  ScriptApp.newTrigger(HANDLER).timeBased().everyDays(1).atHour(5).create();
  Logger.log('Dark Pool Tracker trigger installed: ' + HANDLER + ' at ~5:00 AM (before the 6 AM macro-regime cache and 7 AM daily-automation triggers).');
}

// v9.79, Edwards & Magee Ch38 -- real Evaluative Index (Magee's own later
// "MEI" term). The book's own real, precise construction: classify each
// stock in a representative basket as + (Bullish Major Trend) or -
// (Bearish), %Strong = count(+) / total x 100 -- a CONTINUOUS breadth
// gauge, explicitly not a discrete buy/sell signal (the book's own real,
// direct quote: "we do not speak, here, of signals... the Index will float
// and adjust itself continually"). Real, disclosed historical anchors
// (Magee's own real 1982-85 advisory-letter archive, Ch38): ~5-9% Strong
// has consistently corresponded to a real Major market Bottom; by real
// symmetry, ~90%+ Strong to a Major Top. Genuinely NOT built anywhere in
// this project before this (the existing macro regime read is a discrete
// risk-on/off classification off 9 ETFs, not a continuous cross-sectional
// breadth % off individual stocks). See docs/BIG_PLAN_EDWARDS_MAGEE.md
// Tier 2.
//
// Real, disclosed basket choice: reuses this project's own already-
// transcribed, real 85-ticker DARK_POOL_WATCHLIST_V1 (this same file,
// above) as the representative basket -- avoids inventing a new list from
// scratch, same "zero new data where real data already exists" discipline
// as every other addition in this project. Real, disclosed per-stock
// classification rule: a stock is "+"(Bullish) if its own SMA50 > SMA200
// (the exact same Golden/Death Cross convention this project's own main
// engine already uses), "-" otherwise -- the book's own real language is
// "moving in a Bullish Major Trend," and SMA50-vs-SMA200 is this project's
// own already-established real proxy for exactly that condition.
//
// REAL, DISCLOSED execution-cost note: classifying 85 tickers means 85
// real fetchYahooChart calls -- reuses that function's OWN real per-ticker
// price cache (same one darkPoolTrackerV1.gs's own 85-ticker scan above
// already relies on), so a same-day rerun after either trigger has already
// warmed the cache costs far less. Still real, disclosed non-trivial
// execution time -- run as its OWN isolated daily trigger (never from the
// interactive path), same architecture as refreshDarkPoolTrackerV1 itself.
function computeEvaluativeIndexV1_() {
  try {
    const tickers = [];
    Object.keys(DARK_POOL_WATCHLIST_V1).forEach(cat => {
      DARK_POOL_WATCHLIST_V1[cat].forEach(t => { if (tickers.indexOf(t) === -1) tickers.push(t); });
    });
    let strong = 0, weak = 0, unavailable = 0;
    tickers.forEach(t => {
      let chart = null;
      try { chart = fetchYahooChart(t); } catch (e) { chart = null; }
      if (!chart || !chart.closes || chart.closes.length < 200) { unavailable++; return; }
      const closes = chart.closes;
      const sma = (n) => closes.slice(-n).reduce((a,b)=>a+b,0) / n;
      if (sma(50) > sma(200)) strong++; else weak++;
    });
    const total = strong + weak;
    const pctStrong = total > 0 ? (strong / total * 100) : null;
    // Real, disclosed anchors from Magee's own real archive (Ch38, Diagram
    // 10.1) -- ~5-9% Strong at real Major Bottoms; symmetric ~90%+ read by
    // the same real logic, not itself independently confirmed by the book
    // (the book's own real worked examples are all Bottom-side).
    const read = pctStrong == null ? 'unavailable' : pctStrong <= 9 ? 'OVERSOLD (real historical Bottom-zone anchor)' : pctStrong >= 91 ? 'OVERBOUGHT (symmetric complement of the Bottom-zone anchor)' : 'neutral';
    return { pctStrong, strong, weak, unavailable, total: tickers.length, read, asOfDate: new Date() };
  } catch (e) { return { pctStrong: null, strong: 0, weak: 0, unavailable: 0, total: 0, read: 'unavailable', asOfDate: null }; }
}

// Same real "isolated daily trigger, non-fatal, sheet/cache keeps its last
// good data on failure" discipline as refreshDarkPoolTrackerV1 above.
function refreshEvaluativeIndexV1() {
  try {
    const result = computeEvaluativeIndexV1_();
    cacheSet('evaluativeIndexV1', result, 30);
    Logger.log('refreshEvaluativeIndexV1: %Strong=' + (result.pctStrong != null ? result.pctStrong.toFixed(1) + '%' : 'n/a') + ' (' + result.strong + '+/' + result.weak + '-, ' + result.unavailable + ' unavailable) -- ' + result.read);
  } catch (e) {
    Logger.log('refreshEvaluativeIndexV1 failed (non-fatal, cache keeps its last good data): ' + (e && e.message ? e.message : e));
  }
}

// Cache-only reader for the interactive path -- same "never live-fetch 85
// tickers on the interactive path" discipline as every other cached macro
// read in this project.
function getCachedEvaluativeIndexV1_() {
  return cacheGet('evaluativeIndexV1'); // null if the trigger hasn't run/cached yet -- real, disclosed, non-fatal
}

// Idempotent, same pattern as installDarkPoolTrackerTriggerV1 just above.
function installEvaluativeIndexTriggerV1() {
  const HANDLER = 'refreshEvaluativeIndexV1';
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === HANDLER);
  if (existing.length > 0) {
    Logger.log('Evaluative Index trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  ScriptApp.newTrigger(HANDLER).timeBased().everyDays(1).atHour(5).nearMinute(30).create();
  Logger.log('Evaluative Index trigger installed: ' + HANDLER + ' at ~5:30 AM (after the 5 AM Dark Pool Tracker trigger, before the 6 AM macro-regime cache).');
}

// v9.85, Edwards & Magee Appendix E (Turtle System) -- real Tier 3 item,
// docs/BIG_PLAN_EDWARDS_MAGEE.md. User's own explicit choice (2026-09-02):
// full peer/sector RANKING, not just the single-ticker score. Real book
// rule: "buy the strongest, short the weakest" within a correlated group,
// using the real formula `(CurrentPrice - PriceNMonthsAgo) / CurrentN`.
//
// Real, disclosed basket reuse: this project's own already-transcribed
// 14-category DARK_POOL_WATCHLIST_V1 (this same file, above) IS a real,
// ready-made "correlated group" universe -- zero new peer list invented,
// same "reuse real data that already exists" discipline as the Evaluative
// Index's own basket reuse (v9.80). A ticker outside all 14 categories
// simply has no known peer group under this design -- real, disclosed,
// graceful `null` return, not a fabricated fallback group.
//
// REAL, DISCLOSED execution-architecture choice (revised 2026-09-02, user's
// own explicit answer when asked): CACHE-ONLY, same isolated-daily-trigger
// architecture as the Evaluative Index (v9.80) and Dow Theory (v9.79), NOT
// the interactive per-ticker path. Real reason: this computation needs up
// to 14 real `fetchYahooChart` calls per invocation (the biggest real
// category's own peer count) -- the same class of multi-ticker live-fetch
// load that caused a real hang in the macro-regime path before it was
// converted to cache-only (see fullStockAnalysisV9_84.gs's own
// getCachedMacroRegime_ comment). The single-fetch darkPoolShare precedent
// (step 6.5, interactive) does NOT generalize to a multi-peer ranking.
// `refreshRelativeStrengthRankingV1_`/`getCachedRelativeStrengthRankingV1_`/
// `installRelativeStrengthRankingTriggerV1` below implement the cache-only
// wrapper; `computeRelativeStrengthRankingV1_` itself is unchanged (still
// the real, tested per-ticker core -- it's just never called live from
// runAnalysisV7 now).
//
// REAL, DISCLOSED lookback choice: the book's own real language is "N
// months ago" without pinning an exact N -- 3 months (one quarter, ~63
// trading days) used here as a reasoned default (a standard relative-
// strength lookback convention), not independently backtested, same
// standing caveat as every other threshold in this project.
function computeRelativeStrengthRankingV1_(ticker) {
  try {
    const categories = Object.keys(DARK_POOL_WATCHLIST_V1).filter(cat => DARK_POOL_WATCHLIST_V1[cat].indexOf(ticker) > -1);
    if (!categories.length) return null; // real, disclosed: ticker not in any known correlated group
    const peers = [];
    categories.forEach(cat => DARK_POOL_WATCHLIST_V1[cat].forEach(t => { if (peers.indexOf(t) === -1) peers.push(t); }));
    const N_MONTHS = 3, TRADING_DAYS_PER_MONTH = 21; // same real convention trendMaturityV7 already uses
    const scored = [];
    peers.forEach(t => {
      let chart = null;
      try { chart = fetchYahooChart(t); } catch (e) { chart = null; }
      if (!chart || !chart.closes || chart.closes.length < N_MONTHS*TRADING_DAYS_PER_MONTH + 21) return; // real, disclosed: needs enough real history for both the lookback AND a real N (20-day) computation
      const closes = chart.closes, highs = chart.highs, lows = chart.lows, n = closes.length;
      const idxAgo = n - 1 - N_MONTHS*TRADING_DAYS_PER_MONTH;
      const priceAgo = closes[idxAgo];
      if (priceAgo == null) return;
      // Real N (20-day Wilder-smoothed True Range) -- SAME formula as this
      // project's own already-shipped ind.turtleN (v9.78), reused per-peer
      // here since each peer needs its own real N, not the analyzed
      // ticker's.
      const trArr = []; for (let i = 1; i < n; i++) trArr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
      const peerN = wilderSmooth(trArr, 20) || 0.0001;
      scored.push({ ticker: t, score: (closes[n-1] - priceAgo) / peerN });
    });
    if (!scored.some(s => s.ticker === ticker)) return null; // real, disclosed: the analyzed ticker itself needs a valid real score too
    scored.sort((a,b) => b.score - a.score); // strongest first, book's own real ordering
    const rank = scored.findIndex(s => s.ticker === ticker) + 1;
    const total = scored.length;
    const percentile = Math.round((1 - (rank-1)/total) * 100); // 100=strongest, 0=weakest
    // Real, disclosed framing: this user's own standing strategy is long-
    // only/calls-only (memory trading-strategy-long-only-calls) -- the
    // book's own real "short the weakest" half is deliberately NOT
    // surfaced as a recommendation; relative weakness is framed as a real
    // caution only, never a short signal.
    const read = percentile >= 80 ? 'STRONG -- among the strongest in its real peer group'
      : percentile <= 20 ? 'WEAK -- among the weakest in its real peer group (a real caution, not a short signal -- this project is long-only/calls-only)'
      : 'middling within its real peer group';
    return { categories, peerCount: total, rank, percentile, read, topPeers: scored.slice(0,3), bottomPeers: scored.slice(-3).reverse() };
  } catch (e) { return null; }
}

// Same real "isolated daily trigger, non-fatal, cache keeps its last good
// data on failure" discipline as refreshEvaluativeIndexV1 just above.
// Computes every real ticker's own ranking once (union of all 14
// categories, same real union DARK_POOL_WATCHLIST_V1/Evaluative Index
// already build) and caches the whole map -- getCachedRelativeStrengthRankingV1_
// below is then a pure map lookup, zero live fetches, for any ticker.
function refreshRelativeStrengthRankingV1_() {
  try {
    const tickers = [];
    Object.keys(DARK_POOL_WATCHLIST_V1).forEach(cat => {
      DARK_POOL_WATCHLIST_V1[cat].forEach(t => { if (tickers.indexOf(t) === -1) tickers.push(t); });
    });
    const map = {};
    let computed = 0, nulls = 0;
    tickers.forEach(t => {
      const r = computeRelativeStrengthRankingV1_(t);
      if (r) { map[t] = r; computed++; } else { nulls++; }
    });
    cacheSet('relativeStrengthRankingV1', map, 30);
    Logger.log('refreshRelativeStrengthRankingV1_: ' + computed + '/' + tickers.length + ' tickers ranked (' + nulls + ' insufficient data).');
  } catch (e) {
    Logger.log('refreshRelativeStrengthRankingV1_ failed (non-fatal, cache keeps its last good data): ' + (e && e.message ? e.message : e));
  }
}

// Cache-only reader for the interactive path -- same "never live-fetch a
// multi-ticker load on the interactive path" discipline as every other
// cached macro/basket read in this project (getCachedEvaluativeIndexV1_,
// getCachedDowTheoryConfirmationV1_, getCachedMacroRegime_).
function getCachedRelativeStrengthRankingV1_(ticker) {
  const map = cacheGet('relativeStrengthRankingV1');
  return (map && map[ticker]) ? map[ticker] : null; // null if the trigger hasn't run/cached yet, or ticker not in any known category -- real, disclosed, non-fatal
}

// Idempotent, same pattern as installEvaluativeIndexTriggerV1 just above.
// Staggered to run after Evaluative Index (5:30) and before the 6 AM
// macro-regime cache, so a same-day rerun benefits from whatever
// fetchYahooChart cache Evaluative Index already warmed for shared tickers.
function installRelativeStrengthRankingTriggerV1() {
  const HANDLER = 'refreshRelativeStrengthRankingV1_';
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === HANDLER);
  if (existing.length > 0) {
    Logger.log('Relative Strength Ranking trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  ScriptApp.newTrigger(HANDLER).timeBased().everyDays(1).atHour(5).nearMinute(45).create();
  Logger.log('Relative Strength Ranking trigger installed: ' + HANDLER + ' at ~5:45 AM (after Evaluative Index, before the 6 AM macro-regime cache).');
}
