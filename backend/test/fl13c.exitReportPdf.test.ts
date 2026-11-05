/**
 * FL-13c: the Exit Report run (src/exitReportPdf.ts): the nightly's Exit step alone, the Exit Report
 * tab drawn into a PDF, a message and the PDF to Telegram. Offline: memory Sheet, no network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exitReportPdfMain } from '../src/exitReportPdf.ts';

const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', FMP_API_KEY: 'x', ALPHAVANTAGE_KEY: 'x', FINNHUB_KEY: 'x' };
const offline = { request: async () => { throw new Error('offline'); } } as never;

describe('FL-13c — Exit Report PDF', () => {
  test('memory run: the Exit Report tab is drawn and sent with a message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl13c-'));
    const sent: string[] = [];
    const fetchImpl = (async (url: string) => { sent.push(url.split('/').pop() as string); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); }) as unknown as typeof fetch;
    let html = '';
    const code = await exitReportPdfMain(['--memory', '--out', dir], { out: () => {}, err: () => {}, env: { ...ENV, TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '42' } }, {
      toPdf: async (h, p) => { html = h; fs.writeFileSync(p, '%PDF'); }, fetchImpl, over: { transport: offline }, now: () => Date.UTC(2026, 9, 27, 14),
    });
    assert.equal(code, 0);
    assert.match(html, /Exit Strategy Report/);
    assert.match(html, /📤 Exit Report/);
    assert.ok(fs.existsSync(path.join(dir, 'v13-report-exit-20261027.pdf')));
    assert.deepEqual(sent, ['sendMessage', 'sendDocument']);
  });

  test('refuses to start when Telegram is not set up', async () => {
    assert.equal(await exitReportPdfMain([], { out: () => {}, err: () => {}, env: ENV }, { toPdf: async () => {} }), 2);
  });
});
