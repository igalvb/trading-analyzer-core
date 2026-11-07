/**
 * The dashboard's ledger edit function (backend/dashboard/functions/api/edit.js): POST /api/edit -> one commit on the
 * `data` branch (the edited file + a line in ledger/edits.jsonl), behind Cloudflare Access, with a strict check per
 * kind. A fake GitHub (an in-memory branch) stands in for the git data API.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleEdit, validateEdit, applyEdit, LEDGER, RULES, SAVED, onRequest } from '../dashboard/functions/api/edit.js';
import { LEDGER_SCHEMA, LEDGER_BRANCH, LEDGER_FILES, LEDGER_GROUPS, LEDGER_EDIT_KINDS } from '../src/ledger/schema.ts';

const SITE = 'https://trading-dashboard.pages.dev';
const ME = 'me@example.com';
// A fake token made from parts, so no token-shaped literal sits in the repository.
const TOKEN = ['fake', 'token', 'for', 'edits'].join('-');
const ENV = { REPO: 'someone/trading', GITHUB_TOKEN: TOKEN, ALLOWED_EMAILS: ME, TIME_ZONE: 'America/New_York' };
const NOW = Date.parse('2026-11-06T15:00:00Z');
const TODAY = '2026-11-06';
const API = 'https://api.github.com/repos/someone/trading';

interface Call { method: string; url: string; body: unknown; auth: string }
/** An in-memory `data` branch: commits by sha, each with its files; the git data endpoints the function uses. */
function fakeGitHub(files: Record<string, string>, o: { moveOnFirstPatch?: Record<string, string>; failAt?: string; noBranch?: boolean; alwaysConflict?: boolean } = {}) {
  let n = 0;
  const sha = (p: string): string => p + (++n);
  const commits = new Map<string, { tree: string }>(), trees = new Map<string, Record<string, string>>(), blobs = new Map<string, string>();
  const t0 = sha('tree'); trees.set(t0, { ...files });
  let head = sha('commit'); commits.set(head, { tree: t0 });
  let patches = 0;
  const calls: Call[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body, auth: init.headers.Authorization ?? '' });
    const path = url.replace(API, '');
    const key = init.method + ' ' + path.replace(/\?.*$/, '');
    if (o.failAt && key.startsWith(o.failAt)) return new Response('{}', { status: 500 });
    const json = (status: number, v: unknown): Response => new Response(JSON.stringify(v), { status });
    if (key === 'GET /git/ref/heads/data') return o.noBranch ? json(404, {}) : json(200, { object: { sha: head } });
    let m = /^GET \/git\/commits\/(.+)$/.exec(key);
    if (m) { const c = commits.get(m[1]!); return c ? json(200, { tree: { sha: c.tree } }) : json(404, {}); }
    m = /^GET \/contents\/(.+)$/.exec(key);
    if (m) {
      assert.match(init.headers.Accept ?? '', /raw/);
      const ref = /[?&]ref=([^&]+)/.exec(path)![1]!;
      const f = trees.get(commits.get(ref)!.tree)![m[1]!];
      return f === undefined ? new Response('Not Found', { status: 404 }) : new Response(f, { status: 200 });
    }
    if (key === 'POST /git/blobs') { assert.equal(body.encoding, 'utf-8'); const s = sha('blob'); blobs.set(s, body.content); return json(201, { sha: s }); }
    if (key === 'POST /git/trees') {
      const base = trees.get(body.base_tree)!;
      const next = { ...base };
      for (const e of body.tree) { assert.equal(e.mode, '100644'); assert.equal(e.type, 'blob'); next[e.path] = blobs.get(e.sha)!; }
      const s = sha('tree'); trees.set(s, next); return json(201, { sha: s });
    }
    if (key === 'POST /git/commits') { assert.equal(body.parents.length, 1); const s = sha('commit'); commits.set(s, { tree: body.tree }); (commits.get(s) as { tree: string; message?: string; parent?: string }).message = body.message; (commits.get(s) as { parent?: string }).parent = body.parents[0]; return json(201, { sha: s }); }
    if (key === 'PATCH /git/refs/heads/data') {
      patches++;
      assert.equal(body.force, false);
      const parent = (commits.get(body.sha) as { parent?: string }).parent;
      if (patches === 1 && o.moveOnFirstPatch) {
        // Someone else committed first: the head moves; this fast-forward is refused.
        const t = sha('tree'); trees.set(t, { ...trees.get(commits.get(head)!.tree)!, ...o.moveOnFirstPatch });
        const c = sha('commit'); commits.set(c, { tree: t }); head = c;
      }
      if (o.alwaysConflict || parent !== head) return json(422, { message: 'Update is not a fast forward' });
      head = body.sha; return json(200, { object: { sha: head } });
    }
    return json(404, { message: 'unexpected ' + key });
  };
  return { fn, calls, files: (): Record<string, string> => trees.get(commits.get(head)!.tree)!, message: (): string | undefined => (commits.get(head) as { message?: string }).message };
}

function req(body: unknown, o: { origin?: string | null; email?: string | null; method?: string; type?: string; raw?: string } = {}): Request {
  const headers = new Headers();
  if (o.origin !== null) headers.set('Origin', o.origin ?? SITE);
  if (o.email !== null) headers.set('Cf-Access-Authenticated-User-Email', o.email ?? ME);
  headers.set('Content-Type', o.type ?? 'application/json');
  const method = o.method ?? 'POST';
  return new Request(SITE + '/api/edit', { method, headers, ...(method === 'POST' ? { body: o.raw ?? JSON.stringify(body) } : {}) });
}
let idn = 0;
const deps = { now: () => NOW, newId: (p: string) => p + '-test' + (++idn) };
async function edit(gh: ReturnType<typeof fakeGitHub>, body: unknown, o: Parameters<typeof req>[1] = {}, env: Record<string, string> = ENV) {
  const res = await handleEdit(req(body, o), env, gh.fn as never, deps);
  return { status: res.status, body: await res.json() as { ok: boolean; message: string; itemId?: string; after?: unknown } };
}

const HOLDINGS = JSON.stringify({
  schema: 1, updated: '2026-11-05',
  stocks: [{ id: 's1', ticker: 'AAA', kind: 'stock', qty: 10, avgCost: 100, currency: 'USD', bought: '2025-01-10' }],
  options: [{ id: 'o1', ticker: 'BBB', side: 'call', contracts: 2, strike: 50, expiry: '2027-06-17', avgPremium: 3, bought: '2026-06-01', currentValue: 1200 }],
  closed: [],
}, null, 2) + '\n';
const ASSETS = JSON.stringify({ schema: 1, updated: '2026-11-05', items: [{ id: 'a1', group: 'realEstate', name: 'Home', value: 2000000, debt: 800000, currency: 'ILS', asOf: '2026-06-01' }] }, null, 2) + '\n';
const FLOWS = JSON.stringify({ schema: 1, id: 'f1', date: '2026-11-02', group: 'pension', amount: 5000, currency: 'ILS', source: 'suggested' }) + '\n';
const base = (): Record<string, string> => ({ [LEDGER_FILES.holdings]: HOLDINGS, [LEDGER_FILES.assets]: ASSETS, [LEDGER_FILES.flows]: FLOWS, [LEDGER_FILES.edits]: '' });
const editsOf = (gh: ReturnType<typeof fakeGitHub>): Record<string, unknown>[] => gh.files()[LEDGER_FILES.edits]!.trim().split('\n').map((l) => JSON.parse(l));

describe('dashboard /api/edit', () => {
  test('the function mirrors the ledger schema (schema number, branch, files, groups)', () => {
    assert.equal(LEDGER.schema, LEDGER_SCHEMA);
    assert.equal(LEDGER.branch, LEDGER_BRANCH);
    assert.deepEqual(LEDGER.files, LEDGER_FILES);
    assert.deepEqual(LEDGER.groups, [...LEDGER_GROUPS]);
    assert.deepEqual(LEDGER.editKinds, [...LEDGER_EDIT_KINDS]);
    assert.ok((Object.values(RULES).flat() as string[]).every((k) => (LEDGER_EDIT_KINDS as readonly string[]).includes(k)), 'every allowed kind is a LedgerEdit kind');
    assert.deepEqual(Object.keys(RULES).sort(), [LEDGER_FILES.assets, LEDGER_FILES.flows, LEDGER_FILES.holdings, LEDGER_FILES.watchlist].sort());
  });

  test('add a stock: the exact commit sequence; the file and the edit line change in ONE commit', async () => {
    const gh = fakeGitHub(base());
    const r = await edit(gh, { kind: 'add', file: LEDGER_FILES.holdings, item: { type: 'stock', ticker: 'CCC', kind: 'stock', qty: 5, avgCost: 20.5, currency: 'USD', bought: '2026-11-01', note: 'test' } });
    assert.equal(r.status, 200, r.body.message);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.message, SAVED);
    assert.match(r.body.itemId!, /^s-test/);
    assert.deepEqual(gh.calls.map((c) => c.method + ' ' + c.url.replace(API, '').replace(/\?ref=.*$/, '?ref=…')), [
      'GET /git/ref/heads/data', 'GET /git/commits/commit2', 'GET /contents/ledger/holdings.json?ref=…', 'GET /contents/ledger/edits.jsonl?ref=…',
      'POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/data',
    ]);
    assert.ok(gh.calls.every((c) => c.auth === 'Bearer ' + TOKEN));
    const h = JSON.parse(gh.files()[LEDGER_FILES.holdings]!);
    assert.equal(h.updated, TODAY);
    assert.deepEqual(h.stocks[1], { id: r.body.itemId, ticker: 'CCC', kind: 'stock', qty: 5, avgCost: 20.5, currency: 'USD', bought: '2026-11-01', note: 'test' });
    const e = editsOf(gh);
    assert.equal(e.length, 1);
    assert.deepEqual({ ...e[0], at: 'x' }, { schema: 1, at: 'x', by: ME, kind: 'add', file: LEDGER_FILES.holdings, itemId: r.body.itemId, before: null, after: h.stocks[1] });
    assert.equal(gh.message(), 'ledger: add ' + r.body.itemId + ' by dashboard');
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  });

  test('a sha conflict (the branch moved) is retried ONCE from the new head; the other change is kept', async () => {
    const gh = fakeGitHub(base(), { moveOnFirstPatch: { 'ledger/snapshots.jsonl': '{"schema":1,"date":"2026-11-06"}\n' } });
    const r = await edit(gh, { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } });
    assert.equal(r.status, 200, r.body.message);
    assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 2);
    assert.equal(gh.calls.filter((c) => c.url.endsWith('/git/ref/heads/data')).length, 2);
    assert.ok(gh.files()['ledger/snapshots.jsonl'], 'the concurrent commit survives');
    assert.equal(JSON.parse(gh.files()[LEDGER_FILES.holdings]!).stocks.length, 0);
    const again = fakeGitHub(base(), { alwaysConflict: true });
    const r2 = await edit(again, { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } });
    assert.equal(r2.status, 409);
    assert.equal(again.calls.filter((c) => c.method === 'PATCH').length, 2, 'one retry only');
  });

  test('sell part of a stock and a whole call: quantity down / removed, a closed line with cost and proceeds', async () => {
    const gh = fakeGitHub(base());
    const r = await edit(gh, { kind: 'sell', file: LEDGER_FILES.holdings, item: { id: 's1', qty: 4, price: 150, sold: '2026-11-05' } });
    assert.equal(r.status, 200, r.body.message);
    let h = JSON.parse(gh.files()[LEDGER_FILES.holdings]!);
    assert.equal(h.stocks[0].qty, 6);
    assert.deepEqual(h.closed[0], { id: 'c-test' + idn, ticker: 'AAA', kind: 'stock', qty: 4, cost: 400, proceeds: 600, currency: 'USD', bought: '2025-01-10', sold: '2026-11-05' });
    const r2 = await edit(gh, { kind: 'sell', file: LEDGER_FILES.holdings, item: { id: 'o1', qty: 2, price: 7.5, sold: '2026-11-06' } });
    assert.equal(r2.status, 200, r2.body.message);
    h = JSON.parse(gh.files()[LEDGER_FILES.holdings]!);
    assert.equal(h.options.length, 0);
    assert.deepEqual({ ...h.closed[1], id: 'x' }, { id: 'x', ticker: 'BBB', kind: 'call', qty: 2, strike: 50, expiry: '2027-06-17', cost: 600, proceeds: 1500, currency: 'USD', bought: '2026-06-01', sold: '2026-11-06' });
    assert.equal(editsOf(gh).length, 2);
    assert.equal((await edit(gh, { kind: 'sell', file: LEDGER_FILES.holdings, item: { id: 's1', qty: 7, price: 1, sold: TODAY } })).status, 400, 'more than held');
    assert.equal((await edit(gh, { kind: 'sell', file: LEDGER_FILES.holdings, item: { id: 'nope', qty: 1, price: 1, sold: TODAY } })).status, 404);
  });

  test('change keeps the option value the runs write; a stock cannot turn into an option', async () => {
    const gh = fakeGitHub(base());
    const r = await edit(gh, { kind: 'change', file: LEDGER_FILES.holdings, item: { type: 'option', id: 'o1', ticker: 'BBB', side: 'call', contracts: 3, strike: 55, expiry: '2027-06-17', avgPremium: 2.5, bought: '2026-06-01' } });
    assert.equal(r.status, 200, r.body.message);
    assert.deepEqual(JSON.parse(gh.files()[LEDGER_FILES.holdings]!).options[0], { id: 'o1', ticker: 'BBB', side: 'call', contracts: 3, strike: 55, expiry: '2027-06-17', avgPremium: 2.5, bought: '2026-06-01', currentValue: 1200 });
    assert.equal((await edit(gh, { kind: 'change', file: LEDGER_FILES.holdings, item: { type: 'option', id: 's1', ticker: 'AAA', side: 'call', contracts: 1, strike: 5, expiry: '2027-01-15' } })).status, 400);
  });

  test('assets: update a property value + mortgage and its date (Hebrew name kept); add and remove', async () => {
    const gh = fakeGitHub(base());
    const name = '\u05d3\u05d9\u05e8\u05d4 ' + '\u05d3\u05d5\u05d2\u05de\u05d4';
    const r = await edit(gh, { kind: 'change', file: LEDGER_FILES.assets, item: { id: 'a1', group: 'realEstate', name, value: 2100000, debt: 780000, currency: 'ILS', asOf: '2026-11-06' } });
    assert.equal(r.status, 200, r.body.message);
    const a = JSON.parse(gh.files()[LEDGER_FILES.assets]!);
    assert.deepEqual(a.items[0], { id: 'a1', group: 'realEstate', name, value: 2100000, debt: 780000, currency: 'ILS', asOf: '2026-11-06' });
    assert.equal(editsOf(gh)[0]!.before && (editsOf(gh)[0]!.before as { value: number }).value, 2000000);
    const add = await edit(gh, { kind: 'add', file: LEDGER_FILES.assets, item: { group: 'pension', name: 'Fund', provider: 'Track A', value: 100000, currency: 'ILS', asOf: '2026-10-31' } });
    assert.equal(add.status, 200, add.body.message);
    assert.equal(JSON.parse(gh.files()[LEDGER_FILES.assets]!).items.length, 2);
    assert.equal((await edit(gh, { kind: 'remove', file: LEDGER_FILES.assets, item: { id: add.body.itemId } })).status, 200);
    assert.equal(JSON.parse(gh.files()[LEDGER_FILES.assets]!).items.length, 1);
    assert.equal((await edit(gh, { kind: 'add', file: LEDGER_FILES.assets, item: { group: 'pension', name: 'X', value: 1, debt: 5, currency: 'ILS', asOf: TODAY } })).status, 400, 'a mortgage on a pension');
  });

  test('money in / out appends a line; a suggested flow is confirmed or dismissed by a new line with the same id', async () => {
    const gh = fakeGitHub(base());
    const r = await edit(gh, { kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'add', date: '2026-11-04', group: 'stocks', amount: -2500, currency: 'USD', note: 'out' } });
    assert.equal(r.status, 200, r.body.message);
    let lines = gh.files()[LEDGER_FILES.flows]!.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1], { schema: 1, id: r.body.itemId, date: '2026-11-04', group: 'stocks', amount: -2500, currency: 'USD', note: 'out', source: 'owner' });
    assert.equal((await edit(gh, { kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'confirm', id: 'f1' } })).status, 200);
    lines = gh.files()[LEDGER_FILES.flows]!.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[2].id, 'f1');
    assert.equal(lines[2].source, 'confirmed');
    assert.equal((await edit(gh, { kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'dismiss', id: 'f1' } })).status, 409, 'already decided');
    assert.equal((await edit(gh, { kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'dismiss', id: 'zz' } })).status, 404);
    const gh2 = fakeGitHub(base());
    assert.equal((await edit(gh2, { kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'dismiss', id: 'f1' } })).status, 200);
    assert.equal(JSON.parse(gh2.files()[LEDGER_FILES.flows]!.trim().split('\n')[1]!).dismissed, true);
  });

  test('lots: add and remove a dated lot (strict), one commit with an edit line each; options refused', async () => {
    const gh = fakeGitHub(base());
    const lot = (o: Record<string, unknown>) => ({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'add', id: 's1', date: '2025-01-10', qty: 4, price: 90, ...o } });
    const r = await edit(gh, lot({ note: 'pre-split 1 @ 900' }));
    assert.equal(r.status, 200, r.body.message);
    assert.equal(gh.message(), 'ledger: lot s1 by dashboard');
    let s1 = JSON.parse(gh.files()[LEDGER_FILES.holdings]!).stocks[0];
    assert.deepEqual(s1.lots, [{ date: '2025-01-10', qty: 4, price: 90, note: 'pre-split 1 @ 900' }]);
    assert.equal(s1.qty, 10, 'qty and avgCost untouched');
    assert.equal(s1.avgCost, 100);
    assert.equal((await edit(gh, lot({ date: null, qty: 6, price: 106.67 }))).status, 200, 'an undated lot');
    assert.equal((await edit(gh, lot({ qty: 0.5 }))).status, 400, 'the lots would hold more than qty');
    assert.equal((await edit(gh, lot({ id: 'o1' }))).status, 400, 'not on an option');
    assert.equal((await edit(gh, lot({ id: 'zz' }))).status, 404);
    const e = editsOf(gh);
    assert.equal(e.length, 2);
    assert.equal(e[0]!.kind, 'lot');
    assert.equal((e[0]!.before as { lots?: unknown }).lots, undefined);
    assert.deepEqual((e[1]!.after as { lots: unknown[] }).lots.length, 2);
    // remove: by its place AND its numbers (a stale page is refused)
    const del = (o: Record<string, unknown>) => ({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'remove', id: 's1', index: 0, date: '2025-01-10', qty: 4, price: 90, ...o } });
    assert.equal((await edit(gh, del({ price: 91 }))).status, 409);
    assert.equal((await edit(gh, del({ index: 5 }))).status, 409);
    assert.equal((await edit(gh, del({}))).status, 200);
    s1 = JSON.parse(gh.files()[LEDGER_FILES.holdings]!).stocks[0];
    assert.deepEqual(s1.lots, [{ date: null, qty: 6, price: 106.67 }]);
    assert.equal((await edit(gh, del({ index: 0, date: null, qty: 6, price: 106.67 }))).status, 200);
    assert.ok(!('lots' in JSON.parse(gh.files()[LEDGER_FILES.holdings]!).stocks[0]), 'the last lot removed drops the field');
  });

  test('lots survive a change (and must still fit), and shrink first in, first out on a sale', async () => {
    const withLots = JSON.parse(HOLDINGS);
    withLots.stocks[0].lots = [{ date: '2025-03-01', qty: 3, price: 110 }, { date: '2025-01-10', qty: 4, price: 90 }];
    const gh = fakeGitHub({ ...base(), [LEDGER_FILES.holdings]: JSON.stringify(withLots, null, 2) + '\n' });
    const change = (qty: number) => ({ kind: 'change', file: LEDGER_FILES.holdings, item: { type: 'stock', id: 's1', ticker: 'AAA', kind: 'stock', qty, avgCost: 100, currency: 'USD', bought: null } });
    assert.equal((await edit(gh, change(6))).status, 400, 'below the lots');
    assert.equal((await edit(gh, change(12))).status, 200);
    let s1 = JSON.parse(gh.files()[LEDGER_FILES.holdings]!).stocks[0];
    assert.equal(s1.lots.length, 2, 'lots kept on a change');
    // sell 7 of 12: 5 left; the lots hold 7 -> the earliest (2025-01-10, 4) shrinks by 2
    const r = await edit(gh, { kind: 'sell', file: LEDGER_FILES.holdings, item: { id: 's1', qty: 7, price: 150, sold: '2026-11-05' } });
    assert.equal(r.status, 200, r.body.message);
    const h = JSON.parse(gh.files()[LEDGER_FILES.holdings]!);
    s1 = h.stocks[0];
    assert.equal(s1.qty, 5);
    assert.deepEqual(s1.lots, [{ date: '2025-03-01', qty: 3, price: 110 }, { date: '2025-01-10', qty: 2, price: 90 }]);
    assert.equal(h.closed[0].bought, '2025-01-10', 'no bought: the earliest lot');
  });

  test('watchlist: replaced as a whole; a missing file starts from an empty one', async () => {
    const gh = fakeGitHub(base());
    const r = await edit(gh, { kind: 'watchlist', file: LEDGER_FILES.watchlist, item: { tickers: ['AAA', 'BRK.B'] } });
    assert.equal(r.status, 200, r.body.message);
    assert.deepEqual(JSON.parse(gh.files()[LEDGER_FILES.watchlist]!), { schema: 1, updated: TODAY, tickers: ['AAA', 'BRK.B'] });
    assert.equal(gh.message(), 'ledger: watchlist watchlist.json by dashboard');
  });

  test('strict validation: kinds per file, types, bounds, dates, unknown fields', () => {
    const ok = (b: unknown): void => assert.equal(validateEdit(b, TODAY).status, 200, JSON.stringify(b) + ' ' + validateEdit(b, TODAY).message);
    const bad = (b: unknown): void => assert.equal(validateEdit(b, TODAY).status, 400, JSON.stringify(b));
    const stock = { type: 'stock', ticker: 'AAA', kind: 'stock', qty: 1, avgCost: 1, currency: 'USD', bought: null };
    ok({ kind: 'add', file: LEDGER_FILES.holdings, item: stock });
    ok({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, subType: 'Stocks long' } });
    const lotAdd = { op: 'add', id: 's1', date: '2025-01-10', qty: 1, price: 1 };
    ok({ kind: 'lot', file: LEDGER_FILES.holdings, item: lotAdd });
    ok({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, date: null } });
    bad({ kind: 'lot', file: LEDGER_FILES.assets, item: lotAdd });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, op: 'move' } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, qty: 0 } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, price: -1 } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, date: '2099-01-01' } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, date: '2025-02-30' } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { ...lotAdd, extra: 1 } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'add', id: 's1', qty: 1, price: 1 } });
    ok({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'remove', id: 's1', index: 0, date: null, qty: 1, price: 1 } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'remove', id: 's1', index: 0.5, date: null, qty: 1, price: 1 } });
    bad({ kind: 'lot', file: LEDGER_FILES.holdings, item: { op: 'remove', id: 's1', date: null, qty: 1, price: 1 } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, lots: [] } });
    ok({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'cash', name: 'x', value: 1, currency: 'ILS', asOf: TODAY, person: 'P1' } });
    bad({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'cash', name: 'x', value: 1, currency: 'ILS', asOf: TODAY, person: 'x'.repeat(41) } });
    ok({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, kind: 'crypto', ticker: 'BTC', manualPrice: 70000 } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, ticker: 'aaa' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, qty: 0 } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, qty: '5' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, currency: 'EUR' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, bought: '2026-11-09' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, bought: '2026-02-30' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, extra: 1 } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, id: 's9' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, type: 'bond' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, note: 'a\u0000b' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { ...stock, note: 'x'.repeat(301) } });
    ok({ kind: 'add', file: LEDGER_FILES.holdings, item: { type: 'option', ticker: 'AAA', side: 'call', contracts: 1, strike: 10, expiry: '2028-01-21' } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: { type: 'option', ticker: 'AAA', side: 'call', contracts: 1.5, strike: 10, expiry: '2028-01-21' } });
    bad({ kind: 'flow', file: LEDGER_FILES.holdings, item: {} });
    bad({ kind: 'add', file: LEDGER_FILES.snapshots, item: {} });
    bad({ kind: 'add', file: LEDGER_FILES.edits, item: {} });
    bad({ kind: 'add', file: '../secrets.json', item: {} });
    bad({ kind: 'add', file: 'toString', item: {} });
    bad({ kind: 'remove', file: LEDGER_FILES.holdings, item: { id: '../x' } });
    bad({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'stocks', name: 'x', value: 1, currency: 'ILS', asOf: TODAY } });
    bad({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'cash', name: '   ', value: 1, currency: 'ILS', asOf: TODAY } });
    bad({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'cash', name: 'x', value: -1, currency: 'ILS', asOf: TODAY } });
    ok({ kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'add', date: TODAY, group: 'cash', amount: 1, currency: 'ILS' } });
    bad({ kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'add', date: TODAY, group: 'cash', amount: 0, currency: 'ILS' } });
    bad({ kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'add', date: TODAY, group: 'gold', amount: 1, currency: 'ILS' } });
    bad({ kind: 'flow', file: LEDGER_FILES.flows, item: { op: 'delete', id: 'f1' } });
    bad({ kind: 'watchlist', file: LEDGER_FILES.watchlist, item: { tickers: ['AAA', 'AAA'] } });
    bad({ kind: 'watchlist', file: LEDGER_FILES.watchlist, item: { tickers: ['A A'] } });
    bad({ kind: 'add', file: LEDGER_FILES.holdings, item: stock, more: 1 });
    bad([1]);
  });

  test('guards: Access email, same origin, POST, JSON, 8 KB; nothing is called at GitHub', async () => {
    const gh = fakeGitHub(base());
    const body = { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } };
    assert.equal((await edit(gh, body, { email: null })).status, 403);
    assert.equal((await edit(gh, body, { email: 'stranger@example.com' })).status, 403);
    assert.equal((await edit(gh, body, {}, { ...ENV, ALLOWED_EMAILS: '' })).status, 403);
    assert.equal((await edit(gh, body, { origin: null })).status, 403);
    assert.equal((await edit(gh, body, { origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await edit(gh, null, { method: 'GET' })).status, 405);
    assert.equal((await edit(gh, body, { type: 'text/plain' })).status, 400);
    assert.equal((await edit(gh, null, { raw: '{nope' })).status, 400);
    assert.equal((await edit(gh, { ...body, item: { id: 's1', pad: 'x'.repeat(9000) } })).status, 400);
    assert.equal(gh.calls.length, 0);
    assert.equal((await edit(gh, body, {}, { ...ENV, GITHUB_TOKEN: '' })).status, 500);
    assert.equal((await edit(gh, body, {}, { ...ENV, REPO: 'bad repo' })).status, 500);
    assert.equal(gh.calls.length, 0);
  });

  test('GitHub failures are explained without the token; no data branch = 409; nothing half-written', async () => {
    const none = fakeGitHub(base(), { noBranch: true });
    const r = await edit(none, { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /no data branch/);
    const broken = fakeGitHub(base(), { failAt: 'POST /git/trees' });
    const r2 = await edit(broken, { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } });
    assert.equal(r2.status, 502);
    assert.ok(!r2.body.message.includes(TOKEN));
    assert.equal(JSON.parse(broken.files()[LEDGER_FILES.holdings]!).stocks.length, 1, 'the branch did not move');
    const down = await handleEdit(req({ kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } }), ENV, (() => Promise.reject(new Error('net'))) as never, deps);
    assert.equal(down.status, 502);
    const newer = fakeGitHub({ ...base(), [LEDGER_FILES.holdings]: '{"schema":2,"stocks":[]}' });
    assert.equal((await edit(newer, { kind: 'remove', file: LEDGER_FILES.holdings, item: { id: 's1' } })).status, 409);
  });

  test('applyEdit is pure: the same input gives the same file text', async () => {
    const v = validateEdit({ kind: 'add', file: LEDGER_FILES.assets, item: { group: 'cash', name: 'Bank', value: 10, currency: 'ILS', asOf: TODAY } }, TODAY);
    const meta = { today: TODAY, newId: (p: string) => p + '-1' };
    const a = await applyEdit(v, ASSETS, meta), b = await applyEdit(v, ASSETS, meta);
    assert.equal(a.content, b.content);
    assert.ok(a.content.endsWith('\n'));
  });

  test('onRequest is the Pages entry; answers are not cached', async () => {
    const res = await onRequest({ request: req({ kind: 'nope' }), env: ENV });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});
