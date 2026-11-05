/**
 * Backlog 9: the backtest's decision policy. PURE: (engine reads, exit reads, portfolio state) -> orders.
 *
 * Every rule and number is an existing project convention, none tuned on the result:
 *
 *   BUY   the Buy report's own tier-1 rule (jobs/buy/buyPipeline.ts tierOf: a decision, not blocked by the
 *         fundamentals floor, and BUY_NOW timing or conviction >= BUY_TIER1_MIN_CONVICTION), AND the 5-voice
 *         comparison verdict is not SPLIT or NO_CONSENSUS (owner 4f: hold off on those; no conviction bump).
 *         A missing verdict (comparison not built) also holds off: agreement cannot be checked.
 *         Not a ticker already held; at most `maxPositions` open (Test A: 6; Test B: no limit).
 *         Several candidates on one day: the Buy report's own order (BUY_NOW first, conviction descending,
 *         entry confidence descending, ticker).
 *   SIZE  analysis/decision.ts computePositionSize(entry, stop, finalConviction, {size: equity, riskPct:
 *         ACCOUNT.riskPct}) (owner 4e). The cash cap (scale down to the cash on hand, skip at 0) is applied at
 *         the fill, in the runner.
 *   SELL  the engine's exit read classified by the Exit pipeline (classifyStockAction): EXIT (stop breached
 *         since the real entry, or the read turned AVOID) sells everything; TRIM (T1 / T2 reached) sells by the
 *         owner's F-X2 thirds rule (portfolio/sellPlan.ts buildSellPlan with the remembered stage), keeping the
 *         runner on the trailing stop. HOLD sells nothing.
 */

import { tierOf, BUY_TIER1_MIN_CONVICTION } from '../jobs/buy/buyPipeline.ts';
import { computePositionSize, ACCOUNT, type PositionSize } from '../analysis/decision.ts';
import { buildSellPlan, planAmounts, type StageMemory } from '../portfolio/sellPlan.ts';
import type { EngineRead, ExitReadResult } from './engineRun.ts';

/** Owner 4f: the comparison verdicts that hold a buy off. */
export const HOLD_OFF_VERDICTS: readonly string[] = ['SPLIT', 'NO_CONSENSUS'];

export interface PolicyConfig {
  /** Test variant (owner, 2026-10-27): put all the account into each buy instead of the engine's risk-based size; isolates the timing. */
  readonly allIn?: boolean;
  /** Test variant (owner, 2026-10-27): the engine alone -- no hold-off by the 5-voice comparison verdict. */
  readonly noVeto?: boolean;
  /** Test A: 6. Test B: null (no position-count rule). */
  readonly maxPositions: number | null;
  /** ACCOUNT.riskPct unless a test overrides it. */
  readonly riskPct?: number;
}

export interface BuyCheck {
  readonly eligible: boolean;
  readonly tier: 1 | 2 | 3 | null;
  /** Plain reason when not eligible. */
  readonly reason: string;
}

/** Is this engine read a buy signal under the policy (ignoring portfolio state)? */
export function buyCheck(r: EngineRead, opts: { readonly noVeto?: boolean } = {}): BuyCheck {
  if (!r.ok || r.finalConviction == null) return { eligible: false, tier: null, reason: 'no decision' + (r.aborted ? ' (' + r.aborted + ')' : '') };
  const tier = tierOf({ decision: true, blocked: r.blocked, buyNow: r.timing === 'BUY_NOW', conviction: r.finalConviction }) as 1 | 2 | 3;
  if (tier !== 1) return { eligible: false, tier, reason: r.blocked ? 'blocked by the fundamentals floor' : 'not tier 1 (no BUY_NOW, conviction ' + r.finalConviction + ' < ' + BUY_TIER1_MIN_CONVICTION + ')' };
  if (opts.noVeto) return { eligible: true, tier, reason: '' };
  if (r.verdict == null) return { eligible: false, tier, reason: 'no comparison verdict' };
  if (HOLD_OFF_VERDICTS.includes(r.verdict)) return { eligible: false, tier, reason: 'comparison verdict ' + r.verdict };
  return { eligible: true, tier, reason: '' };
}

/** The Buy report's order: BUY_NOW first, conviction descending, entry confidence descending, ticker. */
export function rankReads(reads: readonly EngineRead[]): EngineRead[] {
  const k = (r: EngineRead): [number, number, number] => [r.timing === 'BUY_NOW' ? 0 : 1, -(r.finalConviction ?? -1), -(r.entryConfidencePct ?? -1)];
  return [...reads].sort((a, b) => {
    const ka = k(a), kb = k(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
}

export interface BuyOrder {
  readonly ticker: string;
  readonly signalDay: string;
  /** Shares from computePositionSize, before the cash cap at the fill. */
  readonly plannedShares: number;
  readonly sizing: PositionSize;
  readonly read: EngineRead;
}

export interface SkippedBuy {
  readonly ticker: string;
  readonly signalDay: string;
  readonly reason: string;
}

export interface BuyState {
  /** Mark-to-market equity at the signal day's close. */
  readonly equity: number;
  readonly held: ReadonlySet<string>;
  /** Positions still open after today's full-exit orders. */
  readonly openAfterExits: number;
}

export function planBuys(state: BuyState, reads: readonly EngineRead[], cfg: PolicyConfig): { orders: BuyOrder[]; skipped: SkippedBuy[] } {
  const orders: BuyOrder[] = [];
  const skipped: SkippedBuy[] = [];
  const riskPct = cfg.riskPct ?? ACCOUNT.riskPct;
  for (const r of rankReads(reads.filter((x) => buyCheck(x, { noVeto: !!cfg.noVeto }).eligible))) {
    if (state.held.has(r.ticker)) continue;
    if (cfg.maxPositions != null && state.openAfterExits + orders.length >= cfg.maxPositions) {
      skipped.push({ ticker: r.ticker, signalDay: r.day, reason: 'max ' + cfg.maxPositions + ' positions' });
      continue;
    }
    const size = r.entryPrice != null && r.stop != null
      ? computePositionSize(r.entryPrice, r.stop, r.finalConviction as number, { size: state.equity, riskPct })
      : null;
    if (!size) { skipped.push({ ticker: r.ticker, signalDay: r.day, reason: 'no position size (entry/stop unusable)' }); continue; }
    const planned = cfg.allIn && r.entryPrice ? Math.floor(state.equity / r.entryPrice) : size.shares;
    orders.push({ ticker: r.ticker, signalDay: r.day, plannedShares: planned, sizing: size, read: r });
  }
  return { orders, skipped };
}

export interface HeldPosition {
  readonly ticker: string;
  readonly shares: number;
  /** 'YYYY-MM-DD' of the first fill. */
  readonly entryDate: string;
  /** Average cost per share (the exit read's entry price). */
  readonly entryPrice: number;
  /** The remembered F-X2 plan, null before the first target sale. */
  readonly stage: StageMemory | null;
}

export interface SellOrder {
  readonly ticker: string;
  readonly signalDay: string;
  readonly shares: number;
  readonly full: boolean;
  readonly reason: string;
  /** The plan to remember after this sale (target sales only). */
  readonly stageAfter: StageMemory | null;
  readonly exit: ExitReadResult;
}

/** The sell order (if any) for one held position, from the engine's own exit read. */
export function planSell(p: HeldPosition, x: ExitReadResult): SellOrder | null {
  if (!x.ok || p.shares <= 0) return null;
  if (x.actionClass === 'EXIT') {
    return { ticker: p.ticker, signalDay: x.day, shares: p.shares, full: true, reason: x.recommendation ?? 'EXIT', stageAfter: null, exit: x };
  }
  if (x.actionClass !== 'TRIM') return null;
  const plan = buildSellPlan({ kind: 'STOCK', quantity: p.shares, t1: x.t1, t2: x.t2, hitT1: x.hitT1, hitT2: x.hitT2, stage: p.stage });
  let qty = 0;
  if (plan.kind === 'SINGLE_UNIT_CHOICE') qty = p.shares; // one unit cannot be split: the first alternative (sell at T1).
  else if (plan.kind === 'RUNNER_ONLY') qty = 0;
  else if (plan.stage === 1) qty = (x.hitT1 ? plan.sellAtT1 : 0) + (x.hitT2 ? plan.sellAtT2 : 0);
  else if (plan.stage === 2) qty = (x.hitT1 || x.hitT2) ? plan.sellAtT1 : 0;
  qty = Math.min(qty, p.shares);
  if (!(qty > 0)) return null;
  let stageAfter = p.stage;
  if (!stageAfter && plan.kind !== 'SINGLE_UNIT_CHOICE') {
    const a = planAmounts('STOCK', undefined, p.shares);
    if (a) stageAfter = { originalQuantity: p.shares, plannedAtT1: a.atT1, plannedAtT2: a.atT2, since: p.entryDate, rule: a.rule };
  }
  return { ticker: p.ticker, signalDay: x.day, shares: qty, full: qty >= p.shares, reason: x.recommendation ?? 'TRIM', stageAfter: qty >= p.shares ? null : stageAfter, exit: x };
}
