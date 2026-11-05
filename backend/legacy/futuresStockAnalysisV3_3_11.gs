// ============================================================
//  futuresStockAnalysisV3.gs — Options Conviction Score System
//  Current version: OPTIONS_ENGINE_VERSION below, single source of truth.
//  2026-09-06: user's own explicit instruction -- "versioning is for all
//  the scripts" -- FILENAME versioning now applies here too, same as the
//  main engine (fullStockAnalysisV9_NN.gs). The note this replaced said
//  the opposite (constant-only, stable filename); that's superseded now,
//  not silently contradicted -- every real change bumps BOTH the filename
//  suffix and this constant together, going forward.
//  Inline comments occasionally cite an old build number for context —
//  ignore them if they don't match OPTIONS_ENGINE_VERSION, that's the real one.
// ============================================================

// W1 (v3.2.0): removed the hardcoded TOKEN — it was unused (CBOE needs no
// token) and was a secret sitting in source. If a token is ever needed,
// read it from PropertiesService.getScriptProperties().getProperty('TOKEN').
const DEFAULT_TICKER = 'TSLA';

// Version tracking, same discipline as CONFIG_V7.version -- UPDATE THIS
// (and the filename suffix) on every real change.
const OPTIONS_ENGINE_VERSION = 'v3.3.11'; // v3.3.11 (2026-09-10): real menu audit + reorder, user's own explicit request -- nothing removed (every item checked against real code, all still exist), regrouped into real sections (quick-run / portfolio-wide / daily automation / diagnostics+maintenance / docs) so small, focused tools (Find Recommended Call, Show Price Chart) aren't buried between the big combined flows. STANDING RULE from here on, user's own words: "Help mailing you must always be updated" -- showMenuHelpV7 (fullStockAnalysisV10_9.gs) rewritten same pass to match exactly, was found stale (documented a removed menu item, missing 7+ real live ones).
// v3.3.10 (2026-09-09): removed "💼 Build Portfolio Summary" menu item (buildPortfolioSummarySheetV7Menu) -- that report was removed from fullStockAnalysisV10_3.gs -> _10_4.gs, real reason: it read the Transactions sheet the user does not maintain, permanently stale/empty and fully redundant with 📤 Exit Strategy's own real Portfolio-sheet-backed listing; its one distinct piece (diversification/Bull-phase advisory) was merged into Exit Strategy instead, not dropped. User's own words: "if we have unusable code remove it."
// v3.3.9 (2026-09-08): menu wiring for the new 📤 Exit Strategy feature (fullStockAnalysisV10_0.gs v10.1) -- "📤 Build Exit Strategy Report" (manual, buildExitStrategyReportV7Menu) + "⏰ Install Exit Strategy Nightly Trigger (~1am)" (installExitStrategyTriggerV1), both per the user's own explicit request: "it can run at night scheduled and also manually at request." v3.3.8 (2026-09-07): Pass 4 of the fetch/analyze separation refactor (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md) -- this file's own real fetch-owning functions (fetchCboeRawV1_ + its execution-scoped dedup cache _cboeRawChainCacheV1_, fetchCboeChain, fetchChain) MOVED VERBATIM to dataLayerV1.gs. selectRecommendedCallV7 (a real selection/scoring function, not a fetch) stays here, still calls fetchCboeRawV1_ by name -- real Apps Script shared global scope means zero call-site changes anywhere. v3.3.7 (2026-09-07): item 8, hang-prevention cleanup -- fetchCboeRawV1_ had a real execution-scoped dedup cache (3 real call sites -> 1 fetch) but no time-budget guard on the actual fetch itself. Added: skips (and caches the skip, same as a real failure) when hasTimeBudgetV7_ says budget's critically tight. Interactive-only, real guard (runCompleteTickerAnalysisV7Continued sets _runStartTimeV7 before this runs, so it's not a no-op here). New mechanism tests in tests/item8_hang_prevention_guards_test.js (22/22, covers this file + fullStockAnalysisV9_110.gs + brokerCourseModelV1.gs v1.1's same-pass guards together). v3.3.6 (2026-09-07): real dead-function fix -- both real call sites (runFullAnalysis, showRecommendedCallV7Continued) called fetchNextEarningsDate(ticker, log), which does not exist anywhere in the project (confirmed via direct grep) -- renamed to fetchEarningsCalendarV7 in v9.41 (fullStockAnalysisV9_109.gs). Every real call threw a ReferenceError, silently swallowed by each site's own try/catch -- next-earnings-date has been silently missing from every options report since v9.41, no visible error. Fixed both sites to call fetchEarningsCalendarV7(ticker, log).next instead (same {date, dateStr} shape the old function returned). 14/14 real mechanism tests (tests/earnings_calendar_rename_fix_test.js) -- extracts the exact real try/catch lines from this file and executes them directly against a stub, rather than a heavy full-pipeline mock, avoiding the class of test-fixture bug this project has hit twice before. v3.3.5 (2026-09-07): real CBOE chain-fetch dedup -- fetchCboeChain and selectRecommendedCallV7 (called twice, LEAPS + short-term) each did their own independent CBOE fetch, up to 3x per real run for the same ticker. New execution-scoped cache (fetchCboeRawV1_, a plain global -- doesn't need to survive past one real run) shared by all 3 real call sites. User's own direct question ("all data fetching should have been before any analysis") -- this closes the one specific, scoped redundancy; the full fetch/analyze pipeline separation remains a separate, much bigger, not-yet-started project. Real, confirmed live: cdn.cboe.com calls dropped from 3 to 1 on a real ALAB run. v3.3.4 (2026-09-06): added the "🔍 Diagnose Sheet Size" menu item (diagnoseSheetSizeV1Menu, defined in fullStockAnalysisV9_107.gs) + fixed runFullAnalysis's own log() calling SpreadsheetApp.flush() on every single line (real, forced synchronous Sheets-backend round-trip x20+ per run) -- now flushes every 3rd line instead, same fix applied to makeLogger in the main engine. v3.3.3 (2026-08-28): stripped the `deadline:NN` key from all 3 real UrlFetchApp.fetch() calls in this file -- confirmed via Opus review (docs/OPUS_REVIEW_2026-08-27.md) it's not a real, documented Apps Script fetch() parameter, was silently ignored. Purely additive removal, no behavior change. v3.3.2 (2026-08-25): added "🧹 Clean Up Old Price Caches" to the 📈 Stock Analysis menu (onOpen()) -- the real cache-cleanup entry point lives in fullStockAnalysisV9_65.gs (cleanupPriceCacheSheetsV1Menu), same-project shared global scope, same pattern already used for every cross-file menu wiring here.

// ──────────────────────────────────────────────────────────────
//  MENU & AUTO-LOCK ON REFRESH — unified triple menu system
//  (Options + Stock + Lock). Consolidated from 4 stacked, redundant
//  section headers found during the version cleanup — same onOpen()
//  below, no functional change, just removed duplicate comment noise.
// ──────────────────────────────────────────────────────────────
// v3.3.11 (2026-09-10): real menu audit + reorder, user's own explicit
// request ("go over it and leave everything that's relevant... small
// method is also nice... reorder stuff"). Nothing removed -- every item
// checked directly against real code before this pass (all target
// functions confirmed to still exist: selectTickerAndRun,
// buildMethodologySheetV7, etc.) -- only regrouped into real, disclosed
// sections (quick-run / small standalone tools / portfolio-wide / daily
// automation / diagnostics+maintenance / docs) so a small, focused tool
// (e.g. "Find Recommended Call") isn't buried between two long combined
// flows. STANDING RULE from here on, user's own words: "Help mailing you
// must always be updated" -- showMenuHelpV7 (fullStockAnalysisV10_9.gs)
// MUST be kept in sync with this menu, same pass, every time either
// changes. It was found stale before this fix (documented a removed
// menu item, missing several real live ones) -- now rewritten to match
// exactly, same grouping/order as below.
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // MENU 1: Options Analysis -- real, small, focused tools, kept as their
  // own quick actions rather than folded into the bigger combined flows.
  ui.createMenu('🚀 Options Analysis')
    .addItem('▶ Run Analysis (Default: ' + DEFAULT_TICKER + ')', 'runFullAnalysis')
    .addItem('📊 Select Ticker & Run', 'selectTickerAndRun')
    .addSeparator()
    .addItem('📞 Find Recommended Call', 'showRecommendedCallV7')
    .addSeparator()
    .addItem('🔬 Diagnose API connection', 'diagnose')
    .addToUi();

  // MENU 2: Stock Analysis  (v7 is now THE analyzer; v6.1 is retired/commented out)
  // Phase 6/7/8 additions: functions that previously only ran via the Apps
  // Script function selector are now reachable from the menu too.
  ui.createMenu('📈 Stock Analysis')
    // ── Quick-run: the main, real combined flows ──
    .addItem('🚀 Full Ticker Analysis (Options + Stock + Chart)', 'runCompleteTickerAnalysisV7')
    .addItem('📊 Run Stock Analysis (v7)', 'runAnalysisV7FromMenu')
    .addItem('📊 Show Price Chart', 'showPriceChartV7')
    .addSeparator()
    // ── Portfolio-wide: exit analysis for what you already hold ──
    .addItem('📤 Build Exit Strategy Report', 'buildExitStrategyReportV7Menu')
    .addItem('⏰ Install Exit Strategy Nightly Trigger (~1am)', 'installExitStrategyTriggerV1')
    .addSeparator()
    // ── Daily/watchlist automation ──
    .addItem('🎯 Run Watchlist / Daily Check Now', 'runDailyAutomationV7')
    .addItem('⏰ Install Daily Auto-Run Trigger', 'installDailyTriggerV7')
    .addSeparator()
    // ── Diagnostics & maintenance ──
    .addItem('🔑 Check API Keys Configured', 'checkApiKeysConfiguredV7')
    .addItem('🧹 Clean Up Old Price Caches', 'cleanupPriceCacheSheetsV1Menu')
    .addItem('🔍 Diagnose Sheet Size (read-only)', 'diagnoseSheetSizeV1Menu')
    .addSeparator()
    // ── Docs ──
    .addItem('📖 Build Methodology Sheet', 'buildMethodologySheetV7')
    .addItem('❓ What do these do?', 'showMenuHelpV7')
    .addToUi();

  // MENU 3: Master Lock
  ui.createMenu('🔒 Master Lock')
    .addItem('🔓 Unlock All Sheets (Deep Clean)', 'unlockAllSheets')
    .addItem('🔒 Lock All Sheets', 'lockAllSheets')
    .addToUi();

  // DEFAULT BEHAVIOR: Lock everything on refresh
  lockAllSheets();
}

// ──────────────────────────────────────────────────────────────
//  TICKER SELECTION UI
// ──────────────────────────────────────────────────────────────
function selectTickerAndRun() {
  const html = `
    <!DOCTYPE html><html><head><base target="_top">
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
      label { display: block; margin-bottom: 8px; font-weight: bold; }
      select, input { width: 100%; padding: 10px; margin-bottom: 20px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      button { background-color: #1a73e8; color: white; border: none; padding: 12px 15px; cursor: pointer; border-radius: 4px; width: 100%; font-size: 14px; font-weight: bold; }
      button:hover { background-color: #0d47a1; }
      button:disabled { background-color: #9e9e9e; cursor: not-allowed; }
      #manualDiv { display: none; }
    </style></head><body>
    <label for="tickerSelect">Choose a Ticker:</label>
    <select id="tickerSelect" onchange="checkManual()">
      <option value="TSLA">TSLA</option>
      <option value="NVDA">NVDA</option>
      <option value="AMD">AMD</option>
      <option value="AVGO">AVGO</option>
      <option value="MSTR">MSTR</option>
      <option value="MQZA">MQZA</option>
      <option value="PLTR">PLTR</option>
      <option value="AQZB">AQZB</option>
      <option value="MQZC">MQZC</option>
      <option value="GOOGL">GOOGL</option>
      <option value="AMZN">AMZN</option>
      <option value="AQZD">AQZD</option>
      <option value="OTHER">OTHER (Enter Manually)</option>
    </select>
    <div id="manualDiv">
      <label for="manualTicker">Enter Ticker Symbol:</label>
      <input type="text" id="manualTicker" placeholder="e.g., AAPL">
    </div>
    <button id="runBtn" onclick="run()">Run Analysis</button>
    <script>
      function checkManual() {
        const sel = document.getElementById('tickerSelect').value;
        document.getElementById('manualDiv').style.display = (sel === 'OTHER') ? 'block' : 'none';
      }
      function run() {
        let ticker = document.getElementById('tickerSelect').value;
        if (ticker === 'OTHER') {
          ticker = document.getElementById('manualTicker').value.toUpperCase().trim();
          if (!ticker) { alert('Please enter a ticker symbol.'); return; }
        }
        const btn = document.getElementById('runBtn');
        btn.innerText = 'Running... (check 🔬 Log sheet)';
        btn.disabled = true;
        google.script.run
          .withSuccessHandler(google.script.host.close)
          .withFailureHandler(function(err) {
            alert('Error: ' + err.message);
            btn.innerText = 'Run Analysis';
            btn.disabled = false;
          })
          .runFullAnalysis(ticker);
      }
    </script>
    </body></html>`;

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(320).setHeight(280),
    'Select Ticker'
  );
}

// ──────────────────────────────────────────────────────────────
//  DIAGNOSE
// ──────────────────────────────────────────────────────────────
function diagnose() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('🔬 Log');
  if (!sh) sh = ss.insertSheet('🔬 Log');
  sh.clearContents();
  sh.activate();

  function w(row, label, value) {
    sh.getRange(row, 1).setValue(label);
    sh.getRange(row, 2).setValue(String(value));
  }

  w(1, 'OPTIONS DIAGNOSTIC v3.1 (CBOE)', new Date().toLocaleString());
  w(2, 'Ticker Tested', DEFAULT_TICKER);
  w(3, 'Source', 'CBOE delayed quotes — keyless, full chain');

  const url = buildUrl(DEFAULT_TICKER);
  w(4, 'URL', url);
  w(5, 'Status', 'Calling CBOE...');
  SpreadsheetApp.flush();

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const body = resp.getContentText();

    w(6, 'HTTP code', code);
    w(7, 'Response size (bytes)', body.length);
    SpreadsheetApp.flush();

    if (code === 200) {
      const json = JSON.parse(body);
      const opts = (json.data && json.data.options) || [];
      w(8,  'Underlying price', json.data ? json.data.current_price : 'N/A');
      w(9,  'Contracts returned', opts.length);
      if (opts.length > 0) {
        const p = parseOcc(opts[0].option);
        w(10, 'Sample contract 1', [
          opts[0].option,
          'strike=' + p.strike,
          'side='   + p.side,
          'exp='    + new Date(p.expUnix * 1000).toLocaleDateString(),
          'vol='    + opts[0].volume,
          'OI='     + opts[0].open_interest,
          'iv='     + opts[0].iv
        ].join(' | '));
        w(11, 'RESULT', '✅ CBOE working — run Full Analysis');
      } else {
        w(11, 'RESULT', '❌ No contracts — check the ticker symbol');
      }
    } else {
      w(8,  'First 300 chars', body.substring(0, 300));
      w(9,  'RESULT', '❌ HTTP ' + code + ' — bad ticker or CBOE unreachable');
    }
  } catch (e) {
    w(6, 'EXCEPTION', e.message);
    w(7, 'RESULT', '❌ API call failed — timeout or network blocked');
  }

  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 620);
  SpreadsheetApp.flush();
}

// ──────────────────────────────────────────────────────────────
//  MAIN
// ──────────────────────────────────────────────────────────────
function runFullAnalysis(targetTicker) {
  const ticker = (typeof targetTicker === 'string' && targetTicker.length > 0)
    ? targetTicker : DEFAULT_TICKER;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const start = Date.now();
  const logSh = getOrCreate(ss, '🔬 Log');
  logSh.clearContents();
  let logRow  = 1;

  // 2026-09-06 real fix: SpreadsheetApp.flush() forces an immediate, real,
  // synchronous round-trip to the Sheets backend on every call -- doing
  // this on EVERY single log line here (~20 lines per real options run,
  // more with a full combined run) is a well-documented real Apps Script
  // performance anti-pattern, likely the single biggest real,
  // previously-undiagnosed cost behind this project's whole-run slowness
  // complaints. Flushing every 3rd line instead keeps the log visibly
  // updating in near-real-time (a real, deliberate design goal) while
  // cutting real flush() round-trips by ~2/3. Apps Script auto-flushes at
  // the natural end of execution regardless, so the final lines are never lost.
  let logCallCount = 0;
  function log(msg) {
    logSh.getRange(logRow++, 1).setValue(new Date().toLocaleTimeString() + '  ' + msg);
    if ((++logCallCount % 3) === 0) SpreadsheetApp.flush();
  }

  log('▶ Started — ' + ticker + ' full chain via CBOE  [v3.1]');

  const raw = fetchChain(730, ticker, log);
  if (!raw) { log('❌ CBOE fetch failed — run 🔬 Diagnose (check the ticker symbol / network)'); return; }
  log('✅ ' + raw.strike.length + ' contracts returned' +
      (raw.underlying ? ' (underlying $' + raw.underlying + ')' : '') + '  [' + elapsed(start) + ']');

  log('⚙️  Scoring...');
  const contracts = parseAndScore(raw, log, ticker);
  log('Scored ' + contracts.length + ' valid contracts  [' + elapsed(start) + ']');

  if (contracts.length === 0) {
    log('❌ Zero scored. Possible: all OI=0, ATM filter too tight, or API fields changed.');
    return;
  }

  const totalVol  = contracts.reduce((s, c) => s + c.vol, 0);
  const mktClosed = totalVol === 0;
  log('Market ' + (mktClosed ? 'CLOSED (vol=0 — holding/urgency disabled)' : 'OPEN'));

  // ── Conviction verification: log formula breakdown for top 5 ──
  // T4.1: LEAPS contracts use a different formula (45/30/15/10, no
  // urgency/time), so the expected-value check branches on bucket too.
  log('── Conviction verification (top 5 calls) ──');
  contracts.filter(c => c.side === 'call').slice(0, 5).forEach((c, i) => {
    const expected = isLeaps(c.bucket)
      ? Math.round(c.dollarScore * 0.45 + c.holdingScore * 0.30 + c.oiPersistenceScore * 0.15 + c.ivScore * 0.10)
      : mktClosed
      ? Math.round(c.dollarScore * 0.70 + c.timeScore * 0.20 + c.ivScore * 0.10)
      : Math.round(c.dollarScore * 0.50 + c.holdingScore * 0.20 + c.urgencyScore * 0.15 + c.timeScore * 0.10 + c.ivScore * 0.05);
    const match = expected === c.conviction ? '✅' : '⚠️ MISMATCH';
    log((i+1) + '. $' + c.strike + ' | $Score=' + c.dollarScore + ' Hold=' + c.holdingScore +
        ' Urg=' + c.urgencyScore + ' Time=' + c.timeScore + ' IV=' + c.ivScore +
        (isLeaps(c.bucket) ? ' OIPers=' + c.oiPersistenceScore + (c.oiPersistenceIsFirstRun ? ' (first run, no history)' : '') : '') +
        ' | stored=' + c.conviction + ' computed=' + expected + ' ' + match);
  });

  const topC = contracts.filter(c => c.side === 'call').slice(0, 3);
  const topP = contracts.filter(c => c.side === 'put').slice(0, 3);
  log('Top calls: ' + topC.map(c => '$'+c.strike+' $'+Math.round(c.dollarsCommitted/1e6)+'M conv='+c.conviction).join(' | '));
  log('Top puts:  ' + topP.map(c => '$'+c.strike+' $'+Math.round(c.dollarsCommitted/1e6)+'M conv='+c.conviction).join(' | '));

  log('🏆 Building Top 10...');
  const leapsCall = selectRecommendedCallV7(ticker, 0.75, true, log);
  const shortTermCall = selectRecommendedCallV7(ticker, 0.50, false, log);
  // 2026-09-07, real fix (found while mapping the whole pipeline's fetch
  // calls for the refactor plan): fetchNextEarningsDate was renamed to
  // fetchEarningsCalendarV7 in v9.41 (fullStockAnalysisV9.gs) -- the OLD
  // name hasn't existed since, so this call threw a real ReferenceError
  // on every single run, silently swallowed by the catch below. "Next
  // earnings" awareness in the options step has been broken since v9.41
  // with zero visible error. fetchEarningsCalendarV7's own .next field has
  // the exact same {date, dateStr} shape the old function returned, so
  // this is a drop-in fix, no downstream changes needed.
  let nextEarnings = null;
  try { nextEarnings = fetchEarningsCalendarV7(ticker, log).next; } catch (e) { /* non-fatal */ }
  buildTop10(ss, contracts, ticker, leapsCall, shortTermCall, nextEarnings);
  log('📋 Building Dashboard...');  buildDashboard(ss, contracts, ticker);
  log('📞 Building CALL Table...'); buildCallTable(ss, contracts, ticker);
  log('📉 Building PUT Table...');  buildPutTable(ss, contracts, ticker);
  log('🧱 Building Gamma Wall...'); buildGammaWall(ss, contracts, ticker);

  // v7 Phase 4 (T4.2/T4.3): chain-wide context + Near/Mid/LEAPS breakdown tab.
  // FIX: pass a CONTRACT ARRAY, not the raw CBOE chain object. `contracts.fullChain`
  // is the full pre-filter parsed array (exposed by parseAndScore); fall back to the
  // filtered `contracts` array if it's absent. This resolves "raw.filter is not a function".
  const chainContext = computeChainContext(contracts.fullChain || contracts);
  log('📆 Building Near/Mid/LEAPS Breakdown...'); buildBucketBreakdown(ss, contracts, ticker, chainContext);
  log('Chain context — Put/Call OI=' + (chainContext.putCallRatioOI!=null?chainContext.putCallRatioOI.toFixed(2):'N/A') +
      '  IV%ile=' + (chainContext.ivRankPct!=null?chainContext.ivRankPct:'N/A') +
      '  ' + chainContext.termNote + '  ' + chainContext.netBiasNote);

  // FULL RAW SNAPSHOT for the Stock Analysis script (v7). Report tabs above are
  // untouched — this ONLY dumps the complete scored dataset to a hidden data
  // sheet so the analyzer can read whatever it needs and score it itself.
  try { saveOptionsSnapshotV7(ss, ticker, contracts, chainContext, raw.underlying || null); log('💾 Full options snapshot saved (' + contracts.length + ' contracts)'); }
  catch (e) { log('⚠️ Snapshot save skipped: ' + e.message); }

  // Share the top call/put with the Stock Analysis script via a project-wide
  // Script Property so its Options Overlay works even if the 🏆 tab isn't the
  // active sheet. Shape matches Stock Analysis getCachedOptions().
  // v7 Phase 4 (T4.4): also share top LEAPS call/put + chain context, additive
  // fields — v6's readOptionsOverlay() doesn't read this property at all (it
  // scrapes the 🏆 tab directly), and Script 1's getCachedOptions() just
  // round-trips the whole JSON blob, so old and new fields coexist safely.
  try {
    const byConv = arr => arr.slice().sort((a, b) => b.conviction - a.conviction);
    const tc = byConv(contracts.filter(c => c.side === 'call'))[0];
    const tp = byConv(contracts.filter(c => c.side === 'put'))[0];
    const leaps1Calls = byConv(contracts.filter(c => c.side === 'call' && c.bucket === 'LEAPS ~1yr'));
    const leaps1Puts  = byConv(contracts.filter(c => c.side === 'put'  && c.bucket === 'LEAPS ~1yr'));
    const leaps2Calls = byConv(contracts.filter(c => c.side === 'call' && c.bucket === 'LEAPS ~2yr'));
    const leaps2Puts  = byConv(contracts.filter(c => c.side === 'put'  && c.bucket === 'LEAPS ~2yr'));
    const lc  = leaps1Calls[0], lp  = leaps1Puts[0];   // ~1yr (kept on legacy leapCall*/leapPut* keys for back-compat)
    const l2c = leaps2Calls[0], l2p = leaps2Puts[0];   // ~2yr
    PropertiesService.getScriptProperties().setProperty('OPTIONS_OVERLAY', JSON.stringify({
      ticker: ticker,
      topCallStrike: tc ? '$' + tc.strike : null,
      topCallConv:   tc ? tc.conviction : null,
      topPutStrike:  tp ? '$' + tp.strike : null,
      topPutConv:    tp ? tp.conviction : null,
      leapCallStrike: lc ? '$' + lc.strike : null,
      leapCallConv:   lc ? lc.conviction : null,
      leapPutStrike:  lp ? '$' + lp.strike : null,
      leapPutConv:    lp ? lp.conviction : null,
      leap2CallStrike: l2c ? '$' + l2c.strike : null,
      leap2CallConv:   l2c ? l2c.conviction : null,
      leap2PutStrike:  l2p ? '$' + l2p.strike : null,
      leap2PutConv:    l2p ? l2p.conviction : null,
      putCallRatio:   chainContext.putCallRatioOI,
      ivRank:         chainContext.ivRankPct,
      netBias:        chainContext.netBiasNote,
      _date: new Date().toLocaleDateString()
    }));
    log('💾 Options overlay saved for ' + ticker);
  } catch (e) { log('⚠️ Overlay save skipped: ' + e.message); }

  log('✅ Done in ' + elapsed(start));

  ss.getSheetByName('🏆 Top 10 Conviction').activate();
  // Return the recommended calls so the Full Ticker Analysis orchestrator
  // can pass them into the chart as reference lines -- avoids a second,
  // redundant CBOE fetch for the same data already computed above.
  return { leapsCall: leapsCall, shortTermCall: shortTermCall };
}

// ──────────────────────────────────────────────────────────────
//  API
// ──────────────────────────────────────────────────────────────
// SOURCE: CBOE delayed quotes — keyless, no credit limit, returns the FULL
// chain (all expirations) in ONE request. Data is delayed ~15 min / prior
// close, which is fine for open-interest conviction analysis.
function buildUrl(ticker) {
  return 'https://cdn.cboe.com/api/global/delayed_quotes/options/' + ticker + '.json';
}

// Parse an OCC option symbol (e.g. TSLA270115C00960000) from the RIGHT so it
// works regardless of root length:
//   last 8 chars = strike * 1000 ; next char = C/P ; 6 chars before = YYMMDD (expiry)
function parseOcc(sym) {
  const strike = parseInt(sym.slice(-8), 10) / 1000;
  const cp     = sym.slice(-9, -8);
  const ymd    = sym.slice(-15, -9);
  const yy = 2000 + parseInt(ymd.slice(0, 2), 10);
  const mm = parseInt(ymd.slice(2, 4), 10);
  const dd = parseInt(ymd.slice(4, 6), 10);
  const expUnix = Math.floor(Date.UTC(yy, mm - 1, dd) / 1000);
  return { strike: strike, side: cp === 'C' ? 'call' : 'put', expUnix: expUnix };
}

// 2026-09-07, real fix (user's own direct architecture question: "all data
// fetching should have been before any analysis" -- a full fetch/analyze
// pipeline split is a much bigger, separate project, but THIS specific
// redundancy is small and safe to close now): the real CBOE full-chain
// fetch was happening up to 3 SEPARATE times in one real run --
// fetchCboeChain's own fetch (the main scoring pass), then
// selectRecommendedCallV7's own INDEPENDENT fetch for the LEAPS pick, then
// AGAIN for the short-term pick -- identical URLs, identical real network
// cost, paid 3x. Real, execution-scoped cache (a plain global, not
// PropertiesService -- doesn't need to survive past this one real
// execution, only avoid re-fetching within it): fetched once per ticker,
// reused by every caller in the same run. Real, disclosed choice: a failed
// fetch (null) is ALSO cached, so a genuinely broken ticker doesn't pay
// the same failed-fetch cost 3 times either.

// Fetch full chain from CBOE and reshape into the SAME columnar format the
// scorer expects (identical to the old marketdata shape) so parseAndScore and
// every sheet builder stay untouched.

// ══════════════════════════════════════════════════════════════════
//  CONTRACT SELECTION (OPTIONS_CONTRACT_SELECTION_PLAN.md, Section 2a)
//  Long calls only, single-leg -- per explicit user direction (no puts,
//  no hedges, no spreads). Picks the call whose delta is closest to a
//  target: 0.75 for LEAPS (>=180 days out, a stock-substitute default
//  confirmed against the user's real portfolio -- all 4 real positions
//  are 7-16 months out), 0.50 (ATM) for anything shorter, a secondary,
//  lower-priority case since the user doesn't currently trade short-dated.
//
//  Expiry selection within each bucket is a DELIBERATE, FLAGGED PLACEHOLDER
//  (furthest available for LEAPS, nearest liquid for short-term) -- real
//  ETA-based selection (matching an option's expiry to the stock engine's
//  own T1/T2 timing estimates) is Section 2b, not yet built. Don't treat
//  the expiry choice here as final design, just a reasonable default to
//  get contract selection itself working and testable.
//
//  Greeks (delta/theta/gamma) assumed present in this same CBOE feed,
//  based on strong secondary evidence (a documented, live-verified
//  wrapper over this exact data source showing delta/gamma/theta/vega/rho
//  fields alongside bid/ask/iv, which are ALREADY confirmed working in
//  this codebase) -- NOT independently confirmed firsthand, since direct
//  access to fetch and inspect the raw endpoint wasn't available. This is
//  why the diagnostic warning below exists: if that inference is wrong,
//  the first real run will say so clearly in the log, not fail silently.
//
//  IV-based conviction adjustment (Section 2c) is NOT wired in yet --
//  deliberately scoped out of this first pass rather than half-connect
//  it. This function returns contract selection only.
// ══════════════════════════════════════════════════════════════════
function selectRecommendedCallV7(ticker, targetDelta, isLeaps, log) {
  // 2026-09-07, real fix: was its own independent CBOE fetch, identical
  // URLs to fetchCboeChain's own -- see fetchCboeRawV1_'s own header
  // comment for why this real redundancy (up to 3x per run) got closed.
  const json = fetchCboeRawV1_(ticker, log);
  if (!json || !json.data || !json.data.options) return { found: false, reason: 'no chain data returned for ' + ticker };

  const nowSec = Date.now() / 1000;
  const opts = json.data.options;
  const byExpiry = {};
  let deltaFieldSeen = false;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o.option) continue;
    const p = parseOcc(o.option);
    if (p.side !== 'call') continue; // calls only, per explicit user preference
    if (o.delta !== undefined && o.delta !== null) deltaFieldSeen = true;
    if (!byExpiry[p.expUnix]) byExpiry[p.expUnix] = [];
    byExpiry[p.expUnix].push({
      strike: p.strike, expUnix: p.expUnix, symbol: o.option,
      delta: Number(o.delta), theta: Number(o.theta), gamma: Number(o.gamma),
      bid: Number(o.bid) || 0, ask: Number(o.ask) || 0, iv: Number(o.iv) || 0
    });
  }
  if (!deltaFieldSeen && log) {
    log('⚠ WARNING: delta field not found in CBOE response for ' + ticker + ' -- greek-based contract selection cannot work correctly. This needs investigating -- the assumption that delta is in this feed (based on secondary evidence, never independently confirmed) may be wrong.');
  }

  const expiries = Object.keys(byExpiry).map(Number).sort((a, b) => a - b);
  if (!expiries.length) return { found: false, reason: 'no call contracts found for ' + ticker };

  const SECONDS_180D = 180 * 24 * 3600;
  const SECONDS_14D  = 14 * 24 * 3600;
  let targetExpUnix;
  if (isLeaps) {
    const leapsExpiries = expiries.filter(e => (e - nowSec) >= SECONDS_180D);
    targetExpUnix = leapsExpiries.length ? leapsExpiries[leapsExpiries.length - 1] : expiries[expiries.length - 1];
  } else {
    const shortExpiries = expiries.filter(e => (e - nowSec) < SECONDS_180D && (e - nowSec) > SECONDS_14D);
    targetExpUnix = shortExpiries.length ? shortExpiries[0] : expiries[0];
  }

  const candidates = byExpiry[targetExpUnix] || [];
  let best = null, bestDiff = Infinity;
  candidates.forEach(c => {
    if (isNaN(c.delta)) return;
    const diff = Math.abs(c.delta - targetDelta);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  if (!best) {
    return {
      found: false,
      reason: deltaFieldSeen
        ? 'no candidate with a usable delta at the selected expiry for ' + ticker
        : 'delta field appears missing from this feed -- cannot select by delta'
    };
  }
  // Real feedback: a single pick with no visible comparison isn't
  // trustworthy, it's just an assertion. Return every candidate at the
  // selected expiry (sorted by distance from target delta), not just the
  // winner, so the actual "why this one" reasoning is inspectable, not
  // hidden. Expiry-level transparency (why THIS expiry vs another) is a
  // separate, later concern tied to Section 2b's real ETA-based selection
  // -- not addressed here, this is specifically about strike transparency
  // within the already-chosen expiry.
  const allCandidatesRanked = candidates
    .filter(c => !isNaN(c.delta))
    .map(c => Object.assign({}, c, { deltaDistance: Math.abs(c.delta - targetDelta) }))
    .sort((a, b) => a.deltaDistance - b.deltaDistance);
  return { found: true, contract: best, expUnix: targetExpUnix, deltaFieldSeen: deltaFieldSeen, allCandidates: allCandidatesRanked };
}

// Kept the (days, ticker) signature so callers don't change. `days` is now
// unused because CBOE returns the entire chain in one shot (the full picture).

// Menu-triggered entry point for selectRecommendedCallV7 -- shows both the
// LEAPS (0.75 delta) and short-term (0.50 delta) picks for a ticker, so the
// first real run immediately confirms whether the delta-field assumption
// (never independently verified firsthand) actually holds.
function showRecommendedCallV7() {
  const html = `<!DOCTYPE html><html><head><base target="_top">
  <style>
    body{font-family:Arial,sans-serif;padding:20px;color:#333}
    label{display:block;margin-bottom:8px;font-weight:bold}
    select,input{width:100%;padding:10px;margin-bottom:16px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:14px}
    button{background:#1a73e8;color:#fff;border:none;padding:12px;cursor:pointer;border-radius:4px;width:100%;font-size:14px;font-weight:bold}
    button:hover{background:#0d47a1} button:disabled{background:#9e9e9e;cursor:not-allowed}
    #manualDivRC{display:none}
  </style></head><body>
  <label>Ticker:</label>
  <select id="selRC" onchange="document.getElementById('manualDivRC').style.display=this.value==='OTHER'?'block':'none'">
    <option>TSLA</option><option>NVDA</option><option>AMD</option><option>AVGO</option>
    <option>MSTR</option><option>MQZA</option><option>PLTR</option><option>GOOGL</option>
    <option>AMZN</option><option>AAPL</option><option>MSFT</option><option>META</option>
    <option value="OTHER">OTHER (manual)</option>
  </select>
  <div id="manualDivRC"><label>Ticker Symbol:</label><input type="text" id="manualRC" placeholder="e.g., AAPL"></div>
  <button id="btnRC" onclick="
    let t=document.getElementById('selRC').value;
    if(t==='OTHER'){t=document.getElementById('manualRC').value.toUpperCase().trim();
      if(!t){alert('Enter ticker');return;}}
    const b=document.getElementById('btnRC');
    b.innerText='Running…';b.disabled=true;
    google.script.run
      .withSuccessHandler(google.script.host.close)
      .withFailureHandler(e=>{alert(e.message);b.innerText='Run';b.disabled=false;})
      .showRecommendedCallV7Continued(t);">Find Recommended Call</button>
  </body></html>`;
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(320).setHeight(240), 'Recommended Call');
}

function showRecommendedCallV7Continued(ticker) {
  ticker = String(ticker).toUpperCase().trim();
  const ui = SpreadsheetApp.getUi();
  const lines = ['📞 Recommended Call — ' + ticker, ''];

  // Earnings-date awareness (ENGINE_GAP_ANALYSIS.md, priority #1) -- the
  // real value here specifically: flagging whether the picked contract's
  // expiry sits AFTER the next earnings date, meaning the position would
  // be held THROUGH that event -- real IV-crush/gap risk.
  //
  // 2026-09-07, real fix: this called fetchNextEarningsDate, renamed to
  // fetchEarningsCalendarV7 in v9.41 -- the old name has thrown a real
  // ReferenceError on every call since, silently swallowed by the catch
  // below. Same fix as runFullAnalysis's own copy above.
  let nextEarnings = null;
  try { nextEarnings = fetchEarningsCalendarV7(ticker, null).next; } catch (e) { /* non-fatal, chart/report still builds without it */ }

  function describeResult(label, result, targetDelta) {
    lines.push(label + ':');
    if (!result.found) { lines.push('  Not found: ' + result.reason); lines.push(''); return; }
    const c = result.contract;
    const expDate = new Date(c.expUnix * 1000);
    lines.push('  ✅ PICKED: $' + c.strike + ' call, exp ' + expDate.toDateString());
    lines.push('  Delta: ' + c.delta.toFixed(2) + ' (target ' + targetDelta.toFixed(2) + ')   IV: ' + (c.iv ? (c.iv*100).toFixed(1)+'%' : 'N/A') + '   Bid/Ask: $' + c.bid.toFixed(2) + '/$' + c.ask.toFixed(2));
    // Cache round-trip safety fix (parallel to the same fix in fullStockAnalysisV9.gs):
    // .date could be a real Date object OR a plain string if this ever came
    // through a cache/serialization boundary -- deriving fresh from dateStr
    // (a plain string, always safe) rather than trusting .date's type.
    const nextEarningsDate = nextEarnings ? new Date(nextEarnings.dateStr+'T00:00:00Z') : null;
    if (nextEarningsDate && nextEarningsDate < expDate) {
      const daysToEarnings = Math.round((nextEarningsDate - new Date()) / (1000*60*60*24));
      lines.push('  ⚠ Next earnings (' + nextEarnings.dateStr + ', ~' + daysToEarnings + ' days) falls BEFORE this expiry -- holding through an earnings event, real IV-crush/gap risk.');
    }
    lines.push('');
    // Real feedback: show the actual field of candidates considered, not
    // just the winner -- this is the "where's the score/why this one"
    // transparency that was missing before. Capped at 6 (closest by delta
    // distance) so this stays readable in a popup rather than an
    // unscrollable wall of text -- not hiding anything, just not
    // dumping every strike at the expiry into one alert box.
    lines.push('  Other strikes considered at this same expiry, closest by delta first:');
    const shown = result.allCandidates.slice(0, 6);
    shown.forEach(c2 => {
      const marker = (c2.strike === c.strike) ? ' ← PICKED' : '';
      lines.push('    $' + c2.strike + '  delta ' + c2.delta.toFixed(2) + '  (Δ' + c2.deltaDistance.toFixed(2) + ' from target)  bid/ask $' + c2.bid.toFixed(2) + '/$' + c2.ask.toFixed(2) + marker);
    });
    if (result.allCandidates.length > 6) lines.push('    ...and ' + (result.allCandidates.length - 6) + ' more strikes at this expiry, not shown here.');
    lines.push('');
  }

  const leaps = selectRecommendedCallV7(ticker, 0.75, true, null);
  describeResult('LEAPS (target delta 0.75)', leaps, 0.75);

  const shortTerm = selectRecommendedCallV7(ticker, 0.50, false, null);
  describeResult('Short-term (target delta 0.50)', shortTerm, 0.50);
  lines.push('');
  lines.push('⚠ Note: delta field assumed present based on secondary evidence, never independently confirmed firsthand.');
  lines.push('Delta field actually seen in this response: ' + (leaps.deltaFieldSeen || shortTerm.deltaFieldSeen ? 'YES — assumption confirmed' : 'NO — assumption was WRONG, needs investigating'));
  lines.push('');
  lines.push('This is contract SELECTION only (Section 2a). Expiry choice is a simple placeholder (furthest/nearest available), not yet tied to real price targets (Section 2b). IV-based conviction adjustment (2c) not wired in yet.');

  ui.alert(lines.join('\n'));
}

// ──────────────────────────────────────────────────────────────
//  PARSE + SCORE  (v3 — key changes marked with FIX/TUNE)
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
//  v7 PHASE 4 (T4.1) — LEAPS OI-persistence, via real run-over-run
//  comparison stored in Script Properties (cacheGet/cacheSet are
//  defined in the Stock Analysis script but live in the same GAS
//  project, so they're callable here too — H5). A ticker's FIRST
//  run has no prior snapshot, so persistence is neutral (50), not
//  fabricated. TTL is 30 days so a weekend gap doesn't lose history.
// ──────────────────────────────────────────────────────────────
// T4.1 / Phase 9.1 (T9.1 fix): returns per-key {score, isFirstRun} rather than
// a bare number — "50 because no prior data" and "50 because OI genuinely
// didn't move" were previously indistinguishable on the page. isFirstRun lets
// callers label the two cases differently instead of showing the same "50"
// for both, without changing the underlying score math at all.
// ──────────────────────────────────────────────────────────────
//  REAL BUG FOUND AND FIXED (2026-08-11): cacheGet/cacheSet were REFERENCED
//  by computeOiPersistence below but never actually DEFINED anywhere in
//  either file. Since the calls were wrapped in `typeof x === 'function'`
//  checks, this failed completely silently -- every run, for every ticker,
//  forever treated every LEAPS contract as "first run, no history," which
//  is exactly what was observed in a real run despite the same ticker
//  having been run many times. Found by checking the actual code after the
//  symptom was flagged, not assumed. Real implementation using
//  PropertiesService (matching what the original comment already claimed),
//  with a manual TTL check since PropertiesService itself doesn't expire
//  entries automatically the way CacheService does (CacheService's own
//  max TTL is far too short -- hours, not the 30 days this needs).
//  Known constraint: PropertiesService caps each property at ~9KB and
//  total script storage at ~500KB -- comfortably enough for one ticker's
//  LEAPS OI snapshot, worth knowing if this ever needs to track many
//  tickers' history simultaneously.
// ──────────────────────────────────────────────────────────────
function cacheSet(key, value, ttlHours) {
  try {
    const payload = { _savedAt: Date.now(), _ttlHours: ttlHours || null, data: value };
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(payload));
  } catch (e) { /* non-fatal -- e.g. property size limit exceeded */ }
}

function cacheGet(key) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (payload._ttlHours != null) {
      const ageHours = (Date.now() - payload._savedAt) / (1000 * 60 * 60);
      if (ageHours > payload._ttlHours) return null; // expired
    }
    return payload.data;
  } catch (e) {
    return null;
  }
}

function computeOiPersistence(ticker, leapsContracts) {
  const cacheKey = 'OI_HIST_' + String(ticker || 'UNKNOWN').toUpperCase(); // W7 (v3.2.1): normalize case so PLTR/pltr share one history
  let prev = null;
  try { prev = (typeof cacheGet === 'function') ? cacheGet(cacheKey) : null; } catch (e) { prev = null; }
  const prevMap = (prev && prev.contracts) || {};
  const nowMap = {}, scores = {};
  leapsContracts.forEach(c => {
    const key = c.side + '_' + c.strike + '@' + c.expiryStr;
    nowMap[key] = c.oi;
    const prevOi = prevMap[key];
    if (prevOi == null || prevOi <= 0) { scores[key] = { score: 50, isFirstRun: true }; return; } // no history yet — neutral, not fabricated
    const chg = (c.oi - prevOi) / prevOi;
    const score = chg >= 0.10 ? 100 : chg >= 0.02 ? 75 : chg >= -0.02 ? 50 : chg >= -0.10 ? 25 : 0;
    scores[key] = { score, isFirstRun: false };
  });
  try { if (typeof cacheSet === 'function') cacheSet(cacheKey, { date: new Date().toISOString(), contracts: nowMap }, 24 * 30); } catch (e) { /* non-fatal */ }
  return scores; // keyed by side_strike@expiryStr -> {score, isFirstRun}
}

// Both LEAPS buckets (~1yr + ~2yr) share the LEAPS conviction formula
// (45/30/15/10 with OI-persistence) and the OI-persistence tracking.
function isLeaps(bucket) { return bucket === 'LEAPS ~1yr' || bucket === 'LEAPS ~2yr'; }

function parseAndScore(r, log, ticker) {
  const today = new Date();
  // W7 (v3.2.1): bail cleanly on a malformed chain row instead of throwing on
  // r.strike.length (the historical `raw.filter is not a function`-class crash).
  if (!r || !Array.isArray(r.strike)) {
    if (log) log('  ⚠ malformed chain (no strike array) — skipped');
    return [];
  }
  const n     = r.strike.length;
  const raw   = [];

  const oiKey   = r.openInterest  ? 'openInterest'  : r.openinterest  ? 'openinterest'  : null;
  const volKey  = r.volume        ? 'volume'         : r.vol           ? 'vol'           : null;
  const ivKey   = r.iv            ? 'iv'             : r.impliedVolatility ? 'impliedVolatility' : null;
  const sideKey = r.side          ? 'side'           : r.optionType    ? 'optionType'    : null;
  const expKey  = r.expiration    ? 'expiration'     : r.expirationDate ? 'expirationDate' : null;

  // ── Step 1: extract raw contract data ──
  for (let i = 0; i < n; i++) {
    const side     = sideKey ? r[sideKey][i] : '';
    const sideNorm = side === 'C' ? 'call' : side === 'P' ? 'put' : side;
    if (sideNorm !== 'call' && sideNorm !== 'put') continue;

    const expTs        = expKey ? r[expKey][i] : null;
    const expiry       = expTs  ? new Date(expTs * 1000) : null;
    const daysToExpiry = expiry ? Math.max(1, Math.round((expiry - today) / 86400000)) : 730;

    const strike = Number(r.strike[i]);
    const vol    = volKey ? (Number(r[volKey][i]) || 0) : 0;
    const oi     = oiKey  ? (Number(r[oiKey][i])  || 0) : 0;
    const iv     = ivKey  ? (Number(r[ivKey][i])  || 0) : 0;

    // W7 (v3.2.1): skip contracts with a non-finite/non-positive strike so NaN
    // can never leak into dollarsCommitted → dollarScore (clamps use Math.min,
    // which does NOT stop NaN).
    if (!Number.isFinite(strike) || strike <= 0) continue;
    if (oi === 0) continue;

    const expiryStr = expiry
      ? expiry.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
      : 'N/A';
    const bucket = daysToExpiry <= 90  ? 'Near (0–3m)'
                 : daysToExpiry <= 365 ? 'Mid (3–12m)'
                 : daysToExpiry <= 730 ? 'LEAPS ~1yr'
                 :                       'LEAPS ~2yr';

    raw.push({
      side: sideNorm, strike, vol, oi, iv,
      dollarsCommitted: strike * oi * 100,
      // FIX: holdingRaw when vol=0 capped at 100 (not 200)
      // A contract with zero vol today is held but we shouldn't score it
      // as MORE institutional than a contract with tiny real volume
      holdingRaw: vol > 0 ? Math.min(oi / vol, 100) : 100,
      // FIX: urgencyRaw cap raised to 20 for better gradation on extreme spikes
      urgencyRaw: oi  > 0 ? Math.min(vol / oi, 20)  : 0,
      daysToExpiry, expiryStr, bucket, expiry
    });
  }

  if (raw.length === 0) return [];

  // ── Step 2: ATM estimate — OI-weighted median (TUNE vs v2 mean) ──
  // Sort by strike, find the strike where cumulative OI crosses 50% of total OI.
  // This is robust against heavy OTM positioning skewing the filter boundary.
  const sortedByStrike = raw.slice().sort((a, b) => a.strike - b.strike);
  const totalOI = sortedByStrike.reduce((s, c) => s + c.oi, 0);
  let cumOI = 0;
  let atmEstimate = sortedByStrike[Math.floor(sortedByStrike.length / 2)].strike;
  for (const c of sortedByStrike) {
    cumOI += c.oi;
    if (cumOI >= totalOI * 0.50) { atmEstimate = c.strike; break; }
  }

  // ── Step 3: filter (strike band + ADAPTIVE $ floor) ──
  // The $100M floor is calibrated for mega-caps. For smaller / cheaper names
  // (e.g. a $26 stock) no single contract reaches $100M committed, which would
  // return ZERO rows. So we start at $100M — keeping mega-cap behavior identical
  // — then halve the floor until we capture at least ~10 of the biggest positions
  // for THIS ticker, down to a $1M minimum so we never surface pure noise.
  const minStrike = atmEstimate * 0.50;
  const maxStrike = atmEstimate * 2.00;
  const inBand = raw.filter(c => c.strike >= minStrike && c.strike <= maxStrike);

  let dollarFloor = 100e6;
  let filtered = inBand.filter(c => c.dollarsCommitted >= dollarFloor);
  while (filtered.length < 10 && dollarFloor > 1e6) {
    dollarFloor = Math.max(1e6, dollarFloor / 2);
    filtered = inBand.filter(c => c.dollarsCommitted >= dollarFloor);
  }
  if (log) {
    const floorStr = dollarFloor >= 1e9 ? (dollarFloor / 1e9) + 'B' : Math.round(dollarFloor / 1e6) + 'M';
    log('   Filter: ' + filtered.length + ' contracts ≥ $' + floorStr +
        ' committed, strikes $' + Math.round(minStrike) + '–$' + Math.round(maxStrike));
  }
  if (filtered.length === 0) return [];

  // ── Step 4: chain-wide IV average ──
  const ivVals = filtered.filter(c => c.iv > 0).map(c => c.iv);
  const ivAvg  = ivVals.length > 0 ? ivVals.reduce((a, b) => a + b, 0) / ivVals.length : 0;
  filtered.forEach(c => {
    c.ivPremium = (ivAvg > 0 && c.iv > 0) ? (c.iv / ivAvg) : 1.0;
  });

  // ── Step 5: scoring functions ──

  // W3 (v3.2.0): DOLLAR SCORE is now CHAIN-RELATIVE, not absolute.
  // The old absolute bands ($1B=40, $5B=65) were calibrated for mega-caps, so
  // any ticker whose biggest single-strike notional was under ~$1B capped
  // around 40 — squashing every contract's conviction into a narrow band
  // (PLTR observed 28–45). Now every contract is ranked against the LARGEST
  // committed position in THIS ticker's own chain (log2-spaced): the top
  // position ≈ 100, half its size ≈ 80, a quarter ≈ 60, an eighth ≈ 40, etc.
  // Mega-caps and mid-caps both get a full 0–100 spread that reflects real
  // relative conviction inside the chain rather than absolute dollar size.
  const dollarMax = Math.max(1, ...filtered.map(c => Number(c.dollarsCommitted) || 0));
  // A4 (independent review addendum): pure relative scoring means a "100"
  // means "biggest position in THIS chain," not "objectively large" -- a
  // thin chain's biggest position (still clearing the adaptive floor above,
  // which can go as low as $1M) could show full conviction even if it's
  // small in absolute terms. Dampens the relative score when the chain's
  // OWN largest position is still modest -- chains at/above the threshold
  // get full, undamped scoring (unaffected for names like the real PLTR
  // case this whole recalibration was built around, whose top position was
  // well over $1B); thinner chains get scaled toward (not to) a lower
  // ceiling, so "biggest fish in a small pond" doesn't read as "large."
  // MEANINGFUL_DOLLAR_THRESHOLD is a reasoned default, not empirically
  // validated -- same standing caveat as every other threshold here.
  const MEANINGFUL_DOLLAR_THRESHOLD = 300e6;
  const chainSizeDampening = Math.min(1, dollarMax / MEANINGFUL_DOLLAR_THRESHOLD);
  const dollarScore = (d) => {
    if (!Number.isFinite(d) || d <= 0) return 0;
    const frac = d / dollarMax;                 // 0..1 vs the chain's top position
    const relativeScore = Math.max(0, Math.min(100, Math.round(100 + 20 * Math.log2(frac))));
    return Math.round(relativeScore * (0.5 + 0.5 * chainSizeDampening));
  };

  // W3 (v3.2.0): HOLDING SCORE is now a PERCENTILE within the chain.
  // The old absolute curve returned 100 for any OI/Vol ≥ 50, which is almost
  // always true for LEAPS (high OI, low daily volume) — so holding contributed
  // a flat ~30 pts with zero discrimination. Now each contract is scored by
  // where its OI/Vol ratio falls in THIS chain's distribution, so "unusually
  // held for this ticker" replaces "over an absolute cutoff."
  const _holdRatios = filtered.map(c => Number(c.holdingRaw)).filter(Number.isFinite).sort((a,b)=>a-b);
  const holdingScore = (ratio) => {
    if (!Number.isFinite(ratio) || _holdRatios.length === 0) return 0;
    const atOrBelow = _holdRatios.filter(x => x <= ratio).length;
    return Math.max(0, Math.min(100, Math.round((atOrBelow / _holdRatios.length) * 100)));
  };

  // Urgency Score — Volume ÷ OI
  // TUNE: urgencyRaw now capped at 20 (was 10), threshold curves adjusted
  const urgencyScore = (ratio) => {
    if (ratio >= 5.0) return 100;
    if (ratio >= 2.0) return 70  + Math.round(((ratio - 2.0) / 3.0) * 30);
    if (ratio >= 0.5) return 30  + Math.round(((ratio - 0.5) / 1.5) * 40);
    if (ratio > 0)    return Math.round((ratio / 0.5) * 30);
    return 0;
  };

  // Time Score — near-term = stronger signal
  // <30d=100  90d=70  180d=50  1yr=25  2yr=0
  const timeScore = (days) => {
    if (days <= 30)  return 100;
    if (days <= 90)  return 70  + Math.round(((90  - days) / 60)  * 30);
    if (days <= 180) return 50  + Math.round(((180 - days) / 90)  * 20);
    if (days <= 365) return 25  + Math.round(((365 - days) / 185) * 25);
    if (days <= 730)  return Math.round(((730 - days) / 365) * 25);            // 1yr→25, tapers to 0 at 2yr
    if (days <= 1095) return Math.max(0, Math.round(((1095 - days) / 365) * 5)); // 2–3yr: gentle 5→0 taper (reference only; excluded from LEAPS conviction)
    return 0;
  };

  // IV Score — this strike vs chain average
  // FIX: below-average IV now scores 0 (was leaking positive values via premium×30)
  // Rationale: below-average IV is not a conviction signal, it's neutral or noise
  // 1.0×avg=0  1.2×=40  1.35×=70  1.5×=100
  const ivScore = (premium) => {
    if (premium >= 1.5)  return 100;
    if (premium >= 1.35) return 70  + Math.round(((premium - 1.35) / 0.15) * 30);
    if (premium >= 1.2)  return 40  + Math.round(((premium - 1.2)  / 0.15) * 30);
    if (premium >= 1.0)  return Math.round(((premium - 1.0) / 0.2) * 40);
    return 0;  // FIX: below average = 0, not a positive signal
  };

  // ── Step 6: detect market closed ──
  const totalVol    = filtered.reduce((s, c) => s + c.vol, 0);
  const marketClosed = totalVol === 0;

  // ── Step 7: compute conviction ──
  // Near/Mid (unchanged from v3.1):
  //   Market open:   50% Dollar + 20% Holding + 15% Urgency + 10% Time + 5% IV
  //   Market closed: 70% Dollar + 20% Time    + 10% IV
  // LEAPS (T4.1, new): 45% Dollar + 30% Holding + 15% OI-persistence + 10% IV.
  // Urgency/Time are excluded from the LEAPS formula (still computed &
  // shown for reference) — a same-day vol/OI spike or "30d vs 45d" time
  // decay curve carries little signal a year+ out.
  const leapsContracts = filtered.filter(c => isLeaps(c.bucket));
  const oiPersistenceMap = leapsContracts.length ? computeOiPersistence(ticker || 'UNKNOWN', leapsContracts) : {};

  filtered.forEach(c => {
    // FIX: explicit Math.min(..., 100) caps on every sub-score before weighting
    // Prevents any edge case from inflating conviction above its theoretical max
    c.dollarScore  = Math.min(dollarScore(c.dollarsCommitted), 100);
    c.holdingScore = marketClosed ? 0 : Math.min(holdingScore(c.holdingRaw), 100);
    c.urgencyScore = marketClosed ? 0 : Math.min(urgencyScore(c.urgencyRaw), 100);
    c.timeScore    = Math.min(timeScore(c.daysToExpiry), 100);
    c.ivScore      = Math.min(ivScore(c.ivPremium), 100);

    if (isLeaps(c.bucket)) {
      const key = c.side + '_' + c.strike + '@' + c.expiryStr;
      const oiPers = oiPersistenceMap[key];
      c.oiPersistenceScore = oiPers != null ? oiPers.score : 50;
      c.oiPersistenceIsFirstRun = oiPers != null ? oiPers.isFirstRun : true; // T9.1 fix
      c.conviction = Math.round(
        c.dollarScore * 0.45 + c.holdingScore * 0.30 + c.oiPersistenceScore * 0.15 + c.ivScore * 0.10
      );
    } else {
      c.oiPersistenceScore = null;
      c.oiPersistenceIsFirstRun = null;
      c.conviction = marketClosed
        ? Math.round(c.dollarScore * 0.70 + c.timeScore * 0.20 + c.ivScore * 0.10)
        : Math.round(
            c.dollarScore  * 0.50 +
            c.holdingScore * 0.20 +
            c.urgencyScore * 0.15 +
            c.timeScore    * 0.10 +
            c.ivScore      * 0.05
          );
    }
  });

  filtered.sort((a, b) => b.conviction - a.conviction);
  filtered.dollarFloor = dollarFloor;  // expose the actual floor used (for accurate headers)
  filtered.fullChain = raw;            // FIX: expose the FULL pre-filter parsed contract array
                                       // (an ARRAY) so computeChainContext() gets whole-chain
                                       // put/call & IV data instead of the raw CBOE object.
  return filtered;
}

// ──────────────────────────────────────────────────────────────
//  v7 PHASE 4 (T4.2) — CHAIN-LEVEL CONTEXT
//  Uses `raw` (the FULL chain, before ATM-band/$ floor filtering) so the
//  ratios reflect the whole chain, not just the top slice shown in tables.
//  IV rank/percentile is CROSS-SECTIONAL (this chain, today) — a single
//  snapshot has no 252-day history to compute a true historical IV rank
//  against, so that's not attempted (D5 — don't fabricate what the data
//  doesn't support).
// ──────────────────────────────────────────────────────────────
function computeChainContext(raw) {
  // §2.5.5 fix (deep-dive review): this is the exact bug class that already
  // crashed this project once (`raw.filter is not a function`). The current
  // caller (contracts.fullChain) is confirmed to pass a real array, so this
  // isn't fixing an active bug — it's a guard so a future caller can't
  // silently reintroduce the historical crash.
  raw = Array.isArray(raw) ? raw : [];
  const calls = raw.filter(c => c.side === 'call');
  const puts  = raw.filter(c => c.side === 'put');
  const callOI  = calls.reduce((s,c)=>s+c.oi,0),  putOI  = puts.reduce((s,c)=>s+c.oi,0);
  const callVol = calls.reduce((s,c)=>s+c.vol,0), putVol = puts.reduce((s,c)=>s+c.vol,0);
  const putCallRatioOI  = callOI  > 0 ? putOI  / callOI  : null;
  const putCallRatioVol = callVol > 0 ? putVol / callVol : null;

  const allIVs  = raw.filter(c => c.iv > 0).map(c => c.iv).sort((a,b)=>a-b);
  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const frontIV = avg(raw.filter(c => c.iv > 0 && c.daysToExpiry <= 90).map(c=>c.iv));
  const backIV  = avg(raw.filter(c => c.iv > 0 && c.daysToExpiry > 365).map(c=>c.iv));

  let ivRankPct = null;
  if (frontIV != null && allIVs.length > 0) {
    ivRankPct = Math.round((allIVs.filter(v => v <= frontIV).length / allIVs.length) * 100);
  }

  let termNote = 'N/A (insufficient front/back IV data)';
  if (frontIV != null && backIV != null && backIV > 0) {
    const diffPct = ((frontIV - backIV) / backIV) * 100;
    termNote = diffPct > 5  ? 'Inverted — front IV ' + diffPct.toFixed(1) + '% above back (near-term event/fear priced in)'
             : diffPct < -5 ? 'Normal/contango — back IV ' + Math.abs(diffPct).toFixed(1) + '% above front'
             :                'Flat (front ≈ back, ' + diffPct.toFixed(1) + '%)';
  }

  const callDollars = calls.reduce((s,c)=>s+c.strike*c.oi*100,0);
  const putDollars  = puts.reduce((s,c)=>s+c.strike*c.oi*100,0);
  const totalDollars = callDollars + putDollars;
  const netBiasPct = totalDollars > 0 ? Math.round(((callDollars - putDollars) / totalDollars) * 100) : null;
  const netBiasNote = netBiasPct == null ? 'N/A'
    : netBiasPct > 15  ? 'Call-heavy (net +' + netBiasPct + '%) — bullish skew'
    : netBiasPct < -15 ? 'Put-heavy (net ' + netBiasPct + '%) — bearish/hedging skew'
    :                    'Balanced (net ' + (netBiasPct>0?'+':'') + netBiasPct + '%)';

  return { putCallRatioOI, putCallRatioVol, frontIV, backIV, ivRankPct, termNote, netBiasPct, netBiasNote };
}

// ──────────────────────────────────────────────────────────────
//  SIGNAL — plain English interpretation (v3 — tighter conditions)
// ──────────────────────────────────────────────────────────────
function interpretSignal(c) {
  const isCall      = c.side === 'call';
  const near        = c.daysToExpiry <= 90;
  const far         = c.daysToExpiry > 365;

  // Use actual computed scores for signal conditions, not arbitrary thresholds
  const massiveDollars  = c.dollarScore  >= 65;   // $5B+
  const strongDollars   = c.dollarScore  >= 40;   // $1B+
  const institutional   = c.holdingScore >= 70;   // high OI/vol ratio
  const urgencySpike    = c.urgencyScore >= 70;   // vol/OI spike
  const highIV          = c.ivScore      >= 60;   // IV significantly above average

  if (isCall) {
    if (massiveDollars && near)                        return 'Major call wall — massive near-term positioning';
    if (massiveDollars && far)                         return 'Institutional LEAPS target — major upside level';
    if (strongDollars && institutional && far)         return 'Institutional upside target (LEAPS)';
    if (urgencySpike && near)                          return 'Near-term call spike — possible informed entry';
    if (urgencySpike)                                  return 'Unusual call activity — new position building';
    if (strongDollars && institutional)                return 'Major resistance / call wall';
    if (near && highIV)                                return 'Near-term call — elevated IV premium';
    if (near)                                          return 'Near-term bullish positioning';
    return 'Bullish bet / upside target';
  } else {
    if (massiveDollars && near)                        return 'Major put wall — large near-term hedge';
    if (massiveDollars && far)                         return 'Long-dated crash hedge — institutional tail risk';
    if (strongDollars && institutional && far)         return 'Long-dated crash hedge';
    if (urgencySpike && near)                          return 'Near-term put spike — possible informed exit';
    if (urgencySpike)                                  return 'Unusual put activity — new hedge building';
    if (strongDollars && institutional)                return 'Strong support / institutional hedge';
    if (near && highIV)                                return 'Near-term put — elevated IV premium';
    if (near)                                          return 'Near-term downside protection';
    return 'Bearish bet / downside hedge';
  }
}

// ──────────────────────────────────────────────────────────────
//  SHEET 1 — TOP 10 CALLS + TOP 10 PUTS
// ──────────────────────────────────────────────────────────────
function buildTop10(ss, contracts, ticker, leapsCall, shortTermCall, nextEarnings) {
  const sh = getOrCreate(ss, '🏆 Top 10 Conviction');
  sh.clearContents();
  sh.clearFormats();
  sh.setTabColor('#d50000');

  const calls        = contracts.filter(c => c.side === 'call');
  const puts         = contracts.filter(c => c.side === 'put');
  const top10calls   = calls.slice(0, 10);
  const top10puts    = puts.slice(0, 10);
  const marketClosed = contracts.every(c => c.vol === 0);

  // Show the ACTUAL $ floor used (adaptive — auto-lowers for smaller tickers).
  const floorVal = contracts.dollarFloor || 100e6;
  const floorStr = floorVal >= 1e9 ? '$' + (floorVal / 1e9) + 'B' : '$' + Math.round(floorVal / 1e6) + 'M';
  const floorNote = floorVal >= 100e6
    ? 'Min ' + floorStr + ' committed'
    : 'Min ' + floorStr + ' committed (auto-scaled for this ticker — $ Score is relative to it)';

  const scoreNote = marketClosed
    ? '⚠️  Market closed — Holding & Urgency disabled. Conviction = 70% Dollar + 20% Time + 10% IV   |   ' + floorNote + ', strikes within 50–200% of ATM'
    : 'Conviction = 50% Dollar + 20% Holding + 15% Urgency + 10% Time + 5% IV   |   ' + floorNote + ', strikes within 50–200% of ATM';

  hdr(sh, 1, ticker + ' Options ' + OPTIONS_ENGINE_VERSION + ' — Top 10 Calls & Top 10 Puts   |   ' + new Date().toLocaleString(), '#1a237e', 13, 13);
  sh.getRange(2, 1, 1, 13).merge()
    .setValue(scoreNote).setFontSize(10).setFontStyle('italic')
    .setBackground(marketClosed ? '#fff3e0' : '#e8eaf6')
    .setFontColor(marketClosed ? '#e65100' : '#3949ab');

  // RECOMMENDED CALL (OPTIONS_CONTRACT_SELECTION_PLAN.md, Section 2a) --
  // long calls only, per explicit user preference. Placed right at the
  // top since this is meant to be the actual answer, not one more table
  // to interpret yourself. Shows full candidate transparency (not just
  // the winner) per direct feedback -- "where's the score from which you
  // decided" -- capped at 6 closest-by-delta for readability.
  let row = 4;
  sh.getRange(row, 1, 1, 13).merge()
    .setValue('📞  RECOMMENDED CALL — long calls only, single-leg (no puts/hedges/spreads)')
    .setBackground('#4a148c').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  row++;
  function writeRecCall(label, result, targetDelta) {
    sh.getRange(row, 1, 1, 13).merge().setValue(label).setFontWeight('bold').setBackground('#f3e5f5');
    row++;
    if (!result || !result.found) {
      sh.getRange(row, 1, 1, 13).merge().setValue('Not found: ' + (result ? result.reason : 'no data')).setFontColor('#c62828');
      row++;
      return;
    }
    const c = result.contract;
    const expDate = new Date(c.expUnix * 1000);
    sh.getRange(row, 1, 1, 13).merge()
      .setValue('✅ $' + c.strike + ' call, exp ' + expDate.toDateString() + '   Delta: ' + c.delta.toFixed(2) + ' (target ' + targetDelta.toFixed(2) + ')   IV: ' + (c.iv ? (c.iv*100).toFixed(1)+'%' : 'N/A') + '   Bid/Ask: $' + c.bid.toFixed(2) + '/$' + c.ask.toFixed(2))
      .setBackground('#e8f5e9');
    row++;
    // Cache round-trip safety fix (parallel to the same fix in fullStockAnalysisV9.gs):
    // .date could be a real Date object OR a plain string if this ever came
    // through a cache/serialization boundary -- deriving fresh from dateStr
    // (a plain string, always safe) rather than trusting .date's type.
    const nextEarningsDate = nextEarnings ? new Date(nextEarnings.dateStr+'T00:00:00Z') : null;
    if (nextEarningsDate && nextEarningsDate < expDate) {
      const daysToEarnings = Math.round((nextEarningsDate - new Date()) / (1000*60*60*24));
      sh.getRange(row, 1, 1, 13).merge()
        .setValue('⚠ Next earnings (' + nextEarnings.dateStr + ', ~' + daysToEarnings + ' days) falls BEFORE this expiry -- holding through an earnings event, real IV-crush/gap risk.')
        .setFontColor('#e65100').setFontSize(9);
      row++;
    }
    sh.getRange(row, 1, 1, 13).setValue('Other strikes considered, closest by delta first:').setFontStyle('italic').setFontSize(9).setFontColor('#666');
    row++;
    const shown = result.allCandidates.slice(0, 6);
    shown.forEach(c2 => {
      const marker = (c2.strike === c.strike) ? '  ← PICKED' : '';
      sh.getRange(row, 1, 1, 13).setValue('  $' + c2.strike + '  delta ' + c2.delta.toFixed(2) + '  (Δ' + c2.deltaDistance.toFixed(2) + ' from target)  bid/ask $' + c2.bid.toFixed(2) + '/$' + c2.ask.toFixed(2) + marker).setFontSize(9);
      row++;
    });
    if (result.allCandidates.length > 6) {
      sh.getRange(row, 1, 1, 13).setValue('  ...and ' + (result.allCandidates.length - 6) + ' more strikes at this expiry, not shown here.').setFontSize(9).setFontColor('#999');
      row++;
    }
    row++;
  }
  writeRecCall('LEAPS (target delta 0.75):', leapsCall, 0.75);
  writeRecCall('Short-term (target delta 0.50):', shortTermCall, 0.50);
  sh.getRange(row, 1, 1, 13).merge()
    .setValue('Expiry choice is a simple placeholder (furthest/nearest available) -- not yet tied to real price targets. IV-based conviction adjustment not wired in yet.')
    .setFontSize(9).setFontStyle('italic').setFontColor('#999');
  row += 2;

  // CALLS
  const callsHeaderRow = row;
  sh.getRange(callsHeaderRow, 1, 1, 13).merge()
    .setValue('📞  TOP 10 CALL POSITIONS — Bullish bets / Resistance levels  (sorted by Conviction)')
    .setBackground('#1b5e20').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  writeConvictionTable(sh, top10calls, callsHeaderRow + 1, marketClosed, '#e8f5e9', '#f1f8e9', '#43a047', floorVal);

  // PUTS
  const putsStartRow = callsHeaderRow + 1 + 2 + top10calls.length + 3;
  sh.getRange(putsStartRow, 1, 1, 13).merge()
    .setValue('📉  TOP 10 PUT POSITIONS — Bearish bets / Support levels  (sorted by Conviction)')
    .setBackground('#b71c1c').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  writeConvictionTable(sh, top10puts, putsStartRow + 1, marketClosed, '#ffebee', '#fce4ec', '#e53935', floorVal);

  // Legend
  const legendRow = putsStartRow + 1 + 2 + top10puts.length + 3;
  hdr(sh, legendRow, 'Conviction Score Guide', '#37474f', 11, 13);
  [
    ['80–100', '🔴 Very High', 'Major level — significant institutional positioning, watch closely'],
    ['60–79',  '🟠 High',      'Strong signal — real money, clear directional thesis'],
    ['40–59',  '🟡 Moderate',  'Mixed signals — worth monitoring but not conclusive'],
    ['20–39',  '🔵 Low',       'Likely day trading or thin positioning — low signal value'],
    ['0–19',   '⚪ Noise',     'Ignore — no meaningful positioning here'],
  ].forEach((rowData, i) => {
    sh.getRange(legendRow + 1 + i, 1, 1, 3).setValues([rowData])
      .setBackground(['#ffcdd2','#ffe0b2','#fff9c4','#e3f2fd','#f5f5f5'][i]);
  });

  sh.setColumnWidth(1, 40);  sh.setColumnWidth(2, 80);  sh.setColumnWidth(3, 70);
  sh.setColumnWidth(4, 120); sh.setColumnWidth(5, 110); sh.setColumnWidth(6, 115);
  sh.setColumnWidth(7, 72);  sh.setColumnWidth(8, 72);  sh.setColumnWidth(9, 72);
  sh.setColumnWidth(10, 72); sh.setColumnWidth(11, 65); sh.setColumnWidth(12, 95);
  sh.setColumnWidth(13, 280);
  sh.setFrozenRows(2);
}

function writeConvictionTable(sh, rows, startRow, marketClosed, c1, c2, midColor, dollarFloor) {
  // $ Score legend adapts to the actual floor: absolute for large caps,
  // relative for smaller tickers where the floor auto-lowered.
  const dollarLegend = (dollarFloor && dollarFloor < 100e6)
    ? '$' + Math.round(dollarFloor / 1e6) + 'M=20\n(relative: ×2=40 ×8=80)'
    : '$100M=0\n$1B=40, $5B=65';
  sh.getRange(startRow, 1, 1, 13)
    .setValues([['#','Strike','Side','Expiry','Bucket','$ Committed',
                 '$ Score','Holding\nScore','Urgency\nScore','Time\nScore','IV\nScore','CONVICTION','Signal']])
    .setFontWeight('bold').setBackground(midColor).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow, 38);

  sh.getRange(startRow + 1, 1, 1, 13)
    .setValues([['','','','','',
      'Strike × OI × 100',
      dollarLegend,
      marketClosed ? 'N/A\n(mkt closed)' : 'OI ÷ Vol\n>50× = institutional',
      marketClosed ? 'N/A\n(mkt closed)' : 'Vol ÷ OI\n>5× = spike',
      '<30d=100\n1yr=25, 2yr=0',
      'This IV vs\nchain avg',
      'Weighted\n0–100',
      ''
    ]])
    .setFontSize(9).setFontStyle('italic').setBackground('#f5f5f5')
    .setFontColor('#757575').setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow + 1, 44);

  if (!rows || rows.length === 0) {
    sh.getRange(startRow + 2, 1).setValue('No data').setFontStyle('italic').setFontColor('#9e9e9e');
    return;
  }

  rows.forEach((c, idx) => {
    const rowNum = startRow + 2 + idx;
    const isCall = c.side === 'call';
    const dollars = c.dollarsCommitted >= 1e9
      ? '$' + (c.dollarsCommitted / 1e9).toFixed(2) + 'B'
      : '$' + (c.dollarsCommitted / 1e6).toFixed(0) + 'M';

    const rowData = [
      idx + 1, '$' + c.strike, c.side.toUpperCase(),
      c.expiryStr, c.bucket, dollars,
      c.dollarScore,
      marketClosed ? '—' : c.holdingScore,
      marketClosed ? '—' : c.urgencyScore,
      c.timeScore, c.ivScore, c.conviction,
      interpretSignal(c)
    ];

    sh.getRange(rowNum, 1, 1, 13).setValues([rowData]).setBackground(idx % 2 === 0 ? c1 : c2);
    sh.getRange(rowNum, 1).setFontWeight('bold').setHorizontalAlignment('center');
    sh.getRange(rowNum, 3)
      .setBackground(isCall ? '#1b5e20' : '#b71c1c')
      .setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');

    for (let col = 7; col <= 11; col++) {
      const val = rowData[col - 1];
      if (val === '—') {
        sh.getRange(rowNum, col).setBackground('#f5f5f5').setFontColor('#bdbdbd').setHorizontalAlignment('center');
      } else {
        sh.getRange(rowNum, col)
          .setBackground(scoreColor(val))
          .setFontColor(val >= 60 ? '#1b5e20' : val >= 40 ? '#e65100' : '#b71c1c')
          .setHorizontalAlignment('center').setFontWeight('bold');
      }
    }

    sh.getRange(rowNum, 12)
      .setBackground(scoreColor(c.conviction))
      .setFontColor(c.conviction >= 60 ? '#1b5e20' : c.conviction >= 40 ? '#e65100' : '#b71c1c')
      .setFontWeight('bold').setFontSize(13).setHorizontalAlignment('center');
    sh.getRange(rowNum, 6).setFontWeight('bold').setHorizontalAlignment('right');
  });
}

// ──────────────────────────────────────────────────────────────
//  v7 PHASE 4 (T4.3) — NEAR / MID / LEAPS BREAKDOWN
//  New tab, additive only — does NOT touch 🏆 Top 10 Conviction,
//  📋 Dashboard, 📞/📉 Call/Put tables, or 🧱 Gamma Wall above.
// ──────────────────────────────────────────────────────────────
function writeBucketMiniTable(sh, rows, startRow, label, midColor, showOiPersistence, emptyMsg) {
  const cols = showOiPersistence ? 9 : 8;
  sh.getRange(startRow, 1, 1, cols)
    .setValues([showOiPersistence
      ? [label,'Strike','Side','Expiry','$ Committed','$ Score','Hold\nScore','OI-Pers\nScore','CONVICTION']
      : [label,'Strike','Side','Expiry','$ Committed','$ Score','Hold\nScore','CONVICTION']])
    .setFontWeight('bold').setBackground(midColor).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow, 30);

  if (!rows || rows.length === 0) {
    sh.getRange(startRow + 1, 1).setValue(emptyMsg || 'No data in this bucket').setFontStyle('italic').setFontColor('#9e9e9e');
    return 1;
  }
  rows.forEach((c, idx) => {
    const rowNum = startRow + 1 + idx;
    const dollars = c.dollarsCommitted >= 1e9 ? '$' + (c.dollarsCommitted/1e9).toFixed(2)+'B' : '$'+(c.dollarsCommitted/1e6).toFixed(0)+'M';
    const oiPersDisplay = c.oiPersistenceIsFirstRun ? c.oiPersistenceScore + ' (no history yet)' : c.oiPersistenceScore;
    const rowData = showOiPersistence
      ? [idx+1, '$'+c.strike, c.side.toUpperCase(), c.expiryStr, dollars, c.dollarScore, c.holdingScore, oiPersDisplay, c.conviction]
      : [idx+1, '$'+c.strike, c.side.toUpperCase(), c.expiryStr, dollars, c.dollarScore, c.holdingScore, c.conviction];
    sh.getRange(rowNum, 1, 1, cols).setValues([rowData]);
    sh.getRange(rowNum, 3).setBackground(c.side==='call' ? '#1b5e20' : '#b71c1c').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    sh.getRange(rowNum, cols).setBackground(scoreColor(c.conviction)).setFontWeight('bold').setHorizontalAlignment('center');
  });
  return rows.length;
}

function buildBucketBreakdown(ss, contracts, ticker, chainContext) {
  const sh = getOrCreate(ss, '📆 Near／Mid／LEAPS');
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#6a1b9a');

  hdr(sh, 1, ticker + ' — Near / Mid / LEAPS(~1yr · ~2yr) Breakdown   |   ' + new Date().toLocaleString(), '#4a148c', 13, 9);

  // T4.2 chain context header
  const cc = chainContext;
  const ctxLine = [
    'Put/Call OI: ' + (cc.putCallRatioOI!=null ? cc.putCallRatioOI.toFixed(2) : 'N/A'),
    'Put/Call Vol: ' + (cc.putCallRatioVol!=null ? cc.putCallRatioVol.toFixed(2) : 'N/A'),
    'Front IV: ' + (cc.frontIV!=null ? (cc.frontIV*100).toFixed(1)+'%' : 'N/A'),
    'Back IV: ' + (cc.backIV!=null ? (cc.backIV*100).toFixed(1)+'%' : 'N/A'),
    'IV percentile (vs today\'s chain): ' + (cc.ivRankPct!=null ? cc.ivRankPct+'th' : 'N/A'),
    'Term structure: ' + cc.termNote,
    '$ Bias: ' + cc.netBiasNote
  ].join('   |   ');
  sh.getRange(2, 1, 1, 9).merge().setValue(ctxLine).setFontSize(10).setFontStyle('italic')
    .setBackground('#f3e5f5').setFontColor('#4a148c').setWrap(true);
  sh.setRowHeight(2, 40);

  let row = 4;
  const buckets = [
    { key:'Near (0–3m)',  label:'📞 NEAR (≤90d)',            color:'#00695c', persist:false },
    { key:'Mid (3–12m)',  label:'📞 MID (90–365d)',          color:'#2e7d32', persist:false },
    { key:'LEAPS ~1yr',   label:'📞 LEAPS ~1yr (365–730d)',  color:'#6a1b9a', persist:true  },
    { key:'LEAPS ~2yr',   label:'📞 LEAPS ~2yr (>730d)',     color:'#4a148c', persist:true,
      emptyMsg:'No contracts — broker lists no expiries beyond ~24 months for this ticker' }
  ];
  buckets.forEach(b => {
    const calls = contracts.filter(c => c.bucket===b.key && c.side==='call').slice(0,5);
    const puts  = contracts.filter(c => c.bucket===b.key && c.side==='put').slice(0,5);
    sh.getRange(row, 1, 1, 9).merge().setValue(b.label + ' — Top 5 Calls').setBackground(b.color).setFontColor('#fff').setFontWeight('bold');
    row++;
    const n1 = writeBucketMiniTable(sh, calls, row, '#', b.color, b.persist, b.emptyMsg);
    row += n1 + 1;
    const putLabel = b.label.replace('📞','📉') + ' — Top 5 Puts';
    sh.getRange(row, 1, 1, 9).merge().setValue(putLabel).setBackground('#b71c1c').setFontColor('#fff').setFontWeight('bold');
    row++;
    const n2 = writeBucketMiniTable(sh, puts, row, '#', '#b71c1c', b.persist, b.emptyMsg);
    row += n2 + 2;
  });

  if (buckets.some(b => b.persist)) {
    sh.getRange(row, 1, 1, 9).merge().setValue(
      'OI-Persistence: compares LEAPS open interest to the LAST time this ticker was run — 50=no prior data (first run), ' +
      '100=OI grew ≥10% since last run, 0=OI fell ≥10%. Builds up real signal over repeated runs, not a single-snapshot metric.'
    ).setFontSize(9).setFontStyle('italic').setFontColor('#757575').setWrap(true);
    row++;
  }

  sh.setColumnWidths(1, 9, 90);
  sh.setColumnWidth(1, 60);
  sh.setFrozenRows(2);
}

// ──────────────────────────────────────────────────────────────
//  SHEET 2 — DASHBOARD
// ──────────────────────────────────────────────────────────────
function buildDashboard(ss, contracts, ticker) {
  const sh = getOrCreate(ss, '📋 Dashboard');
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#1a73e8');

  const calls = contracts.filter(c => c.side === 'call');
  const puts  = contracts.filter(c => c.side === 'put');

  hdr(sh, 1, ticker + ' Options Dashboard   |   ' + new Date().toLocaleString(), '#0d47a1', 13, 6);

  const totalCallOI = calls.reduce((s, c) => s + c.oi, 0);
  const totalPutOI  = puts.reduce((s,  c) => s + c.oi, 0);
  const pcr         = totalCallOI > 0 ? (totalPutOI / totalCallOI) : null;
  const pcrStr      = pcr !== null ? pcr.toFixed(3) : 'N/A';
  const pcrSig      = pcr === null ? 'N/A'
                    : pcr < 0.7   ? '🐂 Bullish — calls dominate'
                    : pcr <= 1.2  ? '😐 Neutral — balanced'
                    :               '🐻 Bearish — puts dominate';

  hdr(sh, 3, 'Put / Call Ratio', '#37474f', 12, 6);
  sh.getRange(4, 1, 1, 6).setValues([['Total Call OI','Total Put OI','P/C Ratio','Signal','Total Calls','Total Puts']])
    .setFontWeight('bold').setBackground('#cfd8dc');
  sh.getRange(5, 1, 1, 6).setValues([[totalCallOI, totalPutOI, pcrStr, pcrSig, calls.length, puts.length]])
    .setBackground('#eceff1');

  const top5calls = calls.sort((a, b) => b.conviction - a.conviction).slice(0, 5);
  hdr(sh, 7, 'Top 5 Call Positions (by Conviction)', '#1b5e20', 12, 6);
  sh.getRange(8, 1, 1, 6).setValues([['Strike','Expiry','Bucket','$ Committed','Conviction','Signal']])
    .setFontWeight('bold').setBackground('#a5d6a7');
  if (top5calls.length) {
    sh.getRange(9, 1, top5calls.length, 6).setValues(top5calls.map(c => [
      '$'+c.strike, c.expiryStr, c.bucket,
      c.dollarsCommitted >= 1e9 ? '$'+(c.dollarsCommitted/1e9).toFixed(2)+'B' : '$'+(c.dollarsCommitted/1e6).toFixed(0)+'M',
      c.conviction, interpretSignal(c)
    ]));
    altRows(sh, 9, top5calls.length, 6, '#e8f5e9', '#f1f8e9');
  }

  const pr = 9 + top5calls.length + 2;
  const top5puts = puts.sort((a, b) => b.conviction - a.conviction).slice(0, 5);
  hdr(sh, pr, 'Top 5 Put Positions (by Conviction)', '#b71c1c', 12, 6);
  sh.getRange(pr+1, 1, 1, 6).setValues([['Strike','Expiry','Bucket','$ Committed','Conviction','Signal']])
    .setFontWeight('bold').setBackground('#ef9a9a');
  if (top5puts.length) {
    sh.getRange(pr+2, 1, top5puts.length, 6).setValues(top5puts.map(c => [
      '$'+c.strike, c.expiryStr, c.bucket,
      c.dollarsCommitted >= 1e9 ? '$'+(c.dollarsCommitted/1e9).toFixed(2)+'B' : '$'+(c.dollarsCommitted/1e6).toFixed(0)+'M',
      c.conviction, interpretSignal(c)
    ]));
    altRows(sh, pr+2, top5puts.length, 6, '#ffebee', '#fce4ec');
  }

  sh.setColumnWidths(1, 6, 160);
  sh.setFrozenRows(1);
}

// ──────────────────────────────────────────────────────────────
//  SHEET 3 — CALL TABLE
// ──────────────────────────────────────────────────────────────
function buildCallTable(ss, contracts, ticker) {
  const sh = getOrCreate(ss, '📞 CALL Table');
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#2e7d32');

  hdr(sh, 1, ticker + ' — All CALL options sorted by Open Interest', '#1b5e20', 13, 8);
  sh.getRange(2, 1, 1, 8)
    .setValues([['Expiry','Bucket','Strike','Volume','Open Interest','Impl. Vol','$ Committed','Conviction']])
    .setFontWeight('bold').setBackground('#43a047').setFontColor('#fff');

  const calls = contracts.filter(c => c.side === 'call').sort((a, b) => b.oi - a.oi);
  if (calls.length) {
    const rows = calls.map(c => [
      c.expiryStr, c.bucket, c.strike, c.vol, c.oi,
      c.iv > 0 ? (c.iv * 100).toFixed(1) + '%' : '-',
      c.dollarsCommitted >= 1e9 ? '$'+(c.dollarsCommitted/1e9).toFixed(2)+'B' : '$'+(c.dollarsCommitted/1e6).toFixed(0)+'M',
      c.conviction
    ]);
    sh.getRange(3, 1, rows.length, 8).setValues(rows);
    altRows(sh, 3, rows.length, 8, '#e8f5e9', '#f1f8e9');
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      sh.getRange(3+i, 1, 1, 8).setBackground('#b9f6ca').setFontWeight('bold');
    }
  }
  sh.setColumnWidths(1, 8, 140); sh.setFrozenRows(2);
}

// ──────────────────────────────────────────────────────────────
//  SHEET 4 — PUT TABLE
// ──────────────────────────────────────────────────────────────
function buildPutTable(ss, contracts, ticker) {
  const sh = getOrCreate(ss, '📉 PUT Table');
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#c62828');

  hdr(sh, 1, ticker + ' — All PUT options sorted by Open Interest', '#b71c1c', 13, 8);
  sh.getRange(2, 1, 1, 8)
    .setValues([['Expiry','Bucket','Strike','Volume','Open Interest','Impl. Vol','$ Committed','Conviction']])
    .setFontWeight('bold').setBackground('#e53935').setFontColor('#fff');

  const puts = contracts.filter(c => c.side === 'put').sort((a, b) => b.oi - a.oi);
  if (puts.length) {
    const rows = puts.map(c => [
      c.expiryStr, c.bucket, c.strike, c.vol, c.oi,
      c.iv > 0 ? (c.iv * 100).toFixed(1) + '%' : '-',
      c.dollarsCommitted >= 1e9 ? '$'+(c.dollarsCommitted/1e9).toFixed(2)+'B' : '$'+(c.dollarsCommitted/1e6).toFixed(0)+'M',
      c.conviction
    ]);
    sh.getRange(3, 1, rows.length, 8).setValues(rows);
    altRows(sh, 3, rows.length, 8, '#ffebee', '#fce4ec');
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      sh.getRange(3+i, 1, 1, 8).setBackground('#ff8a80').setFontWeight('bold');
    }
  }
  sh.setColumnWidths(1, 8, 140); sh.setFrozenRows(2);
}

// ──────────────────────────────────────────────────────────────
//  SHEET 5 — GAMMA WALL
// ──────────────────────────────────────────────────────────────
function buildGammaWall(ss, contracts, ticker) {
  const sh = getOrCreate(ss, '🧱 Gamma Wall');
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#f57f17');
  // W7 (v3.2.1): guard against a non-array being passed (computeChainContext
  // already guards; buildGammaWall previously called .forEach directly).
  contracts = Array.isArray(contracts) ? contracts : [];

  hdr(sh, 1, ticker + ' Gamma Wall — Call OI vs Put OI per Strike', '#e65100', 13, 7);
  sh.getRange(2, 1, 1, 7).merge()
    .setValue('Yellow = top 25% combined OI = gamma wall. Price gravitates toward these strikes near expiry.')
    .setBackground('#fff8e1').setFontColor('#5d4037').setFontSize(10).setFontStyle('italic');
  sh.getRange(3, 1, 1, 7)
    .setValues([['Strike','Call OI','Put OI','Call Vol','Put Vol','P/C OI Ratio','Combined OI']])
    .setFontWeight('bold').setBackground('#ff8f00').setFontColor('#fff');

  const strikeMap = {};
  contracts.forEach(c => {
    if (!strikeMap[c.strike]) strikeMap[c.strike] = { callOI:0, putOI:0, callVol:0, putVol:0 };
    if (c.side === 'call') { strikeMap[c.strike].callOI += c.oi; strikeMap[c.strike].callVol += c.vol; }
    else                   { strikeMap[c.strike].putOI  += c.oi; strikeMap[c.strike].putVol  += c.vol; }
  });

  const rows = Object.keys(strikeMap).map(Number).sort((a, b) => a - b).map(s => {
    const m = strikeMap[s];
    return [s, m.callOI, m.putOI, m.callVol, m.putVol,
            m.callOI > 0 ? parseFloat((m.putOI / m.callOI).toFixed(2)) : 'N/A',
            m.callOI + m.putOI];
  });

  if (rows.length) {
    sh.getRange(4, 1, rows.length, 7).setValues(rows);
    altRows(sh, 4, rows.length, 7, '#fff9c4', '#fffde7');

    const p75 = rows.map(r => r[6]).sort((a, b) => a - b)[Math.floor(rows.length * 0.75)] || 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][6] >= p75) sh.getRange(4+i, 1, 1, 7).setBackground('#ffe082').setFontWeight('bold');
    }

    const top5row = rows.length + 6;
    hdr(sh, top5row, 'Top 5 Gamma Walls (highest combined OI)', '#bf360c', 12, 7);
    sh.getRange(top5row+1, 1, 1, 7)
      .setValues([['Strike','Call OI','Put OI','Call Vol','Put Vol','P/C Ratio','Combined OI']])
      .setFontWeight('bold').setBackground('#ffb300');
    const top5 = rows.slice().sort((a, b) => b[6] - a[6]).slice(0, 5);
    sh.getRange(top5row+2, 1, top5.length, 7).setValues(top5);
    for (let i = 0; i < top5.length; i++) {
      sh.getRange(top5row+2+i, 1, 1, 7).setBackground('#fff176').setFontWeight('bold');
    }
  }
  sh.setColumnWidths(1, 7, 140); sh.setFrozenRows(3);
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
function scoreColor(val) {
  if (val >= 80) return '#c8e6c9';
  if (val >= 60) return '#dcedc8';
  if (val >= 40) return '#fff9c4';
  if (val >= 20) return '#ffe0b2';
  return '#ffcdd2';
}
// ──────────────────────────────────────────────────────────────
//  FULL RAW OPTIONS SNAPSHOT  (for the Stock Analysis v7 script)
//  Writes the COMPLETE scored contract set + chain context + meta to a
//  hidden data sheet, overwritten each run. Does NOT touch any report tab.
//  The analyzer reads this and decides how to score it (analyst conventions).
// ──────────────────────────────────────────────────────────────
var OPTIONS_SNAPSHOT_SHEET = '_OPTIONS_SNAPSHOT';
var OPTIONS_SNAPSHOT_COLS = ['side','strike','expiryStr','daysToExpiry','oi','vol','iv',
  'dollarsCommitted','dollarScore','holdingScore','urgencyScore','timeScore','ivScore','oiPersistenceScore','conviction','bucket'];

function saveOptionsSnapshotV7(ss, ticker, contracts, chainContext, underlying) {
  const sh = getOrCreate(ss, OPTIONS_SNAPSHOT_SHEET);
  sh.clear();
  const meta = {
    ticker: String(ticker || '').toUpperCase(),
    priceAtRun: (underlying != null && isFinite(underlying)) ? Number(underlying) : null,
    timestamp: new Date().toISOString(),
    count: contracts.length,
    context: chainContext || {}
  };
  // Row 1: META marker + JSON blob (chain context is small — well under the cell limit)
  sh.getRange(1, 1).setValue('META');
  sh.getRange(1, 2).setValue(JSON.stringify(meta));
  // Row 2: headers ; Rows 3+: one row per scored contract
  sh.getRange(2, 1, 1, OPTIONS_SNAPSHOT_COLS.length).setValues([OPTIONS_SNAPSHOT_COLS]);
  if (contracts.length) {
    const rows = contracts.map(c => OPTIONS_SNAPSHOT_COLS.map(k => {
      const v = c[k];
      return (v === undefined || v === null) ? '' : v;
    }));
    sh.getRange(3, 1, rows.length, OPTIONS_SNAPSHOT_COLS.length).setValues(rows);
  }
  try { sh.hideSheet(); } catch (e) { /* already hidden or not hideable — non-fatal */ }
  return meta.count;
}

function getOrCreate(ss, name)  { return ss.getSheetByName(name) || ss.insertSheet(name); }
function hdr(sh, row, text, bg, size, cols) {
  sh.getRange(row, 1, 1, cols).merge().setValue(text)
    .setBackground(bg).setFontSize(size||11).setFontWeight('bold').setFontColor('#ffffff');
}
function altRows(sh, startRow, numRows, numCols, c1, c2) {
  for (let i = 0; i < numRows; i++)
    sh.getRange(startRow+i, 1, 1, numCols).setBackground(i % 2 === 0 ? c1 : c2);
}
function fmtDate(d)     { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
function addDays(d, n)  { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function elapsed(s)     { return ((Date.now()-s)/1000).toFixed(1)+'s'; }

// ──────────────────────────────────────────────────────────────
//  SHEET LOCKING — hard-locks every tab's color as a visual "don't touch
//  this while it's running" signal. Consolidated from 5 stacked, redundant
//  section headers ("SHEET LOCKING LOGIC" / "ULTIMATE SHEET LOCK
//  (OWNER-PROOF)" / "GLOBAL HARD-LOCK" / "MASTER LOCK (TABLE-COMPATIBLE)" /
//  "MASTER LOCK (CLEAN VERSION)") plus 2 loose inline comment fragments,
//  found during the version cleanup — same lockAllSheets/unlockAllSheets
//  below, no functional change, just removed accumulated comment noise.
// ──────────────────────────────────────────────────────────────
function lockAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Loop through EVERY tab (even those without scripts) and turn them Red
  ss.getSheets().forEach(sh => sh.setTabColor("#d50000"));
  ss.toast("🔒 HARD LOCK ACTIVE", "Security");
}

function unlockAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Clear the color to stand down the Guardian
  ss.getSheets().forEach(sh => sh.setTabColor(null));
  ss.toast("🔓 UNLOCKED", "Security");
}

/**
 * THE GUARDIAN
 * This is the only function that can stop an OWNER.
 * It is called by the Google Server, not by your code.
 */
function sheetGuardian(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  // If the tab color is Red, we revert the edit immediately
  if (sheet.getTabColor() === "#d50000") {
    if (e.oldValue === undefined) {
      e.range.clearContent(); 
    } else {
      e.range.setValue(e.oldValue);
    }
    SpreadsheetApp.getActiveSpreadsheet().toast("🛑 LOCKED: Use menu to unlock.", "Security", 2);
  }
}
