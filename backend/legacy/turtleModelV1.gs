// ══════════════════════════════════════════════════════════════════════
//  turtleModelV1.gs — Original Turtle Trading System Model (Deliverable 1,
//  docs/BIG_PLAN_TURTLE.md)
//  Built per docs/BIG_PLAN_TURTLE.md's own Deliverable 1 section, 2026-09-05.
//
//  Source: "Original Turtle Trading System" manual (Curtis Faith, one of
//  Richard Dennis's original Turtles), Appendix E of Edwards, Magee &
//  Bassetti's "Technical Analysis of Stock Trends," 9th Ed., p681-702 —
//  NOT Edwards/Magee's own writing, a separately-authored, bundled
//  document (also freely available at originalturtles.org). Every real
//  number/rule below was re-verified directly against the raw PDF
//  (`pdftotext -f 727 -l 748`), not just docs/EDWARDS_MAGEE_BOOK_NOTES.md's
//  own §509-525 extraction — book-fidelity rule, applied from the start
//  for this model (CLAUDE.md standing rule, memory
//  `stock-analyzer-book-fidelity-rule`).
//
//  ⭐ Real, disclosed process-gap fix this file corrects: a past session
//  used engine-vs-Turtle SURFACE overlap (a bare Donchian(20) score,
//  N-normalized sizing, RS ranking already existed) to justify never
//  building this model standalone at all — the wrong test (CLAUDE.md's
//  own standing rule, Failure mode B). This file is that missing
//  Deliverable 1, built the same way as brokerCourseModelV1.gs/
//  schabackerModelV1.gs/edwardsMageeModelV1.gs.
//
//  ⭐ Long-only adaptation, per this user's own standing trading strategy
//  (memory `trading-strategy-long-only-calls`): every short-side rule
//  (short entries, short-side pyramiding/stops, the buy-strongest/
//  short-weakest RS rule's own short half) is dropped. This model reads
//  and reports LONG signals only. Real, disclosed consequence: the book's
//  own "last breakout" skip-filter state is native to a system that
//  alternates long AND short — dropped to "last LONG System-1 breakout
//  only" here, since short breakouts are never tracked at all. Not the
//  full multi-directional book system, a deliberate long-only subset of it.
//
//  Real design choice, genuinely different from the other 3 models: this
//  file DOES real, new computation (a full walk-forward breakout/exit/
//  pyramid simulation over the chart's own available history) rather than
//  just labeling already-computed engine fields — because the book's own
//  core rules (skip-if-last-winner, asymmetric exit channels, pyramid
//  ladder/stop convergence) genuinely don't exist anywhere in this engine
//  yet (confirmed via BIG_PLAN_TURTLE.md's own Deliverable 1 audit).
//  Reuses, rather than re-derives, wherever a real shared primitive
//  already exists: `ind.turtleN` (the CURRENT N reused for the live
//  sizing/stop read), `wilderArray`/`wilderSmooth` (the SAME global
//  helper functions the engine's own turtleN already calls — this file
//  reuses them again to get N's full historical SERIES, needed for the
//  walk-forward, not a re-derivation of a different formula),
//  `computeNNormalizedPositionSizeV1_` (v9.78, the engine's own existing
//  Unit-sizing function, called directly, not reimplemented), and
//  `ind.relativeStrengthRanking` (v9.85, already ported — cited, not
//  re-derived).
//
//  Real, disclosed scope limit: `chart.closes/highs/lows` is capped at
//  ~2 years (fetchYahooChart's own existing cap, same standing limitation
//  as every other feature in this project that reads chart history) — the
//  walk-forward below only sees that window, not a ticker's full listing
//  history. A "no prior breakout seen in this window" state is real and
//  disclosed, not hidden as if it were "no breakout ever."
//
//  Same Apps Script project, shared global scope as fullStockAnalysisV9_*.gs
//  and the other 3 models (this file's own functions are never called from
//  those files in this phase — wiring happens in a future comparison-report
//  phase, not here, per BIG_PLAN_TURTLE.md's own Deliverable 1/2 ordering).
// ══════════════════════════════════════════════════════════════════════

// ── Real, book-cited constants — every number here traces to a direct
//    quote in the raw PDF (see file header), none invented/fit to a
//    backtest. ──────────────────────────────────────────────────────────
const TURTLE_S1_WINDOW_V1 = 20;   // System 1 entry: new 20-day high (p689)
const TURTLE_S2_WINDOW_V1 = 55;   // System 2 entry: new 55-day high, always taken, real "Failsafe Breakout" (p691)
const TURTLE_S1_EXIT_WINDOW_V1 = 10; // System 1 exit: opposite-direction 10-day breakout (p699/931)
const TURTLE_S2_EXIT_WINDOW_V1 = 20; // System 2 exit: opposite-direction 20-day breakout (p699/934)
const TURTLE_STOP_N_V1 = 2;       // Initial stop = entry - 2N, real "2% max risk since 1N=1%" rule (p693-694)
const TURTLE_PYRAMID_STEP_N_V1 = 0.5; // Add one Unit every 0.5N of favorable movement (p691-692)
const TURTLE_MAX_UNITS_V1 = 4;    // Real, disclosed max Units in a single market (p690-692)
const TURTLE_WHIPSAW_STOP_N_V1 = 0.5; // Alternate "Whipsaw" stop: 0.5N for 0.5% risk (p694-695)

// ── Core walk-forward simulator ─────────────────────────────────────────
// Single source of truth for both the LIVE "where are we today" read and
// the historical last-S1-outcome the skip-if-winner filter needs. Long
// only (see file header). Entries/exits/adds all assumed filled AT the
// real theoretical trigger price (the channel level itself), matching the
// book's own worked numerical examples (e.g. p693's "55-day breakout =
// 28.30" used directly as Entry Price, not the day's actual high/low) —
// a real, disclosed no-slippage simplification, same class of assumption
// every stop/target function in this project already makes. Breakout/exit
// TOUCH tests use highs/lows (intrabar-touch proxy, EOD-bar approximation
// of the book's own real intraday "single tick" trigger — same
// highs/lows-based convention this engine's own existing Donchian(20)
// channel bounds already use, not closes).
function turtleRollHighV1_(arr, i, w) { return (i >= w) ? Math.max.apply(null, arr.slice(i - w, i)) : null; }
function turtleRollLowV1_(arr, i, w) { return (i >= w) ? Math.min.apply(null, arr.slice(i - w, i)) : null; }

// Shadow-simulates a SKIPPED System-1 signal's own real outcome, so the
// NEXT real S1 signal's skip-filter has a correct lastS1Outcome to check
// against — the book's own explicit rule: "the last breakout was
// considered the last breakout... irrespective of whether... actually
// taken, or was skipped because of this rule" (p690). Uses the exact same
// stop/exit rules as a real position, just never opens one. Real,
// disclosed limit: if neither the stop nor the exit resolves within the
// remaining chart window, the outcome is genuinely unknown (returns null)
// — not silently defaulted either way.
function turtleShadowS1OutcomeV1_(highs, lows, closes, entryIdx, entryPrice, n) {
  const stop = entryPrice - TURTLE_STOP_N_V1 * n;
  for (let j = entryIdx + 1; j < closes.length; j++) {
    if (lows[j] <= stop) return 'loser';
    if (j >= TURTLE_S1_EXIT_WINDOW_V1) {
      const l10 = turtleRollLowV1_(lows, j, TURTLE_S1_EXIT_WINDOW_V1);
      // Strict '<': a real breakdown means a NEW low, strictly beyond the
      // prior 10-day window — not merely equaling it. Real bug found via
      // this file's own test (a perfectly flat mock series was falsely
      // "exiting" every single day under a non-strict '<=', since a flat
      // series trivially ties its own rolling window every day).
      if (l10 != null && lows[j] < l10) return 'winner';
    }
  }
  return null; // unresolved within the available chart window
}

// ── Deliverable 2 port, 2026-09-05: real N-based pyramid/stop-convergence
// ladder for a KNOWN real entry (from analyzePositionV7/the Transactions
// sheet), independent of whether that entry happened to be a genuine
// Turtle channel breakout — the book's own 0.5N-add/2N-stop mechanics are
// general position-management, not conditional on how the position was
// opened. Same "2nd opinion, real entry" framing as this engine's own
// existing `computeClassicalStopTrailingV1_` (Schabacker) and
// `computeNNormalizedPositionSizeV1_` (Turtle's own sizing 2nd opinion,
// v9.78) — genuinely NOT redundant with either (see docs/BIG_PLAN_TURTLE.md
// Deliverable 2 audit): this is the position-MANAGEMENT ladder (adds +
// stop convergence over time), not a stop philosophy or a one-time sizing
// number. Long-only (this user's own standing strategy).
function turtlePyramidLadderForRealEntryV1_(chart, entryIdx, entryPrice) {
  const highs = chart && chart.highs, lows = chart && chart.lows, closes = chart && chart.closes;
  const n = (closes || []).length;
  if (entryIdx == null || entryIdx < 0 || entryIdx >= n || !Number.isFinite(entryPrice) || !(entryPrice > 0)) {
    return { available: false, note: 'Invalid entry index/price for this chart.' };
  }
  // Real N series -- same reuse as turtleSimulateV1_ above (wilderArray,
  // the same global helper ind.turtleN itself already calls).
  const trArr = [];
  for (let i = 1; i < n; i++) trArr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  const nSeries = wilderArray(trArr, 20);
  const nAt = (i) => (i >= 20 && (i-20) < nSeries.length) ? nSeries[i-20] : null;
  const N = nAt(entryIdx);
  if (N == null || !(N > 0)) return { available: false, note: 'N unavailable at the entry date (insufficient real price history before entry).' };

  const units = [{ idx: entryIdx, price: entryPrice }];
  let stop = entryPrice - TURTLE_STOP_N_V1 * N;
  let stoppedOutIdx = null;
  for (let i = entryIdx + 1; i < n; i++) {
    if (lows[i] <= stop) { stoppedOutIdx = i; break; } // real stop-order convention: fills at-or-through, same as turtleSimulateV1_'s own stopHit check
    if (units.length < TURTLE_MAX_UNITS_V1) {
      const lastUnit = units[units.length - 1];
      const addTrigger = lastUnit.price + TURTLE_PYRAMID_STEP_N_V1 * N;
      if (highs[i] >= addTrigger) { units.push({ idx: i, price: addTrigger }); stop = addTrigger - TURTLE_STOP_N_V1 * N; }
    }
  }
  return {
    available: true, n: N, units: units.length, unitFills: units, stop,
    stoppedOut: stoppedOutIdx != null, stoppedOutIdx,
    nextAddTrigger: (stoppedOutIdx == null && units.length < TURTLE_MAX_UNITS_V1) ? units[units.length - 1].price + TURTLE_PYRAMID_STEP_N_V1 * N : null
  };
}

const TURTLE_CLOSELY_CORRELATED_CAP_V1 = 6;  // real book cap, p690 -- NOT used below, see note
const TURTLE_LOOSELY_CORRELATED_CAP_V1 = 10; // real book cap, p690 -- the tier actually applied per category (see note)
const TURTLE_TOTAL_DIRECTION_CAP_V1 = 12;    // real book cap, p690 (this strategy is long-only, so "one direction" = the whole real portfolio)

// ── Deliverable 2 port, 2026-09-05: real correlated-market exposure caps
// (stock analog). Genuinely different dimension from this engine's
// existing Ch31 diversification ceiling (computePortfolioBullPhaseAdvisoryV1_,
// v9.91) — that one is a flat "max 10 distinct stocks" COUNT with no
// grouping; this is a Unit-WEIGHTED count within real correlated GROUPS
// (see docs/BIG_PLAN_TURTLE.md Deliverable 2 audit). Deliberately a PURE
// function — no cross-file lookups of its own (no `getCachedRelativeStrengthRankingV1_`,
// no `computeNNormalizedPositionSizeV1_` calls here) — the ENGINE already
// has both in the same file and resolves them once per held ticker before
// calling this; this function only transforms already-resolved data, same
// "reuse, don't re-derive" discipline as this file's own
// `turtleRelativeStrengthV1_` read.
//
// `holdings`: [{ ticker, categories: string[], units: number|null }] --
// `units` = real shares held ÷ that ticker's own Unit size via the
// engine's existing `computeNNormalizedPositionSizeV1_` (v9.78) — a real,
// disclosed PROXY for "how many Turtle Units does this actual position
// represent," not a literal historical Unit count (this project doesn't
// track WHEN/AT-WHAT-N each real share was bought, only what's held now).
function turtleCorrelatedCapsV1_(holdings) {
  const categoryTotals = {};
  let totalUnits = 0;
  const perTicker = [];
  (holdings || []).forEach(h => {
    if (h.units == null || !(h.units > 0)) {
      perTicker.push({ ticker: h.ticker, units: null, categories: h.categories || [], note: 'insufficient data for a real Unit count' });
      return;
    }
    totalUnits += h.units;
    (h.categories || []).forEach(cat => { categoryTotals[cat] = (categoryTotals[cat] || 0) + h.units; });
    perTicker.push({ ticker: h.ticker, units: h.units, categories: h.categories || [] });
  });
  const categoryFlags = Object.keys(categoryTotals).map(cat => ({
    category: cat, units: categoryTotals[cat],
    // Real, disclosed simplification: this project's 14 dark-pool
    // categories are broad sector groupings, not verified as "closely"
    // correlated pairs (the book's own real example: crude oil + heating
    // oil) — using the LOOSER 10-Unit tier per category is the more
    // honest match; the tighter 6-Unit "closely correlated" tier
    // (TURTLE_CLOSELY_CORRELATED_CAP_V1, defined but deliberately not
    // applied here) would overstate the real risk of a merely-same-sector
    // group.
    flagged: categoryTotals[cat] > TURTLE_LOOSELY_CORRELATED_CAP_V1
  })).filter(c => c.units > 0);
  return {
    perTicker, categoryFlags, totalUnits,
    totalFlagged: totalUnits > TURTLE_TOTAL_DIRECTION_CAP_V1,
    note: 'Appendix E, p690 — real 4/6/10/12-Unit correlated-exposure caps. Per-category cap uses the LOOSER 10-Unit "loosely correlated" tier (disclosed simplification above); total portfolio directional cap uses the book\'s own literal 12-Unit figure directly. Unit count per ticker is a real, disclosed proxy (see this function\'s own header), not a literal historical Unit count.'
  };
}

function turtleSimulateV1_(chart) {
  const highs = chart.highs, lows = chart.lows, closes = chart.closes;
  const n = (closes || []).length;
  const START = TURTLE_S2_WINDOW_V1; // first index where the widest (55d) channel + N are both defined
  if (n < START + 1) {
    return { available: false, note: 'Needs at least ' + (START + 1) + ' bars of history (55-day channel + 1) — insufficient for this ticker.' };
  }

  // Real N series — SAME formula/global helpers the engine's own
  // ind.turtleN already uses (v9.78: trArr + wilderSmooth(trArr,20)).
  // Kept as a full series here (wilderArray) because the walk-forward
  // needs N's real historical value at each PAST entry, not just today's
  // scalar (ind.turtleN) — same primitive, not a re-derivation.
  const trArr = [];
  for (let i = 1; i < n; i++) trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const nSeries = wilderArray(trArr, 20);
  const nAt = (i) => (i >= 20 && (i - 20) < nSeries.length) ? nSeries[i - 20] : null;

  let lastS1Outcome = null; // null = no prior LONG S1 breakout resolved yet in this window
  let pos = null;           // {system, entryIdx, entryPrice, n, units:[{idx,price}], stop}
  const trail = [];

  for (let i = START; i < n; i++) {
    const N = nAt(i);
    if (N == null || !(N > 0)) continue;
    const h20 = turtleRollHighV1_(highs, i, TURTLE_S1_WINDOW_V1);
    const h55 = turtleRollHighV1_(highs, i, TURTLE_S2_WINDOW_V1);
    const l10 = turtleRollLowV1_(lows, i, TURTLE_S1_EXIT_WINDOW_V1);
    const l20 = turtleRollLowV1_(lows, i, TURTLE_S2_EXIT_WINDOW_V1);

    if (pos) {
      // Stops are non-negotiable — checked before a pyramid add (p716-717).
      const stopHit = lows[i] <= pos.stop;
      const exitLevel = pos.system === 'S1' ? l10 : l20;
      // Strict '<': same real fix as turtleShadowS1OutcomeV1_ above — a
      // channel exit means a NEW low, strictly beyond the prior window.
      const channelExit = exitLevel != null && lows[i] < exitLevel;
      if (stopHit || channelExit) {
        // Real, literal book test (p690): a breakout is a LOSER only if
        // price moved 2N against it BEFORE a (channel) exit occurred —
        // otherwise a winner, regardless of the exit's own P&L sign.
        const outcome = stopHit ? 'loser' : 'winner';
        const exitPrice = stopHit ? pos.stop : exitLevel;
        if (pos.system === 'S1') lastS1Outcome = outcome;
        trail.push({ system: pos.system, entryIdx: pos.entryIdx, entryPrice: pos.entryPrice, exitIdx: i, exitPrice, units: pos.units.length, outcome });
        pos = null;
      } else if (pos.units.length < TURTLE_MAX_UNITS_V1) {
        // Pyramid add: every 0.5N of favorable movement from the actual
        // fill price of the previous Unit (p691-692), stop then raised so
        // the whole position converges to 2N below the MOST RECENT Unit.
        const lastUnit = pos.units[pos.units.length - 1];
        const addTrigger = lastUnit.price + TURTLE_PYRAMID_STEP_N_V1 * pos.n;
        if (highs[i] >= addTrigger) {
          pos.units.push({ idx: i, price: addTrigger });
          pos.stop = addTrigger - TURTLE_STOP_N_V1 * pos.n;
        }
      }
    }

    if (!pos) {
      // Strict '>': same real fix as the channel-exit check above — a new
      // high means strictly beyond the prior window, not merely tying it.
      const s2Signal = h55 != null && highs[i] > h55;
      const s1Signal = h20 != null && highs[i] > h20;
      if (s2Signal) {
        // System 2: "all breakouts... taken whether the previous breakout
        // had been a winner or not" (p626) — also the real Failsafe when
        // S1 was itself skipped (p690).
        pos = { system: 'S2', entryIdx: i, entryPrice: h55, n: N, units: [{ idx: i, price: h55 }], stop: h55 - TURTLE_STOP_N_V1 * N };
      } else if (s1Signal) {
        if (lastS1Outcome === 'winner') {
          // Skipped per the whipsaw filter — still counts as "the last
          // breakout" (p690), so shadow-simulate its own real outcome.
          lastS1Outcome = turtleShadowS1OutcomeV1_(highs, lows, closes, i, h20, N);
        } else {
          pos = { system: 'S1', entryIdx: i, entryPrice: h20, n: N, units: [{ idx: i, price: h20 }], stop: h20 - TURTLE_STOP_N_V1 * N };
        }
      }
    }
  }

  const today = n - 1;
  const live = pos ? {
    inPosition: true,
    system: pos.system,
    entryIdx: pos.entryIdx, entryPrice: pos.entryPrice,
    units: pos.units.length,
    stop: pos.stop,
    enteredToday: pos.entryIdx === today,
    addedToday: pos.units.length > 1 && pos.units[pos.units.length - 1].idx === today,
    exitChannelLevel: pos.system === 'S1' ? turtleRollLowV1_(lows, today, TURTLE_S1_EXIT_WINDOW_V1) : turtleRollLowV1_(lows, today, TURTLE_S2_EXIT_WINDOW_V1),
    nextAddTrigger: pos.units.length < TURTLE_MAX_UNITS_V1 ? pos.units[pos.units.length - 1].price + TURTLE_PYRAMID_STEP_N_V1 * pos.n : null
  } : {
    inPosition: false,
    s1Trigger: turtleRollHighV1_(highs, today, TURTLE_S1_WINDOW_V1),
    s2Trigger: turtleRollHighV1_(highs, today, TURTLE_S2_WINDOW_V1),
    s1Skipped: lastS1Outcome === 'winner'
  };
  const exitedToday = trail.length > 0 && trail[trail.length - 1].exitIdx === today;

  return {
    available: true,
    n: nAt(today),
    live, exitedToday,
    lastS1Outcome,
    trail, recentTrades: trail.slice(-5),
    wins: trail.filter(t => t.outcome === 'winner').length,
    losses: trail.filter(t => t.outcome === 'loser').length,
    dates: chart.dates
  };
}

// ── Sizing/stop read — reuses techPlan.nNormalizedPositionSize verbatim
//    (v9.78, computeNNormalizedPositionSizeV1_(entryPrice, ind.turtleN)),
//    the engine's OWN existing Unit-sizing function, not reimplemented.
//    Real, disclosed scope: this is the FIRST Unit's size at TODAY's
//    price only — a live pyramid's later Units each size against their
//    own fill price/N at add time, same convention techPlan already uses
//    elsewhere (a live "as of today" read, not a full backtest ledger). ──
function turtleSizingV1_(techPlan, sim) {
  const nps = techPlan && techPlan.nNormalizedPositionSize;
  if (!nps) return { available: false, note: 'N-normalized position size unavailable for this ticker.' };
  return {
    available: true,
    shares: nps.shares, stopLevel: nps.stopLevel, dollarRisk: nps.dollarRisk, riskPctOfAccount: nps.riskPctOfAccount, n: nps.n,
    unitsOpen: sim && sim.available && sim.live.inPosition ? sim.live.units : 0,
    maxUnits: TURTLE_MAX_UNITS_V1,
    note: 'p687-692 — real Unit = (Account × 1%) ÷ (N × $/point); initial stop = entry − 2N (2% max risk); one new Unit every 0.5N favorable, up to ' + TURTLE_MAX_UNITS_V1 + ', earlier stops raised to converge at 2N below the most-recent Unit.'
  };
}

// ── Whipsaw variant — reported as a labeled ALTERNATIVE, never blended
//    with the primary 2N read (per BIG_PLAN_TURTLE.md item 4). Real,
//    disclosed tradeoff quoted directly from the book (p815-825): better
//    total profitability historically, but more/smaller losing trades,
//    harder to sit through psychologically. ─────────────────────────────
function turtleWhipsawV1_(sim, techPlan) {
  if (!sim || !sim.available || !sim.live.inPosition) {
    return { available: false, note: 'No open position to compute a Whipsaw-equivalent stop for.' };
  }
  const nps = techPlan && techPlan.nNormalizedPositionSize;
  const n = nps ? nps.n : sim.n;
  if (n == null) return { available: false, note: 'N unavailable.' };
  return {
    available: true,
    stop: sim.live.entryPrice - TURTLE_WHIPSAW_STOP_N_V1 * n,
    note: 'p814-825 — real, disclosed alternate: 0.5N stop (0.5% risk) instead of 2N/2%, with an explicit re-entry rule if stopped out and price later reclaims the original entry price. "A few Turtles traded this method with good success" (book\'s own words) — better historical profitability, but a lower win/loss ratio, harder to execute. Shown as a labeled alternative only, never blended into the primary 2N stop above.'
  };
}

// ── Relative-strength cross-reference — ALREADY ported (v9.85,
//    darkPoolTrackerV1.gs, ind.relativeStrengthRanking). Cites the
//    existing field, does not re-derive it — same "label, don't
//    re-detect" discipline as every other model's relationship to
//    already-ported signals. ─────────────────────────────────────────────
function turtleRelativeStrengthV1_(ind) {
  const rsr = ind && ind.relativeStrengthRanking;
  if (!rsr) return { available: false, note: 'Relative Strength Ranking unavailable (ticker not in any of the 14 real correlated-group categories, or trigger cache stale/missing — see refreshRelativeStrengthRankingV1_, darkPoolTrackerV1.gs).' };
  return {
    available: true,
    categories: rsr.categories, rank: rsr.rank, peerCount: rsr.peerCount, percentile: rsr.percentile, read: rsr.read,
    note: 'p698-699 — real, disclosed rule: within a correlated group, buy the STRONGEST, short the WEAKEST. Long-only adaptation: relative weakness is a caution only, never a short recommendation (this user\'s own long-only/calls-only strategy). Real formula (CurrentPrice−PriceNMonthsAgo)/CurrentN, already wired — this section cross-references it, does not recompute it.'
  };
}

function turtleDisciplineNoteV1_() {
  return {
    quote: 'I always say that you could publish my trading rules in the newspaper and no one would follow them. The key is consistency and discipline. Almost anybody can make up a list of rules that are 80% as good as what we taught our people. What they couldn\'t do is give them the confidence to stick to those rules even when things are going bad.',
    attribution: 'Richard Dennis, quoted in Market Wizards by Jack D. Schwager (p1081-1086)',
    note: 'The book\'s own real, disclosed finding: most Turtles who failed did NOT fail because the rules didn\'t work — they failed because they could not consistently follow them, especially the counterintuitive parts (adding to positions quickly, holding through open-profit giveback while waiting for the slower exit). Same "don\'t over-promise certainty" framing this project already uses elsewhere.'
  };
}

// ── Explicit, disclosed exclusions (matches this project's own
//    "excluded methods" discipline) ─────────────────────────────────────
function turtleExclusionsV1_() {
  return [
    { item: 'Short-side entries, short-side pyramiding, short-side stops', reason: 'This user\'s own standing trading strategy is long-only/calls-only (memory `trading-strategy-long-only-calls`) — this model reads and reports LONG signals only.' },
    { item: '4-tier correlated-market exposure caps (max 4/6/10/12 Units, p690)', reason: 'Futures-specific cross-COMMODITY concept (e.g. crude oil + heating oil as "closely correlated"). A stock-analog candidate exists (this engine\'s own Ch31 "8-10 stocks max" diversification ceiling, computePortfolioBullPhaseAdvisoryV1_, v9.91) — real port-audit question, deferred to Deliverable 2 per BIG_PLAN_TURTLE.md, not decided here.' },
    { item: 'Contract-rollover rules, notional/non-cash account sizing, the real futures market list (T-Bonds, Coffee/Cocoa/Sugar/Cotton, FX majors, etc.)', reason: 'Genuinely out of scope — this engine is stocks/ETFs only, no futures-contract infrastructure.' },
    { item: 'Raw N-adjusted-distance-since-breakout RS method (the book\'s own 2nd, cruder alternative)', reason: 'The book\'s own more precise method, (CurrentPrice−PriceNMonthsAgo)/CurrentN, is already ported and cited above — using both would be redundant, not complementary.' }
  ];
}

// ── Top-level builder ───────────────────────────────────────────────────
// Same signature convention as the other 3 models. Accepts already-fetched
// `chart` (needs real highs/lows/closes arrays, unlike the other 3 models
// which only read already-computed ind/techPlan fields) — no independent
// fetch of its own. Wrapped in try/catch, same disclosed-degradation
// convention as this project's other report builders.
function buildTurtleReportV1(ticker, ind, gann, confluence, techPlan, chart, log) {
  try {
    const sim = turtleSimulateV1_(chart || {});
    const sizing = turtleSizingV1_(techPlan || {}, sim);
    const whipsaw = turtleWhipsawV1_(sim, techPlan || {});
    const relativeStrength = turtleRelativeStrengthV1_(ind || {});
    const discipline = turtleDisciplineNoteV1_();
    const exclusions = turtleExclusionsV1_();

    // ── Final synthesis — qualitative, no fabricated score. Required
    // shape for comparison-report interop, same convention as the other
    // 3 models: { netRead, bullish, cautionary }.
    const bullish = [], cautionary = [];
    if (sim.available) {
      if (sim.live.inPosition) {
        if (sim.live.enteredToday) bullish.push('Turtle ' + sim.live.system + ' breakout entry triggered TODAY (Appendix E)');
        else bullish.push('Currently in a real Turtle ' + sim.live.system + ' long position (' + sim.live.units + ' Unit' + (sim.live.units > 1 ? 's' : '') + ' open)');
        if (sim.live.addedToday) bullish.push('Pyramid add triggered TODAY — favorable 0.5N move (Appendix E)');
      } else {
        if (sim.exitedToday) cautionary.push('Turtle position exited TODAY (stop or opposite-channel breakdown, Appendix E)');
        if (sim.live.s1Skipped) cautionary.push('Next System-1 signal will be SKIPPED (last one was a winner) unless System-2 (55-day) also clears — Appendix E whipsaw filter');
      }
    }
    if (relativeStrength.available) {
      if (relativeStrength.read && relativeStrength.read.indexOf('STRONG') === 0) bullish.push('Relative Strength Ranking: #' + relativeStrength.rank + '/' + relativeStrength.peerCount + ' in ' + relativeStrength.categories.join('/') + ' — among the strongest in its real peer group (Appendix E)');
      else if (relativeStrength.read && relativeStrength.read.indexOf('WEAK') === 0) cautionary.push('Relative Strength Ranking: #' + relativeStrength.rank + '/' + relativeStrength.peerCount + ' in ' + relativeStrength.categories.join('/') + ' — among the weakest in its real peer group, a caution not a short signal (Appendix E)');
    }

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
      : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker,
      sim, sizing, whipsaw, relativeStrength, discipline, exclusions,
      synthesis: { bullish, cautionary, netRead }
    };
  } catch (e) {
    if (log) log('Turtle model: report build failed for ' + ticker + ' — ' + (e && e.message ? e.message : e));
    return null;
  }
}

// Small local date formatter — avoids depending on Apps Script's real
// 3-arg Utilities.formatDate signature (chart.dates entries are real Date
// objects, e.g. dates: dates.slice(...) in fetchYahooChart); works
// identically in real GAS and in this project's own Node test sandbox.
function turtleDateStrV1_(dates, idx) {
  const d = dates && dates[idx];
  if (!d) return 'n/a';
  return (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d);
}

// ── Plain-text formatter — mirrors the other 3 models' own convention:
//    one section per category, real gaps shown inline. ──────────────────
function formatTurtleReportV1(report) {
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
  push('── ' + report.ticker + ' — Original Turtle Trading System Model v1 (Appendix E) ──');
  push('');
  push('1. DUAL-SYSTEM BREAKOUT READ (S1: 20-day / S2: 55-day)');
  if (!report.sim.available) {
    push('  ' + report.sim.note);
  } else if (report.sim.live.inPosition) {
    const l = report.sim.live;
    push('  IN POSITION — System ' + l.system + ', entered ' + turtleDateStrV1_(report.sim.dates, l.entryIdx) + ' @ $' + l.entryPrice.toFixed(2) + (l.enteredToday ? ' (TODAY)' : ''));
    push('  Units: ' + l.units + '/4' + (l.addedToday ? ' (added TODAY)' : '') + '. Stop: $' + l.stop.toFixed(2) + '. Exit channel (opposite-direction breakdown): $' + (l.exitChannelLevel != null ? l.exitChannelLevel.toFixed(2) : 'n/a'));
    if (l.nextAddTrigger != null) push('  Next pyramid add triggers at: $' + l.nextAddTrigger.toFixed(2));
  } else {
    const l = report.sim.live;
    push('  FLAT. S1 (20d) entry trigger: $' + (l.s1Trigger != null ? l.s1Trigger.toFixed(2) : 'n/a') + (l.s1Skipped ? ' — WOULD BE SKIPPED (last S1 was a winner) unless S2 also clears' : '') + '. S2 (55d) failsafe entry trigger: $' + (l.s2Trigger != null ? l.s2Trigger.toFixed(2) : 'n/a'));
    if (report.sim.exitedToday) push('  Exited a position TODAY.');
  }
  if (report.sim.available) {
    push('  Real trade history in this ~2yr window: ' + report.sim.trail.length + ' closed (' + report.sim.wins + 'W/' + report.sim.losses + 'L) — descriptive only, not a predictive-value backtest.');
    report.sim.recentTrades.forEach(t => push('    - ' + t.system + ': ' + turtleDateStrV1_(report.sim.dates, t.entryIdx) + ' @ $' + t.entryPrice.toFixed(2) + ' -> ' + turtleDateStrV1_(report.sim.dates, t.exitIdx) + ' @ $' + t.exitPrice.toFixed(2) + ' (' + t.units + 'u, ' + t.outcome + ')'));
  }
  push('');
  push('2. N-BASED UNIT SIZING + 2N STOP + PYRAMID LADDER (p687-692)');
  if (report.sizing.available) {
    push('  Unit (today, 1st Unit): ' + report.sizing.shares + ' shares, N=' + report.sizing.n.toFixed(2) + ', stop $' + report.sizing.stopLevel.toFixed(2) + ', risk $' + report.sizing.dollarRisk.toFixed(0) + ' (' + report.sizing.riskPctOfAccount.toFixed(1) + '% of account). Open Units: ' + report.sizing.unitsOpen + '/' + report.sizing.maxUnits + '.');
  } else push('  ' + report.sizing.note);
  push('');
  push('3. WHIPSAW VARIANT — LABELED ALTERNATIVE, NOT BLENDED (p814-825)');
  if (report.whipsaw.available) push('  Whipsaw-equivalent stop: $' + report.whipsaw.stop.toFixed(2));
  push('  ' + report.whipsaw.note);
  push('');
  push('4. RELATIVE STRENGTH CROSS-REFERENCE (p698-699)');
  if (report.relativeStrength.available) {
    const rs = report.relativeStrength;
    push('  #' + rs.rank + '/' + rs.peerCount + ' in ' + rs.categories.join('/') + ' (percentile ' + rs.percentile + ') — ' + rs.read);
  } else push('  ' + report.relativeStrength.note);
  push('  ' + report.relativeStrength.note || '');
  push('');
  push('5. DISCIPLINE (p1081-1086)');
  push('  "' + report.discipline.quote + '" — ' + report.discipline.attribution);
  push('');
  push('6. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach(e => push('  - ' + e.item + ': ' + e.reason));
  push('');
  push('7. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach(b => push('  [+] ' + b));
  report.synthesis.cautionary.forEach(c => push('  [-] ' + c));

  return lines.join('\n');
}
