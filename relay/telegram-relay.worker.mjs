/**
 * Telegram -> GitHub relay (Cloudflare Worker, free plan). Paste this whole file into a new Worker.
 * Telegram sends each message here; the relay checks it is from a known chat (the owner's, or one listed in USERS),
 * then starts a GitHub workflow, which does the work and replies in Telegram. Nothing is stored here.
 *
 * Worker settings > Variables and Secrets (all "Secret"):
 *   BOT_TOKEN       the Telegram bot key (same as the GitHub secret TELEGRAM_BOT_TOKEN)
 *   ALLOWED_CHAT_ID the owner's chat number (same as TELEGRAM_CHAT_ID)
 *   WEBHOOK_SECRET  a random text, also saved in GitHub as TELEGRAM_WEBHOOK_SECRET
 *   GITHUB_TOKEN    a GitHub fine-grained token: this repo only, "Actions: Read and write"
 *   TICKERS         REQUIRED, plain variable: the stocks on your /analyze buttons, comma-separated (e.g. AAPL,MSFT,KO)
 *   REPO            REQUIRED, plain variable: your GitHub repo "yourname/yourrepo" (no default: unset = nothing starts)
 *   USERS           optional (GENERIC_PLAN P6): more users of the same bot and repo, as JSON, chat number -> user:
 *                   {"123456789": {"user": "u2", "tickers": ["AAPL", "MSFT"], "timers": true}}
 *                   `user` = the id their GitHub secrets are named after (U2_<NAME>, docs/GENERIC_PLAN.md P5);
 *                   `tickers` = their /analyze buttons (default none: "Other ticker" only); `timers: false` = the
 *                   relay timers start nothing for them. Without USERS the relay serves the owner only, as before.
 * Runs for the owner are started exactly as before (no `user` input is sent); another user's runs get `user`.
 *
 * Timed jobs: GitHub's own schedule proved unreliable (hours late, or never), so the relay starts every timed job
 * (docs/RELAY_SCHEDULES_PLAN.md). Worker > Settings > Triggers > Cron Triggers (UTC), add all three:
 *   `23 3 * * *`  the nightly run (23:23 / 22:23 New York)
 *   `5 21 * * *`  My Options in summer (17:05 New York, EDT)
 *   `5 22 * * *`  My Options in winter (17:05 New York, EST)
 * My Options starts only when it is the 17:00 hour in New York, so exactly one of its two triggers acts each day.
 * The job is chosen by the time the timer fired; a timer at any other time sends a Telegram note. A refusal is
 * reported in Telegram. The nightly has no GitHub timer any more (it fired hours late, during market hours, and its
 * queued run could cancel a waiting /analyze); My Options keeps GitHub's timer as a harmless backup (its hour guard
 * skips late runs). Deploy this code BEFORE adding the triggers (older code started the nightly on any trigger).
 * Every timer starts the job once per user, the owner first, then USERS in their order (never one trigger per user).
 *
 * Commands: /exit, /exit opus, /analyze (a button menu of stocks + "Other ticker"), /analyze TICKER [opus], /verify
 * (alias /check: the Opus check of the last 3 days of runs, verify.yml), /help (anything else gets the help text).
 * "Other ticker" asks for the ticker; the answer to that question ("COIN" or "COIN opus") starts the run.
 * Owner 2026-11-05: Claude Opus is paid, so it runs only when asked: after a stock button, two buttons
 * "Free (Gemini)" / "+ Opus"; or the word `opus` after the command. Without it, analyze sends no `opus` input
 * (analyze.yml defaults it to false) and /exit sends none (send-exit.yml defaults it to false).
 */

/** Bumped on every change, so the live version can be checked (a GET on the relay answers with it). */
export const RELAY_VERSION = '2026-11-05.1';
/** The owner's user id (the workflows' default `user`). */
export const OWNER_USER = 'owner';
/** A user id that is also a GitHub secret prefix (same rule as backend/src/profile/runUser.ts). */
const USER_RE = /^[a-z][a-z0-9_]{0,19}$/;
const ASK_TICKER = '✏️ Type the ticker to analyse (for example COIN, or COIN opus for Claude Opus too):';
const TICKER_RE = /^[A-Z0-9.^-]{1,12}$/;
const HELP = [
  'Commands:',
  '/exit: the latest Exit Report as a PDF (stocks and options, as saved by last night, with the AI part). About 1 min, about 4 if the AI part is added first.',
  '/exit opus: the same, with a Claude Opus read of every holding first (paid, about $0.25). About 4 min.',
  '/analyze: pick a stock, then Free (Gemini) or + Opus (paid, about $0.15). Full analysis (Sheet + PDF), about 3 min.',
  '/analyze AAPL: free (Gemini). /analyze AAPL opus: with Claude Opus too.',
  '/verify (or /check): checks every run of the last 3 days and asks Claude Opus what went wrong and how to fix it. About 2 min.',
].join('\n');
/** The /verify reply and the days it checks (verify.yml `days`). */
export const VERIFY_REPLY = '🩺 Verifying the last 3 days… about 2 min.';
const VERIFY_DAYS = '3';

const cleanTickers = (list) => list.map((t) => String(t).trim().toUpperCase()).filter((t) => TICKER_RE.test(t));

export function tickersOf(env) {
  const list = cleanTickers(String(env.TICKERS || '').split(','));
  return list; // no default: TICKERS is a required setting
}

/** The GitHub repo the runs start in: REPO ("owner/name") when set and well formed, else '' (nothing starts). */
export function repoOf(env) {
  const r = String(env.REPO || '').trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? r : '';
}

/** The required settings that are missing or malformed (REPO, TICKERS), for the status page and the refusals. */
export function missingSettings(env) {
  return [repoOf(env) ? '' : 'REPO', tickersOf(env).length ? '' : 'TICKERS'].filter(Boolean);
}

/**
 * The users this relay serves, the owner first: [{ chat, user, tickers, timers }]. The owner is ALLOWED_CHAT_ID with
 * the TICKERS buttons; USERS adds the others. A USERS entry that is not valid (bad JSON, bad chat number or user id,
 * the owner's chat or id again, a second entry for one user) is left out; the owner is never affected by USERS.
 */
export function usersOf(env) {
  // The owner is always first (the timers start the owner's runs even before ALLOWED_CHAT_ID is set, as before).
  const out = [{ chat: String(env.ALLOWED_CHAT_ID || '').trim(), user: OWNER_USER, tickers: tickersOf(env), timers: true }];
  let map = {};
  try { map = typeof env.USERS === 'string' ? (env.USERS.trim() ? JSON.parse(env.USERS) : {}) : (env.USERS || {}); } catch { map = {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [chatKey, v] of Object.entries(map)) {
    const chat = String(chatKey).trim();
    const user = String((v && v.user) || '').trim().toLowerCase();
    if (!/^-?\d{1,20}$/.test(chat) || !USER_RE.test(user) || user === OWNER_USER) continue;
    if (out.some((u) => (u.chat !== '' && u.chat === chat) || u.user === user)) continue;
    const tickers = cleanTickers(Array.isArray(v.tickers) ? v.tickers : String(v.tickers || '').split(','));
    out.push({ chat, user, tickers, timers: v.timers !== false });
  }
  return out;
}

/** The user of a chat, or null (a chat the relay does not know is ignored). */
export function userOfChat(env, chatId) {
  return usersOf(env).find((u) => u.chat !== '' && u.chat === String(chatId)) || null;
}

/** The workflow inputs for a user: the owner's are sent unchanged (the workflow's default `user` is the owner). */
export function inputsFor(user, inputs) {
  return user === OWNER_USER ? inputs : { ...inputs, user };
}

/** After a stock button: free (Gemini only) or with Opus (paid). */
export function opusChoice(ticker) {
  return { inline_keyboard: [[{ text: '🆓 Free (Gemini)', callback_data: 'g:' + ticker }, { text: '💎 + Opus (~$0.15)', callback_data: 'o:' + ticker }]] };
}

/** The /analyze menu: 4 stocks a row, then "Other ticker". */
export function analyzeMenu(tickers) {
  const rows = [];
  for (let i = 0; i < tickers.length; i += 4) rows.push(tickers.slice(i, i + 4).map((t) => ({ text: t, callback_data: 'a:' + t })));
  rows.push([{ text: '✏️ Other ticker', callback_data: 'a:?' }]);
  return { inline_keyboard: rows };
}

async function tg(env, method, body) {
  await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function reply(env, chat, text, replyMarkup) {
  await tg(env, 'sendMessage', { chat_id: chat, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

async function startAnalyze(env, who, ticker, opus) {
  const err = await dispatch(env, 'analyze.yml', inputsFor(who.user, { ticker, ai: 'true', update_sheet: 'true', ...(opus ? { opus: 'true' } : {}) }));
  if (err) await refused(env, who, err); else await reply(env, who.chat, '⏳ Analysing ' + ticker + (opus ? ' with Opus' : '') + '… about 3 min.');
}

/** A typed ticker, optionally followed by the word opus: "COIN", "$coin opus". null = not a ticker. */
export function parseTickerOpus(text) {
  const m = /^\$?([A-Za-z0-9.^-]{1,12})(?:\s+(opus))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const ticker = m[1].toUpperCase();
  return TICKER_RE.test(ticker) ? { ticker, opus: !!m[2] } : null;
}

async function dispatch(env, workflow, inputs) {
  if (!repoOf(env)) return 'The relay has no REPO setting (Worker > Settings > Variables and Secrets: REPO = yourname/yourrepo).';
  const r = await fetch('https://api.github.com/repos/' + repoOf(env) + '/actions/workflows/' + workflow + '/dispatches', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + String(env.GITHUB_TOKEN || '').trim(), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'trading-relay', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (r.status === 204) return null;
  let why = '';
  try { why = (await r.json()).message || ''; } catch { /* no body */ }
  return 'GitHub said ' + r.status + (why ? ' (' + why + ')' : '') + (r.status === 401 ? '. The GitHub token in the relay is wrong or expired.' : r.status === 403 || r.status === 404 ? '. The GitHub token in the relay cannot start runs on this repo (Actions: Read and write).' : '.');
}

async function refused(env, who, err) {
  await reply(env, who.chat, '⚠️ Could not start it. ' + err);
}

/** The New York hour (0-23) at a moment. */
export function newYorkHour(ms) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
}

/**
 * Which timed job a Cloudflare timer starts, chosen by the time it fired (UTC), not by the trigger's text:
 * 03:23 the nightly; 21:05 or 22:05 My Options, only in the 17:00 New York hour. 'skip' = the other My Options
 * trigger of the day (clock-change twin); null = a timer that matches no job.
 */
export function timedJob(ms) {
  const d = new Date(ms), hm = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (hm === 3 * 60 + 23) return { name: 'nightly', workflow: 'nightly.yml', inputs: { run_checks: 'false' } };
  if (hm === 21 * 60 + 5 || hm === 22 * 60 + 5) return newYorkHour(ms) === 17 ? { name: 'My Options', workflow: 'my-options.yml', inputs: {} } : 'skip';
  return null;
}

/** The Telegram line when a timer started its job. */
export function timerLine(name, at) {
  return 'The ' + name + ' run was started by the relay timer (' + new Date(at).toISOString().slice(11, 16) + ' UTC).';
}

/** The Telegram line when the timer code itself failed (before: silent). No key values: only the error's own text. */
export function crashLine(event, e) {
  const at = event && event.scheduledTime ? event.scheduledTime : Date.now();
  const why = String((e && e.message) || e || 'unknown error').slice(0, 200);
  return '⚠️ The relay timer at ' + new Date(at).toISOString().slice(11, 16) + ' UTC failed before starting its job: ' + why;
}

export function parseCommand(text) {
  const t = String(text || '').trim();
  const m = /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/.exec(t);
  if (!m) return { kind: 'help' };
  const cmd = m[1].toLowerCase(), arg = (m[2] || '').trim().toUpperCase();
  if (cmd === 'exit') return arg === 'OPUS' ? { kind: 'exit', opus: true } : { kind: 'exit' };
  if (cmd === 'verify' || cmd === 'check') return { kind: 'verify' };
  if (cmd === 'analyze') {
    if (!arg) return { kind: 'analyze-menu' };
    const t = parseTickerOpus(arg);
    return !t ? { kind: 'analyze-usage' } : t.opus ? { kind: 'analyze', ticker: t.ticker, opus: true } : { kind: 'analyze', ticker: t.ticker };
  }
  return { kind: 'help' };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const at = event && event.scheduledTime ? event.scheduledTime : Date.now();
      const job = timedJob(at);
      if (job === 'skip') return;
      if (!job) { await reply(env, env.ALLOWED_CHAT_ID, '⚠️ A relay timer fired at ' + new Date(at).toISOString().slice(11, 16) + ' UTC (trigger "' + String(event && event.cron || '') + '") that matches no job. Check the Cron Triggers.'); return; }
      // One start per user, in order (the owner first); one user's refusal never stops the next user's start.
      for (const who of usersOf(env).filter((u) => u.timers)) {
        const err = await dispatch(env, job.workflow, inputsFor(who.user, job.inputs));
        // 2026-11-01: say it either way, so a timer that never fires (no message at all) can be told apart from one that does.
        if (err) await reply(env, who.chat, '⚠️ The ' + job.name + ' run could not be started. ' + err);
        else await reply(env, who.chat, '⏰ ' + timerLine(job.name, at));
      }
    })().catch((e) => reply(env, env.ALLOWED_CHAT_ID, crashLine(event, e)).catch(() => {})));
  },
  async fetch(request, env) {
    if (request.method !== 'POST') { const m = missingSettings(env); return new Response('ok relay ' + RELAY_VERSION + (m.length ? ' (missing settings: ' + m.join(', ') + ')' : '')); }
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    let update;
    try { update = await request.json(); } catch { return new Response('ok'); }
    // A button press on the /analyze menu.
    const cq = update && update.callback_query;
    if (cq) {
      const who = userOfChat(env, cq.message && cq.message.chat && cq.message.chat.id);
      if (!who) return new Response('ok');
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      const data = String(cq.data || '');
      if (data === 'a:?') await reply(env, who.chat, ASK_TICKER, { force_reply: true, input_field_placeholder: 'Ticker, e.g. COIN' });
      else if (data.startsWith('a:') && TICKER_RE.test(data.slice(2))) await reply(env, who.chat, '📊 ' + data.slice(2) + ': free, or with Claude Opus (paid)?', opusChoice(data.slice(2)));
      else if ((data.startsWith('g:') || data.startsWith('o:')) && TICKER_RE.test(data.slice(2))) await startAnalyze(env, who, data.slice(2), data.startsWith('o:'));
      return new Response('ok');
    }
    const msg = update && update.message;
    const who = msg ? userOfChat(env, msg.chat && msg.chat.id) : null;
    if (!who) return new Response('ok');
    // The answer to "Type the ticker".
    if (msg.reply_to_message && msg.reply_to_message.text === ASK_TICKER) {
      const t = parseTickerOpus(msg.text);
      if (t) await startAnalyze(env, who, t.ticker, t.opus);
      else await reply(env, who.chat, 'That does not look like a ticker. Tap /analyze and try again.');
      return new Response('ok');
    }
    const c = parseCommand(msg.text);
    if (c.kind === 'exit') {
      const err = await dispatch(env, 'send-exit.yml', inputsFor(who.user, c.opus ? { opus: 'true' } : {}));
      if (err) await refused(env, who, err); else await reply(env, who.chat, c.opus ? '⏳ Exit Report with Opus… about 4 min.' : '⏳ Getting the Exit Report…');
    } else if (c.kind === 'verify') {
      const err = await dispatch(env, 'verify.yml', inputsFor(who.user, { days: VERIFY_DAYS }));
      if (err) await refused(env, who, err); else await reply(env, who.chat, VERIFY_REPLY);
    } else if (c.kind === 'analyze') {
      await startAnalyze(env, who, c.ticker, c.opus === true);
    } else if (c.kind === 'analyze-menu') {
      await reply(env, who.chat, who.tickers.length ? '📊 Which stock?' : '📊 No TICKERS setting in the relay yet. Tap "Other ticker" to type one.', analyzeMenu(who.tickers));
    } else if (c.kind === 'analyze-usage') {
      await reply(env, who.chat, 'That does not look like a ticker. Tap /analyze to pick one, or type for example: /analyze AAPL');
    } else {
      await reply(env, who.chat, HELP);
    }
    return new Response('ok');
  },
};
