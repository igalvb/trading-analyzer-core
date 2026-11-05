/**
 * The live bot's target (phase 1, 1.1): what the real account should hold after the next open, as WEIGHTS, read from
 * the chosen paper account after the Nightly (paper/paperLab.ts state, read only; nothing here decides anything).
 *
 * How a research account holds its money (paperLab.ts labDay, confirmed): at the open it sells `toSell`, then buys
 * each `toBuy` stock with 1/slots of the account's equity at the open (funded from QQQ), then puts all spare cash in
 * QQQ (whole shares; a remainder under one QQQ share stays cash). A stock it keeps is NOT topped up or trimmed: it
 * keeps its share count and drifts with its price. So the target is
 *   mirror (default): each kept stock at its weight in the paper account tonight, each new buy at 1/slots (less if
 *                     the kept stocks leave less), the rest in QQQ -- exactly what the twin will hold after the open;
 *   equal:            each kept stock and each new buy at 1/slots, the rest in QQQ (the plan's literal wording; it
 *                     rebalances every night, which the twin does not, and costs fees).
 *
 * Supported: the 10 research accounts of group B (LAB_SETUPS). Not supported, and why:
 *   - the 6 original accounts (group A): idle money in cash, not QQQ; 6 slots over the fixed universe plus the live
 *     watchlist (outside the owner's list, the allow-list); partial sells by thirds at targets;
 *   - LILO: limit-order ladders with stops and targets during the day, not weights at the open;
 *   - the LEAPS twins (group C): option contracts of $4,000-$13,000, bigger than the whole $1,000; phase 1 plans
 *     no options (long calls stay allowed by the rails, D4);
 *   - Everything together (group D): half of it is LEAPS, and its shares half has no value of its own in the marks
 *     to compare with.
 */

import type { PaperState } from '../paper/paperTrading.ts';
import { LAB_SETUPS, LILO_ID, LEAPS_IDS, ALL_ID, ALL_SHARES, ALL_LEAPS_ID, type LabSetup } from '../paper/paperLab.ts';
import { STRATEGIES } from '../paper/paperTrading.ts';
import type { TargetMode } from './liveConfig.ts';

export const SUPPORTED_ACCOUNTS: readonly LabSetup[] = LAB_SETUPS;

export const UNSUPPORTED_WHY: ReadonlyArray<{ readonly ids: readonly string[]; readonly why: string }> = [
  { ids: [...STRATEGIES], why: 'the original accounts keep idle money in cash (not QQQ), use 6 slots over a universe outside the owner\'s list, and sell in thirds at targets' },
  { ids: [LILO_ID], why: 'LILO trades limit-order ladders with stops and targets during the day, not weights at the open' },
  { ids: [...LEAPS_IDS], why: 'LEAPS contracts cost $4,000-$13,000, more than the whole $1,000; phase 1 plans no options' },
  { ids: [ALL_ID, ALL_SHARES.id, ALL_LEAPS_ID], why: 'Everything together is half LEAPS, and its shares half has no value of its own to compare with' },
];

export type Support = { readonly ok: true; readonly setup: LabSetup } | { readonly ok: false; readonly why: string };

export function supportOf(id: string): Support {
  const setup = SUPPORTED_ACCOUNTS.find((s) => s.id === id);
  if (setup) return { ok: true, setup };
  const u = UNSUPPORTED_WHY.find((x) => x.ids.includes(id));
  return { ok: false, why: u ? u.why : '"' + id + '" is not an account of the paper test (supported: ' + SUPPORTED_ACCOUNTS.map((s) => s.id).join(', ') + ')' };
}

export interface Target {
  readonly account: string;
  readonly label: string;
  readonly slots: number;
  /** The paper test's decision day (its last closed day). */
  readonly decisionDay: string;
  /** Ticker -> share of the account, 0..1; the stocks being sold are present at 0; QQQ holds the rest. */
  readonly weights: Readonly<Record<string, number>>;
  /** Ticker -> the twin's reason, for the log. */
  readonly why: Readonly<Record<string, string>>;
  readonly sells: readonly string[];
  readonly buys: readonly string[];
}

export type TargetResult = { readonly ok: true; readonly target: Target } | { readonly ok: false; readonly why: string };

/** The paper account's target weights after the next open. `closeOf`: tonight's close (null = unknown: its cost is used). */
export function targetWeights(state: PaperState, id: string, closeOf: (t: string) => number | null, mode: TargetMode = 'mirror'): TargetResult {
  const s = supportOf(id);
  if (!s.ok) return s;
  const st = s.setup;
  const a = state.lab?.accounts[id];
  if (!a || !state.lastDay) return { ok: false, why: 'the paper account ' + st.label + ' has no saved state yet' };
  if (state.lastDay >= state.end) return { ok: false, why: 'the paper test ended on ' + state.end + '; it makes no new decisions' };
  const px = (t: string): number => { const p = a.pos[t]!; return closeOf(t) ?? p.cost / p.shares; };
  let equity = a.cash;
  for (const t of Object.keys(a.pos)) equity += a.pos[t]!.shares * px(t);
  if (!(equity > 0)) return { ok: false, why: 'the paper account ' + st.label + ' has no value' };
  const slot = 1 / st.slots;
  const kept = Object.keys(a.pos).filter((t) => t !== 'QQQ' && !a.toSell.includes(t)).sort();
  const buys = a.toBuy.filter((t) => !a.pos[t]);
  const weights: Record<string, number> = {}, why: Record<string, string> = {};
  let left = 1;
  for (const t of kept) {
    const w = mode === 'equal' ? slot : (a.pos[t]!.shares * px(t)) / equity;
    weights[t] = w; left -= w; why[t] = 'the twin keeps it' + (mode === 'equal' ? ' (1/' + st.slots + ' of the account)' : ' (' + (w * 100).toFixed(1) + '% of it tonight)');
  }
  for (const t of buys) {
    const w = Math.max(0, Math.min(slot, left));
    weights[t] = w; left -= w; why[t] = 'the twin buys it at the next open (1/' + st.slots + ' of the account)';
  }
  for (const t of a.toSell) { if (a.pos[t]) { weights[t] = 0; why[t] = 'the twin sells it at the next open (' + (st.sell === 'trend200' ? '200-day trend broke' : 'its model says sell') + ')'; } }
  weights.QQQ = Math.max(0, left);
  why.QQQ = 'spare money waits in QQQ, as in the twin';
  return { ok: true, target: { account: id, label: st.label, slots: st.slots, decisionDay: state.lastDay, weights, why, sells: a.toSell.filter((t) => a.pos[t]), buys } };
}
