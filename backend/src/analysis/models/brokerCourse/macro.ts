/**
 * Broker Course Phase 9 -- macro overlay (:1655-1712, 3 functions;
 * episode 13's rates-vs-valuations relationship).
 *
 * Direction is the plain sign of last minus first over the caller's window
 * -- no magnitude threshold, because the course gives none. The two trend
 * reads are identical apart from their text. Production windows are the
 * last 20 10-year yields and the last 12 Fed Funds rates (:2102).
 *
 * `gdpSeries` and `interestCoverageRatio` are three-state like Phase 6's
 * params: absent gives the "Not available — course names..." disclosure,
 * null gives the fetch-failed text. The cycle phase always enters
 * evidence when computed; the zombie read only when it flags.
 */

import { businessCyclePhaseReadV1, zombieCompanyScreenV1 } from './screens.ts';

export interface RateTrendRead {
  readonly direction: 'rising' | 'falling' | 'flat';
  readonly change: number;
  readonly current: number;
  readonly read: string;
}

export function treasuryYieldTrendReadV1(recentYields: readonly number[] | null | undefined): RateTrendRead | null {
  if (!recentYields || recentYields.length < 2) return null;
  const first = recentYields[0];
  const last = recentYields[recentYields.length - 1];
  const change = last - first;
  const direction = change > 0 ? 'rising' : (change < 0 ? 'falling' : 'flat');
  return {
    direction, change, current: last,
    read: direction === 'rising'
      ? ('10-year Treasury yield rising (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — historically reads as the market pricing in higher inflation expectations, compressing equity valuations especially for high-multiple/growth names (ep.13)')
      : direction === 'falling'
        ? ('10-year Treasury yield falling (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — historically supportive of equity valuations, the reverse of the rising-rate read (ep.13)')
        : '10-year Treasury yield flat over this window — no directional macro read',
  };
}

export function fedFundsTrendReadV1(recentRates: readonly number[] | null | undefined): RateTrendRead | null {
  if (!recentRates || recentRates.length < 2) return null;
  const first = recentRates[0];
  const last = recentRates[recentRates.length - 1];
  const change = last - first;
  const direction = change > 0 ? 'rising' : (change < 0 ? 'falling' : 'flat');
  return {
    direction, change, current: last,
    read: direction === 'rising'
      ? ('Fed Funds Rate rising (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — tighter monetary policy, historically pressures equity valuations (ep.13)')
      : direction === 'falling'
        ? ('Fed Funds Rate falling (' + first.toFixed(2) + '% -> ' + last.toFixed(2) + '%) — easing monetary policy, historically supportive of equity valuations (ep.13)')
        : 'Fed Funds Rate flat over this window — no directional macro read',
  };
}

export interface MacroOverlay {
  readonly evidence: string[];
  readonly businessCyclePhase: string;
  readonly zombieCompanyScreen: string;
}

export function macroOverlayReadV1(
  recentYields: readonly number[] | null | undefined,
  recentRates: readonly number[] | null | undefined,
  gdpSeries?: readonly number[] | null,
  interestCoverageRatio?: number | null,
): MacroOverlay {
  const yieldTrend = treasuryYieldTrendReadV1(recentYields);
  const fedTrend = fedFundsTrendReadV1(recentRates);
  const cyclePhase = gdpSeries !== undefined ? businessCyclePhaseReadV1(gdpSeries) : null;
  const zombieScreen = interestCoverageRatio !== undefined ? zombieCompanyScreenV1(interestCoverageRatio) : null;
  const evidence: string[] = [];
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
      : 'Not available — real concept, but not stated as a checkable rule (Phase 13: real via FMP\'s interest-coverage ratio + the standard academic zombie-company threshold when this param is supplied)',
  };
}
