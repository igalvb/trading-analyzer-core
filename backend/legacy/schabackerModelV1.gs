// ══════════════════════════════════════════════════════════════════════
//  schabackerModelV1.gs — Schabacker Model (Deliverable 1, docs/BIG_PLAN_SCHABACKER.md)
//  Built per docs/SCHABACKER_IMPLEMENTATION_PLAN.md §4, 2026-08-31.
//
//  Same pattern as brokerCourseModelV1.gs: a standalone, separately-cited
//  model — every read in this file traces to a specific Study in Richard
//  Schabacker's "Technical Analysis and Stock Market Profits" (1932/1937,
//  Harriman House 2005 reprint), per docs/SCHABACKER_BOOK_NOTES.md.
//
//  Real, deliberate design choice (§4a): unlike buildBrokerCourseReportV1
//  (which does its own independent fetch/recompute), this model does NOT
//  re-fetch or re-derive anything. `ind`/`gann`/`confluence`/`techPlan`/
//  `chart` are the EXACT SAME objects the main engine (runAnalysisV7)
//  already computed for the SAME ticker in the SAME run — passed straight
//  through, same convention as buildComparisonReportV1's existingTechPlan/
//  existingDecisionArg/existingFundScore optional args. This report is
//  cheap: no new network calls at all.
//
//  Same Apps Script project, shared global scope as fullStockAnalysisV9_*.gs
//  and brokerCourseModelV1.gs (this file's own functions are never called
//  from those files in this phase — wiring happens in the 3-way comparison
//  report phase, not here).
// ══════════════════════════════════════════════════════════════════════

// ── Pattern taxonomy (Studies II-VII) ──────────────────────────────────
// The book's own complete 3-group taxonomy (reversal-only / continuation-
// only / context-dependent), applied to whatever `ind.chartPatterns`
// already detected — this file LABELS existing detections, it does not
// re-detect anything. A handful of engine pattern types are NOT part of
// Schabacker's own vocabulary at all (STAIRCASE, CUP_AND_HANDLE, BULL_TRAP/
// BEAR_TRAP are later, non-1932 conventions) — labeled honestly as such
// rather than force-fit into the book's taxonomy.
const SCHABACKER_PATTERN_TAXONOMY_V1_ = {
  HEAD_AND_SHOULDERS:          { group: 'reversal', note: 'Study II — book\'s own #1-ranked major reversal formation, the most reliable of the five.' },
  INVERSE_HEAD_AND_SHOULDERS:  { group: 'reversal', note: 'Study II — same formation inverted; same top reliability ranking.' },
  DOUBLE_TOP:                  { group: 'reversal', note: 'Study IV — book\'s own disclosed statistic: "probably not more than a third" of popularly-labeled double tops actually signal reversal; only ones meeting the book\'s specific criteria (comparable peak levels, genuine intervening pullback) are reliable.' },
  DOUBLE_BOTTOM:               { group: 'reversal', note: 'Study IV — same reliability caveat as Double Top, mirrored.' },
  TRIPLE_TOP:                  { group: 'reversal', note: 'Study IV — "Multiple Tops/Bottoms," ranked #4 of the book\'s own top-5 major reversal patterns.' },
  TRIPLE_BOTTOM:               { group: 'reversal', note: 'Study IV — same ranking as Triple Top, mirrored.' },
  COMPLEX_TOP:                 { group: 'reversal', note: 'Study IV — "Complex Reversal," explicitly ranked TIED WITH Head and Shoulders on reliability by the book itself, just rarer.' },
  COMPLEX_BOTTOM:              { group: 'reversal', note: 'Study IV — same top-tier reliability ranking as Complex Top, mirrored.' },
  BROADENING_TOP:              { group: 'reversal', note: 'Study IV — book\'s own "rule of five" alternating-swing pattern, explicitly called secondary/minor (studied for pictorial kinship to the major 5, not itself in that top-5 list).' },
  BROADENING_BOTTOM:           { group: 'reversal', note: 'Study IV — same secondary/minor standing as Broadening Top, mirrored.' },
  DIAMOND_TOP:                 { group: 'reversal', note: 'Study V — "Minor Reversal Formations": a real but secondary-tier pattern, geometrically an inverted-then-normal Symmetrical Triangle pair.' },
  DIAMOND_BOTTOM:              { group: 'reversal', note: 'Study V — same minor-reversal standing as Diamond Top, mirrored.' },
  ROUNDING_TOP:                { group: 'reversal', note: 'Study III — "Rounding Turn," book\'s own #2-ranked major reversal pattern.' },
  ROUNDING_BOTTOM:             { group: 'reversal', note: 'Study III — same #2 ranking as Rounding Top, mirrored.' },
  ISLAND:                      { group: 'reversal', note: 'Study V/VII — "Island Reversal": requires both bounding gaps at (roughly) the same price level AND the first gap staying genuinely un-closed until the reversal gap forms — see meetsStrictValidity below.' },
  ASCENDING_TRIANGLE:          { group: 'context-dependent', note: 'Study VI — same shape has OPPOSITE forecasting implications depending on prevailing-trend context: continuation with the trend, reversal against it. Not scored by the main engine today (weight 0).' },
  DESCENDING_TRIANGLE:         { group: 'context-dependent', note: 'Study VI — same context-dependent read as Ascending Triangle, mirrored. Not scored by the main engine today (weight 0).' },
  SYMMETRICAL_TRIANGLE:        { group: 'continuation', note: 'Study III/VI — book\'s own #3-ranked major reversal-or-continuation pattern overall (Triangle family); Symmetrical specifically leans continuation far more often than reversal.' },
  RECTANGLE:                   { group: 'continuation', note: 'Study VI — classical continuation formation ("Major Continuation Formations").' },
  BULL_FLAG:                   { group: 'continuation', note: 'Study VI/X — Flag; book\'s own "most accurate measuring forecasts" among all its formations — see measuring-rule section below.' },
  BEAR_FLAG:                   { group: 'continuation', note: 'Study VI/X — same standing as Bull Flag, mirrored.' },
  PENNANT:                     { group: 'continuation', note: 'Study VI/X — same family as Flag, same mast-length measuring implication.' },
  HALF_MAST:                   { group: 'continuation', note: 'Study X — "Half-mast Congestion": looser-shaped cousin of Flag/Pennant (tight, brief, low-volume mid-mast pause), same measuring implication as a true Flag.' },
  STAIRCASE:                   { group: 'not-covered', note: 'Not a Schabacker-era formation — this is a later, non-1932 pattern convention; no book citation applies.' },
  CUP_AND_HANDLE:              { group: 'not-covered', note: 'Not a Schabacker-era formation — this is a later, non-1932 pattern convention; no book citation applies.' },
  BULL_TRAP:                   { group: 'not-covered', note: 'Not a formal Schabacker formation type, but conceptually matches the book\'s own "false move/shake-out" caution (Study III/VI): even a volume-confirmed break can occasionally be false, with no fully reliable distinguishing criterion.' },
  BEAR_TRAP:                   { group: 'not-covered', note: 'Same as Bull Trap, mirrored.' }
};

// ── 1. Trend classification (Study I) ──────────────────────────────────
// Major/intermediate/minor movement framing, reusing the engine's existing
// regime detection + weekly-trend comparison (techPlan.drivers already
// carries a 'Multi-Timeframe' driver comparing daily regime vs. weekly
// trend — reused directly here, not recomputed).
function schabackerTrendReadV1_(ind, techPlan) {
  const major = { regime: techPlan.regime, techScore: techPlan.techScore };
  const mtDriver = (techPlan.drivers || []).find(d => d.label === 'Multi-Timeframe');
  const intermediate = {
    weeklyTrend: ind.weeklyTrend || null,
    agreement: mtDriver ? mtDriver.note : 'insufficient history for the 40-week comparison'
  };
  const minor = {
    roc10: ind.roc10 != null ? ind.roc10 : null,
    mom5: ind.mom5 != null ? ind.mom5 : null
  };
  const read = 'Major: ' + major.regime + ' (tech score ' + major.techScore + '/100). '
    + 'Intermediate (weekly): ' + (intermediate.weeklyTrend || 'n/a') + ' — ' + intermediate.agreement + '. '
    + 'Minor (short-term day-to-day fluctuation, book\'s own least-significant tier): '
    + (minor.roc10 != null ? '10-day ROC ' + minor.roc10.toFixed(1) + '%' : 'n/a');
  return { major, intermediate, minor, read };
}

// ── 2. Reversal/Continuation pattern read (Studies II-VII) ─────────────
function schabackerPatternReadV1_(chartPatterns) {
  const patterns = (chartPatterns || []).map(p => {
    const tax = SCHABACKER_PATTERN_TAXONOMY_V1_[p.type] || { group: 'not-covered', note: 'Pattern type not present in the book\'s own taxonomy.' };
    return {
      type: p.type,
      group: tax.group,
      note: tax.note,
      confirmed: p.confirmed === true
    };
  });
  const confirmedReversals = patterns.filter(p => p.group === 'reversal' && p.confirmed);
  const confirmedContinuations = patterns.filter(p => p.group === 'continuation' && p.confirmed);
  return { patterns, confirmedReversals, confirmedContinuations };
}

// ── 3. Trend-line + Support/Resistance read (Studies VIII-IX) ──────────
function schabackerSRTrendLineReadV1_(ind, confluence) {
  const srLevels = ind.srLevels || {};
  const withVolumeWeight = (levels) => (levels || [])
    .filter(l => l.volumeWeightedStrength != null)
    .map(l => ({ level: l.level, touchCount: l.touchCount, volumeWeightedStrength: l.volumeWeightedStrength }));
  const memoryFactor = {
    resistance: withVolumeWeight(srLevels.resistanceLevels),
    support: withVolumeWeight(srLevels.supportLevels),
    note: 'Study IX "memory factor" — higher volume at a touch means a stronger future level, not just touch-count/recency. Informational, not scored.'
  };
  const roleReversal = {
    note: 'Study VIII/IX — a broken resistance level becomes support (and vice versa) once decisively crossed; disclosed principle, not independently re-verified per-level here (see srLevels above for which levels are currently in play).'
  };
  const criticalLevels = {
    nearRoundNumber: ind.roundNumber || null,
    note: 'Study IX — the book calls out round 50/100-point levels as having outsized psychological significance; reuses the engine\'s existing round-numbers feature.'
  };
  const halfway = ind.halfwayRetracementRead ? {
    retracedPct: ind.halfwayRetracementRead.retracedPct,
    classification: ind.halfwayRetracementRead.classification,
    note: 'Study IX "Half-way Intermediate Movement Theory" — retracement of half or less of the prior swing is normal; more than half (book\'s own safer cutoff: two-thirds) raises real suspicion of a major-trend reversal.'
  } : null;
  return { memoryFactor, roleReversal, criticalLevels, halfway };
}

// ── 4. Gap classification (Study VII) ──────────────────────────────────
// Book's own 4-type taxonomy + reliability commentary, applied to the
// engine's existing gap-taxonomy fields (g.gapType/g.meetsStrictValidity).
// Only the most recent gaps are surfaced (matches this file's own
// "informational, not exhaustive" convention elsewhere).
const SCHABACKER_GAP_RELIABILITY_V1_ = {
  COMMON:     'Study VII — least significant of the four; the book\'s own "doesn\'t interest me" default.',
  BREAKAWAY:  'Study VII — significant when touch/volume-confirmed; marks the start of a new move out of a genuine consolidation.',
  RUNAWAY:    'Study VII — a continuation ("measuring") gap occurring mid-move, confirming the existing trend is still intact.',
  EXHAUSTION: 'Study VII — the book\'s own words: "the most important of the four." Signals the CURRENT move is running out of strength, not confirming it.',
  ISLAND:     'Study V/VII — see Island Reversal in the pattern-read section above; validity depends on the two-part same-level/stayed-open rule.'
};
function schabackerGapReadV1_(priceGaps, lookback) {
  const n = lookback || 10;
  const recent = (priceGaps || []).slice(-n).filter(g => g.gapType);
  const gaps = recent.map(g => ({
    date: g.date != null ? g.date : null,
    direction: g.type,
    level: g.level,
    gapType: g.gapType,
    reliabilityNote: SCHABACKER_GAP_RELIABILITY_V1_[g.gapType] || 'No book-cited reliability note for this classification.',
    hindsightDependent: g.gapTypeHindsightDependent === true,
    meetsStrictValidity: g.gapType === 'ISLAND' ? (g.meetsStrictValidity === true) : null
  }));
  const mostImportant = gaps.filter(g => g.gapType === 'EXHAUSTION');
  return { gaps, mostImportant };
}

// ── 5. Measuring-rule price objectives (Study X) ───────────────────────
// Surfaces the v9.71/v9.72 `measuredTarget` fields already computed on
// H&S/Flag/Pennant/Half-mast patterns. Explicitly EXCLUDES Triangle and
// Gap measuring — book's own explicit, tested, NEGATIVE verdict for both
// ("no reliance can be placed").
function schabackerMeasuringRulesV1_(chartPatterns) {
  const objectives = (chartPatterns || [])
    .filter(p => p.measuredTarget != null)
    .map(p => ({ type: p.type, measuredTarget: p.measuredTarget }));
  return {
    objectives,
    excludedNote: 'Study X — Triangle and Gap measuring-rule price theories are explicitly excluded from this section: the book\'s own tested conclusion is "no reliance can be placed" on either. Every objective above is a rough, probable target, never a guarantee (book\'s own worked examples show real under/overshoot).'
  };
}

// ── 6. Classical stop-loss recommendation (Study X) ─────────────────────
// Surfaces techPlan.classicalStop (computeClassicalStopV1_, v9.71) as its
// own cited output, separate from the main engine's existing ATR-multiple
// stop. This function's own input (classicalStop) is a single-snapshot
// read with no entry-point context, so it does NOT compute the real "two
// days away" trailing update -- that requires a real entry date to walk
// forward from. **Real gap CLOSED, v9.86**: the trailing update is now
// implemented (computeClassicalStopTrailingV1_, fullStockAnalysisV9_85.gs)
// and surfaced through analyzePositionV7's own "since entry" position
// utility, the correct real call site given it structurally needs an
// entry point this report-level function doesn't have.
function schabackerClassicalStopV1_(classicalStop) {
  if (!classicalStop) {
    return { available: false, note: 'Classical stop unavailable for this ticker (e.g. insufficient price history).' };
  }
  return {
    available: true,
    level: classicalStop.level,
    basingPointDate: classicalStop.basingPointDate,
    basingPointPrice: classicalStop.basingPointPrice,
    direction: classicalStop.direction,
    note: 'Study X — real swing basing point + volatility-scaled buffer + round-number avoidance, distinct from the main engine\'s ATR-multiple stop. Not empirically validated (same standing caveat as every other threshold in this engine). Static at this basing point — does not currently walk forward with new swing points.'
  };
}

// ── 7. Trading-tactics checklist (Study XII) ────────────────────────────
function schabackerTradingTacticsV1_(chart, ind) {
  const price = chart.currentPrice != null ? chart.currentPrice : ind.last;
  let priceLevelFit;
  if (price == null) priceLevelFit = 'n/a';
  else if (price < 10) priceLevelFit = 'CAUTIONED — below $10, book\'s own "erratic then long stagnant stretches" caution for very low-priced stocks.';
  else if (price >= 15 && price <= 60) priceLevelFit = 'IDEAL — within the book\'s own $15-60 range for a beginning trader\'s program.';
  else if (price > 60) priceLevelFit = 'Above the book\'s own $15-60 ideal range — very high-priced stocks show less profitable % moves per the book.';
  else priceLevelFit = 'Below the book\'s own $15-60 ideal range but above its $10 caution line.';

  const rsp = chart.relativeSwingPower || null;
  const relativeSwingPower = rsp ? {
    ratio: rsp.ratio, etf: rsp.etf, sector: rsp.sector,
    note: 'Study XII — swings ' + (rsp.ratio >= 1 ? ((rsp.ratio - 1) * 100).toFixed(0) + '% wider than' : ((1 - rsp.ratio) * 100).toFixed(0) + '% narrower than') + ' its own sector average.'
  } : null;

  return {
    priceLevelFit,
    relativeSwingPower,
    diversificationNote: 'Study XII — book\'s own diversification/list-size guidance is a portfolio-level judgment (how many tickers to actively chart/trade at once), not a single-ticker computation; not derived here for lack of the user\'s own full position list in this scope.'
  };
}

// ── 8. Explicit, disclosed exclusions (matches this project's own
//      "excluded methods" discipline) ─────────────────────────────────
function schabackerExclusionsV1_() {
  return [
    { item: 'Point & Figure / intraday charts', reason: 'Book\'s own explicit, tested, NEGATIVE verdict for intraday; Point & Figure "offers no advantages over the ordinary vertical line chart." Also a genuine architecture mismatch — this engine is EOD-bar only.' },
    { item: 'Dow Theory (formal tenets) for single-stock use', reason: 'Book\'s own explicit verdict: "of extremely limited value" for individual-stock trading.' },
    { item: 'Time-cycle theories', reason: 'Book\'s own explicit, tested, NEGATIVE verdict: "not one single reliable rule of time has ever been discovered."' },
    { item: 'Triangle measuring rule', reason: 'Book\'s own explicit, tested, NEGATIVE verdict: "no reliance can be placed."' },
    { item: 'Gap measuring theories (single/multiple)', reason: 'Book\'s own explicit, tested, NEGATIVE verdict.' },
    { item: 'Inverted Triangle', reason: 'Real rarity (~1:30-40 vs. normal triangles), poor directional reliability per the book\'s own repeated caution.' },
    { item: 'Monthly/group/average charts as their own feature', reason: 'Book\'s own explicit verdict: "time more profitably spent on individual charts."' }
  ];
}

// ── Top-level builder ───────────────────────────────────────────────────
// Accepts already-computed data as parameters — no independent fetch (§4a).
// Wrapped in try/catch, same disclosed-degradation convention as this
// project's other report builders: returns null and logs on failure rather
// than throwing into the caller.
function buildSchabackerReportV1(ticker, ind, gann, confluence, techPlan, chart, log) {
  try {
    const trend = schabackerTrendReadV1_(ind, techPlan);
    const patternRead = schabackerPatternReadV1_(ind.chartPatterns);
    const srTrendLine = schabackerSRTrendLineReadV1_(ind, confluence);
    const gapRead = schabackerGapReadV1_(ind.priceGaps);
    const measuringRules = schabackerMeasuringRulesV1_(ind.chartPatterns);
    const classicalStop = schabackerClassicalStopV1_(techPlan.classicalStop);
    const tradingTactics = schabackerTradingTacticsV1_(chart, ind);
    const exclusions = schabackerExclusionsV1_();

    // ── Final synthesis — qualitative, no fabricated score. Sourced
    // strictly from Schabacker-specific reads above, same discipline as
    // brokerCourseModelV1's own synthesis (never re-derives the main
    // engine's own scoring). Required shape for comparison-report interop
    // (docs/SCHABACKER_IMPLEMENTATION_PLAN.md §4b): { netRead, bullish, cautionary }.
    const bullish = [], cautionary = [];
    patternRead.confirmedReversals.forEach(p => {
      const bullishTypes = ['INVERSE_HEAD_AND_SHOULDERS', 'DOUBLE_BOTTOM', 'TRIPLE_BOTTOM', 'COMPLEX_BOTTOM', 'BROADENING_BOTTOM', 'DIAMOND_BOTTOM', 'ROUNDING_BOTTOM'];
      if (bullishTypes.indexOf(p.type) > -1) bullish.push('Pattern: confirmed bullish reversal (' + p.type + ')');
      else cautionary.push('Pattern: confirmed bearish reversal (' + p.type + ')');
    });
    gapRead.mostImportant.forEach(g => {
      if (g.direction === 'DOWN') bullish.push('Gap: Exhaustion gap on a down-move — downtrend may be ending (Study VII)');
      else cautionary.push('Gap: Exhaustion gap on an up-move — uptrend may be ending (Study VII)');
    });
    if (srTrendLine.halfway) {
      if (srTrendLine.halfway.classification === 'normal') bullish.push('Retracement: within Schabacker\'s normal half-or-less band, trend structure intact (Study IX)');
      else if (srTrendLine.halfway.classification === 'suspect-major-reversal') cautionary.push('Retracement: exceeds the book\'s own two-thirds safer cutoff — suspect major reversal (Study IX)');
    }
    if (ind.trendAlignedVolume) {
      if (ind.trendAlignedVolume.aligned) bullish.push('Volume confirms trend direction (Study VIII)');
      else cautionary.push('Volume NOT confirming trend direction (Study VIII)');
    }
    if (ind.volumeProgressDivergence && ind.volumeProgressDivergence.flagged) {
      cautionary.push('High volume, minimal net price progress — possible distribution/resistance absorption (Study VIII)');
    }
    if (tradingTactics.priceLevelFit.indexOf('IDEAL') === 0) bullish.push('Price in the book\'s own ideal $15-60 trading range (Study XII)');
    else if (tradingTactics.priceLevelFit.indexOf('CAUTIONED') === 0) cautionary.push('Price below $10 — book\'s own cautioned range (Study XII)');

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
      : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker,
      trend, patternRead, srTrendLine, gapRead, measuringRules, classicalStop, tradingTactics, exclusions,
      synthesis: { bullish, cautionary, netRead }
    };
  } catch (e) {
    if (log) log('Schabacker model: report build failed for ' + ticker + ' — ' + (e && e.message ? e.message : e));
    return null;
  }
}

// ── Plain-text formatter — mirrors formatBrokerCourseReportV1's own
//    convention: one section per category, real gaps shown inline. ──────
function formatSchabackerReportV1(report) {
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
  push('── ' + report.ticker + ' — Schabacker Model v1 ──');
  push('');
  push('1. TREND CLASSIFICATION (Study I)');
  push('  ' + report.trend.read);
  push('');
  push('2. REVERSAL/CONTINUATION PATTERN READ (Studies II-VII)');
  if (!report.patternRead.patterns.length) push('  No chart patterns currently detected.');
  report.patternRead.patterns.forEach(p => {
    push('  - ' + p.type + ' [' + p.group + ']' + (p.confirmed ? ' — CONFIRMED' : ' — forming'));
    push('      ' + p.note);
  });
  push('');
  push('3. SUPPORT/RESISTANCE + TREND-LINE READ (Studies VIII-IX)');
  push('  ' + report.srTrendLine.roleReversal.note);
  push('  ' + report.srTrendLine.memoryFactor.note);
  if (report.srTrendLine.criticalLevels.nearRoundNumber) push('  Near round number: ' + JSON.stringify(report.srTrendLine.criticalLevels.nearRoundNumber));
  if (report.srTrendLine.halfway) push('  Half-way retracement: ' + (report.srTrendLine.halfway.retracedPct * 100).toFixed(1) + '% — ' + report.srTrendLine.halfway.classification + '. ' + report.srTrendLine.halfway.note);
  push('');
  push('4. GAP CLASSIFICATION (Study VII)');
  if (!report.gapRead.gaps.length) push('  No recent gaps.');
  report.gapRead.gaps.forEach(g => push('  - ' + g.direction + ' gap @ ' + g.level.toFixed(2) + ': ' + g.gapType + (g.hindsightDependent ? ' (hindsight-dependent)' : '') + (g.meetsStrictValidity != null ? ', meetsStrictValidity=' + g.meetsStrictValidity : '') + ' — ' + g.reliabilityNote));
  push('');
  push('5. MEASURING-RULE PRICE OBJECTIVES (Study X)');
  if (!report.measuringRules.objectives.length) push('  No pattern currently carries a measured objective.');
  report.measuringRules.objectives.forEach(o => push('  - ' + o.type + ': $' + o.measuredTarget.toFixed(2)));
  push('  ' + report.measuringRules.excludedNote);
  push('');
  push('6. CLASSICAL STOP-LOSS (Study X)');
  if (report.classicalStop.available) {
    push('  Stop: $' + report.classicalStop.level.toFixed(2) + ' (basing point $' + report.classicalStop.basingPointPrice.toFixed(2) + ' on ' + report.classicalStop.basingPointDate + ', ' + report.classicalStop.direction + ')');
  } else {
    push('  ' + report.classicalStop.note);
  }
  push('  ' + (report.classicalStop.note || ''));
  push('');
  push('7. TRADING TACTICS (Study XII)');
  push('  Price-level fit: ' + report.tradingTactics.priceLevelFit);
  if (report.tradingTactics.relativeSwingPower) push('  Relative swing power: ' + report.tradingTactics.relativeSwingPower.ratio.toFixed(2) + 'x vs ' + report.tradingTactics.relativeSwingPower.etf + '/' + report.tradingTactics.relativeSwingPower.sector + ' — ' + report.tradingTactics.relativeSwingPower.note);
  push('  ' + report.tradingTactics.diversificationNote);
  push('');
  push('8. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach(e => push('  - ' + e.item + ': ' + e.reason));
  push('');
  push('9. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach(b => push('  [+] ' + b));
  report.synthesis.cautionary.forEach(c => push('  [-] ' + c));

  return lines.join('\n');
}
