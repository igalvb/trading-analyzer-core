/**
 * The dashboard's Cloudflare Pages Function (backend/dashboard/functions/api/run.js): POST /api/run -> GitHub
 * workflow_dispatch, behind Cloudflare Access, with a strict allow-list. A fake fetch stands in for GitHub.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleRun, checkRun, ALLOWED, BAD_JSON, onRequest } from '../dashboard/functions/api/run.js';

const SITE = 'https://trading-dashboard.pages.dev';
const ME = 'me@example.com';
// A fake token made from parts, so no token-shaped literal sits in the repository.
const TOKEN = ['fake', 'token', 'for', 'tests'].join('-');
const ENV = { REPO: 'someone/trading', GITHUB_TOKEN: TOKEN, ALLOWED_EMAILS: 'Other@example.com, ' + ME.toUpperCase() };

interface Call { url: string; init: { method: string; headers: Record<string, string>; body: string } }
function fakeFetch(status = 204): { calls: Call[]; fn: (url: string, init: Call['init']) => Promise<Response> } {
  const calls: Call[] = [];
  return { calls, fn: async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); } };
}
function req(body: unknown, o: { origin?: string | null; email?: string | null; method?: string; type?: string; raw?: string } = {}): Request {
  const headers = new Headers();
  if (o.origin !== null) headers.set('Origin', o.origin ?? SITE);
  if (o.email !== null) headers.set('Cf-Access-Authenticated-User-Email', o.email ?? ME);
  headers.set('Content-Type', o.type ?? 'application/json');
  const method = o.method ?? 'POST';
  return new Request(SITE + '/api/run', { method, headers, ...(method === 'POST' ? { body: o.raw ?? JSON.stringify(body) } : {}) });
}
async function run(r: Request, env: Record<string, string> = ENV, status = 204): Promise<{ status: number; body: { ok: boolean; message: string }; calls: Call[] }> {
  const f = fakeFetch(status);
  const res = await handleRun(r, env, f.fn);
  return { status: res.status, body: await res.json(), calls: f.calls };
}

describe('dashboard /api/run', () => {
  test('analyze: dispatches analyze.yml on main with the ticker; the token goes in the header only', async () => {
    const r = await run(req({ workflow: 'analyze.yml', inputs: { ticker: 'BRK.B' } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.url, 'https://api.github.com/repos/someone/trading/actions/workflows/analyze.yml/dispatches');
    assert.deepEqual(JSON.parse(r.calls[0]!.init.body), { ref: 'main', inputs: { ticker: 'BRK.B' } });
    assert.equal(r.calls[0]!.init.headers.Authorization, 'Bearer ' + TOKEN);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  });
  test('the allow-list: each workflow and its inputs exactly', async () => {
    assert.deepEqual(Object.keys(ALLOWED).sort(), ['analyze.yml', 'exit-report.yml', 'my-options.yml', 'nightly.yml', 'send-exit.yml', 'setup-check.yml']);
    const ok = async (workflow: string, inputs: unknown, sent: unknown): Promise<void> => {
      const r = await run(req({ workflow, inputs }));
      assert.equal(r.status, 200, workflow + ' ' + JSON.stringify(inputs) + ': ' + r.body.message);
      assert.deepEqual(JSON.parse(r.calls[0]!.init.body).inputs, sent);
    };
    await ok('analyze.yml', { ticker: '^VIX', opus: 'true' }, { ticker: '^VIX', opus: 'true' });
    await ok('send-exit.yml', { opus: 'true' }, { opus: 'true' });
    await ok('send-exit.yml', {}, {});
    await ok('exit-report.yml', undefined, {});
    await ok('nightly.yml', {}, { run_checks: 'false' });
    await ok('nightly.yml', { run_checks: 'false' }, { run_checks: 'false' });
    await ok('my-options.yml', {}, {});
    await ok('setup-check.yml', {}, {});
    const bad = async (body: unknown): Promise<void> => {
      const r = await run(req(body));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.calls.length, 0);
      assert.equal(r.body.ok, false);
    };
    await bad({ workflow: 'ai-dispatch.yml', inputs: {} });
    await bad({ workflow: 'claude-order.yml' });
    await bad({ workflow: '../nightly.yml' });
    await bad({ workflow: 'toString' });
    await bad({ workflow: 'analyze.yml', inputs: {} });
    await bad({ workflow: 'analyze.yml', inputs: { ticker: 'tsla' } });
    await bad({ workflow: 'analyze.yml', inputs: { ticker: 'ABCDEFGHIJKLM' } });
    await bad({ workflow: 'analyze.yml', inputs: { ticker: 'A B' } });
    await bad({ workflow: 'analyze.yml', inputs: { ticker: 'TSLA', opus: 'false' } });
    await bad({ workflow: 'analyze.yml', inputs: { ticker: 'TSLA', user: 'u2' } });
    await bad({ workflow: 'nightly.yml', inputs: { run_checks: 'true' } });
    await bad({ workflow: 'exit-report.yml', inputs: { opus: 'true' } });
    await bad({ workflow: 'setup-check.yml', inputs: [] });
    await bad([1, 2]);
  });
  test('Cloudflare Access email: missing, unknown, or no allow-list set = 403', async () => {
    assert.equal((await run(req({ workflow: 'my-options.yml' }, { email: null }))).status, 403);
    assert.equal((await run(req({ workflow: 'my-options.yml' }, { email: 'stranger@example.com' }))).status, 403);
    const r = await run(req({ workflow: 'my-options.yml' }), { ...ENV, ALLOWED_EMAILS: '' });
    assert.equal(r.status, 403);
    assert.equal(r.calls.length, 0);
  });
  test('same origin only; POST only; JSON only; small bodies only', async () => {
    assert.equal((await run(req({ workflow: 'my-options.yml' }, { origin: null }))).status, 403);
    assert.equal((await run(req({ workflow: 'my-options.yml' }, { origin: 'https://evil.example.com' }))).status, 403);
    assert.equal((await run(req(null, { method: 'GET' }))).status, 405);
    assert.equal((await run(req({ workflow: 'my-options.yml' }, { type: 'text/plain' }))).status, 400);
    assert.equal((await run(req(null, { raw: '{not json' }))).status, 400);
    assert.equal((await run(req({ workflow: 'my-options.yml', pad: 'x'.repeat(3000) }))).status, 400);
    assert.equal(checkRun({ method: 'POST', url: 'not a url', origin: SITE, email: ME, contentType: 'application/json', bodyText: '{}', body: BAD_JSON }, ENV).status, 400);
  });
  test('not set up (no REPO / token) = 500; GitHub refusals are explained without the token', async () => {
    assert.equal((await run(req({ workflow: 'my-options.yml' }), { ...ENV, REPO: '' })).status, 500);
    assert.equal((await run(req({ workflow: 'my-options.yml' }), { ...ENV, GITHUB_TOKEN: '' })).status, 500);
    const denied = await run(req({ workflow: 'my-options.yml' }), ENV, 403);
    assert.equal(denied.status, 502);
    assert.match(denied.body.message, /token was refused/);
    assert.ok(!denied.body.message.includes(TOKEN));
    assert.match((await run(req({ workflow: 'my-options.yml' }), ENV, 404)).body.message, /not found/);
    const down = await handleRun(req({ workflow: 'my-options.yml' }), ENV, () => Promise.reject(new Error('net')));
    assert.equal(down.status, 502);
  });
  test('onRequest is the Pages entry; answers are not cached', async () => {
    const res = await onRequest({ request: req({ workflow: 'nope.yml' }), env: ENV });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});
