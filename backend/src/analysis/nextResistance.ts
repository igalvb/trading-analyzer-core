/**
 * Fix plan 2026-10-30 B1, owner-approved option B part 1 (display only): the NEXT resistance above the entry.
 *
 * T1 stays today's (the biggest confluence cluster, promoted past 1 ATR) for the conviction, the R:R gate, LILO and
 * every decision. Next to it, the reports also show the nearest cluster of valid (not excluded) target methods at
 * least one ATR above the entry -- the nearestTargets computation (techPlan/entryPlan.ts deriveNearestExitTargets) --
 * with its distance from today's price, the methods that form it, and the R:R to it from the plan's entry and stop:
 *
 *   "Next resistance: $409.85 (+1%, Pivot R1, Fib 1.272) · R:R to it 0.95"
 *
 * This is the one place that computes it and words it; the Bottom Line, the Analysis v7 entry/exit zones, the
 * Options Decision exit plan, the LILO page and the AI input (KEY NUMBERS) print it. Never used in legacy-parity
 * mode (the callers gate it).
 *
 * Part 2 (the T2 bug) is also display only here: today's T2 can come from methods the confluence excluded (TSLA $2,187,
 * AMD $6,701 on 2026-10-27). Switching the fix on made LILO -- the one setup that sells at T2 -- worse in 2010-2019 by
 * 70-77 points (docs/models/results/targets-test.md), so T2 stays today's and the reports show "T2 (fixed): $X" next
 * to it (fixedT2Display) wherever T2 is shown: the Options Decision exit plan, the LILO page and the AI input.
 */

import type { ConfluenceTargets } from './confluence.ts';
import { deriveExitTargets, deriveNearestExitTargets } from './techPlan/entryPlan.ts';

export interface NextResistanceInput {
  readonly confluence: Pick<ConfluenceTargets, 'allExitMethods' | 'exitCenter'> | null | undefined;
  readonly atr: unknown;
  readonly entryPrice: unknown;
  readonly stop: unknown;
  readonly currentPrice: unknown;
  /** Today's T1 price: when the next resistance IS T1 there is nothing to add, and nothing is shown. */
  readonly t1Price?: unknown;
}

export interface NextResistance {
  readonly price: number;
  readonly low: number;
  readonly high: number;
  /** The methods forming the cluster, nearest first as the cluster lists them. */
  readonly methods: readonly string[];
  /** % above (or below) today's price. */
  readonly pctFromPrice: number;
  /** (price - entry) / (entry - stop); null when the risk is not positive. */
  readonly rr: number | null;
  /** "Next resistance: $X (+Y%, methods) · R:R to it Z". */
  readonly text: string;
}

export const NEXT_RESISTANCE_PREFIX = 'Next resistance: ';

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const usd = (n: number): string => '$' + n.toFixed(2);

/** Null when there is no valid level 1 ATR above the entry, or when it is today's T1 itself. */
export function nextResistance(i: NextResistanceInput): NextResistance | null {
  const c = i.confluence;
  const entry = fin(i.entryPrice), cp = fin(i.currentPrice), stop = fin(i.stop), atr = fin(i.atr), t1 = fin(i.t1Price);
  if (!c || entry == null || cp == null || cp <= 0) return null;
  const near = deriveNearestExitTargets(c as ConfluenceTargets, atr, entry);
  if (!near) return null;
  const { price, low, high, basis } = near.t1;
  const risk = stop != null ? entry - stop : null;
  const rr = risk != null && risk > 0 ? (price - entry) / risk : null;
  const pct = (price / cp - 1) * 100;
  if (t1 != null && Math.abs(t1 - price) < 0.005) return null;
  const text = NEXT_RESISTANCE_PREFIX + usd(price) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%, ' + basis.join(', ') + ')'
    + ' · R:R to it ' + (rr != null ? rr.toFixed(2) : '—');
  return { price, low, high, methods: basis, pctFromPrice: pct, rr, text };
}

export interface FixedT2Input {
  readonly confluence: ConfluenceTargets | null | undefined;
  readonly atr: unknown;
  readonly entryPrice: unknown;
  /** Today's T2 price (null = no T2). */
  readonly t2Price: unknown;
}

export interface FixedT2Display {
  /** T2 with the excluded methods skipped (ExitTargetOptions.fixedT2); null = none. */
  readonly price: number | null;
  readonly methods: readonly string[];
  /** "T2 (fixed): $X (excluded methods skipped)" or "T2 (fixed): none (...)". */
  readonly text: string;
}

export const FIXED_T2_PREFIX = 'T2 (fixed): ';

/** The fixed T2 beside today's T2; null when they are the same (nothing to show) or there is no confluence. */
export function fixedT2Display(i: FixedT2Input): FixedT2Display | null {
  const c = i.confluence, entry = fin(i.entryPrice), t2 = fin(i.t2Price);
  if (!c) return null;
  const f = deriveExitTargets(c, fin(i.atr), entry, { fixedT2: true }).t2;
  const price = f ? f.price : null;
  if ((price == null && t2 == null) || (price != null && t2 != null && Math.abs(price - t2) < 0.005)) return null;
  const text = FIXED_T2_PREFIX + (price != null
    ? usd(price) + ' (excluded methods skipped; from ' + (f as { basis: string[] }).basis.join(', ') + ')'
    : 'none (the T2 shown comes only from methods the zones excluded)');
  return { price, methods: f ? f.basis : [], text };
}
