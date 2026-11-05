// ══════════════════════════════════════════════════════════════════════
//  edwardsMageeModelV1.gs — Edwards & Magee Model (Deliverable 1, docs/BIG_PLAN_EDWARDS_MAGEE.md)
//  Built per docs/BIG_PLAN_EDWARDS_MAGEE.md's own Deliverable 1 section,
//  2026-09-02, all 9 Tier 1/Tier 2 additions already shipped (v9.75-v9.81).
//
//  Same pattern as schabackerModelV1.gs: a standalone, separately-cited
//  model — every read in this file traces to a specific chapter of
//  Robert D. Edwards, John Magee & W.H.C. Bassetti's "Technical Analysis
//  of Stock Trends," 9th Edition, per docs/EDWARDS_MAGEE_BOOK_NOTES.md.
//
//  Same real, deliberate design choice as schabackerModelV1.gs: does NOT
//  re-fetch or re-derive anything. `ind`/`gann`/`confluence`/`techPlan`/
//  `chart` are the EXACT SAME objects the main engine (runAnalysisV7)
//  already computed for the SAME ticker in the SAME run — passed straight
//  through. This report is cheap: no new network calls at all (the one
//  genuinely new data dependency — Dow Theory's DIA/IYT, the Evaluative
//  Index's 85-ticker basket — is fetched by its OWN isolated daily
//  trigger elsewhere, macro_fetchers_v0_12.gs/darkPoolTrackerV1.gs, and
//  arrives here already attached to `ind` by runAnalysisV7's own existing
//  wiring, same convention already used for macroSupplemental).
//
//  Same Apps Script project, shared global scope as fullStockAnalysisV9_*.gs,
//  brokerCourseModelV1.gs, and schabackerModelV1.gs (this file's own
//  functions are never called from those files in this phase — wiring
//  happens in the 4-way comparison report phase, not here).
// ══════════════════════════════════════════════════════════════════════

// ── 1. Dow Theory Confirmation read (Ch3-5.1) ───────────────────────────
// Surfaces ind.dowTheoryConfirmation (v9.79, macro_fetchers_v0_12.gs) as
// its own cited output. Market-level, not per-ticker — the same real
// DIA/IYT verdict applies regardless of which ticker is being analyzed.
function edwardsMageeDowTheoryV1_(ind) {
  const dt = ind.dowTheoryConfirmation;
  if (!dt) return { available: false, note: 'Dow Theory Confirmation unavailable (trigger cache stale/missing — see refreshMacroRegimeCacheV1, macro_fetchers_v0_12.gs).' };
  const vLabel = {
    BULL_CONFIRMED: 'BULL CONFIRMED — both DIA (Industrials proxy) & IYT (Transports proxy) at new 52wk closing highs',
    BEAR_CONFIRMED: 'BEAR CONFIRMED — both DIA & IYT at new 52wk closing lows',
    NON_CONFIRMATION_BULL: 'NON-CONFIRMATION — only 1 of DIA/IYT made a new high; the book\'s own real named concept for "distrust the signal"',
    NON_CONFIRMATION_BEAR: 'NON-CONFIRMATION — only 1 of DIA/IYT made a new low; distrust the signal',
    NEUTRAL: 'neutral — neither real broad-market average at a 52wk extreme'
  }[dt.verdict] || dt.verdict;
  return {
    available: true,
    verdict: dt.verdict,
    read: vLabel,
    industrials: dt.industrials, transports: dt.transports,
    note: 'Ch3-5.1 — the book\'s own real foundational rule: both real broad-market averages must independently confirm a new high/low before the signal is trusted. Market-level, applies the same way for every ticker in this run.'
  };
}

// ── 2. Basing Point stop + Progressive Stop read (Ch27, 28, 28.1) ──────
// Surfaces techPlan.basingPointStop (v9.75) and ind.progressiveStopFlag
// (v9.76) as their own cited output, distinct from the main engine's ATR
// stop and Schabacker's own classical stop.
function edwardsMageeStopsV1_(techPlan, ind) {
  const bps = techPlan.basingPointStop;
  const basingPoint = bps ? {
    available: true, level: bps.level, basingPointDate: bps.basingPointDate, basingPointPrice: bps.basingPointPrice,
    stopPct: bps.stopPct, sensitivityTier: bps.sensitivityTier,
    note: 'Ch27/28/28.1 — the real "Three Days Away" confirmed swing point + the book\'s own 6-price-tier x 3-sensitivity-tier stop-distance table, distinct from Schabacker\'s own classical stop (flat ATR-scaled buffer, no confirmation wait).'
  } : { available: false, note: 'Basing Point stop unavailable for this ticker (e.g. no confirmed swing point yet).' };
  const progressive = ind.progressiveStopFlag ? {
    triggered: true, level: ind.progressiveStopFlag.level, volumeRatio: ind.progressiveStopFlag.volumeRatio, daysSinceCross: ind.progressiveStopFlag.daysSinceCross,
    note: 'Ch27 — real Progressive/Hair-Trigger Stop trigger: exceptionally heavy volume (>3x avg) on an UP day after an established uptrend — "nine times out of ten" better off tightening to 1/8 point under today\'s close, for the day only.'
  } : { triggered: false, note: 'No Progressive Stop trigger today (needs exceptionally heavy volume on an up day, well into an established uptrend).' };
  return { basingPoint, progressive };
}

// ── 3. Evaluative Index breadth read (Ch38) ─────────────────────────────
// Surfaces ind.evaluativeIndex (v9.80, darkPoolTrackerV1.gs's own isolated
// trigger) as its own cited output. Market-level, same real breadth
// reading applies regardless of which ticker is being analyzed.
function edwardsMageeEvaluativeIndexV1_(ind) {
  const ei = ind.evaluativeIndex;
  if (!ei) return { available: false, note: 'Evaluative Index unavailable (trigger cache stale/missing — see refreshEvaluativeIndexV1, darkPoolTrackerV1.gs).' };
  return {
    available: true,
    pctStrong: ei.pctStrong, strong: ei.strong, weak: ei.weak, unavailable: ei.unavailable, read: ei.read,
    note: 'Ch38 — Magee\'s own real, continuous market-breadth gauge (85-ticker basket, SMA50>SMA200 Bull/Bear classification). "The Index will float and adjust itself continually" — a real, disclosed continuous read, explicitly NOT a discrete buy/sell signal. Real anchors: ~5-9% Strong = historical Bottom zone, ~90%+ = symmetric Top zone.'
  };
}

// ── 4. Position-sizing / Composite Leverage read (Ch42, Appendix A, Appendix E) ──
// Surfaces techPlan.nNormalizedPositionSize (v9.78) and techPlan.compositeLeverage
// (v9.78) as a distinct 2nd opinion alongside the main engine's own
// conviction-scaled computePositionSizeV7_ ("Size:" line).
function edwardsMageePositionRiskV1_(techPlan) {
  const nps = techPlan.nNormalizedPositionSize;
  const sizing = nps ? {
    available: true, shares: nps.shares, stopLevel: nps.stopLevel, dollarRisk: nps.dollarRisk, riskPctOfAccount: nps.riskPctOfAccount,
    note: 'Appendix E (Turtle System) — real, volatility-normalized 2nd opinion: sizes the position so a full 2N move (N=20-day Wilder-smoothed True Range) costs exactly 2% of account equity. A cross-check against the main engine\'s own conviction-scaled sizing, not a replacement.'
  } : { available: false, note: 'N-normalized position size unavailable for this ticker.' };
  const cl = techPlan.compositeLeverage;
  const leverage = cl ? {
    available: true, leverage: cl.leverage, normalRangeForPrice: cl.normalRangeForPrice, tier: cl.tier,
    note: 'Appendix A — real (S×N)/15.5 formula (simplified for a cash-only, no-margin strategy, T/C=1), combining this ticker\'s own volatility (Sensitivity Index, approximated via atrRatio, same approximation the Basing Point stop already makes) with its price-level\'s own typical range.'
  } : { available: false, note: 'Composite Leverage unavailable for this ticker.' };
  return { sizing, leverage };
}

// ── 5. Fan Principle + Trend Channel read (Ch14) ────────────────────────
// Surfaces techPlan.fanPrinciple (v9.81) and techPlan.trendChannel (v9.81)
// as their own cited output.
function edwardsMageeFanTrendChannelV1_(techPlan) {
  const fp = techPlan.fanPrinciple;
  const fanPrinciple = fp ? {
    available: true, triggered: fp.triggered, brokenCount: fp.brokenCount, flattening: fp.flattening,
    originDate: fp.originDate, originPrice: fp.originPrice,
    note: 'Ch14 — real "Three-Fan Rule": as a correction unfolds, price breaks progressively flatter trendlines drawn from the correction\'s own starting extreme; when the 3rd such line breaks, the book\'s own real claim is the correction is over ("works in the great majority of cases," not independently backtested here).'
  } : { available: false, note: 'Fan Principle read unavailable (needs a clear regime — TREND_UP/TREND_DOWN — and a real correction with 3 confirmed opposite-direction swing points).' };
  const tc = techPlan.trendChannel;
  const trendChannel = tc ? {
    available: true, basicTrendlineNow: tc.basicTrendline.currentValue, returnLineNow: tc.returnLine.currentValue,
    shortfall: tc.shortfall, projectedOvershoot: tc.projectedOvershoot,
    note: 'Ch14 (Fig.156) — real symmetric Trend Channel/Return Line rule: if a swing falls short of its own boundary by some margin, the book\'s own claim is the NEXT swing will overshoot the OPPOSITE boundary by that same margin. Applies to that opposite boundary\'s own value when the next swing occurs (both lines are sloped), not a fixed price today.'
  } : { available: false, note: 'Trend Channel read unavailable (needs a clear regime and at least 1 completed swing after the channel\'s own 2 defining points).' };
  return { fanPrinciple, trendChannel };
}

// ── 6. Double Top/Bottom spacing confirmation read (Ch37) ──────────────
// Surfaces the emSpacingCheck field (v9.77) already attached to
// DOUBLE_TOP/DOUBLE_BOTTOM pattern objects — labels existing detections,
// does not re-detect anything, same "label, don't re-detect" discipline
// as schabackerPatternReadV1_ above.
function edwardsMageeSpacingCheckV1_(chartPatterns) {
  const withSpacing = (chartPatterns || [])
    .filter(p => (p.type === 'DOUBLE_TOP' || p.type === 'DOUBLE_BOTTOM') && p.emSpacingCheck)
    .map(p => ({ type: p.type, weeksApart: p.emSpacingCheck.weeksApart, magnitudePct: p.emSpacingCheck.magnitudePct, meetsBook: p.emSpacingCheck.meetsBook }));
  return {
    patterns: withSpacing,
    note: 'Ch37 (p549) — real, quantified confirmation-quality bar: the book\'s own full-confidence read requires the 2 Tops/Bottoms be >=6 weeks apart with >=15% intervening move. A confirmation-quality FLAG, not a gate — the pattern above still fires on this engine\'s own existing, looser 5%/3% detection bar regardless of whether it meets this stricter bar.'
  };
}

// ── 7b. Relative Strength Ranking read (Appendix E, Turtle System) ─────
// Surfaces ind.relativeStrengthRanking (v9.85, darkPoolTrackerV1.gs's own
// isolated trigger — user's explicit 2026-09-02 choice: full peer/sector
// ranking, cache-only architecture) as its own cited output. Same
// "labels an existing attach, doesn't re-detect" discipline as
// edwardsMageeSpacingCheckV1_ above.
function edwardsMageeRelativeStrengthV1_(ind) {
  const rsr = ind.relativeStrengthRanking;
  if (!rsr) return { available: false, note: 'Relative Strength Ranking unavailable (ticker not in any of the 14 real correlated-group categories, or trigger cache stale/missing — see refreshRelativeStrengthRankingV1_, darkPoolTrackerV1.gs).' };
  return {
    available: true,
    categories: rsr.categories, rank: rsr.rank, peerCount: rsr.peerCount, percentile: rsr.percentile, read: rsr.read,
    topPeers: rsr.topPeers, bottomPeers: rsr.bottomPeers,
    note: 'Appendix E, Original Turtle Trading System — "buy the strongest, short the weakest" within a correlated group, real formula (CurrentPrice-PriceNMonthsAgo)/CurrentN, real peer group = this project\'s own 14-category dark-pool watchlist. Relative weakness is surfaced as a real caution only, never a short recommendation (this user\'s own long-only/calls-only strategy).'
  };
}

// ── 8. Explicit, disclosed exclusions (matches schabackerModelV1.gs's own
//      "excluded methods" discipline) ─────────────────────────────────
function edwardsMageeExclusionsV1_() {
  return [
    { item: 'Appendix E\'s full Turtle entry/exit/pyramiding system as a standalone strategy', reason: 'Confirmed the core mechanic (Donchian(20) breakout channel) is ALREADY built in this engine, explicitly attributed to Turtle Trading in the code\'s own comments — a second, parallel Turtle-branded entry system would duplicate existing functionality, not add to it.' },
    { item: 'Appendix E\'s futures-specific market list, contract-rollover rules, notional-account mechanics', reason: 'Real, but genuinely out of scope — this engine is stocks/ETFs only.' },
    { item: 'Appendix A Chapter D\'s 1964-73 per-company Sensitivity Index data table', reason: 'Confirmed obsolete — wrong era, mostly-defunct/renamed companies, functionally superseded by real modern beta / this project\'s own existing ind.atrRatio.' },
    { item: 'Ch25 margin/short-selling mechanics', reason: 'Real, but this user\'s own standing trading strategy is long-only/calls-only — no buildable detail would ever be used.' },
    { item: 'Ch36\'s moving-average-as-mechanical-trendline material', reason: 'Already well covered by this project\'s existing SMA/EMA indicator set — no new buildable signal.' }
    // Ch31/Ch41's diversification/Bull-phase-rotation guidance was listed
    // here as excluded ("portfolio-level, not per-ticker") through v9.90 --
    // real correction, 2026-09-03: this engine's own Portfolio Summary
    // sheet (computePortfolioSummaryV7, pre-existing) IS a real portfolio-
    // level layer. Built as computePortfolioBullPhaseAdvisoryV1_
    // (fullStockAnalysisV9_91.gs), shown on the Portfolio Summary sheet,
    // not this per-ticker report -- not excluded, just lives elsewhere.
  ];
}

// ── Real, disclosed source-conflict (matches schabackerModelV1's own
//    honest-disclosure convention, not silently resolved) ────────────────
function edwardsMageeSourceConflictV1_() {
  return {
    topic: 'Continuation/Runaway Gap measuring reliability',
    thisBook: 'A real, working measuring formula with real historical examples showing it worked (Ch12/Ch32).',
    schabacker: 'Explicit, tested, NEGATIVE verdict: "no reliance can be placed" on gap-measuring theories.',
    note: 'A genuine disagreement between the two real sources this project has now characterized — flagged honestly here rather than silently picking a side. This engine does not currently ship a gap-measuring price target either way.'
  };
}

// ── Top-level builder ───────────────────────────────────────────────────
// Accepts already-computed data as parameters — no independent fetch,
// same discipline as buildSchabackerReportV1. Wrapped in try/catch, same
// disclosed-degradation convention as this project's other report builders.
function buildEdwardsMageeReportV1(ticker, ind, gann, confluence, techPlan, chart, log) {
  try {
    const dowTheory = edwardsMageeDowTheoryV1_(ind);
    const stops = edwardsMageeStopsV1_(techPlan, ind);
    const evaluativeIndex = edwardsMageeEvaluativeIndexV1_(ind);
    const positionRisk = edwardsMageePositionRiskV1_(techPlan);
    const fanTrendChannel = edwardsMageeFanTrendChannelV1_(techPlan);
    const spacingCheck = edwardsMageeSpacingCheckV1_(ind.chartPatterns);
    const relativeStrength = edwardsMageeRelativeStrengthV1_(ind);
    const exclusions = edwardsMageeExclusionsV1_();
    const sourceConflict = edwardsMageeSourceConflictV1_();

    // ── Final synthesis — qualitative, no fabricated score. Sourced
    // strictly from Edwards & Magee-specific reads above, same discipline
    // as schabackerModelV1's own synthesis (never re-derives the main
    // engine's own scoring). Same required shape for comparison-report
    // interop as schabackerModelV1: { netRead, bullish, cautionary }.
    const bullish = [], cautionary = [];
    if (dowTheory.available) {
      if (dowTheory.verdict === 'BULL_CONFIRMED') bullish.push('Dow Theory: both real broad-market averages confirm a new high (Ch3-5.1)');
      else if (dowTheory.verdict === 'BEAR_CONFIRMED') cautionary.push('Dow Theory: both real broad-market averages confirm a new low (Ch3-5.1)');
      else if (dowTheory.verdict === 'NON_CONFIRMATION_BULL' || dowTheory.verdict === 'NON_CONFIRMATION_BEAR') cautionary.push('Dow Theory: real non-confirmation — only 1 of DIA/IYT confirmed, distrust the signal (Ch3-5.1)');
    }
    if (evaluativeIndex.available) {
      if (evaluativeIndex.read.indexOf('OVERSOLD') === 0) bullish.push('Evaluative Index: real breadth reading in the historical Bottom-zone anchor (Ch38)')
      else if (evaluativeIndex.read.indexOf('OVERBOUGHT') === 0) cautionary.push('Evaluative Index: real breadth reading in the symmetric Top-zone anchor (Ch38)');
    }
    if (stops.progressive.triggered) cautionary.push('Progressive Stop: real climactic-volume trigger fired today — book\'s own real "nine times out of ten" caution (Ch27)');
    if (fanTrendChannel.fanPrinciple.available && fanTrendChannel.fanPrinciple.triggered) {
      bullish.push('Fan Principle: real 3rd fan line broken — book\'s own claim the correction is over, Primary trend resuming (Ch14)');
    }
    spacingCheck.patterns.forEach(p => {
      if (p.meetsBook) {
        if (p.type === 'DOUBLE_TOP') cautionary.push('Double Top meets the book\'s own real >=6wk/>=15% full-confidence bar (Ch37)');
        else bullish.push('Double Bottom meets the book\'s own real >=6wk/>=15% full-confidence bar (Ch37)');
      }
    });
    if (relativeStrength.available) {
      if (relativeStrength.read.indexOf('STRONG') === 0) bullish.push('Relative Strength Ranking: #' + relativeStrength.rank + '/' + relativeStrength.peerCount + ' in ' + relativeStrength.categories.join('/') + ' — among the strongest in its real peer group (Appendix E)');
      else if (relativeStrength.read.indexOf('WEAK') === 0) cautionary.push('Relative Strength Ranking: #' + relativeStrength.rank + '/' + relativeStrength.peerCount + ' in ' + relativeStrength.categories.join('/') + ' — among the weakest in its real peer group, a caution not a short signal (Appendix E)');
    }

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
      : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker,
      dowTheory, stops, evaluativeIndex, positionRisk, fanTrendChannel, spacingCheck, relativeStrength, exclusions, sourceConflict,
      synthesis: { bullish, cautionary, netRead }
    };
  } catch (e) {
    if (log) log('Edwards & Magee model: report build failed for ' + ticker + ' — ' + (e && e.message ? e.message : e));
    return null;
  }
}

// ── Plain-text formatter — mirrors formatSchabackerReportV1's own
//    convention: one section per category, real gaps shown inline. ──────
function formatEdwardsMageeReportV1(report) {
  if (!report) return 'No report — data unavailable.';
  const lines = [];
  const push = (s) => lines.push(s);

  // 2026-09-06, real fix: a real live Sheet showed this exact cell as
  // #ERROR! -- Google Sheets/Apps Script's setValue() treats any string
  // starting with '=' as a formula, same as manually typing it in, and
  // "=== ticker..." isn't valid formula syntax. Pre-existing since this
  // report was first built, never noticed until a real xlsx export
  // surfaced it. Switched to this project's own already-established
  // header convention ('── ... ──', used throughout the 🔬 Log and
  // elsewhere) instead of inventing a new one.
  push('── ' + report.ticker + ' — Edwards & Magee Model v1 ──');
  push('');
  push('1. DOW THEORY CONFIRMATION (Ch3-5.1)');
  push('  ' + (report.dowTheory.available ? report.dowTheory.read + ' (DIA $' + report.dowTheory.industrials.close.toFixed(2) + ', IYT $' + report.dowTheory.transports.close.toFixed(2) + ')' : report.dowTheory.note));
  push('');
  push('2. BASING POINT + PROGRESSIVE STOP (Ch27/28/28.1)');
  if (report.stops.basingPoint.available) {
    push('  Basing Point stop: $' + report.stops.basingPoint.level.toFixed(2) + ' (basing point $' + report.stops.basingPoint.basingPointPrice.toFixed(2) + ' on ' + report.stops.basingPoint.basingPointDate + ', ' + (report.stops.basingPoint.stopPct*100).toFixed(0) + '%/' + report.stops.basingPoint.sensitivityTier + ')');
  } else push('  ' + report.stops.basingPoint.note);
  push('  Progressive Stop: ' + (report.stops.progressive.triggered ? 'TRIGGERED — tighten to $' + report.stops.progressive.level.toFixed(2) + ' (' + report.stops.progressive.volumeRatio.toFixed(1) + 'x avg volume)' : 'not triggered today'));
  push('');
  push('3. EVALUATIVE INDEX (Ch38)');
  push('  ' + (report.evaluativeIndex.available ? report.evaluativeIndex.pctStrong.toFixed(1) + '% Strong (' + report.evaluativeIndex.strong + '+/' + report.evaluativeIndex.weak + '-) — ' + report.evaluativeIndex.read : report.evaluativeIndex.note));
  push('');
  push('4. POSITION-SIZING / COMPOSITE LEVERAGE (Ch42, Appendix A/E)');
  if (report.positionRisk.sizing.available) push('  N-normalized size: ' + report.positionRisk.sizing.shares + ' shares, stop $' + report.positionRisk.sizing.stopLevel.toFixed(2) + ', risk $' + report.positionRisk.sizing.dollarRisk.toFixed(0) + ' (' + report.positionRisk.sizing.riskPctOfAccount.toFixed(1) + '% of account)');
  else push('  ' + report.positionRisk.sizing.note);
  if (report.positionRisk.leverage.available) push('  Composite Leverage: ' + report.positionRisk.leverage.leverage.toFixed(2) + 'x (' + report.positionRisk.leverage.tier + ')');
  else push('  ' + report.positionRisk.leverage.note);
  push('');
  push('5. FAN PRINCIPLE + TREND CHANNEL (Ch14)');
  if (report.fanTrendChannel.fanPrinciple.available) push('  Fan Principle: ' + report.fanTrendChannel.fanPrinciple.brokenCount + '/3 fan lines broken' + (report.fanTrendChannel.fanPrinciple.triggered ? ' — TRIGGERED (correction likely over)' : ''));
  else push('  Fan Principle: ' + report.fanTrendChannel.fanPrinciple.note);
  if (report.fanTrendChannel.trendChannel.available) push('  Trend Channel: ' + (report.fanTrendChannel.trendChannel.projectedOvershoot != null ? 'last swing fell short by $' + report.fanTrendChannel.trendChannel.projectedOvershoot.toFixed(2) + ' — projects the same overshoot on the opposite boundary next' : 'last swing reached/exceeded its own boundary'));
  else push('  Trend Channel: ' + report.fanTrendChannel.trendChannel.note);
  push('');
  push('6. DOUBLE TOP/BOTTOM SPACING CHECK (Ch37)');
  if (!report.spacingCheck.patterns.length) push('  No Double Top/Bottom currently carries this field.');
  report.spacingCheck.patterns.forEach(p => push('  - ' + p.type + ': ' + p.weeksApart + ' weeks apart, ' + p.magnitudePct + '% move — ' + (p.meetsBook ? 'MEETS' : 'below') + ' the book\'s full-confidence bar'));
  push('');
  push('7. RELATIVE STRENGTH RANKING (Appendix E, Turtle System)');
  if (report.relativeStrength.available) {
    const rs = report.relativeStrength;
    push('  #' + rs.rank + '/' + rs.peerCount + ' in ' + rs.categories.join('/') + ' (percentile ' + rs.percentile + ') — ' + rs.read);
    push('  Top: ' + rs.topPeers.map(p => p.ticker).join(', ') + '  |  Bottom: ' + rs.bottomPeers.map(p => p.ticker).join(', '));
  } else push('  ' + report.relativeStrength.note);
  push('');
  push('8. REAL SOURCE CONFLICT, DISCLOSED');
  push('  ' + report.sourceConflict.topic + ': this book says "' + report.sourceConflict.thisBook + '" vs. Schabacker\'s "' + report.sourceConflict.schabacker + '"');
  push('');
  push('9. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach(e => push('  - ' + e.item + ': ' + e.reason));
  push('');
  push('10. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach(b => push('  [+] ' + b));
  report.synthesis.cautionary.forEach(c => push('  [-] ' + c));

  return lines.join('\n');
}
