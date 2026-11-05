/**
 * F-X2: how many shares or contracts to sell at each exit target. Pure, display only: it reads the Exit levels the
 * exit reads already computed and never feeds a score, a model or a decision.
 *
 * The owner's rules (2026-10-25, decided):
 *   - stock and long-dated options (LEAPS): sell about a third at T1, a third at T2, keep the rest (the runner) on the
 *     trailing stop. Rounded down, at least 1 per target (2 units = 1 at T1, 1 at T2, no runner).
 *   - short-dated options (and options whose class is unknown): half at T1, the rest at T2, a full exit.
 *   - any option inside its expiry window (30 days short-term, 60 days LEAPS; the exit read's threshold): sell all now.
 *   - a single unit (1 contract, 1 share, or less than 2 shares) cannot be split: T1 and T2 are shown as two
 *     ALTERNATIVES, each with the estimated trading days to reach it and, for an option, the days to expiry and a
 *     plain fit word. No probability figure is ever shown (there is no validated way to compute one).
 *   - staged plan: after a partial sale the remainder is the next stage of the SAME plan (never re-split, so the
 *     plan cannot halve forever). The stage comes from the remembered plan (stores/exitTargetHistory.ts).
 */

import { reasonLine } from '../reports/messages/catalog.ts';

export type SellRule = 'THIRDS_RUNNER' | 'HALVES_FULL_EXIT';
/** EXIT_ALL / TRIM_NOW / NO_SALE: the weekly-stops flag only (jobs/exit/sellPlans.ts, owner 2026-11-05). */
export type PlanKind = SellRule | 'EXIT_ALL_EXPIRY' | 'EXPIRED' | 'SINGLE_UNIT_CHOICE' | 'RUNNER_ONLY' | 'NO_QUANTITY' | 'EXIT_ALL' | 'TRIM_NOW' | 'NO_SALE';
export type OptionClass = 'LEAPS' | 'SHORT_TERM' | 'UNCLASSIFIED';
export type ReachFit = 'COMFORTABLE' | 'TIGHT' | 'UNLIKELY';

const EPS = 1e-9;

export interface PlanAmounts {
  readonly rule: SellRule;
  readonly quantity: number;
  readonly atT1: number;
  readonly atT2: number;
  readonly runner: number;
}

/** The remembered plan a later run continues (stores/exitTargetHistory.ts decideAnchor). */
export interface StageMemory {
  readonly originalQuantity: number;
  readonly plannedAtT1: number;
  readonly plannedAtT2: number;
  /** 'YYYY-MM-DD': the day this plan started. */
  readonly since: string;
  readonly rule: SellRule;
}

export interface SellPlanInput {
  readonly kind: 'STOCK' | 'OPTION';
  /** Shares, or contracts. */
  readonly quantity: number | null;
  readonly optionClass?: OptionClass;
  readonly daysToExpiry?: number | null;
  readonly expiryThreshold?: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly hitT1?: boolean;
  readonly hitT2?: boolean;
  /** Estimated trading days for the (underlying) price to reach each target; null when unknown or reached. */
  readonly daysToT1?: number | null;
  readonly daysToT2?: number | null;
  readonly stop?: number | null;
  readonly stage?: StageMemory | null;
}

export interface SellPlan {
  readonly kind: PlanKind;
  readonly rule: SellRule | null;
  readonly stage: 1 | 2 | 3 | null;
  readonly unit: 'share' | 'contract';
  readonly quantity: number | null;
  readonly sellAtT1: number;
  readonly sellAtT2: number;
  readonly sellNow: number;
  readonly runner: number;
  /** Plain English: the first line is the one-line summary, the rest are the steps. */
  readonly lines: readonly string[];
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const qty = (n: number): string => String(round4(n));
const units = (n: number, unit: string): string => qty(n) + ' ' + unit + (Math.abs(n - 1) < EPS ? '' : 's');
/** $1,234.56: the same money format as the Exit report (audit #49). */
const usd = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 'Feb 12, 2026' for a 'YYYY-MM-DD' day. */
const dayText = (day: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(day)
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(day + 'T00:00:00Z'))
  : day);

export function splitRuleFor(kind: 'STOCK' | 'OPTION', optionClass?: OptionClass): SellRule {
  return kind === 'STOCK' || optionClass === 'LEAPS' ? 'THIRDS_RUNNER' : 'HALVES_FULL_EXIT';
}

/** The split for a position of `quantity` units (null when there is no usable quantity). Below 2 units: the whole position at one target. */
export function planAmounts(kind: 'STOCK' | 'OPTION', optionClass: OptionClass | undefined, quantity: number | null | undefined): PlanAmounts | null {
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) return null;
  const rule = splitRuleFor(kind, optionClass);
  if (quantity < 2) return { rule, quantity, atT1: quantity, atT2: 0, runner: 0 };
  if (rule === 'THIRDS_RUNNER') {
    const a = Math.max(1, Math.floor(quantity / 3));
    return { rule, quantity, atT1: a, atT2: a, runner: round4(quantity - 2 * a) };
  }
  const a = Math.max(1, Math.floor(quantity / 2));
  return { rule, quantity, atT1: a, atT2: round4(quantity - a), runner: 0 };
}

/** Days to reach (trading days) against days to expiry (calendar days). No probability, only a plain fit word. */
export function reachFit(tradingDays: number | null | undefined, daysToExpiry: number | null | undefined): ReachFit | null {
  if (tradingDays == null || daysToExpiry == null || !(daysToExpiry > 0)) return null;
  const calendarDays = tradingDays * 7 / 5;
  return calendarDays <= daysToExpiry * 0.5 ? 'COMFORTABLE' : calendarDays <= daysToExpiry ? 'TIGHT' : 'UNLIKELY';
}

const FIT_TEXT: Readonly<Record<ReachFit, string>> = {
  COMFORTABLE: 'comfortably before expiry',
  TIGHT: 'close to expiry',
  UNLIKELY: 'probably after expiry at the usual pace',
};

const RULE_TEXT: Readonly<Record<SellRule, string>> = {
  THIRDS_RUNNER: 'about a third at each target, the rest kept on the trailing stop (the rule for stocks and long-dated options).',
  HALVES_FULL_EXIT: 'half at each target, a full exit (the rule for short-dated options).',
};

function targetText(name: 'T1' | 'T2', price: number | null, hit: boolean, days: number | null | undefined, i: SellPlanInput): string {
  if (price == null) return name + ' (no target this run)';
  if (hit) return name + ' (' + usd(price) + ', already reached)';
  let s = name + ' (' + usd(price) + (days != null ? ', about ' + Math.round(days) + ' trading day' + (Math.round(days) === 1 ? '' : 's') + ' away at the usual pace, an estimate' : '') + ')';
  if (i.kind === 'OPTION' && i.daysToExpiry != null && i.daysToExpiry > 0) {
    const fit = reachFit(days, i.daysToExpiry);
    s += ', ' + i.daysToExpiry + ' days to expiry' + (fit ? ': ' + FIT_TEXT[fit] : '');
  }
  return s;
}

const empty = (kind: PlanKind, unit: 'share' | 'contract', quantity: number | null, lines: string[], over: Partial<SellPlan> = {}): SellPlan =>
  ({ kind, rule: null, stage: null, unit, quantity, sellAtT1: 0, sellAtT2: 0, sellNow: 0, runner: 0, lines, ...over });

export function buildSellPlan(i: SellPlanInput): SellPlan {
  const unit = i.kind === 'OPTION' ? 'contract' : 'share';
  const q = i.quantity;
  const fresh = planAmounts(i.kind, i.optionClass, q);
  if (!fresh || q == null) return empty('NO_QUANTITY', unit, q ?? null, ['The quantity is missing on the Portfolio sheet, so no sell amounts can be shown. ' + reasonLine('FIELD_MISSING')]);
  const dte = i.kind === 'OPTION' ? (i.daysToExpiry ?? null) : null;
  if (dte != null && dte <= 0) return empty('EXPIRED', unit, q, ['Expired: there is nothing left to sell. Check whether this row is still open.']);
  if (dte != null && i.expiryThreshold != null && dte <= i.expiryThreshold) {
    return empty('EXIT_ALL_EXPIRY', unit, q, [
      'Sell all ' + units(q, unit) + ' now: the contract is ' + dte + ' days from expiry, inside its ' + i.expiryThreshold + '-day exit window.',
      'Expiry comes before the price targets, so there is no staged plan and no runner.',
    ], { rule: fresh.rule, sellNow: q });
  }
  const hit1 = !!i.hitT1, hit2 = !!i.hitT2;
  if (q < 2) {
    const lines = [
      'With ' + units(q, unit) + ' the position cannot be split: sell all of it at T1, or hold all of it for T2.',
      '• Choice 1: sell at ' + targetText('T1', i.t1, hit1, i.daysToT1, i) + '.',
      '• Choice 2: hold for ' + targetText('T2', i.t2, hit2, i.daysToT2, i) + '.',
    ];
    if (i.kind === 'OPTION') lines.push('No probability is shown: the days are an estimate at the usual pace, not a forecast.');
    return empty('SINGLE_UNIT_CHOICE', unit, q, lines, { rule: fresh.rule });
  }

  // The plan in force: a remembered plan of the same rule on a larger original position continues; anything else is a fresh plan.
  const st = i.stage;
  const continues = !!st && st.rule === fresh.rule && st.originalQuantity > q + EPS;
  const plan: PlanAmounts = continues && st ? { rule: fresh.rule, quantity: st.originalQuantity, atT1: st.plannedAtT1, atT2: st.plannedAtT2, runner: round4(st.originalQuantity - st.plannedAtT1 - st.plannedAtT2) } : fresh;
  const sold = continues && st ? round4(st.originalQuantity - q) : 0;
  const targetSales = plan.atT1 + plan.atT2;

  if (sold <= EPS) {
    const left1 = round4(q - plan.atT1), left2 = round4(left1 - plan.atT2);
    // 2 units under the thirds rule leave no runner: that reads as a full exit, never "keep 0".
    const tail = plan.rule === 'THIRDS_RUNNER' && plan.runner > EPS
      ? ', keep ' + qty(plan.runner) + ' on the trailing stop'
      : ', a full exit';
    const lines = [
      'Sell ' + units(plan.atT1, unit) + ' at T1 and ' + qty(plan.atT2) + ' at T2' + tail + ' (' + units(q, unit) + ' now).',
      'Plan: ' + RULE_TEXT[plan.rule],
      '• At ' + targetText('T1', i.t1, hit1, i.daysToT1, i) + ': ' + (hit1 ? 'sell ' + units(plan.atT1, unit) + ' now' : 'sell ' + units(plan.atT1, unit)) + ', ' + qty(left1) + ' left.',
      '• At ' + targetText('T2', i.t2, hit2, i.daysToT2, i) + ': ' + (hit2 ? 'sell ' + units(plan.atT2, unit) + ' now' : 'sell ' + units(plan.atT2, unit)) + ', ' + (left2 > EPS ? qty(left2) + ' left on the trailing stop' + (i.stop != null ? ' (' + usd(i.stop) + ')' : '') : 'nothing left') + '.',
    ];
    return { kind: plan.rule, rule: plan.rule, stage: 1, unit, quantity: q, sellAtT1: plan.atT1, sellAtT2: plan.atT2, sellNow: 0, runner: round4(Math.max(0, left2)), lines };
  }

  if (sold < targetSales - EPS) {
    const next = plan.rule === 'HALVES_FULL_EXIT' ? q : Math.min(q, round4(targetSales - sold));
    const runner = round4(q - next);
    const lines = [
      'Stage 2: sell ' + units(next, unit) + ' at the next target' + (runner > EPS ? ', keep ' + qty(runner) + ' on the trailing stop' : ', a full exit') + ' (' + units(q, unit) + ' now).',
      'The plan from ' + dayText(st!.since) + ' continues: ' + units(sold, unit) + ' already sold of ' + qty(plan.quantity) + '. It is not split again.',
      '• Next, at ' + targetText('T1', i.t1, hit1, i.daysToT1, i) + ': sell ' + units(next, unit) + (hit1 ? ' now' : '') + '.',
    ];
    if (i.t2 != null) lines.push('• ' + targetText('T2', i.t2, hit2, i.daysToT2, i) + ' is the stretch target if you prefer to wait.');
    return { kind: plan.rule, rule: plan.rule, stage: 2, unit, quantity: q, sellAtT1: next, sellAtT2: 0, sellNow: 0, runner, lines };
  }

  return {
    kind: 'RUNNER_ONLY', rule: plan.rule, stage: 3, unit, quantity: q, sellAtT1: 0, sellAtT2: 0, sellNow: 0, runner: q,
    lines: [
      'Both target sales are done: keep all ' + units(q, unit) + ' on the trailing stop' + (i.stop != null ? ' (' + usd(i.stop) + ')' : '') + '.',
      'The plan from ' + dayText(st!.since) + ' started with ' + qty(plan.quantity) + '; ' + qty(sold) + ' sold since then.',
    ],
  };
}
