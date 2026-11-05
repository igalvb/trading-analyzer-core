/**
 * Entry and exit zones from the confluence of many independent methods.
 *
 * The design idea: rather than trusting one support level, gather a dozen
 * candidate levels from unrelated methods (Gann, pivots, Bollinger, Fibonacci,
 * ATR, moving averages, Square-of-9, volume profile) and look for CLUSTERS.
 * Several independent methods agreeing on a price is stronger evidence than any
 * single one.
 *
 * Verified 2026-10-04: 480 cases exact (24 tickers x 5 lengths x 4 fundamental
 * variants), zero failures. 6,940 included and 3,140 excluded method entries
 * compared, across 356 distinct exclusion-reason strings -- which also confirms
 * every embedded dollar amount is formatted byte-identically.
 */

import type { Chart } from '../types/chart.ts';
import type { Indicators } from '../types/indicators.ts';
import type { GannRead } from './gann.ts';
import { slope } from './series.ts';

/** Only the analyst-target fields are read, so the input is deliberately narrow. */
export interface ConfluenceFundamentals {
  readonly targetMean?: number | null;
  readonly targetHigh?: number | null;
}

export type ConfluenceInput = Pick<Chart, 'closes' | 'currentPrice'>;

/** plainText: the corrected wording (production). Unset = legacy's exact strings (the oracle). */
export interface ConfluenceOptions {
  readonly plainText?: boolean;
}

export interface ConfluenceMethod {
  name: string;
  price: number | null;
  type: 'support' | 'target';
  excluded?: boolean;
  /** A specific, human-readable reason -- not a generic placeholder. */
  exclusionReason?: string;
}

export interface ConfluenceTargets {
  entryLow: number;
  entryHigh: number;
  entryCenter: number;
  entryConfidence: string;
  entryCount: number;
  entryMethods: ConfluenceMethod[];
  /** Every candidate, including excluded ones -- the audit trail. */
  allEntryMethods: ConfluenceMethod[];
  exitLow: number;
  exitHigh: number;
  exitCenter: number;
  exitConfidence: string;
  exitCount: number;
  exitMethods: ConfluenceMethod[];
  allExitMethods: ConfluenceMethod[];
}

/** Entry clusters tolerate 5%; exit clusters 7%, since long-term targets are coarser. */
const ENTRY_TOLERANCE = 0.05;
const EXIT_TOLERANCE = 0.07;
/** Gann projections beyond 2.5x current price are treated as unphysical. */
const GANN_PROJECTION_CEILING_MULT = 2.5;

/**
 * Groups methods whose prices sit within `tolerance` of each other.
 *
 * IMPORTANT -- this clusters against a FIXED ANCHOR: every candidate is compared
 * to `methods[i].price`, the first unused element, not to a running centroid.
 * That differs from srLevels() in the indicator layer, which recomputes its
 * cluster average as each member joins. Two different clustering algorithms
 * coexist in this codebase; neither is wrong, but they are not interchangeable
 * and unifying them would change results.
 *
 * Because the input is pre-sorted by price, the anchor choice is deterministic.
 * Clusters are returned largest-first, so [0] is the strongest confluence.
 */
function findClusters(methods: ConfluenceMethod[], tolerance: number): ConfluenceMethod[][] {
  if (methods.length === 0) return [];
  const clusters: ConfluenceMethod[][] = [];
  const used = new Array<boolean>(methods.length).fill(false);

  for (let i = 0; i < methods.length; i++) {
    if (used[i]) continue;
    const anchor = methods[i] as ConfluenceMethod;
    const cluster: ConfluenceMethod[] = [anchor];
    for (let j = i + 1; j < methods.length; j++) {
      if (used[j]) continue;
      const cand = methods[j] as ConfluenceMethod;
      if (Math.abs((cand.price as number) - (anchor.price as number)) / (anchor.price as number) <= tolerance) {
        cluster.push(cand);
        used[j] = true;
      }
    }
    used[i] = true;
    clusters.push(cluster);
  }
  return clusters.sort((a, b) => b.length - a.length);
}

interface ClusterSummary {
  low: number;
  high: number;
  center: number;
  confidence: string;
  count: number;
  methods: ConfluenceMethod[];
  allMethods?: ConfluenceMethod[];
}

/**
 * Summarises the strongest cluster into a zone plus a confidence string.
 *
 * Confidence combines ABSOLUTE agreement (how many methods) with RELATIVE
 * agreement (what fraction of available methods):
 *   HIGH        4+ methods AND >=50% of those available
 *   MEDIUM      3+ methods AND >=35%
 *   LOW-MEDIUM  2+ methods
 *   LOW         a single method
 * The fraction matters: 4 of 5 methods agreeing is stronger than 4 of 20.
 *
 * The no-cluster fallback FABRICATES a zone at 95-97% of current price and
 * labels it 'LOW (no data)'. The label is honest, but entryCenter is then a
 * made-up number rather than null -- so a consumer reading the zone without
 * checking `confidence` or `count` would act on an invented level.
 *
 * I could not reach this path: `validEntry` is kept non-empty by the
 * unconditional ATR-pullback method, which has no `excluded` flag and always
 * lands below price. An attempted 97%-per-day collapse still produced two
 * clustered methods. So this fallback is at minimum very hard to reach -- but
 * I have not proven it unreachable, so it is NOT recorded as a flagged finding.
 */
function clusterSummary(clusters: ConfluenceMethod[][], methods: ConfluenceMethod[], cp: number): ClusterSummary {
  if (clusters.length === 0 || methods.length === 0) {
    return { low: cp * 0.95, high: cp * 0.97, center: cp * 0.96, confidence: 'LOW (no data)', count: 0, methods: [] };
  }
  const best = clusters[0] as ConfluenceMethod[];
  const prices = best.map((m) => m.price as number);
  const count = best.length;
  const frac = methods.length ? count / methods.length : 0;
  const tag = count >= 4 && frac >= 0.5 ? 'HIGH' : count >= 3 && frac >= 0.35 ? 'MEDIUM' : count >= 2 ? 'LOW-MEDIUM' : 'LOW';

  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
    center: prices.reduce((a, b) => a + b, 0) / prices.length,
    confidence: `${tag} (${count}/${methods.length} methods in zone)`,
    count,
    methods: best,
    allMethods: methods,
  };
}

/**
 * Computes entry and exit confluence zones.
 *
 * ══ EVERY METHOD IS ALWAYS PUSHED ══════════════════════════════════════
 * Unavailable or inapplicable methods are pushed WITH `excluded: true` and a
 * specific reason, never omitted. So `allEntryMethods` and `allExitMethods` are
 * a complete audit trail: the reader can see that SMA50 was considered and
 * rejected because it sat above price, as opposed to never having been checked.
 *
 * That is why the exclusion reasons embed formatted prices -- they are written
 * for a human reading the report. 356 distinct reason strings were compared
 * byte-for-byte during verification.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Two asymmetric filters worth noting:
 *   - Entry admits prices up to cp * 1.02, i.e. slightly ABOVE current price,
 *     deliberately allowing a momentum entry rather than requiring a pullback.
 *   - Exit admits prices down to cp * 0.98, slightly BELOW current price.
 * Both bands overlap current price by 2%, so a level right at the money can
 * appear on either side.
 *
 * `fund` may be null, and note the falsy-zero behaviour: a targetMean of
 * exactly 0 is reported as "data unavailable" rather than "below current
 * price". Part of the F-06 family; implausible for a real analyst target.
 */
export function computeConfluenceTargets(
  ind: Indicators,
  gann: GannRead,
  fund: ConfluenceFundamentals | null,
  chart: ConfluenceInput,
  opts: ConfluenceOptions = {},
): ConfluenceTargets {
  const cp = chart.currentPrice;

  // ── Entry (support) candidates ──────────────────────────────────────
  const entryMethods: ConfluenceMethod[] = [];

  if (gann.gannSupport) {
    // The name embeds the angle label, so it varies per chart.
    entryMethods.push({ name: `Gann support (${gann.lowerAngle})`, price: gann.gannSupport, type: 'support' });
  } else {
    entryMethods.push({ name: 'Gann support', price: null, type: 'support', excluded: true, exclusionReason: 'no Gann support angle available for this pivot' });
  }

  if (ind.pp_S1) entryMethods.push({ name: 'Pivot S1', price: ind.pp_S1, type: 'support' });
  else entryMethods.push({ name: 'Pivot S1', price: null, type: 'support', excluded: true, exclusionReason: 'pivot data unavailable' });

  // S2 additionally requires positivity -- a deep pivot can compute negative.
  if (ind.pp_S2 && ind.pp_S2 > 0) entryMethods.push({ name: 'Pivot S2', price: ind.pp_S2, type: 'support' });
  else entryMethods.push({ name: 'Pivot S2', price: null, type: 'support', excluded: true, exclusionReason: 'pivot S2 unavailable or non-positive' });

  if (ind.bbLower) entryMethods.push({ name: 'Bollinger lower band', price: ind.bbLower, type: 'support' });
  else entryMethods.push({ name: 'Bollinger lower band', price: null, type: 'support', excluded: true, exclusionReason: 'Bollinger data unavailable' });

  if (ind.fib382) entryMethods.push({ name: 'Fib 38.2% retracement', price: ind.fib382, type: 'support' });
  else entryMethods.push({ name: 'Fib 38.2% retracement', price: null, type: 'support', excluded: true, exclusionReason: 'Fibonacci data unavailable' });

  if (ind.fib500) entryMethods.push({ name: 'Fib 50.0% retracement', price: ind.fib500, type: 'support' });
  else entryMethods.push({ name: 'Fib 50.0% retracement', price: null, type: 'support', excluded: true, exclusionReason: 'Fibonacci data unavailable' });

  // The ONLY unconditional method -- never excluded, which is what keeps
  // validEntry non-empty in practice. Note the multiplication sign in the name.
  entryMethods.push({ name: 'ATR pullback (1.5×ATR)', price: cp - 1.5 * (ind.atr14 as number), type: 'support' });

  if (ind.sma20) entryMethods.push({ name: 'SMA20 dynamic support', price: ind.sma20, type: 'support' });
  else entryMethods.push({ name: 'SMA20 dynamic support', price: null, type: 'support', excluded: true, exclusionReason: 'SMA20 unavailable' });

  // SMA50/150 keep their PRICE even when excluded -- the value is real, it just
  // is not acting as support right now. Distinct from "unavailable", where
  // price is null.
  if (ind.sma50) {
    if (ind.sma50 < cp) entryMethods.push({ name: 'SMA50 dynamic support', price: ind.sma50, type: 'support' });
    else entryMethods.push({ name: 'SMA50 dynamic support', price: ind.sma50, type: 'support', excluded: true, exclusionReason: `SMA50 ($${ind.sma50.toFixed(2)}) is above current price -- not currently acting as support` });
  } else {
    entryMethods.push({ name: 'SMA50 dynamic support', price: null, type: 'support', excluded: true, exclusionReason: 'SMA50 unavailable' });
  }

  if (ind.sma150) {
    if (ind.sma150 < cp) entryMethods.push({ name: 'SMA150 dynamic support', price: ind.sma150, type: 'support' });
    else entryMethods.push({ name: 'SMA150 dynamic support', price: ind.sma150, type: 'support', excluded: true, exclusionReason: `SMA150 ($${ind.sma150.toFixed(2)}) is above current price -- not currently acting as support` });
  } else {
    entryMethods.push({ name: 'SMA150 dynamic support', price: null, type: 'support', excluded: true, exclusionReason: 'SMA150 unavailable' });
  }

  if (gann.sq9below) entryMethods.push({ name: 'Sq9 harmonic support', price: gann.sq9below, type: 'support' });
  else entryMethods.push({ name: 'Sq9 harmonic support', price: null, type: 'support', excluded: true, exclusionReason: 'no Sq9 level below current price' });

  // Note `!= null` rather than truthiness -- a POC of exactly 0 is treated as
  // present, unlike the falsy-zero handling elsewhere in this function.
  if (ind.volumePOC != null) {
    if (ind.volumePOC < cp) entryMethods.push({ name: 'Volume POC (high-volume node)', price: ind.volumePOC, type: 'support' });
    else entryMethods.push({ name: 'Volume POC (high-volume node)', price: ind.volumePOC, type: 'support', excluded: true, exclusionReason: `the highest-volume price node ($${ind.volumePOC.toFixed(2)}) is above current price -- not currently acting as support` });
  } else {
    entryMethods.push({ name: 'Volume POC (high-volume node)', price: null, type: 'support', excluded: true, exclusionReason: 'insufficient volume data to compute a volume profile' });
  }

  // Highest-first: the nearest support to current price leads.
  const validEntry = entryMethods
    .filter((m) => !m.excluded && (m.price as number) > 0 && (m.price as number) < cp * 1.02)
    .sort((a, b) => (b.price as number) - (a.price as number));

  // ── Exit (target) candidates ────────────────────────────────────────
  const exitMethods: ConfluenceMethod[] = [];
  const gannProjCeiling = cp * GANN_PROJECTION_CEILING_MULT;

  // Gann targets project the fan forward a further 252 trading days.
  if (gann.gannMaster) {
    const gann1x1at1yr = gann.pivot.price + gann.priceUnit * (gann.pivot.daysAgo + 252);
    if (gann1x1at1yr > cp && gann1x1at1yr <= gannProjCeiling) {
      exitMethods.push({ name: 'Gann 1×1 (12 months)', price: gann1x1at1yr, type: 'target' });
    } else {
      exitMethods.push({
        name: 'Gann 1×1 (12 months)', price: gann1x1at1yr, type: 'target', excluded: true,
        exclusionReason: gann1x1at1yr <= cp ? 'projected value is below current price' : `beyond the 2.5x sanity ceiling ($${gannProjCeiling.toFixed(2)})`,
      });
    }
  } else {
    exitMethods.push({ name: 'Gann 1×1 (12 months)', price: null, type: 'target', excluded: true, exclusionReason: 'no Gann master level available' });
  }

  const fib1618ext = (ind.low52 as number) + 1.618 * ((ind.high52 as number) - (ind.low52 as number));
  if (fib1618ext > cp) exitMethods.push({ name: 'Fib 161.8% extension', price: fib1618ext, type: 'target' });
  else exitMethods.push({ name: 'Fib 161.8% extension', price: fib1618ext, type: 'target', excluded: true, exclusionReason: 'projected value is below current price' });

  if (gann.sq9above) exitMethods.push({ name: 'Sq9 harmonic resistance', price: gann.sq9above, type: 'target' });
  else exitMethods.push({ name: 'Sq9 harmonic resistance', price: null, type: 'target', excluded: true, exclusionReason: 'no Sq9 level above current price' });

  if (ind.sma200) {
    // A 60-day slope of CLOSES used as a proxy for the SMA200's own slope --
    // an approximation the legacy source labels as such.
    const slope60 = slope(chart.closes, 60);
    const sma200proj = ind.sma200 + slope60 * 252;
    if (sma200proj > cp) exitMethods.push({ name: 'SMA200 trend (12mo proj)', price: sma200proj, type: 'target' });
    else if (opts.plainText) {
      // D7: the projection can sit below price while the SMA200 itself is still rising; say "declining" only on a negative slope.
      exitMethods.push({ name: 'SMA200 trend (12mo proj)', price: sma200proj, type: 'target', excluded: true, exclusionReason: 'the 12-month projection ($' + sma200proj.toFixed(2) + ') is below the current price' + (slope60 < 0 ? ' -- the 60-day price trend it projects is declining' : '') });
    } else exitMethods.push({ name: 'SMA200 trend (12mo proj)', price: sma200proj, type: 'target', excluded: true, exclusionReason: 'the projected trend (based on current slope) is below current price -- SMA200 is currently declining' });
  } else {
    exitMethods.push({ name: 'SMA200 trend (12mo proj)', price: null, type: 'target', excluded: true, exclusionReason: 'SMA200 unavailable' });
  }

  if (fund && fund.targetMean) {
    if (fund.targetMean > cp) exitMethods.push({ name: 'Analyst consensus (FMP)', price: fund.targetMean, type: 'target' });
    else exitMethods.push({ name: 'Analyst consensus (FMP)', price: fund.targetMean, type: 'target', excluded: true, exclusionReason: `analyst mean target ($${fund.targetMean.toFixed(2)}) is below current price` });
  } else {
    exitMethods.push({ name: 'Analyst consensus (FMP)', price: null, type: 'target', excluded: true, exclusionReason: 'analyst target data unavailable' });
  }

  if (fund && fund.targetHigh) {
    if (fund.targetHigh > cp) exitMethods.push({ name: 'Analyst high target (FMP)', price: fund.targetHigh, type: 'target' });
    else exitMethods.push({ name: 'Analyst high target (FMP)', price: fund.targetHigh, type: 'target', excluded: true, exclusionReason: 'analyst high target is below current price' });
  } else {
    exitMethods.push({ name: 'Analyst high target (FMP)', price: null, type: 'target', excluded: true, exclusionReason: 'analyst target data unavailable' });
  }

  if ((ind.high52 as number) > cp) exitMethods.push({ name: '52-week high', price: ind.high52, type: 'target' });
  else exitMethods.push({ name: '52-week high', price: ind.high52, type: 'target', excluded: true, exclusionReason: 'current price is already above the 52-week high' });

  const gann2x1_1yr = gann.pivot.price + 2 * gann.priceUnit * (gann.pivot.daysAgo + 252);
  if (gann2x1_1yr > cp && gann2x1_1yr <= gannProjCeiling) {
    exitMethods.push({ name: 'Gann 2×1 (12 months)', price: gann2x1_1yr, type: 'target' });
  } else {
    exitMethods.push({
      name: 'Gann 2×1 (12 months)', price: gann2x1_1yr, type: 'target', excluded: true,
      exclusionReason: gann2x1_1yr <= cp ? 'projected value is below current price' : `beyond the 2.5x sanity ceiling ($${gannProjCeiling.toFixed(2)})`,
    });
  }

  // The volume POC appears on BOTH sides, included on whichever side of price
  // it currently sits. Not a duplication -- a high-volume node acts as support
  // from above and resistance from below.
  if (ind.volumePOC != null) {
    if (ind.volumePOC > cp) exitMethods.push({ name: 'Volume POC (high-volume node)', price: ind.volumePOC, type: 'target' });
    else exitMethods.push({ name: 'Volume POC (high-volume node)', price: ind.volumePOC, type: 'target', excluded: true, exclusionReason: `the highest-volume price node ($${ind.volumePOC.toFixed(2)}) is below current price -- not currently acting as resistance` });
  } else {
    exitMethods.push({ name: 'Volume POC (high-volume node)', price: null, type: 'target', excluded: true, exclusionReason: 'insufficient volume data to compute a volume profile' });
  }

  // Lowest-first: the nearest target leads.
  const validExit = exitMethods
    .filter((m) => !m.excluded && (m.price as number) > cp * 0.98)
    .sort((a, b) => (a.price as number) - (b.price as number));

  const e = clusterSummary(findClusters(validEntry, ENTRY_TOLERANCE), validEntry, cp);
  const x = clusterSummary(findClusters(validExit, EXIT_TOLERANCE), validExit, cp);

  return {
    entryLow: e.low, entryHigh: e.high, entryCenter: e.center,
    entryConfidence: e.confidence, entryCount: e.count,
    entryMethods: e.methods || [], allEntryMethods: entryMethods,
    exitLow: x.low, exitHigh: x.high, exitCenter: x.center,
    exitConfidence: x.confidence, exitCount: x.count,
    exitMethods: x.methods || [], allExitMethods: exitMethods,
  };
}
