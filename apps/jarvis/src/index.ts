// apps/jarvis/src/index.ts
// Точка входа Jarvis Core.
import 'dotenv/config';
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
        console.log(`[jarvis] Jarvis bot started, polling... @${info.username}`);
      },
    })
    .catch((err: unknown) => {
      console.error('[jarvis] Fatal error:', err);
      process.exit(1);
    });

  process.on('SIGINT', () => {
    console.log('[jarvis] SIGINT received, stopping...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[jarvis] SIGTERM received, stopping...');
    bot.stop();
    process.exit(0);
  });
} else {
  console.log('Jarvis ready');
  console.log('Version: 0.1.0');
  console.log('No BOT_TOKEN — running in dry mode');
  console.log('Set BOT_TOKEN env variable to enable Telegram bot');
}
