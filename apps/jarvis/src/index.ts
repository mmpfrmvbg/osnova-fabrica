// apps/jarvis/src/index.ts
// Точка входа Jarvis Core.
import * as path from 'path';
import dotenv from 'dotenv';
import { startBot } from './telegram/adapter';

// cwd при `npm start` — apps/jarvis; dotenv по умолчанию не читает корень монорепо.
// Сначала apps/jarvis/.env, затем корень репозитория (../../.. от src/).
const jarvisRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(jarvisRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const BOT_TOKEN = process.env.BOT_TOKEN;

  if (!BOT_TOKEN) {
    console.log('Jarvis ready');
    console.log('Version: 0.1.0');
    console.log('No BOT_TOKEN — running in dry mode');
    console.log('Set BOT_TOKEN env variable to enable Telegram bot');
    return;
  }

  console.log('Jarvis ready');
  console.log('Version: 0.1.0');
  console.log('Mode: Telegram bot');

  try {
    const bot = await startBot(BOT_TOKEN);
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
}

void main();
