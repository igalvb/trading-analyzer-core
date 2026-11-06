/**
 * Cloudflare Pages Function: POST /api/run {workflow, inputs} -> GitHub workflow_dispatch (docs/DASHBOARD.md).
 * Plain JavaScript, no build step. The dashboard's Run buttons call it; Cloudflare Access stands in front of the
 * whole site, and this checks again (defence in depth):
 *   1. POST only, JSON body of at most 2 KB, from the same origin (the Origin header equals the site's own).
 *   2. Cloudflare Access's header Cf-Access-Authenticated-User-Email is present AND in env.ALLOWED_EMAILS
 *      (comma list). Anything else: 403. No ALLOWED_EMAILS set: 403 for everyone.
 *   3. A strict allow-list of workflows and inputs (ALLOWED below); anything else: 400.
 * Then it asks GitHub to start the run on env.REPO (owner/name) with env.GITHUB_TOKEN (a fine-grained token with
 * Actions read and write on that one repository). It answers {ok, message}; the token is never echoed.
 * Pages project settings: Variables and Secrets -> GITHUB_TOKEN (secret), REPO, ALLOWED_EMAILS.
 */

const TICKER = /^[A-Z0-9.^-]{1,12}$/;
const optTrue = (v) => v === undefined || v === 'true';

/** workflow file -> input name -> check (true = allowed). Inputs not listed are refused. */
export const ALLOWED = {
  'analyze.yml': { required: ['ticker'], inputs: { ticker: (v) => typeof v === 'string' && TICKER.test(v), opus: optTrue } },
  'send-exit.yml': { required: [], inputs: { opus: optTrue } },
  'exit-report.yml': { required: [], inputs: {} },
  'nightly.yml': { required: [], inputs: { run_checks: (v) => v === undefined || v === 'false' }, fixed: { run_checks: 'false' } },
  'my-options.yml': { required: [], inputs: {} },
  'setup-check.yml': { required: [], inputs: {} },
};

export const MAX_BODY_BYTES = 2048;
/** The body was not JSON. */
export const BAD_JSON = Symbol('bad json');
/** JSON.parse without a throw. */
export const parseJson = (text) => Promise.resolve().then(() => JSON.parse(text)).catch(() => BAD_JSON);
const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

/**
 * The pure check of one request. Returns {status, message} to refuse, or {status: 200, workflow, inputs} to go.
 * `req`: {method, url, origin, email, contentType, bodyText, body (JSON.parse of bodyText, or BAD_JSON)}; `env`: {ALLOWED_EMAILS}.
 */
export function checkRun(req, env) {
  if (req.method !== 'POST') return { status: 405, message: 'Use POST.' };
  if (!URL.canParse(String(req.url))) return { status: 400, message: 'Bad request.' };
  const site = new URL(req.url).origin;
  if (!req.origin || req.origin !== site) return { status: 403, message: 'Not from this site.' };
  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(req.email || '').trim().toLowerCase();
  if (!email || !allowed.includes(email)) return { status: 403, message: 'Not allowed.' };
  if (!/^application\/json\b/i.test(String(req.contentType || ''))) return { status: 400, message: 'Send JSON.' };
  const text = String(req.bodyText || '');
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { status: 400, message: 'Too large.' };
  const body = req.body;
  if (body === BAD_JSON) return { status: 400, message: 'Bad JSON.' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, message: 'Bad request.' };
  const workflow = body.workflow;
  const rule = typeof workflow === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED, workflow) ? ALLOWED[workflow] : null;
  if (!rule) return { status: 400, message: 'That run is not allowed here.' };
  const given = body.inputs === undefined ? {} : body.inputs;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { status: 400, message: 'Bad inputs.' };
  const inputs = {};
  for (const [k, v] of Object.entries(given)) {
    const ok = Object.prototype.hasOwnProperty.call(rule.inputs, k) ? rule.inputs[k] : null;
    if (!ok || !ok(v)) return { status: 400, message: 'Input not allowed: ' + String(k).slice(0, 20) + '.' };
    if (v !== undefined) inputs[k] = v;
  }
  for (const k of rule.required) if (inputs[k] === undefined) return { status: 400, message: 'Missing input: ' + k + '.' };
  Object.assign(inputs, rule.fixed || {});
  return { status: 200, workflow, inputs };
}

const json = (status, ok, message) => new Response(JSON.stringify({ ok, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

/** The whole handler (tests pass a fake fetch). */
export async function handleRun(request, env, fetchImpl = fetch) {
  const bodyText = request.method === 'POST' ? await request.text() : '';
  const body = bodyText.length <= MAX_BODY_BYTES ? await parseJson(bodyText) : BAD_JSON;
  const c = checkRun({
    method: request.method, url: request.url, origin: request.headers.get('Origin'), email: request.headers.get(ACCESS_EMAIL_HEADER),
    contentType: request.headers.get('Content-Type'), bodyText, body,
  }, env || {});
  if (c.status !== 200) return json(c.status, false, c.message);
  const repo = String(env.REPO || '').trim(), token = String(env.GITHUB_TOKEN || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return json(500, false, 'The dashboard is not set up to start runs (REPO / GITHUB_TOKEN).');
  const res = await Promise.resolve().then(() => fetchImpl('https://api.github.com/repos/' + repo + '/actions/workflows/' + c.workflow + '/dispatches', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'trading-dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: c.inputs }),
    })).catch(() => null);
  if (!res) return json(502, false, 'GitHub could not be reached. Try again in a minute.');
  if (res.status === 204 || res.status === 200) return json(200, true, 'Started ' + c.workflow.replace(/\.yml$/, '') + '. It shows under Runs in a few minutes.');
  const why = res.status === 401 || res.status === 403 ? 'the token was refused (check GITHUB_TOKEN: Actions read and write on this repository)'
    : res.status === 404 ? 'the workflow or repository was not found (check REPO)' : res.status === 422 ? 'GitHub refused the inputs' : 'GitHub answered ' + res.status;
  return json(502, false, 'Not started: ' + why + '.');
}

export async function onRequest(context) {
  return handleRun(context.request, context.env);
}
