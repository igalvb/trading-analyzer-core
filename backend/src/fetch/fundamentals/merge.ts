/**
 * gatherFundamentals (dataLayerV1.gs:405-582): call the three providers,
 * merge them field by field, cross-check where they disagree, and attach
 * the earnings calendar, insider net and 10-year treasury rate.
 *
 * The merge (mergeProviderFundamentals) is pure and ported line for line:
 *  - precedence: targets FMP -> AV -> Finnhub; ratings Finnhub -> AV -> FMP;
 *    everything else FMP -> Finnhub -> AV. A null or '' is skipped; a 0 is
 *    a value;
 *  - `_sources` names a provider only if it has one of seven headline fields;
 *  - eight cross-checks produce `_crossRef` text where sources disagree, and
 *    every field with 2+ numeric sources gets a coefficient of variation
 *    (`_crossRefCV`, banded fine < 0.10 <= shaky < 0.25 <= untrustworthy).
 *
 * The time-budget gates around each call (hasTimeBudgetSafe_ and the
 * "⏭ Skipped" log of skipLog_, :440-441) are NOT ported: per the user's
 * rule the 6-minute budget check is replaced by per-request timeouts, and
 * every gated call is always made -- which is also what the oracle does
 * (its run-start time is unset, so every budget check passes).
 */

import type { FundamentalsDeps, FundLog } from './providers.ts';
import {
  fetchAlphaVantageFundamentals, fetchFinnhubFundamentals, fetchFMPFundamentals,
  fetchEarningsCalendar, fetchInsiderTradingNet, fetchTreasuryRate10Y, nowOf,
} from './providers.ts';
import { localeDateLabel } from '../../core/dates.ts';
import type {
  ProviderFundamentals, MergedFundamentals, CrossRefCV, GatherResult, FundSourceName,
} from '../../types/fundamentals.ts';

const TARGET: Readonly<Record<string, 1>> = { targetMean: 1, targetHigh: 1, targetLow: 1 };
const RATING: Readonly<Record<string, 1>> = { recMean: 1, recKey: 1, numAnalysts: 1, strongBuy: 1, buy: 1, hold: 1, sell: 1, strongSell: 1 };

/** The merged fields, in legacy's order (dataLayerV1.gs:465-478). */
export const MERGED_FIELDS: readonly string[] = [
  'forwardPE', 'trailingPE', 'pegRatio', 'priceToBook', 'profitMargins', 'grossMargins', 'returnOnEquity', 'returnOnAssets',
  'revenueGrowth', 'earningsGrowth', 'beta', 'marketCap', 'dividend', 'price', 'sector', 'industry', 'targetMean', 'targetHigh',
  'targetLow', 'numAnalysts', 'recMean', 'recKey', 'strongBuy', 'buy', 'hold', 'sell', 'strongSell', 'shortRatio', 'institutionPct',
  'debtToEquity', 'currentRatio', 'fcfPerShare', 'quickRatio',
  'shareFloat',
];

type Differ = (a: number, b: number) => boolean;

/** The eight cross-checks (dataLayerV1.gs:500-509). */
const CHECKS: ReadonlyArray<readonly [string, string, Differ]> = [
  ['P/E (trailing)', 'trailingPE', (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)) > 0.4],
  ['P/E (forward)', 'forwardPE', (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)) > 0.4],
  ['Net margin', 'profitMargins', (a, b) => Math.abs(a - b) > 0.10],
  ['Rev growth', 'revenueGrowth', (a, b) => Math.abs(a - b) > 0.10],
  ['ROE', 'returnOnEquity', (a, b) => Math.abs(a - b) > 0.15],
  ['Beta', 'beta', (a, b) => Math.abs(a - b) > 0.2],
  ['Analyst target', 'targetMean', (a, b) => Math.abs(a - b) / Math.max(1, a, b) > 0.15],
  ['Rating', 'recMean', (a, b) => Math.abs(a - b) > 0.7],
];

/** computeCV_ (:516-522): population stdev / |mean|; null under 2 values or a zero mean. */
export function coefficientOfVariation(nums: readonly number[]): number | null {
  if (nums.length < 2) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return null;
  const variance = nums.reduce((s, n) => s + (n - mean) * (n - mean), 0) / nums.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** classifyCV_ (:523-526). */
export function classifyCV(cv: number | null): CrossRefCV['band'] | null {
  if (cv == null) return null;
  return cv < 0.10 ? 'fine' : cv < 0.25 ? 'shaky' : 'untrustworthy';
}

/**
 * The merge half of gatherFundamentals (:453-555). Null when no provider
 * returned anything -- legacy then returns { fund: null, source: 'none' }
 * and makes none of the three side calls.
 */
export function mergeProviderFundamentals(
  fmp: ProviderFundamentals | null,
  av: ProviderFundamentals | null,
  fh: ProviderFundamentals | null,
): MergedFundamentals | null {
  const present = [fmp, av, fh].filter(Boolean);
  if (present.length === 0) return null;

  const defOrder = [fmp, fh, av].filter(Boolean);
  const targetOrder = [fmp, av, fh].filter(Boolean);
  const ratingOrder = [fh, av, fmp].filter(Boolean);
  const first = (order: Array<ProviderFundamentals | null>, k: string): unknown => {
    for (const o of order) if (o && (o as any)[k] != null && (o as any)[k] !== '') return (o as any)[k];
    return null;
  };

  const fund: Record<string, unknown> = { _source: 'merged' };
  MERGED_FIELDS.forEach((k) => {
    fund[k] = first(TARGET[k] ? targetOrder : RATING[k] ? ratingOrder : defOrder, k);
  });
  fund._premiumBlocked = fmp ? fmp._premiumBlocked : false;
  fund._rateLimited = fmp ? fmp._rateLimited : false;
  const companyName = (fmp && fmp._companyName) || (fh && fh._companyName) || (av && av._companyName);
  if (companyName) fund._companyName = companyName;

  const has = (f: ProviderFundamentals | null): unknown =>
    f && (f.forwardPE != null || f.trailingPE != null || f.revenueGrowth != null || f.returnOnEquity != null || f.targetMean != null || f.recMean != null || f.profitMargins != null);
  const named = ([['FMP', fmp], ['AV', av], ['Finnhub', fh]] as Array<[FundSourceName, ProviderFundamentals | null]>).filter((x) => has(x[1]));
  fund._sources = named.map((x) => x[0]);

  const crossRefCV: Record<string, CrossRefCV> = {};
  const crossRef: string[] = [];
  CHECKS.forEach(([label, key, differ]) => {
    const vals = ([['FMP', fmp], ['AV', av], ['Finnhub', fh]] as Array<[string, ProviderFundamentals | null]>)
      .filter((x) => x[1] && (x[1] as any)[key] != null)
      .map((x) => [x[0], (x[1] as any)[key]] as [string, any]);
    if (vals.length >= 2) {
      const nums = vals.map((v) => Number(v[1])).filter(Number.isFinite);
      const cv = coefficientOfVariation(nums);
      if (cv != null) crossRefCV[key] = { cv, band: classifyCV(cv) as CrossRefCV['band'] };
      let disagree = false;
      for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) if (differ(nums[i], nums[j])) disagree = true;
      if (disagree) {
        const isPct = /margin|growth|ROE/i.test(label);
        const periodNote = (key === 'revenueGrowth') ? '  [periods differ: FMP=annual, Finnhub=TTM, AV=quarterly — not directly comparable]' : '';
        crossRef.push(label + ': ' + vals.map((v) => v[0] + ' ' + (isPct ? (v[1] * 100).toFixed(0) + '%' : Math.abs(v[1]) >= 100 ? Math.round(v[1]) : v[1].toFixed(2))).join(' vs ') + periodNote);
      }
    }
  });
  fund._crossRef = crossRef.length ? crossRef : null;
  fund._crossRefCV = crossRefCV;
  return fund as unknown as MergedFundamentals;
}

/** gatherFundamentals (dataLayerV1.gs:405-582). */
export async function gatherFundamentals(deps: FundamentalsDeps, ticker: string, log?: FundLog): Promise<GatherResult> {
  let av: ProviderFundamentals | null = null;
  if (typeof deps.keys.alphaVantage === 'string' && deps.keys.alphaVantage) {
    if (log) log('📡 Alpha Vantage fundamentals...');
    av = await fetchAlphaVantageFundamentals(deps, ticker, log);
  }
  let fh: ProviderFundamentals | null = null;
  if (typeof deps.keys.finnhub === 'string' && deps.keys.finnhub) {
    if (log) log('📡 Finnhub fundamentals...');
    fh = await fetchFinnhubFundamentals(deps, ticker, log);
  }
  const fmp = await fetchFMPFundamentals(deps, ticker, log);

  const fund = mergeProviderFundamentals(fmp, av, fh);
  if (!fund) return { fund: null, source: 'none' };

  const earningsCalendar = await fetchEarningsCalendar(deps, ticker, log);
  fund._nextEarnings = earningsCalendar.next;
  fund._earningsHistory = earningsCalendar.history;
  fund._insiderTrading = await fetchInsiderTradingNet(deps, ticker, log);
  fund._treasuryRate10Y = await fetchTreasuryRate10Y(deps, log);

  const label = (deps.dateLabel ?? ((d: Date): string => localeDateLabel(d, deps.timeZone)))(new Date(nowOf(deps)));
  const source = (fund._sources.length ? fund._sources.join(' + ') : 'profile-only') + ' fresh ' + label;
  return { fund, source };
}
