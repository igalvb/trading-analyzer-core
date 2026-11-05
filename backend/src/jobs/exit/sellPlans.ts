/**
 * F-X2 glue: one sell plan per holding of an Exit pipeline run, continued from the remembered plan when the
 * Exit Target History has one (stores/exitTargetHistory.ts), plus the rows to append. Pure: the job reads and
 * writes the tab. Holdings without a verdict get no plan.
 */

import type { ExitHoldingResult } from './exitPipeline.ts';
import { buildSellPlan, planAmounts, type PlanAmounts, type SellPlan, type StageMemory } from '../../portfolio/sellPlan.ts';
import { decideAnchor, holdingKey, type TargetAnchor } from '../../stores/exitTargetHistory.ts';

export interface HoldingSellPlan {
  readonly plan: SellPlan;
  /** One short line about the remembered targets; null when memory is off. */
  readonly memoryLine: string | null;
}

export interface SellPlansResult {
  readonly byHolding: ReadonlyMap<ExitHoldingResult, HoldingSellPlan>;
  readonly append: readonly TargetAnchor[];
}

export function buildSellPlans(holdings: readonly ExitHoldingResult[], anchors: ReadonlyMap<string, TargetAnchor> | null, today: string): SellPlansResult {
  const byHolding = new Map<ExitHoldingResult, HoldingSellPlan>();
  const append: TargetAnchor[] = [];
  const seen = new Set<string>();
  for (const h of holdings) {
    if (h.status === 'FAILED' || h.status === 'SKIPPED' || h.actionClass === 'UNKNOWN') continue;
    const quantity = h.kind === 'STOCK' ? h.shares : h.contracts;
    const optionClass = h.kind === 'OPTION' ? h.expiryTrigger.kind : undefined;
    const dte = h.kind === 'OPTION' ? h.expiryTrigger.daysToExpiry : null;
    const amounts = planAmounts(h.kind, optionClass, quantity);
    const key = h.kind === 'OPTION' ? holdingKey('OPTION', h.ticker, h.strike, h.expiry) : holdingKey('STOCK', h.ticker);
    let stage: StageMemory | null = null;
    let memoryLine: string | null = null;
    // An expired contract has nothing to remember; the same holding twice in one run is remembered once.
    if (anchors && amounts && quantity != null && !(dte != null && dte <= 0) && !seen.has(key)) {
      seen.add(key);
      const d = decideAnchor(anchors.get(key) ?? null, {
        key, ticker: h.ticker, kind: h.kind, quantity, avgCost: h.kind === 'STOCK' ? h.avgCost : h.avgPremium, price: h.price,
        t1: h.t1, t2: h.t2, entryDate: h.kind === 'STOCK' && h.entryDateAssumed ? null : h.entryDate, amounts, splitDays: h.splitDays ?? [],
      }, today);
      if (d.append) append.push(d.append);
      stage = d.stage;
      memoryLine = d.line;
    }
    const weekly = h.weeklyStops ? weeklyPlan(h, quantity, amounts) : null;
    const plan = weekly ?? buildSellPlan({
      kind: h.kind, quantity, optionClass, daysToExpiry: dte, expiryThreshold: h.kind === 'OPTION' ? h.expiryTrigger.threshold : null,
      t1: h.t1, t2: h.t2, hitT1: h.hitT1, hitT2: h.hitT2, daysToT1: h.daysToT1 ?? null, daysToT2: h.daysToT2 ?? null, stop: h.stopLevel, stage,
    });
    byHolding.set(h, { plan, memoryLine });
  }
  return { byHolding, append };
}

const usd = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitsText = (n: number, unit: string): string => String(Math.round(n * 10000) / 10000) + ' ' + unit + (n === 1 ? '' : 's');

/**
 * Owner 2026-11-05 (weeklyStops flag): "How many to sell" follows the action. EXIT = sell all; REVIEW = nothing until
 * reviewed; TRIM = about a third now (the owner's thirds rule); HOLD = the usual staged plan, but only at a target
 * worth +25% after tax over the cost, and "no valid target" when there is none. Null = the usual plan applies.
 */
export function weeklyPlan(h: ExitHoldingResult, quantity: number | null, amounts: PlanAmounts | null): SellPlan | null {
  const unit = h.kind === 'OPTION' ? 'contract' : 'share';
  const base = { rule: null, stage: null, unit, quantity, sellAtT1: 0, sellAtT2: 0, sellNow: 0, runner: 0 } as const;
  if (quantity == null || !amounts) return null;
  if (h.actionClass === 'EXIT') return { ...base, kind: 'EXIT_ALL', sellNow: quantity, lines: ['Sell all ' + unitsText(quantity, unit) + ': this is an exit, not a staged plan.'] };
  if (h.actionClass === 'REVIEW') return { ...base, kind: 'NO_SALE', lines: ['No sale planned until you review the reason above; if you decide to exit, sell all ' + unitsText(quantity, unit) + '.'] };
  const w = h.weeklyStops!;
  if (h.actionClass === 'TRIM') {
    const now = amounts.atT1;
    return { ...base, kind: 'TRIM_NOW', rule: amounts.rule, sellNow: now, runner: Math.round((quantity - now) * 10000) / 10000,
      lines: ['Sell ' + unitsText(now, unit) + ' now' + (w.reachedTarget != null ? ' (the target ' + usd(w.reachedTarget) + ' was reached)' : '') + ' and keep the rest on the weekly stop.'] };
  }
  if (h.actionClass !== 'HOLD') return null;
  if (h.t1 == null) return { ...base, kind: 'NO_SALE', lines: ['No sale planned: no valid target this run; the weekly stop protects the position.'] };
  if (w.t1WorthTrimming === false) return { ...base, kind: 'NO_SALE', lines: ['No sale planned at T1 ' + usd(h.t1) + ': it is under +25% over your cost after tax; keep holding on the weekly stop.'] };
  return null;
}
