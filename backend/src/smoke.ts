/**
 * PHASE 0 GATE -- proves the entire chain works end to end before any
 * business logic exists: secrets -> service-account auth -> real Google
 * Sheets read -> real write -> read-back verification.
 *
 * If this passes, everything infrastructural is proven. If it fails, the
 * message says exactly which link broke.
 *
 * SAFETY -- read this before running it against the real spreadsheet:
 * This script writes to a REAL Google Sheet containing real financial
 * data. It is deliberately built so it can only ever touch its OWN
 * dedicated tab (SMOKE_TAB below), which it creates if missing. It never
 * writes to a user data tab, and it makes zero assumptions about which
 * tabs exist -- its read step uses spreadsheet metadata only.
 *
 * Implements: sub-plan 1 (backend scaffolding) DOD items 1-6.
 */

import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

// Hardcoded, per the project's standing scope rule: no config-driven tab
// names (umbrella section 2.5). This tab is disposable -- it holds nothing
// but smoke-test output and can be deleted at any time.
const SMOKE_TAB = '⚙️ Smoke Test';

// The only scope this project ever needs. Deliberately not the broader
// drive scope: this code has no business seeing any other file.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/** Counts real Sheets API calls, so the batching discipline is visible from day one. */
let apiCallCount = 0;

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

function fail(msg: string, hint?: string): never {
  console.error(`\n[smoke] ❌ FAILED: ${msg}`);
  if (hint) console.error(`[smoke]    → ${hint}`);
  process.exit(1);
}

/**
 * Reads every required env var at once and reports ALL missing ones
 * together. Reporting them one at a time turns setup into a guessing game.
 */
function requireEnv(): { serviceAccountJson: string; spreadsheetId: string } {
  const required = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'] as const;
  const missing = required.filter((name) => {
    const v = process.env[name];
    return v === undefined || v.trim() === '';
  });

  if (missing.length > 0) {
    fail(
      `missing required environment variable(s): ${missing.join(', ')}`,
      'Locally: copy .env.example to .env and fill it in. ' +
        'In CI: check the repository secrets are set and mapped in the workflow env block.',
    );
  }

  return {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON as string,
    spreadsheetId: process.env.SPREADSHEET_ID as string,
  };
}

/**
 * Parses the service-account JSON from the environment.
 *
 * Two real, well-documented traps handled here:
 *
 *  1. `private_key` newlines. When the JSON passes through a shell, a
 *     .env file, or some secret UIs, real newlines become the literal
 *     two-character sequence \n. Auth then fails with an opaque error.
 *     The fix targets the ESCAPED sequence -- note the double backslash
 *     in /\\n/g. The naive /\n/g form is a no-op (it replaces newlines
 *     with newlines) and is a common cause of "it works locally but not
 *     in CI".
 *
 *  2. Never log this object. GitHub masks registered secret values in
 *     logs, but that masking is reliable only for exact-match strings.
 *     A parsed and re-serialised private_key is a DIFFERENT string and
 *     will NOT be masked. So: no logging of credentials, and no error
 *     path that echoes them.
 */
function parseCredentials(raw: string): { client_email: string; private_key: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately does not include the raw value in the message.
    fail(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON',
      'It must be the ENTIRE contents of the downloaded service-account key file, ' +
        'including the outer { }. Check it was not truncated when pasted.',
    );
  }

  const creds = parsed as Record<string, unknown>;
  const clientEmail = creds['client_email'];
  const privateKey = creds['private_key'];

  if (typeof clientEmail !== 'string' || clientEmail === '') {
    fail(
      'service-account JSON has no "client_email"',
      'This does not look like a service-account key. OAuth client secrets ' +
        'and API keys will not work here -- it must be a service account.',
    );
  }
  if (typeof privateKey !== 'string' || privateKey === '') {
    fail('service-account JSON has no "private_key"', 'The key file appears incomplete.');
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n'),
  };
}

async function main(): Promise<void> {
  log('starting phase-0 smoke test');

  const { serviceAccountJson, spreadsheetId } = requireEnv();
  const credentials = parseCredentials(serviceAccountJson);

  // Safe to log: the service-account email is an identifier, not a secret,
  // and showing it is genuinely useful -- the single most common setup
  // failure is forgetting to share the Sheet with this exact address.
  log(`authenticating as ${credentials.client_email}`);

  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  // ── STEP 1: READ (metadata only -- touches no user data) ──────────────
  // Proves read access with zero assumptions about tab names or contents.
  // Also usefully reports what tabs actually exist, which is real
  // information worth having at phase 0.
  log('step 1/3: reading spreadsheet metadata...');
  let meta;
  try {
    apiCallCount++;
    meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties.title' });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 404) {
      fail(
        `spreadsheet not found (404): ${spreadsheetId}`,
        'Check SPREADSHEET_ID is the ID from the URL, not the whole URL.',
      );
    }
    if (e.code === 403) {
      fail(
        `permission denied (403) on spreadsheet ${spreadsheetId}`,
        `Share the Sheet with ${credentials.client_email} (Editor access). ` +
          'Also confirm the Google Sheets API is enabled for this Cloud project.',
      );
    }
    fail(`could not read spreadsheet: ${e.message ?? String(err)}`);
  }

  const title = meta.data.properties?.title ?? '(untitled)';
  const existingTabs = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => typeof t === 'string');

  log(`  ✓ read OK -- spreadsheet: "${title}"`);
  log(`  ✓ ${existingTabs.length} tabs found: ${existingTabs.join(', ')}`);

  // ── STEP 2: WRITE (into our own dedicated tab, never user data) ───────
  if (!existingTabs.includes(SMOKE_TAB)) {
    log(`step 2/3: creating "${SMOKE_TAB}" tab (first run)...`);
    try {
      apiCallCount++;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: SMOKE_TAB } } }] },
      });
      log(`  ✓ created "${SMOKE_TAB}"`);
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 403) {
        fail(
          'write permission denied (403)',
          `${credentials.client_email} can read but not write. ` +
            'Re-share the Sheet with EDITOR access, not Viewer/Commenter.',
        );
      }
      fail(`could not create the smoke-test tab: ${e.message ?? String(err)}`);
    }
  } else {
    log(`step 2/3: "${SMOKE_TAB}" tab already exists`);
  }

  const stamp = new Date().toISOString();
  const runContext = process.env.GITHUB_RUN_ID ? `GitHub Actions run ${process.env.GITHUB_RUN_ID}` : 'local run';
  const range = `${SMOKE_TAB}!A1:C1`;

  log(`writing timestamp to ${range}...`);
  try {
    apiCallCount++;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [['Last smoke test', stamp, runContext]] },
    });
    log('  ✓ write OK');
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 403) {
      fail('write permission denied (403)', `Re-share the Sheet with ${credentials.client_email} as EDITOR.`);
    }
    fail(`could not write: ${e.message ?? String(err)}`);
  }

  // ── STEP 3: READ BACK (proves the round trip, not just that no error threw) ──
  log('step 3/3: reading the value back to verify...');
  let readBack;
  try {
    apiCallCount++;
    readBack = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  } catch (err) {
    const e = err as { message?: string };
    fail(`could not read back the written value: ${e.message ?? String(err)}`);
  }

  const got = readBack.data.values?.[0]?.[1];
  if (got !== stamp) {
    fail(
      `read-back mismatch -- wrote "${stamp}" but read "${String(got)}"`,
      'The write appeared to succeed but the value did not persist as written. ' +
        'This usually means a value-coercion issue; investigate before trusting any write path.',
    );
  }
  log('  ✓ read-back matches exactly');

  console.log('\n[smoke] ✅ PASSED -- auth, read, write, and read-back all work.');
  console.log(`[smoke]    Sheets API calls used: ${apiCallCount}`);
  console.log(`[smoke]    Quota context: 60 requests/min per user per project is the binding limit.`);
}

main().catch((err: unknown) => {
  // Last-resort net. Anything reaching here is a bug in the error handling
  // above, not an expected failure -- expected failures all exit via fail().
  console.error('\n[smoke] ❌ UNEXPECTED ERROR:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
