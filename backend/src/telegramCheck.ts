/**
 * npm run telegram-check: proves the bot can reach the owner. With TELEGRAM_CHAT_ID set it sends a test
 * message there. Without it, it finds the chat that wrote to the bot and sends the chat number to save as
 * the TELEGRAM_CHAT_ID secret. The bot key is never printed.
 * Exit: 0 sent, 1 nothing to send to or Telegram refused, 2 configuration missing.
 */

import { finish } from './core/finish.ts';
import { sendMessage, findChats, botName, TelegramError, type TelegramDeps } from './notify/telegram.ts';

export interface TelegramCheckIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

export async function telegramCheck(io: TelegramCheckIo): Promise<number> {
  const token = (io.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) { io.out('Telegram: the TELEGRAM_BOT_TOKEN secret is missing.'); return 2; }
  const deps: TelegramDeps = { token, ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) };
  const chatId = (io.env.TELEGRAM_CHAT_ID ?? '').trim();
  try {
    if (chatId) {
      await sendMessage(deps, chatId, '✅ Trading Analyzer is connected. Reports will arrive in this chat.');
      io.out('Telegram: test message sent to the saved chat.');
      return 0;
    }
    const chats = await findChats(deps);
    const chat = chats[chats.length - 1];
    if (!chat) {
      const name = await botName(deps).catch(() => '');
      io.out(`Telegram: no chat found. Open your bot${name ? ' ' + name : ''} in Telegram, press Start, send it any message, then run this again.`);
      return 1;
    }
    // P5: another user saves it under their prefix (SECRET_PREFIX u2_ -> U2_TELEGRAM_CHAT_ID); the owner: TELEGRAM_CHAT_ID.
    const secret = (io.env.SECRET_PREFIX ?? '').trim().toUpperCase() + 'TELEGRAM_CHAT_ID';
    await sendMessage(deps, chat.id, '✅ Trading Analyzer found you.\n\nLast step: in GitHub add a secret named ' + secret + ' with this number:\n\n' + chat.id);
    io.out('Telegram: chat found and a message sent. Chat number (save it as the ' + secret + ' secret): ' + chat.id);
    return 0;
  } catch (e) {
    io.out(e instanceof TelegramError ? e.message : 'Telegram: unexpected failure.');
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  telegramCheck({ env: process.env, out: (l) => process.stdout.write(l + '\n') }).then((c) => finish(c), () => finish(1));
}
