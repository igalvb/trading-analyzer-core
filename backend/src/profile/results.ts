/**
 * GENERIC_PLAN P4: the results pack. The history numbers the analysis pages print (each model's simulation on the
 * research list, 2010-19 / 2020-23 / 2024-26, after tax) are DATA of one user's research, not engine code. They live
 * in a JSON file per profile, named by the profile key `results`; the core holds no history figure.
 *
 *   profile.results = null      -> no pack: the pages print NO_HISTORY instead of numbers
 *   profile.results = '<name>'  -> <RESULTS_DIR, else src/owner/results (a private overlay), else backend/results>/<name>.json;
 *                                  a missing or bad pack refuses the run
 */

import fs from 'node:fs';
import path from 'node:path';
import { activeProfile } from './active.ts';
import { overlayResultsDir } from '../overlay.ts';

/** What the pages print when the profile has no results pack. */
export const NO_HISTORY = 'No history for your list yet. Run the research step.';

/** Three periods as text: three signed percents joined by " / ". */
type H3 = string;

export interface ResultsPack {
  readonly name: string;
  /** What the research was run on: the list's name, its hold yardstick, and the tax rate used (as text). */
  readonly basis: { readonly list: string; readonly holdList: string; readonly tax: string };
  /** The All Models page: model key -> history text (reportPages.ts MODEL_SIMULATION keys). */
  readonly models: Readonly<Record<string, string>>;
  readonly james: {
    readonly liloV2: { readonly chosen: H3; readonly fall: string; readonly defaultRun: H3; readonly verdict: string };
    readonly profitTaking: { readonly line: string; readonly detail: string; readonly verdict: string };
    readonly qqq: H3; readonly list14: H3;
  };
  readonly james2: {
    readonly meanRev: { readonly chosen: H3; readonly fall: string; readonly defaultRun: H3; readonly verdict: string; readonly claim: string };
    readonly pair: Readonly<Record<string, { readonly run: string; readonly fiftyFifty: string; readonly fall: string; readonly roth: string; readonly when: string }>>;
    readonly pairVerdict: string;
    readonly winners: { readonly chosen: H3; readonly fall: string; readonly defaultRun: H3; readonly verdict: string };
    readonly qqq: H3; readonly list14: H3;
  };
  readonly james3: {
    readonly cycle: { readonly chosen: H3; readonly fall: string; readonly defaultRun: H3; readonly verdict: string; readonly panic: string };
    readonly mm: { readonly chosen: H3; readonly fall: string; readonly verdict: string };
    readonly qqq: H3; readonly list14: H3;
  };
  readonly james4: {
    readonly shares: H3; readonly sharesFall: string; readonly leapsCap: H3; readonly leapsCapFall: string;
    readonly leapsUncapped: H3; readonly leapsUncappedFall: string; readonly verdict: string;
    readonly qqq: H3; readonly list14: H3; readonly everythingLeaps: H3;
  };
  readonly james5: {
    readonly trend200: { readonly gated: H3; readonly ungated: H3; readonly fall: string };
    readonly combo: { readonly gated: H3; readonly ungated: H3; readonly fall: string };
    readonly engine: { readonly gated: H3; readonly ungated: H3; readonly fall: string };
    readonly best: { readonly gated: H3; readonly ungated: H3; readonly fall: string };
    readonly asWritten: string; readonly verdict: string;
    readonly qqq: H3; readonly list14: H3;
  };
}

const SECTIONS = ['basis', 'models', 'james', 'james2', 'james3', 'james4', 'james5'] as const;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Every leaf must be text (a pack holds words and figures as text only). */
function allText(v: unknown): boolean {
  if (typeof v === 'string') return true;
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.values(v).every(allText);
  return false;
}

/** Checks a parsed pack; returns the problems found (empty = good). */
export function packProblems(v: unknown, name: string): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['the pack must be an object'];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  if (o.name !== name) out.push('its name is not ' + name);
  for (const s of SECTIONS) if (!(s in o)) out.push('section ' + s + ' is missing');
  if (!allText(o)) out.push('every value must be text');
  return out;
}

/** The default results folder: src/owner/results/ in a copy with a private overlay, else backend/results/ (src/overlay.ts). */
export const defaultResultsDir = (): string => overlayResultsDir();

/** Loads the pack `name` from `dir`; throws one plain line when it is missing or bad. */
export function loadResultsPack(name: string, dir: string = process.env.RESULTS_DIR || defaultResultsDir()): ResultsPack {
  if (!NAME.test(name)) throw new Error('The results pack name "' + name + '" is not valid.');
  const file = path.join(dir, name + '.json');
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('The results pack ' + name + ' could not be read (' + file + '): ' + String((e as Error).message ?? e)); }
  const bad = packProblems(v, name);
  if (bad.length) throw new Error('The results pack ' + name + ' is not valid: ' + bad.join('; '));
  return v as ResultsPack;
}

/** This run's pack (profile `results`), or null when the profile names none. */
export const RESULTS: ResultsPack | null = ((): ResultsPack | null => {
  const name = activeProfile().results;
  return name ? loadResultsPack(name) : null;
})();
