/**
 * `npm run telegram-setup -- <relay URL>`: connects the bot to the Cloudflare relay (relay/telegram-relay.worker.mjs)
 * and sets its command menu. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (the same value the relay has).
 * Exit: 0 done, 1 Telegram refused, 2 usage or configuration.
 */

import { finish } from './core/finish.ts';
import { connectRelay, TelegramError, type TelegramDeps } from './notify/telegram.ts';

export async function telegramSetup(argv: readonly string[], io: { env: Readonly<Record<string, string | undefined>>; out: (l: string) => void; fetchImpl?: typeof fetch }): Promise<number> {
  const url = (argv[0] ?? '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) { io.out('Give the relay address, for example https://trading-relay.yourname.workers.dev'); return 2; }
  const token = (io.env.TELEGRAM_BOT_TOKEN ?? '').trim(), secret = (io.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) { io.out('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (16+ letters, digits, _ or -) are needed.'); return 2; }
  const deps: TelegramDeps = { token, ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) };
  try {
    await connectRelay(deps, url, secret);
    io.out('Telegram: the bot now sends your commands to the relay; the menu has /exit, /analyze (stock buttons + Other ticker) and /help.');
    return 0;
  } catch (e) {
    io.out('Telegram refused: ' + (e instanceof TelegramError ? e.message : String(e)));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  telegramSetup(process.argv.slice(2), { env: process.env, out: (l) => process.stdout.write(l + '\n') }).then(finish, () => finish(1));
}
