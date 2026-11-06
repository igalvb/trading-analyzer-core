/**
 * The Telegram policy (owner 2026-11-05; docs/TELEGRAM_POLICY.md). The ONE place that decides what reaches the chat:
 *
 *   a run with a report    its PDF(s) only; the first PDF carries a short caption, the bottom line (bottomLine:
 *                          at most 2 lines, CAPTION_MAX_CHARS). No separate text message: tables, summaries, AI
 *                          notes and the minutes line go inside the PDF or stay in the Sheet and the run log.
 *   a run without a PDF    nothing when all is fine. ONE line (alertLine) only when the owner is needed: a failure,
 *                          a run that did not happen, a live-bot alert, a watchdog ⚠️/❌ (notifyIfNeeded).
 *
 * Nothing here throws: a Telegram failure is logged and the run goes on.
 */

import { sendMessage, sendDocument, type TelegramDeps } from './telegram.ts';

/** A caption is the bottom line: about 200 characters (Telegram allows 1024). */
export const CAPTION_MAX_CHARS = 200;
/** An alert is one line. */
export const ALERT_MAX_CHARS = 300;

export interface TelegramTarget { readonly deps: TelegramDeps; readonly chatId: string }

const cut = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…');
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();

/**
 * "Nightly 5 Nov: 2 BUY · 1 EXIT, 13 HOLD · paper +1.2%". `head` and the non-empty parts on line 1, `second` (one
 * short note, e.g. a data problem) on line 2. Never more than 2 lines or CAPTION_MAX_CHARS.
 */
export function bottomLine(head: string, parts: readonly (string | null | undefined | false)[] = [], second?: string | null): string {
  const body = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map(oneLine).join(' · ');
  const first = oneLine(body ? head + ': ' + body : head);
  const two = second ? oneLine(second) : '';
  if (!two) return cut(first, CAPTION_MAX_CHARS);
  const l1 = cut(first, CAPTION_MAX_CHARS - 2 - Math.min(two.length, 60));
  return l1 + '\n' + cut(two, CAPTION_MAX_CHARS - l1.length - 1);
}

/** Any text as ONE short line (newlines folded, cut to ALERT_MAX_CHARS). */
export function alertLine(text: string): string {
  return cut(oneLine(text), ALERT_MAX_CHARS);
}

/** "Quiet unless needed": sends ONE line when `line` is set, nothing when it is null. Returns true when sent. */
export async function notifyIfNeeded(tg: TelegramTarget | null | undefined, line: string | null, log: (m: string) => void): Promise<boolean> {
  if (!line || !tg) return false;
  return sendMessage(tg.deps, tg.chatId, alertLine(line)).then(() => true, (e: unknown) => { log('Telegram: the alert line could not be sent: ' + String(e)); return false; });
}

export interface PdfDoc { readonly name: string; readonly bytes: Uint8Array }

/**
 * Sends the run's PDFs in order; the caption goes on the first one Telegram takes (the others go without one).
 * Returns the names sent. Never throws.
 */
export async function sendPdfs(tg: TelegramTarget, docs: readonly PdfDoc[], caption: string, log: (m: string) => void): Promise<string[]> {
  const sent: string[] = [];
  for (const doc of docs) {
    const cap = sent.length ? undefined : cut(caption, CAPTION_MAX_CHARS);
    const ok = await sendDocument(tg.deps, tg.chatId, doc.name, doc.bytes, 'application/pdf', cap).then(() => true, (e: unknown) => { log('Telegram: ' + doc.name + ' not sent: ' + String(e)); return false; });
    if (ok) sent.push(doc.name);
  }
  return sent;
}
