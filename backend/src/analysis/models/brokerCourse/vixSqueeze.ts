/**
 * Broker Course Phase 10 -- VIX regime (ep.2) and short-squeeze setup
 * (ep.9/13), :1729-1810, 4 functions.
 *
 * vixRegimeReadV1 is ALSO called by the engine itself, cross-file
 * (fullStockAnalysisV10_9.gs:1113-1114) -- the Phase-3 pipeline must import
 * it from here, same as playerMapping.ts.
 *
 * vixAndSqueezeReadV1 has NO caller in any legacy file (F-24 class): the
 * report builder calls the two parts directly (:2028, :2069), and its own
 * comment (:2070-2076) records that bypassing the wrapper dropped the
 * coverage disclosure, which was then re-added there as
 * `shortInterestNote`. Ported and tested; nothing should need it.
 */

export type VixRegime = 'Euphoria (<13)' | 'Normal (13-25)' | 'Elevated (25-40)' | 'Crisis (40-70)' | 'Extreme (70+)';

export interface VixRegimeRead {
  readonly regime: VixRegime;
  readonly vixLevel: number;
  readonly read: string;
}

/**
 * The course's stated VIX bands, explicitly time-bound per the instructor.
 * The lower edge of Euphoria is exclusive (13 is Normal); every upper edge
 * is inclusive (25 is Normal, 70 is Crisis). All five regimes occur in the
 * real VIX history fixture.
 */
export function vixRegimeReadV1(vixLevel: number | null | undefined): VixRegimeRead | null {
  if (vixLevel == null) return null;
  let regime: VixRegime;
  if (vixLevel < 13) regime = 'Euphoria (<13)';
  else if (vixLevel <= 25) regime = 'Normal (13-25)';
  else if (vixLevel <= 40) regime = 'Elevated (25-40)';
  else if (vixLevel <= 70) regime = 'Crisis (40-70)';
  else regime = 'Extreme (70+)';
  return {
    regime, vixLevel,
    read: 'VIX at ' + vixLevel.toFixed(1) + ' — ' + regime + ' by the course\'s own stated bands (ep.2). These are the instructor\'s stated reference points from a specific period, not asserted as permanent — he discloses they already went stale once (COVID recalibration).',
  };
}

/** Short % of float tiers from the course's FinViz screener anchors (ep.9). All strict. */
export function shortInterestTierV1(shortPctOfFloat: number | null | undefined): string | null {
  if (shortPctOfFloat == null) return null;
  if (shortPctOfFloat > 0.40) return 'Extreme (>40%)';
  if (shortPctOfFloat > 0.20) return 'Elevated (>20%) — course\'s own "getting interesting" tier (ep.9)';
  if (shortPctOfFloat > 0.10) return 'Notable (>10%) — course\'s own floor for even screening on this (ep.9)';
  return 'Normal (<=10%)';
}

export interface ShortSqueezeRead {
  readonly isSqueezeSetup: boolean;
  readonly tier: string | null;
  readonly atNewHigh: boolean;
  readonly shortPctOfFloat: number;
  readonly read: string;
}

/**
 * Squeeze setup: short interest > 20% (strict) AND price within 3%
 * (inclusive) of the 52-week high -- a NEW high, which the course
 * distinguishes from mere short-covering off a low. Three read arms.
 */
export function shortSqueezeSetupReadV1(
  shortPctOfFloat: number | null | undefined,
  currentPrice: number | null | undefined,
  week52High: number | null | undefined,
  tolerance?: number | null,
): ShortSqueezeRead | null {
  if (shortPctOfFloat == null || currentPrice == null || week52High == null) return null;
  const tol = tolerance == null ? 0.03 : tolerance;
  const tier = shortInterestTierV1(shortPctOfFloat);
  const atNewHigh = currentPrice >= week52High * (1 - tol);
  const SQUEEZE_MIN_SHORT_PCT = 0.20;
  const isSqueezeSetup = shortPctOfFloat > SQUEEZE_MIN_SHORT_PCT && atNewHigh;
  return {
    isSqueezeSetup, tier, atNewHigh, shortPctOfFloat,
    read: isSqueezeSetup
      ? ('High short interest (' + (shortPctOfFloat * 100).toFixed(1) + '% of float, ' + tier + ') breaking to a NEW high — matches the course\'s Short Squeeze setup, explicitly distinguished from mere short-covering off a low (ep.9, reinforced live in ep.13\'s real GME case study)')
      : atNewHigh
        ? ('At a new high, but short interest (' + (shortPctOfFloat * 100).toFixed(1) + '%) is below the course\'s "getting interesting" tier — not a squeeze setup')
        : ('Short interest ' + tier + ', but not currently at a new high — bouncing off a low is short-covering, not the same mechanism as a squeeze (ep.9)'),
  };
}

export interface VixAndSqueezeRead {
  readonly evidence: string[];
  readonly isSqueezeSetup: boolean;
  readonly shortInterestCoverage: string;
}

/** Orphaned wrapper -- see the header. `isSqueezeSetup` is false, not null, when data is missing. */
export function vixAndSqueezeReadV1(
  vixLevel: number | null | undefined,
  shortPctOfFloat: number | null | undefined,
  currentPrice: number | null | undefined,
  week52High: number | null | undefined,
): VixAndSqueezeRead {
  const vix = vixRegimeReadV1(vixLevel);
  const squeeze = shortSqueezeSetupReadV1(shortPctOfFloat, currentPrice, week52High);
  const evidence: string[] = [];
  if (vix) evidence.push(vix.read);
  if (squeeze) evidence.push(squeeze.read);
  return {
    evidence,
    isSqueezeSetup: squeeze ? squeeze.isSqueezeSetup : false,
    shortInterestCoverage: 'Nasdaq-listed tickers only (verified live) — NYSE/other-exchange tickers need a different real data source, not currently wired in',
  };
}
