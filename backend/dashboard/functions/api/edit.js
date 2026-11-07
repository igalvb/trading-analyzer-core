/**
 * Cloudflare Pages Function: POST /api/edit {kind, file, item} -> one commit on the repository's private `data` branch
 * (docs/DASHBOARD.md "Net worth, growth graph, editing"). Plain JavaScript, no build step. The dashboard's edit
 * screens call it; Cloudflare Access stands in front of the whole site, and this checks again (as run.js does):
 *   1. POST only, JSON body of at most 8 KB, from the same origin (the Origin header equals the site's own).
 *   2. Cloudflare Access's header Cf-Access-Authenticated-User-Email is present AND in env.ALLOWED_EMAILS.
 *   3. A strict check per kind and file (RULES below): every field typed and bounded, unknown fields refused.
 * Then it changes the ledger file and appends a LedgerEdit line to ledger/edits.jsonl IN ONE COMMIT, with the git
 * data API (read the branch head, the two files at that commit, create two blobs, a tree, a commit, then move the
 * branch with force=false). When the branch moved in between (another edit, a run), it starts again once from the
 * new head. Commit message: 'ledger: <kind> <id> by dashboard'.
 * Token: env.GITHUB_TOKEN, the same fine-grained token as the Run buttons with one more permission on this one
 * repository: Contents: Read and write. Env: REPO (owner/name), ALLOWED_EMAILS, optional TIME_ZONE for 'updated'.
 * It answers {ok, message, itemId?, after?}; the token is never echoed.
 *
 * The ledger format is backend/src/ledger/schema.ts (LEDGER below mirrors it; test/dashboard.editFunction.test.ts
 * holds the two equal).
 */

export const LEDGER = {
  schema: 1,
  branch: 'data',
  files: {
    holdings: 'ledger/holdings.json', assets: 'ledger/assets.json', watchlist: 'ledger/watchlist.json',
    flows: 'ledger/flows.jsonl', snapshots: 'ledger/snapshots.jsonl', edits: 'ledger/edits.jsonl', targets: 'ledger/targets.json', prices: 'ledger/prices.json',
  },
  groups: ['stocks', 'btcFunds', 'crypto', 'calls', 'pension', 'funds', 'realEstate', 'cash'],
  editKinds: ['add', 'change', 'remove', 'sell', 'flow', 'watchlist', 'lot'],
};
const F = LEDGER.files;
/** file -> the kinds allowed on it. */
export const RULES = {
  [F.holdings]: ['add', 'change', 'sell', 'remove', 'lot'],
  [F.assets]: ['add', 'change', 'remove'],
  [F.flows]: ['flow'],
  [F.watchlist]: ['watchlist'],
};

export const MAX_BODY_BYTES = 8192;
/** Dated purchase lots per holding (schema.ts LedgerStock.lots), at most. */
export const MAX_LOTS = 200;
export const BAD_JSON = Symbol('bad json');
export const parseJson = (text) => Promise.resolve().then(() => JSON.parse(text)).catch(() => BAD_JSON);
const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';
export const SAVED = 'Saved ✓ — the dashboard updates after the next run.';

// ── field checks (each returns an error text, or null when fine) ───────────────────────────────────────────────────

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const TICKER = /^[A-Z0-9.^-]{1,12}$/;
const ID = /^[A-Za-z0-9_-]{1,48}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const validDay = (v) => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const MAX_MONEY = 1e10;

/** A schema of fields: name -> [required, check(v) -> error | null]. */
const num = (min, max, opts = {}) => (v) => typeof v !== 'number' || !Number.isFinite(v) ? 'must be a number'
  : opts.int && !Number.isInteger(v) ? 'must be a whole number' : (opts.gt ? v <= min : v < min) ? 'must be ' + (opts.gt ? 'above ' : 'at least ') + min : v > max ? 'is too large' : null;
const numOrNull = (min, max) => (v) => v === null ? null : num(min, max)(v);
const text = (max, minLen = 0) => (v) => typeof v !== 'string' ? 'must be text' : v.trim().length < minLen ? 'is empty' : v.length > max ? 'is too long (' + max + ' at most)' : CONTROL.test(v) ? 'has a control character' : null;
const oneOf = (...xs) => (v) => xs.includes(v) ? null : 'must be one of ' + xs.join(', ');
const ticker = (v) => typeof v === 'string' && TICKER.test(v) ? null : 'must be a ticker (A-Z, 0-9, . ^ -; 12 at most)';
const id = (v) => typeof v === 'string' && ID.test(v) ? null : 'must be an id';
const day = (notAfter) => (v) => !validDay(v) ? 'must be a date YYYY-MM-DD' : notAfter && v > notAfter ? 'is in the future' : null;
const dayOrNull = (notAfter) => (v) => v === null ? null : day(notAfter)(v);
const currency = oneOf('USD', 'ILS');

/** Checks `item` against `spec`; returns {item} (only the spec's fields, trimmed text) or {error}. */
function check(item, spec) {
  if (!isObj(item)) return { error: 'The item must be an object.' };
  for (const k of Object.keys(item)) if (!own(spec, k)) return { error: 'Field not allowed: ' + String(k).slice(0, 24) + '.' };
  const out = {};
  for (const [k, [required, fn]] of Object.entries(spec)) {
    if (!own(item, k) || item[k] === undefined) { if (required) return { error: 'Missing field: ' + k + '.' }; continue; }
    const err = fn(item[k]);
    if (err) return { error: k + ' ' + err + '.' };
    out[k] = typeof item[k] === 'string' && k !== 'ticker' ? item[k].trim() : item[k];
  }
  return { item: out };
}

const tomorrowOf = (today) => new Date(Date.parse(today + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);

function specs(today) {
  const past = tomorrowOf(today); // a phone a time zone ahead may already be on tomorrow
  return {
    stock: {
      type: [true, oneOf('stock')], ticker: [true, ticker], kind: [true, oneOf('stock', 'btcFund', 'crypto')], qty: [true, num(0, 1e9, { gt: true })],
      avgCost: [false, numOrNull(0, 1e7)], currency: [true, currency], bought: [false, dayOrNull(past)], manualPrice: [false, numOrNull(0, 1e7)], note: [false, text(300)], subType: [false, text(40)],
    },
    option: {
      type: [true, oneOf('option')], ticker: [true, ticker], side: [true, oneOf('call')], contracts: [true, num(0, 1e6, { gt: true, int: true })],
      strike: [true, num(0, 1e6, { gt: true })], expiry: [true, day(null)], avgPremium: [false, numOrNull(0, 1e6)], bought: [false, dayOrNull(past)], note: [false, text(300)],
    },
    sell: { id: [true, id], qty: [true, num(0, 1e9, { gt: true })], price: [true, num(0, 1e7)], sold: [true, day(past)], note: [false, text(300)] },
    asset: {
      group: [true, oneOf('pension', 'funds', 'realEstate', 'cash')], name: [true, text(80, 1)], provider: [false, text(80)], value: [true, num(0, MAX_MONEY)],
      debt: [false, numOrNull(0, MAX_MONEY)], currency: [true, currency], asOf: [true, day(past)], note: [false, text(300)], person: [false, text(40)],
    },
    flowAdd: {
      op: [true, oneOf('add')], date: [true, day(past)], group: [true, oneOf(...LEDGER.groups)], itemId: [false, (v) => v === null ? null : id(v)],
      amount: [true, (v) => num(-MAX_MONEY, MAX_MONEY)(v) || (v === 0 ? 'must not be 0' : null)], currency: [true, currency], note: [false, text(300)],
    },
    flowDecide: { op: [true, oneOf('confirm', 'dismiss')], id: [true, id] },
    watchlist: { tickers: [true, (v) => !Array.isArray(v) ? 'must be a list' : v.length > 200 ? 'has more than 200 tickers' : v.some((t) => ticker(t)) ? 'has a bad ticker' : new Set(v).size !== v.length ? 'has a ticker twice' : null] },
    byId: { id: [true, id] },
    // Dated purchase lots (additive 2026-11-07): add one to a holding, or remove one by its place AND its numbers.
    lotAdd: { op: [true, oneOf('add')], id: [true, id], date: [true, dayOrNull(past)], qty: [true, num(0, 1e9, { gt: true })], price: [true, num(0, 1e7)], note: [false, text(120)] },
    lotRemove: { op: [true, oneOf('remove')], id: [true, id], index: [true, num(0, MAX_LOTS - 1, { int: true })], date: [true, dayOrNull(null)], qty: [true, num(0, 1e9, { gt: true })], price: [true, num(0, 1e7)] },
  };
}

/**
 * The pure check of one request body. Returns {status: 400, message} or {status: 200, kind, file, item} where `item`
 * holds only checked fields. `today` = 'YYYY-MM-DD' (dates after tomorrow are refused for past events).
 */
export function validateEdit(body, today) {
  if (!isObj(body)) return { status: 400, message: 'Bad request.' };
  for (const k of Object.keys(body)) if (!['kind', 'file', 'item'].includes(k)) return { status: 400, message: 'Field not allowed: ' + String(k).slice(0, 24) + '.' };
  const { kind, file } = body;
  const kinds = typeof file === 'string' && own(RULES, file) ? RULES[file] : null;
  if (!kinds) return { status: 400, message: 'That file cannot be edited here.' };
  if (typeof kind !== 'string' || !kinds.includes(kind)) return { status: 400, message: 'That edit is not allowed on this file.' };
  const S = specs(today);
  const it = body.item;
  let spec;
  if (file === F.holdings) {
    if (kind === 'sell') spec = S.sell;
    else if (kind === 'remove') spec = S.byId;
    else if (kind === 'lot') spec = isObj(it) && it.op === 'add' ? S.lotAdd : isObj(it) && it.op === 'remove' ? S.lotRemove : null;
    else {
      const t = isObj(it) ? it.type : null;
      spec = t === 'stock' ? S.stock : t === 'option' ? S.option : null;
      if (!spec) return { status: 400, message: 'type must be stock or option.' };
      if (kind === 'change') spec = { ...spec, id: [true, id] };
    }
    if (!spec) return { status: 400, message: 'op must be add or remove.' };
  } else if (file === F.assets) spec = kind === 'remove' ? S.byId : kind === 'change' ? { ...S.asset, id: [true, id] } : S.asset;
  else if (file === F.flows) spec = isObj(it) && it.op === 'add' ? S.flowAdd : S.flowDecide;
  else spec = S.watchlist;
  const c = check(it, spec);
  if (c.error) return { status: 400, message: c.error };
  const item = c.item;
  if (file === F.assets && item.group !== 'realEstate' && item.debt != null && item.debt !== 0) return { status: 400, message: 'Only real estate has a mortgage.' };
  return { status: 200, kind, file, item };
}

/** The request guards shared with run.js. Returns {status, message} to refuse, or {status: 200, email, body}. */
export function checkRequest(req, env) {
  if (req.method !== 'POST') return { status: 405, message: 'Use POST.' };
  if (!URL.canParse(String(req.url))) return { status: 400, message: 'Bad request.' };
  const site = new URL(req.url).origin;
  if (!req.origin || req.origin !== site) return { status: 403, message: 'Not from this site.' };
  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(req.email || '').trim().toLowerCase();
  if (!email || !allowed.includes(email)) return { status: 403, message: 'Not allowed.' };
  if (!/^application\/json\b/i.test(String(req.contentType || ''))) return { status: 400, message: 'Send JSON.' };
  if (new TextEncoder().encode(String(req.bodyText || '')).length > MAX_BODY_BYTES) return { status: 400, message: 'Too large.' };
  if (req.body === BAD_JSON) return { status: 400, message: 'Bad JSON.' };
  return { status: 200, email, body: req.body };
}

// ── applying an edit to the file's text (pure) ────────────────────────────────────────────────────────────────────

const parseOr = (t, fallback) => Promise.resolve().then(() => (t == null || t === '' ? fallback : JSON.parse(t))).catch(() => BAD_JSON);
const jsonText = (o) => JSON.stringify(o, null, 2) + '\n';
const appendLine = (t, o) => (t && !t.endsWith('\n') ? t + '\n' : t || '') + JSON.stringify(o) + '\n';
const fail = (status, message) => ({ error: { status, message } });

/** The last line of each flow id in a flows.jsonl text. */
async function flowsById(t) {
  const by = new Map();
  for (const line of String(t || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = await parseOr(line, null);
    if (isObj(o) && typeof o.id === 'string') by.set(o.id, o);
  }
  return by;
}

const roundQty = (x) => Math.round(x * 1e8) / 1e8;
const lotQty = (lots) => roundQty(lots.reduce((a, l) => a + (typeof l.qty === 'number' ? l.qty : 0), 0));
const earliestLot = (lots) => lots.map((l) => l.date).filter((d) => typeof d === 'string' && d).sort()[0] ?? null;
/** The lots kept when `left` units remain: while they hold more than `left`, the earliest dated lot (else an undated one) shrinks first. */
function lotsAfterSale(lots, left) {
  const out = lots.map((l) => ({ ...l }));
  let over = roundQty(lotQty(out) - left);
  const order = out.map((l, k) => k).sort((a, b) => { const da = out[a].date, db = out[b].date; return da == null ? (db == null ? a - b : 1) : db == null ? -1 : da < db ? -1 : da > db ? 1 : a - b; });
  for (const k of order) {
    if (over <= 1e-9) break;
    const take = Math.min(out[k].qty, over);
    out[k].qty = roundQty(out[k].qty - take);
    over = roundQty(over - take);
  }
  return out.filter((l) => l.qty > 1e-9);
}

/**
 * Applies a checked edit to the current file text (null = the file does not exist yet). Returns
 * {content, itemId, before, after} or {error: {status, message}}. meta: {today, newId(prefix)}.
 */
export async function applyEdit(v, current, meta) {
  const { kind, file, item } = v;
  if (file === F.flows) {
    if (item.op === 'add') {
      const fid = meta.newId('f');
      const line = { schema: LEDGER.schema, id: fid, date: item.date, group: item.group, ...(item.itemId ? { itemId: item.itemId } : {}), amount: item.amount, currency: item.currency, ...(item.note ? { note: item.note } : {}), source: 'owner' };
      return { content: appendLine(current, line), itemId: fid, before: null, after: line };
    }
    const had = (await flowsById(current)).get(item.id);
    if (!had) return fail(404, 'That money in/out line was not found.');
    if (had.source !== 'suggested' || had.dismissed) return fail(409, 'That line is not waiting for a decision any more.');
    const line = item.op === 'confirm' ? { ...had, schema: LEDGER.schema, source: 'confirmed' } : { ...had, schema: LEDGER.schema, dismissed: true };
    return { content: appendLine(current, line), itemId: item.id, before: had, after: line };
  }
  const empty = file === F.holdings ? { schema: LEDGER.schema, updated: meta.today, stocks: [], options: [], closed: [] }
    : file === F.assets ? { schema: LEDGER.schema, updated: meta.today, items: [] } : { schema: LEDGER.schema, updated: meta.today, tickers: [] };
  const doc = await parseOr(current, empty);
  if (doc === BAD_JSON || !isObj(doc)) return fail(409, 'The ledger file could not be read; nothing was changed.');
  if (typeof doc.schema === 'number' && doc.schema > LEDGER.schema) return fail(409, 'The ledger has a newer format; update the dashboard first.');
  const next = { ...doc, updated: meta.today };
  if (file === F.watchlist) {
    next.tickers = item.tickers.slice();
    return { content: jsonText(next), itemId: null, before: Array.isArray(doc.tickers) ? doc.tickers : [], after: next.tickers };
  }
  if (file === F.assets) {
    const items = Array.isArray(doc.items) ? doc.items.slice() : [];
    const at = item.id ? items.findIndex((x) => isObj(x) && x.id === item.id) : -1;
    if (kind !== 'add' && at < 0) return fail(404, 'That item was not found in the ledger.');
    const before = at >= 0 ? items[at] : null;
    if (kind === 'remove') { items.splice(at, 1); next.items = items; return { content: jsonText(next), itemId: item.id, before, after: null }; }
    const after = { id: kind === 'add' ? meta.newId('a') : item.id, ...item };
    delete after.type;
    if (kind === 'add') items.push(after); else items[at] = after;
    next.items = items;
    return { content: jsonText(next), itemId: after.id, before, after };
  }
  // holdings
  const stocks = Array.isArray(doc.stocks) ? doc.stocks.slice() : [], options = Array.isArray(doc.options) ? doc.options.slice() : [], closed = Array.isArray(doc.closed) ? doc.closed.slice() : [];
  const findIn = (xs) => xs.findIndex((x) => isObj(x) && x.id === item.id);
  const si = item.id ? findIn(stocks) : -1, oi = item.id ? findIn(options) : -1;
  const done = (itemId, before, after) => { next.stocks = stocks; next.options = options; next.closed = closed; return { content: jsonText(next), itemId, before, after }; };
  if (kind === 'add') {
    const { type, ...rest } = item;
    const after = { id: meta.newId(type === 'option' ? 'o' : 's'), ...rest };
    if (type === 'option') options.push(after); else stocks.push(after);
    return done(after.id, null, after);
  }
  if (si < 0 && oi < 0) return fail(404, 'That holding was not found in the ledger.');
  const isOpt = oi >= 0, list = isOpt ? options : stocks, at = isOpt ? oi : si, before = list[at];
  if (kind === 'remove') { list.splice(at, 1); return done(item.id, before, null); }
  const lots = !isOpt && Array.isArray(before.lots) ? before.lots.filter(isObj) : [];
  if (kind === 'lot') {
    if (isOpt) return fail(400, 'Lots are for stocks, bitcoin funds and coins, not options.');
    if (item.op === 'add') {
      if (lots.length >= MAX_LOTS) return fail(400, 'This holding has ' + MAX_LOTS + ' lots already.');
      const inLots = lotQty(lots);
      if (inLots + item.qty > before.qty + 1e-9) return fail(400, 'The lots would hold ' + roundQty(inLots + item.qty) + ', more than the ' + before.qty + ' you hold.');
      const lot = { date: item.date, qty: item.qty, price: item.price, ...(item.note ? { note: item.note } : {}) };
      const after = { ...before, lots: [...lots, lot] };
      list[at] = after;
      return done(item.id, before, after);
    }
    const had = lots[item.index];
    if (!had || had.date !== item.date || had.qty !== item.qty || had.price !== item.price) return fail(409, 'That lot is not in the ledger as shown any more; reload and try again.');
    const rest = lots.filter((_, k) => k !== item.index);
    const after = { ...before };
    if (rest.length) after.lots = rest; else delete after.lots;
    list[at] = after;
    return done(item.id, before, after);
  }
  if (kind === 'change') {
    const { type, ...rest } = item;
    if ((type === 'option') !== isOpt) return fail(400, 'A stock cannot become an option (remove it and add the new one).');
    // A holding's dated lots are changed with the lot edit only; they stay, and must still fit in the quantity.
    if (lots.length && lotQty(lots) > rest.qty + 1e-9) return fail(400, 'Your dated lots hold ' + roundQty(lotQty(lots)) + '; remove a lot before setting the quantity to ' + rest.qty + '.');
    // Fields the runs write (an option's last market value) stay as they were.
    const after = { ...rest, ...(isOpt && own(before, 'currentValue') ? { currentValue: before.currentValue } : {}), ...(lots.length ? { lots } : {}) };
    list[at] = after;
    return done(item.id, before, after);
  }
  // sell
  const held = isOpt ? before.contracts : before.qty;
  if (!(typeof held === 'number') || item.qty > held + 1e-9) return fail(400, 'You hold ' + held + '; you cannot sell ' + item.qty + '.');
  if (isOpt && !Number.isInteger(item.qty)) return fail(400, 'Contracts are sold whole.');
  const mult = isOpt ? 100 : 1;
  const unitCost = isOpt ? before.avgPremium : before.avgCost;
  const sale = {
    id: meta.newId('c'), ticker: before.ticker, kind: isOpt ? before.side : before.kind, qty: item.qty,
    ...(isOpt ? { strike: before.strike, expiry: before.expiry } : {}),
    cost: typeof unitCost === 'number' ? Math.round(unitCost * item.qty * mult * 100) / 100 : null,
    proceeds: Math.round(item.price * item.qty * mult * 100) / 100, currency: isOpt ? 'USD' : before.currency === 'ILS' ? 'ILS' : 'USD',
    bought: before.bought ?? earliestLot(lots), sold: item.sold, ...(item.note ? { note: item.note } : {}),
  };
  const left = Math.round((held - item.qty) * 1e8) / 1e8;
  let remaining = null;
  if (left <= 1e-9) list.splice(at, 1);
  else {
    remaining = { ...before, [isOpt ? 'contracts' : 'qty']: left };
    // Dated lots that no longer fit in what is left go first in, first out (the earliest dated lot first).
    if (lots.length) { const kept = lotsAfterSale(lots, left); if (kept.length) remaining.lots = kept; else delete remaining.lots; }
    list[at] = remaining;
  }
  closed.push(sale);
  return done(item.id, before, { holding: remaining, closed: sale });
}

// ── GitHub (git data API) ─────────────────────────────────────────────────────────────────────────────────────────

const ghHeaders = (token, raw) => ({
  Authorization: 'Bearer ' + token, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'trading-dashboard', 'Content-Type': 'application/json',
});

/** One GitHub call: {status, json | text} or {status: 0} when GitHub could not be reached. */
async function gh(fetchImpl, token, method, url, body, raw) {
  const res = await Promise.resolve().then(() => fetchImpl(url, { method, headers: ghHeaders(token, raw), ...(body ? { body: JSON.stringify(body) } : {}) })).catch(() => null);
  if (!res) return { status: 0 };
  const t = await res.text().catch(() => '');
  return { status: res.status, text: t, json: raw ? null : await parseOr(t, null) };
}

const whyNot = (status) => status === 0 ? 'GitHub could not be reached. Try again in a minute.'
  : status === 401 || status === 403 ? 'the token was refused (check GITHUB_TOKEN: Contents read and write on this repository)'
    : status === 404 ? 'the repository was not found (check REPO)' : 'GitHub answered ' + status;

/**
 * Reads the head of the data branch and the two files, applies the edit, writes both in one commit and moves the
 * branch (force=false). Returns {ok, status, message, itemId?, after?, conflict?}.
 */
async function commitOnce(ctx, v) {
  const { fetchImpl, token, api, meta } = ctx;
  const ref = await gh(fetchImpl, token, 'GET', api + '/git/ref/heads/' + LEDGER.branch);
  if (ref.status === 404) return { ok: false, status: 409, message: 'There is no data branch yet: run the ledger migration first.' };
  if (ref.status !== 200 || !isObj(ref.json) || !isObj(ref.json.object)) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(ref.status) + '.' };
  const head = ref.json.object.sha;
  const commit = await gh(fetchImpl, token, 'GET', api + '/git/commits/' + head);
  if (commit.status !== 200 || !isObj(commit.json) || !isObj(commit.json.tree)) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(commit.status) + '.' };
  const read = async (path) => {
    const r = await gh(fetchImpl, token, 'GET', api + '/contents/' + path + '?ref=' + head, null, true);
    return r.status === 200 ? { text: r.text } : r.status === 404 ? { text: null } : { error: r.status };
  };
  const cur = await read(v.file), log = await read(F.edits);
  if (cur.error !== undefined || log.error !== undefined) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(cur.error ?? log.error) + '.' };
  const r = await applyEdit(v, cur.text, meta);
  if (r.error) return { ok: false, status: r.error.status, message: r.error.message };
  const edit = { schema: LEDGER.schema, at: meta.at, by: meta.email, kind: v.kind, file: v.file, itemId: r.itemId ?? null, before: r.before ?? null, after: r.after ?? null };
  const blob = async (content) => gh(fetchImpl, token, 'POST', api + '/git/blobs', { content, encoding: 'utf-8' });
  const b1 = await blob(r.content), b2 = await blob(appendLine(log.text, edit));
  if (b1.status !== 201 || b2.status !== 201) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(b1.status !== 201 ? b1.status : b2.status) + '.' };
  const tree = await gh(fetchImpl, token, 'POST', api + '/git/trees', {
    base_tree: commit.json.tree.sha,
    tree: [{ path: v.file, mode: '100644', type: 'blob', sha: b1.json.sha }, { path: F.edits, mode: '100644', type: 'blob', sha: b2.json.sha }],
  });
  if (tree.status !== 201) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(tree.status) + '.' };
  const message = 'ledger: ' + v.kind + ' ' + (r.itemId || v.file.replace(/^ledger\//, '')) + ' by dashboard';
  const made = await gh(fetchImpl, token, 'POST', api + '/git/commits', { message, tree: tree.json.sha, parents: [head] });
  if (made.status !== 201) return { ok: false, status: 502, message: 'Not saved: ' + whyNot(made.status) + '.' };
  const moved = await gh(fetchImpl, token, 'PATCH', api + '/git/refs/heads/' + LEDGER.branch, { sha: made.json.sha, force: false });
  if (moved.status === 200) return { ok: true, status: 200, message: SAVED, itemId: r.itemId ?? null, after: r.after ?? null };
  if (moved.status === 422 || moved.status === 409) return { ok: false, status: 409, conflict: true, message: 'The ledger changed while saving. Try again.' };
  return { ok: false, status: 502, message: 'Not saved: ' + whyNot(moved.status) + '.' };
}

const reply = (status, o) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

const randomPart = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6); };
/** A day 'YYYY-MM-DD' in `zone` (falls back to UTC for an unknown zone). */
export function dayIn(ms, zone) {
  const f = (z) => new Date(ms).toLocaleDateString('en-CA', { timeZone: z });
  return Promise.resolve().then(() => f(zone || 'America/New_York')).catch(() => f('UTC'));
}

/** The whole handler (tests pass a fake fetch and a fixed clock / ids). */
export async function handleEdit(request, env, fetchImpl = fetch, deps = {}) {
  env = env || {};
  const bodyText = request.method === 'POST' ? await request.text() : '';
  const body = bodyText.length <= MAX_BODY_BYTES ? await parseJson(bodyText) : BAD_JSON;
  const g = checkRequest({
    method: request.method, url: request.url, origin: request.headers.get('Origin'), email: request.headers.get(ACCESS_EMAIL_HEADER),
    contentType: request.headers.get('Content-Type'), bodyText, body,
  }, env);
  if (g.status !== 200) return reply(g.status, { ok: false, message: g.message });
  const now = (deps.now || Date.now)();
  const today = await dayIn(now, env.TIME_ZONE);
  const v = validateEdit(g.body, today);
  if (v.status !== 200) return reply(v.status, { ok: false, message: v.message });
  const repo = String(env.REPO || '').trim(), token = String(env.GITHUB_TOKEN || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return reply(500, { ok: false, message: 'The dashboard is not set up to save edits (REPO / GITHUB_TOKEN).' });
  const newId = deps.newId || ((p) => p + '-' + now.toString(36) + randomPart());
  const ctx = { fetchImpl, token, api: 'https://api.github.com/repos/' + repo, meta: { today, at: new Date(now).toISOString(), email: g.email, newId } };
  let r = await commitOnce(ctx, v);
  if (r.conflict) r = await commitOnce(ctx, v);
  const out = { ok: r.ok, message: r.message };
  if (r.ok) { out.itemId = r.itemId; out.after = r.after; }
  return reply(r.status, out);
}

export async function onRequest(context) {
  return handleEdit(context.request, context.env);
}
