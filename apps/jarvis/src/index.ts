// apps/jarvis/src/index.ts
// Точка входа Jarvis Core.

import { createBot } from './telegram/adapter';

const BOT_TOKEN = process.env.BOT_TOKEN;

if (BOT_TOKEN) {
  console.log('Jarvis ready');
  console.log('Version: 0.1.0');
  console.log('Mode: Telegram bot');

  const bot = createBot(BOT_TOKEN);
  bot
    .start({
      onStart: (info) => {
        console.log(`[jarvis] Bot started: @${info.username}`);
      },
    })
    .catch((err: unknown) => {
      console.error('[jarvis] Fatal error:', err);
      process.exit(1);
    });
} else {
  console.log('Jarvis ready');
  console.log('Version: 0.1.0');
  console.log('No BOT_TOKEN — running in dry mode');
  console.log('Set BOT_TOKEN env variable to enable Telegram bot');
}
