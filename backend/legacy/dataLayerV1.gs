// ══════════════════════════════════════════════════════════════════
//  DATA LAYER — v1.0
//  docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md
//
//  Real, deliberate refactor (v10.x era, not organic v9.x accretion --
//  see memory stock-analyzer-v10-refactor-marker). User's own explicit
//  architecture critique: "all data fetching should have been before
//  any analysis" -- correct; the engine had grown to interleave fetch
//  and analyze throughout, a byproduct of 109 versions of feature
//  accretion, never a designed layer split.
//
//  User's own explicit design directives, all confirmed 2026-09-07:
//  - New file owns every real fetch call currently scattered across
//    the 9 tracked script files -- starting with the engine (this
//    pass), the rest follow in the agreed order (brokerCourseModelV1
//    -> darkPoolTrackerV1 -> futuresStockAnalysisV3 -> macro_fetchers,
//    macro_fetchers already closest to this shape).
//  - Cosmetic-only migration: "the changes can not effect the
//    functionality only the way we run the code." Every function
//    below is moved VERBATIM from fullStockAnalysisV9_109.gs -- same
//    body, same behavior, same live-vs-cached split. Real Apps Script
//    shared global scope means this move needed ZERO call-site
//    changes anywhere: any function, in any file, can already call
//    any of these by name exactly as before.
//  - myOptionsValueTracker.gs is in scope for this refactor too (not
//    yet migrated this pass) -- user's own words: "you need to know
//    the portfolio I have and its status."
//
//  What's HERE (moved from the engine, this pass): the core price
//  fetch (fetchYahooChart/fetchYahooChartRaw_/fetchYahooChartLongRange_),
//  the multi-provider fundamentals merge (gatherFundamentals/
//  gatherFundamentalsV7 + FMP/AlphaVantage/Finnhub + earnings/insider/
//  treasury), the real 13F fetch+cache chain (fetch13FBatchedV1_ and
//  its dependents, including 2 confirmed-dead/unreachable legacy
//  functions -- fetch13FSingleCikV7_/fetch13FForFilerV7_/
//  fetch13FInfoTableUrlV7_ -- kept, not deleted, per this project's own
//  standing "move code, don't delete lines" refactor constraint), the
//  Gemini AI-review fetch, peer metrics, and every real cache
//  read/write helper these depend on (13F/broker-data/macro-snapshot/
//  fundamentals Sheet caches).
//
//  What's NOT here yet: brokerCourseModelV1.gs's own fetches (SPDR/
//  QQQ holdings, SEC filing-keyword search, FRED/short-interest/
//  interest-coverage nightly refreshers), darkPoolTrackerV1.gs's FINRA
//  fetch, futuresStockAnalysisV3's CBOE chain fetch, macro_fetchers'
//  own fetches -- each migrates in a later pass, same discipline.
//
//  Real, disclosed platform limitation this refactor does NOT change:
//  UrlFetchApp has no working per-call deadline (confirmed,
//  docs/OPUS_REVIEW_2026-08-27.md) -- this file consolidates WHERE
//  fetch calls live, it does not and cannot make any individual call
//  interruptible. That's a separate, already-partially-addressed
//  concern (item 8, hang-prevention guards, v9.x).
// ══════════════════════════════════════════════════════════════════

const DATA_LAYER_VERSION = 'v1.5'; // v1.5 (2026-09-07): Pass 6 -- myOptionsValueTracker.gs's own real fetch-owning function (myOpt_fetchCurrentPrice) + its 2 fetch-only helpers moved here verbatim. All 6 real files in scope for docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md are now migrated. // v1.4 (2026-09-07): Pass 5 (FINAL PASS) -- macro_fetchers_v0_14.gs's own real fetch-owning functions + cache helpers + refresh orchestrator moved here verbatim. All 5 planned migration passes of docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md are now complete. // v1.3 (2026-09-07): Pass 4 -- futuresStockAnalysisV3's own real fetch-owning functions moved here verbatim (fetchCboeRawV1_ + _cboeRawChainCacheV1_, fetchCboeChain, fetchChain). // v1.2 (2026-09-07): Pass 3 -- darkPoolTrackerV1.gs's own 2 real fetch-owning functions moved here verbatim (findLatestPublishedFinraWeekV1_, fetchFinraAtsWeeklyBatchV1_). // v1.1 (2026-09-07): Pass 2 -- brokerCourseModelV1.gs's own 10 real fetch-owning/refresh-orchestrator functions moved here verbatim (SPDR/QQQ holdings, FRED series, Nasdaq short interest, SEC EDGAR CIK/shares-outstanding/filing-keyword search, FMP interest coverage, both nightly refresh orchestrators). v1.0 (2026-09-07): first real split -- engine's fetch functions + their cache helpers moved here verbatim (30 functions). See fullStockAnalysisV10_0.gs's own version comment for the paired engine-side change.

function gatherFundamentalsV7(ticker, log) {
  const g = gatherFundamentals(ticker, log); // v6.1, unmodified
  const fund = g.fund;
  if (!fund) return { fund: null, source: g.source };

  let series = null, peers = null;
  try {
    if (typeof FINNHUB_KEY === 'string' && FINNHUB_KEY) {
      const T = encodeURIComponent(ticker);
      const mmRes = UrlFetchApp.fetch('https://finnhub.io/api/v1/stock/metric?symbol='+T+'&metric=all&token='+FINNHUB_KEY, {muteHttpExceptions:true});
      if (mmRes.getResponseCode() === 200) {
        const mm = JSON.parse(mmRes.getContentText() || '{}');
        series = mm.series || null;
      }
      const peersRes = UrlFetchApp.fetch('https://finnhub.io/api/v1/stock/peers?symbol='+T+'&token='+FINNHUB_KEY, {muteHttpExceptions:true});
      if (peersRes.getResponseCode() === 200) {
        const arr = JSON.parse(peersRes.getContentText() || '[]');
        if (Array.isArray(arr)) {
          const self = ticker.toUpperCase();
          peers = arr.filter(t => typeof t === 'string' && t.toUpperCase() !== self).slice(0, CONFIG_V7.peers.max);
        }
      }
    }
  } catch (e) { if (log) log('  ⚠️ v7 series/peers fetch: ' + e.message.substring(0,60)); }

  fund._metricSeries = series;   // {quarterly:{...}, annual:{...}} | null
  fund._peersRaw = peers;        // already self-excluded + capped, or null
  return { fund, source: g.source };
}

function fetchPeerBasicMetricsV7(sym, log) {
  const cacheKey = 'V7_PEER_' + sym;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && cached.t && (Date.now()-cached.t) < CONFIG_V7.peers.cacheHours*3600*1000) return cached.data;
    }
  } catch (e) { /* fall through to a fresh fetch */ }
  try {
    if (!FINNHUB_KEY) return null;
    const url = 'https://finnhub.io/api/v1/stock/metric?symbol='+encodeURIComponent(sym)+'&metric=all&token='+FINNHUB_KEY;
    const res = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
    if (res.getResponseCode() !== 200) return null;
    const d = JSON.parse(res.getContentText() || '{}');
    const m = d.metric || null, series = d.series || null;
    if (!m) return null;
    const num = v => { if (v==null) return null; const n=parseFloat(v); return isNaN(n)?null:n; };
    const pct = v => { const n=num(v); return n==null?null:n/100; };
    const data = {
      revenueGrowth: pct(m.revenueGrowthTTMYoy != null ? m.revenueGrowthTTMYoy : m.revenueGrowthQuarterlyYoy),
      grossMargins : pct(m.grossMarginTTM),
      netMargin    : pct(m.netProfitMarginTTM),
      fcfMargin    : seriesLatestV7(series, 'fcfMargin', null, null),
      evSales      : seriesLatestV7(series, 'evRevenueTTM', null, null)
    };
    try { PropertiesService.getScriptProperties().setProperty(cacheKey, JSON.stringify({ t: Date.now(), data })); } catch (e) {}
    return data;
  } catch (e) { if (log) log('  Peer metric error (' + sym + '): ' + e.message.substring(0,40)); return null; }
}

function fetchGeminiReviewV7(ticker, fundResult, techPlan, decision, ind, gann, confluence, fund, chart, optAnalysis, log, leapsCallArg, shortTermCallArg) {
  const key = GEMINI_API_KEY; // v6.1 constant
  if (!key) { if (log) log('  Gemini: no API key'); return null; }
  const round = (v,d) => (v==null||isNaN(v)) ? null : Number(Number(v).toFixed(d==null?2:d));

  const report = {
    ticker: ticker, price: round(chart.currentPrice),
    fundamental: {
      score: fundResult.score, verdict: fundResult.verdict, sectorModel: fundResult.profile,
      drivers: (fundResult.drivers||[]).map(d => ({ label:d.label, value:d.value, note:d.note })),
      pricedForPerfection: fundResult.pricedForPerfection || false,
      // Sub-phase 1.1.4 (Phase 1 fix): the canonical, single-source-of-truth
      // revenue growth figure, fed directly so the model can't paraphrase a
      // DIFFERENT driver (e.g. "Revenue/share trend") into "revenue growth."
      // v9.70 fix: all 4 of these dereferenced `fund.X` directly, with no
      // `fund &&` guard -- unlike this same function's own later lines
      // (fund._insiderTrading, fund.forwardPE) which already guard
      // correctly. A real, reproducible crash: fund is null whenever all 3
      // fundamentals sources fail (a real, already-handled degraded path
      // everywhere else in this file), and if Gemini review is still
      // attempted in that case, this line threw -- aborting the ENTIRE
      // report even though price/technicals/options/decision had already
      // computed successfully. Found via the v9.70 resilience integration
      // test (tests/macro_regime_resilience_test.js), not observed live.
      canonicalRevenueGrowthPct: fund && fund.revenueGrowth != null ? round(fund.revenueGrowth*100, 1) : null,
      // Balance sheet health -- 3 distilled numbers, not raw statements.
      // Real gap found directly: this whole section existed on the dashboard
      // but was never in the AI's prompt at all.
      debtToEquity: fund && fund.debtToEquity != null ? round(fund.debtToEquity, 2) : null,
      currentRatio: fund && fund.currentRatio != null ? round(fund.currentRatio, 2) : null,
      fcfPerShare: fund && fund.fcfPerShare != null ? round(fund.fcfPerShare, 2) : null
    },
    technical: {
      techScore: techPlan.techScore, regime: techPlan.regime, timing: techPlan.timing,
      entry: round(techPlan.entryPrice), entryZone: [round(techPlan.entryLow), round(techPlan.entryHigh)],
      eta: techPlan.timeToEntry ? techPlan.timeToEntry.humanText : null, confidencePct: techPlan.entryConfidencePct,
      exitT1: techPlan.t1 ? round(techPlan.t1.price) : null, exitT2: techPlan.t2 ? round(techPlan.t2.price) : null,
      stop: round(techPlan.stop), rrToT1: round(techPlan.rrToT1,2), rrToT2: round(techPlan.rrToT2,2)
    },
    decision: { action: decision.action, finalConviction: decision.finalConviction }
  };

  // Secular (5-10yr) read -- one verdict string, not the underlying CAGR
  // series or weekly closes. Directly relevant to the "should you own it"
  // framing already in the prompt.
  if (techPlan.secular) {
    report.secular = { verdict: techPlan.secular.verdict, why: techPlan.secular.why };
  }
  // Sector-relative strength -- 2 numbers, already a finished comparison,
  // not the underlying benchmark price series.
  if (ind.rs) {
    report.sectorStrength = { rs63Pct: round(ind.rs.rs63, 1), outperforming: !!ind.rs.outperforming };
  }
  // Broad-market backdrop (VIX) -- 1 read, not the VIX time series.
  if (chart.vixContext) {
    report.macroBackdrop = chart.vixContext.read;
  }
  // v9.28: cross-asset macro regime (RISK_ON/RISK_OFF/NEUTRAL) -- the SAME
  // signal synthesizeDecisionV7's conviction modifier already uses (§5B.2
  // above), reused here, not recomputed. getCachedMacroRegime_() is script-
  // execution-cached and already called earlier in the real call chain
  // (synthesizeDecisionV7 runs before this function), so this line costs
  // ZERO additional network calls -- it only ever reads the cache. Same
  // "weak/unconfirmed signal" disclosure already attached everywhere else
  // this regime read is used (MACRO_REGIME_VALIDATION_RESULTS.md), so the
  // AI narrative can't overstate it beyond what the rest of the report does.
  {
    const macroRead = getCachedMacroRegime_();
    if (macroRead && macroRead.available) {
      report.macroRegime = macroRead.regime + ' (weak/unconfirmed signal -- see MACRO_REGIME_VALIDATION_RESULTS.md)';
    }
  }
  // Insider trading -- only when real data came back (matches the same
  // conditional pattern the dashboard itself already uses), net direction
  // only, not the individual filing list.
  if (fund && fund._insiderTrading) {
    report.insiderActivity = fund._insiderTrading.netBuying ? 'net buying' : 'net selling';
  }
  // Rate-sensitivity -- only surfaced when it's a REAL consideration (high
  // P/E), matching the dashboard's own conditional display -- not noise for
  // every ticker regardless of relevance.
  {
    const pe = fund && (fund.forwardPE != null ? fund.forwardPE : fund.trailingPE);
    if (pe != null && pe > 40 && fund._treasuryRate10Y && fund._treasuryRate10Y.year10 != null) {
      report.rateSensitivity = 'high (P/E ' + round(pe,1) + 'x vs ' + round(fund._treasuryRate10Y.year10,2) + '% 10yr yield)';
    }
  }

  if (optAnalysis && optAnalysis.available) {
    // Real mismatch found directly: topCall/leapCall here came from a
    // DIFFERENT function (analyzeOptionsForScoringV7, used for direction-
    // confirmation scoring) than the actual recommended contract shown
    // everywhere else in the report (selectRecommendedCallV7, on the chart
    // and in Bottom Line) -- Gemini was describing a contract that might not
    // match what the rest of the report says to actually buy. Removed the
    // mismatched topCall/topPut/leapCall/leapPut; kept the genuinely
    // different, non-redundant positioning signals (aggregate sentiment,
    // not a specific trade) and reconciled the actual pick below.
    report.options = {
      confirm: optAnalysis.confirm, putCallOI: round(optAnalysis.putCallOI,2), netBiasPct: round(optAnalysis.netBiasPct,1),
      dirSignal: round(optAnalysis.dirSig,2), leapsLean: round(optAnalysis.leapsLean,2), ivRankPct: optAnalysis.ivRank,
      notes: optAnalysis.notes
    };
  }
  // The actual recommended contract(s) -- same picks shown on the chart and
  // in Bottom Line, so the AI narrative describes the SAME trade, not a
  // separately-computed one. Distilled to strike/expiry/delta, not the full
  // candidate comparison.
  function distillPick(pick) {
    if (!pick || !pick.found) return null;
    const c = pick.contract;
    return { strike: c.strike, expiry: new Date(c.expUnix*1000).toDateString(), delta: round(c.delta,2) };
  }
  const leapsPick = distillPick(leapsCallArg), shortPick = distillPick(shortTermCallArg);
  if (leapsPick || shortPick) {
    report.recommendedContract = {};
    if (leapsPick) report.recommendedContract.leaps = leapsPick;
    if (shortPick) report.recommendedContract.shortTerm = shortPick;
  }

  const prompt =
    'You are a professional equity analyst reviewing an automated v7 report for ' + ticker + '. ' +
    'This report deliberately keeps TWO SEPARATE scores: a Fundamental/OWN score (is this a good company to own?) ' +
    'and a Technical/BUY-TIMING score+plan (is now the time to buy, and if not, at what price and roughly when?). ' +
    'Respect that separation — never merge them into one number or imply one determines the other. ' +
    'Use ONLY the numbers provided — do NOT invent prices, targets, or figures. ' +
    'IMPORTANT: if you state a revenue growth percentage anywhere, you MUST use the value in ' +
    'fundamental.canonicalRevenueGrowthPct verbatim (or say revenue growth data is unavailable if it is null). ' +
    'Do NOT use any figure from the "drivers" list as a revenue-growth percentage — a driver labeled ' +
    '"Revenue/share trend" describes a DIFFERENT metric (revenue per share, not total revenue growth) ' +
    'and must never be reported as "revenue growth."\n\n' +
    'AUDIENCE: a NON-EXPERT investor. Write a clear, pedagogical briefing (≤320 words). Explain any jargon in a few words the first time you use it. ' +
    'FORMAT RULES (important): do NOT use any Markdown symbols — no asterisks, no "#", no backticks, no bold markup. ' +
    'Use these EXACT section headers, each on its own line in UPPERCASE, followed by 1–3 short sentences or lines that start with "- ":\n\n' +
    'AT A GLANCE\n' +
    '- one plain sentence: is it a good company, is now a good time to buy, and what is the action.\n\n' +
    'THE COMPANY (SHOULD YOU OWN IT?)\n' +
    '- reference the OWN score/verdict and the 2–3 biggest positive and negative drivers, in plain words. If balance-sheet fields (debtToEquity/currentRatio/fcfPerShare) are present, weave in a one-line financial-health read. If insiderActivity is present, mention it briefly as a supporting (not primary) signal.\n\n' +
    'THE TIMING (IS NOW A GOOD TIME TO BUY?)\n' +
    '- reference the BUY-TIMING score, trend, and whether to buy now or wait; if waiting, give the entry price, zone, ETA and confidence %. If secular is present, add one sentence on the long-term (5-10yr) read, kept clearly distinct from this short-term timing call. If sectorStrength or macroBackdrop or rateSensitivity or macroRegime are present, weave in briefly where relevant — do not force all four if only one is present. If macroRegime is present, mention it as one contributing factor only, exactly as weak/unconfirmed as its own label says — never imply it is a confirmed or primary driver of the timing call.\n\n' +
    'WHAT THE OPTIONS SAY\n' +
    '- if an options block is present: plain-English read of confirm/conflict, Put/Call and LEAPS lean (near-term timing vs long-term ownership conviction) and IV; state it nudges the Final Conviction and BUY-TIMING but NEVER the OWN score. If recommendedContract is present, name the actual strike/expiry as the specific contract this report points to (leaps and/or short-term). If both options and recommendedContract are absent, say options data was not loaded.\n\n' +
    'REAL-WORLD EXPOSURE (STRUCTURAL, NOT A NEW SCORE)\n' +
    '- Using what you know about this specific company (not the report data), name ONE real, concrete exposure that could matter: a key input cost (does it depend on a specific commodity/material?), a supply-chain dependency (a concentrated supplier, a single-region manufacturing base), or its 2-3 real named competitors and whether this company is relatively better or worse positioned on that same exposure. Keep this to 2-3 sentences, plainly labeled as general/structural reasoning, not tied to any specific current event unless commodityMoves data is present in the report (it usually will not be yet). Skip this section entirely rather than force a generic "macro risk exists" statement if nothing concrete comes to mind for this specific company.\n\n' +
    'KEY NUMBERS\n' +
    '- a compact list, one per line as "Label: value", covering OWN score, BUY-TIMING score, Final Conviction, Entry, Stop, Target 1, Target 2, and Risk/Reward.\n\n' +
    'BOTTOM LINE\n' +
    '- the decision action, the Final Conviction, and one plain sentence on what a non-expert should actually do.\n\n' +
    'REPORT (JSON):\n' + JSON.stringify(report);

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);
  const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1024 } };
  try {
    const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json', payload: JSON.stringify(payload), muteHttpExceptions:true });
    const code = res.getResponseCode();
    if (code !== 200) { if (log) log('  Gemini HTTP ' + code + ': ' + res.getContentText().substring(0,120)); return null; }
    const json = JSON.parse(res.getContentText());
    const cand = json.candidates && json.candidates[0];
    if (!cand) { const fb = json.promptFeedback && json.promptFeedback.blockReason; if (log) log('  Gemini: no candidate' + (fb?' (blocked: '+fb+')':'')); return null; }
    let text = '';
    if (cand.content && cand.content.parts) text = cand.content.parts.map(p=>p.text||'').join('').trim();
    if (!text) { if (log) log('  Gemini: empty text'); return null; }
    return text.replace(/\*\*/g,'').replace(/(^|[^\w])\*(?=\S)/g,'$1').replace(/`/g,'').replace(/^#+\s*/gm,'').trim(); // strip stray Markdown
  } catch (e) { if (log) log('  Gemini error: ' + e.message.substring(0,80)); return null; }
}

function fetchYahooChartRaw_(ticker, range) {
  // Defensive encoding added for VIX support (DASHBOARD_IMPROVEMENTS_PLAN.md
  // 4a) -- '^VIX' contains a reserved URL character that was previously
  // concatenated raw. encodeURIComponent is a no-op for ordinary tickers
  // (confirmed: 'AAPL'->'AAPL', 'BRK.B'->'BRK.B'), so this is safe and
  // backward-compatible for every existing call site, not just VIX.
  // v9.40 -- CHARACTERIZATION_PLAN_reverse_split.md. Added events=div,splits
  // to this same call (zero new network calls) -- found while checking
  // whether real split events are exposed on this already-used endpoint,
  // for broker course ep.10's reverse-split avoid-heuristic. Verified live
  // against NVDA's real 10:1 forward split (2024-06-10): numerator=10,
  // denominator=1, correct date, decoded from this exact param.
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
            + '?interval=1d&range=' + range + '&includePrePost=false&events=div,splits';
  try {
    const res = UrlFetchApp.fetch(url, {
      headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},
      muteHttpExceptions:true
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    const r = json.chart && json.chart.result && json.chart.result[0];
    if (!r) return null;
    const q = r.indicators.quote[0], n = r.timestamp.length;
    const opens=[],highs=[],lows=[],closes=[],volumes=[],dates=[];
    for (let i=0;i<n;i++) {
      if (q.close[i]==null) continue;
      opens.push(q.open[i]||q.close[i]); highs.push(q.high[i]||q.close[i]);
      lows.push(q.low[i]||q.close[i]);   closes.push(q.close[i]);
      volumes.push(q.volume[i]||0);       dates.push(new Date(r.timestamp[i]*1000));
    }
    if (!closes.length) return null;
    // v9.40 -- splits come back keyed by timestamp-string; normalize to a
    // plain array of {date: Date, numerator, denominator}. numerator/
    // denominator direct from Yahoo, not the human-readable splitRatio
    // string (more reliable to compare numerically -- a reverse split is
    // numerator < denominator, e.g. 1-for-16 -> numerator=1, denominator=16).
    const splitEvents = (r.events && r.events.splits) ? Object.values(r.events.splits) : [];
    const splits = splitEvents.map(s => ({ date: new Date(s.date*1000), numerator: s.numerator, denominator: s.denominator }));
    return {
      opens, highs, lows, closes, volumes, dates, ticker,
      currentPrice: r.meta.regularMarketPrice || closes[closes.length-1],
      prevClose:    closes[closes.length-2],  // FIXED: always from array
      currency:     r.meta.currency || 'USD',
      // v9.39 -- CHARACTERIZATION_PLAN_lockup_expiration.md. r.meta.firstTradeDate
      // was already present in this same JSON response and unused -- found while
      // verifying broker course ep.9's short-interest data wasn't fetchable
      // (quoteSummary needs a crumb-auth handshake this simple fetch doesn't do).
      // Verified live against 4 known real listing dates before trusting it:
      // TSLA->2010-06-29, ABNB->2020-12-10, GME->2002-02-13, NIO->2018-09-12,
      // all correct. Zero new network calls.
      ipoDate: r.meta.firstTradeDate ? new Date(r.meta.firstTradeDate*1000) : null,
      splits // v9.40, see comment above -- real split events, zero new network calls
    };
  } catch(e) { return null; }
}

function fetchYahooChart(ticker) {
  const _cached = readPriceCacheV7_(ticker);
  if (isPriceCacheFreshV7_(_cached)) return _cached;

  if (_cached && _cached.dates && _cached.dates.length) {
    const lastCachedDate = _cached.dates[_cached.dates.length - 1];
    const daysSinceLastCache = Math.floor((Date.now() - lastCachedDate.getTime()) / 86400000);
    const INCREMENTAL_GAP_CEILING_DAYS = 25;
    if (daysSinceLastCache <= INCREMENTAL_GAP_CEILING_DAYS) {
      const incremental = fetchYahooChartRaw_(ticker, '1mo');
      if (incremental) {
        const newIdx = incremental.dates.findIndex(d => d.getTime() > lastCachedDate.getTime());
        if (newIdx !== -1) {
          const newCount = incremental.dates.length - newIdx;
          const merged = {
            opens:  _cached.opens.concat(incremental.opens.slice(newIdx)),
            highs:  _cached.highs.concat(incremental.highs.slice(newIdx)),
            lows:   _cached.lows.concat(incremental.lows.slice(newIdx)),
            closes: _cached.closes.concat(incremental.closes.slice(newIdx)),
            volumes:_cached.volumes.concat(incremental.volumes.slice(newIdx)),
            dates:  _cached.dates.concat(incremental.dates.slice(newIdx)),
            ticker,
            currentPrice: incremental.currentPrice, prevClose: incremental.prevClose, currency: incremental.currency,
            ipoDate: incremental.ipoDate || _cached.ipoDate,
            splits: (incremental.splits && incremental.splits.length) ? incremental.splits : _cached.splits
          };
          appendPriceCacheV7_(ticker, merged, newCount);
          return merged;
        }
        // real, disclosed edge case: newIdx===-1 means even a 1mo fetch's
        // earliest bar doesn't reach back to the cache's last date (should
        // be rare given the 25-day ceiling above, but falls through safely
        // to the full fetch below rather than silently leaving a gap).
      }
    }
  }

  const result = fetchYahooChartRaw_(ticker, '2y');
  if (!result || result.closes.length < 60) return null;
  writePriceCacheV7_(ticker, result);
  return result;
}

function fetchYahooChartLongRange_(ticker) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
            + '?interval=1d&range=10y&includePrePost=false';
  try {
    const res = UrlFetchApp.fetch(url, {
      headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},
      muteHttpExceptions:true
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    const r = json.chart && json.chart.result && json.chart.result[0];
    if (!r) return null;
    const q = r.indicators.quote[0], n = r.timestamp.length;
    const closes = [];
    for (let i=0;i<n;i++) { if (q.close[i]!=null) closes.push(q.close[i]); }
    if (closes.length < 2) return null;
    return closes;
  } catch(e) { return null; }
}

function gatherFundamentals(ticker, log) {
  // 2026-09-06: FMP moved to run LAST among these 3 -- user's own direct ask
  // ("put the problematic api in the end, I want to see everything else in
  // the data fetching works") after a real MELI run showed FMP's 5 premium-
  // tier endpoints failing with a real, expected HTTP 402 (this API key's
  // free plan doesn't cover them for this symbol) logged FIRST, ahead of AV/
  // Finnhub's real successes. Pure reorder, zero logic change: all 3 calls
  // are independent (none reads another's result), and the merge logic
  // below (present/defOrder/targetOrder/etc.) only ever reads each
  // variable's final VALUE, never the order they were assigned in.
  // 2026-09-07, real fix (item 8, hang-prevention cleanup): these 3
  // providers (AV=1 endpoint, Finnhub=3, FMP=6 -- the single largest
  // unguarded cluster this project's own fetch-map found, confirmed via
  // a direct Explore-agent code sweep) ran completely unconditionally,
  // zero time-budget guard anywhere in this function. A brand-new ticker
  // pays the full live cost of all 10 endpoints on every real call. Real
  // Apps Script limitation (already confirmed via this project's own
  // Opus review, docs/OPUS_REVIEW_2026-08-27.md): UrlFetchApp has no real
  // working per-call deadline, so a guard here can only stop STARTING a
  // remaining provider when time is already tight -- it can't bound a
  // call already in flight. Still real, disclosed value: on a run
  // where AV+Finnhub already burned most of the budget (or a fully
  // legitimate slow real network day), FMP's 6-endpoint cluster is
  // skipped instead of also being started, same disclosure shape a
  // provider that returns null already gets (`fund._sources` just won't
  // list it -- no separate plumbing needed).
  // 2026-09-07, v10.0 Pass 1 real fix: this function moved here from the
  // engine, but `hasTimeBudgetV7_`/`_runStartTimeV7` (item 8, 2026-09-07)
  // stayed in the engine -- real global execution-timing state, not a
  // fetch concern. Always present together in the real deployed project
  // (same shared global scope), but a standalone/test sandbox that loads
  // only this file would ReferenceError without a defensive check --
  // same `typeof X !== 'function'` convention already used at every other
  // real cross-file call site in this project (e.g. brokerCourseModelV1.gs's
  // own SPDR-holdings guard).
  function hasTimeBudgetSafe_(marginMs) { return typeof hasTimeBudgetV7_ !== 'function' || hasTimeBudgetV7_(marginMs); }
  function skipLog_(label) { if (log) log('⏭ Skipped: ' + label + ' — time budget (' + Math.round((Date.now()-(typeof _runStartTimeV7 !== 'undefined' && _runStartTimeV7 != null ? _runStartTimeV7 : Date.now()))/1000) + 's elapsed)'); return null; }

  let av = null;
  if (typeof ALPHAVANTAGE_KEY==='string' && ALPHAVANTAGE_KEY) {
    av = hasTimeBudgetSafe_(10000) ? (log&&log('📡 Alpha Vantage fundamentals...'), fetchAlphaVantageFundamentals(ticker, log)) : skipLog_('Alpha Vantage fundamentals');
  }
  let fh = null;
  if (typeof FINNHUB_KEY==='string' && FINNHUB_KEY) {
    fh = hasTimeBudgetSafe_(10000) ? (log&&log('📡 Finnhub fundamentals...'), fetchFinnhubFundamentals(ticker, log)) : skipLog_('Finnhub fundamentals');
  }
  const fmp = hasTimeBudgetSafe_(30000) ? fetchFMPFundamentals(ticker, log) : skipLog_('FMP fundamentals (6 endpoints)');

  const present = [fmp,av,fh].filter(Boolean);
  if (present.length === 0) return { fund:null, source:'none' };

  // Per-field precedence. AV's P/E can be an extreme outlier on low-earnings
  // names, so ratios prefer FMP→Finnhub→AV; targets prefer FMP→AV; analyst
  // ratings prefer Finnhub→AV→FMP (Finnhub's counts are freshest).
  const defOrder    = [fmp,fh,av].filter(Boolean);
  const targetOrder = [fmp,av,fh].filter(Boolean);
  const ratingOrder = [fh,av,fmp].filter(Boolean);
  const first = (order,k) => { for (const o of order) if (o && o[k]!=null && o[k]!=='') return o[k]; return null; };
  const TARGET = {targetMean:1,targetHigh:1,targetLow:1};
  const RATING = {recMean:1,recKey:1,numAnalysts:1,strongBuy:1,buy:1,hold:1,sell:1,strongSell:1};
  const FIELDS = ['forwardPE','trailingPE','pegRatio','priceToBook','profitMargins','grossMargins','returnOnEquity','returnOnAssets','revenueGrowth','earningsGrowth','beta','marketCap','dividend','price','sector','industry','targetMean','targetHigh','targetLow','numAnalysts','recMean','recKey','strongBuy','buy','hold','sell','strongSell','shortRatio','institutionPct',
    // Found missing during a real-run check: fetchFMPFundamentals extracts
    // these 3 correctly, but they were never added to this merge list, so
    // they were silently dropped every single run regardless of whether
    // FMP succeeded -- the Balance Sheet Health section never had a chance
    // to render. Same bug class caught before (macdDivergence not being
    // copied through scoreAllSignalsV7_) -- computed correctly one layer
    // up, never actually reaching where it's used.
    'debtToEquity','currentRatio','fcfPerShare','quickRatio',
    // v9.31: shareFloat — from BROKER_COURSE_EPISODE_1_NOTES.md's real
    // finding. FMP's float endpoint is paid-tier-blocked (verified live),
    // so this field is only ever sourced from Finnhub or AV — defOrder's
    // FMP-first precedence just naturally skips it via first()'s null-check.
    'shareFloat'];

  const fund = { _source:'merged' };
  FIELDS.forEach(k => { fund[k] = first(TARGET[k]?targetOrder:RATING[k]?ratingOrder:defOrder, k); });
  fund._premiumBlocked = fmp ? fmp._premiumBlocked : false;
  fund._rateLimited    = fmp ? fmp._rateLimited : false;

  // Phase 2 fix: forwardPE alone is no longer a reliable "has data" signal now
  // that it's honestly null for providers without real forward estimates —
  // trailingPE added so a source isn't wrongly treated as empty.
  const has = f => f && (f.forwardPE!=null||f.trailingPE!=null||f.revenueGrowth!=null||f.returnOnEquity!=null||f.targetMean!=null||f.recMean!=null||f.profitMargins!=null);
  const named = [['FMP',fmp],['AV',av],['Finnhub',fh]].filter(x=>has(x[1]));
  fund._sources = named.map(x=>x[0]);

  // Cross-reference: flag metrics where sources disagree materially.
  // Phase 2 fix: 'P/E' now checks trailingPE specifically (the one field all
  // 3 providers can genuinely supply) instead of the old forwardPE, which
  // was comparing a guaranteed-trailing number (FMP) against a sometimes-
  // forward number (Finnhub/AV) — a definitional mismatch, not real
  // disagreement (see Phase 0's audit finding). A residual 'Forward P/E'
  // check is added separately for whichever providers DO have real forward
  // data — genuine disagreement there is worth still flagging.
  const checks = [
    ['P/E (trailing)','trailingPE', (a,b)=>Math.abs(a-b)/Math.max(1,Math.abs(a),Math.abs(b))>0.4],
    ['P/E (forward)','forwardPE', (a,b)=>Math.abs(a-b)/Math.max(1,Math.abs(a),Math.abs(b))>0.4],
    ['Net margin','profitMargins',(a,b)=>Math.abs(a-b)>0.10],
    ['Rev growth','revenueGrowth',(a,b)=>Math.abs(a-b)>0.10],
    ['ROE','returnOnEquity',(a,b)=>Math.abs(a-b)>0.15],
    ['Beta','beta',(a,b)=>Math.abs(a-b)>0.2],
    ['Analyst target','targetMean',(a,b)=>Math.abs(a-b)/Math.max(1,a,b)>0.15],
    ['Rating','recMean',(a,b)=>Math.abs(a-b)>0.7],
  ];
  // Phase 2 fix (2.2.2/2.2.3): a genuine residual-disagreement metric —
  // coefficient of variation, computed for EVERY field with 2+ sources,
  // not just the ones that trip the old absolute-threshold checks below.
  // Thresholds grounded in the two real disagreement cases already seen
  // (TSLA P/E CV=0.296, PLTR P/E CV=0.260) rather than picked arbitrarily —
  // both land clearly in "untrustworthy" with this split, not borderline.
  function computeCV_(nums) {
    if (nums.length < 2) return null;
    const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
    if (mean === 0) return null;
    const variance = nums.reduce((s,n)=>s+(n-mean)*(n-mean),0)/nums.length;
    return Math.sqrt(variance)/Math.abs(mean);
  }
  function classifyCV_(cv) {
    if (cv == null) return null;
    return cv < 0.10 ? 'fine' : cv < 0.25 ? 'shaky' : 'untrustworthy';
  }
  const crossRefCV = {}; // key -> { cv, band } — used by computeFundamentalScoreV7 (Sub-phase 2.3) to annotate drivers

  const crossRef = [];
  checks.forEach(([label,key,differ]) => {
    const vals = [['FMP',fmp],['AV',av],['Finnhub',fh]].filter(x=>x[1]&&x[1][key]!=null).map(x=>[x[0],x[1][key]]);
    if (vals.length>=2) {
      // P1-1 fix (deep-dive review): CV/differ() had no independent numeric
      // filter — even with P0-1's fix at the source, this is a second layer
      // of defense so a future provider integration (or any value that
      // slips through) can't silently corrupt the mean/CV calculation.
      const nums = vals.map(v => Number(v[1])).filter(Number.isFinite);
      const cv = computeCV_(nums);
      if (cv != null) crossRefCV[key] = { cv, band: classifyCV_(cv) };
      let disagree=false;
      for (let i=0;i<nums.length;i++) for (let j=i+1;j<nums.length;j++) if (differ(nums[i],nums[j])) disagree=true;
      if (disagree) {
        const isPct = /margin|growth|ROE/i.test(label);
        // Phase 2 fix (2.2.1): 'Rev growth' specifically gets a period-mismatch
        // note appended — FMP=annual (now explicit, see the fetch call above),
        // Finnhub=TTM YoY (primary field), AV=quarterly YoY. These are three
        // genuinely different measurement periods, not the same number
        // disagreeing — the note says so plainly instead of implying it's noise.
        const periodNote = (key==='revenueGrowth') ? '  [periods differ: FMP=annual, Finnhub=TTM, AV=quarterly — not directly comparable]' : '';
        crossRef.push(label+': '+vals.map(v=>v[0]+' '+(isPct?(v[1]*100).toFixed(0)+'%':Math.abs(v[1])>=100?Math.round(v[1]):v[1].toFixed(2))).join(' vs ')+periodNote);
      }
    }
  });
  fund._crossRef = crossRef.length ? crossRef : null;
  fund._crossRefCV = crossRefCV; // Sub-phase 2.3: structured, per-field CV data for driver-level confidence annotation

  // Earnings-date awareness (ENGINE_GAP_ANALYSIS.md, priority #1) --
  // attached here so it flows through wherever fund/fundResult already
  // does, no new plumbing needed elsewhere.
  // v9.41 -- CHARACTERIZATION_PLAN_earnings_gap.md: fetchNextEarningsDate
  // renamed to fetchEarningsCalendarV7 and now ALSO returns the full
  // history array (past + future) from this SAME already-called FMP
  // endpoint -- verified live it already carries real epsActual/
  // epsEstimated/revenueActual/revenueEstimated per report, just discarded
  // by the old function's future-only filter. Zero new network calls.
  // `.next`'s shape is unchanged from the old return value -- the one
  // existing call site (the "Next earnings" banner) needed no changes.
  // Same 2026-09-07 guard as the 3 providers above -- these 3 were also
  // completely unconditional, no guard at all.
  if (hasTimeBudgetSafe_(5000)) {
    const earningsCalendar = fetchEarningsCalendarV7(ticker, log);
    fund._nextEarnings = earningsCalendar.next;
    fund._earningsHistory = earningsCalendar.history;
  } else {
    skipLog_('Earnings calendar');
  }
  fund._insiderTrading = hasTimeBudgetSafe_(5000) ? fetchInsiderTradingNet(ticker, log) : skipLog_('Insider trading net');
  fund._treasuryRate10Y = hasTimeBudgetSafe_(5000) ? fetchTreasuryRate10Y(log) : skipLog_('Treasury 10Y rate'); // no ticker needed -- same macro value for every stock

  const source = (fund._sources.length ? fund._sources.join(' + ') : 'profile-only') + ' fresh ' + new Date().toLocaleDateString();
  return { fund, source };
}

function fetchFinnhubFundamentals(ticker, log) {
  try {
    if (!FINNHUB_KEY) return null;
    const base = 'https://finnhub.io/api/v1/';
    const get = q => { try { const r=UrlFetchApp.fetch(base+q+'&token='+FINNHUB_KEY,{muteHttpExceptions:true}); if(r.getResponseCode()!==200) return null; const j=JSON.parse(r.getContentText()||'null'); if(j&&j.error) return null; return j; } catch(e){ return null; } };
    const T   = encodeURIComponent(ticker);
    const mm  = get('stock/metric?symbol='+T+'&metric=all');
    const m   = (mm && mm.metric) || null;
    const prof= get('stock/profile2?symbol='+T);
    const rec = get('stock/recommendation?symbol='+T);
    if (!m && !prof && !(rec && rec.length)) { if(log) log('  Finnhub: no data for '+ticker); return null; }

    const num = v => { if(v==null) return null; const n=parseFloat(v); return isNaN(n)?null:n; };
    const pct = v => { const n=num(v); return n==null?null:n/100; }; // % → decimal

    // recommendation is an array, newest first
    let recMean=null, recKey='', sb=0,b=0,h=0,sl=0,ss=0,totRec=0;
    if (rec && rec.length) {
      const r0=rec[0]; sb=+r0.strongBuy||0; b=+r0.buy||0; h=+r0.hold||0; sl=+r0.sell||0; ss=+r0.strongSell||0;
      totRec=sb+b+h+sl+ss;
      if (totRec) { recMean=(1*sb+2*b+3*h+4*sl+5*ss)/totRec; recKey=recMean<1.5?'Strong Buy':recMean<2.5?'Buy':recMean<3.5?'Hold':recMean<4.5?'Sell':'Strong Sell'; }
    }
    return {
      _source:'finnhub',
      forwardPE     : num(m&&m.forwardPE), // Phase 2 fix (2.2.0): no longer silently falls back to trailing — null means Finnhub genuinely has no forward estimate
      trailingPE    : num(m&&m.peTTM), // new field — the actual trailing multiple, tracked separately from forward
      pegRatio      : num(m&&m.pegTTM),
      priceToBook   : num(m&&(m.pbQuarterly!=null?m.pbQuarterly:m.pb)),
      profitMargins : pct(m&&m.netProfitMarginTTM),
      grossMargins  : pct(m&&m.grossMarginTTM),
      returnOnEquity: pct(m&&m.roeTTM),
      returnOnAssets: pct(m&&m.roaTTM),
      revenueGrowth : pct(m&&(m.revenueGrowthTTMYoy!=null?m.revenueGrowthTTMYoy:m.revenueGrowthQuarterlyYoy)),
      earningsGrowth: pct(m&&(m.epsGrowthTTMYoy!=null?m.epsGrowthTTMYoy:m.epsGrowthQuarterlyYoy)),
      beta          : num(m&&m.beta),
      marketCap     : prof&&prof.marketCapitalization!=null ? num(prof.marketCapitalization)*1e6 : null,
      // v9.31: floatingShare is in millions (verified live: JKS returned
      // 28.97, i.e. 28.97M shares) -- same *1e6 convention marketCapitalization
      // already uses one line up. Zero new network call: profile2 is already
      // fetched above for sector/marketCap.
      shareFloat    : prof&&prof.floatingShare!=null ? num(prof.floatingShare)*1e6 : null,
      dividend      : num(m&&m.dividendPerShareTTM) || num(m&&m.currentDividendPerShareTTM),
      price         : null,
      sector        : (prof&&prof.finnhubIndustry) || null,
      industry      : (prof&&prof.finnhubIndustry) || null,
      targetMean:null, targetHigh:null, targetLow:null,
      numAnalysts   : totRec||null,
      recMean, recKey,
      strongBuy:sb, buy:b, hold:h, sell:sl, strongSell:ss,
      shortRatio:null, institutionPct:null,
      _premiumBlocked:false, _rateLimited:false
    };
  } catch(e) { if(log) log('  Finnhub error: ' + e.message.substring(0,50)); return null; }
}

function fetchEarningsCalendarV7(ticker, log) {
  const url = 'https://financialmodelingprep.com/stable/earnings?symbol=' + ticker + '&apikey=' + FMP_API_KEY;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      if (log) log('  FMP [earnings] HTTP ' + resp.getResponseCode());
      return { next: null, history: [] };
    }
    const body = resp.getContentText();
    if (!body || body.length < 5) return { next: null, history: [] };
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return { next: null, history: [] };
    if (list[0] && list[0].date === undefined && log) {
      log('  ⚠ WARNING: expected "date" field not found on FMP earnings response for ' + ticker + ' -- field-name assumption may be wrong, needs investigating.');
      return { next: null, history: [] };
    }
    const today = new Date(); today.setHours(0,0,0,0);
    const parsed = list
      .filter(e => e && e.date)
      .map(e => ({
        date: new Date(e.date + 'T00:00:00Z'), raw: e.date,
        epsActual: (typeof e.epsActual === 'number') ? e.epsActual : null,
        epsEstimated: (typeof e.epsEstimated === 'number') ? e.epsEstimated : null,
        revenueActual: (typeof e.revenueActual === 'number') ? e.revenueActual : null,
        revenueEstimated: (typeof e.revenueEstimated === 'number') ? e.revenueEstimated : null
      }))
      .filter(e => !isNaN(e.date.getTime()));
    // Find the soonest date that's today or later -- ignore past reports (unchanged from the old function).
    const upcoming = parsed.filter(e => e.date >= today).sort((a, b) => a.date - b.date);
    const next = upcoming.length ? { date: upcoming[0].date, dateStr: upcoming[0].raw } : null;
    return { next, history: parsed };
  } catch (e) {
    if (log) log('  FMP [earnings] error: ' + e.message.substring(0, 60));
    return { next: null, history: [] };
  }
}

function fetch13FCusipV7(ticker) {
  const cacheKey = 'CUSIP_' + String(ticker).toUpperCase();
  const cached = (typeof cacheGet === 'function') ? cacheGet(cacheKey) : null;
  if (cached !== null && cached !== undefined) return cached;
  try {
    const url = 'https://financialmodelingprep.com/stable/profile?symbol=' + encodeURIComponent(ticker) + '&apikey=' + FMP_API_KEY;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null; // real transient failure (e.g. rate limit) -- deliberately NOT cached, retry next run
    const j = JSON.parse(resp.getContentText());
    const result = (j && j[0] && j[0].cusip) || null;
    if (result && typeof cacheSet === 'function') cacheSet(cacheKey, result, 24 * 90); // 90 days
    return result;
  } catch (e) { return null; }
}

function fetch13FInfoTableUrlV7_(cik, accession) {
  const accNoDash = accession.replace(/-/g, '');
  const idxUrl = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/index.json';
  const resp = UrlFetchApp.fetch(idxUrl, { headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  const idx = JSON.parse(resp.getContentText());
  const items = (idx.directory && idx.directory.item) || [];
  const infoTable = items.find(i => i.name.indexOf('.xml') === i.name.length - 4 && i.name !== 'primary_doc.xml');
  if (!infoTable) return null;
  return 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + accNoDash + '/' + infoTable.name;
}

function fetch13FSingleCikV7_(cik, cusip) {
  try {
    const subUrl = 'https://data.sec.gov/submissions/CIK' + ('0000000000' + cik).slice(-10) + '.json';
    const subResp = UrlFetchApp.fetch(subUrl, { headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true });
    if (subResp.getResponseCode() !== 200) return { latest: null, prior: null };
    const sub = JSON.parse(subResp.getContentText());
    const r = sub.filings.recent;
    const accessions = [];
    for (let i = 0; i < r.form.length && accessions.length < 2; i++) {
      if (r.form[i] === '13F-HR') accessions.push({ accession: r.accessionNumber[i], date: r.filingDate[i] });
    }
    const result = { latest: null, prior: null };
    ['latest', 'prior'].forEach((label, idx) => {
      const acc = accessions[idx];
      if (!acc) return;
      const url = fetch13FInfoTableUrlV7_(cik, acc.accession);
      if (!url) return;
      const xmlResp = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true });
      if (xmlResp.getResponseCode() !== 200) return;
      const holdingsMap = parse13FInfoTableV7_(xmlResp.getContentText());
      result[label] = { date: acc.date, holdings: holdingsMap[cusip] || null };
    });
    return result;
  } catch (e) { return { latest: null, prior: null }; }
}

function fetch13FForFilerV7_(cikOrCiks, cusip) {
  const ciks = Array.isArray(cikOrCiks) ? cikOrCiks : [cikOrCiks];
  const perCik = ciks.map(cik => fetch13FSingleCikV7_(cik, cusip));
  return sum13FPerCikResultsV1_(perCik);
}

function fetchAllOrSequentialV1_(requests) {
  if (!requests.length) return [];
  if (typeof UrlFetchApp.fetchAll === 'function') {
    try { return UrlFetchApp.fetchAll(requests); } catch (e) { /* fall through to sequential below */ }
  }
  return requests.map(req => { try { return UrlFetchApp.fetch(req.url, req); } catch (e) { return null; } });
}

function fetch13FBatchedV1_(cikList, cusip) {
  const result = {};
  cikList.forEach(cik => { result[cik] = { latest: null, prior: null }; });
  if (!cikList.length) return result;

  // Round 1: every CIK's real submissions index, concurrently.
  const subReqs = cikList.map(cik => ({
    url: 'https://data.sec.gov/submissions/CIK' + ('0000000000' + cik).slice(-10) + '.json',
    headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true
  }));
  const subResps = fetchAllOrSequentialV1_(subReqs);

  // 2026-09-06, real bug found via a real user-pasted screenshot (GOOGL):
  // a real institutional holder (State Street, BlackRock, etc.) coming
  // back completely null for a mega-cap ticker, paired with a suspiciously
  // fast "1.6s" fetch time -- a real cold fetch takes ~28s (confirmed
  // live), so 1.6s could only be a CACHE HIT. The unconditional-cache
  // design (deliberate, dating to v9.63-companion, for a genuine "no real
  // institutional holder" ticker) becomes a real bug when the all-null
  // result was actually caused by a transient SEC outage/rate-limit at
  // fetch time, not a genuine finding -- that bad result then gets served
  // for up to 90 days (the whole quarter). Tracked here: did SEC's real
  // submissions endpoint respond successfully for AT LEAST ONE real CIK?
  // If EVERY single one failed, that's the real signal of a systemic,
  // transient problem (SEC unreachable that moment), not "no holders" --
  // the caller (fetchInstitutional13FHoldingsV7) uses this to skip caching
  // entirely in that case, so the NEXT real run gets a fresh attempt
  // instead of being stuck with a poisoned result for the whole quarter.
  let anySubmissionsSuccess = false;
  const accessionsByCik = {}; // cik -> [{label, accession, date}]
  cikList.forEach((cik, i) => {
    accessionsByCik[cik] = [];
    const resp = subResps[i];
    if (!resp) return;
    try {
      if (resp.getResponseCode() !== 200) return;
      anySubmissionsSuccess = true;
      const sub = JSON.parse(resp.getContentText());
      const r = sub.filings.recent;
      const found = [];
      for (let j = 0; j < r.form.length && found.length < 2; j++) {
        if (r.form[j] === '13F-HR') found.push({ accession: r.accessionNumber[j], date: r.filingDate[j] });
      }
      ['latest', 'prior'].forEach((label, idx) => {
        if (found[idx]) accessionsByCik[cik].push({ label, accession: found[idx].accession, date: found[idx].date });
      });
    } catch (e) { /* real, disclosed: a malformed submissions response leaves this CIK with 0 accessions, not a crash */ }
  });

  // Round 2: every resolved accession's real index.json, concurrently.
  const idxEntries = []; // {cik, label, accession, date}
  cikList.forEach(cik => { accessionsByCik[cik].forEach(a => idxEntries.push({ cik, label: a.label, accession: a.accession, date: a.date })); });
  const idxReqs = idxEntries.map(e => ({
    url: 'https://www.sec.gov/Archives/edgar/data/' + e.cik + '/' + e.accession.replace(/-/g, '') + '/index.json',
    headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true
  }));
  const idxResps = fetchAllOrSequentialV1_(idxReqs);

  const dataEntries = []; // {cik, label, date, dataUrl}
  idxEntries.forEach((e, i) => {
    const resp = idxResps[i];
    if (!resp) return;
    try {
      if (resp.getResponseCode() !== 200) return;
      const idx = JSON.parse(resp.getContentText());
      const items = (idx.directory && idx.directory.item) || [];
      const infoTable = items.find(it => it.name.indexOf('.xml') === it.name.length - 4 && it.name !== 'primary_doc.xml');
      if (!infoTable) return;
      dataEntries.push({ cik: e.cik, label: e.label, date: e.date, dataUrl: 'https://www.sec.gov/Archives/edgar/data/' + e.cik + '/' + e.accession.replace(/-/g, '') + '/' + infoTable.name });
    } catch (e2) { /* real, disclosed: a malformed index.json leaves this one label unresolved, not a crash */ }
  });

  // Round 3: every resolved real XML data file, concurrently -- the actual big ones.
  const dataReqs = dataEntries.map(e => ({ url: e.dataUrl, headers: { 'User-Agent': 'Mozilla/5.0 research@example.com' }, muteHttpExceptions: true }));
  const dataResps = fetchAllOrSequentialV1_(dataReqs);

  // 2026-09-06, real fix (Opus review): anySubmissionsSuccess alone only
  // proves Round 1 (small, fast JSON) worked -- the real GOOGL failure
  // this was built to prevent is far more likely a Round 3 problem (up to
  // 18 concurrent ~23MB downloads, the ones SEC's own real rate limiting
  // is most likely to throttle/403/truncate). Tracked here too, so the
  // caller's caching decision reflects whether the actual DATA fetch
  // worked, not just the cheap lookup that precedes it.
  let anyDataFetchSuccess = false;
  dataEntries.forEach((e, i) => {
    const resp = dataResps[i];
    if (!resp) return;
    try {
      if (resp.getResponseCode() !== 200) return;
      anyDataFetchSuccess = true;
      const holdingsMap = parse13FInfoTableV7_(resp.getContentText());
      result[e.cik][e.label] = { date: e.date, holdings: holdingsMap[cusip] || null };
    } catch (e2) { /* real, disclosed: a malformed XML leaves this one label null, not a crash */ }
  });

  // Real, disclosed: this metadata key is intentionally NOT a valid real
  // CIK (a real CIK is all-digits), so it can never collide with a real
  // per-CIK result key -- the caller reads and deletes it before iterating.
  // Real caching rule (both conditions, not just Round 1): SEC must have
  // been reachable at all (anySubmissionsSuccess), AND either there was
  // genuinely nothing further to fetch (every reachable CIK's own real
  // 13F-HR search found 0 accessions -- a real, valid "nothing filed"
  // outcome, dataEntries.length===0) OR at least one real Round-3 data
  // fetch actually succeeded (anyDataFetchSuccess) -- proving the pipeline
  // worked end-to-end for at least one CIK, not just its cheap first step.
  result.__meta = { safeToCache: anySubmissionsSuccess && (dataEntries.length === 0 || anyDataFetchSuccess) };
  return result;
}

function fetchInstitutional13FHoldingsV7(cusip) {
  const expectedTag = (typeof expected13FQuarterTagV1_ === 'function') ? expected13FQuarterTagV1_() : null;
  const cached = (typeof read13FCacheV1_ === 'function') ? read13FCacheV1_(cusip) : null;
  if (cached && expectedTag && cached.quarterTag === expectedTag) return cached.data;

  // 2026-09-05, v9.104: flatten every filer's CIK(s) into one deduped list
  // and fetch ALL of them via fetch13FBatchedV1_'s 3 concurrent rounds,
  // instead of looping filer-by-filer (each filer previously ran its own
  // fully sequential chain, one after another -- see fetch13FBatchedV1_'s
  // own header comment for the real, measured scale of the problem this
  // fixes: up to 45 sequential round-trips for one ticker).
  const cikToFilers = {}; // cik -> [filerName, ...] (defensive: a CIK could in principle serve >1 filer name)
  Object.keys(INSTITUTIONAL_13F_FILERS_V7).forEach(name => {
    const ciks = Array.isArray(INSTITUTIONAL_13F_FILERS_V7[name]) ? INSTITUTIONAL_13F_FILERS_V7[name] : [INSTITUTIONAL_13F_FILERS_V7[name]];
    ciks.forEach(cik => { (cikToFilers[cik] = cikToFilers[cik] || []).push(name); });
  });
  const allCiks = Object.keys(cikToFilers);
  const perCikResults = (typeof fetch13FBatchedV1_ === 'function') ? fetch13FBatchedV1_(allCiks, cusip) : {};
  // Real, disclosed: default true when the flag is genuinely absent (e.g.
  // fetch13FBatchedV1_ unavailable) -- preserves the prior always-cache
  // behavior in that fallback case rather than silently never caching.
  const safeToCache = perCikResults.__meta ? perCikResults.__meta.safeToCache : true;
  delete perCikResults.__meta;

  const out = {};
  Object.keys(INSTITUTIONAL_13F_FILERS_V7).forEach(name => {
    const ciks = Array.isArray(INSTITUTIONAL_13F_FILERS_V7[name]) ? INSTITUTIONAL_13F_FILERS_V7[name] : [INSTITUTIONAL_13F_FILERS_V7[name]];
    out[name] = sum13FPerCikResultsV1_(ciks.map(cik => perCikResults[cik] || { latest: null, prior: null }));
  });
  // 2026-09-06, real bug fix, refined same day (Opus review): only cache
  // when the fetch was genuinely safeToCache -- both SEC's cheap
  // submissions lookup AND (if there was anything further to fetch) at
  // least one real Round-3 data download actually succeeded. Caching an
  // all-null result caused by a real, transient SEC outage/rate-limit
  // (at ANY of the 3 rounds, not just the first) would otherwise poison
  // this CUSIP's cache for up to 90 days (the whole quarter), serving
  // wrong "no institutional holders" data for a real mega-cap that
  // genuinely has real holders. A genuine "no real holder" ticker (SEC
  // reachable, found nothing) still caches normally, unchanged.
  if (typeof write13FCacheV1_ === 'function' && safeToCache) write13FCacheV1_(cusip, expectedTag, out);
  return out;
}

function expected13FQuarterTagV1_(now) {
  now = now || new Date();
  const year = now.getUTCFullYear();
  const FILING_LAG_DAYS_V1 = 45;
  const candidates = [];
  [year - 1, year].forEach(y => {
    [[2, 31, 1], [5, 30, 2], [8, 30, 3], [11, 31, 4]].forEach(([month, day, q]) => {
      const qEnd = new Date(Date.UTC(y, month, day));
      const deadline = new Date(qEnd.getTime() + FILING_LAG_DAYS_V1 * 86400000);
      if (deadline.getTime() <= now.getTime()) candidates.push({ qEnd, tag: y + 'Q' + q });
    });
  });
  if (!candidates.length) return null; // real, disclosed: defensive only -- shouldn't happen given year-1 is also checked
  candidates.sort((a, b) => b.qEnd.getTime() - a.qEnd.getTime());
  return candidates[0].tag;
}

function read13FCacheV1_(cusip) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CACHE_13F_SHEET_NAME_V1);
    if (!sh) return null;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return null;
    const rows = sh.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === String(cusip)) {
        let data;
        try { data = JSON.parse(rows[i][3]); } catch (e) { return null; } // real, disclosed: a malformed cached row falls through to a real live fetch, never crashes
        return { quarterTag: rows[i][1], lastFetched: rows[i][2], data };
      }
    }
    return null;
  } catch (e) { return null; } // real, disclosed: any cache-read problem falls through to a real live fetch, never blocks a report
}

function write13FCacheV1_(cusip, quarterTag, data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(CACHE_13F_SHEET_NAME_V1);
    if (!sh) {
      sh = ss.insertSheet(CACHE_13F_SHEET_NAME_V1);
      sh.getRange(1, 1, 1, 4).setValues([['CUSIP', 'QuarterTag', 'LastFetched', 'JSON']]).setFontWeight('bold').setBackground('#eceff1');
    }
    const lastRow = sh.getLastRow();
    let targetRow = null;
    if (lastRow >= 2) {
      const cusips = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < cusips.length; i++) {
        if (String(cusips[i][0]) === String(cusip)) { targetRow = i + 2; break; }
      }
    }
    if (!targetRow) targetRow = lastRow + 1;
    sh.getRange(targetRow, 1, 1, 4).setValues([[String(cusip), quarterTag, new Date().toISOString(), JSON.stringify(data)]]);
  } catch (e) { /* non-fatal -- caching is supplementary, must never block a real report */ }
}

function readBrokerDataCacheV1_(ticker) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CACHE_BROKER_DATA_SHEET_NAME_V1);
    if (!sh) return null;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return null;
    const rows = sh.getRange(2, 1, lastRow - 1, 6).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).toUpperCase() === String(ticker).toUpperCase()) {
        const date = rows[i][1] instanceof Date ? rows[i][1] : new Date(rows[i][1]);
        const ageDays = (Date.now() - date.getTime()) / 86400000;
        if (ageDays > BROKER_DATA_CACHE_STALE_DAYS_V1) return null; // real, disclosed: stale cache treated as unavailable, not shown silently outdated
        // 2026-09-06, real fix (Opus review caught this): real Google
        // Sheets auto-coerces a date-shaped string ("09/15/2026") into a
        // real Date object on write -- every consumer of settlementDate
        // elsewhere in this codebase expects a raw string, not a Date. A
        // mocked-SpreadsheetApp test can't catch this (mocks don't
        // coerce), only a real Sheet does. Explicitly re-stringified here
        // (ISO yyyy-mm-dd, this project's own established date-string
        // convention) so the return type is always a string regardless of
        // what the real Sheet did to the stored cell.
        const rawSettlement = rows[i][4];
        const settlementDate = !rawSettlement ? null : (rawSettlement instanceof Date ? rawSettlement.toISOString().slice(0, 10) : String(rawSettlement));
        return {
          date,
          shortInterest: rows[i][2] === '' ? null : Number(rows[i][2]),
          daysToCover: rows[i][3] === '' ? null : Number(rows[i][3]),
          settlementDate,
          interestCoverageRatio: rows[i][5] === '' ? null : Number(rows[i][5])
        };
      }
    }
    return null;
  } catch (e) { return null; } // real, disclosed: any cache-read problem returns null (same as "not available"), never blocks a report
}

function writeBrokerDataCacheV1_(ticker, data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(CACHE_BROKER_DATA_SHEET_NAME_V1);
    if (!sh) {
      sh = ss.insertSheet(CACHE_BROKER_DATA_SHEET_NAME_V1);
      sh.getRange(1, 1, 1, 6).setValues([['Ticker', 'Date', 'ShortInterest', 'DaysToCover', 'SettlementDate', 'InterestCoverageRatio']]).setFontWeight('bold').setBackground('#eceff1');
    }
    const lastRow = sh.getLastRow();
    let targetRow = null;
    if (lastRow >= 2) {
      const tickers = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < tickers.length; i++) {
        if (String(tickers[i][0]).toUpperCase() === String(ticker).toUpperCase()) { targetRow = i + 2; break; }
      }
    }
    if (!targetRow) targetRow = lastRow + 1;
    sh.getRange(targetRow, 1, 1, 6).setValues([[
      String(ticker).toUpperCase(), new Date(),
      data.shortInterest != null ? data.shortInterest : '',
      data.daysToCover != null ? data.daysToCover : '',
      data.settlementDate || '',
      data.interestCoverageRatio != null ? data.interestCoverageRatio : ''
    ]]);
  } catch (e) { /* non-fatal -- caching is supplementary, must never block a real report */ }
}

function readMacroSnapshotV1_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CACHE_MACRO_SNAPSHOT_SHEET_NAME_V1);
    if (!sh || sh.getLastRow() < 2) return null;
    const row = sh.getRange(2, 1, 1, 4).getValues()[0];
    const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    const ageDays = (Date.now() - date.getTime()) / 86400000;
    if (ageDays > BROKER_DATA_CACHE_STALE_DAYS_V1) return null; // real, disclosed: stale -> treated as unavailable
    return {
      date,
      dgs10: row[1] ? JSON.parse(row[1]) : null,
      fedfunds: row[2] ? JSON.parse(row[2]) : null,
      gdpSeries: row[3] ? JSON.parse(row[3]) : null
    };
  } catch (e) { return null; }
}

function writeMacroSnapshotV1_(dgs10, fedfunds, gdpSeries) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(CACHE_MACRO_SNAPSHOT_SHEET_NAME_V1);
    if (!sh) {
      sh = ss.insertSheet(CACHE_MACRO_SNAPSHOT_SHEET_NAME_V1);
      sh.getRange(1, 1, 1, 4).setValues([['Date', 'DGS10 (JSON)', 'FEDFUNDS (JSON)', 'GDPC1 (JSON)']]).setFontWeight('bold').setBackground('#eceff1');
    }
    sh.getRange(2, 1, 1, 4).setValues([[
      new Date(),
      dgs10 ? JSON.stringify(dgs10) : '',
      fedfunds ? JSON.stringify(fedfunds) : '',
      gdpSeries ? JSON.stringify(gdpSeries) : ''
    ]]);
  } catch (e) { /* non-fatal -- caching is supplementary, must never block a real report */ }
}

function fetchInsiderTradingNet(ticker, log) {
  const url = 'https://financialmodelingprep.com/stable/insider-trading/search?symbol=' + ticker + '&page=0&limit=50&apikey=' + FMP_API_KEY;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      if (resp.getResponseCode() === 402) {
        if (log) log('  FMP [insider-trading] HTTP 402 -- confirmed via real run: this endpoint requires a plan tier this API key doesn\'t have. Not a parameter-naming issue -- the symbol= assumption is fine, this data just isn\'t accessible on the current plan.');
      } else if (log) {
        log('  FMP [insider-trading] HTTP ' + resp.getResponseCode() + ' -- the symbol= parameter assumption may be wrong for this endpoint');
      }
      return null;
    }
    const body = resp.getContentText();
    if (!body || body.length < 5) return null;
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return null;
    if (list[0] && list[0].acquistionOrDisposition === undefined) {
      if (log) log('  ⚠ WARNING: expected "acquistionOrDisposition" field not found on FMP insider-trading response for ' + ticker + ' -- field-name assumption may be wrong, needs investigating.');
      return null;
    }
    let sharesAcquired = 0, sharesDisposed = 0, purchaseCount = 0, saleCount = 0;
    list.forEach(t => {
      if (!t || !t.acquistionOrDisposition) return;
      const shares = Number(t.securitiesTransacted) || 0;
      if (t.acquistionOrDisposition === 'A') { sharesAcquired += shares; purchaseCount++; }
      else if (t.acquistionOrDisposition === 'D') { sharesDisposed += shares; saleCount++; }
    });
    const netShares = sharesAcquired - sharesDisposed;
    return {
      sharesAcquired, sharesDisposed, netShares, purchaseCount, saleCount,
      transactionsAnalyzed: list.length,
      netBuying: netShares > 0
    };
  } catch (e) {
    if (log) log('  FMP [insider-trading] error: ' + e.message.substring(0, 60));
    return null;
  }
}

function fetchTreasuryRate10Y(log) {
  const url = 'https://financialmodelingprep.com/stable/treasury-rates?apikey=' + FMP_API_KEY;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      if (log) log('  FMP [treasury-rates] HTTP ' + resp.getResponseCode());
      return null;
    }
    const body = resp.getContentText();
    if (!body || body.length < 5) return null;
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) return null;
    if (list[0] && list[0].year10 === undefined) {
      if (log) log('  ⚠ WARNING: expected "year10" field not found on FMP treasury-rates response -- field-name assumption may be wrong, needs investigating. Real fields present: ' + Object.keys(list[0]).join(', '));
      return null;
    }
    // Most recent entry is expected first -- consistent with every other
    // FMP list endpoint already used in this codebase (earnings, insider
    // trading), not a new assumption.
    const latest = list[0];
    return { year10: Number(latest.year10), date: latest.date };
  } catch (e) {
    if (log) log('  FMP [treasury-rates] error: ' + e.message.substring(0, 60));
    return null;
  }
}

function fetchFMPFundamentals(ticker, log) {
  // v3 (/api/v3/) is a legacy dead end since Aug 2025 (HTTP 403 "Legacy Endpoint").
  // Migrated to the current /stable/ API — same key works, params are ?symbol=TICKER.
  const BASE = 'https://financialmodelingprep.com/stable/';
  const K = FMP_API_KEY;
  // addKey uses & or ? correctly (stable URLs already carry ?symbol=, so & is appended)
  function addKey(url) { return url + (url.includes('?') ? '&' : '?') + 'apikey=' + K; }

  let premiumBlocked = false;
  let rateLimited = false;

  function safeFetch(label, url) {
    try {
      const res  = UrlFetchApp.fetch(addKey(url), {muteHttpExceptions:true});
      const code = res.getResponseCode();
      const body = res.getContentText();
      // Daily quota (free tier ≈ 250 calls/day) → HTTP 429 "Limit Reach".
      if (code === 429 || (body && body.indexOf('Limit Reach') !== -1)) { rateLimited = true; if(log) log('  FMP ['+label+'] rate-limited (HTTP '+code+' — free tier ~250 calls/day, resets midnight ET)'); return null; }
      // FMP free tier gates certain tickers behind a paid plan → HTTP 402 "not available under your current subscription".
      if (code === 402 || (body && body.indexOf('current subscription') !== -1)) { premiumBlocked = true; if(log) log('  FMP ['+label+'] premium-gated (HTTP '+code+' — symbol not covered on free plan)'); return null; }
      if (code !== 200) { if(log) log('  FMP ['+label+'] HTTP '+code); return null; }
      if (!body || body.length < 5) return null;
      const p = JSON.parse(body);
      if (p && (p['Error Message'] || p['errors'])) { if(log) log('  FMP ['+label+'] access denied'); return null; }
      return Array.isArray(p) ? (p[0]||null) : p;
    } catch(e) { if(log) log('  FMP ['+label+'] '+e.message.substring(0,50)); return null; }
  }

  const profile = safeFetch('profile',      BASE+'profile?symbol='+ticker);
  const ratios  = safeFetch('ratios-ttm',   BASE+'ratios-ttm?symbol='+ticker);
  const metrics = safeFetch('metrics-ttm',  BASE+'key-metrics-ttm?symbol='+ticker);
  // Phase 2 fix (2.2.1): the endpoint's default period without an explicit
  // `period=` param could not be confirmed from FMP's public docs (search
  // found the param exists — annual|quarter — but not the unstated default).
  // Rather than guess, made it explicit: period=annual. This also means
  // FMP's revenueGrowth is now KNOWN to be annual, not an assumption — used
  // in the cross-ref period-mismatch note below.
  const growth  = safeFetch('growth',       BASE+'financial-growth?symbol='+ticker+'&period=annual&limit=1');
  const target  = safeFetch('target',       BASE+'price-target-consensus?symbol='+ticker);
  const rating  = safeFetch('rating',       BASE+'ratings-snapshot?symbol='+ticker);

  if (!profile && !ratios && !metrics) { if(log) log('  FMP: all core endpoints failed'); return null; }
  if (log) { const prem=[ratios,metrics,growth,target,rating].filter(x=>x==null).length;
    log('  FMP: profile OK'+(prem>0?' — '+prem+'/5 premium endpoints unavailable ('+(rateLimited?'rate-limited':premiumBlocked?'not covered on free plan for '+ticker:'no data')+')':' — full fundamentals loaded')); }

  // P0-1 fix (deep-dive review): FMP was the only provider fetch function
  // with no numeric coercion — a string P/E from FMP would crash
  // peValue.toFixed(1) downstream. Matches the num() pattern already used
  // by fetchFinnhubFundamentals/fetchAlphaVantageFundamentals.
  const num = v => { if(v==null) return null; const n=parseFloat(v); return isNaN(n)?null:n; };
  // P1-3 fix: pick() previously rejected a real 0 (0% growth, $0 dividend)
  // as if it were missing data, falling through to the next value or null.
  const pick = (...vals) => vals.find(v => v!=null && v!=='') ?? null;
  // stable /ratings-snapshot returns a letter grade (A best … F worst) + overallScore 1-5 (5 best).
  // Downstream scoring expects recMean on a 1=Strong Buy … 5=Strong Sell scale, so map the letter.
  let recMean=null, recKey='';
  if (rating) {
    recKey = rating.rating || '';
    const m={'A':1,'B':2,'C':3,'D':4,'F':5};
    recMean = m[String(recKey).charAt(0).toUpperCase()] || null;
  }

  const fund = {
    _source:'fmp',
    // Phase 2 fix (2.2.0): Phase 0's audit confirmed FMP's contribution here was
    // ALWAYS trailing (priceToEarningsRatioTTM) despite being stored in a field
    // called "forwardPE" — this endpoint has no forward P/E at all. Fixed:
    // forwardPE is honestly null for FMP; trailingPE carries the real number.
    forwardPE     : null,
    trailingPE    : num(pick(ratios&&ratios.priceToEarningsRatioTTM)),
    pegRatio      : num(pick(ratios&&ratios.priceToEarningsGrowthRatioTTM)),
    priceToBook   : num(pick(ratios&&ratios.priceToBookRatioTTM)),
    profitMargins : num(pick(ratios&&ratios.netProfitMarginTTM)),
    grossMargins  : num(pick(ratios&&ratios.grossProfitMarginTTM)),
    returnOnEquity: num(pick(metrics&&metrics.returnOnEquityTTM)),
    returnOnAssets: num(pick(metrics&&metrics.returnOnAssetsTTM)),
    revenueGrowth : num(pick(growth&&growth.revenueGrowth)),
    earningsGrowth: num(pick(growth&&growth.netIncomeGrowth, growth&&growth.epsgrowth)),
    beta          : num(pick(profile&&profile.beta)),
    marketCap     : num(pick(profile&&profile.marketCap)),
    dividend      : num(pick(profile&&profile.lastDividend)),
    price         : num(pick(profile&&profile.price)),
    sector        : pick(profile&&profile.sector),
    industry      : pick(profile&&profile.industry),
    targetMean    : num(pick(target&&target.targetConsensus, target&&target.targetMedian)),
    targetHigh    : num(pick(target&&target.targetHigh)),
    targetLow     : num(pick(target&&target.targetLow)),
    numAnalysts   : num(pick(target&&target.numberOfAnalystOpinions)),
    // Balance sheet health (ENGINE_GAP_ANALYSIS.md Section 6 /
    // DASHBOARD_IMPROVEMENTS_PLAN.md 4a) -- confirmed real field names
    // from FMP's own documentation before adding, same ratios-ttm
    // response already being fetched for other fields above, zero new
    // network call, zero new risk to what's already working. Search
    // evidence was ambiguous about whether freeCashFlowPerShareTTM lives
    // on ratios-ttm or key-metrics-ttm specifically -- checking both
    // rather than guessing which one, matching pick()'s own existing
    // fallback design.
    debtToEquity  : num(pick(ratios&&ratios.debtToEquityRatioTTM)),
    currentRatio  : num(pick(ratios&&ratios.currentRatioTTM)),
    quickRatio    : num(pick(ratios&&ratios.quickRatioTTM)), // same ratios-ttm endpoint, same field-naming pattern as currentRatio -- not independently confirmed with a real sample, same honesty standard as the other unconfirmed FMP field assumptions in this file (real risk if wrong: this specific field silently stays null, doesn't break anything else)
    fcfPerShare   : num(pick(ratios&&ratios.freeCashFlowPerShareTTM, metrics&&metrics.freeCashFlowPerShareTTM)),
    recMean, recKey,
    strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
    shortRatio:null, institutionPct:null,
    _premiumBlocked: premiumBlocked,
    _rateLimited: rateLimited
  };

  // P1-3 fix: hasData previously only checked forwardPE, which is now
  // ALWAYS null for FMP by design (Phase 2's honest split) — meaning an
  // FMP result with real trailingPE data was being discarded entirely.
  const hasData = fund.forwardPE||fund.trailingPE||fund.revenueGrowth||fund.targetMean||fund.profitMargins||fund.returnOnEquity||fund.beta;
  if (!hasData) { if(log) log('  FMP: connected but all fields null for '+ticker); return null; }
  return fund;
}

function fetchAlphaVantageFundamentals(ticker, log) {
  try {
    if (!ALPHAVANTAGE_KEY) return null;
    const url = 'https://www.alphavantage.co/query?function=OVERVIEW&symbol=' + encodeURIComponent(ticker) + '&apikey=' + ALPHAVANTAGE_KEY;
    const res = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
    if (res.getResponseCode() !== 200) { if(log) log('  AV HTTP ' + res.getResponseCode()); return null; }
    const d = JSON.parse(res.getContentText() || '{}');
    // Rate-limit / demo-key / info responses come back as {Note:...} or {Information:...}
    if (d.Note || d.Information) { if(log) log('  AV: ' + String(d.Note||d.Information).substring(0,70)); return null; }
    if (!d.Symbol || Object.keys(d).length < 5) { if(log) log('  AV: no fundamentals for ' + ticker); return null; }

    const num = v => { if(v==null) return null; const s=String(v).trim(); if(s===''||s==='None'||s==='-'||s==='NaN') return null; const n=parseFloat(s); return isNaN(n)?null:n; };
    const tc  = s => String(s).toLowerCase().replace(/\b\w/g, c=>c.toUpperCase());
    // AV gives analyst rating counts; map to a 1=Strong Buy … 5=Strong Sell mean.
    const sb=num(d.AnalystRatingStrongBuy)||0, b=num(d.AnalystRatingBuy)||0, h=num(d.AnalystRatingHold)||0,
          sl=num(d.AnalystRatingSell)||0, ss=num(d.AnalystRatingStrongSell)||0;
    const totRec = sb+b+h+sl+ss;
    const recMean = totRec ? (1*sb+2*b+3*h+4*sl+5*ss)/totRec : null;
    const recKey  = recMean==null ? '' : (recMean<1.5?'Strong Buy':recMean<2.5?'Buy':recMean<3.5?'Hold':recMean<4.5?'Sell':'Strong Sell');

    return {
      _source:'alphavantage',
      forwardPE     : num(d.ForwardPE), // Phase 2 fix (2.2.0): no longer silently falls back to trailing — null means AV genuinely has no forward estimate
      trailingPE    : num(d.PERatio), // new field — the actual trailing multiple, tracked separately from forward
      pegRatio      : num(d.PEGRatio),
      priceToBook   : num(d.PriceToBookRatio),
      profitMargins : num(d.ProfitMargin),
      grossMargins  : null,
      returnOnEquity: num(d.ReturnOnEquityTTM),
      returnOnAssets: num(d.ReturnOnAssetsTTM),
      revenueGrowth : num(d.QuarterlyRevenueGrowthYOY),
      earningsGrowth: num(d.QuarterlyEarningsGrowthYOY),
      beta          : num(d.Beta),
      marketCap     : num(d.MarketCapitalization),
      // v9.31: SharesFloat is a raw share count (verified live: JKS returned
      // "30297200"), unlike Finnhub's millions convention -- no *1e6 here.
      shareFloat    : num(d.SharesFloat),
      dividend      : num(d.DividendPerShare),
      price         : null,
      sector        : (d.Sector && d.Sector!=='None') ? tc(d.Sector) : null,
      industry      : (d.Industry && d.Industry!=='None') ? tc(d.Industry) : null,
      targetMean    : num(d.AnalystTargetPrice),
      targetHigh    : null,
      targetLow     : null,
      numAnalysts   : totRec||null,
      recMean, recKey,
      strongBuy:sb, buy:b, hold:h, sell:sl, strongSell:ss,
      shortRatio:null, institutionPct:null,
      _premiumBlocked:false, _rateLimited:false
    };
  } catch(e) { if(log) log('  AV error: ' + e.message.substring(0,50)); return null; }
}

function getCachedFundamentals(ticker) {
  try { const r=PropertiesService.getScriptProperties().getProperty('FUND_'+ticker); return r?JSON.parse(r):null; } catch(e) { return null; }
}

function saveFundamentalsCache(ticker, fund) {
  try { PropertiesService.getScriptProperties().setProperty('FUND_'+ticker, JSON.stringify({data:fund,date:new Date().toLocaleDateString()})); } catch(e) {}
}

function fetchNasdaqShortInterestV7(ticker) {
  try {
    const url = 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/short-interest?assetclass=stocks';
    const res = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nasdaq.com/' },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const rows = j && j.data && j.data.shortInterestTable && j.data.shortInterestTable.rows;
    if (!rows || !rows[0] || !rows[0].interest) return null;
    return { shortInterest: parseInt(rows[0].interest.replace(/,/g, ''), 10), settlementDate: rows[0].settlementDate, daysToCover: rows[0].daysToCover };
  } catch (e) { return null; }
}


// ── Pass 2, 2026-09-07: brokerCourseModelV1.gs's own real fetch calls,
// moved verbatim, same discipline as Pass 1 above (SPDR/QQQ top-10
// holdings, FRED series, Nasdaq short interest, SEC EDGAR CIK/shares-
// outstanding/filing-keyword search, FMP interest coverage), plus the 2
// real nightly-refresh orchestrators that call them + the Pass-1 cache
// writers (readBrokerDataCacheV1_/writeBrokerDataCacheV1_/
// readMacroSnapshotV1_/writeMacroSnapshotV1_, already here from Pass 1). ──
function fetchSpdrEtfTopHoldingsV1(ticker) {
  if (SPDR_ETF_TICKERS_V1.indexOf(ticker) < 0) return null; // real, disclosed scope limit
  try {
    var url = 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-' + ticker.toLowerCase() + '.xlsx';
    var resp = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    var blob = resp.getBlob();
    var files = Utilities.unzip(blob);
    var sharedStringsFile = files.filter(function(f) { return f.getName().indexOf('sharedStrings.xml') >= 0; })[0];
    var sheetFile = files.filter(function(f) { return f.getName().indexOf('worksheets/sheet1.xml') >= 0; })[0];
    if (!sharedStringsFile || !sheetFile) return null;
    var sharedStrings = parseSpdrSharedStringsV1_(sharedStringsFile.getDataAsString());
    var holdings = parseSpdrHoldingsV1_(sheetFile.getDataAsString(), sharedStrings, 10);
    if (!holdings.length) return null;
    var totalWeight = holdings.reduce(function(s, h) { return s + h.weightPct; }, 0);
    return { holdings: holdings, top10ConcentrationPct: totalWeight };
  } catch (e) { return null; }
}

function fetchQqqTopHoldingsV1(ticker) {
  if (ticker !== 'QQQ') return null; // real, disclosed scope limit -- only QQQ's real SEC path is verified; SMH's CIK was never located (KNOWN_GAPS_AND_RISKS.md)
  const cacheKey = 'QQQ_NPORT_HOLDINGS_V1';
  const cached = (typeof cacheGet === 'function') ? cacheGet(cacheKey) : null;
  if (cached !== null && cached !== undefined) return cached;
  try {
    const cik = fetchSecEdgarCIKV1('QQQ');
    if (!cik) return null;
    const subRes = UrlFetchApp.fetch('https://data.sec.gov/submissions/CIK' + cik + '.json', {
      headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' }, muteHttpExceptions: true
    });
    if (subRes.getResponseCode() !== 200) return null;
    const sub = JSON.parse(subRes.getContentText());
    const recent = sub.filings && sub.filings.recent;
    if (!recent || !recent.form) return null;
    let accession = null;
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === 'NPORT-P') { accession = recent.accessionNumber[i]; break; }
    }
    if (!accession) return null; // real, disclosed: no NPORT-P filing found in the recent window
    const accessionNoDash = accession.replace(/-/g, '');
    const cikNoLeadingZeros = String(parseInt(cik, 10));
    const docUrl = 'https://www.sec.gov/Archives/edgar/data/' + cikNoLeadingZeros + '/' + accessionNoDash + '/primary_doc.xml';
    const docRes = UrlFetchApp.fetch(docUrl, { headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' }, muteHttpExceptions: true });
    if (docRes.getResponseCode() !== 200) return null;
    const xml = docRes.getContentText();
    const recs = xml.match(/<invstOrSec>[\s\S]*?<\/invstOrSec>/g) || [];
    const byName = {};
    recs.forEach(function(r) {
      const nameM = r.match(/<name>([\s\S]*?)<\/name>/);
      const pctM = r.match(/<pctVal>([\s\S]*?)<\/pctVal>/);
      if (!nameM || !pctM) return;
      const name = nameM[1].trim();
      const pct = parseFloat(pctM[1]);
      if (!Number.isFinite(pct)) return;
      byName[name] = (byName[name] || 0) + pct; // real, disclosed: combines multi-class same-issuer records (e.g. Alphabet GOOGL/GOOG)
    });
    const holdings = Object.keys(byName).map(function(name) { return { name: name, weightPct: byName[name] }; })
      .sort(function(a,b) { return b.weightPct - a.weightPct; })
      .slice(0, 10);
    if (!holdings.length) return null;
    const totalWeight = holdings.reduce(function(s,h) { return s + h.weightPct; }, 0);
    const result = { holdings: holdings, top10ConcentrationPct: totalWeight, filingDate: recent.filingDate[recent.accessionNumber.indexOf(accession)] };
    if (typeof cacheSet === 'function') cacheSet(cacheKey, result, 24 * 30); // 30 days -- real, quarterly filing cadence
    return result;
  } catch (e) { return null; }
}

function fetchFredSeriesV1(seriesId) {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + seriesId;
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const lines = res.getContentText().split('\n').filter(l => l.trim().length);
    const values = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 2) continue;
      const v = parseFloat(parts[1]);
      if (!isNaN(v)) values.push(v);
    }
    return values;
  } catch (e) { return null; }
}

function fetchNasdaqShortInterestV1(ticker) {
  const url = 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/short-interest?assetclass=stocks';
  try {
    const res = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nasdaq.com/' },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const rows = j && j.data && j.data.shortInterestTable && j.data.shortInterestTable.rows;
    if (!rows || !rows[0] || !rows[0].interest) return null;
    return {
      shortInterest: parseInt(rows[0].interest.replace(/,/g, ''), 10),
      settlementDate: rows[0].settlementDate,
      daysToCover: rows[0].daysToCover
    };
  } catch (e) { return null; }
}

function fetchSecEdgarCIKV1(ticker) {
  const cacheKey = 'CIK_' + String(ticker).toUpperCase();
  const cached = (typeof cacheGet === 'function') ? cacheGet(cacheKey) : null;
  if (cached !== null && cached !== undefined) return cached;
  try {
    const res = UrlFetchApp.fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const data = JSON.parse(res.getContentText());
    const upperTicker = ticker.toUpperCase();
    for (const key in data) {
      if (data[key].ticker === upperTicker) {
        const cik = String(data[key].cik_str);
        const result = '0'.repeat(Math.max(0, 10 - cik.length)) + cik;
        if (typeof cacheSet === 'function') cacheSet(cacheKey, result, 24 * 90); // 90 days
        return result;
      }
    }
    return null; // real "no CIK found" (e.g. SMH, VanEck) -- deliberately NOT cached, so a real future filing doesn't stay permanently invisible
  } catch (e) { return null; }
}

function fetchSharesOutstandingHistoryV1(cik) {
  if (!cik) return null;
  try {
    const url = 'https://data.sec.gov/api/xbrl/companyconcept/CIK' + cik + '/us-gaap/CommonStockSharesOutstanding.json';
    const res = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const data = JSON.parse(res.getContentText());
    const shares = data.units && data.units.shares;
    if (!shares || !shares.length) return null;
    // Real, disclosed dedup: multiple filings often restate the SAME
    // period (a 10-Q's figure later reappearing in the annual 10-K) —
    // keep the latest-FILED value per distinct `end` date.
    const byEnd = {};
    shares.forEach(s => {
      if (!byEnd[s.end] || new Date(s.filed) > new Date(byEnd[s.end].filed)) byEnd[s.end] = s;
    });
    return Object.keys(byEnd).map(k => byEnd[k]).sort((a, b) => new Date(a.end) - new Date(b.end))
      .map(s => ({ date: s.end, value: s.val }));
  } catch (e) { return null; }
}

function fetchSecFilingKeywordHitsV1(cik, sinceDate) {
  if (!cik) return null;
  const cikNum = String(parseInt(cik, 10));
  const results = {};
  SEC_DILUTION_KEYWORDS_V1.forEach(kw => {
    try {
      let url = 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent('"' + kw + '"') +
        '&ciks=' + ('0'.repeat(Math.max(0, 10 - cikNum.length)) + cikNum);
      if (sinceDate) {
        url += '&dateRange=custom&startdt=' + sinceDate + '&enddt=' + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
      }
      const res = UrlFetchApp.fetch(url, {
        headers: { 'User-Agent': 'BrokerCourseModelV1 research contact@example.com' },
        muteHttpExceptions: true
      });
      // v9.46 fix: parsed the same JSON response twice per keyword (10
      // parses/report). Also a real edge-case bug: `X && X.total.value`
      // yields `undefined` (not a clean 0/null) whenever `.total` itself
      // is falsy -- parsed once now, with an explicit fallback chain.
      if (res.getResponseCode() === 200) {
        const parsed = JSON.parse(res.getContentText());
        const total = parsed && parsed.hits && parsed.hits.total;
        results[kw] = total ? total.value : 0;
      } else {
        results[kw] = null;
      }
    } catch (e) { results[kw] = null; }
  });
  return results;
}

function fetchFMPInterestCoverageV1(ticker) {
  try {
    const url = 'https://financialmodelingprep.com/stable/ratios-ttm?symbol=' + ticker + '&apikey=' + FMP_API_KEY;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const list = JSON.parse(res.getContentText());
    if (!Array.isArray(list) || !list[0] || list[0].interestCoverageRatioTTM == null) return null;
    return list[0].interestCoverageRatioTTM;
  } catch (e) { return null; }
}

function refreshBrokerCourseDataCacheV1_(ticker, log) {
  try {
    const existing = (typeof readBrokerDataCacheV1_ === 'function') ? readBrokerDataCacheV1_(ticker) : null;
    if (existing) return; // real, disclosed: readBrokerDataCacheV1_ itself already treats a stale cache as null, so a non-null result here IS fresh -- nothing to do
    const shortInterest = fetchNasdaqShortInterestV1(ticker);
    const interestCoverageRatio = fetchFMPInterestCoverageV1(ticker);
    // 2026-09-06, real fix (Opus review caught this): this function
    // reintroduced the EXACT same cache-poisoning pattern the 13F fix just
    // closed -- writing unconditionally even when BOTH real fetches failed
    // (a real, transient Nasdaq/FMP outage) meant an all-null row got
    // written with today's date, and readBrokerDataCacheV1_ treats ANY
    // non-null row as fresh -- silently blocking every retry for the next
    // BROKER_DATA_CACHE_STALE_DAYS_V1 days. Now only writes when at least
    // one of the two real fetches actually returned real data.
    if (shortInterest == null && interestCoverageRatio == null) {
      if (log) log('  ⚠ Broker data cache NOT written for ' + ticker + ' -- both real fetches failed (Nasdaq + FMP), real transient failure, will retry next run');
      return;
    }
    if (typeof writeBrokerDataCacheV1_ === 'function') {
      writeBrokerDataCacheV1_(ticker, {
        shortInterest: shortInterest ? shortInterest.shortInterest : null,
        daysToCover: shortInterest ? shortInterest.daysToCover : null,
        settlementDate: shortInterest ? shortInterest.settlementDate : null,
        interestCoverageRatio
      });
    }
    if (log) log('  💾 Broker data cache refreshed for ' + ticker + ' (short-interest' + (shortInterest ? '' : ': n/a') + ', interest-coverage' + (interestCoverageRatio != null ? '' : ': n/a') + ')');
  } catch (e) { if (log) log('  ⚠ Broker data cache refresh failed for ' + ticker + ': ' + e.message); } // non-fatal, never blocks the rest of the automation loop
}

function refreshMacroSnapshotV1_(log) {
  try {
    const existing = (typeof readMacroSnapshotV1_ === 'function') ? readMacroSnapshotV1_() : null;
    if (existing) return;
    const dgs10Raw = fetchFredSeriesV1('DGS10');
    const fedfundsRaw = fetchFredSeriesV1('FEDFUNDS');
    const gdpSeriesRaw = fetchFredSeriesV1('GDPC1');
    if (dgs10Raw == null && fedfundsRaw == null && gdpSeriesRaw == null) {
      if (log) log('  ⚠ Macro snapshot NOT written -- all 3 real FRED fetches failed, real transient failure, will retry next run');
      return;
    }
    const dgs10 = dgs10Raw ? dgs10Raw.slice(-20) : null;
    const fedfunds = fedfundsRaw ? fedfundsRaw.slice(-12) : null;
    const gdpSeries = gdpSeriesRaw ? gdpSeriesRaw.slice(-8) : null;
    if (typeof writeMacroSnapshotV1_ === 'function') writeMacroSnapshotV1_(dgs10, fedfunds, gdpSeries);
    if (log) log('  💾 Macro snapshot refreshed (DGS10' + (dgs10 ? '' : ': n/a') + ', FEDFUNDS' + (fedfunds ? '' : ': n/a') + ', GDPC1' + (gdpSeries ? '' : ': n/a') + ')');
  } catch (e) { if (log) log('  ⚠ Macro snapshot refresh failed: ' + e.message); } // non-fatal, never blocks the rest of the automation
}


// ── Pass 3, 2026-09-07: darkPoolTrackerV1.gs's own 2 real fetch-owning
// functions, moved verbatim. Its 3 trigger handlers deliberately stayed
// put (wrap analysis functions, not raw fetch+cache plumbing). ──
function findLatestPublishedFinraWeekV1_(tierIdentifier) {
  const MAX_WEEKS_BACK = 8;
  let monday = mostRecentMondayV1_(new Date());
  for (let i = 0; i < MAX_WEEKS_BACK; i++) {
    const dateStr = Utilities.formatDate(monday, 'America/New_York', 'yyyy-MM-dd');
    try {
      const resp = UrlFetchApp.fetch(FINRA_ATS_WEEKLY_URL_V1, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({
          compareFilters: [
            finraCompareFilterV1_('weekStartDate', dateStr),
            finraCompareFilterV1_('tierIdentifier', tierIdentifier)
          ],
          limit: 1
        }),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        const body = resp.getContentText();
        if (body && body.trim() && body.trim() !== '[]') return dateStr;
      }
    } catch (e) { /* real network hiccup on this probe -- keep walking back */ }
    monday = new Date(monday.getTime() - 7 * 86400000);
  }
  return null; // real, disclosed: nothing published within the lookback window
}

function fetchFinraAtsWeeklyBatchV1_(tickers, tierIdentifier, weekStartDate) {
  const out = {};
  if (!tickers || !tickers.length || !weekStartDate) return out;
  const buildPayload = (t) => JSON.stringify({
    compareFilters: [
      finraCompareFilterV1_('issueSymbolIdentifier', t),
      finraCompareFilterV1_('weekStartDate', weekStartDate),
      finraCompareFilterV1_('tierIdentifier', tierIdentifier)
    ],
    limit: 50
  });
  try {
    const requests = tickers.map(t => ({
      url: FINRA_ATS_WEEKLY_URL_V1, method: 'post', contentType: 'application/json',
      payload: buildPayload(t), muteHttpExceptions: true
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    tickers.forEach((t, i) => {
      try {
        const code = responses[i].getResponseCode();
        out[t] = (code === 200) ? (JSON.parse(responses[i].getContentText() || '[]')) : null;
      } catch (e) { out[t] = null; }
    });
  } catch (e) {
    // Real, disclosed fallback, same class as the macro batch's own.
    tickers.forEach(t => {
      try {
        const resp = UrlFetchApp.fetch(FINRA_ATS_WEEKLY_URL_V1, {
          method: 'post', contentType: 'application/json', payload: buildPayload(t), muteHttpExceptions: true
        });
        out[t] = (resp.getResponseCode() === 200) ? (JSON.parse(resp.getContentText() || '[]')) : null;
      } catch (e2) { out[t] = null; }
    });
  }
  return out;
}


// ── Pass 4, 2026-09-07: futuresStockAnalysisV3's own real fetch-owning
// functions (options-chain fetch/parse), moved verbatim. selectRecommendedCallV7
// (real selection/scoring) stays put, still calls fetchCboeRawV1_ by name. ──
var _cboeRawChainCacheV1_ = {}; // ticker (uppercased) -> raw CBOE json, or null

function fetchCboeRawV1_(ticker, log) {
  const key = String(ticker).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(_cboeRawChainCacheV1_, key)) return _cboeRawChainCacheV1_[key];
  // 2026-09-07, real fix (item 8): the dedup cache above stops this
  // running 3x per ticker, but nothing guarded the real first fetch
  // itself. Interactive-only (runCompleteTickerAnalysisV7Continued sets
  // _runStartTimeV7 before this ever runs, so the guard is real here, not
  // a no-op) — skip rather than start a live CBOE round-trip when time is
  // already critically tight; the stock dashboard's own graceful-
  // degradation banner already handles "no options data" cleanly.
  if (typeof hasTimeBudgetV7_ === 'function' && !hasTimeBudgetV7_(15000)) {
    if (log) log('⏭ Skipped: CBOE chain fetch (' + key + ') — time budget');
    _cboeRawChainCacheV1_[key] = null;
    return null;
  }
  const urls = [buildUrl(ticker), buildUrl('_' + ticker)]; // '_' prefix = index symbols (SPX, VIX, NDX…)
  let json = null;
  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = UrlFetchApp.fetch(urls[u], { muteHttpExceptions: true });
      const code = resp.getResponseCode();
      if (code === 200) { json = JSON.parse(resp.getContentText()); break; }
      if (log) log('   CBOE HTTP ' + code + ' for ' + urls[u]);
    } catch (e) { if (log) log('   CBOE error: ' + e.message); }
  }
  _cboeRawChainCacheV1_[key] = json;
  return json;
}

function fetchCboeChain(ticker, log) {
  const json = fetchCboeRawV1_(ticker, log);
  if (!json || !json.data || !json.data.options) return null;

  const opts = json.data.options;
  const strike = [], side = [], openInterest = [], volume = [], iv = [], expiration = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o.option) continue;
    const p = parseOcc(o.option);
    strike.push(p.strike);
    side.push(p.side);
    expiration.push(p.expUnix);
    openInterest.push(o.open_interest || 0);
    volume.push(o.volume || 0);
    iv.push(o.iv || 0);
  }
  return {
    s: 'ok',
    underlying: json.data.current_price || null,
    strike: strike, side: side, openInterest: openInterest,
    volume: volume, iv: iv, expiration: expiration
  };
}

function fetchChain(days, ticker, log) {
  const chain = fetchCboeChain(ticker, log);
  if (!chain || !chain.strike || chain.strike.length === 0) return null;
  return chain;
}


// ── Pass 5 (FINAL), 2026-09-07: macro_fetchers_v0_14.gs's own real
// fetch-owning functions + cache helpers + refresh orchestrator, moved
// verbatim. computeDowTheoryConfirmationV1_ (pure analysis) and
// classifyMacroRegimeAt_Macro/alignSeries_Macro/pctChange_Macro (pure math)
// stay in macro_fetchers_v0_15.gs. ──
function parseNasdaqHistoricalResponse_Macro(ticker, resp) {
  if (resp.getResponseCode() !== 200) {
    Logger.log('Fetch failed for ' + ticker + ': HTTP ' + resp.getResponseCode());
    return null;
  }
  let json;
  try { json = JSON.parse(resp.getContentText()); } catch (e) { Logger.log('Parse exception for ' + ticker + ': ' + e.message); return null; }
  const rows = json.data && json.data.tradesTable && json.data.tradesTable.rows;
  if (!rows || !rows.length) { Logger.log('No rows for ' + ticker); return null; }
  // Nasdaq returns newest-first -- reverse to chronological, matching
  // this file's existing (Yahoo-era) oldest-to-newest convention that
  // alignSeries_Macro/classifyMacroRegimeAt_Macro already assume.
  const chrono = rows.slice().reverse();
  const dates=[], closes=[], highs=[], lows=[], volumes=[];
  chrono.forEach(r => {
    const [m,d,y] = r.date.split('/');
    const close = parseFloat(String(r.close).replace(/[$,]/g,''));
    const high = parseFloat(String(r.high).replace(/[$,]/g,''));
    const low = parseFloat(String(r.low).replace(/[$,]/g,''));
    const vol = parseFloat(String(r.volume).replace(/,/g,''));
    if (isNaN(close) || isNaN(high) || isNaN(low)) return; // real data gap -- skip, don't fabricate
    dates.push(new Date(Date.UTC(+y, +m-1, +d))); closes.push(close); highs.push(high); lows.push(low); volumes.push(isNaN(vol)?0:vol);
  });
  if (!dates.length) return null;
  return { ticker, dates, closes, highs, lows, volumes };
}

function nasdaqHistoricalUrl_Macro_(ticker) {
  return 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/historical?assetclass=etf&fromdate=2000-01-01&limit=9999';
}

function fetchHistoricalOHLCV_Macro(ticker) {
  try {
    const resp = UrlFetchApp.fetch(nasdaqHistoricalUrl_Macro_(ticker), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nasdaq.com/' },
      muteHttpExceptions: true
    });
    return parseNasdaqHistoricalResponse_Macro(ticker, resp);
  } catch (e) { Logger.log('Fetch exception for ' + ticker + ': ' + e.message); return null; }
}

function macroPriceCacheSheetName_(ticker) {
  const clean = String(ticker).replace(/[\[\]*/\\?:]/g, '');
  return (MACRO_PRICE_CACHE_SHEET_PREFIX_V0_8 + clean).slice(0, 100);
}

function readMacroPriceCache_(ticker) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(macroPriceCacheSheetName_(ticker));
    if (!sh) return null;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return null; // needs header + >=1 real data row
    const rows = sh.getRange(2, 1, lastRow - 1, 5).getValues();
    const dates=[], highs=[], lows=[], closes=[], volumes=[];
    rows.forEach(r => {
      if (!(r[0] instanceof Date) || isNaN(r[0].getTime())) return;
      dates.push(r[0]); highs.push(r[1]); lows.push(r[2]); closes.push(r[3]); volumes.push(r[4]);
    });
    if (!dates.length) return null;
    return { ticker, dates, closes, highs, lows, volumes };
  } catch (e) { return null; } // real, disclosed: falls through to a real live fetch, never blocks the regime read
}

function writeMacroPriceCache_(ticker, data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = macroPriceCacheSheetName_(ticker);
    let sh = ss.getSheetByName(name);
    if (sh) sh.clearContents(); else sh = ss.insertSheet(name);
    sh.getRange(1,1,1,5).setValues([['Date','High','Low','Close','Volume']]).setFontWeight('bold').setBackground('#eceff1');
    const n = data.dates.length, rows = new Array(n);
    for (let i=0;i<n;i++) rows[i] = [data.dates[i], data.highs[i], data.lows[i], data.closes[i], data.volumes[i]];
    sh.getRange(2,1,n,5).setValues(rows);
    sh.getRange(2,1,n,1).setNumberFormat('yyyy-mm-dd');
  } catch (e) { /* non-fatal -- caching is supplementary */ }
}

function fetchHistoricalOHLCV_MacroBatch(tickers) {
  const out = {};
  if (!tickers || !tickers.length) return out;
  // Real cache check first (v0.8 same pass) -- only the tickers whose
  // cache is missing/stale go into the real fetchAll request. A same-day
  // rerun with every ticker fresh skips the whole real network round-trip
  // entirely, same principle as fetchYahooChart's own cache.
  const needFetch = [];
  tickers.forEach(t => {
    const cached = readMacroPriceCache_(t);
    if (typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(cached)) out[t] = cached;
    else needFetch.push(t);
  });
  if (!needFetch.length) return out;
  try {
    const requests = needFetch.map(t => ({
      url: nasdaqHistoricalUrl_Macro_(t),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nasdaq.com/' },
      muteHttpExceptions: true
      // v0.9: no deadline key here (or on the single-ticker fetch above) --
      // it was never a real, documented UrlFetchApp option to begin with,
      // single-call or batch. If this batch call itself runs long, Apps
      // Script's own overall script execution ceiling is the real backstop,
      // same as always.
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    needFetch.forEach((t, i) => {
      try {
        out[t] = parseNasdaqHistoricalResponse_Macro(t, responses[i]);
        if (out[t]) writeMacroPriceCache_(t, out[t]);
      }
      catch (e) { Logger.log('Batch parse exception for ' + t + ': ' + e.message); out[t] = null; }
    });
  } catch (e) {
    // Real, disclosed fallback: if fetchAll itself throws (e.g. this specific
    // API behaves unexpectedly in the real environment, genuinely unverified
    // until now), fall back to the original sequential path rather than
    // failing the whole macro regime read outright -- slower, but the same
    // real behavior this project already shipped and validated once.
    Logger.log('fetchAll exception, falling back to sequential fetch: ' + e.message);
    needFetch.forEach(t => { out[t] = fetchHistoricalOHLCV_Macro(t); if (out[t]) writeMacroPriceCache_(t, out[t]); });
  }
  return out;
}

function computeMacroSupplementalV1_() {
  const out = { m2YoyGrowthPct: null, m2AsOfDate: null, yieldCurveSpread: null, yieldCurveInverted: null, yieldCurveAsOfDate: null, businessCyclePhase: null };
  try {
    const m2 = fetchM2_Macro();
    if (m2 && m2.values.length >= 13) {
      const latest = m2.values[m2.values.length - 1], yearAgo = m2.values[m2.values.length - 13];
      if (yearAgo) { out.m2YoyGrowthPct = (latest / yearAgo - 1) * 100; out.m2AsOfDate = m2.dates[m2.dates.length - 1]; }
    }
  } catch (e) { Logger.log('computeMacroSupplementalV1_: M2 fetch failed (non-fatal): ' + (e && e.message ? e.message : e)); }
  try {
    const yc = fetchFredSeries_Macro('T10Y2Y');
    if (yc && yc.values.length) {
      out.yieldCurveSpread = yc.values[yc.values.length - 1];
      out.yieldCurveInverted = out.yieldCurveSpread < 0;
      out.yieldCurveAsOfDate = yc.dates[yc.dates.length - 1];
    }
  } catch (e) { Logger.log('computeMacroSupplementalV1_: yield-curve fetch failed (non-fatal): ' + (e && e.message ? e.message : e)); }
  // v9.93, real port from brokerCourseModelV1.gs (docs/CLAUDE_CODE_HANDOFF.md
  // section 3.7's port audit / standing rule 9): real business-cycle phase
  // via FRED's real GDPC1 series + the standard textbook 2-consecutive-
  // negative-quarters recession definition (ep.13's own named 4 phases --
  // expansion/peak/contraction/trough). Same "not coupled to the 9-ticker
  // regime read's own availability" discipline as M2/yield-curve above.
  // Reuses `businessCyclePhaseReadV1()` directly (brokerCourseModelV1.gs),
  // not a duplicated implementation.
  try {
    const gdp = fetchFredSeries_Macro('GDPC1');
    if (gdp && gdp.values.length >= 3 && typeof businessCyclePhaseReadV1 === 'function') {
      const cycle = businessCyclePhaseReadV1(gdp.values);
      if (cycle) out.businessCyclePhase = cycle;
    }
  } catch (e) { Logger.log('computeMacroSupplementalV1_: GDP fetch failed (non-fatal): ' + (e && e.message ? e.message : e)); }
  return out;
}

function refreshMacroRegimeCacheV1() {
  const tickers = ['SPY','TLT','GLD','XLP','XLU','XLV','XLY','XLI','XLB'];
  try {
    const before = tickers.filter(t => { const c = readMacroPriceCache_(t); return typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(c); }).length;
    fetchHistoricalOHLCV_MacroBatch(tickers); // writes cache internally for whatever wasn't already fresh
    const after = tickers.filter(t => { const c = readMacroPriceCache_(t); return typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(c); }).length;
    Logger.log('refreshMacroRegimeCacheV1: ' + before + '/9 already fresh, ' + after + '/9 fresh after refresh.');
  } catch (e) {
    // Real, disclosed, non-fatal -- this trigger runs unattended; a failure
    // here just means the interactive path's cache stays as stale as it was,
    // which is already a handled, graceful degradation, not a crash.
    Logger.log('refreshMacroRegimeCacheV1 failed (non-fatal, interactive path degrades gracefully): ' + (e && e.message ? e.message : e));
  }
  // 2026-09-01 real fix: same cacheSet/cacheGet (PropertiesService)
  // mechanism already used elsewhere in this project -- TTL 30h, same
  // cadence as the 9-ticker cache above.
  try {
    const supplemental = computeMacroSupplementalV1_();
    cacheSet('macroSupplementalV1', supplemental, 30);
    Logger.log('refreshMacroRegimeCacheV1: supplemental cached -- M2 YoY ' + (supplemental.m2YoyGrowthPct != null ? supplemental.m2YoyGrowthPct.toFixed(1) + '%' : 'n/a') + ', yield curve ' + (supplemental.yieldCurveSpread != null ? supplemental.yieldCurveSpread.toFixed(2) : 'n/a'));
  } catch (e) {
    Logger.log('refreshMacroRegimeCacheV1: supplemental cache failed (non-fatal): ' + (e && e.message ? e.message : e));
  }
  // v9.79, Edwards & Magee Ch3-5.1 -- deliberately a SEPARATE, small
  // 2-ticker fetch (DIA/IYT), same "not coupled to the 9-ticker regime
  // read's own availability" discipline as the M2/yield-curve supplemental
  // block just above -- a stale/missing Dow Theory read doesn't hide an
  // otherwise-fresh regime read, and vice versa.
  try {
    const before = DOW_THEORY_TICKERS_V1.filter(t => { const c = readMacroPriceCache_(t); return typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(c); }).length;
    fetchHistoricalOHLCV_MacroBatch(DOW_THEORY_TICKERS_V1); // same real batch-fetch mechanism as the 9-ticker regime basket above
    const after = DOW_THEORY_TICKERS_V1.filter(t => { const c = readMacroPriceCache_(t); return typeof isPriceCacheFreshV7_ === 'function' && isPriceCacheFreshV7_(c); }).length;
    const dowTheory = computeDowTheoryConfirmationV1_();
    cacheSet('dowTheoryConfirmationV1', dowTheory, 30);
    Logger.log('refreshMacroRegimeCacheV1: Dow Theory ' + before + '/2 already fresh, ' + after + '/2 fresh after refresh -- verdict: ' + (dowTheory.verdict || 'n/a'));
  } catch (e) {
    Logger.log('refreshMacroRegimeCacheV1: Dow Theory fetch/cache failed (non-fatal): ' + (e && e.message ? e.message : e));
  }
}

function getCachedMacroSupplementalV1_() {
  // 2026-09-07, v10.0 Pass 5 real fix: cacheGet (PropertiesService wrapper)
  // is defined in the options engine file, not this one -- same
  // cross-file shape as hasTimeBudgetV7_ (item 8), same defensive
  // convention already used elsewhere in this file (13F cache reads).
  // Always present together in the real deployed project; this guard
  // only matters for a standalone/test sandbox that doesn't load it.
  return (typeof cacheGet === 'function') ? cacheGet('macroSupplementalV1') : null; // null if the trigger hasn't run/cached yet -- real, disclosed, non-fatal
}

function getCachedDowTheoryConfirmationV1_() {
  return (typeof cacheGet === 'function') ? cacheGet('dowTheoryConfirmationV1') : null; // null if the trigger hasn't run/cached yet -- real, disclosed, non-fatal
}

function fetchM2_Macro() {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL';
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log('M2 fetch failed: HTTP ' + resp.getResponseCode());
    return null;
  }
  const lines = resp.getContentText().split('\n').filter(l => l.trim().length);
  const header = lines[0];
  if (header.indexOf('observation_date') === -1 && header.indexOf('DATE') === -1) {
    Logger.log('WARNING: unexpected M2 CSV header: ' + header + ' -- field-name assumption may be wrong, check before trusting this data.');
  }
  const dates = [], values = [];
  for (let i=1;i<lines.length;i++) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const v = parseFloat(parts[1]);
    if (isNaN(v)) continue;
    dates.push(parts[0]); values.push(v);
  }
  return { dates, values };
}

function fetchFredSeries_Macro(seriesId) {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + seriesId;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) { Logger.log(seriesId + ' fetch failed: HTTP ' + resp.getResponseCode()); return null; }
  const lines = resp.getContentText().split('\n').filter(l => l.trim().length);
  const dates = [], values = [];
  for (let i=1;i<lines.length;i++) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const v = parseFloat(parts[1]);
    if (isNaN(v)) continue;
    dates.push(parts[0]); values.push(v);
  }
  return { dates, values };
}


// ── Pass 6 (FINAL), 2026-09-07: myOptionsValueTracker.gs's own real
// fetch-owning function + its 2 fetch-only helpers, moved verbatim.
// myOpt_parseDate/myOpt_findTable stay put (general-purpose). ──
function myOpt_buildUrl(ticker) {
  return 'https://cdn.cboe.com/api/global/delayed_quotes/options/' + ticker + '.json';
}

function myOpt_parseOcc(sym) {
  if (!sym || typeof sym !== 'string') return null;

  const match = sym.match(/^([A-Z1-9]+?)(\d{6}|\d{8})([CP])(\d{8})$/i);
  if (!match) return null;

  const dateStr = match[2];
  const cp = match[3].toUpperCase();
  const strikeRaw = parseInt(match[4], 10) / 1000;

  let yy, mm, dd;
  if (dateStr.length === 6) {
    yy = 2000 + parseInt(dateStr.slice(0, 2), 10);
    mm = parseInt(dateStr.slice(2, 4), 10);
    dd = parseInt(dateStr.slice(4, 6), 10);
  } else {
    yy = parseInt(dateStr.slice(0, 4), 10);
    mm = parseInt(dateStr.slice(4, 6), 10);
    dd = parseInt(dateStr.slice(6, 8), 10);
  }

  return { strike: strikeRaw, side: cp === 'C' ? 'call' : 'put', year: yy, month: mm, day: dd };
}

function myOpt_fetchCurrentPrice(ticker, strike, parsedDate, side) {
  const urls = [myOpt_buildUrl(ticker), myOpt_buildUrl('_' + ticker)];
  let json = null;
  const debug = [];

  const fetchOptions = {
    method: 'get',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    },
    muteHttpExceptions: true,
    deadline: 55
  };

  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = UrlFetchApp.fetch(urls[u], fetchOptions);
      const code = resp.getResponseCode();
      const bodySnippet = resp.getContentText().slice(0, 200);
      debug.push(urls[u] + ' -> HTTP ' + code + ' | ' + bodySnippet);
      if (code === 200) {
        json = JSON.parse(resp.getContentText());
        if (json && json.data && json.data.options && json.data.options.length > 0) break;
      }
    } catch (e) {
      debug.push(urls[u] + ' -> EXCEPTION: ' + e);
    }
  }

  Logger.log('🔎 ' + ticker + ' fetch trace:\n' + debug.join('\n'));

  if (!json || !json.data || !json.data.options) {
    return { found: false, reason: 'no chain data returned for ' + ticker };
  }

  const opts = json.data.options;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o || !o.option) continue;

    const p = myOpt_parseOcc(o.option);
    if (!p) continue;
    if (Math.abs(p.strike - strike) > 0.001) continue;
    if (p.side !== side) continue;
    if (p.year !== parsedDate.year || p.month !== parsedDate.month || p.day !== parsedDate.day) continue;

    const bid = Number(o.bid) || 0;
    const ask = Number(o.ask) || 0;
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (Number(o.last_trade_price) || Number(o.close) || null);

    return { found: true, mid: mid };
  }

  const targetReadable = parsedDate.year + '-' + String(parsedDate.month).padStart(2, '0') + '-' + String(parsedDate.day).padStart(2, '0');
  return { found: false, reason: 'no contract for $' + strike + ' ' + side.toUpperCase() + ' ' + targetReadable };
}

