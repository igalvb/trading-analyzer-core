/**
 * Owner 2026-11-04: layer 2 of the run monitoring (src/verify.ts, npm run ops-verify) against a fake GitHub API, a
 * fake Claude SDK and a fake Telegram. Example data only.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipBytes } from './secFixtures.ts';
import type { GhFetch, GhRun } from '../src/watchdog.ts';
import type { ClaudeRequest, ClaudeResponse, ClaudeSdk } from '../src/ai/claudeReview.ts';
import {
  PROMPT_MAX_CHARS, VERIFY_EFFORT, VERIFY_NO_KEY, VERIFY_ROW_JOB, cellDay, redactSecrets, runVerify, verifyDays,
  type VerifyDeps,
} from '../src/verify.ts';

const REPO = 'owner/TradingAnalyzerBackEnd';
const TG_TOKEN = '123456789:AAHfakeTelegramTokenValue_abcdefghijk';
// Fake keys are built from parts so the repo holds no real-looking key text (generic guard R7).
const ANTHROPIC = ['sk', 'ant', 'api03-fakeKeyForTestsOnly_0123456789'].join('-');
const PK = ['PRIVATE', 'KEY'].join(' ');
const PRIVATE = '-----BEGIN ' + PK + '-----\nMIIEfakefakefake\n-----END ' + PK + '-----';
const ENV = { GITHUB_TOKEN: 'gh-test-token-value', GITHUB_REPOSITORY: REPO, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '4242', SPREADSHEET_ID: 'sheet-id-1234567890abc' };
const NOW = Date.parse('2026-11-04T10:00:00Z');

let nextId = 5000;
function run(file: string, created: string, opts: Partial<GhRun> & { minutes?: number } = {}): GhRun {
  const id = nextId++;
  return {
    id, name: file === 'nightly.yml' ? 'Nightly' : file === 'my-options.yml' ? 'My Options' : file, path: '.github/workflows/' + file,
    event: 'schedule', status: 'completed', conclusion: 'success', created_at: created, run_started_at: created,
    updated_at: new Date(Date.parse(created) + (opts.minutes ?? 2) * 60_000).toISOString(), html_url: 'https://github.com/' + REPO + '/actions/runs/' + id, ...opts,
  };
}

function fakeGitHub(runs: GhRun[], logs: Record<number, string> = {}, fail = false): GhFetch {
  const res = (body: unknown, bytes?: Uint8Array, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new Uint8Array(bytes ?? new Uint8Array()).buffer });
  return async (url) => {
    if (fail) return res({}, undefined, 500);
    let m: RegExpExecArray | null;
    if (/\/runs\/\d+\/timing$/.test(url)) return res({ billable: { UBUNTU: { total_ms: 120_000 } } });
    if (/\/runs\/\d+\/jobs/.test(url)) return res({ jobs: [{ steps: [{ name: 'Refresh My Options values', conclusion: 'success' }] }] });
    if (/\/runs\/\d+\/artifacts/.test(url)) return res({ artifacts: [] });
    if ((m = /\/runs\/(\d+)\/logs$/.exec(url))) return res(null, zipBytes([['0_job.txt', logs[Number(m[1])] ?? '2026-11-04T04:00:00.0000000Z all good', 'deflate']]));
    if (/\/actions\/runs\?/.test(url)) return res({ total_count: runs.length, workflow_runs: runs });
    return res({}, undefined, 404);
  };
}

function fakeTelegram(): { fetch: typeof fetch; sent: string[]; docs: Array<{ name: string; caption: string }> } {
  const sent: string[] = [];
  const docs: Array<{ name: string; caption: string }> = [];
  const f = (async (_url: string, init: { body: string | FormData }) => {
    if (init.body instanceof FormData) docs.push({ name: (init.body.get('document') as File).name, caption: String(init.body.get('caption') ?? '') });
    else sent.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, sent, docs };
}

function fakeSdk(answer: string | ((req: ClaudeRequest) => ClaudeResponse | Promise<ClaudeResponse>)): { sdk: ClaudeSdk; requests: ClaudeRequest[] } {
  const requests: ClaudeRequest[] = [];
  return {
    requests,
    sdk: {
      async create(req) {
        requests.push(req);
        if (typeof answer === 'function') return answer(req);
        return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: answer }], usage: { input_tokens: 12_000, output_tokens: 900 } };
      },
    },
  };
}

/** Three days: Nightly ran 3 Nov and 4 Nov, missing for 2 Nov (window 3 Nov 03-13 UTC); one failed analyze with a leaked key in its log. */
function scenario(): { runs: GhRun[]; logs: Record<number, string> } {
  const failed = run('analyze.yml', '2026-11-03T15:00:00Z', { conclusion: 'failure', event: 'workflow_dispatch' });
  const n2 = run('nightly.yml', '2026-11-04T04:10:00Z', { minutes: 6 });
  const runs = [n2, failed, run('nightly.yml', '2026-11-02T04:10:00Z', { minutes: 6 }), run('my-options.yml', '2026-11-02T22:10:00Z'), run('my-options.yml', '2026-11-03T22:10:00Z'), run('my-options.yml', '2026-10-30T21:10:00Z')];
  const logs = {
    [failed.id]: '2026-11-03T15:01:00Z ERROR fetch failed: HTTP 401 for https://api.example.com/q?apikey=' + 'LEAKEDKEY123456' + '\n' +
      '2026-11-03T15:01:01Z ERROR Anthropic said invalid x-api-key ' + ANTHROPIC + '\n' +
      '2026-11-03T15:01:02Z ERROR telegram https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage refused\n' +
      '2026-11-03T15:01:03Z CRITICAL service account ' + PRIVATE.replace(/\n/g, ' ') + '\n',
    [n2.id]: '2026-11-04T04:12:00Z WARNING FMP partial data for TSLA\n2026-11-04T04:12:01Z WARNING FMP partial data for NVDA\n',
  };
  return { runs, logs };
}

/** A lowercase word per number (patternOf blanks digits and capitals, not lowercase words). */
const word = (n: number): string => { let w = ''; do { w += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); } while (n > 0); return w; };

async function verify(over: Partial<VerifyDeps> & { runs?: GhRun[]; logs?: Record<number, string>; ghFail?: boolean } = {}) {
  const s = scenario();
  const tg = fakeTelegram();
  const appended: (readonly (string | number)[])[] = [];
  const res = await runVerify({
    env: ENV, now: NOW, fetchImpl: fakeGitHub(over.runs ?? s.runs, over.logs ?? s.logs, over.ghFail), telegramFetch: tg.fetch,
    readHealthRows: async () => [['2026-10-20', 'Nightly', '—', '1', '✅ ok', 6, 0, 0, '', ''], ['2026-11-03', 'Nightly', 'yes (2026-11-02)', 'no', '❌ did not run', 0, 0, 0, 'Nightly did not run', '']],
    appendRows: async (rows) => { appended.push(...rows); return rows.length; },
    sleep: async () => {},
    toPdf: null, // no browser: ONE message (the PDF path has its own test)
    ...over,
  });
  return { res, sent: tg.sent, docs: tg.docs, rows: appended };
}

describe('ops-verify: no Anthropic key', () => {
  test('the watchdog table for 3 days + one line, no Opus call, one Verify row; Telegram: ONE short message', async () => {
    const { sdk, requests } = fakeSdk('unused');
    const r = await verify({ sdk });
    assert.equal(r.res.state, 'no-key');
    assert.equal(requests.length, 0, 'no call without a key');
    const m = r.res.messages[0] as string;
    assert.match(m, /^🩺 Verify — .* \(last 72 h\)/);
    assert.match(m, /Nightly did not run for 2026-11-02/);
    assert.match(m, /analyze\.yml run failure/);
    assert.ok(m.endsWith(VERIFY_NO_KEY));
    assert.deepEqual(r.sent, ['🩺 Verify (3 days): Something failed or did not run.\n' + VERIFY_NO_KEY], 'the bottom line only');
    assert.equal(VERIFY_NO_KEY, 'Opus diagnosis off (no Anthropic key saved)');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]![1], VERIFY_ROW_JOB);
  });
});

describe('ops-verify: with a key', () => {
  const env = { ...ENV, ANTHROPIC_API_KEY: ANTHROPIC };
  test('ONE Opus call (model, effort high, cached system); the answer goes to Telegram, split at 4096', async () => {
    const answer = 'VERDICT: some issues.\n' + Array.from({ length: 120 }, (_, i) => (i + 1) + ' | Nightly missing | relay timer stopped | HIGH | relay/telegram-relay.worker.mjs timers | yes').join('\n');
    assert.ok(answer.length > 4096 * 2);
    const { sdk, requests } = fakeSdk(answer);
    const r = await verify({ env, sdk });
    assert.equal(r.res.state, 'ok');
    assert.equal(requests.length, 1);
    const req = requests[0]!;
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.output_config.effort, 'high');
    assert.equal(VERIFY_EFFORT, 'high');
    assert.ok(!('thinking' in req) && !('temperature' in req), 'adaptive thinking by default; no sampling params');
    assert.match(req.system[0]!.text, /ops reviewer/);
    assert.match(req.system[0]!.text, /Likely root cause \| Severity/);
    assert.match(req.messages[0]!.content, /DID NOT RUN \(1\):\n- Nightly did not run for 2026-11-02/);
    assert.match(req.messages[0]!.content, /RUN HEALTH TAB ROWS[^\n]*\n- 2026-11-03 \| Nightly/);
    assert.ok(!req.messages[0]!.content.includes('2026-10-20'), 'only the rows of the checked days');
    // The result: the table, then the answer. Telegram (no browser): ONE message, the bottom line and the answer
    // (Telegram's own 4096-character parts).
    assert.match(r.res.messages[0] as string, /^🩺 Verify/);
    assert.match(r.res.messages[1] as string, /^🧠 Opus diagnosis \(last 3 days\)\n\nVERDICT: some issues\./);
    assert.match(r.sent[0] as string, /^🩺 Verify \(3 days\): some issues\.\n\n🧠 Opus diagnosis/);
    assert.ok(r.sent.every((m) => m.length <= 4096));
    assert.ok(!r.sent.join('\n').includes('Top problems'), 'the watchdog table is not sent as text');
    assert.equal(r.sent.join('\n').split(' | Nightly missing').length - 1, 120, 'nothing lost in the split');
    assert.match(String(r.rows[0]![8]), /^some issues\./);
    assert.deepEqual(r.res.usage, { inputTokens: 12_000, outputTokens: 900, cacheReadInputTokens: null, cacheCreationInputTokens: null });
  });
  test('secrets are redacted from the prompt (env values, key shapes, bot URL, private key, ?apikey=)', async () => {
    const { sdk, requests } = fakeSdk('VERDICT: healthy.');
    const r = await verify({ env, sdk });
    const p = requests[0]!.messages[0]!.content;
    assert.match(p, /LOG PROBLEMS/);
    assert.match(p, /\[REDACTED\]/);
    for (const secret of [ANTHROPIC, TG_TOKEN, 'LEAKEDKEY123456', 'MIIEfakefakefake', 'gh-test-token-value', 'sheet-id-1234567890abc']) {
      assert.ok(!p.includes(secret), 'leaked: ' + secret);
      assert.ok(!r.sent.join('\n').includes(secret), 'leaked to Telegram: ' + secret);
    }
    assert.ok(p.length <= PROMPT_MAX_CHARS + 200);
  });
  test('redactSecrets on its own', () => {
    const t = redactSecrets('a ' + ANTHROPIC + ' b ' + 'gh' + 'p_abcdefghijklmnopqrstuvwxyz123 c ' + 'AI' + 'zaSyA1234567890abcdefghijklmnopqrstuv d Bearer abcdefghijklmnop e "private_key": "xyz" f /bot' + TG_TOKEN + '/getMe g ?token=abc&x=1 h my-value-12345678', { MY_SECRET: 'my-value-12345678', PLAIN_NAME: 'ordinary-value' });
    assert.ok(!/sk-ant|ghp_|AIza|abcdefghijklmnop|xyz|AAHfake|abc&|my-value/.test(t), t);
    assert.match(t, /"private_key": \[REDACTED\]/);
    assert.match(t, /\?token=\[REDACTED\]&x=1/);
    assert.equal(redactSecrets('plain text ordinary-value', { PLAIN_NAME: 'ordinary-value' }), 'plain text ordinary-value');
  });
  test('the prompt is capped, most severe first (the run list and Run Health rows are cut before the problems)', async () => {
    const runs: GhRun[] = [];
    const logs: Record<number, string> = {};
    for (let i = 0; i < 30; i++) {
      const r = run('analyze.yml', new Date(NOW - (i + 1) * 3_600_000).toISOString(), { conclusion: i === 0 ? 'failure' : 'success', event: 'workflow_dispatch' });
      runs.push(r);
      logs[r.id] = Array.from({ length: 200 }, (_, k) => '2026-11-04T01:00:00Z WARNING problem ' + word(i * 1000 + k) + ' in the detail of the step that read the data for the report').join('\n');
    }
    const { sdk, requests } = fakeSdk('VERDICT: some issues.');
    await verify({ env, sdk, runs, logs });
    const p = requests[0]!.messages[0]!.content;
    assert.ok(p.length <= PROMPT_MAX_CHARS + 200, String(p.length));
    assert.match(p, /\[the rest was cut to keep the request short\]/);
    assert.ok(p.indexOf('FAILED / CANCELLED') < p.indexOf('LOG PROBLEMS'));
    assert.match(p, /analyze\.yml run failure/);
  });
  test('Opus refuses / errors: the table still goes out with one line; nothing throws', async () => {
    const refusal = fakeSdk(() => ({ stop_reason: 'refusal', content: [] }));
    const r1 = await verify({ env, sdk: refusal.sdk });
    assert.equal(r1.res.state, 'opus-failed');
    assert.match(r1.res.messages[0] as string, /^🩺 Verify/);
    assert.match(r1.res.messages[r1.res.messages.length - 1] as string, /Opus diagnosis: not available this time \(refusal\)/);
    assert.equal(r1.sent.length, 1);
    assert.match(r1.sent[0] as string, /^🩺 Verify \(3 days\): .*\nOpus diagnosis not available this time$/);
    const boom = fakeSdk(() => { throw Object.assign(new Error('overloaded ' + ANTHROPIC), { status: 529 }); });
    const lines: string[] = [];
    const r2 = await verify({ env, sdk: boom.sdk, log: (l) => lines.push(l) });
    assert.equal(r2.res.state, 'opus-failed');
    assert.equal(boom.requests.length, 2, 'transient: retried once (two attempts in all)');
    assert.ok(!lines.join('\n').includes(ANTHROPIC), 'the key never reaches the log');
  });
  test('a fallback model answered: the header says which', async () => {
    const { sdk } = fakeSdk(() => ({ model: 'claude-sonnet-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'VERDICT: healthy.' }] }));
    const r = await verify({ env, sdk });
    assert.match(r.res.messages[1] as string, /answered by claude-sonnet-x/);
  });
});

describe('ops-verify: the clean Telegram policy', () => {
  test('with a browser: ONE PDF (the table and the answer inside), the bottom line as its caption, no text message', async () => {
    const { sdk } = fakeSdk('VERDICT: healthy.\nNothing to fix.');
    let html = '';
    const fs = await import('node:fs');
    const r = await verify({ env: { ...ENV, ANTHROPIC_API_KEY: ANTHROPIC }, sdk, toPdf: async (h, p) => { html = h; fs.writeFileSync(p, '%PDF-1.4 test'); } });
    assert.equal(r.res.state, 'ok');
    assert.deepEqual(r.sent, [], 'no text message');
    assert.equal(r.docs.length, 1);
    assert.equal(r.docs[0]!.name, 'verify-20261104.pdf');
    assert.equal(r.docs[0]!.caption, '🩺 Verify (3 days): healthy.');
    assert.match(html, /Opus diagnosis/);
    assert.match(html, /Nightly did not run for 2026-11-02/);
  });
});

describe('ops-verify: never throws', () => {
  test('GitHub down -> one ❌ Telegram line; no Opus call', async () => {
    const { sdk, requests } = fakeSdk('x');
    const r = await verify({ env: { ...ENV, ANTHROPIC_API_KEY: ANTHROPIC }, sdk, ghFail: true });
    assert.equal(r.res.state, 'collect-failed');
    assert.equal(requests.length, 0);
    assert.match(r.res.messages[0] as string, /❌ the runs could not be read: GitHub API HTTP 500/);
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0] as string, /^🩺 Verify \(3 days\): ❌ the runs could not be read: GitHub API HTTP 500 for \/runs$/);
  });
  test('no GitHub token, the sheet and Telegram both failing, a throwing reader: still resolves', async () => {
    const r1 = await runVerify({ env: {}, now: NOW });
    assert.match(r1.messages[0] as string, /GITHUB_TOKEN \/ GITHUB_REPOSITORY not set/);
    const s = scenario();
    const badTg = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const r2 = await runVerify({
      env: ENV, now: NOW, fetchImpl: fakeGitHub(s.runs, s.logs), telegramFetch: badTg, log: (l) => lines.push(l), toPdf: null,
      readHealthRows: () => { throw new Error('sheet gone'); },
      appendRows: async () => { throw new Error('quota'); },
    });
    assert.equal(r2.state, 'no-key');
    assert.match(r2.messages[0] as string, /Run Health not read: sheet gone/);
    assert.match(r2.messages[0] as string, /Sheet not updated: quota/);
    assert.ok(lines.some((l) => /could not be sent/.test(l)));
  });
  test('VERIFY_DAYS: default 3, clamped 1..7; cellDay reads text dates and serial numbers', () => {
    assert.equal(verifyDays({}), 3);
    assert.equal(verifyDays({ VERIFY_DAYS: '5' }), 5);
    assert.equal(verifyDays({ VERIFY_DAYS: '30' }), 7);
    assert.equal(verifyDays({ VERIFY_DAYS: 'x' }), 3);
    assert.equal(verifyDays({ VERIFY_DAYS: '0' }), 3);
    assert.equal(cellDay('2026-11-03'), '2026-11-03');
    assert.equal(cellDay(46330), '2026-11-04');
    assert.equal(cellDay(''), '');
  });
});
