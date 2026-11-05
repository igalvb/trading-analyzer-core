/**
 * FL-8o: the correlated-group concept (plan section 3.2). First and only member group: the spot Bitcoin ETFs.
 *
 * What is shared and what never is:
 *  - SHARED once per run: the scale-invariant technical thesis (regime, trend, bounded oscillators, chart-pattern
 *    names), computed from ONE anchor series.
 *  - NEVER shared: every dollar level (stop, targets, Gann levels, highest high since entry), fundamentals, 13F,
 *    options, position specifics. Those stay per ticker (src/jobs/exit/exitPipeline.ts computes them from each
 *    holding's own chart).
 * Membership is hardcoded (scope discipline); the tickers are ordinary NYSE Arca securities and are analysed
 * normally. BTC here is the Grayscale Bitcoin Mini Trust ETF, never the BTC-USD pair. The anchor is Bitcoin's own
 * price (BTC-USD) if it can be fetched, else IBIT. It is deliberately NEVER GBTC, whose premium/discount history
 * makes it the least representative of the five. The ETFs track closely but not identically (fees cause slow
 * divergence); this is a reasoned, disclosed approximation for trend / pattern / regime purposes.
 */
import type { Chart } from '../../types/chart.ts';
import { computeTechnicalRead } from '../../analysis/pipeline.ts';

export interface AnchorCandidate { readonly symbol: string; readonly kind: 'UNDERLYING' | 'ETF' }

export interface CorrelatedGroup {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
  /** Tried in order; the first whose chart and thesis can be computed wins. */
  readonly anchors: readonly AnchorCandidate[];
}

import { BITCOIN_ETF_TICKERS } from '../../types/bitcoinEtfs.ts';

export const BITCOIN_ETF_GROUP: CorrelatedGroup = {
  id: 'bitcoin-etfs',
  label: 'Bitcoin-tracking ETFs',
  members: [...BITCOIN_ETF_TICKERS],
  anchors: [{ symbol: 'BTC-USD', kind: 'UNDERLYING' }, { symbol: 'IBIT', kind: 'ETF' }],
};

export const DEFAULT_CORRELATED_GROUPS: readonly CorrelatedGroup[] = [BITCOIN_ETF_GROUP];

export interface ResolvedGroup {
  readonly group: CorrelatedGroup;
  /** Members actually present in the holdings, in the group's own order. */
  readonly present: readonly string[];
  /** True only when two or more members are held; a lone member just uses its own read. */
  readonly shared: boolean;
}

export function resolveGroups(tickers: Iterable<string>, groups: readonly CorrelatedGroup[] = DEFAULT_CORRELATED_GROUPS): ResolvedGroup[] {
  const held = new Set<string>();
  for (const t of tickers) held.add(String(t).trim().toUpperCase());
  const out: ResolvedGroup[] = [];
  for (const g of groups) {
    const present = g.members.filter((m) => held.has(m));
    if (present.length > 0) out.push({ group: g, present, shared: present.length >= 2 });
  }
  return out;
}

/** The one plain sentence required in every affected holding's section. */
export function sharedThesisDisclosure(rg: ResolvedGroup): string {
  return 'Technical read shared across ' + rg.group.label + ' (' + rg.present.join(', ') + '), since they track the same underlying asset. '
    + 'Your stop, targets, fundamentals, and position details below are specific to this holding.';
}

/** Only scale-invariant fields: nothing here is a dollar level. */
export interface SharedThesisCore {
  readonly regime: string | null;
  readonly rsi14: number | null;
  readonly rsiWeekly: number | null;
  readonly stochRsi: number | null;
  readonly weeklyTrend: unknown;
  readonly trendMaturity: unknown;
  readonly patternTypes: readonly string[];
}

export interface SharedThesis extends SharedThesisCore {
  readonly groupId: string;
  readonly anchorSymbol: string;
  readonly anchorKind: 'UNDERLYING' | 'ETF';
  /** True when the first-choice anchor was not used. */
  readonly usedFallbackAnchor: boolean;
  readonly narrative: string;
  readonly disclosure: string;
}

const REGIME_TEXT: Readonly<Record<string, string>> = {
  TREND_UP: 'trending up', TREND_DOWN: 'trending down', CHOP: 'moving sideways', HIGH_VOL: 'swinging widely without a clear direction',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Default thesis extractor: runs the ported technical read on the anchor chart and keeps only scale-invariant fields. */
export function defaultScaleInvariantThesis(chart: Chart): SharedThesisCore {
  const t = computeTechnicalRead(chart);
  const ind = t.indicators as unknown as Record<string, unknown>;
  const patterns = Array.isArray(ind['chartPatterns']) ? (ind['chartPatterns'] as Array<Record<string, unknown>>) : [];
  return {
    regime: typeof t.core.regime === 'string' ? t.core.regime : null,
    rsi14: num(ind['rsi14']),
    rsiWeekly: num(ind['rsiWeekly']),
    stochRsi: num(ind['stochRsi']),
    weeklyTrend: ind['weeklyTrend'] ?? null,
    trendMaturity: ind['trendMaturity'] ?? null,
    patternTypes: patterns.map((p) => String(p['type'])).filter((s) => s && s !== 'undefined'),
  };
}

export function buildSharedThesis(rg: ResolvedGroup, anchor: AnchorCandidate, index: number, core: SharedThesisCore): SharedThesis {
  const regimeText = core.regime ? (REGIME_TEXT[core.regime] ?? 'in an unclassified state') : 'in an unclassified state';
  const bits = ['The shared trend read says the group is ' + regimeText + '.'];
  if (core.rsiWeekly !== null) bits.push('Weekly RSI is ' + core.rsiWeekly.toFixed(0) + '.');
  if (core.rsi14 !== null) bits.push('Daily RSI is ' + core.rsi14.toFixed(0) + '.');
  if (core.patternTypes.length) bits.push(core.patternTypes.length + ' chart pattern' + (core.patternTypes.length === 1 ? '' : 's') + ' detected on the shared series.');
  return {
    ...core, groupId: rg.group.id, anchorSymbol: anchor.symbol, anchorKind: anchor.kind, usedFallbackAnchor: index > 0,
    narrative: bits.join(' '), disclosure: sharedThesisDisclosure(rg),
  };
}
