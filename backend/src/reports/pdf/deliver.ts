/**
 * Shared last mile for the PDF reports: print the HTML to a PDF in out/, then send a short message
 * and the PDF to Telegram (unless sending is off). Used by analyzeReport.ts and exitReportPdf.ts.
 */

import { processLine } from '../../core/logFile.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { CliIo } from '../../cli.ts';
import { findChrome, htmlToPdf } from './chromePdf.ts';
import { sendMessage, sendDocument, TelegramError, type TelegramDeps } from '../../notify/telegram.ts';

export interface DeliverDeps {
  readonly toPdf?: (html: string, pdfPath: string) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

export interface Delivery {
  readonly send: boolean;
  readonly tg: TelegramDeps;
  readonly chatId: string;
  readonly toPdf: (html: string, pdfPath: string) => Promise<void>;
}

/** Checks the set-up before any work: Telegram secrets (when sending) and a browser. Null = refused (message written). */
export function prepareDelivery(io: CliIo, send: boolean, deps: DeliverDeps, usage: string): Delivery | null {
  const env = io.env ?? process.env;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (send && (!token || !chatId)) { io.err('Telegram is not set up: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are needed (or use --no-send). ' + usage + '\n'); return null; }
  let toPdf = deps.toPdf;
  if (!toPdf) {
    const chrome = findChrome(env);
    if (!chrome) { io.err('No Chrome or Chromium found to make the PDF (set CHROME_PATH).\n'); return null; }
    toPdf = (html, p) => htmlToPdf(html, p, chrome);
  }
  return { send, tg: { token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, chatId, toPdf };
}

/** Prints and sends. Returns 0 when everything worked, 1 when the PDF or Telegram failed. */
export async function deliverPdf(io: CliIo, d: Delivery, o: { label: string; html: string; outDir: string; pdfName: string; message: string; caption: string }): Promise<number> {
  fs.mkdirSync(o.outDir, { recursive: true });
  const pdfPath = path.join(o.outDir, o.pdfName);
  try {
    await d.toPdf(o.html, pdfPath);
  } catch (e) {
    io.out(`${o.label}: the PDF could not be made: ${(e as Error).message}\n`);
    // The report this job exists for was not produced: CRITICAL in the run log (docs/LOGGING_SPEC.md).
    processLine('CRITICAL', 'deliver', o.label + ': the PDF could not be made', { detail: String((e as Error)?.message ?? e) }, io.env ?? process.env, (t) => io.err(t));
    if (d.send) await sendMessage(d.tg, d.chatId, o.message + '\n\n⚠️ The PDF could not be made this time.').catch((te: unknown) => { processLine('WARNING', 'deliver', o.label + ': Telegram did not take the no-PDF notice', { detail: String(te) }, io.env ?? process.env, (t) => io.err(t)); });
    return 1;
  }
  io.out(`${o.label}: PDF saved to ${pdfPath} (${Math.round(fs.statSync(pdfPath).size / 1024)} KB).\n`);
  processLine('INFO', 'deliver', o.label + ': PDF saved', { pdf: pdfPath, bytes: fs.statSync(pdfPath).size, send: d.send }, io.env ?? process.env, (t) => io.err(t));
  if (!d.send) return 0;
  try {
    await sendMessage(d.tg, d.chatId, o.message);
    await sendDocument(d.tg, d.chatId, o.pdfName, fs.readFileSync(pdfPath), 'application/pdf', o.caption);
    io.out(`${o.label}: sent to Telegram.\n`);
    return 0;
  } catch (e) {
    io.out(`${o.label}: Telegram refused: ${e instanceof TelegramError ? e.message : String(e)}\n`);
    processLine('ERROR', 'deliver', o.label + ': the PDF was made but Telegram refused it', { detail: String(e), pdf: pdfPath }, io.env ?? process.env, (t) => io.err(t));
    return 1;
  }
}

export const dateStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
