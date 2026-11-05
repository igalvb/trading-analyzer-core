/**
 * Fundamentals shapes, as the legacy fetch layer builds them
 * (dataLayerV1.gs:58-117, :405-674, :1051-1292).
 *
 * Every field is nullable because every provider can be missing it; a
 * merged field is whatever the first provider in that field's precedence
 * order had (see fetch/fundamentals/merge.ts). Nothing is defaulted.
 */

import type { FinnhubMetricSeries } from '../fetch/finnhubSeries.ts';

/** One provider's normalised result (fetchFMPFundamentals / fetchAlphaVantageFundamentals / fetchFinnhubFundamentals). */
export interface ProviderFundamentals {
  readonly _source: 'fmp' | 'alphavantage' | 'finnhub';
  readonly forwardPE: number | null;
  readonly trailingPE: number | null;
  readonly pegRatio: number | null;
  readonly priceToBook: number | null;
  readonly profitMargins: number | null;
  readonly grossMargins: number | null;
  readonly returnOnEquity: number | null;
  readonly returnOnAssets: number | null;
  readonly revenueGrowth: number | null;
  readonly earningsGrowth: number | null;
  readonly beta: number | null;
  readonly marketCap: number | null;
  /** Finnhub and Alpha Vantage only. */
  readonly shareFloat?: number | null;
  readonly dividend: number | null;
  readonly price: number | null;
  readonly sector: string | null;
  readonly industry: string | null;
  readonly targetMean: number | null;
  readonly targetHigh: number | null;
  readonly targetLow: number | null;
  readonly numAnalysts: number | null;
  readonly recMean: number | null;
  readonly recKey: string;
  readonly strongBuy: number;
  readonly buy: number;
  readonly hold: number;
  readonly sell: number;
  readonly strongSell: number;
  readonly shortRatio: null;
  readonly institutionPct: null;
  /** FMP only (balance-sheet health). */
  readonly debtToEquity?: number | null;
  readonly currentRatio?: number | null;
  readonly quickRatio?: number | null;
  readonly fcfPerShare?: number | null;
  readonly _premiumBlocked: boolean;
  readonly _rateLimited: boolean;
  /** D18: the profile's company name; only with FundamentalsDeps.withCompanyName. */
  readonly _companyName?: string;
}

export type FundSourceName = 'FMP' | 'AV' | 'Finnhub';

export interface CrossRefCV {
  readonly cv: number;
  readonly band: 'fine' | 'shaky' | 'untrustworthy';
}

export interface EarningsNext {
  readonly date: Date;
  readonly dateStr: string;
}

export interface EarningsReport {
  readonly date: Date;
  readonly raw: string;
  readonly epsActual: number | null;
  readonly epsEstimated: number | null;
  readonly revenueActual: number | null;
  readonly revenueEstimated: number | null;
}

export interface EarningsCalendar {
  readonly next: EarningsNext | null;
  readonly history: EarningsReport[];
}

export interface InsiderTradingNet {
  readonly sharesAcquired: number;
  readonly sharesDisposed: number;
  readonly netShares: number;
  readonly purchaseCount: number;
  readonly saleCount: number;
  readonly transactionsAnalyzed: number;
  readonly netBuying: boolean;
}

export interface TreasuryRate10Y {
  readonly year10: number;
  readonly date: unknown;
}

/**
 * gatherFundamentals' merged result, plus what gatherFundamentalsV7 adds.
 * Mutable on purpose: legacy attaches the calendar, insider, treasury,
 * series and peers fields after the merge.
 */
export interface MergedFundamentals {
  _source: 'merged';
  forwardPE: number | null;
  trailingPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  profitMargins: number | null;
  grossMargins: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  beta: number | null;
  marketCap: number | null;
  dividend: number | null;
  price: number | null;
  sector: string | null;
  industry: string | null;
  targetMean: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  numAnalysts: number | null;
  recMean: number | null;
  recKey: string | null;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
  shortRatio: null;
  institutionPct: null;
  debtToEquity: number | null;
  currentRatio: number | null;
  fcfPerShare: number | null;
  quickRatio: number | null;
  shareFloat: number | null;
  _premiumBlocked: boolean;
  _rateLimited: boolean;
  _sources: FundSourceName[];
  _crossRef: string[] | null;
  _crossRefCV: Record<string, CrossRefCV>;
  _nextEarnings?: EarningsNext | null;
  _earningsHistory?: EarningsReport[];
  _insiderTrading?: InsiderTradingNet | null;
  _treasuryRate10Y?: TreasuryRate10Y | null;
  /** gatherFundamentalsV7: Finnhub's metric series, or null. */
  _metricSeries?: FinnhubMetricSeries | null;
  /** gatherFundamentalsV7: peers, self excluded, capped at 5, or null. */
  _peersRaw?: string[] | null;
  /** D18: the profile's company name (FundamentalsDeps.withCompanyName only). */
  _companyName?: string;
}

export interface GatherResult {
  readonly fund: MergedFundamentals | null;
  readonly source: string;
}

/** fetchPeerBasicMetricsV7's per-peer record (dataLayerV1.gs:107-113). */
export interface PeerBasicMetrics {
  readonly revenueGrowth: number | null;
  readonly grossMargins: number | null;
  readonly netMargin: number | null;
  readonly fcfMargin: number | null;
  readonly evSales: number | null;
}
