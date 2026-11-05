/**
 * Telegram delivery (owner request 2026-10-27: reports to the phone instead of the Sheet).
 * Bot API over HTTPS. The bot key travels in the URL path (/bot<key>/method), so it is never logged:
 * errors carry the method name and Telegram's own description only, and net/http.ts scrubUrl also
 * blanks a /bot<key>/ path in case such a URL is ever logged elsewhere.
 */

export const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram's limit for one text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramDeps {
  readonly token: string;
  /** Tests inject a fake; default: the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class TelegramError extends Error {
  constructor(method: string, description: string) {
    super('Telegram ' + method + ' failed: ' + description);
    this.name = 'TelegramError';
  }
}

async function call(deps: TelegramDeps, method: string, body: Record<string, unknown> | FormData): Promise<any> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res: Response;
  try {
    res = await f(TELEGRAM_API + '/bot' + deps.token + '/' + method, {
      method: 'POST',
      ...(isForm ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new TelegramError(method, 'no response');
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !json || json.ok !== true) throw new TelegramError(method, String(json?.description ?? 'HTTP ' + res.status).replace(deps.token, 'REDACTED'));
  return json.result;
}

/** Splits text into Telegram-sized parts, breaking at a line end when possible. */
export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

/** Plain text (no Markdown parsing, so report text can never break the message). Long text is sent in parts. */
export async function sendMessage(deps: TelegramDeps, chatId: string, text: string): Promise<number> {
  const parts = splitText(text);
  for (const p of parts) await call(deps, 'sendMessage', { chat_id: chatId, text: p, disable_web_page_preview: true });
  return parts.length;
}

/** The five characters Telegram's HTML mode needs escaped. */
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A bold title line and a fixed-width table (Telegram HTML mode, <pre>), so the columns line up on the phone.
 * Every text is escaped here: report words can never break the markup.
 */
export async function sendTable(deps: TelegramDeps, chatId: string, title: string, table: string): Promise<number> {
  const limit = TELEGRAM_TEXT_LIMIT - 200;
  const parts = splitText(table, limit);
  for (let i = 0; i < parts.length; i++) {
    const head = i === 0 && title ? '<b>' + escapeHtml(title) + '</b>\n' : '';
    await call(deps, 'sendMessage', { chat_id: chatId, text: head + '<pre>' + escapeHtml(parts[i] as string) + '</pre>', parse_mode: 'HTML', disable_web_page_preview: true });
  }
  return parts.length;
}

export async function sendDocument(deps: TelegramDeps, chatId: string, fileName: string, bytes: Uint8Array, mime: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([bytes], { type: mime }), fileName);
  await call(deps, 'sendDocument', form);
}

/** The bot's own @name (getMe). */
export async function botName(deps: TelegramDeps): Promise<string> {
  const me = (await call(deps, 'getMe', {})) as { username?: string };
  return me?.username ? '@' + me.username : '';
}

export interface TelegramChat { readonly id: string; readonly name: string }

/** The private chats that wrote to the bot recently (getUpdates keeps about 24 hours). Newest last. */
export async function findChats(deps: TelegramDeps): Promise<TelegramChat[]> {
  const updates = (await call(deps, 'getUpdates', {})) as Array<{ message?: { chat?: { id?: number; type?: string; first_name?: string; username?: string } } }>;
  const out: TelegramChat[] = [];
  for (const u of updates ?? []) {
    const c = u.message?.chat;
    if (!c || c.type !== 'private' || typeof c.id !== 'number') continue;
    const id = String(c.id);
    const i = out.findIndex((x) => x.id === id);
    if (i >= 0) out.splice(i, 1);
    out.push({ id, name: c.first_name ?? c.username ?? '' });
  }
  return out;
}

/** The bot's command menu (the "/" button in Telegram). */
export const BOT_COMMANDS: ReadonlyArray<{ readonly command: string; readonly description: string }> = [
  { command: 'exit', description: 'Latest Exit Report as a PDF (saved, with AI)' },
  { command: 'analyze', description: 'Full analysis: pick a stock or type one' },
  { command: 'help', description: 'What the bot can do' },
];

/** Points the bot at the relay (Telegram calls `url` with `secret` in the X-Telegram-Bot-Api-Secret-Token header) and sets the menu. */
export async function connectRelay(deps: TelegramDeps, url: string, secret: string): Promise<void> {
  await call(deps, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  await call(deps, 'setMyCommands', { commands: BOT_COMMANDS });
}
