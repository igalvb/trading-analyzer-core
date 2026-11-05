/**
 * npm run ops-verify (owner request 2026-11-04): layer 2 of the run monitoring, started BY HAND from Telegram
 * (/verify or /check -> .github/workflows/verify.yml). Layer 1 is the daily watchdog (src/watchdog.ts).
 *
 * It reuses the watchdog's collector for the last VERIFY_DAYS days (default 3): the runs and their conclusions, the
 * expected Nightly / My Options runs that did not happen, slow runs, the minutes, and every run log's problem lines
 * grouped with counts; plus the last days of '🩺 Run Health' rows. Then ONE Claude Opus call (claudeReview.ts
 * sendClaudeRequest: the same model, retry policy and server-side refusal fallback as the rest, adaptive thinking by
 * default, effort high) asks for a short table: problem -> likely root cause -> severity -> concrete fix -> needs
 * the owner? The prompt is redacted (redactSecrets) and capped at PROMPT_MAX_CHARS, most severe first.
 *
 * Telegram: the watchdog table for those days, then Opus's answer (split into 4096-character parts). No Anthropic
 * key: the table and one line (VERIFY_NO_KEY). Never throws; every error of its own is a line in the message.
 * Read-only: it changes no code, no workflow and no sheet except one 'Verify' row appended to '🩺 Run Health'.
 */

import { pathToFileURL } from 'node:url';
import { sendMessage, type TelegramDeps } from './notify/telegram.ts';
import { finish } from './core/finish.ts';
import {
  GitHub, RUN_HEALTH_TAB, appendToReportsSheet, buildReport, duration, fileOf, isFailed, reportText,
  type GhFetch, type Report, type WatchdogDeps,
} from './watchdog.ts';
import {
  CLAUDE_REVIEW_MODEL, DEFAULT_CLAUDE_RETRY_POLICY, claudeKeyFromEnv, sendClaudeRequest,
  type ClaudeEffort, type ClaudeRequest, type ClaudeRetryPolicy, type ClaudeSdk, type ClaudeUsage,
} from './ai/claudeReview.ts';

export const VERIFY_DEFAULT_DAYS = 3;
export const VERIFY_MAX_DAYS = 7;
export const VERIFY_EFFORT: ClaudeEffort = 'high';
/** Thinking tokens count against it; the answer itself is a short table. */
export const VERIFY_MAX_TOKENS = 16_000;
/** The facts and log excerpts sent to Opus are capped here (most severe first, so a cut loses only the tail). */
export const PROMPT_MAX_CHARS = 60_000;
/** The collector's own limit (the workflow has 10 minutes in all). */
export const COLLECT_TIMEOUT_MS = 3 * 60_000;
/** Two attempts of 150 s at most: collector + Opus stay inside the workflow's 10 minutes. */
export const VERIFY_RETRY: ClaudeRetryPolicy = { ...DEFAULT_CLAUDE_RETRY_POLICY, maxAttemptsTransient: 2, maxAttemptsUnknown: 1, maxDelayMs: 15_000, timeoutMs: 150_000 };
export const VERIFY_NO_KEY = 'Opus diagnosis off (no Anthropic key saved)';
export const VERIFY_ROW_JOB = 'Verify (Opus)';
const MAX_HEALTH_ROWS = 200;
const MAX_RUN_LINES = 300;

const DAY = 86_400_000;
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- redaction -----------------------------------------------------------------------------

// Secret redaction lives in ops/redact.ts (shared with the watchdog, no import cycle).
export { redactSecrets } from './ops/redact.ts';
import { redactSecrets } from './ops/redact.ts';

// ---- the prompt ----------------------------------------------------------------------------

export const VERIFY_SYSTEM_PROMPT = [
  'You are the ops reviewer of a private trading-analyzer pipeline. It is a Node 24 TypeScript backend (backend/src)',
  'run only by GitHub Actions workflows (.github/workflows/*.yml): nightly.yml (the nightly analysis; started by a',
  'Cloudflare relay timer at 03:23 UTC, relay/telegram-relay.worker.mjs, with a GitHub backup timer nightly-backup.yml),',
  'my-options.yml (option values each trading day after 17:00 New York), analyze.yml / send-exit.yml / exit-report.yml',
  '(started from Telegram), ai-dispatch.yml (Gemini and Claude), watchdog.yml (the daily run check). Data comes from',
  'market-data APIs (FMP, Yahoo, SEC); results go to three Google Sheets and to Telegram.',
  '',
  'You get the facts of the last days as the run watchdog collected them: every run with its conclusion and duration,',
  'expected runs that did not happen, slow runs, the GitHub minutes, the daily Run Health rows, and the problem lines',
  'of the run logs grouped by pattern with counts (numbers and tickers blanked as # and *). Secrets are redacted.',
  '',
  'Write a SHORT diagnosis for the owner, read on a phone in Telegram:',
  '- First line: "VERDICT: " and one sentence (healthy / some issues / broken).',
  '- Then a table, one problem per line, at most 8 lines, most severe first, fields separated by " | ":',
  '  # | Problem | Likely root cause | Severity (HIGH/MEDIUM/LOW) | Concrete fix (file or area if you can infer it) | Owner needed? (yes/no + why in 3 words)',
  '- Merge lines that are the same root cause. Routine noise that needs no action: at most one LOW line for all of it.',
  '- Use ONLY the facts given. Never invent a run, file, number or error. If a cause is a guess, say "probably".',
  '- Plain text only: no Markdown, no **, no #-headings, no code blocks. Under 2,500 characters in total.',
  '- If everything is healthy, say so in the VERDICT and give no table.',
].join('\n');

const hm = (t: string | undefined): string => (t ?? '').slice(5, 16).replace('T', ' ');

/** The lines sent to Opus, most severe first, cut at `maxChars` (whole lines). */
export function verifyFacts(report: Report, healthRows: readonly (readonly unknown[])[], days: number, maxChars = PROMPT_MAX_CHARS): string {
  const lines: string[] = [];
  lines.push('WINDOW: the last ' + days + ' day(s) up to ' + new Date(report.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.');
  const missing = report.problems.filter((p) => p.level === 'missing');
  const failed = report.problems.filter((p) => p.level === 'failed');
  const slow = report.problems.filter((p) => p.level === 'warning' && / took \d+ min \(normal \d+\)$/.test(p.text));
  lines.push('', 'DID NOT RUN (' + missing.length + '):', ...(missing.length ? missing.map((p) => '- ' + p.text) : ['- none']));
  lines.push('', 'FAILED / CANCELLED / TIMED OUT RUNS (' + failed.length + '):', ...(failed.length ? failed.map((p) => '- ' + p.text + ' ' + p.link) : ['- none']));
  lines.push('', 'SLOW RUNS (' + slow.length + '):', ...(slow.length ? slow.map((p) => '- ' + p.text) : ['- none']));
  lines.push('', 'PER WORKFLOW (runs, result, billed minutes, warning / error log lines, expected):');
  for (const r of report.rows) lines.push('- ' + r.icon + ' ' + r.job + ' [' + r.file + ']: ' + r.ran + ' run(s); ' + (r.result || 'ok') + '; ' + r.minutes + ' min; ' + r.warnings + ' W / ' + r.errors + ' E' + (r.expected ? '; expected ' + r.expected : ''));
  lines.push('', 'MINUTES: ' + report.minutesLine);
  for (const n of report.notes) lines.push('NOTE: ' + n);
  const logs = report.problems.filter((p) => p.level === 'error' || (p.level === 'warning' && !slow.includes(p)));
  lines.push('', 'LOG PROBLEMS, grouped (level, count, workflow: sample line), errors first then by count:');
  for (const p of logs) lines.push('- ' + (p.level === 'error' ? 'ERROR' : 'WARN') + ' ' + p.count + '× ' + p.job + ': ' + p.text);
  if (!logs.length) lines.push('- none');
  lines.push('', 'ALL RUNS (created UTC, workflow, trigger, status/conclusion, minutes), problems first:');
  const runs = [...report.recent].sort((a, b) => Number(isFailed(b)) - Number(isFailed(a)));
  for (const r of runs.slice(0, MAX_RUN_LINES)) {
    const d = duration(r);
    lines.push('- ' + hm(r.created_at) + ' ' + fileOf(r) + ' ' + String(r.event ?? '') + ' ' + String(r.status ?? '') + '/' + String(r.conclusion ?? '-') + (d != null ? ' ' + Math.round(d / 6_000) / 10 + ' min' : '') + ' #' + r.id);
  }
  if (runs.length > MAX_RUN_LINES) lines.push('- … ' + (runs.length - MAX_RUN_LINES) + ' more');
  lines.push('', "RUN HEALTH TAB ROWS of these days (Date | Job | Expected | Ran | Result | Minutes | Warnings | Errors | Top problem | Run link):");
  for (const row of healthRows.slice(-MAX_HEALTH_ROWS)) lines.push('- ' + row.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).join(' | '));
  if (!healthRows.length) lines.push('- none (or the tab could not be read)');

  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > maxChars) { out.push('[the rest was cut to keep the request short]'); break; }
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

export function verifyRequest(facts: string, model = CLAUDE_REVIEW_MODEL): ClaudeRequest {
  return {
    model,
    max_tokens: VERIFY_MAX_TOKENS,
    system: [{ type: 'text', text: VERIFY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '<facts>\n' + facts + '\n</facts>\n\nWrite the diagnosis now: the VERDICT line, then the table.' }],
    output_config: { effort: VERIFY_EFFORT },
  };
}

// ---- the sheet -----------------------------------------------------------------------------

/** A Date cell as YYYY-MM-DD: the text as written, or a Sheets serial number. */
export function cellDay(c: unknown): string {
  if (typeof c === 'number' && Number.isFinite(c)) return new Date(Math.round((c - 25569) * DAY)).toISOString().slice(0, 10);
  const s = String(c ?? '').trim();
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

/** The default reader: every '🩺 Run Health' row (header left out) of the reports spreadsheet. */
async function readRunHealthSheet(env: Readonly<Record<string, string | undefined>>): Promise<unknown[][]> {
  const json = (env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  const id = (env.REPORTS_SPREADSHEET_ID ?? '').trim() || (env.SPREADSHEET_ID ?? '').trim();
  if (!json || !id) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / REPORTS_SPREADSHEET_ID not set');
  const { SheetsClient, createSheetsApi, parseServiceAccount } = await import('./sheets/client.ts');
  const { a1 } = await import('./sheets/tabs.ts');
  const { createContext } = await import('./core/context.ts');
  const c = new SheetsClient({ spreadsheetId: id, api: createSheetsApi(parseServiceAccount(json)) });
  const res = await c.batchGet(createContext({ mode: 'lock' }), [a1(RUN_HEALTH_TAB, 'A2:J')]);
  if (!res.ok) throw new Error('the ' + RUN_HEALTH_TAB + ' tab could not be read');
  return (res.value[0] ?? []).map((r) => [...r]);
}

// ---- the run -------------------------------------------------------------------------------

export interface VerifyDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  /** GitHub's fetch (tests: a fake GitHub). */
  readonly fetchImpl?: GhFetch;
  /** Telegram's fetch (tests: a fake). */
  readonly telegramFetch?: typeof fetch;
  /** The Claude SDK (tests: a fake); default: the real one with the env key. */
  readonly sdk?: ClaudeSdk;
  /** The '🩺 Run Health' rows (header left out); default: the reports spreadsheet. */
  readonly readHealthRows?: () => Promise<readonly (readonly unknown[])[]>;
  /** Appends the one Verify row; default: the reports spreadsheet. */
  readonly appendRows?: (rows: readonly (readonly (string | number)[])[]) => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface VerifyResult {
  /** The Telegram messages, in order (each split into 4096-character parts when sent). */
  readonly messages: readonly string[];
  readonly state: 'ok' | 'no-key' | 'opus-failed' | 'collect-failed';
  readonly usage?: ClaudeUsage;
  /** The exact user message sent to Opus (redacted), when one was sent. */
  readonly prompt?: string;
}

export function verifyDays(env: Readonly<Record<string, string | undefined>>): number {
  const n = Math.round(Number((env.VERIFY_DAYS ?? '').trim() || VERIFY_DEFAULT_DAYS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, VERIFY_MAX_DAYS) : VERIFY_DEFAULT_DAYS;
}

async function collect(d: VerifyDeps, days: number): Promise<Report> {
  const token = (d.env.GITHUB_TOKEN ?? '').trim(), repo = (d.env.GITHUB_REPOSITORY ?? '').trim();
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY not set');
  const gh = new GitHub(token, repo, d.fetchImpl);
  const wd: WatchdogDeps = { env: d.env, now: d.now, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), ...(d.log ? { log: d.log } : {}) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after ' + COLLECT_TIMEOUT_MS / 60_000 + ' min')), COLLECT_TIMEOUT_MS); });
  return Promise.race([buildReport(wd, gh, { recentH: days * 24, lookbackClosedH: days * 24 + 12 }), limit]).finally(() => clearTimeout(timer));
}

async function verifyInner(d: VerifyDeps, log: (line: string) => void): Promise<VerifyResult> {
  const days = verifyDays(d.env);
  const report = await collect(d, days).then((r) => r, (e: unknown) => msgOf(e));
  if (typeof report === 'string') {
    return { state: 'collect-failed', messages: ['🩺 Verify — ❌ the runs could not be read: ' + redactSecrets(report, d.env) + '\nNothing was checked. Open Actions → Verify for the log.'] };
  }
  const since = new Date(d.now - days * DAY).toISOString().slice(0, 10);
  const readRows = d.readHealthRows ?? (() => readRunHealthSheet(d.env));
  const health = await Promise.resolve().then(readRows).then(
    (rows) => rows.filter((r) => cellDay(r[0]) >= since),
    (e: unknown) => { report.notes.push(RUN_HEALTH_TAB + ' not read: ' + msgOf(e)); return [] as (readonly unknown[])[]; },
  );
  const table = reportText(report).replace(/^🩺 Run Health/, '🩺 Verify');

  const apiKey = claudeKeyFromEnv(d.env).trim();
  let result: VerifyResult;
  if (!apiKey) {
    log(VERIFY_NO_KEY);
    result = { state: 'no-key', messages: [table + '\n\n' + VERIFY_NO_KEY] };
  } else {
    const prompt = redactSecrets(verifyFacts(report, health, days), d.env);
    const request = verifyRequest(prompt);
    const sdk = d.sdk ?? (await import('./ai/claudeSdk.ts')).createAnthropicSdk(apiKey);
    const sent = await sendClaudeRequest(sdk, request, VERIFY_RETRY, {
      sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: Math.random, apiKey, label: 'Claude Opus (verify)',
      emit: (_lvl, m) => log(redactSecrets(m, d.env)),
    });
    if (!sent.ok) {
      log('verify: Opus ' + sent.reason + ' after ' + sent.attempts + ' attempt(s): ' + redactSecrets(sent.detail, d.env));
      result = { state: 'opus-failed', prompt: request.messages[0]?.content ?? '', messages: [table, '🧠 Opus diagnosis: not available this time (' + sent.reason + '). The table above is the watchdog\'s own check.'] };
    } else {
      const u = sent.usage;
      const answered = typeof sent.response.model === 'string' && sent.response.model ? sent.response.model : request.model;
      log('verify: Opus answered (' + sent.parsed.body.length + ' chars, model ' + answered + ', in=' + u.inputTokens + ' out=' + u.outputTokens + ')');
      const body = redactSecrets(sent.parsed.body, d.env);
      const head = '🧠 Opus diagnosis (last ' + days + ' days' + (answered.startsWith(request.model) ? '' : ', answered by ' + answered) + ')';
      result = { state: 'ok', usage: u, prompt: request.messages[0]?.content ?? '', messages: [table, head + '\n\n' + body + (sent.parsed.truncated ? '\n\n(cut off before it finished)' : '')] };
    }
  }

  const append = d.appendRows ?? ((rows) => appendToReportsSheet(d.env, rows));
  const verdict = /VERDICT:?\s*([^\n]*)/i.exec(result.messages[result.messages.length - 1] ?? '')?.[1] ?? '';
  const row: (string | number)[] = [new Date(d.now).toISOString().slice(0, 10), VERIFY_ROW_JOB, '—', '1', (result.state === 'ok' ? '✅ ' : '⚠️ ') + result.state + ' (' + days + ' days)', 0, 0, 0, (verdict || (result.state === 'no-key' ? VERIFY_NO_KEY : '')).slice(0, 300), ''];
  const note = await Promise.resolve().then(() => append([row])).then(
    () => { log('verify: 1 row appended to ' + RUN_HEALTH_TAB); return ''; },
    (e: unknown) => 'ℹ️ Sheet not updated: ' + msgOf(e),
  );
  if (note) return { ...result, messages: [...result.messages.slice(0, -1), result.messages[result.messages.length - 1] + '\n' + note] };
  return result;
}

/** The whole verification. Never throws; returns what it sent (or would have sent) to Telegram. */
export async function runVerify(d: VerifyDeps): Promise<VerifyResult> {
  const log = d.log ?? (() => {});
  const raw = await Promise.resolve().then(() => verifyInner(d, log)).then(
    (r) => r,
    (e: unknown): VerifyResult => ({ state: 'collect-failed', messages: ['🩺 Verify — ❌ the verification itself failed: ' + msgOf(e) + '\nOpen Actions → Verify for the log.'] }),
  );
  // The table quotes run-log lines, which may hold a key: every message is redacted before the log and Telegram.
  const res: VerifyResult = { ...raw, messages: raw.messages.map((m) => redactSecrets(m, d.env)) };
  for (const m of res.messages) log(m);
  const tg = (d.env.TELEGRAM_BOT_TOKEN ?? '').trim(), chat = (d.env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!tg || !chat) { log('verify: Telegram secrets missing; the result is in this log only.'); return res; }
  const deps: TelegramDeps = { token: tg, ...(d.telegramFetch ? { fetchImpl: d.telegramFetch } : {}) };
  for (const m of res.messages) {
    await sendMessage(deps, chat, m).then(
      (n) => log('verify: Telegram message sent (' + n + ' part(s)).'),
      (e: unknown) => log('verify: a Telegram message could not be sent: ' + redactSecrets(msgOf(e), d.env)),
    );
  }
  return res;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runVerify({ env: process.env, now: Date.now(), log: (l) => process.stdout.write(l + '\n') }).then(() => finish(0), () => finish(0));
}
