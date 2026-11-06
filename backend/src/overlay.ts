/**
 * The optional private overlay (docs/P9_EXPORT.md "Core-first workflow"). The shared core is the same, byte for byte,
 * in every copy; a user who keeps private files next to it puts them in `src/owner/`:
 *
 *   src/owner/profile.ts   exports OWNER_PROFILE_INPUT: the built-in profile, used when the run sets no PROFILE_JSON /
 *                          PROFILE_FILE (a copy without it has no built-in profile: no profile = the run refuses)
 *   src/owner/results/     the default results folder (RESULTS_DIR wins); without it: backend/results/
 *
 * The workflows test the same file (`hashFiles('backend/src/owner/profile.ts')`): with a built-in profile the default
 * user does not read its Profile tab (no extra sheet request); without one it does.
 *
 * Loaded with a dynamic import of a path held in a variable, so a copy without `src/owner/` still typechecks and runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** backend/src/owner/ */
export const OVERLAY_DIR = path.join(import.meta.dirname, 'owner');
/** The built-in profile's module (present only in a copy with a private overlay). */
export const OVERLAY_PROFILE_FILE = path.join(OVERLAY_DIR, 'profile.ts');
const OVERLAY_RESULTS_DIR = path.join(OVERLAY_DIR, 'results');

/** True when this copy has a built-in profile (src/owner/profile.ts). */
export const hasOverlayProfile = (): boolean => fs.existsSync(OVERLAY_PROFILE_FILE);

const profileModule: { readonly OWNER_PROFILE_INPUT?: unknown } | null = hasOverlayProfile()
  ? await import(pathToFileURL(OVERLAY_PROFILE_FILE).href) as { readonly OWNER_PROFILE_INPUT?: unknown }
  : null;

/** The built-in profile input (not yet validated), or undefined when this copy has none. */
export const overlayProfileInput = (): unknown => profileModule?.OWNER_PROFILE_INPUT;

/** The default results folder: src/owner/results/ when the overlay has one, else backend/results/. */
export const overlayResultsDir = (): string => (fs.existsSync(OVERLAY_RESULTS_DIR) ? OVERLAY_RESULTS_DIR : path.resolve(import.meta.dirname, '..', 'results'));
