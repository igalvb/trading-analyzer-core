/** FL-13a: Telegram delivery (owner request 2026-10-27). Offline: a fake fetch plays the Bot API. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, sendDocument, findChats, splitText, TELEGRAM_TEXT_LIMIT } from '../src/notify/telegram.ts';
import { telegramCheck } from '../src/telegramCheck.ts';
import { scrubUrl } from '../src/net/http.ts';

const TOKEN = '1234567890:AAH-fake_TOKEN_value';

function fakeApi(updates: unknown[] = [], fail?: string) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: { body: any }) => {
    const method = url.split('/').pop() as string;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, body });
    if (fail === method) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
    const result = method === 'getUpdates' ? updates : method === 'getMe' ? { username: 'my_test_bot' } : { message_id: calls.length };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('FL-13a — Telegram', () => {
  test('sendMessage: plain text, long text in parts under the limit', async () => {
    const { calls, fetchImpl } = fakeApi();
    const long = Array.from({ length: 300 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(30)).join('\n');
    const n = await sendMessage({ token: TOKEN, fetchImpl }, '42', long);
    assert.equal(n, calls.length);
    assert.ok(n >= 3);
    for (const c of calls) { assert.equal(c.method, 'sendMessage'); assert.equal(c.body.chat_id, '42'); assert.ok(c.body.text.length <= TELEGRAM_TEXT_LIMIT); assert.equal(c.body.parse_mode, undefined); }
    assert.equal(calls.map((c) => c.body.text).join('\n'), long, 'nothing lost when split at line ends');
  });

  test('splitText cuts a line with no break at the limit', () => {
    const parts = splitText('y'.repeat(10_000));
    assert.deepEqual(parts.map((p) => p.length), [4096, 4096, 1808]);
  });

  test('sendDocument: multipart with the file and a caption', async () => {
    const { calls, fetchImpl } = fakeApi();
    await sendDocument({ token: TOKEN, fetchImpl }, '42', 'TSLA.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf', 'TSLA report');
    const form = calls[0]!.body as FormData;
    assert.equal(calls[0]!.method, 'sendDocument');
    assert.equal(form.get('chat_id'), '42');
    assert.equal(form.get('caption'), 'TSLA report');
    assert.equal((form.get('document') as File).name, 'TSLA.pdf');
  });

  test('findChats: private chats only, newest last, no duplicates', async () => {
    const { fetchImpl } = fakeApi([
      { message: { chat: { id: 7, type: 'private', first_name: 'A' } } },
      { message: { chat: { id: -100, type: 'group' } } },
      { message: { chat: { id: 9, type: 'private', first_name: 'B' } } },
      { message: { chat: { id: 7, type: 'private', first_name: 'A' } } },
    ]);
    assert.deepEqual(await findChats({ token: TOKEN, fetchImpl }), [{ id: '9', name: 'B' }, { id: '7', name: 'A' }]);
  });

  test('telegramCheck: finds the chat, tells the owner the number, never prints the key', async () => {
    const { calls, fetchImpl } = fakeApi([{ message: { chat: { id: 555, type: 'private', first_name: 'Alex' } } }]);
    const out: string[] = [];
    assert.equal(await telegramCheck({ env: { TELEGRAM_BOT_TOKEN: TOKEN }, out: (l) => out.push(l), fetchImpl }), 0);
    assert.match(calls[1]!.body.text, /TELEGRAM_CHAT_ID[\s\S]*555/);
    assert.match(out.join('\n'), /555/);
    assert.ok(!out.join('\n').includes(TOKEN));
  });

  test('telegramCheck: with a chat id it just sends; errors and missing config are plain, key never shown', async () => {
    const ok = fakeApi();
    assert.equal(await telegramCheck({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '555' }, out: () => {}, fetchImpl: ok.fetchImpl }), 0);
    assert.deepEqual(ok.calls.map((c) => c.method), ['sendMessage']);
    const bad = fakeApi([], 'sendMessage');
    const out: string[] = [];
    assert.equal(await telegramCheck({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '1' }, out: (l) => out.push(l), fetchImpl: bad.fetchImpl }), 1);
    assert.match(out[0]!, /chat not found/);
    assert.ok(!out.join('').includes(TOKEN));
    const none = fakeApi([]);
    const lines: string[] = [];
    assert.equal(await telegramCheck({ env: { TELEGRAM_BOT_TOKEN: TOKEN }, out: (l) => lines.push(l), fetchImpl: none.fetchImpl }), 1);
    assert.match(lines.join('\n'), /@my_test_bot/, 'names the bot so the owner can check it is the right one');
    assert.equal(await telegramCheck({ env: {}, out: () => {} }), 2);
  });

  test('scrubUrl blanks a Telegram bot key in a URL path', () => {
    assert.equal(scrubUrl('https://api.telegram.org/bot' + TOKEN + '/sendMessage'), 'https://api.telegram.org/botREDACTED/sendMessage');
  });
});
