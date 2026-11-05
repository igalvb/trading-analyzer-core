import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetupCheck, formatRows, type SetupCheckDeps } from '../src/setupCheck.ts';

const SA = JSON.stringify({ client_email: 'robot-at-example', private_key: '-----FAKE-----zzqq' });
const GOOD_ENV: Record<string, string> = {
  GOOGLE_SERVICE_ACCOUNT_JSON: SA,
  SPREADSHEET_ID: 'sheetAAA111', REPORTS_SPREADSHEET_ID: 'sheetBBB222', DATA_SPREADSHEET_ID: 'sheetCCC333',
  FMP_API_KEY: 'fmpSECRET9', FINNHUB_KEY: 'fhSECRET8', ALPHAVANTAGE_KEY: 'avSECRET7', GEMINI_API_KEY: 'gemSECRET6',
  ANTHROPIC_API_KEY: 'antSECRET5', TELEGRAM_BOT_TOKEN: '12345:tokSECRET4', TELEGRAM_CHAT_ID: '987654321',
  TELEGRAM_WEBHOOK_SECRET: 'hookSECRET3', SEC_CONTACT_EMAIL: 'me@example.com',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake internet: every service answers "good" unless `refuse` names it. */
function fakeFetch(refuse: readonly string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = String(input);
    const no = (k: string) => refuse.includes(k);
    if (u.includes('financialmodelingprep')) return no('fmp') ? json(401, { 'Error Message': 'Invalid API KEY' }) : json(200, [{ symbol: 'AAPL' }]);
    if (u.includes('finnhub')) return no('finnhub') ? json(401, { error: 'Invalid API key' }) : json(200, { c: 1.5 });
    if (u.includes('alphavantage')) return no('av') ? json(200, { 'Error Message': 'the parameter apikey is invalid' }) : json(200, { 'Global Quote': { '05. price': '1' } });
    if (u.includes('generativelanguage')) return no('gemini') ? json(400, { error: {} }) : json(200, { models: [] });
    if (u.includes('anthropic')) return no('anthropic') ? json(401, {}) : json(200, { data: [] });
    if (u.includes('/getMe')) return no('bot') ? json(401, { ok: false }) : json(200, { ok: true });
    if (u.includes('/getChat')) return no('chat') ? json(400, { ok: false }) : json(200, { ok: true });
    throw new Error('unexpected url');
  }) as typeof fetch;
}

function deps(env: Record<string, string>, over: Partial<SetupCheckDeps> = {}): SetupCheckDeps {
  return {
    env, fetchImpl: fakeFetch(), aiOn: true, out: () => {},
    sheetTitle: async (_c, id) => { if (id.startsWith('bad')) throw new Error('403'); return 'T'; },
    ...over,
  };
}

function leakCheck(lines: readonly string[], env: Record<string, string>): void {
  const text = lines.join('\n');
  for (const [k, v] of Object.entries(env)) {
    if (k === 'SEC_CONTACT_EMAIL' || v.length < 6) continue;
    assert.ok(!text.includes(v), 'value of ' + k + ' leaked');
    if (k === 'GOOGLE_SERVICE_ACCOUNT_JSON') assert.ok(!text.includes('zzqq') && !text.includes('robot-at-example'), 'robot key leaked');
  }
  assert.ok(!text.includes('me@example.com'), 'e-mail leaked');
}

test('all keys right: every row ✅, exit 0, no value printed', async () => {
  const { rows, code } = await runSetupCheck(deps(GOOD_ENV));
  assert.equal(code, 0);
  assert.deepEqual(rows.filter((r) => r.mark !== '✅').map((r) => r.item), []);
  assert.equal(rows.length, 13);
  const lines = formatRows(rows);
  assert.equal(lines.at(-1), 'All set.');
  leakCheck(lines, GOOD_ENV);
});

test('every key missing: needed rows ❌ naming the secret, optional rows ➖, exit 1', async () => {
  const { rows, code } = await runSetupCheck(deps({}, { aiOn: false }));
  assert.equal(code, 1);
  const by = Object.fromEntries(rows.map((r) => [r.item, r]));
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'FMP_API_KEY', 'FINNHUB_KEY', 'ALPHAVANTAGE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SEC_CONTACT_EMAIL']) {
    assert.equal(by[k]?.mark, '❌', k);
  }
  assert.equal(by['GEMINI_API_KEY']?.mark, '➖');
  assert.equal(by['ANTHROPIC_API_KEY']?.mark, '➖');
  assert.equal(by['TELEGRAM_WEBHOOK_SECRET']?.mark, '➖');
});

test('Gemini missing is ❌ when AI review is on', async () => {
  const env = { ...GOOD_ENV }; delete env['GEMINI_API_KEY'];
  const { rows } = await runSetupCheck(deps(env, { aiOn: true }));
  assert.equal(rows.find((r) => r.item === 'GEMINI_API_KEY')?.mark, '❌');
});

test('wrong keys: each refused service is ❌ with a fix, nothing leaks', async () => {
  const env = { ...GOOD_ENV, SPREADSHEET_ID: 'badSHEET000', SEC_CONTACT_EMAIL: 'not-an-email' };
  const { rows, code } = await runSetupCheck(deps(env, { fetchImpl: fakeFetch(['fmp', 'finnhub', 'av', 'gemini', 'anthropic', 'bot']) }));
  assert.equal(code, 1);
  const bad = rows.filter((r) => r.mark === '❌').map((r) => r.item);
  assert.deepEqual(bad.sort(), ['ALPHAVANTAGE_KEY', 'ANTHROPIC_API_KEY', 'FINNHUB_KEY', 'FMP_API_KEY', 'GEMINI_API_KEY', 'SEC_CONTACT_EMAIL', 'SPREADSHEET_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].sort());
  leakCheck(formatRows(rows), env);
});

test('a robot key that is not a key file is ❌ and the sheets are not tried', async () => {
  let tried = 0;
  const env = { ...GOOD_ENV, GOOGLE_SERVICE_ACCOUNT_JSON: 'hello' };
  const { rows } = await runSetupCheck(deps(env, { sheetTitle: async () => { tried++; return 'T'; } }));
  assert.equal(tried, 0);
  assert.equal(rows.find((r) => r.item === 'GOOGLE_SERVICE_ACCOUNT_JSON')?.mark, '❌');
  assert.equal(rows.find((r) => r.item === 'DATA_SPREADSHEET_ID')?.mark, '❌');
});

test('a network failure is ❌ "could not reach", not a crash', async () => {
  const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  const { rows } = await runSetupCheck(deps(GOOD_ENV, { fetchImpl: boom }));
  assert.match(rows.find((r) => r.item === 'FMP_API_KEY')?.note ?? '', /Could not reach/);
});

test('profile row: valid, paper on without a start date, invalid', async () => {
  const row = async (profile: SetupCheckDeps['profile']) => (await runSetupCheck(deps(GOOD_ENV, { profile }))).rows.find((r) => r.item === 'Profile');
  assert.equal((await row({ ok: true, paperOn: true, paperStart: '2026-11-02', source: 'built-in' }))?.mark, '✅');
  assert.equal((await row({ ok: true, paperOn: true, paperStart: null, source: 'PROFILE_FILE' }))?.mark, '❌');
  assert.equal((await row({ ok: true, paperOn: false, paperStart: null, source: 'PROFILE_FILE' }))?.mark, '✅');
  assert.equal((await row({ ok: false, error: 'tax.rate is required' }))?.mark, '❌');
});
