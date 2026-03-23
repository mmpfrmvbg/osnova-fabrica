// apps/jarvis/src/telegram/commands/index.ts
// Регистрация slash-команд. Вызывать до installJarvisMessageHandlers (message:text).

import type { Bot } from 'grammy';
import * as path from 'path';
import { getRelevantFacts } from '../../core/memory-engine';
import { getDb, migrate } from '../../db/migrations';

function getMessageCount(): number {
  try {
    migrate();
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  } catch {
    return -1;
  }
}

function getDbPath(): string {
  return process.env.JARVIS_DB_PATH
    ? path.resolve(process.env.JARVIS_DB_PATH)
    : path.resolve('jarvis.db');
}

export function registerCommands(bot: Bot): void {
  bot.command('ping', async (ctx) => {
    const count = getMessageCount();
    const dbPath = getDbPath();
    const countStr = count >= 0 ? String(count) : 'N/A';
    await ctx.reply(`Jarvis online 🟢 | DB: ${dbPath} | Messages: ${countStr}`);
  });

  bot.command('facts', async (ctx) => {
    const rawArg = ctx.message?.text?.replace('/facts', '').trim() ?? '';
    const query = rawArg.length > 0 ? rawArg : '';

    let facts;
    if (query.length > 0) {
      facts = await getRelevantFacts(query, 'unknown', 5);
    } else {
      facts = await getRelevantFacts('общее', 'unknown', 5);
    }

    if (facts.length === 0) {
      await ctx.reply('Фактов пока нет');
      return;
    }
    const lines = facts.map(
      (f, i) => `${i + 1}. [${f.kind}] ${f.text} (важность: ${f.importance})`,
    );
    await ctx.reply('📚 Последние факты:\n' + lines.join('\n'));
  });
}
