/**
 * The Phase-4 LILO ladders of fullStockAnalysisV10_9.gs (pure display
 * constructs -- they re-slice the entry and exit prices Phase 1 already
 * computed, no new price-target logic):
 *   computeStockEntryLadderV7 :3362-3373, ladderDisplayPercentsV7_ :3379-3385,
 *   computeStockExitLadderV7 :3389-3396, computeOptionsEntryLadderV7 :3402,
 *   computeOptionsExitLadderV7 :3403, optionsLadderTimeDecayNoteV7 :3407-3409,
 *   optionsExpiryFlagV7 :3412-3418
 */

export interface LadderRung {
  readonly rung: number;
  readonly price: number;
  portion: number;
}

/** What the entry ladder reads of the confluence result. */
export interface LadderConfluence {
  readonly entryCount?: unknown;
  readonly entryLow: number;
  readonly entryHigh: number;
}

/** What the exit ladder reads of the tech plan: a target is `{ price }`, falsy when absent. */
export interface LadderTechPlan {
  readonly t1?: { readonly price: number } | null;
  readonly t2?: { readonly price: number } | null;
}

/**
 * computeStockEntryLadderV7 (:3362-3373): equal-split rungs, one per aligned
 * method; the highest rung is nearest the current price. A count that is not
 * a positive integer gives an empty ladder, never a fabricated one (P2-4).
 * F-B4: any positive integer is accepted, so a huge count (1e21) loops until
 * memory runs out, exactly as in legacy.
 */
export function computeStockEntryLadder(confluence: LadderConfluence): LadderRung[] {
  const rawCount = confluence.entryCount;
  if (!Number.isInteger(rawCount) || (rawCount as number) <= 0) return [];
  const n = rawCount as number;
  const low = confluence.entryLow, high = confluence.entryHigh;
  const rungs: LadderRung[] = [];
  for (let i = 0; i < n; i++) {
    const price = n === 1 ? high : high - (high - low) * (i / (n - 1));
    rungs.push({ rung: i + 1, price, portion: 1 / n });
  }
  return rungs;
}

/** ladderDisplayPercentsV7_ (:3379-3385): whole percentages that always sum to 100 (the residual goes on the last rung). */
export function ladderDisplayPercents(rungs: readonly { readonly portion: number }[]): number[] {
  if (!rungs.length) return [];
  const raw = rungs.map((r) => Math.round(r.portion * 100));
  const sum = raw.reduce((a, b) => a + b, 0);
  raw[raw.length - 1] += (100 - sum);
  return raw;
}

/** computeStockExitLadderV7 (:3389-3396): T1 and T2, equal split. */
export function computeStockExitLadder(techPlan: LadderTechPlan): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (techPlan.t1) rungs.push({ rung: 1, price: techPlan.t1.price, portion: undefined as unknown as number });
  if (techPlan.t2) rungs.push({ rung: 2, price: techPlan.t2.price, portion: undefined as unknown as number });
  if (!rungs.length) return [];
  rungs.forEach((r) => { r.portion = 1 / rungs.length; });
  return rungs;
}

/** computeOptionsEntryLadderV7 (:3402): the stock ladder's triggers, for more contracts of the SAME strike and expiry. */
export function computeOptionsEntryLadder(confluence: LadderConfluence): LadderRung[] {
  return computeStockEntryLadder(confluence);
}

/** computeOptionsExitLadderV7 (:3403). */
export function computeOptionsExitLadder(techPlan: LadderTechPlan): LadderRung[] {
  return computeStockExitLadder(techPlan);
}

/** optionsLadderTimeDecayNoteV7 (:3407-3409): shown every time an options ladder renders. */
export function optionsLadderTimeDecayNote(): string {
  return 'Waiting for a deeper entry costs time value on this option — the longer you wait, the less time decay matters (LEAPS decay slowly early on), but it is not free. Consider this before spreading LEAPS entries out too far.';
}

/** optionsExpiryFlagV7 (:3412-3418): expiry-proximity flag, independent of the price target. */
export function optionsExpiryFlag(daysToExpiry: number | null | undefined): string | null {
  const THRESHOLD_DAYS = 45;
  if (daysToExpiry != null && daysToExpiry <= THRESHOLD_DAYS) {
    return '⚠ ' + daysToExpiry + ' days to expiry — consider closing regardless of price target';
  }
  return null;
}
