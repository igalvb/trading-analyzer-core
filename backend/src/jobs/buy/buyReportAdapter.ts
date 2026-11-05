/**
 * FL-9d: pure adapter from the Buy pipeline's BuyRun to the Buy sheet's BuyReportInput (reports/buySheet/types.ts).
 *
 * Assumed target interface: buildBuySheet(ss, input: BuyReportInput, deps) as exported by src/reports/buySheet/buySheet.ts.
 *  - every candidate (ok / degraded / failed) is kept, in the pipeline's report order;
 *  - models + comparison are normalised to ModelRead[] / ComparisonRead (the pipeline passes the analysis' real
 *    ComparisonReport through untouched);
 *  - fields the pipeline does not carry yet (techScore, rrToT1AtSpot, positioning) are explicit nulls;
 *  - note / opportunityCost / promotion / dataHealth are leak-scanned; a leaking string is replaced by a fixed sentence.
 */
import { reasonLine } from '../../reports/messages/catalog.ts';
import type { QualityItem } from '../../reports/messages/catalog.ts';
import { findReportLeaks } from '../../reports/messages/leakScan.ts';
import { readsFrom } from '../../reports/adapters/modelReads.ts';
import type { BitcoinDifferentiator, BitcoinSharedThesisInput, BuyCandidateInput, BuyReportInput } from '../../reports/buySheet/types.ts';
import { BUY_METHODOLOGY_CAVEATS, BUY_TIER1_MIN_CONVICTION, BUY_TIER2_MIN_CONVICTION } from './buyPipeline.ts';
import type { BuyCandidate, BuyRun } from './buyPipeline.ts';

export interface BuyAdapterOptions {
  /** Default: now. */
  readonly runAt?: Date;
  readonly dataHealth?: readonly QualityItem[];
  readonly tiers?: { readonly tier1Min: number; readonly tier2Min: number };
  readonly bitcoinSharedThesis?: BitcoinSharedThesisInput | null;
  readonly differentiators?: readonly BitcoinDifferentiator[] | null;
}

const SAFE_NOTE = reasonLine('SECTION_UNAVAILABLE');
const safe = (t: string | null): string | null => (t === null ? null : findReportLeaks(t).length ? SAFE_NOTE : t);

function candidateOf(c: BuyCandidate): BuyCandidateInput {
  const r = readsFrom(c.models, c.comparison);
  return {
    ...c,
    models: r.models,
    comparison: r.comparison,
    entryLadder: { rungs: c.entryLadder.rungs.map((x) => ({ rung: x.rung, price: x.price })), percents: [...c.entryLadder.percents] },
    opportunityCost: c.opportunityCost.map((s) => safe(s) as string),
    dataHealth: c.dataHealth.map((s) => safe(s) as string),
    promotion: safe(c.promotion),
    note: safe(c.note),
    techScore: null,
    rrToT1AtSpot: null,
    fundamentals: c.ownScore !== null || c.ownBand !== null ? { ownScore: c.ownScore, band: c.ownBand } : null,
    positioning: null,
  };
}

export function toBuyReportInput(run: BuyRun, opts: BuyAdapterOptions = {}): BuyReportInput {
  return {
    runAt: opts.runAt ?? new Date(),
    candidates: run.candidates.map(candidateOf),
    emptyText: run.emptyText,
    bitcoin: run.bitcoin
      ? { members: [...run.bitcoin.members], substitutesText: run.bitcoin.substitutesText, sharedThesis: opts.bitcoinSharedThesis ?? null, differentiators: opts.differentiators ?? null }
      : null,
    seeded: run.seeded,
    portfolioOk: run.portfolioOk,
    dataHealth: [...(opts.dataHealth ?? [])],
    tiers: opts.tiers ?? { tier1Min: BUY_TIER1_MIN_CONVICTION, tier2Min: BUY_TIER2_MIN_CONVICTION },
    methodologyCaveats: [...BUY_METHODOLOGY_CAVEATS],
  };
}
