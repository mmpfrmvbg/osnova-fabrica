// apps/jarvis/src/index.ts
// Точка входа Jarvis Core.
import * as path from 'path';
import dotenv from 'dotenv';
import { startHttpServer } from './http/server';
import {
  createBot,
  installJarvisMessageHandlers,
  startExistingBot,
} from './telegram/adapter';
import { registerCommands } from './telegram/commands';

// cwd при `npm start` — apps/jarvis; dotenv по умолчанию не читает корень монорепо.
// Сначала apps/jarvis/.env, затем корень репозитория (../../.. от src/).
const jarvisRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(jarvisRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const transport = process.env.TRANSPORT ?? 'http';
  const BOT_TOKEN = process.env.BOT_TOKEN;

  if (transport === 'telegram') {
    if (!BOT_TOKEN) {
      console.log('Jarvis ready');
      console.log('Version: 0.1.0');
      console.log('No BOT_TOKEN — cannot start Telegram bot');
      console.log('Set BOT_TOKEN env variable and TRANSPORT=telegram');
      return;
    }

    console.log('Jarvis ready');
    console.log('Version: 0.1.0');
    console.log('Mode: Telegram bot');

    try {
      const bot = createBot(BOT_TOKEN);
      registerCommands(bot);
      installJarvisMessageHandlers(bot);
      await startExistingBot(bot);
      console.log('Jarvis bot started, polling...');

      process.on('SIGINT', () => {
        console.log('[jarvis] SIGINT received, stopping...');
        void bot.stop();
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        console.log('[jarvis] SIGTERM received, stopping...');
        void bot.stop();
        process.exit(0);
      });
    } catch (e) {
      console.error('[jarvis:fatal]', e);
      process.exit(1);
    }
    return;
  }

  const withTunnel = process.env.USE_TUNNEL === 'true';

  try {
    await startHttpServer({ tunnel: withTunnel });
  } catch (e) {
    console.error('[jarvis:fatal]', e);
    process.exit(1);
  }
}

void main();
