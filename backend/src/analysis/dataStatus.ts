/**
 * The analysis run's per-source data-health record, ported exactly:
 *   newDataStatusV7 :611-649, setStatusV7 :651-653 (fullStockAnalysisV10_9.gs)
 * state is 'ok' | 'degraded' | 'failed' | 'pending'. The run fills it; the
 * dashboard's status banner and the failure sheet render it (FL-7b).
 * core/status.ts is the Phase-1 run-wide accumulator; this is the legacy
 * per-ticker record the reports read, kept key for key.
 */

import type { ReasonCode } from '../reports/messages/catalog.ts';

export type DataState = 'ok' | 'degraded' | 'failed' | 'pending';

export interface DataStatusEntry {
  readonly label: string;
  state: DataState | string;
  detail: string;
  /** FL-9c: why the source has the state it has. Reports show reasonLine(reasonCode), never `detail`. Optional. */
  reasonCode?: ReasonCode;
}

export const DATA_STATUS_KEYS = [
  'price', 'fundamentals', 'series', 'peers', 'spyRS', 'indicators', 'gann', 'confluence', 'options', 'aiReview',
  'macroRegime', 'institutionalHoldings', 'brokerModel', 'schabackerModel', 'edwardsMageeModel', 'turtleModel', 'comparisonReport',
  'darkPool', 'playerMapping', 'zombieCompanyScreen', 'dilutionScreen',
] as const;

export type DataStatusKey = (typeof DATA_STATUS_KEYS)[number];
export type DataStatus = Record<DataStatusKey, DataStatusEntry>;

const LABELS: Readonly<Record<DataStatusKey, string>> = {
  price: 'Price (OHLCV)', fundamentals: 'Fundamentals', series: 'Finnhub series', peers: 'Peer comparison', spyRS: 'SPY / Relative Str.',
  indicators: 'Technical indicators', gann: 'Gann levels', confluence: 'Entry/exit zones', options: 'Options overlay', aiReview: 'AI narrative',
  macroRegime: 'Macro regime', institutionalHoldings: 'Institutional holdings (13F)', brokerModel: 'Broker-course model report',
  schabackerModel: 'Schabacker model report', edwardsMageeModel: 'Edwards & Magee model report', turtleModel: 'Turtle model report',
  comparisonReport: 'Model comparison report', darkPool: 'Dark pool share (FINRA)', playerMapping: 'Player Mapping (Broker Course)',
  zombieCompanyScreen: 'Zombie Company Screen (Broker Course)', dilutionScreen: 'Dilution/Filing-Keyword Screen (Broker Course)',
};

/** newDataStatusV7 (:611-649): every source 'pending'. */
export function newDataStatus(): DataStatus {
  const out = {} as DataStatus;
  for (const k of DATA_STATUS_KEYS) out[k] = { label: LABELS[k], state: 'pending', detail: '' };
  return out;
}

/** setStatusV7 (:651-653): an unknown key (or no status) is ignored. */
export function setStatus(status: Partial<Record<string, DataStatusEntry>> | null | undefined, key: string, state: DataState | string, detail?: string | null, reasonCode?: ReasonCode): void {
  if (status && status[key]) {
    const entry = status[key] as DataStatusEntry;
    entry.state = state; entry.detail = detail || '';
    if (reasonCode) entry.reasonCode = reasonCode; else delete entry.reasonCode;
  }
}
