/**
 * The Turtle model report (turtleModelV1.gs, 14 functions + 11 constants).
 *
 * Unlike the Edwards & Magee and Schabacker models -- which only relabel
 * things the engine already computed -- this file contains a real
 * WALK-FORWARD SIMULATOR. turtleSimulate replays the dual-channel system
 * bar by bar over the chart, so it is the first model file with genuine
 * arithmetic and real divergence risk.
 *
 * ══ CLOSURE ════════════════════════════════════════════════════════════
 * 25 members, 361 lines of the file's 526. Already ported in exitRead.ts:
 * turtlePyramidLadderForRealEntry (:132-163) and the three stop/pyramid
 * constants (:73-75) -- 35 lines. New here: 326 lines.
 *
 * True external identifiers, after stripping comments AND string contents:
 * `wilderArray` (the shared Wilder helper, already inlined in exitRead.ts)
 * and `nAt`/`apply` which are a local arrow and a builtin. Nothing else.
 *
 * ══ THREE NO-SLIPPAGE ASSUMPTIONS, ALL DISCLOSED IN THE SOURCE ═════════
 * These matter because they make the simulated trade history optimistic,
 * and the report says so ("descriptive only, not a predictive-value
 * backtest"):
 *  1. Every fill -- entry, add, stop, channel exit -- happens AT the
 *     theoretical trigger price, never the bar's actual high or low. This
 *     matches the book's own worked examples (p693 uses "55-day breakout =
 *     28.30" directly as the entry price).
 *  2. Breakout and exit TOUCH tests use highs/lows, an EOD-bar proxy for
 *     the book's real intraday single-tick trigger.
 *  3. No commissions, no gaps through stops.
 */

import type { Indicators } from '../../types/indicators.ts';
import { assumedAccountText, type ModelTextOptions } from './modelText.ts';

// ── Constants (:69-76, :165-167) ───────────────────────────────────────

/** System 1 entry: a new 20-day high (p689). */
export const TURTLE_S1_WINDOW = 20;
/** System 2 entry: a new 55-day high, always taken (p689). */
export const TURTLE_S2_WINDOW = 55;
/** System 1 exit: an opposite-direction 10-day breakdown. */
export const TURTLE_S1_EXIT_WINDOW = 10;
/** System 2 exit: an opposite-direction 20-day breakdown. */
export const TURTLE_S2_EXIT_WINDOW = 20;
/** Initial stop = entry - 2N, the "2% max risk since 1N=1%" rule (p693-694). */
export const TURTLE_STOP_N = 2;
/** Add one Unit per 0.5N of favourable movement (p691-692). */
export const TURTLE_PYRAMID_STEP_N = 0.5;
/** Max Units in a single market (p690-692). */
export const TURTLE_MAX_UNITS = 4;
/** The alternate "Whipsaw" stop: 0.5N for 0.5% risk (p814-825). */
export const TURTLE_WHIPSAW_STOP_N = 0.5;

/**
 * The book's "closely correlated" cap (p690).
 *
 * DEFINED BUT DELIBERATELY NOT APPLIED -- and that is documented in the
 * source, not an oversight like F-12's maxHeatPct. This project's 14
 * dark-pool categories are broad sector groupings, not verified
 * closely-correlated pairs (the book's example is crude oil + heating
 * oil), so applying the tighter 6-Unit tier would overstate the real risk
 * of a merely-same-sector group. The looser 10-Unit tier is used instead.
 */
export const TURTLE_CLOSELY_CORRELATED_CAP = 6;
/** The "loosely correlated" cap (p690) -- the tier actually applied per category. */
export const TURTLE_LOOSELY_CORRELATED_CAP = 10;
/** Total one-direction cap (p690). Long-only, so this is the whole portfolio. */
export const TURTLE_TOTAL_DIRECTION_CAP = 12;

// ── Rolling channel helpers (:91-92) ───────────────────────────────────

/**
 * Highest high over the w bars BEFORE index i. Exclusive of i itself.
 *
 * The exclusivity is the whole point: a breakout at bar i must clear the
 * channel formed by the bars before it, not a channel that already
 * includes today's own high. Returns null before enough history exists,
 * rather than a partial-window value.
 */
export function turtleRollHigh(arr: readonly number[], i: number, w: number): number | null {
  return i >= w ? Math.max.apply(null, arr.slice(i - w, i) as number[]) : null;
}

/** Lowest low over the w bars before index i. Exclusive of i. */
export function turtleRollLow(arr: readonly number[], i: number, w: number): number | null {
  return i >= w ? Math.min.apply(null, arr.slice(i - w, i) as number[]) : null;
}

/**
 * Wilder-smoothed series, the same primitive ind.turtleN uses.
 *
 * Kept as a full SERIES rather than today's scalar because the
 * walk-forward needs N's real historical value at each past entry. Using
 * today's N for a two-year-old entry would silently rewrite history.
 */
function wilderArray(values: readonly number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

export type TurtleOutcome = 'winner' | 'loser';

/**
 * Shadow-simulates a SKIPPED System-1 signal to learn its outcome.
 *
 * ══ WHY A SKIPPED SIGNAL STILL HAS TO BE SIMULATED ═════════════════════
 * The book is explicit (p690): "the last breakout was considered the last
 * breakout... irrespective of whether it was actually taken, or was
 * skipped because of this rule." So the whipsaw filter needs the outcome
 * of a trade that was never opened -- otherwise two consecutive winners
 * would both be skipped forever.
 *
 * Returns null when neither the stop nor the exit resolves inside the
 * remaining window: genuinely unknown, not defaulted either way. A default
 * would silently bias the next signal's filter.
 *
 * Note the strict `<` on the exit test. The source documents finding this
 * via its own test: under `<=`, a perfectly flat series "exits" every day
 * because it trivially ties its own rolling window. Same non-strict trap
 * as stops.ts, caught there by the legacy author.
 */
export function turtleShadowS1Outcome(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  entryIdx: number,
  entryPrice: number,
  n: number,
): TurtleOutcome | null {
  const stop = entryPrice - TURTLE_STOP_N * n;
  for (let j = entryIdx + 1; j < closes.length; j++) {
    if (lows[j] <= stop) return 'loser';
    if (j >= TURTLE_S1_EXIT_WINDOW) {
      const l10 = turtleRollLow(lows, j, TURTLE_S1_EXIT_WINDOW);
      if (l10 != null && lows[j] < l10) return 'winner';
    }
  }
  return null;
}

// ── Correlated exposure caps (:188-218) ────────────────────────────────

export interface CapHolding {
  readonly ticker: string;
  readonly categories?: readonly string[];
  readonly units: number | null;
}

export interface CorrelatedCaps {
  readonly perTicker: ReadonlyArray<{
    readonly ticker: string; readonly units: number | null;
    readonly categories: readonly string[]; readonly note?: string;
  }>;
  readonly categoryFlags: ReadonlyArray<{
    readonly category: string; readonly units: number; readonly flagged: boolean;
  }>;
  readonly totalUnits: number;
  readonly totalFlagged: boolean;
  readonly note: string;
}

/**
 * Unit-weighted exposure within correlated groups.
 *
 * Pure by design: the engine resolves each holding's category list and Unit
 * count before calling, so this only transforms already-resolved data.
 *
 * ══ ITS ONLY CALL SITE IS NOT THIS REPORT ══════════════════════════════
 * Measured across all ten legacy files: the sole caller is
 * fullStockAnalysisV10_9.gs:903, inside computePortfolioBullPhaseAdvisoryV1_
 * -- so this renders on the Portfolio Summary sheet, not the per-ticker
 * Turtle report. buildTurtleReportV1 never calls it. It is ported here
 * because it lives in this file, and it is wired up when the portfolio
 * advisory is ported.
 *
 * `units` is a disclosed PROXY -- shares held divided by today's Unit size
 * -- not a literal historical Unit count, because the project never
 * recorded at what N each share was bought.
 */
export function turtleCorrelatedCaps(holdings: readonly CapHolding[] | null | undefined): CorrelatedCaps {
  const categoryTotals: Record<string, number> = {};
  let totalUnits = 0;
  const perTicker: Array<{
    ticker: string; units: number | null; categories: readonly string[]; note?: string;
  }> = [];

  (holdings || []).forEach((h) => {
    if (h.units == null || !(h.units > 0)) {
      perTicker.push({
        ticker: h.ticker, units: null, categories: h.categories || [],
        note: 'insufficient data for a real Unit count',
      });
      return;
    }
    totalUnits += h.units;
    (h.categories || []).forEach((cat) => {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (h.units as number);
    });
    perTicker.push({ ticker: h.ticker, units: h.units, categories: h.categories || [] });
  });

  const categoryFlags = Object.keys(categoryTotals)
    .map((cat) => ({
      category: cat,
      units: categoryTotals[cat],
      // The LOOSER tier, deliberately -- see TURTLE_CLOSELY_CORRELATED_CAP.
      flagged: categoryTotals[cat] > TURTLE_LOOSELY_CORRELATED_CAP,
    }))
    .filter((c) => c.units > 0);

  return {
    perTicker, categoryFlags, totalUnits,
    totalFlagged: totalUnits > TURTLE_TOTAL_DIRECTION_CAP,
    note: 'Appendix E, p690 — real 4/6/10/12-Unit correlated-exposure caps. Per-category cap uses the LOOSER 10-Unit "loosely correlated" tier (disclosed simplification above); total portfolio directional cap uses the book\'s own literal 12-Unit figure directly. Unit count per ticker is a real, disclosed proxy (see this function\'s own header), not a literal historical Unit count.',
  };
}

// ── The walk-forward simulator (:220-330) ──────────────────────────────

export interface TurtleUnit {
  readonly idx: number;
  readonly price: number;
}

export interface TurtleTrade {
  readonly system: 'S1' | 'S2';
  readonly entryIdx: number;
  readonly entryPrice: number;
  readonly exitIdx: number;
  readonly exitPrice: number;
  readonly units: number;
  readonly outcome: TurtleOutcome;
}

export interface TurtleLiveInPosition {
  readonly inPosition: true;
  readonly system: 'S1' | 'S2';
  readonly entryIdx: number;
  readonly entryPrice: number;
  readonly units: number;
  readonly stop: number;
  readonly enteredToday: boolean;
  readonly addedToday: boolean;
  readonly exitChannelLevel: number | null;
  readonly nextAddTrigger: number | null;
}

export interface TurtleLiveFlat {
  readonly inPosition: false;
  readonly s1Trigger: number | null;
  readonly s2Trigger: number | null;
  readonly s1Skipped: boolean;
}

export type TurtleSimulation =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true;
    readonly n: number | null;
    readonly live: TurtleLiveInPosition | TurtleLiveFlat;
    readonly exitedToday: boolean;
    readonly lastS1Outcome: TurtleOutcome | null;
    readonly trail: readonly TurtleTrade[];
    readonly recentTrades: readonly TurtleTrade[];
    readonly wins: number;
    readonly losses: number;
    readonly dates: readonly Date[];
  };

export interface SimInput {
  readonly highs?: readonly number[];
  readonly lows?: readonly number[];
  readonly closes?: readonly number[];
  readonly dates?: readonly Date[];
}

/**
 * Replays the dual-channel Turtle system bar by bar.
 *
 * ══ THE ORDER OF CHECKS INSIDE EACH BAR IS THE CONTRACT ════════════════
 *   1. stop / channel exit   (p716-717: "stops are non-negotiable")
 *   2. pyramid add           -- only if neither fired
 *   3. new entry             -- only if flat after step 1
 *
 * A bar that would both stop out and trigger an add therefore STOPS OUT.
 * Reordering these would produce a more flattering history, which is
 * exactly why the source puts risk first.
 *
 * ══ WINNER/LOSER IS NOT P&L ════════════════════════════════════════════
 * A trade is a LOSER only if the 2N stop was hit before a channel exit.
 * Exit by channel is a WINNER regardless of whether it made money -- the
 * book's literal test (p690). So `wins`/`losses` count how the trade ENDED,
 * not whether it profited, and the report must never present them as a
 * win rate on returns.
 *
 * ══ S2 PRE-EMPTS S1 ════════════════════════════════════════════════════
 * A 55-day breakout is always taken (p626) and also acts as the failsafe
 * when S1 was skipped (p690). Since a new 55-day high is necessarily also
 * a new 20-day high, the `else if` means S2 always wins that tie -- and
 * the S1 skip-filter is never even consulted on such a bar.
 *
 * Starts at index 55 so the widest channel and N are both defined; returns
 * `available: false` with a reason below that, never a partial read.
 */
export function turtleSimulate(chart: SimInput): TurtleSimulation {
  const highs = (chart.highs || []) as readonly number[];
  const lows = (chart.lows || []) as readonly number[];
  const closes = (chart.closes || []) as readonly number[];
  const n = closes.length;
  const START = TURTLE_S2_WINDOW;
  if (n < START + 1) {
    return {
      available: false,
      note: 'Needs at least ' + (START + 1) + ' bars of history (55-day channel + 1) — insufficient for this ticker.',
    };
  }

  const trArr: number[] = [];
  for (let i = 1; i < n; i++) {
    trArr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  const nSeries = wilderArray(trArr, 20);
  const nAt = (i: number): number | null =>
    i >= 20 && i - 20 < nSeries.length ? nSeries[i - 20] : null;

  let lastS1Outcome: TurtleOutcome | null = null;
  let pos: {
    system: 'S1' | 'S2'; entryIdx: number; entryPrice: number; n: number;
    units: TurtleUnit[]; stop: number;
  } | null = null;
  const trail: TurtleTrade[] = [];

  for (let i = START; i < n; i++) {
    const N = nAt(i);
    if (N == null || !(N > 0)) continue;
    const h20 = turtleRollHigh(highs, i, TURTLE_S1_WINDOW);
    const h55 = turtleRollHigh(highs, i, TURTLE_S2_WINDOW);
    const l10 = turtleRollLow(lows, i, TURTLE_S1_EXIT_WINDOW);
    const l20 = turtleRollLow(lows, i, TURTLE_S2_EXIT_WINDOW);

    if (pos) {
      const stopHit = lows[i] <= pos.stop;
      const exitLevel = pos.system === 'S1' ? l10 : l20;
      // Strict '<' -- a flat series ties its own window every day.
      const channelExit = exitLevel != null && lows[i] < exitLevel;
      if (stopHit || channelExit) {
        const outcome: TurtleOutcome = stopHit ? 'loser' : 'winner';
        const exitPrice = stopHit ? pos.stop : (exitLevel as number);
        if (pos.system === 'S1') lastS1Outcome = outcome;
        trail.push({
          system: pos.system, entryIdx: pos.entryIdx, entryPrice: pos.entryPrice,
          exitIdx: i, exitPrice, units: pos.units.length, outcome,
        });
        pos = null;
      } else if (pos.units.length < TURTLE_MAX_UNITS) {
        // Add measured from the previous Unit's FILL price, not from entry,
        // so the ladder compounds. Stop then converges to 2N below the
        // newest Unit, tightening the whole position.
        const lastUnit = pos.units[pos.units.length - 1];
        const addTrigger = lastUnit.price + TURTLE_PYRAMID_STEP_N * pos.n;
        if (highs[i] >= addTrigger) {
          pos.units.push({ idx: i, price: addTrigger });
          pos.stop = addTrigger - TURTLE_STOP_N * pos.n;
        }
      }
    }

    if (!pos) {
      // Strict '>' for the same reason as the exit test.
      const s2Signal = h55 != null && highs[i] > h55;
      const s1Signal = h20 != null && highs[i] > h20;
      if (s2Signal) {
        pos = {
          system: 'S2', entryIdx: i, entryPrice: h55 as number, n: N,
          units: [{ idx: i, price: h55 as number }],
          stop: (h55 as number) - TURTLE_STOP_N * N,
        };
      } else if (s1Signal) {
        if (lastS1Outcome === 'winner') {
          lastS1Outcome = turtleShadowS1Outcome(highs, lows, closes, i, h20 as number, N);
        } else {
          pos = {
            system: 'S1', entryIdx: i, entryPrice: h20 as number, n: N,
            units: [{ idx: i, price: h20 as number }],
            stop: (h20 as number) - TURTLE_STOP_N * N,
          };
        }
      }
    }
  }

  const today = n - 1;
  const live: TurtleLiveInPosition | TurtleLiveFlat = pos
    ? {
      inPosition: true,
      system: pos.system,
      entryIdx: pos.entryIdx,
      entryPrice: pos.entryPrice,
      units: pos.units.length,
      stop: pos.stop,
      enteredToday: pos.entryIdx === today,
      addedToday: pos.units.length > 1 && pos.units[pos.units.length - 1].idx === today,
      exitChannelLevel: pos.system === 'S1'
        ? turtleRollLow(lows, today, TURTLE_S1_EXIT_WINDOW)
        : turtleRollLow(lows, today, TURTLE_S2_EXIT_WINDOW),
      nextAddTrigger: pos.units.length < TURTLE_MAX_UNITS
        ? pos.units[pos.units.length - 1].price + TURTLE_PYRAMID_STEP_N * pos.n
        : null,
    }
    : {
      inPosition: false,
      s1Trigger: turtleRollHigh(highs, today, TURTLE_S1_WINDOW),
      s2Trigger: turtleRollHigh(highs, today, TURTLE_S2_WINDOW),
      s1Skipped: lastS1Outcome === 'winner',
    };

  return {
    available: true,
    n: nAt(today),
    live,
    exitedToday: trail.length > 0 && trail[trail.length - 1].exitIdx === today,
    lastS1Outcome,
    trail,
    recentTrades: trail.slice(-5),
    wins: trail.filter((t) => t.outcome === 'winner').length,
    losses: trail.filter((t) => t.outcome === 'loser').length,
    dates: (chart.dates || []) as readonly Date[],
  };
}

// ── Sizing, whipsaw, RS, discipline, exclusions (:339-402) ─────────────

export interface TurtleTechPlan {
  readonly nNormalizedPositionSize?: {
    readonly shares: number; readonly stopLevel: number; readonly dollarRisk: number;
    readonly riskPctOfAccount: number; readonly n: number;
  } | null;
}

export type TurtleSizing =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true; readonly shares: number; readonly stopLevel: number;
    readonly dollarRisk: number; readonly riskPctOfAccount: number; readonly n: number;
    readonly unitsOpen: number; readonly maxUnits: number; readonly note: string;
  };

/**
 * Reuses the engine's own Unit sizing rather than reimplementing it.
 *
 * Scope is deliberately narrow and disclosed: the FIRST Unit's size at
 * TODAY's price. A live pyramid's later Units were each sized against
 * their own fill price and N at add time, which this cannot reconstruct --
 * so it reports today's first-Unit figure plus how many Units are
 * currently open, not a blended position size.
 */
export function turtleSizing(techPlan: TurtleTechPlan, sim: TurtleSimulation): TurtleSizing {
  const nps = techPlan && techPlan.nNormalizedPositionSize;
  if (!nps) return { available: false, note: 'N-normalized position size unavailable for this ticker.' };
  return {
    available: true,
    shares: nps.shares, stopLevel: nps.stopLevel, dollarRisk: nps.dollarRisk,
    riskPctOfAccount: nps.riskPctOfAccount, n: nps.n,
    unitsOpen: sim && sim.available && sim.live.inPosition ? sim.live.units : 0,
    maxUnits: TURTLE_MAX_UNITS,
    note: 'p687-692 — real Unit = (Account × 1%) ÷ (N × $/point); initial stop = entry − 2N (2% max risk); one new Unit every 0.5N favorable, up to '
      + TURTLE_MAX_UNITS + ', earlier stops raised to converge at 2N below the most-recent Unit.',
  };
}

export type TurtleWhipsaw =
  | { readonly available: false; readonly note: string }
  | { readonly available: true; readonly stop: number; readonly note: string };

/**
 * The 0.5N alternate stop, reported as a LABELLED ALTERNATIVE.
 *
 * Never blended into the primary 2N read -- the book's own tradeoff is
 * better total profitability historically but more and smaller losses, and
 * harder to sit through. Presenting an average of the two would describe a
 * system nobody traded.
 *
 * Prefers the tech plan's N and falls back to the simulator's, so the stop
 * is computed from the same N the sizing section quotes whenever both exist.
 */
export function turtleWhipsaw(sim: TurtleSimulation, techPlan: TurtleTechPlan): TurtleWhipsaw {
  if (!sim || !sim.available || !sim.live.inPosition) {
    return { available: false, note: 'No open position to compute a Whipsaw-equivalent stop for.' };
  }
  const nps = techPlan && techPlan.nNormalizedPositionSize;
  const n = nps ? nps.n : sim.n;
  if (n == null) return { available: false, note: 'N unavailable.' };
  return {
    available: true,
    stop: sim.live.entryPrice - TURTLE_WHIPSAW_STOP_N * n,
    note: 'p814-825 — real, disclosed alternate: 0.5N stop (0.5% risk) instead of 2N/2%, with an explicit re-entry rule if stopped out and price later reclaims the original entry price. "A few Turtles traded this method with good success" (book\'s own words) — better historical profitability, but a lower win/loss ratio, harder to execute. Shown as a labeled alternative only, never blended into the primary 2N stop above.',
  };
}

export interface TurtleRsCache {
  readonly categories: readonly string[];
  readonly rank: number;
  readonly peerCount: number;
  readonly percentile: number;
  readonly read: string;
}

/** Indicators plus the relative-strength trigger-cache attachment. */
export interface TurtleIndicators extends Indicators {
  readonly relativeStrengthRanking?: TurtleRsCache | null;
}

export type TurtleRelativeStrength =
  | { readonly available: false; readonly note: string }
  | ({ readonly available: true; readonly note: string } & TurtleRsCache);

/**
 * Cross-references the already-computed ranking; recomputes nothing.
 *
 * Long-only adaptation of "buy the strongest, short the weakest": relative
 * weakness is a caution, never a short recommendation.
 */
export function turtleRelativeStrength(ind: TurtleIndicators): TurtleRelativeStrength {
  const rsr = ind && ind.relativeStrengthRanking;
  if (!rsr) {
    return {
      available: false,
      note: 'Relative Strength Ranking unavailable (ticker not in any of the 14 real correlated-group categories, or trigger cache stale/missing — see refreshRelativeStrengthRankingV1_, darkPoolTrackerV1.gs).',
    };
  }
  return {
    available: true,
    categories: rsr.categories, rank: rsr.rank, peerCount: rsr.peerCount,
    percentile: rsr.percentile, read: rsr.read,
    note: 'p698-699 — real, disclosed rule: within a correlated group, buy the STRONGEST, short the WEAKEST. Long-only adaptation: relative weakness is a caution only, never a short recommendation (this user\'s own long-only/calls-only strategy). Real formula (CurrentPrice−PriceNMonthsAgo)/CurrentN, already wired — this section cross-references it, does not recompute it.',
  };
}

export interface TurtleDiscipline {
  readonly quote: string;
  readonly attribution: string;
  readonly note: string;
}

/**
 * The Richard Dennis discipline quote.
 *
 * Kept because it is the book's own finding about WHY the system failed for
 * most people -- not the rules, but the inability to follow them. That is
 * the same "don't over-promise certainty" framing the rest of this project
 * uses, stated by the source itself.
 */
export function turtleDisciplineNote(): TurtleDiscipline {
  return {
    quote: 'I always say that you could publish my trading rules in the newspaper and no one would follow them. The key is consistency and discipline. Almost anybody can make up a list of rules that are 80% as good as what we taught our people. What they couldn\'t do is give them the confidence to stick to those rules even when things are going bad.',
    attribution: 'Richard Dennis, quoted in Market Wizards by Jack D. Schwager (p1081-1086)',
    note: 'The book\'s own real, disclosed finding: most Turtles who failed did NOT fail because the rules didn\'t work — they failed because they could not consistently follow them, especially the counterintuitive parts (adding to positions quickly, holding through open-profit giveback while waiting for the slower exit). Same "don\'t over-promise certainty" framing this project already uses elsewhere.',
  };
}

export interface Exclusion {
  readonly item: string;
  readonly reason: string;
}

/**
 * FLAGGED (F-20): the second entry of this list is STALE.
 *
 * It states the 4-tier correlated-exposure caps are a "real port-audit
 * question, deferred to Deliverable 2... not decided here." They were
 * subsequently built: turtleCorrelatedCaps exists in this very file and is
 * wired into computePortfolioBullPhaseAdvisoryV1_ at
 * fullStockAnalysisV10_9.gs:903, rendering on the Portfolio Summary sheet.
 *
 * So the report tells the user a feature is absent while the system ships
 * it. Verified by grepping every call site across all ten legacy files.
 * Reproduced verbatim, NOT corrected -- it is user-visible report text and
 * the port-fidelity rule applies. Flagged because a reader acting on this
 * list would believe the caps are unimplemented.
 */
export function turtleExclusions(): Exclusion[] {
  return [
    { item: 'Short-side entries, short-side pyramiding, short-side stops', reason: 'This user\'s own standing trading strategy is long-only/calls-only (memory `trading-strategy-long-only-calls`) — this model reads and reports LONG signals only.' },
    { item: '4-tier correlated-market exposure caps (max 4/6/10/12 Units, p690)', reason: 'Futures-specific cross-COMMODITY concept (e.g. crude oil + heating oil as "closely correlated"). A stock-analog candidate exists (this engine\'s own Ch31 "8-10 stocks max" diversification ceiling, computePortfolioBullPhaseAdvisoryV1_, v9.91) — real port-audit question, deferred to Deliverable 2 per BIG_PLAN_TURTLE.md, not decided here.' },
    { item: 'Contract-rollover rules, notional/non-cash account sizing, the real futures market list (T-Bonds, Coffee/Cocoa/Sugar/Cotton, FX majors, etc.)', reason: 'Genuinely out of scope — this engine is stocks/ETFs only, no futures-contract infrastructure.' },
    { item: 'Raw N-adjusted-distance-since-breakout RS method (the book\'s own 2nd, cruder alternative)', reason: 'The book\'s own more precise method, (CurrentPrice−PriceNMonthsAgo)/CurrentN, is already ported and cited above — using both would be redundant, not complementary.' },
  ];
}

// ── Builder (:410-451) ─────────────────────────────────────────────────

export interface TurtleSynthesis {
  readonly bullish: readonly string[];
  readonly cautionary: readonly string[];
  readonly netRead: string;
}

export interface TurtleReport {
  readonly ticker: string;
  readonly sim: TurtleSimulation;
  readonly sizing: TurtleSizing;
  readonly whipsaw: TurtleWhipsaw;
  readonly relativeStrength: TurtleRelativeStrength;
  readonly discipline: TurtleDiscipline;
  readonly exclusions: readonly Exclusion[];
  readonly synthesis: TurtleSynthesis;
}

/**
 * Builds the whole report.
 *
 * Same count-not-score synthesis as the other models.
 *
 * ══ BEING IN A POSITION READS AS BULLISH ═══════════════════════════════
 * Worth noticing: `inPosition` alone pushes a bullish line, because in a
 * trend-following system an open position IS the signal -- the system is
 * long because the channel broke out and has not broken down. It is not an
 * independent opinion about the stock, and a reader comparing this against
 * the main engine's conviction should not treat it as one.
 *
 * FLAGGED (F-19, third occurrence): the legacy signature is
 * (ticker, ind, gann, confluence, techPlan, chart, log). Measured on the
 * body with comments and strings stripped: `gann` 0 uses, `confluence`
 * 0 uses. Identical to F-17 (Edwards & Magee) and F-19 (Schabacker) --
 * three of three model files so far carry the same two dead parameters,
 * which looks like one copied signature template rather than three
 * independent oversights. This takes five parameters.
 */
export function buildTurtleReport(
  ticker: string,
  ind: TurtleIndicators,
  techPlan: TurtleTechPlan,
  chart: SimInput,
  log?: (msg: string) => void,
): TurtleReport | null {
  try {
    const sim = turtleSimulate(chart || {});
    const sizing = turtleSizing(techPlan || {}, sim);
    const whipsaw = turtleWhipsaw(sim, techPlan || {});
    const relativeStrength = turtleRelativeStrength(ind || ({} as TurtleIndicators));
    const discipline = turtleDisciplineNote();
    const exclusions = turtleExclusions();

    const bullish: string[] = [];
    const cautionary: string[] = [];

    if (sim.available) {
      if (sim.live.inPosition) {
        if (sim.live.enteredToday) {
          bullish.push('Turtle ' + sim.live.system + ' breakout entry triggered TODAY (Appendix E)');
        } else {
          bullish.push('Currently in a real Turtle ' + sim.live.system + ' long position ('
            + sim.live.units + ' Unit' + (sim.live.units > 1 ? 's' : '') + ' open)');
        }
        if (sim.live.addedToday) {
          bullish.push('Pyramid add triggered TODAY — favorable 0.5N move (Appendix E)');
        }
      } else {
        if (sim.exitedToday) {
          cautionary.push('Turtle position exited TODAY (stop or opposite-channel breakdown, Appendix E)');
        }
        if (sim.live.s1Skipped) {
          cautionary.push('Next System-1 signal will be SKIPPED (last one was a winner) unless System-2 (55-day) also clears — Appendix E whipsaw filter');
        }
      }
    }
    if (relativeStrength.available) {
      const rs = relativeStrength;
      if (rs.read && rs.read.indexOf('STRONG') === 0) {
        bullish.push('Relative Strength Ranking: #' + rs.rank + '/' + rs.peerCount + ' in '
          + rs.categories.join('/') + ' — among the strongest in its real peer group (Appendix E)');
      } else if (rs.read && rs.read.indexOf('WEAK') === 0) {
        cautionary.push('Relative Strength Ranking: #' + rs.rank + '/' + rs.peerCount + ' in '
          + rs.categories.join('/') + ' — among the weakest in its real peer group, a caution not a short signal (Appendix E)');
      }
    }

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
        : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker, sim, sizing, whipsaw, relativeStrength, discipline, exclusions,
      synthesis: { bullish, cautionary, netRead },
    };
  } catch (e) {
    log?.('Turtle model: report build failed for ' + ticker + ' — '
      + (e && (e as Error).message ? (e as Error).message : String(e)));
    return null;
  }
}

/**
 * Local date formatter (:457-461).
 *
 * Deliberately avoids Apps Script's 3-arg Utilities.formatDate so the same
 * code runs in GAS and in Node. Returns 'n/a' for a missing date rather
 * than "Invalid Date" or a thrown error.
 */
export function turtleDateStr(dates: readonly Date[] | null | undefined, idx: number): string {
  const d = dates && dates[idx];
  if (!d) return 'n/a';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

// ── Plain-text formatter (:465-525) ────────────────────────────────────

/**
 * Renders the report as plain text.
 *
 * Header is '── X ──' not '=== X ===' for the Apps Script formula reason --
 * see edwardsMagee.ts.
 *
 * ══ FLAGGED (F-18, second occurrence): SECTION 4 DUPLICATES ITS NOTE ═══
 * Section 4 is the same shape as the Schabacker bug:
 *
 *     if (available) { push(rank line) } else push('  ' + note);
 *     push('  ' + report.relativeStrength.note || '');
 *
 * so on the UNAVAILABLE path the note prints twice.
 *
 * ══ AND IT HAS A PRECEDENCE QUIRK SCHABACKER DOES NOT ══════════════════
 * Note the parenthesisation. Schabacker writes `push('  ' + (note || ''))`;
 * this writes `push('  ' + note || '')`, and `+` binds tighter than `||`,
 * so it parses as `push(('  ' + note) || '')`. The left operand always has
 * two leading spaces and is therefore always truthy, which makes the
 * `|| ''` fallback DEAD. If `note` were ever undefined this prints
 * "  undefined" where Schabacker would print "  ".
 *
 * Both reproduced exactly. The divergence between the two files is
 * legacy's, not the port's.
 */
export function formatTurtleReport(report: TurtleReport | null, opts: ModelTextOptions = {}): string {
  if (!report) return 'No report — data unavailable.';
  const plain = !!opts.plainText;
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push('── ' + report.ticker + ' — Original Turtle Trading System Model v1 (Appendix E) ──');
  push('');
  push('1. DUAL-SYSTEM BREAKOUT READ (S1: 20-day / S2: 55-day)');
  if (!report.sim.available) {
    push('  ' + report.sim.note);
  } else if (report.sim.live.inPosition) {
    const l = report.sim.live;
    push('  IN POSITION — System ' + l.system + ', entered '
      + turtleDateStr(report.sim.dates, l.entryIdx) + ' @ $' + l.entryPrice.toFixed(2)
      + (l.enteredToday ? ' (TODAY)' : ''));
    push('  Units: ' + l.units + '/4' + (l.addedToday ? ' (added TODAY)' : '')
      + '. Stop: $' + l.stop.toFixed(2)
      + '. Exit channel (opposite-direction breakdown): $'
      + (l.exitChannelLevel != null ? l.exitChannelLevel.toFixed(2) : 'n/a'));
    if (l.nextAddTrigger != null) {
      push('  Next pyramid add triggers at: $' + l.nextAddTrigger.toFixed(2));
    }
  } else {
    const l = report.sim.live;
    push('  FLAT. S1 (20d) entry trigger: $' + (l.s1Trigger != null ? l.s1Trigger.toFixed(2) : 'n/a')
      + (l.s1Skipped ? ' — WOULD BE SKIPPED (last S1 was a winner) unless S2 also clears' : '')
      + '. S2 (55d) failsafe entry trigger: $'
      + (l.s2Trigger != null ? l.s2Trigger.toFixed(2) : 'n/a'));
    if (report.sim.exitedToday) push('  Exited a position TODAY.');
  }
  if (report.sim.available) {
    // "descriptive only, not a predictive-value backtest" -- the wording
    // matters given the no-slippage assumptions in the simulator header.
    push('  Real trade history in this ~2yr window: ' + report.sim.trail.length + ' closed ('
      + report.sim.wins + 'W/' + report.sim.losses
      + 'L) — descriptive only, not a predictive-value backtest.'
      + (plain && report.sim.recentTrades.length < report.sim.trail.length ? ' Listed: the last ' + report.sim.recentTrades.length + ' of ' + report.sim.trail.length + '.' : ''));
    report.sim.recentTrades.forEach((t) => push('    - ' + t.system + ': '
      + turtleDateStr(report.sim.available ? report.sim.dates : null, t.entryIdx)
      + ' @ $' + t.entryPrice.toFixed(2) + ' -> '
      + turtleDateStr(report.sim.available ? report.sim.dates : null, t.exitIdx)
      + ' @ $' + t.exitPrice.toFixed(2) + ' (' + t.units + 'u, ' + t.outcome + ')'));
  }
  push('');

  push('2. N-BASED UNIT SIZING + 2N STOP + PYRAMID LADDER (p687-692)');
  if (report.sizing.available) {
    push('  Unit (today, 1st Unit): ' + report.sizing.shares + ' shares, N='
      + report.sizing.n.toFixed(2) + ', stop $' + report.sizing.stopLevel.toFixed(2)
      + ', risk $' + report.sizing.dollarRisk.toFixed(0) + ' ('
      + report.sizing.riskPctOfAccount.toFixed(1) + (plain ? '% ' + assumedAccountText() : '% of account') + '). Open Units: '
      + report.sizing.unitsOpen + '/' + report.sizing.maxUnits + '.');
  } else {
    push('  ' + report.sizing.note);
  }
  push('');

  push('3. WHIPSAW VARIANT — LABELED ALTERNATIVE, NOT BLENDED (p814-825)');
  if (report.whipsaw.available) push('  Whipsaw-equivalent stop: $' + report.whipsaw.stop.toFixed(2));
  // Unconditional here too, but correct: the note is the section's point
  // and is printed exactly once on both paths.
  push('  ' + report.whipsaw.note);
  push('');

  push('4. RELATIVE STRENGTH CROSS-REFERENCE (p698-699)');
  if (report.relativeStrength.available) {
    const rs = report.relativeStrength;
    push('  #' + rs.rank + '/' + rs.peerCount + ' in ' + rs.categories.join('/')
      + ' (percentile ' + rs.percentile + ') — ' + rs.read);
  } else {
    push('  ' + report.relativeStrength.note);
  }
  // F-18 (second occurrence) plus the dead `|| ''`. Written with explicit
  // parentheses to make the ACTUAL legacy parse unmistakable, rather than
  // copying an expression whose grouping reads as the opposite.
  if (!(plain && !report.relativeStrength.available)) push(('  ' + report.relativeStrength.note) || '');
  push('');

  push('5. DISCIPLINE (p1081-1086)');
  push('  "' + report.discipline.quote + '" — ' + report.discipline.attribution);
  push('');

  push('6. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach((e) => push('  - ' + e.item + ': ' + e.reason));
  push('');

  push('7. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach((b) => push('  [+] ' + b));
  report.synthesis.cautionary.forEach((c) => push('  [-] ' + c));

  return lines.join('\n');
}
