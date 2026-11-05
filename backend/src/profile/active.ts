/**
 * The profile this run uses. Loaded once per process (profile/load.ts order: PROFILE_JSON, then PROFILE_FILE; the
 * workflows read the user's `⚙️ Profile` tab first with npm run profile-fetch, which writes PROFILE_FILE), so the
 * constants that read it at import see the same profile everywhere in the run.
 *
 * There is no built-in profile: no profile = the run refuses with one plain line. A bad profile refuses the run with
 * one plain line naming every problem (never a silent default).
 */

import { loadProfile, type ProfileSource } from './load.ts';
import type { Profile } from './schema.ts';
import { runProfileProblem } from './runUser.ts';

let cached: { readonly profile: Profile; readonly source: ProfileSource } | null = null;

function load(): { readonly profile: Profile; readonly source: ProfileSource } {
  if (cached) return cached;
  const r = loadProfile(process.env);
  if (!r.ok && r.source === 'none') throw new Error('No profile: fill the ⚙️ Profile tab (or set PROFILE_FILE / PROFILE_JSON). Nothing was run.');
  if (!r.ok) throw new Error('The profile (' + r.source + ') is not valid: ' + r.errors.join('; '));
  const problem = runProfileProblem(process.env, r.profile, r.source);
  if (problem) throw new Error('The profile cannot be used: ' + problem);
  cached = { profile: r.profile, source: r.source };
  return cached;
}

/** The profile of this run (validated, defaults filled in). */
export function activeProfile(): Profile { return load().profile; }

/** Where this run's profile came from (PROFILE_JSON, PROFILE_FILE or the sheet). */
export function activeProfileSource(): ProfileSource { return load().source; }
