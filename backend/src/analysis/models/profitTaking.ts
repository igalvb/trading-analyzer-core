/**
 * G6, James — Master Profit-Taking (docs/models/plans/02-master-profit-taking.md): the five sell schedules of James's
 * spreadsheet template (InvestAnswers 2023-10-12 and 2023-12-03), which sell a position in steps at the LILO layers
 * 6, 7, 8, 9 and 10 (and, for the staggered schedule, five more steps every +20% above layer 10).
 *
 *   A20  20% of the CURRENT shares at each of L6..L10  -> 0.8^5  = 32.768% left
 *   A10  10% of the CURRENT shares at each of L6..L10  -> 0.9^5  = 59.049% left
 *   B20  20% of the INITIAL shares at each of L6..L10  -> 0% left (fully out at L10)
 *   B10  10% of the INITIAL shares at each              -> 50% left ("sell half, keep half"; the sheet, not the text)
 *   C    10% of the CURRENT shares at L6..L10, then at L10 x 1.2^j, j = 1..5 -> 0.9^10 = 34.868% left
 *
 * `sheetTable` rebuilds the sheet's rows 5-11 with the member-found bug fixed (HODL value = last layer price x B4,
 * ROI against the total cost B2 x B4). `profitTakingFills` is the exit used by any model (LILO v2, the research
 * portfolio and LILO books, the paper test). Pure, no I/O, display and research only: nothing here feeds a score.
 */

export const PT_SCHEDULES = ['A20', 'A10', 'B20', 'B10', 'C'] as const;
export type PtSchedule = (typeof PT_SCHEDULES)[number];
/** D4: the pre-registered default (the READ ME's first method, the 2023-10-07 preview's setting). */
export const PT_DEFAULT: PtSchedule = 'A20';

export interface PtSpec { readonly share: number; readonly of: 'current' | 'initial'; readonly steps: 5 | 10; readonly name: string }
export const PT_SPEC: Readonly<Record<PtSchedule, PtSpec>> = {
  A20: { share: 0.2, of: 'current', steps: 5, name: 'Incremental 20% (20% of what you hold at each of layers 6-10)' },
  A10: { share: 0.1, of: 'current', steps: 5, name: 'Incremental 10% (10% of what you hold at each of layers 6-10)' },
  B20: { share: 0.2, of: 'initial', steps: 5, name: 'Fixed 20% of the first position at each of layers 6-10 (fully out at layer 10)' },
  B10: { share: 0.1, of: 'initial', steps: 5, name: 'Fixed 10% of the first position at each of layers 6-10 (sell half, keep half)' },
  C: { share: 0.1, of: 'current', steps: 10, name: 'Staggered (10% of what you hold at layers 6-10, then at every +20% above layer 10)' },
};
/** The staggered schedule's step above layer 10. */
export const PT_STAGGER = 1.2;

/** The sell prices of a schedule from the 11 LILO layers: L6..L10, and for C five more at L10 x 1.2^j. */
export function scheduleLevels(levels11: readonly number[], id: PtSchedule): number[] {
  const base = levels11.slice(6, 11) as number[];
  if (PT_SPEC[id].steps === 5) return base;
  const top = base[4] as number;
  return [...base, ...[1, 2, 3, 4, 5].map((j) => top * PT_STAGGER ** j)];
}

/** The sell prices when there are no anchor layers: entry x (1.25, 1.5, 2, 2.5, 3) (plan 02 P1 "percent layers"). */
export const PERCENT_LAYERS: readonly number[] = [1.25, 1.5, 2, 2.5, 3];
export function percentLevels11(entry: number): number[] {
  return [NaN, NaN, NaN, NaN, NaN, NaN, ...PERCENT_LAYERS.map((m) => entry * m)];
}

// ─────────────────────────────── the sheet ───────────────────────────────

export interface SheetColumn {
  readonly price: number;
  /** Row 3, row 5, row 6, row 7 (cumulative cash), row 8 (value of what is left), row 9 (total). */
  readonly share: number; readonly sold: number; readonly remaining: number; readonly cash: number; readonly valueRemaining: number; readonly total: number;
  /** That column's money left on the table: units x price - total. */
  readonly leftOnTable: number;
}
export interface SheetTable {
  readonly columns: readonly SheetColumn[];
  /** Row 10, fixed: the last layer's price x the units (the sheet had G2 alone). */
  readonly hodl: number;
  readonly hodlRoi: number; readonly strategyRoi: number;
  /** Row 11: hodl - the last total. */
  readonly leftOnTable: number;
}

/**
 * The sheet for `units` tokens bought at `costPerUnit`, sold at `prices` (5 columns, or 10 for C), fractional as in
 * the sheet. ROIs are against the total cost (B2 x B4, the fix).
 */
export function sheetTable(costPerUnit: number, units: number, prices: readonly number[], id: PtSchedule): SheetTable {
  const sp = PT_SPEC[id];
  let remaining = units, cash = 0;
  const columns: SheetColumn[] = [];
  for (const price of prices.slice(0, sp.steps)) {
    const sold = sp.of === 'current' ? remaining * sp.share : units * sp.share;
    remaining -= sold; cash += sold * price;
    const valueRemaining = remaining * price, total = cash + valueRemaining;
    columns.push({ price, share: sp.share, sold, remaining, cash, valueRemaining, total, leftOnTable: units * price - total });
  }
  const last = columns[columns.length - 1]!;
  const cost = costPerUnit * units, hodl = last.price * units;
  return { columns, hodl, hodlRoi: hodl / cost - 1, strategyRoi: last.total / cost - 1, leftOnTable: hodl - last.total };
}

/** What is left of 1 unit after the whole schedule (closed forms: 0.32768, 0.59049, 0, 0.5, 0.3486784401). */
export function remainingAfter(id: PtSchedule): number {
  const sp = PT_SPEC[id];
  return sp.of === 'current' ? (1 - sp.share) ** sp.steps : Math.max(0, 1 - sp.share * sp.steps);
}

// ─────────────────────────────── whole shares, one position ───────────────────────────────

/**
 * Whole shares to sell at step `step` (0-based) of a position that started the schedule with `r0` shares and holds
 * `current`. A and C round their share of what is held and always keep the last share; B sells its share of r0,
 * rounded so that the total sold after k steps is round(k x share x r0) (B10 keeps about half; B20's last step sells
 * whatever is left: fully out).
 */
export function sharesToSell(id: PtSchedule, step: number, r0: number, current: number): number {
  const sp = PT_SPEC[id];
  if (current <= 0) return 0;
  if (sp.of === 'current') return Math.max(0, Math.min(current - 1, Math.round(current * sp.share)));
  if (id === 'B20' && step >= sp.steps - 1) return current;
  return Math.max(0, Math.min(current, Math.round(r0 * sp.share * (step + 1)) - Math.round(r0 * sp.share * step)));
}

/** One position's schedule, plain JSON (it is saved with the paper state). */
export interface PtState {
  readonly schedule: PtSchedule;
  /** The sell prices (5, or 10 for C), frozen when the position starts the schedule. */
  readonly levels: readonly number[];
  /** Steps done (sold or skipped). */
  fired: number;
  /** Shares at the start of the schedule (B sells a share of this); later buys add to it. */
  r0: number;
  /** Gross cash from the steps so far, and the price of the last step that sold (for the sheet's "left on the table"). */
  stepCash: number;
  lastPrice: number | null;
}

export function newPtState(id: PtSchedule, levels11: readonly number[], r0: number): PtState {
  return { schedule: id, levels: scheduleLevels(levels11, id), fired: 0, r0, stepCash: 0, lastPrice: null };
}

export interface PtFill { readonly step: number; readonly level: number; readonly shares: number; readonly price: number | null }

/**
 * The steps of one day. 'intraday' (default, P3): a resting limit sell at each known layer, filled when the high
 * reaches it, at max(layer, open); a gap through several layers sells each step, in order, at the open. 'close': a
 * step is due when the close reaches its layer (price null: the caller sells at the next open). A step at or under
 * `floor` (the position's cost per share, P2) is skipped, never sold at a loss to the schedule. Advances `st`.
 */
export function profitTakingFills(st: PtState, bar: { readonly open: number; readonly high: number; readonly close: number }, current: number, mode: 'intraday' | 'close' = 'intraday', floor = 0): PtFill[] {
  const out: PtFill[] = [];
  const reach = mode === 'intraday' ? bar.high : bar.close;
  let held = current;
  while (st.fired < st.levels.length && (st.levels[st.fired] as number) <= reach) {
    const step = st.fired, level = st.levels[step] as number;
    st.fired++;
    if (!(level > floor)) continue;
    const n = sharesToSell(st.schedule, step, st.r0, held);
    if (n <= 0) continue;
    held -= n;
    out.push({ step, level, shares: n, price: mode === 'intraday' ? Math.max(level, bar.open) : null });
  }
  return out;
}

/** Notes a sold step for the "left on the table" check. */
export function noteStep(st: PtState, shares: number, price: number): void {
  st.stepCash += shares * price;
  st.lastPrice = price;
}

/**
 * The sheet-faithful "money left on the table" of one position (pre-tax, the B4 fix): holding the r0 shares to the
 * last step's price, minus (the cash from the steps + the shares left x that price). Null when no step sold.
 */
export function sheetLeftOnTable(st: PtState, sharesLeft: number): number | null {
  if (st.lastPrice == null) return null;
  return st.r0 * st.lastPrice - (st.stepCash + sharesLeft * st.lastPrice);
}

/** The next step not done yet: its index and price, or null when the schedule is finished. */
export function nextStep(st: PtState): { step: number; level: number } | null {
  return st.fired < st.levels.length ? { step: st.fired, level: st.levels[st.fired] as number } : null;
}
