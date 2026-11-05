/**
 * FL-8p (Phase 5, row 10): the BUY pipeline (not the report) -- per-watchlist-ticker buy analysis
 * orchestration, tiering inputs for the later tiered report, entry/ladder/size context.
 *
 * Plan: docs/CHARACTERIZATION_PLAN_V13_buy_pipeline_and_report.md (§1 inputs, §2 Buy vs Exit, §3 Bitcoin
 * group, §4 pipeline, §5.2 design rules, §7 open questions).
 *
 * Legacy ranges ported (fullStockAnalysisV10_9.gs):
 *   scanWatchlistV7            :9627-9659  BUY_NOW first, then conviction descending (sort key kept)
 *   getWatchlistTickersV7      :405-417    the sheet is the ONLY source (fallback deliberately dropped, see sheets/readers/watchlist.ts)
 *   getLastDecisionV7          :370-380    prior row, read BEFORE this run writes
 *   appendDecisionHistoryV7    :383-386    append-only
 *   change detection           dailyAutomation.ts:113-120 (prior.action !== decision.action)
 *   computeStockEntryLadderV7  :3362-3373  entry ladder (src/analysis/ladders.ts)
 *   OWN_BLOCK_FLOOR / OWN_FILTER_THRESHOLD :3204-3205 (read only; scoring is NOT touched here)
 *   turtle first-Unit sizing   turtleModelV1.gs:339-350,500
 *
 * Injected, never fetched here: readTickers, analyze (agent N builds the nightly caller; the Opus agent builds
 * runTickerAnalysis), readPortfolio, history. Stage-0 shared data (fetched once across Buy+Exit) is the
 * business of whatever `analyze` closes over.
 *
 * FIXES (named flags; default = fixed, parity flag restores legacy):
 *   lastRowBaseline (default false)  F-P1: "changed since yesterday" compares with the newest row from an
 *                                    EARLIER New York day; lastRowBaseline:true = legacy (newest row of any day).
 *
 * LONG-ONLY: no shorts, no sold options, no puts. No tax content. Report text is plain English (catalog.ts).
 * Logs are technical; the report-facing strings (note, sentences) never carry raw errors, URLs or codes.
 */

import { orElseAsync } from '../../core/guard.ts';
import type { RunContext } from '../../core/context.ts';
import { logDetail, reportSentence } from '../../core/result.ts';
import { runStep } from '../../core/runStep.ts';
import { computeStockEntryLadder, ladderDisplayPercents } from '../../analysis/ladders.ts';
import type { LadderRung } from '../../analysis/ladders.ts';
import type { CorrelatedCaps } from '../../analysis/models/turtle.ts';
import { getHeldPositionsForTicker } from '../../portfolio/transactions.ts';
import type { PortfolioSummary } from '../../portfolio/transactions.ts';
import { classifyError, dataQualityLines, labelledReason, REPORT_TIME_ZONE } from '../../reports/messages/catalog.ts';
import type { QualityItem } from '../../reports/messages/catalog.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import type { SheetsClient } from '../../sheets/client.ts';
import { readWatchlist } from '../../sheets/readers/watchlist.ts';
import { appendDecisionHistory, DECISION_HISTORY_SHEET } from '../../stores/decisionHistory.ts';
import type { TabCell } from '../../storage/tabStore.ts';
import { OWN_BLOCK_FLOOR, OWN_FILTER_THRESHOLD } from '../../types/decision.ts';
import { mapLimit } from '../nightly/nightly.ts';
import { mayAppendHistory } from '../history/historyPolicy.ts';
import type { HistoryPolicy } from '../history/historyPolicy.ts';

// ── thresholds (plan §7.1: a reasoned starting point, NOT validated) ───────────
export const BUY_TIER1_MIN_CONVICTION = 70;
export const BUY_TIER2_MIN_CONVICTION = 45;
export const BUY_DEFAULT_CONCURRENCY = 4;
export const BUY_TICKER_TIMEOUT_MS = 10 * 60_000;
export const BUY_TICKER_ATTEMPTS = 3;

/** Plan §3: Bitcoin-tracking ETFs are substitutes for one idea. Resolved dynamically over the candidates that appear. */
export { BITCOIN_ETF_TICKERS } from '../../types/bitcoinEtfs.ts';
import { BITCOIN_ETF_TICKERS } from '../../types/bitcoinEtfs.ts';

export const NOTHING_ACTIONABLE_TEXT = 'Nothing is actionable today. Every candidate is either waiting for a better entry or not worth buying right now.';
export const NO_CANDIDATES_TEXT = 'The watchlist has no tickers, so there is nothing to rank.';
export const BITCOIN_SUBSTITUTES_TEXT =
  'Technical read shared across Bitcoin-tracking ETFs, since they track the same underlying asset. These are alternative vehicles for one idea, not separate opportunities. Entry zone, stop and sizing below are specific to each ticker.';

/** For the methodology footer (plan §4.1, §7.1): the unvalidated numbers, stated plainly. */
export const BUY_METHODOLOGY_CAVEATS: readonly string[] = [
  'Conviction is the main ranking key. Its fundamentals floor (' + OWN_BLOCK_FLOOR + ') is a reasoned default and has not been validated against results.',
  'Fundamentals filter starts below a score of ' + OWN_FILTER_THRESHOLD + '; the tier cut-offs (' + BUY_TIER1_MIN_CONVICTION + ' and ' + BUY_TIER2_MIN_CONVICTION + ') are also reasoned starting points.',
  'Ranking: a name that can be bought now comes first, then higher conviction, then higher entry confidence.',
];

// ── injected-input shapes (loose on purpose; the real TechPlan/FundResult/Decision are assignable) ───────────
export interface BuyTechPlan {
  readonly techScore?: number | null;
  readonly regime?: string | null;
  readonly timing?: string | null;
  readonly entryPrice?: number | null;
  readonly entryLow?: number | null;
  readonly entryHigh?: number | null;
  readonly stop?: number | null;
  readonly t1?: { readonly price: number } | null;
  readonly t2?: { readonly price: number } | null;
  readonly rrToT1?: number | null;
  readonly rrToT2?: number | null;
  readonly entryConfidencePct?: number | null;
  readonly timeToEntry?: { readonly humanText: string; readonly agreement: string } | null;
}
export interface BuyFundResult { readonly score?: number | null; readonly verdict?: string | null }
export interface BuyDecision { readonly action: string; readonly finalConviction: number; readonly fundBand?: string | null }
export interface BuyConfluence { readonly entryCount?: unknown; readonly entryLow: number; readonly entryHigh: number }
/** turtleSizing's available branch; shares/dollar risk are accepted but deliberately NOT surfaced (Q3 default: relative only). */
export interface BuySizingIn {
  readonly available: boolean;
  readonly n?: number;
  readonly stopLevel?: number;
  readonly riskPctOfAccount?: number;
  readonly shares?: number;
  readonly dollarRisk?: number;
}
export interface BuyAnalysis {
  readonly fundResult?: BuyFundResult | null;
  readonly techPlan?: BuyTechPlan | null;
  readonly decision?: BuyDecision | null;
  readonly confluence?: BuyConfluence | null;
  readonly sizing?: BuySizingIn | null;
  /** Opaque pass-throughs for the report: the 5 models and their comparison. */
  readonly models?: unknown;
  readonly comparison?: unknown;
  /** FL-17b: the display-only Wyckoff / Trend / combo reads (analysis/extraModels.ts). Never scored or tiered. */
  readonly extraModels?: unknown;
  /** Options picks (LEAPS / short-term call); kept for Tier 1 only (Q2 default). */
  readonly options?: unknown;
  readonly dataQuality?: readonly QualityItem[];
}
export type BuyAnalyzeFn = (ticker: string) => Promise<BuyAnalysis | null | undefined>;

export interface TickerSource { readonly tickers: readonly string[]; readonly seeded?: boolean }

export interface PriorDecision { readonly date: TabCell; readonly action: TabCell; readonly finalConviction: TabCell }
export interface HistoryRow {
  readonly ticker: string;
  readonly fundResult: { readonly score: unknown };
  readonly techPlan: { readonly techScore: unknown };
  readonly decision: { readonly finalConviction: unknown; readonly action: unknown };
}
export interface BuyHistory {
  /** One pass, BEFORE any row is written this run. `todayKey` is the New York day (YYYY-MM-DD). */
  readonly loadPriors: (tickers: readonly string[], todayKey: string) => Promise<ReadonlyMap<string, PriorDecision>> | ReadonlyMap<string, PriorDecision>;
  /** Append-only, called sequentially after analysis. */
  readonly append: (rows: readonly HistoryRow[], nowMs: number) => Promise<void> | void;
}

export type BuyTier = 1 | 2 | 3;
export type CandidateStatus = 'ok' | 'degraded' | 'failed';

export interface BuyCandidate {
  readonly ticker: string;
  readonly status: CandidateStatus;
  readonly tier: BuyTier;
  /** 1-based, unique per candidate, in report order. */
  readonly rank: number;
  /** Ranking slot: Bitcoin-group followers share the slot of the best-ranked member. */
  readonly slot: number;
  readonly buyNow: boolean;
  readonly blocked: boolean;
  readonly conviction: number | null;
  readonly entryConfidencePct: number | null;
  readonly ownScore: number | null;
  readonly ownBand: string | null;
  readonly timing: string | null;
  readonly regime: string | null;
  readonly action: string | null;
  readonly entryZone: { readonly low: number | null; readonly center: number | null; readonly high: number | null };
  readonly timeToEntry: string | null;
  readonly stop: number | null;
  readonly rrToT1: number | null;
  readonly rrToT2: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly entryLadder: { readonly rungs: readonly LadderRung[]; readonly percents: readonly number[] };
  /** Relative sizing only: no share count, no dollar figures. */
  readonly sizing: { readonly firstUnitRiskPctOfAccount: number; readonly n: number | null; readonly stopLevel: number | null } | null;
  readonly sizingText: string | null;
  readonly models: unknown;
  readonly comparison: unknown;
  /** FL-17b: display only; present only when the analysis carried it. */
  readonly extraModels?: unknown;
  readonly options: unknown;
  readonly held: { readonly stockShares: number | null; readonly hasOptions: boolean } | null;
  readonly addToPosition: boolean;
  readonly opportunityCost: readonly string[];
  /** Tier 2 only: the concrete condition that would promote it. Always non-empty for tier 2. */
  readonly promotion: string | null;
  readonly change: { readonly from: string; readonly to: string; readonly fromConviction: number | null } | null;
  readonly bitcoinGroup: boolean;
  readonly dataHealth: readonly string[];
  /** Plain sentence for a failed/degraded candidate; null otherwise. */
  readonly note: string | null;
}

export interface BuyRun {
  readonly candidates: readonly BuyCandidate[];
  readonly shortlist: readonly BuyCandidate[];
  readonly tier1: readonly BuyCandidate[];
  readonly tier2: readonly BuyCandidate[];
  readonly tier3: readonly BuyCandidate[];
  readonly changes: readonly BuyCandidate[];
  readonly nothingActionable: boolean;
  readonly emptyText: string | null;
  readonly bitcoin: { readonly members: readonly string[]; readonly substitutesText: string | null } | null;
  readonly seeded: boolean;
  readonly portfolioOk: boolean;
  readonly counts: { readonly total: number; readonly ok: number; readonly degraded: number; readonly failed: number; readonly tier1: number; readonly tier2: number; readonly tier3: number };
}

export interface BuyPipelineOptions {
  readonly concurrency?: number;
  readonly tickerTimeoutMs?: number;
  readonly tickerAttempts?: number;
  readonly tier1MinConviction?: number;
  readonly tier2MinConviction?: number;
  /** F-P1 parity flag: true = legacy (newest history row of ANY day is the baseline). */
  readonly lastRowBaseline?: boolean;
  /** When false, no Decision History row is appended. Default true. */
  readonly writeHistory?: boolean;
  /** F-P4: single Decision History writer (default: this pipeline). legacyDoubleAppend:true = legacy. */
  readonly historyPolicy?: HistoryPolicy;
}

export interface BuyPipelineDeps {
  readonly ctx: RunContext;
  readonly readTickers: () => Promise<TickerSource> | TickerSource;
  readonly analyze: BuyAnalyzeFn;
  /** Read-only. Optional: without it the opportunity-cost section says so. */
  readonly readPortfolio?: () => Promise<PortfolioSummary> | PortfolioSummary;
  readonly history?: BuyHistory;
  /** Optional, already resolved by the caller (turtleCorrelatedCaps over current holdings). */
  readonly correlatedCaps?: CorrelatedCaps | null;
  readonly categoriesOf?: (ticker: string) => readonly string[];
}

// ── helpers ───────────────────────────────────────────────────────────

/** The New York calendar day (YYYY-MM-DD) of an instant. */
export function nyDayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** A Decision History Date cell -> New York day key, or null when it cannot be read (Date, ISO string or sheet serial). */
export function cellDayKey(cell: TabCell | unknown): string | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : nyDayKey(cell.getTime());
  if (typeof cell === 'number' && Number.isFinite(cell)) return nyDayKey(Date.UTC(1899, 11, 30) + Math.round(cell * 86_400_000));
  if (typeof cell === 'string' && cell.trim() !== '') {
    const ms = Date.parse(cell);
    return Number.isNaN(ms) ? null : nyDayKey(ms);
  }
  return null;
}

/** Production history over the Decision History tab: ONE read for all priors, then append-only writes. */
export function workbookHistory(ss: ReportWorkbook, lastRowBaseline = false): BuyHistory {
  return {
    loadPriors(tickers, todayKey) {
      const out = new Map<string, PriorDecision>();
      const sh = ss.getSheetByName(DECISION_HISTORY_SHEET);
      if (!sh) return out;
      const data = sh.getDataRange().getValues();
      const want = new Set(tickers.map((t) => t.toUpperCase()));
      for (let r = data.length - 1; r >= 1; r--) {
        const row = data[r]!;
        const t = String(row[1]).toUpperCase();
        if (!want.has(t) || out.has(t)) continue;
        if (!lastRowBaseline && cellDayKey(row[0]) === todayKey) continue; // F-P1: skip today's own rows
        out.set(t, { date: row[0] as TabCell, action: row[5] as TabCell, finalConviction: row[4] as TabCell });
      }
      return out;
    },
    append(rows, nowMs) {
      for (const x of rows) appendDecisionHistory(ss, x.ticker, x.fundResult, x.techPlan, x.decision, nowMs);
    },
  };
}

/** Production ticker source: the Sheets-API watchlist reader (sheet is the sole source of truth; one-time seed written to the sheet). */
export function watchlistTickerSource(ctx: RunContext, sheets: SheetsClient): () => Promise<TickerSource> {
  return async () => {
    const res = await readWatchlist(ctx, sheets);
    if (!res.ok) throw new Error('watchlist read failed: ' + String(res.error.detail));
    return { tickers: res.value.tickers, seeded: res.value.seeded };
  };
}

/** Tier from numbers only (plan §7.1). A block beats BUY_NOW (F-P3). */
export function tierOf(
  a: { readonly decision: boolean; readonly blocked: boolean; readonly buyNow: boolean; readonly conviction: number | null },
  t1 = BUY_TIER1_MIN_CONVICTION, t2 = BUY_TIER2_MIN_CONVICTION,
): BuyTier {
  if (!a.decision || a.blocked) return 3;
  if (a.buyNow || (a.conviction != null && a.conviction >= t1)) return 1;
  if (a.conviction != null && a.conviction >= t2) return 2;
  return 3;
}

/** Tier 2: the concrete condition that would make it actionable (plan §5.2). Never empty. */
export function promotionCondition(p: { readonly entryHigh: number | null; readonly regime: string | null; readonly timing: string | null; readonly conviction: number | null }, t1 = BUY_TIER1_MIN_CONVICTION): string {
  const bits: string[] = [];
  if (p.timing !== 'BUY_NOW' && p.entryHigh != null) bits.push('it pulled back to $' + p.entryHigh.toFixed(2) + ' or lower');
  if (p.regime != null && p.regime !== 'TREND_UP') bits.push('the trend turned up');
  if (p.conviction != null && p.conviction < t1) bits.push('conviction rose to ' + t1);
  if (!bits.length) return 'Would be actionable once the entry timing turns to buy now.';
  return 'Would be actionable if ' + bits.join(', or if ') + '.';
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function buildCandidate(ticker: string, a: BuyAnalysis, o: { t1: number; t2: number }): Omit<BuyCandidate, 'rank' | 'slot' | 'held' | 'addToPosition' | 'opportunityCost' | 'change' | 'bitcoinGroup'> {
  const d = a.decision ?? null;
  const tp = a.techPlan ?? null;
  const fr = a.fundResult ?? null;
  const conviction = d ? num(d.finalConviction) : null;
  const ownScore = fr ? num(fr.score) : null;
  const blocked = ownScore != null && ownScore <= OWN_BLOCK_FLOOR;
  const buyNow = !!(tp && tp.timing === 'BUY_NOW');
  const tier = tierOf({ decision: !!d, blocked, buyNow, conviction }, o.t1, o.t2);
  const entryLow = tp ? num(tp.entryLow) : null;
  const entryHigh = tp ? num(tp.entryHigh) : null;
  const entryCenter = tp ? num(tp.entryPrice) : null;

  const rungs = a.confluence ? computeStockEntryLadder(a.confluence) : [];
  const percents = ladderDisplayPercents(rungs);

  const s = a.sizing && a.sizing.available && num(a.sizing.riskPctOfAccount) != null
    ? { firstUnitRiskPctOfAccount: a.sizing.riskPctOfAccount as number, n: num(a.sizing.n), stopLevel: num(a.sizing.stopLevel) }
    : null;
  const sizingText = s
    ? 'A first position unit risks about ' + s.firstUnitRiskPctOfAccount.toFixed(1) + '% of the account if the initial stop is hit.'
    : null;

  return {
    ticker,
    status: d ? 'ok' : 'degraded',
    tier,
    buyNow,
    blocked,
    conviction,
    entryConfidencePct: tp ? num(tp.entryConfidencePct) : null,
    ownScore,
    ownBand: d && d.fundBand != null ? String(d.fundBand) : null,
    timing: tp && tp.timing != null ? String(tp.timing) : null,
    regime: tp && tp.regime != null ? String(tp.regime) : null,
    action: d ? String(d.action) : null,
    entryZone: { low: entryLow, center: entryCenter, high: entryHigh },
    timeToEntry: tp && tp.timeToEntry ? String(tp.timeToEntry.humanText) : null,
    stop: tp ? num(tp.stop) : null,
    rrToT1: tp ? num(tp.rrToT1) : null,
    rrToT2: tp ? num(tp.rrToT2) : null,
    t1: tp && tp.t1 ? num(tp.t1.price) : null,
    t2: tp && tp.t2 ? num(tp.t2.price) : null,
    entryLadder: { rungs, percents },
    sizing: s,
    sizingText,
    models: a.models ?? null,
    comparison: a.comparison ?? null,
    ...(a.extraModels != null ? { extraModels: a.extraModels } : {}),
    options: tier === 1 ? (a.options ?? null) : null,
    promotion: tier === 2 ? promotionCondition({ entryHigh, regime: tp && tp.regime != null ? String(tp.regime) : null, timing: tp && tp.timing != null ? String(tp.timing) : null, conviction }, o.t1) : null,
    dataHealth: dataQualityLines(a.dataQuality ?? []),
    note: d ? null : 'The analysis ran but gave no decision for this stock.',
  };
}

function opportunity(
  ticker: string, group: boolean, portfolio: PortfolioSummary | null, deps: BuyPipelineDeps,
): { held: BuyCandidate['held']; addToPosition: boolean; sentences: string[] } {
  const sentences: string[] = [];
  if (!portfolio) return { held: null, addToPosition: false, sentences: ['Your current holdings could not be read, so no comparison with them is shown.'] };
  const mine = getHeldPositionsForTicker(portfolio, ticker);
  const stock = mine.find((p) => p.assetType === 'STOCK');
  const hasOptions = mine.some((p) => p.assetType === 'OPTION');
  const held = mine.length ? { stockShares: stock && stock.assetType === 'STOCK' ? stock.shares : null, hasOptions } : null;
  const addToPosition = mine.length > 0;
  if (stock) sentences.push('You already hold this stock, so the question is whether to add to your position, not whether to open a new one.');
  else if (hasOptions) sentences.push('You already hold options on this stock, so buying more adds to an existing idea.');
  if (group) {
    const others = BITCOIN_ETF_TICKERS.filter((g) => g !== ticker && portfolio.positions.some((p) => p.ticker === g));
    if (others.length) sentences.push('You already hold ' + others.join(', ') + ', which tracks the same asset, so this would add more of the same exposure rather than a new idea.');
  }
  const caps = deps.correlatedCaps;
  if (caps && deps.categoriesOf) {
    const cats = new Set(deps.categoriesOf(ticker));
    const hit = caps.categoryFlags.filter((c) => c.flagged && cats.has(c.category)).map((c) => c.category);
    if (hit.length) sentences.push('Your holdings are already above the suggested exposure limit in ' + hit.join(', ') + '.');
  }
  if (!sentences.length) sentences.push('You do not hold this stock, and it does not overlap with a group you are already heavily exposed to.');
  return { held, addToPosition, sentences };
}

export async function runBuyPipeline(deps: BuyPipelineDeps, options: BuyPipelineOptions = {}): Promise<BuyRun> {
  const { ctx } = deps;
  const t1 = options.tier1MinConviction ?? BUY_TIER1_MIN_CONVICTION;
  const t2 = options.tier2MinConviction ?? BUY_TIER2_MIN_CONVICTION;
  const nowMs = ctx.clock.now();
  const todayKey = nyDayKey(nowMs);

  const src = await deps.readTickers();
  const seen = new Set<string>();
  const tickers: string[] = [];
  for (const raw of src.tickers) {
    const t = String(raw ?? '').toUpperCase().trim();
    if (t && !seen.has(t)) { seen.add(t); tickers.push(t); }
  }
  ctx.log.info('buy pipeline starting', { tickers: tickers.length, seeded: !!src.seeded });

  // Read-only portfolio (opportunity cost). A failure degrades only that section.
  let portfolio: PortfolioSummary | null = null;
  if (deps.readPortfolio) {
    const read = deps.readPortfolio;
    portfolio = await orElseAsync(ctx.log, 'portfolio read (opportunity cost unavailable)', async () => read(), null);
  }

  // Priors BEFORE any write (legacy :370-380 / dailyAutomation.ts:113).
  let priors: ReadonlyMap<string, PriorDecision> = new Map();
  if (deps.history && tickers.length) {
    const history = deps.history;
    priors = await orElseAsync(ctx.log, 'decision history read (no change detection tonight)', async () => history.loadPriors(tickers, todayKey), priors);
  }

  const conc = options.concurrency ?? BUY_DEFAULT_CONCURRENCY;
  const timeoutMs = options.tickerTimeoutMs ?? BUY_TICKER_TIMEOUT_MS;
  const attempts = options.tickerAttempts ?? BUY_TICKER_ATTEMPTS;

  type Row = { readonly c: Omit<BuyCandidate, 'rank' | 'slot' | 'held' | 'addToPosition' | 'opportunityCost' | 'change' | 'bitcoinGroup'>; readonly raw: BuyAnalysis | null };
  const rows = await mapLimit(tickers, conc, async (t): Promise<Row> => {
    const tctx = ctx.forTicker(t);
    const res = await runStep(
      tctx,
      { key: 'buy.' + t, label: 'Buy analysis ' + t, onFailure: reportSentence('The buy analysis for ' + t + ' did not finish tonight.'), retry: 'auto', timeoutMs, maxAttempts: attempts },
      async () => (await deps.analyze(t)) ?? null,
    );
    if (!res.ok) {
      tctx.log.error('buy analysis failed', { ticker: t, detail: String(logDetail(String(res.error.detail))), attempts: res.error.attempts });
      const base = buildCandidate(t, {}, { t1, t2 });
      return { c: { ...base, status: 'failed', tier: 3, note: labelledReason(t, classifyError(res.error.cause ?? res.error.detail)) }, raw: null };
    }
    const a = res.value;
    if (!a || !a.decision) {
      tctx.log.warning('buy analysis returned no decision', { ticker: t });
      return { c: buildCandidate(t, a ?? {}, { t1, t2 }), raw: a };
    }
    return { c: buildCandidate(t, a, { t1, t2 }), raw: a };
  });

  // Sort: ok-with-decision first; BUY_NOW first, conviction desc (legacy :9627-9659), entry confidence desc, ticker.
  const sorted = rows.slice().sort((x, y) => {
    const xf = x.c.status === 'failed' ? 1 : 0, yf = y.c.status === 'failed' ? 1 : 0;
    if (xf !== yf) return xf - yf;
    if (x.c.buyNow !== y.c.buyNow) return x.c.buyNow ? -1 : 1;
    const dc = (y.c.conviction || 0) - (x.c.conviction || 0);
    if (dc) return dc;
    const de = (y.c.entryConfidencePct || 0) - (x.c.entryConfidencePct || 0);
    if (de) return de;
    return x.c.ticker < y.c.ticker ? -1 : x.c.ticker > y.c.ticker ? 1 : 0;
  });

  const groupPresent = sorted.filter((r) => BITCOIN_ETF_TICKERS.includes(r.c.ticker)).map((r) => r.c.ticker);
  let slot = 0;
  let groupSlot = 0;
  const candidates: BuyCandidate[] = sorted.map((r, i) => {
    const inGroup = BITCOIN_ETF_TICKERS.includes(r.c.ticker);
    let s: number;
    if (inGroup && groupSlot) s = groupSlot;
    else { s = ++slot; if (inGroup) groupSlot = s; }
    const opp = opportunity(r.c.ticker, inGroup, portfolio, deps);
    const prior = priors.get(r.c.ticker);
    const change = prior && r.c.action != null && prior.action !== r.c.action
      ? { from: String(prior.action), to: r.c.action, fromConviction: num(prior.finalConviction) }
      : null;
    return { ...r.c, rank: i + 1, slot: s, held: opp.held, addToPosition: opp.addToPosition, opportunityCost: opp.sentences, change, bitcoinGroup: inGroup };
  });

  // History: sequential, append-only, after all analysis (legacy :383-386).
  if (deps.history && options.writeHistory !== false && mayAppendHistory('buyPipeline', options.historyPolicy)) {
    const toWrite: HistoryRow[] = [];
    for (const r of sorted) {
      const a = r.raw;
      if (a && a.decision && a.fundResult && a.techPlan) {
        toWrite.push({ ticker: r.c.ticker, fundResult: { score: a.fundResult.score }, techPlan: { techScore: a.techPlan.techScore }, decision: { finalConviction: a.decision.finalConviction, action: a.decision.action } });
      }
    }
    const history = deps.history;
    await orElseAsync(ctx.log, 'decision history append', async () => history.append(toWrite, nowMs), undefined, 'error');
  }

  const tier1 = candidates.filter((c) => c.tier === 1);
  const tier2 = candidates.filter((c) => c.tier === 2);
  const tier3 = candidates.filter((c) => c.tier === 3);
  const countOf = (s: CandidateStatus): number => candidates.filter((c) => c.status === s).length;
  const run: BuyRun = {
    candidates, shortlist: tier1, tier1, tier2, tier3,
    changes: candidates.filter((c) => c.change !== null),
    nothingActionable: tier1.length === 0,
    emptyText: candidates.length === 0 ? NO_CANDIDATES_TEXT : tier1.length === 0 ? NOTHING_ACTIONABLE_TEXT : null,
    bitcoin: groupPresent.length ? { members: groupPresent, substitutesText: groupPresent.length >= 2 ? BITCOIN_SUBSTITUTES_TEXT : null } : null,
    seeded: !!src.seeded,
    portfolioOk: portfolio !== null || !deps.readPortfolio,
    counts: { total: candidates.length, ok: countOf('ok'), degraded: countOf('degraded'), failed: countOf('failed'), tier1: tier1.length, tier2: tier2.length, tier3: tier3.length },
  };
  ctx.log.info('buy pipeline done', { ...run.counts, changes: run.changes.length });
  return run;
}
