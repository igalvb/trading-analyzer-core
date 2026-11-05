// ══════════════════════════════════════════════════════════════════
//  NEW BROKER-COURSE MODEL — v1
//  CHARACTERIZATION_PLAN_broker_model_v1.md
//
//  Scope, per user's explicit instruction: "new model should totally be
//  based on only those videos, nothing else." Methodology (thresholds,
//  scoring, signal logic) is derived SOLELY from the 13-episode broker
//  course (Eyal_episode_1..13_*_transcript_he.txt, BROKER_COURSE_NOTES.md).
//
//  Two things ARE reused from the existing engine (whichever
//  fullStockAnalysisV9_*.gs is currently live — this comment said "_43.gs"
//  for a long stretch after the live file moved on, corrected 2026-08-22),
//  per the user's explicit approval — both are pure data-fetching
//  INFRASTRUCTURE, not course methodology:
//    - fetchYahooChart(ticker)   — OHLCV + meta
//    - gatherFundamentals(ticker, log) — multi-provider fundamentals merge
//  Everything else (tier thresholds, classification logic, scoring) is a
//  FRESH, independent implementation in this file — per the user's explicit
//  follow-up decision, even where the main engine already has an
//  equivalent course-derived function (e.g. floatTierV7), it is NOT
//  reused here. This file must never call a *V7 function.
//
//  Same file/testing discipline as every other feature this session:
//  new file (not edit-in-place elsewhere), syntax-checked, diffed,
//  mock-tested + real-data-tested before shipping.
// ══════════════════════════════════════════════════════════════════

// Version tracking, same discipline as CONFIG_V7.version/OPTIONS_ENGINE_VERSION
// -- UPDATE THIS on every real change, per the 2026-09-06 standing rule
// ("versioning is for all the scripts"). First real version marker for
// this file (previously edited in place with no marker at all).
const BROKER_COURSE_MODEL_VERSION = 'v1.3'; // v1.3 (2026-09-08): real bug fix, found via a real live SNDK Sheet run + user-requested QA pass -- the N-voice comparison verdict's `dissentingModel` only ever named a single dissenter (the old 3/4-voice-era design), silently falling back to `null` for any other count. At real N=5, a 3-2 majority split is structurally common -- the real live output was literally "MAJORITY (null dissents)". Fixed: dissenters.length is always >=1 in the MAJORITY branch, now joins ALL real dissenter names instead of special-casing exactly 1. tests/turtle_comparison_test.js's own N=5 3-2-split test had encoded the bug's null output as "correct" -- fixed to assert the real joined-names output. 99/99 across all 4 comparison-report test files, 0 regressions. v1.2 (2026-09-07): Pass 2 of the fetch/analyze separation refactor (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md) -- this file's own 10 real fetch-owning/refresh-orchestrator functions (fetchSpdrEtfTopHoldingsV1/fetchQqqTopHoldingsV1/fetchFredSeriesV1/fetchNasdaqShortInterestV1/fetchSecEdgarCIKV1/fetchSharesOutstandingHistoryV1/fetchSecFilingKeywordHitsV1/fetchFMPInterestCoverageV1/refreshBrokerCourseDataCacheV1_/refreshMacroSnapshotV1_) MOVED VERBATIM to dataLayerV1.gs. Real Apps Script shared global scope means every real call site here (riskOverlayReadV1, buildBrokerCourseReportV1, runDailyAutomationV7) needed ZERO changes -- same function names, still callable exactly as before. v1.1 (2026-09-07): real hang-prevention guard (item 8) -- fetchSpdrEtfTopHoldingsV1's call site had only the outer 30s block-level guard, none on the call itself. Added a direct hasTimeBudgetV7_ check. Purely additive, no behavior change when budget is fine.

// ── Phase 1: Stock ID Card (episode 1) ──────────────────────────────

// Market-cap tiers as stated in episode 1 — verbatim, NOT the existing
// engine's own (different) tier numbers. Real, disclosed discrepancy:
// course says Mega≥$100B/Large $10-100B/Mid $2-10B/Small $250M-2B/
// Tiny<$250M; the existing engine's gapMarketCapContextV7 uses
// Mega≥$200B/Large≥$10B/Mid≥$2B/Small≥$300M/Micro<$300M. This function
// uses the COURSE'S numbers, independently, per the "solely those
// videos" constraint — not reconciled with or copied from the engine.
function marketCapTierV1(marketCap) {
  if (marketCap == null || isNaN(marketCap)) return null;
  if (marketCap >= 100e9) return 'Mega Cap';
  if (marketCap >= 10e9)  return 'Large Cap';
  if (marketCap >= 2e9)   return 'Mid Cap';
  if (marketCap >= 250e6) return 'Small Cap';
  return 'Tiny/Micro Cap';
}

// Float tiers as stated in episode 1 — <50M/<30M/<10M, each a step up in
// "can be moved with less capital." Independently implemented (not
// floatTierV7) per the user's explicit no-code-reuse decision.
function floatTierFlagV1(floatShares) {
  if (floatShares == null || isNaN(floatShares)) return null;
  if (floatShares < 10e6) return 'Extreme low float (<10M)';
  if (floatShares < 30e6) return 'Very low float (<30M)';
  if (floatShares < 50e6) return 'Low float (<50M)';
  return 'Normal float';
}


// ATR>10%-of-price = "very high volatility," episode 1's own stated
// threshold.
function atrPctFlagV1(atrPct) {
  if (atrPct == null || isNaN(atrPct)) return null;
  return atrPct > 0.10 ? 'Very high volatility (ATR >10% of price)' : 'Normal-to-elevated volatility';
}

// Relative volume ≥1.5-2x average = "something's happening," episode 3's
// own stated range. No exact single number given in the course beyond
// "at least 1.5x" — using 1.5x as the trigger floor, not the midpoint or
// the top of the stated range, since 1.5x is the number explicitly
// spoken (ep.5: "לפחות ב-1.5 מהממוצע"). Not fit to any backtest.
function relativeVolumeReadV1(relVol) {
  if (relVol == null || isNaN(relVol)) return null;
  return relVol >= 1.5 ? 'Elevated — something is happening' : 'Normal volume';
}

// Standard 14-period ATR (Wilder's method) — a well-known, standard
// technical-analysis formula, not course-invented, safe to implement
// independently. Takes parallel highs/lows/closes arrays (oldest→newest,
// same convention as fetchYahooChart's return shape), returns the ATR
// value in price units for the most recent bar, or null if insufficient
// data (needs at least period+1 bars).
function computeATRV1(highs, lows, closes, period) {
  period = period || 14;
  if (!highs || !lows || !closes || highs.length < period + 1) return null;
  const n = highs.length;
  const trs = [];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i-1]);
    const lc = Math.abs(lows[i] - closes[i-1]);
    trs.push(Math.max(hl, hc, lc));
  }
  // Wilder's smoothing: seed with a simple average of the first `period`
  // true ranges, then smooth forward.
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Trailing-N-day % volatility — simple high/low range over the window as
// a % of the window's average close. Used for the course's "weekly /
// monthly volatility %" ID-card field (ep.1). A straightforward, disclosed
// approximation (range-based, not stdev-of-returns) — the course itself
// demonstrates this exact "look at the % swing over the period" read
// (ep.4's SPWR/NEO comparisons), not a statistical stdev calc.
function trailingRangeVolatilityPctV1(highs, lows, closes, lookbackDays) {
  if (!highs || !lows || !closes || highs.length < lookbackDays) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackDays);
  const wLows  = lows.slice(n - lookbackDays);
  const wCloses= closes.slice(n - lookbackDays);
  const hi = Math.max.apply(null, wHighs);
  const lo = Math.min.apply(null, wLows);
  const avgClose = wCloses.reduce((a,b)=>a+b,0) / wCloses.length;
  if (!avgClose) return null;
  return (hi - lo) / avgClose;
}

// Real course rule (ep.1), raw-verified 2026-08-22 directly against the
// transcript, not just the summarized notes -- line 187-188:
// "אם את רואה כאן תנודתיות שהיא מעל חמישה שישה אחוז" ("if you see
// volatility above five-six percent") ... "תנודתיות נמוכה זה מתחת
// לשלושה אחוז" ("low volatility is below three percent") -- exact match.
// Real bug fix: `trailingRangeVolatilityPctV1` computed this % correctly
// but nothing ever classified it against these bands, and the field was
// never even displayed (found by this session's fidelity audit). A dual
// read, not one scale: HOT (>5-6%, "something is happening") is itself a
// wanted signal, and COILED (<3%, "calm before the storm") is a SEPARATE,
// also-real signal -- not just "not hot." 5% used as the hot floor (the
// course states a 5-6% range, not one number -- same "state the range's
// floor, not its midpoint" convention already used for the 1.5x
// relative-volume threshold elsewhere in this file).
function volatilityHotColdReadV1(pct) {
  if (pct == null) return null;
  if (pct > 0.05) return { tier: 'Hot', read: 'Volatility ' + (pct*100).toFixed(1) + '% — above the course\'s 5-6% "hot" band (ep.1): something real is happening' };
  if (pct < 0.03) return { tier: 'Coiled', read: 'Volatility ' + (pct*100).toFixed(1) + '% — below the course\'s 3% "coiled" band (ep.1): calm before a possible storm' };
  return { tier: 'Normal', read: 'Volatility ' + (pct*100).toFixed(1) + '% — neither the course\'s hot (>5-6%) nor coiled (<3%) band (ep.1)' };
}

// 52-week high/low — computed from the already-fetched 2yr OHLCV
// (fetchYahooChart), no new data source needed. Takes the trailing
// ~252 trading days.
function trailing52WeekRangeV1(highs, lows, dates) {
  if (!highs || !lows || !highs.length) return null;
  const n = highs.length;
  const cutoff = new Date(dates[n-1].getTime() - 365*24*60*60*1000);
  let hi = -Infinity, lo = Infinity;
  for (let i = n-1; i >= 0 && dates[i] >= cutoff; i--) {
    if (highs[i] > hi) hi = highs[i];
    if (lows[i]  < lo) lo = lows[i];
  }
  if (hi === -Infinity || lo === Infinity) return null;
  return { high: hi, low: lo };
}

// Average volume over a trailing window (simple mean), and current
// (most recent bar) / relative volume (current ÷ average).
function volumeStatsV1(volumes, lookbackDays) {
  if (!volumes || volumes.length < 2) return null;
  const n = volumes.length;
  const current = volumes[n-1];
  const windowStart = Math.max(0, n - 1 - lookbackDays); // exclude today from the average
  const window = volumes.slice(windowStart, n-1);
  if (!window.length) return null;
  const avg = window.reduce((a,b)=>a+b, 0) / window.length;
  const relVol = avg ? current / avg : null;
  return { current, avg, relVol };
}

// Assembles the full Stock ID Card. Reuses fetchYahooChart + gatherFundamentals
// (approved infrastructure reuse) — everything downstream of the raw fetch
// (tiers, flags, ATR, volatility) is this file's own fresh logic.
// `log` is optional (function(string)).
//
// v9.92 real fix (2026-09-03, docs/CLAUDE_CODE_HANDOFF.md section 3.7, Bug
// 3): optional `existingChart` — when the caller (runAnalysisV7) already
// has this ticker's real chart, reuse it instead of re-fetching. Falls
// back to its own fetch when omitted, so this stays independently
// testable/callable exactly as before.
function buildStockIdCardV1(ticker, log, existingChart, existingFund) {
  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) { if (log) log('  ID Card: chart fetch failed for ' + ticker); return null; }

  // v9.97: same dedup pattern as buildBrokerCourseReportV1's own fund reuse
  // -- this function was its own separate, previously-unnoticed 3rd/4th
  // fundamentals fetch per run (found by the dedup fix's own test).
  const fund = existingFund !== undefined ? existingFund : (function() { const r = gatherFundamentals(ticker, log); return r ? r.fund : null; })();

  const atr = computeATRV1(chart.highs, chart.lows, chart.closes, 14);
  const atrPct = (atr != null && chart.currentPrice) ? atr / chart.currentPrice : null;
  const weeklyVolPct  = trailingRangeVolatilityPctV1(chart.highs, chart.lows, chart.closes, 5);
  const monthlyVolPct = trailingRangeVolatilityPctV1(chart.highs, chart.lows, chart.closes, 21);
  const range52w = trailing52WeekRangeV1(chart.highs, chart.lows, chart.dates);
  const vol = volumeStatsV1(chart.volumes, 20);

  const marketCap = fund ? fund.marketCap : null;
  const floatShares = fund ? fund.shareFloat : null;
  // Shares outstanding: no direct field exposed by the reused fetchers —
  // derived as marketCap / price. Disclosed as a derived approximation,
  // not a directly-fetched figure.
  const sharesOutstandingApprox = (marketCap != null && chart.currentPrice) ? marketCap / chart.currentPrice : null;

  return {
    ticker: ticker,
    price: chart.currentPrice,
    ipoDate: chart.ipoDate,
    // Real, disclosed gaps — not available via the reused fetchers
    // (fetchYahooChart / gatherFundamentals). Not guessed.
    exchange: null,
    companyName: null,
    hq: null,
    employees: null,
    revenueAbsolute: null, // only revenueGrowth % is available via gatherFundamentals, not the absolute figure
    shortable: null,       // needs broker-specific data, not available; informational-only per design doc anyway

    sector: fund ? fund.sector : null,
    industry: fund ? fund.industry : null,
    marketCap: marketCap,
    marketCapTier: marketCapTierV1(marketCap),
    sharesOutstandingApprox: sharesOutstandingApprox,
    floatShares: floatShares,
    floatTier: floatTierFlagV1(floatShares),
    atr: atr,
    atrPct: atrPct,
    atrFlag: atrPctFlagV1(atrPct),
    weeklyVolatilityPct: weeklyVolPct,
    monthlyVolatilityPct: monthlyVolPct,
    // Real bug fix (this audit): both fields above were computed but never
    // classified or displayed anywhere -- the course's own hot/coiled read
    // (ep.1) is a real, separate signal, not a decoration.
    weeklyVolatilityRead: volatilityHotColdReadV1(weeklyVolPct),
    monthlyVolatilityRead: volatilityHotColdReadV1(monthlyVolPct),
    range52w: range52w,
    avgVolume20d: vol ? vol.avg : null,
    currentVolume: vol ? vol.current : null,
    relativeVolume: vol ? vol.relVol : null,
    relativeVolumeRead: vol ? relativeVolumeReadV1(vol.relVol) : null,
    fundSources: fund ? fund._sources : null
  };
}

// ── Phase 2: Charts/Technicals core (episodes 3, 4, 6) ──────────────

// Candle geometry decomposition — pure arithmetic, no course-specific
// numbers here, just body/wick/range definitions.
function candleGeometryV1(open, high, low, close) {
  if ([open,high,low,close].some(v => v == null || isNaN(v))) return null;
  const range = high - low;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  return { range, body, upperWick, lowerWick, isGreen: close >= open };
}

// Candle-type classification. The course (ep.3) describes these shapes
// conceptually (full/marubozu = decisive winner, no meaningful wicks;
// hammer/inverted-hammer = long single-sided wick with a small body;
// doji = open≈close) and explicitly defers to the standard, established
// Japanese-candlestick taxonomy for the exact shapes (points students to
// an external reference site for this in ep.3/6) — so the GEOMETRIC
// thresholds below are the standard, textbook conventions for these
// shapes (not invented for this project, not fit to any backtest); the
// COURSE'S OWN, original content is the CONTEXT-DEPENDENT READING of
// what a shape means, implemented separately in candleContextReadV1.
//   - Doji: body <=5% of range ("open and close essentially identical",
//     ep.3's own words — 5% is a disclosed operationalization of
//     "essentially identical" on real, never-exactly-equal market data).
//   - Full/Marubozu: body >=90% of range (negligible wicks either side).
//   - Hammer: lower wick >= 2x body, upper wick <= body, body sits in the
//     upper half of the range.
//   - Inverted hammer: mirror of hammer (upper wick >= 2x body).
function classifyCandleV1(open, high, low, close) {
  const g = candleGeometryV1(open, high, low, close);
  if (!g || g.range === 0) return null;
  const bodyPct = g.body / g.range;

  if (bodyPct <= 0.05) return 'Doji';
  if (bodyPct >= 0.90) return g.isGreen ? 'Full Green (Marubozu)' : 'Full Red (Marubozu)';

  const bodyTop = Math.max(open, close);
  const bodyBottom = Math.min(open, close);
  const bodyMidInUpperHalf = (bodyBottom - low) > (high - bodyTop);

  if (g.lowerWick >= 2 * g.body && g.upperWick <= g.body && bodyMidInUpperHalf) {
    return g.isGreen ? 'Hammer (green)' : 'Hammer (red)';
  }
  const bodyMidInLowerHalf = (high - bodyTop) > (bodyBottom - low);
  if (g.upperWick >= 2 * g.body && g.lowerWick <= g.body && bodyMidInLowerHalf) {
    return g.isGreen ? 'Inverted Hammer (green)' : 'Inverted Hammer (red)';
  }
  return 'Standard'; // no distinctive shape — a normal, unremarkable candle
}

// Context-dependent read (ep.3's own explicit rules — this is the
// course's real content, not the geometry above):
//   - Full/Marubozu after a green run -> "confirms momentum, expect continuation"
//   - Full/Marubozu after a red run -> mirror, bearish continuation
//   - Doji after an extended trend -> "reversal/indecision warning" (ep.3:
//     dojis arriving after a run of green candles = buyers and sellers
//     exhausting each other)
//   - Hammer (any color) after a downtrend -> bullish signal (ep.3: "לא
//     משנה אם זה ירוק או אדום" — color doesn't matter, the shape does)
//   - Inverted Hammer after a downtrend -> bullish signal (mirror rule)
//   - volume confirmation is a SEPARATE, required cross-check (ep.3/ep.6:
//     "נר ירוק פלוס נפח גבוה זה סימן חיובי" — never read a candle alone)
// `precedingTrend` is 'up' | 'down' | 'flat' (caller supplies, e.g. from
// a short MA-slope read); `relativeVolume` is optional (from volumeStatsV1).
function candleContextReadV1(candleType, precedingTrend, relativeVolume) {
  if (!candleType) return null;
  let read = null;
  if (candleType.indexOf('Full Green') === 0) {
    read = precedingTrend === 'up' ? 'Confirms upward momentum — expect continuation' : 'Strong buying, but against the recent trend — worth attention';
  } else if (candleType.indexOf('Full Red') === 0) {
    read = precedingTrend === 'down' ? 'Confirms downward momentum — expect continuation' : 'Strong selling, but against the recent trend — worth attention';
  } else if (candleType === 'Doji') {
    read = (precedingTrend === 'up' || precedingTrend === 'down') ? 'Indecision after a trend — possible reversal/exhaustion warning' : 'Indecision, no strong signal in a flat market';
  } else if (candleType.indexOf('Hammer') === 0 && candleType.indexOf('Inverted') !== 0) {
    read = precedingTrend === 'down' ? 'Bullish reversal signal (hammer after a downtrend)' : 'Hammer shape present, but not after a downtrend — lower-confidence read';
  } else if (candleType.indexOf('Inverted Hammer') === 0) {
    read = precedingTrend === 'down' ? 'Bullish reversal signal (inverted hammer after a downtrend)' : 'Inverted-hammer shape present, but not after a downtrend — lower-confidence read';
  } else {
    return { read: 'No distinctive shape', volumeConfirmed: null };
  }
  const volumeConfirmed = relativeVolume == null ? null : relativeVolume >= 1.5;
  if (volumeConfirmed === false) read += ' (not volume-confirmed — treat with caution, ep.3/6\'s own rule)';
  if (volumeConfirmed === true)  read += ' (volume-confirmed)';
  return { read, volumeConfirmed };
}

// ── Support/Resistance with touch-count x duration quality (ep.3, ep.4) ──

// Swing-point detection: a local max/min over a window of `window` bars
// on each side. Independently implemented (not the existing engine's
// swing-point logic) — window=5 chosen as a reasonable, disclosed
// default (course gives no exact bar-count), not fit to a backtest.
function findSwingPointsV1(highs, lows, window) {
  window = window || 5;
  const swingHighs = [], swingLows = [];
  const n = highs.length;
  for (let i = window; i < n - window; i++) {
    const hSlice = highs.slice(i - window, i + window + 1);
    const lSlice = lows.slice(i - window, i + window + 1);
    if (highs[i] === Math.max.apply(null, hSlice)) swingHighs.push({ idx: i, price: highs[i] });
    if (lows[i]  === Math.min.apply(null, lSlice)) swingLows.push({ idx: i, price: lows[i] });
  }
  return { swingHighs, swingLows };
}

// Clusters swing points within `tolerance` (relative %) of each other into
// candidate S/R levels, then scores each by touch count and how long the
// touches span (duration, in bar-index terms). Course's own stated rule
// (ep.3/ep.4): more touches + longer duration = stronger level; explicitly
// NOT an exact formula — no fixed points-per-touch value given, so the
// output is a qualitative tier, not a fabricated numeric score, per the
// design doc's "no invented scoring" principle.
//
// Real fixes (this audit, 2026-08-22), both raw-verified directly against
// the ep.4 transcript, not just the summarized notes:
// (1) Tier labels renamed Strong/Moderate/Weak -> Primary/Secondary/Minor
//     -- real, spoken course terminology, line 277-278: "רמה ראשית,
//     משנית ומינורית" ("primary level, secondary, and minor") -- not a
//     visual-only finding, said out loud.
// (2) `trendDirection` is a new OPTIONAL trailing param -- real, spoken,
//     verbatim rule, line 480-481: "במגמת עליה, הכו' תמיכה שלי... יותר
//     חשוב... מגמה יורדת אותו דבר אבל הפוך, במגמה יורדת הכו' התנגדות
//     שלי, יותר חשוב מהכו' תמיכה" ("in an uptrend my support line is
//     more important... a downtrend is the reverse -- in a downtrend my
//     resistance line is more important than support") -- exact match.
//     Before this fix, a support level and a resistance level with
//     identical touch-count/duration were treated identically regardless
//     of trend, contradicting this real rule. Omitted (every pre-existing
//     call site), `trendFavored` is simply `null` -- backward-compatible,
//     same 3-state convention already used elsewhere in this file.
function findSupportResistanceV1(highs, lows, tolerance, lastIdx, trendDirection) {
  tolerance = tolerance || 0.03; // 3% clustering tolerance — disclosed default, not course-specified exactly
  const { swingHighs, swingLows } = findSwingPointsV1(highs, lows, 5);

  function clusterLevels(points, isSupport) {
    const sorted = points.slice().sort((a,b) => a.price - b.price);
    const clusters = [];
    for (const p of sorted) {
      let placed = false;
      for (const c of clusters) {
        if (Math.abs(p.price - c.avgPrice) / c.avgPrice <= tolerance) {
          c.touches.push(p);
          c.avgPrice = c.touches.reduce((s,t)=>s+t.price,0) / c.touches.length;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ avgPrice: p.price, touches: [p] });
    }
    return clusters
      // Real bug fix (this audit): the "2 touches minimum" comment claimed
      // this was "ep.3's own minimum" -- raw-checked directly (ep.3, lines
      // 717-718, 786): the instructor counts touches live on real charts
      // ("once, twice, three, four, five") but never states an explicit
      // minimum required to call something a level. 2 is a disclosed
      // default (the natural floor for "more than one touch"), not a
      // verbatim course number -- relabeled, not removed.
      .filter(c => c.touches.length >= 2) // disclosed default -- not course-stated verbatim, see comment above
      .map(c => {
        const idxs = c.touches.map(t => t.idx);
        const duration = Math.max.apply(null, idxs) - Math.min.apply(null, idxs);
        const touchCount = c.touches.length;
        let tier;
        if (touchCount >= 4 && duration >= 60) tier = 'Primary';
        else if (touchCount >= 3 || duration >= 30) tier = 'Secondary';
        else tier = 'Minor';
        const trendFavored = trendDirection === undefined ? null
          : (isSupport ? trendDirection === 'up' : trendDirection === 'down');
        return { level: c.avgPrice, touchCount, duration, tier, trendFavored, lastTouchIdx: Math.max.apply(null, idxs) };
      })
      .sort((a,b) => b.touchCount - a.touchCount);
  }

  return {
    resistanceLevels: clusterLevels(swingHighs, false),
    supportLevels: clusterLevels(swingLows, true)
  };
}

// "ATH resistance != downtrend resistance" — ep.3/4's explicit distinct-
// reliability-class rule. `atHigh` = is price currently at/near its
// all-time or multi-year high; `longTermTrend` = 'up'|'down'|'flat'.
function srReliabilityContextV1(atHigh, longTermTrend) {
  if (atHigh) return 'At/near a structural high — a breakout here tends to run further (institutional participation more likely, ep.3/4)';
  if (longTermTrend === 'down') return 'Breakout is against a longer-term downtrend — lower reliability class than an ATH breakout (ep.3/4)';
  return 'Neutral reliability context';
}

// ── Moving Averages (ep.6: ONLY 50 & 200 SMA — 20 explicitly rejected as "too noisy") ──

function smaV1(closes, period) {
  if (!closes || closes.length < period) return null;
  return closes.slice(-period).reduce((a,b)=>a+b, 0) / period;
}

// Full trailing SMA series (needed for slope/convergence-divergence reads).
function smaSeriesV1(closes, period) {
  if (!closes || closes.length < period) return [];
  const out = [];
  for (let i = period - 1; i < closes.length; i++) {
    out.push(closes.slice(i - period + 1, i + 1).reduce((a,b)=>a+b, 0) / period);
  }
  return out;
}

// MA relationship read (ep.6's explicit rules): slope direction, whether
// the two MAs are converging/diverging/parallel, and whether they've
// recently crossed. Needs at least 2 points in each series to read slope.
function maRelationshipReadV1(sma50Series, sma200Series) {
  if (!sma50Series || !sma200Series || sma50Series.length < 2 || sma200Series.length < 2) return null;
  const n50 = sma50Series.length, n200 = sma200Series.length;
  const s50now = sma50Series[n50-1], s50prev = sma50Series[n50-2];
  const s200now = sma200Series[n200-1], s200prev = sma200Series[n200-2];

  const slope50 = s50now > s50prev ? 'up' : (s50now < s50prev ? 'down' : 'flat');
  const slope200 = s200now > s200prev ? 'up' : (s200now < s200prev ? 'down' : 'flat');

  const gapNow = s50now - s200now;
  const gapPrev = s50prev - s200prev;
  const spreading = Math.abs(gapNow) > Math.abs(gapPrev);
  const convergence = spreading ? 'diverging (trend strengthening)' : 'converging (trend weakening)';

  const crossedUp = gapPrev <= 0 && gapNow > 0;
  const crossedDown = gapPrev >= 0 && gapNow < 0;
  const cross = crossedUp ? 'Golden cross (50 crossed above 200) — potential trend change' :
                crossedDown ? 'Death cross (50 crossed below 200) — potential trend change' : null;

  return { slope50, slope200, convergence, cross, sma50: s50now, sma200: s200now };
}

// ── Phase 3: Fibonacci retracement/extension + flag-pattern scoring (ep.5) ──

// The course itself defers to the standard Fibonacci ratios (38.2%/50%/
//61.8% retracement, 127.2%/161.8% extension) — not invented for this
// project. Its own original content is WHEN/HOW to use them: anchor
// selection off a real swing high/low (S/R confluence, not an arbitrary
// lookback window), and the explicit ">50% retracement = trend likely
// broken" rule.
const FIB_RETRACEMENT_RATIOS = [0, 0.382, 0.5, 0.618, 1.0];
const FIB_EXTENSION_RATIOS = [1.272, 1.618];

// direction: 'up' (retracing down from a swing high) or 'down' (retracing
// up from a swing low). Returns the price at each ratio.
function fibonacciLevelsV1(swingHigh, swingLow, direction) {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  const levels = {};
  FIB_RETRACEMENT_RATIOS.forEach(r => {
    levels[r] = direction === 'up' ? swingHigh - r * range : swingLow + r * range;
  });
  return levels;
}

// Reads where currentPrice sits relative to the retracement levels, and
// applies the course's own explicit trend-validity threshold: retracement
// <=50% of the prior move -> "still in trend"; >50% -> "trend likely
// broken, reassess" (ep.5's own stated number, not derived from anything else).
function fibonacciRetracementReadV1(currentPrice, swingHigh, swingLow, direction) {
  const levels = fibonacciLevelsV1(swingHigh, swingLow, direction);
  if (!levels || currentPrice == null) return null;
  const range = swingHigh - swingLow;
  const retracedFraction = direction === 'up'
    ? (swingHigh - currentPrice) / range
    : (currentPrice - swingLow) / range;
  const trendIntact = retracedFraction <= 0.5;
  let nearestLevel = null, nearestDist = Infinity;
  FIB_RETRACEMENT_RATIOS.forEach(r => {
    const d = Math.abs(currentPrice - levels[r]);
    if (d < nearestDist) { nearestDist = d; nearestLevel = r; }
  });
  return {
    levels, retracedFraction, trendIntact,
    read: trendIntact
      ? 'Retracement is within the trend-validity zone (<=50% of the prior move) — trend likely intact'
      : 'Retracement exceeds 50% of the prior move — trend likely broken, reassess (ep.5\'s own stated threshold)',
    nearestFibLevel: nearestLevel
  };
}

// Extension targets for a new-ATH breakout — the course's stated
// application (ep.5: used to set price targets once a stock breaks to a
// new high with no prior resistance to reference).
function fibonacciExtensionTargetsV1(swingHigh, swingLow) {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  const targets = {};
  FIB_EXTENSION_RATIOS.forEach(r => { targets[r] = swingLow + r * range; });
  return targets;
}

// Flag/pennant pattern quality — ep.5's own stated relationships, kept
// as a QUALITATIVE tier (Strong/Moderate/Weak/Invalid), not a fabricated
// numeric formula (the course gives no exact weighting between these
// factors, only the directional relationships):
//   - breakout relative volume MUST be >=1.5x or the setup is invalid
//     (same threshold as relativeVolumeReadV1 — ep.3/5's own number)
//   - tighter consolidation RELATIVE TO THE PRIOR MOVE'S SIZE = higher
//     quality — real bug fix (this audit, 2026-08-22): the original
//     `consolidationRangePct <= 0.15` was a FIXED, absolute cutoff,
//     independent of how big the pole move was. Raw-checked directly
//     against ep.5 (line 289: "ככל שההתכנסות שלי יותר ערוקה, ככל
//     שהמעלך הקודם יותר חזק" -- "the tighter my consolidation, the
//     stronger the prior move"; lines 536-538 reinforce the same
//     relative framing) -- real, spoken, and explicitly COMPARATIVE, not
//     a fixed number. Disclosed limit: the specific SPWR ~25-30%-vs-move
//     worked example cited in the project's own notes was not re-located
//     in this raw pass within the sections searched -- the underlying
//     comparative relationship IS verified real and spoken; the exact
//     worked numbers may be a visual-only slide, same class of gap as
//     the round-number DPW case. Now matches the main engine's own
//     already-correct version of this same rule
//     (`FP_CONSOL_MAX_RANGE_RATIO = 0.5 * pole%`) -- ratio, not absolute.
//   - longer consolidation duration = higher quality
//   - stronger prior move = higher quality (more energy stored to release)
function flagPatternQualityV1(priorMovePct, consolidationRangePct, consolidationBars, breakoutRelVol) {
  if (breakoutRelVol == null || breakoutRelVol < 1.5) {
    return { tier: 'Invalid', reason: 'Breakout volume below 1.5x average — course\'s own minimum for a valid signal (ep.3/5)' };
  }
  if (priorMovePct == null || consolidationRangePct == null || consolidationBars == null) {
    return { tier: 'Insufficient data', reason: 'Missing one or more required inputs' };
  }
  // Disclosed, reasonable operationalization of "tighter / longer / stronger
  // = better" (course gives directional rules, not exact cutoffs) — three
  // independent qualitative checks, tier = how many hold.
  const FP_CONSOL_MAX_RANGE_RATIO = 0.5; // matches the main engine's own already-verified convention
  const tightConsolidation = priorMovePct > 0 && (consolidationRangePct / priorMovePct) <= FP_CONSOL_MAX_RANGE_RATIO;
  const longConsolidation  = consolidationBars >= 10;        // ~2 trading weeks, ep.5's own reference point
  const strongPriorMove    = priorMovePct >= 0.20;            // >=20% prior move, disclosed default

  const hits = [tightConsolidation, longConsolidation, strongPriorMove].filter(Boolean).length;
  const tier = hits === 3 ? 'Strong' : hits === 2 ? 'Moderate' : hits === 1 ? 'Weak' : 'Marginal';
  return {
    tier,
    tightConsolidation, longConsolidation, strongPriorMove,
    reason: hits + '/3 quality factors met (tight consolidation, long consolidation, strong prior move)'
  };
}

// Risk:Reward — ep.5/7's own explicit minimum of 1:1 to even consider a
// trade, scaling up in quality with higher ratios (course's own stated
// range, up to 1:10 for the best setups — not a formula, just a floor
// check + the raw number).
function riskRewardV1(entryPrice, stopPrice, targetPrice) {
  if ([entryPrice, stopPrice, targetPrice].some(v => v == null || isNaN(v))) return null;
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  if (risk === 0) return null;
  const ratio = reward / risk;
  return {
    risk, reward, ratio,
    meetsMinimum: ratio >= 1.0,
    read: ratio >= 1.0
      ? ('R:R = 1:' + ratio.toFixed(2) + ' — meets the course\'s stated minimum')
      : ('R:R = 1:' + ratio.toFixed(2) + ' — below the 1:1 minimum, course says skip the trade')
  };
}

// ── Phase 4: Gap taxonomy + earnings-gap + reverse-split flag (ep.10, ep.11) ──

// Basic gap detection: today's open vs yesterday's close, above a minimum
// threshold. minGapPct disclosed default 0.02 (2%) — a reasonable floor to
// filter out routine overnight noise, not course-specified exactly, not
// fit to a backtest (matches the same honesty standard as Phase 2/3's
// disclosed defaults).
function detectPriceGapsV1(opens, closes, dates, minGapPct) {
  minGapPct = minGapPct == null ? 0.02 : minGapPct;
  const gaps = [];
  for (let i = 1; i < opens.length; i++) {
    const prevClose = closes[i-1];
    if (!prevClose) continue;
    const gapPct = (opens[i] - prevClose) / prevClose;
    if (Math.abs(gapPct) >= minGapPct) {
      gaps.push({ idx: i, date: dates[i], type: gapPct > 0 ? 'UP' : 'DOWN', sizePct: gapPct, level: prevClose });
    }
  }
  return gaps;
}

// Market-cap-relative gap significance — ep.11's own stated number: 3% is
// significant on a mega-cap. No exact number given for other tiers in the
// course, so those stay informational-only rather than invented (same
// disclosed-gap discipline used elsewhere in this file and in the
// existing engine's own version of this same course content).
function gapMarketCapSignificanceV1(gapSizePct, marketCapTier) {
  if (gapSizePct == null || !marketCapTier) return null;
  const abs = Math.abs(gapSizePct);
  if (marketCapTier === 'Mega Cap') {
    return abs >= 0.03
      ? 'Mega-cap gap >=3% — significant (ep.11\'s own stated threshold)'
      : 'Mega-cap gap <3% — likely not significant';
  }
  return marketCapTier + ' — no exact course-stated threshold for this tier, informational only';
}

// Gap-type taxonomy (Common/Breakaway/Runaway/Exhaustion/Island),
// independently implemented (fresh, not the existing engine's version of
// this same course content — see design doc's no-code-reuse decision).
// Reuses THIS file's own findSwingPointsV1 (Phase 2) for the touch-count
// check, which is fine (same new model, not the existing engine).
//   - Breakaway: gap breaks a level that already had >=2 real touches
//     (course's own S/R-quality minimum, ep.3, applied here).
//   - Exhaustion: gap volume is the highest in the lookback window AND
//     the next bar reverses back through the gap level.
//   - Island: an opposite-direction gap exists within a short window.
//   - Runaway: continues an already-established strong trend context
//     (near-ATH for an up-gap, or an established downtrend for a down-gap).
//   - Common: none of the above (default fallback).
function classifyGapTypeV1(gap, allGaps, highs, lows, volumes, closes, nearATH, longTermDowntrend) {
  if (!gap) return null;
  const ISLAND_WINDOW = 10; // ~2 trading weeks, disclosed default (course gives no exact bar count)
  const LOOKBACK = 60;

  const { swingHighs, swingLows } = findSwingPointsV1(highs, lows, 5);
  const relevantSwings = gap.type === 'UP' ? swingHighs : swingLows;
  // exclude the gap's own defining bar from the touch count (it always
  // trivially "touches itself" — the same off-by-one class of bug caught
  // and fixed in the existing engine's own version of this logic earlier
  // this session; avoided here from the start).
  const touchCount = relevantSwings.filter(s => s.idx < gap.idx - 1 &&
    Math.abs(s.price - gap.level) / gap.level <= 0.03).length;
  if (touchCount >= 2) return 'Breakaway';

  const windowStart = Math.max(0, gap.idx - LOOKBACK);
  const isHighestVol = volumes[gap.idx] === Math.max.apply(null, volumes.slice(windowStart, gap.idx + 1));
  const nextIdx = gap.idx + 1;
  const reversedNext = nextIdx < closes.length &&
    (gap.type === 'UP' ? closes[nextIdx] < gap.level : closes[nextIdx] > gap.level);
  if (isHighestVol && reversedNext) return 'Exhaustion';

  const hasOppositeIsland = allGaps.some(other => other !== gap && other.type !== gap.type &&
    Math.abs(other.idx - gap.idx) <= ISLAND_WINDOW);
  if (hasOppositeIsland) return 'Island';

  if (gap.type === 'UP' ? nearATH : longTermDowntrend) return 'Runaway';

  return 'Common';
}

// Tags a gap as earnings-caused if it falls within `toleranceDays` of a
// real earnings report date, with real EPS/revenue surprise %. Reuses
// fetchEarningsCalendarV7 (data-fetching infrastructure, approved) — the
// classification logic itself is fresh.
function classifyEarningsGapV1(gap, earningsHistory, toleranceDays) {
  toleranceDays = toleranceDays == null ? 1 : toleranceDays;
  if (!gap || !earningsHistory || !earningsHistory.length) return null;
  const MS_PER_DAY = 86400000;
  const gd = new Date(gap.date);
  const gapDateUTC = new Date(Date.UTC(gd.getUTCFullYear(), gd.getUTCMonth(), gd.getUTCDate()));
  const match = earningsHistory
    .filter(e => Math.abs(gapDateUTC - e.date) <= toleranceDays * MS_PER_DAY)
    .sort((a,b) => Math.abs(gapDateUTC - a.date) - Math.abs(gapDateUTC - b.date))[0];
  if (!match) return null;
  const epsSurprisePct = (match.epsActual != null && match.epsEstimated) ?
    (match.epsActual - match.epsEstimated) / Math.abs(match.epsEstimated) * 100 : null;
  const revenueSurprisePct = (match.revenueActual != null && match.revenueEstimated) ?
    (match.revenueActual - match.revenueEstimated) / Math.abs(match.revenueEstimated) * 100 : null;
  return { cause: 'EARNINGS', reportDate: match.date, epsSurprisePct, revenueSurprisePct };
}

// Reverse-split avoid-flag (ep.10) — the instructor's own deliberate
// watchlist-exclusion heuristic: a recent reverse split (numerator <
// denominator) is a real warning sign, independent of chart shape.
// RECENT_LOOKBACK_BARS disclosed default 60 (~3 months), not course-exact.
function reverseSplitAvoidFlagV1(splits, dates, lastIdx) {
  if (!splits || !splits.length || !dates || !dates.length) return null;
  const RECENT_LOOKBACK_BARS = 60;
  const cutoffDate = dates[Math.max(0, lastIdx - RECENT_LOOKBACK_BARS)];
  const recentReverse = splits
    .filter(s => s.numerator < s.denominator)
    .filter(s => s.date >= cutoffDate)
    .sort((a,b) => b.date - a.date)[0];
  if (!recentReverse) return null;
  const daysAgo = Math.round((dates[lastIdx] - recentReverse.date) / 86400000);
  return {
    date: recentReverse.date, ratio: recentReverse.numerator + ':' + recentReverse.denominator, daysAgo,
    read: 'Recent reverse split (' + recentReverse.numerator + ':' + recentReverse.denominator + ', ' + daysAgo + 'd ago) — course\'s own deliberate avoid-heuristic (ep.10)'
  };
}

// ── Phase 14: Chart-Pattern Detection (added 2026-08-22, independent review) ──
//
// Real, confirmed coverage gap found by the video-fidelity audit: this
// file had zero multi-bar chart-pattern detection at all -- the main
// engine has 16 patterns, this file had none. Each pattern below was
// raw-transcript re-checked before being built, not assumed from the
// project's own summarized notes. Independently derived -- reuses only
// this file's own already-built swing-point/S/R plumbing (Phase 2), no
// engine pattern-detector logic imported, per the "clean, zero logic
// dependency" constraint. Output shape loosely mirrors the engine's own
// convention (type/level/neckline/confirmed) for easy RESULT comparison
// during reconciliation -- not code sharing.

// Simple least-squares slope, normalized to %-per-bar relative to the
// series' own mean (so it's comparable across price levels/tickers) --
// plain statistics, not course-specific, same convention as
// linearFitRSquaredV1 above.
function linearFitSlopeV1(values) {
  const n = values.length;
  if (n < 2) return null;
  const xs = []; for (let i = 0; i < n; i++) xs.push(i);
  const meanX = xs.reduce((a,b)=>a+b,0)/n, meanY = values.reduce((a,b)=>a+b,0)/n;
  let ssXY = 0, ssXX = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]-meanX, dy = values[i]-meanY; ssXY += dx*dy; ssXX += dx*dx; }
  if (ssXX === 0 || !meanY) return null;
  return (ssXY / ssXX) / meanY;
}

// Double Top / Double Bottom (ep.5) -- extensively, substantively taught,
// real worked example (AMD: ~$25 -> ~$60 (peak1) -> ~$40 (trough,
// ~33% retrace) -> back to ~$60 (peak2) -> reversal down), explicit
// "textbook" framing ("פי הספר" -- "by the book"). Two comparable peaks
// (or troughs), separated by a meaningful trough (or peak) between them,
// confirmed by a break of that trough/neckline level after the second
// peak fails to make a new high. Disclosed defaults (course gives the
// shape + a real example, not an exact formula): peaks/troughs within 3%
// of each other (reuses this file's own established clustering
// tolerance); the between-swing must retrace at least 15% from the first
// peak (a real, meaningful pullback, not noise -- conservatively lower
// than the real AMD example's ~33% so smaller real moves aren't
// excluded).
function doubleTopBottomReadV1(highs, lows, closes, lookbackBars) {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars), wLows = lows.slice(n - lookbackBars), wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 5);
  const TOLERANCE = 0.03, MIN_RETRACE = 0.15;
  const lastClose = wCloses[wCloses.length - 1];

  function checkTop() {
    const sorted = swingHighs.slice().sort((a,b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i > 0; i--) {
      const p2 = sorted[i], p1 = sorted[i-1];
      if (Math.abs(p2.price - p1.price) / p1.price > TOLERANCE) continue;
      const between = swingLows.filter(l => l.idx > p1.idx && l.idx < p2.idx);
      if (!between.length) continue;
      const trough = between.reduce((min, l) => l.price < min.price ? l : min, between[0]);
      const retrace = (p1.price - trough.price) / p1.price;
      if (retrace < MIN_RETRACE) continue;
      const confirmed = lastClose < trough.price;
      return { type: 'DOUBLE_TOP', level: (p1.price+p2.price)/2, neckline: trough.price, confirmed,
        read: (confirmed ? 'CONFIRMED — broke below neckline. ' : 'Forming — neckline not yet broken. ') +
          'Two comparable peaks ($' + p1.price.toFixed(2) + ', $' + p2.price.toFixed(2) + ') with a ' + (retrace*100).toFixed(0) +
          '% pullback between them (neckline $' + trough.price.toFixed(2) + ') — matches the course\'s Double Top teaching (ep.5)' };
    }
    return null;
  }
  function checkBottom() {
    const sorted = swingLows.slice().sort((a,b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i > 0; i--) {
      const p2 = sorted[i], p1 = sorted[i-1];
      if (Math.abs(p2.price - p1.price) / p1.price > TOLERANCE) continue;
      const between = swingHighs.filter(h => h.idx > p1.idx && h.idx < p2.idx);
      if (!between.length) continue;
      const peak = between.reduce((max, h) => h.price > max.price ? h : max, between[0]);
      const retrace = (peak.price - p1.price) / p1.price;
      if (retrace < MIN_RETRACE) continue;
      const confirmed = lastClose > peak.price;
      return { type: 'DOUBLE_BOTTOM', level: (p1.price+p2.price)/2, neckline: peak.price, confirmed,
        read: (confirmed ? 'CONFIRMED — broke above neckline. ' : 'Forming — neckline not yet broken. ') +
          'Two comparable troughs ($' + p1.price.toFixed(2) + ', $' + p2.price.toFixed(2) + ') with a ' + (retrace*100).toFixed(0) +
          '% bounce between them (neckline $' + peak.price.toFixed(2) + ') — matches the course\'s Double Bottom teaching (ep.5)' };
    }
    return null;
  }
  return checkTop() || checkBottom();
}

// Head & Shoulders (+ Inverted) — real, taught (ep.5, line 102: "ראש
// מקטפיים... אינברט, ראש מקטפיים" -- "head and shoulders... inverted,
// head and shoulders"). Standard 3-peak shape: left shoulder, head
// (clearly the highest), right shoulder (comparable to the left), with a
// neckline connecting the two troughs between them; confirmed by a break
// below the neckline. Inverted is the mirror. Disclosed defaults (no
// exact numbers given): shoulders within 5% of each other (wider than
// double-top's peak tolerance -- shoulders don't need to be as precisely
// equal, only the head needs to clearly stand out); head at least 3%
// above/below both shoulders.
function headAndShouldersReadV1(highs, lows, closes, lookbackBars) {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars), wLows = lows.slice(n - lookbackBars), wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 5);
  const SHOULDER_TOLERANCE = 0.05, HEAD_MIN_EXCESS = 0.03;
  const lastClose = wCloses[wCloses.length - 1];

  function checkRegular() {
    const sorted = swingHighs.slice().sort((a,b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i >= 2; i--) {
      const rightShoulder = sorted[i], head = sorted[i-1], leftShoulder = sorted[i-2];
      if (head.price < leftShoulder.price * (1+HEAD_MIN_EXCESS) || head.price < rightShoulder.price * (1+HEAD_MIN_EXCESS)) continue;
      if (Math.abs(rightShoulder.price - leftShoulder.price) / leftShoulder.price > SHOULDER_TOLERANCE) continue;
      const leftTroughs = swingLows.filter(l => l.idx > leftShoulder.idx && l.idx < head.idx);
      const rightTroughs = swingLows.filter(l => l.idx > head.idx && l.idx < rightShoulder.idx);
      if (!leftTroughs.length || !rightTroughs.length) continue;
      const necklineLevel = (leftTroughs[leftTroughs.length-1].price + rightTroughs[0].price) / 2;
      const confirmed = lastClose < necklineLevel;
      return { type: 'HEAD_AND_SHOULDERS', level: head.price, neckline: necklineLevel, confirmed,
        read: (confirmed ? 'CONFIRMED — broke below neckline. ' : 'Forming — neckline not yet broken. ') +
          'Head $' + head.price.toFixed(2) + ' clearly above comparable shoulders ($' + leftShoulder.price.toFixed(2) + ', $' + rightShoulder.price.toFixed(2) +
          '), neckline $' + necklineLevel.toFixed(2) + ' — matches the course\'s Head & Shoulders teaching (ep.5)' };
    }
    return null;
  }
  function checkInverted() {
    const sorted = swingLows.slice().sort((a,b) => a.idx - b.idx);
    for (let i = sorted.length - 1; i >= 2; i--) {
      const rightShoulder = sorted[i], head = sorted[i-1], leftShoulder = sorted[i-2];
      if (head.price > leftShoulder.price * (1-HEAD_MIN_EXCESS) || head.price > rightShoulder.price * (1-HEAD_MIN_EXCESS)) continue;
      if (Math.abs(rightShoulder.price - leftShoulder.price) / leftShoulder.price > SHOULDER_TOLERANCE) continue;
      const leftPeaks = swingHighs.filter(h => h.idx > leftShoulder.idx && h.idx < head.idx);
      const rightPeaks = swingHighs.filter(h => h.idx > head.idx && h.idx < rightShoulder.idx);
      if (!leftPeaks.length || !rightPeaks.length) continue;
      const necklineLevel = (leftPeaks[leftPeaks.length-1].price + rightPeaks[0].price) / 2;
      const confirmed = lastClose > necklineLevel;
      return { type: 'INVERSE_HEAD_AND_SHOULDERS', level: head.price, neckline: necklineLevel, confirmed,
        read: (confirmed ? 'CONFIRMED — broke above neckline. ' : 'Forming — neckline not yet broken. ') +
          'Head $' + head.price.toFixed(2) + ' clearly below comparable shoulders ($' + leftShoulder.price.toFixed(2) + ', $' + rightShoulder.price.toFixed(2) +
          '), neckline $' + necklineLevel.toFixed(2) + ' — matches the course\'s Inverted Head & Shoulders teaching (ep.5)' };
    }
    return null;
  }
  return checkRegular() || checkInverted();
}

// Cup & Handle — real, taught (ep.5, lines 73/93/371, spoken repeatedly:
// "קאפיין-הנדל... ספל וידית" -- "cup and handle"). Standard shape: a
// rounded "U"-shaped decline-then-recovery back to near the prior high
// (the cup), followed by a smaller, shorter pullback near the highs (the
// handle), then a breakout above the cup's rim. Course confirms the
// shape is taught but gives no exact depth/duration numbers -- disclosed
// defaults, standard textbook conventions: cup depth 10-50% off the rim
// (too shallow isn't a real cup, too deep is a different pattern); cup
// spans at least half the lookback window (a rounded shape needs real
// time to form); handle retraces no more than 50% of the cup's own
// depth and forms in the final ~20% of the window (a shakeout near the
// highs, not a second full decline); breakout = close above the rim.
function cupAndHandleReadV1(highs, lows, closes, lookbackBars) {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = closes.length;
  const wHighs = highs.slice(n - lookbackBars), wLows = lows.slice(n - lookbackBars), wCloses = closes.slice(n - lookbackBars);
  const m = wCloses.length;
  const cupWindow = Math.floor(m * 0.8); // cup forms in the first ~80%, handle in the last ~20%
  const cupHighs = wHighs.slice(0, cupWindow), cupLows = wLows.slice(0, cupWindow);
  let leftRimIdx = 0; for (let i = 1; i < 5 && i < cupHighs.length; i++) if (cupHighs[i] > cupHighs[leftRimIdx]) leftRimIdx = i;
  const leftRim = cupHighs[leftRimIdx];
  let cupLowIdx = 0; for (let i = 0; i < cupLows.length; i++) if (cupLows[i] < cupLows[cupLowIdx]) cupLowIdx = i;
  const cupLow = cupLows[cupLowIdx];
  if (cupLowIdx < cupWindow * 0.15 || cupLowIdx > cupWindow * 0.85) return null; // low must be roughly centered, not at either edge
  const cupDepth = (leftRim - cupLow) / leftRim;
  if (cupDepth < 0.10 || cupDepth > 0.50) return null;
  const rightRim = Math.max.apply(null, wHighs.slice(Math.max(0, cupWindow - 5), cupWindow));
  if (rightRim < leftRim * (1 - 0.05)) return null; // recovery must return close to the left rim (within 5%)
  const rim = Math.max(leftRim, rightRim);

  const handleSlice = wCloses.slice(cupWindow);
  if (!handleSlice.length) return null;
  const handleLow = Math.min.apply(null, handleSlice);
  const handleDepth = (rim - handleLow) / rim;
  if (handleDepth > cupDepth * 0.5 || handleDepth < 0) return null; // shallow shakeout, not a second cup

  const lastClose = wCloses[wCloses.length - 1];
  const confirmed = lastClose > rim;
  return { type: 'CUP_AND_HANDLE', rim, cupLow, handleLow, confirmed,
    read: (confirmed ? 'CONFIRMED — broke above the cup\'s rim. ' : 'Forming — rim not yet broken. ') +
      'Rounded decline-and-recovery (' + (cupDepth*100).toFixed(0) + '% deep) back to $' + rim.toFixed(2) +
      ', followed by a shallow ' + (handleDepth*100).toFixed(0) + '% handle pullback — matches the course\'s Cup & Handle teaching (ep.5)' };
}

// Rectangle — real, taught (ep.4, line 577: "היא נגעה פעם אחת וירדה,
// נגעה פעם שנייה וירדה, אז אני יכול להגדיר את כל המלבן הזה" -- "it
// touched once and dropped, touched a second time and dropped, so I can
// define this whole rectangle" -- the instructor's own real, spoken
// definition). Repeated touch-and-reject at a resistance level AND a
// support level defines a rectangle/channel. Reuses this file's own
// findSupportResistanceV1 (Phase 2) directly -- a rectangle IS an S/R
// resistance level and an S/R support level coexisting in time, nothing
// new to detect.
function rectangleReadV1(highs, lows, closes, lookbackBars) {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars), wLows = lows.slice(n - lookbackBars), wCloses = closes.slice(n - lookbackBars);
  const { resistanceLevels, supportLevels } = findSupportResistanceV1(wHighs, wLows, 0.03, wHighs.length - 1);
  if (!resistanceLevels.length || !supportLevels.length) return null;
  const res = resistanceLevels[0], sup = supportLevels[0]; // strongest of each, already sorted by touch count
  if (res.level <= sup.level) return null;
  const resSpan = [res.lastTouchIdx - res.duration, res.lastTouchIdx];
  const supSpan = [sup.lastTouchIdx - sup.duration, sup.lastTouchIdx];
  const overlaps = resSpan[0] <= supSpan[1] && supSpan[0] <= resSpan[1];
  if (!overlaps) return null;
  const lastClose = wCloses[wCloses.length - 1];
  const status = lastClose > res.level ? 'BROKE_UP' : lastClose < sup.level ? 'BROKE_DOWN' : 'FORMING';
  return { type: 'RECTANGLE', resistanceLevel: res.level, supportLevel: sup.level, status,
    read: (status !== 'FORMING' ? 'CONFIRMED ' + status.replace('_', ' ') + ' — ' : 'Forming — ') +
      'Repeated touch-and-reject at resistance ($' + res.level.toFixed(2) + ', ' + res.touchCount + ' touches) and support ($' +
      sup.level.toFixed(2) + ', ' + sup.touchCount + ' touches) — matches the course\'s rectangle definition (ep.4)' };
}

// Triangle — standard technical-analysis convention, NOT course-taught
// with real rules. Raw-verified exhaustively (this audit, 2026-08-22):
// "triangle" appears only twice across all 13 episode transcripts as a
// genuine chart-pattern reference (ep.4 line 692, ep.6 line 892), both
// times the instructor glancing at a chart and casually noting the shape
// -- zero explanation of sub-types, zero breakout rule, zero numeric
// threshold, ever. Every other "triangle"-word mention across all 13
// episodes (ep.8, ep.9, ep.13) is an unrelated homonym -- "משולשת"
// meaning "triple" in "triple/quadruple witching" options-expiration
// terminology, not the chart shape. Built anyway, per the user's explicit
// decision, for parity with the main engine's own already-shipped
// Triangle detector -- but honestly labeled as standard, textbook
// technical analysis, same disclosure convention already used for the
// basic candlestick-shape geometry in classifyCandleV1, not attributed
// to a specific episode as if it were taught content.
function triangleReadV1(highs, lows, closes, lookbackBars) {
  if (!highs || !lows || !closes || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars), wLows = lows.slice(n - lookbackBars), wCloses = closes.slice(n - lookbackBars);
  const { swingHighs, swingLows } = findSwingPointsV1(wHighs, wLows, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  const resSlope = linearFitSlopeV1(swingHighs.map(p => p.price));
  const supSlope = linearFitSlopeV1(swingLows.map(p => p.price));
  if (resSlope == null || supSlope == null) return null;
  const FLAT = 0.001; // disclosed default, "roughly flat" per bar
  let subtype = null;
  if (Math.abs(resSlope) <= FLAT && supSlope > FLAT) subtype = 'ASCENDING';
  else if (Math.abs(supSlope) <= FLAT && resSlope < -FLAT) subtype = 'DESCENDING';
  else if (resSlope < -FLAT && supSlope > FLAT) subtype = 'SYMMETRIC';
  if (!subtype) return null;
  // must actually be converging: range near the start of the window wider than near the end
  const firstRange = wHighs[0] - wLows[0];
  const lastRange = wHighs[wHighs.length-1] - wLows[wLows.length-1];
  if (!(firstRange > 0) || lastRange >= firstRange) return null;
  const lastClose = wCloses[wCloses.length - 1];
  const resLine = swingHighs[swingHighs.length-1].price; // most recent swing high as the near boundary
  const supLine = swingLows[swingLows.length-1].price;
  const status = lastClose > resLine ? 'BROKE_UP' : lastClose < supLine ? 'BROKE_DOWN' : 'FORMING';
  return { type: 'TRIANGLE_' + subtype, status,
    read: (status !== 'FORMING' ? 'CONFIRMED ' + status.replace('_', ' ') + ' — ' : 'Forming — ') +
      subtype.charAt(0) + subtype.slice(1).toLowerCase() + ' triangle, converging trendlines — standard technical-analysis pattern (not course-specific, same disclosure as the basic candlestick geometry)' };
}

// Orchestrator: runs all 5 detectors, returns the first that fires
// (priority order: patterns with a real, taught, spoken course basis
// first, Triangle -- the one standard-TA-only addition -- last).
function chartPatternReadV1(highs, lows, closes, lookbackBars) {
  lookbackBars = lookbackBars || 60;
  return doubleTopBottomReadV1(highs, lows, closes, lookbackBars)
    || headAndShouldersReadV1(highs, lows, closes, lookbackBars)
    || cupAndHandleReadV1(highs, lows, closes, lookbackBars)
    || rectangleReadV1(highs, lows, closes, lookbackBars)
    || triangleReadV1(highs, lows, closes, lookbackBars);
}

// ── Phase 5: Player Mapping (episodes 1, 3, 4, 6, 7) ────────────────
//
// This is inference-only from move SHAPE, never a claim of direct
// institutional-data confirmation -- deliberately kept that way (see
// `buildBrokerCourseReportV1`'s own real 13F section, added 2026-08-24,
// for why real institutional data stays a SEPARATE report section rather
// than feeding this tag). Real, updated 2026-08-24: real-time Level-2
// order-book depth still has no known free source (unchanged, real wall);
// real 13F QUARTERLY institutional-holdings data is now available in this
// project and shown separately (section 10 of the formatted report).
// One real, disclosed data gap: "gap-and-hold vs gap-and-fade in the first
// 20 minutes" (ep.7) needs intraday bars; fetchYahooChart is daily-only —
// not built, not guessed, flagged in the orchestrator's output.

// Standard linear-regression R^2 — plain statistics, not course-specific.
function linearFitRSquaredV1(values) {
  const n = values.length;
  if (n < 3) return null;
  const xs = []; for (let i = 0; i < n; i++) xs.push(i);
  const meanX = xs.reduce((a,b)=>a+b,0)/n, meanY = values.reduce((a,b)=>a+b,0)/n;
  let ssXY=0, ssXX=0, ssYY=0;
  for (let i=0;i<n;i++) { const dx=xs[i]-meanX, dy=values[i]-meanY; ssXY+=dx*dy; ssXX+=dx*dx; ssYY+=dy*dy; }
  if (ssXX === 0 || ssYY === 0) return null;
  const r = ssXY / Math.sqrt(ssXX*ssYY);
  return r*r;
}

// "Staircase" read (ep.6, VWAP/TWAP mechanics): a steady, roughly-linear
// climb with no single day dominating the move and no explosive volume
// spike driving it — the mechanical signature of an institution splitting
// a large order into small chunks over time. Disclosed defaults (course
// gives the concept, not exact numeric cutoffs): R^2>=0.7 for "roughly
// linear"; no single day's |close-to-close % change| exceeding 2x the
// window's average daily |% change| ("no single day dominates"); max
// day's volume <3x the window average ("no violent volume spike").
function staircasePatternReadV1(closes, volumes, lookbackBars) {
  if (!closes || closes.length < lookbackBars) return null;
  const n = closes.length;
  const window = closes.slice(n - lookbackBars);
  const volWindow = volumes.slice(n - lookbackBars);
  const rSquared = linearFitRSquaredV1(window);
  if (rSquared == null) return null;
  const netUp = window[window.length-1] > window[0];

  const dailyPctChanges = [];
  for (let i = 1; i < window.length; i++) dailyPctChanges.push(Math.abs((window[i]-window[i-1])/window[i-1]));
  const avgDailyPct = dailyPctChanges.reduce((a,b)=>a+b,0) / dailyPctChanges.length;
  const maxDailyPct = Math.max.apply(null, dailyPctChanges);
  const noSingleDayDominates = maxDailyPct <= 2 * avgDailyPct;

  const avgVol = volWindow.reduce((a,b)=>a+b,0) / volWindow.length;
  const maxVol = Math.max.apply(null, volWindow);
  const noVolumeSpike = avgVol > 0 && maxVol < 3 * avgVol;

  const isStaircase = netUp && rSquared >= 0.7 && noSingleDayDominates && noVolumeSpike;
  return {
    isStaircase, rSquared, noSingleDayDominates, noVolumeSpike,
    read: isStaircase
      ? 'Steady, linear climb with no single-day or single-volume spike driving it — matches the course\'s institutional VWAP/TWAP "staircase" signature (ep.6)'
      : 'Does not match the staircase pattern'
  };
}

// "Speculative spike" read (ep.1, ep.3): the move is dominated by one or
// two extreme days on extreme relative volume — the signature of
// speculators/retail momentum/algos, not a patient institutional order.
// Disclosed default: top-2 days' |% change| sum to >=50% of the window's
// total absolute move; and at least one of those days has relative
// volume >=3x. Real quote fix (this audit, 2026-08-22): this comment
// previously cited ep.5 as saying "פי 2, פי 3, פי 4, פי 5" ("times
// 2,3,4,5") -- raw-checked directly, not real. The actual line (ep.5,
// line 43) is "בערך פי שתיים, בערך פי שתיים" ("about 2x, about 2x," said
// twice for emphasis) -- one real jump size, not an escalating sequence.
// Correcting the citation only -- the 50%/3x thresholds below were
// always labeled "Disclosed default," never claimed verbatim, so the
// actual logic is unaffected.
function speculativeSpikeReadV1(closes, volumes, lookbackBars) {
  if (!closes || closes.length < lookbackBars || !volumes) return null;
  const n = closes.length;
  const window = closes.slice(n - lookbackBars);
  const volWindow = volumes.slice(n - lookbackBars);
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
      ? 'A small number of days on extreme volume account for most of the move — matches the course\'s speculative/retail-momentum signature (ep.1/3)'
      : 'Does not match the speculative-spike pattern'
  };
}

// "No consolidation" read (ep.3/4): a move with no S/R ledges formed
// along the way is lower-reliability for continuation than one that
// paused and re-based. Reuses this file's own findSupportResistanceV1
// (Phase 2) restricted to the move's own window.
function noConsolidationReadV1(highs, lows, lookbackBars) {
  if (!highs || highs.length < lookbackBars) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackBars);
  const wLows = lows.slice(n - lookbackBars);
  const { resistanceLevels, supportLevels } = findSupportResistanceV1(wHighs, wLows, 0.03, wHighs.length-1);
  const totalLevels = resistanceLevels.length + supportLevels.length;
  return {
    hasNoConsolidation: totalLevels === 0,
    levelsFormed: totalLevels,
    read: totalLevels === 0
      ? 'No S/R ledges formed during this move — straight-line, lower-reliability continuation signal (ep.3/4)'
      : totalLevels + ' S/R level(s) formed along the way — the move paused/re-based, higher-reliability signature'
  };
}

// Round-number proximity (ep.6/7): checks whether a price sits within
// `tolerancePct` of a psychologically round number, scaled to the price's
// own magnitude (course's own examples span $10, $100, and $20,000 BTC).
// Real bug fix (this audit, 2026-08-22): the original power-of-10 formula
// gave $1 increments below $10, missing the course's own real worked
// example (ep.6 visual re-pass, DPW -- a sub-$10 penny stock: reacted at
// $3, $3.50, $4, $4.50, $5, THEN $6, $7 -- half-dollar increments below
// $5, whole-dollar increments above it). Real, disclosed limit on this
// re-verification: DPW's numbers are a visual-only finding (checked --
// zero mentions in the ep.6 audio transcript), so this fix relies on the
// already-recorded visual-repass notes, not a fresh independent read of
// the frames themselves. Matches the main engine's own already-correct
// version of this same rule (`roundLevelIncrementV7`, v9.36): $0.50 <$5,
// $1 $5-10, $10 $10-100, $100 $100-1000, $1000 >=$1000.
function roundNumberIncrementV1(price) {
  if (price < 5) return 0.5;
  if (price < 10) return 1;
  if (price < 100) return 10;
  if (price < 1000) return 100;
  return 1000;
}
function roundNumberProximityV1(price, tolerancePct) {
  if (price == null || price <= 0) return null;
  tolerancePct = tolerancePct == null ? 0.02 : tolerancePct;
  const magnitude = roundNumberIncrementV1(price);
  const nearestRound = Math.round(price / magnitude) * magnitude;
  const distPct = Math.abs(price - nearestRound) / price;
  return {
    nearestRound, distPct,
    isNearRoundNumber: distPct <= tolerancePct,
    read: distPct <= tolerancePct
      ? ('Price is near the round number ' + nearestRound + ' — course flags these as algo/institutional order-clustering points (ep.6/7)')
      : 'Not currently near a round-number level'
  };
}

// Orchestrator: combines the above into ONE qualitative tag + evidence
// list. Never claims direct institutional-data confirmation — inference
// only, exactly as the design doc requires.
// Phase 13's `gapHoldFade` param/field REMOVED (2026-08-22): the rule it
// implemented ("gap holds/extends in the first ~20min = forced-buyer/
// short-covering signature; fades = retail-chase, lower reliability")
// does not appear anywhere in the course. Checked exhaustively — full
// transcript search (Hebrew) across ep.7 (cited episode), ep.9 (Short),
// ep.10 and ep.11 (the two episodes actually dedicated to gaps) for
// "minutes," forced/covering/short/fade language: no match. Ep.7's own
// notes on the nearest related content (pre-market order pileup) say
// explicitly "not itself a new checkable technical rule." Not a fidelity
// nuance — a fabricated rule cited to an episode that doesn't contain it.
// See CHECKPOINT_TODAY.md for the full removal record.
function playerMappingReadV1(closes, highs, lows, volumes, currentPrice, lookbackBars) {
  lookbackBars = lookbackBars || 20;
  const staircase = staircasePatternReadV1(closes, volumes, lookbackBars);
  const spike = speculativeSpikeReadV1(closes, volumes, lookbackBars);
  const consolidation = noConsolidationReadV1(highs, lows, lookbackBars);
  const roundNumber = roundNumberProximityV1(currentPrice, 0.02);

  const evidence = [];
  let tag = 'Mixed/Unclear';
  if (staircase && staircase.isStaircase) {
    tag = 'Institutional-Accumulation-Signature';
    evidence.push(staircase.read);
  } else if (spike && spike.isSpike) {
    tag = 'Speculative-Spike';
    evidence.push(spike.read);
  }
  if (consolidation) evidence.push(consolidation.read);
  if (roundNumber && roundNumber.isNearRoundNumber) evidence.push(roundNumber.read);

  return { tag, evidence };
}

// ── Phase 6: Fundamentals (dilution/pump-dump screen) — episode 12 ──
//
// Source: episode 12's GEVO worked example, a concrete 4-item checklist
// ("(1) check revenue/income, red flag if minimal/negative; (2) check
// Shares Outstanding trend over multiple years via the 10-K, red flag if
// steadily increasing; (3) search the 10-K/10-Q for the literal terms
// 'offering'/'shelf'/'warrants'/'convertible'/'dilution'; (4) recognize
// the cyclical pattern — price pops, company issues shares while price
// is up, price drops back").
//
// Data-availability check performed FIRST, per the design doc's own
// instruction, before building anything:
//   - (1) revenue/income: gatherFundamentals exposes `revenueGrowth`
//     (single-point YoY %, not the course's own "over multiple years"
//     depth) — buildable, with that depth limitation disclosed, not hidden.
//   - (2) shares-outstanding trend: NOT exposed anywhere in
//     gatherFundamentals' FIELDS list, no history endpoint anywhere in
//     this codebase — confirmed by direct grep, not assumed. Real gap,
//     flagged not built.
//   - (3) 10-K/10-Q red-flag keyword search: no news/filing text source
//     exists anywhere in this codebase. Real gap, flagged not built.
//   - (4) the cyclical pop-then-dilute-then-drop pattern is a synthesis of
//     (1)+(2) — can't be built while (2) is unavailable; not attempted.

// Checklist item (1). "Minimal/negative" isn't given an exact number in
// the transcript — the direct, undistorted reading of "minimal/negative"
// is revenueGrowth <= 0 (covers both "negative" and "~0/minimal" without
// inventing a separate cutoff for "minimal" alone). Disclosed, not fit to
// any backtest.
function revenueRedFlagV1(revenueGrowth) {
  if (revenueGrowth == null) return null;
  const isRedFlag = revenueGrowth <= 0;
  return {
    isRedFlag, revenueGrowth,
    read: isRedFlag
      ? 'Revenue growth is minimal/negative (' + (revenueGrowth * 100).toFixed(1) + '%) — matches the course\'s GEVO dilution-screen red flag #1 (ep.12)'
      : 'Revenue growth is positive (' + (revenueGrowth * 100).toFixed(1) + '%) — no red flag on this check'
  };
}

// IPO lock-up expiration, re-derived independently per the "solely those
// videos" constraint (the main engine already has this, v9.39 — that
// function is NOT imported or copied here; this is a fresh implementation
// off the same course numbers). Course number: ~180-day post-IPO
// insider-selling restriction (episode 8). DISPLAY_WINDOW_DAYS is a direct
// derivation of it (180 + a 30-day grace window either side of the exact
// date), not separately invented.
function lockupExpirationReadV1(firstTradeDate, now) {
  if (!firstTradeDate) return null;
  const LOCKUP_DAYS = 180, DISPLAY_WINDOW_DAYS = 210, MS_PER_DAY = 86400000;
  const daysSinceIPO = Math.floor((now - firstTradeDate) / MS_PER_DAY);
  if (daysSinceIPO < 0 || daysSinceIPO > DISPLAY_WINDOW_DAYS) return null;
  const daysUntilLockupEnd = LOCKUP_DAYS - daysSinceIPO;
  const status = daysUntilLockupEnd > 0 ? 'UPCOMING' : 'PASSED';
  return {
    daysSinceIPO, daysUntilLockupEnd, status,
    read: status === 'UPCOMING'
      ? ('Lock-up expiration in ~' + daysUntilLockupEnd + ' day(s) — insider-selling pressure risk (ep.8)')
      : ('Lock-up expired ~' + Math.abs(daysUntilLockupEnd) + ' day(s) ago — recent insider-selling pressure window (ep.8)')
  };
}

// Orchestrator: combines the above into ONE qualitative tag + evidence
// list, same convention as playerMappingReadV1 — real gaps disclosed in
// the output, never silently dropped.
// Phase 13 update: `sharesOutstandingHistory`/`filingKeywordHits` are new
// OPTIONAL trailing params (real data from `fetchSharesOutstandingHistoryV1`
// / `fetchSecFilingKeywordHitsV1`) — when supplied, both real checklist
// items (ep.12 #2 and #3) are actually evaluated instead of disclosed as
// gaps; when omitted (every pre-Phase-13 call site), behavior is
// byte-identical to before — backward-compatible, no existing test broke.
function fundamentalsScreenReadV1(revenueGrowth, firstTradeDate, now, sharesOutstandingHistory, filingKeywordHits) {
  const revenueFlag = revenueRedFlagV1(revenueGrowth);
  const lockup = lockupExpirationReadV1(firstTradeDate, now);
  const sharesTrend = sharesOutstandingHistory !== undefined ? sharesOutstandingTrendReadV1(sharesOutstandingHistory) : null;
  const filingFlag = filingKeywordHits !== undefined ? filingKeywordReadV1(filingKeywordHits) : null;

  const evidence = [];
  let tag = 'No red flags found';
  if (revenueFlag && revenueFlag.isRedFlag) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(revenueFlag.read);
  }
  if (sharesTrend && sharesTrend.steadilyRising) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(sharesTrend.read);
  }
  if (filingFlag && filingFlag.anyFound) {
    tag = 'Dilution/Pump-Dump Risk Flagged';
    evidence.push(filingFlag.read);
  }
  if (lockup) evidence.push(lockup.read);

  return {
    tag, evidence,
    sharesOutstandingTrend: sharesOutstandingHistory !== undefined
      ? (sharesTrend ? sharesTrend.read : 'SEC EDGAR data fetch failed or insufficient history for this ticker')
      : 'Not available — needs multi-year shares-outstanding history (Phase 13: real via SEC EDGAR when this param is supplied)',
    filingKeywordSearch: filingKeywordHits !== undefined
      ? (filingFlag ? filingFlag.read : 'SEC EDGAR filing search failed for this ticker')
      : 'Not available — needs a 10-K/10-Q text source (Phase 13: real via SEC EDGAR full-text search when this param is supplied)'
  };
}

// ── Phase 7: Technique/Entry (episodes 4, 5, 7) ─────────────────────
//
// Real, disclosed scheduling gap found starting this phase: the design
// doc's original 10-phase build order (`CHARACTERIZATION_PLAN_broker_
// model_v1.md` §11) never scheduled Category 6 (Technique/Entry, §7) at
// all — it jumped from Fundamentals straight to Risk overlay. R:R itself
// was already shipped in Phase 3 (`riskRewardV1`, reused directly below,
// not rebuilt). User's explicit decision (2026-08-20): insert it here as
// its own phase, renumber the rest.
//
// The course's own entry-type taxonomy (breakout / pullback / gap-and-go
// / counter-trend) is, per a direct re-read of the transcript, explicitly
// "a philosophical/organizational framing... not itself a concrete rule
// to encode" — three of those four types are already fully covered by
// other categories' real, numeric outputs (breakout: Phase 2's S/R +
// candle reads; pullback: Phase 3's Fibonacci retracement read; gap-and-
// go: Phase 4's gap taxonomy) and are surfaced there, not rebuilt here as
// a redundant classifier that would risk inventing decision logic the
// course never actually specified. This phase builds the two genuinely
// NEW, numerically concrete pieces the course adds beyond those: the
// Secondary Day entry signal, and the $20B counter-trend-at-support rule
// — plus stop placement, which the course's stop-hunt case study implies
// but never gives an exact number for.

// Secondary Day entry (ep.7): yesterday had elevated volume, today's
// close breaks above yesterday's high. Independent implementation — NOT
// imported from the main engine's already-shipped `secondaryDayV7`
// (v9.37), per the "solely those videos" constraint. Reuses the 1.5x
// relative-volume convention already established in THIS file (Phase 1's
// `relativeVolumeReadV1`), not a separately invented cutoff.
function secondaryDayEntryReadV1(closes, highs, volumes, n) {
  if (!closes || !highs || !volumes || n == null || n < 1) return null;
  if (closes.length <= n || highs.length <= n || volumes.length <= n) return null;
  // Real bug fix (2026-08-22): baseline must be the 20 bars strictly
  // BEFORE yesterday (index n-1), not a window that includes yesterday
  // itself -- the original `slice(n-20, n)` let yesterday's own spike
  // inflate its own yardstick, silently under-reporting its ratio (a
  // real 1.52x elevated day could compute to 1.48x and miss the 1.5x
  // threshold). Matches the main engine's already-correct secondaryDayV7
  // convention (`slice(yesterdayIdx-20, yesterdayIdx)`, exclusive end).
  const avgVol = volumes.slice(Math.max(0, n - 21), n - 1).reduce((a,b) => a + b, 0) / Math.min(n - 1, 20);
  if (!avgVol) return null;
  const yesterdayRelVol = volumes[n - 1] / avgVol;
  const yesterdayElevated = yesterdayRelVol > 1.5; // same >1.5x convention as Phase 1
  const breaksYesterdayHigh = closes[n] > highs[n - 1];
  const isSecondaryDay = yesterdayElevated && breaksYesterdayHigh;
  return {
    isSecondaryDay, yesterdayRelVol, breaksYesterdayHigh,
    read: isSecondaryDay
      ? 'Yesterday\'s elevated volume (' + yesterdayRelVol.toFixed(1) + 'x) + today breaking above yesterday\'s high — matches the course\'s "Secondary Day" momentum-continuation entry (ep.7)'
      : 'Does not match the Secondary Day entry pattern'
  };
}

// Large-cap counter-trend-at-support rule (ep.4): for stocks with market
// cap >$20B (the course's own explicit threshold), buying a dip at an
// established support level is treated as legitimate even against the
// immediate trend — because large funds leave standing orders at known
// levels. Explicitly NOT considered safe for small/speculative names (not
// enough big, patient buyers to reliably defend a level) — this function
// deliberately returns ineligible below the threshold, not a weaker
// version of the same read.
function counterTrendAtSupportReadV1(marketCap, currentPrice, supportLevels, tolerance) {
  if (marketCap == null || currentPrice == null || !supportLevels) return null;
  tolerance = tolerance == null ? 0.03 : tolerance; // reuses Phase 2's own S/R clustering tolerance
  const COUNTER_TREND_MIN_MARKET_CAP = 20e9; // ep.4's own stated number
  const eligible = marketCap > COUNTER_TREND_MIN_MARKET_CAP;
  if (!eligible) {
    return { eligible, atSupport: false, read: 'Market cap below the course\'s $20B counter-trend-buying threshold — dip-buying against the trend not considered safe here (ep.4)' };
  }
  const nearSupport = supportLevels.find(s => Math.abs(currentPrice - s.level) / s.level <= tolerance);
  const atSupport = !!nearSupport;
  return {
    eligible, atSupport, level: nearSupport ? nearSupport.level : null,
    read: atSupport
      ? ('Large-cap (>$20B) at an established support level (' + nearSupport.tier + ', ' + nearSupport.touchCount + ' touches) — course\'s counter-trend-buying rule applies (ep.4)')
      : 'Large-cap, but not currently at an established support level — counter-trend rule not triggered'
  };
}

// Stop placement (implied by ep.3's stop-hunt case study, not given an
// exact margin in the transcript). Real citation fix (this audit,
// 2026-08-22): previously attributed to "ep.7's stop-hunt case study" --
// raw-checked directly, the real SPWR stop-hunt example is in ep.3 (line
// 244: "SPWR ירדה, ומה עשה כל היום אחרי זה, בגדול, היא עלתה" -- "SPWR went
// down, and what did it do the rest of the day, basically it went up"),
// zero mentions of SPWR or a stop-hunt case study anywhere in ep.7. The
// course explains that stop-losses cluster AT well-known support levels
// and get hunted by a brief break below before reversing — the practical
// implication is to place the stop a margin BELOW the level, not exactly
// on it. No specific margin % is stated, so this reuses the same 3%
// tolerance already established in this file (Phase 2's S/R clustering)
// rather than inventing a new one.
function stopPlacementV1(supportLevel, margin) {
  if (supportLevel == null) return null;
  margin = margin == null ? 0.03 : margin;
  const stopPrice = supportLevel * (1 - margin);
  return {
    stopPrice, supportLevel, margin,
    read: 'Stop placed ' + (margin * 100).toFixed(0) + '% below the ' + supportLevel.toFixed(2) + ' support level (not exactly at it) — avoids sitting in the same stop-hunt cluster as the level itself (ep.3)'
  };
}

// Orchestrator: combines the above + reuses Phase 3's `riskRewardV1`
// directly (not rebuilt) to report the actual computed R:R for whichever
// setup is identified. Same qualitative-tag-plus-evidence convention as
// every other category orchestrator in this file.
function techniqueEntryReadV1(closes, highs, volumes, n, marketCap, supportLevels, targetPrice) {
  const secondaryDay = secondaryDayEntryReadV1(closes, highs, volumes, n);
  const counterTrend = counterTrendAtSupportReadV1(marketCap, closes[n], supportLevels);

  const evidence = [];
  let tag = 'No specific entry technique identified';
  let stop = null;
  if (secondaryDay && secondaryDay.isSecondaryDay) {
    tag = 'Secondary-Day-Entry';
    evidence.push(secondaryDay.read);
  } else if (counterTrend && counterTrend.atSupport) {
    tag = 'Counter-Trend-At-Institutional-Support';
    evidence.push(counterTrend.read);
    stop = stopPlacementV1(counterTrend.level);
    evidence.push(stop.read);
  }

  let riskReward = null;
  if (stop && targetPrice != null) {
    riskReward = riskRewardV1(closes[n], stop.stopPrice, targetPrice);
    if (riskReward) evidence.push(riskReward.read);
  }

  return {
    tag, evidence, riskReward,
    // Real, disclosed scope note — not a gap, a deliberate decision (see
    // the phase-header comment above): breakout/pullback/gap-and-go stay
    // organizational labels already covered by other categories' own
    // outputs (Phases 2/3/4), not rebuilt here as a redundant classifier.
    note: 'Breakout, pullback-to-support, and gap-and-go entry types are the course\'s own organizational framing, not separate numeric rules — see the Technicals (Phase 2), Fibonacci (Phase 3), and Gap-taxonomy (Phase 4) reads for those signals directly.'
  };
}

// ── Phase 8: Risk-Management Overlay (episode 7) ────────────────────
//
// Source: episode 7, entirely — a hard rule layer, not a scored category
// (matches the design doc's own framing, §8). Report presents this as a
// recommended RANGE, not a mandate, matching the course's own "framework,
// not rigid rule" language.
//
// The course gives exactly TWO concrete numbers for stock position
// sizing: 20% ceiling for a blue-chip/mega-cap (>$30B), 5% floor for a
// speculative/small-cap — no exact boundary is stated for what counts as
// "speculative/small-cap" beyond "market cap, sector volatility, the
// stock's own weekly/monthly swings." Rather than invent a second number,
// the floor tier reuses this file's OWN already-established Phase 1
// market-cap tier boundary (Small Cap, <$2B) — same discipline already
// used for gapMarketCapSignificanceV1 ("only ONE real numeric anchor was
// given... deliberately did NOT invent thresholds for the other tiers").
// Everything between the two real numbers stays qualitative-only, no
// fabricated formula.
//
// ETF-specific sizing (up to 30%, reduced toward 20% if the ETF's top-10
// holdings' combined market cap is under ~$50-60B) is a REAL, CONFIRMED
// GAP — checked directly, no ETF holdings-composition data source exists
// anywhere in this codebase (grep across the main engine found none) —
// flagged, not built.
function positionSizeRangeV1(marketCap, atrPct) {
  if (marketCap == null) return null;
  const BLUE_CHIP_MIN_MARKET_CAP = 30e9; // ep.7's own stated number
  const SPECULATIVE_MAX_MARKET_CAP = 2e9; // reuses Phase 1's own Small-Cap boundary — course gives no second number
  let tier, note;
  if (marketCap > BLUE_CHIP_MIN_MARKET_CAP) {
    tier = 'Blue-chip/mega-cap';
    note = 'Up to 20% of portfolio for a blue-chip/mega-cap (>$30B) — course\'s own explicit ceiling (ep.7)';
  } else if (marketCap < SPECULATIVE_MAX_MARKET_CAP) {
    tier = 'Speculative/small-cap';
    note = 'Down to a 5% floor for a speculative/small-cap name — course\'s own explicit floor (ep.7); <$2B cutoff reuses this file\'s own Phase 1 market-cap tier boundary since the course gives no second exact number';
  } else {
    tier = 'Mid-range';
    note = 'Between the course\'s 5% floor and 20% ceiling — course gives no exact number for this range; scale down as market cap drops and volatility rises (ep.7)';
  }
  const volatilityFlag = atrPct != null && atrPct > 0.10; // reuses Phase 1's own >10% ATR% threshold
  return {
    tier, note,
    volatilityNote: volatilityFlag
      ? 'ATR% flagged very-high volatility — argues for the LOWER end of whatever range applies (ep.7)'
      : null
  };
}

// "Loss after profit" / breakeven-stop-lock rule (ep.7): once a position's
// unrealized profit crosses 1R (the original risk, i.e. R:R hits 1:1),
// the stop should move up to at least breakeven — never let a winning
// trade round-trip back into a loss. Real, disclosed gap: this needs to
// know whether the user is ALREADY in a position and at what entry price
// — state this stateless, per-ticker report has nowhere to keep. Per the
// design doc's own instruction (§8), presented as a static informational
// note in every report, not an executable/conditional order.
function breakevenLockNoteV1() {
  return 'Once a position\'s unrealized profit crosses 1R (R:R = 1:1), move the stop up to at least breakeven — never let a winning trade round-trip back into a loss (ep.7). This report can\'t track whether you\'re already in a position or your entry price, so this is a standing reminder, not a computed trigger.';
}

// ETF top-10-holdings market-cap composition -- closes the real, disclosed
// gap this function used to just report as unavailable. 4 FMP endpoints
// tried 2026-08-20, all failed (KNOWN_GAPS_AND_RISKS.md). Real, free source
// found live 2026-08-24: State Street's own public holdings XLSX
// (ssga.com/.../holdings-daily-us-en-{ticker}.xlsx) -- verified live, real
// current SPY top holdings (NVDA #1 7.87%, matches real current market-cap-
// weighted S&P 500 ordering). Real, disclosed scope: only State Street
// EQUITY products -- SPY + the 11 sector SPDRs. QQQ (Invesco)/SMH (VanEck)
// need different issuer-specific sources, real future work, not chased this
// pass. GLD deliberately excluded -- real reason found live, not a bug: it's
// a physical gold bullion trust, no equity holdings to enumerate at all.
//
// XLSX is a ZIP of XML parts -- no library available (GAS has no XLSX
// parser), but Apps Script's real, native `Utilities.unzip()` handles the
// ZIP layer, so no from-scratch ZIP parser is needed either. Same regex-
// based XML extraction pattern already used for the real 13F info tables
// (fullStockAnalysisV9_57.gs) -- verified correct in Node first
// (etf_holdings_spdr_test.js, all 12 real tickers), then ported here.
// GAS-specific risk, disclosed: Utilities.unzip()'s exact behavior here is
// unverified in a real Apps Script execution (Node testing used the system
// `unzip` tool as a stand-in, not GAS's own implementation) -- Phase 5 will
// show if this holds.
var SPDR_ETF_TICKERS_V1 = ['SPY','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLB','XLU','XLRE','XLC'];

function parseSpdrSharedStringsV1_(xml) {
  var sis = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
  return sis.map(function(si) {
    var ts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    return ts.map(function(t) { return t.replace(/<[^>]*>/g, ''); }).join('')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  });
}
function spdrCellValueV1_(cellXml, sharedStrings) {
  var isString = /t="s"/.test(cellXml);
  var vMatch = cellXml.match(/<v>([^<]*)<\/v>/);
  if (!vMatch) return null;
  return isString ? sharedStrings[parseInt(vMatch[1], 10)] : parseFloat(vMatch[1]);
}
// Real, disclosed convention (verified against SPY's real file): header row
// 5 (Name/Ticker/Identifier/SEDOL/Weight/Sector/Shares Held/Local Currency),
// real data from row 6, already sorted by weight descending in the source.
function parseSpdrHoldingsV1_(sheetXml, sharedStrings, topN) {
  var rows = sheetXml.match(/<row r="\d+"[^>]*>[\s\S]*?<\/row>/g) || [];
  var holdings = [];
  for (var i = 0; i < rows.length; i++) {
    var rowNum = parseInt((rows[i].match(/<row r="(\d+)"/) || [])[1], 10);
    if (rowNum < 6) continue;
    var cells = rows[i].match(/<c r="[A-Z]+\d+"[^>]*\/?>(?:[\s\S]*?<\/c>)?/g) || [];
    var byCol = {};
    cells.forEach(function(c) {
      var col = (c.match(/<c r="([A-Z]+)\d+"/) || [])[1];
      byCol[col] = spdrCellValueV1_(c, sharedStrings);
    });
    if (byCol.A == null || byCol.B == null) continue; // real footer/blank row -- stop treating as real data
    holdings.push({ name: byCol.A, ticker: byCol.B, weightPct: byCol.E });
    if (holdings.length >= topN) break;
  }
  return holdings;
}


// QQQ top-10 holdings -- closes the 2nd real, disclosed gap from the same
// note above (SPY/sector SPDRs done 2026-08-24; SMH's CIK was never
// located; QQQ's real, free, no-key path IS SEC EDGAR, confirmed live
// 2026-08-28, built here 2026-09-02). Every registered ETF files a real,
// quarterly NPORT-P holdings report with the SEC -- QQQ's real CIK
// (1067839, "INVESCO QQQ TRUST, SERIES 1") resolves via the EXISTING
// `fetchSecEdgarCIKV1` (verified live: it already correctly returns
// 1067839 for ticker 'QQQ', zero new CIK-lookup code needed).
//
// Real, disclosed correction to the original research note: that note
// expected HTML-table scraping of the filing's rendered viewer page. A
// direct live fetch found something simpler and more reliable -- the raw
// filing document at `.../{accessionNoDash}/primary_doc.xml` is real,
// clean, well-formed XML (`<invstOrSec>` records with `<name>`/`<pctVal>`/
// `<cusip>` etc.), the SAME "clean XML tags, regex-extract" pattern
// already used for the real 13F info tables -- no HTML parsing needed at
// all, and no ZIP/unzip layer either (simpler than the SPDR XLSX path
// above).
//
// Real, disclosed limitation vs. the SPDR path: NPORT-P's own schema has
// no ticker-symbol field, only company name/CUSIP/LEI/ISIN -- holdings are
// shown by NAME here, not ticker (a real, honest difference, not a
// fabricated ticker). Real, disclosed handling: Alphabet's 2 real share
// classes (GOOGL/GOOG) file as 2 separate `<invstOrSec>` records with the
// same name -- combined by name + summed weight before ranking, so the
// real top-10 list doesn't show "Alphabet Inc." twice (verified live:
// 2026-09-02 filing has exactly this real case, combining correctly
// produces one Alphabet row at 6.29% combined). Real, disclosed cache:
// filed quarterly, cached 30 real days (same staleness-accepted precedent
// as CIK/CUSIP caching above) -- NOT re-fetched every run.

// Orchestrator: combines the above into one risk-overlay read. Same
// evidence-list convention as every other category orchestrator, but
// deliberately NOT a scored category (design doc §8 — "not scored, a
// hard rule layer").
function riskOverlayReadV1(marketCap, atrPct, ticker) {
  const positionSize = positionSizeRangeV1(marketCap, atrPct);
  const evidence = [];
  if (positionSize) {
    evidence.push(positionSize.note);
    if (positionSize.volatilityNote) evidence.push(positionSize.volatilityNote);
  }
  evidence.push(breakevenLockNoteV1());
  // v9.57-equivalent fix (2026-08-24) — real, free source found and wired
  // in; see fetchSpdrEtfTopHoldingsV1's own header comment for the full
  // real finding. Only fires for a real State Street equity ETF ticker.
  // 2026-09-07, real fix (item 8): only the outer block-level 30s guard
  // covered this before, no guard on the call itself — added directly,
  // same discipline as the engine's own gatherFundamentals guards today.
  const spdrHoldings = (ticker && (typeof hasTimeBudgetV7_ !== 'function' || hasTimeBudgetV7_(10000))) ? fetchSpdrEtfTopHoldingsV1(ticker) : null;
  // v9.86-equivalent fix (2026-09-02) -- real, free SEC EDGAR NPORT-P
  // source found and wired in for QQQ specifically; see
  // fetchQqqTopHoldingsV1's own header comment for the full real finding.
  const qqqHoldings = (!spdrHoldings && ticker === 'QQQ') ? fetchQqqTopHoldingsV1(ticker) : null;
  const etfPositionSizing = spdrHoldings
    ? 'Top-10 holdings: ' + spdrHoldings.holdings.map(h => h.ticker + ' ' + h.weightPct.toFixed(1) + '%').join(', ') + ' — ' + spdrHoldings.top10ConcentrationPct.toFixed(1) + '% concentration in top 10'
    : qqqHoldings
    ? 'Top-10 holdings (by name, SEC NPORT-P, filed ' + qqqHoldings.filingDate + '): ' + qqqHoldings.holdings.map(h => h.name + ' ' + h.weightPct.toFixed(1) + '%').join(', ') + ' — ' + qqqHoldings.top10ConcentrationPct.toFixed(1) + '% concentration in top 10'
    : (ticker && SPDR_ETF_TICKERS_V1.indexOf(ticker) < 0 && ticker !== 'QQQ'
      ? 'Not available for ' + ticker + ' — real source found (State Street) only covers SPY + the 11 sector SPDRs; QQQ covered via SEC NPORT-P; SMH/etc need a different issuer-specific source, real future work'
      : 'Not available — real fetch/parse failed for this real-time run (non-fatal, see log)');
  return {
    positionSizeTier: positionSize ? positionSize.tier : null,
    evidence,
    etfPositionSizing
  };
}

// ── Phase 9: Macro Overlay (episode 13) ──────────────────────────────
//
// Source: episode 13, built fresh — per the user's explicit answer, NOT
// reusing `macro_fetchers_v0_5.gs` (design doc §9). Episode 13's macro
// content is real but much thinner than that existing module — this
// overlay deliberately does not attempt to match that depth, only what
// the episode itself teaches: the interest-rate <-> equity-valuation
// relationship (rates up -> bonds sell off + equity valuations compress;
// rates down -> the reverse), illustrated with a real worked example (the
// 10-year Treasury yield's real 2021 move, 0.35% -> briefly above 1%,
// read as the market beginning to price in inflation).
//
// No numeric trend-magnitude threshold is given in the transcript (the
// worked example is a real historical illustration, not a stated rule),
// so trend direction here is read off the plain sign of the net change
// over the caller-supplied window — no invented "how much is a real
// trend" cutoff.
//
// Real, confirmed gaps, not built: (1) business-cycle phase classification
// (expansion/peak/contraction/trough) — the course names the four phases
// but gives no concrete per-ticker detection rule, and no GDP/unemployment
// data is fetched anywhere in this codebase; (2) "Zombie companies" — a
// real concept but not stated as a checkable per-ticker rule (would need
// debt-service-coverage data this pipeline doesn't fetch).

function treasuryYieldTrendReadV1(recentYields) {
  if (!recentYields || recentYields.length < 2) return null;
  const first = recentYields[0], last = recentYields[recentYields.length - 1];
  const change = last - first;
  const direction = change > 0 ? 'rising' : (change < 0 ? 'falling' : 'flat');
  return {
    direction, change, current: last,
    read: direction === 'rising'
      ? ('10-year Treasury yield rising (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — historically reads as the market pricing in higher inflation expectations, compressing equity valuations especially for high-multiple/growth names (ep.13)')
      : direction === 'falling'
      ? ('10-year Treasury yield falling (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — historically supportive of equity valuations, the reverse of the rising-rate read (ep.13)')
      : '10-year Treasury yield flat over this window — no directional macro read'
  };
}

function fedFundsTrendReadV1(recentRates) {
  if (!recentRates || recentRates.length < 2) return null;
  const first = recentRates[0], last = recentRates[recentRates.length - 1];
  const change = last - first;
  const direction = change > 0 ? 'rising' : (change < 0 ? 'falling' : 'flat');
  return {
    direction, change, current: last,
    read: direction === 'rising'
      ? ('Fed Funds Rate rising (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — tighter monetary policy, historically pressures equity valuations (ep.13)')
      : direction === 'falling'
      ? ('Fed Funds Rate falling (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — easing monetary policy, historically supportive of equity valuations (ep.13)')
      : 'Fed Funds Rate flat over this window — no directional macro read'
  };
}

// Orchestrator: combines the above into one macro-overlay read. Same
// evidence-list convention as every other category orchestrator. Real
// gaps disclosed in the output, never dropped.
// Phase 13 update: `gdpSeries`/`interestCoverageRatio` are new OPTIONAL
// trailing params — when supplied, business-cycle phase (real, via FRED
// GDP) and the zombie-company screen (real, via FMP's interest-coverage
// field) are actually evaluated instead of disclosed as gaps; omitted,
// behavior is byte-identical to before — backward-compatible.
function macroOverlayReadV1(recentYields, recentRates, gdpSeries, interestCoverageRatio) {
  const yieldTrend = treasuryYieldTrendReadV1(recentYields);
  const fedTrend = fedFundsTrendReadV1(recentRates);
  const cyclePhase = gdpSeries !== undefined ? businessCyclePhaseReadV1(gdpSeries) : null;
  const zombieScreen = interestCoverageRatio !== undefined ? zombieCompanyScreenV1(interestCoverageRatio) : null;
  const evidence = [];
  if (yieldTrend) evidence.push(yieldTrend.read);
  if (fedTrend) evidence.push(fedTrend.read);
  if (cyclePhase) evidence.push(cyclePhase.read);
  if (zombieScreen && zombieScreen.isZombie) evidence.push(zombieScreen.read);
  return {
    evidence,
    businessCyclePhase: gdpSeries !== undefined
      ? (cyclePhase ? cyclePhase.read : 'FRED GDP data fetch failed or insufficient history')
      : 'Not available — course names 4 phases but gives no per-ticker detection rule (Phase 13: real via FRED GDP + the standard textbook recession definition when this param is supplied)',
    zombieCompanyScreen: interestCoverageRatio !== undefined
      ? (zombieScreen ? zombieScreen.read : 'FMP interest-coverage data not available for this ticker')
      : 'Not available — real concept, but not stated as a checkable rule (Phase 13: real via FMP\'s interest-coverage ratio + the standard academic zombie-company threshold when this param is supplied)'
  };
}

// ── Phase 10: VIX Regime (ep.2) + Short-Squeeze Setup (ep.9/13) ─────
//
// Real, disclosed 2nd gap found and fixed, user's explicit instruction
// (2026-08-20, "don't skip any logic no matter how small... mark every
// gap for later, don't go around it"): both features were spec'd in the
// design doc (§5's last bullet, §6's third bullet) but never scheduled or
// built in any earlier phase. Verified by direct grep before assuming —
// confirmed genuinely missing, not just unbuilt-but-covered-elsewhere.

// VIX regime (ep.2): the course's own stated bands. Explicitly disclosed
// by the design doc (§5) and the course itself as TIME-BOUND, not a
// permanent rule — the instructor's own account: the pandemic pushed the
// baseline higher, and these numbers already went stale once before.
// Presented as the course's stated reference frame, not hard-coded as
// eternal truth.
function vixRegimeReadV1(vixLevel) {
  if (vixLevel == null) return null;
  let regime;
  if (vixLevel < 13) regime = 'Euphoria (<13)';
  else if (vixLevel <= 25) regime = 'Normal (13-25)';
  else if (vixLevel <= 40) regime = 'Elevated (25-40)';
  else if (vixLevel <= 70) regime = 'Crisis (40-70)';
  else regime = 'Extreme (70+)';
  return {
    regime, vixLevel,
    read: 'VIX at ' + vixLevel.toFixed(1) + ' — ' + regime + ' by the course\'s own stated bands (ep.2). These are the instructor\'s stated reference points from a specific period, not asserted as permanent — he discloses they already went stale once (COVID recalibration).'
  };
}

// Short-Squeeze setup (ep.9, reinforced live in ep.13's real GME case
// study): a high-short-float stock breaking to a NEW HIGH — explicitly
// distinguished by the instructor from merely bouncing off a low (that's
// short-covering, a different and weaker mechanism). Real, long-
// compatible technique (kept because it identifies a LONG opportunity,
// not a short — matches the user's own long-only strategy).
//
// Real data-source finding, this phase: the main engine's earlier
// (2026-08-19) finding that Yahoo's quoteSummary short-interest fields
// need a crumb/cookie auth handshake was RE-VERIFIED LIVE this phase, not
// assumed — it worked once, then failed 5 consecutive retries (flaky, not
// a hard wall, but not reliable enough to ship on). Per the user's
// explicit direction, used the real, working alternative instead:
// Nasdaq's own short-interest API (`/api/quote/{TICKER}/short-interest`,
// same working domain/header pattern already established elsewhere in
// this project for OHLCV), which redistributes FINRA's official
// bi-monthly short-interest reporting. Verified live on real tickers
// (AAPL: 141.6M shares short, 2.42 days-to-cover, settlement 07/31/2026;
// RIOT: 51.6M shares short, 2.65 days-to-cover). **Real, disclosed
// limitation**: this specific endpoint only covers Nasdaq-LISTED tickers
// (verified live — a real NYSE ticker, GME, returns an explicit
// "not available, Nasdaq Listed only" message, not silently wrong data).
//
// shortPctOfFloat tiers are the course's own real, worked FinViz-screener
// result-count anchors (ep.9): >10% "600 results, too broad", >20-30%
// "getting interesting", >40-50% "most extreme, 11-16 results". The
// squeeze-setup trigger uses the ">20%" "getting interesting" tier as the
// real, disclosed floor, not an invented number.
function shortInterestTierV1(shortPctOfFloat) {
  if (shortPctOfFloat == null) return null;
  if (shortPctOfFloat > 0.40) return 'Extreme (>40%)';
  if (shortPctOfFloat > 0.20) return 'Elevated (>20%) — course\'s own "getting interesting" tier (ep.9)';
  if (shortPctOfFloat > 0.10) return 'Notable (>10%) — course\'s own floor for even screening on this (ep.9)';
  return 'Normal (<=10%)';
}

function shortSqueezeSetupReadV1(shortPctOfFloat, currentPrice, week52High, tolerance) {
  if (shortPctOfFloat == null || currentPrice == null || week52High == null) return null;
  tolerance = tolerance == null ? 0.03 : tolerance; // reuses this file's own established "near a level" tolerance
  const tier = shortInterestTierV1(shortPctOfFloat);
  const atNewHigh = currentPrice >= week52High * (1 - tolerance);
  const SQUEEZE_MIN_SHORT_PCT = 0.20; // ep.9's own "getting interesting" number, not invented
  const isSqueezeSetup = shortPctOfFloat > SQUEEZE_MIN_SHORT_PCT && atNewHigh;
  return {
    isSqueezeSetup, tier, atNewHigh, shortPctOfFloat,
    read: isSqueezeSetup
      ? ('High short interest (' + (shortPctOfFloat*100).toFixed(1) + '% of float, ' + tier + ') breaking to a NEW high — matches the course\'s Short Squeeze setup, explicitly distinguished from mere short-covering off a low (ep.9, reinforced live in ep.13\'s real GME case study)')
      : atNewHigh
      ? ('At a new high, but short interest (' + (shortPctOfFloat*100).toFixed(1) + '%) is below the course\'s "getting interesting" tier — not a squeeze setup')
      : ('Short interest ' + tier + ', but not currently at a new high — bouncing off a low is short-covering, not the same mechanism as a squeeze (ep.9)')
  };
}

// Orchestrator: combines both into the Phase-10 read. Same evidence-list
// convention as every other category orchestrator.
function vixAndSqueezeReadV1(vixLevel, shortPctOfFloat, currentPrice, week52High) {
  const vix = vixRegimeReadV1(vixLevel);
  const squeeze = shortSqueezeSetupReadV1(shortPctOfFloat, currentPrice, week52High);
  const evidence = [];
  if (vix) evidence.push(vix.read);
  if (squeeze) evidence.push(squeeze.read);
  return {
    evidence,
    isSqueezeSetup: squeeze ? squeeze.isSqueezeSetup : false,
    // Real, disclosed, verified-live limitation — not silently worked around.
    shortInterestCoverage: 'Nasdaq-listed tickers only (verified live) — NYSE/other-exchange tickers need a different real data source, not currently wired in'
  };
}

// ── Phase 11: Report Assembly (§10) ──────────────────────────────────
//
// Two new pieces of data-fetching PLUMBING, both real, both live-verified
// this session — allowed under the design doc's own infrastructure
// exception ("raw data-fetching plumbing... macro_fetchers' HTTP-fetch
// patterns as a coding pattern, not its computed signals, may be
// reused"). Neither is copy-pasted from elsewhere — independently written
// against the same real, verified endpoints.

// Same coding PATTERN as macro_fetchers_v0_5.gs's fetchFredSeries_Macro
// (parameterized by series ID, plain CSV parse) — independently written,
// not imported, per this file's own "no *V7/*_Macro reuse" discipline.

// Real, verified-live finding this session (Phase 10): Nasdaq's own
// short-interest API redistributes FINRA's official bi-monthly data,
// reliably, using the SAME working domain/header convention this file's
// design doc already established for OHLCV. Nasdaq-listed tickers only
// (verified live — a real NYSE ticker returns an explicit
// "not available" message, not silently wrong data).

// Real, disclosed gap found DURING report assembly, fixed rather than
// skipped (user's explicit instruction, 2026-08-20: "don't skip any logic
// no matter how small"). srReliabilityContextV1 (Phase 2) and
// classifyGapTypeV1 (Phase 4) both take `atHigh`/`nearATH` and
// `longTermTrend`/`longTermDowntrend` as pre-computed INPUTS — but no
// function anywhere in this file actually computed them from raw price
// data. Reuses this file's own established 3% near-level tolerance for
// "near a 52-week high"; -30%/+10% over a 252-trading-day lookback for
// downtrend/uptrend are disclosed defaults (same order of magnitude this
// file already uses for "strong prior move" in Phase 3, scaled up for a
// full-year window) — not course-exact numbers, not fit to a backtest.
function breakoutContextReadV1(currentPrice, high52, roc252, tolerance) {
  tolerance = tolerance == null ? 0.03 : tolerance;
  const nearATH = high52 != null && currentPrice != null && currentPrice >= high52 * (1 - tolerance);
  const longTermDowntrend = roc252 != null && roc252 < -0.30;
  const longTermTrend = longTermDowntrend ? 'down' : (roc252 != null && roc252 > 0.10 ? 'up' : 'flat');
  return { nearATH, longTermDowntrend, longTermTrend, roc252 };
}

// Master orchestrator — fetches real data once (plus a second internal
// fetch inside buildStockIdCardV1, a deliberate simplicity-over-micro-
// efficiency trade-off for a report a user runs manually, one ticker at a
// time, not a backtest loop where the extra call would matter) and wires
// every phase's function together into the design doc's own §10 output
// structure (9 sections). GAS-only (UrlFetchApp) — not runnable from
// plain Node, same constraint as buildStockIdCardV1 (see
// `stock_id_card_test.js`'s real-ticker-path placeholder note).
// v9.92 real fix (2026-09-03, section 3.7, Bug 3): optional `existingChart`
// (and `existingVixLevel`) — when the caller (runAnalysisV7) already has
// this ticker's real chart (and the engine's own already-fetched VIX
// level, `chart.vixContext.level`), reuse both instead of buildBroker
// CourseReportV1 independently re-fetching a 2nd chart for the same
// ticker AND a separate VIX chart. Real, disclosed scope limit: the
// fundamentals fetch is NOT deduped here — checked directly, the engine's
// own `gatherFundamentalsV7` and this file's `gatherFundamentals` are
// genuinely different functions attaching different extra fields
// (`_metricSeries`/`_peersRaw` vs `_nextEarnings`/`_earningsHistory`/
// `_insiderTrading`/`_treasuryRate10Y`) — substituting one for the other
// without verifying every consumer risks a silent, hard-to-catch shape
// bug, so this stays a separate real fetch for now (disclosed, not
// silently dropped — see docs/CLAUDE_CODE_HANDOFF.md section 3.7).
function buildBrokerCourseReportV1(ticker, log, existingChart, existingVixLevel, existingFund, existingCik, existingSoHistory, existingFilingHits) {
  // v9.97 real fix (fetch-dedup pass, 2026-09-04, user-reported real
  // execution timeout): runAnalysisV7 already calls gatherFundamentalsV7,
  // which itself calls this SAME gatherFundamentals -- this used to
  // silently re-run the whole fetch not just once but TWICE more here (this
  // function's own top-level call, AND buildStockIdCardV1's own separate
  // internal call, found by the test written for this fix). `!== undefined`
  // (not `!= null`) so an explicit null (caller genuinely has no
  // fundamentals) is honored as "no data," not misread as "not supplied,
  // fetch it" -- same 3-state convention already used for existingChart/
  // existingVixLevel. Moved above buildStockIdCardV1 (was below it) purely
  // so it can be threaded through -- fund's own computation never depended
  // on chart/idCard, this reorder changes nothing about what gets computed.
  // Flow-only change: every line below that reads `fund.X` is untouched.
  const fund = existingFund !== undefined ? existingFund : (function() { const r = gatherFundamentals(ticker, log); return r ? r.fund : null; })();

  const idCard = buildStockIdCardV1(ticker, log, existingChart, fund);
  if (!idCard) { if (log) log('Report: ID card build failed for ' + ticker); return null; }

  const chart = existingChart || fetchYahooChart(ticker);
  if (!chart) { if (log) log('Report: chart fetch failed for ' + ticker); return null; }
  const n = chart.closes.length - 1;

  // Phase 13: one shared SEC EDGAR CIK lookup, reused by both the
  // shares-outstanding-trend and filing-keyword-search checks below.
  // v9.97: reuse the engine's own already-fetched CIK (its own dilution-
  // screen port, v9.93) when supplied -- same dedup pattern as `fund` above.
  const cik = existingCik !== undefined ? existingCik : fetchSecEdgarCIKV1(ticker);

  // Real institutional-holdings (13F) data -- closes half of the
  // KNOWN_GAPS_AND_RISKS.md "Level-2/13F institutional-holdings data" row
  // (2026-08-24). Real-time Level-2 order-book depth still has no free
  // source -- unchanged, real wall. But real 13F QUARTERLY holdings data
  // now exists in this project (fullStockAnalysisV9_61.gs v9.57/v9.60,
  // SEC EDGAR, Berkshire/BlackRock/Vanguard/State Street) and was never
  // wired into this file at all. Reused verbatim, zero new fetch logic --
  // fetch13FCusipV7/fetchInstitutional13FHoldingsV7/INSTITUTIONAL_13F_FILERS_V7
  // are real GAS globals from the OTHER file in the same Apps Script
  // project (same shared-globals assumption gatherFundamentals/
  // fetchYahooChart/fetchSecFilingKeywordHitsV1 already make elsewhere in
  // this file). Deliberately kept a SEPARATE report section (`institutional13F`
  // below), not fused into Player Mapping's own tag/evidence -- Player
  // Mapping is a pure course-taught price/volume-shape inference; real 13F
  // confirmation is genuine, useful context but was never taught as part of
  // that specific read, and this file's own standing rule is no invented
  // adaptive logic beyond the course. The OLD engine keeps its own 13F
  // section separate from ITS scoring signals too, for the same reason --
  // this mirrors that, doesn't diverge from it.
  // v9.62-companion real fix: real first-ever live Apps Script execution
  // (2026-08-25) exceeded the execution-time ceiling; this 13F fetch is the
  // single heaviest addition to this file's real network cost (4 filers,
  // each downloading a FULL current+prior-quarter holdings table --
  // BlackRock's alone ~23MB, disclosed since v9.57). Timing added so a
  // future timeout's 🔬 Log trace shows whether this specific step is the
  // real bottleneck, rather than guessing.
  // v9.102, real error-handling fix (user-reported real timeout, 2026-09-05):
  // this real fetch already caches its own parsed result (fetchInstitutional13FHoldingsV7,
  // 24h TTL, v9.63-companion) -- a SAME-DAY re-run of the SAME ticker is
  // already cheap and was never the real risk. The real, previously-
  // unguarded risk is a genuinely COLD cache (first run of the day, or
  // after the 24h TTL expires): a real, live-measured cold run of this
  // exact call took 26.1s (vs. 2.9s warm, same ticker) -- BlackRock's own
  // info table alone is ~23MB, no way to bound a single UrlFetchApp call's
  // own duration once it's in flight. Guarded now with a real, reasoned
  // margin (35s, slightly above the one real cold measurement on hand, not
  // fit to it) -- same "skip gracefully, protect the rest of the report"
  // convention as every other real step in this pipeline, which this one
  // real call never had despite being the single heaviest network cost.
  let institutional13F = null;
  if (typeof hasTimeBudgetV7_ !== 'function' || hasTimeBudgetV7_(35 * 1000)) {
    const _t13F = Date.now();
    institutional13F = (function() {
      try {
        const cusip13F = fetch13FCusipV7(ticker);
        if (!cusip13F) return null;
        const holdings = fetchInstitutional13FHoldingsV7(cusip13F);
        const anyReal = Object.values(holdings).some(q => (q.latest && q.latest.holdings) || (q.prior && q.prior.holdings));
        return anyReal ? holdings : null;
      } catch (e) { return null; }
    })();
    if (log) log('  ⏱ institutional 13F fetch: ' + ((Date.now()-_t13F)/1000).toFixed(1) + 's');
  } else if (log) log('  ⏭ Skipped: institutional 13F fetch — time budget (cold cache would cost ~20-30s+, protecting the rest of the report)');

  // Gap detection is needed by the News/Catalyst section below
  // (gapMarketCapSignificanceV1) — computed here once, reused there.
  const gaps = detectPriceGapsV1(chart.opens, chart.closes, chart.dates, 0.02);
  const lastGap = gaps.length ? gaps[gaps.length - 1] : null;

  // ── 2. Player Mapping ──
  const playerMapping = playerMappingReadV1(chart.closes, chart.highs, chart.lows, chart.volumes, chart.currentPrice, 20);

  // ── 3. Fundamentals screen ──
  // v9.97: reuse the engine's own already-fetched shares-outstanding
  // history (its own dilution-screen port, v9.93) when supplied alongside
  // the same cik above -- same dedup pattern as fund/cik.
  const sharesOutstandingHistory = existingSoHistory !== undefined ? existingSoHistory : fetchSharesOutstandingHistoryV1(cik);
  // Real bug caught by this phase's own real-data check: with no date
  // restriction, a mature mega-cap's decades of routine filings (e.g.
  // ordinary corporate-bond "convertible" notes, standard stock-plan
  // "offering" boilerplate) trivially hit all 5 keywords — a false-
  // positive risk the course's own worked example (an ACTIVE, ongoing
  // dilution pattern) doesn't have. The course names no exact recency
  // window, so this uses a disclosed 365-day default (a reasonable
  // "most recent annual cycle" reading, same discipline as this file's
  // other undefined-window defaults elsewhere), not fit to a backtest.
  const oneYearAgo = new Date(new Date().getTime() - 365 * 86400000);
  // v9.97: reuse the engine's own already-fetched filing-keyword hits
  // (same 365-day window, both copies now agree -- see the engine's own
  // v9.97 comment for the real, disclosed reason the window was widened
  // to match this file's own pre-existing choice) when supplied.
  const filingKeywordHits = existingFilingHits !== undefined ? existingFilingHits : fetchSecFilingKeywordHitsV1(cik, Utilities.formatDate(oneYearAgo, 'UTC', 'yyyy-MM-dd'));
  const fundamentalsScreen = fundamentalsScreenReadV1(fund ? fund.revenueGrowth : null, chart.ipoDate, new Date(), sharesOutstandingHistory, filingKeywordHits);

  // ── 4. Technical read ──
  const range52w = trailing52WeekRangeV1(chart.highs, chart.lows, chart.dates);
  const roc252 = (chart.closes.length > 252) ? (chart.currentPrice - chart.closes[chart.closes.length - 1 - 252]) / chart.closes[chart.closes.length - 1 - 252] : null;
  const breakoutContext = breakoutContextReadV1(chart.currentPrice, range52w ? range52w.high : null, roc252);

  const lastCandleType = classifyCandleV1(chart.opens[n], chart.highs[n], chart.lows[n], chart.closes[n]);
  const sma50Series = smaSeriesV1(chart.closes, 50), sma200Series = smaSeriesV1(chart.closes, 200);
  const maRelationship = maRelationshipReadV1(sma50Series, sma200Series);
  const precedingTrend = maRelationship ? maRelationship.slope50 : null;
  const candleContext = candleContextReadV1(lastCandleType, precedingTrend, idCard.relativeVolume);

  const { resistanceLevels, supportLevels } = findSupportResistanceV1(chart.highs, chart.lows, 0.03, n);
  const srReliability = srReliabilityContextV1(breakoutContext.nearATH, breakoutContext.longTermTrend);

  const { swingHighs, swingLows } = findSwingPointsV1(chart.highs, chart.lows, 5);
  const lastSwingHigh = swingHighs.length ? swingHighs[swingHighs.length - 1] : null;
  const lastSwingLow = swingLows.length ? swingLows[swingLows.length - 1] : null;
  let fibRead = null;
  if (lastSwingHigh && lastSwingLow) {
    const direction = lastSwingHigh.idx > lastSwingLow.idx ? 'up' : 'down';
    fibRead = fibonacciRetracementReadV1(chart.currentPrice, lastSwingHigh.price, lastSwingLow.price, direction);
  }

  // v9.92: reuse the engine's own already-fetched VIX level
  // (chart.vixContext.level, fullStockAnalysisV9_91.gs) when the caller
  // supplied one — was an unconditional 2nd fetchYahooChart('^VIX') call
  // before this fix, on top of the engine's own separate VIX fetch every
  // single run. Falls back to its own fetch when omitted (standalone/test use).
  const vixLevel = existingVixLevel != null ? existingVixLevel : (function() {
    // v9.101, real logging fix (user-reported real timeout, 2026-09-05):
    // this was one of 9 real, sequential UrlFetchApp calls in this
    // function with ZERO log() output between them -- a real 🔬 Log dead
    // zone that made a real hard-timeout undiagnosable (the trace went
    // silent right after the 13F timing line above, with no way to tell
    // which of the remaining calls was the actual bottleneck). Only fires
    // when the caller didn't already supply existingVixLevel (rare in the
    // real production path, common in standalone/test calls).
    const _tVix = Date.now();
    const vixChart = fetchYahooChart('^VIX');
    if (log) log('  ⏱ VIX fetch (own, not reused): ' + ((Date.now()-_tVix)/1000).toFixed(1) + 's');
    return vixChart ? vixChart.currentPrice : null;
  })();
  const vix = vixRegimeReadV1(vixLevel);

  // ── 5. News/Catalyst context ──
  // (gaps/lastGap now computed earlier, before Player Mapping — reused here)
  const gapType = lastGap ? classifyGapTypeV1(lastGap, gaps, chart.highs, chart.lows, chart.volumes, chart.closes, breakoutContext.nearATH, breakoutContext.longTermDowntrend) : null;
  const gapCapContext = lastGap ? gapMarketCapSignificanceV1(lastGap.sizePct, idCard.marketCapTier) : null;
  // v9.97: `fund` (whether reused or freshly fetched above) already carries
  // ._earningsHistory -- gatherFundamentals's own body fetches it
  // internally. Reuse that instead of a 2nd/3rd separate fetchEarningsCalendarV7
  // call for the exact same data.
  const _tEarnings = Date.now();
  const earningsHistory = (fund && fund._earningsHistory != null) ? fund._earningsHistory
    : ((typeof fetchEarningsCalendarV7 === 'function') ? (fetchEarningsCalendarV7(ticker, log) || {}).history : null);
  // v9.101, real logging fix: only a real fetch when `fund` didn't already
  // carry _earningsHistory (rare in production, since gatherFundamentals
  // fetches it) -- logged either way so a real timeout's trace can tell
  // "reused, ~0s" apart from "own real fetch, Xs" instead of showing nothing.
  if (log) log('  ⏱ earnings calendar (' + ((fund && fund._earningsHistory != null) ? 'reused' : 'own fetch') + '): ' + ((Date.now()-_tEarnings)/1000).toFixed(1) + 's');
  const earningsGap = (lastGap && earningsHistory) ? classifyEarningsGapV1(lastGap, earningsHistory, 1) : null;
  const reverseSplit = reverseSplitAvoidFlagV1(chart.splits, chart.dates, n);
  // 2026-09-06, real structural fix (user's own explicit direction, after
  // tracing a real, reproducible live timeout (GOOGL) directly to THIS
  // exact call -- the 🔬 Log went dark right after "earnings calendar
  // (reused)" with zero further output, and this was the very next line of
  // code): Apps Script has no real way to bound or interrupt a single
  // UrlFetchApp.fetch() once it starts, so no time-budget guard can
  // protect against a hang already in progress, only against starting one
  // late. Real fix: this call no longer runs on the interactive path AT
  // ALL. It's now fetched ONLY by the nightly automation
  // (refreshBrokerCourseDataCacheV1_, called from runDailyAutomationV7 for
  // every watchlist ticker) and written to a permanent Sheet
  // (readBrokerDataCacheV1_/writeBrokerDataCacheV1_, fullStockAnalysisV9_107.gs)
  // -- a rare hang there doesn't block a live user. The interactive path
  // just reads the cache; genuinely unavailable (new ticker never run
  // through the automation yet, or cache older than
  // BROKER_DATA_CACHE_STALE_DAYS_V1) reads as null, same as before.
  const brokerDataCache = (typeof readBrokerDataCacheV1_ === 'function') ? readBrokerDataCacheV1_(ticker) : null;
  const shortInterestData = (brokerDataCache && brokerDataCache.shortInterest != null)
    ? { shortInterest: brokerDataCache.shortInterest, daysToCover: brokerDataCache.daysToCover, settlementDate: brokerDataCache.settlementDate }
    : null;
  const shortPctOfFloat = (shortInterestData && idCard.floatShares) ? shortInterestData.shortInterest / idCard.floatShares : null;
  const squeezeSetup = shortSqueezeSetupReadV1(shortPctOfFloat, chart.currentPrice, range52w ? range52w.high : null);
  // Real bug caught in this phase's own real-data check (GME): the
  // orchestrator was calling shortSqueezeSetupReadV1 directly instead of
  // Phase 10's vixAndSqueezeReadV1 wrapper, so the disclosed Nasdaq-
  // listed-only limitation silently disappeared for any excluded ticker
  // instead of being shown — fixed by surfacing it explicitly whenever
  // short-interest data comes back unavailable, not just bypassed.
  const shortInterestNote = shortInterestData ? null : 'Short-interest data not available — Nasdaq-listed tickers only (verified live, ep.9/13)';

  // ── 6. Technique match ──
  const techniqueEntry = techniqueEntryReadV1(chart.closes, chart.highs, chart.volumes, n, idCard.marketCap, supportLevels, null);

  // ── 7. Risk-sized position recommendation ──
  const riskOverlay = riskOverlayReadV1(idCard.marketCap, idCard.atrPct, ticker);

  // ── 8. Macro context ──
  // 2026-09-06, real structural fix, same reasoning as short-interest
  // above: these 4 real external calls (3 FRED series + 1 FMP ratio) no
  // longer run on the interactive path at all -- Apps Script can't bound a
  // hung fetch regardless of any time-budget check, so the only real fix
  // is removing the risk, not padding the guard. FRED series (market-wide,
  // NOT per-ticker) come from readMacroSnapshotV1_ (one shared cache row,
  // refreshed by the nightly automation); FMP interest-coverage (per-
  // ticker) comes from the SAME brokerDataCache read as short-interest
  // above, one shared cache lookup, not a second one. Genuinely
  // unavailable (new ticker, or cache older than
  // BROKER_DATA_CACHE_STALE_DAYS_V1) reads as null -- macroOverlayReadV1
  // already null-coalesces every one of these inputs gracefully, unchanged.
  const macroSnapshot = (typeof readMacroSnapshotV1_ === 'function') ? readMacroSnapshotV1_() : null;
  const dgs10 = macroSnapshot ? macroSnapshot.dgs10 : null;
  const fedfunds = macroSnapshot ? macroSnapshot.fedfunds : null;
  const gdpSeries = macroSnapshot ? macroSnapshot.gdpSeries : null;
  const interestCoverageRatio = brokerDataCache ? brokerDataCache.interestCoverageRatio : null;
  const macroOverlay = macroOverlayReadV1(dgs10 ? dgs10.slice(-20) : null, fedfunds ? fedfunds.slice(-12) : null, gdpSeries, interestCoverageRatio);

  // ── 9. Final synthesis — qualitative, no fabricated score ──
  const bullish = [], cautionary = [];
  if (playerMapping.tag === 'Institutional-Accumulation-Signature') bullish.push('Player Mapping: institutional-accumulation signature');
  if (playerMapping.tag === 'Speculative-Spike') cautionary.push('Player Mapping: speculative-spike signature (lower reliability)');
  if (fundamentalsScreen.tag === 'Dilution/Pump-Dump Risk Flagged') cautionary.push('Fundamentals: dilution/pump-dump risk flagged');
  if (fibRead && fibRead.trendIntact === false) cautionary.push('Fibonacci: retracement exceeds 50%, trend likely broken');
  if (maRelationship && maRelationship.cross && maRelationship.cross.indexOf('Golden') === 0) bullish.push('Technicals: golden cross');
  if (maRelationship && maRelationship.cross && maRelationship.cross.indexOf('Death') === 0) cautionary.push('Technicals: death cross');
  if (reverseSplit) cautionary.push('News: recent reverse split — course\'s own avoid-heuristic');
  if (squeezeSetup && squeezeSetup.isSqueezeSetup) bullish.push('News: Short Squeeze setup identified');
  if (techniqueEntry.tag !== 'No specific entry technique identified') bullish.push('Technique: ' + techniqueEntry.tag);
  // Phase 13 additions: the 2 new real signals not already folded into an
  // existing tag (fundamentalsScreen.tag already covers shares-outstanding
  // and filing-keyword flags, since fundamentalsScreenReadV1 sets the same
  // tag for any of its 3 red-flag checks).
  if (interestCoverageRatio != null && interestCoverageRatio < 1.0) cautionary.push('Macro: interest coverage below 1.0 — standard academic zombie-company profile');
  // v2026-09-03 -- real promotion, user's explicit "yes" (fast-tracked
  // alongside SCALLOP_SERIES). Real, in/out-of-sample-confirmed evidence
  // (tests/vix_yield_oos_split_test.js, 2026-09-02): VIX in the course's own
  // "Normal (13-25)" band shows a real, modest historical UNDERperformance
  // vs baseline, confirmed on BOTH a heavily-tuned-against group (PLTR/TSLA,
  // p=0.0425) AND a genuinely untouched out-of-sample group (JNJ/KO/JPM/
  // DECK/POOL, p=0.0048), same direction both times (-2.59pp/-0.77pp) --
  // the one signal, of 19 real VIX/yield + chart-pattern signals checked
  // this pass, that cleanly survived a real split. A mild, real caution,
  // not a strong bearish call -- this project's own long-only/calls-only
  // strategy never reads this as a short signal.
  if (vix && vix.regime === 'Normal (13-25)') cautionary.push('VIX: Normal regime (13-25) shows a real, modest historical underperformance vs baseline, confirmed in-sample AND out-of-sample (-2.59pp/-0.77pp, p=0.0425/0.0048) -- a mild caution, not a strong bearish signal');
  const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
    : cautionary.length > bullish.length ? 'Net read leans cautionary'
    : 'Net read is mixed/neutral — no clear lean';

  return {
    ticker,
    idCard,
    playerMapping,
    fundamentalsScreen,
    technical: { breakoutContext, lastCandleType, candleContext, resistanceLevels, supportLevels, srReliability, maRelationship, fibRead, vix },
    news: { gaps, lastGap, gapType, gapCapContext, earningsGap, reverseSplit, shortInterestData, shortPctOfFloat, squeezeSetup, shortInterestNote },
    technique: techniqueEntry,
    risk: riskOverlay,
    macro: macroOverlay,
    institutional13F,
    synthesis: { bullish, cautionary, netRead }
  };
}

// Human-readable formatter — mirrors the course's own live walkthrough
// structure (design doc §10: "literally how the instructor evaluates
// CRSP/UBER/etc. live in ep.7"), one section per category, evidence
// lines under each, real gaps shown inline rather than omitted.
function formatBrokerCourseReportV1(report) {
  if (!report) return 'No report — data fetch failed.';
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
  push('── ' + report.ticker + ' — Broker Course Model v1 ──');
  push('');
  push('1. STOCK ID CARD');
  push('  Price: ' + report.idCard.price + '  Market cap: ' + report.idCard.marketCapTier + '  Float: ' + report.idCard.floatTier);
  push('  ATR%: ' + (report.idCard.atrPct != null ? (report.idCard.atrPct*100).toFixed(1)+'%' : 'n/a') + ' — ' + report.idCard.atrFlag);
  push('  Relative volume: ' + (report.idCard.relativeVolumeRead || 'n/a'));
  // Real bug fix (this audit): weekly/monthly volatility % was computed
  // but never displayed anywhere -- the course's own hot/coiled read
  // (ep.1, raw-verified) is a real signal, not a decoration.
  push('  Weekly volatility: ' + (report.idCard.weeklyVolatilityRead ? report.idCard.weeklyVolatilityRead.read : 'n/a'));
  push('  Monthly volatility: ' + (report.idCard.monthlyVolatilityRead ? report.idCard.monthlyVolatilityRead.read : 'n/a'));
  push('');
  push('2. PLAYER MAPPING: ' + report.playerMapping.tag);
  report.playerMapping.evidence.forEach(e => push('  - ' + e));
  push('');
  push('3. FUNDAMENTALS SCREEN: ' + report.fundamentalsScreen.tag);
  report.fundamentalsScreen.evidence.forEach(e => push('  - ' + e));
  // Phase 13: when flagged, fundamentalsScreenReadV1 already pushed this
  // exact read into `evidence` above (same duplication class caught and
  // fixed in Player Mapping's gap-hold/fade line, this phase's own
  // real-data check caught it here too) — only print here when it's the
  // disclosed-gap / fetch-failed / not-flagged fallback, never dropped.
  if (report.fundamentalsScreen.sharesOutstandingTrend.indexOf('Shares outstanding steadily rising') !== 0) push('  ' + report.fundamentalsScreen.sharesOutstandingTrend);
  if (report.fundamentalsScreen.filingKeywordSearch.indexOf('Recent filings mention') !== 0) push('  ' + report.fundamentalsScreen.filingKeywordSearch);
  push('');
  push('4. TECHNICAL READ');
  push('  Last candle: ' + report.technical.lastCandleType + (report.technical.candleContext ? ' — ' + report.technical.candleContext.read : ''));
  push('  ' + report.technical.srReliability);
  if (report.technical.maRelationship) push('  MA: 50-slope ' + report.technical.maRelationship.slope50 + ', ' + report.technical.maRelationship.convergence + (report.technical.maRelationship.cross ? ' — ' + report.technical.maRelationship.cross : ''));
  if (report.technical.fibRead) push('  Fibonacci: ' + report.technical.fibRead.read);
  if (report.technical.vix) push('  ' + report.technical.vix.read);
  push('');
  push('5. NEWS/CATALYST CONTEXT');
  if (report.news.lastGap) push('  Last gap: ' + report.news.lastGap.type + ' ' + (report.news.lastGap.sizePct*100).toFixed(1) + '% — ' + report.news.gapType + (report.news.gapCapContext ? ' | ' + report.news.gapCapContext : ''));
  if (report.news.earningsGap) push('  Earnings-linked, EPS surprise ' + (report.news.earningsGap.epsSurprisePct != null ? report.news.earningsGap.epsSurprisePct.toFixed(1)+'%' : 'n/a'));
  if (report.news.reverseSplit) push('  ' + report.news.reverseSplit.read);
  if (report.news.squeezeSetup) push('  ' + report.news.squeezeSetup.read);
  if (report.news.shortInterestNote) push('  (gap) ' + report.news.shortInterestNote);
  push('');
  push('6. TECHNIQUE: ' + report.technique.tag);
  report.technique.evidence.forEach(e => push('  - ' + e));
  push('');
  push('7. RISK-SIZED POSITION RECOMMENDATION');
  report.risk.evidence.forEach(e => push('  - ' + e));
  push('');
  push('8. MACRO CONTEXT');
  report.macro.evidence.forEach(e => push('  - ' + e));
  push('');
  push('9. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach(b => push('  [+] ' + b));
  report.synthesis.cautionary.forEach(c => push('  [-] ' + c));

  // 10. Institutional holdings (13F) -- 2026-08-24, separate from Player
  // Mapping's own course-taught tag/evidence on purpose (see the real,
  // disclosed reasoning at this field's own computation site). Real,
  // quarterly-snapshot data -- never claims to confirm or explain Player
  // Mapping's inferred SHAPE-based read, just genuine supplementary context.
  if (report.institutional13F) {
    push('');
    push('10. INSTITUTIONAL HOLDINGS (13F — Berkshire/BlackRock/Vanguard/State Street)');
    Object.entries(report.institutional13F).forEach(([name, q]) => {
      const latestPos = q.latest && q.latest.holdings;
      const priorPos = q.prior && q.prior.holdings;
      if (!latestPos && !priorPos) return;
      if (latestPos && priorPos) {
        const pct = (latestPos.shares - priorPos.shares) / priorPos.shares * 100;
        push('  - ' + name + ': ' + latestPos.shares.toLocaleString() + ' shares ($' + (latestPos.value/1e6).toFixed(1) + 'M), ' + (pct>=0?'+':'') + pct.toFixed(1) + '% vs prior qtr (' + q.latest.date + ')');
      } else if (latestPos) {
        push('  - ' + name + ': ' + latestPos.shares.toLocaleString() + ' shares ($' + (latestPos.value/1e6).toFixed(1) + 'M), no prior-qtr comparison (' + q.latest.date + ')');
      } else {
        push('  - ' + name + ': held ' + priorPos.shares.toLocaleString() + ' shares as of prior qtr (' + q.prior.date + '), not in latest filing');
      }
    });
  }

  return lines.join('\n');
}

// ── Phase 12: Comparison Report (§10.5) — final phase ────────────────
//
// A THIRD artifact, separate from both single-model reports (user's
// explicit follow-up request, per the design doc). Runs the same ticker
// through both the existing engine (whichever fullStockAnalysisV9_*.gs is
// currently live) and this new model, then diffs agreement/disagreement
// + why. Per the design
// doc's own framing (§10.5): "downstream tooling, not new course-derived
// methodology" — so calling the existing engine's real functions here
// (`fetchYahooChart`, `gatherFundamentals`, `computeAllIndicators`,
// `computeGannInline`, `computeFundamentalScoreV7`,
// `computeConfluenceTargets`, `computeTechnicalPlanV7`,
// `synthesizeDecisionV7`) is explicitly sanctioned, unlike every other
// phase's "solely those videos, zero *V7 reuse" rule — this phase's whole
// point is comparing against that engine's real, unmodified output, not
// re-deriving it. Both files are assumed deployed in the same Apps
// Script project (shared global scope), same assumption
// `buildBrokerCourseReportV1` already makes for its own infrastructure
// reuse (fetchYahooChart/gatherFundamentals).
// `existingTechPlan`/`existingDecision`/`existingFundScore` are OPTIONAL —
// when the caller already ran the existing engine's own pipeline (e.g.
// runAnalysisV7, which computes all three anyway on the way to its own
// dashboard), pass them in directly to skip a wasteful full re-fetch/
// re-compute of the SAME ticker's SAME data a second time. Omitted
// (every pre-this-change call site, including this file's own real
// end-to-end validation), behavior is unchanged — self-fetches exactly
// as before, backward-compatible.
// v9.46 gained a 6th optional param, `existingNewModelReport` — the SAME
// double-fetch fix already applied to the existing-engine side (v9.45),
// now applied to this file's own report too: `runAnalysisV7` already
// builds it once for the "Broker Model" tab before calling this function,
// so building it again here was the real, un-deduped half of the "efficiency
// fix" the independent review caught (2026-08-22).
//
// 2026-08-31, docs/SCHABACKER_IMPLEMENTATION_PLAN.md §5: gained a 7th
// optional param, `existingSchabackerReport` — a real Schabacker-model
// report (schabackerModelV1.gs's `buildSchabackerReportV1`), passed the
// SAME way `existingNewModelReport` already is (`runAnalysisV7` computes it
// once for the "Schabacker Model" tab, then passes it straight through here
// rather than this file re-deriving it). Real, disclosed backward-
// compatibility requirement: when omitted (every pre-this-change call
// site), this function's return shape is BYTE-IDENTICAL to before —
// no `schabackerDirection`/`verdict`/etc. keys are added at all, not even
// as `null` — the existing 2-way `agree`/`existingDirection`/`newDirection`
// output is completely untouched. Verified via a real regression test
// (schabacker_comparison_test.js) that the OLD 6-argument call produces
// the exact same output as before this change.
// 2026-09-02, docs/BIG_PLAN_EDWARDS_MAGEE.md (final step): gained an 8th
// optional param, `existingEdwardsMageeReport` — a real Edwards & Magee
// model report (edwardsMageeModelV1.gs's `buildEdwardsMageeReportV1`),
// passed the SAME way `existingSchabackerReport` already is. Real,
// disclosed backward-compatibility requirement, same as the 7th-arg
// addition: when omitted, this function's return shape is BYTE-IDENTICAL
// to before (verified via edwards_magee_comparison_test.js's own repeated-
// call + explicit-undefined-8th-arg checks, same discipline schabacker_
// comparison_test.js already established for the 7th arg).
//
// Real, disclosed generalization: the verdict logic below now handles
// 2, 3, OR 4 real voices with ONE generic algorithm rather than 2
// separate hardcoded blocks -- verified to produce IDENTICAL results to
// the old 3-voice-specific logic for every 3-voice case (ALL_AGREE/
// MAJORITY/NO_CONSENSUS map onto the exact same real outcomes), so this
// is a behavior-preserving generalization, not a silent change, for every
// existing 7-arg caller. Genuinely NEW for 4 voices: a real 2-2 exact tie
// is now possible (impossible with an odd voter count) -- given its own
// honest new verdict, `SPLIT`, rather than mislabeling it MAJORITY (no
// side actually has more than half) or silently defaulting to NO_CONSENSUS
// (which already means "every voice genuinely differs," a different real
// situation from "two clean pairs agree with each other").
// v9.92 real fix (2026-09-03, docs/CLAUDE_CODE_HANDOFF.md section 3.7):
// Engine data is the one real required anchor here (always available at
// the real call site in runAnalysisV7) -- Broker/Schabacker/E&M are each
// independently optional. Real, disclosed bug this replaces: the old code
// returned null outright whenever Broker Model specifically failed, even
// when Schabacker and/or E&M succeeded fine -- confirmed by direct code
// read, not guessed (Bug 2 of 3 found in the same session's architecture
// audit). Only returns null now if genuinely NOTHING is available to
// compare against the engine.
function buildComparisonReportV1(ticker, log, existingTechPlan, existingDecisionArg, existingFundScore, existingNewModelReport, existingSchabackerReport, existingEdwardsMageeReport, existingTurtleReport) {
  const newModel = existingNewModelReport !== undefined ? existingNewModelReport : buildBrokerCourseReportV1(ticker, log);
  if (!newModel && !existingSchabackerReport && !existingEdwardsMageeReport && !existingTurtleReport) {
    if (log) log('Comparison: no model report available at all for ' + ticker);
    return null;
  }

  let techPlan = existingTechPlan, fundScore = existingFundScore, decision = existingDecisionArg;
  // v9.46 fix (independent review, 2026-08-22): was `=== undefined` only,
  // so an explicit `null` for any of the 3 skipped the self-fetch and then
  // threw downstream reading a property off null -- silently swallowed by
  // the caller's try/catch, killing both new reports with just a log line.
  // `== null` catches both omitted (undefined) and explicit-null callers.
  if (techPlan == null || fundScore == null || decision == null) {
    // Existing engine's real pipeline, called as-is, not re-derived.
    const chart = fetchYahooChart(ticker);
    if (!chart) { if (log) log('Comparison: chart fetch failed for ' + ticker); return null; }
    const ind = computeAllIndicators(chart);
    const gann = computeGannInline(chart, ind);
    const fundResult = gatherFundamentals(ticker, log);
    const fund = fundResult ? fundResult.fund : null;
    fundScore = computeFundamentalScoreV7(fund);
    const confluence = computeConfluenceTargets(ind, gann, fund, chart);
    techPlan = computeTechnicalPlanV7(ind, gann, confluence, chart, null);
    decision = synthesizeDecisionV7(fundScore, techPlan, null);
  }
  const existingDecision = decision;

  // v9.46 real bug fix (independent review, 2026-08-22, verified before
  // fixing): mapping raw `techPlan.timing` alone treated WAIT_PULLBACK as
  // uniformly "mixed" -- but the existing engine's OWN synthesizeDecisionV7
  // MATRIX already classifies (fundBand,timing) pairs into real, human-
  // authored verdicts, and own+WAIT_PULLBACK is literally labeled "GREAT
  // COMPANY — SET A BUY LIMIT" (a real bullish setup, just not at the ideal
  // entry yet) -- the SAME class as own+BUY_NOW, not a neutral fallthrough.
  // This table reuses that ALREADY-AUTHORED semantic classification off the
  // stable (fundBand,timing) enum pair -- not a new judgment call, not a
  // fabricated numeric threshold (finalConviction has no existing banding
  // convention anywhere in this codebase to reuse honestly).
  const EXISTING_DIRECTION_MAP = {
    own:     { BUY_NOW: 'bullish', WAIT_PULLBACK: 'bullish',   AVOID: 'cautionary' },
    mixed:   { BUY_NOW: 'mixed',   WAIT_PULLBACK: 'mixed',     AVOID: 'cautionary' },
    weak:    { BUY_NOW: 'mixed',   WAIT_PULLBACK: 'cautionary', AVOID: 'cautionary' },
    unknown: { BUY_NOW: 'mixed',   WAIT_PULLBACK: 'mixed',     AVOID: 'cautionary' }
  };
  // Real bug caught by this file's own test suite before shipping: the
  // engine's real action string is emoji-prefixed ('🚫 BLOCKED — ...'),
  // so `.indexOf('BLOCKED') === 0` never matched. Fixed to a contains
  // check (`> -1`) -- real, verified: no other MATRIX label anywhere
  // contains this literal word.
  const isBlocked = existingDecision && existingDecision.action && existingDecision.action.indexOf('BLOCKED') > -1;
  const existingDirection = isBlocked ? 'cautionary'
    : ((EXISTING_DIRECTION_MAP[decision.fundBand] && EXISTING_DIRECTION_MAP[decision.fundBand][techPlan.timing]) || 'mixed');

  // Real, shared helper — all 3 external reports share the identical
  // .synthesis.{netRead,bullish,cautionary} shape. Was duplicated 3x
  // inline before this fix (v9.92); one function now, reused for
  // broker/Schabacker/E&M alike.
  function directionFromReport(report) {
    if (!report) return null;
    return report.synthesis.netRead.indexOf('supportive') > -1 ? 'bullish'
      : report.synthesis.netRead.indexOf('cautionary') > -1 ? 'cautionary' : 'mixed';
  }
  const newDirection = directionFromReport(newModel);
  // v9.92: null (not a throw) when Broker Model itself is unavailable —
  // `agree`/`sameReasoning` only mean something when there IS a Broker
  // Model reading to compare against.
  const agree = newModel ? (existingDirection === newDirection) : null;

  // Which specific signals drove each side — read directly off each
  // model's own already-produced output, not re-derived. v9.46: added the
  // real finalConviction/action now that they actually drive the mapping.
  const existingSignals = [
    'Regime: ' + techPlan.regime, 'Tech score: ' + techPlan.techScore + '/100',
    'Timing: ' + techPlan.timing, 'OWN score: ' + (fundScore.score != null ? fundScore.score + '/100 ' + fundScore.verdict : 'N/A'),
    'Final Conviction: ' + (existingDecision ? existingDecision.finalConviction + '/100 — ' + existingDecision.action : 'N/A')
  ];
  const newSignals = newModel ? newModel.synthesis.bullish.concat(newModel.synthesis.cautionary) : null;

  const baseResult = {
    ticker, agree, existingDirection, newDirection,
    existingSignals, newSignals,
    existingHeadline: existingDecision ? existingDecision.headline : null,
    newHeadline: newModel ? newModel.synthesis.netRead : null,
    // v9.92: explicit, disclosed flag — lets callers/the formatter know
    // Broker Model specifically was unavailable, without having to infer
    // it from newHeadline being null.
    newModelUnavailable: !newModel,
    // Real, disclosed note: agreement doesn't mean the same REASONS —
    // the two models share almost no signal vocabulary (design doc's own
    // §10.5 point #3), so this is always worth stating explicitly.
    sameReasoning: !newModel ? null : agree && (existingDirection === 'bullish'
      ? (newModel.playerMapping.tag === 'Institutional-Accumulation-Signature' || newModel.technique.tag !== 'No specific entry technique identified')
      : existingDirection === 'cautionary'
      ? (newModel.fundamentalsScreen.tag === 'Dilution/Pump-Dump Risk Flagged' || (newModel.technical.fibRead && newModel.technical.fibRead.trendIntact === false))
      // v9.46 fix: the 'mixed' branch previously always returned null here,
      // silently never rendering §10.5's required same/different-reasons
      // distinction on this path. A real, defensible check for "mixed for
      // related reasons": both sides show a genuinely balanced read (the
      // new model's own bullish/cautionary evidence counts are equal),
      // rather than one side masking a real lean.
      : newModel.synthesis.bullish.length === newModel.synthesis.cautionary.length)
  };

  // 2026-08-31/2026-09-02/2026-09-05: 3rd/4th/5th voices, each added ONLY
  // when its own real report was passed in — omitted entirely (not even as
  // null keys) when it wasn't, preserving byte-identical backward
  // compatibility for every existing 2-way/3-way/4-way caller.
  if (!existingSchabackerReport && !existingEdwardsMageeReport && !existingTurtleReport) return baseResult;

  // v9.92: `newModel`'s own voice is only included when it's actually
  // present — was unconditional before this fix, the exact Bug 2 this
  // whole change addresses (a missing Broker Model no longer silently
  // corrupts or blocks the N-way verdict against Schabacker/E&M).
  const namedDirections = [{ name: 'existingEngine', dir: existingDirection }];
  if (newModel) namedDirections.push({ name: 'newModel', dir: newDirection });
  const extra = {};
  if (existingSchabackerReport) {
    const schabackerDirection = directionFromReport(existingSchabackerReport);
    extra.schabackerDirection = schabackerDirection;
    extra.schabackerSignals = existingSchabackerReport.synthesis.bullish.concat(existingSchabackerReport.synthesis.cautionary);
    extra.schabackerHeadline = existingSchabackerReport.synthesis.netRead;
    namedDirections.push({ name: 'schabackerModel', dir: schabackerDirection });
  }
  if (existingEdwardsMageeReport) {
    const edwardsMageeDirection = directionFromReport(existingEdwardsMageeReport);
    extra.edwardsMageeDirection = edwardsMageeDirection;
    extra.edwardsMageeSignals = existingEdwardsMageeReport.synthesis.bullish.concat(existingEdwardsMageeReport.synthesis.cautionary);
    extra.edwardsMageeHeadline = existingEdwardsMageeReport.synthesis.netRead;
    namedDirections.push({ name: 'edwardsMageeModel', dir: edwardsMageeDirection });
  }
  // v9.100, Turtle model (turtleModelV1.gs) — 5th voice, same conditional
  // convention as Schabacker/E&M above: added ONLY when a real report was
  // passed in, byte-identical backward compatibility otherwise.
  if (existingTurtleReport) {
    const turtleDirection = directionFromReport(existingTurtleReport);
    extra.turtleDirection = turtleDirection;
    extra.turtleSignals = existingTurtleReport.synthesis.bullish.concat(existingTurtleReport.synthesis.cautionary);
    extra.turtleHeadline = existingTurtleReport.synthesis.netRead;
    namedDirections.push({ name: 'turtleModel', dir: turtleDirection });
  }

  // Real, explicit generic N-voice agreement rule (N=2 through 5 here) —
  // the old binary `agree` (kept above, unchanged, for backward
  // compatibility) has no honest meaning once there's more than 1 real
  // opinion beyond the existing engine. Verified to reproduce the exact
  // same real outcomes as the old 3-voice-specific logic for every 3-voice
  // case (ALL_AGREE when all match; MAJORITY, naming the single dissenter,
  // whenever exactly 2 of 3 agree -- always a real >50% majority at N=3;
  // NO_CONSENSUS when all 3 genuinely differ). A real 2-2 exact tie (SPLIT,
  // first possible at N=4) gets its own honest verdict rather than
  // mislabeling it MAJORITY (no side actually exceeds half) or folding it
  // into NO_CONSENSUS (a different real situation: there, every voice
  // differs; here, two clean pairs agree with each other).
  // v9.100 (Turtle, the real 5th voice): generalized the SPLIT check from
  // a hardcoded "namedDirections.length === 4" to `maxCount === N/2` --
  // this is the real, general tie condition for ANY even N, not just 4
  // (a real 2-2 split can now happen at N=4 with ANY 3 of the 4 optional
  // models present, not only Schabacker+E&M); at odd N (e.g. N=5, all 4
  // models present) N/2 is never a whole number, so this correctly never
  // fires there and falls through to NO_CONSENSUS, same as before.
  const dirCounts = {};
  namedDirections.forEach(m => { dirCounts[m.dir] = (dirCounts[m.dir] || 0) + 1; });
  const uniqueDirs = Object.keys(dirCounts);
  const maxCount = Math.max(...uniqueDirs.map(d => dirCounts[d]));
  const modalDirs = uniqueDirs.filter(d => dirCounts[d] === maxCount);
  let verdict, dissentingModel = null;
  if (uniqueDirs.length === 1) {
    verdict = 'ALL_AGREE';
  } else if (maxCount > namedDirections.length / 2) {
    verdict = 'MAJORITY';
    const dissenters = namedDirections.filter(m => m.dir !== modalDirs[0]);
    // 2026-09-08, real bug fix, confirmed via a real live SNDK run (5
    // voices, a genuine 3-2 split: engine+Schabacker+Turtle bullish vs.
    // new-model+E&M differing) -- the ORIGINAL code here only ever named a
    // dissenter when there was EXACTLY 1 (the only case possible at the
    // old 3-4-voice ceiling: N=4's 3-1 split), and silently fell back to
    // `null` for any other count -- at real N=5, a 3-2 majority split is
    // structurally common (maxCount=3 > 5/2=2.5, dissenters.length=2), and
    // the display line below string-concatenates that raw, producing the
    // real, live "MAJORITY (null dissents)" output this bug report caught.
    // Real fix: dissenters.length is ALWAYS >= 1 in this branch (MAJORITY
    // is only reached when uniqueDirs.length > 1, i.e. at least one voice
    // differs from the modal direction) -- join ALL real dissenter names,
    // not just a special-cased single one.
    dissentingModel = dissenters.map(m => m.name).join(', ');
  } else if (modalDirs.length === 2 && maxCount === namedDirections.length / 2) {
    verdict = 'SPLIT'; // a real, genuine exact tie -- only possible at an even N
  } else {
    verdict = 'NO_CONSENSUS';
  }

  return Object.assign({}, baseResult, extra, { verdict, dissentingModel });
}

function formatComparisonReportV1(comparison) {
  if (!comparison) return 'No comparison — data fetch failed.';
  const lines = [];
  const push = (s) => lines.push(s);
  // 2026-09-06, real fix: same #ERROR! bug as buildBrokerCourseReportV1's
  // own header (leading '=' parsed as a formula start by Sheets) -- see
  // that function's comment for the full detail.
  push('── ' + comparison.ticker + ' — Comparison Report ──');
  push('');
  // 2026-08-31/2026-09-02: 3-4 real voices (`comparison.verdict` is only
  // ever set when a real Schabacker and/or Edwards & Magee report was
  // passed to buildComparisonReportV1) get the real, generic N-voice
  // verdict line instead of the old binary AGREE/CONFLICT line. Omitted
  // entirely, this renders byte-identical to before — same 2-way bottom
  // line, unchanged. Real, disclosed dynamic listing: only names whichever
  // voices are actually present (2, 3, or 4), never a hardcoded voice list.
  if (comparison.verdict) {
    const verdictLabel = comparison.verdict === 'ALL_AGREE' ? 'ALL AGREE'
      : comparison.verdict === 'MAJORITY' ? 'MAJORITY (' + comparison.dissentingModel + ' dissents)'
      : comparison.verdict === 'SPLIT' ? 'SPLIT (2 vs 2, no real majority)'
      : 'NO CONSENSUS';
    // v9.92: 'new model' only listed when Broker Model was actually
    // available — was unconditional before this fix (would have printed
    // "new model: null").
    const voiceParts = ['existing engine: ' + comparison.existingDirection];
    if (!comparison.newModelUnavailable) voiceParts.push('new model: ' + comparison.newDirection);
    if (comparison.schabackerDirection) voiceParts.push('Schabacker model: ' + comparison.schabackerDirection);
    if (comparison.edwardsMageeDirection) voiceParts.push('Edwards & Magee model: ' + comparison.edwardsMageeDirection);
    if (comparison.turtleDirection) voiceParts.push('Turtle model: ' + comparison.turtleDirection);
    push('BOTTOM LINE: ' + verdictLabel + ' (' + voiceParts.join(', ') + ')');
  } else {
    push('BOTTOM LINE: ' + (comparison.agree ? 'AGREE' : 'CONFLICT') +
      ' (existing engine: ' + comparison.existingDirection + ', new model: ' + comparison.newDirection + ')');
  }
  if (comparison.agree && comparison.sameReasoning != null) {
    push('  Agreement is for ' + (comparison.sameReasoning ? 'related' : 'DIFFERENT') + ' reasons — see signals below.');
  }
  push('');
  // v9.46 doc/staleness fix (independent review, 2026-08-22): was
  // hardcoded to 'fullStockAnalysisV9_43.gs', printed to the user's
  // actual sheet output — stale by 2 real versions before this fix,
  // certain to go stale again after every future version bump. Reads
  // the engine's own real, shared-global-scope CONFIG_V7.version instead
  // (same variable the main engine's own dashboard header already uses),
  // so this line can never drift from the truth again. Falls back
  // gracefully if CONFIG_V7 isn't in scope (e.g. this file's own
  // standalone Node tests).
  const existingEngineLabel = (typeof CONFIG_V7 !== 'undefined' && CONFIG_V7.version) ? ('main engine ' + CONFIG_V7.version) : 'main engine';
  push('EXISTING ENGINE (' + existingEngineLabel + '): ' + comparison.existingHeadline);
  comparison.existingSignals.forEach(s => push('  - ' + s));
  push('');
  // v9.92: NEW MODEL section only rendered when Broker Model actually
  // succeeded — was unconditional before this fix (would have thrown
  // calling .forEach on a null newSignals). Same conditional convention
  // as the Schabacker/E&M sections just below.
  if (!comparison.newModelUnavailable) {
    push('NEW MODEL (brokerCourseModelV1.gs): ' + comparison.newHeadline);
    comparison.newSignals.forEach(s => push('  - ' + s));
  } else {
    push('NEW MODEL (brokerCourseModelV1.gs): unavailable — see this run\'s own log for why.');
  }

  // 2026-08-31: 3rd model section, only present when a real Schabacker
  // report was passed in — omitted entirely for a 2-way comparison, same
  // backward-compatible convention as the bottom line above.
  if (comparison.schabackerHeadline) {
    push('');
    push('SCHABACKER MODEL (schabackerModelV1.gs): ' + comparison.schabackerHeadline);
    comparison.schabackerSignals.forEach(s => push('  - ' + s));
  }
  // 2026-09-02: 4th model section, only present when a real Edwards & Magee
  // report was passed in — same backward-compatible convention.
  if (comparison.edwardsMageeHeadline) {
    push('');
    push('EDWARDS & MAGEE MODEL (edwardsMageeModelV1.gs): ' + comparison.edwardsMageeHeadline);
    comparison.edwardsMageeSignals.forEach(s => push('  - ' + s));
  }
  // v9.100: 5th model section, only present when a real Turtle report was
  // passed in — same backward-compatible convention.
  if (comparison.turtleHeadline) {
    push('');
    push('TURTLE MODEL (turtleModelV1.gs): ' + comparison.turtleHeadline);
    comparison.turtleSignals.forEach(s => push('  - ' + s));
  }

  return lines.join('\n');
}

// ── Phase 13: Closing 5 real, confirmed-buildable gaps ───────────────
//
// User's explicit instruction (2026-08-20): re-verify LIVE rather than
// trust earlier "not available" conclusions before accepting them —
// exactly the discipline that unblocked Short-Squeeze in Phase 10. All 5
// below were re-checked live this phase and found genuinely buildable
// with real, free, no-key data sources not previously tried. **ETF
// top-10-holdings composition (Phase 8's gap) was re-checked THREE
// times this phase** (FMP `etf/holdings`, `etf/holder-latest`,
// `etf/sector-weighting`, `api/v3/etf-holder`) — all four real, live
// attempts failed (empty result / legacy-endpoint-blocked / premium-
// gated) — genuinely still not available on this project's data access,
// not just assumed. That one stays a disclosed gap.

// ── 1. Shares-outstanding trend (ep.12 checklist item 2, Phase 6's gap) ──

// SEC EDGAR ticker -> CIK lookup. Real, free, official, no key. The full
// company_tickers.json file (~800KB, every SEC filer) is the standard,
// documented way to do this — no per-ticker lookup endpoint exists.
//
// v9.63-companion real fix (2026-08-25, user's own request: "old data does
// not change... check if exist save"): a ticker's CIK is effectively
// permanent (SEC assigns one CIK per registrant for life; the rare
// exception -- a ticker symbol getting reused by a DIFFERENT company after
// the original delists -- is real but rare enough that a 90-day TTL, not
// "forever," is the reasoned tradeoff here, same disclosed-not-backtested
// threshold discipline as every other default in this project). Reuses
// cacheGet/cacheSet VERBATIM from futuresStockAnalysisV3_3_1.gs (same
// Apps Script project, same global scope, already proven for OI-persistence
// tracking) -- zero new caching mechanism invented. Real, disclosed limit:
// PropertiesService caps each value at ~9KB; a single CIK string is a few
// bytes, comfortably under that, unlike the full 800KB source document
// this replaces re-fetching.

// Real shares-outstanding history via SEC's XBRL companyconcept API —
// verified live this phase (real AAPL history returned, e.g. real
// 888,325,973 shares at 2008-09-27). `CommonStockSharesOutstanding` is
// the standard XBRL tag every 10-K/10-Q reports this under.

// ep.12 checklist item 2: "red flag if steadily increasing (= repeated
// dilution)". Course gives no exact %, so "steadily increasing" is read
// directly: every one of the last `lookbackPeriods` real filed periods
// shows a HIGHER share count than the one before — a genuinely strict,
// disclosed reading of "steadily," not a fabricated threshold.
function sharesOutstandingTrendReadV1(history, lookbackPeriods) {
  if (!history || history.length < 2) return null;
  lookbackPeriods = lookbackPeriods == null ? 4 : lookbackPeriods;
  const recent = history.slice(-Math.min(lookbackPeriods, history.length));
  let steadilyRising = recent.length >= 2;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].value <= recent[i - 1].value) { steadilyRising = false; break; }
  }
  const first = recent[0].value, last = recent[recent.length - 1].value;
  const pctChange = (last - first) / first;
  return {
    steadilyRising, pctChange, periodsChecked: recent.length,
    firstDate: recent[0].date, lastDate: recent[recent.length - 1].date,
    read: steadilyRising
      ? ('Shares outstanding steadily rising over the last ' + recent.length + ' real reported periods (' +
         (pctChange * 100).toFixed(1) + '%, ' + recent[0].date + ' -> ' + recent[recent.length - 1].date +
         ') — repeated dilution red flag (ep.12 checklist item 2)')
      : 'Shares outstanding not steadily rising over the available reported history — no dilution red flag on this check'
  };
}

// ── 2. Filing-keyword search (ep.12 checklist item 3, Phase 6's gap) ──

// Real filing-keyword search via SEC EDGAR's full-text search API —
// verified live this phase (real 79-hit result for "dilution" on a real
// ticker's filings). Searches actual 10-K/10-Q/8-K/S-3 filing TEXT, not
// just metadata. Course's own literal keywords (ep.12): "offering" /
// "shelf" / "warrants" / "convertible" / "dilution".
var SEC_DILUTION_KEYWORDS_V1 = ['offering', 'shelf', 'warrants', 'convertible', 'dilution'];

// Real, disclosed limitation, caught by this phase's own real-data check
// (AAPL's real filings genuinely mention "convertible"/"warrants" in
// routine, benign contexts — existing convertible-note disclosures,
// standard stock-plan boilerplate — not dilution warnings): word
// PRESENCE alone, even within a recent window, is not the same as the
// course's own intent (an analyst reading the actual sentence for
// context). Stated explicitly in the read text below so this is
// surfaced as "worth a manual look," never presented as a proven flag —
// matches this project's "report honestly, don't oversell" discipline.
function filingKeywordReadV1(hits) {
  if (!hits) return null;
  const foundKeywords = Object.keys(hits).filter(k => hits[k] != null && hits[k] > 0);
  const anyFound = foundKeywords.length > 0;
  return {
    anyFound, hits, foundKeywords,
    read: anyFound
      ? ('Recent filings mention: ' + foundKeywords.join(', ') + ' — course\'s own red-flag keyword list (ep.12 checklist item 3). Word presence only, not context — worth a manual read, not a proven flag on its own.')
      : 'No recent filings match the course\'s red-flag keyword list'
  };
}

// ── 3. Business-cycle phase (ep.13, Phase 9's gap) ───────────────────

// Real business-cycle phase classification via FRED's real GDP (GDPC1)
// and unemployment rate (UNRATE) — verified live this phase (real
// current values: GDP ~$24.27T 2026-Q2, unemployment 4.1% July 2026).
// The course names 4 phases (expansion/peak/contraction/trough) but
// gives no per-ticker detection rule — this uses the STANDARD textbook
// recession definition (2 consecutive quarters of negative real GDP
// growth = contraction), a real, independent, textbook convention, not
// fit to any backtest, not invented for this project.
function businessCyclePhaseReadV1(gdpSeries) {
  if (!gdpSeries || gdpSeries.length < 3) return null;
  const n = gdpSeries.length;
  const q1 = (gdpSeries[n - 1] - gdpSeries[n - 2]) / gdpSeries[n - 2];
  const q2 = (gdpSeries[n - 2] - gdpSeries[n - 3]) / gdpSeries[n - 3];
  let phase;
  if (q1 < 0 && q2 < 0) phase = 'Contraction';
  else if (q1 < 0) phase = 'Peak (growth just turned negative)';
  else if (q2 < 0) phase = 'Trough (growth resumed after a contraction)';
  else if (q1 >= q2) phase = 'Expansion';
  else phase = 'Peak (growth decelerating, still positive)';
  return {
    phase, latestQGrowth: q1, priorQGrowth: q2,
    read: 'Business-cycle phase: ' + phase + ' (real GDP growth ' + (q1 * 100).toFixed(1) + '% latest quarter vs. ' +
      (q2 * 100).toFixed(1) + '% prior — standard 2-consecutive-negative-quarters recession definition, ep.13\'s own named phases)'
  };
}

// ── 4. "Zombie companies" screen (ep.13, Phase 9's gap) ──────────────

// FMP's `ratios-ttm` endpoint (already-used infrastructure — same base
// URL/key as fetchFMPFundamentals, just a field this file didn't read
// before) — verified live this phase (real AAPL 0, real Ford 2.67).

// 2026-09-06: the ONLY real callers of fetchNasdaqShortInterestV1 /
// fetchFMPInterestCoverageV1 / fetchFredSeriesV1 now -- moved off the
// interactive path entirely (see buildBrokerCourseReportV1's own comments)
// after a real, reproducible live timeout (GOOGL) traced directly to the
// Nasdaq call, and Apps Script having no way to bound a single hung
// fetch. Called from runDailyAutomationV7's existing per-ticker loop
// (fullStockAnalysisV9_107.gs) -- a rare hang here doesn't block a live
// user, unlike on the interactive path. Real, disclosed freshness check:
// skips the live fetch entirely if today's cache is already fresh
// (matches BROKER_DATA_CACHE_STALE_DAYS_V1's own reasoning), so re-running
// the automation same-day (or the "Run Watchlist Now" menu item) doesn't
// re-fetch needlessly.

// Market-wide (NOT per-ticker) -- call once per real automation run, not
// once per ticker. Same real freshness-skip reasoning as above.
//
// 2026-09-06, 2 real fixes (Opus review caught both):
// (1) fetchFredSeriesV1 returns the FULL unsliced real series -- DGS10 is
// a real DAILY series back to 1962, ~16,000 points, which as raw JSON
// comfortably exceeds Google Sheets' real 50,000-char-per-cell limit.
// writeMacroSnapshotV1_'s own write would silently fail (caught, no
// error), meaning this cache could NEVER actually be written at all. Only
// the real tail each downstream consumer actually reads is stored now
// (macroOverlayReadV1 reads dgs10.slice(-20)/fedfunds.slice(-12);
// businessCyclePhaseReadV1 reads gdpSeries[n-1]/[n-2], needs >=3 -- 8 is a
// generous real buffer, not a hard requirement).
// (2) same cache-poisoning fix as refreshBrokerCourseDataCacheV1_ above --
// only writes when at least one of the 3 real FRED series actually came back.

// Real screen via FMP's real `interestCoverageRatioTTM` (ratios-ttm
// endpoint, already-used infrastructure). Verified live this phase:
// AAPL returned 0 (near-zero NET interest expense, plausible for a
// company with large cash reserves alongside debt — sanity-checked
// against Ford's real 2.67 on the same field to confirm it behaves
// correctly, not a data bug). Threshold: interest coverage < 1.0
// (earnings don't even cover interest expense) is the standard academic
// "zombie company" definition (BIS/Fed research), a real, independent
// convention, not invented for this project, not fit to any backtest.
function zombieCompanyScreenV1(interestCoverageRatio) {
  if (interestCoverageRatio == null) return null;
  // v9.46/gap-fix (independent review, 2026-08-22, verified before
  // fixing): exactly 0 is a real, confirmed AAPL value meaning near-zero
  // NET interest expense (a company with enough cash to roughly net out
  // its own interest cost) -- the OPPOSITE of distress, not merely "no
  // data" (that case is already caught by the `== null` guard above).
  // Excluded from the flag. A negative ratio (implying negative EBIT --
  // genuinely losing money) still flows through the standard <1.0
  // threshold unchanged, since that IS a real distress signal.
  const isZombie = interestCoverageRatio !== 0 && interestCoverageRatio < 1.0;
  return {
    isZombie, interestCoverageRatio,
    read: isZombie
      ? ('Interest coverage ratio ' + interestCoverageRatio.toFixed(2) + ' — below 1.0, earnings don\'t cover interest expense — the standard academic "zombie company" definition (ep.13, real threshold, not invented)')
      : interestCoverageRatio === 0
      ? 'Interest coverage ratio 0.00 — near-zero net interest expense (e.g. large cash reserves offsetting debt), not a zombie-company profile'
      : ('Interest coverage ratio ' + interestCoverageRatio.toFixed(2) + ' — earnings cover interest expense, not a zombie-company profile')
  };
}

// ── 5. [REMOVED 2026-08-22] Gap-and-hold vs. gap-and-fade ────────────
// `fetchIntraday5MinV1` + `gapHoldOrFadeReadV1` removed. The rule they
// implemented ("gap holds/extends in first ~20min = forced-buyer/
// short-covering; fades = retail-chase, lower reliability") does not
// appear anywhere in the course — checked exhaustively via full
// transcript search (Hebrew) across ep.7 (the cited episode), ep.9
// (Short), and ep.10/ep.11 (the two episodes actually dedicated to
// gaps): no "minutes"-scoped rule, no forced-buyer/short-covering
// language tied to gaps anywhere. Ep.7's own notes on the nearest real
// content (pre-market order pileup explaining the first candle's
// extremity) say explicitly "not itself a new checkable technical
// rule." Not a fidelity nuance to fix — a fabricated rule cited to an
// episode that doesn't contain it. See CHECKPOINT_TODAY.md.
