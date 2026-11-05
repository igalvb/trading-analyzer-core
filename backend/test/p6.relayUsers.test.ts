/**
 * GENERIC_PLAN P6: one relay, many chats. The owner's commands and timers send exactly what they sent before (no
 * `user` input); a chat listed in USERS starts that user's runs with `user`; an unknown chat starts nothing; each
 * timer starts the job once per user, the owner first. Example data only (chat numbers and tickers are made up).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore -- plain JavaScript (pasted into Cloudflare as is)
import relay, { RELAY_VERSION, VERIFY_REPLY, OWNER_USER, inputsFor, repoOf, tickersOf, userOfChat, usersOf } from '../../relay/telegram-relay.worker.mjs';
import { RUN_USER_RE, OWNER_USER as BACKEND_OWNER } from '../src/profile/runUser.ts';
import { OWNER_USER as WORKFLOW_OWNER, USER_INPUT } from '../src/workflows/schedule.ts';

const BASE = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: 'AAPL,MSFT' };
const USERS = JSON.stringify({ 77: { user: 'u2', tickers: ['aapl', 'KO', '!!'] }, 88: { user: 'u3', timers: false } });

type Call = { url: string; body: any };
async function withFetch(fn: (seen: Call[]) => Promise<void>, status = (_url: string): number => 204): Promise<void> {
  const seen: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const s = String(url).includes('api.github.com') ? status(String(url)) : 200;
    return new Response(s === 204 ? null : JSON.stringify(s === 200 ? { ok: true } : { message: 'Bad credentials' }), { status: s });
  }) as unknown as typeof fetch;
  try { await fn(seen); } finally { globalThis.fetch = orig; }
}
const post = (env: object, update: unknown) => relay.fetch(new Request('https://relay', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: JSON.stringify(update) }), env);
const timer = async (env: object, iso: string, cron: string) => {
  const waits: Promise<unknown>[] = [];
  await relay.scheduled({ cron, scheduledTime: Date.parse(iso) }, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
};
const dispatches = (seen: Call[]) => seen.filter((c) => c.url.includes('/dispatches'));

describe('P6 relay: the owner, unchanged', () => {
  test('a new version string (the owner sees the new deploy); the same user id and rule as the backend', async () => {
    assert.notEqual(RELAY_VERSION, '2026-10-29.2');
    const res = await relay.fetch(new Request('https://relay'), BASE);
    assert.equal(await res.text(), 'ok relay ' + RELAY_VERSION);
    assert.equal(OWNER_USER, BACKEND_OWNER);
    assert.equal(OWNER_USER, WORKFLOW_OWNER);
    assert.equal(USER_INPUT.name, 'user');
    const worker = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'relay', 'telegram-relay.worker.mjs'), 'utf8');
    assert.ok(worker.includes('const USER_RE = ' + String(RUN_USER_RE) + ';'), 'relay and backend accept the same user ids');
  });
  test('without REPO / USERS: the owner only, the default repo, the same inputs as before (no user key)', async () => {
    assert.equal(usersOf(BASE).length, 1);
    assert.deepEqual(usersOf(BASE)[0], { chat: '42', user: 'owner', tickers: tickersOf(BASE), timers: true });
    assert.deepEqual(inputsFor('owner', { ticker: 'X' }), { ticker: 'X' });
    await withFetch(async (seen) => {
      await post(BASE, { message: { chat: { id: 42 }, text: '/analyze aapl' } });
      await post(BASE, { message: { chat: { id: 42 }, text: '/exit' } });
      const [a, e] = dispatches(seen);
      assert.ok(a!.url.startsWith('https://api.github.com/repos/someone/their-copy/actions/workflows/analyze.yml/dispatches'));
      assert.deepEqual(a!.body, { ref: 'main', inputs: { ticker: 'AAPL', ai: 'true', update_sheet: 'true' } });
      assert.deepEqual(e!.body, { ref: 'main', inputs: {} });
      assert.ok(seen.filter((c) => c.url.endsWith('sendMessage')).every((c) => c.body.chat_id === '42'));
    });
    await withFetch(async (seen) => {
      // Owner 2026-11-05: Opus only on request.
      await post(BASE, { message: { chat: { id: 42 }, text: '/exit opus' } });
      await post(BASE, { message: { chat: { id: 42 }, text: '/analyze aapl opus' } });
      const [e, a] = dispatches(seen);
      assert.ok(e!.url.includes('send-exit.yml'));
      assert.deepEqual(e!.body, { ref: 'main', inputs: { opus: 'true' } });
      assert.deepEqual(a!.body, { ref: 'main', inputs: { ticker: 'AAPL', ai: 'true', update_sheet: 'true', opus: 'true' } });
    });
    await withFetch(async (seen) => {
      await timer(BASE, '2026-10-30T03:23:00Z', '23 3 * * *');
      assert.equal(dispatches(seen).length, 1);
      assert.deepEqual(dispatches(seen)[0]!.body, { ref: 'main', inputs: { run_checks: 'false' } });
    });
  });
  test('REPO moves the runs to another repo; a malformed REPO keeps the default', () => {
    assert.equal(repoOf({ REPO: 'someone/their-copy' }), 'someone/their-copy');
    assert.equal(repoOf({ REPO: 'not a repo' }), '', 'no default repo: nothing starts');
    assert.equal(repoOf({}), '');
    assert.deepEqual(tickersOf({}), [], 'no default buttons');
  });
});

describe('Owner 2026-11-04: /verify (alias /check) starts verify.yml', () => {
  test('the owner: days 3, no user key; u2: with user; the reply; an unknown chat starts nothing; in the help text', async () => {
    assert.ok(RELAY_VERSION >= '2026-11-04.1');
    const env = { ...BASE, USERS };
    await withFetch(async (seen) => {
      await post(env, { message: { chat: { id: 42 }, text: '/verify' } });
      await post(env, { message: { chat: { id: 77 }, text: '/check' } });
      await post(env, { message: { chat: { id: 99 }, text: '/verify' } });
      const d = dispatches(seen);
      assert.equal(d.length, 2);
      assert.ok(d.every((c) => c.url.endsWith('/actions/workflows/verify.yml/dispatches')));
      assert.deepEqual(d[0]!.body, { ref: 'main', inputs: { days: '3' } });
      assert.deepEqual(d[1]!.body, { ref: 'main', inputs: { days: '3', user: 'u2' } });
      const replies = seen.filter((c) => c.url.endsWith('sendMessage'));
      assert.deepEqual(replies.map((c) => [c.body.chat_id, c.body.text]), [['42', VERIFY_REPLY], ['77', VERIFY_REPLY]]);
      assert.equal(VERIFY_REPLY, '🩺 Verifying the last 3 days… about 2 min.');
      seen.length = 0;
      await post(env, { message: { chat: { id: 42 }, text: '/help' } });
      assert.match(String(seen[0]!.body.text), /\/verify \(or \/check\)/);
    });
    await withFetch(async (seen) => {
      await post(BASE, { message: { chat: { id: 42 }, text: '/verify' } });
      const r = seen.filter((c) => c.url.endsWith('sendMessage'));
      assert.match(String(r[0]!.body.text), /Could not start it\. GitHub said 401 \(Bad credentials\)/);
    }, () => 401);
  });
});

describe('P6 relay: more users (USERS)', () => {
  const env = { ...BASE, USERS };
  test('USERS: the owner first, then each valid entry; bad entries are left out and never touch the owner', () => {
    assert.deepEqual(usersOf(env).map((u: any) => [u.chat, u.user, u.tickers, u.timers]), [
      ['42', 'owner', tickersOf(BASE), true], ['77', 'u2', ['AAPL', 'KO'], true], ['88', 'u3', [], false],
    ]);
    const bad = JSON.stringify({ 42: { user: 'u9' }, 5: { user: 'owner' }, 6: { user: 'U-2' }, x: { user: 'u7' }, 7: { user: 'u2' }, 8: { user: 'u2' } });
    assert.deepEqual(usersOf({ ...BASE, USERS: bad }).map((u: any) => u.user), ['owner', 'u2']);
    assert.deepEqual(usersOf({ ...BASE, USERS: '{not json' }).map((u: any) => u.user), ['owner']);
    assert.deepEqual(usersOf({ ...BASE, USERS: '[1,2]' }).map((u: any) => u.user), ['owner']);
    assert.deepEqual(usersOf({ ...BASE, USERS: { 77: { user: 'u2', tickers: 'msft, ko' } } }).map((u: any) => u.tickers), [tickersOf(BASE), ['MSFT', 'KO']], 'a JSON variable arrives as an object');
    assert.equal(userOfChat(env, 99), null);
    assert.equal(userOfChat({ ...BASE, ALLOWED_CHAT_ID: '' }, ''), null, 'an unset owner chat matches nothing');
  });
  test('u2 commands start u2 runs (with user) and the replies go to u2; an unknown chat starts nothing', async () => {
    await withFetch(async (seen) => {
      await post(env, { message: { chat: { id: 77 }, text: '/analyze msft' } });
      await post(env, { message: { chat: { id: 77 }, text: '/exit' } });
      const [a, e] = dispatches(seen);
      assert.deepEqual(a!.body.inputs, { ticker: 'MSFT', ai: 'true', update_sheet: 'true', user: 'u2' });
      assert.ok(e!.url.includes('send-exit.yml'));
      assert.deepEqual(e!.body.inputs, { user: 'u2' });
      const replies = seen.filter((c) => c.url.endsWith('sendMessage'));
      assert.equal(replies.length, 2);
      assert.ok(replies.every((c) => c.body.chat_id === '77'));
      seen.length = 0;
      await post(env, { message: { chat: { id: 77 }, text: '/analyze' } });
      assert.deepEqual(seen[0]!.body.reply_markup.inline_keyboard[0].map((b: any) => b.text), ['AAPL', 'KO'], "u2's own buttons");
      seen.length = 0;
      await post(env, { callback_query: { id: 'q', data: 'g:KO', message: { chat: { id: 77 } } } });
      assert.equal(dispatches(seen)[0]!.body.inputs.user, 'u2');
      seen.length = 0;
      await post(env, { message: { chat: { id: 99 }, text: '/exit' } });
      await post(env, { callback_query: { id: 'q', data: 'g:KO', message: { chat: { id: 99 } } } });
      assert.equal(seen.length, 0);
    });
  });
  test('a timer starts the job once per user, owner first; timers:false is skipped; one refusal does not stop the next', async () => {
    await withFetch(async (seen) => {
      await timer(env, '2026-10-30T03:23:00Z', '23 3 * * *');
      assert.deepEqual(dispatches(seen).map((c) => c.body.inputs), [{ run_checks: 'false' }, { run_checks: 'false', user: 'u2' }]);
      assert.ok(dispatches(seen).every((c) => c.url.endsWith('/nightly.yml/dispatches')));
    });
    await withFetch(async (seen) => {
      await timer(env, '2026-07-15T21:05:00Z', '5 21 * * *');
      assert.deepEqual(dispatches(seen).map((c) => c.body.inputs), [{}, { user: 'u2' }]);
    });
    await withFetch(async (seen) => {
      await timer(env, '2026-07-15T22:05:00Z', '5 22 * * *');
      assert.equal(seen.length, 0, 'the clock-change twin starts nothing for anyone');
    });
    let n = 0;
    await withFetch(async (seen) => {
      await timer(env, '2026-10-30T03:23:00Z', '23 3 * * *');
      assert.equal(dispatches(seen).length, 2, 'u2 still started after the owner was refused');
      const notes = seen.filter((c) => c.url.endsWith('sendMessage'));
      assert.equal(notes.length, 2, 'the owner gets the refusal, u2 gets the started line');
      assert.equal(notes[0]!.body.chat_id, '42');
      assert.match(notes[0]!.body.text, /The nightly run could not be started/);
      assert.match(notes[1]!.body.text, /⏰ The nightly run was started by the relay timer/);
    }, () => (n++ === 0 ? 401 : 204));
    await withFetch(async (seen) => {
      await timer(env, '2026-10-30T12:00:00Z', '0 12 * * *');
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.body.chat_id, '42', 'a timer that matches no job is reported to the owner only');
    });
  });
});
