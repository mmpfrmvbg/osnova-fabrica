// apps/jarvis/src/telegram/adapter.ts
// Telegram-бот через grammy с персистентностью в SQLite.

import { Bot } from 'grammy';
import { saveMessage, getRelevantFacts } from '../core/memory-engine';
import type { ProjectHint } from '../types';

function detectProject(_text: string): ProjectHint {
  return 'unknown';
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command('ping', async (ctx) => {
    await ctx.reply('Jarvis online 🟢');
  });

  bot.command('facts', async (ctx) => {
    const query = ctx.message?.text?.replace('/facts', '').trim() || 'проект';
    const facts = await getRelevantFacts(query, 'unknown', 3);
    if (facts.length === 0) {
      await ctx.reply('Фактов пока нет. Напишите мне что-нибудь!');
      return;
    }
    const lines = facts.map(
      (f, i) => `${i + 1}. [${f.kind}] ${f.text} (важность: ${f.importance})`,
    );
    await ctx.reply('📚 Последние факты:\n' + lines.join('\n'));
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = String(ctx.from?.id ?? 'unknown');
    const chatId = String(ctx.chat.id);
    const messageId = String(ctx.message.message_id);
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const project = detectProject(text);

    let savedId = 0;
    try {
      savedId = await saveMessage({
        userId,
        chatId,
        messageId,
        role: 'user',
        text,
        timestamp,
        tags: [],
        projectHint: project,
        sessionId: null,
        rawJson: JSON.stringify(ctx.message),
      });
    } catch (err) {
      console.error('[jarvis:bot] saveMessage failed:', err);
    }

    await ctx.reply(`[Jarvis] Получено: ${text}\n[Saved: message #${savedId}]`);
  });

  bot.catch((err) => {
    console.error('[jarvis:bot] error:', err);
  });

  return bot;
}
