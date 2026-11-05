/**
 * FL-13d: Telegram commands (owner 2026-10-27): /exit sends the SAVED Exit Report (no re-run), /analyze TICKER
 * starts the Analyze workflow. The relay (Cloudflare) only accepts the owner's chat with the right secret.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { sheets_v4 } from 'googleapis';
import { sheetGridHtml, sheetHasText } from '../src/reports/pdf/sheetGridHtml.ts';
import { sendExitMain } from '../src/sendExit.ts';
import { telegramSetup } from '../src/telegramSetup.ts';
import { AI_PLACEHOLDER } from '../src/reports/exitSheet/text.ts';
// @ts-ignore -- plain JavaScript (pasted into Cloudflare as is)
const RELAY_TICKERS = 'AAPL,MSFT,KO,JNJ,PEP,XOM,WMT,HD,PG,MRK,COST,MCD,DIS,NKE,ORCL,CSCO,INTC';
import relay, { parseCommand, tickersOf, timedJob } from '../../relay/telegram-relay.worker.mjs';

const cell = (formattedValue: string, f: sheets_v4.Schema$CellFormat = {}): sheets_v4.Schema$CellData => ({ formattedValue, effectiveFormat: f });
const TAB: sheets_v4.Schema$Sheet = {
  properties: { title: '📤 Exit Report' },
  merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }],
  data: [{
    columnMetadata: [{ pixelSize: 200 }, { pixelSize: 100 }, { pixelSize: 100 }],
    rowData: [
      { values: [cell('📤 EXIT REPORT', { backgroundColor: { red: 0.1, green: 0.1, blue: 0.2 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } })] },
      { values: [cell('Run time: Oct 27, 2026, 1:57 PM EDT')] },
      { values: [cell('CQZB'), cell('EXIT <b>', { backgroundColor: { red: 1, green: 0.8, blue: 0.82 } })] },
      { values: [cell(AI_PLACEHOLDER)] },
    ],
  }],
};
const fakeTg = () => {
  const calls: Array<{ method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: { body: any }) => {
    calls.push({ method: url.split('/').pop() as string, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe('FL-13d — Telegram commands', () => {
  test('a saved tab keeps its merged title, colours and escapes text', () => {
    const h = sheetGridHtml(TAB)!;
    assert.match(h, /<td colspan="3" style="background:#1a1a33;color:#ffffff;font-weight:700">📤 EXIT REPORT<\/td>/);
    assert.match(h, /background:#ffccd1[^>]*>EXIT &lt;b&gt;</);
    assert.ok(sheetHasText(TAB, AI_PLACEHOLDER));
  });

  test('/exit: --ai-status says missing while the placeholder is there; the send makes a PDF and sends message + PDF', async () => {
    const out: string[] = [];
    await sendExitMain(['--ai-status'], { out: (s) => out.push(s), err: () => {}, env: {} }, { readTab: async () => TAB });
    assert.deepEqual(out, ['missing\n']);
    const { calls, fetchImpl } = fakeTg();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl13d-'));
    let html = '';
    const code = await sendExitMain(['--out', dir], { out: () => {}, err: () => {}, env: { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '42' } },
      { readTab: async () => TAB, toPdf: async (h, p) => { html = h; fs.writeFileSync(p, '%PDF'); }, fetchImpl, now: () => Date.UTC(2026, 9, 27) });
    assert.equal(code, 0);
    assert.match(html, /Report from Oct 27, 2026, 1:57 PM EDT/);
    assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
  });

  test('setup points the bot at the relay with the secret and sets the 3-command menu', async () => {
    const { calls, fetchImpl } = fakeTg();
    const lines: string[] = [];
    assert.equal(await telegramSetup(['https://relay.example.workers.dev'], { env: { TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_WEBHOOK_SECRET: 'abcdefghijklmnop1234' }, out: (l) => lines.push(l), fetchImpl }), 0);
    assert.deepEqual(calls.map((c) => c.method), ['setWebhook', 'setMyCommands']);
    assert.equal(calls[0]!.body.secret_token, 'abcdefghijklmnop1234');
    assert.deepEqual(calls[1]!.body.commands.map((c: any) => c.command), ['exit', 'analyze', 'help']);
    assert.equal(await telegramSetup(['not a url'], { env: {}, out: () => {} }), 2);
  });

  test('relay: parses commands', () => {
    assert.deepEqual(parseCommand('/exit'), { kind: 'exit' });
    assert.deepEqual(parseCommand('/analyze tsla'), { kind: 'analyze', ticker: 'TSLA' });
    assert.deepEqual(parseCommand('/analyze'), { kind: 'analyze-menu' });
    assert.deepEqual(parseCommand('/analyze !!'), { kind: 'analyze-usage' });
    assert.deepEqual(parseCommand('hello'), { kind: 'help' });
    assert.deepEqual(parseCommand('/verify'), { kind: 'verify' });
    assert.deepEqual(parseCommand('/check'), { kind: 'verify' }, '/check is an alias');
    assert.deepEqual(parseCommand('/Verify@MyBot'), { kind: 'verify' });
  });

  test('relay: wrong secret or another chat starts nothing; the owner\'s /analyze starts analyze.yml', async () => {
    const seen: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => { seen.push(url + ' ' + (init?.body ?? '')); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      const req = (secret: string, chat: number, text: string) => new Request('https://relay', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ message: { chat: { id: chat }, text } }) });
      assert.equal((await relay.fetch(req('wrong', 42, '/exit'), env)).status, 403);
      await relay.fetch(req('s3cret', 99, '/exit'), env);
      assert.equal(seen.length, 0, 'nothing for another chat');
      await relay.fetch(req('s3cret', 42, '/analyze nvda'), env);
      assert.ok(seen[0]!.includes('/actions/workflows/analyze.yml/dispatches') && seen[0]!.includes('"ticker":"NVDA"'));
      assert.ok(seen[1]!.includes('sendMessage'));
    } finally { globalThis.fetch = orig; }
  });

  test('relay: /analyze shows the stock buttons; a button starts that stock; "Other ticker" asks, and the answer starts it', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => { seen.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      const post = (update: unknown) => relay.fetch(new Request('https://relay', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: JSON.stringify(update) }), env);
      await post({ message: { chat: { id: 42 }, text: '/analyze' } });
      const kb = seen[0]!.body.reply_markup.inline_keyboard;
      assert.equal(kb.length, 6, '17 stocks in rows of 4, then Other ticker');
      assert.deepEqual(kb[0].map((b: any) => b.text), ['AAPL', 'MSFT', 'KO', 'JNJ']);
      assert.equal(kb[5][0].callback_data, 'a:?');
      seen.length = 0;
      await post({ callback_query: { id: 'q1', data: 'a:NVDA', message: { chat: { id: 42 } } } });
      assert.ok(seen[0]!.url.endsWith('answerCallbackQuery'));
      assert.ok(seen[1]!.url.includes('analyze.yml') && seen[1]!.body.inputs.ticker === 'NVDA');
      seen.length = 0;
      await post({ callback_query: { id: 'q2', data: 'a:NVDA', message: { chat: { id: 99 } } } });
      assert.equal(seen.length, 0, 'a button from another chat does nothing');
      await post({ callback_query: { id: 'q3', data: 'a:?', message: { chat: { id: 42 } } } });
      const ask = seen[1]!.body;
      assert.equal(ask.reply_markup.force_reply, true);
      seen.length = 0;
      await post({ message: { chat: { id: 42 }, text: 'coin', reply_to_message: { text: ask.text } } });
      assert.ok(seen[0]!.url.includes('analyze.yml') && seen[0]!.body.inputs.ticker === 'COIN');
      seen.length = 0;
      await post({ message: { chat: { id: 42 }, text: 'not a ticker!!', reply_to_message: { text: ask.text } } });
      assert.equal(seen.length, 1);
      assert.ok(String(seen[0]!.body.text).includes('does not look like a ticker'));
      assert.deepEqual(tickersOf({ TICKERS: 'nvda, amd' }), ['NVDA', 'AMD'], 'the button list can be changed in the relay settings');
    } finally { globalThis.fetch = orig; }
  });

  test('relay: when GitHub refuses, the message says GitHub\'s own reason', async () => {
    const sent: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      sent.push(JSON.parse(init.body)); return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      await relay.fetch(new Request('https://relay', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: JSON.stringify({ message: { chat: { id: 42 }, text: '/analyze tsla' } }) }), env);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].text.includes('GitHub said 401 (Bad credentials)') && sent[0].text.includes('wrong or expired'), sent[0].text);
    } finally { globalThis.fetch = orig; }
  });

  test('relay: the Cloudflare timer starts the nightly run; a refusal is reported in Telegram', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const orig = globalThis.fetch;
    let status = 204;
    globalThis.fetch = (async (url: string, init: any) => { seen.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return String(url).includes('api.github.com') ? new Response(status === 204 ? null : JSON.stringify({ message: 'Bad credentials' }), { status }) : new Response('{}'); }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      const run = async () => { const waits: Promise<unknown>[] = []; await relay.scheduled({ cron: '23 3 * * *', scheduledTime: Date.parse('2026-10-30T03:23:00Z') }, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) }); await Promise.all(waits); };
      await run();
      assert.equal(seen.length, 2);
      assert.ok(seen[0]!.url.endsWith('/actions/workflows/nightly.yml/dispatches') && seen[0]!.body.ref === 'main');
      assert.match(String(seen[1]!.body.text), /⏰ The nightly run was started by the relay timer \(03:23 UTC\)/);
      seen.length = 0; status = 401;
      await run();
      assert.ok(String(seen[1]!.body.text).includes('nightly run could not be started'));
      // 2026-11-01: the timer code failing before GitHub answers is reported too (before: silent).
      seen.length = 0;
      globalThis.fetch = (async (url: string, init: any) => { if (String(url).includes('api.github.com')) throw new Error('network lost'); seen.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return new Response('{}'); }) as unknown as typeof fetch;
      await run();
      assert.equal(seen.length, 1);
      assert.match(String(seen[0]!.body.text), /relay timer at 03:23 UTC failed before starting its job: network lost/);
    } finally { globalThis.fetch = orig; }
  });

  test('relay timers: chosen by the fire time; the nightly at 03:23 UTC; My Options only in the 17:00 New York hour', () => {
    assert.equal((timedJob(Date.parse('2026-10-30T03:23:00Z')) as any)?.workflow, 'nightly.yml');
    // summer (EDT): 21:05 UTC = 17:05 New York -> runs; 22:05 UTC = 18:05 -> skip
    assert.equal((timedJob(Date.parse('2026-07-15T21:05:00Z')) as any)?.workflow, 'my-options.yml');
    assert.equal(timedJob(Date.parse('2026-07-15T22:05:00Z')), 'skip');
    // winter (EST): 22:05 UTC = 17:05 -> runs; 21:05 UTC = 16:05 -> skip
    assert.equal((timedJob(Date.parse('2026-12-15T22:05:00Z')) as any)?.workflow, 'my-options.yml');
    assert.equal(timedJob(Date.parse('2026-12-15T21:05:00Z')), 'skip');
    // every day of 2026: exactly one My Options start per day
    for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const starts = [21, 22].filter((h) => typeof timedJob(Date.parse(day + 'T' + h + ':05:00Z')) === 'object' && timedJob(Date.parse(day + 'T' + h + ':05:00Z')) !== null).length;
      assert.equal(starts, 1, day);
    }
    assert.equal(timedJob(Date.parse('2026-10-30T12:00:00Z')), null, 'a timer at another time matches no job');
  });

  test('relay timers match the schedule table', async () => {
    const { NIGHTLY_CRON, MY_OPTIONS_CRON_EDT, MY_OPTIONS_CRON_EST } = await import('../src/workflows/schedule.ts');
    const at = (cron: string): number => { const [m, h] = cron.split(' ').map(Number); return Date.UTC(2026, 6, 15, h!, m!); };
    assert.equal((timedJob(at(NIGHTLY_CRON)) as any)?.workflow, 'nightly.yml');
    assert.notEqual(timedJob(at(MY_OPTIONS_CRON_EDT)), null);
    assert.notEqual(timedJob(at(MY_OPTIONS_CRON_EST)), null);
  });

  test('relay timers: a timer that matches no job sends a Telegram note', async () => {
    const seen: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => { seen.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return new Response('{}'); }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      const waits: Promise<unknown>[] = [];
      await relay.scheduled({ cron: '0 12 * * *', scheduledTime: Date.parse('2026-10-30T12:00:00Z') }, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
      assert.equal(seen.length, 1);
      assert.ok(String(seen[0].body.text).includes('matches no job'));
    } finally { globalThis.fetch = orig; }
  });

  test('relay timers: a refused My Options start names the job in Telegram', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => { seen.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return String(url).includes('api.github.com') ? new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }) : new Response('{}'); }) as unknown as typeof fetch;
    try {
      const env = { BOT_TOKEN: '1:a', ALLOWED_CHAT_ID: '42', WEBHOOK_SECRET: 's3cret', GITHUB_TOKEN: 'gh', REPO: 'someone/their-copy', TICKERS: RELAY_TICKERS };
      const waits: Promise<unknown>[] = [];
      await relay.scheduled({ cron: '5 21 * * *', scheduledTime: Date.parse('2026-07-15T21:05:00Z') }, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
      assert.ok(seen[0]!.url.endsWith('/actions/workflows/my-options.yml/dispatches'));
      assert.ok(String(seen[1]!.body.text).includes('The My Options run could not be started'));
    } finally { globalThis.fetch = orig; }
  });
});
