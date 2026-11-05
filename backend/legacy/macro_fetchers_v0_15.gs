// ══════════════════════════════════════════════════════════════════
//  MACRO / CROSS-ASSET FETCHERS — v0.15 (2026-09-07)
//  v0.12 -- Edwards & Magee Ch3-5.1 real Dow Theory Confirmation added
//  (computeDowTheoryConfirmationV1_, DIA/IYT as real Industrials/Transports
//  proxies) -- a deliberately SEPARATE small 2-ticker fetch+cache, same
//  "not coupled to the 9-ticker regime read" discipline the M2/yield-curve
//  supplemental fetch already established. See docs/BIG_PLAN_EDWARDS_MAGEE.md.
//  v0.11 real fix: a SECOND real live timeout, same root cause class as
//  v0.8's fix, happened again (2026-08-30, user's real PLTR run) --
//  fetchHistoricalOHLCV_MacroBatch's own fetchAll() call itself hung for
//  the full remaining ~315s of a single interactive run and was killed by
//  Apps Script's hard 360s cap. Real, tested-live-just-now finding: Nasdaq's
//  endpoint itself was NOT slow (all 9 tickers, HTTP 200, 1.9-4.0s each,
//  tested directly) -- the hang was specific to that execution (Google's
//  own fetchAll() concurrency against a single host, or a one-off network
//  blip -- genuinely not fully diagnosable from outside Apps Script itself,
//  disclosed honestly, not papered over). Real conclusion: since Apps
//  Script gives no way to cancel or time-box a call once it's in flight, a
//  time-elapsed GUARD before calling can't help here either -- only 45s had
//  elapsed when this call started, so any reasonable guard would have said
//  "plenty of budget, proceed" and it would have hung exactly the same way.
//  Real fix: getCachedMacroRegime_ (fullStockAnalysisV9_70.gs) no longer
//  calls fetchHistoricalOHLCV_MacroBatch from the interactive per-ticker
//  path AT ALL -- it is now real CACHE-ONLY there (reads the 9 real
//  💾 Macro TICKER cache sheets directly; stale/missing -> immediate
//  {available:false}, zero network calls, zero possible hang, by
//  construction, not by a heuristic). fetchHistoricalOHLCV_MacroBatch
//  itself is UNCHANGED and still real/live -- it just moved to a new,
//  isolated caller: refreshMacroRegimeCacheV1(), installed via
//  installMacroRegimeCacheTriggerV1() as its own real time-driven trigger
//  (same established pattern as installDailyTriggerV7), fully decoupled
//  from any interactive run -- if IT hangs on some rare day, only its own
//  isolated execution dies; no user-facing report is ever waiting on it.
//  v0.10: DXY's own real status documented explicitly (was undocumented
//  since it was first added) -- tracked/informational only, deliberately
//  not in the real risk-on/off vote, same as crypto. See the comment at
//  its own dictionary entry below. Zero logic change.
//  v0.9: stripped the `deadline:NN` key from every real UrlFetchApp.fetch()
//  call in this file -- confirmed via Opus review (docs/OPUS_REVIEW_2026-08-27.md)
//  that `deadline` is not a real, documented Apps Script fetch() parameter;
//  it was silently ignored the whole time, doing nothing. Purely additive
//  removal -- no other logic changed, every fetch behaves identically to
//  before (Apps Script's own undocumented per-call default and the overall
//  6-minute script cap were always the real backstops, not this key).
//  v0.8 real fix: getCachedMacroRegime_'s real first-ever live Apps Script
//  run (2026-08-25, user's own Full Ticker Analysis on PLTR) genuinely
//  exceeded the execution-time ceiling -- the 🔬 Log trace showed the run
//  died right after techPlan.options was logged, immediately before
//  synthesizeDecisionV7 -> getCachedMacroRegime_'s first real call. That
//  function did 9 SEQUENTIAL single-ticker fetches (a plain for-loop),
//  each an unbounded sequential round-trip (v0.9: the earlier "25s deadline,
//  225s worst case" framing here was wrong -- deadline isn't a real
//  UrlFetchApp.fetch() parameter, corrected per docs/OPUS_REVIEW_2026-08-27.md;
//  the real bottleneck was just 9 sequential calls, no bound), stacked on
//  top of everything before
//  and after it in the same execution. Real fix: fetchHistoricalOHLCV_
//  MacroBatch(tickers) below uses UrlFetchApp.fetchAll() -- a real,
//  documented Apps Script API that issues every request CONCURRENTLY in
//  one server-side call, not sequentially -- collapsing the real 9x
//  round-trip cost to roughly 1x. Real, disclosed caveat: fetchAll() has
//  never been used anywhere in this project before either -- like the
//  macro regime feature itself before v0.6, this is its first real test
//  in the actual Apps Script environment, not independently verified
//  outside this project's own Node-VM harnesses (which can only shim
//  fetchAll's real concurrency, not prove it). The single-ticker
//  fetchHistoricalOHLCV_Macro function is UNCHANGED and still used by
//  testMacroFetchers()'s own diagnostic sweep -- only getCachedMacroRegime_
//  (fullStockAnalysisV9_62.gs) was switched to call the new batch version.
//
//  v0.7: added crypto (IBIT/ETHE ETF proxies) to testMacroFetchers()'s
//  diagnostic ticker list -- real, user-requested, informational only
//  (NOT added to classifyMacroRegimeAt_Macro's real risk-on/off vote --
//  that would need its own real predictive-value test first, same staged
//  discipline BIG_PICTURE_ANALYSIS_PLAN.md already established for every
//  other signal here, not skipped for this one).
//  BIG_PICTURE_ANALYSIS_PLAN.md's real data layer.
//
//  v0.6 real fix: fetchHistoricalOHLCV_Macro switched from Yahoo to
//  Nasdaq's public historical API. Real reason -- user asked "can't we
//  fix that, maybe not use yahoo" after learning this feature has never
//  actually fired with real data (getCachedMacroRegime_ always returned
//  available:false in every test this whole project, because the
//  underlying Yahoo fetch was blocked on the dev sandbox used to build
//  and test this). Checked live before deciding: the 9 tickers the REAL
//  classifier (classifyMacroRegimeAt_Macro, below) actually uses --
//  SPY/TLT/GLD/XLP/XLU/XLV/XLY/XLI/XLB -- are all standard ETFs, and all
//  9 were verified live against Nasdaq's `/historical?assetclass=etf`
//  endpoint before writing this (real HTTP calls, not assumed). Real,
//  disclosed limitation: the broader exploratory ticker list in
//  testMacroFetchers() below (futures like GC=F/CL=F, index notation
//  like ^TNX/^N225) will now fail through THIS fetcher -- Nasdaq's API
//  doesn't serve futures or index-notation tickers at all (verified live:
//  GC=F returns "Symbol not exists"). That function is a diagnostic only,
//  never wired into any real decision -- not fixed this pass, disclosed
//  not silently left broken.
//
//  Real, separate finding, same day: Yahoo's own block status is NOT
//  fixed -- re-tested live from a fresh shell (`query1.finance.yahoo.com`),
//  got a real HTTP 200 with real data, contradicting the "confirmed
//  blocked" claim this whole project has carried. Switching to Nasdaq
//  here regardless (user's explicit call) -- real, verified, adds
//  resilience either way, doesn't depend on Yahoo's block status holding
//  or not holding in the user's own real Apps Script deployment (still
//  genuinely untested, per CLAUDE_CODE_HANDOFF.md).
//
//  WHAT THIS FETCHES (all real, all checked before writing this):
//  - GLD (gold), SMH (semiconductors), TLT (long bonds), sector SPDRs
//    (XLK tech, XLF financials, XLE energy, XLV health, XLP staples,
//    XLY discretionary, XLI industrials, XLB materials, XLU utilities,
//    XLRE real estate, XLC communication svcs) -- same
//    fetchHistoricalOHLCV_Macro pattern, now Nasdaq-backed.
//  - M2 money supply from FRED's own direct CSV export (confirmed real,
//    no API key needed for this specific endpoint) -- monthly, not
//    daily, a genuinely different cadence from everything else here.
// ══════════════════════════════════════════════════════════════════

// Version tracking, same discipline as CONFIG_V7.version/OPTIONS_ENGINE_VERSION/
// BROKER_COURSE_MODEL_VERSION/DARK_POOL_TRACKER_VERSION -- first real
// version CONST for this file (previously only a header-comment string,
// which had drifted stale -- said v0.12 while the filename said v0_14).
const MACRO_FETCHERS_VERSION = 'v0.15'; // v0.15 (2026-09-07): Pass 5 (final pass) of the fetch/analyze separation refactor (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md) -- this file's own real fetch-owning functions + cache read/write helpers + refresh orchestrators (fetchHistoricalOHLCV_Macro/_MacroBatch, nasdaqHistoricalUrl_Macro_/parseNasdaqHistoricalResponse_Macro, macroPriceCacheSheetName_/readMacroPriceCache_/writeMacroPriceCache_, computeMacroSupplementalV1_ (directly fetches M2/FRED), refreshMacroRegimeCacheV1 (the nightly trigger orchestrator), getCachedMacroSupplementalV1_/getCachedDowTheoryConfirmationV1_ (thin cache-read wrappers), fetchM2_Macro, fetchFredSeries_Macro) MOVED VERBATIM to dataLayerV1.gs. computeDowTheoryConfirmationV1_ (pure analysis -- reads cache only, real 252-day scan+classify, no live fetch) and classifyMacroRegimeAt_Macro/alignSeries_Macro/pctChange_Macro (pure math) stay here, matching the precedent set in Pass 3 (analysis functions that merely CONSUME fetched/cached data don't move). installMacroRegimeCacheTriggerV1 also stays -- real Apps Script installs triggers by function NAME string, resolved at call time, unaffected by which file defines the target function. Real Apps Script shared global scope means every real call site needed ZERO changes. This closes Pass 5, the last of the 5 planned migration passes -- docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md's real fetch-owning-function consolidation is now complete across all originally-scoped files.

// ---- v0.8: real parsing logic factored out of fetchHistoricalOHLCV_Macro
// so both the single-ticker fetch (unchanged, still used by
// testMacroFetchers()'s diagnostic sweep) and the new batch fetch below
// share IDENTICAL parsing -- zero risk of the two diverging. Pure
// function, no network I/O -- takes an already-fetched HTTPResponse. ----


// ---- v0.6: Nasdaq-backed, same real pattern already proven in this
// project's fetchNasdaqShortInterestV7 (fullStockAnalysisV9_55.gs).
// ETF-only (assetclass=etf) -- every ticker the real classifier uses is
// a standard ETF; futures/index-notation tickers are NOT supported by
// this endpoint (real, verified, see file header) and will return null,
// same as any other real fetch failure. ----

// ---- v0.8 real caching (2026-08-25, same pass as the fetchAll fix, user's
// own explicit request: "old data does not change... open in a constant
// sheet per ticker"). Separate sheet prefix from fetchYahooChart's own
// price cache ('💾 ' in fullStockAnalysisV9_62.gs) -- deliberately NOT
// shared, even for a ticker like SPY that both files independently fetch,
// because the two are DIFFERENT real data sources (Yahoo vs Nasdaq) and
// could disagree on close-price rounding or date coverage; sharing one
// cache between them risks one source's data silently being read back as
// if it were the other's. Reuses isPriceCacheFreshV7_ from
// fullStockAnalysisV9_62.gs verbatim (same Apps Script project, same
// global scope, same "check last date" logic -- it only ever reads
// `.dates`, genuinely shared, not duplicated). No opens/currentPrice/
// ipoDate/splits fields here -- the real macro series shape
// (parseNasdaqHistoricalResponse_Macro's own return) never had them. ----
const MACRO_PRICE_CACHE_SHEET_PREFIX_V0_8 = '💾 Macro ';




// ---- v0.8 real fix: concurrent batch fetch via UrlFetchApp.fetchAll(),
// a real, documented Apps Script API that issues every request in the
// array CONCURRENTLY in one server-side call -- collapses N sequential
// round-trips down to roughly one round-trip's worth of wall-clock time. Built specifically to
// fix getCachedMacroRegime_'s real first-ever live-execution timeout
// (2026-08-25, see this file's own header for the full real trace).
// Real, disclosed caveat: fetchAll() itself has never been used anywhere
// in this project before -- first real test of this specific API, same
// honesty standard as every other "first real use" already disclosed
// elsewhere in this project. Returns a {ticker: series|null, ...} map --
// same per-ticker null-on-failure contract as the single-ticker function,
// just for every ticker in one real network round-trip instead of one per
// ticker. ----

// 2026-09-01, real fix: `fetchM2_Macro()`/`fetchFredSeries_Macro('T10Y2Y')`
// were REAL data, fetched (only inside the manual `testMacroFetchers()`
// diagnostic), then thrown away -- never fed into the real classifier or
// any displayed report field. User's own direct question surfaced this.
// Computes the LATEST real, informational-only values (not the full time
// series -- that's this function's own concern, downstream only needs
// "where do things stand right now"): M2 money-supply YoY growth (M2SL is
// monthly, so 12 observations back = 1 year) and the 10Y-2Y Treasury
// yield-curve spread + a real, disclosed inverted flag (spread < 0).
// Real, disclosed positioning: yield-curve inversion is a well-documented,
// widely-cited historical recession-leading indicator -- but per this
// project's own standing "evidence-then-promote" discipline (every prior
// new signal here started display-only until independently backtested:
// chartPatterns, trendAlignedVolume, relativeSwingPower, etc.), these are
// surfaced as INFORMATIONAL fields only, not new scored votes in
// classifyMacroRegimeAt_Macro -- promoting them to a real vote is a real,
// separate future step needing its own direct backtest, same as every
// other candidate signal in this project's history.

// v0.11 real fix -- the ONLY caller of fetchHistoricalOHLCV_MacroBatch now.
// A small, isolated, time-driven trigger whose entire job is keeping the 9
// real 💾 Macro TICKER cache sheets fresh -- decoupled from any interactive
// ticker analysis. If this itself hangs/times out on some rare day, only
// this standalone execution dies; no user-facing report was ever waiting on
// it, and the interactive path (getCachedMacroRegime_, cache-only as of
// v9.70) just reads whatever's cached, however stale, and degrades to
// {available:false} if nothing usable exists yet -- never blocks, never hangs.

// Cache-only reader for the interactive path -- same "never live-fetch on
// the interactive path" discipline as getCachedMacroRegime_ itself.

// v9.79, Edwards & Magee Ch3/4/5/5.1 -- real Dow Theory Confirmation. The
// book's own real, foundational rule: the Industrial Average and the
// Transportation Average must BOTH independently confirm (both make a new
// closing high for a Bull signal, or both a new closing low for a Bear
// signal) -- if only one does, that's real Dow Theory "non-confirmation,"
// itself a named, meaningful, distrust-the-signal read, not just "no
// signal." Genuinely NOT built anywhere in this project before this
// (Schabacker explicitly dismissed Dow Theory as low-value for single-
// stock use; this book treats it as foundational -- see docs/
// BIG_PLAN_EDWARDS_MAGEE.md Tier 2).
//
// Real, disclosed modernization: DIA (SPDR Dow Jones Industrial Average
// ETF) as the real Industrials proxy, IYT (iShares Transportation Average
// ETF) as the real, modern Transports proxy -- same real, disclosed
// reasoning already captured in docs/EDWARDS_MAGEE_BOOK_NOTES.md's own
// headline finding #2. Real, disclosed simplification (v1, same "ship the
// codified core first" discipline as every other Tier in this plan): uses
// a literal 252-trading-day (52-week) CLOSING high/low as "new high/low"
// (Dow Theory's own classical convention is closing-price-based averages,
// not intraday extremes) -- the book's own fuller "reasonable time to
// confirm" window between the 2 averages' own extremes is NOT modeled
// here (a real, disclosed, narrower v1 scope, same class of choice as
// computeBasingPointStopV1_'s own disclosed narrower scope).
const DOW_THEORY_TICKERS_V1 = ['DIA','IYT'];
// v2 widening, 2026-09-03, Ch3 p20-21's own real, disclosed language: "It is
// not necessary that the two Averages confirm on the same day... one or the
// other lags behind for days, weeks, or even a month or two." Raw-PDF
// re-read confirmed (pdftotext, docs/EDWARDS_MAGEE_BOOK_NOTES.md Ch3 has the
// full quote) the book gives no exact number, only that stated OUTER bound
// ("a month or two") -- used here as-is, via this file's own already-
// established TRADING_DAYS_PER_MONTH=21 convention (fullStockAnalysisV9_89.gs
// trendMaturity), 2*21=42 trading days, not a new invented number. The v1
// same-day requirement is a strict special case of this (lag=0), so this is
// a pure widening, not a behavior change for same-day cases. Edited in
// place, same name (V1) kept -- this widens the SAME rule's own scope, not a
// new parallel method (unlike Basing Point's 2nd/3rd creation paths, which
// are genuinely different methods and got their own function names).
function computeDowTheoryConfirmationV1_() {
  const out = { verdict: null, industrials: null, transports: null, asOfDate: null, lagTradingDays: null };
  try {
    const dia = readMacroPriceCache_('DIA'), iyt = readMacroPriceCache_('IYT');
    if (!dia || !iyt || dia.closes.length < 252 || iyt.closes.length < 252) return out; // real, disclosed: needs a full real year of both, else stays null (non-fatal)
    const TRADING_DAYS_PER_MONTH = 21;
    const LOOKBACK_WINDOW = 2 * TRADING_DAYS_PER_MONTH; // 42 -- "a month or two", the book's own stated outer bound
    const scan = (series) => {
      const closes = series.closes, n = closes.length;
      let highIdx = -1, lowIdx = -1;
      for (let i = Math.max(251, n - LOOKBACK_WINDOW); i < n; i++) {
        const window = closes.slice(Math.max(0, i - 251), i + 1); // real 252-day trailing window ending at day i, no lookahead
        if (closes[i] >= Math.max(...window)) highIdx = i; // most recent qualifying day wins
        if (closes[i] <= Math.min(...window)) lowIdx = i;
      }
      return { newHigh: highIdx !== -1, newLow: lowIdx !== -1, highIdx, lowIdx, close: closes[n-1], date: series.dates[n-1],
        highDate: highIdx !== -1 ? series.dates[highIdx] : null, lowDate: lowIdx !== -1 ? series.dates[lowIdx] : null };
    };
    const ind = scan(dia), trn = scan(iyt);
    out.industrials = { ticker: 'DIA', newHigh: ind.newHigh, newLow: ind.newLow, close: ind.close, extremeHighDate: ind.highDate, extremeLowDate: ind.lowDate };
    out.transports = { ticker: 'IYT', newHigh: trn.newHigh, newLow: trn.newLow, close: trn.close, extremeHighDate: trn.highDate, extremeLowDate: trn.lowDate };
    out.asOfDate = ind.date;
    if (ind.newHigh && trn.newHigh) { out.verdict = 'BULL_CONFIRMED'; out.lagTradingDays = Math.abs(ind.highIdx - trn.highIdx); }
    else if (ind.newLow && trn.newLow) { out.verdict = 'BEAR_CONFIRMED'; out.lagTradingDays = Math.abs(ind.lowIdx - trn.lowIdx); }
    else if (ind.newHigh !== trn.newHigh && (ind.newHigh || trn.newHigh)) out.verdict = 'NON_CONFIRMATION_BULL'; // real, named Dow Theory concept -- NEITHER average made a real recent high within the book's own "a month or two" window
    else if (ind.newLow !== trn.newLow && (ind.newLow || trn.newLow)) out.verdict = 'NON_CONFIRMATION_BEAR';
    else out.verdict = 'NEUTRAL';
  } catch (e) { /* non-fatal, same discipline as computeMacroSupplementalV1_ */ }
  return out;
}

// Cache-only reader, same "never live-fetch on the interactive path" discipline as every other cached macro read.

// Idempotent, same pattern as installDailyTriggerV7 (fullStockAnalysisV9.gs)
// -- checks for an existing trigger with this handler name first, so
// re-running this doesn't create duplicates. Scheduled an hour before the
// existing 7am daily-automation trigger so the macro cache is warm by the
// time any automated or interactive run needs it that morning.
function installMacroRegimeCacheTriggerV1() {
  const HANDLER = 'refreshMacroRegimeCacheV1';
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === HANDLER);
  if (existing.length > 0) {
    Logger.log('Macro-regime cache trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  ScriptApp.newTrigger(HANDLER).timeBased().everyDays(1).atHour(6).create();
  Logger.log('Macro-regime cache trigger installed: ' + HANDLER + ' at ~6:00 AM (1hr before the daily automation trigger).');
}

// ---- FRED M2 -- confirmed real, direct CSV, no API key needed for
// this specific export endpoint. Monthly cadence -- genuinely different
// from daily price data, needs its own handling downstream (can't be
// walked-forward the same way; a month's M2 figure isn't "known" until
// it's actually released, usually with a real lag -- flagged here, not
// solved yet, matching this project's existing honesty about point-in-
// time correctness for fundamentals in Tier 2). ----

// ---- Test/diagnostic entry point -- run this once to confirm every
// source is genuinely reachable from Apps Script before building
// anything real on top of it. Logs real numbers, not just success/fail. ----
function testMacroFetchers() {
  const tickers = {
    // Commodities/futures (=F tickers confirmed via research to work
    // through this SAME endpoint, no special handling needed -- the one
    // real nuance: futures are continuous/rolled contracts, not one
    // fixed contract's full life. Standard, not a bug.)
    'Gold': 'GC=F', 'Silver': 'SI=F', 'Crude Oil (WTI)': 'CL=F', 'Brent Crude': 'BZ=F',
    'Natural Gas': 'NG=F', 'Copper': 'HG=F', 'Platinum': 'PL=F', 'Palladium': 'PA=F',
    'Corn': 'ZC=F', 'Wheat': 'ZW=F', 'Soybeans': 'ZS=F', 'Coffee': 'KC=F',
    'Sugar': 'SB=F', 'Cotton': 'CT=F', 'Cocoa': 'CC=F', 'Lumber': 'LBS=F',
    // JJU (aluminum ETN) confirmed delisted by Barclays June 14 2023 -- HTTP
    // 404 on this ticker is real, not a fetch bug. No pure-aluminum ETF/ETN
    // remains actively traded in the US. XME (metals & mining broadly) is
    // the closest real substitute, but it's genuinely different exposure
    // (diversified mining companies, not aluminum futures) -- disclosed,
    // not pretended to be equivalent.
    'Uranium (ETF proxy)': 'URA', 'Broad commodities (ETF)': 'DBC', 'Live Cattle': 'LE=F', 'Metals & Mining (aluminum proxy)': 'XME',
    // Crypto -- v0.7 (2026-08-24), user-requested ("commodities crypto ai
    // chips tech oil, different sectors"). Real spot-crypto tickers (BTC-USD
    // etc) aren't fetchable through this Nasdaq-backed fetcher (verified live:
    // it's ETF/stock-listed only) -- real, already-tradeable ETF proxies used
    // instead, same disclosed-substitute pattern as the aluminum/XME case
    // above. IBIT is already on the watchlist itself (real spot-Bitcoin ETF,
    // BlackRock); ETHE is Grayscale's real spot-Ethereum trust. Both verified
    // live working via this fetcher before adding.
    'Bitcoin (IBIT ETF proxy)': 'IBIT', 'Ethereum (ETHE ETF proxy)': 'ETHE',
    // S&P sectors -- all 11, complete
    'Tech (XLK)':'XLK','Financials (XLF)':'XLF','Health Care (XLV)':'XLV','Cons. Discretionary (XLY)':'XLY',
    'Cons. Staples (XLP)':'XLP','Energy (XLE)':'XLE','Industrials (XLI)':'XLI','Materials (XLB)':'XLB',
    'Utilities (XLU)':'XLU','Real Estate (XLRE)':'XLRE','Communication Svcs (XLC)':'XLC',
    // Bonds / rates
    '10yr Treasury Yield':'^TNX','30yr Treasury Yield':'^TYX','3mo Treasury Yield':'^IRX','7-10yr Bond ETF':'IEF','20yr+ Bond ETF':'TLT',
    // Dollar -- v0.10: DXY was fetched here with zero explanation since it
    // was first added, unlike crypto (IBIT/ETHE) which got an explicit
    // "informational only" note when it was added. Same real status applies
    // here, now stated explicitly (Opus review, 2026-08-27, flagged this as
    // a genuine dead-end with no design doc anywhere): tracked in this
    // diagnostic list only, deliberately NOT added to classifyMacroRegimeAt_Macro's
    // real risk-on/off vote -- would need its own predictive-value test
    // first, same staged discipline every other real vote signal here went
    // through (crypto, the original 9-ticker classifier itself). Real
    // future work if someone wants a 4th real vote, not a silent gap.
    'US Dollar Index':'DX-Y.NYB','Dollar ETF (backup)':'UUP',
    // World indices / gold-adjacent already covered above
    'Nikkei 225': '^N225', 'DAX': '^GDAXI', 'FTSE 100': '^FTSE', 'Hang Seng': '^HSI',
    // Broad US equities -- the essential baseline every risk-on/risk-off
    // comparison below needs something to compare AGAINST. Real gap found
    // directly: every macro signal here was being fetched, but nothing to
    // measure them relative to.
    'S&P 500 (baseline)': 'SPY'
  };
  Logger.log('=== Macro/cross-asset fetch test (' + Object.keys(tickers).length + ' tickers) ===');
  let okCount = 0, failCount = 0;
  for (const label in tickers) {
    const data = fetchHistoricalOHLCV_Macro(tickers[label]);
    if (data) {
      okCount++;
      Logger.log('OK    ' + label + ' (' + tickers[label] + '): ' + data.closes.length + ' bars, ' + data.dates[0].toDateString() + ' to ' + data.dates[data.dates.length-1].toDateString());
    } else {
      failCount++;
      Logger.log('FAIL  ' + label + ' (' + tickers[label] + ')');
    }
  }
  Logger.log('\n' + okCount + ' OK, ' + failCount + ' FAILED out of ' + Object.keys(tickers).length);

  const m2 = fetchM2_Macro();
  if (m2) {
    Logger.log('M2 money supply: ' + m2.values.length + ' monthly observations, ' + m2.dates[0] + ' to ' + m2.dates[m2.dates.length-1] + ', latest value: ' + m2.values[m2.values.length-1]);
  } else {
    Logger.log('M2 money supply: FAILED');
  }
  const fedfunds = fetchFredSeries_Macro('FEDFUNDS');
  if (fedfunds) {
    Logger.log('Fed Funds Rate: ' + fedfunds.values.length + ' monthly observations, latest: ' + fedfunds.values[fedfunds.values.length-1] + '%');
  } else {
    Logger.log('Fed Funds Rate: FAILED');
  }
  const t10y2y = fetchFredSeries_Macro('T10Y2Y');
  if (t10y2y) {
    Logger.log('10yr-2yr Yield Curve: ' + t10y2y.values.length + ' daily observations, latest: ' + t10y2y.values[t10y2y.values.length-1]);
  } else {
    Logger.log('10yr-2yr Yield Curve: FAILED');
  }
}

// ---- Generalized FRED fetcher -- same confirmed CSV pattern as M2,
// parameterized by series ID so FEDFUNDS/T10Y2Y/etc. reuse it directly. ----

// ══════════════════════════════════════════════════════════════════
//  MACRO REGIME CLASSIFIER — v0.1
//  BIG_PICTURE_ANALYSIS_PLAN.md Section 3a/3b: build the regime read,
//  then test its OWN standalone predictive value before combining it
//  with anything else. This is that first real piece.
//
//  Deliberately scoped to US-listed instruments only (SPY, TLT, GLD,
//  sector SPDRs) -- all trade on the same US calendar, so date
//  alignment is straightforward. World indices (Nikkei, DAX, etc.)
//  trade on DIFFERENT calendars with different holidays -- combining
//  those correctly needs real date-alignment logic not built here.
//  Left out on purpose, not forgotten.
// ══════════════════════════════════════════════════════════════════

// ---- Align multiple daily series onto a single shared date axis --
// only keeps dates present in ALL series, so every signal below is
// comparing the same actual trading days, not silently misaligned data. ----
function alignSeries_Macro(seriesMap) {
  const dateSets = Object.keys(seriesMap).map(k => new Set(seriesMap[k].dates.map(d => d.toDateString())));
  let common = dateSets[0];
  for (let i=1;i<dateSets.length;i++) {
    common = new Set([...common].filter(d => dateSets[i].has(d)));
  }
  const sortedDates = [...common].sort((a,b) => new Date(a) - new Date(b));
  const aligned = {};
  Object.keys(seriesMap).forEach(k => {
    const s = seriesMap[k];
    const dateToClose = {};
    s.dates.forEach((d,i) => { dateToClose[d.toDateString()] = s.closes[i]; });
    aligned[k] = sortedDates.map(d => dateToClose[d]);
  });
  aligned._dates = sortedDates;
  return aligned;
}

function pctChange_Macro(closes, idx, lookback) {
  if (idx < lookback) return null;
  return (closes[idx] - closes[idx-lookback]) / closes[idx-lookback];
}

// ---- The actual regime read, computed at a single index using ONLY
// data up to and including that index (no-lookahead, same discipline
// as Tier 1). Combines 3 real, distinct risk-appetite signals:
// bonds vs equities, gold vs equities, defensive vs cyclical sectors.
// Majority vote, not a weighted formula -- deliberately simple so it's
// easy to verify by hand, not a black box tuned to look good. ----
function classifyMacroRegimeAt_Macro(aligned, idx, lookback) {
  const spy = pctChange_Macro(aligned.SPY, idx, lookback);
  const tlt = pctChange_Macro(aligned.TLT, idx, lookback);
  const gld = pctChange_Macro(aligned.GLD, idx, lookback);
  const defensive = (pctChange_Macro(aligned.XLP, idx, lookback) + pctChange_Macro(aligned.XLU, idx, lookback) + pctChange_Macro(aligned.XLV, idx, lookback)) / 3;
  const cyclical = (pctChange_Macro(aligned.XLY, idx, lookback) + pctChange_Macro(aligned.XLI, idx, lookback) + pctChange_Macro(aligned.XLB, idx, lookback)) / 3;
  if (spy==null||tlt==null||gld==null||isNaN(defensive)||isNaN(cyclical)) return null;

  let riskOffVotes = 0, riskOnVotes = 0;
  if (tlt > spy) riskOffVotes++; else riskOnVotes++;           // bonds beating stocks = risk-off
  if (gld > spy) riskOffVotes++; else riskOnVotes++;           // gold beating stocks = risk-off
  if (defensive > cyclical) riskOffVotes++; else riskOnVotes++; // defensives beating cyclicals = risk-off

  if (riskOffVotes >= 2) return 'RISK_OFF';
  if (riskOnVotes >= 2) return 'RISK_ON';
  return 'NEUTRAL';
}

// ---- Step 3b from the plan: does this regime read have ANY real
// predictive value on its own, BEFORE it's combined with anything else?
// Tests it against SPY's OWN forward returns -- the most basic, honest
// check: does RISK_OFF actually precede worse SPY returns than RISK_ON? ----
function testMacroRegimePredictiveValue() {
  const tickers = ['SPY','TLT','GLD','XLP','XLU','XLV','XLY','XLI','XLB'];
  const seriesMap = {};
  Logger.log('Fetching ' + tickers.length + ' series for regime classification...');
  for (const t of tickers) {
    const data = fetchHistoricalOHLCV_Macro(t);
    if (!data) { Logger.log('FAILED to fetch ' + t + ' -- cannot proceed without it.'); return; }
    seriesMap[t] = data;
  }
  const aligned = alignSeries_Macro(seriesMap);
  Logger.log('Aligned to ' + aligned._dates.length + ' common trading days, ' + aligned._dates[0] + ' to ' + aligned._dates[aligned._dates.length-1]);

  const LOOKBACK = 20, HORIZON = 20, WARMUP = 30, STEP = 5;
  const results = { RISK_ON: [], RISK_OFF: [], NEUTRAL: [] };
  for (let i = WARMUP; i < aligned._dates.length - HORIZON; i += STEP) {
    const regime = classifyMacroRegimeAt_Macro(aligned, i, LOOKBACK);
    if (!regime) continue;
    const fwdReturn = (aligned.SPY[i+HORIZON] - aligned.SPY[i]) / aligned.SPY[i];
    results[regime].push(fwdReturn);
  }

  Logger.log('\n=== Macro regime -> SPY forward 20-day return ===');
  ['RISK_ON','NEUTRAL','RISK_OFF'].forEach(regime => {
    const arr = results[regime];
    if (!arr.length) { Logger.log(regime + ': no observations'); return; }
    const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
    const hitRate = arr.filter(r=>r>0).length/arr.length;
    Logger.log(regime + ': n=' + arr.length + '  mean SPY fwd return=' + (mean*100).toFixed(2) + '%  hitRate=' + (hitRate*100).toFixed(0) + '%');
  });
  Logger.log('\nHonest check: does RISK_OFF actually precede WORSE SPY returns than RISK_ON? If not, this regime read has no real predictive value as built and should not be trusted, per BIG_PICTURE_ANALYSIS_PLAN.md Section 3b.');
}
