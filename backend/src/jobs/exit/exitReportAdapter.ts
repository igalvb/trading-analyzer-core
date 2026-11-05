/**
 * FL-9d: pure adapter from the Exit pipeline's result to the Exit sheet's input (exitSheet/types.ts).
 *
 * Rules:
 *  - Every sheet field is populated or explicitly null; `failed` is present only when the holding has no verdict.
 *  - A failed / skipped holding stays in the list (the sheet shows it as "No verdict" with the catalog sentence).
 *  - The sheet ranks holdings from the prefix of signals.summary (EXIT / EXPIRED / REVIEW / CONSIDER / T1 / T2 / HOLD),
 *    so the pipeline's plain-English headline is re-prefixed with that word. The action class is NOT re-decided.
 *  - Raw read output (`read`), notes and skipped-row reasons are never copied. Any text that still trips the leak
 *    scanner is replaced by a fixed sentence.
 */
import type { BullPhaseAdvisory, ExitSignals } from '../../reports/exit/exitReport.ts';
import { REASON_CODES, reasonLine } from '../../reports/messages/catalog.ts';
import type { QualityItem, ReasonCode } from '../../reports/messages/catalog.ts';
import { findReportLeaks } from '../../reports/messages/leakScan.ts';
import { readsFrom } from '../../reports/adapters/modelReads.ts';
import type {
  ExitHoldingInput, ExitLevels, ExitReportInput, FundamentalsInput, ModelRead, OptionContractInput, PositionInput, PositioningInput, SharedThesisInput,
} from '../../reports/exitSheet/types.ts';
import { BITCOIN_ETF_GROUP } from './correlatedGroup.ts';
import type { ExitAnalysisBundle, ExitHoldingResult, ExitOptionResult, ExitPipelineResult, ExitStockResult } from './exitPipeline.ts';
import { OPTION_CONTRACT_MULTIPLIER } from '../../portfolio/exitTax.ts';
import { ASSUMED_ENTRY_BASIS } from '../../sheets/readers/portfolio.ts';
import type { HoldingSellPlan } from './sellPlans.ts';
import type { SellPlanView } from '../../reports/exitSheet/types.ts';

export interface ExitAdapterOptions {
  /** Default: the pipeline's start time. */
  readonly runAt?: Date;
  readonly advisory?: BullPhaseAdvisory | null;
  readonly advisoryUnavailable?: ReasonCode;
  readonly stockTableUnreadable?: boolean;
  readonly optionsTableUnreadable?: boolean;
  /** F-X2: the sell plan per holding (jobs/exit/sellPlans.ts). Absent = no sell-plan block. */
  readonly sellPlans?: ReadonlyMap<ExitHoldingResult, HoldingSellPlan>;
  /** F-X2: the Exit Target History tab could not be read or written. */
  readonly targetMemoryUnavailable?: boolean;
}

const SELL_PLAN_FALLBACK = 'See the exit levels above for the targets.';

function sellPlanOf(h: ExitHoldingResult, plans: ReadonlyMap<ExitHoldingResult, HoldingSellPlan> | undefined): SellPlanView | null {
  const p = plans ? plans.get(h) : undefined;
  if (!p) return null;
  return { lines: p.plan.lines.map((t) => clean(t, SELL_PLAN_FALLBACK)), memoryLine: p.memoryLine ? clean(p.memoryLine, '') || null : null };
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x : null);
const rec = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null);
const awayText = (d: unknown): string => { const n = num(d); return n != null && n > 0 ? ' (' + n.toFixed(1) + '% above the current price)' : ''; };
const techOf = (h: ExitHoldingResult): Record<string, unknown> | null => (h.read === null ? null : h.kind === 'OPTION' ? rec(h.read['technical']) : h.read);
const clean = (text: string, fallback: string): string => (findReportLeaks(text).length ? fallback : text);

/** The reason code a failed headline was built from (labelledReason(label, code) ends with reasonLine(code)). */
export function reasonCodeOfHeadline(headline: string): ReasonCode {
  let best: ReasonCode = 'SECTION_UNAVAILABLE';
  let bestLen = 0;
  for (const code of REASON_CODES) {
    const line = reasonLine(code);
    if (headline.endsWith(line) && line.length > bestLen) { best = code; bestLen = line.length; }
  }
  return best;
}

function failedCode(h: ExitHoldingResult): ReasonCode | null {
  // Audit #35: a put row says it is outside the long-only scope, not that a step did not run.
  if (h.status === 'SKIPPED') return h.kind === 'OPTION' && h.side === 'put' ? 'LONG_ONLY_NOT_COVERED' : 'NOT_RUN';
  if (h.status === 'FAILED' || h.actionClass === 'UNKNOWN') return reasonCodeOfHeadline(h.headline);
  return null;
}

const LEAD = /^(Exit|Expired|Review|Hold|Consider trimming): /;

/** The legacy-style summary the sheet ranks on, or null when the holding has no verdict. */
export function summaryOf(h: ExitHoldingResult): string | null {
  const body = clean(LEAD.test(h.headline) ? h.headline.slice(h.headline.indexOf(': ') + 2) : h.headline, 'see the exit levels below.');
  switch (h.actionClass) {
    case 'EXIT': return 'EXIT — ' + body;
    case 'EXPIRED': return 'EXPIRED — ' + body;
    case 'REVIEW': return 'REVIEW — ' + body;
    case 'HOLD': return 'HOLD — ' + body;
    case 'TRIM': return h.headline.startsWith('Consider trimming: ') ? 'CONSIDER TRIMMING — ' + body : (h.hitT2 ? 'T2 reached' : 'T1 reached') + ' — ' + body;
    default: return null;
  }
}

function signalsOf(h: ExitHoldingResult): ExitSignals | null {
  const summary = summaryOf(h);
  if (summary === null || h.read === null) return null;
  const tk = techOf(h);
  const targets = 'First target ' + (h.hitT1 ? 'reached' : 'not reached' + awayText(tk?.['distanceToT1Pct'])) + ', second target ' + (h.hitT2 ? 'reached' : 'not reached' + awayText(tk?.['distanceToT2Pct']));
  const base = {
    thesis: h.thesisInvalidated ? 'Broken' : 'Intact',
    stop: h.stopBreached ? 'Breached' : 'Holding',
    targets,
    confidence: h.confidence === 'REAL' ? 'Measured from your purchase date' : h.confidence === 'ASSUMED' ? ASSUMED_ENTRY_BASIS.charAt(0).toUpperCase() + ASSUMED_ENTRY_BASIS.slice(1) : 'Generic look-back, no usable purchase date',
    summary,
  };
  if (h.kind === 'OPTION') {
    const t = h.expiryTrigger;
    return { ...base, expiry: t.daysToExpiry != null ? t.daysToExpiry + ' days to expiry' + (t.triggered ? ', inside the warning window' : '') : 'Days to expiry unknown' };
  }
  return base;
}

function levelsOf(h: ExitHoldingResult): ExitLevels | null {
  if (h.read === null) return null;
  const tech = h.kind === 'OPTION' ? rec(h.read['technical']) : h.read;
  return {
    stopLevel: h.stopLevel,
    stopBasis: h.stopLevel == null ? null : h.weeklyStops ? 'WEEKLY' : h.confidence === 'REAL' ? 'SINCE_ENTRY' : h.confidence === 'ASSUMED' ? 'SINCE_ASSUMED_ENTRY' : h.confidence === 'GENERIC' ? 'GENERIC' : null,
    stopBreached: h.stopBreached, thesisInvalidated: h.thesisInvalidated,
    t1: h.t1, hitT1: h.hitT1, t2: h.t2, hitT2: h.hitT2,
    highestHighSinceEntry: tech ? num(tech['highestHighSinceEntry']) : null,
    ...(tech && 'distanceToT1Pct' in tech ? { distanceToT1Pct: num(tech['distanceToT1Pct']), distanceToT2Pct: num(tech['distanceToT2Pct']) } : {}),
    ...(h.weeklyStops ? {
      weeklyLines: h.weeklyStops.lines.map((t) => clean(t, 'See the weekly stop above.')),
      weeklyVotes: h.weeklyStops.votes.map((v) => ({ model: v.model, read: v.read, why: clean(v.why, 'see the model pages.') })),
    } : {}),
  };
}

function positionOf(h: ExitHoldingResult): PositionInput {
  const common = { entryDate: h.entryDate };
  if (h.kind === 'STOCK') return { quantity: h.shares, avgCost: h.avgCost, currentPrice: h.price, ...common, ...(h.entryDateAssumed ? { entryDateAssumed: true } : {}) };
  const q = h.contracts;
  const mv = h.tax.marketValueUsd;
  const premium = q != null && q > 0 && mv != null ? mv / (q * OPTION_CONTRACT_MULTIPLIER) : null;
  return { quantity: q, avgCost: h.avgPremium, currentPrice: premium, ...common };
}

function optionOf(h: ExitOptionResult): OptionContractInput | null {
  if (h.strike == null || h.expiry == null) return null;
  const t = h.expiryTrigger;
  return {
    right: h.side === 'put' ? 'PUT' : 'CALL', strike: h.strike, expiry: h.expiry,
    daysToExpiry: t.daysToExpiry, expiryThreshold: t.threshold, expiryWarning: t.triggered, underlyingPrice: h.price,
  };
}

function fundamentalsOf(h: ExitStockResult): FundamentalsInput | null {
  const a = h.analysis;
  if (!a) return null;
  const fr = rec(a.fundResult);
  const dec = rec(a.decision);
  if (!fr || num(fr['score']) === null) return { ownScore: null, band: null, unavailable: 'SECTION_UNAVAILABLE' };
  return { ownScore: num(fr['score']), band: str(dec?.['fundBand']) ?? str(fr['verdict']) };
}

function positioningOf(h: ExitStockResult): PositioningInput | null {
  const a = h.analysis;
  if (!a) return null;
  const p = rec(a.positioning);
  const empty = { institutionalHolders: null, darkPoolPct: null, shortInterestPct: null };
  if (!p) return { ...empty, unavailable: 'NOT_RUN' };
  const out = { institutionalHolders: num(p['institutionalHolders']), darkPoolPct: num(p['darkPoolPct']), shortInterestPct: num(p['shortInterestPct']) };
  if (out.institutionalHolders === null && out.darkPoolPct === null && out.shortInterestPct === null) return { ...out, unavailable: 'FIELD_MISSING' };
  return out;
}

/**
 * Row 35 (#37, G-6): the Score column. The comparison holds directions only, so the engine shows its own final conviction
 * and each book model its signal count (the models count signals; they do not score). Display only: no stance changes.
 */
export function withModelScores<T extends { models: ModelRead[] }>(reads: T, analysis: ExitAnalysisBundle): T {
  const conv = num(rec(analysis.decision)?.['finalConviction']);
  const sig = analysis.modelSignals ?? {};
  return {
    ...reads,
    models: reads.models.map((m) => {
      if (m.stance === 'UNAVAILABLE') return m;
      if (m.model === 'ENGINE' && conv != null) return { ...m, conviction: conv };
      const s = sig[m.model];
      return s && Number.isFinite(s.pro) && Number.isFinite(s.con) ? { ...m, signals: { pro: s.pro, con: s.con } } : m;
    }),
  };
}

function holdingOf(h: ExitHoldingResult, now: Date, opts: ExitAdapterOptions = {}): ExitHoldingInput {
  const failed = failedCode(h);
  const sellPlan = failed ? null : sellPlanOf(h, opts.sellPlans);
  const stock = h.kind === 'STOCK' ? h : null;
  const reads = stock?.analysis ? withModelScores(readsFrom(rec(stock.analysis)?.['modelReads'], stock.analysis.comparison), stock.analysis) : { models: [], comparison: null };
  const health: QualityItem[] = [...h.dataQuality];
  if (h.kind === 'OPTION' && h.side === 'put') health.push({ label: 'Put position (long calls only)', reasonCode: 'LONG_ONLY_NOT_COVERED', effect: 'SECTION_LEFT_OUT', now });
  return {
    ticker: h.ticker,
    kind: h.kind,
    position: positionOf(h),
    option: h.kind === 'OPTION' ? optionOf(h) : null,
    signals: failed ? null : signalsOf(h),
    levels: failed ? null : levelsOf(h),
    models: reads.models,
    comparison: reads.comparison,
    ...(stock?.analysis && stock.analysis.extraModels != null ? { extraModels: stock.analysis.extraModels } : {}),
    fundamentals: stock ? fundamentalsOf(stock) : null,
    positioning: stock ? positioningOf(stock) : null,
    correlatedGroup: h.sharedThesis && h.sharedThesis.groupId === BITCOIN_ETF_GROUP.id ? 'BITCOIN' : null,
    dataHealth: health,
    ...(sellPlan ? { sellPlan } : {}),
    ...(failed ? { failed } : {}),
  };
}

/** Row 35 (#30): the Bitcoin read's momentum line, from its weekly RSI (the daily RSI has its own row). Null when absent. */
export function momentumText(rsiWeekly: number | null | undefined): string | null {
  const r = num(rsiWeekly);
  if (r == null) return null;
  const word = r < 30 ? 'oversold, sellers in control' : r < 45 ? 'weak' : r <= 55 ? 'neutral' : r <= 70 ? 'healthy, rising' : 'overbought, stretched';
  return 'Weekly RSI ' + r.toFixed(1) + ': ' + word + '.';
}

function sharedThesisOf(run: ExitPipelineResult): SharedThesisInput | null {
  const g = run.groups.find((x) => x.groupId === BITCOIN_ETF_GROUP.id && x.shared && x.thesis !== null);
  if (!g || !g.thesis) return null;
  const t = g.thesis;
  const trend = t.weeklyTrend;
  return {
    group: 'BITCOIN', members: [...g.present], anchorSeries: t.anchorSymbol,
    regime: str(t.regime), trend: typeof trend === 'string' ? str(trend) : null, trendMaturity: typeof t.trendMaturity === 'string' ? str(t.trendMaturity) : null,
    rsi: t.rsi14, stochRsi: t.stochRsi,
    pattern: t.patternTypes.length ? t.patternTypes.join(', ') : null,
    momentum: momentumText(t.rsiWeekly),
    thesis: str(clean(t.narrative, '')),
  };
}

/**
 * Audit #32: say WHY rows were left out, grouped by a fixed plain reason. The reader's own reason text can quote
 * a cell (type="..."), so it is never printed; it only picks the group.
 */
export function skipGroupOf(reason: string): string {
  if (reason.startsWith('"*"/TOTAL')) return 'total or note rows';
  if (reason.includes('has a space')) return 'ticker with a space (not a market symbol)';
  if (reason.startsWith('type=')) return 'not typed stock or crypto';
  if (reason.startsWith('blank Ticker')) return 'no ticker';
  if (reason.startsWith('end of the open options')) return 'start of the closed positions';
  return 'not a position';
}

export function groupSkipped(rows: readonly { readonly rowNumber: number; readonly ticker: string; readonly reason: string }[]): string[] {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const g = skipGroupOf(String(r.reason ?? ''));
    groups.set(g, [...(groups.get(g) ?? []), 'row ' + r.rowNumber + (r.ticker ? ' (' + r.ticker + ')' : '')]);
  }
  return [...groups].map(([g, list]) => g + ': ' + list.join(', '));
}

export function toExitReportInput(run: ExitPipelineResult, opts: ExitAdapterOptions = {}): ExitReportInput {
  const now = opts.runAt ?? new Date(run.startedAtMs);
  const stockUnreadable = opts.stockTableUnreadable === true;
  return {
    runAt: now,
    holdings: run.holdings.map((h) => holdingOf(h, now, opts)),
    skipped: {
      crypto: [...run.skipped.crypto],
      otherStock: groupSkipped(run.skipped.other),
      otherStockCount: run.skipped.other.length,
      blankTickerRowCount: run.skipped.blankRowCount,
      stockTableUnreadable: stockUnreadable,
      optionsTableUnreadable: opts.optionsTableUnreadable === true,
      stockTableEmpty: !stockUnreadable && run.rollup.stockCount === 0,
    },
    sharedThesis: sharedThesisOf(run),
    advisory: opts.advisory ?? null,
    ...(opts.advisoryUnavailable ? { advisoryUnavailable: opts.advisoryUnavailable } : {}),
    dataHealth: [
      ...run.portfolioQuality,
      ...(opts.targetMemoryUnavailable ? [{ label: 'Saved exit targets', reasonCode: 'SHEET_UNREADABLE' as ReasonCode, effect: 'SECTION_LEFT_OUT' as const, now }] : []),
    ],
  };
}
