/**
 * The Exit tax calculation -- ONE rule, the user's (2026-10-25): tax is the profile's `tax.rate` of the gain, nothing
 * on a loss. No holding period, no long-term / short-term split, no sheet override. The rate is a working assumption,
 * not the user's real tax rate and not tax advice; every report that shows a figure says so.
 *
 *   gain              = (current price - average cost) x quantity x multiplier (100 for an option contract)
 *   tax               = max(0, gain) x tax.rate
 *   after-tax value   = market value - tax
 *
 * Shared by the Exit pipeline (jobs/exit/exitPipeline.ts) and the Exit sheet (reports/exitSheet/exitSheet.ts).
 */

import { activeProfile } from '../profile/active.ts';

/** Profile `tax.rate` (GENERIC_PLAN P2; required, no default). */
export const EXIT_TAX_RATE: number = activeProfile().tax.rate;
/** One listed option contract controls this many shares. */
export const OPTION_CONTRACT_MULTIPLIER = 100;
/** The rate as report text, e.g. '25%' (GENERIC_PLAN P3: every tax text is derived from the profile's rate). */
export const EXIT_TAX_PCT: string = String(Math.round(EXIT_TAX_RATE * 1000) / 10) + '%';
export const EXIT_TAX_ASSUMPTION = EXIT_TAX_PCT + ' of the gain is a working assumption, not your actual tax rate, and this is not tax advice.';

export interface ExitTaxInput {
  /** Shares for a stock, contracts for an option. */
  readonly quantity: number | null;
  /** Average cost per share, or premium paid per share of the option. */
  readonly unitCost: number | null;
  /** Current price per share, or current premium per share (0 is a real value: a worthless option). */
  readonly unitPrice: number | null;
  /** 1 for stock, 100 for options. */
  readonly multiplier?: number;
}

export interface ExitTax {
  readonly rate: number;
  readonly costBasisUsd: number | null;
  readonly marketValueUsd: number | null;
  readonly unrealizedUsd: number | null;
  /** Percent (12.5 = +12.5%). */
  readonly unrealizedPct: number | null;
  readonly taxOwedUsd: number | null;
  readonly afterTaxValueUsd: number | null;
  readonly afterTaxGainUsd: number | null;
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function computeExitTax(i: ExitTaxInput): ExitTax {
  const mult = i.multiplier ?? 1;
  const qty = fin(i.quantity) && i.quantity > 0 ? i.quantity : null;
  const cost = fin(i.unitCost) && i.unitCost > 0 ? i.unitCost : null;
  const price = fin(i.unitPrice) && i.unitPrice >= 0 ? i.unitPrice : null;
  const costBasisUsd = qty !== null && cost !== null ? qty * cost * mult : null;
  const marketValueUsd = qty !== null && price !== null ? qty * price * mult : null;
  const unrealizedUsd = costBasisUsd !== null && marketValueUsd !== null ? marketValueUsd - costBasisUsd : null;
  const unrealizedPct = cost !== null && price !== null ? (price / cost - 1) * 100 : null;
  const taxOwedUsd = unrealizedUsd !== null ? Math.max(0, unrealizedUsd) * EXIT_TAX_RATE : null;
  const afterTaxValueUsd = marketValueUsd !== null && taxOwedUsd !== null ? marketValueUsd - taxOwedUsd : null;
  const afterTaxGainUsd = unrealizedUsd !== null && taxOwedUsd !== null ? unrealizedUsd - taxOwedUsd : null;
  return { rate: EXIT_TAX_RATE, costBasisUsd, marketValueUsd, unrealizedUsd, unrealizedPct, taxOwedUsd, afterTaxValueUsd, afterTaxGainUsd };
}

function money(n: number): string {
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Plain-English lines for the pipeline's per-holding text. No codes, no raw errors. */
export function exitTaxLines(t: ExitTax): string[] {
  const out: string[] = [];
  if (t.unrealizedUsd !== null && t.unrealizedPct !== null) {
    out.push((t.unrealizedUsd >= 0 ? 'Unrealized gain: ' : 'Unrealized loss: ') + money(t.unrealizedUsd) + ' (' + (t.unrealizedPct >= 0 ? '+' : '') + t.unrealizedPct.toFixed(1) + '%).');
  }
  if (t.taxOwedUsd !== null && t.afterTaxValueUsd !== null) {
    out.push(t.taxOwedUsd > 0
      ? 'If sold today, about ' + money(t.taxOwedUsd) + ' would go to tax (' + EXIT_TAX_PCT + ' of the gain), leaving about ' + money(t.afterTaxValueUsd) + '.'
      : 'This position is not in profit, so no tax is assumed on a sale today.');
    out.push(EXIT_TAX_ASSUMPTION);
  }
  return out;
}
