/**
 * GENERIC_PLAN P5: who a run is for. The per-user workflows (.github/workflows, workflows/schedule.ts PER_USER_ENV)
 * set three variables:
 *   RUN_USER        the `user` input ('owner' by default)
 *   SECRET_PREFIX   '' for the owner, 'u2_' for user u2 (the workflow reads the secrets named U2_<NAME>)
 *   PROFILE_SOURCE  '' for the default user, 'sheet' for anyone else: the workflow reads that user's `⚙️ Profile`
 *                   tab first (npm run profile-fetch) into PROFILE_FILE. The default user's tab is read too unless the
 *                   copy has a built-in profile (workflows/schedule.ts PROFILE_STEP_IF, src/overlay.ts).
 *
 * The rule this file enforces: a run for anyone but the owner NEVER uses the built-in owner profile, and the
 * profile it uses must name that user (`user.id`). The owner's runs (RUN_USER unset, '' or 'owner') are unchanged.
 */

import type { ProfileSource } from './load.ts';
import type { Profile } from './schema.ts';

export const OWNER_USER = 'owner';
/** A user id that is also safe as a GitHub secret prefix (letters, digits, underscore; no dash). */
export const RUN_USER_RE = /^[a-z][a-z0-9_]{0,19}$/;

type Env = Readonly<Record<string, string | undefined>>;

/** The run's user: RUN_USER, '' / unset = the owner. Case is ignored (GitHub compares the input that way). */
export function runUserOf(env: Env): string {
  return (env.RUN_USER ?? '').trim().toLowerCase() || OWNER_USER;
}

export function isOwnerRun(env: Env): boolean {
  return runUserOf(env) === OWNER_USER;
}

/** Why this run's user id cannot be used, or null. */
export function runUserProblem(user: string): string | null {
  return RUN_USER_RE.test(user) ? null : 'the user id "' + user.slice(0, 40) + '" is not valid (a-z first, then a-z, 0-9 or _, at most 20)';
}

/** Why `profile` (from `source`) must not be used for this run, or null. The owner's runs always pass. */
export function runProfileProblem(env: Env, profile: Profile, source: ProfileSource): string | null {
  const user = runUserOf(env);
  const wantsSheet = (env.PROFILE_SOURCE ?? '').trim() === 'sheet';
  // The default user (a single-user copy: its own repo secrets and its own Profile tab) may name itself anything valid
  // in `user.id`; only a profile it did not load from its own tab (the built-in one with PROFILE_SOURCE=sheet) is refused.
  // The workflows never set PROFILE_SOURCE=sheet for the default user, so a copy with a built-in profile runs unchanged.
  if (user === OWNER_USER && (!wantsSheet || source !== 'built-in')) return null;
  const bad = runUserProblem(user);
  if (bad) return bad;
  if (source === 'built-in') return 'this run is for user ' + user + ' but no profile of theirs was loaded (the Profile tab step did not run)';
  if (profile.user.id !== user) return 'this run is for user ' + user + ' but the profile is for user ' + profile.user.id;
  return null;
}
