/**
 * The analysis run's data-quality subjects: for each dataStatus key (and each
 * fetch-step key), the plain label and the fixed EFFECT the report shows when
 * that source is missing. The sentences themselves come from the one report
 * catalog (src/reports/messages/catalog.ts: reason codes, EFFECTS,
 * dataQualityLine); nothing here builds report text of its own.
 */

import type { EffectCode, QualityItem, ReasonCode } from '../reports/messages/catalog.ts';

export interface StatusSubject {
  readonly label: string;
  readonly effect: EffectCode;
}

export const STATUS_SUBJECTS: Readonly<Record<string, StatusSubject>> = {
  price: { label: 'Price history', effect: 'SECTION_LEFT_OUT' },
  fundamentals: { label: 'Fundamentals', effect: 'PRICE_CHART_ONLY' },
  series: { label: 'Quarterly trend data', effect: 'LOWER_CONFIDENCE' },
  peers: { label: 'Peer comparison', effect: 'LOWER_CONFIDENCE' },
  spyRS: { label: 'S&P 500 comparison', effect: 'LOWER_CONFIDENCE' },
  sector: { label: 'Sector comparison', effect: 'SOURCE_LEFT_OUT' },
  vix: { label: 'Market volatility (VIX)', effect: 'SOURCE_LEFT_OUT' },
  longRange: { label: 'Ten-year price history', effect: 'SOURCE_LEFT_OUT' },
  options: { label: 'Options snapshot', effect: 'SOURCE_LEFT_OUT' },
  aiReview: { label: 'AI narrative', effect: 'NO_AI_SUMMARY' },
  macroRegime: { label: 'Market regime read', effect: 'SOURCE_LEFT_OUT' },
  institutionalHoldings: { label: 'Institutional holdings', effect: 'SOURCE_LEFT_OUT' },
  darkPool: { label: 'Dark pool share', effect: 'SOURCE_LEFT_OUT' },
  zombieCompanyScreen: { label: 'Interest-coverage check', effect: 'SOURCE_LEFT_OUT' },
  dilutionScreen: { label: 'Share-dilution check', effect: 'SOURCE_LEFT_OUT' },
  playerMapping: { label: 'Player-mapping read', effect: 'SOURCE_LEFT_OUT' },
  brokerModel: { label: 'Broker-course model', effect: 'SECTION_LEFT_OUT' },
  schabackerModel: { label: 'Schabacker model', effect: 'SECTION_LEFT_OUT' },
  edwardsMageeModel: { label: 'Edwards & Magee model', effect: 'SECTION_LEFT_OUT' },
  turtleModel: { label: 'Turtle model', effect: 'SECTION_LEFT_OUT' },
  comparisonReport: { label: 'Model comparison', effect: 'SECTION_LEFT_OUT' },
  indicators: { label: 'Technical indicators', effect: 'SECTION_LEFT_OUT' },
  gann: { label: 'Gann levels', effect: 'SECTION_LEFT_OUT' },
  confluence: { label: 'Entry and exit zones', effect: 'SECTION_LEFT_OUT' },
};

/** F-H5: a source still 'pending' after the run never ran. macroRegime stays out (F-11: a blocked ticker never writes it). */
export const PENDING_MEANS_NOT_RUN: readonly string[] = Object.keys(STATUS_SUBJECTS).filter((k) => k !== 'macroRegime');
/** The same, when the dashboard is drawn: the 13F step and the model reports that run after the dashboard are still to come. */
export const PENDING_BEFORE_DASHBOARD: readonly string[] = PENDING_MEANS_NOT_RUN.filter(
  (k) => !['institutionalHoldings', 'schabackerModel', 'edwardsMageeModel', 'turtleModel', 'comparisonReport'].includes(k));

/** A QualityItem keyed by its source, so later knowledge (e.g. a saved copy) can replace an earlier item. */
export interface KeyedQuality {
  readonly key: string;
  readonly item: QualityItem;
}

export function qualityFor(key: string, reasonCode: ReasonCode, now: Date, over: { readonly label?: string; readonly effect?: EffectCode; readonly savedDate?: Date } = {}): KeyedQuality {
  const s = STATUS_SUBJECTS[key];
  return {
    key,
    item: {
      label: over.label ?? s?.label ?? key,
      reasonCode,
      effect: over.effect ?? s?.effect ?? 'SOURCE_LEFT_OUT',
      ...(over.savedDate ? { savedDate: over.savedDate } : {}),
      now,
    },
  };
}

export interface StatusLikeEntry { readonly state?: string; readonly reasonCode?: ReasonCode }

export interface StatusQualityOptions {
  /** The keys to read, in report order. Keys without a STATUS_SUBJECTS entry are left out. */
  readonly order: readonly string[];
  /** Keys the caller already has a better item for (a fetch step's real reason). */
  readonly skip?: ReadonlySet<string>;
  /** Keys whose 'pending' state means the step never ran (PENDING_MEANS_NOT_RUN / PENDING_BEFORE_DASHBOARD). */
  readonly pendingNotRun?: readonly string[];
}

/**
 * The data-quality items of a status record: every failed or degraded source (default reason NO_DATA_FOR_TICKER),
 * every skipped one (F-H5: legacy's lists dropped nothing, the old data-quality box dropped skipped; default reason
 * NOT_RUN), and every `pendingNotRun` source still 'pending' (NOT_RUN). One calculation for the CLI box, the dashboard
 * box and the Buy/Exit data-health lines.
 */
export function statusQualityItems(
  status: Readonly<Record<string, StatusLikeEntry | null | undefined>> | null | undefined, now: Date, opts: StatusQualityOptions,
): KeyedQuality[] {
  const out: KeyedQuality[] = [];
  if (!status) return out;
  for (const k of opts.order) {
    const s = status[k];
    if (!s || !STATUS_SUBJECTS[k] || (opts.skip && opts.skip.has(k))) continue;
    if (s.state === 'failed' || s.state === 'degraded') out.push(qualityFor(k, s.reasonCode ?? 'NO_DATA_FOR_TICKER', now));
    else if (s.state === 'skipped') out.push(qualityFor(k, s.reasonCode ?? 'NOT_RUN', now));
    else if (s.state === 'pending' && opts.pendingNotRun && opts.pendingNotRun.includes(k)) out.push(qualityFor(k, 'NOT_RUN', now));
  }
  return out;
}
