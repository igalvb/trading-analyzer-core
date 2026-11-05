/**
 * The Google service account and the Sheets API object (split out of sheets/client.ts, GENERIC_PLAN P5): no tab
 * registry and no profile import, so `npm run profile-fetch` can read a user's Profile tab before any profile is
 * loaded. sheets/client.ts re-exports both functions; the rest of the code keeps importing them from there.
 */

import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export interface ServiceAccountCredentials {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Parses the service-account JSON from an environment variable.
 *
 * Two real traps handled:
 *
 *  1. private_key newlines. Passing through a shell, a .env file, or some
 *     secret UIs turns real newlines into the literal two-character
 *     sequence \n, after which auth fails with an opaque error. The fix
 *     targets the ESCAPED sequence -- note the double backslash in /\\n/g.
 *     The naive /\n/g form is a no-op (newlines replaced with newlines) and
 *     is a classic "works locally, fails in CI".
 *
 *  2. This object must NEVER be logged. GitHub masks registered secrets, but
 *     only reliably for exact-match strings. A parsed and re-serialised
 *     private_key is a DIFFERENT string and would not be masked.
 */
export function parseServiceAccount(raw: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (value deliberately not echoed)');
  }
  const o = parsed as Record<string, unknown>;
  const email = o['client_email'];
  const key = o['private_key'];
  if (typeof email !== 'string' || email === '') {
    throw new Error('service-account JSON has no "client_email" — is this an OAuth client secret rather than a service account?');
  }
  if (typeof key !== 'string' || key === '') {
    throw new Error('service-account JSON has no "private_key"');
  }
  return { client_email: email, private_key: key.replace(/\\n/g, '\n') };
}

export function createSheetsApi(credentials: ServiceAccountCredentials): sheets_v4.Sheets {
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
}
