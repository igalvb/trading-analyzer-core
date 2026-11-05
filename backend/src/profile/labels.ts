/**
 * GENERIC_PLAN P3: the words the reports use for the user's list, from the profile `labels.*` (C17). The owner's
 * profile holds today's words byte for byte (src/owner/profile.ts; test/owner.profile.test.ts pins them),
 * so the owner sees no change; a new user sees "your list".
 *
 * Labels are for display only. Logic never matches a label: the paper yardsticks are found by their keys
 * ('qqq', 'lab.list14', 'lab.list'; reports/digest/nightlyDigest.ts).
 */

import { activeProfile } from './active.ts';
import type { Profile } from './schema.ts';

const upFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const downFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export interface ListLabels {
  /** The research list, lower case: new user "your list". */
  readonly list: string;
  /** The same, first letter upper case: "Your list". */
  readonly List: string;
  /** The research-list yardstick, short: "Hold your list". */
  readonly holdList: string;
  /** The research-list yardstick row (paper key lab.list14): "Hold your list equally". */
  readonly holdResearchCore: string;
  /** The same in a sentence: "hold your list equally". */
  readonly holdResearchCoreLower: string;
  /** The whole-list yardstick row (paper key lab.list); the owner's ends with a note in brackets. */
  readonly holdCore: string;
  /** The whole-list yardstick without a note in brackets at the end. */
  readonly holdCoreShort: string;
  /** The research CLIs' name for the research list (labels.researchName), and its yardstick: "Hold " + it. */
  readonly research: string;
  readonly Research: string;
  readonly holdResearch: string;
}

export function listLabelsOf(p: Profile): ListLabels {
  const l = p.labels;
  return {
    list: l.listName,
    List: upFirst(l.listName),
    holdList: 'Hold ' + l.listName,
    holdResearchCore: l.holdResearchCore,
    holdResearchCoreLower: downFirst(l.holdResearchCore),
    holdCore: l.holdCore,
    holdCoreShort: l.holdCore.replace(/ \([^()]*\)$/, ''),
    research: l.researchName,
    Research: upFirst(l.researchName),
    holdResearch: 'Hold ' + l.researchName,
  };
}

/** The labels of this run's profile. */
export const LABELS: ListLabels = listLabelsOf(activeProfile());
