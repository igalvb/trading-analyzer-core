/**
 * GENERIC_PLAN P2: the profile this run uses. Loaded once per process (profile/load.ts order: PROFILE_JSON, then
 * PROFILE_FILE, then the built-in profile of a private overlay, src/overlay.ts), so the constants that read it at
 * import (paper/paperLab.ts PAPER_OWNER_LIST, portfolio/exitTax.ts EXIT_TAX_RATE, ...) see the same profile everywhere
 * in the run.
 *
 * The workflows read the user's `⚙️ Profile` tab BEFORE the run (npm run profile-fetch writes it to PROFILE_FILE),
 * except for the default user of a copy with a built-in profile (src/owner/profile.ts): that one makes no extra sheet
 * request. A copy without a built-in profile and without PROFILE_JSON / PROFILE_FILE refuses to run with one line.
 *
 * A bad profile refuses the run with one plain line naming every problem (never a silent default).
 */

import { loadProfile, type ProfileSource } from './load.ts';
import type { Profile } from './schema.ts';
import { overlayProfileInput } from '../overlay.ts';
import { runProfileProblem } from './runUser.ts';
import { processLine } from '../core/logFile.ts';

let cached: { readonly profile: Profile; readonly source: ProfileSource } | null = null;

function load(): { readonly profile: Profile; readonly source: ProfileSource } {
  if (cached) return cached;
  const r = loadProfile(process.env, { fallback: overlayProfileInput() });
  if (!r.ok && r.source === 'none') {
    processLine('CRITICAL', 'profile', 'no profile; the run cannot start', { source: r.source });
    throw new Error('No profile: fill the ⚙️ Profile tab (or set PROFILE_FILE / PROFILE_JSON). Nothing was run.');
  }
  if (!r.ok) {
    // Loaded at import, before any run logger exists: the CRITICAL line goes to stderr and the run log file directly.
    processLine('CRITICAL', 'profile', 'the profile is not valid; the run cannot start', { source: r.source, errors: r.errors.join('; ') });
    throw new Error('The profile (' + r.source + ') is not valid: ' + r.errors.join('; '));
  }
  // P5: a run for another user never falls back to the owner's profile (profile/runUser.ts). Owner runs: no check.
  const problem = runProfileProblem(process.env, r.profile, r.source);
  if (problem) {
    processLine('CRITICAL', 'profile', 'the profile cannot be used for this run; the run cannot start', { source: r.source, problem });
    throw new Error('The profile cannot be used: ' + problem);
  }
  cached = { profile: r.profile, source: r.source };
  return cached;
}

/** The profile of this run (validated, defaults filled in). */
export function activeProfile(): Profile { return load().profile; }

/** Where this run's profile came from (PROFILE_JSON, PROFILE_FILE or built-in). */
export function activeProfileSource(): ProfileSource { return load().source; }
