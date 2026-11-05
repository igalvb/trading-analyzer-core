/**
 * The stored research run of the fee report (feeReport.ts), for the nightly (which has no research files):
 * `npm run live-fee-report -- --prices DIR --reads DIR --json` with the IBKR Pro estimate and a $1000 account.
 * Refresh it the same way after a change to the setups, the fee model or the research data.
 *
 * GENERIC_PLAN P4 follow-up: the table is one user's research (run on that user's list), so it is DATA in the
 * user's results folder, not code: `<RESULTS_DIR or src/owner/results>/<profile.results>.fees.json`. No results pack,
 * or no fees file next to it = null (the fee report then says it has no research run).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ResearchFeeTable } from './feeReport.ts';
import { activeProfile } from '../profile/active.ts';
import { defaultResultsDir } from '../profile/results.ts';

export function loadResearchFees(name: string | null, dir: string = process.env.RESULTS_DIR || defaultResultsDir()): ResearchFeeTable | null {
  if (!name) return null;
  const file = path.join(dir, name + '.fees.json');
  if (!fs.existsSync(file)) return null;
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as ResearchFeeTable;
  if (!v || !Array.isArray(v.rows)) throw new Error('The fees file ' + name + '.fees.json is not valid (no rows).');
  return v;
}

export const RESEARCH_FEES: ResearchFeeTable | null = loadResearchFees(activeProfile().results);
