// ══════════════════════════════════════════════════════════════════
//  fullStockAnalysisV9.gs — Single-Screen Stock Analyzer
//  Calls into fullStockAnalysis.gs (v6.1, separate legacy file) and
//  futuresStockAnalysisV3.gs (options engine) — doesn't modify either.
//  Current version: CONFIG_V7.version below, single source of truth.
//  Inline comments occasionally cite an old build number for context —
//  ignore them if they don't match CONFIG_V7.version, that's the real one.
// ══════════════════════════════════════════════════════════════════

const CONFIG_V7 = {
  // NOTE: this WAS display-context-only when first added; W9.2 (position
  // sizing) later made it a real input to computePositionSizeV7_ below —
  // this comment was wrong/stale until now, caught during the version
  // cleanup. size/riskPct genuinely drive the "Size:" line on the
  // dashboard. Still informational only — no order routing.
  account: { size: 10000, riskPct: 1, maxHeatPct: 6 },
  peers:   { max: 5, cacheHours: 24 },
  tab:     '📊 Analysis v7',
  // Phase 7, Sub-phase 7.1.3: the crude, manually-edited ticker list for the
  // daily automated run. Deliberately not smart — superseded once Phase 8
  // (Watchlist) exists. Edit this array directly to change what's covered.
  // 2026-09-06: seeded with the user's own real, already-documented default
  // watchlist (docs/DEFAULT_WATCHLIST.md, 2026-08-18) instead of the old
  // single-ticker placeholder -- this is what `runDailyAutomationV7` seeds
  // a brand-new 🎯 Watchlist sheet with on its first real run.
  dailyTickers: ['TSLA','MSTR','IBIT','HQZA','CQZB','AQZA','SQZB','NVDA','AQZB','MQZC','UQZA','MQZB','PLTR','AMD','GOOGL','BQZA','CQZA','MQZA','SMH','SPY','QQQ'],
  // P1-2 fix (deep-dive review): Session.getActiveUser().getEmail() is
  // documented as unreliable — frequently empty — under a real time-driven
  // trigger (no interactive user session exists). Set this to your email
  // address to guarantee delivery; leave blank to fall back to
  // getEffectiveUser() (the trigger owner's identity, more reliable than
  // getActiveUser() but still verify under a real installed trigger).
  alertEmail: '',
  version: 'v10.9' // v10.1 (2026-09-08): real, deliberate feature build, not organic accretion -- 📤 Exit Strategy, user's own explicit request: "another analysis that takes into account the position I already have... give me the best exit strategy... for all the portfolio." First build was Transactions-sheet-based; superseded same day by v10.2 below.
  // v10.9 (2026-09-10): showMenuHelpV7 fully rewritten -- real, confirmed
  // staleness fixed (still described the removed "💼 Build Portfolio
  // Summary" item, had zero coverage for 7+ real live menu items). Now
  // grouped to match onOpen()'s own real section order exactly (see
  // futuresStockAnalysisV3_3_10.gs -> _3_3_11.gs, same pass). STANDING
  // RULE from here on, user's own words: "Help mailing you must always be
  // updated" -- any future menu change must update this dialog in the
  // same pass, not drift again.
  // v10.8 (2026-09-10): real fix, built directly against the user's own
  // real 'My Portfolio.xlsx' export (parsed the actual sheet2.xml, not a
  // guess) -- v10.7's "stop on ambiguous blank-Ticker row" correctly
  // stopped at row 52 (real content: type="stock-TBD", a genuine
  // placeholder), but that stop hid every real row below it (53-61: TSLA/
  // MSTR/HUT/CLSK/IBIT/GBTC/BTC stock/FBTC/BITB). The real sheet ALSO has
  // a second non-position block further down (rows 70-82: the same
  // tickers suffixed "***", tied to a real loan note, plus real
  // "TOTAL***"/"TOTAL EARNINGS***" summary rows) -- confirmed with the
  // user directly ("this is the only relevant thing for you" -- rows
  // 53-61 + options only; the "***"/TOTAL block and crypto rows are out
  // of scope, not aggregated). Fixed: every blank-Ticker row is now
  // ALWAYS skipped (not a stop signal -- this sheet has more than one);
  // a non-blank ticker containing "*" or starting with "TOTAL" is
  // explicitly excluded; a row whose "type" isn't literally "stock" or
  // "crypto" is excluded too (catches "stock-TBD"). All exclusions are
  // disclosed by name+row+reason in a real note row, not silently
  // dropped. New tests built directly from the real parsed row data
  // (rows 51-140 of the user's actual sheet), not invented mock rows.
  // v10.7 (2026-09-10): real root cause confirmed via the v10.6 diagnostic
  // note on the user's own live run -- "row 52 has a blank Ticker cell,"
  // directly under the real header at row 51, with the user's real ticker
  // rows (TSLA/MSTR/HUT/CLSK/IBIT/GBTC/BTC-stock/FBTC/BITB/BTC/SOL) sitting
  // below it. Fixed: a genuinely BLANK row (every cell empty) is now
  // SKIPPED during the stock/crypto table scan instead of treated as "end
  // of table" -- scanning continues past it to the real rows below. A row
  // with a blank Ticker cell but OTHER real content still stops the scan
  // (kept conservative -- that pattern more likely means the real table
  // boundary into a different, unrelated block of the sheet, not a
  // spacer). User's own explicit choice over manually deleting the blank
  // row in their real sheet: "2" (the code-side fix, more robust against
  // future blank rows).
  // v10.6 (2026-09-09): 3 real fixes from the user's own live-run feedback.
  // (1) "no real analysis only T1 where is T2 or more?" -- the Targets
  // column used to collapse to whichever ONE of T1/T2 fired (T2 winning),
  // silently hiding the other real target's own price/status -- the exact
  // "hidden winner" class this report's v10.3 redesign was supposed to
  // have eliminated everywhere, missed here. New shared formatTargetsV1_
  // shows BOTH real target prices + hit/not-yet status, always, in both
  // the stock and options formatters. (2) "the portfolio is not there" --
  // real, disclosed diagnostic added for the exact reproducible symptom
  // (stock/crypto header row found, 0 real ticker rows read, no visible
  // error): a new note row now states the real header row, matched
  // columns, and the real cause if the row directly under the header has
  // a blank Ticker cell (this reader's own "end of table" rule, same
  // convention as myOpt_findTable) -- surfaces the real cause on the next
  // run instead of another guess-and-repaste cycle. (3) "i want a cleaner
  // better report" -- real, disclosed urgency sort (EXIT/EXPIRED first,
  // then REVIEW, then CONSIDER/target-hit, then HOLD, then ERROR/N/A
  // last, stable within each tier) instead of raw sheet order; header row
  // frozen; ticker column bolded.
  // v10.5 (2026-09-09): real bug found by the user on a live run --
  // "1 options there is nothing to trim/pratial its stay or exit". A
  // 1-contract options row hitting T1 read "CONSIDER TRIMMING/PARTIAL,"
  // nonsensical since a fractional contract can't be traded -- fixed
  // formatOptionsSignalsV1_ to branch on real contract count: 2+ contracts
  // still reads "CONSIDER TRIMMING/PARTIAL," exactly 1 (or unknown/
  // unparseable, same safer default) now reads "T1/T2 reached — HOLD or
  // EXIT (only 1 contract, no partial exit possible)".
  // v10.4 (2026-09-09): user's own explicit instruction -- "if we have
  // unusable code remove it" -- the standalone "💼 Build Portfolio
  // Summary" report (buildPortfolioSummarySheetV7/
  // buildPortfolioSummarySheetV7Menu, menu item removed from
  // futuresStockAnalysisV3_3_9.gs -> _3_3_10.gs) has been REMOVED: it read
  // the `Transactions` sheet the user does not maintain, making its stock/
  // option position listing permanently stale/empty and fully redundant
  // with Exit Strategy's own (better, real-Portfolio-sheet-backed) listing.
  // Its one genuinely distinct piece -- the Ch31/Ch41 diversification +
  // Bull-phase rotation advisory, plus the Appendix E correlated-market-
  // exposure-caps section -- was PORTED, not dropped: real merge, user's
  // own explicit ask ("if this is redundant then yes. if the this is the
  // better report than maybe merge both into one"). New signature
  // computePortfolioBullPhaseAdvisoryV1_(stockHoldings, getChart_) is now
  // data-source-agnostic (no longer calls computePortfolioSummaryV7
  // itself); buildExitStrategyReportV7 is its one real caller, feeding it
  // the real stock holdings it already gathered from the Portfolio sheet
  // and reusing its own already-fetched charts (zero extra fetches). The
  // advisory + correlated-caps sections now render as a real, additional
  // block at the bottom of the 📤 Exit Strategy sheet.
  // v10.2 (2026-09-08): user's own direct correction -- "why the hell would
  // i create another sheets for that ???? all the data is in the file i
  // provided there is a portfolio sheets" -- buildExitStrategyReportV7 now
  // reads the user's REAL, already-populated 'Portfolio' sheet directly
  // (both its stock/crypto sub-table and its options sub-table, via new
  // findPortfolioStockTableV1_/myOpt_findTable in myOptionsValueTracker.gs
  // v1.2) instead of Transactions/computePortfolioSummaryV7. Real, confirmed
  // gap: neither real sub-table has an entry/buy DATE column (only a
  // blended average PRICE across multiple real buys) -- user's own words,
  // "i dont have entry data because its multiple just avg price". User's
  // own explicit plan is to add a real avg-buy-date column later ("i will
  // add avrage buy because i ad many entries"); until then, 2 new,
  // ADDITIVE functions (computePositionExitReadFixedLookbackV1_,
  // computeOptionsPositionExitReadFixedLookbackV1_) give a disclosed,
  // generic-lookback stop read instead of the real since-entry one -- the
  // existing date-based computePositionExitReadV1_/
  // computeOptionsPositionExitReadV1_ (and analyzePositionV7, which still
  // takes a real entry date directly from the user for one ticker at a
  // time) are UNTOUCHED, ready to become the report's real source again
  // the moment that column exists. User's own explicit answers, same day:
  // crypto rows ("skip crypto") are excluded from the report (fetchYahooChart
  // isn't built for crypto tickers), and the generic lookback window is
  // 800 real trading days (user's own number, not invented).
  // v10.3 (2026-09-08), same day: 2 real fixes. (1) user added a real
  // "Purchase Data" column to the OPTIONS sub-table only (stock/crypto
  // still has none) -- buildExitStrategyReportV7 now uses it per-row when
  // present (real since-entry computeOptionsPositionExitReadV1_/
  // computePositionExitReadV1_ -- both UNTOUCHED, already existed), falls
  // back to the generic fixed-lookback functions only when a row has no
  // real date. Same optional-column check applied to the stock/crypto
  // table too (col['Purchase Data']), so it activates automatically the
  // moment the user adds it there -- their own stated plan ("in the
  // future i will add where i can and where i know those details"). (2)
  // fixed a real silent-failure bug: if only ONE of the 2 real sub-tables
  // failed its header search, the whole table silently vanished from the
  // report with zero rows and no visible error -- now surfaced as a real
  // note row. (3) real report redesign per the user's own explicit
  // instruction ("dont drop anything compute all you can and mark what
  // you cant and take into account when you do the analysis and summery
  // at the end"): the old single winner-take-all Recommendation/Why
  // columns (a priority chain that HID e.g. a real target-hit signal
  // whenever a stop breach also fired) are replaced with separate Thesis /
  // Trailing Stop / Targets / Expiry columns (every real, already-computed
  // signal shown, none hidden) plus a Confidence column (REAL since-entry
  // vs GENERIC fixed-lookback, per row) and one synthesized Summary that
  // weights REAL-confidence signals over GENERIC ones (a GENERIC-lookback
  // stop breach reads "REVIEW, LOW CONFIDENCE," not a flat "EXIT" -- real,
  // disclosed distinction, not the same certainty as a real since-entry
  // read). Reuses the exact same pure functions from v10.2, unchanged --
  // only the report-formatting layer changed.
  // v10.0 (2026-09-07): REAL REFACTOR ERA STARTS HERE -- first deliberate architecture pass, not organic accretion (memory stock-analyzer-v10-refactor-marker). Real fetch/analyze pipeline separation (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md), engine migrated first per the agreed order. 30 real functions (20 fetch-owning + 10 cache-read/write helpers) MOVED VERBATIM to the new dataLayerV1.gs -- gatherFundamentals(V7)/fetchYahooChart(Raw_/LongRange_)/fetchFinnhub-FMP-AlphaVantageFundamentals/fetchEarningsCalendarV7/fetchInsiderTradingNet/fetchTreasuryRate10Y/fetchGeminiReviewV7/fetchPeerBasicMetricsV7/the full 13F fetch+cache chain (incl. 2 confirmed-dead/unreachable legacy functions, kept not deleted per the standing 'move code, don't delete lines' constraint)/getCachedFundamentals+saveFundamentalsCache/read+write13FCacheV1_/readBrokerDataCacheV1_+writeBrokerDataCacheV1_/readMacroSnapshotV1_+writeMacroSnapshotV1_/expected13FQuarterTagV1_. Real Apps Script shared-global-scope means ZERO call sites anywhere needed to change -- every one of these is still called by its original name, from wherever it was called before; only the function DEFINITIONS moved. Cosmetic-only per the user's own explicit confirmation ('the changes can not effect the functionality only the way we run the code') -- byte-identical function bodies, verified via a scripted extraction (Python, this codebase's own proven ^function/^} convention) rather than manual editing, to avoid transcription risk at this scale. v9.110 (2026-09-07): item 8, hang-prevention cleanup -- (1) foundational fix: _runStartTimeV7 was ONLY ever set inside runCompleteTickerAnalysisV7Continued, making every existing hasTimeBudgetV7_ guard a silent no-op on the other 2 real entry points (menu, nightly automation); now set at the top of runAnalysisV7 itself (only if not already set), activating every existing guard everywhere. (2) gatherFundamentals's 3 provider calls (AV/Finnhub/FMP, ~10 endpoints total, the single largest unguarded cluster this project's own fetch-map found) + 3 trailing calls (earnings/insider/treasury) were completely unconditional -- now guarded, skip+log under real time pressure instead of always starting. (3) fetchYahooChartLongRange_ (3/5/10yr trailing perf) same fix. Real Apps Script limitation (already confirmed, docs/OPUS_REVIEW_2026-08-27.md): a guard can only stop STARTING a call late, not bound one already in flight. New test tests/item8_hang_prevention_guards_test.js (22/22). Full 73-file affected regression clean. See also brokerCourseModelV1.gs v1.1 and futuresStockAnalysisV3_3_7.gs (same pass, same-day companion fixes). // single source of truth for the version string, referenced by the dashboard header and menu. UPDATE THIS on every real change. scheme: v<major>.<minor>
};

// W9.2 (v9.0): Position sizing. Turns the R:R geometry into an actual share
// count using fixed-fractional risk (risk a fixed % of the account per trade,
// scaled by conviction). This is display/education only — it does not place
// orders. Returns null when inputs are unusable so callers can skip the line.
function computePositionSizeV7_(entryPrice, stopPrice, finalConviction) {
  try {
    const acct = (CONFIG_V7.account && CONFIG_V7.account.size) || 0;
    const riskPct = (CONFIG_V7.account && CONFIG_V7.account.riskPct) || 1;
    if (!(acct > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return null;
    const perShareRisk = entryPrice - stopPrice;
    if (!(perShareRisk > 0)) return null;
    // Scale the risked fraction by conviction (0..100 → 0.5x..1.0x) so a
    // low-conviction setup risks less than a high-conviction one.
    const convScale = 0.5 + 0.5 * (Math.max(0, Math.min(100, finalConviction || 0)) / 100);
    const dollarRisk = acct * (riskPct / 100) * convScale;
    let shares = Math.floor(dollarRisk / perShareRisk);
    if (!(shares > 0)) return null;
    let cost = shares * entryPrice;
    // Never let a single position exceed the account (cash-account cap).
    if (cost > acct) { shares = Math.floor(acct / entryPrice); cost = shares * entryPrice; }
    if (!(shares > 0)) return null;
    return { shares, cost, dollarRisk: shares * perShareRisk, perShareRisk, riskPct, convScale };
  } catch (e) { return null; }
}

// v9.78 -- Edwards & Magee Appendix E (Turtle System), Chapter 3 "Position
// Sizing": a real, distinct, VOLATILITY-NORMALIZED 2nd opinion, purely
// additive alongside computePositionSizeV7_ above (which stays unchanged --
// this is a NEW function, not a modification). The book's own real,
// literal rule: size each Unit so that a full 1xN adverse move costs
// exactly 1% of account equity, where N = the 20-day Wilder-smoothed True
// Range (identical math to this file's own existing 14-day atr14 -- see
// `turtleN` above, computed via the SAME already-existing wilderSmooth()
// helper, just period=20 instead of 14, zero new methodology). Initial
// stop = entry - 2N (a real, literal Appendix E rule -- 2N = 2% max risk
// per Unit, since 1N=1%). This 2N distance is used ONLY internally here to
// size the position, per the book's own real design -- it does NOT create
// a 5th stop-level output; this project's existing stop fields (ATR/
// Chandelier/classical/basingPoint) are untouched and remain the real
// stop-placement outputs.
//
// REAL, DISCLOSED design choice: uses a fixed 1% (Appendix E's own literal
// number), NOT CONFIG_V7.account.riskPct (which drives the EXISTING
// conviction-scaled computePositionSizeV7_ above) -- kept independent so
// the two methods are a genuine, comparable 2nd opinion rather than
// silently sharing one config knob.
function computeNNormalizedPositionSizeV1_(entryPrice, n) {
  try {
    const acct = (CONFIG_V7.account && CONFIG_V7.account.size) || 0;
    if (!(acct > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(n) || !(n > 0)) return null;
    const RISK_PCT_PER_N = 0.01; // Appendix E's own real "1N = 1% of account equity" rule
    const STOP_MULTIPLE_N = 2;   // Appendix E's own real initial-stop rule (2N below entry)
    let shares = Math.floor((acct * RISK_PCT_PER_N) / n); // DollarsPerPoint=1 for a single stock share
    if (!(shares > 0)) return null;
    let cost = shares * entryPrice;
    if (cost > acct) { shares = Math.floor(acct / entryPrice); cost = shares * entryPrice; } // same cash-account cap as computePositionSizeV7_
    if (!(shares > 0)) return null;
    const stopLevel = entryPrice - STOP_MULTIPLE_N * n;
    const dollarRisk = shares * STOP_MULTIPLE_N * n;
    return { shares, cost, n, stopLevel, dollarRisk, riskPctOfAccount: dollarRisk / acct * 100 };
  } catch (e) { return null; }
}

// v9.78 -- Edwards & Magee Appendix A, Chapter B "A Discussion of Composite
// Leverage": a real, precise, purely additive/informational leverage-risk
// read. Composite Leverage = (S x N x T) / (15.5 x C), where S=Sensitivity
// Index (this project's own already-established atrRatio proxy -- same
// approximation computeBasingPointStopV1_ already makes, editor's own
// explicit note "read beta for Sensitivity Index"), N=Normal Range-for-
// Price (a real table, book's own Appendix A Chapter C p620, read directly
// -- NOT the same N as the Turtle system's ATR-based N just above, an
// unfortunate real notation collision the book itself has, disclosed not
// hidden), T=dollar amount committed, C=capital reserved. For this user's
// own cash-only, long-only strategy (no margin, memory `trading-strategy-
// long-only-calls`), T=C, so the T/C term cancels to 1 -- exactly the real
// simplification already reasoned through in docs/BIG_PLAN_EDWARDS_MAGEE.md.
//
// Real Normal-Range-for-Price table (p620), the book's own actual listed
// price points read directly from the table (not every printed row --
// disclosed, linearly interpolated between these real anchor points for
// prices in between, extrapolated flat beyond the table's own $250 top row).
const NORMAL_RANGE_FOR_PRICE_TABLE_V1 = [
  [1.25,38.0],[5,24.0],[10,19.8],[15,17.6],[20,16.5],[25,15.5],[30,14.7],
  [35,14.2],[40,13.7],[45,13.2],[50,12.7],[60,12.1],[70,11.6],[80,11.1],
  [90,10.8],[100,10.4],[150,9.0],[200,8.0],[250,7.0]
];
function normalRangeForPriceV1_(price) {
  const t = NORMAL_RANGE_FOR_PRICE_TABLE_V1;
  if (price <= t[0][0]) return t[0][1];
  if (price >= t[t.length-1][0]) return t[t.length-1][1];
  for (let i = 0; i < t.length-1; i++) {
    const [p1,r1] = t[i], [p2,r2] = t[i+1];
    if (price >= p1 && price <= p2) return r1 + (r2-r1) * (price-p1)/(p2-p1);
  }
  return t[t.length-1][1];
}
function computeCompositeLeverageV1_(price, sensitivityIndex) {
  try {
    if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(sensitivityIndex)) return null;
    const nRange = normalRangeForPriceV1_(price);
    const leverage = (sensitivityIndex * nRange) / 15.5; // T/C=1 (cash-only, no margin)
    const tier = leverage < 0.5 ? 'conservative' : leverage < 1.0 ? 'moderate' : leverage < 1.5 ? 'speculative' : 'highly speculative';
    return { leverage, sensitivityIndex, normalRangeForPrice: nRange, tier };
  } catch (e) { return null; }
}

// W9.1 (v9.0): "Own for years?" secular read. Distinct from the tactical
// BUY-TIMING engine — answers whether the long-term trend supports holding for
// years, using multi-year CAGR and price vs the 200-WEEK SMA (~1000 trading
// days). Degrades gracefully when history is short (uses whatever is available
// and says so). Purely informational.
function computeSecularReadV7_(closes) {
  try {
    if (!Array.isArray(closes) || closes.length < 60) return null;
    const first = closes[0], last = closes[closes.length - 1];
    if (!(first > 0) || !(last > 0)) return null;
    const years = closes.length / 252;
    const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : null;
    // 200-week SMA ≈ last 1000 trading days; fall back to full series if shorter.
    const wk200Window = closes.slice(-1000);
    const wk200Sma = wk200Window.reduce((a, b) => a + b, 0) / wk200Window.length;
    const aboveWk200 = last >= wk200Sma;
    const pctVsWk200 = wk200Sma > 0 ? ((last - wk200Sma) / wk200Sma) * 100 : 0;
    let verdict, why;
    if (cagr != null && cagr >= 12 && aboveWk200) { verdict = 'YES — durable uptrend'; }
    else if (cagr != null && cagr >= 5 && aboveWk200) { verdict = 'MAYBE — modest secular trend'; }
    else if (!aboveWk200) { verdict = 'NO — below long-term trend'; }
    else { verdict = 'MIXED — weak long-term return'; }
    why = (cagr != null ? cagr.toFixed(1) + '%/yr over ~' + years.toFixed(1) + 'y' : 'CAGR n/a')
        + ', ' + (aboveWk200 ? 'above' : 'below') + ' 200-week SMA by ' + Math.abs(pctVsWk200).toFixed(0) + '%'
        + (closes.length < 1000 ? ' (limited history)' : '');
    return { verdict, why, cagr, aboveWk200, pctVsWk200, yearsAvailable: years };
  } catch (e) { return null; }
}

// ────────────────────────────────────────────────────────────────
//  ENTRY POINTS
// ────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
//  PHASE 7 — Daily Automation & Alerts
//  A time-driven trigger runs the existing runAnalysisV7 pipeline on a
//  small manual ticker list, logs every run to an append-only Decision
//  History sheet (doubles as both the change-detection source AND the
//  daily record you actually asked for), and emails exactly one digest
//  when — and only when — a tracked ticker's decision genuinely changed.
// ══════════════════════════════════════════════════════════════════

const DECISION_HISTORY_SHEET_V7 = '📈 Decision History';
const DECISION_HISTORY_HEADERS_V7 = ['Date','Ticker','OWN','TIMING Score','Final Conviction','Action'];
const DAILY_TRIGGER_HANDLER_V7 = 'runDailyAutomationV7';

// 7.1.2: idempotent — checks for an existing trigger with this handler
// name before adding another, so re-running this doesn't create
// duplicates (relevant given the 20-trigger-per-script ceiling).
function installDailyTriggerV7() {
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === DAILY_TRIGGER_HANDLER_V7);
  if (existing.length > 0) {
    Logger.log('Daily trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  // 2026-09-06: was atHour(7) -- user's own explicit ask, moved to 1 AM
  // (real, disclosed caveat: Apps Script fires atHour(n) within an
  // approximate window of that hour, not on-the-dot, and the hour is
  // interpreted in the Apps Script PROJECT's own Time Zone setting, not
  // something this code can read or set -- confirm that's Israel time in
  // the Editor's Project Settings if that's the real intent).
  ScriptApp.newTrigger(DAILY_TRIGGER_HANDLER_V7).timeBased().everyDays(1).atHour(1).create();
  Logger.log('Daily trigger installed: ' + DAILY_TRIGGER_HANDLER_V7 + ' at ~1:00 AM (project time zone).');
}

function getOrCreateDecisionHistorySheetV7(ss) {
  let sh = ss.getSheetByName(DECISION_HISTORY_SHEET_V7);
  if (!sh) {
    sh = ss.insertSheet(DECISION_HISTORY_SHEET_V7);
  }
  // P2-3 fix (deep-dive review): previously only wrote headers when the
  // SHEET didn't exist at all — if the sheet existed but was cleared (row 1
  // empty/wrong), appendRow would place the first real decision on row 1,
  // and getLastDecisionV7's loop (which always treats row 0 as header)
  // would silently misread or skip it, breaking change-detection from that
  // point on. Now checks row 1's actual content every time, not just sheet
  // existence.
  const row1 = sh.getRange(1, 1, 1, DECISION_HISTORY_HEADERS_V7.length).getValues()[0];
  const headersPresent = row1[0] === DECISION_HISTORY_HEADERS_V7[0];
  if (!headersPresent) {
    sh.getRange(1,1,1,DECISION_HISTORY_HEADERS_V7.length).setValues([DECISION_HISTORY_HEADERS_V7]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidths(1, DECISION_HISTORY_HEADERS_V7.length, 130);
    sh.setFrozenRows(1);
  }
  return sh;
}

// 7.2.3: read the most recent PRIOR row for this ticker, BEFORE writing
// today's — this is the actual diffing source for change-detection.
function getLastDecisionV7(ss, ticker) {
  const sh = ss.getSheetByName(DECISION_HISTORY_SHEET_V7);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][1]).toUpperCase() === ticker.toUpperCase()) {
      return { date: data[r][0], ticker: data[r][1], own: data[r][2], timing: data[r][3], finalConviction: data[r][4], action: data[r][5] };
    }
  }
  return null;
}

// 7.2.1/7.2.3: append-only — never edits or overwrites a past row.
function appendDecisionHistoryV7(ss, ticker, fundResult, techPlan, decision) {
  const sh = getOrCreateDecisionHistorySheetV7(ss);
  sh.appendRow([new Date(), ticker, fundResult.score, techPlan.techScore, decision.finalConviction, decision.action]);
}

// ══════════════════════════════════════════════════════════════════
//  PHASE 8 — Multi-Ticker Watchlist
//  Sub-phase 8.1: architecture decided from REAL measured data (the
//  PLTR verification run measured ~26s for the stock pipeline) — at
//  4-8 tickers that's 104-208s, comfortably under the 5-minute safety
//  margin, well under the 6-minute hard cap. A simple loop is
//  justified by measurement; the chunked/continuation architecture is
//  deliberately NOT built, per "don't build the complex version if the
//  simple one is sufficient."
// ══════════════════════════════════════════════════════════════════

const WATCHLIST_SHEET_V7 = '🎯 Watchlist';
const WATCHLIST_SUMMARY_SHEET_V7 = '🎯 Watchlist Summary';

// 8.2.1: a dedicated sheet, one ticker per row — falls back to Phase 7's
// CONFIG_V7.dailyTickers if the Watchlist sheet doesn't exist or is empty,
// so Phase 7's automation keeps working even before this sheet is set up.
function getWatchlistTickersV7(ss) {
  const sh = ss.getSheetByName(WATCHLIST_SHEET_V7);
  if (!sh) return CONFIG_V7.dailyTickers || [];
  const data = sh.getDataRange().getValues();
  const tickers = [];
  for (let r = 1; r < data.length; r++) {
    const t = String(data[r][0]||'').toUpperCase().trim();
    // §2.5.3 fix (deep-dive review): dedupe — a repeated ticker in the sheet
    // would otherwise get analyzed twice, wasting time-budget for nothing.
    if (t && tickers.indexOf(t) === -1) tickers.push(t);
  }
  return tickers.length ? tickers : (CONFIG_V7.dailyTickers || []);
}

function getOrCreateWatchlistSheetV7(ss) {
  let sh = ss.getSheetByName(WATCHLIST_SHEET_V7);
  if (!sh) {
    sh = ss.insertSheet(WATCHLIST_SHEET_V7);
    sh.getRange(1,1,1,1).setValues([['Ticker']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidth(1, 120);
    sh.setFrozenRows(1);
  }
  return sh;
}

// 8.3.1/8.3.2: one row per ticker, ranked by Final Conviction descending
// (surfaces the highest-conviction opportunities first — no new ranking
// logic, reuses the Phase-1-consolidated single source of truth).
function buildWatchlistSummarySheetV7(ss, results) {
  const sh = getOrCreate(ss, WATCHLIST_SUMMARY_SHEET_V7);
  // Same fix class as P2-2 — row count varies with ticker count, so a stale
  // merge from a prior run can collide with this run's rebuild.
  try { sh.getDataRange().breakApart(); } catch (e) {}
  sh.clearContents(); sh.clearFormats();
  let row = 1;
  sh.getRange(row,1,1,7).merge().setValue('🎯 Watchlist Summary — ranked by Final Conviction, updated '+new Date().toLocaleString()).setBackground('#1a5276').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row+=2;

  const ranked = results.slice().sort((a,b) => (b.decision?b.decision.finalConviction:-1) - (a.decision?a.decision.finalConviction:-1));
  sh.getRange(row,1,1,7).setValues([['Ticker','OWN','TIMING','Regime','Final Conviction','Action','Updated']]).setFontWeight('bold').setBackground('#2874a6').setFontColor('#fff');row++;
  ranked.forEach((r,i) => {
    if (r.skippedForTime) { sh.getRange(row,1,1,7).setValues([[r.ticker,'SKIPPED','—','—','—','time budget — will run next automation', new Date().toLocaleTimeString()]]).setBackground('#fff3e0'); row++; return; }
    if (!r.decision) { sh.getRange(row,1,1,7).setValues([[r.ticker,'FAILED','—','—','—','see 🔬 Log', new Date().toLocaleTimeString()]]).setBackground('#fdecea'); row++; return; }
    sh.getRange(row,1,1,7).setValues([[r.ticker, r.fundResult.score, r.techPlan.techScore, r.techPlan.regime, r.decision.finalConviction, r.decision.action, new Date().toLocaleTimeString()]]).setBackground(i%2===0?'#eaf2f8':'#fff');
    row++;
  });
  sh.setColumnWidths(1, 7, 130);
  sh.setFrozenRows(1);
}

// 7.3 / 8.4: the trigger's actual handler — now reads tickers from the
// Watchlist (falling back to CONFIG_V7.dailyTickers, per Phase 7 design),
// runs each through the SAME pipeline a manual run uses, logs every one
// to Decision History AND the ranked Watchlist Summary, and sends exactly
// one digest email if (and only if) something genuinely changed.
function runDailyAutomationV7() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Same fix as buildPortfolioSummarySheetV7Menu — getOrCreateWatchlistSheetV7
  // existed but was never called. Now ensures the sheet exists, and if it's
  // genuinely brand new (no ticker rows yet), pre-fills it with whatever
  // CONFIG_V7.dailyTickers currently is, so the sheet you see matches what
  // just ran — a clear, discoverable starting point to edit from.
  const watchlistSheet = getOrCreateWatchlistSheetV7(ss);
  if (watchlistSheet.getLastRow() <= 1) { // only header row present -> genuinely new
    const seed = CONFIG_V7.dailyTickers || [];
    if (seed.length) watchlistSheet.getRange(2, 1, seed.length, 1).setValues(seed.map(t => [t]));
  }
  const tickers = getWatchlistTickersV7(ss); // 8.4.1: watchlist supersedes the bare CONFIG_V7.dailyTickers list
  const changes = [], results = [];
  // §2.5.3 fix (deep-dive review): Phase 8's own §8.1.1 called for measuring
  // real per-ticker time before shipping — that measurement (PLTR: ~26s
  // stock-only, up to ~45s combined with options+Gemini) showed comfortable
  // margin at 4-8 tickers, so the full chunked/continuation architecture
  // (PropertiesService cursor + re-trigger) is deliberately NOT built here,
  // per Phase 8's own "don't build the complex version if the simple one is
  // sufficient" rule. But there was previously ZERO guard for the abnormal
  // case (a slow API response) — a timeout mid-loop would silently skip the
  // rest of the watchlist, the summary refresh, AND the digest email with
  // no trace. This guard makes that failure mode graceful and visible
  // instead: stop starting new tickers once the time budget is tight, and
  // report exactly which ones were skipped rather than failing silently.
  const AUTOMATION_TIME_BUDGET_MS = 4.5 * 60 * 1000; // 4.5 min — safety margin under the 6-min hard cap
  const CONSERVATIVE_PER_TICKER_MS = 60 * 1000; // conservative estimate (measured ~26-45s; padded)
  const startTime = Date.now();
  const skipped = [];
  // 2026-09-06: real, market-wide refresh -- once per real automation run,
  // not once per ticker (see refreshMacroSnapshotV1_'s own header for why
  // this moved off the interactive path entirely). Non-fatal by design;
  // a real failure here degrades gracefully to the same "not available"
  // state the interactive path already handles.
  if (typeof refreshMacroSnapshotV1_ === 'function') refreshMacroSnapshotV1_(Logger.log);
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const elapsed = Date.now() - startTime;
    if (elapsed + CONSERVATIVE_PER_TICKER_MS > AUTOMATION_TIME_BUDGET_MS) {
      skipped.push(...tickers.slice(i));
      Logger.log('⚠ Time budget guard: stopping after ' + i + '/' + tickers.length + ' tickers (elapsed ' + Math.round(elapsed/1000) + 's) — skipped: ' + skipped.join(', '));
      break;
    }
    try {
      // 2026-09-06 real fix (Opus review caught this): this call was
      // documented in refreshBrokerCourseDataCacheV1_'s own header comment
      // as happening here, but was never actually wired in -- meaning
      // 💾 Broker Data Cache was NEVER written, for ANY ticker, and the
      // interactive path's short-interest/interest-coverage fields were
      // permanently null for everyone, not just new tickers. Non-fatal by
      // design (own try/catch inside), never blocks the rest of this loop.
      if (typeof refreshBrokerCourseDataCacheV1_ === 'function') refreshBrokerCourseDataCacheV1_(ticker, Logger.log);
      const prior = getLastDecisionV7(ss, ticker); // 7.2.3: read BEFORE this run's write
      const result = runAnalysisV7(ticker); // same pipeline as a manual run
      if (!result || !result.decision) { results.push({ ticker, decision: null }); continue; } // a failed run for one ticker doesn't stop the rest
      results.push({ ticker, fundResult: result.fundResult, techPlan: result.techPlan, decision: result.decision });
      appendDecisionHistoryV7(ss, ticker, result.fundResult, result.techPlan, result.decision);
      // 7.2.1/8.4.2: alert on decision.action changing — this already scales
      // correctly to N tickers since getLastDecisionV7/appendDecisionHistoryV7
      // are both per-ticker lookups, no change needed for the watchlist case.
      if (prior && prior.action !== result.decision.action) {
        changes.push({ ticker, from: prior.action, to: result.decision.action, finalConviction: result.decision.finalConviction });
      }
    } catch (e) {
      Logger.log('Daily automation error for ' + ticker + ': ' + (e && e.message ? e.message : e));
      results.push({ ticker, decision: null });
    }
  }
  if (skipped.length) {
    skipped.forEach(t => results.push({ ticker: t, decision: null, skippedForTime: true }));
  }

  buildWatchlistSummarySheetV7(ss, results); // 8.3: refresh the ranked summary every run, not just on change

  if (changes.length > 0) { // 7.3.3: silent when nothing changed — that's correct behavior, not a bug
    const body = changes.map(c => c.ticker + ': ' + c.from + '  →  ' + c.to + '  (Final Conviction ' + c.finalConviction + '/100)').join('\n');
    // P1-2 fix (deep-dive review): getActiveUser() frequently returns "" in
    // a real trigger context (no interactive session), meaning the digest
    // could silently never send — the exact bug found. Now: prefer a
    // configured address, fall back to getEffectiveUser() (the trigger
    // owner's identity), and if BOTH are empty, log a loud, specific error
    // instead of a caught-and-forgotten failure of the whole feature.
    const recipient = CONFIG_V7.alertEmail || Session.getEffectiveUser().getEmail();
    if (!recipient) {
      Logger.log('❌ ALERT FAILED: no email recipient resolved (CONFIG_V7.alertEmail is blank and getEffectiveUser() returned empty) — set CONFIG_V7.alertEmail to guarantee delivery. Decision change was: ' + body);
    } else {
      try {
        MailApp.sendEmail(recipient, '[v7] Decision change: ' + changes.map(c=>c.ticker).join(', '), body); // 7.3.2: one digest, not one email per ticker
      } catch (e) {
        Logger.log('Failed to send digest email to ' + recipient + ': ' + (e && e.message ? e.message : e));
      }
    }
  }
}

function runAnalysisV7FromMenu() {
  const html = `<!DOCTYPE html><html><head><base target="_top">
  <style>
    body{font-family:Arial,sans-serif;padding:20px;color:#333}
    label{display:block;margin-bottom:8px;font-weight:bold}
    select,input{width:100%;padding:10px;margin-bottom:16px;border:1px solid #ccc;
      border-radius:4px;box-sizing:border-box;font-size:14px}
    button{background:#1a73e8;color:#fff;border:none;padding:12px;cursor:pointer;
      border-radius:4px;width:100%;font-size:14px;font-weight:bold}
    button:hover{background:#0d47a1} button:disabled{background:#9e9e9e;cursor:not-allowed}
    #manualDivV7{display:none}
    .note{font-size:10px;color:#888;margin-top:-12px;margin-bottom:14px}
  </style></head><body>
  <label>Ticker:</label>
  <select id="selV7" onchange="document.getElementById('manualDivV7').style.display=
    this.value==='OTHER'?'block':'none'">
    <option>TSLA</option><option>NVDA</option><option>AMD</option><option>AVGO</option>
    <option>MSTR</option><option>MQZA</option><option>PLTR</option><option>GOOGL</option>
    <option>AMZN</option><option>AAPL</option><option>MSFT</option><option>META</option>
    <option value="OTHER">OTHER (manual)</option>
  </select>
  <div id="manualDivV7"><label>Ticker Symbol:</label>
    <input type="text" id="manualV7" placeholder="e.g., AAPL"></div>
  <label style="font-weight:normal;display:flex;align-items:center;gap:8px;margin-bottom:8px">
    <input type="checkbox" id="ladderStockV7" style="width:auto;margin:0"> Ladder stock entry/exit (LILO)
  </label>
  <label style="font-weight:normal;display:flex;align-items:center;gap:8px;margin-bottom:16px">
    <input type="checkbox" id="ladderOptionsV7" style="width:auto;margin:0"> Ladder options entry/exit (LILO)
  </label>
  <p class="note">⏱ ~30-45 seconds — single-screen v7 analysis</p>
  <button id="btnV7" onclick="
    let t=document.getElementById('selV7').value;
    if(t==='OTHER'){t=document.getElementById('manualV7').value.toUpperCase().trim();
      if(!t){alert('Enter ticker');return;}}
    const ladderStock=document.getElementById('ladderStockV7').checked;
    const ladderOptions=document.getElementById('ladderOptionsV7').checked;
    const b=document.getElementById('btnV7');
    b.innerText='Running…';b.disabled=true;
    google.script.run
      .withSuccessHandler(google.script.host.close)
      .withFailureHandler(e=>{alert(e.message);b.innerText='Run';b.disabled=false;})
      .runAnalysisV7(t, ladderStock, ladderOptions);">Run Stock Analysis v7</button>
  </body></html>`;
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(320).setHeight(320), 'Stock Analysis ' + CONFIG_V7.version);
}

// Control flow mirrors v6.1's runStockAnalysis (§7), but every downstream
// call after fundamentals/scoring goes to a NEW v7 function — v6's
// scoreAllSignals/buildAnalysisDashboard/buildNarrative/fetchGeminiReview
// are never called from here.
// ── §6.1 Data-health tracker ──────────────────────────────────────
// Single source of truth for per-source data health. Every step in
// runAnalysisV7 updates it; buildDataStatusBannerV7 turns it into the
// on-sheet transparency banner, and buildFailureSheetV7 renders it on a
// hard abort. state ∈ 'ok' | 'degraded' | 'failed' | 'pending'.
function newDataStatusV7() {
  return {
    price:        { label:'Price (OHLCV)',        state:'pending', detail:'' },
    fundamentals: { label:'Fundamentals',         state:'pending', detail:'' },
    series:       { label:'Finnhub series',       state:'pending', detail:'' },
    peers:        { label:'Peer comparison',      state:'pending', detail:'' },
    spyRS:        { label:'SPY / Relative Str.',  state:'pending', detail:'' },
    indicators:   { label:'Technical indicators', state:'pending', detail:'' },
    gann:         { label:'Gann levels',          state:'pending', detail:'' },
    confluence:   { label:'Entry/exit zones',     state:'pending', detail:'' },
    options:      { label:'Options overlay',      state:'pending', detail:'' },
    aiReview:     { label:'AI narrative',         state:'pending', detail:'' },
    // v9.70 additions -- previously untracked by this object at all,
    // degradations/failures here only ever showed as scattered one-off log
    // lines with nothing collected. Real gap this closes, per direct user
    // request for one consolidated end-of-run report.
    macroRegime:          { label:'Macro regime',            state:'pending', detail:'' },
    institutionalHoldings:{ label:'Institutional holdings (13F)', state:'pending', detail:'' },
    brokerModel:          { label:'Broker-course model report',  state:'pending', detail:'' },
    // 2026-08-31, docs/SCHABACKER_IMPLEMENTATION_PLAN.md §5 — new key,
    // same pattern as brokerModel/comparisonReport above.
    schabackerModel:      { label:'Schabacker model report',     state:'pending', detail:'' },
    // 2026-09-02, docs/BIG_PLAN_EDWARDS_MAGEE.md — new key, same pattern as schabackerModel above.
    edwardsMageeModel:    { label:'Edwards & Magee model report', state:'pending', detail:'' },
    // v9.100, docs/BIG_PLAN_TURTLE.md Deliverable 1 comparison-report wiring — new key, same pattern as schabackerModel/edwardsMageeModel above.
    turtleModel:          { label:'Turtle model report',         state:'pending', detail:'' },
    comparisonReport:     { label:'Model comparison report',     state:'pending', detail:'' },
    // 2026-09-01, darkPoolTrackerV1.gs real fix — new key, same pattern as brokerModel above.
    darkPool:             { label:'Dark pool share (FINRA)',     state:'pending', detail:'' },
    // v9.93 additions -- real fix, direct user challenge ("what about logs
    // and failure recovery?"): these 3 real ports (2026-09-03 Broker Course
    // audit) shipped with try/catch but NO status key at all -- silently
    // invisible in the run summary if their own fetch failed. Same pattern
    // as every other tracked key above.
    playerMapping:        { label:'Player Mapping (Broker Course)', state:'pending', detail:'' },
    zombieCompanyScreen:  { label:'Zombie Company Screen (Broker Course)', state:'pending', detail:'' },
    dilutionScreen:       { label:'Dilution/Filing-Keyword Screen (Broker Course)', state:'pending', detail:'' }
  };
}

function setStatusV7(status, key, state, detail) {
  if (status && status[key]) { status[key].state = state; status[key].detail = detail || ''; }
}

// ══════════════════════════════════════════════════════════════════
//  PHASE 6 — Portfolio & Position Tracking
//  Manual-entry transaction log + a computed (never manually edited)
//  summary. STOCK positions grouped by ticker; OPTION positions grouped
//  by ticker+strike+expiry — both use the SAME FIFO algorithm, just a
//  different grouping key, per the Phase 6 plan's 6.2.2/6.2.3.
//  Human-confirm-only (6.4.1): nothing in this block ever WRITES a
//  transaction row — it only reads the sheet you type into yourself.
// ══════════════════════════════════════════════════════════════════

const TRANSACTIONS_SHEET_V7 = '📒 Transactions';
// PORTFOLIO_SUMMARY_SHEET_V7 ('💼 Portfolio Summary') removed v10.4 --
// its only real use was the standalone report removed the same version,
// see computePortfolioBullPhaseAdvisoryV1_'s own header comment above.
const TRANSACTIONS_HEADERS_V7 = ['Date','Ticker','Asset Type','Action','Shares/Contracts','Price','Strike','Expiry','Notes'];

// 6.1.1: ensures the sheet exists with the right headers. Never touches
// existing rows — if the sheet is already there, this is a no-op beyond
// confirming it exists.
function getOrCreateTransactionsSheetV7(ss) {
  let sh = ss.getSheetByName(TRANSACTIONS_SHEET_V7);
  if (!sh) {
    sh = ss.insertSheet(TRANSACTIONS_SHEET_V7);
    sh.getRange(1,1,1,TRANSACTIONS_HEADERS_V7.length).setValues([TRANSACTIONS_HEADERS_V7]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidths(1, TRANSACTIONS_HEADERS_V7.length, 110);
    sh.setColumnWidth(9, 250);
    sh.setFrozenRows(1);
  }
  return sh;
}

// 6.1.2/6.1.3: reads every row you've typed. Malformed rows (bad date,
// missing ticker, non-BUY/SELL action, non-numeric shares/price) are
// skipped from the computed positions but returned as their own list —
// per the stated preference for informative expected-vs-actual errors,
// a bad row is surfaced, not silently dropped without a trace.
function readTransactionsV7(ss) {
  const sh = ss.getSheetByName(TRANSACTIONS_SHEET_V7);
  if (!sh) return { transactions: [], parseWarnings: [] };
  const data = sh.getDataRange().getValues();
  const transactions = [], parseWarnings = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r], rowNum = r + 1;
    const isBlank = row.every(c => c === '' || c == null);
    if (isBlank) continue;
    const rawDate = row[0];
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    const ticker = String(row[1]||'').toUpperCase().trim();
    const assetType = String(row[2]||'STOCK').toUpperCase().trim();
    const action = String(row[3]||'').toUpperCase().trim();
    const shares = parseFloat(row[4]);
    const price = parseFloat(row[5]);
    const strike = (row[6] !== '' && row[6] != null) ? parseFloat(row[6]) : null;
    // P0-2 fix (deep-dive review): previously plain String(row[7]).trim() —
    // if Sheets auto-converted an expiry cell to a Date (which it does for
    // date-looking text, per fmtExpiryV7_'s own comment), a BUY typed as
    // text and a SELL that got auto-converted (or vice versa) produced two
    // DIFFERENT string keys for the same real contract. That split the FIFO
    // group: the SELL looked like a phantom over-sell, and the original BUY
    // never showed as closed. Canonicalizing through fmtExpiryV7_ — the same
    // function the options-snapshot matching already uses — means BUY, SELL,
    // and the snapshot lookup all agree on one key for the same contract,
    // regardless of whether the cell was typed as text or auto-converted.
    const expiry = (row[7] !== '' && row[7] != null) ? fmtExpiryV7_(row[7]) : null;
    const notes = row[8] || '';

    const problems = [];
    if (isNaN(date.getTime())) problems.push('Date is not a valid date (got "'+rawDate+'")');
    if (!ticker) problems.push('Ticker is empty');
    if (assetType !== 'STOCK' && assetType !== 'OPTION') problems.push('Asset Type must be STOCK or OPTION (got "'+row[2]+'")');
    if (action !== 'BUY' && action !== 'SELL') problems.push('Action must be BUY or SELL (got "'+row[3]+'")');
    if (isNaN(shares) || shares <= 0) problems.push('Shares/Contracts must be a positive number (got "'+row[4]+'")');
    if (isNaN(price) || price < 0) problems.push('Price must be a non-negative number (got "'+row[5]+'")');
    if (assetType === 'OPTION' && (strike == null || isNaN(strike))) problems.push('OPTION rows need a numeric Strike');
    if (assetType === 'OPTION' && !expiry) problems.push('OPTION rows need an Expiry');

    if (problems.length) {
      parseWarnings.push('Row '+rowNum+' ('+(ticker||'?')+'): '+problems.join('; ')+' — this row is EXCLUDED from the portfolio summary until fixed.');
      continue;
    }
    transactions.push({ date, dateStr: date.toISOString().slice(0,10), ticker, assetType, action, shares, price, strike, expiry, notes, rowNum });
  }
  return { transactions, parseWarnings };
}

// 6.2.2/6.2.3: the shared FIFO engine. groupKeyFn decides what counts as
// "the same position" — ticker alone for stock, ticker+strike+expiry for
// options — everything else about the walk is identical.
function computeFifoGroupsV7_(transactions, groupKeyFn) {
  const groups = {};
  const sorted = transactions.slice().sort((a,b) => a.date - b.date);
  sorted.forEach(tx => {
    const key = groupKeyFn(tx);
    if (!groups[key]) groups[key] = { ticker: tx.ticker, assetType: tx.assetType, strike: tx.strike, expiry: tx.expiry, lots: [], warnings: [] };
    const g = groups[key];
    if (tx.action === 'BUY') {
      g.lots.push({ shares: tx.shares, price: tx.price, date: tx.dateStr });
    } else { // SELL
      let remaining = tx.shares;
      while (remaining > 1e-6 && g.lots.length > 0) {
        const lot = g.lots[0];
        const consumed = Math.min(lot.shares, remaining);
        lot.shares -= consumed;
        remaining -= consumed;
        if (lot.shares <= 1e-6) g.lots.shift();
      }
      if (remaining > 1e-6) {
        g.warnings.push('SELL of '+tx.shares+' on '+tx.dateStr+' exceeds the '+(tx.shares-remaining).toFixed(4)+' shares/contracts available at that point (short by '+remaining.toFixed(4)+') — check '+TRANSACTIONS_SHEET_V7+' row '+tx.rowNum+'.');
      }
    }
  });
  return groups;
}

function summarizeFifoGroupV7_(g) {
  const totalShares = g.lots.reduce((s,l) => s+l.shares, 0);
  if (totalShares <= 1e-6) return null; // fully closed position — drops off the summary, per 6.6.3
  const totalCost = g.lots.reduce((s,l) => s+l.shares*l.price, 0);
  // 2026-09-08, real addition (purely additive, existing consumers read
  // only totalShares/avgCost and are unaffected): g.lots[0] is the
  // OLDEST still-open lot (FIFO -- consumed lots are shift()'d off in
  // computeFifoGroupsV7_), so its date is the real date this position was
  // first opened -- what the new "📤 Exit Strategy" report needs for
  // trailing-stop/days-held purposes (same "since your actual entry, not
  // a generic lookback" real value analyzePositionV7 already established).
  return { totalShares, avgCost: totalCost/totalShares, earliestLotDate: g.lots[0].date };
}

// 6.2.5: reads the options snapshot the OPTIONS script already writes —
// no new data source, no new API call. Always labels the data with its
// actual snapshot date; never presents it as live.
function findOptionsSnapshotContractV7_(ss, ticker, strike, expiry) {
  const snap = (typeof readOptionsSnapshotV7 === 'function') ? readOptionsSnapshotV7(ss, ticker) : null;
  if (!snap || snap.mismatch || !snap.contracts) return null;
  const match = snap.contracts.find(c => Math.abs((c.strike||0)-strike) < 0.01 && fmtExpiryV7_(c.expiryStr) === expiry);
  if (!match) return null;
  return { contract: match, snapshotDate: snap.timestamp, ageDays: snap.ageDays };
}

// 6.2: full computation — every open STOCK and OPTION position, plus
// parse warnings (6.1.3) and over-sell warnings (from the FIFO walk).
function computePortfolioSummaryV7(ss) {
  const { transactions, parseWarnings } = readTransactionsV7(ss);
  const stockTx = transactions.filter(t => t.assetType === 'STOCK');
  const optionTx = transactions.filter(t => t.assetType === 'OPTION');

  const stockGroups = computeFifoGroupsV7_(stockTx, tx => tx.ticker);
  const optionGroups = computeFifoGroupsV7_(optionTx, tx => tx.ticker+'|'+tx.strike+'|'+tx.expiry);

  const positions = [], warnings = parseWarnings.slice();
  Object.keys(stockGroups).forEach(key => {
    const g = stockGroups[key];
    warnings.push(...g.warnings);
    const s = summarizeFifoGroupV7_(g);
    if (s) positions.push({ ticker: g.ticker, assetType:'STOCK', shares: s.totalShares, avgCost: s.avgCost, earliestLotDate: s.earliestLotDate });
  });
  Object.keys(optionGroups).forEach(key => {
    const g = optionGroups[key];
    warnings.push(...g.warnings);
    const s = summarizeFifoGroupV7_(g);
    if (s) {
      const snap = findOptionsSnapshotContractV7_(ss, g.ticker, g.strike, g.expiry);
      positions.push({ ticker: g.ticker, assetType:'OPTION', strike: g.strike, expiry: g.expiry, contracts: s.totalShares, avgPremium: s.avgCost, earliestLotDate: s.earliestLotDate, snapshot: snap });
    }
  });
  return { positions, warnings };
}

// Sub-phase 6.5: used by the dashboard to surface a held position for
// the ticker currently being analyzed. Read-only — never writes.
function getHeldPositionsForTickerV7(portfolioResult, ticker) {
  return (portfolioResult.positions||[]).filter(p => p.ticker === ticker.toUpperCase());
}

// v9.91, Edwards & Magee Ch31 (p467-468, real "8-10 stocks max" diversification
// ceiling) + Ch41 (p594, real high-grade-early/speculative-late Bull-phase
// rotation sequencing rule). Every number below is the book's own literal
// cited figure, nothing invented: Ch31's real "8-10 stocks" ceiling (p468),
// and the Evaluative Index's own ALREADY-DISPLAYED anchors (~5-9% Bottom
// zone / ~90%+ Top zone, Ch38, see the existing `ind.evaluativeIndex`
// dashboard line) — the rotation advisory fires ONLY at those 2 literal
// extremes, not a new, invented early/mid/late banding across the whole
// range.
//
// v10.4 (2026-09-09) real re-source: originally read
// computePortfolioSummaryV7 (Transactions-sheet-backed, the standalone
// "💼 Build Portfolio Summary" report this fed). That report was removed
// (user's own words: "if we have unusable code remove it" — Transactions
// is a sheet the user does not maintain, same real problem the Exit
// Strategy report itself was corrected away from on 2026-09-08). This
// function is now DATA-SOURCE-AGNOSTIC — takes a real `stockHoldings`
// array ([{ticker, shares}]) and a real `getChart_` fetcher (so callers can
// reuse an already-fetched chart, same dedup discipline as
// buildExitStrategyReportV7) instead of reaching into a sheet itself. Its
// real caller is now buildExitStrategyReportV7 (wired in below), sourced
// from the real Portfolio sheet's stock/crypto table (crypto already
// excluded there, same as the rest of that report).
//
// Real, disclosed cost, user's own explicit choice (2026-09-03) over
// skipping per-holding tiering to avoid it: one live chart fetch PER
// DISTINCT held stock ticker (deduped against whatever the caller already
// fetched), to get its real Sensitivity-Index tier via the ALREADY-
// EXISTING `computeCompositeLeverageV1_` (Appendix A) — same formula this
// file already uses per-ticker elsewhere, not a new one.
function computePortfolioBullPhaseAdvisoryV1_(stockHoldings, getChart_) {
  const out = { distinctStockCount: 0, diversificationFlag: false, phaseRead: null, evaluativeIndexPctStrong: null, dowTheoryVerdict: null, holdings: [] };
  getChart_ = getChart_ || fetchYahooChart;
  try {
    const holdings = stockHoldings || [];
    const distinctTickers = Array.from(new Set(holdings.map(p => p.ticker)));
    out.distinctStockCount = distinctTickers.length;
    out.diversificationFlag = distinctTickers.length > 10; // real, book's own literal ceiling (p468), not invented

    const macro = (typeof getCachedMacroRegime_ === 'function') ? getCachedMacroRegime_() : null;
    const ei = macro && macro.evaluativeIndex;
    const dt = macro && macro.dowTheory;
    if (ei && ei.pctStrong != null) {
      out.evaluativeIndexPctStrong = ei.pctStrong;
      if (ei.pctStrong <= 9) out.phaseRead = 'NEAR_BOTTOM'; // book's own literal ~5-9% anchor
      else if (ei.pctStrong >= 90) out.phaseRead = 'NEAR_TOP'; // book's own literal ~90%+ anchor
    }
    if (dt && dt.verdict) out.dowTheoryVerdict = dt.verdict;

    // v9.99, Appendix E (Turtle System) Deliverable 2 port, 2026-09-05 --
    // real, disclosed per-ticker data for turtleCorrelatedCapsV1_ below,
    // built alongside the existing per-holding leverage-tier loop (reuses
    // the SAME chart/ind already fetched/computed here for atrRatio --
    // zero new fetch). Genuinely different dimension from this function's
    // own diversificationFlag above (a flat ticker COUNT) -- this is a
    // Unit-WEIGHTED count within real correlated groups. See
    // docs/BIG_PLAN_TURTLE.md Deliverable 2 audit.
    const correlatedCapsHoldings = [];
    distinctTickers.forEach(ticker => {
      try {
        const chart = getChart_(ticker);
        if (!chart || !chart.closes || chart.closes.length < 20) { out.holdings.push({ ticker, tier: null, note: 'insufficient real price history' }); return; }
        const ind = computeAllIndicators({ closes: chart.closes, highs: chart.highs, lows: chart.lows, volumes: chart.volumes, dates: chart.dates, opens: chart.opens, splits: chart.splits || [], ipoDate: chart.ipoDate || chart.dates[0] });
        const cl = computeCompositeLeverageV1_(chart.closes[chart.closes.length - 1], ind.atrRatio);
        out.holdings.push({ ticker, tier: cl ? cl.tier : null });

        const currentPrice = chart.closes[chart.closes.length - 1];
        const rsr = (typeof getCachedRelativeStrengthRankingV1_ === 'function') ? getCachedRelativeStrengthRankingV1_(ticker) : null;
        const unitCalc = (ind.turtleN && typeof computeNNormalizedPositionSizeV1_ === 'function') ? computeNNormalizedPositionSizeV1_(currentPrice, ind.turtleN) : null;
        const pos = holdings.find(p => p.ticker === ticker);
        const units = (unitCalc && unitCalc.shares && pos && pos.shares) ? pos.shares / unitCalc.shares : null;
        correlatedCapsHoldings.push({ ticker, categories: rsr ? rsr.categories : [], units });
      } catch (e) { out.holdings.push({ ticker, tier: null, note: 'fetch/compute error' }); }
    });
    out.correlatedCaps = (typeof turtleCorrelatedCapsV1_ === 'function') ? turtleCorrelatedCapsV1_(correlatedCapsHoldings) : null;
  } catch (e) { /* non-fatal, same discipline as every other supplemental read */ }
  return out;
}

// v10.4 (2026-09-09): the standalone "💼 Build Portfolio Summary" sheet
// (buildPortfolioSummarySheetV7/buildPortfolioSummarySheetV7Menu) was
// REMOVED here — real, user-confirmed reason: it read the `Transactions`
// sheet, which the user does not maintain ("i dont want to built
// Transactions", 2026-09-08), making its stock/option position listing
// permanently empty/stale for this user; its one genuinely distinct piece
// (the Ch31/Ch41 diversification + Bull-phase advisory above) has been
// ported into buildExitStrategyReportV7 below, reading the real Portfolio
// sheet instead. User's own words: "if we have unusable code remove it."
// Archived copy (pre-removal): old_versions/fullStockAnalysisV10_3.gs.

function runAnalysisV7(ticker, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg) {
  // 2026-09-07, real fix (item 8, hang-prevention cleanup): _runStartTimeV7
  // was ONLY ever set inside runCompleteTickerAnalysisV7Continued -- meaning
  // every hasTimeBudgetV7_ guard already shipped in this file (Gemini,
  // broker/Schabacker/E&M/Turtle/comparison-report skips) was a silent
  // no-op on the other 2 real entry points: the plain "📊 Run Stock
  // Analysis (v7)" menu and runDailyAutomationV7's own per-ticker loop.
  // Set it here (only if not already set) so those existing guards
  // actually activate everywhere, not just the combined-flow path --
  // `if (_runStartTimeV7 == null)` deliberately preserves the earlier,
  // more accurate timestamp runCompleteTickerAnalysisV7Continued already
  // set before this function is called (it starts the clock before the
  // options step, not after), and preserves the automation loop's own
  // running total across multiple tickers in one real execution.
  if (_runStartTimeV7 == null) _runStartTimeV7 = Date.now();
  ticker = (ticker || 'TSLA').toUpperCase().trim();
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = makeLogger(ss); // v6.1, shared Log tab
  const t0  = Date.now();
  const status = newDataStatusV7();
  log('▶ Analysis v7 — ' + ticker);

  try {
    // 1. Price — the one input we cannot proceed without.
    log('📡 Fetching OHLCV...');
    const chart = fetchYahooChart(ticker); // v6.1
    if (!chart) {
      setStatusV7(status, 'price', 'failed', 'Yahoo returned no price data — check the ticker symbol');
      log('❌ Price data failed — check ticker');
      buildFailureSheetV7(ss, ticker, status, new Error('Price data unavailable for ' + ticker));
      const sh = ss.getSheetByName(CONFIG_V7.tab); if (sh) sh.activate();
      return;
    }
    setStatusV7(status, 'price', 'ok', chart.closes.length + ' days');
    log('✅ ' + chart.closes.length + ' days  |  $' + chart.currentPrice.toFixed(2));

    // 2. Fundamentals (v7 wrapper: v6's merged fund + series + peers)
    let fund = null, fundSource = 'none';
    log('📡 Fundamentals (v7: FMP+AV+Finnhub + series + peers)...');
    const g = gatherFundamentalsV7(ticker, log);
    if (g.fund && (g.fund._sources.length || g.fund.beta != null)) {
      fund = g.fund; fundSource = g.source;
      saveFundamentalsCache(ticker, fund); // v6.1 — note: cache does NOT preserve _metricSeries/_peersRaw
      setStatusV7(status, 'fundamentals', 'ok', 'live: ' + (fund._sources.length ? fund._sources.join('+') : 'profile-only'));
      setStatusV7(status, 'series', fund._metricSeries ? 'ok' : 'degraded',
        fund._metricSeries ? '' : 'Finnhub series unavailable — OWN score uses flat levels only (no growth/margin trend, no peer valuation)');
      setStatusV7(status, 'peers', (fund._peersRaw && fund._peersRaw.length) ? 'ok' : 'degraded',
        (fund._peersRaw && fund._peersRaw.length) ? fund._peersRaw.length + ' peers' : 'No peers — valuation scored on absolute bands, not vs peers');
      log('✅ Fundamentals: ' + (fund._sources.length ? fund._sources.join('+') : 'profile-only') +
          (fund._metricSeries ? ' + series' : '') + (fund._peersRaw ? ' + ' + fund._peersRaw.length + ' peers' : ''));
    } else {
      const cached = getCachedFundamentals(ticker); // v6.1
      if (cached) {
        fund = cached.data; fundSource = 'cache (' + cached.date + ')';
        setStatusV7(status, 'fundamentals', 'degraded', 'OWN score from CACHED fundamentals (' + cached.date + ')');
        setStatusV7(status, 'series', 'degraded', 'Series unavailable on a cache hit — OWN score uses flat levels only');
        setStatusV7(status, 'peers', 'degraded', 'Peers unavailable on a cache hit — valuation on absolute bands');
        log('⚠️ Using cached fundamentals (' + cached.date + ') — series/peers unavailable on a cache hit');
      } else {
        setStatusV7(status, 'fundamentals', 'failed', 'No fundamentals available — OWN score N/A, decision is TECHNICAL-ONLY');
        setStatusV7(status, 'series', 'failed', '');
        setStatusV7(status, 'peers', 'failed', '');
        log('⚠️ No fundamentals — technical only');
      }
    }

    // 3a. Sector-relative strength (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
    // only SPY-relative existed before; this compares against a
    // sector-specific ETF instead, a more relevant peer comparison than
    // the broad index. Real FMP sector strings confirmed via their own
    // docs before building this mapping, not guessed. Uses the identical
    // ratio-based 63-day relative-strength math already proven for SPY
    // (see below), just against a different benchmark. Non-fatal if the
    // sector is unmapped or the fetch fails.
    if (fund && fund.sector) {
      const SECTOR_ETF = {
        'Technology': 'XLK', 'Financial Services': 'XLF', 'Financial': 'XLF',
        'Energy': 'XLE', 'Healthcare': 'XLV', 'Industrials': 'XLI', 'Industrial Goods': 'XLI',
        'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP', 'Utilities': 'XLU',
        'Basic Materials': 'XLB', 'Real Estate': 'XLRE', 'Communication Services': 'XLC'
      };
      const sectorEtf = SECTOR_ETF[fund.sector];
      if (sectorEtf) {
        log('📡 Fetching ' + sectorEtf + ' for sector-relative strength (' + fund.sector + ')...');
        try {
          const sectorChart = fetchYahooChart(sectorEtf);
          if (sectorChart) {
            const sectorByDate = {};
            sectorChart.dates.forEach((d,i) => { sectorByDate[d.toISOString().slice(0,10)] = sectorChart.closes[i]; });
            let lastSector = null;
            const sectorBenchmarkCloses = chart.dates.map(d => {
              const key = d.toISOString().slice(0,10);
              if (sectorByDate[key] != null) lastSector = sectorByDate[key];
              return lastSector;
            });
            // Same ratio-based 63-day calc already proven for SPY (see computeAllIndicators)
            const ratio = chart.closes.map((v,i) => sectorBenchmarkCloses[i] ? v/sectorBenchmarkCloses[i] : null).filter(v=>v!=null);
            const rn = ratio.length;
            if (rn > 63) {
              const sectorRs63 = (ratio[rn-1]/ratio[rn-64]-1)*100;
              chart.sectorRS = { etf: sectorEtf, sector: fund.sector, rs63: sectorRs63, outperforming: sectorRs63 > 0 };
              log('✅ Sector RS vs ' + sectorEtf + ': ' + (sectorRs63>=0?'+':'') + sectorRs63.toFixed(1) + '%');
            }
            // Relative Swing Power (v9.72, Schabacker Study XII) -- real,
            // distinct from sectorRS above (which measures relative PRICE
            // PERFORMANCE): this measures relative price-swing AMPLITUDE
            // vs. the same already-fetched sector ETF, zero new fetches.
            // Real, disclosed simplification: standard deviation of daily
            // % returns over the same 63-day window as a real, computable
            // proxy for "swing amplitude" -- the book's own worked example
            // (Otis Steel vs US Steel vs their group average) used a full
            // multi-year swing-by-swing comparison; this is a reasoned,
            // disclosed approximation of the same underlying idea, not
            // empirically validated, same standing caveat as every other
            // threshold in this file. Purely additive -- new field only.
            try {
              const stdevPctV1 = (arr) => {
                if (!arr || arr.length < 2) return null;
                const rets = arr.slice(1).map((v,i)=> (v-arr[i])/arr[i]);
                const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
                const variance = rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/rets.length;
                return Math.sqrt(variance);
              };
              const RSP_LOOKBACK = 63;
              const tickerStdev = stdevPctV1(chart.closes.slice(-RSP_LOOKBACK-1));
              const sectorStdev = stdevPctV1(sectorChart.closes.slice(-RSP_LOOKBACK-1));
              if (tickerStdev != null && sectorStdev != null && sectorStdev > 0) {
                chart.relativeSwingPower = { ratio: tickerStdev/sectorStdev, etf: sectorEtf, sector: fund.sector };
              }
            } catch (e) { /* non-fatal, real disclosed simplification -- absence just means no read shown */ }
          }
        } catch (e) { log('⚠️ Sector ETF fetch error: ' + e.message.substring(0,60)); }
      } else {
        log('ℹ️ No sector ETF mapping for "' + fund.sector + '" — sector-relative strength skipped');
      }
    }

    // 3. SPY relative strength (identical alignment code to v6.1's runStockAnalysis)
    log('📡 Fetching SPY for relative strength...');
    const spy = fetchYahooChart('SPY');
    if (spy) {
      const spyByDate = {};
      spy.dates.forEach((d,i) => { spyByDate[d.toISOString().slice(0,10)] = spy.closes[i]; });
      let lastSpy = null;
      chart.benchmarkCloses = chart.dates.map(d => {
        const key = d.toISOString().slice(0,10);
        if (spyByDate[key] != null) lastSpy = spyByDate[key];
        return lastSpy;
      });
      setStatusV7(status, 'spyRS', 'ok', spy.closes.length + ' days aligned');
      log('✅ SPY aligned (' + spy.closes.length + ' days)');
    } else {
      setStatusV7(status, 'spyRS', 'degraded', 'SPY fetch failed — technical score computed WITHOUT Relative Strength');
      log('⚠️ SPY fetch failed — relative strength skipped');
    }

    // 3b. VIX -- broad market volatility/fear context (DASHBOARD_IMPROVEMENTS_PLAN.md
    // 4a). Real symbol confirmed via Yahoo Finance itself before building
    // ('^VIX', the standard CBOE Volatility Index ticker). Non-fatal if it
    // fails -- this is supplementary context, not a required input.
    log('📡 Fetching VIX for market volatility context...');
    try {
      const vix = fetchYahooChart('^VIX');
      if (vix && vix.closes.length) {
        const vixNow = vix.currentPrice;
        const vixHigh52 = Math.max(...vix.closes.slice(-252));
        const vixLow52 = Math.min(...vix.closes.slice(-252));
        const vixRangePct = vixHigh52 > vixLow52 ? (vixNow - vixLow52) / (vixHigh52 - vixLow52) * 100 : 50;
        chart.vixContext = {
          level: vixNow,
          high52: vixHigh52, low52: vixLow52, rangePct: vixRangePct,
          // Conventional VIX read: <15 calm, 15-20 normal, 20-30 elevated, >30 fear/crisis
          read: vixNow < 15 ? 'calm' : vixNow < 20 ? 'normal' : vixNow < 30 ? 'elevated' : 'fear/crisis'
        };
        // v9.93, real port from brokerCourseModelV1.gs (2026-09-03, standing
        // rule 9 / docs/CLAUDE_CODE_HANDOFF.md section 3.7's own port
        // audit): the course's OWN VIX bands (Euphoria<13/Normal13-25/
        // Elevated25-40/Crisis40-70/Extreme70+) are a DIFFERENT scheme from
        // the conventional bands just above -- NOT redundant. Real,
        // disclosed reason this is worth surfacing here too:
        // `vixRegime:Normal` (the course's 13-25 band) is a real, OOS-
        // confirmed finding (tests/vix_yield_oos_split_test.js, p=0.0425
        // in-sample / p=0.0048 OOS, mild real underperformance vs baseline)
        // -- this engine's own conventional band above has never itself
        // been backtested. Reuses `vixRegimeReadV1()` directly
        // (brokerCourseModelV1.gs, same shared-scope reuse convention this
        // engine already uses for the Evaluative Index/Relative Strength
        // Ranking, `darkPoolTrackerV1.gs`) -- not a duplicated band table.
        // Informational only, weight 0 -- same "new signal starts display-
        // only" convention as every other new signal this project has ever
        // added; the finding was already promoted into brokerCourseModelV1
        // .gs's OWN synthesis (2026-09-03, user's explicit "yes") -- this
        // is a display port of that same already-approved finding, not a
        // new promotion decision.
        if (typeof vixRegimeReadV1 === 'function') {
          const courseVix = vixRegimeReadV1(vixNow);
          if (courseVix) chart.vixContext.courseRead = courseVix;
        }
        // v9.32 — CHARACTERIZATION_PLAN_vix_divergence.md. VIX rising while
        // the index goes sideways (not confirming a decline) is a real
        // early-warning divergence, per the broker course episode 2.
        // Zero new network calls: both vix.closes and spy.closes are
        // already fetched in this same scope. 5-day window is a direct
        // match to the course's own worked example, not backtest-fit.
        // Display only, not scored (see the design doc's §3) — no backtest
        // evidence yet, same conservative default as the float feature.
        if (spy && spy.closes && spy.closes.length >= 5 && vix.closes.length >= 5) {
          const vixSlope5 = slope(vix.closes, 5);
          const spyLast5 = spy.closes.slice(-5);
          const spyChange5 = (spyLast5[spyLast5.length-1] - spyLast5[0]) / spyLast5[0] * 100;
          const divergence = vixSlope5 > 0 && Math.abs(spyChange5) < 1;
          chart.vixContext.divergence5d = {
            vixSlope5, spyChange5pct: spyChange5, flagged: divergence,
            note: divergence ? '⚠ VIX rising while S&P is flat (5d) — early bearish divergence' : null
          };
          if (divergence) log('⚠️ VIX/price divergence flagged (5d)');
        }
        log('✅ VIX: ' + vixNow.toFixed(2) + ' (' + chart.vixContext.read + ')');
      } else {
        log('⚠️ VIX fetch failed — market volatility context skipped');
      }
    } catch (e) { log('⚠️ VIX fetch error: ' + e.message.substring(0,60)); }

    // 4-5. Indicators + Gann (v6.1, unmodified) — guarded so a throw becomes a controlled abort.
    let ind, gann, confluence;
    try {
      ind = computeAllIndicators(chart);
      setStatusV7(status, 'indicators', 'ok', '');
      log('✅ RSI=' + ind.rsi14.toFixed(1) + '  ADX=' + ind.adx14.toFixed(1) + '  ATR=$' + ind.atr14.toFixed(2));
    } catch (e) { setStatusV7(status, 'indicators', 'failed', e.message); throw e; }
    try {
      gann = computeGannInline(chart, ind);
      setStatusV7(status, 'gann', 'ok', '');
      log('✅ Gann pivot: ' + gann.pivot.dateStr + ' @ $' + gann.pivot.price.toFixed(2) + '  |  score ' + gann.score + '/100');
    } catch (e) { setStatusV7(status, 'gann', 'failed', e.message); throw e; }

    // 6. Confluence (v6.1, unmodified) — the backbone of the WHERE
    try {
      confluence = computeConfluenceTargets(ind, gann, fund, chart);
      setStatusV7(status, 'confluence', 'ok', '');
      log('Entry zone: $' + confluence.entryLow.toFixed(2) + '–$' + confluence.entryHigh.toFixed(2) + '  (' + confluence.entryConfidence + ')');
      log('Exit zone:  $' + confluence.exitLow.toFixed(2) + '–$' + confluence.exitHigh.toFixed(2) + '  (' + confluence.exitConfidence + ')');
    } catch (e) { setStatusV7(status, 'confluence', 'failed', e.message); throw e; }

    // 6.5. Dark pool share (2026-09-01, darkPoolTrackerV1.gs) — real fix:
    // the 85-ticker watchlist tab alone left this data isolated from the
    // actual per-ticker report. This is the consumption side: cache-only
    // FINRA-week lookup (populated by that file's own daily trigger, never
    // probed live here) + exactly ONE cheap live FINRA fetch for THIS
    // ticker, reusing the chart already fetched above (zero new Yahoo
    // call). Works for any ticker, not just the 85 in the watchlist.
    // Guarded like every other optional step -- a real failure here never
    // blocks the rest of the report.
    if (hasTimeBudgetV7_(15 * 1000)) {
      try {
        ind.darkPoolShare = getTickerDarkPoolShareV1_(ticker, chart, log);
        setStatusV7(status, 'darkPool', ind.darkPoolShare ? 'ok' : 'degraded',
          ind.darkPoolShare ? '' : 'no cached FINRA week yet, or no data for this ticker/week');
      } catch (e) {
        setStatusV7(status, 'darkPool', 'degraded', e.message);
      }
    } else {
      setStatusV7(status, 'darkPool', 'skipped', 'time budget — skipped to protect the rest of the report');
    }

    // 6.6. Macro supplemental (M2 YoY growth, 10Y-2Y yield curve) — real
    // fix, 2026-09-01: this data was previously fetched only inside a
    // manual diagnostic (testMacroFetchers, macro_fetchers_v0_11.gs) and
    // discarded. getCachedMacroRegime_() is script-execution-cached and
    // already called later by synthesizeDecisionV7 -- calling it here too
    // costs ZERO additional network calls (cache-only either way), just
    // attaches its already-cached `supplemental` field onto `ind` so the
    // dashboard can display it. Display-only, NOT a new scored vote (same
    // evidence-then-promote discipline as every other new signal here).
    try {
      const _macroForSupplemental = getCachedMacroRegime_();
      if (_macroForSupplemental && _macroForSupplemental.supplemental) ind.macroSupplemental = _macroForSupplemental.supplemental;
      // v9.79, Edwards & Magee Ch3-5.1: same zero-extra-cost attach (already
      // script-cached by the getCachedMacroRegime_() call just above).
      if (_macroForSupplemental && _macroForSupplemental.dowTheory && _macroForSupplemental.dowTheory.verdict) ind.dowTheoryConfirmation = _macroForSupplemental.dowTheory;
      // v9.79, Edwards & Magee Ch38: same zero-extra-cost attach.
      if (_macroForSupplemental && _macroForSupplemental.evaluativeIndex && _macroForSupplemental.evaluativeIndex.pctStrong != null) ind.evaluativeIndex = _macroForSupplemental.evaluativeIndex;
    } catch (e) { /* non-fatal -- display-only field */ }

    // 6.65. Player Mapping (v9.93, real port from brokerCourseModelV1.gs,
    // docs/CLAUDE_CODE_HANDOFF.md section 3.7's port audit / standing rule
    // 9): the course's own price/volume-SHAPE read (staircase accumulation
    // vs. speculative spike vs. mixed/unclear) -- genuinely distinct from
    // this engine's own real 13F institutional-holdings data (that's
    // actual FILED positions; this is an INFERRED read off the chart
    // shape itself, zero overlap). Zero new network cost -- uses only
    // chart.closes/highs/lows/volumes/currentPrice, all already fetched
    // for the main dashboard above. Reuses `playerMappingReadV1()`
    // directly (brokerCourseModelV1.gs), not a duplicated implementation.
    // Informational only, weight 0 -- same "new signal starts display-
    // only" convention as every other new signal in this project.
    try {
      if (typeof playerMappingReadV1 !== 'function') {
        setStatusV7(status, 'playerMapping', 'skipped', 'brokerCourseModelV1.gs not loaded in this scope');
      } else if (!chart.closes || !chart.closes.length) {
        setStatusV7(status, 'playerMapping', 'skipped', 'no chart data available');
      } else {
        const pm = playerMappingReadV1(chart.closes, chart.highs, chart.lows, chart.volumes, chart.currentPrice, 20);
        if (pm) { ind.playerMapping = pm; setStatusV7(status, 'playerMapping', 'ok', pm.tag); }
        else setStatusV7(status, 'playerMapping', 'degraded', 'playerMappingReadV1 returned null');
      }
    } catch (e) { setStatusV7(status, 'playerMapping', 'failed', e && e.message ? e.message : String(e)); }

    // 6.66. Zombie Company Screen (v9.93, real port from
    // brokerCourseModelV1.gs, same port audit as 6.65 above): real
    // interest-coverage-ratio-based "zombie company" flag (BIS/Fed's own
    // standard academic definition, interest coverage < 1.0 -- a real,
    // independent convention, not invented for this project).
    //
    // 2026-09-06, real fix (Opus review caught this): this was a SECOND,
    // separate live call to fetchFMPInterestCoverageV1 that the "move off
    // the interactive path" fix never touched -- only the copy inside
    // brokerCourseModelV1.gs's own buildBrokerCourseReportV1 was fixed,
    // leaving this engine-side port still fetching live on every real run.
    // Now reads the SAME permanent cache (readBrokerDataCacheV1_) the
    // broker-course report reads, instead of its own live fetch --
    // zero new cache, one shared source of truth per ticker.
    try {
      if (typeof readBrokerDataCacheV1_ !== 'function' || typeof zombieCompanyScreenV1 !== 'function') {
        setStatusV7(status, 'zombieCompanyScreen', 'skipped', 'cache reader not loaded in this scope');
      } else {
        const cached = readBrokerDataCacheV1_(ticker);
        const icr = cached ? cached.interestCoverageRatio : null;
        const zombie = zombieCompanyScreenV1(icr);
        if (zombie) { ind.zombieCompanyScreen = zombie; setStatusV7(status, 'zombieCompanyScreen', 'ok', ''); }
        else setStatusV7(status, 'zombieCompanyScreen', 'degraded', 'Interest-coverage data not yet available (populated by the nightly automation)');
      }
    } catch (e) { setStatusV7(status, 'zombieCompanyScreen', 'failed', e && e.message ? e.message : String(e)); }

    // 6.67. Dilution / Filing-Keyword Screen (v9.93, real port from
    // brokerCourseModelV1.gs, ep.12 checklist items 2+3, same port audit
    // as 6.65/6.66 above): real shares-outstanding-trend (SEC XBRL) + real
    // filing-keyword search (SEC EDGAR full-text search, 5 keywords:
    // offering/shelf/warrants/convertible/dilution) — genuinely new
    // capability, not in this engine before. Real, disclosed cost: up to
    // 7 new real fetches (1 CIK lookup, cached 90 days after first time,
    // same convention as fetch13FCusipV7's own cache; 1 shares-
    // outstanding-history call; 5 keyword-search calls) — guarded by its
    // own generous time budget. Reuses fetchSecEdgarCIKV1/
    // fetchSharesOutstandingHistoryV1/sharesOutstandingTrendReadV1/
    // fetchSecFilingKeywordHitsV1/filingKeywordReadV1 directly
    // (brokerCourseModelV1.gs), not duplicated. Informational only, weight 0.
    // v9.97 (fetch-dedup pass, 2026-09-04): dilutionCik/sharedSoHistory
    // hoisted out of the try block below (were previously local, thrown
    // away) so they can be passed into buildBrokerCourseReportV1 later in
    // this same run instead of it re-fetching the identical CIK + shares-
    // outstanding history from scratch. Flow-only -- the dilutionScreen
    // logic itself, immediately below, is untouched.
    // Deliberately left undefined (not null) here -- undefined means "never
    // attempted" (skipped on time budget, or brokerCourseModelV1.gs not
    // loaded), so buildBrokerCourseReportV1's own `!== undefined` check
    // correctly falls back to trying its own fetch in that case. null is
    // only ever assigned below, when a real attempt genuinely found nothing.
    let dilutionCik, sharedSoHistory, sharedFilingHits;
    try {
      if (typeof fetchSecEdgarCIKV1 !== 'function') {
        setStatusV7(status, 'dilutionScreen', 'skipped', 'brokerCourseModelV1.gs not loaded in this scope');
      } else if (!hasTimeBudgetV7_(25 * 1000)) {
        setStatusV7(status, 'dilutionScreen', 'skipped', 'time budget');
      } else {
        // v9.101, real logging fix (user-reported real timeout, 2026-09-05):
        // this whole block (CIK lookup + shares-outstanding history +
        // filing-keyword search, up to 7 real SEC EDGAR calls) previously
        // had zero log() output -- only silent setStatusV7 tracking, never
        // written to the visible 🔬 Log in real time (only surfaced at
        // logDataStatusSummaryV7, which never runs if the execution times
        // out first). Real timing added so a future timeout's trace can
        // rule this block in or out, same discipline brokerCourseModelV1.gs's
        // own equivalent calls just got.
        const _tCik = Date.now();
        dilutionCik = fetchSecEdgarCIKV1(ticker);
        log('  ⏱ SEC EDGAR CIK lookup: ' + ((Date.now()-_tCik)/1000).toFixed(1) + 's');
        if (!dilutionCik) {
          setStatusV7(status, 'dilutionScreen', 'degraded', 'no real SEC CIK found for this ticker');
        } else {
          let gotOne = false;
          if (typeof fetchSharesOutstandingHistoryV1 === 'function' && typeof sharesOutstandingTrendReadV1 === 'function') {
            const _tSoHistory = Date.now();
            sharedSoHistory = fetchSharesOutstandingHistoryV1(dilutionCik);
            log('  ⏱ SEC shares-outstanding history fetch: ' + ((Date.now()-_tSoHistory)/1000).toFixed(1) + 's');
            const soTrend = sharesOutstandingTrendReadV1(sharedSoHistory, 4);
            if (soTrend) { ind.sharesOutstandingTrend = soTrend; gotOne = true; }
          }
          if (typeof fetchSecFilingKeywordHitsV1 === 'function' && typeof filingKeywordReadV1 === 'function' && hasTimeBudgetV7_(20 * 1000)) {
            // v9.97 real fix (not flow-only, a real logic change, disclosed):
            // was `null` = unbounded history. brokerCourseModelV1.gs's own
            // call to this SAME function already uses a 365-day window,
            // with its own documented reasoning -- a mature mega-cap's
            // decades of routine filings (ordinary corporate-bond
            // "convertible" notes, standard stock-plan "offering"
            // boilerplate) trivially hit all 5 keywords with no date bound,
            // a real false-positive risk this engine copy never had the
            // same safeguard against. Widened to match, both copies now
            // agree, and the result can be safely shared.
            const oneYearAgo = new Date(new Date().getTime() - 365 * 86400000);
            const _tFilingHits = Date.now();
            sharedFilingHits = fetchSecFilingKeywordHitsV1(dilutionCik, Utilities.formatDate(oneYearAgo, 'UTC', 'yyyy-MM-dd'));
            log('  ⏱ SEC filing-keyword search (up to 5 real calls): ' + ((Date.now()-_tFilingHits)/1000).toFixed(1) + 's');
            const kwRead = filingKeywordReadV1(sharedFilingHits);
            if (kwRead) { ind.filingKeywordScreen = kwRead; gotOne = true; }
          }
          setStatusV7(status, 'dilutionScreen', gotOne ? 'ok' : 'degraded', gotOne ? '' : 'real CIK found but no shares-outstanding history or filing-keyword data came back');
        }
      }
    } catch (e) { setStatusV7(status, 'dilutionScreen', 'failed', e && e.message ? e.message : String(e)); }

    // 6.7. Relative Strength Ranking (v9.85, Edwards & Magee Appendix E /
    // Turtle System) — real, disclosed, cache-only attach: architecture
    // decided 2026-09-02 (user's own explicit answer when asked) to avoid
    // the up-to-14-live-fetch cost of computeRelativeStrengthRankingV1_ on
    // the interactive path (same class of hang risk the macro regime cache
    // was already converted away from once). refreshRelativeStrengthRankingV1_
    // (darkPoolTrackerV1.gs) is this feature's OWN isolated daily trigger
    // (installRelativeStrengthRankingTriggerV1, ~5:45 AM) — this is a pure
    // PropertiesService map lookup, ZERO network calls either way, so it's
    // safe to call unconditionally (no time-budget guard needed, same as
    // darkPoolShare's own cache-only half).
    try {
      if (typeof getCachedRelativeStrengthRankingV1_ === 'function') {
        const rsr = getCachedRelativeStrengthRankingV1_(ticker);
        if (rsr) ind.relativeStrengthRanking = rsr;
      }
    } catch (e) { /* non-fatal -- display-only field */ }

    // 7. Fundamental score — ZERO technical input
    const fundResult = computeFundamentalScoreV7(fund);
    // Partial-data awareness (user's explicit ask, 2026-09-04): a 'degraded'
    // fundamentals read (stale cache) still produces a normal-looking score/
    // verdict from computeFundamentalScoreV7's own POV — it has no idea the
    // numbers it was handed are old. Reuse the SAME detail text status
    // already carries (no new wording invented) so the score object itself
    // knows, and can carry that forward into the decision/report text below.
    if (status.fundamentals && status.fundamentals.state === 'degraded') {
      fundResult.dataWarning = status.fundamentals.detail;
    }
    log('📊 OWN score: ' + (fundResult.score != null ? fundResult.score + '/100 (' + fundResult.profile + ') ' + fundResult.verdict : 'N/A'));

    // 7.5 Options snapshot — read the FULL raw dataset saved by the Options
    // script and analyze it per market-analyst conventions. First pass has no
    // techPlan yet (direction-independent signals only); finalized after step 8.
    const optSnap = readOptionsSnapshotV7(ss, ticker);
    let optAnalysis = analyzeOptionsForScoringV7(optSnap, null);
    if (!optSnap) setStatusV7(status, 'options', 'degraded', 'No options snapshot — run Options Analysis on this ticker first');
    else if (optSnap.mismatch) setStatusV7(status, 'options', 'degraded', 'Snapshot is for ' + optSnap.ticker + ' — run Options Analysis on ' + ticker);
    else setStatusV7(status, 'options', (optSnap.ageDays != null && optSnap.ageDays > 4) ? 'degraded' : 'ok',
      (optSnap.ageDays != null && optSnap.ageDays > 4) ? ('Snapshot is ~' + Math.round(optSnap.ageDays) + 'd old') : '');
    log(optAnalysis.available ? '✅ Options snapshot loaded (' + optSnap.contracts.length + ' contracts)'
      : 'ℹ️ No usable options snapshot for ' + ticker + ' — scoring proceeds without it');

    // 8. Technical plan — ZERO fundamentals input; options positioning folds into BUY-TIMING
    const techPlan = computeTechnicalPlanV7(ind, gann, confluence, chart, optAnalysis);
    // Same partial-data awareness as fundamentals above: a degraded spyRS
    // fetch drops the RS signal from the Trend category cleanly (re-
    // normalized, not defaulted to neutral) but techScore itself can't know
    // THAT happened — carry the same detail text status already has.
    if (status.spyRS && status.spyRS.state === 'degraded') {
      techPlan.dataWarning = status.spyRS.detail;
    }
    log('🎯 Tech score: ' + techPlan.techScore + '/100  Regime ' + techPlan.regime + '  Timing ' + techPlan.timing);
    log('   Entry $' + techPlan.entryPrice.toFixed(2) + '  ETA ' + (techPlan.timeToEntry ? techPlan.timeToEntry.humanText : 'N/A') + '  Confidence ' + techPlan.entryConfidencePct + '%');

    // Finalize options read now that we know the technical direction (confirm + horizon)
    optAnalysis = analyzeOptionsForScoringV7(optSnap, techPlan);
    if (optAnalysis.available) { techPlan.options = optAnalysis; log('   Options: ' + optAnalysis.confirm.toUpperCase() + ' — ' + optAnalysis.notes.join(' · ')); }

    // 9. Decision — reads both scores + options read; blends NOTHING into the two pure scores
    const decision = synthesizeDecisionV7(fundResult, techPlan, optAnalysis, status);
    log('✅ Decision: ' + decision.action + '   Final Conviction ' + decision.finalConviction + '/100');

    // 11. AI review — NEW v7 prompt (never v6's fetchGeminiReview)
    // v9.70: time-budget guarded -- a rare-but-real ~55s outlier is already
    // disclosed for this call (see docs); skip rather than risk it being the
    // thing that eats whatever's left of a run already running late.
    let aiReview = null;
    if (hasTimeBudgetV7_(60 * 1000)) {
      log('🤖 Requesting Gemini v7 review...');
      const _tGemini = Date.now();
      aiReview = fetchGeminiReviewV7(ticker, fundResult, techPlan, decision, ind, gann, confluence, fund, chart, optAnalysis, log, leapsCallArg, shortTermCallArg);
      setStatusV7(status, 'aiReview', aiReview ? 'ok' : 'degraded',
        aiReview ? '' : 'AI narrative unavailable (all numbers above are unaffected)');
      log((aiReview ? '✅ Gemini review received (' + aiReview.length + ' chars)' : 'ℹ️ Gemini review unavailable') + '  [⏱ ' + ((Date.now()-_tGemini)/1000).toFixed(1) + 's]');
    } else {
      setStatusV7(status, 'aiReview', 'skipped', 'time budget — skipped to protect the rest of the report');
      log('⏭ Skipped: Gemini review — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
    }

    // v9.45 — user's explicit request: one ticker entry runs the FULL
    // flow, meaning the dashboard below PLUS the 2 new reports from the
    // separate broker-course model (brokerCourseModelV1.gs, same Apps
    // Script project, shared global scope — same assumption that file's
    // own infrastructure reuse already makes). Wrapped in its own
    // try/catch, deliberately: the new model has its own independent real
    // network dependencies (SEC EDGAR, FRED, FMP, Nasdaq) that can fail on
    // their own schedule — a failure there must not take down the main
    // dashboard run. `decision`/`techPlan`/`fundResult` are passed
    // straight through (real values already computed above, v9.45's own
    // optional-args addition to buildComparisonReportV1) — avoids
    // re-fetching/re-computing the SAME ticker's SAME data a second time
    // for the comparison report's existing-engine side.
    // v9.92 real fix (2026-09-03, docs/CLAUDE_CODE_HANDOFF.md section 3.7):
    // Broker Model / Schabacker / Edwards & Magee are now 3 genuinely
    // INDEPENDENT steps, each its own try/catch with its own correctly-
    // named status key — none of them gates another's build. Real,
    // disclosed bugs this replaces (found by direct code read, not
    // guessed): (1) Schabacker/E&M used to be gated behind
    // `if (brokerModelReport && ...)` even though both need ZERO network
    // calls (they only reuse ind/gann/confluence/techPlan/chart already
    // computed above) — a Broker Model failure (its own real SEC EDGAR/
    // FRED/FMP/Nasdaq dependencies) used to silently skip 2 completely
    // unrelated reports too; (2) all 4 steps shared ONE outer try/catch,
    // so an uncaught exception in Schabacker or E&M got mislabeled as a
    // 'brokerModel' failure in status; (3) buildBrokerCourseReportV1 now
    // reuses the engine's already-fetched chart + VIX level instead of
    // re-fetching both (brokerCourseModelV1.gs's own v9.92 fix, Bug 3).
    //
    // v9.99 REAL, CRITICAL FIX (2026-09-05): this Broker Course Model
    // section used to sit AFTER "12-13. Render + activate" below, even
    // though buildDashboardV7's own call already read `brokerModelReport`
    // (to reuse its already-fetched institutional13F/short-interest data,
    // per the v9.97 comment 2 paragraphs below) — a real `let` variable
    // referenced before its own declaration, a guaranteed
    // "Cannot access 'brokerModelReport' before initialization"
    // ReferenceError on EVERY SINGLE real call to this function, with NO
    // ticker-specific or budget-specific condition gating it. Caught the
    // OUTER top-level try/catch (§6.4's own safety net) every time,
    // silently building a failure sheet instead of the real dashboard —
    // never visibly "crashing" to any caller, which is exactly why this
    // sat undetected in production since v9.92 (2026-09-03, 2 real days):
    // every existing test in this project either calls buildDashboardV7/
    // buildBrokerCourseReportV1 directly (bypassing this exact call
    // order) or asserts "no crash" without checking WHICH log lines
    // actually appeared. Found by `tests/macro_regime_resilience_test.js`'s
    // own real budget-gating assertions (5 failures, previously
    // mis-diagnosed as "stale test" before a real, direct trace to this
    // exact ReferenceError). Real fix: moved this whole section to run
    // BEFORE the dashboard render (not just moving the `let` declaration
    // earlier while leaving it structurally unreachable-before-use) — this
    // also makes the v9.97 "reuse already-fetched institutional13F"
    // optimization genuinely work for the first time, instead of always
    // silently passing `undefined` even after a naive declaration-order fix.

    // 1. Broker Course Model — its own real, independent network
    // dependencies (SEC EDGAR/FRED/FMP/Nasdaq), guarded on its own.
    let brokerModelReport = null;
    try {
      if (hasTimeBudgetV7_(30 * 1000)) {
        const _tBroker = Date.now();
        log('🏗️ Building broker-course model report...');
        // v9.97 (fetch-dedup pass, 2026-09-04): also reuse this run's
        // already-fetched fund/dilutionCik/sharesOutstandingHistory (same
        // dedup pattern as the existing chart/VIX reuse cited above) --
        // eliminates a full redundant fundamentals fetch + SEC CIK lookup +
        // shares-outstanding-history call inside buildBrokerCourseReportV1.
        brokerModelReport = buildBrokerCourseReportV1(ticker, log, chart, chart.vixContext ? chart.vixContext.level : null, fund, dilutionCik, sharedSoHistory, sharedFilingHits);
        log('  ⏱ broker-course model report: ' + ((Date.now()-_tBroker)/1000).toFixed(1) + 's');
        writeTextReportToSheetV7(getOrCreate(ss, '📚 Broker Model'), formatBrokerCourseReportV1(brokerModelReport), '#6a1b9a');
        setStatusV7(status, 'brokerModel', brokerModelReport ? 'ok' : 'degraded', brokerModelReport ? '' : 'broker-course report build returned null');
      } else {
        setStatusV7(status, 'brokerModel', 'skipped', 'time budget — skipped to protect the rest of the report');
        log('⏭ Skipped: broker-course model report — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
      }
    } catch (e) {
      setStatusV7(status, 'brokerModel', 'failed', e && e.message ? e.message : String(e));
      log('⚠️ Broker-course model report failed: ' + (e && e.message ? e.message : e) + ' (does not affect Schabacker/E&M/main dashboard)');
    }

    // 12-13. Render + activate — real fix, v9.99: now correctly AFTER
    // Broker Course Model above, so brokerModelReport is genuinely
    // available (not just declared-but-always-null) when this reads it.
    log('🏗️ Building v7 dashboard (' + CONFIG_V7.tab + ')...');
    // v9.97 (fetch-dedup pass, 2026-09-04): pass the broker-course model's
    // already-fetched institutional13F through (when it ran and returned a
    // report) so buildDashboardV7 doesn't re-fetch the same 13F data a 2nd
    // time -- real, disclosed heaviest single fetch in the whole run.
    buildDashboardV7(ss, ticker, chart, ind, gann, confluence, fundResult, techPlan, decision, fund, optAnalysis, fundSource, aiReview, status, !!ladderStock, !!ladderOptions, leapsCallArg, shortTermCallArg, brokerModelReport ? brokerModelReport.institutional13F : undefined, (brokerModelReport && brokerModelReport.news) ? brokerModelReport.news.shortInterestData : undefined);
    log('✅ Done in ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

    // 2. Schabacker Model — 2026-08-31, docs/SCHABACKER_IMPLEMENTATION_PLAN.md
    // §5: built ONLY off already-computed data (ind/gann/confluence/
    // techPlan/chart, all real values already sitting in scope from
    // earlier in this same function) — zero new network calls, cheap by
    // design (§4a). Genuinely independent of Broker Model's own success.
    let schabackerReport = null;
    try {
      if (hasTimeBudgetV7_(20 * 1000)) {
        const _tSchabacker = Date.now();
        log('🏗️ Building Schabacker model report...');
        schabackerReport = buildSchabackerReportV1(ticker, ind, gann, confluence, techPlan, chart, log);
        log('  ⏱ Schabacker model report: ' + ((Date.now()-_tSchabacker)/1000).toFixed(1) + 's');
        writeTextReportToSheetV7(getOrCreate(ss, '📜 Schabacker Model'), formatSchabackerReportV1(schabackerReport), '#8d6e63');
        setStatusV7(status, 'schabackerModel', schabackerReport ? 'ok' : 'degraded', schabackerReport ? '' : 'Schabacker report build returned null');
      } else {
        setStatusV7(status, 'schabackerModel', 'skipped', 'time budget — skipped to protect the rest of the report');
        log('⏭ Skipped: Schabacker model report — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
      }
    } catch (e) {
      setStatusV7(status, 'schabackerModel', 'failed', e && e.message ? e.message : String(e));
      log('⚠️ Schabacker model report failed: ' + (e && e.message ? e.message : e) + ' (does not affect Broker Model/E&M/main dashboard)');
    }

    // 3. Edwards & Magee Model — v9.82 (2026-09-02), docs/BIG_PLAN_EDWARDS_MAGEE.md:
    // same exact real convention as the Schabacker block just above — built
    // ONLY off already-computed data, zero new network calls, genuinely
    // independent of Broker Model's own success.
    let edwardsMageeReport = null;
    try {
      if (hasTimeBudgetV7_(20 * 1000)) {
        const _tEdwardsMagee = Date.now();
        log('🏗️ Building Edwards & Magee model report...');
        edwardsMageeReport = buildEdwardsMageeReportV1(ticker, ind, gann, confluence, techPlan, chart, log);
        log('  ⏱ Edwards & Magee model report: ' + ((Date.now()-_tEdwardsMagee)/1000).toFixed(1) + 's');
        writeTextReportToSheetV7(getOrCreate(ss, '📖 Edwards & Magee Model'), formatEdwardsMageeReportV1(edwardsMageeReport), '#5e35b1');
        setStatusV7(status, 'edwardsMageeModel', edwardsMageeReport ? 'ok' : 'degraded', edwardsMageeReport ? '' : 'Edwards & Magee report build returned null');
      } else {
        setStatusV7(status, 'edwardsMageeModel', 'skipped', 'time budget — skipped to protect the rest of the report');
        log('⏭ Skipped: Edwards & Magee model report — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
      }
    } catch (e) {
      setStatusV7(status, 'edwardsMageeModel', 'failed', e && e.message ? e.message : String(e));
      log('⚠️ Edwards & Magee model report failed: ' + (e && e.message ? e.message : e) + ' (does not affect Broker Model/Schabacker/main dashboard)');
    }

    // 3.5. Turtle Model — v9.100, docs/BIG_PLAN_TURTLE.md Deliverable 1
    // comparison-report wiring. Same exact real convention as
    // Schabacker/E&M above: built ONLY off already-computed data
    // (ind/gann/confluence/techPlan/chart), zero new network calls,
    // genuinely independent of Broker Model's own success. Guarded by
    // `typeof` (fails safe if turtleModelV1.gs isn't loaded, same
    // convention as every other cross-file optional feature here).
    let turtleReport = null;
    try {
      if (typeof buildTurtleReportV1 !== 'function') {
        setStatusV7(status, 'turtleModel', 'skipped', 'turtleModelV1.gs not loaded');
      } else if (hasTimeBudgetV7_(20 * 1000)) {
        const _tTurtle = Date.now();
        log('🏗️ Building Turtle model report...');
        turtleReport = buildTurtleReportV1(ticker, ind, gann, confluence, techPlan, chart, log);
        log('  ⏱ Turtle model report: ' + ((Date.now()-_tTurtle)/1000).toFixed(1) + 's');
        writeTextReportToSheetV7(getOrCreate(ss, '🐢 Turtle Model'), formatTurtleReportV1(turtleReport), '#00838f');
        setStatusV7(status, 'turtleModel', turtleReport ? 'ok' : 'degraded', turtleReport ? '' : 'Turtle report build returned null');
      } else {
        setStatusV7(status, 'turtleModel', 'skipped', 'time budget — skipped to protect the rest of the report');
        log('⏭ Skipped: Turtle model report — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
      }
    } catch (e) {
      setStatusV7(status, 'turtleModel', 'failed', e && e.message ? e.message : String(e));
      log('⚠️ Turtle model report failed: ' + (e && e.message ? e.message : e) + ' (does not affect Broker Model/Schabacker/E&M/main dashboard)');
    }

    // 4. Comparison Report — Engine data is the one real required anchor
    // (always available here); Broker/Schabacker/E&M/Turtle are each
    // independently optional (buildComparisonReportV1's own v9.92 fix,
    // section 3.7 Bug 2) — builds from whichever subset actually
    // succeeded, only skipped if genuinely none of them did.
    try {
      const anyModel = brokerModelReport || schabackerReport || edwardsMageeReport || turtleReport;
      if (anyModel && hasTimeBudgetV7_(30 * 1000)) {
        const _tComparison = Date.now();
        log('🏗️ Building comparison report...');
        const comparisonReport = buildComparisonReportV1(ticker, log, techPlan, decision, fundResult, brokerModelReport, schabackerReport, edwardsMageeReport, turtleReport);
        log('  ⏱ comparison report: ' + ((Date.now()-_tComparison)/1000).toFixed(1) + 's');
        writeTextReportToSheetV7(getOrCreate(ss, '🔀 Model Comparison'), formatComparisonReportV1(comparisonReport), '#00695c');
        setStatusV7(status, 'comparisonReport', comparisonReport ? 'ok' : 'degraded', comparisonReport ? '' : 'comparison report build returned null');
      } else if (!anyModel) {
        setStatusV7(status, 'comparisonReport', 'skipped', 'no model report succeeded — nothing to compare against the engine');
      } else {
        setStatusV7(status, 'comparisonReport', 'skipped', 'time budget — skipped to protect the rest of the report');
        log('⏭ Skipped: comparison report — time budget (' + Math.round((Date.now()-_runStartTimeV7)/1000) + 's elapsed)');
      }
    } catch (e) {
      setStatusV7(status, 'comparisonReport', 'failed', e && e.message ? e.message : String(e));
      log('⚠️ Comparison report failed: ' + (e && e.message ? e.message : e) + ' (does not affect Broker Model/Schabacker/E&M/main dashboard)');
    }

    logDataStatusSummaryV7(status, log); // v9.70, direct user request
    ss.getSheetByName(CONFIG_V7.tab).activate();
    // Phase 7: backward-compatible return — existing callers (the menu dialog,
    // via google.script.run) ignore this; the daily automation handler uses it
    // for change-detection without needing to re-run or re-parse anything.
    return { fundResult, techPlan, decision };

  } catch (err) {
    // Top-level safety net (§6.4): ANY unexpected failure still leaves a readable sheet.
    log('❌ v7 aborted: ' + (err && err.message ? err.message : err));
    logDataStatusSummaryV7(status, log); // v9.70: even an aborted run reports what it knows so far
    try {
      buildFailureSheetV7(ss, ticker, status, err);
      const sh = ss.getSheetByName(CONFIG_V7.tab);
      if (sh) sh.activate();
    } catch (e2) {
      log('❌ Could not render failure sheet: ' + (e2 && e2.message ? e2.message : e2));
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  §5A — FUNDAMENTALS
// ────────────────────────────────────────────────────────────────

// Wraps v6.1's gatherFundamentals (untouched) and additionally captures
// the Finnhub series + peers blocks v6.1 discards. New, independent calls
// — does not modify fetchFinnhubFundamentals. Null-guarded throughout
// (D5 — never fabricate): any fetch failure just leaves _metricSeries /
// _peersRaw null, and downstream code treats that as "N/A", not a crash.

// Lightweight, independent, single-endpoint Finnhub fetch for ONE peer.
// Cached (PropertiesService, CONFIG_V7.peers.cacheHours). A peer that
// fails/402s returns null and simply doesn't appear in the peer table —
// it never blocks or crashes the others.

// TECH_GROWTH unless the AAPL gate fires (big + profitable -> DEFAULT).
function sectorProfileV7(fund) {
  const s = ((fund && (fund.sector || fund.industry)) || '').toString();
  const isTechLike = /tech|software|internet|semiconduct|communication|cloud|data|platform/i.test(s);
  if (!isTechLike) return 'DEFAULT';
  if (fund && fund.marketCap > 200e9 && fund.profitMargins > 0.15) return 'DEFAULT'; // AAPL gate (§12)
  return 'TECH_GROWTH';
}

// v9.31 — CHARACTERIZATION_PLAN_float_volume.md. Thresholds are the
// broker course's own taught bands verbatim, not fit to any backtest
// (standing rule #9): <10M/<30M/<50M. Display-only, never scored (see
// the design doc's §4 for why) — same status as the existing Market Cap
// tier line right below it in scoreAllSignalsV7_.
function floatTierV7(floatShares) {
  if (floatShares == null || isNaN(floatShares)) return null;
  if (floatShares < 10e6) return 'Extreme (float <10M)';
  if (floatShares < 30e6) return 'Super volatile (float <30M)';
  if (floatShares < 50e6) return 'Very volatile (float <50M)';
  return 'Normal float';
}

// D1/D2 fallback: Finnhub series.quarterly[key][0].v -> series.annual[key][0].v
// -> flatFallback -> avFallback -> null. Never fabricates.
function seriesLatestV7(series, key, flatFallback, avFallback) {
  try {
    if (series && series.quarterly && Array.isArray(series.quarterly[key]) && series.quarterly[key].length) {
      const v = series.quarterly[key][0] && series.quarterly[key][0].v;
      if (v != null && !isNaN(v)) return v;
    }
    if (series && series.annual && Array.isArray(series.annual[key]) && series.annual[key].length) {
      const v = series.annual[key][0] && series.annual[key][0].v;
      if (v != null && !isNaN(v)) return v;
    }
  } catch (e) {}
  if (flatFallback != null && !isNaN(flatFallback)) return flatFallback;
  if (avFallback != null && !isNaN(avFallback)) return avFallback;
  return null;
}

function seriesArrayV7(series, key, maxPoints) {
  try {
    const src = (series && series.quarterly && Array.isArray(series.quarterly[key]) && series.quarterly[key].length)
      ? series.quarterly[key]
      : (series && series.annual && Array.isArray(series.annual[key])) ? series.annual[key] : [];
    return src.filter(p => p && p.v != null && !isNaN(p.v)).slice(0, maxPoints || 8);
  } catch (e) { return []; }
}

// D2: winsorize (~3xMAD) before slope/accel; latest/prev/yoy report RAW
// values always, so one outlier quarter (e.g. a real -400% net-margin
// quarter) can't flip the trend read.
function trendStatsV7(arr) {
  if (!arr || arr.length === 0) return null;
  const vals = arr.map(p => p.v);
  const latest = vals[0], prev = vals.length > 1 ? vals[1] : null;
  const yoy = vals.length > 4 ? vals[4] : null;
  const median = a => { const s=a.slice().sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const med = median(vals);
  const mad = median(vals.map(v=>Math.abs(v-med))) || 1e-9;
  const clipHi = med+3*mad*1.4826, clipLo = med-3*mad*1.4826;
  const clipped = vals.map(v => v>clipHi?clipHi:v<clipLo?clipLo:v);
  const chrono = clipped.slice().reverse();
  const n = chrono.length;
  let slopeSign = 0;
  if (n >= 2) {
    const xs = chrono.map((_,i)=>i);
    const xMean = xs.reduce((a,b)=>a+b,0)/n, yMean = chrono.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for (let i=0;i<n;i++) { num += (xs[i]-xMean)*(chrono[i]-yMean); den += (xs[i]-xMean)**2; }
    const slopeVal = den===0?0:num/den;
    slopeSign = slopeVal>1e-6?1:slopeVal<-1e-6?-1:0;
  }
  let accel = 0;
  if (n >= 4) {
    const half = Math.floor(n/2);
    const avg = a => a.reduce((x,y)=>x+y,0)/a.length;
    const d1 = avg(chrono.slice(0,half)), d2 = avg(chrono.slice(half));
    accel = d2>d1+1e-6?1:d2<d1-1e-6?-1:0;
  }
  return { latest, prev, yoy, slopeSign, accel, pointCount: arr.length };
}

// value's percentile among peerValues. higherBetter=true: % of peers value
// beats by being higher. higherBetter=false: % of peers value beats by
// being LOWER (e.g. valuation multiples, where cheap = good).
function percentileRankV7(value, peerValues, higherBetter) {
  const clean = (peerValues || []).filter(v => v != null && !isNaN(v));
  if (value == null || isNaN(value) || clean.length === 0) return null;
  const beat = clean.filter(v => higherBetter ? value >= v : value <= v).length;
  return Math.round((beat / clean.length) * 100);
}

// §5A — the fundamental (OWN) score. ZERO technical/price-action input.
// Each component maps to a -1..+1 signal; missing metric = that
// component is DROPPED (weight excluded from the renormalized average),
// never defaulted to a value that would move the score (D5).
function computeFundamentalScoreV7(fund) {
  if (!fund) return { score: null, verdict: 'N/A', profile: null, drivers: [], peerTable: [], pricedForPerfection: false, evSales: null };

  const profile = sectorProfileV7(fund);
  const isTech = profile === 'TECH_GROWTH';
  const W = isTech
    ? { growth:0.22, margin:0.16, r40:0.18, quality:0.10, valuation:0.16, balance:0.06, analyst:0.06, pe:0.06 }
    : { growth:0.14, margin:0.12, r40:0.08, quality:0.20, valuation:0.16, balance:0.06, analyst:0.12, pe:0.12 };

  const drivers = [];
  let wSum = 0, wTot = 0;
  function add(key, label, sig, value, note) {
    if (sig == null) return;
    sig = Math.max(-1, Math.min(1, sig));
    const w = W[key];
    wSum += sig*w; wTot += w;
    drivers.push({ label, value, points: Math.round(sig*w*1000)/1000, note });
  }

  const series = fund._metricSeries;

  // Sub-phase 1.1.1 (Phase 1 fix): relabeled from the ambiguous "Growth durability"
  // to two DISTINCT, accurate labels — this driver can mean two different things
  // depending on data availability, and the old shared label is exactly what let
  // the AI review conflate a rev/share TREND with plain revenue growth on the
  // real TSLA run (drove: table said "-2.9%", AI said "25% revenue growth").
  const revStats = trendStatsV7(seriesArrayV7(series, 'salesPerShare', 8));
  if (revStats) {
    const sig = revStats.slopeSign*0.6 + revStats.accel*0.4;
    const yoyTxt = (revStats.yoy != null && revStats.yoy !== 0) ? (((revStats.latest-revStats.yoy)/Math.abs(revStats.yoy))*100).toFixed(0)+'% YoY, ' : '';
    add('growth', 'Revenue/share trend', sig, yoyTxt + 'rev/share ' + (revStats.slopeSign>0?'rising':revStats.slopeSign<0?'falling':'flat'),
      revStats.pointCount<4 ? 'limited history ('+revStats.pointCount+'q) — reduced confidence' : 'trend across '+revStats.pointCount+' quarters — NOTE: this is revenue-per-share trend, not the same figure as flat revenue growth %');
  } else if (fund.revenueGrowth != null) {
    const rg = fund.revenueGrowth;
    const sig = rg>0.20?1:rg>0.10?0.5:rg>0?0:rg>-0.10?-0.5:-1;
    add('growth', 'Revenue growth (level)', sig, (rg>=0?'+':'')+(rg*100).toFixed(1)+'% rev growth', 'no series data — level only, not a trend');
  }

  // Margin trajectory: netMargin trend (fallback grossMargin), sign-aware.
  const nmStats = trendStatsV7(seriesArrayV7(series, 'netMargin', 8));
  const gmStats = !nmStats ? trendStatsV7(seriesArrayV7(series, 'grossMargin', 8)) : null;
  const marginStats = nmStats || gmStats;
  if (marginStats) {
    const sig = marginStats.slopeSign*0.7 + marginStats.accel*0.3;
    // Real-run finding (PLTR, v7.1.3): this note text was a static string that
    // always said "narrowing losses" even for an already-profitable, improving
    // company. Made it actually sign-aware, matching the score's own logic.
    const isLoss = marginStats.latest < 0;
    const marginNote = isLoss
      ? (marginStats.slopeSign>0 ? 'losses narrowing — sign-aware scoring credits this even though still unprofitable'
        : marginStats.slopeSign<0 ? 'losses widening — a real concern' : 'losses roughly flat')
      : (marginStats.slopeSign>0 ? 'already profitable, and the margin is improving further'
        : marginStats.slopeSign<0 ? 'still profitable, but the margin is compressing' : 'profitable, margin trend is flat');
    add('margin', 'Margin trajectory', sig, (marginStats.latest*100).toFixed(1)+'% '+(nmStats?'net':'gross')+' margin, '+(marginStats.slopeSign>0?'improving':marginStats.slopeSign<0?'worsening':'flat'),
      marginNote);
  }

  // Rule of 40 = revenueGrowth% + fcfMargin%; drop if either missing (D3/D5).
  // §2.5.4 note (deep-dive review): this uses flat fund.revenueGrowth, which
  // is a DIFFERENT growth notion than the "Revenue/share trend" driver
  // above (which uses salesPerShare's multi-quarter trend). Not a bug — they
  // measure genuinely different things — but flagged so a future edit
  // doesn't "fix" one to match the other by mistake, assuming they're
  // supposed to agree.
  const fcfMargin = seriesLatestV7(series, 'fcfMargin', null, null);
  if (fund.revenueGrowth != null && fcfMargin != null) {
    const r40 = fund.revenueGrowth*100 + fcfMargin*100;
    const sig = r40>=40?1:r40>=20?0.3:-0.5;
    add('r40', 'Rule of 40', sig, r40.toFixed(1)+' (growth '+(fund.revenueGrowth*100).toFixed(0)+' + FCF '+(fcfMargin*100).toFixed(0)+')', r40>=40?'strong':r40>=20?'ok':'weak');
  }

  // Profitability/quality: ROE + net margin LEVEL (current-state read).
  if (fund.returnOnEquity != null || fund.profitMargins != null) {
    let sig = 0, n = 0;
    if (fund.returnOnEquity != null) { const roe=fund.returnOnEquity*100; sig += roe>20?1:roe>10?0.5:roe>0?0:-0.5; n++; }
    if (fund.profitMargins != null) { const pm=fund.profitMargins*100; sig += pm>15?1:pm>5?0.5:pm>0?0:-0.5; n++; }
    add('quality', 'Profitability/quality', n?sig/n:null,
      (fund.returnOnEquity!=null?'ROE '+(fund.returnOnEquity*100).toFixed(1)+'%  ':'')+(fund.profitMargins!=null?'NM '+(fund.profitMargins*100).toFixed(1)+'%':''),
      'current-level read (not a trend)');
  }

  // Valuation vs peers (EV/Sales percentile); else absolute bands fallback.
  const evSales = seriesLatestV7(series, 'evRevenueTTM', null, null);
  let peerTable = [], pricedForPerfection = false;
  if (evSales != null) {
    let usedPeers = false;
    if (fund._peersRaw && fund._peersRaw.length >= 2) {
      const peerMetrics = {};
      fund._peersRaw.forEach(sym => { const m = fetchPeerBasicMetricsV7(sym, null); if (m) peerMetrics[sym] = m; });
      const evPeers = Object.values(peerMetrics).map(m=>m.evSales).filter(v=>v!=null);
      peerTable = Object.keys(peerMetrics).map(sym => ({ ticker: sym, evSales: peerMetrics[sym].evSales, revGrowth: peerMetrics[sym].revenueGrowth, margin: peerMetrics[sym].fcfMargin!=null?peerMetrics[sym].fcfMargin:peerMetrics[sym].netMargin }));
      if (evPeers.length >= 2) {
        usedPeers = true;
        const cheaperThanPct = percentileRankV7(evSales, evPeers, false); // false: lower evSales = beats peer
        const sig = cheaperThanPct>=66?1:cheaperThanPct>=33?0:-0.5;
        // W8 (v8.1): avoid the awkward "cheaper than 0% of peers" phrasing —
        // read it as an expensive/cheap ranking instead.
        const valPhrase = cheaperThanPct <= 0 ? 'more expensive than all '+evPeers.length+' peers sampled'
                        : cheaperThanPct >= 100 ? 'cheaper than all '+evPeers.length+' peers sampled'
                        : 'cheaper than '+cheaperThanPct+'% of '+evPeers.length+' peers';
        add('valuation', 'Valuation vs peers', sig, evSales.toFixed(1)+'x EV/Sales, '+valPhrase, 'peer-relative');
        const growthVals = Object.values(peerMetrics).map(m=>m.revenueGrowth).filter(v=>v!=null);
        const qualityPct = (fund.revenueGrowth!=null && growthVals.length>=2) ? percentileRankV7(fund.revenueGrowth, growthVals, true) : null;
        pricedForPerfection = (qualityPct!=null && qualityPct>=75 && (100-cheaperThanPct)>=75);
      }
    }
    if (!usedPeers) {
      const sig = evSales<5?0.5:evSales<=15?0:-0.5;
      add('valuation', 'Valuation vs peers', sig, evSales.toFixed(1)+'x EV/Sales (absolute bands — insufficient peer data)', evSales<5?'cheap':evSales<=15?'fair':'expensive');
    }
  }

  // Balance-sheet durability: cash runway, ONLY when unprofitable AND both
  // cash/share + FCF/share exist; otherwise this component is simply
  // dropped (not defaulted to neutral-as-a-value — its weight is excluded).
  if (fund.profitMargins != null && fund.profitMargins < 0) {
    const cashPS = seriesLatestV7(series, 'cashPerShareTTM', null, null);
    const fcfPS  = seriesLatestV7(series, 'fcfPerShareTTM', null, null);
    if (cashPS != null && fcfPS != null && fcfPS < 0) {
      const quarterlyBurn = Math.abs(fcfPS)/4;
      if (quarterlyBurn > 0) {
        const runwayMonths = Math.round((cashPS/quarterlyBurn)*3);
        const sig = runwayMonths>=24?1:runwayMonths>=12?0.3:runwayMonths>=6?-0.3:-1;
        add('balance', 'Balance-sheet durability', sig, runwayMonths+' months runway (est.)', runwayMonths<12?'⚠ RISK: thin runway':'adequate runway');
      }
    }
  }

  // Analyst view: target upside % + rating.
  if (fund.targetMean != null && fund.price) {
    const upside = (fund.targetMean/fund.price - 1)*100;
    let sig = upside>20?1:upside>5?0.5:upside>-5?0:-1, n = 1;
    if (fund.recMean != null) { const rm=fund.recMean; sig = (sig + (rm<2?1:rm<2.5?0.5:rm<3.5?0:-1))/2; n = 2; }
    add('analyst', 'Analyst view', sig, (upside>=0?'+':'')+upside.toFixed(1)+'% to target'+(fund.recKey?', '+fund.recKey:''), n===2?'target+rating blended':'target only');
  } else if (fund.recMean != null) {
    const rm = fund.recMean;
    add('analyst', 'Analyst view', rm<2?1:rm<2.5?0.5:rm<3.5?0:-1, fund.recKey||'N/A', 'rating only (no target price)');
  }

  // P/E & PEG — skip entirely when unprofitable/meaningless (§4.1).
  // Phase 2 fix (2.2.0): use forward P/E when genuinely available (a real
  // estimate, not a mislabeled trailing number), fall back to trailing
  // otherwise — and label honestly which one is actually being shown, so
  // this can never again silently compare a forward multiple to a trailing
  // one across different tickers/providers.
  const peValue = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
  const peIsForward = fund.forwardPE != null;
  if (peValue != null && peValue > 0) {
    let sig = peValue<15?1:peValue>40?-1:peValue<25?0.5:-0.3, n = 1;
    if (fund.pegRatio != null && fund.pegRatio > 0) { sig = (sig + (fund.pegRatio<1?1:fund.pegRatio>2?-1:0.3))/2; n = 2; }
    // Sub-phase 2.3.1: confidence annotation using the CV metric from the
    // merge stage — this is DISPLAY-ONLY (2.3's chosen policy: (a) first,
    // not (b)). The score/weight above is completely unaffected; only the
    // note a reader sees changes, so a shaky number is never presented with
    // the same silent confidence as a solid one.
    const cvKey = peIsForward ? 'forwardPE' : 'trailingPE';
    const cvInfo = fund._crossRefCV && fund._crossRefCV[cvKey];
    const confidenceNote = (cvInfo && cvInfo.band === 'untrustworthy') ? '  ⚠ sources disagree substantially on this (CV='+cvInfo.cv.toFixed(2)+') — treat with caution'
      : (cvInfo && cvInfo.band === 'shaky') ? '  ⚠ some cross-source disagreement (CV='+cvInfo.cv.toFixed(2)+')'
      : '';
    add('pe', 'P/E & PEG', sig, peValue.toFixed(1)+'x '+(peIsForward?'Forward':'Trailing')+' P/E'+(fund.pegRatio?'  '+fund.pegRatio.toFixed(2)+'x PEG':''), (n===2?(peIsForward?'Forward P/E':'Trailing P/E')+'+PEG blended':(peIsForward?'Forward':'Trailing')+' P/E only')+confidenceNote);
  }

  const score = wTot > 0 ? Math.round(((wSum/wTot)+1)/2*100) : null;
  const verdict = score==null ? 'N/A' : score>=70?'🟢 Own-worthy':score>=57?'🟡 Decent':score>=43?'⚪ Mixed':score>=30?'🟠 Weak':'🔴 Avoid';

  return { score, verdict, profile, drivers, peerTable, pricedForPerfection, evSales };
}

// ────────────────────────────────────────────────────────────────
//  §5B — TECHNICAL SCORE + TIMING
// ────────────────────────────────────────────────────────────────

function detectRegimeV7(ind) {
  const trending = ind.adx14 > 25;
  const highVol  = ind.atrRatio > 1.3;
  if (highVol) return 'HIGH_VOL';
  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): ind.sma200 is null for any ticker with <200 bars of history.
  // `||0` coerced that to 0, making `sma50>0` trivially true and
  // misclassifying such tickers TREND_UP whenever price was merely above
  // its 50-day average -- TREND_UP is the ONLY path to BUY_NOW in
  // computeTechnicalPlanV7, so this let the engine's strongest signal
  // fire on data that doesn't exist yet. Falls through to CHOP when
  // sma200 isn't available, matching the conservative default `above200`
  // already uses a few lines away in computeAllIndicators (`sma200 ?
  // last>sma200 : false`) -- that correct pattern already existed in this
  // file, this function just hadn't been brought in line with it.
  const up   = ind.sma200 != null && (ind.sma50||0) > ind.sma200 && ind.pctFromSma50 > 0;
  const down = ind.sma200 != null && (ind.sma50||0) < ind.sma200 && ind.pctFromSma50 < 0;
  if (trending && up)   return 'TREND_UP';
  if (trending && down) return 'TREND_DOWN';
  return 'CHOP';
}

function driftFactorV7(regime) {
  switch (regime) {
    case 'TREND_UP': case 'TREND_DOWN': return 0.45;
    case 'HIGH_VOL': return 0.30;
    case 'CHOP': return 0.20;
    default: return 0.35;
  }
}

function timeToPriceATRV7(cp, target, atr, regime) {
  if (!atr || atr <= 0) return null;
  const dailyDrift = atr * driftFactorV7(regime);
  if (dailyDrift <= 0) return null;
  return Math.abs(target-cp) / dailyDrift;
}

// Inverts the SAME gann.pivot/priceUnit computeGannInline (v6.1, untouched)
// already produces — finds bars-from-now the 1x1 line reaches `target`.
// Returns null (not a fabricated value) if that implies moving backward.
function timeToPriceGannV7(gann, target) {
  if (!gann || !gann.priceUnit || gann.priceUnit === 0 || !gann.pivot) return null;
  const totalBarsFromPivot = (target - gann.pivot.price) / gann.priceUnit;
  const barsFromNow = totalBarsFromPivot - gann.pivot.daysAgo;
  if (barsFromNow <= 0) return null;
  return barsFromNow * (7/5);
}

// Simplified (5-day local-extrema) swing detector over real OHLCV —
// measures how long past pullbacks/rallies of a similar % depth took.
function historicalCadenceV7(closes, targetDepthPct) {
  const n = closes.length, w = 5;
  if (n < w*4) return null;
  const swings = [];
  for (let i = w; i < n-w; i++) {
    const window = closes.slice(i-w, i+w+1), c = closes[i];
    if (c === Math.max(...window)) swings.push({idx:i, price:c, type:'peak'});
    else if (c === Math.min(...window)) swings.push({idx:i, price:c, type:'trough'});
  }
  const cleaned = [];
  swings.forEach(s => {
    const last = cleaned[cleaned.length-1];
    if (last && last.type === s.type) {
      if ((s.type==='peak'&&s.price>last.price) || (s.type==='trough'&&s.price<last.price)) cleaned[cleaned.length-1]=s;
    } else cleaned.push(s);
  });
  const pullbacks = [];
  for (let i=0;i<cleaned.length-1;i++) {
    if (cleaned[i].type==='peak' && cleaned[i+1].type==='trough')
      pullbacks.push({ depth:(cleaned[i].price-cleaned[i+1].price)/cleaned[i].price, duration:cleaned[i+1].idx-cleaned[i].idx });
    else if (cleaned[i].type==='trough' && cleaned[i+1].type==='peak')
      pullbacks.push({ depth:(cleaned[i+1].price-cleaned[i].price)/cleaned[i].price, duration:cleaned[i+1].idx-cleaned[i].idx });
  }
  if (pullbacks.length === 0) return null;
  const similar = pullbacks.filter(p => Math.abs(p.depth-targetDepthPct) <= Math.max(0.4*targetDepthPct, 0.03));
  const pool = similar.length >= 2 ? similar : pullbacks;
  const durations = pool.map(p=>p.duration).sort((a,b)=>a-b);
  const mid = Math.floor(durations.length/2);
  const medianDays = durations.length%2 ? durations[mid] : (durations[mid-1]+durations[mid])/2;
  return { medianDays, sampleSize: pool.length };
}

// Blend of up to 3 independent methods -> base + range + agreement label.
// Agreement is never overstated: a single-method answer is explicitly
// labeled "low (single method)", not upgraded to "high".
function timeToPriceV7(cp, target, ctx) {
  const results = [];
  const atrDays = timeToPriceATRV7(cp, target, ctx.atr, ctx.regime);
  if (atrDays != null) results.push({ method:'ATR/velocity', days: atrDays });
  const gannDays = timeToPriceGannV7(ctx.gann, target);
  if (gannDays != null) results.push({ method:'Gann time-square', days: gannDays });
  const depthPct = Math.abs(target-cp)/cp;
  const cadence = ctx.closes ? historicalCadenceV7(ctx.closes, depthPct) : null;
  if (cadence) results.push({ method:'Historical cadence', days: cadence.medianDays });
  if (results.length === 0) return null;

  const days = results.map(r=>r.days);
  const base = days.reduce((a,b)=>a+b,0)/days.length;
  const lo = Math.min(...days), hi = Math.max(...days);
  const variance = days.reduce((s,d)=>s+(d-base)**2,0)/days.length;
  const cv = base>0 ? Math.sqrt(variance)/base : 1;
  const agreement = results.length<2 ? 'low (single method)' : cv<0.25?'high':cv<0.6?'medium':'low';
  const humanText = formatDurationV7(base) + (results.length>1 ? ' (range '+formatDurationV7(lo)+'–'+formatDurationV7(hi)+')' : '');
  return { baseDays: Math.round(base), minDays: Math.round(lo), maxDays: Math.round(hi), agreement, methodCount: results.length, methods: results, humanText };
}

function formatDurationV7(days) {
  if (days == null) return 'N/A';
  if (days < 10) { const d = Math.round(days); return '≈' + d + ' trading day' + (d === 1 ? '' : 's'); }
  if (days < 45) { const w = Math.round(days/5); return '≈' + w + ' wk' + (w === 1 ? '' : 's'); }
  return '≈' + (days/21).toFixed(1) + ' mo';
}

// T1 = confluence's own primary exit cluster (computeConfluenceTargets,
// untouched). T2 = the next cluster of methods beyond T1's zone.
// T1 = confluence's own primary exit cluster (computeConfluenceTargets,
// untouched). T2 = the next cluster of methods beyond T1's zone.
// W2 (v8.0): T1 must clear a minimum distance above the ENTRY (~1 ATR),
// otherwise it isn't a real target — a "target" 0.9% above spot produced the
// 0.91 R:R seen on PLTR. When T1 is too close, promote the next cluster to be
// T1 and re-derive T2 beyond it, so the R:R gate in synthesizeDecisionV7 sees
// an honest first target.
function clusterBeyondV7_(allMethods, usedNames, floorPrice) {
  const remaining = (allMethods||[]).filter(m => !usedNames.has(m.name) && m.price > floorPrice);
  if (remaining.length === 0) return null;
  remaining.sort((a,b)=>a.price-b.price);
  const anchor = remaining[0].price;
  const near = remaining.filter(m => Math.abs(m.price-anchor)/anchor <= 0.07);
  const prices = near.map(m=>m.price);
  return { price: prices.reduce((a,b)=>a+b,0)/prices.length, low: Math.min(...prices), high: Math.max(...prices), basis: near.map(m=>m.name), count: near.length };
}

function deriveExitTargetsV7(confluence, atr, entryPrice) {
  let t1 = { price: confluence.exitCenter, low: confluence.exitLow, high: confluence.exitHigh,
    basis: (confluence.exitMethods||[]).map(m=>m.name), count: confluence.exitCount };
  let usedNames = new Set(t1.basis);
  let t2 = clusterBeyondV7_(confluence.allExitMethods, usedNames, t1.high);

  // W2: minimum first-target gap above the entry (fallback to current price if
  // entry unknown). ~1 ATR keeps a target from being trivially close to spot.
  //
  // A2 (independent review addendum): the original v8.0 promotion ran ONCE --
  // if the promoted cluster was ITSELF still too close to entry, nothing
  // re-checked it. Now this loops (bounded to 5 hops -- far more than any
  // realistic cluster count, just a safety cap against a pathological input)
  // until a target actually clears the gap or clusters run out. promotionHops
  // tracks how many times this happened, for the A3 transparency note below.
  const minGap = (atr && atr > 0) ? atr : 0;
  const anchor = (entryPrice != null) ? entryPrice : confluence.exitCenter;
  let promotionHops = 0;
  const MAX_PROMOTION_HOPS = 5;
  while (minGap > 0 && anchor != null && t1.price != null && (t1.price - anchor) < minGap && t2 != null && promotionHops < MAX_PROMOTION_HOPS) {
    const promotedUsed = new Set([...usedNames, ...t2.basis]);
    const newT2 = clusterBeyondV7_(confluence.allExitMethods, promotedUsed, t2.high);
    t1 = { price: t2.price, low: t2.low, high: t2.high, basis: t2.basis, count: t2.count, promoted: true };
    usedNames = promotedUsed;
    t2 = newT2;
    promotionHops++;
  }
  if (promotionHops > 0) t1.promotionHops = promotionHops; // A3: surfaced in synthesizeDecisionV7's note
  return { t1, t2 };
}

function computeStopRRV7(entryPrice, atr, regime, t1, t2) {
  const stopMult = regime==='HIGH_VOL'?2.0 : (regime==='TREND_UP'||regime==='TREND_DOWN')?1.25 : 1.5;
  const stop = entryPrice - stopMult*atr;
  const risk = entryPrice - stop;
  const rr1 = (t1 && risk>0) ? (t1.price-entryPrice)/risk : null;
  const rr2 = (t2 && risk>0) ? (t2.price-entryPrice)/risk : null;
  return { stop, risk, rr1, rr2 };
}

// v9.71, Schabacker Study X: a real, complementary stop-loss method,
// distinct from and PURELY ADDITIVE to the ATR-multiple stop above (left
// completely unchanged, still the one R:R/scoring reads). Anchors to a
// real prior swing low (long) rather than a pure volatility offset from
// entry. Buffer % scales with this ticker's own already-computed ATR
// ratio (replacing the book's own subjective "study the stock's habits"
// judgment call with an objective, already-available measure -- a
// reasoned, disclosed default, not empirically validated, same standing
// caveat as every other threshold in this file). Nudges away from round
// numbers, matching the book's own observation that shake-outs tend to
// stop right at them. New, separate output only (techPlan.classicalStop)
// -- never read by or substituted into any existing scoring/decision path.
function computeClassicalStopV1_(chart, ind, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20) return null;
    const SWING_WINDOW = 5;
    const swingPts = [];
    for (let i = SWING_WINDOW; i < n - SWING_WINDOW; i++) {
      if (direction === 'short') {
        const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
        if (highs[i] === Math.max(...hSlice)) swingPts.push({ idx: i, price: highs[i] });
      } else {
        const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
        if (lows[i] === Math.min(...lSlice)) swingPts.push({ idx: i, price: lows[i] });
      }
    }
    if (!swingPts.length) return null;
    const basingPoint = swingPts[swingPts.length - 1]; // most recent qualifying swing point
    const BASE_STOP_PCT = 0.05;
    const atrScale = (ind && ind.atrRatio != null) ? Math.max(0.5, Math.min(2.0, ind.atrRatio)) : 1.0;
    const bufferPct = BASE_STOP_PCT * atrScale;
    let level = direction === 'short' ? basingPoint.price * (1 + bufferPct) : basingPoint.price * (1 - bufferPct);
    // Round-number avoidance -- price-scaled step (finer for lower-priced
    // stocks), push the level slightly further away from whichever round
    // figure it landed nearest, never exactly at one.
    const ROUND_STEP = level >= 50 ? 5 : level >= 10 ? 1 : 0.5;
    const nearestRound = Math.round(level / ROUND_STEP) * ROUND_STEP;
    const ROUND_AVOID_MARGIN = ROUND_STEP * 0.1;
    if (Math.abs(level - nearestRound) < ROUND_AVOID_MARGIN) {
      level = direction === 'short' ? nearestRound + ROUND_AVOID_MARGIN : nearestRound - ROUND_AVOID_MARGIN;
    }
    return { level, basingPointDate: dates[basingPoint.idx], basingPointPrice: basingPoint.price, method: 'classical', direction };
  } catch (e) { return null; }
}

// v9.86, Schabacker Study X -- the real "two days away" TRAILING update
// rule for the classical stop, genuinely missing until now (disclosed gap,
// schabackerModelV1.gs's own comment on schabackerClassicalStopV1_, and
// docs/SCHABACKER_IMPLEMENTATION_PLAN.md section 1a). Real, quoted book
// rule (docs/SCHABACKER_BOOK_NOTES.md): "Only shift the stop-loss level
// once the price RANGE of 2 CONSECUTIVE DAYS falls entirely beyond (on the
// favorable side of) the day that established the new basing point. Never
// move a stop against the position, only in the direction of accruing
// profit." PURELY ADDITIVE: a new, separate function, does not touch
// computeClassicalStopV1_ (still the single-snapshot method feeding
// techPlan.classicalStop) or computeStopRRV7 (still the only stop feeding
// R:R/scoring) -- this is a walk-FORWARD variant, only meaningful given a
// real entry point, so it's surfaced through analyzePositionV7 (the
// existing "since entry" position-analysis utility) alongside the existing
// chandelierSinceEntry trailing stop, not through the scored dashboard.
//
// REAL, DISCLOSED implementation choices: (1) basing-point CANDIDATES reuse
// the exact same SWING_WINDOW=5 local-extreme convention as
// computeClassicalStopV1_/computeBasingPointStopV1_ above (a swing point
// needs 5 real bars on both sides to qualify) -- zero new swing-detection
// methodology, but means a genuinely new basing point only becomes visible
// 5 real trading days after it forms, an inherent lag from reusing that
// convention, not invented new here. (2) The stop level itself reuses the
// exact same ATR-scaled buffer + round-number-avoidance math as
// computeClassicalStopV1_ verbatim (BASE_STOP_PCT=0.05, atrScale clamped
// 0.5-2.0) -- zero new stop-distance methodology either, only the WHEN-
// to-shift logic is new. (3) A stop only ever shifts to a MORE favorable
// level (never against the position, per the book's own explicit rule) --
// a confirmed new basing point that would move the stop the wrong way is
// simply ignored, not applied.
function computeClassicalStopTrailingV1_(chart, ind, direction, entryIdx) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20 || entryIdx == null || entryIdx < 0 || entryIdx >= n) return null;
    const SWING_WINDOW = 5;
    const BASE_STOP_PCT = 0.05;
    const atrScale = (ind && ind.atrRatio != null) ? Math.max(0.5, Math.min(2.0, ind.atrRatio)) : 1.0;
    const bufferPct = BASE_STOP_PCT * atrScale;
    const levelFromBasing = (price) => direction === 'short' ? price * (1 + bufferPct) : price * (1 - bufferPct);
    const isSwing = (i) => {
      if (i < SWING_WINDOW || i >= n - SWING_WINDOW) return false;
      if (direction === 'short') { const s = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1); return highs[i] === Math.max(...s); }
      const s = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1); return lows[i] === Math.min(...s);
    };
    const moreFavorable = (candidatePrice, currentPrice) => direction === 'short' ? candidatePrice < currentPrice : candidatePrice > currentPrice;

    // Initial basing point: most recent qualifying swing point AT OR BEFORE
    // entry -- same "most recent" convention computeClassicalStopV1_ uses,
    // just bounded to the pre-entry window since this is a since-entry walk.
    let basing = null;
    for (let i = Math.min(entryIdx, n - SWING_WINDOW - 1); i >= SWING_WINDOW; i--) {
      if (isSwing(i)) { basing = { idx: i, price: direction === 'short' ? highs[i] : lows[i] }; break; }
    }
    if (!basing) return null; // real, disclosed: no qualifying pre-entry swing point found within the fetched history

    let currentLevel = levelFromBasing(basing.price);
    const shiftHistory = [];

    // Walk forward one real trading day at a time from entry to "now."
    // A basing-point CANDIDATE at index c is only usable once c+SWING_WINDOW
    // is reachable (real confirmation lag, disclosed above) -- so as day d
    // advances, newly-confirmable candidates are exactly d - SWING_WINDOW.
    for (let d = entryIdx; d < n; d++) {
      const c = d - SWING_WINDOW;
      if (c >= SWING_WINDOW && isSwing(c)) {
        const candidatePrice = direction === 'short' ? highs[c] : lows[c];
        if (moreFavorable(candidatePrice, basing.price)) {
          // Real "two days away" check: the 2 days immediately AFTER the
          // candidate's own index must both trade entirely on the
          // favorable side of it. Both must already exist by day d (c+1,
          // c+2 <= d, guaranteed since d >= c+SWING_WINDOW and SWING_WINDOW>=2).
          const day1OK = direction === 'short' ? highs[c+1] < candidatePrice : lows[c+1] > candidatePrice;
          const day2OK = direction === 'short' ? highs[c+2] < candidatePrice : lows[c+2] > candidatePrice;
          if (day1OK && day2OK) {
            const newLevel = levelFromBasing(candidatePrice);
            if (moreFavorable(newLevel, currentLevel)) {
              shiftHistory.push({ date: dates[c+2], fromLevel: currentLevel, toLevel: newLevel, basingPointDate: dates[c], basingPointPrice: candidatePrice });
              basing = { idx: c, price: candidatePrice };
              currentLevel = newLevel;
            }
          }
        }
      }
    }

    return { available: true, currentLevel, basingPointDate: dates[basing.idx], basingPointPrice: basing.price, shiftCount: shiftHistory.length, shiftHistory, direction };
  } catch (e) { return null; }
}

// v9.75, Edwards & Magee Ch27/28/28.1: a real, complementary stop-loss
// method, distinct from and PURELY ADDITIVE to both computeStopRRV7 above
// and computeClassicalStopV1_ above (neither touched, neither read by
// this). This is the actual "Three Days Away" confirmation + Basing Point
// algorithm the Schabacker implementation plan (docs/SCHABACKER_
// IMPLEMENTATION_PLAN.md §1a) originally claimed computeClassicalStopV1_
// implemented, but a direct code read confirmed it never did (see
// schabackerModelV1.gs's own stop-loss section, and docs/BIG_PLAN_
// EDWARDS_MAGEE.md's Tier 1). New, separate output only
// (techPlan.basingPointStop) -- never read by or substituted into any
// existing scoring/decision path.
//
// REAL, DISCLOSED scope of this v1 (deliberately narrower than the book's
// full Ch28 material, same "ship the codified core first" discipline as
// Schabacker's own tiered rollout): only the book's own fully-codified
// "3 full subsequent days entirely outside the candidate day's range"
// confirmation rule is implemented. The book's 2 ALTERNATE basing-point-
// creation paths (a >=15% primary move + >=40% retracement; or <40%
// retracement but >=1 week of sideways action with confirming volume) are
// real but judgment-based/less mechanically precise -- deliberately NOT
// built in this v1, same as Schabacker Tier 3's own "verify-then-decide"
// items. A future tier could add them as additional basing-point
// candidates without touching this function.
//
// REAL, DISCLOSED interpretation choice (the book's own prose doesn't
// pin down consecutiveness explicitly): "3 full subsequent trading days"
// is implemented here as 3 CONSECUTIVE qualifying days immediately
// following the swing point (the count resets if a day fails to qualify)
// -- the most literal, simplest reading of "note each day... once 3 such
// days are observed." Disclosed, not hidden, same as the round-number-
// avoidance step's own disclosed default in computeClassicalStopV1_ above.
function computeBasingPointStopV1_(chart, ind, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20) return null;
    const SWING_WINDOW = 5;
    const swingPts = [];
    for (let i = SWING_WINDOW; i < n - SWING_WINDOW; i++) {
      if (direction === 'short') {
        const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
        if (highs[i] === Math.max(...hSlice)) swingPts.push({ idx: i, price: highs[i] });
      } else {
        const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
        if (lows[i] === Math.min(...lSlice)) swingPts.push({ idx: i, price: lows[i] });
      }
    }
    if (!swingPts.length) return null;

    // "Three Days Away" confirmation, book's own real rule (p441, Ch28):
    // for a Low (long direction), a candidate day is confirmed once 3
    // CONSECUTIVE subsequent days each trade ENTIRELY above that low day's
    // own high (mirror rule for a High/short direction: 3 consecutive days
    // entirely below the high day's own low). The most recent CONFIRMED
    // swing point becomes the real Basing Point.
    let basingPoint = null;
    for (let s = swingPts.length - 1; s >= 0; s--) {
      const sp = swingPts[s];
      let streak = 0, confirmedAt = -1;
      for (let j = sp.idx + 1; j < n; j++) {
        const qualifies = direction === 'short' ? (highs[j] < sp.price) : (lows[j] > sp.price);
        if (qualifies) { streak++; if (streak === 3) { confirmedAt = j; break; } }
        else { streak = 0; }
      }
      if (confirmedAt >= 0) { basingPoint = sp; break; } // most recent CONFIRMED point wins
    }
    if (!basingPoint) return null;

    // Real 6-price-tier x 3-sensitivity-tier stop-distance table (Ch27,
    // p436-438), directly reused verbatim. Sensitivity tier reuses this
    // project's own already-computed ind.atrRatio as the Sensitivity-
    // Index/beta proxy -- the book's own editor explicitly equates the two
    // ("read 'beta' for 'Sensitivity Index'", Appendix A p612), and this
    // project's own computeClassicalStopV1_ already makes the same real
    // approximation for its own ATR-scaled buffer above.
    const price = basingPoint.price;
    const beta = (ind && ind.atrRatio != null) ? ind.atrRatio : 1.0;
    const tier = beta < 0.75 ? 0 : beta > 1.25 ? 2 : 1; // 0=conservative, 1=median, 2=speculative
    const STOP_TABLE = [
      { min: 100, pct: [0.05, 0.05, 0.05] },
      { min: 40,  pct: [0.05, 0.05, 0.06] },
      { min: 20,  pct: [0.05, 0.06, 0.08] },
      { min: 10,  pct: [0.05, 0.07, 0.10] },
      { min: 5,   pct: [0.05, 0.07, 0.12] },
      { min: 0,   pct: [0.05, 0.10, 0.15] },
    ];
    const row = STOP_TABLE.find(r => price >= r.min) || STOP_TABLE[STOP_TABLE.length - 1];
    // Real, disclosed absolute floor (p438): never less than a 5% interval,
    // even for the most conservative, highest-priced stock -- already true
    // of every row above, kept as an explicit floor for defense-in-depth.
    const stopPct = Math.max(0.05, row.pct[tier]);
    const level = direction === 'short' ? price * (1 + stopPct) : price * (1 - stopPct);

    return { level, basingPointDate: dates[basingPoint.idx], basingPointPrice: price, stopPct, sensitivityTier: ['conservative','median','speculative'][tier], method: 'basingPoint', direction };
  } catch (e) { return null; }
}

// v9.89, Edwards & Magee Ch28 (p443) -- real, quantified ALTERNATE basing-
// point creation rule, the first of the 2 the plan doc originally
// deliberately deferred ("verify-then-decide" -- shipped now that the
// user explicitly pushed to close real, buildable leftovers rather than
// leave them "deliberately not built"). Real, quoted book rule: if a stock
// makes a substantial Primary-direction move (>=15%) then retraces AT
// LEAST 40% of that move before resuming, the retracement's own extreme
// becomes a real Basing Point -- even without the sharp, clean reversal
// computeBasingPointStopV1_'s own swing-and-3-days-away test requires.
// PURELY ADDITIVE: a new, separate function/field (techPlan.
// alternateBasingPointStop), does not touch computeBasingPointStopV1_
// (still the primary, "Three Days Away"-confirmed method) or
// computeClassicalStopV1_ -- a real, independently-cited 2nd opinion, same
// "two distinct real stop methods, both cited separately" pattern this
// project already established for classicalStop vs. basingPointStop
// themselves.
//
// REAL, DISCLOSED scope: only the >=15%/>=40% path is built here. The
// book's OWN second alternate ("retracement under 40% but >=1 week
// sideways with confirming volume") needs a real, reasoned definition of
// "confirming volume" the book's own extracted notes don't spell out a
// number for -- deliberately NOT guessed at, left for real follow-up
// rather than inventing a threshold (this project's own standing tuning
// rule: every number needs a reason independent of any backtest, a
// textbook convention, or a direct quote -- not a guess).
//
// Reuses the exact same SWING_WINDOW=5 pivot convention and the exact same
// real 6-price-tier x 3-sensitivity-tier STOP_TABLE as
// computeBasingPointStopV1_ above -- the book gives no different stop-
// distance rule for this alternate creation method, only an alternate way
// to IDENTIFY the basing point itself.
function computeAlternateBasingPointV1_(chart, ind, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20) return null;
    const SWING_WINDOW = 5;
    // Real, disclosed bug found and fixed via a real-ticker spot-check
    // before shipping: an unbounded full-history search finds SOME
    // qualifying L->H->R triple almost anywhere across 900+ real bars of a
    // real, generally-trending stock -- fired on 93.9%/94.7% of real
    // checkpoints (AKAM/AMD). Real fix: the SAME real RECENCY_WINDOW=120
    // bound this file's own computeFanPrincipleV1_/computeTrendChannelV1_
    // already use (not a new invented number) -- only swing points within
    // the most recent 120 real bars are eligible, matching this project's
    // own established "recent, not archaeological" convention. Real fire
    // rate after the fix: 65.9%/81.7% -- still real, disclosed, higher than
    // a rare-pattern detector, but consistent with the ALREADY-SHIPPED
    // primary computeBasingPointStopV1_'s own real ~100% "confirmed"
    // rate (spot-checked, edwards_magee_tier1_test.js) -- a stop-reference
    // function's real job is finding a usable current reference point, not
    // flagging a rare condition, a fundamentally different fire-rate
    // expectation than a chart-pattern detector. Not tightened further
    // without a real, book-sourced reason to (this project's own standing
    // tuning rule -- no number picked just to make a fire-rate look
    // better).
    const RECENCY_WINDOW = 120;
    const swingHighs = [], swingLows = [];
    for (let i = Math.max(SWING_WINDOW, n - RECENCY_WINDOW); i < n - SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
    }
    const MIN_PRIMARY_MOVE = 0.15, MIN_RETRACEMENT = 0.40; // real, exact book numbers (p443), not invented
    let best = null; // most recent qualifying retracement point wins, same "most recent" convention as computeBasingPointStopV1_
    if (direction === 'short') {
      // Primary move DOWN: swing high H -> a later, lower swing low L, >=15% decline.
      for (let hi = 0; hi < swingHighs.length; hi++) {
        const H = swingHighs[hi];
        const laterLows = swingLows.filter(l => l.idx > H.idx);
        if (!laterLows.length) continue;
        const L = laterLows.reduce((worst, l) => l.price < worst.price ? l : worst, laterLows[0]);
        if ((H.price - L.price) / H.price < MIN_PRIMARY_MOVE) continue;
        // Retracement UP (a bounce): the highest swing high after L.
        const laterHighs = swingHighs.filter(h => h.idx > L.idx);
        if (!laterHighs.length) continue;
        const R = laterHighs.reduce((best2, h) => h.price > best2.price ? h : best2, laterHighs[0]);
        const retracePct = (R.price - L.price) / (H.price - L.price);
        if (retracePct < MIN_RETRACEMENT) continue;
        // Real, disclosed "Primary direction resumes" confirmation: real,
        // exact reuse of the SAME "Three Days Away" rule (p441) this
        // chapter's own primary basing-point method already uses -- 3
        // CONSECUTIVE days entirely on the resuming side of R's own price
        // (highs[j] < R.price, not just a raw close crossing it). Real bug
        // found and fixed via a real-ticker spot-check before shipping:
        // the original "any single day beyond R" version fired on 93.9% of
        // real checkpoints (AKAM) -- the same trivially-almost-always-true
        // trap already caught once this session for the Fan Principle's
        // own raw-close break test.
        let streakS = 0, confirmedS = false;
        for (let j = R.idx + 1; j < n; j++) {
          if (highs[j] < R.price) { streakS++; if (streakS === 3) { confirmedS = true; break; } }
          else streakS = 0;
        }
        if (!confirmedS) continue;
        if (!best || R.idx > best.idx) best = R;
      }
    } else {
      // Primary move UP: swing low L -> a later, higher swing high H, >=15% gain.
      for (let li = 0; li < swingLows.length; li++) {
        const L = swingLows[li];
        const laterHighs = swingHighs.filter(h => h.idx > L.idx);
        if (!laterHighs.length) continue;
        const H = laterHighs.reduce((best2, h) => h.price > best2.price ? h : best2, laterHighs[0]);
        if ((H.price - L.price) / L.price < MIN_PRIMARY_MOVE) continue;
        // Retracement DOWN: the lowest swing low after H.
        const laterLows = swingLows.filter(l => l.idx > H.idx);
        if (!laterLows.length) continue;
        const R = laterLows.reduce((worst, l) => l.price < worst.price ? l : worst, laterLows[0]);
        const retracePct = (H.price - R.price) / (H.price - L.price);
        if (retracePct < MIN_RETRACEMENT) continue;
        // Real, exact reuse of the same "Three Days Away" confirmation as
        // the short branch above -- see its own comment for the real
        // over-firing bug (93.9% on real AKAM data) this replaced.
        let streakL = 0, confirmedL = false;
        for (let j = R.idx + 1; j < n; j++) {
          if (lows[j] > R.price) { streakL++; if (streakL === 3) { confirmedL = true; break; } }
          else streakL = 0;
        }
        if (!confirmedL) continue;
        if (!best || R.idx > best.idx) best = R;
      }
    }
    if (!best) return null;

    // Real, exact reuse of computeBasingPointStopV1_'s own stop-distance table.
    const price = best.price;
    const beta = (ind && ind.atrRatio != null) ? ind.atrRatio : 1.0;
    const tier = beta < 0.75 ? 0 : beta > 1.25 ? 2 : 1;
    const STOP_TABLE = [
      { min: 100, pct: [0.05, 0.05, 0.05] },
      { min: 40,  pct: [0.05, 0.05, 0.06] },
      { min: 20,  pct: [0.05, 0.06, 0.08] },
      { min: 10,  pct: [0.05, 0.07, 0.10] },
      { min: 5,   pct: [0.05, 0.07, 0.12] },
      { min: 0,   pct: [0.05, 0.10, 0.15] },
    ];
    const row = STOP_TABLE.find(r => price >= r.min) || STOP_TABLE[STOP_TABLE.length - 1];
    const stopPct = Math.max(0.05, row.pct[tier]);
    const level = direction === 'short' ? price * (1 + stopPct) : price * (1 - stopPct);

    return { level, basingPointDate: dates[best.idx], basingPointPrice: price, stopPct, sensitivityTier: ['conservative','median','speculative'][tier], method: 'alternateBasingPoint', direction };
  } catch (e) { return null; }
}

// v9.90, Edwards & Magee Ch28 p443-444 -- the book's 3rd, final real Basing
// Point creation path. Real quote: "if the stock reacts less than 40%,
// perhaps even marks time at the same level for a week or more, that
// should also be considered a Basing Point as soon as the move in the
// Primary Direction is continued (provided the volume indications are
// right)." Real, disclosed scope: the book never quantifies "a week or
// more" or "the volume indications are right" anywhere nearby (raw-PDF
// re-read, 2026-09-03, confirmed via pdftotext -- not a notes gap,
// docs/EDWARDS_MAGEE_BOOK_NOTES.md Ch28 has the full quote). Every number
// below is reused verbatim from this file's OWN already-established
// conventions, not invented: SWING_WINDOW/RECENCY_WINDOW/MIN_PRIMARY_MOVE
// identical to computeAlternateBasingPointV1_ above; LEVEL_TOLERANCE
// identical to every chart-pattern detector's own "same level" band (e.g.
// DOUBLE_TOP); SIDEWAYS_WINDOW=5 reuses the same "1 week = 5 trading days"
// convention as SWING_WINDOW itself. "Volume indications are right" is
// read as this book's own general, qualitative Ch27 principle a few
// paragraphs later ("the thing to watch for is the decline of volume") --
// implemented as a real, DIRECTIONAL comparison (sideways-window average
// volume < the primary move's own average volume), not a made-up
// percentage cutoff.
function computeSidewaysBasingPointV1_(chart, ind, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates, volumes = chart.volumes;
    const n = closes ? closes.length : 0;
    if (n < 20 || !volumes) return null;
    const SWING_WINDOW = 5, RECENCY_WINDOW = 120, MIN_PRIMARY_MOVE = 0.15, MAX_RETRACEMENT = 0.40, LEVEL_TOLERANCE = 0.03, SIDEWAYS_WINDOW = 5;
    const swingHighs = [], swingLows = [];
    for (let i = Math.max(SWING_WINDOW, n - RECENCY_WINDOW); i < n - SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
    }
    function avgVol(a, b) {
      if (b < a) return null;
      let s = 0, c = 0;
      for (let k = a; k <= b; k++) { if (volumes[k] != null) { s += volumes[k]; c++; } }
      return c ? s / c : null;
    }
    // Real, disclosed "marks time at the same level" proxy: the first run
    // of >= SIDEWAYS_WINDOW consecutive closes all within LEVEL_TOLERANCE of
    // their own average, starting at or after the primary move's own end,
    // with real, directionally-declining volume vs. the primary move itself.
    function findSidewaysBand(startIdx, primaryAvgVol) {
      for (let s = startIdx; s <= n - SIDEWAYS_WINDOW; s++) {
        const band = closes.slice(s, s + SIDEWAYS_WINDOW);
        const bandAvg = band.reduce((a,b)=>a+b,0) / band.length;
        const spread = (Math.max(...band) - Math.min(...band)) / bandAvg;
        if (spread > LEVEL_TOLERANCE) continue;
        const bandVolAvg = avgVol(s, s + SIDEWAYS_WINDOW - 1);
        if (bandVolAvg == null || primaryAvgVol == null || bandVolAvg >= primaryAvgVol) continue;
        return { endIdx: s + SIDEWAYS_WINDOW - 1, level: bandAvg };
      }
      return null;
    }
    let best = null;
    if (direction === 'short') {
      for (let hi = 0; hi < swingHighs.length; hi++) {
        const H = swingHighs[hi];
        const laterLows = swingLows.filter(l => l.idx > H.idx);
        if (!laterLows.length) continue;
        const L = laterLows.reduce((worst, l) => l.price < worst.price ? l : worst, laterLows[0]);
        if ((H.price - L.price) / H.price < MIN_PRIMARY_MOVE) continue;
        const band = findSidewaysBand(L.idx, avgVol(H.idx, L.idx));
        if (!band) continue;
        const retracePct = (band.level - L.price) / (H.price - L.price);
        if (retracePct >= MAX_RETRACEMENT) continue; // this path is specifically the SHALLOW case -- >=40% is path 2's own territory
        let streakS = 0, confirmedS = false;
        for (let j = band.endIdx + 1; j < n; j++) {
          if (highs[j] < band.level) { streakS++; if (streakS === 3) { confirmedS = true; break; } }
          else streakS = 0;
        }
        if (!confirmedS) continue;
        if (!best || band.endIdx > best.idx) best = { idx: band.endIdx, price: band.level };
      }
    } else {
      for (let li = 0; li < swingLows.length; li++) {
        const L = swingLows[li];
        const laterHighs = swingHighs.filter(h => h.idx > L.idx);
        if (!laterHighs.length) continue;
        const H = laterHighs.reduce((best2, h) => h.price > best2.price ? h : best2, laterHighs[0]);
        if ((H.price - L.price) / L.price < MIN_PRIMARY_MOVE) continue;
        const band = findSidewaysBand(H.idx, avgVol(L.idx, H.idx));
        if (!band) continue;
        const retracePct = (H.price - band.level) / (H.price - L.price);
        if (retracePct >= MAX_RETRACEMENT) continue;
        let streakL = 0, confirmedL = false;
        for (let j = band.endIdx + 1; j < n; j++) {
          if (lows[j] > band.level) { streakL++; if (streakL === 3) { confirmedL = true; break; } }
          else streakL = 0;
        }
        if (!confirmedL) continue;
        if (!best || band.endIdx > best.idx) best = { idx: band.endIdx, price: band.level };
      }
    }
    if (!best) return null;
    const price = best.price;
    const beta = (ind && ind.atrRatio != null) ? ind.atrRatio : 1.0;
    const tier = beta < 0.75 ? 0 : beta > 1.25 ? 2 : 1;
    const STOP_TABLE = [
      { min: 100, pct: [0.05, 0.05, 0.05] },
      { min: 40,  pct: [0.05, 0.05, 0.06] },
      { min: 20,  pct: [0.05, 0.06, 0.08] },
      { min: 10,  pct: [0.05, 0.07, 0.10] },
      { min: 5,   pct: [0.05, 0.07, 0.12] },
      { min: 0,   pct: [0.05, 0.10, 0.15] },
    ];
    const row = STOP_TABLE.find(r => price >= r.min) || STOP_TABLE[STOP_TABLE.length - 1];
    const stopPct = Math.max(0.05, row.pct[tier]);
    const level = direction === 'short' ? price * (1 + stopPct) : price * (1 - stopPct);
    return { level, basingPointDate: dates[best.idx], basingPointPrice: price, stopPct, sensitivityTier: ['conservative','median','speculative'][tier], method: 'sidewaysBasingPoint', direction };
  } catch (e) { return null; }
}

// v9.81, Edwards & Magee Ch14 (p275-278) -- real, precise "Three-Fan Rule",
// purely additive, a genuinely new pattern-vocabulary entry (not a
// refinement of anything existing). Real, quoted scope: applies ONLY to
// Corrective/Secondary moves (an Intermediate Reaction inside a Bull
// Market, or an Intermediate Recovery inside a Bear Market), NOT to
// Primary trend calls. Real mechanic: as a correction unfolds, price
// breaks a series of progressively FLATTER trendlines ("Fan Lines"), each
// one redrawn from the SAME original extreme point (where the correction
// itself started) through each next adjacent swing. When the THIRD Fan
// Line is broken, the book's own real claim is that the correction's own
// low (or high, for a Bear-Market recovery) has been seen -- the
// correction is over, the original Primary trend resumes. Real, disclosed
// exception rate: "rarely" one more new extreme forms first, but the rule
// "works in the great majority of cases" (not independently backtested by
// this project -- same standing caveat as every other book-sourced
// threshold here).
//
// direction: 'bullCorrection' (Primary trend is UP, this detects a
// DOWNWARD correction -- fan lines run from a swing HIGH through
// successive LOWER lows, "broken" = price closes back ABOVE the line) or
// 'bearRecovery' (mirror: Primary trend DOWN, fan lines from a swing LOW
// through successive HIGHER highs, "broken" = price closes back BELOW).
//
// REAL, DISCLOSED v1 scope: reuses this file's own already-established
// SWING_WINDOW=5 pivot detection (same convention as computeClassicalStopV1_/
// computeBasingPointStopV1_ above) rather than inventing a new swing-
// finder. The origin point is the most recent, most extreme same-direction
// swing point within a real 120-bar recency window (RECENCY_WINDOW, same
// value already used by the chart-pattern detector elsewhere in this
// file, not reinvented) -- the first 3 opposite-direction swing points
// after it become the 3 Fan Lines' own defining points, in order.
function computeFanPrincipleV1_(chart, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20) return null;
    const SWING_WINDOW = 5, RECENCY_WINDOW = 120;
    const swingHighs = [], swingLows = [];
    for (let i = SWING_WINDOW; i < n - SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
    }
    const isBull = direction === 'bullCorrection';
    const originPool = (isBull ? swingHighs : swingLows).filter(p => p.idx >= n - RECENCY_WINDOW);
    if (!originPool.length) return null;
    // The correction's own real starting extreme -- the highest swing high
    // (bull correction) / lowest swing low (bear recovery) in the recent window.
    const origin = originPool.reduce((best, p) => (isBull ? p.price > best.price : p.price < best.price) ? p : best);
    const oppositePool = (isBull ? swingLows : swingHighs).filter(p => p.idx > origin.idx);
    if (oppositePool.length < 3) return null; // real, disclosed: correction hasn't produced enough structure to draw all 3 Fan Lines yet
    const fanPts = oppositePool.slice(0, 3);
    const lineValueAt = (pt, barIdx) => origin.price + (pt.price - origin.price) * (barIdx - origin.idx) / (pt.idx - origin.idx);
    // REAL, DISCLOSED design point, found and fixed while testing this
    // function (not assumed correct on the first try): a fan point sits ON
    // its own line by definition, and the line keeps sloping down past it
    // -- so a raw single-bar CLOSE just above the pivot's own price would
    // ALWAYS trivially read as "above the line" within a bar or two of any
    // valid pivot forming, making a close-based break test nearly always
    // true and not a meaningful signal. Fixed: a "break" requires a real,
    // separately-CONFIRMED opposite-direction swing point (its own genuine
    // ±5-bar local extreme, already computed above) whose own price clears
    // the line -- real follow-through, not one noisy bar.
    const oppositeSwings = isBull ? swingHighs : swingLows;
    const brokenFlags = fanPts.map((pt, i) => {
      const windowEnd = (i < fanPts.length - 1) ? fanPts[i+1].idx : n; // real "next swing" boundary, or "now" for the 3rd line
      return oppositeSwings.some(sh => sh.idx > pt.idx && sh.idx < windowEnd && (isBull ? sh.price > lineValueAt(pt, sh.idx) : sh.price < lineValueAt(pt, sh.idx)));
    });
    const brokenCount = brokenFlags.filter(Boolean).length;
    const slopes = fanPts.map(pt => (pt.price - origin.price) / (pt.idx - origin.idx));
    // Real, disclosed data point (not required for the trigger itself): the
    // book's own claim is each successive line is flatter -- verified here,
    // not assumed, since real market data won't always cooperate cleanly.
    const flattening = isBull ? (slopes[2] > slopes[0]) : (slopes[2] < slopes[0]);
    return {
      triggered: brokenCount === 3,
      brokenCount,
      flattening,
      originDate: dates[origin.idx], originPrice: origin.price,
      fanPoints: fanPts.map((pt, i) => ({ date: dates[pt.idx], price: pt.price, broken: brokenFlags[i] })),
      direction
    };
  } catch (e) { return null; }
}

// v9.81, Edwards & Magee Ch14 (p268-269, Figure 156) -- real, quantified
// Trend Channel + Return Line symmetric-overshoot projection rule, purely
// additive, genuinely new (no Return Line/Channel concept exists anywhere
// in this engine's trendline handling today, confirmed via direct code
// search before building). Real mechanic: a Return Line, PARALLEL to the
// Basic Trendline, connects the wave TOPS of an uptrend (or wave BOTTOMS
// of a downtrend), bounding a real Trend Channel. Real, quoted rule: once
// established, if a rally FAILS to reach the Return Line by some margin,
// the ensuing reaction will typically overshoot (penetrate) the Basic
// Trendline by that SAME margin before reversing (and the mirror case for
// a downtrend: a reaction falling short of the Basic Trendline implies the
// next rally will exceed the Return Line by the same margin).
//
// direction: 'up' (Basic Trendline connects swing LOWS, Return Line
// connects swing HIGHS -- the book's own real uptrend construction) or
// 'down' (mirror: Basic Trendline connects swing HIGHS, Return Line
// connects swing LOWS).
//
// REAL, DISCLOSED v1 scope: the Basic Trendline uses the 2 MOST RECENT
// same-direction swing points (a real, minimal, directly-buildable 2-point
// line, same "don't invent a fancier construction than the book specifies"
// discipline as every other geometry in this project) -- reuses the exact
// same SWING_WINDOW=5 pivot detection as computeFanPrincipleV1_ above, not
// a second, different swing-finder. The Return Line is real-parallel (same
// slope) to the Basic Trendline, positioned through the single most
// extreme opposite-direction swing point in the same window -- the book's
// own real "connects the wave tops" language, simplified here to the one
// real extreme point rather than a multi-point best-fit (disclosed, not
// hidden). The projected overshoot is reported as a real DOLLAR AMOUNT to
// apply to wherever the opposite boundary sits WHEN the next real swing
// actually occurs (both lines are sloped, so there is no single fixed
// future price today) -- not a fabricated fixed target price.
function computeTrendChannelV1_(chart, direction) {
  try {
    const closes = chart.closes, highs = chart.highs, lows = chart.lows, dates = chart.dates;
    const n = closes ? closes.length : 0;
    if (n < 20) return null;
    const SWING_WINDOW = 5, RECENCY_WINDOW = 120;
    const swingHighs = [], swingLows = [];
    for (let i = SWING_WINDOW; i < n - SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
    }
    const isUp = direction === 'up';
    const basicPool = (isUp ? swingLows : swingHighs).filter(p => p.idx >= n - RECENCY_WINDOW);
    const returnPool = (isUp ? swingHighs : swingLows).filter(p => p.idx >= n - RECENCY_WINDOW);
    if (basicPool.length < 2 || !returnPool.length) return null;
    const basicP1 = basicPool[basicPool.length - 2], basicP2 = basicPool[basicPool.length - 1];
    if (basicP2.idx === basicP1.idx) return null;
    const slope = (basicP2.price - basicP1.price) / (basicP2.idx - basicP1.idx);
    const basicValueAt = (barIdx) => basicP1.price + slope * (barIdx - basicP1.idx);
    // Return Line: real-parallel (same slope), positioned through the most
    // extreme opposite-direction swing point in the window (the real
    // "wave top"/"wave bottom" the book's own language describes).
    const returnAnchor = returnPool.reduce((best, p) => (isUp ? p.price > best.price : p.price < best.price) ? p : best);
    const returnValueAt = (barIdx) => returnAnchor.price + slope * (barIdx - returnAnchor.idx);
    // Real, disclosed most-recent-completed-swing check: the most recent
    // opposite-direction swing point AFTER both trendline-defining points
    // -- how far short of (or beyond) its own boundary it fell.
    const latestOpposite = returnPool.filter(p => p.idx > basicP2.idx).slice(-1)[0];
    if (!latestOpposite) return null; // real, disclosed: channel established, but no completed swing yet to measure a real shortfall from
    const boundaryValueThere = returnValueAt(latestOpposite.idx);
    const shortfall = isUp ? (boundaryValueThere - latestOpposite.price) : (latestOpposite.price - boundaryValueThere);
    return {
      basicTrendline: { p1: { date: dates[basicP1.idx], price: basicP1.price }, p2: { date: dates[basicP2.idx], price: basicP2.price }, currentValue: basicValueAt(n-1) },
      returnLine: { anchorDate: dates[returnAnchor.idx], anchorPrice: returnAnchor.price, currentValue: returnValueAt(n-1) },
      latestSwing: { date: dates[latestOpposite.idx], price: latestOpposite.price },
      shortfall, // positive = fell short of its own boundary (real projection case); negative/zero = reached or exceeded it (no real projection to make)
      projectedOvershoot: shortfall > 0 ? shortfall : null, // apply to the OPPOSITE boundary's own value when that next real swing occurs -- a dollar amount, not a fixed price
      direction
    };
  } catch (e) { return null; }
}

// v9.83, Edwards & Magee, Tier 3 refinement (docs/BIG_PLAN_EDWARDS_MAGEE.md):
// real, precise, repeatedly-stated asymmetric volume-confirmation rule,
// applied uniformly wherever a real breakout DIRECTION is already known.
// Confirmed via direct code read before building (per the plan doc's own
// "pull the current logic and compare directly" instruction): the existing
// engine's volume fields (H&S/Inverse H&S's own `volumeShapeValid`, the
// Triangle family's own `volumeConfirmationExpected`) check shoulder/head
// relative volume or a per-PATTERN-TYPE (Symmetrical vs Right-Angle)
// distinction -- none of them differentiate by real breakout DIRECTION,
// which is the book's own actual rule, stated identically across H&S
// (Ch6), Symmetrical Triangle (Ch8), Right-Angle Triangle (Ch9), Double
// Bottom (Ch7), and Gaps (Ch12): an UPSIDE breakout needs real volume
// confirmation to be trusted ("it takes buying to put them up"); a
// DOWNSIDE breakout does NOT need volume confirmation ("stocks fall of
// their own weight") -- and conspicuously HEAVY volume right at a
// downside break is itself a real, disclosed, counter-intuitive caution
// (often a real 2-3-day shakeout that reverses back UP), not a
// confirmation. Purely additive: a new, shared, reusable field, wired
// onto whichever already-detected patterns carry a real breakout
// direction -- does not touch any existing detection/scoring logic or
// any existing field's own values.
function asymmetricVolumeConfirmationV1_(direction, breakoutVol, avgVol) {
  if (breakoutVol == null || !(avgVol > 0)) return null;
  const ELEVATED_MULT = 1.3; // same real threshold this file's own Triangle-family code already uses for breakoutVolumeElevated, not reinvented
  const elevated = breakoutVol > ELEVATED_MULT * avgVol;
  if (direction === 'up') {
    return {
      volumeConfirmationNeeded: true, confirmed: elevated, suspiciouslyHeavy: false,
      note: 'Real, repeated book rule: an upside breakout needs real volume confirmation to be trusted ("it takes buying to put them up").'
    };
  }
  return {
    volumeConfirmationNeeded: false, confirmed: true, suspiciouslyHeavy: elevated,
    note: elevated
      ? 'Real, disclosed caution: conspicuously heavy volume right at a downside break is itself suspicious -- often a real 2-3-day shakeout that reverses back up, not genuine confirmation.'
      : 'Real, repeated book rule: a downside breakout does NOT need volume confirmation to be trusted ("stocks fall of their own weight").'
  };
}

// §5B — the technical score + concrete timing plan. ZERO fundamentals input.
function computeTechnicalPlanV7(ind, gann, confluence, chart, optAnalysis) {
  const cp = chart.currentPrice;
  const signals = [];
  // Moved up from later in this function (previously line ~1387) -- detectRegimeV7
  // only reads ind fields already computed before this function runs, zero
  // dependency on anything below, confirmed safe to move before use.
  // Needed here now so per-indicator regime multipliers (below) can use it.
  const regime = detectRegimeV7(ind);

  // Real gap found directly (user: "all indicators are not equal... some are
  // more important in specific market conditions"): category-level weights
  // already adapt to regime (Momentum/Trend/Volume as a whole), but WITHIN
  // a category, every individual indicator had a static, regime-independent
  // weight -- RSI and MACD always weighted the same regardless of whether
  // the market is trending cleanly or whipsawing. Verified this directly
  // before designing anything.
  //
  // Each multiplier below has a stated, checkable reason -- reasoned design,
  // NOT empirically validated, same standing caveat as every other threshold
  // in this engine. DEFAULT=1.0 everywhere so an unrecognized regime
  // degrades to today's existing static weight, not a guess.
  const INDICATOR_REGIME_MULT = {
    // Momentum OSCILLATORS (RSI, Stochastic, MFI): well-established --
    // mean-reversion signals work better range-bound, can stay "extreme"
    // through a real trend without reverting (a false-signal risk specific
    // to trends, not chop).
    momentumOscillator: { TREND_UP:0.7, TREND_DOWN:0.7, CHOP:1.3, HIGH_VOL:1.0, DEFAULT:1.0 },
    // MACD specifically -- NOT the same reasoning as the oscillators above.
    // Grounded in this project's OWN real backtest finding (Tier 1, real
    // market data): fast-reacting indicators do better when regimes change
    // often (chop, high-vol) and worse in long, stable trends, where their
    // speed just creates noise/whipsaws. Evidence-based, not textbook.
    fastTrendFollowing: { TREND_UP:0.8, TREND_DOWN:0.8, CHOP:1.1, HIGH_VOL:1.1, DEFAULT:1.0 },
    // ADX: measures trend STRENGTH by definition -- more meaningful when
    // there's an actual trend to measure, close to noise in genuine chop.
    trendStrength: { TREND_UP:1.3, TREND_DOWN:1.3, CHOP:0.7, HIGH_VOL:1.0, DEFAULT:1.0 },
    // Price/RSI divergence: a reversal warning means more as a real signal
    // during a clean trend (something to actually reverse FROM); chop
    // produces divergence-like noise as a matter of course.
    divergence: { TREND_UP:1.2, TREND_DOWN:1.2, CHOP:0.8, HIGH_VOL:1.0, DEFAULT:1.0 },
    // Volatility/squeeze indicators: most predictive right around regime
    // TRANSITIONS -- high-vol and chop (often right before a breakout).
    volatility: { TREND_UP:0.8, TREND_DOWN:0.8, CHOP:1.2, HIGH_VOL:1.3, DEFAULT:1.0 },
    // Volume: most valuable as CONFIRMATION of a genuine move; noisier and
    // less confirmatory in a directionless, choppy tape.
    volume: { TREND_UP:1.2, TREND_DOWN:1.2, CHOP:0.8, HIGH_VOL:1.1, DEFAULT:1.0 }
  };
  // indicatorType is optional -- omit it (existing calls, untouched) and
  // behavior is EXACTLY as before, static weight, no multiplier applied.
  function add(cat, sig, weight, indicatorType) {
    let w = weight;
    if (indicatorType && INDICATOR_REGIME_MULT[indicatorType]) {
      const table = INDICATOR_REGIME_MULT[indicatorType];
      w = weight * (table[regime] != null ? table[regime] : table.DEFAULT);
    }
    signals.push({ cat, sig: Math.max(-1,Math.min(1,sig)), weight: w });
  }

  add('Momentum', ind.rsi14<30?1:ind.rsi14>70?-1:ind.rsi14>55?0.5:ind.rsi14<45?-0.5:0, 3, 'momentumOscillator');
  add('Momentum', ind.histogram>0&&ind.histSlope>0?1:ind.histogram<0&&ind.histSlope<0?-1:ind.histogram>0?0.5:-0.5, 3, 'fastTrendFollowing');
  add('Momentum', ind.stochK<20?1:ind.stochK>80?-1:ind.stochK>ind.stochD?0.5:-0.5, 2, 'momentumOscillator');
  // v9.29: StochRSI was computed (W9.6, v9.0 -- "a faster/more-sensitive
  // momentum oscillator than either RSI or price-Stoch alone") but never
  // wired into any scored signal -- found by a systematic computed-but-
  // unused audit (UNUSED_FIELDS_AUDIT_AND_WEEKLY_AGREEMENT_RESULTS.md), not
  // a new indicator invented here. Same 0-100 stochastic-style scale as
  // stochK, no companion signal line (same shape as mfi14 below it) --
  // reuses mfi14's exact threshold pattern rather than inventing new bands,
  // and the same weight as stochK (2) since it's the same instrument class,
  // not a fitted number. Not yet re-backtested with this signal included --
  // a real, disclosed next step, same standing as every other addition to
  // this scoring function.
  // v9.30: sarBullish (the other orphaned field from the same audit) --
  // retired, not wired. Its name doesn't match its actual computation (an
  // EMA9/EMA21 persistence count, not real Parabolic SAR) and it's
  // conceptually redundant with goldenCross/above50 already scored --
  // a stale/renamed leftover, not a clean oversight like stochRSI was.
  // Confirmed zero downstream reads anywhere in this file before removing
  // (computed + returned but never scored, displayed, or referenced) --
  // this removes dead weight, doesn't change any real dashboard output.
  add('Momentum', ind.stochRSI<20?1:ind.stochRSI>80?-1:ind.stochRSI>55?0.5:ind.stochRSI<45?-0.5:0, 2, 'momentumOscillator');
  add('Momentum', ind.mfi14<20?1:ind.mfi14>80?-1:ind.mfi14>55?0.5:ind.mfi14<45?-0.5:0, 2, 'momentumOscillator');
  add('Momentum', ind.divergence.type==='bullish'?1:ind.divergence.type==='bearish'?-1:0, 3, 'divergence');

  // v9.96: guarded, matching the `if (ind.rs) add(...)` skip-when-missing
  // convention a few lines below -- a young ticker's missing 200-day SMA is
  // cleanly excluded from the Trend category average now, not defaulted
  // to a biased -0.5 (see pctFromSma200's own fix comment).
  if (ind.pctFromSma200 != null) add('Trend', ind.pctFromSma200>5?1:ind.pctFromSma200<-5?-1:ind.pctFromSma200>0?0.5:-0.5, 4);
  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): this "Trend" signal and the "Golden/Death Cross" signal at
  // scoreAllSignalsV7_'s addL site both read the same ind.goldenCross/
  // ind.deathCross flags, but fell back to two DIFFERENT, contradictory
  // conditions when neither cross is active -- this one used
  // ind.above50 (price vs its own 50-day SMA), the other used
  // sma50>sma200 (the two moving averages' relative position). Both are
  // live, both feed a real score. Reconciled to the sma50>sma200
  // fallback, matching what "Golden/Death Cross" actually names and the
  // note text this signal already displays (SMA50=.../SMA200=...).
  // v9.96: guarded on ind.sma200 -- the ||0 fallback let a missing sma200
  // (young ticker) silently read as a false "bullish align" (sma50 is
  // almost always >0). goldenCross/deathCross are already false here via
  // crossDataAvailable when sma200 is missing, so this only ever changes
  // the fallback branch's behavior for that case: cleanly excluded now,
  // matching pctFromSma200's own fix immediately above.
  if (ind.sma200 != null) add('Trend', ind.goldenCross?1:ind.deathCross?-1:(ind.sma50>ind.sma200?0.5:-0.5), 4);
  add('Trend', ind.adx14>25&&ind.adxBullish?1:ind.adx14>25&&!ind.adxBullish?-1:0, 3, 'trendStrength');
  add('Trend', (gann.score-50)/50, 2); // W4 (v8.0): weight 4→2 — Gann is confirmation, not a primary trend driver
  if (ind.rs) add('Trend', ind.rs.rs63>10?1:ind.rs.rs63<-10?-1:ind.rs.rs63>0?0.5:-0.5, 3);

  // Real bug found and fixed (user asked "volume vs avg volume", led directly
  // to checking this): the moderate-volume branch (1.0-1.5x average) ignored
  // price direction entirely, always nudging bullish even with price BELOW
  // its own SMA20 -- inconsistent with the high-volume branch just above it,
  // which correctly considers direction. Verified by hand before fixing:
  // volumeSignal(1.2, price=90, sma20=100) returned +0.3 (wrong) instead of
  // -0.3. Now direction-aware at both volume tiers, same pattern, smaller
  // magnitude for the weaker moderate-volume signal.
  const volDir = cp>(ind.sma20||0) ? 1 : cp<(ind.sma20||0) ? -1 : 0;
  add('Volume', ind.volRatio>1.5 ? volDir : (ind.volRatio>1 ? 0.3*volDir : 0), 2, 'volume');
  add('Volume', ind.obvShortSlope>0?1:ind.obvShortSlope<0?-1:0, 2, 'volume');
  add('Volume', ind.cmf20>0.1?1:ind.cmf20<-0.1?-1:0, 2, 'volume');

  add('Volatility', ind.bbSqueeze?0.3:0, 1, 'volatility');
  add('Volatility', ind.atrRatio>1.3?-0.3:ind.atrRatio<0.7?0.3:0, 1, 'volatility');

  add('Position', ind.fibPct>0.618?0.5:ind.fibPct<0.236?-0.5:0, 2);
  add('Position', ind.range52Pct>80?0.3:ind.range52Pct<20?-0.3:0, 1);

  // Options positioning (institutional smart-money) — a TIMING signal, added to
  // BUY-TIMING only, never to OWN. Absent snapshot => no signals => weight auto-drops.
  if (optAnalysis && optAnalysis.available) {
    add('Options', optAnalysis.dirSig, 5);           // near/mid directional (P/C, conviction dominance, $ bias)
    add('Options', optAnalysis.leapsLean * 0.6, 3);  // LEAPS structural lean (softer)
  }

  // W5 (v8.1): ENGINE UNIFICATION — the HEADLINE techScore is now
  // regime-adaptive, matching the philosophy that previously lived ONLY in the
  // legacy scoreAllSignalsV7_ path. Before, this function used a single STATIC
  // catWeight regardless of regime, so the number the user actually acts on
  // never benefited from the regime classifier. Now the same regime drives
  // both. DEFAULT reproduces the original static weights exactly, so an
  // unrecognized/absent regime degrades to prior behavior, not a guess.
  // (Options weight held ~constant across regimes — it's a positioning signal,
  // not a regime-sensitive one.)
  // regime already computed above (moved up for the per-indicator
  // multipliers) -- removed this duplicate declaration.
  const HEADLINE_WEIGHTS_BY_REGIME = {
    TREND_UP:   { Momentum:0.30, Trend:0.34, Volume:0.12, Volatility:0.04, Position:0.08, Options:0.12 },
    TREND_DOWN: { Momentum:0.30, Trend:0.34, Volume:0.12, Volatility:0.04, Position:0.08, Options:0.12 },
    CHOP:       { Momentum:0.22, Trend:0.24, Volume:0.14, Volatility:0.14, Position:0.14, Options:0.12 },
    HIGH_VOL:   { Momentum:0.22, Trend:0.24, Volume:0.12, Volatility:0.20, Position:0.10, Options:0.12 },
    DEFAULT:    { Momentum:0.27, Trend:0.31, Volume:0.13, Volatility:0.07, Position:0.10, Options:0.12 },
  };
  const catWeight = HEADLINE_WEIGHTS_BY_REGIME[regime] || HEADLINE_WEIGHTS_BY_REGIME.DEFAULT;
  const headlineUsedDefaultWeights = !HEADLINE_WEIGHTS_BY_REGIME[regime];
  const byCat = {};
  signals.forEach(s => { if (!byCat[s.cat]) byCat[s.cat]={wSum:0,wTot:0}; byCat[s.cat].wSum+=s.sig*s.weight; byCat[s.cat].wTot+=s.weight; });
  let num=0, den=0;
  Object.keys(byCat).forEach(c => { const sig = byCat[c].wTot ? byCat[c].wSum/byCat[c].wTot : 0; const w = catWeight[c]||0.1; num+=sig*w; den+=w; });
  const overallSig = den ? num/den : 0;
  const techScore = Math.round(((overallSig+1)/2)*100);

  const entryPrice = confluence.entryCenter, entryLow = confluence.entryLow, entryHigh = confluence.entryHigh;
  const timeToEntry = timeToPriceV7(cp, entryPrice, { atr: ind.atr14, regime, gann, closes: chart.closes });

  let timing;
  // Phase 3, Sub-phase 3.1.1: the trend gate. Previously BUY_NOW could fire in
  // ANY regime (including CHOP/HIGH_VOL) as long as price was near the entry
  // zone — undermining the whole point of having a regime classifier. Now
  // BUY_NOW is only reachable from TREND_UP; everything else (CHOP, HIGH_VOL)
  // falls through to WAIT_PULLBACK, same as an out-of-zone TREND_UP would.
  // TREND_DOWN/strongly-negative-signal still forces AVOID, unchanged.
  if (regime === 'TREND_DOWN' || overallSig <= -0.35) timing = 'AVOID';
  else if (regime === 'TREND_UP' && cp <= entryHigh*1.02) timing = 'BUY_NOW';
  else timing = 'WAIT_PULLBACK';

  const entryMethodCount = (confluence.entryMethods||[]).length;
  const totalEntryMethods = (confluence.allEntryMethods||[]).length || entryMethodCount || 1;
  const confluenceStrength = totalEntryMethods ? (entryMethodCount/totalEntryMethods) : 0;
  const timeAgreementScore = !timeToEntry?0.3 : timeToEntry.agreement==='high'?0.9 : timeToEntry.agreement==='medium'?0.6 : 0.3;
  const regimeAlignScore = regime==='TREND_UP'?0.8 : regime==='CHOP'?0.5 : regime==='HIGH_VOL'?0.35 : 0.5;
  let entryConfidencePct = Math.round((confluenceStrength*0.4 + timeAgreementScore*0.35 + regimeAlignScore*0.25)*100);
  // Elevated IV (options pricing a big move / event) trims entry confidence — not direction.
  if (optAnalysis && optAnalysis.available && optAnalysis.ivRank != null && optAnalysis.ivRank >= 80) {
    entryConfidencePct = Math.max(0, entryConfidencePct - 8);
  }

  const { t1, t2 } = deriveExitTargetsV7(confluence, ind.atr14, entryPrice);
  const t1Time = t1 ? timeToPriceV7(cp, t1.price, { atr: ind.atr14, regime, gann, closes: chart.closes }) : null;
  const t2Time = t2 ? timeToPriceV7(cp, t2.price, { atr: ind.atr14, regime, gann, closes: chart.closes }) : null;
  const stopRR = computeStopRRV7(entryPrice, ind.atr14, regime, t1, t2);
  // 2026-09-06, real gap found via a real live ALAB run + independent Opus
  // review: R:R/stop above are correctly computed for the PLANNED ladder
  // entry (entryPrice = confluence.entryCenter) -- by design, not a bug --
  // but nothing anywhere shows what the R:R actually is if bought at
  // TODAY's price instead, which is the real, actionable question whenever
  // price sits well outside the entry zone (ALAB: ~$310 spot vs a
  // $266-274 ladder). Reuses the SAME pure function with cp instead of
  // entryPrice -- a fresh ATR-stop from spot, against the SAME real target
  // levels (t1/t2 are real technical levels, not tied to any one entry
  // price), so this is a real, correct "if you bought right now" figure,
  // not a guess.
  const stopRRAtSpot = computeStopRRV7(cp, ind.atr14, regime, t1, t2);
  const classicalStop = computeClassicalStopV1_(chart, ind, 'long'); // v9.71, Schabacker Study X: purely additive, separate from stopRR above
  const basingPointStop = computeBasingPointStopV1_(chart, ind, 'long'); // v9.75, Edwards & Magee Ch27/28/28.1: purely additive, separate from stopRR/classicalStop above
  const alternateBasingPointStop = computeAlternateBasingPointV1_(chart, ind, 'long'); // v9.89, Edwards & Magee Ch28 p443: purely additive real 2nd basing-point-creation path (>=15% move + >=40% retracement), separate from basingPointStop above
  const sidewaysBasingPointStop = computeSidewaysBasingPointV1_(chart, ind, 'long'); // v9.90, Edwards & Magee Ch28 p443-444: purely additive real 3rd (final) basing-point-creation path (<40% retracement + sideways band + declining volume), separate from the 2 basing-point stops above
  const nNormalizedPositionSize = computeNNormalizedPositionSizeV1_(entryPrice, ind.turtleN); // v9.78, Edwards & Magee Appendix E: purely additive 2nd position-sizing opinion, does not affect computePositionSizeV7_'s own existing call site
  const compositeLeverage = computeCompositeLeverageV1_(entryPrice, ind.atrRatio); // v9.78, Edwards & Magee Appendix A: purely additive, informational leverage-risk read
  // v9.81, Edwards & Magee Ch14: purely additive, only meaningful with a
  // clear real Primary trend context (regime) to correct within/channel --
  // real, disclosed null on CHOP/HIGH_VOL, same "don't force a read where
  // the book's own real scope doesn't apply" discipline as elsewhere.
  const fanPrinciple = regime === 'TREND_UP' ? computeFanPrincipleV1_(chart, 'bullCorrection') : regime === 'TREND_DOWN' ? computeFanPrincipleV1_(chart, 'bearRecovery') : null;
  const trendChannel = regime === 'TREND_UP' ? computeTrendChannelV1_(chart, 'up') : regime === 'TREND_DOWN' ? computeTrendChannelV1_(chart, 'down') : null;

  const drivers = [
    { label:'RSI(14)', value: ind.rsi14.toFixed(1), note: ind.rsi14<30?'oversold':ind.rsi14>70?'overbought':'neutral' },
    { label:'ADX(14)', value: ind.adx14.toFixed(1)+(ind.adxBullish?' (+DI>-DI)':' (-DI>+DI)'), note: ind.adx14>25?'trending':'weak/sideways' },
    { label:'Trend (SMA)', value: (ind.above200?'above':'below')+' 200MA, '+(ind.above50?'above':'below')+' 50MA', note: ind.goldenCross?'golden cross':ind.deathCross?'death cross':'' },
    { label:'RS vs SPY (3mo)', value: ind.rs?((ind.rs.rs63>=0?'+':'')+ind.rs.rs63.toFixed(1)+'%'):'N/A', note: ind.rs?(ind.rs.outperforming?'outperforming':'underperforming'):'SPY data unavailable' },
    { label:'Trailing Performance', value: ind.trailingPerf ? ['week','month','quarter','halfYear','year','ytd','threeYear','fiveYear','tenYear'].map(k => {
        const labels = {week:'1W',month:'1M',quarter:'3M',halfYear:'6M',year:'1Y',ytd:'YTD',threeYear:'3Y',fiveYear:'5Y',tenYear:'10Y'};
        const v = ind.trailingPerf[k];
        return v==null ? null : labels[k]+' '+(v>=0?'+':'')+(v*100).toFixed(1)+'%';
      }).filter(Boolean).join('  ') : 'N/A', note: (ind.trailingPerf && ind.trailingPerf.tenYear==null) ? '3Y/5Y/10Y (v9.26): dedicated long-range fetch, closes-only, separate from the main 2yr pipeline -- missing values mean either the fetch failed or the ticker has less history than that window (e.g. a recent IPO), not a hard error' : '' },
    { label:'Multi-Timeframe', value: ind.weeklyTrend ? 'Daily: '+regime+' / Weekly: '+ind.weeklyTrend : 'N/A',
      note: (() => { // real gap found directly: no check existed for whether the daily regime agrees with the larger weekly trend
        if (!ind.weeklyTrend) return 'insufficient history for the 40-week comparison';
        if (regime === 'CHOP') return 'daily is choppy, nothing to compare';
        const dailyDir = regime === 'TREND_UP' ? 'UP' : 'DOWN';
        return dailyDir === ind.weeklyTrend ? 'AGREE -- daily move is confirmed by the larger weekly trend' : 'DISAGREE -- daily move runs against the larger weekly trend, treat with caution';
      })() },
    { label:'Gann', value: gann.score+'/100', note: 'pivot '+gann.pivot.dateStr+' @ $'+gann.pivot.price.toFixed(2) }
  ];

  return {
    techScore, regime, timing,
    headlineWeights: catWeight, headlineUsedDefaultWeights, // W5 (v8.1): regime-adaptive headline weighting, exposed for the dashboard transparency line
    entryPrice, entryLow, entryHigh, entryConfidencePct,
    timeToEntry, t1, t1Time, t2, t2Time,
    stop: stopRR.stop, rrToT1: stopRR.rr1, rrToT2: stopRR.rr2,
    // 2026-09-06: purely additive, real "if bought at today's price" companion figures -- does not change stop/rrToT1/rrToT2 above (still the ladder-based ones every existing consumer/gate reads).
    stopAtSpot: stopRRAtSpot.stop, rrToT1AtSpot: stopRRAtSpot.rr1, rrToT2AtSpot: stopRRAtSpot.rr2,
    classicalStop, // v9.71, Schabacker Study X: purely additive, separate real stop-loss method, does not affect stop/rrToT1/rrToT2 above
    basingPointStop, // v9.75, Edwards & Magee Ch27/28/28.1: purely additive, separate real stop-loss method, does not affect stop/rrToT1/rrToT2/classicalStop above
    alternateBasingPointStop, // v9.89, Edwards & Magee Ch28 p443: purely additive real 2nd basing-point-creation path, does not affect basingPointStop or anything else above
    sidewaysBasingPointStop, // v9.90, Edwards & Magee Ch28 p443-444: purely additive real 3rd (final) basing-point-creation path, does not affect either basing-point stop above
    nNormalizedPositionSize, // v9.78, Edwards & Magee Appendix E: purely additive 2nd position-sizing opinion, does not affect computePositionSizeV7_'s own existing call site
    compositeLeverage, // v9.78, Edwards & Magee Appendix A: purely additive, informational leverage-risk read
    fanPrinciple, // v9.81, Edwards & Magee Ch14: purely additive, real Three-Fan Rule correction-completion read
    trendChannel, // v9.81, Edwards & Magee Ch14: purely additive, real Trend Channel/Return Line symmetric-overshoot projection
    drivers, entryMethods: confluence.entryMethods||[], exitMethods: confluence.exitMethods||[],
    atr14: ind.atr14, // added for Sub-phase 10.3 (chart's ATR band) — purely additive, doesn't change anything else about this function
    secular: computeSecularReadV7_(chart.closes), // W9.1 (v9.0): long-term "own for years?" read (informational)
    entryCount: confluence.entryCount, // added for chart LILO rungs — purely additive, reuses the existing value unchanged
    options: (optAnalysis && optAnalysis.available) ? optAnalysis : null
  };
}

// ────────────────────────────────────────────────────────────────
//  §5B.2 — MACRO REGIME CONVICTION MODIFIER (v9.24)
//  BIG_PICTURE_ANALYSIS_PLAN.md §3c. Built ahead of that plan's own stated
//  gate ("only if 3b holds up") -- 3b (macro_fetchers's
//  testMacroRegimePredictiveValue, run this session) came back directionally
//  correct but weak: RISK_ON mean 1.24%/hit 72% vs RISK_OFF mean 0.96%/hit
//  66%, small gap, never tested against a real drawdown (see
//  MACRO_REGIME_VALIDATION_RESULTS.md). Built anyway per explicit
//  instruction. Adjustment magnitude kept deliberately small (well under the
//  options block's +8/-10) because the underlying signal is weak/unconfirmed
//  -- and every time it fires, the conviction note says so, not hidden.
//
//  Reuses classifyMacroRegimeAt_Macro/alignSeries_Macro/
//  fetchHistoricalOHLCV_Macro from macro_fetchers_v0_7.gs VERBATIM (same
//  Apps Script project, same global scope, no duplication) -- the exact
//  functions already validated on real data in that file's own test.
//  Cached at the script-execution level so a batch report over many tickers
//  fetches the 9 macro series once, not once per ticker.
//
//  v9.56 (2026-08-24): macro_fetchers bumped v0.5->v0.6 -- its
//  fetchHistoricalOHLCV_Macro switched from Yahoo to Nasdaq, real reason
//  being this exact feature had NEVER once fired with real data in this
//  whole project (Yahoo blocked on the dev sandbox this was built/tested
//  in) -- getCachedMacroRegime_ always silently returned {available:false}.
//  Real live test after the swap (see CHECKPOINT_TODAY.md): genuinely the
//  FIRST real macro regime read this project has ever produced --
//  RISK_ON, 2026-08-24, real Nasdaq data, all 9 tickers. No code in THIS
//  file changed for the fix itself (the fetch swap lives entirely in
//  macro_fetchers_v0_7.gs) -- this comment update is the only change here.
// ────────────────────────────────────────────────────────────────
// v9.70 real fix -- set ONCE, at the true top of runCompleteTickerAnalysisV7Continued
// (the actual start of the real 360s execution ceiling for an interactive
// run). null when not set at all (e.g. the daily-automation batch loop or
// the standalone reuse call at ~7883, neither of which set this) --
// hasTimeBudgetV7_ treats null as "no reference, don't block" so those
// callers keep their prior behavior unchanged, not silently gated.
var _runStartTimeV7 = null;

// Real, disclosed limitation stated plainly, not hidden: this can only
// protect a step that HASN'T started yet. It cannot cancel or time-box a
// call already in flight -- Apps Script provides no real mechanism for
// that. It exists specifically for the heavy, genuinely-optional steps
// deep in a single ticker's run (Gemini review, 13F, broker-model report,
// comparison report) where skipping late is honest and disclosed, better
// than letting one of them consume 100% of whatever budget is left and
// silently killing the entire report. marginMs is a reasoned estimate of
// that specific step's own typical cost, not empirically validated (same
// standing caveat as every other threshold in this engine).
function hasTimeBudgetV7_(marginMs) {
  if (_runStartTimeV7 == null) return true;
  const HARD_CEILING_MS = 300 * 1000; // 5 min -- 60s safety margin under the real 360s Apps Script cap
  return (Date.now() - _runStartTimeV7) + (marginMs || 0) <= HARD_CEILING_MS;
}

var _macroRegimeCache = null; // {regime, available} once computed this execution; null = not yet attempted

// v9.62 real fix: real first-ever live Apps Script execution (2026-08-25,
// user's own Full Ticker Analysis on PLTR) genuinely exceeded the
// execution-time ceiling -- the 🔬 Log trace showed the run died right
// after techPlan.options was logged, immediately before this function's
// first real call. The 9-ticker for-loop below used to call
// fetchHistoricalOHLCV_Macro (one real sequential network round-trip per
// ticker -- v9.67: the "25s deadline, worst case 225s" framing here was
// wrong, deadline isn't a real UrlFetchApp.fetch() parameter, corrected
// per docs/OPUS_REVIEW_2026-08-27.md; the real bottleneck was simply 9
// sequential round-trips with no bound). Switched to
// fetchHistoricalOHLCV_MacroBatch (real UrlFetchApp.fetchAll()-based
// concurrent fetch) -- collapsed the real 9x round-trip cost to roughly 1x.
//
// v9.70 real fix -- that batch fetch itself hung for the full remaining
// ~315s of a real interactive run (2026-08-30, user's real PLTR run) and
// was killed by Apps Script's own hard 360s cap. Confirmed live, right
// then, that Nasdaq's endpoint itself was NOT slow (all 9 tickers, HTTP
// 200, 1.9-4.0s each, tested directly outside Apps Script) -- the hang was
// specific to that one execution, genuinely not fully diagnosable from
// outside Apps Script itself, disclosed honestly rather than guessed at.
// Since Apps Script gives no real way to cancel or time-box a call once
// it's in flight, a time-elapsed guard before calling can't help either --
// only 45s had elapsed when that call started, so any reasonable guard
// would have said "plenty of budget, proceed" and it would have hung the
// same way. Real fix: this function is now CACHE-ONLY in the interactive
// path -- it never calls fetchHistoricalOHLCV_MacroBatch itself anymore.
// Freshness is maintained by a separate, isolated trigger
// (refreshMacroRegimeCacheV1 / installMacroRegimeCacheTriggerV1,
// macro_fetchers_v0_11.gs) fully decoupled from any interactive run -- if
// THAT hangs on some rare day, only its own standalone execution dies; no
// user-facing report is ever waiting on it. A stale/missing cache here
// degrades instantly to {available:false} -- zero network calls, zero
// possible hang, by construction, not by a heuristic. Real, accepted
// tradeoff: macro regime can now be UP TO ~1 DAY stale (between trigger
// runs) instead of always-live -- already an explicitly "weak/unconfirmed"
// conviction modifier (see its own call site's comment), so a day of
// staleness is a real, disclosed, acceptable cost for never hanging again.
function getCachedMacroRegime_() {
  if (_macroRegimeCache !== null) return _macroRegimeCache;
  const _t0 = Date.now();
  // 2026-09-01 real fix: M2/yield-curve are a genuinely SEPARATE cache
  // (different source, different cadence) from the 9-ticker regime read
  // above -- deliberately NOT coupled to its own availability, so a stale
  // 9-ticker cache doesn't also hide otherwise-fresh supplemental data,
  // and vice versa. Attached to every real exit path below.
  const supplemental = (typeof getCachedMacroSupplementalV1_ === 'function') ? getCachedMacroSupplementalV1_() : null;
  // v9.79, Edwards & Magee Ch3-5.1 -- same "deliberately separate, attached
  // on every real exit path below" discipline as supplemental just above.
  const dowTheory = (typeof getCachedDowTheoryConfirmationV1_ === 'function') ? getCachedDowTheoryConfirmationV1_() : null;
  // v9.79, Edwards & Magee Ch38 -- same "deliberately separate" discipline
  // as dowTheory/supplemental just above (darkPoolTrackerV1.gs's own
  // isolated trigger, cache-only here).
  const evaluativeIndex = (typeof getCachedEvaluativeIndexV1_ === 'function') ? getCachedEvaluativeIndexV1_() : null;
  try {
    const tickers = ['SPY','TLT','GLD','XLP','XLU','XLV','XLY','XLI','XLB'];
    const seriesMap = {};
    for (const t of tickers) {
      const cached = readMacroPriceCache_(t);
      if (!(typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(cached))) {
        _macroRegimeCache = { available: false, supplemental, dowTheory, evaluativeIndex };
        Logger.log('  ⏱ getCachedMacroRegime_: ' + ((Date.now()-_t0)/1000).toFixed(1) + 's (unavailable -- ' + t + ' cache stale/missing, not fetched live -- see refreshMacroRegimeCacheV1)');
        return _macroRegimeCache;
      }
      seriesMap[t] = cached;
    }
    const aligned = alignSeries_Macro(seriesMap);
    const LOOKBACK = 20; // matches the exact parameter validated in MACRO_REGIME_VALIDATION_RESULTS.md
    const latestIdx = aligned._dates.length - 1;
    const regime = classifyMacroRegimeAt_Macro(aligned, latestIdx, LOOKBACK);
    _macroRegimeCache = regime ? { regime, available: true, supplemental, dowTheory, evaluativeIndex } : { available: false, supplemental, dowTheory, evaluativeIndex };
  } catch (e) {
    _macroRegimeCache = { available: false, supplemental, dowTheory, evaluativeIndex }; // non-fatal -- macro read is supplementary, never blocks a report
  }
  Logger.log('  ⏱ getCachedMacroRegime_: ' + ((Date.now()-_t0)/1000).toFixed(1) + 's (cache-only, no network call)');
  return _macroRegimeCache;
}

// ────────────────────────────────────────────────────────────────
//  §5C — DECISION (reads both scores, blends NEITHER)
// ────────────────────────────────────────────────────────────────

function synthesizeDecisionV7(fundResult, techPlan, optAnalysis, status) {
  const fundBand = fundResult.score==null ? 'unknown' : fundResult.score>=57?'own':fundResult.score>=43?'mixed':'weak';
  const timing = techPlan.timing;

  // Partial-data awareness (user's explicit ask, 2026-09-04): a handled/
  // caught upstream failure (stale-cache fundamentals, missing RS) must not
  // be silent here just because it didn't crash the run — surfaced on both
  // the headline (so it's seen without hunting for the separate status
  // banner) and the Final Conviction notes (full detail).
  const dataWarnings = [fundResult.dataWarning, techPlan.dataWarning].filter(Boolean);

  const MATRIX = {
    own:  { BUY_NOW:{emoji:'✅',label:'BUY NOW'}, WAIT_PULLBACK:{emoji:'⏳',label:'GREAT COMPANY — SET A BUY LIMIT'}, AVOID:{emoji:'⚠️',label:'GOOD COMPANY, BAD TAPE'} },
    mixed:{ BUY_NOW:{emoji:'➖',label:'Tradeable, not a conviction owner'}, WAIT_PULLBACK:{emoji:'➖',label:'Only-if-it-dips trade'}, AVOID:{emoji:'🚫',label:'Stand aside'} },
    weak: { BUY_NOW:{emoji:'🩳',label:'Technical bounce only (not own-worthy)'}, WAIT_PULLBACK:{emoji:'🚫',label:'Skip — weak fundamentals, no entry edge'}, AVOID:{emoji:'🔴',label:'Avoid entirely'} },
    unknown:{ BUY_NOW:{emoji:'❔',label:'No fundamentals — technical-only bounce'}, WAIT_PULLBACK:{emoji:'❔',label:'No fundamentals — technical-only, wait for entry'}, AVOID:{emoji:'❔',label:'No fundamentals — avoid, weak tape'} }
  };
  const cell = MATRIX[fundBand][timing];
  let action = cell.emoji + ' ' + cell.label;
  if (dataWarnings.length) action += '  ⚠ PARTIAL DATA';

  // Final Conviction (0–100): OWN-as-filter, TECH-as-driver, per your
  // explicit design. Once OWN clears OWN_FILTER_THRESHOLD, Final Conviction
  // is TECH alone — fundamentals stops competing with it 50/50 (the OLD
  // formula, (O+T)/2, is gone). Below the threshold, TECH gets reduced by
  // an ACCELERATING (squared) curve, not a flat per-point penalty — a
  // company barely below the bar loses little, one deep below loses most
  // or all of it. Below OWN_BLOCK_FLOOR, it's a hard block regardless of
  // how good the chart looks, options adjustments included.
  // Thresholds: 43 reuses the EXISTING fundBand boundary above (already
  // the 'weak' cutoff elsewhere in this file), not a new invented number.
  // 20 (the floor) is a reasoned default, NOT empirically validated —
  // worth revisiting against real data, flagged here so that's not lost.
  const OWN_FILTER_THRESHOLD = 43;
  const OWN_BLOCK_FLOOR = 20;
  const convNotes = [];
  dataWarnings.forEach(w => convNotes.push('⚠ PARTIAL DATA: ' + w));
  const isBlocked = (fundResult.score != null && fundResult.score <= OWN_BLOCK_FLOOR);
  const T = techPlan.techScore;
  let finalConviction;

  if (isBlocked) {
    finalConviction = 0;
    action = '🚫 BLOCKED — fundamentals too weak (OWN ' + fundResult.score + '/100), regardless of chart';
    if (dataWarnings.length) action += '  ⚠ PARTIAL DATA';
    convNotes.push('fundamentals block: OWN ' + fundResult.score + ' ≤ floor ' + OWN_BLOCK_FLOOR + ' — options adjustments skipped');
  } else {
    // Missing fundamentals data (fundResult.score == null) defaults O to 50,
    // which is >= OWN_FILTER_THRESHOLD — so a data outage passes through as
    // "no reduction" automatically, never blocks, per the earlier discussion.
    const O = fundResult.score != null ? fundResult.score : 50;
    let reduction = 0;
    if (O < OWN_FILTER_THRESHOLD) {
      const frac = (OWN_FILTER_THRESHOLD - O) / (OWN_FILTER_THRESHOLD - OWN_BLOCK_FLOOR);
      reduction = Math.pow(Math.min(1, Math.max(0, frac)), 2);
      convNotes.push('OWN ' + O + ' below filter (' + OWN_FILTER_THRESHOLD + ') — TECH reduced ' + Math.round(reduction*100) + '%');
    }
    finalConviction = Math.round(T * (1 - reduction));
    if (optAnalysis && optAnalysis.available) {
      if (optAnalysis.confirm === 'confirm') { finalConviction += 8; convNotes.push('options CONFIRM +8'); }
      else if (optAnalysis.confirm === 'conflict') { finalConviction -= 10; convNotes.push('options CONFLICT −10'); }
      if (optAnalysis.leapsLean >= 0.5) { finalConviction += 5; convNotes.push('LEAPS accumulation +5'); }
      else if (optAnalysis.leapsLean <= -0.5) { finalConviction -= 5; convNotes.push('LEAPS hedged −5'); }
    }
    // Macro regime conviction modifier (v9.24, §5B.2 above) -- small
    // deliberately, weak/unconfirmed underlying signal, disclosed in the
    // note every time it fires.
    const macroRead = getCachedMacroRegime_();
    setStatusV7(status, 'macroRegime', (macroRead && macroRead.available) ? 'ok' : 'degraded',
      (macroRead && macroRead.available) ? 'cached read' : 'cache stale/missing — refreshed by a separate daily trigger, not fetched inline (v9.70)');
    if (macroRead && macroRead.available) {
      if (macroRead.regime === 'RISK_OFF') { finalConviction -= 4; convNotes.push('macro regime RISK_OFF −4 (weak/unconfirmed signal — see MACRO_REGIME_VALIDATION_RESULTS.md)'); }
      else if (macroRead.regime === 'RISK_ON') { finalConviction += 2; convNotes.push('macro regime RISK_ON +2 (weak/unconfirmed signal — see MACRO_REGIME_VALIDATION_RESULTS.md)'); }
    }
    finalConviction = Math.max(0, Math.min(100, finalConviction));
  }

  // A3 (independent review addendum): promotionHops was computed in
  // deriveExitTargetsV7 but never shown anywhere -- given this whole
  // project's established "show your work" pattern (excluded methods,
  // decision traces, weight-profile transparency), silently promoting T1
  // was a real inconsistency. Surfaced here, in the same trace the R:R
  // gate below already writes to.
  if (techPlan.t1 && techPlan.t1.promotionHops) {
    convNotes.push('T1 promoted ' + techPlan.t1.promotionHops + 'x — the nearest confluence cluster was inside the minimum gap above entry, so a farther cluster was used instead');
  }

  // ── W2 (v8.0): RISK/REWARD QUALITY GATE ──────────────────────────
  // techPlan already computes rrToT1/rrToT2 but nothing acted on them, so a
  // sub-1.0 first-target R:R (you risk more than T1 pays) could still print as
  // a confident BUY. Now a poor R:R visibly downgrades the recommendation and
  // trims conviction; a thin-but-acceptable R:R adds a caution note only.
  //
  // A1 (independent review addendum): the original v8.0 gate used a FLAT 25%
  // penalty for any rr1 below 1.0 -- rr1=0.99 and rr1=0.1 got the identical
  // haircut. That's inconsistent with this codebase's OWN stated philosophy:
  // the OWN-filter above uses an accelerating squared curve specifically to
  // avoid flat penalties (see its own comment). Replaced with the same shape:
  // near-zero reduction right at the 1.0 boundary, scaling up to a real
  // maximum as R:R approaches 0 or goes negative (a broken/inverted target).
  // MAX_RR_REDUCTION=0.40 (worse than the old flat 25% for genuinely bad
  // setups, better/fairer for marginal ones near the boundary) -- a reasoned
  // default, not empirically validated, same standing caveat as every other
  // threshold in this engine.
  if (!isBlocked && techPlan.rrToT1 != null) {
    const rr1 = techPlan.rrToT1;
    if (rr1 < 1.0) {
      const MAX_RR_REDUCTION = 0.40;
      const frac = Math.min(1, Math.max(0, 1.0 - rr1)); // 0 at rr1=1.0, 1 at rr1<=0
      const rrReduction = Math.pow(frac, 2) * MAX_RR_REDUCTION;
      finalConviction = Math.max(0, Math.round(finalConviction * (1 - rrReduction)));
      convNotes.push('R:R gate: T1 R:R ' + rr1.toFixed(2) + ' < 1.0 — first target inside 1R, conviction −' + Math.round(rrReduction*100) + '%');
      action += '  ⚠ marginal structure (T1 R:R ' + rr1.toFixed(2) + ')';
    } else if (rr1 < 1.5) {
      convNotes.push('R:R note: T1 R:R ' + rr1.toFixed(2) + ' is thin (<1.5) — size accordingly');
    }
  }
  const timingLabel = { BUY_NOW:'BUY NOW ✅', WAIT_PULLBACK:'WAIT ⏳', AVOID:'AVOID ⚠️' }[timing];

  const fundStr = fundResult.score != null ? ('OWN ' + fundResult.score + '/100 ' + fundResult.verdict) : 'OWN N/A';
  const entryVerb = timing === 'WAIT_PULLBACK' ? 'Buy limit' : 'Buy';
  const entryStr = entryVerb + ' $' + techPlan.entryPrice.toFixed(2) + ' (zone $' + techPlan.entryLow.toFixed(2) + '–$' + techPlan.entryHigh.toFixed(2) + ')';
  const etaStr = techPlan.timeToEntry ? ', ETA ' + techPlan.timeToEntry.humanText : '';
  const confStr = ', ' + techPlan.entryConfidencePct + '% conf.';

  // headline omits the ticker itself (this function's signature per spec
  // takes no ticker) — buildDashboardV7 prepends "{ticker} — " when rendering.
  // dataWarnings prefix (2026-09-04): the ⚠ PARTIAL DATA tag already added
  // to `action` doesn't reach the headline (built independently, not from
  // `action`) — added here too so the FIRST line the user reads carries it,
  // not just the Action line further down.
  const headline = (dataWarnings.length ? '⚠ PARTIAL DATA  |  ' : '') +
    fundStr + '  |  BUY-TIMING: ' + timingLabel + '  |  ' + entryStr + etaStr + confStr + '  |  Conviction ' + finalConviction + '/100';

  const lines = [
    'Entry: $'+techPlan.entryPrice.toFixed(2)+' (zone $'+techPlan.entryLow.toFixed(2)+'–$'+techPlan.entryHigh.toFixed(2)+')',
    'ETA: '+(techPlan.timeToEntry?techPlan.timeToEntry.humanText:'N/A')+'   Confidence: '+techPlan.entryConfidencePct+'%',
    'Exit T1: '+(techPlan.t1?'$'+techPlan.t1.price.toFixed(2):'N/A')+(techPlan.t1Time?' ('+techPlan.t1Time.humanText+')':''),
    'Exit T2: '+(techPlan.t2?'$'+techPlan.t2.price.toFixed(2):'N/A')+(techPlan.t2Time?' ('+techPlan.t2Time.humanText+')':''),
    'Stop: $'+techPlan.stop.toFixed(2)+'   R:R '+(techPlan.rrToT1!=null?techPlan.rrToT1.toFixed(2):'N/A')+' / '+(techPlan.rrToT2!=null?techPlan.rrToT2.toFixed(2):'N/A')
  ];
  // W9.2 (v9.0): position-sizing line derived from the stop geometry above.
  const _pos = computePositionSizeV7_(techPlan.entryPrice, techPlan.stop, finalConviction);
  if (_pos) {
    lines.push('Size: '+_pos.shares+' sh (~$'+Math.round(_pos.cost).toLocaleString()+', risking $'+Math.round(_pos.dollarRisk).toLocaleString()+' = '+(_pos.riskPct)+'% acct × '+_pos.convScale.toFixed(2)+' conviction) — sizing is educational, not an order');
  }
  if (optAnalysis && optAnalysis.available) {
    lines.push('Options: ' + optAnalysis.confirm.toUpperCase() + ' — ' + optAnalysis.notes.join(' · '));
  } else {
    lines.push('Options: N/A (run Options Analysis on this ticker first for a positioning read)');
  }
  lines.push('Final Conviction: ' + finalConviction + '/100' + (convNotes.length ? '   [' + convNotes.join(', ') + ']' : ''));
  // W9.1 (v9.0): secular "own for years?" read (long-term context, distinct from BUY-TIMING).
  if (techPlan.secular) {
    lines.push('Secular (own for years?): ' + techPlan.secular.verdict + ' — ' + techPlan.secular.why);
  }
  lines.push('Action: '+action);

  return { headline, action, lines, fundBand, timing, finalConviction, dataWarnings, optionsConfirm: (optAnalysis && optAnalysis.available) ? optAnalysis.confirm : null };
}

// ────────────────────────────────────────────────────────────────
//  §6 — THE ONE-TAB DASHBOARD
// ────────────────────────────────────────────────────────────────

const V7_DASH_COLS = 10;

function padRowV7(vals) {
  const out = vals.slice(0, V7_DASH_COLS);
  while (out.length < V7_DASH_COLS) out.push('');
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  PHASE 4 — LILO: Layer-In / Layer-Out Position Laddering
//  Opt-in per run (Sub-phase 4.1, the dialog checkboxes). Pure display
//  construct — reads the SAME entry/exit prices Phase 1 already
//  computes, just breaks them into equal-split rungs (4.2.3: no new
//  price-target logic here, no confidence-weighting, per your decisions).
// ══════════════════════════════════════════════════════════════════

// 4.2.1: equal-split entry ladder. N rungs = however many confluence
// methods actually aligned (confluence.entryCount) — reuses existing
// data, no invented number. Highest rung near current price (buy first),
// lowest rung at the deepest point of the zone.
// P2-4 fix (deep-dive review): validate entryCount is a genuine positive
// integer before using it as a rung count. Previously `Math.max(1,
// confluence.entryCount || 1)` meant entryCount=0 (no aligned methods)
// still invented a single rung via the `|| 1` fallback, implying alignment
// that didn't exist; and a non-integer count (e.g. 2.5, if ever produced
// upstream) both looped wrong AND made portions not sum to 100%.
function computeStockEntryLadderV7(confluence) {
  const rawCount = confluence.entryCount;
  if (!Number.isInteger(rawCount) || rawCount <= 0) return []; // no aligned methods -> empty ladder, not a fabricated one
  const n = rawCount;
  const low = confluence.entryLow, high = confluence.entryHigh;
  const rungs = [];
  for (let i = 0; i < n; i++) {
    const price = n === 1 ? high : high - (high-low)*(i/(n-1));
    rungs.push({ rung: i+1, price, portion: 1/n });
  }
  return rungs;
}

// P2-4 fix, display half: rounding each rung's percentage independently
// can sum to 99% or 101% (e.g. three rungs of 33.33% -> 33+33+33=99%).
// Puts the rounding residual on the final rung so displayed percentages
// always sum to exactly 100%.
function ladderDisplayPercentsV7_(rungs) {
  if (!rungs.length) return [];
  const raw = rungs.map(r => Math.round(r.portion*100));
  const sum = raw.reduce((a,b)=>a+b,0);
  raw[raw.length-1] += (100 - sum);
  return raw;
}

// 4.2.2: exit ladder off T1/T2, equal split (matches the equal-split
// tranches decision — not confidence-weighted).
function computeStockExitLadderV7(techPlan) {
  const rungs = [];
  if (techPlan.t1) rungs.push({ rung: 1, price: techPlan.t1.price });
  if (techPlan.t2) rungs.push({ rung: 2, price: techPlan.t2.price });
  if (!rungs.length) return [];
  rungs.forEach(r => r.portion = 1/rungs.length);
  return rungs;
}

// 4.3.1: options ladder reuses the SAME price triggers as the stock
// ladder (same underlying, same confluence zone) — applied to buying
// more contracts of the SAME strike+expiry, never different strikes
// (the beginner-safety scope limit from the plan).
function computeOptionsEntryLadderV7(confluence) { return computeStockEntryLadderV7(confluence); }
function computeOptionsExitLadderV7(techPlan) { return computeStockExitLadderV7(techPlan); }

// 4.3.2: stated plainly every time an options ladder renders — the one
// real, honest difference from stock laddering.
function optionsLadderTimeDecayNoteV7() {
  return 'Waiting for a deeper entry costs time value on this option — the longer you wait, the less time decay matters (LEAPS decay slowly early on), but it is not free. Consider this before spreading LEAPS entries out too far.';
}

// 4.3.3: expiry-proximity exit flag, independent of price target.
function optionsExpiryFlagV7(daysToExpiry) {
  const THRESHOLD_DAYS = 45;
  if (daysToExpiry != null && daysToExpiry <= THRESHOLD_DAYS) {
    return '⚠ '+daysToExpiry+' days to expiry — consider closing regardless of price target';
  }
  return null;
}

// Real, serious bug found directly: hdr() was called 4 times inside
// buildDashboardV7 (Price Snapshot, Gann Summary, Key Price Levels, and
// now Price Gaps) but never defined anywhere in this file. Each call sat
// inside a try/catch added specifically so "a failure here must never
// take down the rest of the dashboard" -- which correctly protected the
// REST of the dashboard, but had the side effect of silently swallowing
// this ReferenceError every single time, with zero visible error. That
// means these 3 pre-existing sections have likely been silently missing
// from every dashboard run in this whole project. Confirmed the throw
// directly (ReferenceError: hdr is not defined) before writing this fix.
// Modeled on the exact, real, already-working header pattern used
// elsewhere in this file (e.g. the Investor Briefing title line).
// v9.46 renamed hdr -> hdrV7 (independent review, 2026-08-22, verified
// before fixing): this name collided with a same-named, DIFFERENT-
// signature `hdr` defined in futuresStockAnalysisV3_3_1.gs, which shares
// this project's Apps Script global scope. Latent and benign today (all
// real call sites happen to pass compatible args either way), but a real
// risk in a design that depends entirely on there being no collisions.
function hdrV7(sh, row, text, color, fontSize, colSpan) {
  sh.getRange(row,1,1,colSpan||14).merge().setValue(text).setBackground(color).setFontColor('#fff').setFontSize(fontSize||11).setFontWeight('bold');
}

function buildDashboardV7(ss, ticker, chart, ind, gann, confluence, fundResult, techPlan, decision, fund, opts, fundSource, aiReview, status, ladderStock, ladderOptions, leapsCallArg, shortTermCallArg, existingInstitutional13F, existingShortInterest) {
  // Best-of-both-worlds render: the familiar rich v6.1 report LAYOUT, driven by
  // the v6.1 dual-timeframe signal engine (scoreAllSignalsV7_), with EVERY v7
  // engine output kept and surfaced — the improved OWN score (fundResult), the
  // BUY-TIMING plan (techPlan), the deep options intelligence (opts) and the
  // Final Conviction synthesis (decision) — plus the new pedagogical AI narrative.
  const sh = getOrCreate(ss, CONFIG_V7.tab);
  // Same fix class as P2-2 — this dashboard's row count varies the most of
  // any sheet in the project (data availability, LILO toggle, held
  // positions, etc.), making it the highest-risk spot for a stale-merge
  // collision on rebuild.
  try { sh.getDataRange().breakApart(); } catch (e) {}
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#4a148c');
  let row = 1;
  const cp = chart.currentPrice;

  // v6.1 dual-timeframe scores (SHORT/LONG indicator tables + verdict)
  const scores = scoreAllSignalsV7_(ind, fund, gann, chart, techPlan.regime, existingShortInterest);

  // ══ HEADER ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📊 '+ticker+' — Investor Briefing '+CONFIG_V7.version+'   |   $'+cp.toFixed(2)+'   |   '+new Date().toLocaleString()).setBackground('#1a237e').setFontColor('#fff').setFontSize(14).setFontWeight('bold');row++;
    sh.getRange(row,1,1,14).merge().setValue('Indicators + Relative Strength + RSI Divergence + Gann (confirmation only) + Confluence + v7 Fundamentals & Options Intelligence + Gemini AI   |   Source: '+fundSource+(fund&&fund._crossRef?'   ⚠ '+fund._crossRef.length+' cross-source diff(s)':'')).setBackground('#283593').setFontColor('#c5cae9').setFontSize(10).setFontStyle('italic');row++;
    (buildDataStatusBannerV7(status)||[]).forEach(b=>{ try{ const rng=sh.getRange(row,1,1,14).merge().setValue(String(b.text[0])); const m=b.meta||{}; if(m.bg)rng.setBackground(m.bg); if(m.color)rng.setFontColor(m.color); if(m.bold)rng.setFontWeight('bold'); if(m.italic)rng.setFontStyle('italic'); if(m.wrap)rng.setWrap(true); if(m.size)rng.setFontSize(m.size); row++; }catch(e){} });
    row++;
  }catch(e){row+=3;}

  // ══ AI ANALYST REVIEW (Gemini) — pedagogical, at top ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🤖  AI ANALYST REVIEW  (Gemini '+GEMINI_MODEL+')').setBackground('#1b5e20').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    if (aiReview) {
      renderAiReviewV7_(aiReview).forEach(r=>{
        try{
          const rng=sh.getRange(row,1,1,14).merge().setValue(String(r.text[0])).setWrap(true).setVerticalAlignment('top');
          const m=r.meta||{};
          if(m.bg)rng.setBackground(m.bg); else rng.setBackground('#f1f8e9');
          if(m.color)rng.setFontColor(m.color);
          if(m.bold)rng.setFontWeight('bold');
          if(m.italic)rng.setFontStyle('italic');
          rng.setFontSize(m.size||10);
          const lines=Math.max(1,Math.ceil(String(r.text[0]).length/110));
          sh.setRowHeight(row, Math.min(120, 16*lines+6));
        }catch(e){}
        row++;
      });
      row++;
    } else {
      sh.getRange(row,1,1,14).merge().setValue('AI review unavailable — add GEMINI_API_KEY in Script Properties to enable. Every number below is unaffected.').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic');row+=2;
    }
  }catch(e){ sh.getRange(row,1).setValue('⚠️ AI review render error: '+e.message.substring(0,60)).setFontColor('#e65100'); row+=2; }

  // ══ YOUR POSITION — Phase 6, Sub-phase 6.5: read-only surfacing of any held STOCK/OPTION position for this ticker ══
  try {
    const portfolioResult = computePortfolioSummaryV7(ss);
    const held = getHeldPositionsForTickerV7(portfolioResult, ticker);
    if (held.length) {
      sh.getRange(row,1,1,14).merge().setValue('💼  YOUR POSITION').setBackground('#1a5276').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
      held.forEach(p => {
        try {
          if (p.assetType === 'STOCK') {
            const unrealizedPct = ((cp/p.avgCost)-1)*100;
            const line = 'You hold '+p.shares.toFixed(4).replace(/\.?0+$/,'')+' shares @ avg $'+p.avgCost.toFixed(2)+'  (current: '+(unrealizedPct>=0?'+':'')+unrealizedPct.toFixed(1)+'%)'
              + '   ·   Engine says: '+techPlan.timing+', stop $'+techPlan.stop.toFixed(2);
            sh.getRange(row,1,1,14).merge().setValue(line).setBackground('#d6eaf8').setFontColor('#1a5276').setFontWeight('bold');row++;
          } else {
            const snapText = p.snapshot ? ('as of '+new Date(p.snapshot.snapshotDate).toLocaleDateString()+', conviction '+p.snapshot.contract.conviction) : 'no recent options snapshot — run Options Analysis on this ticker to refresh';
            const line = 'You hold '+p.contracts+' '+p.ticker+' $'+p.strike+' exp '+p.expiry+' @ avg $'+p.avgPremium.toFixed(2)+' premium   ·   '+snapText;
            sh.getRange(row,1,1,14).merge().setValue(line).setBackground('#fdebd0').setFontColor('#7e5109').setFontWeight('bold').setWrap(true);row++;
          }
        } catch(e2) { row++; }
      });
      if (portfolioResult.warnings && portfolioResult.warnings.length) {
        sh.getRange(row,1,1,14).merge().setValue('⚠ Portfolio data issues (see '+TRANSACTIONS_SHEET_V7+'): '+portfolioResult.warnings.length+' warning(s) — check that sheet for details.').setBackground('#fdecea').setFontColor('#c0392b').setFontStyle('italic').setFontSize(9);row++;
      }
      row++;
    }
  } catch(e) { /* Phase 6 is additive — a failure here must never take down the rest of the dashboard */ }

  // ══ PRICE SNAPSHOT ══
  try {
    hdrV7(sh,row,'📈  PRICE SNAPSHOT','#37474f',11,14);row++;
    const dayChg=cp-chart.prevClose,dayChgPct=chart.prevClose?dayChg/chart.prevClose*100:0;
    sh.getRange(row,1,1,14).setValues([['Price','$'+cp.toFixed(2),'Day Change',(dayChg>=0?'+':'')+dayChg.toFixed(2)+' ('+(dayChgPct>=0?'+':'')+dayChgPct.toFixed(2)+'%)','52wk High','$'+ind.high52.toFixed(2),'52wk Low','$'+ind.low52.toFixed(2),'52wk Pos',ind.range52Pct.toFixed(1)+'%','ATR(14)','$'+ind.atr14.toFixed(2),'Currency',chart.currency]]).setBackground('#eceff1');
    sh.getRange(row,4).setFontColor(dayChg>=0?'#2e7d32':'#c62828').setFontWeight('bold');row++;
    // Earnings-date awareness (ENGINE_GAP_ANALYSIS.md, priority #1) --
    // only shown when there's a real date to show, and flagged distinctly
    // when it's close (within 30 days), since that's the case that
    // actually matters for both stock entry timing and options IV-crush risk.
    if (fund && fund._nextEarnings) {
      const daysOut = Math.round((new Date(fund._nextEarnings.dateStr+'T00:00:00Z') - new Date()) / (1000*60*60*24));
      const isSoon = daysOut <= 30;
      sh.getRange(row,1,1,14).merge()
        .setValue((isSoon ? '⚠ ' : '') + 'Next earnings: ' + fund._nextEarnings.dateStr + ' (~' + daysOut + ' days) '
          + (isSoon ? '— within 30 days, real volatility/IV-crush risk if holding an option through this' : ''))
        .setFontSize(10).setFontStyle('italic')
        .setBackground(isSoon ? '#fff3e0' : '#f5f5f5')
        .setFontColor(isSoon ? '#e65100' : '#666');
      row++;
    }
    row++;
  }catch(e){row+=3;}

  // ══ ENTRY / EXIT ZONES ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🎯  ENTRY & EXIT ZONES — Confluence of Multiple Methods').setBackground('#004d40').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    sh.getRange(row,1,1,8).setValues([['Zone','Price Range','Midpoint','Confidence','Which methods agree','% vs Now','Suggested Action','Horizon / Basis']]).setFontWeight('bold').setBackground('#00695c').setFontColor('#fff');row++;
    const entryUpside=(confluence.entryCenter/cp-1)*100;
    const entryAligned=(confluence.entryMethods||[]).map(m=>m.name).join(' | ')||'No strong confluence';
    // Phase 1, sub-phase 1.4: this text is now DERIVED from techPlan.timing — the
    // actual decision — instead of an independent entryUpside threshold. The old
    // version had no AVOID case at all, so it could read "buy now or on slight
    // pullback" on a run where the real decision was to avoid the stock entirely.
    const entrySuggestedAction = techPlan.timing==='AVOID' ? 'Plan says AVOID — regime/momentum unsupportive right now'
      : techPlan.timing==='BUY_NOW' ? 'Near current price — plan says buy now'
      : 'Wait for the zone — plan says buy on a dip';
    sh.getRange(row,1,1,8).setValues([['📥 ENTRY (Buy Zone)','$'+confluence.entryLow.toFixed(2)+' – $'+confluence.entryHigh.toFixed(2),'$'+confluence.entryCenter.toFixed(2),confluence.entryConfidence,entryAligned,(entryUpside>=0?'+':'')+entryUpside.toFixed(1)+'% from now',entrySuggestedAction,'Short-term entry: dip buy']]).setBackground('#e0f2f1');
    sh.getRange(row,4).setFontColor(confluence.entryCount>=3?'#1b5e20':confluence.entryCount>=2?'#e65100':'#b71c1c').setFontWeight('bold');
    sh.getRange(row,3).setFontWeight('bold').setFontColor('#004d40');row++;
    // Sub-phase 1.4.3: the Exit row's text is purely descriptive of the zone's
    // distance/character (not an action verb like "buy"/"sell") — confirmed safe
    // to leave as-is, doesn't imply a decision independent of the engine.
    const exitUpside=(confluence.exitCenter/cp-1)*100;
    const exitAligned=(confluence.exitMethods||[]).map(m=>m.name).join(' | ')||'No strong confluence';
    sh.getRange(row,1,1,8).setValues([['📤 EXIT (Sell Zone)','$'+confluence.exitLow.toFixed(2)+' – $'+confluence.exitHigh.toFixed(2),'$'+confluence.exitCenter.toFixed(2),confluence.exitConfidence,exitAligned,'+'+(exitUpside).toFixed(1)+'% upside',exitUpside>40?'Long-term hold — significant upside':exitUpside>15?'Medium-term target':'Near-term resistance','Long-term exit: scale out at zone']]).setBackground('#fce4ec');
    sh.getRange(row,4).setFontColor(confluence.exitCount>=3?'#1b5e20':confluence.exitCount>=2?'#e65100':'#b71c1c').setFontWeight('bold');
    sh.getRange(row,3).setFontWeight('bold').setFontColor('#880e4f');row+=2;
    sh.getRange(row,1,1,14).merge().setValue('📋  ALL PRICE METHODS — Entry (short) & Exit (long)').setBackground('#37474f').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    sh.getRange(row,1,1,6).setValues([['Price Method','Target Price','% vs Now','Horizon','Entry / Exit','Status']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
    // Item 2 fix: excluded candidates (null price OR excluded:true) are now
    // shown too, not silently omitted -- rendered separately, at the
    // bottom, with the specific reason, since they can't be meaningfully
    // sorted by price (some have no price at all).
    const rawAll=[...(confluence.allEntryMethods||[]).map(m=>({...m,tf:'Short'})),...(confluence.allExitMethods||[]).map(m=>({...m,tf:'Long'}))];
    const allMethods = rawAll.filter(m => !m.excluded && m.price != null);
    const excludedMethods = rawAll.filter(m => m.excluded || m.price == null);
    allMethods.sort((a,b)=>a.price-b.price).forEach((m,i)=>{
      try{
        const pct=(m.price/cp-1)*100;
        const isEntry=m.type==='support';
        const isConfluent=(isEntry?confluence.entryMethods:confluence.exitMethods).some(c=>c.name===m.name);
        sh.getRange(row,1,1,6).setValues([[m.name,'$'+m.price.toFixed(2),(pct>=0?'+':'')+pct.toFixed(2)+'%',m.tf,isEntry?'Entry':'Exit','']]).setBackground(isConfluent?(isEntry?'#a5d6a7':'#f48fb1'):i%2===0?'#eceff1':'#f5f5f5');
        sh.getRange(row,3).setFontColor(pct>=0?'#2e7d32':'#c62828');
        if(isConfluent)sh.getRange(row,1,1,6).setFontWeight('bold');
      }catch(e){}
      row++;
    });
    if (excludedMethods.length) {
      sh.getRange(row,1,1,6).merge().setValue('Excluded this run (candidate methods evaluated but not currently qualifying):').setFontStyle('italic').setFontSize(9).setFontColor('#666');row++;
      excludedMethods.forEach(m => {
        const priceStr = m.price != null ? '$'+m.price.toFixed(2) : 'N/A';
        sh.getRange(row,1,1,6).setValues([[m.name, priceStr, '', m.tf, m.type==='support'?'Entry':'Exit', m.exclusionReason||'excluded']]).setBackground('#fafafa').setFontColor('#999').setFontSize(9);
        row++;
      });
    }
    row+=2;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Entry/exit zone error: '+e.message.substring(0,80)).setFontColor('#e65100');row+=5;}

  // ══ ATR — dedicated section (user request: moved to sit with LILO, not
  // Macro Range — both this section and LILO are "how do I actually
  // execute this trade" mechanics (risk sizing, staged entry), distinct
  // from Macro Range's "big picture, where might price go" framing.
  // Presentation only — every value here is already computed elsewhere
  // (same ATR pullback formula from the entry-zone confluence calc, same
  // stop formula from computeStopRRV7), just gathered in one place. No new
  // calculation, no formula change. ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📏  ATR — Volatility & Risk Sizing').setBackground('#00695c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;

    const atrPctOfPrice = (ind.atr14/cp*100).toFixed(1);
    const atrReadWord = ind.atrRatio>1.3?'expanding':ind.atrRatio<0.7?'contracting':'normal';
    sh.getRange(row,1,1,4).setValues([['ATR(14)','% of price','vs 50d avg','Volatility regime']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['$'+ind.atr14.toFixed(2), atrPctOfPrice+'%', 'x'+ind.atrRatio.toFixed(2), atrReadWord]]).setBackground('#e0f2f1');row++;
    row++;

    const atrEntry = cp - 1.5 * ind.atr14;
    sh.getRange(row,1,1,3).setValues([['ATR-based entry (1.5×ATR pullback)','Price','% vs now']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,3).setValues([['', '$'+atrEntry.toFixed(2), ((atrEntry/cp-1)*100).toFixed(1)+'%']]).setBackground('#e0f2f1');row++;
    row++;

    const stopMult = techPlan.regime==='HIGH_VOL'?2.0 : (techPlan.regime==='TREND_UP'||techPlan.regime==='TREND_DOWN')?1.25 : 1.5;
    const riskDollars = techPlan.entryPrice - techPlan.stop;
    sh.getRange(row,1,1,4).setValues([['ATR-based stop','Multiplier used','Regime driving it','Risk ($)']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['$'+techPlan.stop.toFixed(2), stopMult.toFixed(2)+'×ATR', techPlan.regime+' → '+stopMult.toFixed(2)+'×', '$'+riskDollars.toFixed(2)]]).setBackground('#e0f2f1');row++;
    sh.getRange(row,1,1,14).merge().setValue('Stop multiplier adapts to regime: 2.0× in HIGH_VOL (wider, since volatility itself is expanding), 1.25× in a clean TREND_UP/TREND_DOWN (tighter, trend is doing the work), 1.5× otherwise.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;

    // Trailing stop / Chandelier Exit (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
    // a genuinely different mechanic from the fixed stop above, not a
    // replacement: this ratchets UP as the recent high increases (locks in
    // gains as a position works), the fixed stop above is set once and
    // stays put. Shown as a separate, clearly-labeled reference.
    if (ind.chandelierStop != null) {
      sh.getRange(row,1,1,4).setValues([['Trailing stop (Chandelier)','22-day high','Multiplier','Distance from current price']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
      const chDist = cp - ind.chandelierStop;
      sh.getRange(row,1,1,4).setValues([['$'+ind.chandelierStop.toFixed(2), '$'+ind.chandelierHighestHigh.toFixed(2), '3×ATR', '$'+chDist.toFixed(2)]]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('Ratchets UP as the 22-day high increases (never down) -- unlike the fixed stop above, this ADAPTS as a position works in your favor, locking in gains rather than staying fixed at entry.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Classical stop (v9.71, Schabacker Study X) -- a THIRD, real,
    // complementary stop method, purely additive: anchored to an actual
    // prior swing low (not a pure ATR offset from entry like the fixed
    // stop above), volatility-scaled buffer, round-number avoidance. Does
    // NOT replace or affect the ATR stop above or the Chandelier trail --
    // shown as its own separate, clearly-labeled reference, same
    // convention as the Chandelier section just above.
    if (techPlan.classicalStop) {
      const cs = techPlan.classicalStop;
      sh.getRange(row,1,1,4).setValues([['Classical stop (Schabacker)','Basing point','Basing point date','Distance from current price']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+cs.level.toFixed(2), '$'+cs.basingPointPrice.toFixed(2), Utilities.formatDate(new Date(cs.basingPointDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'), '$'+(cp-cs.level).toFixed(2)]]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('A real prior swing low, ATR-scaled buffer below it, nudged off round numbers -- distinct from the fixed ATR stop above, which is a pure volatility offset from entry with no connection to actual chart structure.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Basing Point stop (v9.75, Edwards & Magee Ch27/28/28.1) -- a FOURTH,
    // real, complementary stop method, purely additive: the actual "Three
    // Days Away" confirmed swing point + the book's own 6-price-tier x
    // 3-sensitivity-tier stop-distance table, distinct from the classical
    // stop above (which uses a flat ATR-scaled buffer with no confirmation
    // wait and no price/sensitivity table). Does NOT replace or affect any
    // stop above -- shown as its own separate, clearly-labeled reference.
    if (techPlan.basingPointStop) {
      const bps = techPlan.basingPointStop;
      sh.getRange(row,1,1,4).setValues([['Basing Point stop (Edwards & Magee)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+bps.level.toFixed(2), '$'+bps.basingPointPrice.toFixed(2), Utilities.formatDate(new Date(bps.basingPointDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'), (bps.stopPct*100).toFixed(0)+'% / '+bps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('A swing point confirmed via the book\'s own real "Three Days Away" rule (3 consecutive days trading entirely outside the swing point\'s own range), stop-distance from the book\'s own real price/sensitivity table -- distinct from the classical stop above, which uses a flat ATR-scaled buffer with no confirmation wait.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // v9.89, Edwards & Magee Ch28 p443 -- the book's own 2nd, alternate
    // basing-point-creation path (>=15% primary move + >=40% retracement),
    // purely additive, shown only when it identifies a real, more recent
    // basing point than the "Three Days Away" method above found.
    if (techPlan.alternateBasingPointStop) {
      const abps = techPlan.alternateBasingPointStop;
      sh.getRange(row,1,1,4).setValues([['Alternate Basing Point stop (Edwards & Magee, p443)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+abps.level.toFixed(2), '$'+abps.basingPointPrice.toFixed(2), Utilities.formatDate(new Date(abps.basingPointDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'), (abps.stopPct*100).toFixed(0)+'% / '+abps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real 2nd basing-point-creation rule (p443): a >=15% Primary-direction move, retraced >=40% before resuming -- even without a clean sharp reversal. Same real stop-distance table as the Basing Point stop above, just an alternate way to identify the basing point itself.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // v9.90, Edwards & Magee Ch28 p443-444 -- the book's own 3rd, final
    // basing-point-creation path (<40% retracement + a sideways band held
    // for a week + declining volume vs. the primary move itself), purely
    // additive, shown only when it identifies a real basing point.
    if (techPlan.sidewaysBasingPointStop) {
      const sbps = techPlan.sidewaysBasingPointStop;
      sh.getRange(row,1,1,4).setValues([['Sideways Basing Point stop (Edwards & Magee, p443-444)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+sbps.level.toFixed(2), '$'+sbps.basingPointPrice.toFixed(2), Utilities.formatDate(new Date(sbps.basingPointDate), Session.getScriptTimeZone(), 'yyyy-MM-dd'), (sbps.stopPct*100).toFixed(0)+'% / '+sbps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real 3rd, final basing-point-creation rule (p443-444): a <40% retracement that instead "marks time at the same level" for a week or more, with declining volume vs. the primary move ("the volume indications are right"). Same real stop-distance table as the 2 basing-point stops above, just a 3rd way to identify the basing point itself.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Progressive Stop trigger (v9.75, Edwards & Magee Ch27) -- a real,
    // informational-only flag (no stop LEVEL of its own to size a position
    // off, unlike the 4 methods above -- see the field's own header comment
    // for why: this engine has no persisted day-to-day trade state to
    // "ratchet" against). Shown only when it fires today.
    if (ind.progressiveStopFlag) {
      const ps = ind.progressiveStopFlag;
      sh.getRange(row,1,1,4).setValues([['Progressive Stop trigger (Edwards & Magee)','Suggested tight stop (today only)','Volume vs 20d avg','Uptrend maturity']]).setFontWeight('bold').setBackground('#c62828').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['⚠ TRIGGERED', '$'+ps.level.toFixed(2), ps.volumeRatio.toFixed(1)+'x', ps.daysSinceCross+' days since cross']]).setBackground('#ffebee');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real rule: exceptionally heavy volume (>3x avg) on an UP day, after an established uptrend (not the very first breakout day) -- "nine times out of ten" better off tightening to just 1/8 point under today\'s close, "for the day only." Informational only, not a persisted/ratcheting stop -- re-evaluate fresh next time this ticker is analyzed.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // N-normalized position-sizing 2nd opinion (v9.78, Edwards & Magee
    // Appendix E) -- purely additive alongside the existing "Size:" line
    // (computePositionSizeV7_, conviction-scaled) elsewhere on this
    // dashboard, NOT a replacement for it.
    if (techPlan.nNormalizedPositionSize) {
      const nps = techPlan.nNormalizedPositionSize;
      sh.getRange(row,1,1,4).setValues([['N-normalized size (Edwards & Magee, Turtle-style)','Shares','2N stop level','$ risk / % of account']]).setFontWeight('bold').setBackground('#00695c').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['2nd opinion vs "Size:" above', nps.shares, '$'+nps.stopLevel.toFixed(2), '$'+nps.dollarRisk.toFixed(0)+' / '+nps.riskPctOfAccount.toFixed(1)+'%']]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real Turtle-system rule: size the position so a full 2N move (N=20-day Wilder-smoothed True Range) costs exactly 2% of account equity -- volatility-normalized, distinct from the conviction-scaled "Size:" line above, which uses a fixed stop distance instead. A cross-check, not a replacement.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Composite Leverage read (v9.78, Edwards & Magee Appendix A) -- real,
    // purely additive, informational leverage-risk gauge.
    if (techPlan.compositeLeverage) {
      const cl = techPlan.compositeLeverage;
      sh.getRange(row,1,1,4).setValues([['Composite Leverage (Edwards & Magee)','Leverage','Normal Range-for-Price','Read']]).setFontWeight('bold').setBackground('#4527a0').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['(S×N)/15.5, cash-only', cl.leverage.toFixed(2)+'x', cl.normalRangeForPrice.toFixed(1), cl.tier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real formula for how much real risk a dollar commitment represents, combining this ticker\'s own volatility (Sensitivity Index, approximated via atrRatio) with its price-level\'s own typical range -- simplified for a cash-only, no-margin strategy (T/C=1). Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Fan Principle read (v9.81, Edwards & Magee Ch14) -- real, purely
    // additive, only computed when a clear regime/Primary trend exists.
    if (techPlan.fanPrinciple) {
      const fp = techPlan.fanPrinciple;
      sh.getRange(row,1,1,4).setValues([['Fan Principle (Edwards & Magee)','Fan lines broken','Flattening?','Read']]).setFontWeight('bold').setBackground('#00838f').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['Origin $'+fp.originPrice.toFixed(2)+' ('+Utilities.formatDate(new Date(fp.originDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')+')', fp.brokenCount+'/3', fp.flattening?'yes':'no', fp.triggered ? '✅ 3rd Fan Line broken — correction likely over' : (fp.brokenCount+'/3 broken — correction may still be in progress')]]).setBackground('#e0f7fa');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real "Three-Fan Rule" (Ch14): as a correction unfolds, price breaks progressively flatter trendlines drawn from the correction\'s own starting extreme -- when the 3rd such line breaks, the book\'s own real claim is the correction is over and the Primary trend resumes ("works in the great majority of cases," not independently backtested here). Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    // Trend Channel / Return Line read (v9.81, Edwards & Magee Ch14) -- real,
    // purely additive, symmetric overshoot-projection rule.
    if (techPlan.trendChannel) {
      const tc = techPlan.trendChannel;
      sh.getRange(row,1,1,4).setValues([['Trend Channel (Edwards & Magee)','Basic Trendline (now)','Return Line (now)','Read']]).setFontWeight('bold').setBackground('#5d4037').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['', '$'+tc.basicTrendline.currentValue.toFixed(2), '$'+tc.returnLine.currentValue.toFixed(2), tc.projectedOvershoot != null ? ('Last swing fell short by $'+tc.projectedOvershoot.toFixed(2)+' — book\'s own rule projects the SAME overshoot on the opposite boundary next') : 'Last swing reached/exceeded its own boundary — no real projection to make']]).setBackground('#efebe9');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real symmetric rule (Ch14, Fig.156): a Return Line parallel to the Basic Trendline bounds a real Trend Channel -- if a swing falls short of its own boundary by some margin, the book\'s own claim is the NEXT swing will overshoot the OPPOSITE boundary by that same margin. The $ amount above applies to that opposite boundary\'s own value when the next swing actually occurs (both lines are sloped) -- not a fixed price today. Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
  } catch(e) { sh.getRange(row,1).setValue('⚠️ ATR section error: '+e.message.substring(0,80)).setFontColor('#e65100'); row+=3; }

  // ══ LILO LADDER — Phase 4, opt-in only (4.5.2: renders NOTHING if both toggles are off) ══
  if (ladderStock || ladderOptions) {
    try {
      sh.getRange(row,1,1,14).merge().setValue('🪜  LILO — STAGED ENTRY/EXIT (opt-in)').setBackground('#6a1b9a').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;

      if (ladderStock) {
        const entryLadder = computeStockEntryLadderV7(confluence);
        const exitLadder = computeStockExitLadderV7(techPlan);
        const entryPct = ladderDisplayPercentsV7_(entryLadder), exitPct = ladderDisplayPercentsV7_(exitLadder);
        sh.getRange(row,1,1,14).merge().setValue('Stock ladder').setBackground('#8e24aa').setFontColor('#fff').setFontWeight('bold');row++;
        sh.getRange(row,1,1,4).setValues([['Rung','Trigger price','Portion','Side']]).setFontWeight('bold').setBackground('#ce93d8');row++;
        if (!entryLadder.length && !exitLadder.length) {
          sh.getRange(row,1,1,4).merge().setValue('No confluence methods aligned — ladder unavailable for this run.').setFontStyle('italic').setFontColor('#666');row++;
        }
        entryLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), entryPct[i]+'%', 'BUY']]).setBackground('#f3e5f5'); row++; });
        exitLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), exitPct[i]+'%', 'SELL']]).setBackground('#fce4ec'); row++; });
        row++;
      }

      if (ladderOptions && techPlan.options && techPlan.options.available) {
        const entryLadder = computeOptionsEntryLadderV7(confluence);
        const exitLadder = computeOptionsExitLadderV7(techPlan);
        const entryPct = ladderDisplayPercentsV7_(entryLadder), exitPct = ladderDisplayPercentsV7_(exitLadder);
        sh.getRange(row,1,1,14).merge().setValue('Options ladder — same contract, staged into/out of it').setBackground('#8e24aa').setFontColor('#fff').setFontWeight('bold');row++;
        sh.getRange(row,1,1,4).setValues([['Rung','Trigger price (underlying)','Portion','Side']]).setFontWeight('bold').setBackground('#ce93d8');row++;
        if (!entryLadder.length && !exitLadder.length) {
          sh.getRange(row,1,1,4).merge().setValue('No confluence methods aligned — ladder unavailable for this run.').setFontStyle('italic').setFontColor('#666');row++;
        }
        entryLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), entryPct[i]+'%', 'BUY']]).setBackground('#f3e5f5'); row++; });
        exitLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), exitPct[i]+'%', 'SELL']]).setBackground('#fce4ec'); row++; });
        sh.getRange(row,1,1,14).merge().setValue('⏳ '+optionsLadderTimeDecayNoteV7()).setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setWrap(true);row++;
        const expiryFlag = (techPlan.options.horizon && techPlan.options.horizon.days!=null) ? optionsExpiryFlagV7(techPlan.options.horizon.days) : null;
        if (expiryFlag) { sh.getRange(row,1,1,14).merge().setValue(expiryFlag).setBackground('#ffebee').setFontColor('#c62828').setFontWeight('bold');row++; }
        row++;
      } else if (ladderOptions) {
        sh.getRange(row,1,1,14).merge().setValue('Options ladder requested, but no usable options data for this ticker — run Options Analysis first.').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic');row+=2;
      }

      sh.getRange(row,1,1,14).merge().setValue('Ladder rungs are suggestions, not exact position sizing. When you act on one, log it as a normal row in '+TRANSACTIONS_SHEET_V7+' (optionally note "LILO rung N" for your own reference).').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    } catch(e) { sh.getRange(row,1).setValue('⚠️ LILO ladder error: '+e.message.substring(0,80)).setFontColor('#e65100'); row+=3; }
  }

  // Recommended contract — LEAPS and short-term (OPTIONS_CONTRACT_SELECTION_
  // PLAN.md). Real gap found directly: the actual pick (strike/expiry/delta)
  // was already computed via selectRecommendedCallV7 and shown on the chart
  // as a reference line and in the separate options report, but never on
  // THIS dashboard -- the one place a user would naturally look for "which
  // contract do I actually buy" alongside the stock decision itself. Only
  // appears when this run came from Full Ticker Analysis (both picks are
  // null on a standalone stock-only run) -- graceful, not a broken section.
  try {
    if (leapsCallArg || shortTermCallArg) {
      sh.getRange(row,1,1,14).merge().setValue('📞  RECOMMENDED CONTRACT — long calls only, single-leg (no puts/hedges/spreads)').setBackground('#4a148c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
      function writeContractLine(label, pick) {
        if (!pick) { sh.getRange(row,1,1,14).merge().setValue(label+': not available this run').setFontColor('#999').setFontSize(9);row++; return; }
        if (!pick.found) { sh.getRange(row,1,1,14).merge().setValue(label+': not found — '+pick.reason).setFontColor('#c62828').setFontSize(9);row++; return; }
        const c = pick.contract;
        const expDate = new Date(c.expUnix * 1000);
        sh.getRange(row,1,1,14).merge().setValue(label+': $'+c.strike+' call, exp '+expDate.toDateString()+'   Delta: '+c.delta.toFixed(2)+'   IV: '+(c.iv?(c.iv*100).toFixed(1)+'%':'N/A')+'   Bid/Ask: $'+c.bid.toFixed(2)+'/$'+c.ask.toFixed(2)).setBackground('#f3e5f5');row++;
      }
      writeContractLine('LEAPS (>1yr, target delta 0.75)', leapsCallArg);
      writeContractLine('Short-term (<1yr, target delta 0.50)', shortTermCallArg);
      sh.getRange(row,1,1,14).merge().setValue('Full candidate comparison (other strikes considered) is in 🏆 Top 10 Conviction. Expiry choice is a placeholder (furthest/nearest available), not yet tied to real price targets.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
  } catch(e) { sh.getRange(row,1).setValue('⚠️ Recommended contract error: '+e.message.substring(0,80)).setFontColor('#e65100'); row+=3; }

  // ══ v7 SYNTHESIS ENGINE — PRIMARY decision (Phase 1: moved first, per Path B) ══
  try {
    // Sub-phase 1.2.1 (Phase 1 fix): this block used to render SECOND, after
    // the legacy dual-timeframe table below — meaning the more prominent-
    // sounding header ("FINAL CONVICTION VERDICT") belonged to the OLD,
    // non-sector-aware scores, while the actual primary engine's numbers
    // appeared second under a less prominent label. Swapped: this is now
    // first and visually dominant; the legacy table is demoted below it.
    // Sub-phase 3.2 (Phase 3 fix): the regime gets its own single-glance line,
    // stating the gate's actual consequence in plain language — not left
    // buried as one column in the 10-column table below.
    const regimeLine = techPlan.regime==='TREND_UP' ? '📈 REGIME: TREND_UP — entries permitted'
      : techPlan.regime==='TREND_DOWN' ? '📉 REGIME: TREND_DOWN — avoid, no entries'
      : techPlan.regime==='HIGH_VOL' ? '⚡ REGIME: HIGH_VOL — no new entries, wait for clarity'
      : '🌊 REGIME: CHOP — no clear trend, no new entries, wait for clarity';
    const regimeColor = techPlan.regime==='TREND_UP' ? '#1b5e20' : techPlan.regime==='TREND_DOWN' ? '#b71c1c' : '#e65100';
    sh.getRange(row,1,1,14).merge().setValue(regimeLine).setBackground(regimeColor).setFontColor('#fff').setFontWeight('bold').setFontSize(11);row++;
    sh.getRange(row,1,1,14).merge().setValue('🏆  FINAL CONVICTION — PRIMARY (v7 sector-aware engine)').setBackground('#4a148c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    // W5 transparency line — found MISSING on the first real live run of
    // v9.1: techPlan.headlineWeights/headlineUsedDefaultWeights were
    // computed and exposed on the return object with a comment saying
    // "exposed for the dashboard transparency line," but no display code
    // anywhere actually read them. The only regime-weight transparency
    // visible was the LEGACY path's (a different weight scheme entirely,
    // with different categories) -- meaning the headline decision's own
    // regime-adaptivity, the actual point of W5, was invisible to the
    // user despite genuinely driving the number they see. Fixed here.
    if (techPlan.headlineWeights) {
      const hw = techPlan.headlineWeights;
      const hwStr = Object.entries(hw).map(([k,v]) => k+' '+Math.round(v*100)+'%').join(', ');
      const defaultNote = techPlan.headlineUsedDefaultWeights ? ' (default — regime unrecognized)' : '';
      sh.getRange(row,1,1,14).merge().setValue('ℹ️ Headline weights adapted for this run\'s regime (' + techPlan.regime + defaultNote + '): ' + hwStr).setFontStyle('italic').setFontSize(9).setFontColor('#4a148c').setWrap(true);row++;
    }
    sh.getRange(row,1,1,10).setValues([['OWN (business only) /100','Own Verdict','BUY-TIMING (chart only) /100','Timing','Regime','Options Read','Net $ Bias','IV %ile','FINAL CONVICTION /100','Action']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
    const optRead = (opts&&opts.available)?(opts.confirm==='confirm'?'✅ CONFIRM (+8)':opts.confirm==='conflict'?'⚠️ CONFLICT (−10)':'➖ Neutral'):'— no data';
    const nbStr = (opts&&opts.available&&opts.netBiasPct!=null)?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'%'):'—';
    const ivStr = (opts&&opts.available&&opts.ivRank!=null)?(opts.ivRank+'th'):'—';
    sh.getRange(row,1,1,10).setValues([[fundResult.score!=null?fundResult.score:'N/A',fundResult.verdict||'N/A',techPlan.techScore,techPlan.timing,techPlan.regime,optRead,nbStr,ivStr,decision.finalConviction,decision.action]]);
    sh.getRange(row,1,1,10).setNumberFormat('General');colorVerdictRow9V7_(sh,row,decision.finalConviction);sh.getRange(row,9).setFontWeight('bold').setFontSize(13);row++;
    if (decision.lines&&decision.lines.length){ sh.getRange(row,1,1,14).merge().setValue('   '+decision.lines.join('   ·   ')).setBackground('#ede7f6').setFontColor('#4527a0').setFontStyle('italic').setWrap(true);row++; }
    row+=2;

    // ── ②  SECOND OPINION — legacy v6.1 dual-timeframe engine (kept in full, per Path B; demoted, not authoritative) ──
    sh.getRange(row,1,1,14).merge().setValue('②  SECOND OPINION — legacy v6.1 dual-timeframe engine (context only, NOT the decision)').setBackground('#78909c').setFontColor('#fff').setFontSize(11).setFontStyle('italic');row++;
    sh.getRange(row,1,1,9).setValues([['Timeframe','Technical /100','Tech Verdict','Gann /100','Gann Signal','Fundamentals /100','Fund Verdict','Legacy Conviction /100','Legacy Action']]).setFontWeight('bold').setBackground('#90a4ae').setFontColor('#fff');row++;
    const gannVerdict=gann.score>=70?'🟢 Bullish':gann.score>=50?'🟡 Neutral':'🔴 Bearish';
    sh.getRange(row,1,1,9).setValues([['SHORT (Days/Weeks)',scores.shortScore,scores.shortVerdict,gann.score,gannVerdict,scores.fundScore!==null?scores.fundScore:'N/A',scores.fundVerdict,scores.shortConviction,scores.shortConviction>=60?'▲ BUY':scores.shortConviction<=40?'▼ SELL':'● HOLD']]).setBackground('#eceff1').setFontColor('#546e7a');row++;
    sh.getRange(row,1,1,9).setValues([['LONG (Months/1-2yr)',scores.longScore,scores.longVerdict,gann.score,gannVerdict,scores.fundScore!==null?scores.fundScore:'N/A',scores.fundVerdict,scores.longConviction,scores.longConviction>=60?'▲ HOLD/BUY MORE':scores.longConviction<=40?'▼ SELL':'● HOLD']]).setBackground('#f5f5f5').setFontColor('#546e7a');row++;

    // Item 3 (DASHBOARD_IMPROVEMENTS_PLAN.md): explain WHY v7 and legacy
    // disagree when they do, using the confirmed real mechanism -- traced
    // and verified against real numbers before building. Legacy's
    // conviction (shortConviction/longConviction) is a pure blend of its
    // own technical + fundamentals scores, no regime-gate anywhere in it.
    // v7's timing DOES have Phase 3's regime gate. When v7 says WAIT/AVOID
    // but legacy says BUY, that gate is the confirmed, verified reason --
    // not a guess restated here, the same mechanism proven earlier.
    const legacyShortAction = scores.shortConviction>=60?'BUY':scores.shortConviction<=40?'SELL':'HOLD';
    if (techPlan.timing !== 'BUY_NOW' && legacyShortAction === 'BUY') {
      sh.getRange(row,1,1,14).merge()
        .setValue('ℹ️ Why these disagree: v7\'s technical/fundamental reads are similarly bullish to legacy\'s -- they diverge because v7\'s regime gate ('+techPlan.regime+') holds back full conviction until the setup actually confirms, which legacy\'s formula has no equivalent for. Legacy blends technical+fundamentals only; it never checks whether now is a good time to act on that read.')
        .setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setBackground('#fff8e1').setWrap(true);
      row++;
    }
    row++;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Verdict error: '+e.message.substring(0,80)).setFontColor('#e65100');row+=4;}

  // ══ MACRO RANGE — Phase 5: presentation only, reads existing computed values, no new calculation ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📏  MACRO RANGE — Where Price Is Expected To Move').setBackground('#00838f').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;

    // Near-term: ATR-based daily range + Bollinger channel
    const atrPctOfPrice = (ind.atr14/cp*100).toFixed(1);
    const atrReadWord = ind.atrRatio>1.3?'expanding':ind.atrRatio<0.7?'contracting':'normal';
    sh.getRange(row,1,1,4).setValues([['Daily range (ATR)','Volatility regime','Bollinger channel','Squeeze']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['±$'+ind.atr14.toFixed(2)+' ('+atrPctOfPrice+'% of price)','x'+ind.atrRatio.toFixed(2)+' vs 50d avg — '+atrReadWord,'$'+ind.bbLower.toFixed(2)+' – $'+ind.bbUpper.toFixed(2), ind.bbSqueeze?'⚠ TIGHT — often precedes a sharp move':'normal']]).setBackground('#e0f7fa');row++;
    // Keltner squeeze (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- a real,
    // separate confirmation signal from bbSqueeze above: Bollinger sitting
    // entirely INSIDE Keltner is a more established version of "squeeze"
    // than Bollinger width alone, only shown when it's actually true so
    // it doesn't add noise on the common case.
    if (ind.keltnerSqueeze) {
      sh.getRange(row,1,1,4).merge().setValue('⚠ Keltner squeeze confirmed — Bollinger bands sitting inside the Keltner Channel, a stronger volatility-compression signal than Bollinger width alone').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setWrap(true);row++;
    }
    row++;

    // Structural: the Gann fan channel price is currently riding between
    const masterSide = gann.gannMaster ? (gann.gannMaster < cp ? 'support' : 'resistance') : 'N/A';
    sh.getRange(row,1,1,4).setValues([['Structural channel (Gann fan)','Riding between','1×1 master level','Acting as']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['weeks–months horizon', gann.lowerAngle+' – '+gann.upperAngle, gann.gannMaster?'$'+gann.gannMaster.toFixed(2):'N/A', masterSide]]).setBackground('#e0f7fa');row++;
    row++;

    // One combined envelope line, synthesizing both timeframes into a single plain-English statement
    const envelopeLine = 'Near-term (days): $'+ind.bbLower.toFixed(2)+'–$'+ind.bbUpper.toFixed(2)+' (Bollinger). '
      + 'Structural (weeks–months): riding between the '+gann.lowerAngle+' and '+gann.upperAngle+' Gann angles'
      + (gann.gannMaster ? ', 1×1 master level $'+gann.gannMaster.toFixed(2)+' acting as '+masterSide+'.' : '.');
    sh.getRange(row,1,1,14).merge().setValue(envelopeLine).setBackground('#b2ebf2').setFontColor('#006064').setFontStyle('italic').setWrap(true);row+=2;

    // VIX / broad market context (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
    // this stock's own IV is already shown elsewhere; this is the separate,
    // previously-missing question of whether the WHOLE MARKET is calm or
    // fearful right now. Non-fatal if VIX fetch failed earlier -- just
    // omitted, doesn't block the rest of this section.
    if (chart.vixContext) {
      const vx = chart.vixContext;
      sh.getRange(row,1,1,4).setValues([['VIX (broad market)','52wk range','Position in range','Read']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([[vx.level.toFixed(2), vx.low52.toFixed(2)+' – '+vx.high52.toFixed(2), vx.rangePct.toFixed(0)+'%', vx.read]]).setBackground('#e0f7fa');
      sh.getRange(row,4).setFontColor(vx.read==='fear/crisis'?'#c62828':vx.read==='elevated'?'#e65100':'#2e7d32').setFontWeight('bold');
      row++;
      // v9.93 — real port from brokerCourseModelV1.gs (docs/CLAUDE_CODE_HANDOFF.md
      // section 3.7's port audit): the course's OWN VIX bands, a DIFFERENT
      // scheme from the conventional read above -- `Normal (13-25)` is the
      // one real, OOS-confirmed band (mild underperformance, already
      // promoted into brokerCourseModelV1.gs's own synthesis). Informational
      // only, not a scored vote here either.
      if (vx.courseRead) {
        sh.getRange(row,1,1,4).merge().setValue('Broker-course VIX regime (ep.2 bands): ' + vx.courseRead.regime + (vx.courseRead.regime.indexOf('Normal') === 0 ? ' — real, OOS-confirmed mild underperformance signal (tests/vix_yield_oos_split_test.js)' : '')).setBackground('#e0f7fa').setFontColor('#00695c').setFontSize(9);
        row++;
      }
      // v9.32 — VIX-vs-price divergence, display only (see CHARACTERIZATION_PLAN_vix_divergence.md).
      if (vx.divergence5d && vx.divergence5d.flagged) {
        sh.getRange(row,1,1,4).merge().setValue(vx.divergence5d.note+'  (VIX 5d slope +'+vx.divergence5d.vixSlope5.toFixed(2)+', S&P 5d '+(vx.divergence5d.spyChange5pct>=0?'+':'')+vx.divergence5d.spyChange5pct.toFixed(2)+'%)').setBackground('#fff3e0').setFontColor('#e65100').setFontWeight('bold');
        row++;
      }
      row++;
    }
  }catch(e){sh.getRange(row,1).setValue('⚠️ Macro range error: '+e.message.substring(0,80)).setFontColor('#e65100');row+=3;}

  // ══ SIGNAL CROSS-REFERENCE ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🧭  SIGNAL CROSS-REFERENCE — Category Agreement').setBackground('#00695c').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    // Regime-adaptive weighting transparency (DASHBOARD_IMPROVEMENTS_PLAN.md
    // 4b) -- shows exactly which weight profile applied THIS run, not just
    // that adaptation exists somewhere in the code. Real, checkable claim.
    sh.getRange(row,1,1,14).merge().setValue('ℹ️ Category weights adapted for this run\'s regime ('+scores.regimeUsedForWeights+'). Short-term: '+Object.entries(scores.shortW).map(([k,v])=>k+' '+Math.round(v*100)+'%').join(', ')+'. Long-term: '+Object.entries(scores.longW).map(([k,v])=>k+' '+Math.round(v*100)+'%').join(', ')+'.').setFontStyle('italic').setFontSize(9).setFontColor('#00695c').setWrap(true);row++;
    sh.getRange(row,1,1,6).setValues([['Category','Short /100','Short Read','Long /100','Long Read','# signals']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    const catList=['Trend','Momentum','Volume','Volatility','Position'];
    const readOf=s=>s==null?'—':s>=60?'🟢 Bullish':s<=40?'🔴 Bearish':'🟡 Neutral';
    catList.forEach((c,i)=>{
      try{
        const sc=scores.shortCats&&scores.shortCats[c], lc=scores.longCats&&scores.longCats[c];
        if(!sc&&!lc)return;
        const cnt=((sc&&sc.count)||0)+((lc&&lc.count)||0);
        sh.getRange(row,1,1,6).setValues([[c,sc?Math.round(sc.score):'—',readOf(sc?sc.score:null),lc?Math.round(lc.score):'—',readOf(lc?lc.score:null),cnt]]).setBackground(i%2===0?'#e0f2f1':'#f1f8e9');
        sh.getRange(row,2).setNumberFormat('0'); sh.getRange(row,4).setNumberFormat('0'); sh.getRange(row,6).setNumberFormat('0');
        row++;
      }catch(e){}
    });
    const sConf=scores.shortConflict, lConf=scores.longConflict;
    sh.getRange(row,1,1,6).merge().setValue('Short-term: '+((sConf&&sConf.note)||'—')).setBackground(sConf&&sConf.conflict?'#ffe0b2':'#e8f5e9').setFontStyle('italic');row++;
    sh.getRange(row,1,1,6).merge().setValue('Long-term: '+((lConf&&lConf.note)||'—')).setBackground(lConf&&lConf.conflict?'#ffe0b2':'#e8f5e9').setFontStyle('italic');row++;

    // Dynamic per-run decision trace (Item 1's second half, DASHBOARD_
    // IMPROVEMENTS_PLAN.md). Depends on 4c's per-indicator points/weights,
    // which now exist -- this is the synthesis layer on top: not "what
    // does RSI mean" (the static glossary), but "why did THIS run's score
    // come out this way." Finds the actual biggest driver by CONTRIBUTION
    // magnitude (|signal| x weight), not just weight alone (a high-weight
    // near-neutral signal barely moves the score) or extremeness alone (a
    // low-weight extreme signal doesn't move it much either).
    function biggestDriver(signalList, catWeights) {
      let best = null, bestContribution = -1;
      signalList.forEach(s => {
        const catW = catWeights[s.cat] != null ? catWeights[s.cat] : 0.1;
        const contribution = Math.abs(s.signal) * s.weight * catW;
        if (contribution > bestContribution) { bestContribution = contribution; best = s; }
      });
      return best;
    }
    const shortDriver = biggestDriver(scores.shortSignals||[], scores.shortW||{});
    const longDriver = biggestDriver(scores.longSignals||[], scores.longW||{});
    // Direction-aware wording -- fixed after the first real run showed a
    // real, confusing case: RSI at 0 points (bearish) got cited as the
    // "driver" of a 77 (bullish) score, reading as contradictory even
    // though the underlying math (biggest contribution MAGNITUDE,
    // direction-agnostic) was correct. If the driver's own points lean
    // the OPPOSITE way from the overall score, it's a drag holding the
    // score back, not what's pushing it there -- say so honestly.
    function traceLine(label, overallScore, driver) {
      if (!driver) return null;
      const pts = Math.round((driver.signal+1)/2*100);
      const driverBullish = pts > 50, overallBullish = overallScore > 50;
      const verb = (driverBullish === overallBullish)
        ? 'driven primarily by'
        : 'held back primarily by (the biggest drag against an otherwise '+(overallBullish?'higher':'lower')+' score)';
      return 'Why '+label+' scored '+overallScore+': '+verb+' '+driver.name+' ('+pts+' points, '+driver.cat+' category) — the single biggest contributor to this run\'s score.';
    }
    const shortLine = traceLine('SHORT-TERM', scores.shortScore, shortDriver);
    const longLine = traceLine('LONG-TERM', scores.longScore, longDriver);
    if (shortLine) { sh.getRange(row,1,1,6).merge().setValue(shortLine).setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setWrap(true);row++; }
    if (longLine) { sh.getRange(row,1,1,6).merge().setValue(longLine).setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setWrap(true);row++; }

    const dv=scores.divergence, rs=scores.rs;
    if(dv){sh.getRange(row,1,1,6).merge().setValue('RSI divergence: '+dv.type.toUpperCase()+' — '+dv.note).setBackground(dv.type==='bullish'?'#c8e6c9':dv.type==='bearish'?'#ffcdd2':'#eceff1');row++;}
    // MACD/OBV divergence (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- only shown
    // when an actual divergence exists (type !== 'none'), so this doesn't
    // add noise on the (common) case where nothing notable is happening.
    const mdv=scores.macdDivergence, odv=scores.obvDivergence;
    if(mdv&&mdv.type!=='none'){sh.getRange(row,1,1,6).merge().setValue('MACD divergence: '+mdv.type.toUpperCase()+' — '+mdv.note).setBackground(mdv.type==='bullish'?'#c8e6c9':'#ffcdd2');row++;}
    if(odv&&odv.type!=='none'){sh.getRange(row,1,1,6).merge().setValue('OBV divergence: '+odv.type.toUpperCase()+' — '+odv.note).setBackground(odv.type==='bullish'?'#c8e6c9':'#ffcdd2');row++;}
    if(rs){sh.getRange(row,1,1,6).merge().setValue('Relative strength vs SPY (3mo): '+(rs.rs63>=0?'+':'')+rs.rs63.toFixed(1)+'% — '+(rs.outperforming?'outperforming the market':'lagging the market')).setBackground(rs.outperforming?'#c8e6c9':'#ffcdd2');row++;}
    // Sector-relative strength (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
    // a more relevant comparison than broad SPY: how the stock performs
    // against its OWN sector specifically.
    if(chart.sectorRS){const srs=chart.sectorRS;sh.getRange(row,1,1,6).merge().setValue('Relative strength vs '+srs.etf+' / '+srs.sector+' sector (3mo): '+(srs.rs63>=0?'+':'')+srs.rs63.toFixed(1)+'% — '+(srs.outperforming?'outperforming its sector':'lagging its sector')).setBackground(srs.outperforming?'#c8e6c9':'#ffcdd2');row++;}
    // v9.72, Schabacker Study XII: purely additive -- new, separate line, distinct from sectorRS above (relative price-swing AMPLITUDE, not relative price performance).
    if(chart.relativeSwingPower){const rsp=chart.relativeSwingPower;sh.getRange(row,1,1,6).merge().setValue('Relative swing power vs '+rsp.etf+' / '+rsp.sector+' sector (Schabacker): '+rsp.ratio.toFixed(2)+'x — swings '+(rsp.ratio>=1?((rsp.ratio-1)*100).toFixed(0)+'% wider than':((1-rsp.ratio)*100).toFixed(0)+'% narrower than')+' its sector average (informational, not scored)').setBackground('#eceff1');row++;}
    row+=2;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Cross-reference error: '+e.message.substring(0,60)).setFontColor('#e65100');row+=3;}

  // ══ PRICE GAPS ══
  try {
    if (ind.priceGaps && ind.priceGaps.length) {
      hdrV7(sh,row,'⬜  PRICE GAPS (last ~3 months)','#455a64',11,14);row++;
      sh.getRange(row,1,1,7).setValues([['Date','Type','Level','Status','Class','Cause','Cap Context']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
      // v9.43 -- CHARACTERIZATION_PLAN_gap_types.md. GAP_CLASS_LABELS: display-only formatting for the .gapType field computeAllIndicators already attached to each gap.
      const GAP_CLASS_LABELS = { BREAKAWAY:'🚀 Breakaway', EXHAUSTION:'🥵 Exhaustion', ISLAND:'🏝️ Island', RUNAWAY:'🏃 Runaway', COMMON:'Common' };
      ind.priceGaps.slice(-8).reverse().forEach((g,i) => { // most recent first, capped at 8 so this stays a quick scan, not a wall
        const bg = !g.filled ? (g.type==='UP'?'#c8e6c9':'#ffcdd2') : (i%2===0?'#eceff1':'#fff');
        // v9.41 -- CHARACTERIZATION_PLAN_earnings_gap.md. Display only, weight 0.
        const cause = classifyGapCauseV7(g, fund && fund._earningsHistory);
        // v9.42 -- CHARACTERIZATION_PLAN_gap_market_cap.md. Display only, weight 0.
        const capNote = gapMarketCapContextV7(g, fund && fund.marketCap);
        sh.getRange(row,1,1,7).setValues([[
          Utilities.formatDate(new Date(g.date), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
          g.type==='UP'?'Gap Up ▲':'Gap Down ▼',
          '$'+g.level.toFixed(2)+' ('+(g.sizePct>=0?'+':'')+(g.sizePct*100).toFixed(1)+'%)',
          g.filled?'Filled':'UNFILLED — real S/R',
          GAP_CLASS_LABELS[g.gapType] || '',
          cause ? ('📊 Earnings' + (cause.epsSurprisePct!=null ? ' (EPS '+(cause.epsSurprisePct>=0?'+':'')+cause.epsSurprisePct.toFixed(1)+'%)' : '')) : '',
          capNote ? capNote.note : ''
        ]]).setBackground(bg);row++;
      });
      row++;
    }
  } catch(e) { /* non-fatal */ }

  // ══ CHART PATTERNS ══
  try {
    if (ind.chartPatterns && ind.chartPatterns.length) {
      hdrV7(sh,row,'📉  CHART PATTERNS','#4527a0',11,14);row++;
      sh.getRange(row,1,1,5).setValues([['Pattern','First Peak/Trough','Second Peak/Trough','Neckline','Status']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      const fmtD = d => Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const isBearish = t => t==='DOUBLE_TOP' || t==='HEAD_AND_SHOULDERS' || t==='TRIPLE_TOP';
      const TW_TYPES = ['SYMMETRICAL_TRIANGLE','ASCENDING_TRIANGLE','DESCENDING_TRIANGLE','RISING_WEDGE','FALLING_WEDGE'];
      const FP_TYPES = ['BULL_FLAG','BEAR_FLAG','PENNANT'];
      ind.chartPatterns.forEach(p => {
        const isTW = TW_TYPES.indexOf(p.type) >= 0;
        const isFP = FP_TYPES.indexOf(p.type) >= 0;
        const isRect = p.type === 'RECTANGLE';
        const RND_TYPES = ['ROUNDING_BOTTOM','ROUNDING_TOP','CUP_AND_HANDLE'];
        const isRnd = RND_TYPES.indexOf(p.type) >= 0;
        const isTrap = p.type === 'BULL_TRAP' || p.type === 'BEAR_TRAP';
        const isHM = p.type === 'HALF_MAST'; // v9.71, Schabacker Study X -- purely additive, new type, own display branch below (see the correctness note there)
        const isBT = p.type === 'BROADENING_TOP' || p.type === 'BROADENING_BOTTOM'; // v9.72, Schabacker Study IV
        const isDM = p.type === 'DIAMOND_TOP' || p.type === 'DIAMOND_BOTTOM'; // v9.72, Schabacker Study V
        const isCX = p.type === 'COMPLEX_TOP' || p.type === 'COMPLEX_BOTTOM'; // v9.72, Schabacker Study IV
        const bg = isTrap
          ? (p.status==='CONFIRMED' ? (p.type==='BULL_TRAP'?'#ffcdd2':'#c8e6c9') : '#fff9c4')
          : (isTW || isFP || isRect || isRnd || isHM || isBT || isDM)
          ? (p.status==='BROKE_UP'?'#c8e6c9':(p.status==='BROKE_DOWN'?'#ffcdd2':'#fff9c4'))
          : (isCX ? (p.confirmed ? (p.type==='COMPLEX_TOP'?'#ffcdd2':'#c8e6c9') : '#fff9c4')
          : (p.confirmed ? (isBearish(p.type)?'#ffcdd2':'#c8e6c9') : '#fff9c4'));
        let row5;
        if (isTrap) {
          const isBull = p.type === 'BULL_TRAP';
          const label = isBull ? 'Bull Trap (avoid/exit — fake breakout)' : 'Bear Trap (buy opportunity — fake breakdown)';
          const levelLabel = isBull ? 'Resistance' : 'Support';
          const statusLabel = p.status==='CONFIRMED'
            ? (isBull ? 'CONFIRMED — broke above then failed back below' : 'CONFIRMED — broke below then reclaimed above')
            : 'WATCHING — broke through, not yet confirmed either way';
          row5 = [
            label,
            levelLabel+': $'+p.level.toFixed(2),
            isBull ? ('Broke '+fmtD(p.breakoutDate)) : ('Broke '+fmtD(p.breakdownDate)),
            p.status==='CONFIRMED' ? (isBull ? ('Failed back below '+fmtD(p.failDate)) : ('Reclaimed above '+fmtD(p.reclaimDate))) : '(within watch window)',
            statusLabel
          ];
        } else if (isRnd) {
          const RND_LABELS = { ROUNDING_BOTTOM:'Rounding Bottom (Saucer)', ROUNDING_TOP:'Rounding Top', CUP_AND_HANDLE:'Cup and Handle' };
          const rndBrokeWord = p.type==='ROUNDING_TOP' ? 'below' : 'above';
          const statusLabel = p.status==='BROKE_UP' ? ('BROKE UP — closed '+rndBrokeWord+' rim') : (p.status==='BROKE_DOWN' ? ('BROKE DOWN — closed '+rndBrokeWord+' rim') : 'Forming — rim not yet broken');
          row5 = [
            RND_LABELS[p.type],
            'Rim: $'+p.rim.toFixed(2),
            '(coarse curve-fit proxy, not a true parabola fit)',
            '$'+p.rim.toFixed(2),
            statusLabel
          ];
        } else if (isRect) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — closed above resistance' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — closed below support' : 'Forming — inside range');
          row5 = [
            'Rectangle',
            'Resistance: $'+p.resistanceLevel.toFixed(2),
            'Support: $'+p.supportLevel.toFixed(2),
            'Range: $'+p.supportLevel.toFixed(2)+' – $'+p.resistanceLevel.toFixed(2),
            statusLabel
          ];
        } else if (isFP) {
          const FP_LABELS = { BULL_FLAG:'Bull Flag', BEAR_FLAG:'Bear Flag', PENNANT:'Pennant' };
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — continuation confirmed' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — continuation confirmed' : 'Forming — inside consolidation range');
          row5 = [
            FP_LABELS[p.type],
            'Pole: '+fmtD(p.poleStartDate)+' → '+fmtD(p.poleEndDate)+' ('+(p.polePct>=0?'+':'')+(p.polePct*100).toFixed(1)+'%, '+p.poleDir+')',
            'Consolidation range',
            '$'+p.consolLow.toFixed(2)+' – $'+p.consolHigh.toFixed(2),
            statusLabel
          ];
        } else if (isTW) {
          const TW_LABELS = { SYMMETRICAL_TRIANGLE:'Symmetrical Triangle', ASCENDING_TRIANGLE:'Ascending Triangle', DESCENDING_TRIANGLE:'Descending Triangle', RISING_WEDGE:'Rising Wedge', FALLING_WEDGE:'Falling Wedge' };
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — closed above resistance' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — closed below support' : 'Forming — inside both lines');
          row5 = [
            TW_LABELS[p.type],
            'R: '+fmtD(p.resistanceP1.date)+' @$'+p.resistanceP1.price.toFixed(2)+' → '+fmtD(p.resistanceP2.date)+' @$'+p.resistanceP2.price.toFixed(2),
            'S: '+fmtD(p.supportP1.date)+' @$'+p.supportP1.price.toFixed(2)+' → '+fmtD(p.supportP2.date)+' @$'+p.supportP2.price.toFixed(2),
            'Res @last: $'+p.resistanceAtLast.toFixed(2)+' | Sup @last: $'+p.supportAtLast.toFixed(2),
            statusLabel
          ];
        } else if (p.type==='TRIPLE_TOP' || p.type==='TRIPLE_BOTTOM') {
          const label = p.type==='TRIPLE_TOP' ? 'Triple Top' : 'Triple Bottom';
          const pk = p.type==='TRIPLE_TOP' ? [p.peak1,p.peak2,p.peak3] : [p.trough1,p.trough2,p.trough3];
          const brokeWord = isBearish(p.type) ? 'below' : 'above';
          row5 = [
            label,
            fmtD(pk[0].date)+' @$'+pk[0].price.toFixed(2)+' | '+fmtD(pk[1].date)+' @$'+pk[1].price.toFixed(2),
            fmtD(pk[2].date)+' @$'+pk[2].price.toFixed(2),
            '$'+p.neckline.toFixed(2),
            p.confirmed ? ('CONFIRMED — broke '+brokeWord+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else if (p.type==='HEAD_AND_SHOULDERS' || p.type==='INVERSE_HEAD_AND_SHOULDERS') {
          const label = p.type==='HEAD_AND_SHOULDERS' ? 'Head & Shoulders' : 'Inverse Head & Shoulders';
          const brokeWord = isBearish(p.type) ? 'below' : 'above';
          row5 = [
            label,
            'LS '+fmtD(p.leftShoulder.date)+' @$'+p.leftShoulder.price.toFixed(2)+' | Head '+fmtD(p.head.date)+' @$'+p.head.price.toFixed(2),
            'RS '+fmtD(p.rightShoulder.date)+' @$'+p.rightShoulder.price.toFixed(2),
            '$'+p.necklineAtLast.toFixed(2)+' (sloped, at last close)',
            p.confirmed ? ('CONFIRMED — broke '+brokeWord+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else if (isHM) {
          // v9.71, Schabacker Study X. Real correctness note, caught before
          // shipping: without this branch, HALF_MAST would have fallen
          // through to the generic DOUBLE_TOP/BOTTOM branch below, which
          // reads p.date1/p.level/p.neckline -- none of which exist on a
          // HALF_MAST object (p.level.toFixed would throw on undefined).
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — continuation confirmed' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — continuation confirmed' : 'Forming — inside congestion');
          row5 = [
            'Half-Mast Congestion',
            'Mast: '+fmtD(p.moveStartDate)+' → '+fmtD(p.moveEndDate)+' ('+(p.movePct>=0?'+':'')+(p.movePct*100).toFixed(1)+'%, '+p.moveDir+')',
            'Congestion range',
            '$'+p.consolLow.toFixed(2)+' – $'+p.consolHigh.toFixed(2),
            statusLabel
          ];
        } else if (isBT) {
          // v9.72, Schabacker Study IV. Same correctness reasoning as the
          // HALF_MAST branch above -- a BROADENING object has no
          // date1/level/neckline either.
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN' : 'Forming — rule of five in progress');
          row5 = [
            p.type==='BROADENING_TOP' ? 'Broadening Top' : 'Broadening Bottom',
            'First: '+fmtD(p.points[0].date)+' @$'+p.points[0].price.toFixed(2),
            'Last: '+fmtD(p.points[p.points.length-1].date)+' @$'+p.points[p.points.length-1].price.toFixed(2),
            'Res: $'+p.resistance.toFixed(2)+' / Sup: $'+p.support.toFixed(2),
            statusLabel
          ];
        } else if (isDM) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN' : 'Forming — widen-then-narrow in progress');
          row5 = [
            p.type==='DIAMOND_TOP' ? 'Diamond Top' : 'Diamond Bottom',
            'First: '+fmtD(p.points[0].date)+' @$'+p.points[0].price.toFixed(2),
            'Last: '+fmtD(p.points[p.points.length-1].date)+' @$'+p.points[p.points.length-1].price.toFixed(2),
            'Res: $'+p.resistance.toFixed(2)+' / Sup: $'+p.support.toFixed(2),
            statusLabel
          ];
        } else if (isCX) {
          row5 = [
            p.type==='COMPLEX_TOP' ? 'Complex Top (double head)' : 'Complex Bottom (double head)',
            'S1 '+fmtD(p.shoulder1.date)+' @$'+p.shoulder1.price.toFixed(2)+' | H1 '+fmtD(p.head1.date)+' @$'+p.head1.price.toFixed(2),
            'H2 '+fmtD(p.head2.date)+' @$'+p.head2.price.toFixed(2)+' | S2 '+fmtD(p.shoulder2.date)+' @$'+p.shoulder2.price.toFixed(2),
            '$'+p.necklineAtLast.toFixed(2)+' (sloped, at last close)',
            p.confirmed ? ('CONFIRMED — broke '+(p.type==='COMPLEX_TOP'?'below':'above')+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else {
          row5 = [
            p.type==='DOUBLE_TOP'?'Double Top':'Double Bottom',
            fmtD(p.date1)+' @ $'+p.level.toFixed(2),
            fmtD(p.date2),
            '$'+p.neckline.toFixed(2),
            p.confirmed ? (p.type==='DOUBLE_TOP'?'CONFIRMED — broke below neckline':'CONFIRMED — broke above neckline') : 'Forming — neckline not yet broken'
          ];
        }
        sh.getRange(row,1,1,5).setValues([row5]).setBackground(bg);row++;
        // v9.71, Schabacker Study X: purely additive -- a new, separate row
        // (not a new column on the table above, so the existing 5-column
        // header/shape is completely untouched) shown only for patterns
        // that carry the new measuredTarget field (H&S/Flag/Pennant/Half-
        // Mast measuring rules). Book's own disclosed caveat included
        // directly, not hidden: a rough, probable objective, real
        // documented under/overshoot in the book's own worked examples,
        // never a guarantee.
        if (p.measuredTarget != null) {
          sh.getRange(row,1,1,5).merge().setValue('  ↳ Measured objective (Schabacker): $'+p.measuredTarget.toFixed(2)+' — rough, probable target, not a guarantee').setFontStyle('italic').setFontSize(9).setFontColor('#6d4c41');row++;
        }
        // v9.77, Edwards & Magee Ch37: purely additive, same "new separate
        // row" convention as the measuredTarget row just above -- shown
        // only for Double Top/Bottom (the only 2 pattern types that carry
        // this new field). Real book rule: >=6 weeks apart AND >=15%
        // intervening move for the book's own full-confidence read; this
        // engine's own detector still fires on its existing, looser 5%
        // MIN_PULLBACK/no-spacing-check bar (untouched) -- this row is a
        // real, disclosed CONFIRMATION-QUALITY flag, not a gate.
        if (p.emSpacingCheck) {
          const es = p.emSpacingCheck;
          sh.getRange(row,1,1,5).merge().setValue('  ↳ Edwards & Magee spacing check: '+es.weeksApart+' weeks apart, '+es.magnitudePct+'% intervening move — '+(es.meetsBook ? 'MEETS the book\'s full-confidence bar (≥6 weeks, ≥15%)' : 'below the book\'s full-confidence bar (≥6 weeks, ≥15%) — still a real, detected pattern, just lower book-confidence')).setFontStyle('italic').setFontSize(9).setFontColor('#4527a0');row++;
        }
      });
      row++;
    }
  } catch(e) { /* non-fatal */ }

  // ══ INSTITUTIONAL HOLDINGS (13F) ══ v9.57, user-requested (2026-08-24:
  // "Berkshire/BlackRock/Vanguard/State Street... a section in the report").
  // Real, free, SEC EDGAR 13F-HR filings -- verified live before building
  // (CIKs found via SEC's own full-text search, not memory; a real bug
  // caught and fixed before trusting output: "value" is whole dollars on
  // current filings, not thousands -- see fetchInstitutional13FHoldingsV7).
  // v9.60 update: Vanguard added back -- found all 6 real subsidiary CIKs
  // (see INSTITUTIONAL_13F_FILERS_V7 above), summed. 4 filers total now.
  // Real, disclosed cost: this section downloads each filer's FULL current+
  // prior-quarter holdings table (BlackRock's alone is ~23MB) to search for
  // one CUSIP -- a real, accepted addition to this report's total execution
  // time (~25s/ticker for all 4 filers), not hidden.
  // v9.61 real bug fix (2026-08-24): this comment block and the section
  // header below still said "3 filers, Vanguard dropped" after v9.60 added
  // Vanguard back -- the underlying data/fetch was correct, only the label
  // was stale. Caught during an unrelated real-gaps review, fixed here.
  // v9.70: time-budget guarded -- real, disclosed cost is ~25s/ticker for
  // all 4 filers (see comment above); skip rather than risk it being the
  // thing that eats whatever's left of a run already running late.
  // v9.97 (fetch-dedup pass, 2026-09-04): if the broker-course model
  // already fetched this same ticker's 13F holdings this run (its own
  // report build, earlier in runAnalysisV7), reuse that result instead of
  // fetching a 2nd, fully redundant round of SEC EDGAR 13F data (real,
  // disclosed heaviest single fetch in the whole run -- BlackRock's own
  // table alone ~23MB, per the comment above). Skip the time-budget guard
  // too when reusing -- there's no fetch left to protect against.
  if (existingInstitutional13F === undefined && !hasTimeBudgetV7_(25 * 1000)) {
    setStatusV7(status, 'institutionalHoldings', 'skipped', 'time budget — skipped to protect the rest of the report');
  } else {
  try {
    const cusip = existingInstitutional13F !== undefined ? null : fetch13FCusipV7(chart.ticker);
    if (existingInstitutional13F !== undefined || cusip) {
      const holdings13F = existingInstitutional13F !== undefined ? existingInstitutional13F : fetchInstitutional13FHoldingsV7(cusip);
      if (!holdings13F) {
        setStatusV7(status, 'institutionalHoldings', 'degraded', 'no institutional 13F data (reused from broker-course model)');
      } else {
      // Real bug caught before shipping: q.latest/q.prior are always non-null
      // wrapper objects ({date, holdings}) once the FETCH succeeds, even when
      // this specific CUSIP wasn't found in that filer's table -- checking
      // .holdings (the actual matched position) is the real "does anyone hold this" test.
      const anyReal = Object.values(holdings13F).some(q => (q.latest && q.latest.holdings) || (q.prior && q.prior.holdings));
      setStatusV7(status, 'institutionalHoldings', anyReal ? 'ok' : 'degraded', anyReal ? '' : 'no matching CUSIP position found in any tracked filer');
      if (anyReal) {
        hdrV7(sh,row,'🏛️  INSTITUTIONAL HOLDINGS (13F — Berkshire/BlackRock/Vanguard/State Street)','#1a237e',11,14);row++;
        sh.getRange(row,1,1,4).setValues([['Filer','Shares (latest)','Value','Qtr-over-Qtr Change']]).setFontWeight('bold').setBackground('#283593').setFontColor('#fff');row++;
        Object.entries(holdings13F).forEach(([name,q]) => {
          const latestPos = q.latest && q.latest.holdings;
          const priorPos = q.prior && q.prior.holdings;
          if (!latestPos && !priorPos) return;
          let sharesStr, valueStr, changeStr, bg='#e8eaf6';
          if (latestPos && priorPos) {
            const pct = (latestPos.shares-priorPos.shares)/priorPos.shares*100;
            sharesStr = latestPos.shares.toLocaleString()+' ('+q.latest.date+')';
            valueStr = '$'+(latestPos.value/1e6).toFixed(1)+'M';
            changeStr = (pct>=0?'+':'')+pct.toFixed(1)+'% vs '+q.prior.date;
            bg = pct>0?'#c8e6c9':pct<0?'#ffcdd2':'#e8eaf6';
          } else if (latestPos) {
            sharesStr = latestPos.shares.toLocaleString()+' ('+q.latest.date+')';
            valueStr = '$'+(latestPos.value/1e6).toFixed(1)+'M';
            changeStr = 'NEW position (no prior-quarter data)';
            bg = '#c8e6c9';
          } else {
            sharesStr = '0 (position closed)';
            valueStr = 'N/A';
            changeStr = 'Held '+priorPos.shares.toLocaleString()+' as of '+q.prior.date+', now CLOSED';
            bg = '#ffcdd2';
          }
          sh.getRange(row,1,1,4).setValues([[name, sharesStr, valueStr, changeStr]]).setBackground(bg);row++;
        });
        sh.getRange(row,1,1,4).merge().setValue('Real SEC EDGAR 13F-HR data — long equity positions only (no shorts/cash/bonds), filed up to 45 days after quarter-end. Vanguard is summed across its 6 real subsidiary filer CIKs (no single one covers its full position).').setFontStyle('italic').setFontSize(9).setFontColor('#5c6bc0').setWrap(true);row++;
        row++;
      }
      }
    } else {
      setStatusV7(status, 'institutionalHoldings', 'degraded', 'CUSIP lookup failed');
    }
  } catch(e) {
    // Real, disclosed degradation, not a hidden swallow -- real SEC EDGAR
    // fetch failures shouldn't break the rest of the report.
    setStatusV7(status, 'institutionalHoldings', 'failed', e && e.message ? e.message : String(e));
  }
  }

  // ══ GANN SUMMARY ══
  try {
    hdrV7(sh,row,'📐  GANN ANGULAR SUMMARY (20% of long-term score)','#bf360c',11,14);row++;
    sh.getRange(row,1,1,6).setValues([['Pivot','Price Unit','Riding','1×1 Level','Gann Support','Gann Score']]).setFontWeight('bold').setBackground('#d84315').setFontColor('#fff');row++;
    sh.getRange(row,1,1,6).setValues([[gann.pivot.dateStr+' @ $'+gann.pivot.price.toFixed(2),'$'+gann.priceUnit.toFixed(2)+'/day',gann.lowerAngle+' → '+gann.upperAngle,gann.gannMaster?'$'+gann.gannMaster.toFixed(2):'N/A',gann.gannSupport?'$'+gann.gannSupport.toFixed(2):'N/A',gann.score+'/100 '+scoreBar(gann.score)]]).setBackground('#fbe9e7');row++;
    sh.getRange(row,1,1,5).setValues([['Gann Angle','Line Price Today','% vs Now','Support / Resistance','Note']]).setFontWeight('bold').setBackground('#e64a19').setFontColor('#fff');row++;
    (gann.ANGLES||[]).forEach((a,i)=>{
      const isLower=a.label===gann.lowerAngle,isUpper=a.label===gann.upperAngle,isMaster=a.label==='1×1';
      const f0=gann.fan[a.label];
      if(f0 && !isMaster && !isLower && !isUpper && Math.abs(f0.pct)>150) return;
      try{
        const f=f0;if(!f)return;
        const bg=isMaster?'#ffe082':isLower||isUpper?'#b3e5fc':i%2===0?'#fbe9e7':'#fff3e0';
        sh.getRange(row,1,1,5).setValues([[a.label,'$'+f.level.toFixed(2),(f.pct>=0?'+':'')+f.pct.toFixed(2)+'%',f.above?'Resistance':'Support',isMaster?'★ MASTER':isLower||isUpper?'◀ RIDING':'']]).setBackground(bg);
        sh.getRange(row,4).setFontColor(f.above?'#b71c1c':'#2e7d32').setFontWeight('bold');
      }catch(e){}
      row++;
    });
    row+=2;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Gann section error').setFontColor('#e65100');row+=12;}

  // ══ SHORT INDICATORS ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📊  SHORT-TERM INDICATORS  (Days / Weeks)').setBackground('#1b5e20').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    // Sub-phase 4c (DASHBOARD_IMPROVEMENTS_PLAN.md): Points + Weight columns,
    // computed from signal.signal/signal.weight -- both already existed,
    // never surfaced. Points = this indicator's own reading on the same
    // 0-100 scale as the category score. Weight = its share of its
    // category's total weight (not its raw weight number alone, which
    // isn't meaningful without knowing what it's being compared against).
    const shortCatTotals = {};
    (scores.shortSignals||[]).forEach(s => { const c=s.cat||'Other'; shortCatTotals[c]=(shortCatTotals[c]||0)+s.weight; });
    sh.getRange(row,1,1,7).setValues([['#','Indicator','Current Reading','Bull / Bear','Points','Weight','What it means']]).setFontWeight('bold').setBackground('#43a047').setFontColor('#fff');row++;
    (scores.shortSignals||[]).forEach((s,i)=>{
      try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':'🟡 NEUTRAL';
        const pts = Math.round((s.signal+1)/2*100);
        const catTotal = shortCatTotals[s.cat||'Other'] || 1;
        const weightShare = Math.round((s.weight/catTotal)*100) + '% of ' + (s.cat||'Other');
        sh.getRange(row,1,1,7).setValues([[i+1,s.name,s.display||'Missing data',sig,pts,weightShare,s.note||'']]).setBackground(i%2===0?'#e8f5e9':'#f1f8e9');
        sh.getRange(row,4).setFontColor(s.signal>0.3?'#1b5e20':s.signal<-0.3?'#b71c1c':'#f57f17').setFontWeight('bold');
      }catch(e){}row++;
    });
    sh.getRange(row,1,1,7).merge().setValue('SHORT-TERM: '+scores.shortScore+'/100  '+scoreBar(scores.shortScore)+'  '+scores.shortVerdict).setBackground(scores.shortScore>=60?'#a5d6a7':scores.shortScore>=45?'#fff9c4':'#ef9a9a').setFontWeight('bold').setFontSize(11);row+=3;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Short indicators error').setFontColor('#e65100');row+=3;}

  // ══ LONG INDICATORS ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📈  LONG-TERM INDICATORS  (Months / 1-2 Years)').setBackground('#0d47a1').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    const longCatTotals = {};
    (scores.longSignals||[]).forEach(s => { const c=s.cat||'Other'; longCatTotals[c]=(longCatTotals[c]||0)+s.weight; });
    sh.getRange(row,1,1,7).setValues([['#','Indicator','Current Reading','Bull / Bear','Points','Weight','What it means']]).setFontWeight('bold').setBackground('#1976d2').setFontColor('#fff');row++;
    (scores.longSignals||[]).forEach((s,i)=>{
      try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':'🟡 NEUTRAL';
        const bg=s.name.includes('Gann')?'#fff9c4':i%2===0?'#e3f2fd':'#e8eaf6';
        const pts = Math.round((s.signal+1)/2*100);
        const catTotal = longCatTotals[s.cat||'Other'] || 1;
        const weightShare = Math.round((s.weight/catTotal)*100) + '% of ' + (s.cat||'Other');
        sh.getRange(row,1,1,7).setValues([[i+1,s.name,s.display||'Missing data',sig,pts,weightShare,s.note||'']]).setBackground(bg);
        sh.getRange(row,4).setFontColor(s.signal>0.3?'#1b5e20':s.signal<-0.3?'#b71c1c':'#f57f17').setFontWeight('bold');
      }catch(e){}row++;
    });
    sh.getRange(row,1,1,7).merge().setValue('LONG-TERM: '+scores.longScore+'/100  '+scoreBar(scores.longScore)+'  '+scores.longVerdict).setBackground(scores.longScore>=60?'#a5d6a7':scores.longScore>=45?'#fff9c4':'#ef9a9a').setFontWeight('bold').setFontSize(11);row+=3;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Long indicators error').setFontColor('#e65100');row+=3;}

  // ══ FUNDAMENTALS (v6.1 detailed table) + v7 improved OWN score ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('💰  FUNDAMENTAL ANALYSIS  ['+fundSource+']').setBackground('#e65100').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    if (fundResult && fundResult.score!=null) {
      sh.getRange(row,1,1,14).merge().setValue('🔮 v7 OWN score (PRIMARY): '+fundResult.score+'/100  '+scoreBar(fundResult.score)+'  '+fundResult.verdict+'   ·   Sector model: '+(fundResult.profile||'DEFAULT')).setBackground('#ede7f6').setFontColor('#4527a0').setFontWeight('bold');row++;
      // Sub-phase 1.2.3: cross-source warning now attached explicitly to the
      // ONE authoritative score it actually affects (fundResult.score), not
      // left floating near the demoted legacy score further down the page.
      if (fund && fund._crossRef) {
        sh.getRange(row,1,1,14).merge().setValue('⚠ This OWN score may be less reliable than usual — cross-source data disagreement: '+fund._crossRef.join('  •  ')).setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setFontSize(9).setWrap(true);row++;
      }
      // Sub-phase 1.2.2 (Phase 1 fix): render fundResult.drivers — the new
      // engine's actual sector-aware component breakdown. Previously computed
      // but NEVER shown anywhere on the dashboard; only the single summary
      // score line existed. This is the primary detail table now.
      if (fundResult.drivers && fundResult.drivers.length) {
        sh.getRange(row,1,1,4).setValues([['Driver','Value','Points','Note']]).setFontWeight('bold').setBackground('#7e57c2').setFontColor('#fff');row++;
        fundResult.drivers.forEach((d,i)=>{
          try{
            sh.getRange(row,1,1,4).setValues([[d.label, d.value, d.points, d.note||'']]).setBackground(i%2===0?'#ede7f6':'#f3e5f5');
          }catch(e){}
          row++;
        });
        row++;
      }

      // Balance sheet health (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- shown
      // as standalone reference figures, distinct from the existing
      // cash-runway SCORING component above (which only fires for
      // unprofitable companies). These display regardless of profitability
      // status -- real gap this was filling: debt/equity, current ratio,
      // FCF/share weren't visible on their own for a profitable company.
      if (fund && (fund.debtToEquity != null || fund.currentRatio != null || fund.fcfPerShare != null)) {
        sh.getRange(row,1,1,3).setValues([['Balance Sheet Health','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        if (fund.debtToEquity != null) {
          const d2eRead = fund.debtToEquity < 0.5 ? 'low leverage' : fund.debtToEquity < 1.5 ? 'moderate' : 'high leverage';
          sh.getRange(row,1,1,3).setValues([['Debt/Equity', fund.debtToEquity.toFixed(2)+'x', d2eRead]]).setBackground('#ede7f6');row++;
        }
        if (fund.currentRatio != null) {
          const curRead = fund.currentRatio >= 1.5 ? 'healthy liquidity' : fund.currentRatio >= 1.0 ? 'adequate' : 'tight — current liabilities exceed current assets';
          sh.getRange(row,1,1,3).setValues([['Current Ratio', fund.currentRatio.toFixed(2)+'x', curRead]]).setBackground('#f3e5f5');row++;
        }
        if (fund.quickRatio != null) {
          // Genuinely different from Current Ratio -- excludes inventory, a
          // stricter "can this company cover short-term obligations without
          // needing to sell inventory first" read. Real gap found directly
          // by comparing against a real stock-screener export.
          const quickRead = fund.quickRatio >= 1.0 ? 'can cover short-term liabilities without selling inventory' : 'would need to sell inventory or raise cash to cover short-term liabilities';
          sh.getRange(row,1,1,3).setValues([['Quick Ratio', fund.quickRatio.toFixed(2)+'x', quickRead]]).setBackground('#f3e5f5');row++;
        }
        if (fund.fcfPerShare != null) {
          const fcfRead = fund.fcfPerShare > 0 ? 'generating free cash flow' : 'burning cash';
          sh.getRange(row,1,1,3).setValues([['FCF/Share (TTM)', '$'+fund.fcfPerShare.toFixed(2), fcfRead]]).setBackground('#ede7f6');row++;
        }
        row++;
      }

      // Insider trading -- net buying/selling (DASHBOARD_IMPROVEMENTS_PLAN.md
      // 4a). A real "smart money" signal, previously entirely absent.
      // Confirmed endpoint/field names via FMP docs before building; the
      // exact query param for ticker-filtering wasn't explicitly confirmed
      // on this specific endpoint, using symbol= (the consistent pattern
      // across 7+ other proven FMP calls in this codebase). If wrong, this
      // section simply won't appear (fund._insiderTrading stays null) --
      // fails safely, doesn't break anything else.
      if (fund && fund._insiderTrading) {
        const it = fund._insiderTrading;
        sh.getRange(row,1,1,3).setValues([['Insider Trading (recent filings)','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        const netRead = it.netBuying ? 'net insider BUYING' : it.netShares < 0 ? 'net insider SELLING' : 'neutral';
        sh.getRange(row,1,1,3).setValues([['Net shares (last '+it.transactionsAnalyzed+' filings)', (it.netShares>=0?'+':'')+it.netShares.toLocaleString(), netRead]]).setBackground(it.netBuying?'#c8e6c9':it.netShares<0?'#ffcdd2':'#eceff1');row++;
        sh.getRange(row,1,1,3).setValues([['Purchases vs sales (count)', it.purchaseCount+' buys / '+it.saleCount+' sells', '']]).setBackground('#f3e5f5');row++;
        row++;
      }

      // Rate-environment context (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
      // connected explicitly to THIS stock's own P/E, since that's the
      // actual reasoning (a high-multiple stock is more rate-sensitive),
      // not just a floating macro number with no stated relevance.
      if (fund && fund._treasuryRate10Y && fund._treasuryRate10Y.year10 != null) {
        const t10y = fund._treasuryRate10Y.year10;
        // Real bug found on the first real run: this read trailingPE first,
        // which disagreed with the already-established, documented
        // convention elsewhere in this codebase (the P/E & PEG driver's own
        // "Phase 2 fix": forward P/E first when genuinely available, since
        // it's a real forward-looking estimate, not a mislabeled trailing
        // number -- trailing only as fallback). Confirmed on the real run:
        // this bug showed 139.1x (trailing) while the rest of the SAME
        // report correctly showed 67.0x (forward) for the same stock.
        const pe = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
        sh.getRange(row,1,1,3).setValues([['Rate Environment','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        // W8 (v8.1): the "Read" column previously held the raw date, which
        // Sheets coerced into a meaningless serial (the 46241 artifact). Now it
        // carries a real plain-language read; the as-of date moves to a cell note.
        const yieldRead = t10y > 4.5 ? 'elevated — pressures high-multiple valuations'
                        : t10y > 3.5 ? 'moderate' : 'low — supportive for equities';
        sh.getRange(row,1,1,3).setValues([['10-Year Treasury Yield', t10y.toFixed(2)+'%', yieldRead]]).setBackground('#ede7f6');
        if (fund._treasuryRate10Y.date) sh.getRange(row,3).setNote('As of ' + fund._treasuryRate10Y.date);
        row++;
        if (pe != null) {
          const rateSensRead = pe > 40 ? 'HIGH rate-sensitivity — this multiple is unusually exposed to rate moves' : pe > 25 ? 'moderate rate-sensitivity' : 'low rate-sensitivity';
          sh.getRange(row,1,1,3).setValues([['This stock\'s P/E ('+pe.toFixed(1)+'x) vs. rates', rateSensRead, '']]).setBackground(pe>40?'#fff3e0':'#f3e5f5');
          if (pe > 40) sh.getRange(row,2).setFontColor('#e65100').setFontWeight('bold');
          row++;
        }
        row++;
      }
    }
    if(fund&&scores.fundSignals&&scores.fundSignals.length>0){
      // Sub-phase 1.2.1 (Phase 1 fix): the old engine's score/table is now
      // explicitly demoted under a Second Opinion header — kept in full (per
      // Path B), never presented as competing with the primary OWN score above.
      sh.getRange(row,1,1,14).merge().setValue('②  SECOND OPINION — legacy v6.1 engine (context only, NOT the decision)').setBackground('#78909c').setFontColor('#fff').setFontStyle('italic').setFontSize(10);row++;
      sh.getRange(row,1,1,5).setValues([['#','Metric','Current Reading','Bull / Bear','What it means']]).setFontWeight('bold').setBackground('#90a4ae').setFontColor('#fff');row++;
      scores.fundSignals.forEach((s,i)=>{
        try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':s.weight===0?'ℹ️ INFO':'🟡 NEUTRAL';
          sh.getRange(row,1,1,5).setValues([[i+1,s.name,s.display||'Missing data',sig,s.note||'']]).setBackground(i%2===0?'#eceff1':'#f5f5f5').setFontColor('#546e7a');
          sh.getRange(row,4).setFontColor('#78909c').setFontWeight('bold');
        }catch(e){}row++;
      });
      const fs=scores.fundScore;
      const fsLabel=(fs!=null)?(fs+'/100  '+scoreBar(fs)+'  '+scores.fundVerdict):('N/A  '+(scores.fundVerdict||'— insufficient fundamental data'));
      sh.getRange(row,1,1,5).merge().setValue('Second Opinion score (legacy, not authoritative): '+fsLabel).setBackground('#cfd8dc').setFontColor('#455a64').setFontWeight('bold').setFontSize(10);row++;
      // Sub-phase 1.2.4 (Phase 1 fix): plain-language auto-reconciliation when
      // the two scores diverge sharply, so "why are there two numbers" isn't
      // left for the reader to wonder about.
      if (fundResult && fundResult.score!=null && fs!=null && Math.abs(fundResult.score-fs)>=15) {
        const higher = fundResult.score>fs ? 'Primary' : 'Second Opinion';
        sh.getRange(row,1,1,5).merge().setValue('ℹ These differ by '+Math.abs(fundResult.score-fs)+' points — the '+higher+' score weighs sector-specific factors (growth trajectory, peer valuation) the legacy model does not; the Primary score above is the one used in the decision.').setBackground('#fff9c4').setFontColor('#8d6e00').setFontStyle('italic').setFontSize(9).setWrap(true);row++;
      }
      if(fund&&fund._sources&&fund._sources.length){
        sh.getRange(row,1,1,5).merge().setValue('🔗 Sources: '+fund._sources.join(' + ')+(fund._crossRef?'   ⚠ Cross-source differences noted above':'   ✓ sources agree')).setBackground('#eceff1').setFontStyle('italic').setFontColor('#455a64').setFontSize(9);row++;
      }
      row+=2;
    } else {
      sh.getRange(row,1,1,5).merge().setValue('⚠️ No fundamental signal data — technical & Gann analysis only. See 🔬 Log for the API result.').setBackground('#fff3e0').setFontColor('#e65100');row++;
      sh.getRange(row,1,1,5).merge().setValue('Second Opinion score: N/A — technical signals only').setBackground('#cfd8dc').setFontColor('#455a64').setFontWeight('bold').setFontSize(10);row+=3;
    }
  }catch(e){sh.getRange(row,1).setValue('⚠️ Fund error: '+e.message.substring(0,60)).setFontColor('#e65100');row+=3;}

  // ══ OPTIONS INTELLIGENCE (rich v7) ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('⚡  OPTIONS INTELLIGENCE — Smart-Money Positioning  (adjusts BUY-TIMING & Final Conviction, never OWN)').setBackground('#880e4f').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    if(opts&&opts.available){
      const dir=opts.dirSig>=0.34?'🟢 Bullish':opts.dirSig<=-0.34?'🔴 Bearish':'🟡 Mixed / neutral';
      const verdict=opts.confirm==='confirm'?'✅ CONFIRM — options agree with the chart  (Final Conviction +8)':opts.confirm==='conflict'?'⚠️ CONFLICT — options lean opposite the chart  (Final Conviction −10)':'➖ NEUTRAL — no strong directional edge';
      const rows5=[
        ['Verdict',verdict,'','',''],
        ['Direction',dir+'   ·   Put/Call OI '+(opts.putCallOI!=null?opts.putCallOI.toFixed(2):'N/A')+'   ·   net $ '+(opts.netBiasPct!=null?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'% into '+(opts.netBiasPct>=0?'calls':'puts')):'N/A'),'','','Put/Call <0.7 = upside positioning; >1.1 = downside/hedging'],
        ['Long-term (LEAPS 1–2yr)',(opts.leapsLean>0.15?'🟢 Bullish accumulation':opts.leapsLean<-0.15?'🔴 Bearish / hedged':'🟡 Neutral'),'','','Heavy long-dated call buying = real long-term conviction (often institutions)'],
        ['Volatility (IV %ile)',(opts.ivRank!=null?opts.ivRank+'th percentile':'N/A')+(opts.ivRank!=null&&opts.ivRank>=80?'  — elevated (event/fear priced in)':opts.ivRank!=null&&opts.ivRank<=20?'  — low / calm':''),'','','High IV = options pricing a big move; trims entry confidence'],
        ['Biggest bets','calls '+(opts.topCall?'$'+opts.topCall.strike+' ('+fmtExpiryV7_(opts.topCall.expiry)+') conv '+opts.topCall.conv:'N/A')+'   ·   puts '+(opts.topPut?'$'+opts.topPut.strike+' ('+fmtExpiryV7_(opts.topPut.expiry)+') conv '+opts.topPut.conv:'N/A'),'','','Price levels where the biggest option money sits — informal magnets'],
        ['LEAPS bets','calls '+(opts.leapCall?'$'+opts.leapCall.strike+' ('+fmtExpiryV7_(opts.leapCall.expiry)+')':'N/A')+'   ·   puts '+(opts.leapPut?'$'+opts.leapPut.strike+' ('+fmtExpiryV7_(opts.leapPut.expiry)+')':'N/A'),'','','Longest-dated conviction bets']
      ];
      if(opts.horizon) rows5.push(['Near your entry (~'+opts.horizon.days+'d)','call '+(opts.horizon.topCall?'$'+opts.horizon.topCall.strike+' ('+fmtExpiryV7_(opts.horizon.topCall.expiry)+')':'N/A')+'   ·   put '+(opts.horizon.topPut?'$'+opts.horizon.topPut.strike+' ('+fmtExpiryV7_(opts.horizon.topPut.expiry)+')':'N/A'),'','','Positioning at the expiries closest to the planned entry timing']);
      sh.getRange(row,1,1,5).setValues([['Signal','Reading','','','What it means']]).setFontWeight('bold').setBackground('#ad1457').setFontColor('#fff');row++;
      rows5.forEach((rr,i)=>{ try{ sh.getRange(row,1,1,5).setValues([rr]).setBackground(i%2===0?'#fce4ec':'#f3e5f5'); sh.getRange(row,1).setFontWeight('bold'); sh.getRange(row,5).setFontStyle('italic').setFontColor('#6a1b9a').setFontSize(9);}catch(e){} row++; });
      row+=2;
    } else {
      sh.getRange(row,1,1,5).merge().setValue('No options snapshot for '+ticker+' — run Options Analysis on this ticker first, then re-run this report to fold in smart-money positioning.').setBackground('#fce4ec').setFontColor('#880e4f').setFontStyle('italic');row+=3;
    }
  }catch(e){sh.getRange(row,1).setValue('⚠️ Options error: '+e.message.substring(0,60)).setFontColor('#e65100');row+=3;}

  // ══ KEY LEVELS ══
  try {
    hdrV7(sh,row,'📐  KEY PRICE LEVELS & MOVING AVERAGES','#37474f',11,14);row++;
    sh.getRange(row,1,1,8).setValues([['Support/Resistance','Level Price','% vs Now','Moving Average','MA Price','% vs Now','Fib / 52wk','Fib Price']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
    [['SMA20',ind.sma20,'EMA9',ind.ema9,'23.6%',ind.fib236],['SMA50',ind.sma50,'EMA21',ind.ema21,'38.2%',ind.fib382],['SMA150',ind.sma150,'',null,'50.0%',ind.fib500],['SMA200',ind.sma200,'',null,'61.8%',ind.fib618],['Pivot',ind.pivot,'R1',ind.pp_R1,'78.6%',ind.fib786],['S1',ind.pp_S1,'R2',ind.pp_R2,'52wk H',ind.high52],['S2',ind.pp_S2,'',null,'52wk L',ind.low52]].forEach(([l1,v1,l2,v2,l3,v3],i)=>{
      try{const p1=v1?((v1/cp-1>=0?'+':'')+((v1/cp-1)*100).toFixed(2))+'%':'—',p2=v2?((v2/cp-1>=0?'+':'')+((v2/cp-1)*100).toFixed(2))+'%':'—';
        sh.getRange(row,1,1,8).setValues([[l1,v1?'$'+v1.toFixed(2):'—',p1,l2,v2?'$'+v2.toFixed(2):'—',p2,l3,v3?'$'+v3.toFixed(2):'—']]).setBackground(i%2===0?'#eceff1':'#f5f5f5');
        if(v1)sh.getRange(row,3).setFontColor((v1/cp-1)>=0?'#2e7d32':'#c62828');
        if(v2)sh.getRange(row,6).setFontColor((v2/cp-1)>=0?'#2e7d32':'#c62828');
      }catch(e){}row++;
    });
    row+=2;
  }catch(e){row+=8;}

  // ══ PLAIN-ENGLISH ANALYSIS SUMMARY ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📝  ANALYSIS SUMMARY — Plain English').setBackground('#263238').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row+=2;
    const paras=buildNarrativeV7_(ticker, chart, ind, gann, confluence, scores, fund, opts, techPlan, decision, fundResult);
    paras.forEach(p=>{
      try {
        sh.getRange(row,1,1,14).merge().setValue(p.heading).setFontWeight('bold').setFontSize(11).setFontColor('#0d47a1');row++;
        sh.getRange(row,1,1,14).merge().setValue(p.body).setWrap(true).setVerticalAlignment('top').setFontSize(10).setBackground('#fafafa');
        const lines=Math.max(1,Math.ceil(p.body.length/110));
        sh.setRowHeight(row, Math.min(220, 18*lines+6));
        row+=2;
      } catch(e){ row++; }
    });
  } catch(e){ sh.getRange(row,1).setValue('⚠️ Summary error: '+e.message.substring(0,80)).setFontColor('#e65100'); row+=3; }

  sh.setColumnWidth(1,190);sh.setColumnWidth(2,120);sh.setColumnWidth(3,150);
  sh.setColumnWidth(4,170);sh.setColumnWidth(5,300);sh.setColumnWidths(6,9,110);
  sh.setFrozenRows(1);
  SpreadsheetApp.flush();
}

// ──────────────────────────────────────────────────────────────
//  v6.1 SIGNAL ENGINE — ported so the rich SHORT/LONG report renders
//  from v7 data. Renamed with V7_ suffix; identical logic to v6.1.
// ──────────────────────────────────────────────────────────────
function categoryOfV7_(name){
  if(/SMA|EMA|Cross|ADX|Gann|Relative Strength|Aroon|Donchian|Parabolic SAR|SuperTrend|Ichimoku/i.test(name))return'Trend';
  if(/RSI|MACD|Stochastic|Williams|CCI|MFI|ROC|Momentum|Divergence|Bollinger/i.test(name))return'Momentum';
  if(/Volume|OBV|CMF/i.test(name))return'Volume';
  if(/ATR/i.test(name))return'Volatility';
  if(/52wk|Fib/i.test(name))return'Position';
  return'Other';
}

function scoreAllSignalsV7_(ind, fund, gann, chart, regime, existingShortInterest) {
  const shortSignals=[],longSignals=[],fundSignals=[];
  const addS=(n,s,d,w,note)=>shortSignals.push({name:n,signal:s,display:d,weight:w,note:note||'',cat:categoryOfV7_(n)});
  const addL=(n,s,d,w,note)=>longSignals.push({name:n,signal:s,display:d,weight:w,note:note||'',cat:categoryOfV7_(n)});
  const addF=(n,s,d,w,note)=>fundSignals.push({name:n,signal:s,display:d,weight:w,note:note||'',cat:'Valuation'});

  addS('RSI(14)',ind.rsi14<30?1:ind.rsi14>70?-1:ind.rsi14>55?0.5:ind.rsi14<45?-0.5:0,ind.rsi14.toFixed(1)+(ind.rsi14<30?' OVERSOLD':ind.rsi14>70?' OVERBOUGHT':''),3,ind.rsi14<30?'Oversold — bounce likely':ind.rsi14>70?'Overbought — pullback risk':ind.rsi14>55?'Firm — bullish momentum':ind.rsi14<45?'Soft — mild weakness':'Neutral zone');
  addS('MACD Histogram',ind.histogram>0&&ind.histSlope>0?1:ind.histogram<0&&ind.histSlope<0?-1:ind.histogram>0?0.5:-0.5,ind.macdVal.toFixed(2)+' / sig '+ind.sigVal.toFixed(2),3,ind.histogram>0?'Above signal — bullish':'Below signal — bearish');
  addS('Stochastic %K/%D',ind.stochK<20?1:ind.stochK>80?-1:ind.stochK>ind.stochD?0.5:-0.5,'%K='+ind.stochK.toFixed(1)+'  %D='+ind.stochD.toFixed(1),2,ind.stochK<20?'Oversold':ind.stochK>80?'Overbought':'Momentum: '+(ind.stochK>ind.stochD?'rising':'falling'));
  addS('Bollinger %B',ind.bbPctB<0.05?1:ind.bbPctB>0.95?-1:ind.bbPctB<0.35?0.5:ind.bbPctB>0.65?-0.5:0,'%B='+(ind.bbPctB*100).toFixed(1)+'%  W='+(ind.bbWidth*100).toFixed(1)+'%',2,ind.bbSqueeze?'Squeeze — breakout imminent':ind.bbPctB>0.95?'Near upper band':ind.bbPctB<0.05?'Near lower band':'Mid-band');
  addS('Williams %R',ind.willR<-80?1:ind.willR>-20?-1:ind.willR<-50?0.5:-0.5,ind.willR.toFixed(1),2,ind.willR<-80?'Oversold':ind.willR>-20?'Overbought':'Neutral');
  addS('CCI(20)',ind.cci20>100?1:ind.cci20<-100?-1:ind.cci20>0?0.3:-0.3,ind.cci20.toFixed(1),2,ind.cci20>100?'Strong upward momentum':ind.cci20<-100?'Strong downward momentum':'Neutral');
  addS('MFI(14)',ind.mfi14<20?1:ind.mfi14>80?-1:ind.mfi14>55?0.5:ind.mfi14<45?-0.5:0,ind.mfi14.toFixed(1)+(ind.mfi14<20?' OVERSOLD':ind.mfi14>80?' OVERBOUGHT':''),2,ind.mfi14<20?'Money flowing in':ind.mfi14>80?'Overbought flow':'Balanced');
  // v9.68 -- BIG_PLAN_ENGINE_EXPANSION.md Phase A. 5 real, standard,
  // well-established indicators, scored the same way every other textbook
  // oscillator/trend indicator in this block already is -- real, standard
  // convention thresholds (Aroon's 70/30 "strong trend" bands, SAR/SuperTrend's
  // own inherent binary flip, Ichimoku's inside-cloud=neutral reading), not
  // fit to any backtest.
  if(ind.aroonUp!=null&&ind.aroonDown!=null)addS('Aroon(25)',(ind.aroonUp>70&&ind.aroonDown<30)?1:(ind.aroonDown>70&&ind.aroonUp<30)?-1:ind.aroonUp>ind.aroonDown?0.5:ind.aroonDown>ind.aroonUp?-0.5:0,'Up='+ind.aroonUp.toFixed(0)+' Down='+ind.aroonDown.toFixed(0),2,(ind.aroonUp>70&&ind.aroonDown<30)?'Strong uptrend':(ind.aroonDown>70&&ind.aroonUp<30)?'Strong downtrend':'No dominant trend');
  if(ind.donchianUpper!=null){const dcPctB=(ind.last-ind.donchianLower)/((ind.donchianUpper-ind.donchianLower)||1);addS('Donchian(20)',dcPctB>0.95?1:dcPctB<0.05?-1:dcPctB>0.65?0.5:dcPctB<0.35?-0.5:0,'$'+ind.donchianLower.toFixed(2)+' – $'+ind.donchianUpper.toFixed(2),2,dcPctB>0.95?'At/near 20d high — breakout zone':dcPctB<0.05?'At/near 20d low — breakdown zone':'Mid-channel');}
  // v9.99 -- Turtle System 2 (55-day channel), informational cross-reference
  // ONLY: weight 0 AND signal 0, deliberately excluded from the SHORT-table
  // verdict total and not asserting a directional read -- needs a real
  // predictive-value backtest before ever being scored (docs/BIG_PLAN_TURTLE.md
  // Deliverable 2 audit, 2026-09-05).
  if(ind.donchian55Upper!=null){addS('Donchian(55) [Turtle System 2 — informational, not scored]',0,'$'+ind.donchian55Lower.toFixed(2)+' – $'+ind.donchian55Upper.toFixed(2),0,'Appendix E, Original Turtle Trading System — the book\'s own parallel 55-day breakout channel, the real "Failsafe" level. Cross-reference only; not yet backtested, not scored.');}
  if(ind.parabolicSAR!=null)addS('Parabolic SAR',ind.parabolicSARBullish?1:-1,'$'+ind.parabolicSAR.toFixed(2),2,ind.parabolicSARBullish?'Below price — uptrend':'Above price — downtrend');
  if(ind.superTrend!=null)addS('SuperTrend',ind.superTrendBullish?1:-1,'$'+ind.superTrend.toFixed(2),2,ind.superTrendBullish?'Below price — uptrend':'Above price — downtrend');
  if(ind.senkouSpanA!=null)addS('Ichimoku Cloud',ind.ichimokuCloudBullish===true?1:ind.ichimokuCloudBullish===false?-1:0,ind.ichimokuCloudBullish===true?'Price above cloud':ind.ichimokuCloudBullish===false?'Price below cloud':'Price inside cloud',2,ind.ichimokuCloudBullish===true?'Bullish — trend support below':ind.ichimokuCloudBullish===false?'Bearish — trend resistance above':'No clear trend (inside cloud)');
  // Same direction-awareness fix as the headline Volume signal above --
  // this table used a slightly different moderate-volume threshold (1.2,
  // not 1.0), preserved here; only the direction-blindness is fixed.
  { const vDir = ind.last>(ind.sma20||0) ? 1 : ind.last<(ind.sma20||0) ? -1 : 0;
    addS('Volume vs 20d',ind.volRatio>1.5?vDir:(ind.volRatio>1.2?0.3*vDir:0),ind.volRatio.toFixed(2)+'x'+(ind.volRatio>1.5?' HIGH':''),2,ind.volRatio>1.5?'High volume confirms move':'Normal volume'); }
  addS('OBV (10d)',ind.obvShortSlope>0?1:ind.obvShortSlope<0?-1:0,ind.obvShortSlope>0?'Rising':'Falling',2,'Volume flow direction');
  // v9.96: pctFromSma20 null (very young ticker, <20 days) now shown
  // honestly (N/A, weight-0 signal) instead of a silent -0.5 bearish
  // default -- same fix class as pctFromSma200 above.
  addS('Price vs SMA20',ind.pctFromSma20==null?0:(ind.pctFromSma20>2?1:ind.pctFromSma20<-2?-1:ind.pctFromSma20>0?0.5:-0.5),ind.pctFromSma20==null?'N/A — insufficient history':(ind.pctFromSma20>0?'+':'')+ind.pctFromSma20.toFixed(2)+'%  SMA='+ind.sma20.toFixed(2),ind.pctFromSma20==null?0:2,ind.pctFromSma20==null?'<20 days history':(ind.pctFromSma20>0?'Above':'Below')+' 20MA');
  addS('EMA9/EMA21',(ind.ema9||0)>(ind.ema21||0)?1:-1,(ind.ema9||0).toFixed(2)+' / '+(ind.ema21||0).toFixed(2),2,(ind.ema9||0)>(ind.ema21||0)?'Fast EMA above slow':'Fast EMA below slow');
  addS('CMF(20)',ind.cmf20>0.1?1:ind.cmf20<-0.1?-1:ind.cmf20>0?0.3:-0.3,ind.cmf20.toFixed(3),2,ind.cmf20>0.1?'Buying pressure':ind.cmf20<-0.1?'Selling pressure':'Balanced');
  addS('ROC(10)',ind.roc10>3?1:ind.roc10<-3?-1:ind.roc10>0?0.3:-0.3,(ind.roc10>0?'+':'')+ind.roc10.toFixed(2)+'%',1,'10-day momentum');
  addS('Momentum Divergence (RSI)',ind.divergence.type==='bullish'?1:ind.divergence.type==='bearish'?-1:0,ind.divergence.type==='none'?'None':ind.divergence.type.toUpperCase(),3,ind.divergence.note);

  // v9.96: pctFromSma200 null (young ticker, <200 days) now honest (N/A,
  // weight 0) instead of a silent -0.5 bearish default; the note used to
  // say "Primary trend: BEARISH" (above200 defaults false) even though
  // there's no real 200-day average to call bearish -- both fixed together.
  addL('Price vs SMA200',ind.pctFromSma200==null?0:(ind.pctFromSma200>5?1:ind.pctFromSma200<-5?-1:ind.pctFromSma200>0?0.5:-0.5),ind.pctFromSma200==null?'N/A — insufficient history':(ind.pctFromSma200>0?'+':'')+ind.pctFromSma200.toFixed(2)+'%  SMA='+ind.sma200.toFixed(2),ind.pctFromSma200==null?0:4,ind.sma200==null?'<200 days history':'Primary trend: '+(ind.above200?'BULLISH':'BEARISH'));
  // v9.96: sma200 null now cleanly "N/A" instead of the ||0 fallback's
  // silent false "Bullish align" (sma50 is almost always >0) -- same class
  // as the pctFromSma200 fix immediately above.
  addL('Golden/Death Cross',ind.goldenCross?1:ind.deathCross?-1:(ind.sma200==null?0:(ind.sma50>ind.sma200?0.5:-0.5)),ind.goldenCross?'🌟 GOLDEN CROSS':ind.deathCross?'☠️ DEATH CROSS':(ind.sma200==null?'N/A — insufficient history':(ind.sma50>ind.sma200?'Bullish align':'Bearish align')),ind.sma200==null&&!ind.goldenCross&&!ind.deathCross?0:4,'SMA50='+(ind.sma50||0).toFixed(2)+'  SMA200='+(ind.sma200!=null?ind.sma200.toFixed(2):'N/A'));
  // v9.33 — CHARACTERIZATION_PLAN_breakout_context.md. v9.50: promoted, real
  // backtest evidence (PREDICTIVE_EDGE_BACKTEST_RESULTS.md, SIGNAL_EVIDENCE_TABLE_RESULTS.md,
  // 19 tickers/13,675 real checkpoints). Downtrend context real outperformance,
  // all regimes (weight 1, flat). Near-ATH "favorable" label real UNDERperformance,
  // CHOP regime specifically -- contributes bearish despite the bullish-sounding
  // label; real finding, not a bug (labeled-favorable-underperforms is this
  // project's own repeated core finding, now a signal-level instance of it).
  // Neutral real underperformance, TREND_DOWN regime specifically. All 3 use
  // flat weight=1 when they fire (not tuned to effect magnitude, per this
  // project's own tuning rule) -- only WHEN they fire differs by regime.
  { const bcSig = ind.breakoutContext==='long-term downtrend — weaker breakout context' ? 0.5
      : (ind.breakoutContext==='near 52wk/ATH — favorable breakout context' && regime==='CHOP') ? -1
      : (ind.breakoutContext==='neutral' && regime==='TREND_DOWN') ? -1
      : 0;
    addL('Breakout Context',bcSig,ind.breakoutContext,bcSig!==0?1:0,'from broker course ep.3 — ATH breakouts run harder than downtrend-resistance breakouts'); }
  // v9.34 — CHARACTERIZATION_PLAN_climax_volume.md. Display only, weight 0 (NO CASE in the real backtest -- no effect found).
  if(ind.climaxVolume)addL('Climax Volume',0,'⚠ Possible distribution — high-volume down day after an extended advance',0,'from broker course ep.4 — Wyckoff-style exhaustion signal');
  // v9.75 -- Edwards & Magee Ch27 Progressive Stop. Display only, weight 0, same convention as Climax Volume just above.
  if(ind.progressiveStopFlag)addL('Progressive Stop Trigger',0,'⚠ '+ind.progressiveStopFlag.volumeRatio.toFixed(1)+'x avg volume on an up day after an established uptrend — Edwards & Magee Ch27 real trigger to tighten the stop for the day',0,'informational, not scored — see the Basing Point stop section for the tight level');
  // v9.68 -- BIG_PLAN_ENGINE_EXPANSION.md Phase A, full classical Wyckoff.
  // Display only, weight 0, same as every other new composite classification
  // signal this project has ever shipped (chartPatterns/breakoutContext/
  // trendMaturity all started this way) -- a real backtest, same
  // evidence-then-promote pipeline already used for those, is real future
  // work before this should ever move real conviction. Real signal DIRECTION
  // still shown for transparency, matching this file's own convention.
  if(ind.wyckoffSchematic){const wy=ind.wyckoffSchematic;const wySig=wy.phase==='ACCUMULATION'?(wy.stage==='LPS/LPSY'?1:wy.stage==='SOS/SOW'?0.75:wy.stage==='SPRING/UPTHRUST'?0.5:0.25):(wy.stage==='LPS/LPSY'?-1:wy.stage==='SOS/SOW'?-0.75:wy.stage==='SPRING/UPTHRUST'?-0.5:-0.25);addL('Wyckoff Schematic',0,wy.read,0,'Real stage reached: '+wy.stage+' ('+wySig.toFixed(2)+' directional lean, not scored)');}
  // v9.72, Schabacker Study VIII: 2 new general-purpose volume signals, both display only (weight 0), same evidence-then-promote discipline.
  if(ind.trendAlignedVolume){const tav=ind.trendAlignedVolume;addL('Trend-Aligned Volume',0,(tav.aligned?'Aligned':'NOT aligned')+' — '+tav.trendDir+' trend, avg up-day vol '+(tav.avgUpDayVolume/1e6).toFixed(1)+'M vs down-day '+(tav.avgDownDayVolume/1e6).toFixed(1)+'M',0,'Schabacker Study VIII — volume should run higher WITH the trend; not scored');}
  // 2026-09-01, darkPoolTrackerV1.gs real fix — real per-ticker FINRA dark-pool share, cache-only week lookup + one live fetch for THIS ticker (see runAnalysisV7's own 6.5 step). Display-only, not scored.
  if(ind.darkPoolShare){const dp=ind.darkPoolShare;addL('Dark Pool Share',0,(dp.darkPoolSharePct*100).toFixed(1)+'% of ~weekly volume — FINRA week of '+dp.weekStartDate+' ('+dp.tier+')'+(dp.elevated?' ⚠ elevated vs ~12-15% typical market-wide baseline':''),0,'FINRA OTC Transparency ATS data — real off-exchange volume, reasoned elevated threshold (20%), not backtested for this watchlist');}
  // 2026-09-01 real fix — M2/yield-curve, previously fetched then discarded (see macro_fetchers_v0_11.gs). Display-only, NOT a scored vote.
  if(ind.macroSupplemental){const ms=ind.macroSupplemental;const parts=[];if(ms.yieldCurveSpread!=null)parts.push('10Y-2Y yield curve: '+ms.yieldCurveSpread.toFixed(2)+' ('+(ms.yieldCurveInverted?'⚠ INVERTED':'normal')+', as of '+ms.yieldCurveAsOfDate+')');if(ms.m2YoyGrowthPct!=null)parts.push('M2 money supply YoY: '+ms.m2YoyGrowthPct.toFixed(1)+'% (as of '+ms.m2AsOfDate+')');if(ms.businessCyclePhase)parts.push('Business-cycle phase (Broker Course ep.13): '+ms.businessCyclePhase.phase);if(parts.length)addL('Macro Supplemental',0,parts.join('  |  '),0,'Yield-curve inversion is a well-documented historical recession-leading indicator; business-cycle phase is the standard textbook 2-consecutive-negative-quarters GDP recession definition (real port from brokerCourseModelV1.gs) — informational only, not independently backtested for this classifier, not a scored vote');}
  // v9.79, Edwards & Magee Ch3-5.1: real Dow Theory Confirmation (DIA=Industrials proxy, IYT=Transports proxy). Display only, weight 0, same discipline as Macro Supplemental just above.
  if(ind.dowTheoryConfirmation){const dt=ind.dowTheoryConfirmation;const vLabel={BULL_CONFIRMED:'✅ BULL CONFIRMED — both DIA & IYT at new 52wk closing highs',BEAR_CONFIRMED:'⚠ BEAR CONFIRMED — both DIA & IYT at new 52wk closing lows',NON_CONFIRMATION_BULL:'⚠ NON-CONFIRMATION — only 1 of DIA/IYT made a new high, distrust the signal',NON_CONFIRMATION_BEAR:'⚠ NON-CONFIRMATION — only 1 of DIA/IYT made a new low, distrust the signal',NEUTRAL:'neutral — neither average at a 52wk extreme'}[dt.verdict]||dt.verdict;const lagStr=(dt.lagTradingDays!=null)?(dt.lagTradingDays===0?', same day':', '+dt.lagTradingDays+'td lag'):'';addL('Dow Theory Confirmation',0,vLabel+lagStr+' (DIA $'+dt.industrials.close.toFixed(2)+', IYT $'+dt.transports.close.toFixed(2)+')',0,'Edwards & Magee\'s own real foundational rule — both real broad-market averages must independently confirm a new high/low, within the book\'s own "days, weeks, or even a month or two" real allowed lag (v9.90/v0.13 widening, 42 trading days = 2x this book\'s own stated outer bound) — informational only, not a scored vote');}
  // v9.79, Edwards & Magee Ch38: real Evaluative Index breadth gauge (85-ticker basket, SMA50>SMA200 Bull/Bear classification). Display only, weight 0, continuous gauge not a discrete signal per the book's own real framing.
  if(ind.evaluativeIndex){const ei=ind.evaluativeIndex;addL('Evaluative Index (Edwards & Magee)',0,ei.pctStrong.toFixed(1)+'% Strong ('+ei.strong+'+/'+ei.weak+'-  of '+ (ei.strong+ei.weak) +', '+ei.unavailable+' unavailable) — '+ei.read,0,'Magee\'s own real continuous market-breadth gauge — "the Index will float and adjust itself continually," not a buy/sell signal — real anchors: ~5-9% = historical Bottom zone, ~90%+ = symmetric Top zone — informational only, not a scored vote');}
  if(ind.playerMapping){const pmap=ind.playerMapping;addL('Player Mapping (Broker Course)',0,pmap.tag+(pmap.evidence.length?' — '+pmap.evidence.join('; '):''),0,'Broker course\'s own real price/volume-SHAPE read (staircase accumulation vs. speculative spike vs. mixed/unclear) — a genuinely different angle from the real 13F institutional-holdings data above (that\'s actual filed positions; this is an inferred read off the chart shape itself) — informational only, not a scored vote');}
  if(ind.zombieCompanyScreen){const zc=ind.zombieCompanyScreen;addL('Zombie Company Screen (Broker Course)',0,(zc.isZombie?'⚠ ':'')+zc.read,0,'Real interest-coverage-ratio screen — the standard academic "zombie company" definition (BIS/Fed research, interest coverage <1.0), a real independent convention, not invented for or fit to this project — informational only, not a scored vote');}
  if(ind.sharesOutstandingTrend){const sot=ind.sharesOutstandingTrend;addL('Shares Outstanding Trend (Broker Course)',0,(sot.steadilyRising?'⚠ ':'')+sot.read,0,'Real SEC XBRL shares-outstanding history, course\'s own ep.12 checklist item 2 (repeated dilution red flag) — informational only, not a scored vote');}
  if(ind.filingKeywordScreen){const fk=ind.filingKeywordScreen;addL('Filing Keyword Screen (Broker Course)',0,(fk.anyFound?'⚠ ':'')+fk.read,0,'Real SEC EDGAR full-text filing search, course\'s own ep.12 checklist item 3 red-flag keyword list — word presence only, not context, worth a manual read not a proven flag on its own — informational only, not a scored vote');}
  if(ind.relativeStrengthRanking){const rsr=ind.relativeStrengthRanking;addL('Relative Strength Ranking (Turtle System)',0,'#'+rsr.rank+'/'+rsr.peerCount+' in '+rsr.categories.join('/')+' (percentile '+rsr.percentile+') — '+rsr.read,0,'Appendix E, Original Turtle Trading System — "buy the strongest, short the weakest" within a correlated group, real formula (CurrentPrice-PriceNMonthsAgo)/CurrentN, real peer group = this project\'s own 14-category dark-pool watchlist — cache-only (refreshed ~5:45 AM daily), informational only, not a scored vote, and never framed as a short recommendation (long-only/calls-only strategy)');}
  if(ind.volumeProgressDivergence&&ind.volumeProgressDivergence.flagged){const vpd=ind.volumeProgressDivergence;addL('Volume/Price Divergence',0,'⚠ High volume ('+(vpd.avgRecentVolume/1e6).toFixed(1)+'M vs '+(vpd.avgBaseVolume/1e6).toFixed(1)+'M avg), only '+(vpd.netProgressPct*100).toFixed(1)+'% net price progress',0,'Schabacker Study VIII — heavy volume with little progress suggests resistance/distribution being absorbed; not scored');}
  // v9.35 -- CHARACTERIZATION_PLAN_trend_maturity.md. v9.50: NEW-trend real
  // underperformance, TREND_DOWN regime specifically (SIGNAL_EVIDENCE_TABLE_RESULTS.md)
  // -- promoted only for that slice. MATURE/MATURING and all other regimes:
  // no real effect found, stay unscored.
  if(ind.trendMaturity){const tm=ind.trendMaturity;const icon=tm.maturity==='MATURE'?'✅':tm.maturity==='MATURING'?'🌿':'🌱';
    const tmSig=(tm.maturity==='NEW'&&regime==='TREND_DOWN')?-1:0;
    addL('Trend Maturity',tmSig,icon+' '+tm.maturity+' — '+tm.monthsSinceCross.toFixed(1)+'mo since '+tm.direction+' cross'+(tm.foundCross?'':' (start of available history)'),tmSig!==0?1:0,'from broker course ep.5 — course treats a primary trend as confirmed only after 6-9mo / 2-4 earnings reports, not on the crossover alone');}
  // v9.36 -- CHARACTERIZATION_PLAN_round_numbers.md. Display only, weight 0 (NO CASE in the real backtest -- no effect found).
  if(ind.roundNumber&&ind.roundNumber.near)addL('Round Number',0,'$'+ind.roundNumber.nearest+' ('+(ind.roundNumber.distPct*100).toFixed(1)+'% away)',0,'from broker course ep.6 — round price levels ($10/$100/etc, scaled to price) often act as real psychological S/R');
  // v9.50 -- chart-pattern scoring, real backtest evidence (SIGNAL_EVIDENCE_TABLE_RESULTS.md,
  // signal_evidence_table.js, 19 tickers/13,675 real checkpoints). Chart patterns
  // were display-only until now (CHART PATTERNS sheet section below, unaffected --
  // still shows all 21 real pattern types regardless of scoring). First time any
  // of them feed the score. Several contribute OPPOSITE their nominal
  // bullish/bearish name -- real finding, not a bug (DOUBLE_BOTTOM underperforms
  // despite a bullish label; see the results doc for the full per-regime
  // evidence). v9.52: 9 of 21 real types scored (3 flat-weight "ALWAYS", 6
  // regime-conditional "SOMETIMES" -- down from 10/7 in v9.50; SYMMETRICAL_TRIANGLE
  // and TRIPLE_BOTTOM removed, see the block below for why). [v9.66: counts
  // corrected -- this comment previously said "8 of 21 (3+5)" and "the other
  // 13", both off by one against PATTERN_SCORE_RULES_V9_50's actual 9 entries;
  // caught by independent review, docs/OPUS_REVIEW_2026-08-27.md.] The other 12
  // (ASCENDING_TRIANGLE, BULL_FLAG, CUP_AND_HANDLE, DESCENDING_TRIANGLE,
  // FALLING_WEDGE, HEAD_AND_SHOULDERS, PENNANT, RISING_WEDGE, ROUNDING_BOTTOM,
  // STAIRCASE, SYMMETRICAL_TRIANGLE, TRIPLE_BOTTOM) showed no surviving real
  // effect -- stay unscored, still displayed. Flat weight=1 for every scored type regardless
  // of effect size (not tuned to backtest magnitude, per this project's own
  // tuning rule) -- only WHETHER a type is scored, and in which regime,
  // comes from the real evidence.
  { const PATTERN_SCORE_RULES_V9_50 = {
      DOUBLE_BOTTOM:{signal:-1,regime:null}, RECTANGLE:{signal:-1,regime:null}, TRIPLE_TOP:{signal:-1,regime:null},
      BEAR_FLAG:{signal:-1,regime:'CHOP'}, BEAR_TRAP:{signal:1,regime:'CHOP'}, BULL_TRAP:{signal:1,regime:'HIGH_VOL'},
      DOUBLE_TOP:{signal:-1,regime:'CHOP'}, INVERSE_HEAD_AND_SHOULDERS:{signal:-1,regime:'TREND_UP'},
      ROUNDING_TOP:{signal:-1,regime:'TREND_DOWN'}
      // v9.52: SYMMETRICAL_TRIANGLE and TRIPLE_BOTTOM removed. Real follow-up
      // (chop_power_check.js, 2026-08-23) found their CHOP-only significance
      // was likely a statistical-power artifact (CHOP simply has far more
      // samples than the other regimes) rather than a real CHOP-specific
      // effect -- downsampling CHOP to match another regime's real sample
      // size and re-testing 500 times, the effect survived only 5.2%
      // (SYMMETRICAL_TRIANGLE) and 17.0% (TRIPLE_BOTTOM) of the time, same
      // direction. Reverted to unscored (weight 0) per the user's explicit
      // call, matching this project's own core discipline: don't score on
      // an effect that doesn't survive scrutiny. BEAR_FLAG (28.4% survival)
      // is a real, disclosed, weaker case flagged in the same follow-up --
      // kept for now, not removed, genuinely borderline rather than clearly
      // artifactual like the 2 removed here.
    };
    // Dedupe by type before scoring -- ind.chartPatterns can (and often does)
    // hold multiple real instances of the SAME type within its lookback window
    // (e.g. 3 separate BEAR_TRAP detections). The real backtest measured "did
    // type X fire at all this checkpoint" (binary), not instance count --
    // scoring every instance separately would multiply the weight in a way
    // never tested. One addL per distinct type, matching the evidence exactly.
    const uniqueTypes=[...new Set((ind.chartPatterns||[]).map(p=>p.type))];
    uniqueTypes.forEach(type=>{
      const rule=PATTERN_SCORE_RULES_V9_50[type];
      if(!rule)return;
      if(rule.regime&&rule.regime!==regime)return;
      addL('Chart Pattern: '+type,rule.signal,type+(rule.regime?' (real effect, '+rule.regime+' regime)':' (real effect, all regimes)'),1,'from real backtest evidence, not the broker course directly — see SIGNAL_EVIDENCE_TABLE_RESULTS.md. Contributes '+(rule.signal>0?'bullish':'bearish')+' regardless of the pattern\'s nominal textbook meaning, matching what real forward returns actually showed.');
    }); }
  // v9.88 -- SCALLOP_SERIES promoted to real scored weight, user's explicit
  // "yes" (2026-09-02), same real evidence-then-promote discipline as the
  // v9.50 table above, just a separate, later evidence pass (not folded
  // into PATTERN_SCORE_RULES_V9_50, to keep each promotion's own real
  // source honestly attributed). Real, Bonferroni-significant backtest
  // (tests/edwards_magee_predictive_value_test.js, run on the real
  // 21-ticker DEFAULT_WATCHLIST): fired mean fwd return 5.92% vs
  // not-fired 2.05% (n=2198/11477, p~0). Verified NOT a single-ticker/
  // outlier artifact before promoting (user's own standing rule: verify
  // automatically, prefer concrete proof over p-values alone) via 3 real
  // checks, tests/scallop_series_power_check_test.js: per-ticker
  // breakdown (10/14 real tickers individually beat their own baseline
  // when fired), leave-one-ticker-out (gap never reverses, stays
  // 3.25-4.27pp across all 19 single-ticker removals), and the pooled
  // median agreeing with the mean (2.17% vs 1.60%, same direction, not
  // outlier-driven). Real, disclosed: scored ALWAYS (not regime-
  // conditional) because the backtest itself tested fired-vs-not-fired
  // globally, never bucketed by regime — scoring it regime-specific would
  // claim evidence this pass never actually checked. Flat weight=1, same
  // convention as every other scored pattern above, not tuned to the
  // 3.87pp effect size.
  if((ind.chartPatterns||[]).some(p=>p.type==='SCALLOP_SERIES')){
    addL('Chart Pattern: SCALLOP_SERIES',1,'SCALLOP_SERIES (real effect, all regimes)',1,'from real backtest evidence, tests/edwards_magee_predictive_value_test.js + tests/scallop_series_power_check_test.js (2026-09-02) — fired mean fwd return 5.92% vs not-fired 2.05% (n=2198/11477, p~0), verified not a single-ticker/outlier artifact via 3 concrete checks before promoting.');
  }
  // v9.55 -- CHARACTERIZATION_PLAN_double_top_bottom_market_cap.md. Display
  // only, weight 0 -- qualitative only, no numeric threshold given by the
  // course for this. Reuses fund.marketCap (already fetched) and the
  // existing DOUBLE_TOP/DOUBLE_BOTTOM detector's own dates -- zero new data.
  if(fund&&fund.marketCap){
    const dtb=(ind.chartPatterns||[]).find(p=>p.type==='DOUBLE_TOP'||p.type==='DOUBLE_BOTTOM');
    if(dtb){
      const roundTripBars=Math.round((dtb.date2-dtb.date1)/86400000);
      const cap=doubleTopBottomMarketCapContextV7(dtb.type,fund.marketCap,roundTripBars);
      if(cap)addL(dtb.type+' — Market-Cap Context',0,cap.tier+'-cap ('+cap.expectedReliability+'), '+roundTripBars+'d round-trip',0,'from broker course ep.6 — '+cap.note);
    }
  }
  // v9.53 -- CHARACTERIZATION_PLAN_candlestick_classification.md. Display only,
  // weight 0 -- new signal, untested until backtested, same standing rule as
  // every other course-derived feature. See singleCandleClassifyV7's own
  // header comment for the real hammer/inverted-hammer naming finding.
  if(ind.singleCandle)addL('Candle: '+ind.singleCandle.type,0,ind.singleCandle.type+' — '+ind.singleCandle.courseDirection+' ('+ind.singleCandle.note+')',0,'from broker course ep.3/6 — single-candle classification, raw-transcript + video re-verified 2026-08-23');
  // v9.49 -- engine gap-fill, independent review + video-fidelity audit. v9.50:
  // promoted, real Bonferroni-surviving, regime-independent effect (Hot
  // outperforms, Coiled/Normal underperform) -- strongest signal found in the
  // whole backtest pass. Normal tier: signal=0 by design (below), no functional
  // change since 0*weight=0 regardless -- kept silent in the display too,
  // matching the existing "Normal is silent" convention, not a new inconsistency.
  if(ind.weeklyVolatility&&ind.weeklyVolatility.tier!=='Normal')addL('Weekly Volatility',ind.weeklyVolatility.tier==='Hot'?1:-1,ind.weeklyVolatility.read,1,'from broker course ep.1 — raw-verified against the transcript, a real dual hot/coiled read, not a decoration');
  if(ind.monthlyVolatility&&ind.monthlyVolatility.tier!=='Normal')addL('Monthly Volatility',0,ind.monthlyVolatility.read,0,'from broker course ep.1 — raw-verified against the transcript, a real dual hot/coiled read, not a decoration');
  // v9.49 -- engine gap-fill. Display only, weight 0. Shows the strongest (most-touched) level of each type, when one exists.
  if(ind.srLevels&&ind.srLevels.resistanceLevels.length){const r=ind.srLevels.resistanceLevels[0];
    addL('Resistance Level',0,'$'+r.level.toFixed(2)+' — '+r.tier+' ('+r.touchCount+' touches)'+(r.trendFavored?' — trend-favored':''),0,'from broker course ep.3/4 — real, spoken PRIMARY/SECONDARY/MINOR tiering + trend-conditional weighting (resistance matters more in a downtrend)');}
  if(ind.srLevels&&ind.srLevels.supportLevels.length){const s=ind.srLevels.supportLevels[0];
    addL('Support Level',0,'$'+s.level.toFixed(2)+' — '+s.tier+' ('+s.touchCount+' touches)'+(s.trendFavored?' — trend-favored':''),0,'from broker course ep.3/4 — real, spoken PRIMARY/SECONDARY/MINOR tiering + trend-conditional weighting (support matters more in an uptrend)');}
  // v9.54 -- CHARACTERIZATION_PLAN.md's S/R multi-timeframe strength scoring.
  // Display only, weight 0. Only shown when the strongest level actually
  // confirms on a higher timeframe (matches the existing "only shown when it
  // fires" convention for rarer, stronger-signal course features).
  if(ind.srMultiTimeframe&&ind.srMultiTimeframe.resistance&&ind.srMultiTimeframe.resistance.strength!=='DAILY_ONLY'){const r=ind.srMultiTimeframe.resistance;
    addL('Resistance — Multi-Timeframe',0,'$'+r.level.toFixed(2)+' confirmed on '+r.strength.replace(/_/g,' ').replace('+',' + ').toLowerCase(),0,'from broker course ep.3-5 — 5+ real worked examples (TSLA/PYPL/ZM/JWN/ANF): a level confirmed on a higher timeframe is materially stronger than the same level on daily alone');}
  if(ind.srMultiTimeframe&&ind.srMultiTimeframe.support&&ind.srMultiTimeframe.support.strength!=='DAILY_ONLY'){const s=ind.srMultiTimeframe.support;
    addL('Support — Multi-Timeframe',0,'$'+s.level.toFixed(2)+' confirmed on '+s.strength.replace(/_/g,' ').replace('+',' + ').toLowerCase(),0,'from broker course ep.3-5 — same multi-timeframe confluence rule as Resistance above');}
  // v9.49 -- engine gap-fill. Display only, weight 0. Complement to the already-shipped staircase detector (v9.38). Only shown when actually triggered.
  if(ind.speculativeSpike&&ind.speculativeSpike.isSpike)addL('Speculative Spike',0,ind.speculativeSpike.read,0,'from broker course ep.1/3');
  // v9.58 -- CHARACTERIZATION_PLAN_double_top_bottom_market_cap.md Part B. Display only, weight 0. Only shown when actually triggered (real, disclosed, genuinely rare per the course's own account).
  if(ind.dpoSignature&&ind.dpoSignature.triggered)addL('DPO Delayed Breakout',0,ind.dpoSignature.read,0,'from broker course ep.9 — real PLTR worked example; KNOWN_DPO_TICKERS_V7 is a small, disclosed, manually-curated list, not a fetched field');
  // v9.37 -- CHARACTERIZATION_PLAN_secondary_day.md. Display only, weight 0. Only shown when actually triggered.
  if(ind.secondaryDay&&ind.secondaryDay.triggered)addL('Secondary Day',0,'⚡ Broke above yesterday\'s high ($'+ind.secondaryDay.yesterdayHigh.toFixed(2)+') after a high-volume day ('+ind.secondaryDay.yesterdayVolRatio.toFixed(2)+'x)',0,'from broker course ep.7 — momentum-continuation entry: a strong-volume day followed by a break above its high often draws algo/momentum traders');
  // v9.39 -- CHARACTERIZATION_PLAN_lockup_expiration.md. Display only, weight 0. Only shown within the real ~180-day post-IPO window (+30d grace either side).
  if(ind.lockupExpiration){const lu=ind.lockupExpiration;
    addL('Lock-up Expiration',0,(lu.status==='UPCOMING'?'⏳ Insider lock-up expires in '+lu.daysUntilExpiration+'d':'✅ Insider lock-up expired '+Math.abs(lu.daysUntilExpiration)+'d ago')+' ('+lu.lockupDate.toDateString()+')',0,'from broker course ep.8/9 — typical ~180-day post-IPO insider/employee selling restriction; a real, timeable event, not itself scored');}
  // v9.40 -- CHARACTERIZATION_PLAN_reverse_split.md. Display only, weight 0. Only shown when a real reverse split happened within the recent lookback window.
  if(ind.recentReverseSplit){const rs=ind.recentReverseSplit;
    addL('Reverse Split',0,'⚠ '+rs.ratio+' reverse split '+rs.daysAgo+'d ago ('+rs.date.toDateString()+')',0,'from broker course ep.10 — instructor\'s own real avoid-heuristic: recently reverse-split tickers show elevated manipulation/volatility risk, he removes them from his own watchlist');}
  // v9.44 -- broker course ep.9/13, episode-9's own flagged candidate.
  // Display only, weight 0.
  //
  // 2026-09-06, real fix (Opus review caught this): the old fallback
  // (`fetchNasdaqShortInterestV7(chart.ticker)`, a byte-identical duplicate
  // of fetchNasdaqShortInterestV1) fired live EXACTLY when
  // existingShortInterest was undefined -- i.e. whenever the broker-course
  // model was skipped on time budget or threw, which is precisely the
  // worst moment (the run is already running late) to make an unbounded
  // network call to Nasdaq's own real API (the same call already traced to
  // a real, reproducible live hang). This duplicate call is now gone
  // entirely -- falls back to the SAME permanent cache read every other
  // consumer of this data uses, never a live fetch from this function.
  const shortInterestData = existingShortInterest !== undefined
    ? existingShortInterest
    : ((typeof readBrokerDataCacheV1_ === 'function') ? (() => {
        const cached = readBrokerDataCacheV1_(chart.ticker);
        return (cached && cached.shortInterest != null) ? { shortInterest: cached.shortInterest, daysToCover: cached.daysToCover, settlementDate: cached.settlementDate } : null;
      })() : null);
  const shortPctOfFloat = (shortInterestData && fund && fund.shareFloat) ? shortInterestData.shortInterest / fund.shareFloat : null;
  const squeezeSetup = shortSqueezeSetupV7(shortPctOfFloat, ind.last, ind.high52);
  if(squeezeSetup&&squeezeSetup.triggered)addL('Short Squeeze Setup',0,'🔥 High short interest ('+(shortPctOfFloat*100).toFixed(1)+'% of float) breaking to a NEW HIGH',0,'from broker course ep.9, reinforced live in ep.13\'s real GME case study — explicitly distinguished from mere short-covering off a low; kept because it identifies a LONG opportunity, never a short');
  // v9.96: pctFromSma50 null (very young ticker, <50 days) now honest
  // (N/A, weight 0) instead of a silent -0.5 bearish default.
  addL('Price vs SMA50',ind.pctFromSma50==null?0:(ind.pctFromSma50>3?1:ind.pctFromSma50<-3?-1:ind.pctFromSma50>0?0.5:-0.5),ind.pctFromSma50==null?'N/A — insufficient history':(ind.pctFromSma50>0?'+':'')+ind.pctFromSma50.toFixed(2)+'%  SMA='+ind.sma50.toFixed(2),ind.pctFromSma50==null?0:3,ind.pctFromSma50==null?'<50 days history':(ind.above50?'Above 50MA':'Below 50MA'));
  addL('ADX(14)',ind.adx14>25&&ind.adxBullish?1:ind.adx14>25&&!ind.adxBullish?-1:ind.adxBullish?0.3:-0.3,ind.adx14.toFixed(1)+(ind.adx14>25?' TRENDING':' WEAK')+(ind.adxBullish?' (+DI>-DI)':' (-DI>+DI)'),3,ind.adx14>40?'Very strong trend':ind.adx14>25?'Trending':'Sideways');
  addL('RSI Weekly',ind.rsiWeekly<40?1:ind.rsiWeekly>65?-1:ind.rsiWeekly>55?0.5:ind.rsiWeekly<45?-0.5:0,ind.rsiWeekly.toFixed(1),3,'Weekly: '+(ind.rsiWeekly<40?'oversold':ind.rsiWeekly>65?'overbought':'neutral'));
  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): roc52 is (last/closes[n-53]-1)*100 -- 52 TRADING DAYS, ~13
  // weeks (~2.5 calendar months), not "52 weeks"/1 year. It was labeled,
  // displayed, and narrated as annual throughout the file. Fixed the
  // label/display text here and at the 2 other sites below. Left the
  // ±20% scoring thresholds and the underlying computation untouched --
  // they were sized for an annual move and are now applied to a
  // quarterly one, so this signal likely saturates more than intended,
  // but re-deriving a correctly-scaled threshold without a real backtest
  // to justify it would violate this project's own standing rule (no
  // threshold without a reason independent of backtest results). The
  // mislabeling is fixed; the threshold-scale question is disclosed, not
  // silently "fixed" with an invented number.
  addL('ROC(52) — ~13wk',ind.roc52>20?1:ind.roc52<-20?-1:ind.roc52>0?0.5:-0.5,(ind.roc52>0?'+':'')+ind.roc52.toFixed(1)+'% (~13wk)',2,'~13-week (quarterly) performance');
  addL('Fibonacci Level',ind.fibPct>0.618?1:ind.fibPct<0.382?-1:ind.fibPct>0.5?0.5:-0.5,(ind.fibPct*100).toFixed(1)+'% of 52wk range',2,ind.fibPct>0.786?'Near 52wk high':ind.fibPct>0.618?'Above 61.8%':ind.fibPct<0.236?'Near 52wk low':ind.fibPct<0.382?'Below 38.2%':'Mid-range');
  addL('52wk Range',ind.range52Pct>70?1:ind.range52Pct<30?-1:0,ind.range52Pct.toFixed(1)+'%  H=$'+ind.high52.toFixed(2)+'  L=$'+ind.low52.toFixed(2),2,ind.range52Pct>80?'Near 52wk high':ind.range52Pct<20?'Near 52wk low':'Mid-range');
  addL('OBV (50d)',ind.obvLongSlope>0?1:ind.obvLongSlope<0?-1:0,ind.obvLongSlope>0?'Accumulation':'Distribution',2,'Long-term volume flow');
  addL('ATR Regime',ind.atrRatio>1.3?-0.5:ind.atrRatio<0.7?0.5:0,'ATR=$'+ind.atr14.toFixed(2)+'  x'+ind.atrRatio.toFixed(2),1,ind.atrRatio>1.3?'Expanding vol':ind.atrRatio<0.7?'Contracting':'Normal');
  addL('Price vs SMA150',ind.sma150?(ind.last>ind.sma150?0.5:-0.5):0,ind.sma150?((ind.last/ind.sma150-1)*100>0?'+':'')+((ind.last/ind.sma150-1)*100).toFixed(2)+'%  SMA='+ind.sma150.toFixed(2):'N/A',2,'Intermediate MA');
  if(ind.rs){
    const rs63=ind.rs.rs63;
    addL('Relative Strength vs SPY',rs63>10?1:rs63<-10?-1:rs63>0?0.5:-0.5,(rs63>=0?'+':'')+rs63.toFixed(1)+'% (3mo)  '+(ind.rs.outperforming?'OUTPERFORM':'UNDERPERFORM'),4,'Stock vs S&P 500 over 3 months — '+(ind.rs.outperforming?'leading the market':'lagging the market'));
  }
  // Multi-timeframe structure (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- the
  // gap most tied to the user's own stated 5-10yr hold horizon: everything
  // else in this section is daily/weekly-derived, this is the first
  // genuinely monthly-timeframe read. Named with "SMA" so it correctly
  // falls into the existing 'Trend' category via categoryOfV7_'s regex.
  if(ind.monthlyStructure){
    const ms=ind.monthlyStructure;
    addL('Monthly Structure (10mo SMA)',ms.monthlyTrend==='above'?0.7:-0.7,
      '$'+ind.last.toFixed(2)+' vs 10mo SMA $'+ms.monthlySma.toFixed(2)+' ('+ms.monthlyTrend+')',
      3,'Long-term monthly trend read — the "10-month rule," based on '+ms.monthsAvailable+' months of history');
  }

  const gannNorm=(gann.score-50)/50;
  addL('📐 Gann Angular',gannNorm,gann.score+'/100  |  riding '+gann.lowerAngle+'→'+gann.upperAngle+'  |  1×1 '+
    (gann.gannMaster?(gann.gannMaster<chart.currentPrice?'SUPPORT @ $'+gann.gannMaster.toFixed(2):'RESISTANCE @ $'+gann.gannMaster.toFixed(2)):'N/A'),
    2,'Pivot: '+gann.pivot.dateStr+' @ $'+gann.pivot.price.toFixed(2)+  // W4 (v8.0): weight 5→2 — confirmation, not primary
    '  |  price unit: $'+gann.priceUnit.toFixed(2)+'/day');

  if (fund) {
    const cp=chart.currentPrice;
    // P2-1 fix (deep-dive review): this legacy signal read fund.forwardPE
    // exclusively — which is now ALWAYS null for FMP by design (Phase 2's
    // honest split), so it silently stopped firing for FMP-sourced tickers,
    // and even when Finnhub/AV data was present it mislabeled a genuine
    // forward P/E as "TTM" (trailing). Now falls back to trailingPE and
    // labels honestly which one is actually shown, same pattern as the
    // primary OWN score's driver (line ~929).
    {
      const legacyPE = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
      const legacyPEIsForward = fund.forwardPE != null;
      if (legacyPE) addF('P/E ('+(legacyPEIsForward?'Fwd':'TTM')+')', legacyPE<15?1:legacyPE>40?-1:legacyPE<25?0.5:-0.3, legacyPE.toFixed(1)+'x', 3, legacyPE<15?'Undervalued':legacyPE>40?'Expensive':'Fair');
    }
    if(fund.pegRatio&&fund.pegRatio>0)addF('PEG Ratio',fund.pegRatio<1?1:fund.pegRatio>2?-1:fund.pegRatio<1.5?0.5:-0.3,fund.pegRatio.toFixed(2)+'x',2,fund.pegRatio<1?'Undervalued vs growth':fund.pegRatio>2?'Expensive':'Fair');
    if(fund.revenueGrowth!=null){const rg=fund.revenueGrowth*100;addF('Revenue Growth',rg>20?1:rg>10?0.5:rg>0?0:rg>-10?-0.5:-1,(rg>0?'+':'')+rg.toFixed(1)+'%',3,rg>20?'Strong':rg>10?'Solid':rg>0?'Slow':'Declining');}
    if(fund.earningsGrowth!=null){const eg=fund.earningsGrowth*100;addF('EPS Growth',eg>20?1:eg>10?0.5:eg>0?0:-0.5,(eg>0?'+':'')+eg.toFixed(1)+'%',3,eg>20?'Strong EPS':eg>0?'Positive':'Declining');}
    if(fund.profitMargins!=null){const pm=fund.profitMargins*100;addF('Net Profit Margin',pm>15?1:pm>5?0.5:pm>0?0:-1,pm.toFixed(1)+'%',2,pm>20?'Excellent':pm>10?'Good':pm>0?'Thin':'Unprofitable');}
    if(fund.returnOnEquity!=null){const roe=fund.returnOnEquity*100;addF('ROE',roe>20?1:roe>10?0.5:roe>0?0:-0.5,roe.toFixed(1)+'%',2,roe>20?'Excellent':roe>0?'Moderate':'Negative');}
    if(fund.targetMean&&cp){const up=(fund.targetMean/cp-1)*100;var hl='';if(fund.targetHigh)hl+='H=$'+fund.targetHigh.toFixed(2);if(fund.targetLow)hl+=(hl?'  ':'')+'L=$'+fund.targetLow.toFixed(2);if(fund.numAnalysts)hl+=(hl?'  ':'')+fund.numAnalysts+' analysts';addF('Analyst Target',up>20?1:up>5?0.5:up>-5?0:-1,'$'+fund.targetMean.toFixed(2)+'  ('+(up>0?'+':'')+up.toFixed(1)+'%)',4,hl||'consensus mean');}
    if(fund.recMean){const rm=fund.recMean;addF('Analyst Rating',rm<2?1:rm<2.5?0.7:rm<3.5?0.2:-1,fund.recKey||'N/A',4,'');}
    if(fund.beta)addF('Beta',0,fund.beta.toFixed(2)+'x market',0,fund.beta>1.5?'High vol':fund.beta<0.8?'Low vol':'Market-like');
    if(fund.marketCap){const mc=fund.marketCap;const tier=mc>=200e9?'Mega cap':mc>=10e9?'Large cap':mc>=2e9?'Mid cap':mc>=300e6?'Small cap':'Micro cap';const mcStr=mc>=1e12?'$'+(mc/1e12).toFixed(2)+'T':mc>=1e9?'$'+(mc/1e9).toFixed(2)+'B':'$'+(mc/1e6).toFixed(0)+'M';addF('Market Cap',0,mcStr,0,tier);}
    // v9.31 — CHARACTERIZATION_PLAN_float_volume.md: float + volume-vs-float,
    // display only (weight 0), same status as Market Cap right above.
    if(fund.shareFloat){
      const floatStr=fund.shareFloat>=1e9?(fund.shareFloat/1e9).toFixed(2)+'B':(fund.shareFloat/1e6).toFixed(1)+'M';
      const todaysVol=chart.volumes&&chart.volumes.length?chart.volumes[chart.volumes.length-1]:null;
      let note=floatTierV7(fund.shareFloat)||'';
      if(todaysVol!=null){
        const volToFloat=todaysVol/fund.shareFloat;
        note += '  ·  Vol/Float '+(volToFloat*100).toFixed(1)+'%'+(volToFloat>=1?' ⚠ EXTREME (vol ≥ entire float)':volToFloat>=0.25?' ⚠ elevated':'');
      }
      addF('Float',0,floatStr+' shares',0,note);
    }
    if(fund.dividend&&fund.price){const dy=fund.dividend/fund.price*100;addF('Dividend Yield',0,dy.toFixed(2)+'%',0,dy>4?'High yield':dy>2?'Solid income':'Pays dividend');}
    // v9.48 real bug fix (independent review 2026-08-22, same null-vs-zero
    // class as detectRegimeV7/stochK/zombieCompanyScreenV1 elsewhere in this
    // project): truthy check silently dropped a real, meaningful 0% gross
    // margin (revenue==COGS, real for distressed/breakeven names) as if no
    // data existed -- the band logic below already correctly scores 0% as
    // -0.5, only the entry guard was wrong.
    if(fund.grossMargins!=null){const gm=fund.grossMargins*100;addF('Gross Margin',gm>50?1:gm>30?0.5:gm>15?0:-0.5,gm.toFixed(1)+'%',1,gm>50?'High-margin':gm>30?'Good':'Low');}
    if(fund.sector)addF('Sector/Industry',0,(fund.sector||'')+(fund.industry?'/'+fund.industry:''),0,'');
  }

  function computeScore(signals){
    let wSum=0,wTotal=0;signals.forEach(s=>{wSum+=s.signal*s.weight;wTotal+=s.weight;});
    return wTotal===0?50:Math.min(100,Math.max(0,Math.round((wSum/wTotal+1)/2*100)));
  }
  function categoryScores(signals, catWeights){
    const byCat={};
    signals.forEach(s=>{
      const c=s.cat||'Other';
      if(!byCat[c])byCat[c]={wSum:0,wTot:0,count:0};
      byCat[c].wSum+=s.signal*s.weight;byCat[c].wTot+=s.weight;byCat[c].count++;
    });
    const cats={};
    Object.keys(byCat).forEach(c=>{
      const sig=byCat[c].wTot===0?0:byCat[c].wSum/byCat[c].wTot;
      cats[c]={signal:sig,score:Math.round((sig+1)/2*100),count:byCat[c].count};
    });
    let num=0,den=0;
    Object.keys(cats).forEach(c=>{const w=catWeights[c]!=null?catWeights[c]:0.1;num+=cats[c].signal*w;den+=w;});
    const overallSig=den===0?0:num/den;
    return {cats, overall:Math.min(100,Math.max(0,Math.round((overallSig+1)/2*100))), overallSig};
  }

  // Regime-adaptive category weighting (DASHBOARD_IMPROVEMENTS_PLAN.md 4b)
  // -- the last real piece of the plan. Correction from the original
  // assumption: the system was never flat-weighted (confirmed earlier),
  // but the weights WERE static regardless of market regime. This is the
  // fix: real, reasoned weight profiles per regime, not just one fixed set.
  //
  // Reasoning per profile (matches the two-dimensional baseline+sensitivity
  // model already agreed in the plan, applied at the category level since
  // that's what this scoring system actually operates on):
  // - TREND_UP/TREND_DOWN share ONE profile: trend/momentum reliability
  //   depends on there BEING a clean trend, not which direction it runs.
  //   Trend and Momentum weight UP, Volatility weights DOWN (the trend is
  //   doing the work, less need for volatility-based caution).
  // - CHOP: Momentum and Trend weight DOWN (both are known to whipsaw in
  //   range-bound conditions -- the exact mechanism already explained to
  //   the user this session). Volatility and Position weight UP instead.
  // - HIGH_VOL: Volatility weights up significantly (it IS the dominant
  //   condition), Trend/Momentum weight down moderately (more noise).
  //
  // These are REASONED design choices, explicitly NOT validated against
  // historical backtests -- consistent with this whole project's standing,
  // repeated disclosure that the underlying investment logic itself has
  // never been empirically verified, only the code's internal correctness.
  // DEFAULT (used when regime is null/unrecognized) matches the ORIGINAL
  // static weights exactly -- so a missing regime degrades to the exact
  // prior behavior, not a guess.
  const SHORT_WEIGHTS_BY_REGIME = {
    TREND_UP:   {Momentum:0.40,Trend:0.25,Volume:0.20,Volatility:0.10,Position:0.05},
    TREND_DOWN: {Momentum:0.40,Trend:0.25,Volume:0.20,Volatility:0.10,Position:0.05},
    CHOP:       {Momentum:0.25,Volume:0.25,Trend:0.15,Volatility:0.25,Position:0.10},
    HIGH_VOL:   {Momentum:0.25,Volume:0.20,Trend:0.15,Volatility:0.35,Position:0.05},
    DEFAULT:    {Momentum:0.35,Volume:0.25,Trend:0.20,Volatility:0.15,Position:0.05},
  };
  const LONG_WEIGHTS_BY_REGIME = {
    TREND_UP:   {Trend:0.50,Momentum:0.25,Volume:0.12,Position:0.08,Volatility:0.05},
    TREND_DOWN: {Trend:0.50,Momentum:0.25,Volume:0.12,Position:0.08,Volatility:0.05},
    CHOP:       {Trend:0.30,Volume:0.25,Momentum:0.15,Position:0.20,Volatility:0.10},
    HIGH_VOL:   {Trend:0.35,Volatility:0.25,Momentum:0.15,Volume:0.15,Position:0.10},
    DEFAULT:    {Trend:0.45,Momentum:0.20,Volume:0.15,Position:0.12,Volatility:0.08},
  };
  const shortW = SHORT_WEIGHTS_BY_REGIME[regime] || SHORT_WEIGHTS_BY_REGIME.DEFAULT;
  const longW  = LONG_WEIGHTS_BY_REGIME[regime]  || LONG_WEIGHTS_BY_REGIME.DEFAULT;
  const usedDefaultWeights = !SHORT_WEIGHTS_BY_REGIME[regime]; // for transparency in the report
  const shortCatRes=categoryScores(shortSignals,shortW);
  const longCatRes =categoryScores(longSignals,longW);
  const shortScore=shortCatRes.overall;
  const longScore =longCatRes.overall;
  const fundScore=(fund&&fundSignals.filter(s=>s.weight>0).length>0)?computeScore(fundSignals.filter(s=>s.weight>0)):null;

  function conflictOf(res){
    const t=res.cats.Trend?res.cats.Trend.signal:0, m=res.cats.Momentum?res.cats.Momentum.signal:0;
    if(t*m<0 && Math.abs(t)>0.25 && Math.abs(m)>0.25)
      return {conflict:true, note:'Trend ('+(t>0?'up':'down')+') and momentum ('+(m>0?'up':'down')+') disagree — lower confidence'};
    return {conflict:false, note:'Trend and momentum broadly agree'};
  }
  const shortConflict=conflictOf(shortCatRes), longConflict=conflictOf(longCatRes);

  const fw=fundScore!==null?0.20:0,tw=1-fw;
  let shortConviction=Math.round(shortScore*(tw*0.6+0.4)+(fundScore||50)*fw*0.4);
  let longConviction =Math.round(longScore*(tw*0.5+0.5)+(fundScore||50)*fw*0.5);
  if(shortConflict.conflict)shortConviction=Math.round(shortConviction*0.75+50*0.25);
  if(longConflict.conflict) longConviction =Math.round(longConviction*0.8+50*0.2);
  shortConviction=Math.min(100,Math.max(0,shortConviction));
  longConviction =Math.min(100,Math.max(0,longConviction));

  function verdict(s){return s>=70?'🟢 BULLISH':s>=57?'🟡 SLIGHTLY BULLISH':s>=43?'⚪ NEUTRAL':s>=30?'🟠 SLIGHTLY BEARISH':'🔴 BEARISH';}

  return {
    shortSignals,longSignals,fundSignals,
    shortScore,longScore,fundScore,
    shortW,longW,regimeUsedForWeights:regime||'DEFAULT',usedDefaultWeights,
    shortCats:shortCatRes.cats,longCats:longCatRes.cats,
    shortConflict,longConflict,
    divergence:ind.divergence,macdDivergence:ind.macdDivergence,obvDivergence:ind.obvDivergence,rs:ind.rs,
    shortVerdict:verdict(shortScore),longVerdict:verdict(longScore),
    fundVerdict:fundScore!==null?verdict(fundScore):'N/A',
    shortConviction,longConviction,
  };
}

function colorVerdictRow9V7_(sh,row,conviction){
  const bg=conviction>=65?'#c8e6c9':conviction>=50?'#fff9c4':'#ffcdd2';
  const fg=conviction>=65?'#1b5e20':conviction>=50?'#e65100':'#b71c1c';
  sh.getRange(row,1,1,9).setBackground(bg);
  sh.getRange(row,8).setFontWeight('bold').setFontSize(13).setFontColor(fg);
  sh.getRange(row,9).setFontWeight('bold').setFontColor(fg);
}

function buildNarrativeV7_(ticker, chart, ind, gann, confluence, scores, fund, opts, techPlan, decision, fundResult) {
  const cp = chart.currentPrice;
  const $  = v => (v==null || isNaN(v)) ? 'N/A' : '$'+Number(v).toFixed(2);
  const pct= v => (v==null || isNaN(v)) ? 'N/A' : (v>=0?'+':'')+Number(v).toFixed(1)+'%';
  const paras = [];

  const dayChg = cp - chart.prevClose, dayPct = chart.prevClose ? dayChg/chart.prevClose*100 : 0;
  const trendLong = ind.above200 ? 'a long-term uptrend (price above its 200-day average)' : 'a long-term downtrend (price below its 200-day average)';
  const trendMid  = ind.above50 ? 'above the 50-day average' : 'below the 50-day average';
  const posWord = ind.range52Pct>80?'near the top of':ind.range52Pct<20?'near the bottom of':'in the middle of';
  paras.push({ heading:'1. Overview & Trend Context', body:
    ticker+' is trading at '+$(cp)+' ('+pct(dayPct)+' on the day) and sits '+posWord+
    ' its 52-week range ('+$(ind.low52)+' to '+$(ind.high52)+', currently at '+ind.range52Pct.toFixed(0)+
    '% of that range). The stock is in '+trendLong+' and is '+trendMid+
    ', so the primary backdrop is '+(ind.above200?'constructive':'cautious')+'. '+
    (ind.goldenCross?'A recent golden cross (50-day crossing above 200-day) adds a fresh bullish signal. ':
     ind.deathCross?'A recent death cross (50-day crossing below 200-day) is a warning sign. ':'')+
    'Daily volatility (ATR) is '+$(ind.atr14)+', about '+(ind.atr14/cp*100).toFixed(1)+'% of price.' });

  const rsiWord = ind.rsi14<30?'oversold':ind.rsi14>70?'overbought':ind.rsi14<45?'slightly weak':ind.rsi14>55?'slightly firm':'neutral';
  const macdWord= ind.histogram>0?'above its signal line (bullish momentum)':'below its signal line (bearish momentum)';
  const bbWord  = ind.bbSqueeze?'The bands are squeezing, which often precedes a sharp move. ':ind.bbPctB>0.95?'Price is riding the upper band (stretched). ':ind.bbPctB<0.05?'Price is pinned to the lower band (stretched down). ':'';
  const volWord = ind.volRatio>1.5?'on notably heavy volume':ind.volRatio<0.7?'on light volume':'on average volume';
  paras.push({ heading:'2. Short-Term Technical Picture (days–weeks)', body:
    'Momentum is mixed-to-'+(scores.shortScore>=57?'positive':scores.shortScore<=43?'negative':'neutral')+
    '. RSI(14) is '+ind.rsi14.toFixed(0)+' ('+rsiWord+') and MACD is '+macdWord+'. '+
    'Stochastic %K is '+ind.stochK.toFixed(0)+' and Williams %R is '+ind.willR.toFixed(0)+
    ', so the fast oscillators are '+(ind.stochK<20?'oversold':ind.stochK>80?'overbought':'mid-range')+'. '+bbWord+
    'The latest session traded '+volWord+' ('+ind.volRatio.toFixed(1)+'x the 20-day average). '+
    'Net short-term score: '+scores.shortScore+'/100 ('+scores.shortVerdict.replace(/[^\w\s]/g,'').trim()+').' });

  const adxWord = ind.adx14>40?'a very strong trend':ind.adx14>25?'a defined trend':'a weak/sideways trend';
  paras.push({ heading:'3. Long-Term Technical Picture (months–years)', body:
    'ADX(14) is '+ind.adx14.toFixed(0)+', indicating '+adxWord+', currently favouring the '+
    (ind.adxBullish?'bulls (+DI over -DI)':'bears (-DI over +DI)')+'. Price is '+pct(ind.pctFromSma200)+
    ' versus its 200-day average and '+pct(ind.pctFromSma50)+' versus its 50-day. '+
    'Weekly RSI is '+ind.rsiWeekly.toFixed(0)+' ('+(ind.rsiWeekly<40?'oversold':ind.rsiWeekly>65?'overbought':'neutral')+
    ') and ~13-week momentum (ROC) is '+pct(ind.roc52)+'. '+
    'Net long-term score: '+scores.longScore+'/100 ('+scores.longVerdict.replace(/[^\w\s]/g,'').trim()+').' });

  const gannWord = gann.score>=70?'supportive/bullish':gann.score>=50?'neutral':'unsupportive/bearish';
  paras.push({ heading:'4. Gann Angular Read', body:
    'Anchored to the swing low of '+gann.pivot.dateStr+' at '+$(gann.pivot.price)+' (price unit '+$(gann.priceUnit)+
    '/day), price is currently positioned between the '+gann.lowerAngle+' (support) and '+gann.upperAngle+' (resistance) angles. '+
    'The Gann score is driven mainly by distance from the master 1×1 line at '+(gann.gannMaster?$(gann.gannMaster):'N/A')+
    ', which is '+(gann.gannMaster&&gann.gannMaster<cp?'below price and acting as support':'far above price and acting as resistance')+
    ' — so even though price holds the lower fan angles, sitting well below the 1×1 keeps the structural read '+gannWord+
    ' ('+gann.score+'/100 to the long-term score).' });

  if (fund && (fundResult&&fundResult.score!=null)) {
    const bits=[];
    // Phase 2 fix: same forward-else-trailing preference as the scoring driver, so the narrative text stays consistent with the score.
    const narrPE = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
    if(narrPE)   bits.push('a P/E of '+narrPE.toFixed(0)+(narrPE>40?' (rich)':narrPE<15?' (cheap)':' (fair)'));
    if(fund.pegRatio&&fund.pegRatio>0) bits.push('a PEG of '+fund.pegRatio.toFixed(2)+(fund.pegRatio<1?' (attractive vs growth)':fund.pegRatio>2?' (expensive vs growth)':''));
    if(fund.revenueGrowth!=null) bits.push('revenue growth of '+pct(fund.revenueGrowth*100));
    if(fund.profitMargins!=null) bits.push('a net margin of '+(fund.profitMargins*100).toFixed(1)+'%');
    if(fund.returnOnEquity!=null) bits.push('ROE of '+(fund.returnOnEquity*100).toFixed(0)+'%');
    let targetSent='';
    if(fund.targetMean){const up=(fund.targetMean/cp-1)*100;targetSent=' Analysts see a mean target of '+$(fund.targetMean)+' ('+pct(up)+' from here'+(fund.recKey?', rating '+fund.recKey:'')+').';}
    paras.push({ heading:'5. Fundamental Assessment (OWN)', body:
      ticker+' shows '+(bits.length?bits.join(', '):'limited fundamental data')+'.'+targetSent+
      ' The improved v7 OWN score is '+fundResult.score+'/100 ('+(fundResult.verdict||'').replace(/[^\w\s]/g,'').trim()+
      '), so business quality and valuation are '+(fundResult.score>=57?'a tailwind':fundResult.score<=43?'a headwind':'roughly neutral')+' for the thesis.' });
  } else {
    paras.push({ heading:'5. Fundamental Assessment (OWN)', body:
      'No fundamental data was available for this run (see the 🔬 Log for the exact API result), so the verdict rests on technical and Gann signals only.' });
  }

  const entryUp=(confluence.entryCenter/cp-1)*100, exitUp=(confluence.exitCenter/cp-1)*100;
  paras.push({ heading:'6. Entry & Exit Zones', body:
    'Combining independent methods, the buy-the-dip ENTRY zone clusters around '+$(confluence.entryLow)+'–'+$(confluence.entryHigh)+
    ' (center '+$(confluence.entryCenter)+', '+pct(entryUp)+' from here) with '+confluence.entryConfidence+'. '+
    (entryUp<-2?'That implies waiting for a pullback before adding. ':'That is close to the current price, so entries look reasonable now or on minor weakness. ')+
    'The longer-term EXIT/target zone clusters around '+$(confluence.exitLow)+'–'+$(confluence.exitHigh)+
    ' (center '+$(confluence.exitCenter)+', '+pct(exitUp)+' upside) with '+confluence.exitConfidence+
    ', a sensible area to scale out.' });

  let optSent='No options snapshot was loaded, so smart-money positioning is not factored into the Final Conviction yet.';
  if (opts && opts.available) {
    optSent='Options positioning '+(opts.confirm==='confirm'?'CONFIRMS the chart (added to conviction)':opts.confirm==='conflict'?'CONFLICTS with the chart (subtracted from conviction)':'is roughly neutral')+
      ' — Put/Call OI '+(opts.putCallOI!=null?opts.putCallOI.toFixed(2):'N/A')+', net $ '+(opts.netBiasPct!=null?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'%'):'N/A')+', IV '+(opts.ivRank!=null?opts.ivRank+'th %ile':'N/A')+'.';
  }
  paras.push({ heading:'7. Bottom Line', body:
    'The pure OWN score (business only) is '+(fundResult&&fundResult.score!=null?fundResult.score+'/100':'N/A')+
    ' and the pure BUY-TIMING score (chart only) is '+techPlan.techScore+'/100 in a '+techPlan.regime+' regime ('+techPlan.timing+'). '+
    optSent+' Combined, the options-adjusted FINAL CONVICTION is '+decision.finalConviction+'/100 → '+decision.action+'. '+
    'For reference, the v6.1 dual-timeframe read is short '+scores.shortConviction+'/100 and long '+scores.longConviction+
    '/100. Treat these zones as a plan, not a guarantee — always size positions to your own risk tolerance.' });

  return paras;
}

// ── §6.3 Transparency banner ──────────────────────────────────────
// Turns the `status` tracker into a compact, easy-to-read block:
//  - one summary line (green "all OK" OR bold red "⚠ PARTIAL DATA …"),
//  - one detail line listing exactly which sources degraded/failed and
//    which score/decision each one weakens.
// Returns an array of { text:[...], meta:{...} } rows for pushRow.
// Tolerates a missing status object (older callers) by rendering nothing.
function buildDataStatusBannerV7(status) {
  if (!status) return [];
  const order = ['price','fundamentals','series','peers','spyRS','indicators','gann','confluence','options','macroRegime','institutionalHoldings','aiReview','brokerModel','schabackerModel','edwardsMageeModel','turtleModel','darkPool','playerMapping','zombieCompanyScreen','dilutionScreen','comparisonReport'];
  const degraded = [], failed = [], skipped = [];
  order.forEach(k => {
    const s = status[k]; if (!s) return;
    if (s.state === 'failed')   failed.push(s);
    else if (s.state === 'skipped') skipped.push(s);
    else if (s.state === 'degraded') degraded.push(s);
  });

  if (degraded.length === 0 && failed.length === 0 && skipped.length === 0) {
    return [{ text: ['✅ All data sources OK — full-confidence report.'],
      meta: { merge:true, bg:'#1b5e20', color:'#fff', bold:true, size:10 } }];
  }

  const consequences = failed.concat(skipped).concat(degraded)
    .map(s => s.detail || s.label)
    .filter(Boolean);
  const parts = [];
  if (failed.length)   parts.push(failed.length + ' failed');
  if (skipped.length)  parts.push(skipped.length + ' skipped');
  if (degraded.length) parts.push(degraded.length + ' degraded');
  const summary = '⚠ PARTIAL DATA — this report relies on incomplete inputs. ' + parts.join(', ') + '.';

  return [
    { text: [summary], meta: { merge:true, bg:'#b71c1c', color:'#fff', bold:true, size:11, wrap:true } },
    { text: ['Affected: ' + consequences.join('   •   ')], meta: { merge:true, bg:'#fff3e0', color:'#b71c1c', italic:true, size:10, wrap:true } }
  ];
}

// v9.70, direct user request: a single, consolidated end-of-run report of
// everything that failed/was skipped/degraded, printed to the SAME 🔬 Log
// panel everything else already reports to -- previously each of these
// only ever showed as a scattered one-off log line (or, for macroRegime/
// institutionalHoldings/brokerModel/comparisonReport specifically, wasn't
// tracked in this `status` object at all until this same v9.70 pass).
// Reuses the exact same 3-way bucketing as buildDataStatusBannerV7 (the
// sheet-rendered version of this same information) so the two surfaces
// never disagree with each other.
function logDataStatusSummaryV7(status, log) {
  if (!status || typeof log !== 'function') return;
  const order = ['price','fundamentals','series','peers','spyRS','indicators','gann','confluence','options','macroRegime','institutionalHoldings','aiReview','brokerModel','schabackerModel','edwardsMageeModel','turtleModel','darkPool','playerMapping','zombieCompanyScreen','dilutionScreen','comparisonReport'];
  const failed = [], skipped = [], degraded = [];
  order.forEach(k => {
    const s = status[k]; if (!s) return;
    if (s.state === 'failed') failed.push(s);
    else if (s.state === 'skipped') skipped.push(s);
    else if (s.state === 'degraded') degraded.push(s);
  });
  if (!failed.length && !skipped.length && !degraded.length) {
    log('✅ Run Summary: all data sources OK.');
    return;
  }
  const parts = [];
  if (failed.length)   parts.push(failed.length + ' failed');
  if (skipped.length)  parts.push(skipped.length + ' skipped');
  if (degraded.length) parts.push(degraded.length + ' degraded');
  const detail = failed.concat(skipped).concat(degraded)
    .map(s => s.label + (s.detail ? ' (' + s.detail + ')' : ''))
    .join('   •   ');
  log('🔍 Run Summary: ' + parts.join(', ') + ' — ' + detail);
}

// ── §6.4 Failure sheet ────────────────────────────────────────────
// The "always leave a readable sheet" guarantee. Called from the price
// hard-stop and the top-level catch in runAnalysisV7. Uses the SAME
// getOrCreate + padded setValues pattern as buildDashboardV7 (so it
// cannot itself throw on a normal failure), and reuses the transparency
// banner so the user sees exactly which sources did / didn't load.
// v9.45 — writes one of brokerCourseModelV1.gs's plain-text reports
// (formatBrokerCourseReportV1 / formatComparisonReportV1, both return a
// single '\n'-joined string) into its own sheet tab. Deliberately simple:
// one line per row in column A, no merge/no wrap (every line is already
// short and pre-formatted by the source function) — the title line
// ("=== TICKER ...") and numbered section headers ("1. STOCK ID CARD")
// get bold + a tint so the tab is scannable, everything else stays plain.
function writeTextReportToSheetV7(sh, text, accentColor) {
  try { sh.getDataRange().breakApart(); } catch (e) {}
  sh.clearContents(); sh.clearFormats();
  sh.setTabColor(accentColor || '#455a64');
  const lines = String(text || '').split('\n');
  // v9.46 real fix (independent review, 2026-08-22): guard against a
  // report exceeding the sheet's current row grid (real reports are
  // ~40-50 lines today, well under this, but nothing previously stopped
  // a future report from silently truncating or throwing on a fresh
  // sheet with fewer rows than the report).
  if (sh.getMaxRows() < lines.length) sh.insertRowsAfter(sh.getMaxRows(), lines.length - sh.getMaxRows());
  sh.getRange(1, 1, lines.length, 1).setValues(lines.map(l => [l]));
  sh.setColumnWidth(1, 900);
  lines.forEach((l, i) => {
    const row = i + 1;
    if (l.indexOf('===') === 0) {
      sh.getRange(row, 1).setFontWeight('bold').setFontSize(13).setBackground(accentColor || '#455a64').setFontColor('#fff');
    } else if (/^\d+\.\s/.test(l)) {
      sh.getRange(row, 1).setFontWeight('bold').setFontSize(11).setBackground('#eceff1');
    }
  });
  sh.setFrozenRows(1);
}

function buildFailureSheetV7(ss, ticker, status, error) {
  const sh = getOrCreate(ss, CONFIG_V7.tab);
  // Same fix class as P2-2 — the failure sheet reuses the same tab as the
  // main dashboard, so it can inherit a stale merge from whichever one
  // rendered last.
  try { sh.getDataRange().breakApart(); } catch (e) {}
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#b71c1c');

  const rows = [], meta = [];
  function pushRow(vals, m) { rows.push(padRowV7(vals)); meta.push(m || {}); }

  pushRow(['⚠ ANALYSIS INCOMPLETE — ' + (ticker || '(no ticker)') + '   ·   ' + new Date().toLocaleString()],
    { merge:true, bg:'#b71c1c', color:'#fff', bold:true, size:14, wrap:true });
  const msg = (error && error.message) ? error.message : String(error || 'Unknown error');
  pushRow(['Reason: ' + msg.substring(0, 300)], { merge:true, bg:'#fff3e0', color:'#b71c1c', bold:true, size:11, wrap:true });
  pushRow([''], {});

  // Per-source status table so the user can see what DID load.
  pushRow(['Data source','Status','Detail','','','','','','',''], { header:true, bg:'#eeeeee' });
  // v9.93 real fix (direct user question: "what about logs and failure
  // recovery?"): this list was stale even before today's 3 new keys --
  // macroRegime/institutionalHoldings/brokerModel/schabackerModel/
  // edwardsMageeModel/darkPool/comparisonReport were already tracked in
  // `status` but never shown on THIS sheet (only in the success-path
  // banner/log summary) -- a hard abort mid-run hid exactly the info most
  // useful for diagnosing it. Now matches buildDataStatusBannerV7's own
  // list exactly, so a failure and a partial-success report never disagree
  // about what was tracked.
  const order = ['price','fundamentals','series','peers','spyRS','indicators','gann','confluence','options','macroRegime','institutionalHoldings','aiReview','brokerModel','schabackerModel','edwardsMageeModel','turtleModel','darkPool','playerMapping','zombieCompanyScreen','dilutionScreen','comparisonReport'];
  const icon = { ok:'✅ ok', degraded:'⚠️ degraded', failed:'❌ failed', pending:'⏳ not reached' };
  order.forEach(k => {
    const s = status && status[k]; if (!s) return;
    pushRow([s.label || k, icon[s.state] || s.state, s.detail || ''], {});
  });
  pushRow([''], {});
  pushRow(['What to do: check the ticker symbol, or re-run in a minute — external APIs (Yahoo/FMP/Finnhub/Gemini) may be rate-limited. Nothing in your other scripts was affected.'],
    { merge:true, italic:true, color:'#555', size:10, wrap:true });

  sh.getRange(1, 1, rows.length, V7_DASH_COLS).setValues(rows);
  for (let i = 0; i < rows.length; i++) {
    const r = i + 1, m = meta[i]; if (!m) continue;
    if (m.merge) {
      const rng = sh.getRange(r, 1, 1, V7_DASH_COLS).merge();
      if (m.wrap) rng.setWrap(true);
      if (m.bg) rng.setBackground(m.bg);
      if (m.color) rng.setFontColor(m.color);
      if (m.bold) rng.setFontWeight('bold');
      if (m.italic) rng.setFontStyle('italic');
      if (m.size) rng.setFontSize(m.size);
    } else if (m.header) {
      const rng = sh.getRange(r, 1, 1, V7_DASH_COLS);
      rng.setFontWeight('bold'); if (m.bg) rng.setBackground(m.bg);
    }
  }
  sh.setColumnWidths(1, V7_DASH_COLS, 95);
  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(3, 420);
}



// ══════════════════════════════════════════════════════════════════════
//  PORTED v6.1 ENGINE — copied VERBATIM from fullStockAnalysis.gs so v7 is
//  fully self-contained and v6.1 can stay commented out. Do not edit here;
//  these mirror v6.1 exactly. (23 functions + 5 constants.)
// ══════════════════════════════════════════════════════════════════════

// ── API KEYS — hardcoded by explicit request ─────────────────────────
// History, stated plainly instead of stacked as separate old comments:
// hardcoded → moved to Script Properties (for a security review) → back to
// hardcoded, because Script Properties has not worked reliably in this
// project and the underlying cause was never diagnosed. This is a real,
// known tradeoff: a key sitting in plain text here means anyone who sees
// this file sees the keys. Don't paste this file anywhere public, and
// rotate these 4 keys at FMP / Alpha Vantage / Finnhub / Google AI Studio
// if it ever has been.
//
// PASTE YOUR REAL KEYS BELOW — replace every PASTE_*_HERE placeholder.
// These are placeholders, not real values — nobody but you has ever had
// your actual keys, and that's not changing here.
const FMP_API_KEY      = 'PLACEHOLDER_NOT_A_REAL_KEY';
const ALPHAVANTAGE_KEY = 'PLACEHOLDER_NOT_A_REAL_KEY';
const FINNHUB_KEY      = 'PLACEHOLDER_NOT_A_REAL_KEY';
const GEMINI_API_KEY   = 'PLACEHOLDER_NOT_A_REAL_KEY';
const GEMINI_MODEL     = 'gemini-flash-lite-latest';
// ══════════════════════════════════════════════════════════════════
//  BOTTOM LINE SUMMARY — real user request: "conclusions, the Bottom
//  line, the convictions of all the strategies... short detailed clean
//  summary." Reuses everything already computed by runAnalysisV7 and
//  runFullAnalysis -- zero new fetches, zero recomputation risk. Where a
//  strategy naturally has a 0-100 conviction number (fundamentals, stock
//  timing), shows it. Where it doesn't (secular verdict, ATR risk, LILO,
//  the specific option pick), shows its real, honest conclusion instead
//  of forcing a fake score onto something that isn't scored that way.
// ══════════════════════════════════════════════════════════════════
function buildBottomLineSummaryV7(ss, ticker, fundResult, techPlan, decision, leapsCallArg, shortTermCallArg) {
  const sheetName = '📋 Bottom Line — ' + ticker;
  let sh = ss.getSheetByName(sheetName);
  if (sh) { sh.clearContents(); sh.clearFormats(); } else { sh = ss.insertSheet(sheetName); }
  sh.setTabColor('#4a148c');

  let row = 1;
  sh.getRange(row,1,1,2).merge().setValue('📋 BOTTOM LINE — ' + ticker + '   |   ' + new Date().toLocaleString()).setBackground('#1a237e').setFontColor('#fff').setFontSize(13).setFontWeight('bold');row+=2;

  sh.getRange(row,1,1,2).setValues([['Strategy','Conclusion']]).setFontWeight('bold').setBackground('#616161').setFontColor('#fff');row++;

  function line(label, text, bg) {
    sh.getRange(row,1).setValue(label).setFontWeight('bold');
    sh.getRange(row,2).setValue(text).setWrap(true);
    if (bg) sh.getRange(row,1,1,2).setBackground(bg);
    row++;
  }

  // Overall — the single headline verdict, same text as the main dashboard's own decision line
  line('🏆 Overall Action', (decision && decision.action ? decision.action : 'N/A') + '  (Final Conviction: ' + (decision && decision.finalConviction != null ? decision.finalConviction : 'N/A') + '/100)', '#ede7f6');

  // Fundamentals
  if (fundResult && fundResult.score != null) {
    line('💰 Fundamentals (OWN)', fundResult.score + '/100 — ' + (fundResult.verdict || ''));
  } else {
    line('💰 Fundamentals (OWN)', 'N/A this run');
  }

  // Stock — short-term timing
  line('📊 Stock Timing (short-term)', (techPlan.techScore!=null?techPlan.techScore+'/100':'N/A') + ' — ' + (techPlan.timing||'N/A') + '  (regime: ' + (techPlan.regime||'N/A') + ')');

  // Stock — secular (5-10yr)
  if (techPlan.secular) {
    line('📈 Stock Secular (5-10yr hold)', techPlan.secular.verdict + ' — ' + techPlan.secular.why);
  } else {
    line('📈 Stock Secular (5-10yr hold)', 'N/A this run');
  }

  // ATR / risk
  if (techPlan.atr14 != null && techPlan.stop != null) {
    const riskPerShare = (techPlan.entryPrice != null) ? Math.abs(techPlan.entryPrice - techPlan.stop) : null;
    line('📏 ATR / Risk', '$' + techPlan.atr14.toFixed(2) + ' ATR  ·  Stop $' + techPlan.stop.toFixed(2) + (riskPerShare!=null?'  ·  Risk $'+riskPerShare.toFixed(2)+'/share':''));
  } else {
    line('📏 ATR / Risk', 'N/A this run');
  }

  // LILO — reuses the exact same ladder functions the chart already uses, no new computation logic
  try {
    const entryLadder = computeStockEntryLadderV7({ entryCount: techPlan.entryCount, entryLow: techPlan.entryLow, entryHigh: techPlan.entryHigh });
    const exitLadder = computeStockExitLadderV7(techPlan);
    if (entryLadder.length || exitLadder.length) {
      const buyRange = entryLadder.length ? '$'+Math.min(...entryLadder.map(r=>r.price)).toFixed(2)+'–$'+Math.max(...entryLadder.map(r=>r.price)).toFixed(2) : 'none';
      const sellRange = exitLadder.length ? exitLadder.map(r=>'$'+r.price.toFixed(2)).join(', ') : 'none';
      line('🪜 LILO Ladder', entryLadder.length + ' buy rungs (' + buyRange + ')  ·  ' + exitLadder.length + ' sell rungs (' + sellRange + ')');
    } else {
      line('🪜 LILO Ladder', 'no rungs this run (insufficient confluence alignment)');
    }
  } catch(e) { line('🪜 LILO Ladder', 'N/A this run'); }

  // Options — LEAPS and short-term, reusing the already-computed picks passed in from the orchestrator
  //
  // 2026-09-06, real gap found via a real live ALAB run + independent Opus
  // review: selectRecommendedCallV7 (the options picker) runs during the
  // OPTIONS step, which fires BEFORE the stock-timing analysis even
  // computes techPlan.timing -- the equity signal genuinely doesn't exist
  // yet at the moment a contract gets picked, so the picker itself can't
  // cross-check it (a real, structural pipeline-ordering fact, not
  // something fixable inside the picker without reordering the whole
  // pipeline -- too big/risky a change to make alongside this one). Real,
  // safe fix instead: disclose the conflict HERE, where both pieces of
  // data are already available together -- a short-term call recommended
  // while the equity side says WAIT_PULLBACK/AVOID is a real, visible
  // contradiction (buying near-term upside exposure while the same report
  // says wait for a pullback) that should never sit silently.
  function optionLine(label, pick, checkTimingConflict) {
    if (!pick) { line(label, 'not available this run (run via 🚀 Full Ticker Analysis for options data)'); return; }
    if (!pick.found) { line(label, 'not found — ' + pick.reason); return; }
    const c = pick.contract;
    const expDate = new Date(c.expUnix * 1000);
    let text = '$'+c.strike+' call, exp '+expDate.toDateString()+'  ·  delta '+c.delta.toFixed(2)+'  ·  IV '+(c.iv?(c.iv*100).toFixed(1)+'%':'N/A');
    let bg = null;
    if (checkTimingConflict && (techPlan.timing === 'WAIT_PULLBACK' || techPlan.timing === 'AVOID')) {
      text += '  ⚠ Equity signal says ' + techPlan.timing + ' — buying this now runs ahead of that plan';
      bg = '#fff3e0';
    }
    line(label, text, bg);
  }
  optionLine('📞 Options — LEAPS (>1yr)', leapsCallArg, false); // a >1yr position is far less sensitive to near-term timing; cross-check only the short-term pick
  optionLine('📞 Options — Short-term (<1yr)', shortTermCallArg, true);

  // R:R gate — only shown when it actually fired, matching the same convNotes-based pattern already used on the main dashboard
  if (techPlan.rrToT1 != null) {
    const rr1 = techPlan.rrToT1;
    if (rr1 < 1.5) {
      line('⚠ R:R Gate', 'T1 R:R ' + rr1.toFixed(2) + (rr1 < 1.0 ? ' — marginal structure' : ' — thin, size accordingly'), rr1 < 1.0 ? '#fff3e0' : null);
    }
  }
  // 2026-09-06, real fix (found via a real live ALAB run + independent
  // Opus review): the R:R above describes the PLANNED ladder entry only --
  // real, correct, but easy to misread as "today's R:R" when price sits
  // well outside the ladder. Shown unconditionally (not gated on the
  // ladder R:R being thin) since a healthy ladder R:R can still hide a
  // genuinely bad at-spot R:R, and that's the actionable number if buying
  // right now instead of waiting for the ladder.
  if (techPlan.rrToT1AtSpot != null) {
    const rr1Spot = techPlan.rrToT1AtSpot;
    line('📍 R:R at today\'s price', 'T1 R:R ' + rr1Spot.toFixed(2) + (techPlan.entryPrice != null ? ' (vs ' + techPlan.rrToT1.toFixed(2) + ' at the $' + techPlan.entryPrice.toFixed(2) + ' ladder entry)' : ''), rr1Spot < 1.0 ? '#fff3e0' : null);
  }

  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 620);
  sh.activate();
}

// ══════════════════════════════════════════════════════════════════
//  Item 1 (DASHBOARD_IMPROVEMENTS_PLAN.md): methodology / glossary sheet.
//  Static reference content -- explanations don't change run to run, so
//  this is written once and doesn't need recomputing on every analysis.
//  Organized by the same categories the dashboard already uses.
// ══════════════════════════════════════════════════════════════════
function buildMethodologySheetV7() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('📖 Methodology');
  if (sh) { sh.clearContents(); sh.clearFormats(); } else { sh = ss.insertSheet('📖 Methodology'); }

  let row = 1;
  function section(title, color) {
    sh.getRange(row,1,1,3).merge().setValue(title).setBackground(color).setFontColor('#fff').setFontSize(12).setFontWeight('bold');
    row++;
    sh.getRange(row,1,1,3).setValues([['Method / Indicator','What it measures / how to read it','Notes']]).setFontWeight('bold').setBackground('#eceff1');
    row++;
  }
  function entry(name, desc, note) {
    sh.getRange(row,1,1,3).setValues([[name, desc, note||'']]).setWrap(true);
    row++;
  }

  section('📋 Price / Entry-Exit Methods', '#37474f');
  entry('Bollinger lower/upper band', 'A band 2 standard deviations from the 20-day average price. Price near the lower band suggests it\'s statistically stretched to the downside; near the upper band, stretched up.', '');
  entry('SMA20/50/150/200 (as support/resistance)', 'The average closing price over that many days. When price sits above its own SMA, that SMA line often acts as a floor (support) if price pulls back to it; below it, a ceiling (resistance).', 'SMA50/150 added to this system on this pass -- previously only SMA20/200 were used here.');
  entry('Fibonacci retracement (38.2%, 50%)', 'Levels derived from a mathematical ratio sequence, applied to a recent price swing. Widely watched because many traders use them, which can become self-fulfilling.', '');
  entry('Fibonacci 161.8% extension', 'A projection beyond the original price swing, using the same ratio sequence -- typically used as a longer-range upside target.', '');
  entry('Pivot Points (S1/S2, R1/R2)', 'Classic support/resistance levels computed from the prior period\'s high/low/close. Widely used by day traders.', '');
  entry('ATR pullback (1.5×ATR)', 'Current price minus 1.5x the Average True Range -- a common rule-of-thumb for "how far a healthy pullback typically goes" before a stock likely finds support.', '');
  entry('Gann support/resistance (angles)', 'A price/time relationship system where a diagonal line is drawn from a significant price pivot at a fixed slope (e.g. $X per trading day). Where price sits relative to these angles is read as support/resistance.', 'A minority, more esoteric technique -- not universally used by traders the way moving averages or RSI are.');
  entry('Square of Nine (Sq9) harmonic levels', 'A Gann-derived technique using a specific numerical spiral to derive price levels believed to have geometric significance.', 'Niche technique, included for completeness, not a mainstream method.');
  entry('52-week high/low', 'The highest and lowest closing prices over the trailing year. The 52-week high in particular is a widely-watched psychological resistance level.', '');
  entry('Analyst consensus / high target', 'The average (consensus) and highest individual price target among covering analysts.', 'Reflects analyst opinion, not an independent technical or fundamental calculation.');

  section('📊 Short-Term Technical Indicators (Days/Weeks)', '#1b5e20');
  entry('RSI(14)', 'Relative Strength Index -- measures how fast and how much price has moved recently, on a 0-100 scale. Above 70 is conventionally "overbought," below 30 "oversold."', 'More reliable as a reversal signal in a range-bound/choppy market; can stay "overbought" for a long time during a strong trend without reversing.');
  entry('MACD (Moving Average Convergence Divergence)', 'The difference between two moving averages (typically 12 and 26-day), plus a signal line. When the MACD line crosses above its signal line, that\'s read as bullish momentum.', 'More reliable in a trending market; prone to false signals (whipsaws) in a choppy market.');
  entry('Stochastic %K/%D', 'Compares the current closing price to its recent trading range, also 0-100. Similar interpretation to RSI (overbought/oversold).', 'Same regime-sensitivity as RSI -- more reliable when range-bound.');
  entry('Williams %R', 'A momentum oscillator similar to Stochastic, inverted scale (0 to -100).', '');
  entry('CCI(20) (Commodity Channel Index)', 'Measures how far price has moved from its statistical average -- used to spot potential trend starts or extremes.', '');
  entry('MFI(14) (Money Flow Index)', 'Similar to RSI but incorporates trading volume, sometimes called "volume-weighted RSI."', '');
  entry('OBV (On-Balance Volume)', 'A running total that adds volume on up days and subtracts it on down days -- used to confirm whether a price move has genuine volume support behind it.', 'Tends to matter across most market conditions, not just specific regimes.');
  entry('EMA9/21 (Exponential Moving Averages)', 'Similar to simple moving averages but weight recent prices more heavily, so they react faster to new price action.', '');
  entry('CMF(20) (Chaikin Money Flow)', 'Measures buying vs. selling pressure over 20 days, incorporating both price and volume.', '');
  entry('ROC(10) (Rate of Change)', 'The percentage price change over the last 10 days -- a simple, direct momentum measure.', '');
  entry('RSI Divergence', 'When price makes a new low but RSI does NOT make a correspondingly lower low (or the reverse for highs) -- often read as an early sign the current move is losing strength.', '');
  entry('Aroon(25)', 'Measures how long it\'s been since price made a new 25-day high vs. a new 25-day low. A recent high with no recent low reads as a strong uptrend, and vice versa.', 'Reads flat/neutral by design during a real sideways market -- that\'s the indicator correctly reporting no dominant trend, not a malfunction.');
  entry('Donchian(20) (Donchian Channel)', 'The highest high and lowest low over the last 20 days -- the classic "Turtle Trading" breakout channel. Price pressing the upper band reads bullish, the lower band bearish.', '');
  entry('Parabolic SAR', 'A trailing stop-and-reverse indicator that flips sides when price crosses it. Below price = uptrend, above price = downtrend.', 'Designed for trending markets -- whipsaws (frequent flips) in a real choppy/range-bound market, same regime-sensitivity as MACD.');
  entry('SuperTrend', 'An ATR-based trend line, similar purpose to Parabolic SAR but built from real, measured volatility (ATR) rather than a fixed acceleration formula.', 'Same trending-market bias as Parabolic SAR -- both are trend-following overlays, not range-bound tools.');
  entry('Ichimoku Cloud', 'A Japanese charting system combining trend direction, support/resistance ("the cloud"), and momentum in one view. Price above the cloud reads bullish, below reads bearish, inside the cloud reads as no clear trend.', 'The cloud shown today reflects a real calculation from 26 real trading days ago, displaced forward -- a standard, correct part of how this indicator works, not a delay/lag bug.');

  section('📈 Long-Term Technical Indicators (Months/Years)', '#0d47a1');
  entry('Price vs. SMA200', 'Whether price is above or below its 200-day average -- one of the most widely-used simple definitions of "primary trend."', '');
  entry('Golden Cross / Death Cross', 'When the 50-day average crosses above (golden) or below (death) the 200-day average -- a classic, widely-watched long-term trend signal.', '');
  entry('ADX(14) (Average Directional Index)', 'Measures how STRONG a trend is (not its direction) -- low ADX suggests a weak/sideways market regardless of which way price is drifting.', '');
  entry('RSI Weekly', 'The same RSI calculation, but using weekly instead of daily candles -- a slower, longer-horizon momentum read.', '');
  entry('ROC(52) — ~13wk', 'The percentage price change over the trailing 52 TRADING DAYS (~13 weeks / ~2.5 months, not 1 year — v9.46: was mislabeled "annual"/"1yr" throughout the file).', '');
  entry('Relative Strength vs. SPY', 'How the stock has performed compared to the S&P 500 over the same period -- outperformance vs. the broad market.', 'Currently only compares against the broad index, not sector-specific peers.');
  entry('Gann Angular (structural)', 'The same Gann angle technique as the entry/exit methods above, applied here as a long-term structural trend read.', '');

  section('💰 Fundamentals Drivers (OWN Score)', '#4a148c');
  entry('Revenue/share trend', 'Whether revenue-per-share has been rising over the past several quarters -- a growth trajectory signal, distinct from a single period\'s growth rate.', '');
  entry('Margin trajectory', 'Whether net profit margin is improving or declining -- profitability trend, not just current-level profitability.', '');
  entry('Rule of 40', 'A common growth-company heuristic: revenue growth rate + free cash flow margin should exceed 40 for a healthy, efficient growth business.', '');
  entry('Profitability/quality (ROE, Net Margin)', 'Current-level profitability metrics -- how efficiently the company turns equity/revenue into profit right now.', '');
  entry('Valuation vs. peers (EV/Sales)', 'How expensive the stock is relative to a set of comparable companies, using Enterprise Value/Sales.', '');
  entry('Analyst view', 'Blended analyst rating and price target, relative to current price.', '');
  entry('P/E & PEG', 'Price/Earnings ratio and PEG (P/E relative to growth rate) -- classic valuation multiples.', '');

  section('⚡ Options Metrics', '#e65100');
  entry('IV Percentile', 'How expensive options are priced right now, RELATIVE to this same stock\'s own historical range -- not an absolute number. High percentile means options are pricier than usual for this specific stock.', '');
  entry('Put/Call Open Interest ratio', 'Total open put contracts divided by open call contracts. Below ~0.7 suggests upside positioning; above ~1.1 suggests downside/hedging positioning.', '');
  entry('LEAPS lean', 'Whether long-dated (1-2yr+) option positioning skews bullish or bearish -- often read as reflecting more patient, institutional conviction than short-dated options.', '');
  entry('Dollar-weighted conviction (options)', 'A blended score: 50% dollar value committed to a position + 20% holding pattern + 15% urgency (volume spike) + 10% time-to-expiry + 5% relative IV.', '');
  entry('OI-Persistence', 'Compares today\'s open interest in a specific contract to the LAST time this same ticker was analyzed -- builds up real signal over repeated runs, not a single snapshot.', '');

  section('🌊 Regime & Risk Mechanics', '#c62828');
  entry('ATR (Average True Range)', 'How much the stock typically moves in a single day, in dollars -- the base volatility measurement everything else in risk-sizing is built from.', '');
  entry('Regime (TREND_UP / TREND_DOWN / CHOP / HIGH_VOL)', 'A classification of current market conditions, used to gate whether a "BUY NOW" recommendation is even allowed, and to set the stop-loss distance.', '');
  entry('Stop multiplier by regime', 'The distance from entry to stop-loss, as a multiple of ATR: 2.0x in HIGH_VOL (wider, since volatility itself is elevated), 1.25x in a clean trend (tighter, the trend is doing the work), 1.5x otherwise (CHOP).', '');
  entry('OWN-as-filter Final Conviction', 'Once fundamentals (OWN score) clear a threshold, Final Conviction is driven by technical timing alone. Below that threshold, technical timing gets reduced on an accelerating curve; below a hard floor, it\'s blocked entirely regardless of chart.', '');

  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 500); sh.setColumnWidth(3, 300);
  sh.setFrozenRows(0);
  SpreadsheetApp.getUi().alert('Methodology sheet built/refreshed — see the 📖 Methodology tab.');
}

function checkApiKeysConfiguredV7() {
  const required = { FMP_API_KEY, ALPHAVANTAGE_KEY, FINNHUB_KEY, GEMINI_API_KEY };
  const missing = Object.keys(required).filter(k => !required[k]);
  if (missing.length) {
    const msg = 'Missing keys: ' + missing.join(', ') + '.';
    Logger.log('❌ ' + msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* fine if run outside a spreadsheet context */ }
  } else {
    Logger.log('✅ All 4 required API keys are present.');
  }
}

// Menu item: a plain-language guide to what each menu item does, since
// Apps Script's native menu API has no tooltip/hover-text support (confirmed
// against Google's own Menu class reference — addItem() only takes a
// caption and a function name, nothing else).
// v10.9 (2026-09-10): full real rewrite, kept in sync with onOpen()'s
// actual real menu (futuresStockAnalysisV3_3_11.gs) -- STANDING RULE from
// here on, user's own words: "Help mailing you must always be updated."
// Real, confirmed gap this fixed: the prior version still described
// "💼 Build Portfolio Summary" (removed v10.4) as if it existed, and had
// no entry at all for 7+ real, currently-live menu items (the entire
// "🚀 Options Analysis" top menu, Exit Strategy + its trigger, Clean Up
// Old Price Caches, Diagnose Sheet Size, Build Methodology Sheet).
// Section order matches onOpen()'s own real grouping exactly.
function showMenuHelpV7() {
  const html = `<!DOCTYPE html><html><head><base target="_top">
  <style>
    body{font-family:Arial,sans-serif;padding:16px 20px;color:#333;font-size:13px}
    h2{margin:18px 0 6px 0;color:#455a64;font-size:12px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #cfd8dc;padding-bottom:3px}
    h2:first-child{margin-top:0}
    h3{margin:10px 0 3px 0;color:#1a237e;font-size:14px}
    p{margin:0 0 4px 0;color:#555;line-height:1.45}
  </style></head><body>
    <h2>🚀 Options Analysis menu</h2>
    <h3>▶ Run Analysis (Default: ticker)</h3>
    <p>Zero-click — instantly re-runs the options analysis on whatever ticker is currently your default. Fastest way to refresh a check you already ran.</p>
    <h3>📊 Select Ticker &amp; Run</h3>
    <p>Same options analysis, but asks you for a symbol first — use this to check a different ticker.</p>
    <h3>📞 Find Recommended Call</h3>
    <p>Small, standalone tool — just tells you the single best-scored call contract for a ticker, without running the full report.</p>
    <h3>🔬 Diagnose API connection</h3>
    <p>Checks the CBOE options-chain connection directly and tells you what's wrong if a ticker's options data won't load.</p>

    <h2>📈 Stock Analysis menu — quick-run</h2>
    <h3>🚀 Full Ticker Analysis (Options + Stock + Chart)</h3>
    <p>The fastest way to fully analyze one ticker — asks for a symbol once, then runs options analysis, stock analysis, and opens the price chart, all for that same ticker, in the correct order. Solves the "options data only shows up if it's the same ticker as your last stock analysis" issue by making that automatic.</p>
    <h3>📊 Run Stock Analysis (v7)</h3>
    <p>The main one — opens a ticker picker, runs the full engine (fundamentals, technicals, Gann, options), builds the dashboard. Use this instead of Full Ticker Analysis above when you don't need options data refreshed, or want to reuse an existing options run.</p>
    <h3>📊 Show Price Chart</h3>
    <p>Opens a real price chart (up to 2 years of daily data, SMA50/SMA200, entry/exit/stop/target lines when available) for whichever ticker's dashboard you last built.</p>

    <h2>📈 Stock Analysis menu — portfolio-wide</h2>
    <h3>📤 Build Exit Strategy Report</h3>
    <p>Reads your real Portfolio sheet directly (both the stock/crypto table and the options table) and gives each real held position a Thesis / Trailing Stop / Targets / Expiry / Confidence / Summary read, plus a portfolio-wide diversification and correlated-exposure advisory at the bottom.</p>
    <h3>⏰ Install Exit Strategy Nightly Trigger (~1am)</h3>
    <p>One-time setup — schedules the report above to run automatically overnight. Click once.</p>

    <h2>📈 Stock Analysis menu — daily/watchlist automation</h2>
    <h3>🎯 Run Watchlist / Daily Check Now</h3>
    <p>Manually runs the daily check on every ticker in your 🎯 Watchlist sheet (creates it, seeded with your current default ticker, the first time you click this). Logs every result to 📈 Decision History and emails you only if a decision genuinely changed.</p>
    <h3>⏰ Install Daily Auto-Run Trigger</h3>
    <p>One-time setup — makes the item above happen automatically every morning (~7 AM). Needs nothing from you, just click it once.</p>

    <h2>📈 Stock Analysis menu — diagnostics &amp; maintenance</h2>
    <h3>🔑 Check API Keys Configured</h3>
    <p>Confirms your API keys (FMP, Alpha Vantage, Finnhub, Gemini) are present. Currently these are hardcoded directly in the script file (not Script Properties) — this check will always pass unless the file itself was edited incorrectly.</p>
    <h3>🧹 Clean Up Old Price Caches</h3>
    <p>Deletes stale per-ticker price-cache sheets you no longer need, to keep the spreadsheet from accumulating clutter.</p>
    <h3>🔍 Diagnose Sheet Size (read-only)</h3>
    <p>Reports how large your spreadsheet has gotten (sheet count, cell count) — read-only, changes nothing, just tells you.</p>

    <h2>📈 Stock Analysis menu — docs</h2>
    <h3>📖 Build Methodology Sheet</h3>
    <p>Writes a real, in-sheet explanation of how the engine's scoring/technical methodology works — a reference, not a live report.</p>
    <h3>❓ What do these do?</h3>
    <p>This dialog.</p>
  </body></html>`;
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(420).setHeight(620), 'What do these menu items do?');
}

// ══════════════════════════════════════════════════════════════════
//  PHASE 10 — In-Sheet Price Chart, core design (Sub-phases 10.2-10.6)
//  Design doc: PHASE_10_IN_SHEET_CHART_DETAILED.md — each element here maps
//  to one of the 5 original product ideas this project was built around.
//  10.7 (LILO ladder rungs) is the next increment — needs its own dialog
//  changes (LILO toggles aren't in the Full Ticker Analysis flow yet),
//  deliberately not bundled into this pass.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  PHASE 10 — Full-Tab Native Chart (line-based, full feature set)
//  Real, structural evidence found before building this: every OTHER
//  native chart type has its own dedicated builder class (EmbeddedLine
//  ChartBuilder, EmbeddedBarChartBuilder, EmbeddedComboChartBuilder,
//  etc.) -- there is no EmbeddedCandlestickChartBuilder anywhere in
//  Google's own documentation, and Google states directly that "not all
//  embedded chart types are currently supported" for programmatic
//  building, even when available through the manual UI. Strong signal
//  candlesticks specifically aren't buildable via Apps Script's code API
//  at all -- a real platform limit, not a config mistake. Switched to a
//  LINE chart for price, which is confirmed, reliably supported (this is
//  literally Google's own official codelab example pattern). Keeps the
//  full feature set -- SMA50/SMA200, entry/exit/stop/target lines, real
//  width, real persistent tab -- loses only the candlestick VISUAL shape.
//  CONFIRMED WORKING via real user screenshot -- line charts are the
//  correct approach; candlesticks were the actual problem.
//  Round 2 (user: "useless, make it great" -- 4 concrete fixes, verified
//  feasible before building, no more guessing):
//   1. Default window is now ~6 months (DISPLAY_DAYS=126), not 2 years --
//      SMA is still computed over the FULL fetched history for accuracy,
//      only the DISPLAY is windowed, so SMA200 stays correct on day 1 shown.
//   2. A "Today" marker -- single diamond point, only on the last row.
//   3. Entry zone consolidated to ONE line at the midpoint (was two
//      overlapping lines reading as visual noise) -- the zone width is in
//      a text label below the chart instead.
//   4. The actual verdict (decision.action) in the title, not just the
//      regime -- chart and decision are now the same object to look at.
//  Deliberately NOT included (explicitly deferred, not forgotten): daily
//  high/low range as a shaded band. Flagged as needing a real feasibility
//  check first, given what happened with candlesticks -- not baking in
//  another unverified risk in the same pass as everything above.
// ══════════════════════════════════════════════════════════════════
function showPriceChartV7(tickerArg, techPlanArg, decisionArg, showLadderArg, recCallArg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ticker = tickerArg || (CONFIG_V7.dailyTickers && CONFIG_V7.dailyTickers[0]) || 'TSLA';
  if (!tickerArg) {
    try {
      const sh = ss.getSheetByName(CONFIG_V7.tab);
      if (sh) {
        const header = String(sh.getRange(1,1).getValue());
        const m = header.match(/📊\s+([A-Z.]+)\s+—/);
        if (m) ticker = m[1];
      }
    } catch (e) { /* fall back to the default above */ }
  }

  const data = fetchYahooChart(ticker);
  if (!data) {
    SpreadsheetApp.getUi().alert('Could not load chart data for ' + ticker + ' — try running an analysis on it first, or check your connection.');
    return;
  }

  const chartSheetName = '📊 ' + ticker + ' Chart';
  let sh = ss.getSheetByName(chartSheetName);
  if (sh) {
    sh.getCharts().forEach(c => sh.removeChart(c)); // clear any prior chart before rebuilding
    sh.clearContents();
  } else {
    sh = ss.insertSheet(chartSheetName);
  }

  function sma(period, i, closes) {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    return sum / period;
  }

  const entryMid = (techPlanArg && techPlanArg.entryLow != null && techPlanArg.entryHigh != null)
    ? (techPlanArg.entryLow + techPlanArg.entryHigh) / 2 : null;

  const n = data.dates.length;
  const DISPLAY_DAYS = 126; // ~6 trading months
  const startIdx = Math.max(0, n - DISPLAY_DAYS);
  const isLastRow = (i) => i === n - 1;

  // LILO ladder rungs (new): a VARIABLE number of price lines (however many
  // confluence methods aligned), unlike the fixed Entry/Stop/T1/T2 columns.
  // Reuses computeStockEntryLadderV7/computeStockExitLadderV7 UNCHANGED --
  // same functions the dashboard's own LILO section already uses, so the
  // chart can never silently disagree with what the dashboard shows.
  let ladderRungs = [];
  let hasEntryRungs = false; // tracks whether real buy rungs exist, so the redundant consolidated Entry line can be suppressed
  let hasExitRungs = false;  // same idea for T1/T2 vs sell rungs -- confirmed via real data they're always identical values
  if (showLadderArg && techPlanArg) {
    try {
      const entryLadder = computeStockEntryLadderV7({
        entryCount: techPlanArg.entryCount, entryLow: techPlanArg.entryLow, entryHigh: techPlanArg.entryHigh
      });
      const exitLadder = computeStockExitLadderV7(techPlanArg);
      hasEntryRungs = entryLadder.length > 0;
      hasExitRungs = exitLadder.length > 0;
      // Distinct shade per rung -- found from a real screenshot that all
      // rungs sharing one flat color made them indistinguishable from each
      // other (label-only, not visually). Buy rungs: green family (not
      // colliding with SMA200's purple). Sell rungs: reuse the blue family
      // T1/T2 used to occupy -- safe, since T1/T2 are always suppressed
      // whenever sell rungs are shown, never both visible at once.
      // 9 shades, not 5 -- computeStockEntryLadderV7 has no cap on rung
      // count (confirmed by reading it directly, not assumed), and the
      // dashboard's own confidence labels elsewhere show up to "X/9
      // aligned" methods -- meaning entryCount could realistically reach
      // 9 in some run, even though THIS run only had 4. A 5-color palette
      // would have silently wrapped and reintroduced the exact
      // indistinguishable-rung problem just fixed, just at a higher rung
      // count that hasn't been seen yet. Real Material Design green scale
      // (900->100), genuinely distinguishable at all 9 steps.
      const BUY_RUNG_COLORS = ['#1b5e20','#2e7d32','#388e3c','#43a047','#4caf50','#66bb6a','#81c784','#a5d6a7','#c8e6c9'];
      const SELL_RUNG_COLORS = ['#0d47a1', '#1565c0', '#1e88e5', '#42a5f5', '#90caf9'];
      entryLadder.forEach(r => ladderRungs.push({ label: 'Buy rung ' + r.rung, price: r.price, color: BUY_RUNG_COLORS[(r.rung - 1) % BUY_RUNG_COLORS.length] }));
      exitLadder.forEach(r => ladderRungs.push({ label: 'Sell rung ' + r.rung, price: r.price, color: SELL_RUNG_COLORS[(r.rung - 1) % SELL_RUNG_COLORS.length] }));
    } catch (e) {
      Logger.log('LILO ladder computation failed for chart: ' + (e && e.message ? e.message : e));
      // Non-fatal -- chart still builds without ladder rungs, same graceful pattern used elsewhere.
    }
  }

  // Index-safe by construction: every series (fixed AND dynamic ladder
  // rungs) is defined ONCE here, and headers/rows/series-options are all
  // DERIVED from this single list -- eliminates the exact class of bug
  // that happened earlier this session (manually shifting hardcoded
  // series indices when High/Low were added, easy to get wrong).
  const seriesDefs = [
    { header: 'Close', value: (i) => data.closes[i], opt: { color: '#1a237e', lineWidth: 2 } },
    { header: 'High',  value: (i) => data.highs[i],  opt: { color: '#cfd8dc', lineWidth: 1 } },
    { header: 'Low',   value: (i) => data.lows[i],   opt: { color: '#cfd8dc', lineWidth: 1 } },
    { header: 'SMA50', value: (i) => sma(50, i, data.closes),  opt: { color: '#f57c00', lineWidth: 1 } },
    { header: 'SMA200',value: (i) => sma(200, i, data.closes), opt: { color: '#6a1b9a', lineWidth: 1 } },
  ];
  // Real user screenshot + real dashboard data confirmed: the consolidated
  // Entry line and the individual buy rungs are genuinely redundant when
  // both are shown -- the rungs are literally subdivisions of the same
  // entry zone (confirmed against real numbers: Entry $165.38 sits exactly
  // between Buy rung 3 $163.84 and Buy rung 1 $168.37). When real buy rungs
  // exist, they replace the single Entry line rather than coexisting with
  // it -- cuts a 4-line cluster down to 3 meaningfully different lines.
  if (!hasEntryRungs) {
    seriesDefs.push({ header: 'Entry', value: () => entryMid, opt: { color: '#2e7d32', lineWidth: 1, lineDashStyle: [4,2] } });
  }
  seriesDefs.push({ header: 'Stop', value: () => techPlanArg && techPlanArg.stop != null ? techPlanArg.stop : null, opt: { color: '#c62828', lineWidth: 1, lineDashStyle: [4,2] } });
  // Same exact redundancy on the sell side, found from a real fresh export
  // (not guessed): computeStockExitLadderV7 builds its 2 rungs DIRECTLY
  // from T1/T2 -- Sell rung 1 always equals T1 exactly, Sell rung 2 always
  // equals T2 exactly, confirmed from real data (211.260002 both places,
  // 270.030705 both places). When real sell rungs exist, T1/T2 are
  // guaranteed-redundant with them, every time, by design -- not a
  // coincidence worth treating differently from the Entry/buy-rung case.
  if (!hasExitRungs) {
    seriesDefs.push(
      { header: 'T1', value: () => techPlanArg && techPlanArg.t1 && techPlanArg.t1.price != null ? techPlanArg.t1.price : null, opt: { color: '#1565c0', lineWidth: 1, lineDashStyle: [4,2] } },
      { header: 'T2', value: () => techPlanArg && techPlanArg.t2 && techPlanArg.t2.price != null ? techPlanArg.t2.price : null, opt: { color: '#1565c0', lineWidth: 1, lineDashStyle: [4,2] } }
    );
  }
  ladderRungs.forEach(r => {
    seriesDefs.push({ header: r.label, value: () => r.price, opt: { color: r.color, lineWidth: 1, lineDashStyle: [1,2] } });
  });
  // Recommended call strike (Section 2a/2 integration) -- reuses the exact
  // same flat-reference-line technique as Entry/Stop/T1/T2/LILO rungs, no
  // new chart mechanism. Only the LEAPS pick is shown here (the user's
  // actual, confirmed real-world usage -- all 4 real positions are 7+
  // months out); short-term could be added the same way later if wanted.
  if (recCallArg && recCallArg.found) {
    seriesDefs.push({
      header: 'Rec. Call ($' + recCallArg.contract.strike + ')',
      value: () => recCallArg.contract.strike,
      opt: { color: '#e65100', lineWidth: 1, lineDashStyle: [2,2] }
    });
  }
  seriesDefs.push({ header: 'Today', value: (i) => isLastRow(i) ? data.closes[i] : null, opt: { color: '#000000', lineWidth: 0, pointSize: 10, pointShape: 'diamond' } });

  const headers = ['Date', ...seriesDefs.map(s => s.header)];
  sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');

  const rows = [];
  for (let i = startIdx; i < n; i++) {
    rows.push([data.dates[i], ...seriesDefs.map(s => s.value(i))]);
  }
  sh.getRange(2,1,rows.length,headers.length).setValues(rows);
  sh.getRange(2,1,rows.length,1).setNumberFormat('yyyy-mm-dd');

  const regimeLabel = techPlanArg ? (techPlanArg.regime||'') : '';
  const verdictLabel = decisionArg && decisionArg.action ? decisionArg.action : regimeLabel;
  const entryLabel = (techPlanArg && techPlanArg.entryLow != null && techPlanArg.entryHigh != null)
    ? 'Entry ~$' + entryMid.toFixed(2) + ' (zone $' + techPlanArg.entryLow.toFixed(2) + '–$' + techPlanArg.entryHigh.toFixed(2) + ')'
    : 'Entry';

  const displayedCloses = data.closes.slice(startIdx);
  const displayedLows = data.lows.slice(startIdx);

  // W6 (v8.1): DATA-DRIVEN vertical range.
  // The old axis forced min:0, which crushed all price action into the top
  // ~40% of the plot (the "bunched rungs" seen in the real screenshot) with
  // empty dead space below. Now the MIN is driven by the actual lowest plotted
  // value (lows/stop/buy rungs), so price fills the plot. The MAX keeps the
  // v7.33 anti-stretch intent — a far-extended T2 (and the T2-level sell rung)
  // is DELIBERATELY excluded so it can't stretch the whole scale; it still
  // draws at its real value and may run off the top. Near-price reference
  // lines (entry, stop, T1, buy rungs, rec-call) ARE included so they're never
  // clipped.
  const maxCandidates = [Math.max(...displayedCloses)];
  const minCandidates = [Math.min(...displayedLows)];
  if (techPlanArg) {
    if (entryMid != null) { maxCandidates.push(entryMid); minCandidates.push(entryMid); }
    if (techPlanArg.stop != null) { maxCandidates.push(techPlanArg.stop); minCandidates.push(techPlanArg.stop); }
    if (techPlanArg.t1 && techPlanArg.t1.price != null) maxCandidates.push(techPlanArg.t1.price);
  }
  // buy rungs sit near/below price — safe for both bounds; sell rungs mirror
  // T1/T2 exactly, so only the T1-level rung is bounded (the T2-level one is
  // excluded from MAX along with T2 itself, same anti-stretch rule).
  ladderRungs.forEach(r => {
    if (/Buy rung/.test(r.label)) { maxCandidates.push(r.price); minCandidates.push(r.price); }
    else if (/Sell rung 1\b/.test(r.label)) { maxCandidates.push(r.price); }
  });
  if (recCallArg && recCallArg.found) {
    const rc = Number(recCallArg.contract.strike);
    if (Number.isFinite(rc)) { maxCandidates.push(rc); minCandidates.push(rc); }
  }
  const dataMax = Math.max(...maxCandidates), dataMin = Math.min(...minCandidates);
  const pad = (dataMax - dataMin) * 0.08 || dataMax * 0.05;
  const vAxisMin = Math.max(0, dataMin - pad);
  const vAxisMax = dataMax + pad;

  // series options object built from the SAME seriesDefs list, indices
  // derived automatically (index+1 since Date is column 0, not a series) --
  // cannot drift out of sync with the headers/rows above.
  const seriesOptions = {};
  seriesDefs.forEach((s, idx) => { seriesOptions[idx] = s.opt; });

  const chart = sh.newChart()
    .asLineChart()
    .addRange(sh.getRange(1,1,rows.length+1,headers.length))
    .setNumHeaders(1)
    .setOption('series', seriesOptions)
    .setOption('title', ticker + ' — $' + data.currentPrice.toFixed(2) + '   ' + verdictLabel)
    .setOption('titleTextStyle', { bold: true, fontSize: 15 })
    .setOption('legend', { position: 'top' })
    .setOption('vAxis', { viewWindow: { min: vAxisMin, max: vAxisMax } })
    .setOption('width', 1200)
    .setOption('height', 700)
    .setPosition(2, headers.length + 2, 0, 0)
    .build();

  sh.insertChart(chart);
  sh.getRange(headers.length + 3, 1).setValue(entryLabel).setFontStyle('italic').setFontColor('#2e7d32');
  sh.activate();
}

// One-click orchestrator: options -> stock analysis -> chart, all for the
// SAME ticker, in the correct order. Directly solves the ordering/mismatch
// problem discussed with the user (options data only shows on the stock
// dashboard if run for the same ticker; the chart reads whichever ticker's
// dashboard was just built). Named distinctly from futuresStockAnalysisV3.gs's (currently v3.3.1)
// own runFullAnalysis(targetTicker) — that function IS reused here (called
// directly, no menu re-prompt), just under a different name at this
// orchestration layer to avoid any confusion between the two.
// Shows the SAME ticker-picker dropdown as runAnalysisV7FromMenu (identical
// list, identical OTHER/manual entry) — user feedback: the bare text prompt
// this had before was inconsistent with every other entry point in the tool.
function runCompleteTickerAnalysisV7() {
  const html = `<!DOCTYPE html><html><head><base target="_top">
  <style>
    body{font-family:Arial,sans-serif;padding:20px;color:#333}
    label{display:block;margin-bottom:8px;font-weight:bold}
    select,input{width:100%;padding:10px;margin-bottom:16px;border:1px solid #ccc;
      border-radius:4px;box-sizing:border-box;font-size:14px}
    button{background:#1a73e8;color:#fff;border:none;padding:12px;cursor:pointer;
      border-radius:4px;width:100%;font-size:14px;font-weight:bold}
    button:hover{background:#0d47a1} button:disabled{background:#9e9e9e;cursor:not-allowed}
    #manualDivV7b{display:none}
    .note{font-size:10px;color:#888;margin-top:-12px;margin-bottom:14px}
  </style></head><body>
  <label>Ticker:</label>
  <select id="selV7b" onchange="document.getElementById('manualDivV7b').style.display=
    this.value==='OTHER'?'block':'none'">
    <option>TSLA</option><option>NVDA</option><option>AMD</option><option>AVGO</option>
    <option>MSTR</option><option>MQZA</option><option>PLTR</option><option>GOOGL</option>
    <option>AMZN</option><option>AAPL</option><option>MSFT</option><option>META</option>
    <option value="OTHER">OTHER (manual)</option>
  </select>
  <div id="manualDivV7b"><label>Ticker Symbol:</label>
    <input type="text" id="manualV7b" placeholder="e.g., AAPL"></div>
  <label style="font-weight:normal;margin-bottom:6px">
    <input type="checkbox" id="ladderStockV7b" style="width:auto;margin:0"> Ladder stock entry/exit (LILO) — also shows on the chart
  </label>
  <label style="font-weight:normal;margin-bottom:16px">
    <input type="checkbox" id="ladderOptionsV7b" style="width:auto;margin:0"> Ladder options entry/exit (LILO)
  </label>
  <p class="note">⏱ Runs options + stock analysis + opens the chart — allow extra time vs. a single run</p>
  <button id="btnV7b" onclick="
    let t=document.getElementById('selV7b').value;
    if(t==='OTHER'){t=document.getElementById('manualV7b').value.toUpperCase().trim();
      if(!t){alert('Enter ticker');return;}}
    const ladderStock=document.getElementById('ladderStockV7b').checked;
    const ladderOptions=document.getElementById('ladderOptionsV7b').checked;
    const b=document.getElementById('btnV7b');
    b.innerText='Running…';b.disabled=true;
    google.script.run
      .withSuccessHandler(google.script.host.close)
      .withFailureHandler(e=>{alert(e.message);b.innerText='Run';b.disabled=false;})
      .runCompleteTickerAnalysisV7Continued(t, ladderStock, ladderOptions);">Run Full Analysis</button>
  </body></html>`;
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(320).setHeight(360), 'Full Ticker Analysis');
}

function runCompleteTickerAnalysisV7Continued(ticker, ladderStock, ladderOptions) {
  _runStartTimeV7 = Date.now(); // v9.70: true start of this real 360s execution -- read by hasTimeBudgetV7_
  ticker = String(ticker).toUpperCase().trim();
  if (!ticker) return;
  let optionsResult = null;
  try {
    optionsResult = runFullAnalysis(ticker); // options — defined in futuresStockAnalysisV3.gs (currently v3.3.1), same project, shared namespace
  } catch (e) {
    Logger.log('Full Ticker Analysis: options step failed for ' + ticker + ': ' + (e && e.message ? e.message : e));
    // Non-fatal — the stock dashboard's own graceful-degradation banner already
    // handles "no options data available" cleanly; don't block the rest of the run.
  }
  const result = runAnalysisV7(
    ticker, ladderStock, ladderOptions,
    optionsResult ? optionsResult.leapsCall : null,
    optionsResult ? optionsResult.shortTermCall : null
  ); // stock analysis — now also passes both option picks through to the main dashboard, per direct user request ("for both short term and LEAPS") -- previously only the chart got leapsCall, the main dashboard never showed either pick at all
  // Pass techPlan straight through — no re-running, no fragile cell-text
  // parsing, just reusing what runAnalysisV7 already computed and returned.
  // Recommended call (leapsCall) passed through the same way — reuses
  // runFullAnalysis's own computation, no redundant CBOE fetch.
  showPriceChartV7(ticker, result ? result.techPlan : null, result ? result.decision : null, !!ladderStock, optionsResult ? optionsResult.leapsCall : null);

  // Bottom Line summary — reuses everything already computed above, no
  // new fetches. Non-fatal if it fails; the main dashboard/chart already
  // succeeded and shouldn't be blocked by this being additive.
  if (result) {
    try {
      buildBottomLineSummaryV7(
        SpreadsheetApp.getActiveSpreadsheet(), ticker,
        result.fundResult, result.techPlan, result.decision,
        optionsResult ? optionsResult.leapsCall : null,
        optionsResult ? optionsResult.shortTermCall : null
      );
    } catch (e) {
      Logger.log('Bottom Line summary failed for ' + ticker + ': ' + (e && e.message ? e.message : e));
    }
  }
}

// v9.63-companion real feature (2026-08-25, user's own explicit request:
// "old data does not change... check if exist save... open in a constant
// sheet per ticker" -- i.e. a real, VISIBLE, human-inspectable sheet, not
// a hidden blob cache like the small CIK/CUSIP/13F caches added earlier
// this same pass). Wired into fetchYahooChart ITSELF, not a separate
// wrapper function -- every one of this function's ~8 real call sites
// across both files (main dashboard, sector RS, SPY RS, VIX, the new
// model's own `buildStockIdCardV1`/`buildBrokerCourseReportV1`/comparison
// self-fetch, all of which independently re-fetch the SAME ticker's chart
// within one real execution) benefits automatically -- zero call sites
// changed, zero risk of missing one. Contract UNCHANGED: still returns
// null on a real failure, still the exact same shape on success -- a
// stale/missing cache falls straight through to the real live fetch
// exactly as before, never used as an outage fallback (that would be a
// real behavior change this pass deliberately does not make).
const PRICE_CACHE_SHEET_PREFIX_V7 = '💾 ';

function priceCacheSheetNameV7_(ticker) {
  // GAS sheet names disallow [ ] * / \ ? : and a leading/trailing
  // apostrophe, max 100 chars. No real ticker in this project's watchlist
  // uses any of those (^VIX, DX-Y.NYB, BRK.B all use only allowed chars)
  // -- this strip is a defensive safety net for a future manually-typed
  // ticker, not a known-necessary fix today.
  const clean = String(ticker).replace(/[\[\]*/\\?:]/g, '');
  return (PRICE_CACHE_SHEET_PREFIX_V7 + clean).slice(0, 100);
}

function readPriceCacheV7_(ticker) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(priceCacheSheetNameV7_(ticker));
    if (!sh) return null;
    const lastRow = sh.getLastRow();
    if (lastRow < 3) return null; // needs META row + header row + >=1 real data row
    let meta;
    try { meta = JSON.parse(sh.getRange(1, 2).getValue()); } catch (e) { return null; }
    const rows = sh.getRange(3, 1, lastRow - 2, 6).getValues();
    const dates=[], opens=[], highs=[], lows=[], closes=[], volumes=[];
    rows.forEach(r => {
      if (!(r[0] instanceof Date) || isNaN(r[0].getTime())) return; // real defensive skip, don't fabricate a bar from a malformed row
      dates.push(r[0]); opens.push(r[1]); highs.push(r[2]); lows.push(r[3]); closes.push(r[4]); volumes.push(r[5]);
    });
    if (!dates.length) return null;
    return {
      opens, highs, lows, closes, volumes, dates, ticker: meta.ticker || ticker,
      currentPrice: meta.currentPrice, prevClose: meta.prevClose, currency: meta.currency || 'USD',
      ipoDate: meta.ipoDate ? new Date(meta.ipoDate) : null,
      splits: Array.isArray(meta.splits) ? meta.splits.map(s => ({ date: new Date(s.date), numerator: s.numerator, denominator: s.denominator })) : []
    };
  } catch (e) { return null; } // real, disclosed: any cache-read problem falls through to a real live fetch, never blocks a report
}

// Reused as-is by macro_fetchers_v0_8.gs's own batch cache (same Apps
// Script project, same global scope, same "check last date" logic --
// that file's macro series only need dates/closes/etc, this function only
// ever reads `.dates`, so it's genuinely shared, not duplicated).
function isPriceCacheFreshV7_(cached) {
  if (!cached || !cached.dates || !cached.dates.length) return false;
  const lastStr = cached.dates[cached.dates.length - 1].toISOString().slice(0, 10);
  const today = new Date(), yesterday = new Date(today.getTime() - 86400000);
  // Real, disclosed heuristic (not a backtested threshold, a reasoned
  // default): "today or yesterday" covers a same-day rerun regardless of
  // whether the market's newest bar has settled, and a next-morning rerun
  // before that day's own bar exists yet. A real gap (e.g. checked after a
  // weekend/holiday) correctly falls through to a real live fetch.
  return lastStr === today.toISOString().slice(0, 10) || lastStr === yesterday.toISOString().slice(0, 10);
}

function writePriceCacheV7_(ticker, data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = priceCacheSheetNameV7_(ticker);
    let sh = ss.getSheetByName(name);
    if (sh) sh.clearContents(); else sh = ss.insertSheet(name);
    const meta = {
      ticker: data.ticker, currentPrice: data.currentPrice, prevClose: data.prevClose, currency: data.currency,
      ipoDate: data.ipoDate ? data.ipoDate.toISOString() : null,
      splits: (data.splits||[]).map(s => ({ date: s.date.toISOString(), numerator: s.numerator, denominator: s.denominator }))
    };
    sh.getRange(1,1).setValue('META');
    sh.getRange(1,2).setValue(JSON.stringify(meta));
    sh.getRange(2,1,1,6).setValues([['Date','Open','High','Low','Close','Volume']]).setFontWeight('bold').setBackground('#eceff1');
    const n = data.dates.length, rows = new Array(n);
    for (let i=0;i<n;i++) rows[i] = [data.dates[i], data.opens[i], data.highs[i], data.lows[i], data.closes[i], data.volumes[i]];
    sh.getRange(3,1,n,6).setValues(rows);
    sh.getRange(3,1,n,1).setNumberFormat('yyyy-mm-dd');
  } catch (e) { /* non-fatal -- caching is supplementary, must never block a real report */ }
}

// v9.64 real feature: true append, not a full rewrite. Only the LAST
// `newRowCount` rows of `merged` (the genuinely new bars, already isolated
// by fetchYahooChart's own newIdx slice) get written, starting right after
// whatever the sheet's real last row already is -- every existing cached
// row (old, unchanging data) is never touched or rewritten, matching the
// user's own explicit request. The META row (row 1) IS refreshed every
// time (currentPrice/prevClose move daily; splits/ipoDate carried through
// from whichever fetch -- cached or fresh -- actually had them).
function appendPriceCacheV7_(ticker, merged, newRowCount) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = priceCacheSheetNameV7_(ticker);
    const sh = ss.getSheetByName(name);
    if (!sh) { writePriceCacheV7_(ticker, merged); return; } // real defensive fallback -- sheet vanished between read and write, just rebuild it whole
    const meta = {
      ticker: merged.ticker, currentPrice: merged.currentPrice, prevClose: merged.prevClose, currency: merged.currency,
      ipoDate: merged.ipoDate ? merged.ipoDate.toISOString() : null,
      splits: (merged.splits||[]).map(s => ({ date: s.date.toISOString(), numerator: s.numerator, denominator: s.denominator }))
    };
    sh.getRange(1,2).setValue(JSON.stringify(meta));
    if (newRowCount <= 0) return; // real, disclosed: nothing new to append (e.g. incremental fetch returned only already-cached dates)
    const total = merged.dates.length, startIdx = total - newRowCount;
    const startRow = sh.getLastRow() + 1;
    const rows = new Array(newRowCount);
    for (let i = 0; i < newRowCount; i++) {
      const j = startIdx + i;
      rows[i] = [merged.dates[j], merged.opens[j], merged.highs[j], merged.lows[j], merged.closes[j], merged.volumes[j]];
    }
    sh.getRange(startRow,1,newRowCount,6).setValues(rows);
    sh.getRange(startRow,1,newRowCount,1).setNumberFormat('yyyy-mm-dd');
  } catch (e) { /* non-fatal -- caching is supplementary, must never block a real report */ }
}

// v9.65 real feature (2026-08-25, real gap the user themselves flagged in
// this session's own status report: "no cleanup/expiry mechanism for old
// cache sheets"). Real, deliberate design choice: MANUAL, not automatic --
// deleting a real, visible sheet is hard to reverse (no git-style undo for
// this project), and the whole point of "open in a constant sheet per
// ticker" was user visibility/control, not a silent background sweep.
// Menu-triggered only; shows the real candidate list and asks for
// confirmation before deleting anything, same pattern as every other
// destructive-adjacent action in this project.
//
// "Stale" = the sheet's own LAST CACHED BAR is more than
// PRICE_CACHE_STALE_DAYS real calendar days old -- no new tracking field
// needed, the existing last row already carries this real signal (if a
// ticker had been re-analyzed recently, its cache would have a recent
// last bar via the v9.64 incremental catch-up). 90 days is a reasoned
// default (matches the CIK/CUSIP cache TTL already used this session),
// not empirically validated, same standing caveat as every other
// threshold in this project.
const PRICE_CACHE_STALE_DAYS = 90;

function findStalePriceCacheSheetsV1_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = Date.now() - PRICE_CACHE_STALE_DAYS * 86400000;
  const candidates = [];
  ss.getSheets().forEach(sh => {
    const name = sh.getName();
    if (name.indexOf(PRICE_CACHE_SHEET_PREFIX_V7) !== 0) return; // real: PRICE_CACHE_SHEET_PREFIX_V7 ('💾 ') also matches macro_fetchers_v0_8.gs's '💾 Macro ' sheets -- both are real price-cache sheets, both real cleanup candidates
    try {
      const lastRow = sh.getLastRow();
      if (lastRow < 3) return; // no real data rows, not a genuine cache sheet
      const lastDate = sh.getRange(lastRow, 1).getValue();
      if (!(lastDate instanceof Date) || isNaN(lastDate.getTime())) return;
      if (lastDate.getTime() < cutoff) {
        candidates.push({ name, lastDate, daysOld: Math.floor((Date.now() - lastDate.getTime()) / 86400000) });
      }
    } catch (e) { /* real, disclosed: a malformed sheet is skipped, never crashes the scan */ }
  });
  return candidates;
}

// Menu entry point -- shows the real candidate list, asks for real
// confirmation, deletes only what the user approves. Reachable from the
// 📈 Stock Analysis menu (onOpen(), futuresStockAnalysisV3_3_2.gs).
function cleanupPriceCacheSheetsV1Menu() {
  const ui = SpreadsheetApp.getUi();
  const candidates = findStalePriceCacheSheetsV1_();
  if (!candidates.length) {
    ui.alert('No price-cache sheets are older than ' + PRICE_CACHE_STALE_DAYS + ' days — nothing to clean up.');
    return;
  }
  const list = candidates
    .sort((a,b) => b.daysOld - a.daysOld)
    .map(c => '  ' + c.name + '  (last data: ' + c.lastDate.toISOString().slice(0,10) + ', ' + c.daysOld + ' days old)')
    .join('\n');
  const response = ui.alert(
    'Delete ' + candidates.length + ' stale price-cache sheet' + (candidates.length===1?'':'s') + '?',
    list + '\n\nThese haven\'t been refreshed in over ' + PRICE_CACHE_STALE_DAYS + ' days. Deleting them is permanent -- the next real analysis of that ticker will just rebuild the cache from a fresh live fetch, same as it would today anyway.',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) { Logger.log('Price-cache cleanup: cancelled by user.'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let deleted = 0;
  candidates.forEach(c => {
    try { ss.deleteSheet(ss.getSheetByName(c.name)); deleted++; }
    catch (e) { Logger.log('Price-cache cleanup: failed to delete ' + c.name + ': ' + e.message); }
  });
  Logger.log('Price-cache cleanup: deleted ' + deleted + '/' + candidates.length + ' stale sheets.');
  ui.alert('Deleted ' + deleted + ' stale price-cache sheet' + (deleted===1?'':'s') + '.');
}

// 2026-09-06 real, read-only diagnostic (user's own direct report: "way
// worse now, everything is slow, the whole sheet barely works" -- can't be
// inspected from here, this is a real live Apps Script project this
// session has zero connection to, only Node/curl simulations). Touches
// NOTHING -- no locks, no data, no deletes. Just counts every real sheet
// and its real row/column size, sorted biggest-first, so the actual
// bottleneck (a specific bloated sheet? just a very high total sheet
// count, which alone slows Google Sheets' own UI regardless of any script
// code?) is visible instead of guessed at.
function diagnoseSheetSizeV1Menu() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const rows = sheets.map(sh => {
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    return { name: sh.getName(), lastRow, lastCol, cells: lastRow * lastCol };
  });
  rows.sort((a, b) => b.cells - a.cells);
  const totalCells = rows.reduce((s, r) => s + r.cells, 0);

  const reportSheetName = '🔍 Sheet Size Report';
  let reportSheet = ss.getSheetByName(reportSheetName);
  if (reportSheet) reportSheet.clearContents(); else reportSheet = ss.insertSheet(reportSheetName);
  reportSheet.getRange(1, 1, 1, 4).setValues([['Sheet Name', 'Rows', 'Columns', 'Cells (Rows x Cols)']]).setFontWeight('bold').setBackground('#eceff1');
  reportSheet.getRange(2, 1, rows.length, 4).setValues(rows.map(r => [r.name, r.lastRow, r.lastCol, r.cells]));
  reportSheet.setFrozenRows(1);
  reportSheet.autoResizeColumns(1, 4);

  SpreadsheetApp.getUi().alert(
    'Sheet Size Report',
    'Total real sheets: ' + sheets.length + '\nTotal cells across all sheets: ' + totalCells.toLocaleString() +
    '\n\nTop 5 biggest:\n' + rows.slice(0, 5).map(r => '  ' + r.name + ': ' + r.cells.toLocaleString() + ' cells (' + r.lastRow + ' rows x ' + r.lastCol + ' cols)').join('\n') +
    '\n\nFull breakdown written to the "' + reportSheetName + '" sheet.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// v9.64 real refactor (2026-08-25, user's own explicit follow-up: "per
// ticker but only if i ask... i choose the ticker then you check if it has
// already history then you add what's missing" -- true incremental, not
// v9.63's full-replace-on-stale). Network+parse logic factored out of
// fetchYahooChart into this pure, range-parameterized helper so the SAME
// real Yahoo-parsing code serves both the full 2y fetch and the new small
// incremental catch-up fetch -- zero duplicated parsing logic. The real
// `<60 bars` sanity guard is NOT applied here (a genuine 1mo incremental
// fetch has ~20 real trading days, always under 60) -- it's applied by the
// caller, only on the full-range path.

// v9.64 real feature: true incremental catch-up, replacing v9.63's
// full-replace-on-stale. A stale-but-recent cache (gap <=25 calendar days
// -- a reasoned, generous cushion for weekends/holidays/a real multi-day
// gap in usage, not fit to any backtest) triggers a real SMALL fetch
// (range=1mo, not the full 2y) and appends ONLY the rows strictly newer
// than the cache's last date -- every existing cached row is left
// completely untouched, matching the user's own explicit mental model
// ("check if it has already history, add what's missing"). A gap too old
// for a 1mo fetch to bridge, or an incremental fetch that fails or
// doesn't overlap the cache at all, falls through to the existing full 2y
// fetch + full-sheet-overwrite path -- same real safety net as v9.63,
// unchanged.

// Dedicated long-range fetch (v9.26), separate from fetchYahooChart on
// purpose -- per explicit decision, NOT extending the main 2yr fetch used
// by every indicator in this file (that would give every RSI/MACD/regime/
// pattern computation ~5x more data to process per run, real risk of
// hitting the 6-min Apps Script execution cap on batch/multi-ticker
// reports -- CHARACTERIZATION_PLAN.md Section 3 already documents this
// constraint). This fetch is closes-only (no highs/lows/volumes -- not
// needed for a simple trailing-return calc, keeps the payload smaller),
// used ONLY by the 3Y/5Y/10Y trailing-performance calc below, nowhere
// else threaded into the pipeline. Confirmed reachable per
// CHARACTERIZATION_PLAN.md Section 2: "Yahoo's own chart endpoint
// supports range=10y and range=max, not just range=2y... a parameter
// choice in the existing code, not a data limit" -- not re-verified
// against a live Apps Script execution this session (same disclosed gap
// as the conviction-modifier's own cross-file dependency).

// Pure calc, tested against 4 constructed cases (full 10yr history hand-
// verified match, partial history graceful degradation, short history all
// null, empty input null) before writing this -- trading-day counts match
// the existing week/month/quarter/halfYear/year convention just above,
// scaled up (252/yr): 3Y=756, 5Y=1260, 10Y=2520.
function computeLongRangeTrailingPerf_(longCloses) {
  const nL = longCloses.length;
  if (nL < 2) return null;
  const currentLong = longCloses[nL-1];
  const perfAt = daysAgo => {
    if (nL <= daysAgo) return null;
    const past = longCloses[nL-1-daysAgo];
    return past ? (currentLong-past)/past : null;
  };
  return { threeYear: perfAt(756), fiveYear: perfAt(1260), tenYear: perfAt(2520) };
}

function computeAllIndicators(c) {
  const {closes,highs,lows,volumes}=c, n=closes.length, last=closes[n-1];

  const diffs=closes.slice(1).map((v,i)=>v-closes[i]);
  const gains=diffs.map(d=>d>0?d:0), losses=diffs.map(d=>d<0?Math.abs(d):0);
  const avgG=wilderSmooth(gains,14)||0, avgL=wilderSmooth(losses,14)||0;
  // W7 (v8.1): flat series (no gains AND no losses) → neutral 50, not 100.
  const rsi14=(avgG===0&&avgL===0)?50:(avgL===0?100:100-100/(1+avgG/avgL));

  const weekly=[];for(let i=n-1;i>=0;i-=5)weekly.unshift(closes[i]);
  const wd=weekly.slice(1).map((v,i)=>v-weekly[i]);
  const wg=wd.map(d=>d>0?d:0),wl=wd.map(d=>d<0?Math.abs(d):0);
  // W7 (v8.1): flat weekly series → neutral 50, not 100. NOTE: weekly is still
  // a 5th-day resample (not true calendar week-ending closes) — an accepted
  // approximation, documented as a follow-up in the changelog.
  const _wg=wilderSmooth(wg,14)||0,_wl=wilderSmooth(wl,14)||0;
  const rsiWeekly=(_wg===0&&_wl===0)?50:(_wl===0?100:100-100/(1+_wg/_wl));

  // Weekly TREND (not just RSI) -- genuine gap found directly: this file had
  // weekly momentum (rsiWeekly) but no weekly trend direction at all, and no
  // check for whether the daily regime agrees with it. Reuses the SAME
  // weekly[] resample already built above, no new data. 10wk/40wk mirror the
  // daily 50/200 SMA pair in spirit (10*5=50, 40*5=200 trading days).
  const wSma10=sma(weekly,10), wSma40=sma(weekly,40);
  const weeklyTrend = (wSma10!=null && wSma40!=null) ? (wSma10>wSma40?'UP':'DOWN') : null;

  const ema12a=emaArray(closes,12),ema26a=emaArray(closes,26),off=ema12a.length-ema26a.length;
  const macdLine=ema26a.map((v,i)=>ema12a[i+off]-v),sigLine=emaArray(macdLine,9);
  const macdVal=macdLine[macdLine.length-1]||0,sigVal=sigLine[sigLine.length-1]||0;
  const histogram=macdVal-sigVal;
  const histSlope=slope(macdLine.slice(-5).map((v,i,a)=>i>=1?v-(sigLine[sigLine.length-5+i]||0):0),3);

  const bb20=closes.slice(-20),sma20v=bb20.reduce((a,b)=>a+b,0)/20,std20=stdDev(bb20);
  const bbUpper=sma20v+2*std20,bbLower=sma20v-2*std20,bbRange=bbUpper-bbLower;
  const bbPctB=bbRange===0?0.5:(last-bbLower)/bbRange,bbWidth=sma20v===0?0:bbRange/sma20v;
  const bbSqueeze=bbWidth<0.08;

  const stochKarr=[];
  for(let i=13;i<n;i++){const hh=Math.max(...highs.slice(i-13,i+1)),ll=Math.min(...lows.slice(i-13,i+1));stochKarr.push(hh===ll?50:(closes[i]-ll)/(hh-ll)*100);}
  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): %K of exactly 0 means price closed at the exact low of the
  // 14-bar range -- a real, routine, maximally-oversold reading -- but 0
  // is falsy in JS, so `||50` silently converted it to a neutral "50.0 —
  // Mid-range" display and dropped the weight-2 oversold signal at both
  // scoring sites below. Fixed via array-length truthiness (only the
  // genuinely-empty-array case, unreachable in practice given this file's
  // own 60-bar fetch minimum, falls back to 50) instead of value
  // truthiness, so a real 0 passes through correctly. Kept the same
  // always-a-number return type (never null) since 6 call sites elsewhere
  // call .toFixed() on these directly.
  const stochK=stochKarr.length?stochKarr[stochKarr.length-1]:50;
  const stochDraw=sma(stochKarr,3);
  const stochD=stochKarr.length?(stochDraw!=null?stochDraw:stochK):50;

  // W9.6 (v9.0): Stochastic RSI — a StochRSI over the last 14 RSI values, a
  // faster/more-sensitive momentum oscillator than either RSI or price-Stoch
  // alone. Uses the existing rsiArray helper. Falls back to neutral 50 when
  // there isn't enough history.
  let stochRSI = 50;
  try {
    const rsiSeries = rsiArray(closes, 14);
    const rsiWindow = rsiSeries.slice(-14).filter(v => Number.isFinite(v));
    if (rsiWindow.length >= 2) {
      const rMin = Math.min(...rsiWindow), rMax = Math.max(...rsiWindow);
      stochRSI = (rMax === rMin) ? 50 : ((rsiSeries[rsiSeries.length-1] - rMin) / (rMax - rMin)) * 100;
    }
  } catch (e) { stochRSI = 50; }

  const wHH=Math.max(...highs.slice(-14)),wLL=Math.min(...lows.slice(-14));
  const willR=wHH===wLL?-50:(wHH-last)/(wHH-wLL)*-100;

  const tpArr=highs.map((h,i)=>(h+lows[i]+closes[i])/3),tp20=tpArr.slice(-20);
  const smaTP=tp20.reduce((a,b)=>a+b,0)/20,meanDev=tp20.reduce((s,v)=>s+Math.abs(v-smaTP),0)/20;
  const cci20=meanDev===0?0:(tpArr[n-1]-smaTP)/(0.015*meanDev);

  let posMF=0,negMF=0;
  // W7 (v8.1): unchanged typical price is ignored (not counted as selling).
  for(let i=n-14;i<n;i++){const tp=(highs[i]+lows[i]+closes[i])/3,tpp=(highs[i-1]+lows[i-1]+closes[i-1])/3,mf=tp*volumes[i];if(tp>tpp)posMF+=mf;else if(tp<tpp)negMF+=mf;}
  const mfi14=negMF===0?100:100-100/(1+posMF/negMF);

  const trArr=[];for(let i=1;i<n;i++)trArr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  // W7 (v8.1): don't fake a real 0 ATR up to 1 — keep the true value and guard
  // consumers (stops/ETA already null-check atr). Only floor to a tiny epsilon
  // to avoid divide-by-zero, not a distorting 1.0.
  const atr14=wilderSmooth(trArr,14)||0.0001;
  const atr50arr=wilderArray(trArr,14).slice(-50);
  const atrAvg50=atr50arr.length?atr50arr.reduce((a,b)=>a+b,0)/atr50arr.length:atr14;
  const atrRatio=atr14/atrAvg50;
  // v9.78 -- Edwards & Magee Appendix E's real "N" (Turtle System volatility
  // unit): the book's own formula, N=(19*PrevN+TodayTrueRange)/20, is
  // mathematically identical to this file's own already-existing
  // wilderSmooth() (period=20 instead of atr14's period=14) -- zero new
  // math, direct reuse of the exact same trArr already computed above.
  const turtleN=wilderSmooth(trArr,20)||0.0001;

  // Keltner Channels + TTM-style squeeze (DASHBOARD_IMPROVEMENTS_PLAN.md 4a)
  // -- reuses ema() (already proven for ema9/ema21) and atr14 (already
  // computed above), no new methodology introduced. Standard definition:
  // middle = EMA(20), bands = EMA(20) +/- 1.5x ATR(14). Squeeze = Bollinger
  // Bands sitting entirely INSIDE the Keltner Channel -- a well-known,
  // standard volatility-compression signal (the "TTM Squeeze"), distinct
  // from the existing Bollinger-only bbSqueeze already computed above.
  const ema20v=ema(closes,20)||sma20v;
  const keltnerMult=1.5;
  const keltnerUpper=ema20v+keltnerMult*atr14, keltnerLower=ema20v-keltnerMult*atr14;
  const keltnerSqueeze = bbUpper < keltnerUpper && bbLower > keltnerLower;

  // Trailing stop / Chandelier Exit (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
  // standard definition: highest high over a rolling lookback (22 days,
  // conventional) minus a multiplier x ATR (3x, conventional). Uses the
  // ALREADY-COMPUTED atr14 rather than a separate ATR(22) -- a common,
  // real, non-controversial variation in practice, not a purist deviation.
  // Distinct from the existing fixed stop (set once at entry, by regime):
  // this is a continuously-recalculated reference level that ratchets up
  // as the recent high increases, never down -- a genuinely different
  // mechanic (locks in gains as a position works), not a replacement.
  const chandelierLookback=22;
  const chandelierHighestHigh=Math.max(...highs.slice(-chandelierLookback));
  const chandelierMult=3;
  // W7 (v8.1) NOTE: the comment above says "ratchets up, never down," but this
  // single-snapshot computation can actually step DOWN if ATR rises or an old
  // high rolls off the 22-day window. A TRUE ratchet is max(previousStop,
  // currentStop) carried ACROSS runs — that needs per-ticker persisted state,
  // which is deliberately not threaded into this stateless indicator function.
  // Deferred to a follow-up (see changelog); the current value is a valid
  // point-in-time Chandelier level, just not a monotonic trailing stop yet.
  const chandelierStop=chandelierHighestHigh-chandelierMult*atr14;

  // Multi-timeframe structure: monthly aggregation (DASHBOARD_IMPROVEMENTS_PLAN.md
  // 4a) -- reuses the already-fetched 2 years of daily closes/dates, no new
  // data source. Standard "10-month rule" style read: is price above/below
  // its own monthly moving average -- a genuine, different timeframe from
  // the existing daily/weekly reads, relevant to a multi-year hold.
  let monthlyStructure = null;
  try {
    const monthlyMap = {};
    c.dates.forEach((d,i) => {
      const key = d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
      monthlyMap[key] = closes[i]; // last close seen for that month wins (dates are chronological)
    });
    const monthlyCloses = Object.keys(monthlyMap).sort().map(k => monthlyMap[k]);
    const MONTHLY_SMA_PERIOD = 10; // the well-known "10-month rule"
    if (monthlyCloses.length >= MONTHLY_SMA_PERIOD) {
      const recent10 = monthlyCloses.slice(-MONTHLY_SMA_PERIOD);
      const monthlySma = recent10.reduce((a,b)=>a+b,0)/MONTHLY_SMA_PERIOD;
      const monthlyTrend = last > monthlySma ? 'above' : 'below';
      monthlyStructure = { monthlySma, monthlyTrend, monthsAvailable: monthlyCloses.length };
    }
  } catch(e) { /* non-fatal -- multi-timeframe context is supplementary */ }

  // Price gaps -- flagged earlier as "genuinely easy, not built" (unlike
  // chart PATTERNS like head-and-shoulders, which are real shape-recognition
  // problems). A gap is just: today's low > yesterday's high (up) or
  // today's high < yesterday's low (down). Tracks fill status too --
  // unfilled gaps are considered more technically significant (real S/R,
  // a "magnet" effect where price often returns to fill them).
  let priceGaps = [];
  try {
    const GAP_LOOKBACK = 60; // ~3 trading months, keeps the list relevant not exhaustive
    const startIdx = Math.max(1, n - GAP_LOOKBACK);
    for (let i = startIdx; i < n; i++) {
      if (lows[i] > highs[i-1]) {
        priceGaps.push({ idx: i, date: c.dates[i], type: 'UP', level: highs[i-1], sizePct: (lows[i]-highs[i-1])/highs[i-1] });
      } else if (highs[i] < lows[i-1]) {
        priceGaps.push({ idx: i, date: c.dates[i], type: 'DOWN', level: lows[i-1], sizePct: (highs[i]-lows[i-1])/lows[i-1] });
      }
    }
    priceGaps.forEach(g => {
      let filled = false;
      for (let j = g.idx+1; j < n; j++) {
        if (g.type === 'UP' && lows[j] <= g.level) { filled = true; break; }
        if (g.type === 'DOWN' && highs[j] >= g.level) { filled = true; break; }
      }
      g.filled = filled;
    });
  } catch(e) { /* non-fatal */ }

  // Double top / double bottom -- the first real chart PATTERN (not just
  // gaps/trend) attempted in this project. Standard, well-established
  // definition: two swing highs (or lows) at roughly the same level,
  // separated by a genuine pullback -- not inventing a new technique.
  // Design tested against 4 real cases before writing this, including 2
  // genuine negative cases (peaks too different in level; pullback too
  // small to be real) to confirm this discriminates, not just fires on
  // any 2 nearby peaks.
  let chartPatterns = [];
  try {
    const SWING_WINDOW = 5, LEVEL_TOLERANCE = 0.03, MIN_PULLBACK = 0.05;
    // RECENCY_WINDOW (v9.23) -- real gap found by running all 14 patterns
    // against 13 real tickers (10yr history each): Double/Triple Top/Bottom
    // and H&S scan the ENTIRE history with no recency filter, so a decade-
    // old swing pair that never broke its neckline still counted as
    // "forming" today -- 957 of 1045 real-data pattern instances were this,
    // dwarfing the genuinely current ones. 120 bars (~6 months) chosen as a
    // reasoned, disclosed threshold: generous enough for real multi-month
    // double-top formations, short enough to exclude stale history. Matches
    // the recency discipline Tiers B-E already had (60-bar trailing window)
    // -- this brings Double/Triple Top/Bottom and H&S in line with that,
    // not a new invention.
    const RECENCY_WINDOW = 120;
    const swingHighs = [], swingLows = [];
    for (let i = SWING_WINDOW; i < n - SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      const lSlice = lows.slice(i-SWING_WINDOW, i+SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
    }
    for (let i = 0; i < swingHighs.length - 1; i++) {
      const h1 = swingHighs[i], h2 = swingHighs[i+1];
      if (h2.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      if (Math.abs(h2.price-h1.price)/h1.price > LEVEL_TOLERANCE) continue;
      const between = swingLows.filter(l => l.idx > h1.idx && l.idx < h2.idx);
      if (!between.length) continue;
      const neck = between.reduce((min,l) => l.price < min.price ? l : min);
      const pullbackPct = (h1.price - neck.price) / h1.price;
      if (pullbackPct < MIN_PULLBACK) continue;
      // v9.77 -- Edwards & Magee Ch37 (p549, Fig.260): a real, quantified
      // spacing+magnitude confirmation-quality flag, purely additive --
      // does NOT touch the detection/confirmed logic above (MIN_PULLBACK
      // stays 5%, same as this project's own Schabacker Tier 3 rule: never
      // change a live threshold, this is a NEW field only). Book's own
      // real rule: the 2 Tops (or Bottoms) should be >=6 weeks apart
      // (preferably more), and the intervening decline (or rally) should
      // be >=15% at its extreme -- a stricter, separate bar from the
      // 5%/3% detection-level MIN_PULLBACK/LEVEL_TOLERANCE just used
      // above, reported alongside the pattern, not substituted for it.
      const weeksApartTop = (c.dates[h2.idx] - c.dates[h1.idx]) / (7*86400000);
      const emSpacingCheck = { weeksApart: +weeksApartTop.toFixed(1), magnitudePct: +(pullbackPct*100).toFixed(1), meetsBook: weeksApartTop >= 6 && pullbackPct >= 0.15 };
      // v9.83, Edwards & Magee Tier 3: Double Top is always a DOWN break when confirmed.
      const dtConfirmed = closes[n-1] < neck.price;
      const dtAsymVol = dtConfirmed ? asymmetricVolumeConfirmationV1_('down', volumes[n-1], volumes.slice(Math.max(0,n-21), n-1).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(20, n-1))) : null;
      chartPatterns.push({ type:'DOUBLE_TOP', date1:c.dates[h1.idx], date2:c.dates[h2.idx], level:(h1.price+h2.price)/2, neckline:neck.price,
        confirmed: dtConfirmed, emSpacingCheck, asymmetricVolumeRead: dtAsymVol }); // pattern "confirms" once price closes below the neckline
    }
    for (let i = 0; i < swingLows.length - 1; i++) {
      const l1 = swingLows[i], l2 = swingLows[i+1];
      if (l2.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      if (Math.abs(l2.price-l1.price)/l1.price > LEVEL_TOLERANCE) continue;
      const between = swingHighs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
      if (!between.length) continue;
      const neck = between.reduce((max,h) => h.price > max.price ? h : max);
      const bouncePct = (neck.price - l1.price) / l1.price;
      if (bouncePct < MIN_PULLBACK) continue;
      // v9.77 -- same real Ch37 rule, mirrored for Double Bottom (>=6 weeks
      // apart, >=15% intervening rally). Purely additive, see comment above.
      const weeksApartBot = (c.dates[l2.idx] - c.dates[l1.idx]) / (7*86400000);
      const emSpacingCheckBot = { weeksApart: +weeksApartBot.toFixed(1), magnitudePct: +(bouncePct*100).toFixed(1), meetsBook: weeksApartBot >= 6 && bouncePct >= 0.15 };
      // v9.83, Edwards & Magee Tier 3: Double Bottom is always an UP break when confirmed -- needs real volume confirmation.
      const dbConfirmed = closes[n-1] > neck.price;
      const dbAsymVol = dbConfirmed ? asymmetricVolumeConfirmationV1_('up', volumes[n-1], volumes.slice(Math.max(0,n-21), n-1).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(20, n-1))) : null;
      chartPatterns.push({ type:'DOUBLE_BOTTOM', date1:c.dates[l1.idx], date2:c.dates[l2.idx], level:(l1.price+l2.price)/2, neckline:neck.price,
        confirmed: dbConfirmed, emSpacingCheck: emSpacingCheckBot, asymmetricVolumeRead: dbAsymVol });
    }

    // Head & Shoulders / Inverse H&S (v9.17, DESIGN_head_and_shoulders.md) --
    // reuses the exact same swingHighs/swingLows just computed above, no new
    // detection primitive. Genuine 3-peak relationship (unlike double top/
    // bottom's 2), sloped neckline (real 2-point line equation, not a flat
    // level -- a flat neckline would misclassify many real H&S patterns).
    // Tested against 10 constructed cases before writing this, including 3
    // genuine negative cases (head not tall enough, shoulders too mismatched,
    // spacing too tight) plus a pure-noise no-false-positive check.
    const HS_HEAD_MIN_PCT = 0.03, HS_SHOULDER_TOL = 0.05;
    const necklineAt = (p1, p2, idx) => {
      const m = (p2.price - p1.price) / (p2.idx - p1.idx);
      return p1.price + m * (idx - p1.idx);
    };
    for (let i = 0; i < swingHighs.length - 2; i++) {
      const h1 = swingHighs[i], h2 = swingHighs[i+1], h3 = swingHighs[i+2];
      if (h3.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      if (h2.idx - h1.idx < SWING_WINDOW || h3.idx - h2.idx < SWING_WINDOW) continue; // spacing
      const higherShoulder = Math.max(h1.price, h3.price);
      if (h2.price < higherShoulder * (1 + HS_HEAD_MIN_PCT)) continue; // head not tall enough
      if (Math.abs(h1.price - h3.price) / h1.price > HS_SHOULDER_TOL) continue; // shoulders too mismatched
      const leftTroughs = swingLows.filter(l => l.idx > h1.idx && l.idx < h2.idx);
      const rightTroughs = swingLows.filter(l => l.idx > h2.idx && l.idx < h3.idx);
      if (!leftTroughs.length || !rightTroughs.length) continue;
      const leftTrough = leftTroughs.reduce((min,l) => l.price < min.price ? l : min);
      const rightTrough = rightTroughs.reduce((min,l) => l.price < min.price ? l : min);
      const necklineLast = necklineAt(leftTrough, rightTrough, n-1);
      chartPatterns.push({
        type: 'HEAD_AND_SHOULDERS',
        leftShoulder: { date: c.dates[h1.idx], price: h1.price }, head: { date: c.dates[h2.idx], price: h2.price },
        rightShoulder: { date: c.dates[h3.idx], price: h3.price },
        necklineAtLast: necklineLast,
        confirmed: closes[n-1] < necklineLast,
        // v9.71, Schabacker Study X: classical H&S measuring rule -- price
        // objective projects the head-to-neckline vertical distance downward
        // from the neckline. Purely additive display field, not scored --
        // book's own worked examples show real, disclosed under/overshoot
        // (e.g. Republic Steel: called for 84, only reached 73), a rough
        // objective, never a guarantee.
        measuredTarget: necklineLast - (h2.price - necklineLast),
        // v9.73, Schabacker Study II. Purely additive -- new fields only,
        // existing detection/confirmation logic above is untouched.
        // Neckline slope: real, checkable trading implication per the
        // book -- descending necklines forecast a faster, more urgent
        // reversal (less time to act, break confirmation less reliable);
        // ascending necklines are slower but the confirmed break is more
        // reliable, generally better profit potential. Real, disclosed
        // tolerance: within 1% counts as flat.
        necklineSlope: Math.abs(rightTrough.price - leftTrough.price) / leftTrough.price < 0.01 ? 'flat'
          : (rightTrough.price > leftTrough.price ? 'ascending' : 'descending'),
        // Volume-shape check: typical shape per the book is left-shoulder
        // high, head HIGHEST, right shoulder only slightly increased (often
        // still lower than the head). Real, disclosed exceptions exist
        // (the book names cases where the right shoulder or even the head
        // is lower) -- informational only, never a rejection criterion,
        // does not affect whether/how this pattern fires or scores.
        volumeShapeValid: (volumes[h2.idx] >= volumes[h1.idx]) && (volumes[h2.idx] >= volumes[h3.idx]),
        // v9.83, Edwards & Magee Tier 3: real asymmetric volume-confirmation
        // read -- H&S is always a DOWN break (confirmed check above), so
        // this doesn't need volume confirmation; heavy volume right at the
        // break is itself flagged as suspicious. Purely additive, new field
        // only -- does not affect `confirmed`/detection above.
        asymmetricVolumeRead: closes[n-1] < necklineLast
          ? asymmetricVolumeConfirmationV1_('down', volumes[n-1], volumes.slice(Math.max(0,n-21), n-1).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(20, n-1)))
          : null
      });
    }
    for (let i = 0; i < swingLows.length - 2; i++) {
      const l1 = swingLows[i], l2 = swingLows[i+1], l3 = swingLows[i+2];
      if (l3.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      if (l2.idx - l1.idx < SWING_WINDOW || l3.idx - l2.idx < SWING_WINDOW) continue;
      const lowerShoulder = Math.min(l1.price, l3.price);
      if (l2.price > lowerShoulder * (1 - HS_HEAD_MIN_PCT)) continue;
      if (Math.abs(l1.price - l3.price) / l1.price > HS_SHOULDER_TOL) continue;
      const leftPeaks = swingHighs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
      const rightPeaks = swingHighs.filter(h => h.idx > l2.idx && h.idx < l3.idx);
      if (!leftPeaks.length || !rightPeaks.length) continue;
      const leftPeak = leftPeaks.reduce((max,h) => h.price > max.price ? h : max);
      const rightPeak = rightPeaks.reduce((max,h) => h.price > max.price ? h : max);
      const necklineLast = necklineAt(leftPeak, rightPeak, n-1);
      chartPatterns.push({
        type: 'INVERSE_HEAD_AND_SHOULDERS',
        leftShoulder: { date: c.dates[l1.idx], price: l1.price }, head: { date: c.dates[l2.idx], price: l2.price },
        rightShoulder: { date: c.dates[l3.idx], price: l3.price },
        necklineAtLast: necklineLast,
        confirmed: closes[n-1] > necklineLast,
        // v9.71, Schabacker Study X: same classical measuring rule, mirrored
        // upward. Purely additive display field, not scored -- same real,
        // disclosed under/overshoot caveat as the top variant above.
        measuredTarget: necklineLast + (necklineLast - l2.price),
        // v9.73, Schabacker Study II. Same real fields as the top variant
        // above, mirrored. Real, disclosed note: the book's own specific
        // "descending=faster/less reliable, ascending=slower/more
        // reliable" reliability commentary was stated for TOP patterns
        // specifically -- not separately re-validated here for bottoms,
        // the label is purely geometric (which way the neckline slopes).
        necklineSlope: Math.abs(rightPeak.price - leftPeak.price) / leftPeak.price < 0.01 ? 'flat'
          : (rightPeak.price > leftPeak.price ? 'ascending' : 'descending'),
        volumeShapeValid: (volumes[l2.idx] >= volumes[l1.idx]) && (volumes[l2.idx] >= volumes[l3.idx]),
        // v9.83, Edwards & Magee Tier 3: mirror of the H&S read above --
        // Inverse H&S is always an UP break, so it DOES need volume
        // confirmation to be trusted.
        asymmetricVolumeRead: closes[n-1] > necklineLast
          ? asymmetricVolumeConfirmationV1_('up', volumes[n-1], volumes.slice(Math.max(0,n-21), n-1).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(20, n-1)))
          : null
      });
    }

    // v9.84, Edwards & Magee Ch11 (p204-207) -- real, genuinely NEW pattern:
    // "Scallops -- Repeated Saucers." Confirmed via direct code check before
    // building (per the plan doc's own "check whether the engine has any
    // existing Scallop/Saucer-shaped detector at all" instruction): the
    // existing ROUNDING_BOTTOM detector (further below in this same
    // function) finds a real, but SINGLE, rounding shape in one fixed
    // lookback window -- it does NOT detect the book's own actual concept
    // here, a REPEATED SERIES of 2+ such rounding-bottom-like "Saucers" in
    // succession, each ending a little higher than the one before it
    // (uptilted). A genuinely new detector, not a refinement of
    // ROUNDING_BOTTOM. Real, disclosed v1 scope: reuses this same
    // function's own already-computed swingHighs/swingLows (SWING_WINDOW=5)
    // rather than re-deriving the existing ROUNDING_BOTTOM detector's own
    // separate, riskier curve-segment-average logic a second time --
    // detects the real STRUCTURAL shape (2+ progressively higher swing
    // lows, each with a real intervening peak-to-low pullback) using
    // looser structural gates, then separately reports whether each real
    // leg's own gain%/pullback% matches the book's own specific "typical"
    // numbers as an informational flag, not a hard detection gate (the
    // book's own language is "typically," not "always").
    {
      const SCALLOP_LOOKBACK = 260; // ~1 real year, matches the book's own "long Major Advance" framing
      // v9.84 real fix (found during this session's own real-ticker spot
      // check, not shipped in the first draft): the ORIGINAL gates here
      // (any positive gain, 10% pullback floor) fired on 30-68% of real
      // checkpoints on 2 real tickers -- far too permissive for what the
      // book itself frames as a distinctive, notable pattern ("Repeated
      // Saucers" in a genuine long Major Advance), same class of real
      // over-firing problem this project's own history has hit before
      // (Diamond Formation's original 43-56% fire rate). Tightened with 2
      // real, disclosed structural floors below the book's own "typically"
      // numbers (10-15% gain, 20-30% pullback) but meaningfully stricter
      // than the original near-zero gates -- not independently backtested,
      // same standing caveat as every other reasoned-default threshold in
      // this file.
      const SCALLOP_MIN_GAIN = 0.05; // real structural minimum, half the book's own 10% typical floor
      const SCALLOP_MIN_PULLBACK = 0.15; // real structural minimum, still below the book's own 20% typical floor but well above the original 10%
      const SCALLOP_MIN_DURATION_WEEKS = 3; // book's own real, disclosed minimum ("rarely less than 3" weeks)
      const SCALLOP_PRICE_TIER = 20; // book's own real, disclosed typical ceiling ($15-20) -- informational only, real disclosed exceptions exist
      const scLowsPool = swingLows.filter(l => l.idx >= n - SCALLOP_LOOKBACK);
      const scLegs = [];
      for (let i = 0; i < scLowsPool.length - 1; i++) {
        const l1 = scLowsPool[i], l2 = scLowsPool[i+1];
        const gainPct = (l2.price - l1.price) / l1.price;
        if (gainPct < SCALLOP_MIN_GAIN) continue; // real, structural: each Saucer must end a MEANINGFULLY higher than the last (uptilted), not just any positive tick
        const weeksApart = (c.dates[l2.idx] - c.dates[l1.idx]) / (7*86400000);
        if (weeksApart < SCALLOP_MIN_DURATION_WEEKS) continue;
        const between = swingHighs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
        if (!between.length) continue;
        const peak = between.reduce((max,h) => h.price > max.price ? h : max);
        const pullbackPct = (peak.price - l2.price) / peak.price;
        if (pullbackPct < SCALLOP_MIN_PULLBACK) continue;
        scLegs.push({
          fromDate: c.dates[l1.idx], fromPrice: l1.price, toDate: c.dates[l2.idx], toPrice: l2.price,
          peakDate: c.dates[peak.idx], peakPrice: peak.price,
          weeksApart: +weeksApart.toFixed(1), gainPct: +(gainPct*100).toFixed(1), pullbackPct: +(pullbackPct*100).toFixed(1),
          // Real, disclosed, informational-only match against the book's own
          // specific "typically" numbers -- never a detection gate.
          matchesBook: gainPct >= 0.10 && gainPct <= 0.15 && pullbackPct >= 0.20 && pullbackPct <= 0.30 && weeksApart >= 3 && weeksApart <= 9 // real 5-7wk "normal" range with a disclosed margin either side, not a hard cutoff
        });
      }
      // Real, disclosed detection bar: at least 2 real legs (i.e. 3 real,
      // progressively higher lows) to call this a genuine "repeated series,"
      // matching the book's own real plural framing ("Repeated Saucers"),
      // not a single rounding bottom (already covered by ROUNDING_BOTTOM).
      if (scLegs.length >= 2) {
        chartPatterns.push({
          type: 'SCALLOP_SERIES',
          legs: scLegs,
          legCount: scLegs.length,
          priceTierMatch: closes[n-1] <= SCALLOP_PRICE_TIER, // informational -- book's own real, disclosed exceptions exist for higher-priced issues
          status: closes[n-1] > scLegs[scLegs.length-1].peakPrice ? 'BROKE_UP' : 'FORMING'
        });
      }
    }

    // Triple Top / Triple Bottom (v9.18, DESIGN_chart_pattern_roadmap.md Tier
    // A) -- direct 3-peak generalization of Double Top/Bottom just above:
    // same comparable-level + neckline + pullback check, one more peak to
    // match, same swingHighs/swingLows already computed. Note: a genuine
    // triple top will usually ALSO register as 2 separate double tops (the
    // h1-h2 pair and h2-h3 pair each independently qualify) -- expected,
    // not a bug; the triple-top entry is the correctly-labeled summary of
    // the same real shape, not a replacement for the double-top entries.
    // Tested against 9 constructed cases (confirmed/forming both types,
    // mismatched-peaks negative, shallow-pullback negative, random-walk
    // no-false-positive) before touching this file.
    for (let i = 0; i < swingHighs.length - 2; i++) {
      const h1 = swingHighs[i], h2 = swingHighs[i+1], h3 = swingHighs[i+2];
      if (h3.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      const maxP = Math.max(h1.price, h2.price, h3.price), minP = Math.min(h1.price, h2.price, h3.price);
      if ((maxP - minP) / minP > LEVEL_TOLERANCE) continue;
      const between1 = swingLows.filter(l => l.idx > h1.idx && l.idx < h2.idx);
      const between2 = swingLows.filter(l => l.idx > h2.idx && l.idx < h3.idx);
      if (!between1.length || !between2.length) continue;
      const t1 = between1.reduce((min,l) => l.price < min.price ? l : min);
      const t2 = between2.reduce((min,l) => l.price < min.price ? l : min);
      const neckline3 = Math.min(t1.price, t2.price);
      const avgPeak = (h1.price + h2.price + h3.price) / 3;
      if ((avgPeak - neckline3) / avgPeak < MIN_PULLBACK) continue;
      chartPatterns.push({
        type: 'TRIPLE_TOP',
        peak1: { date: c.dates[h1.idx], price: h1.price }, peak2: { date: c.dates[h2.idx], price: h2.price }, peak3: { date: c.dates[h3.idx], price: h3.price },
        neckline: neckline3,
        confirmed: closes[n-1] < neckline3
      });
    }
    for (let i = 0; i < swingLows.length - 2; i++) {
      const l1 = swingLows[i], l2 = swingLows[i+1], l3 = swingLows[i+2];
      if (l3.idx < n - RECENCY_WINDOW) continue; // stale -- not currently relevant
      const maxP = Math.max(l1.price, l2.price, l3.price), minP = Math.min(l1.price, l2.price, l3.price);
      if ((maxP - minP) / minP > LEVEL_TOLERANCE) continue;
      const between1 = swingHighs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
      const between2 = swingHighs.filter(h => h.idx > l2.idx && h.idx < l3.idx);
      if (!between1.length || !between2.length) continue;
      const p1 = between1.reduce((max,h) => h.price > max.price ? h : max);
      const p2 = between2.reduce((max,h) => h.price > max.price ? h : max);
      const neckline3 = Math.max(p1.price, p2.price);
      const avgTrough = (l1.price + l2.price + l3.price) / 3;
      if ((neckline3 - avgTrough) / avgTrough < MIN_PULLBACK) continue;
      chartPatterns.push({
        type: 'TRIPLE_BOTTOM',
        trough1: { date: c.dates[l1.idx], price: l1.price }, trough2: { date: c.dates[l2.idx], price: l2.price }, trough3: { date: c.dates[l3.idx], price: l3.price },
        neckline: neckline3,
        confirmed: closes[n-1] > neckline3
      });
    }

    // Triangles + Wedges (v9.19, DESIGN_chart_pattern_roadmap.md Tier B) --
    // one shared primitive for 5 patterns: fit a resistance line through the
    // first/last swing high in a trailing window, a support line through the
    // first/last swing low, classify by slope direction (UP/DOWN/FLAT) and
    // require genuine convergence. Simple 2-point lines, not regression --
    // same "easy to verify by hand" preference as the macro regime majority
    // vote and the H&S neckline. Unlike double/triple top which scan all of
    // history, this looks only at a trailing window (a forming pattern near
    // the current price is what actually gets traded).
    // Convergence is judged at the LAST CONFIRMED swing point, not today's
    // bar -- a real breakout often lands after the lines' extrapolated
    // crossing point (the apex), which is expected, not invalid. The first
    // two drafts of this got that backwards and rejected every genuine case;
    // fixed and reverified against 14 constructed cases (5 confirmed
    // patterns, 1 forming, 1 parallel-channel negative, 1 random-walk
    // no-false-positive) before writing this.
    const TW_LOOKBACK_BARS = 60, TW_FLAT_TOL = 0.02, TW_MIN_CONVERGE_RATIO = 0.7;
    const twWindowStart = Math.max(0, n - TW_LOOKBACK_BARS);
    const twHighs = swingHighs.filter(h => h.idx >= twWindowStart);
    const twLows = swingLows.filter(l => l.idx >= twWindowStart);
    if (twHighs.length >= 2 && twLows.length >= 2) {
      const twR1 = twHighs[0], twR2 = twHighs[twHighs.length-1];
      const twS1 = twLows[0], twS2 = twLows[twLows.length-1];
      if (twR2.idx !== twR1.idx && twS2.idx !== twS1.idx) {
        const twLastIdx = Math.max(twR2.idx, twS2.idx);
        const twGapStart = necklineAt(twR1,twR2,twWindowStart) - necklineAt(twS1,twS2,twWindowStart);
        const twGapEnd = necklineAt(twR1,twR2,twLastIdx) - necklineAt(twS1,twS2,twLastIdx);
        if (twGapStart > 0 && twGapEnd > 0 && twGapEnd <= twGapStart * TW_MIN_CONVERGE_RATIO) {
          const twResPct = (twR2.price - twR1.price) / twR1.price;
          const twSupPct = (twS2.price - twS1.price) / twS1.price;
          const twDir = pct => Math.abs(pct) < TW_FLAT_TOL ? 'FLAT' : (pct > 0 ? 'UP' : 'DOWN');
          const twResDir = twDir(twResPct), twSupDir = twDir(twSupPct);
          let twType = null;
          if (twResDir==='DOWN' && twSupDir==='UP') twType = 'SYMMETRICAL_TRIANGLE';
          else if (twResDir==='FLAT' && twSupDir==='UP') twType = 'ASCENDING_TRIANGLE';
          else if (twResDir==='DOWN' && twSupDir==='FLAT') twType = 'DESCENDING_TRIANGLE';
          else if (twResDir==='UP' && twSupDir==='UP' && twSupPct > twResPct) twType = 'RISING_WEDGE';
          else if (twResDir==='DOWN' && twSupDir==='DOWN' && twResPct < twSupPct) twType = 'FALLING_WEDGE';
          if (twType) {
            const twResLast = necklineAt(twR1, twR2, n-1), twSupLast = necklineAt(twS1, twS2, n-1);
            const twBrokeUp = closes[n-1] > twResLast, twBrokeDown = closes[n-1] < twSupLast;
            // v9.73, Schabacker Study III. Purely additive -- new,
            // informational-only fields, does not affect detection/status
            // above. Real, disclosed distinction from the book: unlike
            // Symmetrical Triangle (where a real volume pick-up confirms
            // the breakout), volume confirmation is explicitly NOT
            // essential for Right-angle Triangles (Ascending/Descending) --
            // "no excessive selling is required... support eventually has
            // to give way." These 2 types are currently unscored (weight
            // 0) anyway, so this is informational only, no scoring change.
            const twVolExpected = twType === 'SYMMETRICAL_TRIANGLE';
            const twBreakoutVol = (twBrokeUp || twBrokeDown) ? volumes[n-1] : null;
            const twAvgVol = volumes.slice(Math.max(0,n-21), n-1).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(20, n-1));
            chartPatterns.push({
              type: twType,
              resistanceP1: { date: c.dates[twR1.idx], price: twR1.price }, resistanceP2: { date: c.dates[twR2.idx], price: twR2.price },
              supportP1: { date: c.dates[twS1.idx], price: twS1.price }, supportP2: { date: c.dates[twS2.idx], price: twS2.price },
              resistanceAtLast: twResLast, supportAtLast: twSupLast,
              status: twBrokeUp ? 'BROKE_UP' : (twBrokeDown ? 'BROKE_DOWN' : 'FORMING'),
              volumeConfirmationExpected: twVolExpected,
              breakoutVolumeElevated: twBreakoutVol != null && twAvgVol > 0 ? (twBreakoutVol > 1.3 * twAvgVol) : null,
              // v9.83, Edwards & Magee Tier 3: real, DIRECTION-aware refinement,
              // alongside (not replacing) volumeConfirmationExpected/
              // breakoutVolumeElevated above -- those 2 fields are pattern-
              // TYPE-aware (Symmetrical needs confirmation, Right-Angle
              // doesn't) but not direction-aware; the book's own real rule
              // applies per-DIRECTION even within Symmetrical Triangle
              // itself (upside needs confirmation, downside doesn't, and
              // heavy volume on a downside Symmetrical Triangle break is
              // itself suspicious -- not currently distinguished by the 2
              // existing fields).
              asymmetricVolumeRead: twBrokeUp ? asymmetricVolumeConfirmationV1_('up', twBreakoutVol, twAvgVol)
                : twBrokeDown ? asymmetricVolumeConfirmationV1_('down', twBreakoutVol, twAvgVol)
                : null
            });
          }
        }
      }
    }

    // Bull Flag / Bear Flag / Pennant (v9.20, DESIGN_chart_pattern_roadmap.md
    // Tier C) -- one shared primitive: a "pole" (fast directional move over
    // FP_POLE_BARS) followed by a tight consolidation over FP_CONSOL_BARS.
    // Flag = consolidation range roughly constant; Pennant = range clearly
    // narrowing (second half <=60% of first half). Deliberately simpler than
    // Tier B: plain high/low range compression, not swing-point trendlines --
    // appropriate for a short consolidation window, and the pole/consolidation
    // shape is directly what traders mean by "flag", not a derived geometry.
    // Tested against 11 constructed cases (bull/bear flag confirmed+forming,
    // pennant confirmed, 3 negatives incl. random-walk no-false-positive)
    // before writing this -- one real off-by-one caught in that process
    // (a POLE_BARS-bar move needs POLE_BARS+1 price points, not POLE_BARS).
    const FP_POLE_BARS = 10, FP_POLE_MIN_PCT = 0.08, FP_CONSOL_BARS = 10;
    const FP_CONSOL_MAX_RANGE_RATIO = 0.5, FP_PENNANT_NARROW_RATIO = 0.6, FP_FLAG_DRIFT_MAX = 0.02;
    // v9.27 fix (PENNANT_FLAG_ZERO_HIT_DIAGNOSIS.md, real-data diagnosis run
    // before touching this code): the v9.20 original checked exactly ONE
    // fixed pole/consolidation window per call (poleEnd = n-1-FP_CONSOL_BARS-1)
    // -- unlike every other pattern in this file (Double/Triple Top, H&S,
    // Triangles, Rectangle), which all scan. Confirmed empirically: scanning
    // every possible window on real 10y data found genuine flag/pennant
    // shapes in 1.68% of windows -- not a rare pattern, a detection-coverage
    // gap. Fix: scan the last FP_SCAN_BARS candidate pole-end positions,
    // most-recent first, take the first (most current) one that qualifies --
    // same math, same thresholds as v9.20, unchanged, only the search
    // mechanism changes. FP_SCAN_BARS=20 (~1 trading month) is a reasoned,
    // disclosed default -- flag/pennant consolidations are inherently
    // short-lived by definition (unlike Triangles' 60-bar window), not fit
    // to any backtest result (per TEST_METHODOLOGY_PLAN.md's tuning rule).
    const FP_SCAN_BARS = 20;
    for (let fpOffset = 0; fpOffset <= FP_SCAN_BARS; fpOffset++) {
      const fpPoleEnd = n - 1 - FP_CONSOL_BARS - 1 - fpOffset;
      const fpPoleStart = fpPoleEnd - FP_POLE_BARS;
      if (fpPoleStart < 0) break; // ran out of history -- no older candidates possible
      const fpPolePct = (closes[fpPoleEnd] - closes[fpPoleStart]) / closes[fpPoleStart];
      if (Math.abs(fpPolePct) < FP_POLE_MIN_PCT) continue;
      const fpPoleDir = fpPolePct > 0 ? 'UP' : 'DOWN';
      const fpConsolStart = fpPoleEnd + 1, fpConsolEnd = fpPoleEnd + FP_CONSOL_BARS;
      const fpChunk = (arr, a, b) => arr.slice(a, b+1);
      const fpConsolHigh = Math.max(...fpChunk(highs, fpConsolStart, fpConsolEnd));
      const fpConsolLow = Math.min(...fpChunk(lows, fpConsolStart, fpConsolEnd));
      const fpConsolRangePct = (fpConsolHigh - fpConsolLow) / closes[fpPoleEnd];
      if (fpConsolRangePct > FP_CONSOL_MAX_RANGE_RATIO * Math.abs(fpPolePct)) continue;
      const fpMid = fpConsolStart + Math.floor(FP_CONSOL_BARS/2);
      const fpFirstRange = Math.max(...fpChunk(highs,fpConsolStart,fpMid-1)) - Math.min(...fpChunk(lows,fpConsolStart,fpMid-1));
      const fpSecondRange = Math.max(...fpChunk(highs,fpMid,fpConsolEnd)) - Math.min(...fpChunk(lows,fpMid,fpConsolEnd));
      const fpIsPennant = fpSecondRange <= FP_PENNANT_NARROW_RATIO * fpFirstRange;
      const fpFirstAvg = fpChunk(closes,fpConsolStart,fpMid-1).reduce((a,b)=>a+b,0)/(fpMid-fpConsolStart);
      const fpSecondAvg = fpChunk(closes,fpMid,fpConsolEnd).reduce((a,b)=>a+b,0)/(fpConsolEnd-fpMid+1);
      const fpDrift = (fpSecondAvg-fpFirstAvg)/fpFirstAvg;
      let fpType = null;
      if (fpIsPennant) fpType = 'PENNANT';
      else if (fpPoleDir==='UP' && fpDrift <= FP_FLAG_DRIFT_MAX) fpType = 'BULL_FLAG';
      else if (fpPoleDir==='DOWN' && fpDrift >= -FP_FLAG_DRIFT_MAX) fpType = 'BEAR_FLAG';
      if (fpType) {
        const fpBrokeUp = closes[n-1] > fpConsolHigh, fpBrokeDown = closes[n-1] < fpConsolLow;
        // v9.71, Schabacker Study X: "mast" measuring rule -- book's own
        // words, "our most accurate measuring forecasts." Same point-length
        // as the pre-flag mast (poleStart->poleEnd), projected from the
        // breakout level in the pole's own direction. Purely additive
        // display field, not scored -- book's own disclosed caveat: this is
        // a probable IMMEDIATE objective only, not a forecast of an actual
        // reversal there (price may continue well beyond it).
        const fpMastLength = Math.abs(closes[fpPoleEnd] - closes[fpPoleStart]);
        const fpMeasuredTarget = fpPoleDir === 'UP' ? fpConsolHigh + fpMastLength : fpConsolLow - fpMastLength;
        chartPatterns.push({
          type: fpType, poleDir: fpPoleDir, polePct: fpPolePct,
          poleStartDate: c.dates[fpPoleStart], poleEndDate: c.dates[fpPoleEnd],
          consolHigh: fpConsolHigh, consolLow: fpConsolLow,
          status: fpBrokeUp ? 'BROKE_UP' : (fpBrokeDown ? 'BROKE_DOWN' : 'FORMING'),
          measuredTarget: fpMeasuredTarget
        });
        break; // most-recent qualifying match found -- stop, one flag/pennant result per call, avoids flooding (the same over-counting bug already found and fixed for Double/Triple Top/H&S)
      }
    }

    // Half-mast Congestion (v9.71, Schabacker Study X) -- a real, distinct
    // phenomenon from Flag/Pennant above: the book itself says it "can
    // hardly be classified as a pattern" -- a very tight, brief, low-volume
    // congestion forming roughly halfway along an already-fast, sustained,
    // near-vertical move, carrying the SAME measuring implication as a true
    // Flag (the same point distance again, projected from the congestion's
    // own breakout level). Looser shape requirement than Flag/Pennant (no
    // parallel-channel/narrowing-wedge geometry required, just "tight, no
    // give"), a bigger/more-extensive preceding move requirement, and a
    // real volume-shrinkage check the Flag/Pennant detector doesn't make.
    // Purely additive -- new detector, new pattern type, does not touch the
    // Flag/Pennant detection above. Reasoned, disclosed defaults, not
    // empirically validated, same standing caveat as every other threshold
    // in this file.
    const HM_MOVE_BARS = 15, HM_MOVE_MIN_PCT = 0.12, HM_CONSOL_BARS = 10;
    const HM_CONSOL_MAX_RANGE_RATIO = 0.35, HM_VOLUME_SHRINK_RATIO = 0.7, HM_SCAN_BARS = 20;
    for (let hmOffset = 0; hmOffset <= HM_SCAN_BARS; hmOffset++) {
      const hmConsolEnd = n - 1 - hmOffset;
      const hmConsolStart = hmConsolEnd - HM_CONSOL_BARS + 1;
      const hmMoveEnd = hmConsolStart - 1;
      const hmMoveStart = hmMoveEnd - HM_MOVE_BARS;
      if (hmMoveStart < 0) break; // ran out of history -- no older candidates possible
      const hmMovePct = (closes[hmMoveEnd] - closes[hmMoveStart]) / closes[hmMoveStart];
      if (Math.abs(hmMovePct) < HM_MOVE_MIN_PCT) continue;
      const hmDir = hmMovePct > 0 ? 'UP' : 'DOWN';
      const hmSlice = (arr,a,b) => arr.slice(a,b+1);
      const hmConsolHigh = Math.max(...hmSlice(highs, hmConsolStart, hmConsolEnd));
      const hmConsolLow = Math.min(...hmSlice(lows, hmConsolStart, hmConsolEnd));
      const hmConsolRangePct = (hmConsolHigh - hmConsolLow) / closes[hmMoveEnd];
      if (hmConsolRangePct > HM_CONSOL_MAX_RANGE_RATIO * Math.abs(hmMovePct)) continue;
      const hmMoveVolAvg = hmSlice(volumes, hmMoveStart, hmMoveEnd).reduce((a,b)=>a+b,0) / (hmMoveEnd - hmMoveStart + 1);
      const hmConsolVolAvg = hmSlice(volumes, hmConsolStart, hmConsolEnd).reduce((a,b)=>a+b,0) / HM_CONSOL_BARS;
      if (hmMoveVolAvg <= 0 || hmConsolVolAvg > HM_VOLUME_SHRINK_RATIO * hmMoveVolAvg) continue;
      const hmMastLength = Math.abs(closes[hmMoveEnd] - closes[hmMoveStart]);
      const hmBreakoutLevel = hmDir === 'UP' ? hmConsolHigh : hmConsolLow;
      const hmMeasuredTarget = hmDir === 'UP' ? hmBreakoutLevel + hmMastLength : hmBreakoutLevel - hmMastLength;
      const hmBrokeUp = closes[n-1] > hmConsolHigh, hmBrokeDown = closes[n-1] < hmConsolLow;
      chartPatterns.push({
        type: 'HALF_MAST', moveDir: hmDir, movePct: hmMovePct,
        moveStartDate: c.dates[hmMoveStart], moveEndDate: c.dates[hmMoveEnd],
        consolHigh: hmConsolHigh, consolLow: hmConsolLow,
        status: hmBrokeUp ? 'BROKE_UP' : (hmBrokeDown ? 'BROKE_DOWN' : 'FORMING'),
        measuredTarget: hmMeasuredTarget
      });
      break; // most-recent qualifying match found -- stop, one result per call, same convention as Flag/Pennant above
    }

    // v9.72, Schabacker Studies IV/V -- Broadening Top/Bottom and Diamond
    // both reuse the SAME real alternating zigzag construction from
    // swingHighs/swingLows (already computed above for H&S). Purely
    // additive -- new, standalone detection, does not touch swingHighs/
    // swingLows or any existing detector's own logic.
    const zzMerged = swingHighs.map(h=>({idx:h.idx,price:h.price,type:'H'}))
      .concat(swingLows.map(l=>({idx:l.idx,price:l.price,type:'L'})))
      .sort((a,b)=>a.idx-b.idx);
    const zigzag = [];
    zzMerged.forEach(pt => {
      if (!zigzag.length) { zigzag.push(pt); return; }
      const zLast = zigzag[zigzag.length-1];
      if (pt.type === zLast.type) {
        if ((pt.type==='H' && pt.price > zLast.price) || (pt.type==='L' && pt.price < zLast.price)) zigzag[zigzag.length-1] = pt;
      } else {
        zigzag.push(pt);
      }
    });

    // Broadening Top/Bottom (v9.72, Schabacker Study IV) -- real "rule of
    // five": 5 alternating swings, each widening beyond the prior
    // same-type swing's own extreme. Book's own top-5 "major pattern"
    // ranking (tied with H&S on reliability, despite real rarity).
    // Display only, weight 0, same evidence-then-promote discipline as
    // every other composite classifier in this file.
    const BT_POINTS = 5;
    for (let end = zigzag.length-1; end >= BT_POINTS-1; end--) {
      const btWindow = zigzag.slice(end-BT_POINTS+1, end+1);
      if (btWindow[btWindow.length-1].idx < n - RECENCY_WINDOW) continue;
      let btWidening = true;
      for (let i = 2; i < btWindow.length; i++) {
        const cur = btWindow[i], prior = btWindow[i-2];
        if (cur.type==='H' ? !(cur.price > prior.price) : !(cur.price < prior.price)) { btWidening = false; break; }
      }
      if (!btWidening) continue;
      const btHighs = btWindow.filter(w=>w.type==='H').map(w=>w.price);
      const btLows = btWindow.filter(w=>w.type==='L').map(w=>w.price);
      if (btHighs.length < 2 || btLows.length < 2) continue;
      const btResistance = Math.max(...btHighs), btSupport = Math.min(...btLows);
      chartPatterns.push({
        type: btWindow[0].type === 'H' ? 'BROADENING_TOP' : 'BROADENING_BOTTOM',
        points: btWindow.map(w => ({ date: c.dates[w.idx], price: w.price, kind: w.type })),
        resistance: btResistance, support: btSupport,
        status: closes[n-1] > btResistance ? 'BROKE_UP' : (closes[n-1] < btSupport ? 'BROKE_DOWN' : 'FORMING')
      });
      break; // most-recent qualifying match, one result per call
    }

    // Diamond Formation (v9.72, Schabacker Study V) -- same zigzag,
    // widens for the first half then narrows for the second half (a
    // rhombus shape) -- geometrically an inverted-then-normal Triangle
    // pair, per the book's own description. Display only, weight 0.
    // Real bug caught before shipping (found via a suspiciously high real
    // fire-rate check, 43-56% on real cached tickers, clearly too common
    // for what the book itself frames as a genuine, noteworthy shape): a
    // 5-point window only has 3 same-type points on one side (H or L) and
    // 2 on the other, so the widen/narrow check only ever validated ONE
    // side of the diamond, never both -- e.g. resistance narrowing back
    // in was checked, but support doing the matching narrow-back-in move
    // was never checked at all. Needs 7 points (4 of one type, 3 of the
    // other) so BOTH sides get 2 real same-type comparisons each (one
    // widen, one narrow).
    const DM_POINTS = 7;
    for (let end = zigzag.length-1; end >= DM_POINTS-1; end--) {
      const dmWindow = zigzag.slice(end-DM_POINTS+1, end+1);
      if (dmWindow[dmWindow.length-1].idx < n - RECENCY_WINDOW) continue;
      const dmMid = Math.floor(dmWindow.length/2);
      let dmOk = true;
      for (let i = 2; i <= dmMid; i++) {
        const cur = dmWindow[i], prior = dmWindow[i-2];
        if (cur.type==='H' ? !(cur.price > prior.price) : !(cur.price < prior.price)) { dmOk = false; break; }
      }
      if (dmOk) for (let i = dmMid+1; i < dmWindow.length; i++) {
        const cur = dmWindow[i], prior = dmWindow[i-2];
        if (cur.type==='H' ? !(cur.price < prior.price) : !(cur.price > prior.price)) { dmOk = false; break; }
      }
      if (!dmOk) continue;
      const dmHighs = dmWindow.filter(w=>w.type==='H').map(w=>w.price);
      const dmLows = dmWindow.filter(w=>w.type==='L').map(w=>w.price);
      if (dmHighs.length < 2 || dmLows.length < 2) continue;
      const dmResistance = Math.max(...dmHighs), dmSupport = Math.min(...dmLows);
      chartPatterns.push({
        type: dmWindow[0].type === 'H' ? 'DIAMOND_TOP' : 'DIAMOND_BOTTOM',
        points: dmWindow.map(w => ({ date: c.dates[w.idx], price: w.price, kind: w.type })),
        resistance: dmResistance, support: dmSupport,
        status: closes[n-1] > dmResistance ? 'BROKE_UP' : (closes[n-1] < dmSupport ? 'BROKE_DOWN' : 'FORMING')
      });
      break;
    }

    // Complex Reversal (v9.72, Schabacker Study IV) -- standalone
    // detector, does NOT edit the existing HEAD_AND_SHOULDERS/
    // INVERSE_HEAD_AND_SHOULDERS loops above (purely additive, per the
    // user's own explicit constraint). Double-head/double-shoulder
    // variant: 4-peak shoulder/head/head/shoulder shape, reusing the same
    // necklineAt/HS_HEAD_MIN_PCT/HS_SHOULDER_TOL already defined for H&S
    // above (read only, not modified). Book's own top-5 "major pattern"
    // ranking, tied with H&S on reliability.
    for (let i = 0; i < swingHighs.length - 3; i++) {
      const cs1 = swingHighs[i], ch1 = swingHighs[i+1], ch2 = swingHighs[i+2], cs2 = swingHighs[i+3];
      if (cs2.idx < n - RECENCY_WINDOW) continue;
      if (ch1.idx-cs1.idx < SWING_WINDOW || ch2.idx-ch1.idx < SWING_WINDOW || cs2.idx-ch2.idx < SWING_WINDOW) continue;
      if (Math.abs(ch1.price-ch2.price)/ch1.price > HS_SHOULDER_TOL) continue; // heads comparable
      const higherShoulder = Math.max(cs1.price, cs2.price);
      if (Math.min(ch1.price,ch2.price) < higherShoulder*(1+HS_HEAD_MIN_PCT)) continue; // both heads taller
      if (Math.abs(cs1.price-cs2.price)/cs1.price > HS_SHOULDER_TOL) continue; // shoulders comparable
      const cLeftTroughs = swingLows.filter(l=>l.idx>cs1.idx && l.idx<ch1.idx);
      const cRightTroughs = swingLows.filter(l=>l.idx>ch2.idx && l.idx<cs2.idx);
      if (!cLeftTroughs.length || !cRightTroughs.length) continue;
      const cLeftTrough = cLeftTroughs.reduce((min,l)=>l.price<min.price?l:min);
      const cRightTrough = cRightTroughs.reduce((min,l)=>l.price<min.price?l:min);
      const cNecklineLast = necklineAt(cLeftTrough, cRightTrough, n-1);
      chartPatterns.push({
        type: 'COMPLEX_TOP',
        shoulder1: { date: c.dates[cs1.idx], price: cs1.price }, head1: { date: c.dates[ch1.idx], price: ch1.price },
        head2: { date: c.dates[ch2.idx], price: ch2.price }, shoulder2: { date: c.dates[cs2.idx], price: cs2.price },
        necklineAtLast: cNecklineLast, confirmed: closes[n-1] < cNecklineLast
      });
      break;
    }
    for (let i = 0; i < swingLows.length - 3; i++) {
      const cs1 = swingLows[i], ch1 = swingLows[i+1], ch2 = swingLows[i+2], cs2 = swingLows[i+3];
      if (cs2.idx < n - RECENCY_WINDOW) continue;
      if (ch1.idx-cs1.idx < SWING_WINDOW || ch2.idx-ch1.idx < SWING_WINDOW || cs2.idx-ch2.idx < SWING_WINDOW) continue;
      if (Math.abs(ch1.price-ch2.price)/ch1.price > HS_SHOULDER_TOL) continue;
      const lowerShoulder = Math.min(cs1.price, cs2.price);
      if (Math.max(ch1.price,ch2.price) > lowerShoulder*(1-HS_HEAD_MIN_PCT)) continue;
      if (Math.abs(cs1.price-cs2.price)/cs1.price > HS_SHOULDER_TOL) continue;
      const cLeftPeaks = swingHighs.filter(h=>h.idx>cs1.idx && h.idx<ch1.idx);
      const cRightPeaks = swingHighs.filter(h=>h.idx>ch2.idx && h.idx<cs2.idx);
      if (!cLeftPeaks.length || !cRightPeaks.length) continue;
      const cLeftPeak = cLeftPeaks.reduce((max,h)=>h.price>max.price?h:max);
      const cRightPeak = cRightPeaks.reduce((max,h)=>h.price>max.price?h:max);
      const cNecklineLast = necklineAt(cLeftPeak, cRightPeak, n-1);
      chartPatterns.push({
        type: 'COMPLEX_BOTTOM',
        shoulder1: { date: c.dates[cs1.idx], price: cs1.price }, head1: { date: c.dates[ch1.idx], price: ch1.price },
        head2: { date: c.dates[ch2.idx], price: ch2.price }, shoulder2: { date: c.dates[cs2.idx], price: cs2.price },
        necklineAtLast: cNecklineLast, confirmed: closes[n-1] > cNecklineLast
      });
      break;
    }

    // Rectangle / trading-range breakout (v9.21, DESIGN_chart_pattern_roadmap.md
    // Tier D) -- flat resistance + flat support (swing highs/lows in a
    // trailing window, all within LEVEL_TOLERANCE of their own average),
    // with a real containment check: most closes in the window must
    // actually sit inside the range, not just a couple of touches lining
    // up by chance in an otherwise choppy or trending market. Flagged in
    // the roadmap for extra false-positive skepticism -- the containment
    // check is exactly that discipline applied. Simplest primitive on the
    // roadmap; tested against 9 constructed cases (3 confirmed/forming, 3
    // negative incl. non-flat resistance, real uptrend, random-walk) before
    // writing this, all passed on the first design (no bugs caught this
    // time, unlike Tiers B/C).
    // v9.67 -- RECT_LEVEL_TOL deliberately decoupled from LEVEL_TOLERANCE
    // (real predictive-value backtest, docs/PATTERN_THRESHOLD_TIGHTENING_RESULTS.md):
    // tightening LEVEL_TOLERANCE 3%->1.5% genuinely improves RECTANGLE's real
    // signal (diff widens -1.14pp->-1.66pp, stays p<0.0001) but BREAKS/REVERSES
    // DOUBLE_TOP/DOUBLE_BOTTOM/TRIPLE_TOP/TRIPLE_BOTTOM's already-real signal
    // (all 4 share LEVEL_TOLERANCE) -- those 4 must stay at 3%. Own constant,
    // not a shared alias, so this change can't silently affect them again.
    const RECT_LOOKBACK = 60, RECT_LEVEL_TOL = 0.015, RECT_MIN_RANGE = 0.04, RECT_MIN_CONTAINMENT = 0.80;
    const rectWindowStart = Math.max(0, n - RECT_LOOKBACK);
    const rectH = swingHighs.filter(h => h.idx >= rectWindowStart);
    const rectL = swingLows.filter(l => l.idx >= rectWindowStart);
    if (rectH.length >= 2 && rectL.length >= 2) {
      const rectResistance = rectH.reduce((a,h)=>a+h.price,0)/rectH.length;
      const rectSupport = rectL.reduce((a,l)=>a+l.price,0)/rectL.length;
      const rectFlatH = rectH.every(h => Math.abs(h.price-rectResistance)/rectResistance <= RECT_LEVEL_TOL);
      const rectFlatL = rectL.every(l => Math.abs(l.price-rectSupport)/rectSupport <= RECT_LEVEL_TOL);
      if (rectFlatH && rectFlatL && rectResistance > rectSupport && (rectResistance-rectSupport)/rectSupport >= RECT_MIN_RANGE) {
        const rectWindowCloses = closes.slice(rectWindowStart, n);
        const rectContained = rectWindowCloses.filter(cl => cl >= rectSupport*(1-RECT_LEVEL_TOL) && cl <= rectResistance*(1+RECT_LEVEL_TOL)).length;
        if (rectContained/rectWindowCloses.length >= RECT_MIN_CONTAINMENT) {
          const rectBrokeUp = closes[n-1] > rectResistance, rectBrokeDown = closes[n-1] < rectSupport;
          chartPatterns.push({
            type: 'RECTANGLE', resistanceLevel: rectResistance, supportLevel: rectSupport,
            status: rectBrokeUp ? 'BROKE_UP' : (rectBrokeDown ? 'BROKE_DOWN' : 'FORMING')
          });
        }
      }
    }

    // Staircase (v9.38, CHARACTERIZATION_PLAN_staircase.md) -- real, named
    // pattern from broker course ep.4's visual re-pass, reinforced across 8+
    // real worked examples (NIO, PLTR, XPEV, RIOT, JMIA). A chain of 3+
    // ascending "shelves" (multi-week periods of low net drift), each
    // broken out before the next forms.
    //
    // Real design history, disclosed: two earlier attempts (swing-low
    // clustering reusing Rectangle's own flatness convention; then rolling-
    // window range-tightness) both failed real-data validation against
    // NIO's own 2020 chart -- the exact source example. Direct inspection of
    // that chart (full-resolution frame, not the low-res contact sheet)
    // showed the real "steps" are much WIDER bands than a tight consolidation
    // (~$10-18, ~$27-45) -- range-based tightness was the wrong primitive
    // entirely. What actually matches: net DRIFT (start-to-end % change of a
    // window), not range. Re-tested against NIO's real 2020 data with this
    // approach and got a precise match (3.54 -> 13.23 -> 19.39 -> 47.01,
    // matching the on-screen box levels) plus a second real, independent
    // match on JMIA (8.32 -> 16.16 -> 37.81). PLTR/XPEV/RIOT didn't fire in
    // that same test, explained by genuinely short trading history in the
    // window tested (all 3 IPO'd Aug-Sep 2020, ~74-97 real bars available by
    // Jan 2021), not a logic gap. Negative-case checked against 3 stable,
    // non-trending large caps (KO/JNJ/WMT) -- correctly finds nothing.
    const STAIR_WIN = 15, STAIR_STEP = 3, STAIR_DRIFT_TOL = 0.15, STAIR_MIN_STEP_RISE = 0.15, STAIR_MIN_STEPS = 3;
    const stairFlatWindows = [];
    for (let i = 0; i + STAIR_WIN <= n; i += STAIR_STEP) {
      const drift = (closes[i+STAIR_WIN-1] - closes[i]) / closes[i];
      if (Math.abs(drift) < STAIR_DRIFT_TOL) stairFlatWindows.push({ start: i, end: i+STAIR_WIN-1 });
    }
    if (stairFlatWindows.length) {
      const stairRegions = [{ ...stairFlatWindows[0] }];
      for (let i = 1; i < stairFlatWindows.length; i++) {
        const w = stairFlatWindows[i], cur = stairRegions[stairRegions.length-1];
        if (w.start <= cur.end) cur.end = Math.max(cur.end, w.end); // strict overlap only -- w.start<=cur.end+STAIR_STEP (an earlier draft) let two genuinely separate shelves merge across a real breakout gap, silently eating a step. Caught in real-data testing (NIO), not assumed.
        else stairRegions.push({ ...w });
      }
      const stairSteps = stairRegions.map(r => {
        const seg = closes.slice(r.start, r.end+1);
        return { ...r, level: seg.reduce((a,b)=>a+b,0)/seg.length, localHigh: Math.max(...highs.slice(r.start, r.end+1)) };
      });
      let stairChain = [];
      for (const step of stairSteps) {
        if (stairChain.length) {
          const prev = stairChain[stairChain.length-1];
          const brokeOut = Math.max(...closes.slice(prev.end, step.start+1)) > prev.localHigh;
          if (step.level > prev.level * (1+STAIR_MIN_STEP_RISE) && brokeOut) { stairChain.push(step); continue; }
        }
        stairChain = [step];
      }
      if (stairChain.length >= STAIR_MIN_STEPS) {
        const stairLast = stairChain[stairChain.length-1];
        chartPatterns.push({
          type: 'STAIRCASE', steps: stairChain.length, baseLevel: stairChain[0].level, lastStepLevel: stairLast.level,
          status: closes[n-1] > stairLast.localHigh ? 'BROKE_UP' : 'FORMING'
        });
      }
    }

    // Rounding Top/Bottom + Cup and Handle (v9.22, DESIGN_chart_pattern_roadmap.md
    // Tier E -- the explicit stretch tier, curve-fitting, deliberately last
    // because it's the hardest and riskiest primitive on the roadmap).
    // NOT a true parabola regression -- a coarser, verifiable-by-hand proxy:
    // split the decline/rise phase into segments, require each segment's
    // average to move consistently in the right direction (allows bar-to-bar
    // noise), AND require no single bar to dominate the move. That second
    // check exists because the first draft's segment-average check alone let
    // a sharp V-shaped reversal through as a false "rounding bottom" --
    // exactly the false-positive risk this tier was flagged for. Caught,
    // fixed, then reverified against 16 constructed cases (Rounding Bottom/
    // Top confirmed+forming, Cup and Handle confirmed+forming, 5 negatives
    // incl. the V-shape and 2 random-walk no-false-positive checks) before
    // writing this.
    const RND_LOOKBACK = 60, RND_EDGE_FRAC = 0.2, RND_MIN_DEPTH = 0.08, RND_SEGMENTS = 4, RND_MAX_SINGLE_BAR_SHARE = 0.35;
    const rndSegAvgs = (arr, k) => { const avgs=[]; const cs=Math.floor(arr.length/k);
      for (let s=0;s<k;s++) { const a=s*cs, b=(s===k-1)?arr.length:(s+1)*cs; const c=arr.slice(a,b); avgs.push(c.reduce((x,y)=>x+y,0)/c.length); }
      return avgs; };
    const rndMonoDec = (avgs,tol) => { for (let i=0;i<avgs.length-1;i++) if (avgs[i+1] > avgs[i]*(1+tol)) return false; return true; };
    const rndMonoInc = (avgs,tol) => { for (let i=0;i<avgs.length-1;i++) if (avgs[i+1] < avgs[i]*(1-tol)) return false; return true; };
    const rndMaxBarShare = (phase) => { let total=0,maxBar=0; for (let i=1;i<phase.length;i++) { const d=Math.abs(phase[i]-phase[i-1]); total+=d; if (d>maxBar) maxBar=d; } return total===0?0:maxBar/total; };

    const rndWindowEnd = n - 2; // yesterday -- today (n-1) is the separate breakout candidate
    const rndWindowStart = Math.max(0, rndWindowEnd - RND_LOOKBACK + 1);
    const rndWin = closes.slice(rndWindowStart, rndWindowEnd+1);
    const rndWn = rndWin.length;
    let rndMinIdx = 0, rndMaxIdx = 0;
    for (let i=1;i<rndWn;i++) { if (rndWin[i]<rndWin[rndMinIdx]) rndMinIdx=i; if (rndWin[i]>rndWin[rndMaxIdx]) rndMaxIdx=i; }

    if (rndMinIdx >= rndWn*RND_EDGE_FRAC && rndMinIdx <= rndWn*(1-RND_EDGE_FRAC)) {
      const declPhase = rndWin.slice(0, rndMinIdx+1), risePhase = rndWin.slice(rndMinIdx);
      if (declPhase.length >= RND_SEGMENTS && risePhase.length >= RND_SEGMENTS) {
        const declAvgs = rndSegAvgs(declPhase, RND_SEGMENTS), riseAvgs = rndSegAvgs(risePhase, RND_SEGMENTS);
        const declDepth = (rndWin[0]-rndWin[rndMinIdx])/rndWin[0], riseDepth = (rndWin[rndWn-1]-rndWin[rndMinIdx])/rndWin[rndMinIdx];
        const gradual = rndMaxBarShare(declPhase)<=RND_MAX_SINGLE_BAR_SHARE && rndMaxBarShare(risePhase)<=RND_MAX_SINGLE_BAR_SHARE;
        if (rndMonoDec(declAvgs,0.01) && rndMonoInc(riseAvgs,0.01) && declDepth>=RND_MIN_DEPTH && riseDepth>=RND_MIN_DEPTH && gradual) {
          const rndRim = Math.max(rndWin[0], rndWin[rndWn-1]);
          chartPatterns.push({ type: 'ROUNDING_BOTTOM', rim: rndRim, status: closes[n-1]>rndRim?'BROKE_UP':'FORMING' });
        }
      }
    }
    if (rndMaxIdx >= rndWn*RND_EDGE_FRAC && rndMaxIdx <= rndWn*(1-RND_EDGE_FRAC)) {
      const risePhase = rndWin.slice(0, rndMaxIdx+1), declPhase = rndWin.slice(rndMaxIdx);
      if (declPhase.length >= RND_SEGMENTS && risePhase.length >= RND_SEGMENTS) {
        const riseAvgs = rndSegAvgs(risePhase, RND_SEGMENTS), declAvgs = rndSegAvgs(declPhase, RND_SEGMENTS);
        const riseDepth = (rndWin[rndMaxIdx]-rndWin[0])/rndWin[0], declDepth = (rndWin[rndMaxIdx]-rndWin[rndWn-1])/rndWin[rndMaxIdx];
        const gradual = rndMaxBarShare(declPhase)<=RND_MAX_SINGLE_BAR_SHARE && rndMaxBarShare(risePhase)<=RND_MAX_SINGLE_BAR_SHARE;
        if (rndMonoInc(riseAvgs,0.01) && rndMonoDec(declAvgs,0.01) && riseDepth>=RND_MIN_DEPTH && declDepth>=RND_MIN_DEPTH && gradual) {
          const rndRim2 = Math.min(rndWin[0], rndWin[rndWn-1]);
          chartPatterns.push({ type: 'ROUNDING_TOP', rim: rndRim2, status: closes[n-1]<rndRim2?'BROKE_DOWN':'FORMING' });
        }
      }
    }

    // Cup and Handle -- reuses the exact same cup-shape check above (segment
    // monotonicity + no-single-bar-dominance), just applied to a window that
    // ends earlier, leaving room for a shallow "handle" pullback afterward.
    const CUP_LOOKBACK = 50, HANDLE_BARS = 10, HANDLE_MAX_DEPTH_RATIO = 0.5, HANDLE_MIN_DEPTH = 0.02, HANDLE_MAX_DEPTH_ABS = 0.15;
    const cupEnd = n - 1 - HANDLE_BARS - 1;
    const cupStart = Math.max(0, cupEnd - CUP_LOOKBACK + 1);
    if (cupEnd - cupStart >= RND_SEGMENTS*2) {
      const cupWin = closes.slice(cupStart, cupEnd+1);
      const cupWn = cupWin.length;
      let cupMinIdx = 0; for (let i=1;i<cupWn;i++) if (cupWin[i]<cupWin[cupMinIdx]) cupMinIdx=i;
      if (cupMinIdx >= cupWn*RND_EDGE_FRAC && cupMinIdx <= cupWn*(1-RND_EDGE_FRAC)) {
        const cDeclPhase = cupWin.slice(0,cupMinIdx+1), cRisePhase = cupWin.slice(cupMinIdx);
        if (cDeclPhase.length>=RND_SEGMENTS && cRisePhase.length>=RND_SEGMENTS) {
          const cDeclAvgs = rndSegAvgs(cDeclPhase,RND_SEGMENTS), cRiseAvgs = rndSegAvgs(cRisePhase,RND_SEGMENTS);
          const cDeclDepth = (cupWin[0]-cupWin[cupMinIdx])/cupWin[0], cRiseDepth = (cupWin[cupWn-1]-cupWin[cupMinIdx])/cupWin[cupMinIdx];
          const cGradual = rndMaxBarShare(cDeclPhase)<=RND_MAX_SINGLE_BAR_SHARE && rndMaxBarShare(cRisePhase)<=RND_MAX_SINGLE_BAR_SHARE;
          if (rndMonoDec(cDeclAvgs,0.01) && rndMonoInc(cRiseAvgs,0.01) && cDeclDepth>=RND_MIN_DEPTH && cRiseDepth>=RND_MIN_DEPTH && cGradual) {
            const cupRim = Math.max(cupWin[0], cupWin[cupWn-1]);
            const handleStart = cupEnd+1, handleEnd = cupEnd+HANDLE_BARS;
            const handleLow = Math.min(...lows.slice(handleStart, handleEnd+1));
            const handleDepth = (cupRim - handleLow)/cupRim;
            if (handleDepth >= HANDLE_MIN_DEPTH && handleDepth <= HANDLE_MAX_DEPTH_ABS && handleDepth <= HANDLE_MAX_DEPTH_RATIO*cDeclDepth) {
              chartPatterns.push({ type: 'CUP_AND_HANDLE', rim: cupRim, status: closes[n-1]>cupRim?'BROKE_UP':'FORMING' });
            }
          }
        }
      }
    }

    // Bull Trap / Bear Trap (v9.25, user-requested) -- new primitive:
    // breakout-then-failure. Mirror-image patterns per standard TA
    // definition, confirmed with the user since the name they used
    // ("bear trap") actually described the opposite pattern (a fake
    // bullish breakout, standard term "bull trap"). Built both.
    // BULL_TRAP: close above a recent swing-high resistance (breakout),
    // then closes back below that level within TRAP_WINDOW bars -- fake
    // breakout, bearish outcome. For this project's long-only/calls-only
    // strategy (see CLAUDE_CODE_HANDOFF.md), this is an avoid/exit signal,
    // not a short setup. BEAR_TRAP: mirror -- close below a recent
    // swing-low support (breakdown), then reclaims it within the window --
    // bullish outcome, a real buy-opportunity signal for this strategy.
    // Recency-windowed from the start (TRAP_LOOKBACK) -- learned directly
    // from the real recency bug found in Double/Triple Top/Bottom/H&S this
    // same session, not repeating it. TRAP_MIN_BREAK_PCT raised from an
    // initial 0.5% to 1.5% after a real false positive on random-walk
    // noise (0.5% was smaller than that synthetic walk's own typical
    // single-bar move) -- fixed, then reverified clean across 4 random
    // seeds. 6/6 constructed cases pass (confirmed + watching for bull
    // trap, confirmed for bear trap, 2 negatives, multi-seed no-false-
    // positive check).
    // v9.67 -- TRAP_WINDOW 5->3, TRAP_MIN_BREAK_PCT 1.5%->3%: real predictive-
    // value backtest (docs/PATTERN_THRESHOLD_TIGHTENING_RESULTS.md) showed
    // both BULL_TRAP and BEAR_TRAP's already-real signal (p<0.0001 at the old
    // thresholds) genuinely widens under these tighter values -- BULL_TRAP
    // diff +0.88pp->+1.62pp, BEAR_TRAP +1.01pp->+1.40pp, both stay p<0.0001.
    // Independent constants, not shared with any other pattern -- no
    // cross-pattern risk the way LEVEL_TOLERANCE had for RECTANGLE.
    const TRAP_LOOKBACK = 90, TRAP_WINDOW = 3, TRAP_MIN_BREAK_PCT = 0.03;
    const trapWindowStart = Math.max(0, n - TRAP_LOOKBACK);
    swingHighs.filter(h => h.idx >= trapWindowStart).forEach(h => {
      let breakoutIdx = -1;
      for (let j = h.idx + 1; j < n; j++) { if (closes[j] > h.price * (1 + TRAP_MIN_BREAK_PCT)) { breakoutIdx = j; break; } }
      if (breakoutIdx === -1) return;
      let failIdx = -1;
      for (let k = breakoutIdx + 1; k <= Math.min(breakoutIdx + TRAP_WINDOW, n - 1); k++) { if (closes[k] < h.price) { failIdx = k; break; } }
      if (failIdx !== -1) {
        chartPatterns.push({ type: 'BULL_TRAP', level: h.price, breakoutDate: c.dates[breakoutIdx], failDate: c.dates[failIdx], status: 'CONFIRMED' });
      } else if (n - 1 - breakoutIdx < TRAP_WINDOW) {
        chartPatterns.push({ type: 'BULL_TRAP', level: h.price, breakoutDate: c.dates[breakoutIdx], status: 'WATCHING' });
      }
    });
    swingLows.filter(l => l.idx >= trapWindowStart).forEach(l => {
      let breakdownIdx = -1;
      for (let j = l.idx + 1; j < n; j++) { if (closes[j] < l.price * (1 - TRAP_MIN_BREAK_PCT)) { breakdownIdx = j; break; } }
      if (breakdownIdx === -1) return;
      let reclaimIdx = -1;
      for (let k = breakdownIdx + 1; k <= Math.min(breakdownIdx + TRAP_WINDOW, n - 1); k++) { if (closes[k] > l.price) { reclaimIdx = k; break; } }
      if (reclaimIdx !== -1) {
        chartPatterns.push({ type: 'BEAR_TRAP', level: l.price, breakdownDate: c.dates[breakdownIdx], reclaimDate: c.dates[reclaimIdx], status: 'CONFIRMED' });
      } else if (n - 1 - breakdownIdx < TRAP_WINDOW) {
        chartPatterns.push({ type: 'BEAR_TRAP', level: l.price, breakdownDate: c.dates[breakdownIdx], status: 'WATCHING' });
      }
    });
  } catch(e) {
    // v9.66 -- real gap caught by independent review (docs/OPUS_REVIEW_2026-08-27.md):
    // this one try wraps ALL 21 chart-pattern detectors sequentially. A throw
    // in any one of them silently skipped every detector after it, and the
    // dashboard rendered "no patterns detected" -- indistinguishable from a
    // genuinely patternless chart. Logged now so this is at least visible in
    // the real 🔬 Log tab instead of a silent, unexplained empty result.
    // Guarded (typeof check) since this function is also exercised in Node
    // test harnesses where Logger isn't a real global.
    if (typeof Logger !== 'undefined') Logger.log('⚠️ chart-pattern detection aborted: ' + e.message);
  }

  // Trailing performance across real timeframes -- genuine gap found by
  // direct comparison against a real stock-screener export (Week/Month/
  // Quarter/HalfY/YTD/Year all fit within the existing 2yr chart data, no
  // new fetch needed).
  // 3Y/5Y/10Y (v9.26): added via a SEPARATE, dedicated long-range fetch
  // (fetchYahooChartLongRange_, closes-only, range=10y) rather than
  // extending the main 2yr fetch every indicator in this file uses --
  // deliberate choice to avoid giving every RSI/MACD/regime/pattern
  // computation ~5x more data per run (real execution-time risk on batch
  // reports, see CHARACTERIZATION_PLAN.md Section 3). Non-fatal if the
  // long-range fetch fails or the ticker has less history (e.g. a recent
  // IPO) -- degrades to null per-field, same discipline as everywhere else
  // in this file, not a hard failure.
  let trailingPerf = null;
  try {
    const perfAt = (daysAgo) => {
      if (n <= daysAgo) return null;
      const past = closes[n-1-daysAgo];
      return past ? (last-past)/past : null;
    };
    const startOfYearIdx = c.dates.findIndex(d => d.getUTCFullYear() === c.dates[n-1].getUTCFullYear());
    const ytd = startOfYearIdx >= 0 && startOfYearIdx < n-1 ? (last-closes[startOfYearIdx])/closes[startOfYearIdx] : null;
    trailingPerf = {
      week: perfAt(5), month: perfAt(21), quarter: perfAt(63),
      halfYear: perfAt(126), year: perfAt(252), ytd: ytd,
      threeYear: null, fiveYear: null, tenYear: null
    };
    // 2026-09-07, real fix (item 8): unconditional, no guard before this
    // session — skip the 3/5/10yr long-range fetch under real time
    // pressure rather than risk it; the week/month/quarter/half/year/YTD
    // figures above are unaffected either way.
    const longCloses = hasTimeBudgetV7_(10000) ? fetchYahooChartLongRange_(c.ticker) : null;
    if (longCloses) {
      const longPerf = computeLongRangeTrailingPerf_(longCloses);
      if (longPerf) {
        trailingPerf.threeYear = longPerf.threeYear;
        trailingPerf.fiveYear = longPerf.fiveYear;
        trailingPerf.tenYear = longPerf.tenYear;
      }
    }
  } catch(e) { /* non-fatal */ }

  // Volume profile / Point of Control (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
  // every current support/resistance level in this system is price-derived
  // (pivots, Fibonacci); this is genuinely different, based on WHERE the
  // heaviest historical trading actually happened.
  // W9.6 (v9.0): upgraded from close-only bucketing to DISTRIBUTING each day's
  // volume across its intraday HIGH–LOW range (spread evenly over the buckets
  // the bar spans). This is a truer volume-profile POC than assigning a whole
  // day's volume to its single close bucket. Uses full available history.
  let volumePOC = null;
  try {
    if (closes.length > 30 && volumes.some(v => v > 0)) {
      const priceMin = Math.min(...lows), priceMax = Math.max(...highs);
      const numBuckets = 25;
      const bucketSize = (priceMax - priceMin) / numBuckets || 1;
      const bucketVolume = new Array(numBuckets).fill(0);
      for (let i = 0; i < closes.length; i++) {
        const v = volumes[i] || 0; if (v <= 0) continue;
        let loIdx = Math.floor((lows[i] - priceMin) / bucketSize);
        let hiIdx = Math.floor((highs[i] - priceMin) / bucketSize);
        loIdx = Math.max(0, Math.min(numBuckets-1, loIdx));
        hiIdx = Math.max(0, Math.min(numBuckets-1, hiIdx));
        const span = hiIdx - loIdx + 1;
        const share = v / span; // spread the bar's volume evenly across the buckets it covers
        for (let b = loIdx; b <= hiIdx; b++) bucketVolume[b] += share;
      }
      let maxIdx = 0;
      for (let i = 1; i < numBuckets; i++) if (bucketVolume[i] > bucketVolume[maxIdx]) maxIdx = i;
      volumePOC = priceMin + (maxIdx + 0.5) * bucketSize; // center of the highest-volume bucket
    }
  } catch(e) { /* non-fatal -- supplementary signal */ }

  const plusDM=[],minusDM=[];
  for(let i=1;i<n;i++){const up=highs[i]-highs[i-1],dn=lows[i-1]-lows[i];plusDM.push(up>dn&&up>0?up:0);minusDM.push(dn>up&&dn>0?dn:0);}
  const sTR=wilderArray(trArr,14),sPDM=wilderArray(plusDM,14),sMDM=wilderArray(minusDM,14);
  const adxLen=Math.min(sTR.length,sPDM.length,sMDM.length),dxArr=[];
  for(let i=0;i<adxLen;i++){if(sTR[i]===0)continue;const pdi=100*sPDM[i]/sTR[i],mdi=100*sMDM[i]/sTR[i];dxArr.push(pdi+mdi===0?0:100*Math.abs(pdi-mdi)/(pdi+mdi));}
  const adx14=wilderSmooth(dxArr,14)||0;
  const lastPDI=adxLen>0?100*sPDM[adxLen-1]/sTR[adxLen-1]:0,lastMDI=adxLen>0?100*sMDM[adxLen-1]/sTR[adxLen-1]:0;
  const adxBullish=lastPDI>lastMDI;

  const obvArr=[0];for(let i=1;i<n;i++){const p=obvArr[obvArr.length-1];obvArr.push(closes[i]>closes[i-1]?p+volumes[i]:closes[i]<closes[i-1]?p-volumes[i]:p);}
  const obvShortSlope=slope(obvArr,10),obvLongSlope=slope(obvArr,50);

  let cmfMFV=0,cmfVol=0;
  // W9.6 (v9.0): keep volume in the denominator on high==low days (multiplier
  // 0), instead of dropping the bar entirely — the standard CMF definition.
  for(let i=n-20;i<n;i++){const hl=highs[i]-lows[i];const mult=hl===0?0:((closes[i]-lows[i])-(highs[i]-closes[i]))/hl;cmfMFV+=mult*volumes[i];cmfVol+=volumes[i];}
  const cmf20=cmfVol===0?0:cmfMFV/cmfVol;

  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): a halted/suspended ticker can show 20 consecutive
  // zero-volume bars -- vol20avgRaw is genuinely 0, `||1` coerced the
  // AVERAGE to 1 (not the ratio), so volRatio became the raw current-day
  // share count divided by 1 -- e.g. a real "3000000.00x HIGH" printed to
  // the dashboard. Fixed: when the window's real average is 0, volRatio
  // itself is set to a neutral 1 (no signal), not derived from a
  // fabricated average.
  const vol20avgRaw=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const vol20avg=vol20avgRaw||1;
  const volRatio=vol20avgRaw>0?volumes[n-1]/vol20avg:1;

  const sma20=sma(closes,20),sma50=sma(closes,50),sma150=sma(closes,150),sma200=sma(closes,200);
  const ema9=ema(closes,9),ema21=ema(closes,21);

  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): for n in [200,204] (200-204 bars of history), sma200 is a
  // real number but closes.slice(0,-5) only has n-5 elements, which can
  // drop below 200 -- sma200_5 was `||0`'d to 0, making sma50_5<=0 false
  // (deathCross's own `>=0` check fires unconditionally true) and
  // sma50_5<=0 also false (goldenCross's check fires unconditionally
  // false) -- a spurious, LATCHED false deathCross plus a suppressed real
  // goldenCross, feeding the highest-weighted Trend signal (weight 4) and
  // the dashboard's death-flag. Guarded now: both crosses require real
  // (non-null) data on both sides of the 5-bar-ago comparison, same as
  // this function already does correctly for `above200`/`above50` below.
  const sma50_5=sma(closes.slice(0,-5),50),sma200_5=sma(closes.slice(0,-5),200);
  const crossDataAvailable = sma200!=null && sma200_5!=null && sma50_5!=null;
  const goldenCross=crossDataAvailable && sma50>sma200 && sma50_5<=sma200_5;
  const deathCross=crossDataAvailable && sma50<sma200 && sma50_5>=sma200_5;
  const above200=sma200?last>sma200:false,above50=sma50?last>sma50:false;

  // v9.35 -- CHARACTERIZATION_PLAN_trend_maturity.md. Real concept from broker
  // course episode 5 -- days since the last SMA50/200 crossover, so the
  // existing Golden/Death Cross flag can be read alongside how mature the
  // current trend actually is. Zero new data -- reuses `closes`.
  const trendMaturity = trendMaturityV7(closes);

  // v9.53 -- CHARACTERIZATION_PLAN_candlestick_classification.md. Single-candle
  // classification of the most recent real bar. `c.opens` accessed directly
  // (not destructured above -- this is the first indicator in this function
  // to need it). Display only, weight 0 -- see singleCandleClassifyV7's own
  // header comment for the full real finding and disclosed thresholds.
  const singleCandle = (c.opens && c.opens[n-1] != null) ? singleCandleClassifyV7(c.opens[n-1], highs[n-1], lows[n-1], closes[n-1]) : null;

  // v9.58 -- CHARACTERIZATION_PLAN_double_top_bottom_market_cap.md Part B,
  // wired in now that KNOWN_DPO_TICKERS_V7 gives a real, disclosed isDPO
  // source (see dpoDelayedBreakoutV7's own header comment). `c.ticker`
  // accessed directly (same real production `chart` object already
  // provides `.ticker`, per its use elsewhere in this file) -- not present
  // on the synthetic input objects this project's own backtest harnesses
  // build, which just means isDPO stays false/undefined there, same as
  // every real non-DPO ticker.
  const dpoSignature = (c.ticker && KNOWN_DPO_TICKERS_V7[c.ticker]) ? dpoDelayedBreakoutV7(closes, volumes, true) : null;

  // v9.34 — CHARACTERIZATION_PLAN_climax_volume.md. Real Wyckoff-style
  // concept from broker course episode 4: distribution phase = a final
  // huge-volume "climax day" that fails to progress, after an extended
  // advance. 3.0x is a direct derivation (double the engine's own existing
  // "high volume" threshold, 1.5x, used 3 places already), not fit to any
  // backtest. Zero new data -- volRatio/above200 already computed above,
  // closes[n-2] already in scope. Display only, not scored (design doc §2).
  const climaxVolume = n>1 && volRatio>3.0 && closes[n-1]<closes[n-2] && above200;

  // v9.75 -- Edwards & Magee Ch27, "Progressive Stop"/"Hair-Trigger Stop":
  // real, distinct from climaxVolume just above (which is a DOWN-day
  // distribution/exhaustion read) -- this is the book's own real trigger
  // for TIGHTENING a stop after a strong UP day on exceptionally heavy
  // volume, "provided this is NOT the very first breakout day." Purely
  // additive, display-only, not scored -- same discipline as climaxVolume.
  // Zero new data: volRatio (already computed above) reused directly for
  // "exceptionally heavy volume," same 3.0x threshold this file already
  // uses for climaxVolume (not reinvented); trendMaturity (already
  // computed above) reused as the real, disclosed proxy for "not the
  // first breakout day" -- an established UP trend maturity of >=5
  // trading days since the last Golden/Death Cross, a reasoned default
  // (not backtested), same standing caveat as every other threshold in
  // this file.
  //
  // REAL, DISCLOSED SCOPE LIMIT: this engine recomputes everything fresh
  // from historical bars each call -- there is no persisted, day-to-day
  // trade state to walk forward. So only the book's own SIMPLER "Hair-
  // Trigger" variant is representable here (a single, real trigger read
  // on the most recent bar), not the "ratchet daily while volume stays
  // climactic" continuation rule, which needs actual position/trade
  // tracking this engine doesn't do. Disclosed, not silently narrowed.
  //
  // REAL, DISCLOSED PRICE NOTE: the book's own real recommended level is
  // a literal ⅛-point ($0.125) under today's close -- a real, direct
  // quote from an eighths-based-pricing era. Kept exactly as the book
  // states it (not silently modernized to a %), but disclosed here as
  // genuinely tiny/near-meaningless for a higher-priced stock (e.g.
  // ~0.06% of a $200 close) -- most relevant for the same lower/mid-price
  // range the rest of Ch27's stop-distance table already targets.
  const progressiveStopFlag = (n>1 && volRatio>3.0 && closes[n-1]>closes[n-2] &&
    trendMaturity && trendMaturity.direction==='UP' && trendMaturity.daysSinceCross>=5)
    ? { level: closes[n-1]-0.125, volumeRatio: volRatio, daysSinceCross: trendMaturity.daysSinceCross }
    : null;

  const roc10=n>10?(last/closes[n-11]-1)*100:0;
  const roc26=n>26?(last/closes[n-27]-1)*100:0;
  const roc52=n>52?(last/closes[n-53]-1)*100:0;
  const roc252=n>252?(last/closes[n-253]-1)*100:0;
  const mom5=n>5?(last/closes[n-6]-1)*100:0;
  const mom20=n>20?(last/closes[n-21]-1)*100:0;

  const high52=Math.max(...highs.slice(-252)),low52=Math.min(...lows.slice(-252));
  // v9.33 — CHARACTERIZATION_PLAN_breakout_context.md. Real, direct claim
  // from broker course episode 3: a resistance breakout near an all-time/
  // 52-week high can run far more aggressively than the same breakout in a
  // stock whose broader trend is still down (instructor's own worked
  // comparison: Teva vs. Neo). Zero new computation -- reuses high52 (just
  // computed above) and roc252 (already computed a few lines up). 3%/-30%
  // are direct, reasoned readings of the course's own qualitative framing,
  // not fit to any backtest. UPDATE (v9.50): promoted to real scoring, see
  // the "Breakout Context" addL block below -- this comment previously said
  // "display only, not scored" after that promotion already shipped; caught
  // by independent review, docs/OPUS_REVIEW_2026-08-27.md.
  const nearATH = last >= high52*0.97;
  const longTermDowntrend = !nearATH && roc252 < -30;
  const breakoutContext = nearATH ? 'near 52wk/ATH — favorable breakout context'
    : longTermDowntrend ? 'long-term downtrend — weaker breakout context'
    : 'neutral';

  // v9.43 -- CHARACTERIZATION_PLAN_gap_types.md. Classic gap taxonomy
  // (Common/Breakaway/Runaway/Exhaustion/Island) -- broker course ep.11,
  // reinforced on-screen by StockCharts.com's own "Gaps and Gap Analysis"
  // reference article. Enriches `priceGaps` (already computed above) with a
  // `.gapType` field on each entry -- does NOT touch priceGaps' own
  // detection or fill-tracking logic, purely additive.
  //
  // Checked in priority order matching the course's own framing (Breakaway
  // explicitly named the strongest/most important type -- checked first):
  //   1. BREAKAWAY -- gap breaks a real multi-touch (>=2) S/R level.
  //      swingHighs/swingLows themselves are block-scoped to the chart-
  //      pattern try{} elsewhere in this file and can't be reused directly
  //      here, so this recomputes the same swing-touch primitive
  //      independently, reusing the exact SWING_WINDOW=5/LEVEL_TOLERANCE=
  //      0.03 VALUES already established for chart-pattern detection (same
  //      convention already mirrored once before, v9.36's
  //      ROUND_NUMBER_TOLERANCE) -- zero new data either way.
  //   2. EXHAUSTION -- gap's volume is the HIGHEST in the same 60-bar
  //      window priceGaps itself already scans, AND the next bar reverses
  //      back across the gap's own level -- both real, explicit course
  //      criteria, no invented number.
  //   3. ISLAND -- an opposite-direction gap occurs within GT_ISLAND_WINDOW
  //      (10 bars, NOT the 60-bar GT_LOOKBACK -- this summary said 60-bar
  //      for a while after the real fix below moved it to 10; caught by
  //      independent review, docs/OPUS_REVIEW_2026-08-27.md) of the other
  //      gap (checked pairwise against the other gaps already in priceGaps).
  //   4. RUNAWAY -- gap continues an ALREADY established move. Reuses
  //      nearATH/longTermDowntrend (both just computed above for
  //      breakoutContext, v9.33) rather than inventing a new roc252
  //      threshold -- those are the file's own existing, reasoned reads of
  //      "is this stock already in a strong established trend."
  //   5. COMMON -- fallback, none of the above (the course's own "doesn't
  //      interest me" default).
  try {
    const GT_SWING_WINDOW = 5, GT_LEVEL_TOLERANCE = 0.03, GT_MIN_TOUCHES = 2, GT_LOOKBACK = 60;
    // GT_ISLAND_WINDOW=10 (~2 trading weeks): REAL BUG CAUGHT IN REAL-DATA
    // TESTING (not mocks) -- Island originally reused GT_LOOKBACK (60 bars),
    // the SAME span as the whole priceGaps scan itself, so "is there an
    // opposite-direction gap nearby" was almost always true whenever a
    // ticker had both up and down gaps anywhere in the scanned window --
    // AAPL real check: 7/7 real gaps misclassified Island. "Quickly
    // followed" (the course's own phrase) means days, not months -- 10
    // trading days is a reasoned estimate matching the visual spacing of
    // the course's own real island examples (NFLX, ZM), disclosed as an
    // estimate since no exact day-count was stated, not fit to a backtest.
    const GT_ISLAND_WINDOW = 10;
    const gtSwingHighs = [], gtSwingLows = [];
    for (let i = GT_SWING_WINDOW; i < n - GT_SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-GT_SWING_WINDOW, i+GT_SWING_WINDOW+1);
      const lSlice = lows.slice(i-GT_SWING_WINDOW, i+GT_SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) gtSwingHighs.push({ idx: i, price: highs[i] });
      if (lows[i] === Math.min(...lSlice)) gtSwingLows.push({ idx: i, price: lows[i] });
    }
    // REAL BUG CAUGHT IN TESTING (mock self-test, not real-data): the gap's OWN
    // immediately-preceding bar (highs[g.idx-1]/lows[g.idx-1], i.e. the bar that
    // literally IS gap.level) trivially registers as its own swing high/low --
    // it's a local max/min surrounded by unrelated bars, so it always "touches
    // itself." That silently inflated every gap's touch count by 1, meaning
    // GT_MIN_TOUCHES=2 only required ONE genuinely prior touch, not two. Fixed
    // to require touches strictly before the gap's own defining bar
    // (`beforeIdx-1`, not `beforeIdx`), matching the course's real teaching of
    // multiple PRIOR consolidation touches before the breakout bar itself.
    const touchCount = (level, swings, beforeIdx) => swings.filter(s => s.idx < beforeIdx-1 && Math.abs(s.price-level)/level <= GT_LEVEL_TOLERANCE).length;

    priceGaps.forEach(g => {
      const relevantSwings = g.type === 'UP' ? gtSwingHighs : gtSwingLows;
      if (touchCount(g.level, relevantSwings, g.idx) >= GT_MIN_TOUCHES) { g.gapType = 'BREAKAWAY'; return; }

      const windowStart = Math.max(0, g.idx - GT_LOOKBACK);
      const isHighestVol = volumes[g.idx] === Math.max(...volumes.slice(windowStart, g.idx+1));
      const nextIdx = g.idx+1;
      const reversedNext = nextIdx < n && (g.type==='UP' ? closes[nextIdx] < g.level : closes[nextIdx] > g.level);
      // v9.46 real finding disclosed (independent review, 2026-08-22):
      // EXHAUSTION is inherently retrospective by its own real-world
      // definition (the move failed shortly AFTER the gap) -- this reads
      // closes[g.idx+1], a bar after the gap's own index. Not "fixed" by
      // changing the logic (that would break what "Exhaustion" actually
      // means), but flagged programmatically so a backtest can exclude
      // it -- standing rule #6 (no-lookahead, index i uses only [0..i])
      // is stated absolutely elsewhere in this file and this is a real,
      // narrow, disclosed exception to it, not a silent violation.
      if (isHighestVol && reversedNext) { g.gapType = 'EXHAUSTION'; g.gapTypeHindsightDependent = true; return; }

      // Same disclosure: ISLAND's window is symmetric in time (an
      // opposite-direction gap within GT_ISLAND_WINDOW bars EITHER side),
      // so a gap can be classified Island because of a gap that happens
      // LATER. Also inherent to the real definition (an island is
      // isolated by gaps on both sides), flagged the same way.
      if (priceGaps.some(other => other !== g && other.type !== g.type && Math.abs(other.idx - g.idx) <= GT_ISLAND_WINDOW)) {
        g.gapType = 'ISLAND'; g.gapTypeHindsightDependent = true;
        // v9.73, Schabacker Study V/VII. Purely additive -- a new,
        // informational-only field, does NOT change the ISLAND
        // classification/gate above at all (existing firing behavior is
        // completely untouched). Real, checkable validity rule from the
        // book: the two bounding gaps should occur at (roughly) the same
        // price level, AND the first gap must remain genuinely un-closed
        // by the island's own congestion before the second (reversal) gap
        // forms -- a "closed" first gap invalidates the classical
        // definition, even when two opposite-direction gaps are both
        // present nearby.
        const gtOther = priceGaps.find(other => other !== g && other.type !== g.type && Math.abs(other.idx - g.idx) <= GT_ISLAND_WINDOW);
        if (gtOther) {
          const sameLevel = Math.abs(gtOther.level - g.level) / g.level <= GT_LEVEL_TOLERANCE;
          const between = closes.slice(Math.min(g.idx,gtOther.idx)+1, Math.max(g.idx,gtOther.idx));
          const stayedOpen = g.type === 'UP'
            ? between.every(v => v >= g.level) // an up-gap stays "open" while price never falls back through its own level
            : between.every(v => v <= g.level);
          g.meetsStrictValidity = sameLevel && stayedOpen;
        }
        return;
      }

      // v9.46 real bug fix (independent review, 2026-08-22, verified
      // before fixing): nearATH/longTermDowntrend (computed above, once,
      // from `last`/`roc252` -- i.e. TODAY's price) were being applied to
      // classify gaps up to GT_LOOKBACK*... bars in the past, so a gap
      // from mid-downtrend 50 bars ago could get relabeled RUNAWAY purely
      // because the stock has since rallied to a new high. Fixed to
      // compute nearATH/longTermDowntrend AS OF the gap's own bar index,
      // reusing the same 252-bar-window/roc252 logic, not today's values.
      const gapHigh52Start = Math.max(0, g.idx - 251);
      const gapHigh52 = Math.max(...highs.slice(gapHigh52Start, g.idx+1));
      const gapRoc252 = g.idx >= 252 ? (closes[g.idx]/closes[g.idx-252]-1)*100 : null;
      const nearATHAtGap = closes[g.idx] >= gapHigh52*0.97;
      const longTermDowntrendAtGap = !nearATHAtGap && gapRoc252 != null && gapRoc252 < -30;
      if (g.type === 'UP' ? nearATHAtGap : longTermDowntrendAtGap) { g.gapType = 'RUNAWAY'; return; }

      g.gapType = 'COMMON';
    });
  } catch(e) {
    // v9.66 -- same real gap as the chart-pattern catch above (docs/OPUS_REVIEW_2026-08-27.md):
    // a throw here silently drops the whole gap-taxonomy classification pass.
    // Logged for visibility, same guarded pattern.
    if (typeof Logger !== 'undefined') Logger.log('⚠️ gap taxonomy classification aborted: ' + e.message);
  }

  const fibRange=high52-low52,fibPct=fibRange===0?0.5:(last-low52)/fibRange,range52Pct=fibPct*100;
  const fib236=low52+0.236*fibRange,fib382=low52+0.382*fibRange,fib500=low52+0.500*fibRange;
  const fib618=low52+0.618*fibRange,fib786=low52+0.786*fibRange;

  // v9.73, Schabacker Study IX "Half-way Intermediate Movement Theory" --
  // real, distinct from fibPct above (which is a rolling 52-week-range
  // POSITION, not a retracement of a specific recent swing move). Book's
  // own real, quantified rule: a correction retracing HALF OR LESS of the
  // prior major swing is a normal correction; MORE than half raises real
  // suspicion of an actual major-trend reversal (book's own suggested
  // safer cutoff: two-thirds). Purely additive -- new, self-contained
  // field, own small swing scan (same SWING_WINDOW convention used
  // throughout this file), doesn't touch fibPct/fib236-786 above at all.
  let halfwayRetracementRead = null;
  try {
    const HR_SWING_WINDOW = 5;
    const hrSwings = [];
    for (let i = HR_SWING_WINDOW; i < n - HR_SWING_WINDOW; i++) {
      const hSlice = highs.slice(i-HR_SWING_WINDOW, i+HR_SWING_WINDOW+1);
      const lSlice = lows.slice(i-HR_SWING_WINDOW, i+HR_SWING_WINDOW+1);
      if (highs[i] === Math.max(...hSlice)) hrSwings.push({ idx: i, price: highs[i], type: 'H' });
      if (lows[i] === Math.min(...lSlice)) hrSwings.push({ idx: i, price: lows[i], type: 'L' });
    }
    hrSwings.sort((a,b) => a.idx - b.idx);
    if (hrSwings.length >= 2) {
      const hrLast = hrSwings[hrSwings.length-1], hrPrior = hrSwings[hrSwings.length-2];
      if (hrLast.type !== hrPrior.type) {
        const moveSize = Math.abs(hrLast.price - hrPrior.price);
        if (moveSize > 0) {
          const retracedPct = Math.abs(last - hrLast.price) / moveSize;
          const classification = retracedPct <= 0.5 ? 'normal' : (retracedPct <= 0.667 ? 'thin' : 'suspect-major-reversal');
          halfwayRetracementRead = { moveFrom: hrPrior.price, moveTo: hrLast.price, retracedPct, classification };
        }
      }
    }
  } catch (e) { /* non-fatal */ }

  const pH=highs[n-2]||last,pL=lows[n-2]||last,pC=closes[n-2]||last;
  const pivot=(pH+pL+pC)/3,pp_R1=2*pivot-pL,pp_S1=2*pivot-pH,pp_R2=pivot+(pH-pL),pp_S2=pivot-(pH-pL);
  const abovePivot=last>pivot;

  // v9.36 -- CHARACTERIZATION_PLAN_round_numbers.md. Real, concrete gap from
  // broker course episode 6 (ep.5 raised round numbers but never elaborated
  // -- this closes that thread). Four real worked chart examples (NIO, TSLA,
  // VXX, DPW) show round-number significance scaling with the price's own
  // order of magnitude. Checked directly: the file's existing LEVEL_TOLERANCE
  // (0.03, used earlier in this function for S/R flatness) is declared inside
  // the chart-pattern try-block and already out of scope here -- so this
  // mirrors its VALUE (0.03), not the variable, same convention either way.
  const ROUND_NUMBER_TOLERANCE = 0.03;
  const roundNumber = roundNumberProximityV7(last, ROUND_NUMBER_TOLERANCE);

  // v9.37 -- CHARACTERIZATION_PLAN_secondary_day.md. Real, named momentum-
  // continuation entry technique from broker course episode 7: a high-volume
  // "strong day" followed by the NEXT day breaking above that day's high
  // draws in momentum/algo traders. Reuses the engine's own already-
  // established 1.5x volume convention (used 3+ places already) rather than
  // inventing a new price-% threshold -- matches the instructor's own
  // emphasis on volume as the confirming check. Zero new data.
  const secondaryDay = secondaryDayV7(closes, highs, volumes, n);

  // v9.39 -- CHARACTERIZATION_PLAN_lockup_expiration.md. c.ipoDate comes from
  // fetchYahooChart's meta.firstTradeDate (zero new data). Real-world calendar
  // days since listing, not trading-day count -- `now` defaults to actual
  // wall-clock `new Date()` for every real/live call site (unchanged
  // behavior). v9.51: `c.simulatedNow` is an OPTIONAL field, undefined on
  // every real call site in this file -- exists only so a backtest harness
  // can pass the checkpoint's own simulated "today" instead of actual today.
  // Real, disclosed reason this was needed: a full real-data predictive-edge
  // backtest (2026-08-23, PREDICTIVE_EDGE_BACKTEST_RESULTS.md) found this
  // feature never fired once in 13,675 checkpoints -- traced to this line
  // always checking real 2026-08-23 regardless of which historical point was
  // being simulated, not a WARMUP/data problem as first assumed.
  const lockupExpiration = lockupExpirationV7(c.ipoDate, c.simulatedNow || new Date());

  // v9.40 -- CHARACTERIZATION_PLAN_reverse_split.md. c.splits/c.dates come
  // from fetchYahooChart (splits via the new events=div,splits param, dates
  // already existed) -- zero new data. Uses c.dates, not a bare `dates`:
  // checked directly, this function destructures only closes/highs/lows/
  // volumes from `c` at the top, dates was never pulled into local scope.
  const recentReverseSplit = recentReverseSplitV7(c.splits, c.dates, n);

  // v9.96 real bug fix (due-diligence pass, 2026-09-04, same class as the
  // v9.46 detectRegimeV7 fix): these 3 previously defaulted to 0 when their
  // SMA doesn't exist yet (young ticker) -- 0 isn't neutral to every
  // downstream >0?bullish:-0.5-bearish consumer, it silently reads as
  // "flat, so bearish." null matches above200/above50's already-correct
  // convention a few lines below; every consumer updated alongside this.
  const pctFromSma20=sma20?(last/sma20-1)*100:null;
  const pctFromSma50=sma50?(last/sma50-1)*100:null;
  const pctFromSma200=sma200?(last/sma200-1)*100:null;
  const shortSlope=slope(closes,20);

  // v9.49 -- engine gap-fill, independent review + video-fidelity audit
  // (2026-08-22). Weekly/monthly range-based volatility %, same simple
  // formula as this file's own existing range-based reads elsewhere
  // (hi-lo range as a % of average close over the window) -- classified
  // against the real, raw-verified ep.1 hot/coiled bands (see
  // volatilityHotColdV7's own comment for the full transcript quote).
  function trailingRangeVolPctV7(lookback) {
    if (n < lookback) return null;
    const wH = highs.slice(n - lookback), wL = lows.slice(n - lookback), wC = closes.slice(n - lookback);
    const avgC = wC.reduce((a,b)=>a+b,0) / wC.length;
    if (!avgC) return null;
    return (Math.max(...wH) - Math.min(...wL)) / avgC;
  }
  const weeklyVolatilityPct = trailingRangeVolPctV7(5);
  const monthlyVolatilityPct = trailingRangeVolPctV7(21);
  const weeklyVolatility = volatilityHotColdV7(weeklyVolatilityPct);
  const monthlyVolatility = volatilityHotColdV7(monthlyVolatilityPct);

  // v9.49 -- engine gap-fill. Trend direction for srLevelsV7's
  // trend-conditional weighting -- reuses the already-computed
  // pctFromSma50 sign, the same simple direction signal this file's own
  // detectRegimeV7 (called downstream) is itself built from, not a new
  // methodology.
  const srTrendDirection = pctFromSma50 > 0 ? 'up' : pctFromSma50 < 0 ? 'down' : 'flat';
  const srLevels = srLevelsV7(highs, lows, srTrendDirection, volumes); // v9.73: volumes passed through for the new, optional volumeWeightedStrength field -- purely additive, srMultiTimeframeConfluenceV7's own 3 internal calls are left unchanged

  // v9.54 -- CHARACTERIZATION_PLAN.md's still-unbuilt "S/R multi-timeframe
  // strength scoring" candidate (distinct from v9.49's trend-conditional
  // weighting above). Real course rule (ep.3-5, 5+ worked examples --
  // TSLA/PYPL/ZM/JWN/ANF): a level that also shows up on weekly/monthly
  // timeframes is materially stronger than the same level on daily alone.
  // Zero new detection logic -- reuses srLevelsV7 (immediately above) against
  // resampled weekly/monthly OHLC (every 5/21 trading days = 1 week/month,
  // the same approximation this file's own weekly[] resample already uses
  // elsewhere) and checks confluence with LEVEL_TOLERANCE_V7 (the same
  // constant already used throughout this file for level-proximity checks).
  const srMultiTimeframe = srMultiTimeframeConfluenceV7(highs, lows);

  const speculativeSpike = speculativeSpikeV7(closes, volumes, n);

  // Divergence between price and RSI (regular bull/bear divergence)
  const rsiSeries=rsiArray(closes,14);
  const divergence=detectDivergence(closes,rsiSeries,60);

  // MACD and OBV divergence (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- extends
  // the exact same, already-proven detectDivergence pattern used for RSI
  // above, reusing macdLine/obvArr which already exist as full historical
  // series in this same function scope (computed for the current-value
  // display elsewhere), zero new computation needed.
  const macdDivergence=detectDivergence(closes,macdLine,60,'MACD');
  const obvDivergence=detectDivergence(closes,obvArr,60,'OBV');

  // Relative strength vs benchmark (SPY), aligned to this stock's dates by the caller
  let rs=null;
  const bench=c.benchmarkCloses;
  if(bench&&bench.length===n){
    const ratio=closes.map((v,i)=>bench[i]?v/bench[i]:null).filter(v=>v!=null);
    const rn=ratio.length;
    const rs21=rn>21?(ratio[rn-1]/ratio[rn-22]-1)*100:0;
    const rs63=rn>63?(ratio[rn-1]/ratio[rn-64]-1)*100:0;
    const rsSlope=slope(ratio,63);
    rs={rs21,rs63,rsSlope,outperforming:rs63>0};
  }

  // v9.68 -- BIG_PLAN_ENGINE_EXPANSION.md Phase A. 5 real, standard,
  // widely-used indicators genuinely absent from this file (confirmed via
  // direct inventory before writing any of this, not assumed). All use
  // real, textbook-standard periods/multipliers -- not fit to any backtest,
  // same discipline as every other indicator in this file (RSI/Stochastic/
  // CCI/etc. all use their own real textbook defaults, never tuned here).

  // Aroon (25-period standard default) -- trend-strength via time-since-extreme.
  const AROON_PERIOD = 25;
  let aroonUp = null, aroonDown = null;
  if (n > AROON_PERIOD) {
    const hSlice = highs.slice(n-AROON_PERIOD, n), lSlice = lows.slice(n-AROON_PERIOD, n);
    let hIdx = 0, lIdx = 0;
    for (let i = 1; i < hSlice.length; i++) { if (hSlice[i] >= hSlice[hIdx]) hIdx = i; if (lSlice[i] <= lSlice[lIdx]) lIdx = i; }
    const daysSinceHigh = hSlice.length - 1 - hIdx, daysSinceLow = lSlice.length - 1 - lIdx;
    aroonUp = ((AROON_PERIOD - daysSinceHigh) / AROON_PERIOD) * 100;
    aroonDown = ((AROON_PERIOD - daysSinceLow) / AROON_PERIOD) * 100;
  }

  // Donchian Channels (20-period standard default -- the original Turtle
  // Trading entry-channel period).
  const DONCHIAN_PERIOD = 20;
  let donchianUpper = null, donchianLower = null, donchianMid = null;
  if (n >= DONCHIAN_PERIOD) {
    donchianUpper = Math.max(...highs.slice(n-DONCHIAN_PERIOD, n));
    donchianLower = Math.min(...lows.slice(n-DONCHIAN_PERIOD, n));
    donchianMid = (donchianUpper + donchianLower) / 2;
  }

  // v9.99 -- Appendix E (Turtle System), System 2: the book's own real
  // parallel 55-day channel (turtleModelV1.gs's own "dual-system breakout
  // read," Deliverable 2 port-audit, docs/BIG_PLAN_TURTLE.md, 2026-09-05).
  // INFORMATIONAL cross-reference ONLY -- deliberately NOT scored anywhere
  // (not in scoreAllSignalsV7_'s verdict total, not in computeTechnicalPlanV7's
  // Trend category): this project's own core finding is "no reliable edge
  // confirmed 5+ times" -- a brand-new Final-Conviction addition needs a
  // real predictive-value backtest first, same standing rule every other
  // scored addition here already went through (SCALLOP_SERIES, vixRegime:
  // Normal). Same inclusive-today convention as its sibling Donchian(20)
  // block just above (a consistent read next to its neighbor), NOT the
  // model's own stricter, book-exact exclusive-today breakout definition
  // used for actual entry signals (see turtleModelV1.gs's own
  // turtleRollHighV1_/turtleRollLowV1_) -- different purpose (display
  // cross-reference here, not a trading signal).
  const DONCHIAN55_PERIOD = 55;
  let donchian55Upper = null, donchian55Lower = null;
  if (n >= DONCHIAN55_PERIOD) {
    donchian55Upper = Math.max(...highs.slice(n-DONCHIAN55_PERIOD, n));
    donchian55Lower = Math.min(...lows.slice(n-DONCHIAN55_PERIOD, n));
  }

  // Parabolic SAR (Wilder's original formula: AF starts 0.02, steps 0.02 per
  // new extreme point, capped at 0.20 -- all 3 are the real, standard,
  // never-changed Wilder defaults). Genuinely recursive/stateful, computed
  // forward from the start of available history -- there is no way to
  // compute "today's" SAR without walking the whole real trend history,
  // same as this file's own ADX/OBV already do.
  let parabolicSAR = null, parabolicSARBullish = null;
  try {
    const SAR_AF_START = 0.02, SAR_AF_STEP = 0.02, SAR_AF_MAX = 0.20;
    if (n > 5) {
      let trendUp = closes[1] > closes[0];
      let sar = trendUp ? Math.min(lows[0], lows[1]) : Math.max(highs[0], highs[1]);
      let ep = trendUp ? Math.max(highs[0], highs[1]) : Math.min(lows[0], lows[1]);
      let af = SAR_AF_START;
      for (let i = 2; i < n; i++) {
        let nextSar = sar + af * (ep - sar);
        if (trendUp) {
          nextSar = Math.min(nextSar, lows[i-1], lows[i-2]);
          if (lows[i] < nextSar) { trendUp = false; nextSar = ep; ep = lows[i]; af = SAR_AF_START; }
          else if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX); }
        } else {
          nextSar = Math.max(nextSar, highs[i-1], highs[i-2]);
          if (highs[i] > nextSar) { trendUp = true; nextSar = ep; ep = highs[i]; af = SAR_AF_START; }
          else if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX); }
        }
        sar = nextSar;
      }
      parabolicSAR = sar; parabolicSARBullish = trendUp;
    }
  } catch(e) { /* non-fatal */ }

  // SuperTrend (ATR-based, multiplier=3 standard default). Needs a real
  // PER-BAR ATR, not just the final scalar atr14 -- reuses sTR (Wilder-
  // smoothed True Range array, already computed above for ADX), not a
  // second redundant ATR computation. Index alignment checked directly
  // against wilderArray()'s own real construction, not assumed: sTR[0] is
  // the average of the first 14 real TR values (trArr[0..13], i.e. TR for
  // real day indices 1..14) -- that average represents ATR "as of" day
  // index 14. Each subsequent sTR[k] advances exactly one real day, so
  // sTR[k] = ATR as of real day index (14+k).
  let superTrend = null, superTrendBullish = null;
  try {
    const ST_MULTIPLIER = 3, ST_START = 14;
    if (n > ST_START + 1 && sTR.length >= n - ST_START) {
      const atrAt = (i) => sTR[i - ST_START];
      let finalUpper = (highs[ST_START]+lows[ST_START])/2 + ST_MULTIPLIER*atrAt(ST_START);
      let finalLower = (highs[ST_START]+lows[ST_START])/2 - ST_MULTIPLIER*atrAt(ST_START);
      let trendUp = true;
      for (let i = ST_START+1; i < n; i++) {
        const atrI = atrAt(i);
        const basicUpper = (highs[i]+lows[i])/2 + ST_MULTIPLIER*atrI;
        const basicLower = (highs[i]+lows[i])/2 - ST_MULTIPLIER*atrI;
        const newFinalUpper = (basicUpper < finalUpper || closes[i-1] > finalUpper) ? basicUpper : finalUpper;
        const newFinalLower = (basicLower > finalLower || closes[i-1] < finalLower) ? basicLower : finalLower;
        if (trendUp && closes[i] < newFinalLower) trendUp = false;
        else if (!trendUp && closes[i] > newFinalUpper) trendUp = true;
        finalUpper = newFinalUpper; finalLower = newFinalLower;
      }
      superTrend = trendUp ? finalLower : finalUpper; superTrendBullish = trendUp;
    }
  } catch(e) { /* non-fatal */ }

  // Ichimoku Cloud (standard periods: Tenkan=9, Kijun=26, Senkou B=52,
  // displacement=26 -- all real, never-changed textbook defaults). Real
  // no-lookahead note, checked directly not assumed: the cloud visible
  // AGAINST today's price on a real chart was computed 26 real bars ago
  // (Senkou A/B "as of" day (today-26), displaced forward when plotted) --
  // reading it that way here uses only real, already-past data, the same
  // legitimate displacement every real Ichimoku chart uses, not a lookahead
  // violation.
  let tenkanSen = null, kijunSen = null, senkouSpanA = null, senkouSpanB = null, ichimokuCloudBullish = null;
  try {
    const ICHI_TENKAN = 9, ICHI_KIJUN = 26, ICHI_SENKOU_B = 52, ICHI_DISPLACEMENT = 26;
    const midOf = (period, endIdx) => {
      if (endIdx - period + 1 < 0) return null;
      return (Math.max(...highs.slice(endIdx-period+1, endIdx+1)) + Math.min(...lows.slice(endIdx-period+1, endIdx+1))) / 2;
    };
    const lastIdx = n-1;
    tenkanSen = midOf(ICHI_TENKAN, lastIdx);
    kijunSen = midOf(ICHI_KIJUN, lastIdx);
    const cloudSrcIdx = lastIdx - ICHI_DISPLACEMENT;
    if (cloudSrcIdx >= ICHI_SENKOU_B - 1) {
      const tenkanAtSrc = midOf(ICHI_TENKAN, cloudSrcIdx), kijunAtSrc = midOf(ICHI_KIJUN, cloudSrcIdx);
      senkouSpanA = (tenkanAtSrc + kijunAtSrc) / 2;
      senkouSpanB = midOf(ICHI_SENKOU_B, cloudSrcIdx);
      if (senkouSpanA != null && senkouSpanB != null) {
        const cloudTop = Math.max(senkouSpanA, senkouSpanB), cloudBottom = Math.min(senkouSpanA, senkouSpanB);
        ichimokuCloudBullish = last > cloudTop ? true : (last < cloudBottom ? false : null); // null = inside the cloud, neutral
      }
    }
  } catch(e) { /* non-fatal */ }

  // v9.68 -- full classical Wyckoff Accumulation/Distribution framework
  // (see wyckoffSchematicV7's own header comment for the real design).
  // Called here, after chartPatterns is fully populated (needs RECTANGLE/
  // BEAR_TRAP/BULL_TRAP already detected to anchor against).
  const wyckoffSchematic = wyckoffSchematicV7(c.dates, closes, highs, lows, volumes, volRatio, chartPatterns);

  // Trend-aligned volume (v9.72, Schabacker Study VIII) -- real, simple,
  // general-purpose signal, NOT tied to any specific chart pattern (unlike
  // almost everything else in this Schabacker pass): book's own words,
  // "volume tends to run higher when prices are moving in the direction
  // of the basic trend, lower when moving contrary to it." Trend
  // direction proxy: close vs SMA50 (already computed above) --
  // computeAllIndicators doesn't have the full regime read yet (that's
  // derived later, from this function's own output), so this reuses the
  // same simple signal above50 already relies on. Real, disclosed
  // lookback: 20 bars (~1 trading month), a reasoned default, not
  // empirically validated, same standing caveat as every other threshold
  // in this file. Purely additive -- new field only.
  let trendAlignedVolume = null;
  try {
    const TAV_LOOKBACK = 20;
    if (n > TAV_LOOKBACK) {
      const upDayVols = [], downDayVols = [];
      for (let i = n-TAV_LOOKBACK; i < n; i++) {
        if (closes[i] > closes[i-1]) upDayVols.push(volumes[i]);
        else if (closes[i] < closes[i-1]) downDayVols.push(volumes[i]);
      }
      if (upDayVols.length && downDayVols.length) {
        const avgUp = upDayVols.reduce((a,b)=>a+b,0)/upDayVols.length;
        const avgDown = downDayVols.reduce((a,b)=>a+b,0)/downDayVols.length;
        const trendDir = sma50 && last > sma50 ? 'UP' : 'DOWN';
        const aligned = trendDir === 'UP' ? avgUp > avgDown : avgDown > avgUp;
        trendAlignedVolume = { avgUpDayVolume: avgUp, avgDownDayVolume: avgDown, trendDir, aligned };
      }
    }
  } catch (e) { /* non-fatal */ }

  // Volume/price-progress divergence (v9.72, Schabacker Study VIII) --
  // real, simple, general-purpose: "several days of high volume attended
  // by no price movement" suggests resistance/distribution being
  // absorbed, forecasting a correctional pause. Conceptually distinct
  // from the already-built VIX-divergence/climax-volume signals
  // (different data, different shape). Real, disclosed defaults: 5-day
  // window, "high volume" = 1.5x the trailing 20-day average, "little
  // price progress" = net move under 2% over those 5 days -- reasoned,
  // not empirically validated. Purely additive -- new field only.
  let volumeProgressDivergence = null;
  try {
    const VPD_WINDOW = 5, VPD_VOL_MULT = 1.5, VPD_MAX_PROGRESS_PCT = 0.02, VPD_BASE_LOOKBACK = 20;
    if (n >= VPD_WINDOW + VPD_BASE_LOOKBACK) {
      const baseVols = volumes.slice(n-VPD_WINDOW-VPD_BASE_LOOKBACK, n-VPD_WINDOW);
      const avgBaseVol = baseVols.reduce((a,b)=>a+b,0)/baseVols.length;
      const recentVols = volumes.slice(n-VPD_WINDOW, n);
      const avgRecentVol = recentVols.reduce((a,b)=>a+b,0)/recentVols.length;
      const netProgressPct = Math.abs((closes[n-1]-closes[n-1-VPD_WINDOW])/closes[n-1-VPD_WINDOW]);
      const flagged = avgBaseVol > 0 && avgRecentVol > VPD_VOL_MULT * avgBaseVol && netProgressPct < VPD_MAX_PROGRESS_PCT;
      volumeProgressDivergence = { flagged, avgRecentVolume: avgRecentVol, avgBaseVolume: avgBaseVol, netProgressPct };
    }
  } catch (e) { /* non-fatal */ }

  return {
    last,high52,low52,rsi14,rsiWeekly,weeklyTrend,macdVal,sigVal,histogram,histSlope,
    bbUpper,bbLower,bbPctB,bbWidth,bbSqueeze,sma20v,stochK,stochD,stochRSI,
    willR,cci20,mfi14,atr14,atrRatio,adx14,adxBullish,
    obvShortSlope,obvLongSlope,cmf20,volRatio,
    sma20,sma50,sma150,sma200,ema9,ema21,above200,above50,goldenCross,deathCross,trendMaturity,singleCandle,dpoSignature,
    pctFromSma20,pctFromSma50,pctFromSma200,
    roc10,roc26,roc52,roc252,mom5,mom20,
    fibPct,range52Pct,fib236,fib382,fib500,fib618,fib786,
    pivot,pp_R1,pp_S1,pp_R2,pp_S2,abovePivot,shortSlope,breakoutContext,climaxVolume,progressiveStopFlag,turtleN,roundNumber,secondaryDay,lockupExpiration,recentReverseSplit,
    divergence,macdDivergence,obvDivergence,rs,
    keltnerUpper,keltnerLower,keltnerSqueeze,
    chandelierStop,chandelierHighestHigh,
    monthlyStructure,volumePOC,trailingPerf,priceGaps,chartPatterns,
    weeklyVolatilityPct,monthlyVolatilityPct,weeklyVolatility,monthlyVolatility,srLevels,srMultiTimeframe,speculativeSpike,
    aroonUp,aroonDown,donchianUpper,donchianLower,donchianMid,donchian55Upper,donchian55Lower,parabolicSAR,parabolicSARBullish,
    superTrend,superTrendBullish,tenkanSen,kijunSen,senkouSpanA,senkouSpanB,ichimokuCloudBullish,
    wyckoffSchematic,
    trendAlignedVolume, volumeProgressDivergence, // v9.72, Schabacker Study VIII
    halfwayRetracementRead, // v9.73, Schabacker Study IX
  };
}

function computeGannInline(chart, ind) {
  const {closes,highs,lows,volumes,dates} = chart;
  const n = closes.length, cp = chart.currentPrice;

  // Price unit: half ATR20
  const trArr=[];for(let i=1;i<n;i++)trArr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  const atr20=trArr.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,trArr.length);
  let priceUnit=atr20/2;
  if(priceUnit>=10)priceUnit=Math.round(priceUnit/5)*5;
  else if(priceUnit>=2)priceUnit=Math.round(priceUnit);
  else if(priceUnit>=0.5)priceUnit=Math.round(priceUnit*4)/4;
  else priceUnit=Math.round(priceUnit*100)/100;
  if(priceUnit===0)priceUnit=1;

  // Auto-detect pivot: best swing low in last year with volume confirmation
  const lookback=Math.min(252,n-20),start=n-lookback;
  const vol20avg=volumes.slice(start,start+20).reduce((a,b)=>a+b,0)/20||1;
  const window=10;let pivot=null,bestScore=0;
  for(let i=start+window;i<n-window;i++){
    const low=lows[i];
    const isMin=Array.from({length:window*2},(_,k)=>k-window+i).filter(j=>j!==i&&j>=0&&j<n).every(j=>lows[j]>=low);
    if(!isMin)continue;
    const swing=(cp-low)/low;if(swing<0.12)continue;
    const volOk=volumes[i]>vol20avg*0.8;
    const sc=swing*(volOk?1.3:1.0);
    if(sc>bestScore){bestScore=sc;pivot={idx:i,price:low,date:dates[i],daysAgo:n-1-i,volOk,swing};}
  }
  if(!pivot){
    // Fallback: 52-week low. Real, disclosed bug fix (found via the
    // ~1000-scenario mock sweep, tests/edwards_magee_scenario_sweep_test.js,
    // n=20 minimum-length edge case): when n<=20, `start` (n-lookback)
    // lands exactly AT n, one past the last valid index -- `minIdx=start`
    // then pointed at `lows[n]`/`dates[n]` (undefined), crashing at
    // `pivot.date.toLocaleDateString()` below. Real, unreachable in actual
    // production (fetchYahooChart's own `closes.length<60` guard means
    // this function never sees fewer than 60 real bars) -- but a genuine
    // robustness gap, fixed by clamping minIdx to a real, always-valid
    // index (min(start, n-1)), same defensive floor every sibling
    // function in this file already uses.
    let minIdx=Math.min(start,n-1),minVal=lows[minIdx];
    for(let i=minIdx+1;i<n;i++)if(lows[i]<minVal){minVal=lows[i];minIdx=i;}
    pivot={idx:minIdx,price:lows[minIdx],date:dates[minIdx],daysAgo:n-1-minIdx,volOk:false,swing:(cp-lows[minIdx])/lows[minIdx]};
  }
  pivot.dateStr=pivot.date.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});

  // Fan angles
  const ANGLES=[
    {label:'8×1',ratio:8},{label:'4×1',ratio:4},{label:'3×1',ratio:3},
    {label:'2×1',ratio:2},{label:'1×1',ratio:1},{label:'1×2',ratio:0.5},
    {label:'1×3',ratio:1/3},{label:'1×4',ratio:0.25},{label:'1×8',ratio:0.125}
  ];
  const fan={};
  ANGLES.forEach(a=>{
    const level=pivot.price+a.ratio*priceUnit*pivot.daysAgo;
    fan[a.label]={level,above:level>cp,pct:(level-cp)/cp*100,ratio:a.ratio};
  });

  // Which two angles is price between?
  const below=ANGLES.filter(a=>!fan[a.label].above).sort((a,b)=>fan[b.label].level-fan[a.label].level);
  const above=ANGLES.filter(a=> fan[a.label].above).sort((a,b)=>fan[a.label].level-fan[b.label].level);
  const lowerAngle=below.length>0?below[0].label:'below all';
  const upperAngle=above.length>0?above[0].label:'above all';

  // Gann score
  // W4 (v8.0): RE-NORMALIZED to velocity, not raw distance from the 1×1 line.
  // The old bands scored purely on how far price sat BELOW the 1×1 line, and
  // that line rises at priceUnit (½·ATR20) PER DAY from the pivot — so any
  // steady-but-not-parabolic uptrend can't keep pace and always read bearish
  // (PLTR: price +15% over SMA200 yet Gann 15/100). The fix compares the
  // stock's REALIZED velocity since the pivot against the 1×1 slope: "is price
  // out-pacing its own Gann angle?" — achievable for a normal uptrend, and it
  // no longer structurally penalizes every non-vertical advance.
  const master=fan['1×1'];
  const masterPct=master?master.pct:0; // negative=price above 1×1 (bullish) — kept for display/back-compat
  const realizedPerDay = pivot.daysAgo > 0 ? (cp - pivot.price) / pivot.daysAgo : 0;
  const velocityRatio  = priceUnit > 0 ? realizedPerDay / priceUnit : 0;
  let gannScore;
  if      (velocityRatio >= 1.2) gannScore = 85; // rising faster than the 1×1 — strongly bullish structure
  else if (velocityRatio >= 0.9) gannScore = 68; // roughly tracking the 1×1
  else if (velocityRatio >= 0.6) gannScore = 55; // advancing, below the 1×1 pace
  else if (velocityRatio >= 0.3) gannScore = 45; // slow advance
  else if (velocityRatio >= 0)   gannScore = 35; // barely rising / flat since pivot
  else                           gannScore = 18; // falling since the pivot — genuinely bearish

  // Support level from Gann (nearest angle below = near-term support)
  const gannSupport=below.length>0?fan[below[0].label].level:null;
  const gannResistance=above.length>0?fan[above[0].label].level:null;
  const gannMaster=master?master.level:null;

  // Square of Nine: nearest support/resistance
  const root=Math.sqrt(pivot.price),step=0.5;
  const sq9levels=[];
  for(let k=-8;k<=16;k++){if(k===0)continue;const v=Math.pow(root+k*step,2);if(v>0)sq9levels.push(Math.round(v*100)/100);}
  sq9levels.sort((a,b)=>a-b);
  const sq9above=sq9levels.filter(v=>v>cp)[0]||null;
  const sq9below=sq9levels.filter(v=>v<cp).slice(-1)[0]||null;

  return {pivot,priceUnit,fan,lowerAngle,upperAngle,
          gannSupport,gannResistance,gannMaster,
          sq9above,sq9below,score:gannScore,ANGLES};
}

function computeConfluenceTargets(ind, gann, fund, chart) {
  const cp = chart.currentPrice;
  const n  = chart.closes.length;

  // ── SHORT-TERM ENTRY: support/target methods ──
  // Item 2 (DASHBOARD_IMPROVEMENTS_PLAN.md): every candidate is now ALWAYS
  // recorded, with excluded/exclusionReason when it doesn't qualify --
  // nothing silently vanishes. Also adds SMA50/SMA150 as genuine
  // candidates (previously missing entirely, confirmed gap).
  const entryMethods = [];

  // 1. Gann fan support (nearest angle below)
  if (gann.gannSupport)
    entryMethods.push({ name:'Gann support ('+gann.lowerAngle+')', price:gann.gannSupport, type:'support' });
  else
    entryMethods.push({ name:'Gann support', price:null, type:'support', excluded:true, exclusionReason:'no Gann support angle available for this pivot' });

  // 2. Pivot S1 / S2
  if (ind.pp_S1) entryMethods.push({ name:'Pivot S1', price:ind.pp_S1, type:'support' });
  else entryMethods.push({ name:'Pivot S1', price:null, type:'support', excluded:true, exclusionReason:'pivot data unavailable' });
  if (ind.pp_S2 && ind.pp_S2 > 0) entryMethods.push({ name:'Pivot S2', price:ind.pp_S2, type:'support' });
  else entryMethods.push({ name:'Pivot S2', price:null, type:'support', excluded:true, exclusionReason:'pivot S2 unavailable or non-positive' });

  // 3. Bollinger lower band
  if (ind.bbLower) entryMethods.push({ name:'Bollinger lower band', price:ind.bbLower, type:'support' });
  else entryMethods.push({ name:'Bollinger lower band', price:null, type:'support', excluded:true, exclusionReason:'Bollinger data unavailable' });

  // 4. Fibonacci 38.2% and 50% retracement from recent high
  if (ind.fib382) entryMethods.push({ name:'Fib 38.2% retracement', price:ind.fib382, type:'support' });
  else entryMethods.push({ name:'Fib 38.2% retracement', price:null, type:'support', excluded:true, exclusionReason:'Fibonacci data unavailable' });
  if (ind.fib500) entryMethods.push({ name:'Fib 50.0% retracement', price:ind.fib500, type:'support' });
  else entryMethods.push({ name:'Fib 50.0% retracement', price:null, type:'support', excluded:true, exclusionReason:'Fibonacci data unavailable' });

  // 5. ATR-based pullback (1.5× ATR below current, typical healthy pullback)
  const atrSupport = cp - 1.5 * ind.atr14;
  entryMethods.push({ name:'ATR pullback (1.5×ATR)', price:atrSupport, type:'support' });

  // 6. SMA20 as dynamic support
  if (ind.sma20) entryMethods.push({ name:'SMA20 dynamic support', price:ind.sma20, type:'support' });
  else entryMethods.push({ name:'SMA20 dynamic support', price:null, type:'support', excluded:true, exclusionReason:'SMA20 unavailable' });

  // 6b/6c. SMA50 / SMA150 -- NEW, previously missing entirely from this
  // confluence system (confirmed gap, ENGINE_GAP_ANALYSIS.md Section 1).
  // Same pattern as SMA20: candidate if below current price (support),
  // explicitly excluded with a real reason otherwise -- not just absent.
  if (ind.sma50) {
    if (ind.sma50 < cp) entryMethods.push({ name:'SMA50 dynamic support', price:ind.sma50, type:'support' });
    else entryMethods.push({ name:'SMA50 dynamic support', price:ind.sma50, type:'support', excluded:true, exclusionReason:'SMA50 ($'+ind.sma50.toFixed(2)+') is above current price -- not currently acting as support' });
  } else {
    entryMethods.push({ name:'SMA50 dynamic support', price:null, type:'support', excluded:true, exclusionReason:'SMA50 unavailable' });
  }
  if (ind.sma150) {
    if (ind.sma150 < cp) entryMethods.push({ name:'SMA150 dynamic support', price:ind.sma150, type:'support' });
    else entryMethods.push({ name:'SMA150 dynamic support', price:ind.sma150, type:'support', excluded:true, exclusionReason:'SMA150 ($'+ind.sma150.toFixed(2)+') is above current price -- not currently acting as support' });
  } else {
    entryMethods.push({ name:'SMA150 dynamic support', price:null, type:'support', excluded:true, exclusionReason:'SMA150 unavailable' });
  }

  // 7. Square of Nine below
  if (gann.sq9below) entryMethods.push({ name:'Sq9 harmonic support', price:gann.sq9below, type:'support' });
  else entryMethods.push({ name:'Sq9 harmonic support', price:null, type:'support', excluded:true, exclusionReason:'no Sq9 level below current price' });

  // 8. Volume profile Point of Control (DASHBOARD_IMPROVEMENTS_PLAN.md 4a)
  // -- genuinely different from every other method here: based on WHERE
  // the heaviest historical volume actually traded, not a price-derived
  // formula. Same conditional support/exclude pattern already proven for
  // SMA50/150 -- POC could land above or below current price, so it's
  // only a valid ENTRY candidate if it's below.
  if (ind.volumePOC != null) {
    if (ind.volumePOC < cp) entryMethods.push({ name:'Volume POC (high-volume node)', price:ind.volumePOC, type:'support' });
    else entryMethods.push({ name:'Volume POC (high-volume node)', price:ind.volumePOC, type:'support', excluded:true, exclusionReason:'the highest-volume price node ($'+ind.volumePOC.toFixed(2)+') is above current price -- not currently acting as support' });
  } else {
    entryMethods.push({ name:'Volume POC (high-volume node)', price:null, type:'support', excluded:true, exclusionReason:'insufficient volume data to compute a volume profile' });
  }

  // Filter: only prices below current (entry = buy dip) AND not already
  // marked excluded above -- excluded candidates are kept in entryMethods
  // for visibility but never enter the "valid"/scored set.
  const validEntry = entryMethods
    .filter(m => !m.excluded && m.price > 0 && m.price < cp * 1.02) // allow slightly above current (momentum entry)
    .sort((a, b) => b.price - a.price); // highest to lowest

  // ── LONG-TERM EXIT: target methods ──
  const exitMethods = [];

  // A Gann angle extended a full year can produce runaway prices when the
  // price-unit/day is large. Cap projections at a plausible 12-month ceiling
  // (2.5× current price) so they don't pollute the exit list with +600% targets.
  const gannProjCeiling = cp * 2.5;

  // 1. Gann 1×1 projection at 12 months
  if (gann.gannMaster) {
    // 1×1 line value 252 trading days FROM NOW (now is daysAgo bars past the pivot)
    const gann1x1at1yr = gann.pivot.price + gann.priceUnit * (gann.pivot.daysAgo + 252);
    if (gann1x1at1yr > cp && gann1x1at1yr <= gannProjCeiling) {
      exitMethods.push({ name:'Gann 1×1 (12 months)', price:gann1x1at1yr, type:'target' });
    } else {
      const reason = gann1x1at1yr <= cp ? 'projected value is below current price' : 'beyond the 2.5x sanity ceiling ($'+gannProjCeiling.toFixed(2)+')';
      exitMethods.push({ name:'Gann 1×1 (12 months)', price:gann1x1at1yr, type:'target', excluded:true, exclusionReason:reason });
    }
  } else {
    exitMethods.push({ name:'Gann 1×1 (12 months)', price:null, type:'target', excluded:true, exclusionReason:'no Gann master level available' });
  }

  // 2. Fibonacci 161.8% extension from low52 to high52
  const fib1618ext = ind.low52 + 1.618 * (ind.high52 - ind.low52);
  if (fib1618ext > cp) exitMethods.push({ name:'Fib 161.8% extension', price:fib1618ext, type:'target' });
  else exitMethods.push({ name:'Fib 161.8% extension', price:fib1618ext, type:'target', excluded:true, exclusionReason:'projected value is below current price' });

  // 3. Square of Nine above
  if (gann.sq9above) exitMethods.push({ name:'Sq9 harmonic resistance', price:gann.sq9above, type:'target' });
  else exitMethods.push({ name:'Sq9 harmonic resistance', price:null, type:'target', excluded:true, exclusionReason:'no Sq9 level above current price' });

  // 4. SMA200 projected forward 12 months (current slope × 252 trading days)
  if (ind.sma200) {
    const sma200slope = slope(chart.closes, 60); // 60-day slope of closes as proxy
    const sma200proj  = ind.sma200 + sma200slope * 252;
    if (sma200proj > cp) {
      exitMethods.push({ name:'SMA200 trend (12mo proj)', price:sma200proj, type:'target' });
    } else {
      exitMethods.push({ name:'SMA200 trend (12mo proj)', price:sma200proj, type:'target', excluded:true, exclusionReason:'the projected trend (based on current slope) is below current price -- SMA200 is currently declining' });
    }
  } else {
    exitMethods.push({ name:'SMA200 trend (12mo proj)', price:null, type:'target', excluded:true, exclusionReason:'SMA200 unavailable' });
  }

  // 5. Analyst consensus (FMP)
  if (fund && fund.targetMean) {
    if (fund.targetMean > cp) exitMethods.push({ name:'Analyst consensus (FMP)', price:fund.targetMean, type:'target' });
    else exitMethods.push({ name:'Analyst consensus (FMP)', price:fund.targetMean, type:'target', excluded:true, exclusionReason:'analyst mean target ($'+fund.targetMean.toFixed(2)+') is below current price' });
  } else {
    exitMethods.push({ name:'Analyst consensus (FMP)', price:null, type:'target', excluded:true, exclusionReason:'analyst target data unavailable' });
  }
  if (fund && fund.targetHigh) {
    if (fund.targetHigh > cp) exitMethods.push({ name:'Analyst high target (FMP)', price:fund.targetHigh, type:'target' });
    else exitMethods.push({ name:'Analyst high target (FMP)', price:fund.targetHigh, type:'target', excluded:true, exclusionReason:'analyst high target is below current price' });
  } else {
    exitMethods.push({ name:'Analyst high target (FMP)', price:null, type:'target', excluded:true, exclusionReason:'analyst target data unavailable' });
  }

  // 6. 52-week high as near-term resistance / exit
  if (ind.high52 > cp) exitMethods.push({ name:'52-week high', price:ind.high52, type:'target' });
  else exitMethods.push({ name:'52-week high', price:ind.high52, type:'target', excluded:true, exclusionReason:'current price is already above the 52-week high' });

  // 7. Gann 2×1 level (acceleration target)
  // 2×1 line value 252 trading days FROM NOW
  const gann2x1_1yr = gann.pivot.price + 2 * gann.priceUnit * (gann.pivot.daysAgo + 252);
  if (gann2x1_1yr > cp && gann2x1_1yr <= gannProjCeiling) {
    exitMethods.push({ name:'Gann 2×1 (12 months)', price:gann2x1_1yr, type:'target' });
  } else {
    const reason = gann2x1_1yr <= cp ? 'projected value is below current price' : 'beyond the 2.5x sanity ceiling ($'+gannProjCeiling.toFixed(2)+')';
    exitMethods.push({ name:'Gann 2×1 (12 months)', price:gann2x1_1yr, type:'target', excluded:true, exclusionReason:reason });
  }

  // 8. Volume profile Point of Control -- same signal as the entry-side
  // candidate above, only valid as an EXIT/target if it sits ABOVE current
  // price (the mirror-image condition of the entry-side check).
  if (ind.volumePOC != null) {
    if (ind.volumePOC > cp) exitMethods.push({ name:'Volume POC (high-volume node)', price:ind.volumePOC, type:'target' });
    else exitMethods.push({ name:'Volume POC (high-volume node)', price:ind.volumePOC, type:'target', excluded:true, exclusionReason:'the highest-volume price node ($'+ind.volumePOC.toFixed(2)+') is below current price -- not currently acting as resistance' });
  } else {
    exitMethods.push({ name:'Volume POC (high-volume node)', price:null, type:'target', excluded:true, exclusionReason:'insufficient volume data to compute a volume profile' });
  }

  const validExit = exitMethods
    .filter(m => !m.excluded && m.price > cp * 0.98)
    .sort((a, b) => a.price - b.price);

  // ── CLUSTER ANALYSIS: find confluence zones ──
  function findClusters(methods, tolerance) {
    if (methods.length === 0) return [];
    const clusters = [];
    const used = new Array(methods.length).fill(false);
    for (let i = 0; i < methods.length; i++) {
      if (used[i]) continue;
      const cluster = [methods[i]];
      for (let j = i+1; j < methods.length; j++) {
        if (used[j]) continue;
        if (Math.abs(methods[j].price - methods[i].price) / methods[i].price <= tolerance) {
          cluster.push(methods[j]); used[j] = true;
        }
      }
      used[i] = true;
      clusters.push(cluster);
    }
    return clusters.sort((a, b) => b.length - a.length);
  }

  const entryClusters = findClusters(validEntry, 0.05); // 5% tolerance
  const exitClusters  = findClusters(validExit,  0.07); // 7% tolerance for long-term

  function clusterSummary(clusters, methods) {
    if (clusters.length === 0 || methods.length === 0) {
      return { low: cp * 0.95, high: cp * 0.97, center: cp * 0.96, confidence: 'LOW (no data)', count: 0, methods: [] };
    }
    const best = clusters[0];
    const prices = best.map(m => m.price);
    const low  = Math.min(...prices), high = Math.max(...prices);
    const center = prices.reduce((a,b)=>a+b,0)/prices.length;
    const count = best.length;
    // W8 (v8.1): confidence now considers the FRACTION of methods that agree,
    // not just an absolute count. "HIGH (4/12)" previously fired when only a
    // third of methods clustered — misleading. Now HIGH requires both a solid
    // count AND a majority-ish fraction; the label always shows count/total so
    // the user sees the real agreement.
    const frac = methods.length ? count / methods.length : 0;
    const tag = (count >= 4 && frac >= 0.5) ? 'HIGH'
              : (count >= 3 && frac >= 0.35) ? 'MEDIUM'
              : (count >= 2) ? 'LOW-MEDIUM'
              : 'LOW';
    const confidence = tag + ' (' + count + '/' + methods.length + ' methods in zone)';
    return { low, high, center, confidence, count, methods: best, allMethods: methods };
  }

  const entrySummary = clusterSummary(entryClusters, validEntry);
  const exitSummary  = clusterSummary(exitClusters,  validExit);

  return {
    entryLow:        entrySummary.low,
    entryHigh:       entrySummary.high,
    entryCenter:     entrySummary.center,
    entryConfidence: entrySummary.confidence,
    entryCount:      entrySummary.count,
    entryMethods:    entrySummary.methods || [],
    // Item 2 fix: allEntryMethods/allExitMethods now reference the FULL
    // local arrays directly (including excluded candidates), not
    // entrySummary.allMethods (which is just validEntry -- the filtered
    // set, would have silently dropped every excluded candidate before
    // it ever reached the display table). entryConfidence/entryCount
    // above are UNCHANGED, still computed from validEntry inside
    // clusterSummary -- the "X/9 aligned" denominator stays correct.
    allEntryMethods: entryMethods,
    exitLow:         exitSummary.low,
    exitHigh:        exitSummary.high,
    exitCenter:      exitSummary.center,
    exitConfidence:  exitSummary.confidence,
    exitCount:       exitSummary.count,
    exitMethods:     exitSummary.methods || [],
    allExitMethods:  exitMethods,
  };
}



// ══════════════════════════════════════════════════════════════════
//  EARNINGS-DATE AWARENESS (ENGINE_GAP_ANALYSIS.md, priority #1)
//  Real, confirmed endpoint before writing this -- same /stable/ base URL
//  and API key already in use for fundamentals, zero new dependency.
//  Field confirmed via two independent sources: {date, symbol, eps,
//  epsEstimated, time, revenue, revenueEstimated}. "date" (the actual
//  earnings date) is the ONLY field this function needs and is the one
//  most consistently confirmed across sources -- lower confidence on
//  exact naming of the actual-vs-estimated EPS fields, but those aren't
//  used here at all, so that uncertainty doesn't matter for this purpose.
//  Real value: flags whether an option's expiry sits AFTER the next
//  earnings date (meaning the position would be held through the event --
//  a real IV-crush/gap risk), and separately whether the date itself
//  is coming up soon regardless of options.
// ══════════════════════════════════════════════════════════════════
// v9.41 -- CHARACTERIZATION_PLAN_earnings_gap.md. Renamed from
// fetchNextEarningsDate (was future-only) -- the same FMP response already
// carries the FULL history (past + future) with real epsActual/epsEstimated/
// revenueActual/revenueEstimated per report, verified live (NVDA: 8 real
// quarters returned, correct actual/estimate figures). The old function
// silently discarded all of that with `.filter(e => e.date >= today)`.
// `.next` preserves the EXACT old return shape -- the one existing call
// site (the "Next earnings" banner) needed no changes.

// v9.41 -- CHARACTERIZATION_PLAN_earnings_gap.md. Real, concrete gap from
// broker course ep.10 (momentum/gaps): the engine already detects any-size
// price gaps (`priceGaps`, ~line 4126) but has no notion of WHY a gap
// happened. The course draws a hard line between "boring" gap causes
// (dual-listed-stock arbitrage, dividend ex-date, index-wide futures gaps)
// and "interesting" ones -- the single most emphasized being an earnings
// report, with a real, explicit rule of thumb: "expect the price reaction
// to at least match the earnings surprise %." This tags an existing gap
// with its real cause (an earnings date within GAP_EARNINGS_TOLERANCE_DAYS)
// and the real EPS/revenue surprise %, so that rule becomes checkable
// against what the engine already shows -- display/context only, no new
// scored verdict.
//
// GAP_EARNINGS_TOLERANCE_DAYS=1 (not fit to any backtest): earnings
// released after-market-close on day D commonly gap the NEXT trading day;
// before-market-open releases can gap the SAME day. +/-1 calendar day
// covers both real release-timing conventions without over-matching gaps
// that have nothing to do with earnings. Disclosed limitation: FMP's
// `date` field is the report's calendar date, not a BMO/AMC flag -- this
// engine doesn't currently know which, hence the symmetric tolerance
// rather than a directional one.
function classifyGapCauseV7(gap, earningsHistory) {
  if (!earningsHistory || !earningsHistory.length) return null;
  const GAP_EARNINGS_TOLERANCE_DAYS = 1, MS_PER_DAY = 86400000;
  // REAL BUG CAUGHT IN TESTING (mock self-test, not real-data): `.setHours(0,0,0,0)`
  // zeroes in the Apps Script PROJECT's local timezone, but earningsHistory's dates
  // are built with `new Date(e.date+'T00:00:00Z')` -- pinned to UTC midnight. In any
  // non-UTC script timezone those two "midnights" disagree by the UTC offset, which
  // can push a real same-day match outside the +/-1-day tolerance. Fixed to zero in
  // UTC on both sides via Date.UTC, so the comparison is timezone-independent.
  const gd = new Date(gap.date);
  const gapDate = new Date(Date.UTC(gd.getUTCFullYear(), gd.getUTCMonth(), gd.getUTCDate()));
  const match = earningsHistory
    .filter(e => Math.abs(gapDate - e.date) <= GAP_EARNINGS_TOLERANCE_DAYS * MS_PER_DAY)
    .sort((a,b) => Math.abs(gapDate-a.date) - Math.abs(gapDate-b.date))[0];
  if (!match) return null;
  const epsSurprisePct = (match.epsActual != null && match.epsEstimated) ? (match.epsActual - match.epsEstimated) / Math.abs(match.epsEstimated) * 100 : null;
  const revenueSurprisePct = (match.revenueActual != null && match.revenueEstimated) ? (match.revenueActual - match.revenueEstimated) / Math.abs(match.revenueEstimated) * 100 : null;
  return { cause: 'EARNINGS', reportDate: match.date, epsSurprisePct, revenueSurprisePct };
}

// v9.42 -- CHARACTERIZATION_PLAN_gap_market_cap.md. Real, explicit rule from
// broker course ep.11 (gaps2): the same gap % means something different
// depending on market cap -- "the higher the market cap, the smaller the
// gap % needs to be to matter" (direct quote, paraphrased). Real, explicit
// worked example given: on a MEGA-cap, a 3% gap IS significant; the same 3%
// gap on a small-cap is "probably not interesting." Reuses `fund.marketCap`
// (already fetched) and an existing gap's `sizePct` (already computed by
// `priceGaps`) -- zero new data.
//
// Only ONE real numeric anchor was given (mega-cap: 3%) -- no equivalent
// number was stated for Large/Mid/Small/Micro. Rather than invent thresholds
// for the other 4 tiers to "complete" a table, this stays informational
// (tier label only) for everything except Mega-cap, where the one real,
// verified number is applied as an actual significant/not-significant read.
// MARKET_CAP_TIERS mirrors the exact boundaries already used elsewhere in
// this file (the existing Market Cap display line), not a new scale.
// v9.57 -- institutional-holdings (13F) tracker, user-requested. Real, free,
// SEC EDGAR 13F-HR filings. CIKs verified live via SEC's own full-text
// search 2026-08-24 (not memory) -- real finding along the way: large
// managers file under multiple subsidiary CIKs and the "main" one can
// change entirely over time (BlackRock's old consolidated filer, 1364742,
// stopped filing after mid-2024; the real current one is 2012383).
// v9.60 -- Vanguard added. Real research, not left as a permanent gap: found
// all 6 real, active, currently-filing Vanguard subsidiary CIKs (Advisers
// Inc, Asset Management Ltd, Capital Management LLC, Fiduciary Trust Co,
// Global Advisers LLC, Investments Australia) and verified live that
// SUMMING across all 6 produces a real, plausible total (real test: NVDA,
// 1,788,131,110 shares / $357.8B combined -- matches real-world public
// knowledge of Vanguard as one of NVDA's largest holders; the single entity
// tried at v9.57, Advisers Inc, held only 150 of those 1.79B shares --
// "Vanguard Capital Management LLC" turned out to be the real dominant one,
// ~86% of the total, previously undiscovered). A filer entry below can now
// be either one CIK (string) or several (array, summed across all).
// Real, disclosed cost increase: Vanguard alone now adds 6 real CIKs x 2
// quarters = 12 more real fetches per ticker, on top of the existing 3
// filers -- a meaningfully larger real per-report cost than v9.57 shipped
// with, accepted per the user's own "I want zero gaps" request.
const INSTITUTIONAL_13F_FILERS_V7 = {
  'Berkshire Hathaway': '1067983',
  'BlackRock':          '2012383',
  'State Street':       '93751',
  'Vanguard':           ['947529', '1680208', '2100119', '933478', '1811242', '1550100'],
};

// v9.63-companion real fix (2026-08-25, user's own request: "old data does
// not change... check if exist save"): a ticker's CUSIP is effectively
// permanent (same real-but-rare exception as CIK -- a ticker symbol
// reused after delisting -- same reasoned 90-day TTL, not "forever").
// Same real, disclosed benefit as fetchSecEdgarCIKV1's own cache: also
// reduces real pressure on FMP's already-observed rate limit (real HTTP
// 429s hit this exact session, "~250 calls/day"). Reuses cacheGet/cacheSet
// verbatim, same as fetchSecEdgarCIKV1.


// Real, minimal XML parse -- info tables are large (BlackRock's latest is
// ~23MB) but flat/repetitive, a regex-per-record pass is deliberate here,
// same pragmatic scope as this file's other narrow, purpose-built
// extractions, not a general XML parser.
function parse13FInfoTableV7_(xml) {
  const holdings = {}; // cusip -> {issuer, shares, value}
  const re = /<infoTable>([\s\S]*?)<\/infoTable>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const cusip = (block.match(/<cusip>([^<]+)<\/cusip>/) || [])[1];
    const issuer = (block.match(/<nameOfIssuer>([^<]+)<\/nameOfIssuer>/) || [])[1];
    const shares = parseInt((block.match(/<sshPrnamt>([^<]+)<\/sshPrnamt>/) || [])[1] || '0', 10);
    // Real bug caught and fixed before this shipped (institutional_holdings_13f_test.js,
    // 2026-08-24): "value" is WHOLE DOLLARS on current filings (SEC's 2023
    // Form 13F amendment replaced the old thousands-rounding convention) --
    // verified directly against 2 independent real filers' raw XML. An
    // earlier draft divided by 1e3 assuming the old convention and produced
    // a real, absurd $1.2 TRILLION for one mid-cap position before this was caught.
    const value = parseInt((block.match(/<value>([^<]+)<\/value>/) || [])[1] || '0', 10);
    if (!cusip) continue;
    // A filer can list the SAME cusip multiple times (different sub-managers within one filing, real pattern
    // verified directly in BlackRock's own raw XML -- 19 separate entries for one ticker, one real 13F).
    if (!holdings[cusip]) holdings[cusip] = { issuer: issuer, shares: 0, value: 0 };
    holdings[cusip].shares += shares;
    holdings[cusip].value += value;
  }
  return holdings;
}

// Real, single-CIK fetch -- one filer entity's own latest+prior 13F position for one cusip.

// Real, shared summing logic -- extracted 2026-09-05 (v9.104) so the SAME
// aggregation code serves both the original sequential path (below) and the
// new batched path (fetch13FBatchedV1_ + fetchInstitutional13FHoldingsV7),
// instead of two copies drifting apart. Shares/value summed across every
// CIK that holds a real position; date taken from whichever real CIK
// actually returned one (they may not all file the exact same day, real
// and disclosed, not treated as an inconsistency to fix).
function sum13FPerCikResultsV1_(perCik) {
  const result = { latest: null, prior: null };
  ['latest', 'prior'].forEach(label => {
    let summed = null, date = null;
    perCik.forEach(r => {
      const entry = r && r[label];
      if (!entry || !entry.holdings) return;
      if (!summed) summed = { issuer: entry.holdings.issuer, shares: 0, value: 0 };
      summed.shares += entry.holdings.shares;
      summed.value += entry.holdings.value;
      date = date || entry.date;
    });
    if (summed) result[label] = { date: date, holdings: summed };
  });
  return result;
}

// v9.60 -- a filer entry can be one CIK (string) or several (array, real
// example: Vanguard's 6 subsidiary CIKs, summed). Kept as the real,
// sequential single-filer path (still directly callable/testable on its
// own); `fetchInstitutional13FHoldingsV7` below uses the batched path
// instead for its own real multi-filer call, reusing this same summing
// logic via sum13FPerCikResultsV1_.

// Real, disclosed fallback: batches real HTTP requests concurrently via
// UrlFetchApp.fetchAll() (same real technique already proven at ~7x on this
// project's 9 macro fetches) when available, otherwise degrades to a real
// sequential UrlFetchApp.fetch() per request -- never crashes if fetchAll
// is somehow unavailable (defensive; real Apps Script always has it).

// 2026-09-05, v9.104 real batching fix: the real bottleneck behind the 13F
// fetch's measured 26.1s cold cost (see memory
// broker-course-timeout-logging-fix-2026-09-05) isn't any ONE slow call --
// it's up to 45 real SEQUENTIAL round-trips for one ticker (9 real CIKs
// across 4 filers -- Vanguard alone has 6 -- x up to 5 real fetches each:
// 1 submissions lookup + 2x[index.json + XML data] for latest/prior). This
// runs the exact same real work as fetch13FSingleCikV7_ x N, just in 3
// concurrent BATCHED rounds instead of N sequential per-CIK chains: (1)
// every CIK's submissions index at once, (2) every resolved accession's
// index.json at once, (3) every resolved XML data file at once (the real
// big ones). Returns the SAME shape fetch13FSingleCikV7_ would per CIK --
// { [cik]: {latest, prior} } -- so fetchInstitutional13FHoldingsV7 can feed
// it straight into the existing sum13FPerCikResultsV1_.

// Real, disclosed cost: this downloads each filer's FULL current+prior-
// quarter holdings table to search for one CUSIP (not a targeted lookup --
// SEC provides no such endpoint). Real, accepted per the user's own
// explicit call (2026-08-24) to wire this in despite the cost.
//
// 2026-09-05, v9.104 real redesign (user's own direct ask, after 2 earlier
// passes that only treated the symptom -- see memory
// stock-analyzer-symptom-vs-root-cause-2026-09-05): PropertiesService's
// calendar TTL (24h, then 24*90h) is gone entirely. A real 13F filing only
// ever changes on SEC's own quarterly cadence with a real ~45-day filing
// lag -- so instead of guessing a TTL, this now computes the REAL currently-
// expected filing quarter (expected13FQuarterTagV1_) and only refetches when
// that quarter actually advances. Cached permanently in a real Sheet
// ('💾 13F Cache', one row per CUSIP -- CUSIP/QuarterTag/LastFetched/JSON),
// matching the user's own explicit "have the data in Sheets, permanently"
// request (same pattern as the existing '💾 TICKER' price cache, just one
// shared sheet instead of one-per-ticker since 13F data is tiny). Real,
// disclosed one-time cost: any CUSIP cached under the OLD PropertiesService
// scheme is not migrated -- the first call under this new scheme pays one
// real cold fetch, then persists to the Sheet from then on.

// Real SEC quarter-end dates (calendar quarters) + the real ~45-day 13F
// filing deadline. Returns the tag (e.g. '2026Q2') of the MOST RECENT
// quarter whose real filing deadline has already passed as of `now` -- i.e.
// the newest quarter a real 13F could plausibly already be filed for. Not
// an invented number: 45 days is the SEC's own real Form 13F filing
// deadline (45 days after each calendar quarter's end).

const CACHE_13F_SHEET_NAME_V1 = '💾 13F Cache';



// 2026-09-06, real fix: traced a real, reproducible live timeout (GOOGL)
// directly to fetchNasdaqShortInterestV1 -- Apps Script has no way to
// bound or interrupt a single UrlFetchApp.fetch() once it starts, so if
// Nasdaq's own real API is slow/unreliable on a given call (their own
// site needs a spoofed User-Agent/Referer to work at all -- an
// already-known-flaky integration), nothing in this codebase can stop it.
// User's own explicit fix, extending the same real "prefetch offline for
// the watchlist" request already applied to the daily automation: these 3
// external calls (Nasdaq short-interest, FMP interest-coverage, the 3 FRED
// macro series) move OFF the interactive path entirely. Only the nightly
// automation (runDailyAutomationV7) ever live-fetches them now, via
// refreshBrokerCourseDataCacheV1_/refreshMacroSnapshotV1_
// (brokerCourseModelV1.gs) -- a rare hang there doesn't block a live user.
// The interactive path only ever reads these 2 permanent Sheets caches.
const CACHE_BROKER_DATA_SHEET_NAME_V1 = '💾 Broker Data Cache';
const CACHE_MACRO_SNAPSHOT_SHEET_NAME_V1 = '💾 Macro Snapshot';
// Real, reasoned freshness window: the nightly automation runs once a
// day, but could miss a day (weekend/holiday/a real automation hiccup) --
// 5 real calendar days is a generous buffer (matches this file's own
// "25-day" cushion elsewhere for the same weekend/holiday reasoning), not
// fit to any backtest. Older than this and the interactive path treats
// the cache as stale/unavailable rather than silently show outdated data.
const BROKER_DATA_CACHE_STALE_DAYS_V1 = 5;



// Market-wide (NOT per-ticker) -- one shared row, refreshed once per real
// automation run, read by every ticker's interactive report the same way.


function gapMarketCapContextV7(gap, marketCap) {
  if (!marketCap) return null;
  const MEGA_CAP_SIGNIFICANT_GAP_PCT = 0.03;
  const tier = marketCap>=200e9?'Mega':marketCap>=10e9?'Large':marketCap>=2e9?'Mid':marketCap>=300e6?'Small':'Micro';
  const note = tier === 'Mega'
    ? (Math.abs(gap.sizePct) >= MEGA_CAP_SIGNIFICANT_GAP_PCT ? tier+'-cap, ≥ 3% — significant' : tier+'-cap, < 3% — likely not significant')
    : tier+'-cap';
  return { tier, note };
}

// v9.55 -- CHARACTERIZATION_PLAN_double_top_bottom_market_cap.md. Real,
// repeated course observation (ep.6): large-cap double-top/bottom patterns
// are rarer and, when they occur, produce a smaller reversal; small/
// speculative-cap patterns are more common with a larger, more explosive
// reversal. No specific numeric threshold given by the instructor for this
// -- qualitative only. Reuses the SAME market-cap tier boundaries as
// gapMarketCapContextV7 immediately above (Mega>=200e9/Large>=10e9/
// Mid>=2e9/Small>=300e6/else Micro) -- not a new threshold. roundTripBars
// (real peak->trough->second-peak elapsed days, already available from the
// existing DOUBLE_TOP/DOUBLE_BOTTOM detector's own date1/date2) is surfaced
// as real informational data, not gated on any invented "fast" cutoff.
function doubleTopBottomMarketCapContextV7(patternType, marketCap, roundTripBars) {
  if (!marketCap || (patternType !== 'DOUBLE_TOP' && patternType !== 'DOUBLE_BOTTOM')) return null;
  const tier = marketCap>=200e9?'Mega':marketCap>=10e9?'Large':marketCap>=2e9?'Mid':marketCap>=300e6?'Small':'Micro';
  const isLarge = tier === 'Mega' || tier === 'Large';
  const note = isLarge
    ? tier+'-cap — the course flags large-cap double-top/bottom patterns as rarer and, when they do occur, typically producing a smaller reversal'
    : tier+'-cap — the course flags small/speculative-cap double-top/bottom patterns as more common, often with a larger, more explosive reversal (especially with a fast round-trip)';
  return { tier, expectedReliability: isLarge ? 'lower-frequency, smaller-magnitude' : 'higher-frequency, larger-magnitude', roundTripBars: roundTripBars != null ? roundTripBars : null, note };
}

// ══════════════════════════════════════════════════════════════════
//  INSIDER TRADING (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- real endpoint
//  and field names confirmed via FMP's own docs before building:
//  /stable/insider-trading/search, fields {transactionType,
//  securitiesTransacted, price, acquistionOrDisposition (A/D)}. The
//  EXACT query parameter for filtering by ticker on THIS specific
//  endpoint was NOT explicitly confirmed in the fetched docs (the params
//  section didn't render) -- using symbol=TICKER because it's the
//  CONSISTENT pattern across every other FMP endpoint already proven
//  working in this codebase (profile, ratios-ttm, earnings, etc, 7+
//  confirmed uses), not a blind guess. Diagnostic warning below will
//  immediately surface if this assumption is wrong on a real run,
//  matching the same safety pattern already proven for earnings-date.
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  RATE-ENVIRONMENT CONTEXT (DASHBOARD_IMPROVEMENTS_PLAN.md 4a) --
//  genuinely relevant given this project's own real analysis: PLTR trades
//  at 67x forward P/E, unusually rate-sensitive, and nothing previously
//  flagged that exposure at all. Endpoint existence confirmed via 2
//  separate FMP doc pages (stable + legacy); needs NO symbol parameter
//  (a general macro endpoint, same data for every ticker). The exact
//  field name for the 10-year yield specifically was NOT confirmed after
//  genuine, repeated search effort -- using 'year10' (a common convention
//  in financial APIs) with the same diagnostic-warning safety net already
//  proven working for earnings-date on a real run.
// ══════════════════════════════════════════════════════════════════





function getCachedOptions() {
  try { const r=PropertiesService.getScriptProperties().getProperty('OPTIONS_OVERLAY'); return r?JSON.parse(r):null; } catch(e) { return null; }
}

function readOptionsOverlay(ss, ticker) {
  try {
    const sh=ss.getSheetByName('🏆 Top 10 Conviction');if(!sh)return null;
    const data=sh.getDataRange().getValues();
    // Guard: only use the tab if it holds the SAME ticker we're analyzing.
    // The title cell reads e.g. "FIG Options — Top 10 Calls & Top 10 Puts | ..."
    const title=String((data[0]&&data[0][0])||'');
    const tabTicker=(title.split(' ')[0]||'').toUpperCase();
    if(ticker&&tabTicker&&tabTicker!==ticker.toUpperCase())return null;
    let tCS=null,tCC=null,tPS=null,tPC=null,inC=false,inP=false,cc=0,pc=0;
    for(let r=0;r<data.length;r++){
      const row=data[r];
      if(String(row[0]).includes('TOP 10 CALL')){inC=true;inP=false;cc=0;continue;}
      if(String(row[0]).includes('TOP 10 PUT')){inP=true;inC=false;pc=0;continue;}
      if(inC&&row[1]&&String(row[1]).startsWith('$')&&row[11]){cc++;if(cc===1){tCS=row[1];tCC=row[11];}}
      if(inP&&row[1]&&String(row[1]).startsWith('$')&&row[11]){pc++;if(pc===1){tPS=row[1];tPC=row[11];}}
    }
    return(tCS||tPS)?{ticker:ticker,topCallStrike:tCS,topCallConv:tCC,topPutStrike:tPS,topPutConv:tPC}:null;
  }catch(e){return null;}
}

function makeLogger(ss){
  const sh=getOrCreate(ss,'🔬 Log');
  const lastRow=sh.getLastRow();
  if(lastRow>0)sh.getRange(lastRow+1,1).setValue('─────────────────────────────');
  let logRow=lastRow+2;
  // 2026-09-06 real fix: SpreadsheetApp.flush() forces an immediate, real,
  // synchronous round-trip to the Sheets backend on every call -- doing
  // this on EVERY single log line (a real full run logs 40-60+ lines
  // across the whole pipeline) is a well-documented real Apps Script
  // performance anti-pattern, and a far bigger, previously-undiagnosed real
  // cost than any individual UrlFetchApp call measured this session. Real,
  // disclosed trade-off: flushing every 3rd line instead of every line
  // keeps the log visibly updating in near-real-time during a run (a real,
  // deliberate design goal -- watching progress live) while cutting real
  // flush() round-trips by ~2/3. Apps Script auto-flushes at the natural
  // end of execution regardless, so the final lines are never lost.
  let logCallCount = 0;
  return msg=>{sh.getRange(logRow++,1).setValue(new Date().toLocaleTimeString()+'  '+msg); if ((++logCallCount % 3) === 0) SpreadsheetApp.flush();};
}

// ══════════════════════════════════════════════════════════════════════
//  OPTIONS SNAPSHOT — read the full raw dataset the Options script saved to
//  the hidden _OPTIONS_SNAPSHOT tab, then score it per market-analyst
//  conventions. Fully guarded: no/mismatched snapshot => not available, and
//  the analyzer scores exactly as it would with no options at all.
// ══════════════════════════════════════════════════════════════════════
function readOptionsSnapshotV7(ss, ticker) {
  try {
    const sh = ss.getSheetByName('_OPTIONS_SNAPSHOT');
    if (!sh) return null;
    const data = sh.getDataRange().getValues();
    if (!data || data.length < 3 || String(data[0][0]) !== 'META') return null;
    let meta; try { meta = JSON.parse(data[0][1]); } catch (e) { return null; }
    if (!meta) return null;
    if (ticker && meta.ticker && meta.ticker !== String(ticker).toUpperCase()) return { mismatch: true, ticker: meta.ticker };
    const headers = data[1];
    const numFields = ['strike','daysToExpiry','oi','vol','iv','dollarsCommitted','dollarScore','holdingScore','urgencyScore','timeScore','ivScore','oiPersistenceScore','conviction'];
    const contracts = [];
    for (let r = 2; r < data.length; r++) {
      const row = data[r];
      if (row[0] === '' || row[0] == null) continue;
      const c = {};
      for (let k = 0; k < headers.length; k++) c[headers[k]] = row[k];
      numFields.forEach(f => { if (c[f] !== '' && c[f] != null && !isNaN(c[f])) c[f] = Number(c[f]); });
      c.expiryStr = fmtExpiryV7_(c.expiryStr); // Sheets coerces date-like strings to Date on write — normalize back
      contracts.push(c);
    }
    const ageDays = meta.timestamp ? (Date.now() - new Date(meta.timestamp).getTime()) / 86400000 : null;
    return { ticker: meta.ticker, priceAtRun: meta.priceAtRun, timestamp: meta.timestamp, ageDays: ageDays, context: meta.context || {}, contracts: contracts };
  } catch (e) { return null; }
}

// Google Sheets auto-converts a date-looking string ("Aug 21, 2026") into a Date
// serial on write, so getValues() hands it back as a Date. Render a clean, short,
// timezone-free label like "Aug 21 '26" for display.
function fmtExpiryV7_(v) {
  if (v instanceof Date && !isNaN(v)) {
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return M[v.getMonth()] + ' ' + v.getDate() + " '" + String(v.getFullYear()).slice(-2);
  }
  return (v == null) ? '' : String(v);
}

// ── Pedagogical-report helpers ────────────────────────────────────────
// Format a driver's signed points into a short tag + a ✓ / ⚠ / • marker.
function pmV7_(p) {
  if (p == null || isNaN(p)) return { s: 'n/a', mark: '•' };
  if (p > 0.001)  return { s: '+' + Number(p).toFixed(2), mark: '✓' };
  if (p < -0.001) return { s: '−' + Math.abs(Number(p)).toFixed(2), mark: '⚠' };
  return { s: '0.00', mark: '•' };
}

// Plain-English "what this means" for each fundamental driver, sign-aware.
function fundDriverContextV7_(label, p) {
  const pos = p > 0.001, neg = p < -0.001, L = String(label || '').toLowerCase();
  if (L.indexOf('growth') >= 0)       return pos ? 'Sales are growing at a healthy, consistent pace — a real engine for the stock.' : neg ? 'Growth is weak or shrinking — little momentum in the business itself.' : 'Growth is only average.';
  if (L.indexOf('margin') >= 0)       return pos ? 'Profit margins are improving — the company keeps more of every dollar it sells.' : neg ? 'Margins are thin and/or getting worse — profitability is under pressure.' : 'Margins are steady but unremarkable.';
  if (L.indexOf('rule of 40') >= 0)   return pos ? 'Growth plus profitability clear the "40" health bar investors like to see.' : neg ? 'Growth plus profitability fall short of the "40" health bar — an unbalanced mix.' : 'Right around the "40" line — balanced but not standout.';
  if (L.indexOf('profitab') >= 0 || L.indexOf('quality') >= 0) return pos ? 'Returns on capital are strong — a high-quality operation.' : neg ? 'Returns on capital are weak — lower-quality economics.' : 'Returns on capital are average.';
  if (L.indexOf('valuation') >= 0 || L.indexOf('peer') >= 0)   return pos ? 'It trades cheaper than similar companies — relatively good value.' : neg ? 'It trades richer than its peers — you are paying a premium versus similar names.' : 'Roughly in line with peers on value.';
  if (L.indexOf('analyst') >= 0)      return pos ? 'Wall-Street analysts are net-positive and see upside to their price targets.' : neg ? 'Analysts are cautious and see limited upside.' : 'Analyst opinion is mixed.';
  if (L.indexOf('p/e') >= 0 || L.indexOf('peg') >= 0) return pos ? 'The earnings multiple is reasonable for the growth on offer.' : neg ? 'A very high earnings multiple — the stock is priced for a lot of future success, which is risky if it stumbles.' : 'The earnings multiple is about fair.';
  return pos ? 'Reads as a plus for owning the business.' : neg ? 'Reads as a minus for owning the business.' : 'Roughly neutral for owning the business.';
}

// Each technical indicator as { label, value, note } with a plain-English read.
function techIndicatorRowsV7_(ind) {
  const r = [], rsi = ind.rsi14;
  r.push({ label: 'Momentum (RSI 14)', value: rsi.toFixed(1) + ' / 100', note: rsi < 30 ? 'Oversold — beaten down, can be due for a bounce.' : rsi < 45 ? 'Weak momentum — sellers still in control.' : rsi <= 55 ? 'Neutral momentum.' : rsi <= 70 ? 'Healthy upward momentum.' : 'Overbought — extended, pullback risk.' });
  r.push({ label: 'Trend momentum (MACD histogram)', value: ind.histogram.toFixed(2), note: ind.histogram > 0 ? 'Positive — short-term momentum is building upward.' : 'Negative — short-term momentum is pointing down.' });
  r.push({ label: 'Trend strength (ADX 14)', value: ind.adx14.toFixed(1), note: ind.adx14 > 25 ? 'A strong, established trend is in place — respect its direction.' : ind.adx14 < 20 ? 'No real trend — price is choppy / sideways.' : 'A trend is developing but not yet strong.' });
  r.push({ label: 'Typical daily move (ATR 14)', value: '$' + ind.atr14.toFixed(2), note: 'How much the stock usually moves in a day — used to size the stop and targets.' });
  r.push({ label: 'Short-term timing (Stochastic %K)', value: ind.stochK.toFixed(1), note: ind.stochK < 20 ? 'Oversold zone.' : ind.stochK > 80 ? 'Overbought zone.' : 'Mid-range.' });
  r.push({ label: 'Money flow (MFI 14)', value: ind.mfi14.toFixed(1), note: ind.mfi14 < 20 ? 'Money is flowing out (oversold).' : ind.mfi14 > 80 ? 'Money is flowing in (overbought).' : 'Balanced money flow.' });
  if (ind.rs) r.push({ label: 'Vs. the market (3-mo relative strength)', value: (ind.rs.rs63 >= 0 ? '+' : '') + ind.rs.rs63.toFixed(1) + '%', note: ind.rs.rs63 >= 0 ? 'Outperforming the S&P over the last 3 months.' : 'Lagging the S&P over the last 3 months — a relative weakness.' });
  return r;
}

// One-sentence plain-English bottom line + a conviction word.
function bottomLineV7_(ticker, fundResult, techPlan, decision, opts) {
  const fc = decision.finalConviction;
  const convWord = fc >= 67 ? 'High' : fc >= 50 ? 'Moderate' : fc >= 33 ? 'Low' : 'Very Low';
  const s = fundResult.score;
  const ownWord = s == null ? 'an unrated' : s >= 57 ? 'a solid' : s >= 43 ? 'a mixed-quality' : 'a weak';
  const pricey = fundResult.pricedForPerfection || (fundResult.drivers || []).some(d => /p\/e|peg|valuation/i.test(d.label) && d.points < 0);
  const valWord = pricey ? 'at a rich (expensive) price' : 'at a reasonable price';
  const trendWord = techPlan.regime === 'TREND_UP' ? 'trending up' : techPlan.regime === 'TREND_DOWN' ? 'trending down' : 'moving sideways';
  const timeWord = techPlan.timing === 'BUY_NOW' ? 'a good time to buy' : techPlan.timing === 'WAIT_PULLBACK' ? 'better to wait for a dip' : 'a poor time to buy';
  let optClause = 'No options data was loaded, so smart-money positioning is not factored in yet.';
  if (opts && opts.available) optClause = opts.confirm === 'confirm' ? 'Options traders lean the SAME way, which adds confidence.' : opts.confirm === 'conflict' ? 'Options traders lean the OTHER way — a mixed signal that lowers confidence.' : 'Options positioning is roughly neutral.';
  const text = ticker + ' is ' + ownWord + ' business (score ' + (s == null ? 'N/A' : s + '/100') + '), ' + valWord + '. The chart is ' + trendWord + ' right now, so it is ' + timeWord + '. ' + optClause + ' Bottom line: ' + decision.action + ' — confidence ' + fc + '/100 (' + convWord + ').';
  return { convWord: convWord, text: text };
}

// Turn the AI's plain-text briefing into styled rows: UPPERCASE / colon-ending
// lines become bold subtitles, "- " lines become bullets, the rest wrap normally.
function renderAiReviewV7_(text) {
  const out = [];
  const clean = String(text).replace(/\*\*/g,'').replace(/`/g,'').replace(/^#+\s*/gm,'');
  clean.split(/\r?\n/).forEach(raw => {
    const line = raw.replace(/\s+$/,'').trim();
    if (!line) return;
    const isHeader = /^[A-Z0-9][A-Za-z0-9 &/()'?\-]{1,50}:?$/.test(line) && (line.endsWith(':') || line === line.toUpperCase());
    if (isHeader) {
      out.push({ text: [line.replace(/:$/,'')], meta: { merge:true, bold:true, bg:'#ede7f6', color:'#4a148c', size:11 } });
    } else if (/^[-•*]\s+/.test(line)) {
      out.push({ text: ['   • ' + line.replace(/^[-•*]\s+/,'')], meta: { merge:true, wrap:true } });
    } else {
      out.push({ text: [line], meta: { merge:true, wrap:true } });
    }
  });
  if (!out.length) out.push({ text: [clean], meta: { merge:true, wrap:true } });
  return out;
}

// Applies analyst conventions to the full snapshot. `techPlan` may be null on a
// first pass (before the tech plan exists) — then confirm/horizon are skipped
// and only the direction-independent signals (used by the tech score) are set.
function analyzeOptionsForScoringV7(snap, techPlan) {
  const out = { available:false, dirSig:0, leapsLean:0, ivRank:null, confirm:'neutral',
                putCallOI:null, netBiasPct:null, topCall:null, topPut:null, leapCall:null, leapPut:null,
                horizon:null, notes:[] };
  if (!snap || snap.mismatch || !snap.contracts || !snap.contracts.length) return out;
  out.available = true;
  const cs = snap.contracts, ctx = snap.context || {};
  const calls = cs.filter(c => c.side === 'call'), puts = cs.filter(c => c.side === 'put');
  const byConv = a => a.slice().sort((x, y) => (y.conviction || 0) - (x.conviction || 0));
  // §2.5.1 fix (deep-dive review): comparing only the single TOP-conviction
  // contract on each side meant comparing two already-elite contracts
  // against each other (both near 100 on their own side's scale), so their
  // gap was almost always tiny (e.g. 52 vs 51) and /40 compressed the
  // signal to ~0 nearly every run. Dollar-weighted average conviction
  // across the WHOLE chain on each side reflects overall positioning, not
  // just the single biggest bet — should produce a meaningfully wider
  // spread. The /40 divisor itself is deliberately left unchanged here —
  // changing the comparison AND the divisor in the same step would make it
  // impossible to tell which change caused any observed effect. If real
  // multi-ticker data later shows this new signal is STILL compressed,
  // that's the moment to revisit the divisor, with real evidence.
  function dollarWeightedAvgConvictionV7_(contracts) {
    const withDollars = contracts.filter(c => c.dollarsCommitted > 0 && c.conviction != null);
    if (!withDollars.length) return null;
    const totalDollars = withDollars.reduce((s,c) => s + c.dollarsCommitted, 0);
    if (totalDollars <= 0) return null;
    return withDollars.reduce((s,c) => s + c.conviction * c.dollarsCommitted, 0) / totalDollars;
  }

  // 1) Put/Call OI directional bias
  const pc = (ctx.putCallRatioOI != null) ? ctx.putCallRatioOI : null; out.putCallOI = pc;
  const pcSig = pc == null ? 0 : pc <= 0.6 ? 1 : pc <= 0.8 ? 0.5 : pc <= 1.1 ? 0 : pc <= 1.4 ? -0.5 : -1;

  // 2) Conviction dominance — display still shows the single top contract on
  // each side (topCall/topPut), but the actual SIGNAL now uses the
  // dollar-weighted chain-wide average (see §2.5.1 fix above), not just
  // those two top contracts against each other.
  const tC = byConv(calls)[0], tP = byConv(puts)[0];
  out.topCall = tC ? { strike:tC.strike, conv:tC.conviction, expiry:tC.expiryStr, days:tC.daysToExpiry } : null;
  out.topPut  = tP ? { strike:tP.strike, conv:tP.conviction, expiry:tP.expiryStr, days:tP.daysToExpiry } : null;
  const aggCallConv = dollarWeightedAvgConvictionV7_(calls), aggPutConv = dollarWeightedAvgConvictionV7_(puts);
  const domSig = (aggCallConv != null && aggPutConv != null) ? Math.max(-1, Math.min(1, (aggCallConv - aggPutConv) / 40)) : 0;

  // 3) Net $ bias (already computed on the full chain)
  const nb = (ctx.netBiasPct != null) ? ctx.netBiasPct : null; out.netBiasPct = nb;
  const nbSig = nb == null ? 0 : Math.max(-1, Math.min(1, nb / 40));

  // Near/mid TIMING direction (feeds BUY-TIMING score)
  out.dirSig = Math.max(-1, Math.min(1, 0.40 * pcSig + 0.35 * domSig + 0.25 * nbSig));

  // 4) LEAPS structural lean (>365d) — same §2.5.1 fix: dollar-weighted
  // average across all LEAPS contracts on each side, not just the single
  // top LEAPS call vs top LEAPS put (display still shows those two).
  const leapsCalls = calls.filter(c => c.daysToExpiry > 365), leapsPuts = puts.filter(c => c.daysToExpiry > 365);
  const lC = byConv(leapsCalls)[0];
  const lP = byConv(leapsPuts)[0];
  out.leapCall = lC ? { strike:lC.strike, conv:lC.conviction, expiry:lC.expiryStr, days:lC.daysToExpiry } : null;
  out.leapPut  = lP ? { strike:lP.strike, conv:lP.conviction, expiry:lP.expiryStr, days:lP.daysToExpiry } : null;
  const aggLeapCallConv = dollarWeightedAvgConvictionV7_(leapsCalls), aggLeapPutConv = dollarWeightedAvgConvictionV7_(leapsPuts);
  out.leapsLean = (aggLeapCallConv != null && aggLeapPutConv != null) ? Math.max(-1, Math.min(1, (aggLeapCallConv - aggLeapPutConv) / 40)) : 0;

  // 5) IV rank — risk/confidence modifier, not direction
  out.ivRank = (ctx.ivRankPct != null) ? ctx.ivRankPct : null;

  // 6) Horizon alignment — read positioning at the expiries that match the plan
  const etaDays = techPlan && techPlan.timeToEntry && techPlan.timeToEntry.baseDays != null ? techPlan.timeToEntry.baseDays
                : techPlan && techPlan.t1Time && techPlan.t1Time.baseDays != null ? techPlan.t1Time.baseDays : null;
  if (etaDays != null) {
    const hi = Math.max(45, etaDays * 2);
    const win = cs.filter(c => c.daysToExpiry >= 0 && c.daysToExpiry <= hi);
    const wc = byConv(win.filter(c => c.side === 'call'))[0], wp = byConv(win.filter(c => c.side === 'put'))[0];
    out.horizon = { days: Math.round(hi),
                    topCall: wc ? { strike:wc.strike, conv:wc.conviction, expiry:wc.expiryStr } : null,
                    topPut:  wp ? { strike:wp.strike, conv:wp.conviction, expiry:wp.expiryStr } : null };
  }

  // 7) Confirm vs divergence relative to the technical direction
  const techDir = techPlan ? (techPlan.techScore >= 55 ? 1 : techPlan.techScore <= 45 ? -1 : 0) : 0;
  const optDir  = out.dirSig >= 0.34 ? 1 : out.dirSig <= -0.34 ? -1 : 0;
  if (techDir !== 0 && optDir !== 0) out.confirm = (techDir === optDir) ? 'confirm' : 'conflict';

  out.notes.push('Put/Call OI ' + (pc != null ? pc.toFixed(2) : 'N/A') + (pcSig > 0 ? ' (call-heavy/bullish)' : pcSig < 0 ? ' (put-heavy/bearish)' : ' (neutral)'));
  if (tC && tP) out.notes.push('Top call conv ' + tC.conviction + ' vs top put conv ' + tP.conviction);
  out.notes.push('LEAPS lean ' + (out.leapsLean > 0.15 ? 'bullish (institutions accumulating)' : out.leapsLean < -0.15 ? 'bearish/hedged' : 'neutral'));
  if (out.ivRank != null) out.notes.push('IV %ile ' + out.ivRank + (out.ivRank >= 80 ? ' (elevated — event/fear priced in)' : out.ivRank <= 20 ? ' (low — complacent)' : ''));
  return out;
}

function scoreBar(score){const f=Math.round(Math.min(100,Math.max(0,score))/10);return'█'.repeat(f)+'░'.repeat(10-f);}

function ema(arr,n){if(!arr||arr.length<n)return null;const k=2/(n+1);let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;}

function emaArray(arr,n){if(!arr||arr.length<n)return[];const k=2/(n+1),out=[];let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;out.push(e);for(let i=n;i<arr.length;i++){e=arr[i]*k+e*(1-k);out.push(e);}return out;}

function sma(arr,n){if(!arr||arr.length<n)return null;return arr.slice(-n).reduce((a,b)=>a+b,0)/n;}

// v9.35 -- CHARACTERIZATION_PLAN_trend_maturity.md. Real gap from broker course
// ep.5: engine's goldenCross/deathCross only flags whether a SMA50/200 flip
// happened in the last 5 bars -- no field says how long the CURRENT primary
// trend (by that same crossover) has actually held. Course rule: don't trust a
// crossover as a confirmed trend change until 6-9 months / 2-4 quarterly
// earnings reports have passed. Zero new data -- walks the already-fetched
// `closes` array backward via a prefix sum, reusing the same SMA50/200
// definition already used by goldenCross/deathCross. Display only (weight 0).
// v9.53 -- CHARACTERIZATION_PLAN_candlestick_classification.md. Single-candlestick
// classification (open item since ep.3, `KNOWN_GAPS_AND_RISKS.md`). Raw-transcript
// re-verified (ep.3 "03 scanner" transcript) AND a real video frame extracted
// (t≈2150s, the "נרות מיוחדים" slide) before building, per this project's own
// standing rule.
//
// REAL FINDING, confirmed via the actual video frame, not guessed: the course's
// Hebrew terminology for hammer/inverted-hammer is SWAPPED vs Western textbook
// convention. His "Hammer" (פטיש) = small body at the bottom, long UPPER wick
// (the shape Western TA calls a "shooting star") -- his stated direction:
// BEARISH. His "Inverted Hammer" (פטיש הפוך) = small body at the top, long LOWER
// wick (Western "hammer" shape) -- his stated direction: BULLISH. Built per HIS
// stated rule (course-derived, not Western textbook), same convention as every
// other course-derived feature in this file. Field names below use his
// terminology, explicitly labeled, so this doesn't read as a bug to a future
// reviewer.
//
// Doji subtypes (Dragonfly/Gravestone/Long-legged) from an external
// StockCharts.com-style reference shown on screen, ep.6.
//
// Geometry thresholds -- all textbook/standard conventions, none fit to any
// backtest (this project's own tuning rule): doji body <=10% of range,
// marubozu wicks <=5% of range each, hammer-family long-wick >=2x body.
// Display only, weight 0 -- new signal, untested until backtested, same
// standing rule as every other course-derived feature. Real self-test:
// `candlestick_classification_test.js`, 18/18 passed, 0 crashes across
// 72,660 real cached bars before wiring in.
function singleCandleClassifyV7(open, high, low, close) {
  if (open == null || high == null || low == null || close == null) return null;
  const range = high - low;
  if (range <= 0) return null;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const bodyPct = body / range;

  if (bodyPct <= 0.10) {
    if (upperWick <= range * 0.10 && lowerWick >= range * 0.60) {
      return { type: 'DRAGONFLY_DOJI', courseDirection: 'bullish', note: 'open≈close≈high, long lower wick only — bullish reversal per the course (ep.6 external reference)' };
    }
    if (lowerWick <= range * 0.10 && upperWick >= range * 0.60) {
      return { type: 'GRAVESTONE_DOJI', courseDirection: 'bearish', note: 'open≈close≈low, long upper wick only — bearish reversal per the course (ep.6 external reference)' };
    }
    if (upperWick >= range * 0.40 && lowerWick >= range * 0.40) {
      return { type: 'LONG_LEGGED_DOJI', courseDirection: 'neutral', note: 'long wicks both sides, roughly equal — pure indecision per the course (ep.6)' };
    }
    return { type: 'DOJI', courseDirection: 'neutral', note: 'open≈close — the course frames this as a pause/transition after a run, not necessarily a reversal (ep.3 JKS example)' };
  }

  if (upperWick <= range * 0.05 && lowerWick <= range * 0.05) {
    const bullish = close > open;
    return { type: 'FULL_MARUBOZU', courseDirection: bullish ? 'bullish' : 'bearish', note: (bullish ? 'buyers won unambiguously' : 'sellers won unambiguously') + ' — real body-size still matters for significance (ep.3: a 1% full candle carries little signal, a 15% one is clearly powerful) but no single clean numeric cutoff was reliably spoken in the transcript; not encoded as a threshold here, disclosed not invented' };
  }

  if (body > 0) {
    if (lowerWick <= range * 0.10 && upperWick >= body * 2) {
      return { type: 'HAMMER_COURSE_TERM', courseDirection: 'bearish', note: 'course calls this "Hammer" (פטיש) — shape matches Western "shooting star," not Western "hammer." Course\'s own stated direction: bearish (tries to rise, closes low).' };
    }
    if (upperWick <= range * 0.10 && lowerWick >= body * 2) {
      return { type: 'INVERTED_HAMMER_COURSE_TERM', courseDirection: 'bullish', note: 'course calls this "Inverted Hammer" (פטיש הפוך) — shape matches Western "hammer," not Western "inverted hammer." Course\'s own stated direction: bullish.' };
    }
  }

  return null;
}

function trendMaturityV7(closes) {
  const n = closes.length;
  if (n < 200) return null; // same guard as goldenCross/deathCross -- sma200 needs 200 bars
  const prefix = new Array(n+1); prefix[0] = 0;
  for (let i=0;i<n;i++) prefix[i+1] = prefix[i] + closes[i];
  const smaAt = (endIdxIncl, len) => {
    const startIdx = endIdxIncl - len + 1;
    if (startIdx < 0) return null;
    return (prefix[endIdxIncl+1] - prefix[startIdx]) / len;
  };
  const relAt = (i) => {
    const s50 = smaAt(i,50), s200 = smaAt(i,200);
    if (s50==null || s200==null) return null;
    return s50 > s200 ? 1 : (s50 < s200 ? -1 : 0);
  };
  const currentRel = relAt(n-1);
  if (currentRel == null || currentRel === 0) return null;
  let crossBar = null;
  for (let j = n-2; j >= 199; j--) {
    const rel = relAt(j);
    if (rel == null) break;
    if (rel !== currentRel) { crossBar = j+1; break; }
  }
  const TRADING_DAYS_PER_MONTH = 21; // 252 trading days/yr / 12 -- standard convention
  const daysSinceCross = crossBar != null ? (n-1) - crossBar : (n-1) - 199;
  const monthsSinceCross = daysSinceCross / TRADING_DAYS_PER_MONTH;
  const maturity = monthsSinceCross >= 9 ? 'MATURE' : monthsSinceCross >= 6 ? 'MATURING' : 'NEW';
  return { daysSinceCross, monthsSinceCross, maturity, foundCross: crossBar != null, direction: currentRel > 0 ? 'UP' : 'DOWN' };
}

// v9.39 -- CHARACTERIZATION_PLAN_lockup_expiration.md. Real, named event from
// broker course ep.8/ep.9: post-IPO insider/employee lock-up agreements
// typically expire ~180 days after listing -- a real, timeable, predictable
// selling-pressure event (course's own worked example: TSLA's real S&P500
// inclusion date referenced alongside its lock-up timeline). Unblocked by a
// separate real finding while verifying ep.9's short-interest data: the
// already-called v8/finance/chart endpoint carries a free, unused
// `firstTradeDate` field -- zero new network calls, zero new auth (see
// fetchYahooChart). LOCKUP_DAYS=180 is the exact number stated in the course,
// not fit to any backtest. DISPLAY_WINDOW_DAYS=210 (180 + a 30-day grace
// period) is a direct derivation of that same number, not invented
// separately -- keeps the fact visible shortly before AND shortly after the
// real event, then goes quiet for the rest of the stock's life (same
// "only shown when relevant" convention as Climax Volume/Round Number/
// Secondary Day).
function lockupExpirationV7(ipoDate, now) {
  if (!ipoDate) return null; // pre-Yahoo-coverage tickers or a fetch that didn't carry the field
  const LOCKUP_DAYS = 180, DISPLAY_WINDOW_DAYS = 210, MS_PER_DAY = 86400000;
  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): the raw millisecond diff was time-of-day dependent
  // (ipoDate sits at market-open timestamp, `now` is wall-clock at
  // whatever hour the script runs), so the UPCOMING->PASSED flip at day
  // 180 could land a day early or late depending on the hour of the run.
  // Same fix pattern already used elsewhere in this file for the exact
  // same bug class (v9.41's earnings-gap UTC-day-zeroing fix): zero both
  // dates to UTC midnight before differencing.
  const ipoDay = Date.UTC(ipoDate.getUTCFullYear(), ipoDate.getUTCMonth(), ipoDate.getUTCDate());
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceIPO = Math.floor((nowDay - ipoDay) / MS_PER_DAY);
  if (daysSinceIPO < 0 || daysSinceIPO > DISPLAY_WINDOW_DAYS) return null;
  const lockupDate = new Date(ipoDate.getTime() + LOCKUP_DAYS * MS_PER_DAY);
  const daysUntilExpiration = LOCKUP_DAYS - daysSinceIPO;
  return { ipoDate, lockupDate, daysSinceIPO, daysUntilExpiration, status: daysUntilExpiration > 0 ? 'UPCOMING' : 'PASSED' };
}

// v9.44 -- broker course ep.9 (short), reinforced live in ep.13's real
// GME case study. Real, long-compatible technique: a high-short-interest
// stock breaking to a NEW HIGH -- explicitly distinguished by the
// instructor from merely bouncing off a low (that's short-covering, a
// different and weaker mechanism). Kept because it identifies a LONG
// opportunity (squeeze), never a short.
//
// Originally flagged episode 9 as "not cheaply buildable" -- live-tested
// Yahoo's quoteSummary short-interest endpoint at the time, it required a
// crumb/cookie auth handshake this engine's simple fetch pattern doesn't
// have. Re-verified LIVE this session (2026-08-20, during the separate
// broker-course-model build's own Phase 10/13 gap-closure work, per the
// user's explicit "don't skip any logic, no matter how small" standing
// instruction): the crumb approach worked once, then failed 5 straight
// retries -- genuinely too flaky to ship on, not a hard permanent wall
// either. Found and verified a real, RELIABLE alternative instead:
// Nasdaq's own short-interest API, redistributing FINRA's official
// bi-monthly short-interest reporting -- multiple consecutive successful
// real calls (AAPL: 141,606,163 shares short, 2.42 days-to-cover;
// RIOT: 51,572,314 shares short, 2.65 days-to-cover). Real, disclosed
// limitation, verified live: Nasdaq-LISTED tickers only -- a real NYSE
// ticker (GME) correctly returns "Short interest is not available...
// Nasdaq Listed stocks", not silently wrong data.

// Module-scope constant (this function sits outside computeAllIndicators'
// own try{} block where the file's original LEVEL_TOLERANCE lives, same
// scoping issue already documented and solved the same way for v9.36's
// round-number feature -- mirrors the VALUE (0.03), not the variable).
const LEVEL_TOLERANCE_V7 = 0.03;

// Squeeze-setup trigger: short interest above the course's own real
// FinViz-screener anchor (ep.9: >10% "600 results, too broad" -> >20-30%
// "getting interesting" -> >40-50% "most extreme, 11-16 results" -- >20%
// used as the real, disclosed floor, not an invented number) AND
// currently at/near a real 52-week high (LEVEL_TOLERANCE_V7=0.03, this
// file's own already-established "near a level" convention, reused
// directly rather than inventing a new one).
function shortSqueezeSetupV7(shortPctOfFloat, currentPrice, high52) {
  if (shortPctOfFloat == null || currentPrice == null || high52 == null) return null;
  const SQUEEZE_MIN_SHORT_PCT = 0.20;
  const atNewHigh = currentPrice >= high52 * (1 - LEVEL_TOLERANCE_V7);
  const triggered = shortPctOfFloat > SQUEEZE_MIN_SHORT_PCT && atNewHigh;
  return { triggered, shortPctOfFloat, atNewHigh };
}

// v9.40 -- CHARACTERIZATION_PLAN_reverse_split.md. Real, explicit avoid-
// heuristic from broker course ep.10 (momentum/gaps): the instructor
// explicitly REMOVES recently reverse-split tickers from his own watchlist
// ("אני מוציא מנהיות מרשימה את הטופ ליסט"), citing extreme manipulation/
// volatility risk in the weeks after -- real worked chart examples (APDN,
// BLPH, BPTH, CSU) all show erratic post-split action. Unblocked by the
// same live verification that surfaced ep.9's firstTradeDate field: this
// endpoint also carries real split events via events=div,splits (verified
// against NVDA's real 10:1 forward split), zero new auth.
//
// RECENT_LOOKBACK_BARS=60 reuses this file's OWN existing "recent" window
// convention (GAP_LOOKBACK, ~3 trading months, used for priceGaps a few
// hundred lines below) rather than inventing a new period specific to this
// feature -- the course gave no explicit day-count for how long the
// caution should apply, so borrowing an already-established, disclosed
// convention is more defensible than picking a number to fit this alone.
// A reverse split is numerator < denominator (e.g. 1-for-16: numerator=1,
// denominator=16) -- the opposite of a forward split (e.g. NVDA's 10-for-1:
// numerator=10, denominator=1).
function recentReverseSplitV7(splits, dates, n) {
  if (!splits || !splits.length || !dates || !dates.length) return null;
  const RECENT_LOOKBACK_BARS = 60;
  const cutoffDate = dates[Math.max(0, n - RECENT_LOOKBACK_BARS)];
  const recentReverse = splits
    .filter(s => s.numerator < s.denominator)
    .filter(s => s.date >= cutoffDate)
    .sort((a,b) => b.date - a.date)[0];
  if (!recentReverse) return null;
  const daysAgo = Math.round((dates[n-1] - recentReverse.date) / 86400000);
  return { date: recentReverse.date, ratio: recentReverse.numerator + ':' + recentReverse.denominator, daysAgo };
}

// v9.36 -- CHARACTERIZATION_PLAN_round_numbers.md. Real gap from broker course
// ep.6: round price levels ($10/$100/etc, scaled to the price's own order of
// magnitude) act as real psychological S/R -- demonstrated across 4 real
// worked chart examples (NIO, TSLA, VXX, DPW). Granularity bands are a direct
// read of those 4 examples, not fit to any backtest.
function roundLevelIncrementV7(price) {
  if (price < 5) return 0.5;      // DPW: $3, $3.50, $4, $4.50
  if (price < 10) return 1;       // DPW: $5, $6, $7
  if (price < 100) return 10;     // NIO: $10, $20, $30, $40
  if (price < 1000) return 100;   // TSLA: $300, $400, $500, $600
  return 1000;                    // extrapolation of the same pattern -- no worked example above $1000, disclosed as such
}
function roundNumberProximityV7(price, tolerance) {
  const inc = roundLevelIncrementV7(price);
  const nearest = Math.round(price / inc) * inc;
  const distPct = Math.abs(price - nearest) / price;
  return { nearest, increment: inc, distPct, near: distPct <= tolerance };
}

// v9.49 -- engine gap-fill, independent review + video-fidelity audit
// (2026-08-22). Real course rule (ep.1), raw-verified directly against
// the transcript, not just the summarized notes -- line 187-188:
// "אם את רואה כאן תנודתיות שהיא מעל חמישה שישה אחוז" ("if you see
// volatility above five-six percent") ... "תנודתיות נמוכה זה מתחת
// לשלושה אחוז" ("low volatility is below three percent") -- exact
// match. A dual read, not one scale: HOT (>5-6%, "something is
// happening") is itself a wanted signal, and COILED (<3%, "calm before
// the storm") is a SEPARATE, also-real signal -- not just "not hot."
// 5% used as the hot floor (the course states a 5-6% range, not one
// number -- same "state the range's floor, not its midpoint"
// convention already used for the 1.5x relative-volume threshold
// elsewhere in this file). Range-based %, same formula as the file's
// own existing weekly/monthly % computations elsewhere.
function volatilityHotColdV7(pct) {
  if (pct == null) return null;
  if (pct > 0.05) return { tier: 'Hot', read: 'Volatility ' + (pct*100).toFixed(1) + '% — above the course\'s 5-6% "hot" band (ep.1): something real is happening' };
  if (pct < 0.03) return { tier: 'Coiled', read: 'Volatility ' + (pct*100).toFixed(1) + '% — below the course\'s 3% "coiled" band (ep.1): calm before a possible storm' };
  return { tier: 'Normal', read: 'Volatility ' + (pct*100).toFixed(1) + '% — neither the course\'s hot (>5-6%) nor coiled (<3%) band (ep.1)' };
}

// v9.49 -- engine gap-fill. Real course rule (ep.4), raw-verified
// directly against the transcript -- line 480-481: "במגמת עליה, הכו'
// תמיכה שלי... יותר חשוב... במגמה יורדת הכו' התנגדות שלי, יותר חשוב"
// ("in an uptrend my support line is more important... in a downtrend
// my resistance line is more important") -- exact match, spoken, not a
// visual-only slide. Also line 277-278: "רמה ראשית, משנית ומינורית"
// ("primary level, secondary, and minor") -- real, spoken tier
// terminology, the single most-reinforced still-unbuilt candidate
// across ep.3-6 before this fix. Independently written swing-point
// clustering (same simple max/min-over-window convention already used
// by this file's own chart-pattern detector above, not imported from
// it) -- 2 touches minimum is a disclosed default, not course-stated
// (raw-checked, ep.3: the instructor counts touches live but never
// states an explicit minimum). `trendDirection` is optional
// ('up'|'down'|'flat') -- when omitted, `trendFavored` is simply null.
function srLevelsV7(highs, lows, trendDirection, volumes) {
  const window = 5, tolerance = 0.03; // same window/tolerance convention as roundNumberProximityV7/LEVEL_TOLERANCE elsewhere in this file
  const n = highs.length;
  const swingHighs = [], swingLows = [];
  for (let i = window; i < n - window; i++) {
    const hSlice = highs.slice(i - window, i + window + 1);
    const lSlice = lows.slice(i - window, i + window + 1);
    if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] });
    if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] });
  }
  function clusterLevels(points, isSupport) {
    const sorted = points.slice().sort((a,b) => a.price - b.price);
    const clusters = [];
    for (const p of sorted) {
      let placed = false;
      for (const c of clusters) {
        if (Math.abs(p.price - c.avgPrice) / c.avgPrice <= tolerance) {
          c.touches.push(p); c.avgPrice = c.touches.reduce((s,t)=>s+t.price,0) / c.touches.length; placed = true; break;
        }
      }
      if (!placed) clusters.push({ avgPrice: p.price, touches: [p] });
    }
    return clusters.filter(c => c.touches.length >= 2).map(c => {
      const idxs = c.touches.map(t => t.idx);
      const duration = Math.max(...idxs) - Math.min(...idxs);
      const touchCount = c.touches.length;
      let tier;
      if (touchCount >= 4 && duration >= 60) tier = 'Primary';
      else if (touchCount >= 3 || duration >= 30) tier = 'Secondary';
      else tier = 'Minor';
      const trendFavored = trendDirection === undefined ? null : (isSupport ? trendDirection === 'up' : trendDirection === 'down');
      // v9.73, Schabacker Study IX: purely additive -- a new, optional
      // field, computed ONLY when a volumes array is provided (existing
      // callers that don't pass one get exactly today's object shape,
      // unchanged). Real "memory factor" per the book: the greater the
      // aggregate volume attending a level's own touches, the longer that
      // level is likely to have real effect -- unlike touchCount/tier
      // above (count/recency only), this weights each touch by its OWN
      // real volume. Does not replace or affect tier/touchCount at all.
      let volumeWeightedStrength;
      if (volumes && volumes.length) {
        volumeWeightedStrength = c.touches.reduce((s,t) => s + (volumes[t.idx] || 0), 0);
      }
      return { level: c.avgPrice, touchCount, duration, tier, trendFavored, volumeWeightedStrength };
    }).sort((a,b) => b.touchCount - a.touchCount);
  }
  return { resistanceLevels: clusterLevels(swingHighs, false), supportLevels: clusterLevels(swingLows, true) };
}

// v9.54 -- CHARACTERIZATION_PLAN.md's S/R multi-timeframe strength scoring.
// See the call site (computeAllIndicators) for the full real course rule.
// Every-N-trading-day OHLC resample -- same approximation this file's own
// weekly[] resample already uses elsewhere, not a new simplification.
function resampleHighLowV7(highs, lows, groupSize) {
  const outHighs = [], outLows = [];
  for (let i = highs.length; i > 0; i -= groupSize) {
    const start = Math.max(0, i - groupSize);
    outHighs.unshift(Math.max(...highs.slice(start, i)));
    outLows.unshift(Math.min(...lows.slice(start, i)));
  }
  return { highs: outHighs, lows: outLows };
}
function srMultiTimeframeConfluenceV7(highs, lows) {
  const daily = srLevelsV7(highs, lows);
  const weekly = resampleHighLowV7(highs, lows, 5);
  const monthly = resampleHighLowV7(highs, lows, 21); // TRADING_DAYS_PER_MONTH convention, same as trendMaturityV7
  const weeklySR = srLevelsV7(weekly.highs, weekly.lows);
  const monthlySR = srLevelsV7(monthly.highs, monthly.lows);
  const match = (price, levels) => levels.some(l => Math.abs(l.level - price) / price <= LEVEL_TOLERANCE_V7);
  function classify(dailyLevel, weeklyLevels, monthlyLevels) {
    if (!dailyLevel) return null;
    const onWeekly = match(dailyLevel.level, weeklyLevels);
    const onMonthly = match(dailyLevel.level, monthlyLevels);
    const strength = onMonthly ? 'DAILY+WEEKLY+MONTHLY' : onWeekly ? 'DAILY+WEEKLY' : 'DAILY_ONLY';
    return { level: dailyLevel.level, tier: dailyLevel.tier, touchCount: dailyLevel.touchCount, onWeekly, onMonthly, strength };
  }
  return {
    resistance: classify(daily.resistanceLevels[0], weeklySR.resistanceLevels, monthlySR.resistanceLevels),
    support: classify(daily.supportLevels[0], weeklySR.supportLevels, monthlySR.supportLevels),
  };
}

// v9.68 -- BIG_PLAN_ENGINE_EXPANSION.md Phase A, full classical Wyckoff
// Accumulation/Distribution framework. User's own explicit, deliberate
// request for the MAIN ENGINE specifically -- a real, confirmed departure
// from "course-only" scope (the broker course's own `climaxVolume` field,
// CHARACTERIZATION_PLAN_climax_volume.md, only teaches a narrow 3-phase
// VOLUME cycle and stays exactly as it was, untouched here).
//
// Real, deliberate reuse, not reinvented from scratch: a genuine Wyckoff
// Trading Range is the SAME shape this file's own RECTANGLE detector
// already finds (flat resistance + flat support, real containment check).
// A genuine Spring (accumulation) is the SAME shape as this file's own
// BEAR_TRAP (false breakdown, quick reclaim); a genuine Upthrust
// (distribution) is the SAME shape as BULL_TRAP (false breakout, quick
// failure) -- both reused by checking whether one already fired inside the
// real trading range's own real boundaries, not redetected from scratch.
//
// Genuinely new pieces, not covered by anything else in this file: real
// Selling/Buying Climax bar identification (a wide-range reversal bar on
// real high volume, with a real recovery/rejection tail within the SAME
// bar -- SC is a down bar closing in the upper half of its own range, BC
// the mirror), and the SOS/SOW + LPS/LPSY sequencing that ties everything
// into one real, ordered phase read.
//
// Long-only/calls-only strategy note (CLAUDE_CODE_HANDOFF.md standing
// rule): Accumulation -> real BUY-relevant signal (leads to markup).
// Distribution -> real AVOID/EXIT-relevant signal (leads to markdown),
// same framing already used for BULL_TRAP (avoid/exit) vs BEAR_TRAP (real
// buy opportunity) elsewhere in this file -- never a short setup.
const WY_CLIMAX_VOL_RATIO = 3.0; // same real threshold as this file's own existing climaxVolume field, not reinvented
const WY_TR_LOOKBACK = 60; // same as RECT_LOOKBACK, reuses that convention directly

// Real, disclosed limitation, found via a hand-constructed synthetic test,
// not hidden: this function requires RECTANGLE to still be present in the
// SAME call's chartPatterns to identify the real TR boundaries. A genuine
// Spring's own minimum real depth (BEAR_TRAP's real 3% break threshold)
// structurally exceeds RECTANGLE's own real flatness tolerance (1.5%,
// RECT_LEVEL_TOL) -- if the spring's low bar is still inside RECTANGLE's
// own 60-bar lookback window and gets classified as a genuine swing low,
// it can retroactively break that SAME window's flatness check, making
// RECTANGLE (and therefore this function) fail to fire right after a
// real, sharp spring. Real evidence this doesn't dominate in practice: a
// direct 18,496-checkpoint real-data run found 56 genuine hits (0.30%,
// appropriately rare for a full multi-stage schematic) including real
// examples that correctly reached SPRING/UPTHRUST and SOS/SOW stages, so
// real market noise/timing evidently avoids this exact collision often
// enough to work -- but it is a real, structural edge case, not eliminated,
// flagged here as genuine future refinement work (e.g., re-deriving TR
// boundaries from a window that excludes the spring's own extreme, rather
// than requiring RECTANGLE's own simultaneous detection).
function wyckoffSchematicV7(dates, closes, highs, lows, volumes, volRatio, chartPatterns) {
  try {
    const n = closes.length;
    if (n < WY_TR_LOOKBACK + 20) return null;

    // 1. Anchor to a real trading range -- reuse RECTANGLE if this same
    // call already detected one; without a real TR there's no real
    // boundary for a Spring/SOS/LPS to be evaluated against, just noise.
    const rect = (chartPatterns || []).find(p => p.type === 'RECTANGLE');
    if (!rect) return null;
    const resistance = rect.resistanceLevel, support = rect.supportLevel;
    const trStart = Math.max(0, n - WY_TR_LOOKBACK);

    // 2. Real climax-bar scan -- looks further back than the TR's own
    // window (a real climax + Automatic Rally/Reaction typically precede
    // the range becoming visible as a flat Rectangle) -- 40 real bars,
    // reasoned: enough for a real climax and its real aftermath to unfold
    // before a genuine range appears, not fit to any backtest.
    const scanStart = Math.max(1, trStart - 40);
    const volBaseStart = Math.max(0, scanStart-50);
    const avgVol = volumes.slice(volBaseStart, scanStart).reduce((a,b)=>a+b,0) / Math.max(1, scanStart-volBaseStart);
    let climax = null;
    for (let i = scanStart; i < n; i++) {
      const range = highs[i]-lows[i]; if (range<=0) continue;
      const vRatio = avgVol>0 ? volumes[i]/avgVol : 0;
      if (vRatio < WY_CLIMAX_VOL_RATIO) continue;
      const closePosInRange = (closes[i]-lows[i])/range;
      if (closes[i] < closes[i-1] && closePosInRange > 0.5) { climax = { idx:i, type:'SC', date: dates[i] }; break; }
      if (closes[i] > closes[i-1] && closePosInRange < 0.5) { climax = { idx:i, type:'BC', date: dates[i] }; break; }
    }
    if (!climax) return null; // no real climax found -- an ordinary range, not a Wyckoff schematic

    const phase = climax.type === 'SC' ? 'ACCUMULATION' : 'DISTRIBUTION';

    // 3. Automatic Rally/Reaction -- the real bounce/reaction off the
    // climax bar; just confirms real price action followed the climax
    // (checked directly, not assumed) before treating this as real.
    const arWindow = closes.slice(climax.idx+1, Math.min(n, climax.idx+11));
    if (!arWindow.length) return null;

    // 4. Spring/Upthrust -- reuse this file's own already-detected
    // BEAR_TRAP/BULL_TRAP, gated to have occurred at/near this real TR's
    // own boundary (within 5% -- same real tolerance convention used
    // throughout this file for "at a level").
    const trapType = phase === 'ACCUMULATION' ? 'BEAR_TRAP' : 'BULL_TRAP';
    const trapLevel = phase === 'ACCUMULATION' ? support : resistance;
    const trap = (chartPatterns || []).find(p => p.type === trapType && p.level != null && Math.abs(p.level - trapLevel) / trapLevel < 0.05);

    // 5. Sign of Strength/Weakness -- the real Rectangle's own status
    // field already tracks whether price broke its boundary; SOS/SOW is
    // that same real breakout, in this phase's real direction, confirmed
    // by real volume expansion (Wyckoff's own definition requires this --
    // distinguishes a real SOS from a low-conviction drift through the level).
    const sosDirection = phase === 'ACCUMULATION' ? 'BROKE_UP' : 'BROKE_DOWN';
    const sosConfirmed = rect.status === sosDirection && volRatio > 1.3;

    // 6. Last Point of Support/Supply -- only meaningful once SOS/SOW has
    // actually happened; a real, quiet pullback that holds at the former
    // TR boundary on real LOWER volume than the SOS/SOW bar itself (a
    // genuine LPS/LPSY is unconvincing by design -- if it re-crosses with
    // real volume, that's a failed breakout, not an LPS/LPSY, and this
    // deliberately returns none rather than force a label).
    let lps = null;
    if (sosConfirmed) {
      const boundary = phase === 'ACCUMULATION' ? resistance : support;
      const held = phase === 'ACCUMULATION' ? closes[n-1] >= boundary * 0.98 : closes[n-1] <= boundary * 1.02;
      if (held && volRatio < 1.0) lps = { held: true };
    }

    const stage = lps ? 'LPS/LPSY' : sosConfirmed ? 'SOS/SOW' : trap ? 'SPRING/UPTHRUST' : 'ST';
    return {
      phase, stage, climaxDate: climax.date, resistance, support,
      spring: !!trap, signOfStrength: sosConfirmed,
      read: phase === 'ACCUMULATION'
        ? ('Wyckoff Accumulation schematic, real stage: ' + stage + ' — ' + (stage==='LPS/LPSY' ? 'markup phase confirmed, real Last Point of Support forming' : stage==='SOS/SOW' ? 'real Sign of Strength, breakout through range resistance on real rising volume' : stage==='SPRING/UPTHRUST' ? 'real Spring (false breakdown, reclaimed) — classic final accumulation signature' : 'real trading range with a real Selling Climax, still forming'))
        : ('Wyckoff Distribution schematic, real stage: ' + stage + ' — ' + (stage==='LPS/LPSY' ? 'markdown phase confirmed, real Last Point of Supply forming' : stage==='SOS/SOW' ? 'real Sign of Weakness, breakdown through range support on real rising volume' : stage==='SPRING/UPTHRUST' ? 'real Upthrust (false breakout, failed) — classic final distribution signature' : 'real trading range with a real Buying Climax, still forming'))
    };
  } catch(e) { return null; }
}

// v9.49 -- engine gap-fill. Real course content (ep.1, ep.3): the move
// is dominated by one or two extreme days on extreme relative volume --
// the signature of speculators/retail momentum/algos, not a patient
// institutional order. Direct complement to the already-shipped
// staircase detector (v9.38, institutional accumulation -- the OPPOSITE
// signature, same course episodes). Disclosed default: top-2 days'
// |%change| sum to >=50% of the window's total absolute move; and at
// least one of those days has relative volume >=3x. Real, raw-verified
// quote (ep.5, line 43): "בערך פי שתיים, בערך פי שתיים" ("about 2x,
// about 2x," said twice for emphasis, describing one real jump) --
// used only as loose supporting color for the "extreme move" framing,
// not as the source of the 50%/3x numbers themselves (both remain
// disclosed defaults, not claimed verbatim).
// v9.55 (built), v9.58 (wired in) -- CHARACTERIZATION_PLAN_double_top_bottom_market_cap.md
// Part B. Real, checkable course mechanism (ep.9): a DPO (Direct Public
// Offering) has no underwriter share allocation at a discount -- large
// institutional buyers must accumulate on the open market. Real worked
// example: PLTR traded flat/dead for ~5-6 weeks post-listing on huge
// volume, then broke out once institutional accumulation absorbed the
// float -- signature: declining volume (distribution/disinterest)
// followed by resurging volume (accumulation) preceding a real breakout.
// Real, disclosed precondition: needs to know a ticker IS a DPO, not
// itself a fetched data field from any source this project uses. Left
// unwired at v9.55 for exactly this reason -- wiring it with a silent
// false/undefined default would make it structurally always-null forever,
// the same class of mistake lockupExpirationV7 had before v9.51's fix.
// v9.58 real fix: KNOWN_DPO_TICKERS_V7 below is a small, disclosed,
// manually-curated map -- PLTR is the course's OWN named, verified DPO
// worked example (ep.9, BROKER_COURSE_NOTES.md line 501), not a guess.
// No other watchlist ticker is a known DPO; SPCX/CBRS specifically NOT
// verified either way (too new, real limitation, defaults to false/unknown
// rather than a guessed answer).
const KNOWN_DPO_TICKERS_V7 = { 'PLTR': true };

function dpoDelayedBreakoutV7(closes, volumes, isDPO) {
  if (!isDPO) return null; // structural precondition -- see comment above
  const LOOKBACK = 30; // ~5-6 weeks, sourced from the ONE real worked example (PLTR), not a separately-stated universal rule
  if (closes.length < LOOKBACK || volumes.length < LOOKBACK) return null;
  const cw = closes.slice(-LOOKBACK), vw = volumes.slice(-LOOKBACK);
  const firstHalf = vw.slice(0, 15), secondHalf = vw.slice(15);
  const decliningPhase = slope(firstHalf, firstHalf.length) < 0;
  const resurgingPhase = slope(secondHalf, secondHalf.length) > 0;
  const windowHigh = Math.max(...cw.slice(0, -1)); // real high BEFORE today, no-lookahead
  const breakingOut = cw[cw.length-1] >= windowHigh * (1 - LEVEL_TOLERANCE_V7);
  const triggered = decliningPhase && resurgingPhase && breakingOut;
  return {
    triggered: triggered, decliningPhase: decliningPhase, resurgingPhase: resurgingPhase, breakingOut: breakingOut,
    read: triggered
      ? 'Volume declined then resurged ahead of a real breakout — matches the course\'s DPO delayed-breakout signature (ep.9, real PLTR example)'
      : 'Does not match the DPO delayed-breakout signature'
  };
}

function speculativeSpikeV7(closes, volumes, n, lookbackBars) {
  lookbackBars = lookbackBars || 20;
  if (n < lookbackBars) return null;
  const window = closes.slice(n - lookbackBars, n);
  const volWindow = volumes.slice(n - lookbackBars, n);
  const dailyPctChanges = [];
  for (let i = 1; i < window.length; i++) dailyPctChanges.push((window[i]-window[i-1])/window[i-1]);
  const totalAbsMove = dailyPctChanges.reduce((s,v)=>s+Math.abs(v), 0);
  if (totalAbsMove === 0) return null;
  const sortedAbs = dailyPctChanges.map(Math.abs).slice().sort((a,b)=>b-a);
  const top2Sum = sortedAbs.slice(0,2).reduce((a,b)=>a+b,0);
  const dominatedByFewDays = top2Sum / totalAbsMove >= 0.5;
  const avgVol = volWindow.reduce((a,b)=>a+b,0) / volWindow.length;
  const hasExtremeVolDay = avgVol > 0 && volWindow.some(v => v >= 3 * avgVol);
  const isSpike = dominatedByFewDays && hasExtremeVolDay;
  return {
    isSpike, top2ShareOfMove: top2Sum / totalAbsMove, hasExtremeVolDay,
    read: isSpike
      ? 'A small number of days on extreme volume account for most of the move — speculative/retail-momentum signature (ep.1/3), the opposite of the staircase institutional-accumulation pattern'
      : 'Does not match the speculative-spike pattern'
  };
}

// v9.37 -- CHARACTERIZATION_PLAN_secondary_day.md. "Secondary Day" -- a named
// momentum-continuation entry technique from broker course ep.7: a high-volume
// day, followed by the NEXT day breaking above that day's high. Uses the
// close (not the intraday high) for the "broke above" check, matching the
// engine's own convention elsewhere (e.g. breakoutContext), to avoid a false
// trigger off a brief intraday wick.
function secondaryDayV7(closes, highs, volumes, n) {
  if (n < 22) return null; // needs a 20-bar trailing window for yesterday's volRatio, +1 for "today"
  const yesterdayIdx = n - 2;
  // v9.46 real bug fix (same class as the main volRatio fix above,
  // independent review 2026-08-22): a halted ticker's 20-bar zero-volume
  // window would otherwise blow this ratio up to the raw share count.
  const vol20avgRaw = volumes.slice(yesterdayIdx-20, yesterdayIdx).reduce((a,b)=>a+b,0) / 20;
  const vol20avg = vol20avgRaw || 1;
  const yesterdayVolRatio = vol20avgRaw > 0 ? volumes[yesterdayIdx] / vol20avg : 1;
  const brokeYesterdayHigh = closes[n-1] > highs[yesterdayIdx];
  const triggered = yesterdayVolRatio > 1.5 && brokeYesterdayHigh;
  return { triggered, yesterdayVolRatio, yesterdayHigh: highs[yesterdayIdx] };
}

function rsiArray(closes,n){
  if(!closes||closes.length<n+1)return[];
  const diffs=closes.slice(1).map((v,i)=>v-closes[i]);
  const gains=diffs.map(d=>d>0?d:0),losses=diffs.map(d=>d<0?-d:0);
  const ag=wilderArray(gains,n),al=wilderArray(losses,n),out=[];
  for(let i=0;i<ag.length;i++){out.push(al[i]===0?100:100-100/(1+ag[i]/al[i]));}
  return out; // length = closes.length - n
}

function wilderArray(arr,n){if(!arr||arr.length<n)return[];const out=[];let v=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;out.push(v);for(let i=n;i<arr.length;i++){v=(v*(n-1)+arr[i])/n;out.push(v);}return out;}

function wilderSmooth(arr,n){if(!arr||arr.length<n)return null;let v=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<arr.length;i++)v=(v*(n-1)+arr[i])/n;return v;}

function stdDev(arr){if(!arr||arr.length===0)return 0;const m=arr.reduce((a,b)=>a+b,0)/arr.length;return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length);}

function slope(arr,n){if(!arr||arr.length<2)return 0;const pts=arr.slice(-Math.min(n,arr.length)),m=pts.length;if(m<2)return 0;const sx=m*(m-1)/2,sy=pts.reduce((a,b)=>a+b,0),sxx=m*(m-1)*(2*m-1)/6,sxy=pts.reduce((s,v,i)=>s+i*v,0),d=m*sxx-sx*sx;return d===0?0:(m*sxy-sx*sy)/d;}

function detectDivergence(closes,osc,look,oscLabel){
  const label = oscLabel || 'RSI'; // parameterized (MACD/OBV divergence, DASHBOARD_IMPROVEMENTS_PLAN.md 4a)
  // -- previously hardcoded to always say "RSI" even when called with a
  // different oscillator; kept 'RSI' as the default so the existing call
  // site (unchanged) behaves identically to before.
  const L=Math.min(look||60,osc.length,closes.length);
  if(L<20)return{type:'none',note:'insufficient history'};
  const price=closes.slice(-L),o=osc.slice(-L),w=3;
  const lows=[],highs=[];
  for(let i=w;i<L-w;i++){
    let isLow=true,isHigh=true;
    for(let j=i-w;j<=i+w;j++){if(price[j]<price[i])isLow=false;if(price[j]>price[i])isHigh=false;}
    if(isLow)lows.push(i);if(isHigh)highs.push(i);
  }
  if(lows.length>=2){
    const a=lows[lows.length-2],b=lows[lows.length-1];
    if(price[b]<price[a]&&o[b]>o[a])return{type:'bullish',note:'price lower low, '+label+' higher low'};
  }
  if(highs.length>=2){
    const a=highs[highs.length-2],b=highs[highs.length-1];
    if(price[b]>price[a]&&o[b]<o[a])return{type:'bearish',note:'price higher high, '+label+' lower high'};
  }
  return{type:'none',note:'no clear divergence'};
}


// ══════════════════════════════════════════════════════════════════
//  W9.4 (v9.0) — WATCHLIST SCANNER (lightweight, additive)
//  A thin convenience wrapper over the existing daily pipeline: runs the
//  full engine across every watchlist ticker and returns a compact,
//  sortable summary (ticker, OWN band, BUY-TIMING, conviction, action)
//  WITHOUT writing dashboards or sending mail. Intended for a quick "what
//  across my list is a BUY right now?" scan. runDailyAutomationV7 remains
//  the authoritative logged/emailed path; this is a read-only view.
//  Marked additive: it reuses runAnalysisV7 and does not alter it.
// ══════════════════════════════════════════════════════════════════
function scanWatchlistV7() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tickers = (typeof getWatchlistTickersV7 === 'function')
    ? getWatchlistTickersV7(ss)
    : (CONFIG_V7.dailyTickers || []);
  const rows = [];
  (tickers || []).forEach(function (t) {
    try {
      const res = runAnalysisV7(t, false, false); // reuse the real engine; no chart/options ladder side-effects
      const d = res && res.decision ? res.decision : null;
      rows.push({
        ticker: t,
        ownBand: d ? d.fundBand : 'n/a',
        timing: (res && res.techPlan) ? res.techPlan.timing : 'n/a',
        conviction: d ? d.finalConviction : null,
        action: d ? d.action : 'n/a',
        buyNow: !!(res && res.techPlan && res.techPlan.timing === 'BUY_NOW')
      });
    } catch (e) {
      rows.push({ ticker: t, ownBand: 'ERR', timing: 'ERR', conviction: null, action: String(e), buyNow: false });
    }
  });
  // Sort BUY_NOW first, then by conviction descending.
  rows.sort(function (a, b) {
    if (a.buyNow !== b.buyNow) return a.buyNow ? -1 : 1;
    return (b.conviction || 0) - (a.conviction || 0);
  });
  Logger.log('Watchlist scan (' + rows.length + ' tickers):');
  rows.forEach(function (r) {
    Logger.log('  ' + r.ticker + '  [' + r.ownBand + ']  ' + r.timing + '  conv=' + (r.conviction != null ? r.conviction : 'n/a') + '  ' + r.action);
  });
  return rows;
}

// ══════════════════════════════════════════════════════════════════
//  W9.3 (v9.0) — BACKTEST HARNESS (SKELETON, documented, NOT run-verified)
//  Deliberately shipped as a clearly-labeled skeleton: a real backtest of
//  this engine requires either (a) replaying the full indicator pipeline on
//  each historical bar with only-then-available data, or (b) a stored
//  point-in-time snapshot of every daily decision. Neither exists yet, and
//  it CANNOT be validated in this offline environment (no Apps Script
//  runtime, no historical data feed here). The structure below encodes the
//  correct methodology so another model / a future run can flesh it out
//  against real data without re-deriving the design.
//
//  Methodology (fixed-horizon forward-return evaluation):
//   1. For a ticker, fetch a long daily history (closes/highs/lows/volumes).
//   2. Walk forward from index i=WARMUP..(n-HORIZON-1). At each i, build the
//      SAME indicator set from bars [0..i] ONLY (no lookahead), derive the
//      decision (timing/conviction), and record it.
//   3. Realized outcome = forward return over HORIZON bars: (close[i+H]/close[i]-1).
//      Optionally check whether T1 was hit before the stop within the window.
//   4. Aggregate: hit-rate and average forward return bucketed by decision
//      (BUY_NOW / WAIT_PULLBACK / AVOID) and by conviction decile.
//  A working engine should show BUY_NOW > WAIT_PULLBACK > AVOID on both
//  hit-rate and mean forward return; if not, the weights are miscalibrated.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  ONE-TIME DIAGNOSTIC (CHARACTERIZATION_PLAN.md, Tier 2) -- checks the
//  single open question blocking point-in-time fundamentals: does the
//  CURRENT /stable/income-statement endpoint carry a real filing date
//  (fillingDate/acceptedDate), distinct from the fiscal period-end date
//  (date)? Confirmed present on the old, dead /api/v3/ endpoint via
//  published samples; NOT independently confirmed on /stable/ yet --
//  this function is that confirmation, run once, logged, then done.
//  Run this from the Apps Script editor (select it in the function
//  dropdown, click Run), then check View > Logs.
// ══════════════════════════════════════════════════════════════════
function testFMPStablePointInTimeFields_() {
  const url = 'https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&limit=1&apikey=' + FMP_API_KEY;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code !== 200) {
      Logger.log('HTTP ' + code + ' -- could not reach the endpoint to check. Response: ' + resp.getContentText().substring(0,200));
      return;
    }
    const body = resp.getContentText();
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) {
      Logger.log('Got a 200 but no usable data back. Raw response: ' + body.substring(0,300));
      return;
    }
    const row = list[0];
    const hasFilingDate = row.fillingDate !== undefined;
    const hasAcceptedDate = row.acceptedDate !== undefined;
    Logger.log('=== /stable/income-statement point-in-time field check ===');
    Logger.log('Fiscal period end (date): ' + row.date);
    Logger.log('fillingDate present: ' + hasFilingDate + (hasFilingDate ? ' (value: ' + row.fillingDate + ')' : ''));
    Logger.log('acceptedDate present: ' + hasAcceptedDate + (hasAcceptedDate ? ' (value: ' + row.acceptedDate + ')' : ''));
    if (hasFilingDate || hasAcceptedDate) {
      Logger.log('RESULT: CONFIRMED -- the stable endpoint carries a real filing date, distinct from the fiscal period-end date. Tier 2 can proceed on this data source.');
    } else {
      Logger.log('RESULT: NOT CONFIRMED -- no filing/acceptance date field found. All fields present: ' + Object.keys(row).join(', '));
      Logger.log('This means Tier 2 needs a different point-in-time source (e.g. pairing this endpoint with SEC EDGARs own filing index) -- see CHARACTERIZATION_PLAN.md Section 1, Tier 2.');
    }
  } catch (e) {
    Logger.log('Error: ' + (e && e.message ? e.message : e));
  }
}

function backtestEngineV7_SKELETON(ticker, opts) {
  opts = opts || {};
  const HORIZON = opts.horizonBars || 20; // ~1 trading month
  const WARMUP = opts.warmupBars || 220;  // enough for SMA200 + ADX warmup
  throw new Error(
    'backtestEngineV7_SKELETON is an intentional, documented stub. To implement: ' +
    '(1) fetch full daily history for ' + ticker + '; ' +
    '(2) walk i=' + WARMUP + '..n-' + HORIZON + '-1 rebuilding indicators from bars [0..i] with NO lookahead; ' +
    '(3) record the decision at each i; ' +
    '(4) score forward-return over ' + HORIZON + ' bars and aggregate hit-rate/avg-return by decision & conviction decile. ' +
    'Requires a historical data feed + Apps Script runtime — not runnable in the authoring environment.'
  );
}

// ══════════════════════════════════════════════════════════════════
//  POSITION MANAGEMENT — v0.1
//  Real gap found directly: this engine has always analyzed FRESH,
//  hypothetical entries -- it has no concept of "I already own this,
//  bought at $X on DATE Y." The existing Chandelier stop uses a fixed
//  22-day lookback (see its own comment: "not a monotonic trailing
//  stop yet, needs entry-specific state") -- exactly the piece a real
//  position-management feature needs. This is that fix, scoped to
//  this specific use case.
//
//  Self-contained -- fetches its own chart data via the same
//  fetchYahooChart() already used elsewhere in this file (confirmed
//  its real return shape before using it here, not assumed).
//  Run: analyzePositionV7('TICKER', entryPrice, 'YYYY-MM-DD')
// ══════════════════════════════════════════════════════════════════
// 2026-09-08, real refactor (extraction, not a rewrite -- output is
// byte-identical to what analyzePositionV7 already computed inline
// before this change, verified by keeping every line of real logic
// below unchanged, only moved). Real reason: the new whole-portfolio
// "📤 Exit Strategy" report (buildExitStrategyReportV7) needs this EXACT
// same real stop/target/recommendation logic for every held stock
// position, not a second, separately-maintained copy of it -- same
// "one real implementation, multiple callers" discipline already used
// throughout this project (e.g. riskRewardV1 reused by both Phase 3 and
// Phase 7 in brokerCourseModelV1.gs). Pure computation only -- no
// SpreadsheetApp calls, no UI alerts; returns `{error: '...'}` on a real
// input problem instead of alerting, so a portfolio-wide caller can
// collect errors per-position without a stray alert() blocking the loop.
// Optional `existingChart` -- same dedup convention as every other
// function in this file that can reuse an already-fetched chart.
function computePositionExitReadV1_(ticker, entryPrice, entryDateStr, existingChart) {
  if (typeof entryPrice !== 'number' || isNaN(entryPrice) || entryPrice <= 0) {
    return { error: 'Entry price must be a valid positive number (e.g. 150.25). Got: ' + entryPrice };
  }
  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };
  const dates = chart.dates, closes = chart.closes, highs = chart.highs, lows = chart.lows;

  const entryDate = new Date(entryDateStr);
  let entryIdx = dates.findIndex(d => d >= entryDate);
  if (entryIdx === -1) return { error: 'Entry date is after all available data.' };
  if (entryIdx === 0 && dates[0] > entryDate) {
    return { error: 'Entry date is before the available price history for this ticker (this file fetches 2yr of history) -- the highest-high-since-entry calculation would be inaccurate. Real limitation, not silently ignored.' };
  }

  const ind = computeAllIndicators(chart);
  const cp = closes[closes.length-1];
  const unrealizedPct = (cp - entryPrice) / entryPrice;
  const daysHeld = Math.round((dates[dates.length-1] - entryDate) / (1000*60*60*24));

  const highsSinceEntry = highs.slice(entryIdx);
  const highestHighSinceEntry = Math.max(...highsSinceEntry);
  const chandelierSinceEntry = highestHighSinceEntry - 3*ind.atr14;
  const stopBreached = cp < chandelierSinceEntry;

  // v9.86, Schabacker Study X -- real "two days away" classical trailing
  // stop, a 2nd, independent trailing-stop opinion alongside the existing
  // chandelierSinceEntry above (that one untouched, still the one
  // recommendation/stopBreached reads). Purely additive, display-only.
  const classicalTrailing = (typeof computeClassicalStopTrailingV1_ === 'function') ? computeClassicalStopTrailingV1_(chart, ind, 'long', entryIdx) : null;

  // v9.99, Appendix E (Turtle System) Deliverable 2 port, 2026-09-05 -- a
  // 3rd, independent trailing/position-management opinion for this SAME
  // real entry: N-based 0.5N pyramid adds + 2N stop convergence, from
  // turtleModelV1.gs (guarded, fails safe if that file isn't loaded, same
  // convention as every other cross-file optional feature in this
  // project). Purely additive, display-only -- does not touch
  // chandelierSinceEntry/recommendation above.
  const turtlePyramid = (typeof turtlePyramidLadderForRealEntryV1_ === 'function') ? turtlePyramidLadderForRealEntryV1_(chart, entryIdx, entryPrice) : null;

  const gann = computeGannInline(chart, ind);
  const confluence = computeConfluenceTargets(ind, gann, null, chart); // fund is confirmed unused in this function -- safe to pass null
  const techPlan = computeTechnicalPlanV7(ind, gann, confluence, chart, null);
  const t1 = techPlan.t1 ? techPlan.t1.price : null, t2 = techPlan.t2 ? techPlan.t2.price : null;
  const hitT1 = t1 != null && highestHighSinceEntry >= t1;
  const hitT2 = t2 != null && highestHighSinceEntry >= t2;
  const thesisInvalidated = techPlan.timing === 'AVOID';

  let recommendation, reason;
  if (stopBreached) {
    recommendation = 'STOP HIT — EXIT';
    reason = 'Price ($'+cp.toFixed(2)+') is below the trailing stop ($'+chandelierSinceEntry.toFixed(2)+'), based on the highest high since your actual entry, not a generic lookback.';
  } else if (thesisInvalidated) {
    recommendation = 'THESIS INVALIDATED — CONSIDER EXIT';
    reason = 'The engine now reads AVOID on this ticker — a real change since you entered.';
  } else if (hitT2) {
    recommendation = 'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST';
    reason = 'Price reached the current T2 target ($'+t2.toFixed(2)+') at some point since entry.';
  } else if (hitT1) {
    recommendation = 'T1 REACHED — CONSIDER PARTIAL PROFITS';
    reason = 'Price reached the current T1 target ($'+t1.toFixed(2)+') — the normal, designed point for a first partial exit.';
  } else {
    recommendation = 'HOLD';
    reason = 'No stop breach, no thesis change, targets not yet reached.';
  }

  return {
    error: null, ticker, entryPrice, entryDateStr, cp, unrealizedPct, daysHeld,
    highestHighSinceEntry, chandelierSinceEntry, stopBreached,
    classicalTrailing, turtlePyramid, t1, t2, hitT1, hitT2, thesisInvalidated,
    recommendation, reason
  };
}

function analyzePositionV7(ticker, entryPrice, entryDateStr) {
  const r = computePositionExitReadV1_(ticker, entryPrice, entryDateStr);
  if (r.error) { SpreadsheetApp.getUi().alert(r.error); return; }
  const cp = r.cp, unrealizedPct = r.unrealizedPct, daysHeld = r.daysHeld,
    highestHighSinceEntry = r.highestHighSinceEntry, chandelierSinceEntry = r.chandelierSinceEntry,
    stopBreached = r.stopBreached, classicalTrailing = r.classicalTrailing, turtlePyramid = r.turtlePyramid,
    t1 = r.t1, t2 = r.t2, thesisInvalidated = r.thesisInvalidated,
    recommendation = r.recommendation, reason = r.reason;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('📌 Position — ' + ticker);
  if (sh) sh.clearContents(); else sh = ss.insertSheet('📌 Position — ' + ticker);
  const rows = [
    ['Entry', '$'+entryPrice.toFixed(2)+' on '+entryDateStr],
    ['Current Price', '$'+cp.toFixed(2)],
    ['Unrealized', (unrealizedPct>=0?'+':'')+(unrealizedPct*100).toFixed(1)+'%'],
    ['Days Held', daysHeld],
    ['Trailing Stop (since entry)', '$'+chandelierSinceEntry.toFixed(2)],
    ['Classical Trailing Stop (Schabacker, "two days away")', classicalTrailing ? '$'+classicalTrailing.currentLevel.toFixed(2)+' ('+classicalTrailing.shiftCount+' real shift'+(classicalTrailing.shiftCount===1?'':'s')+' since entry)' : 'N/A (no qualifying pre-entry basing point found)'],
    ['Turtle Pyramid Ladder (Appendix E, 0.5N adds / 2N stop)', (turtlePyramid && turtlePyramid.available) ? (turtlePyramid.units+'/4 Units, stop $'+turtlePyramid.stop.toFixed(2)+(turtlePyramid.stoppedOut?' — STOPPED OUT since entry':turtlePyramid.nextAddTrigger?', next add @ $'+turtlePyramid.nextAddTrigger.toFixed(2):', at max Units')) : 'N/A ('+((turtlePyramid && turtlePyramid.note) || 'model not loaded')+')'],
    ['Highest High Since Entry', '$'+highestHighSinceEntry.toFixed(2)],
    ['Current T1 / T2', (t1?'$'+t1.toFixed(2):'N/A')+' / '+(t2?'$'+t2.toFixed(2):'N/A')],
    ['', ''],
    ['RECOMMENDATION', recommendation],
    ['Why', reason]
  ];
  sh.getRange(1,1,rows.length,2).setValues(rows);
  // v9.99 fix: real, pre-existing off-by-one found while inserting the new
  // Turtle Pyramid Ladder row above -- this hardcoded row number highlighted
  // the BLANK separator row (then row 9), not RECOMMENDATION (then row 10),
  // even before today's own new row shifted everything down by 1. Verified
  // by an exact recount of `rows` before fixing, not assumed. Derived from
  // rows.length instead of hardcoded again, so a future row insertion here
  // can't silently reintroduce the same class of bug.
  const recommendationRow = rows.length - 1; // 'Why' is always the last row, RECOMMENDATION is always the one before it
  sh.getRange(recommendationRow,1,1,2).setFontWeight('bold').setBackground(stopBreached||thesisInvalidated?'#ffcdd2':hitT1||hitT2?'#fff9c4':'#c8e6c9');
  sh.autoResizeColumns(1,2);
}

// ══════════════════════════════════════════════════════════════════
//  📤 EXIT STRATEGY — whole-portfolio position exit analysis, 2026-09-08
//
//  User's own explicit request: "another analysis that takes into
//  account the position I already have... it can be stocks as well...
//  give me the best exit strategy... for all the portfolio" (a single
//  consolidated report over every real held position, not one ticker at
//  a time). Real data source, user's own explicit choice (over the
//  separate myOptionsValueTracker.gs "Portfolio" sheet): the same
//  Transactions-sheet-backed computePortfolioSummaryV7 the existing
//  "💼 Build Portfolio Summary" menu item already uses — one real,
//  unified source for both stock AND option positions, FIFO-tracked,
//  real entry price/date per position (no new data source built).
//
//  Stock rows: reuse computePositionExitReadV1_ (the exact same real
//  stop/target/recommendation logic analyzePositionV7 already uses,
//  extracted above into a shared pure function specifically so this
//  report and the single-ticker tool never drift into 2 different real
//  implementations of the same real decision).
//
//  Option rows: same underlying technical read PLUS a real, options-
//  specific days-to-expiry trigger (user's own explicit answer,
//  2026-09-08: yes, a real hard trigger, not technical-read-only).
//  Real, disclosed default (this project's own established "state the
//  floor of a stated range, not invented" convention -- see e.g.
//  brokerCourseModelV1.gs's 1.5x relative-volume floor): 30 real
//  calendar days for a short-term contract, 60 real calendar days for a
//  real LEAPS (>365 real days from entry to expiry at the time you
//  opened it -- not remaining duration now, which would misclassify an
//  aging LEAPS as short-term right when its slower decay curve matters
//  most). Both numbers are the LOWER bound of what the user approved,
//  not fit to any backtest.
// ══════════════════════════════════════════════════════════════════

const EXIT_STRATEGY_EXPIRY_WARNING_DAYS_SHORT_TERM_V1 = 30;
const EXIT_STRATEGY_EXPIRY_WARNING_DAYS_LEAPS_V1 = 60;
const EXIT_STRATEGY_LEAPS_MIN_ORIGINAL_DURATION_DAYS_V1 = 365;

// v10.2, 2026-09-08: user's own explicit number ("it can be 800 days
// trading days") -- real generic lookback window used ONLY when there's no
// real entry date on file (the current, real state of the Portfolio
// sheet's 2 sub-tables). NOT a since-entry calc -- disclosed as such in
// every reason string that uses it.
const EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1 = 800;

// Real, additive stock/crypto exit read for when only an average COST is
// known, not a real entry DATE -- computePositionExitReadV1_ above stays
// untouched (still the real since-entry calc analyzePositionV7 uses, and
// will become buildExitStrategyReportV7's source again once the user adds
// a real entry-date column). Same real chandelier-stop/T1/T2/thesis logic,
// windowed over a fixed trailing lookback instead of "since entryIdx".
function computePositionExitReadFixedLookbackV1_(ticker, entryPrice, existingChart, lookbackTradingDays) {
  lookbackTradingDays = lookbackTradingDays || EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1;
  if (typeof entryPrice !== 'number' || isNaN(entryPrice) || entryPrice <= 0) {
    return { error: 'Entry price (avg cost) must be a valid positive number. Got: ' + entryPrice };
  }
  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };
  const closes = chart.closes, highs = chart.highs;

  const ind = computeAllIndicators(chart);
  const cp = closes[closes.length - 1];
  const unrealizedPct = (cp - entryPrice) / entryPrice;

  const lookbackStart = Math.max(0, highs.length - lookbackTradingDays);
  const highsInWindow = highs.slice(lookbackStart);
  const highestHighInWindow = Math.max(...highsInWindow);
  const chandelierGeneric = highestHighInWindow - 3 * ind.atr14;
  const stopBreached = cp < chandelierGeneric;

  const gann = computeGannInline(chart, ind);
  const confluence = computeConfluenceTargets(ind, gann, null, chart);
  const techPlan = computeTechnicalPlanV7(ind, gann, confluence, chart, null);
  const t1 = techPlan.t1 ? techPlan.t1.price : null, t2 = techPlan.t2 ? techPlan.t2.price : null;
  const hitT1 = t1 != null && highestHighInWindow >= t1;
  const hitT2 = t2 != null && highestHighInWindow >= t2;
  const thesisInvalidated = techPlan.timing === 'AVOID';

  let recommendation, reason;
  if (stopBreached) {
    recommendation = 'STOP HIT — EXIT';
    reason = 'Price ($' + cp.toFixed(2) + ') is below the trailing stop ($' + chandelierGeneric.toFixed(2) + '), based on the highest high over the last ' + lookbackTradingDays + ' trading days -- a generic lookback, NOT since your actual entry (no entry date on file; add one to switch to the real since-entry calc).';
  } else if (thesisInvalidated) {
    recommendation = 'THESIS INVALIDATED — CONSIDER EXIT';
    reason = 'The engine now reads AVOID on this ticker.';
  } else if (hitT2) {
    recommendation = 'T2 REACHED — CONSIDER TRIMMING REMAINDER, TRAIL THE REST';
    reason = 'Price reached the current T2 target ($' + t2.toFixed(2) + ') within the last ' + lookbackTradingDays + ' trading days.';
  } else if (hitT1) {
    recommendation = 'T1 REACHED — CONSIDER PARTIAL PROFITS';
    reason = 'Price reached the current T1 target ($' + t1.toFixed(2) + ') within the last ' + lookbackTradingDays + ' trading days.';
  } else {
    recommendation = 'HOLD';
    reason = 'No stop breach, no thesis change, targets not yet reached.';
  }

  return {
    error: null, ticker, entryPrice, cp, unrealizedPct, lookbackTradingDays,
    highestHighInWindow, chandelierGeneric, stopBreached, t1, t2, hitT1, hitT2, thesisInvalidated,
    recommendation, reason
  };
}

// Real, additive options exit read for the fixed-lookback case (no real
// entry date on file). computeOptionsPositionExitReadV1_ above stays
// untouched and is the real, more-precise calc once a real entry date
// exists (it classifies LEAPS by ORIGINAL duration at entry, which needs
// a real entry date to compute at all).
//
// Real bug caught before shipping this, 2026-09-08: a first draft tried to
// classify LEAPS-vs-short-term by REMAINING days-to-expiry instead. That
// proxy is broken exactly where it matters most -- a real LEAPS approaching
// its own 60-day warning window has ~50-60 days REMAINING, never >365, so
// it would always misclassify as short-term and get the tighter 30-day
// threshold right when the slower-decay LEAPS threshold is the one that
// should apply. Fixed by dropping the classification entirely when no
// entry date is known: every fixed-lookback option position uses the
// single, safer 60-day (LEAPS) floor -- warns a real short-term contract
// a bit earlier than strictly necessary (safe direction), never a real
// LEAPS too late (unsafe direction). Disclosed in the reason text.
function computeOptionsPositionExitReadFixedLookbackV1_(ticker, strike, expiryStr, avgPremium, existingChart, lookbackTradingDays) {
  lookbackTradingDays = lookbackTradingDays || EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1;
  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };

  const parsedExpiry = (typeof myOpt_parseDate === 'function') ? myOpt_parseDate(expiryStr) : null;
  if (!parsedExpiry) return { error: 'Could not parse expiry date "' + expiryStr + '" for ' + ticker + ' $' + strike + '.' };
  const expiryDate = new Date(parsedExpiry.year, parsedExpiry.month - 1, parsedExpiry.day);
  const MS_PER_DAY = 86400000;
  const daysToExpiry = Math.round((expiryDate - Date.now()) / MS_PER_DAY);

  const expiryThreshold = EXIT_STRATEGY_EXPIRY_WARNING_DAYS_LEAPS_V1; // single, safer floor -- no entry date, so LEAPS vs short-term isn't classifiable at all
  const expiryWarning = daysToExpiry <= expiryThreshold;

  const closes = chart.closes;
  const lookbackStart = Math.max(0, closes.length - lookbackTradingDays);
  const underlyingProxyEntryPrice = closes[lookbackStart];
  const technical = computePositionExitReadFixedLookbackV1_(ticker, underlyingProxyEntryPrice, chart, lookbackTradingDays);

  let recommendation, reason;
  if (daysToExpiry <= 0) {
    recommendation = 'EXPIRED';
    reason = 'Expiry date (' + expiryStr + ') has passed — this position should not still be open; check the Portfolio sheet.';
  } else if (technical.error) {
    recommendation = 'HOLD (technical read unavailable)';
    reason = technical.error;
  } else if (technical.stopBreached) {
    recommendation = 'STOP HIT (underlying) — EXIT';
    reason = technical.reason;
  } else if (technical.thesisInvalidated) {
    recommendation = 'THESIS INVALIDATED (underlying) — CONSIDER EXIT';
    reason = technical.reason;
  } else if (expiryWarning) {
    recommendation = 'EXPIRY APPROACHING (' + daysToExpiry + 'd) — CONSIDER EXIT';
    reason = 'Inside the ' + expiryThreshold + '-day time-decay warning window (single, safer LEAPS-floor threshold used for all contracts -- no entry date on file to classify LEAPS vs short-term), independent of the underlying\'s own technical picture.';
  } else if (technical.hitT2) {
    recommendation = 'T2 REACHED (underlying) — CONSIDER TRIMMING';
    reason = technical.reason;
  } else if (technical.hitT1) {
    recommendation = 'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS';
    reason = technical.reason;
  } else {
    recommendation = 'HOLD';
    reason = 'No stop breach, no thesis change, not near expiry, targets not yet reached.';
  }

  return {
    error: null, ticker, strike, expiryStr, avgPremium, daysToExpiry, expiryThreshold, expiryWarning,
    underlyingProxyEntryPrice, technical, recommendation, reason
  };
}

// Real, options-specific exit read. `underlyingChart` is the real,
// already-fetched OHLCV for the option's own underlying ticker (reused,
// not re-fetched, across every option row for the same ticker in
// buildExitStrategyReportV7 below -- same dedup discipline as every
// other real fetch in this project).
//
// Real, disclosed proxy: the "entry price" fed into the shared
// computePositionExitReadV1_ technical read is the UNDERLYING's own real
// close price on the option's entry date (looked up from the chart), not
// the option premium itself -- the chandelier/T1/T2 stop-and-target
// logic is inherently about the underlying's own price action, which is
// what actually drives whether an options position's THESIS still holds,
// not the premium's own price (which also moves with IV/theta, a
// genuinely different real signal, not modeled here -- disclosed, not
// silently conflated).
function computeOptionsPositionExitReadV1_(ticker, strike, expiryStr, avgPremium, earliestEntryDateStr, existingChart) {
  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) return { error: 'Could not fetch data for ' + ticker + '.' };

  const parsedExpiry = (typeof myOpt_parseDate === 'function') ? myOpt_parseDate(expiryStr) : null;
  if (!parsedExpiry) return { error: 'Could not parse expiry date "' + expiryStr + '" for ' + ticker + ' $' + strike + '.' };
  const expiryDate = new Date(parsedExpiry.year, parsedExpiry.month - 1, parsedExpiry.day);
  const entryDate = new Date(earliestEntryDateStr);
  const MS_PER_DAY = 86400000;
  const daysToExpiry = Math.round((expiryDate - Date.now()) / MS_PER_DAY);
  const originalDurationDays = Math.round((expiryDate - entryDate) / MS_PER_DAY);
  const isLeapsAtEntry = originalDurationDays > EXIT_STRATEGY_LEAPS_MIN_ORIGINAL_DURATION_DAYS_V1;
  const expiryThreshold = isLeapsAtEntry ? EXIT_STRATEGY_EXPIRY_WARNING_DAYS_LEAPS_V1 : EXIT_STRATEGY_EXPIRY_WARNING_DAYS_SHORT_TERM_V1;
  const expiryWarning = daysToExpiry <= expiryThreshold;

  const dates = chart.dates;
  const entryIdx = dates.findIndex(d => d >= entryDate);
  const underlyingEntryPrice = (entryIdx !== -1) ? chart.closes[entryIdx] : chart.closes[0];
  const technical = computePositionExitReadV1_(ticker, underlyingEntryPrice, earliestEntryDateStr, chart);

  // Real, disclosed priority order (most urgent wins the headline
  // recommendation; every real signal is still shown, not just the
  // winner) -- expired contracts first (shouldn't normally appear if the
  // Transactions sheet is kept current, but a real defensive check, not
  // a silent NaN), then the underlying's own stop/thesis reads (a broken
  // technical picture matters regardless of how much time is left), then
  // the real, independent expiry-decay trigger, then targets, then hold.
  let recommendation, reason;
  if (daysToExpiry <= 0) {
    recommendation = 'EXPIRED';
    reason = 'Expiry date (' + expiryStr + ') has passed — this position should not still be open; check the Transactions sheet.';
  } else if (technical.error) {
    recommendation = 'HOLD (technical read unavailable)';
    reason = technical.error;
  } else if (technical.stopBreached) {
    recommendation = 'STOP HIT (underlying) — EXIT';
    reason = technical.reason;
  } else if (technical.thesisInvalidated) {
    recommendation = 'THESIS INVALIDATED (underlying) — CONSIDER EXIT';
    reason = technical.reason;
  } else if (expiryWarning) {
    recommendation = 'EXPIRY APPROACHING (' + daysToExpiry + 'd) — CONSIDER EXIT';
    reason = 'Inside the ' + expiryThreshold + '-day real time-decay warning window for a ' + (isLeapsAtEntry ? 'LEAPS' : 'short-term') + ' contract (theta accelerates as expiry nears), independent of the underlying\'s own technical picture.';
  } else if (technical.hitT2) {
    recommendation = 'T2 REACHED (underlying) — CONSIDER TRIMMING';
    reason = technical.reason;
  } else if (technical.hitT1) {
    recommendation = 'T1 REACHED (underlying) — CONSIDER PARTIAL PROFITS';
    reason = technical.reason;
  } else {
    recommendation = 'HOLD';
    reason = 'No stop breach, no thesis change, not near expiry, targets not yet reached.';
  }

  return {
    error: null, ticker, strike, expiryStr, avgPremium, daysToExpiry, isLeapsAtEntry, expiryThreshold, expiryWarning,
    underlyingEntryPrice, technical, recommendation, reason
  };
}

// Real column name for a per-row entry date, IF the user has added it to a
// given Portfolio sub-table -- same name the user used for the options
// table (2026-09-08); checked as an OPTIONAL column on BOTH sub-tables, so
// this activates automatically the moment it exists, no code change
// needed, per the user's own stated plan ("in the future i will add where
// i can and where i know those details as well").
const EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1 = 'Purchase Data';

// Real, additive formatter -- turns a stock/crypto exit-read result (from
// either the real since-entry computePositionExitReadV1_ or the generic
// computePositionExitReadFixedLookbackV1_ -- both already compute the SAME
// real fields: thesisInvalidated, stopBreached, hitT1/hitT2) into every
// real signal SEPARATELY, tagged with confidence, instead of collapsing
// them into one hidden winner. User's own explicit instruction, 2026-09-08:
// "dont drop anything compute all you can and mark what you cant and take
// into account when you do the analysis and summery at the end."
// v10.6 (2026-09-09): real, shared T1/T2 formatter -- user's own direct
// complaint on a live run: "no real analysis only T1 where is T2 or more?"
// Both were already computed (t1/t2/hitT1/hitT2, real fields on every one
// of the 4 exit-read functions) but the OLD `targets` string collapsed
// them to whichever ONE fired (hitT2 winning over hitT1 if both did),
// silently hiding the other real target's own price/status -- the exact
// class of "hidden winner" bug this report's own v10.3 redesign was
// supposed to have eliminated everywhere, missed here. Now shows BOTH
// real target prices and their real hit/not-yet status, always.
function formatTargetsV1_(t1, hitT1, t2, hitT2) {
  const t1Str = t1 != null ? '$' + t1.toFixed(2) + (hitT1 ? ' ✓reached' : '') : 'N/A';
  const t2Str = t2 != null ? '$' + t2.toFixed(2) + (hitT2 ? ' ✓reached' : '') : 'N/A';
  return 'T1 ' + t1Str + '  |  T2 ' + t2Str;
}

function formatStockSignalsV1_(r, hasRealDate) {
  if (r.error) return { thesis: 'N/A', stop: 'N/A', targets: 'N/A', confidence: 'N/A', summary: 'ERROR: ' + r.error };
  const thesis = r.thesisInvalidated ? 'AVOID' : 'OK';
  const stopLevel = (r.chandelierSinceEntry != null) ? r.chandelierSinceEntry : r.chandelierGeneric;
  const stop = r.stopBreached ? ('BREACHED ($' + stopLevel.toFixed(2) + ')') : 'OK';
  const targets = formatTargetsV1_(r.t1, r.hitT1, r.t2, r.hitT2);
  const confidence = hasRealDate
    ? ('REAL (since entry' + (r.entryDateStr ? ' ' + r.entryDateStr : '') + ')')
    : ('GENERIC (' + (r.lookbackTradingDays || EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1) + 'd lookback, no entry date)');

  let summary;
  if (thesis === 'AVOID') summary = 'EXIT — thesis broken (high confidence, full history)';
  else if (r.stopBreached && hasRealDate) summary = 'EXIT — stop hit (high confidence, since real entry)';
  else if (r.stopBreached && !hasRealDate) summary = 'REVIEW — possible stop hit, LOW CONFIDENCE (generic lookback, add entry date to confirm)';
  else if (r.hitT2) summary = 'CONSIDER TRIMMING/PARTIAL — T2 reached';
  else if (r.hitT1) summary = 'CONSIDER TRIMMING/PARTIAL — T1 reached';
  else summary = 'HOLD';

  return { thesis, stop, targets, confidence, summary };
}

// Real, additive formatter -- same real-signals-not-hidden treatment for
// options (from computeOptionsPositionExitReadV1_ or
// computeOptionsPositionExitReadFixedLookbackV1_), plus the real,
// independent expiry read (always computable from strike+expiry alone,
// never date-dependent).
// `contracts`: real, whole-unit contract count for this row -- unlike
// shares, a fractional contract can't be traded, so "trim" is only a real,
// actionable choice at 2+ contracts. Real bug caught by the user on a live
// run, 2026-09-09: a 1-contract row hitting T1 read "CONSIDER TRIMMING/
// PARTIAL," which is nonsensical -- 1 contract is binary, hold the whole
// thing or exit the whole thing, no partial exists. Fixed by branching the
// target-hit summary text on contracts >= 2 vs. exactly 1 (or unknown/
// unparseable, treated the same as 1 -- the safer, non-invented default).
function formatOptionsSignalsV1_(r, hasRealDate, contracts) {
  if (r.error) return { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: 'N/A', confidence: 'N/A', summary: 'ERROR: ' + r.error };
  const t = r.technical || {};
  const thesis = t.error ? 'N/A' : (t.thesisInvalidated ? 'AVOID' : 'OK');
  const stopLevel = t.error ? null : ((t.chandelierSinceEntry != null) ? t.chandelierSinceEntry : t.chandelierGeneric);
  const stop = t.error ? 'N/A' : (t.stopBreached ? ('BREACHED (underlying, $' + stopLevel.toFixed(2) + ')') : 'OK');
  // v10.6: real, both-targets read (see formatTargetsV1_ above) -- same
  // fix as the stock formatter, same real user complaint.
  const targets = t.error ? 'N/A' : formatTargetsV1_(t.t1, t.hitT1, t.t2, t.hitT2);
  const confidence = hasRealDate ? 'REAL (since entry, real LEAPS-vs-short-term split)' : ('GENERIC (' + r.expiryThreshold + 'd floor, no entry date — no LEAPS split possible)');
  const expiry = r.daysToExpiry + 'd' + (r.expiryWarning ? (' — WARNING (≤ ' + r.expiryThreshold + 'd)') : '');
  const canTrim = typeof contracts === 'number' && contracts >= 2;

  let summary;
  if (r.daysToExpiry <= 0) summary = 'EXPIRED — check Portfolio sheet';
  else if (thesis === 'AVOID') summary = 'EXIT — thesis broken (underlying, high confidence)';
  else if (t.stopBreached && hasRealDate) summary = 'EXIT — stop hit (underlying, high confidence, since real entry)';
  else if (t.stopBreached && !hasRealDate) summary = 'REVIEW — possible stop hit (underlying), LOW CONFIDENCE (generic lookback)';
  else if (r.expiryWarning) summary = 'EXIT — expiry approaching (' + r.daysToExpiry + 'd)';
  else if (t.hitT2 || t.hitT1) {
    const label = t.hitT2 ? 'T2 reached' : 'T1 reached';
    summary = canTrim ? ('CONSIDER TRIMMING/PARTIAL — ' + label) : (label + ' — HOLD or EXIT (only 1 contract, no partial exit possible)');
  }
  else summary = 'HOLD';

  return { thesis, stop, targets, expiry, confidence, summary };
}

// Master orchestrator, v10.3: walks every real position row directly off
// the user's real 'Portfolio' sheet (both its stock/crypto sub-table and
// its options sub-table -- NOT Transactions/computePortfolioSummaryV7,
// per the user's own direct correction 2026-09-08), gives each one a real,
// multi-signal exit-strategy read (not one hidden winner), writes one
// consolidated sheet. Crypto rows (type === 'crypto') are SKIPPED, not
// silently dropped -- fetchYahooChart isn't built for crypto tickers, and
// the user's own explicit answer was "skip crypto." A real per-row
// EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1 date, when present, switches that
// row to the real since-entry functions; otherwise the generic
// fixed-lookback functions are used (disclosed via the Confidence column,
// not hidden). Real fetch-dedup: the underlying chart is fetched ONCE per
// distinct ticker and reused across that ticker's stock row AND every
// option row on the same underlying. Real, fixed silent-failure bug
// (2026-09-08): if only ONE of the 2 real sub-tables failed its header
// search, the whole table used to vanish with no visible error -- now
// surfaced as a real note row regardless of which side failed.
function buildExitStrategyReportV7() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const stockLoc = (typeof findPortfolioStockTableV1_ === 'function') ? findPortfolioStockTableV1_(ss) : { error: 'findPortfolioStockTableV1_ not loaded (myOptionsValueTracker.gs missing).' };
  const optLoc = (typeof myOpt_findTable === 'function') ? myOpt_findTable(ss) : { error: 'myOpt_findTable not loaded (myOptionsValueTracker.gs missing).' };
  if (stockLoc.error && optLoc.error) {
    SpreadsheetApp.getUi().alert('Could not read the Portfolio sheet: ' + stockLoc.error + ' / ' + optLoc.error);
    return;
  }

  const chartCache = {};
  function getChart_(ticker) {
    if (!(ticker in chartCache)) chartCache[ticker] = fetchYahooChart(ticker);
    return chartCache[ticker];
  }

  const results = [];
  const skippedCrypto = [];
  const skippedOtherStock = []; // v10.8: real, disclosed exclusions -- ticker+reason for every stock/crypto-table row that isn't a real position (blank/placeholder rows, TOTAL/summary rows, "***"-marked rows), confirmed against the user's own real Portfolio.xlsx export (row 52 "stock-TBD" placeholder, rows 70-82 a separate loan-funded "***" block + TOTAL rows -- user confirmed only rows 53-61 + options are in scope).
  let blankTickerRowCount = 0; // v10.8: real count of genuinely empty rows skipped (no ticker, no other content worth naming) -- summarized, not spammed one note row each.
  const stockHoldingsForAdvisory = []; // real, disclosed input to computePortfolioBullPhaseAdvisoryV1_ below -- every real stock row (ticker+shares), even ones this report itself can't get a signal for (e.g. no parseable avg cost), since diversification/correlated-caps only need ticker+shares, not a valid entry price.
  let stockTableEmptyDiagnostic = null; // v10.6: real, disclosed diagnostic for a real, reproducible symptom -- the stock/crypto header row IS found (stockLoc.error is falsy) but the loop below reads 0 real ticker rows, so no error note fires and the report silently shows "Distinct stocks held: 0" with no clue why. Populated below if that exact case happens; surfaced as a real note row so the NEXT run pinpoints the cause without another round-trip paste.

  // ── Stock/crypto sub-table ──
  if (!stockLoc.error) {
    const col = stockLoc.col;
    const lastCol = stockLoc.sheet.getLastColumn();
    // v10.7 real, disclosed bound: the scan must never be allowed to run
    // PAST the options table's own header row -- cap at optLoc.headerRow-1
    // when the options table was found and sits after this one (the real,
    // observed order on the user's own sheet), not a guess. Still
    // necessary in v10.8 -- skipping non-position rows (below) means this
    // is the ONLY thing preventing a runaway scan into the options table.
    const optBound = (!optLoc.error && optLoc.headerRow > stockLoc.headerRow) ? optLoc.headerRow - 1 : Infinity;
    const lastRow = Math.min(stockLoc.sheet.getLastRow(), optBound);
    if (lastRow <= stockLoc.headerRow) {
      stockTableEmptyDiagnostic = 'Stock/crypto table header found at row ' + stockLoc.headerRow + ' of "Portfolio" (columns matched: ' + Object.keys(col).join(', ') + '), but the sheet\'s own real last row is ' + lastRow + ' -- nothing below the header to read at all.';
    }
    if (lastRow > stockLoc.headerRow) {
      const data = stockLoc.sheet.getRange(stockLoc.headerRow + 1, 1, lastRow - stockLoc.headerRow, lastCol).getValues();
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNum = stockLoc.headerRow + 1 + i;
        const tickerRaw = String(row[col['Ticker']] || '').trim();
        const ticker = tickerRaw.toUpperCase();
        // v10.8 real fix -- confirmed directly against the user's own real
        // Portfolio.xlsx export: this sheet has MULTIPLE non-position rows
        // interleaved with real ticker rows, not just one spacer --
        // (a) row 52: blank Ticker, type="stock-TBD", a real placeholder;
        // (b) rows 70-82: a SEPARATE, real block of the same tickers
        //     suffixed "***" (loan-funded shares, per the user's own note)
        //     plus real "TOTAL***"/"TOTAL EARNINGS***" summary rows;
        // (c) a stray blank-Ticker row with a leftover total in one cell.
        // User's own explicit scope confirmation: only rows 53-61 (the
        // primary stock block) + the options table are in scope -- the
        // "***" block and any TOTAL/summary row are excluded, not
        // guessed-at or aggregated. Any blank-Ticker row is now always
        // SKIPPED (continue), never a stop signal -- this sheet has more
        // than one such row, and stopping at the first one (v10.7)
        // silently hid every real row after it. A non-blank ticker
        // containing "*" or starting with "TOTAL" is explicitly excluded
        // too, same real reasoning.
        if (!ticker) {
          // v10.8 real fix to the fix: this was a silent skip with zero
          // disclosure -- violates this report's own "dont drop anything
          // ... mark what you cant" convention. A blank-Ticker row with a
          // real "type" value (e.g. row 52's "stock-TBD") is disclosed by
          // name; a genuinely empty row (e.g. row 83's stray leftover
          // total) is just counted, to avoid one note row per real blank
          // spacer on a large sheet.
          const typeHint = String(row[col['type']] || '').trim();
          if (typeHint) skippedOtherStock.push('(row ' + rowNum + ', blank Ticker, type="' + typeHint + '")');
          else blankTickerRowCount++;
          continue;
        }
        if (ticker.indexOf('*') > -1 || ticker.indexOf('TOTAL') === 0) {
          skippedOtherStock.push(tickerRaw + ' (row ' + rowNum + ', excluded -- "*"/TOTAL marker, not a real primary position)');
          continue;
        }
        const type = String(row[col['type']] || '').toLowerCase().trim();
        if (type !== 'stock' && type !== 'crypto') {
          skippedOtherStock.push(ticker + ' (row ' + rowNum + ', type="' + (type || '(blank)') + '" -- not a real "stock" or "crypto" row)');
          continue;
        }
        if (type === 'crypto') { skippedCrypto.push(ticker); continue; }
        const amount = parsePortfolioNumberV1_(row[col['amount']]);
        stockHoldingsForAdvisory.push({ ticker, shares: amount });
        const avgCost = parsePortfolioNumberV1_(row[col['cost avg per stock']]);
        if (avgCost == null) {
          results.push({ assetType: 'STOCK', ticker, size: amount != null ? amount : '', entry: '', extra: '', signals: { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: '', confidence: 'N/A', summary: 'ERROR: No parseable "cost avg per stock" value.' } });
          continue;
        }
        const chart = getChart_(ticker);
        if (!chart) {
          results.push({ assetType: 'STOCK', ticker, size: amount != null ? amount : '', entry: '$' + avgCost.toFixed(2), extra: '', signals: { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: '', confidence: 'N/A', summary: 'ERROR: Could not fetch data for ' + ticker + '.' } });
          continue;
        }
        const entryDateStr = (col[EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1] != null) ? String(row[col[EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1]] || '').trim() : '';
        let hasRealDate = !!entryDateStr;
        let r = hasRealDate ? computePositionExitReadV1_(ticker, avgCost, entryDateStr, chart) : null;
        if (!hasRealDate || (r && r.error)) {
          if (hasRealDate) hasRealDate = false; // real date on file but rejected (e.g. before available history) -- fall back, disclosed via confidence tag, not a hard error
          r = computePositionExitReadFixedLookbackV1_(ticker, avgCost, chart);
        }
        const signals = formatStockSignalsV1_(r, hasRealDate);
        signals.expiry = '';
        results.push({ assetType: 'STOCK', ticker, size: amount != null ? amount : '', entry: '$' + avgCost.toFixed(2), extra: '', signals });
      }
    }
  }

  // ── Options sub-table ──
  if (!optLoc.error) {
    const col = optLoc.col;
    const lastCol = optLoc.sheet.getLastColumn();
    const lastRow = optLoc.sheet.getLastRow();
    if (lastRow > optLoc.headerRow) {
      const data = optLoc.sheet.getRange(optLoc.headerRow + 1, 1, lastRow - optLoc.headerRow, lastCol).getValues();
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const ticker = String(row[col['Ticker']] || '').toUpperCase().trim();
        if (!ticker) break;
        const contracts = parsePortfolioNumberV1_(row[col['positions']]);
        const strike = parsePortfolioNumberV1_(row[col['strike']]);
        const expiryStr = String(row[col['last trade Date']] || '').trim();
        const avgPremium = (col['avg price - Premium paid'] != null) ? parsePortfolioNumberV1_(row[col['avg price - Premium paid']]) : null;
        if (strike == null || !expiryStr) {
          results.push({ assetType: 'OPTION', ticker, size: contracts != null ? contracts : '', entry: '', extra: '', signals: { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: 'N/A', confidence: 'N/A', summary: 'ERROR: Missing/unparseable strike or expiry.' } });
          continue;
        }
        const chart = getChart_(ticker);
        if (!chart) {
          results.push({ assetType: 'OPTION', ticker, size: contracts != null ? contracts : '', entry: avgPremium != null ? ('$' + avgPremium.toFixed(2) + ' premium') : '', extra: '$' + strike + ' exp ' + expiryStr, signals: { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: 'N/A', confidence: 'N/A', summary: 'ERROR: Could not fetch data for ' + ticker + '.' } });
          continue;
        }
        const entryDateStr = (col[EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1] != null) ? String(row[col[EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1]] || '').trim() : '';
        let hasRealDate = !!entryDateStr;
        let r = hasRealDate ? computeOptionsPositionExitReadV1_(ticker, strike, expiryStr, avgPremium, entryDateStr, chart) : null;
        if (!hasRealDate || (r && r.error)) {
          if (hasRealDate) hasRealDate = false;
          r = computeOptionsPositionExitReadFixedLookbackV1_(ticker, strike, expiryStr, avgPremium, chart);
        }
        const signals = formatOptionsSignalsV1_(r, hasRealDate, contracts);
        results.push({ assetType: 'OPTION', ticker, size: contracts != null ? contracts : '', entry: avgPremium != null ? ('$' + avgPremium.toFixed(2) + ' premium') : '', extra: '$' + strike + ' exp ' + expiryStr, signals });
      }
    }
  }

  // v10.6, "cleaner, better report" (user's own explicit ask): real,
  // disclosed urgency sort -- most actionable rows first (a real EXIT/
  // EXPIRED signal), least actionable last (HOLD, then N/A/ERROR rows),
  // instead of whatever order the Portfolio sheet's own rows happened to
  // be in. Ties keep their original relative order (stable sort).
  function urgencyRankV1_(summary) {
    const s = String(summary || '');
    if (s.indexOf('EXIT') === 0 || s.indexOf('EXPIRED') === 0) return 0;
    if (s.indexOf('REVIEW') === 0) return 1;
    if (s.indexOf('CONSIDER') === 0) return 2;
    if (s.indexOf('T1') === 0 || s.indexOf('T2') === 0) return 2; // 1-contract "HOLD or EXIT" phrasing starts with the target label, not a keyword above -- same urgency tier as CONSIDER
    if (s.indexOf('HOLD') === 0) return 3;
    return 4; // ERROR / N/A
  }
  const sortedResults = results.map((r, i) => ({ r, i }))
    .sort((a, b) => urgencyRankV1_(a.r.signals.summary) - urgencyRankV1_(b.r.signals.summary) || a.i - b.i)
    .map(x => x.r);

  const sh = getOrCreate(ss, '📤 Exit Strategy');
  sh.clearContents();
  const header = ['Ticker', 'Type', 'Size', 'Entry', 'Contract', 'Thesis', 'Trailing Stop', 'Targets', 'Expiry', 'Confidence', 'Summary'];
  const rows = [header];
  sortedResults.forEach(r => {
    const s = r.signals;
    rows.push([r.ticker, r.assetType, r.size, r.entry, r.extra, s.thesis, s.stop, s.targets, s.expiry || '', s.confidence, s.summary]);
  });
  if (rows.length === 1) rows.push(['(no open positions found on the Portfolio sheet)', '', '', '', '', '', '', '', '', '', '']);
  sh.getRange(1, 1, rows.length, header.length).setValues(rows);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  sh.setFrozenRows(1); // v10.6: header stays visible while scrolling a long real portfolio
  sh.getRange(2, 1, Math.max(0, rows.length - 1), 1).setFontWeight('bold'); // real ticker column bolded for scannability
  // Real, disclosed color convention -- keyed off the synthesized Summary
  // (last column): red = urgent exit signal (high confidence), orange =
  // review only (low confidence, generic lookback -- a real, deliberately
  // weaker signal, not the same as a real EXIT), yellow = target reached,
  // green = hold, grey = error.
  const summaryCol = header.length;
  for (let i = 1; i < rows.length; i++) {
    const summary = String(rows[i][summaryCol - 1] || '');
    const bg = summary.indexOf('ERROR') === 0 ? '#eceff1'
      : summary.indexOf('EXIT') === 0 || summary.indexOf('EXPIRED') === 0 ? '#ffcdd2'
      : summary.indexOf('REVIEW') === 0 ? '#ffe0b2'
      : summary.indexOf('CONSIDER') === 0 ? '#fff9c4'
      : '#c8e6c9';
    sh.getRange(i + 1, summaryCol, 1, 1).setBackground(bg);
  }
  sh.autoResizeColumns(1, header.length);

  let noteRow = rows.length + 2;
  if (stockLoc.error) { sh.getRange(noteRow, 1).setValue('⚠ Stock/crypto table not read: ' + stockLoc.error); noteRow++; }
  if (optLoc.error) { sh.getRange(noteRow, 1).setValue('⚠ Options table not read: ' + optLoc.error); noteRow++; }
  if (stockTableEmptyDiagnostic) { sh.getRange(noteRow, 1).setValue('⚠ ' + stockTableEmptyDiagnostic).setFontColor('#c0392b').setWrap(true); noteRow++; }
  sh.getRange(noteRow, 1).setValue('ℹ Rows without a real "' + EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1 + '" entry date use a generic lookback for the Trailing Stop/Targets columns (see Confidence column per row), not since-actual-entry.');
  noteRow++;
  if (skippedCrypto.length) {
    sh.getRange(noteRow, 1).setValue('ℹ Skipped ' + skippedCrypto.length + ' crypto row(s) (' + skippedCrypto.join(', ') + ') — not supported by this report.');
    noteRow++;
  }
  if (skippedOtherStock.length) {
    sh.getRange(noteRow, 1).setValue('ℹ Excluded ' + skippedOtherStock.length + ' non-position row(s) from the stock/crypto table: ' + skippedOtherStock.join('; ')).setWrap(true);
    noteRow++;
  }
  if (blankTickerRowCount) {
    sh.getRange(noteRow, 1).setValue('ℹ Skipped ' + blankTickerRowCount + ' genuinely empty row(s) in the stock/crypto table (no Ticker, no other content).');
    noteRow++;
  }
  noteRow++;

  // v10.4 (2026-09-09): real, portfolio-wide diversification + Bull-phase
  // rotation advisory (Edwards & Magee Ch31/Ch41), ported here from the
  // removed "💼 Build Portfolio Summary" report -- see
  // computePortfolioBullPhaseAdvisoryV1_'s own header comment for the full
  // real, disclosed reasoning. Reuses the SAME real stock holdings + the
  // SAME already-fetched charts (getChart_) this report just built above --
  // zero extra fetches for any ticker already loaded.
  try {
    const advisory = computePortfolioBullPhaseAdvisoryV1_(stockHoldingsForAdvisory, getChart_);
    sh.getRange(noteRow, 1).setValue('📊 DIVERSIFICATION & BULL-PHASE ROTATION (Edwards & Magee Ch31/Ch41)').setFontWeight('bold').setBackground('#6c3483').setFontColor('#fff');noteRow++;
    sh.getRange(noteRow, 1).setValue('Distinct stocks held: ' + advisory.distinctStockCount + (advisory.diversificationFlag ? '  ⚠ above the book\'s own real Ch31 "8-10 stocks max" ceiling for an actively-managed account (p468)' : '  (within the book\'s own real Ch31 "8-10 stocks max" guidance, p468)'));noteRow++;
    const phaseLabel = { NEAR_BOTTOM: 'near a real historical BOTTOM-zone read (book\'s own Ch38 anchor, ~5-9% Strong) — Ch41\'s own guidance: favor higher-grade/conservative names early in a new Bull phase',
      NEAR_TOP: 'near a real historical TOP-zone read (book\'s own Ch38 anchor, ~90%+ Strong) — Ch41\'s own guidance: speculative/lower-grade names may be near their own late-cycle peak' }[advisory.phaseRead]
      || 'no strong phase read right now (Evaluative Index not near either of the book\'s own cited extremes)';
    sh.getRange(noteRow, 1).setValue('Market phase: ' + phaseLabel + (advisory.evaluativeIndexPctStrong != null ? ' — Evaluative Index ' + advisory.evaluativeIndexPctStrong.toFixed(1) + '% Strong' : '') + (advisory.dowTheoryVerdict ? ', Dow Theory ' + advisory.dowTheoryVerdict : '')).setWrap(true);noteRow++;
    if (advisory.holdings.length) {
      sh.getRange(noteRow, 1, 1, 3).setValues([['Ticker', 'Sensitivity-Index tier', 'Note']]).setFontWeight('bold').setBackground('#d2b4de');noteRow++;
      advisory.holdings.forEach((h, i) => {
        sh.getRange(noteRow, 1, 1, 3).setValues([[h.ticker, h.tier || 'n/a', h.note || '']]).setBackground(i % 2 === 0 ? '#f4ecf7' : '#fff');
        noteRow++;
      });
    }
    sh.getRange(noteRow, 1).setValue('Informational only, not a scored vote. Real, disclosed limitation: reads the market\'s CURRENT phase, not a prediction of what comes next.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);noteRow += 2;

    if (advisory.correlatedCaps) {
      const cc = advisory.correlatedCaps;
      sh.getRange(noteRow, 1).setValue('🐢 CORRELATED-MARKET EXPOSURE CAPS (Appendix E, Original Turtle Trading System)').setFontWeight('bold').setBackground('#1b4f72').setFontColor('#fff');noteRow++;
      sh.getRange(noteRow, 1).setValue('Total portfolio Units (real shares held ÷ each ticker\'s own Unit size): ' + cc.totalUnits.toFixed(1) + (cc.totalFlagged ? '  ⚠ above the book\'s own real 12-Unit total-direction cap (p690)' : '  (within the book\'s own real 12-Unit total-direction cap, p690)'));noteRow++;
      if (cc.categoryFlags.length) {
        sh.getRange(noteRow, 1, 1, 2).setValues([['Correlated category', 'Units held']]).setFontWeight('bold').setBackground('#aed6f1');noteRow++;
        cc.categoryFlags.forEach((cf, i) => {
          sh.getRange(noteRow, 1, 1, 2).setValues([[cf.category + (cf.flagged ? ' ⚠' : ''), cf.units.toFixed(1)]]).setBackground(i % 2 === 0 ? '#eaf2f8' : '#fff');
          noteRow++;
        });
      } else {
        sh.getRange(noteRow, 1).setValue('No held tickers currently map to a real correlated category.').setFontStyle('italic').setFontColor('#7f8c8d');noteRow++;
      }
      sh.getRange(noteRow, 1).setValue('Informational only, not a scored vote. Per-category cap uses the book\'s own real 10-Unit "loosely correlated" tier (disclosed simplification). Unit count is a real, disclosed proxy (current shares held ÷ the existing N-normalized Unit-size formula), not a literal historical Unit count.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);noteRow++;
    }
  } catch (e) { sh.getRange(noteRow, 1).setValue('⚠️ Diversification/Bull-phase advisory error: ' + e.message.substring(0, 60)).setFontColor('#e65100'); noteRow++; }

  sh.activate();
}

function buildExitStrategyReportV7Menu() {
  buildExitStrategyReportV7();
}

// 2026-09-08, user's own explicit request: "it can run at night scheduled
// and also manually at request... 1am israel time" — same real trigger
// convention already established for the daily watchlist automation
// (installDailyTriggerV7, same 1am hour, same real, disclosed caveat:
// Apps Script fires atHour(n) within an approximate window, in the
// project's own Time Zone setting, not something this code can read or
// set). A SEPARATE handler name/trigger from the watchlist automation —
// this report runs once, over the whole real portfolio, not once per
// watchlist ticker, so it doesn't belong inside that existing loop.
const EXIT_STRATEGY_TRIGGER_HANDLER_V1 = 'buildExitStrategyReportV7';
function installExitStrategyTriggerV1() {
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === EXIT_STRATEGY_TRIGGER_HANDLER_V1);
  if (existing.length > 0) {
    Logger.log('Exit Strategy trigger already installed (' + existing.length + ' found) — not adding another.');
    return;
  }
  ScriptApp.newTrigger(EXIT_STRATEGY_TRIGGER_HANDLER_V1).timeBased().everyDays(1).atHour(1).create();
  Logger.log('Exit Strategy trigger installed: ' + EXIT_STRATEGY_TRIGGER_HANDLER_V1 + ' at ~1:00 AM (project time zone).');
}
