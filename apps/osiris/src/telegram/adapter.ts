// apps/osiris/src/telegram/adapter.ts
// Telegram-бот через grammy с персистентностью в SQLite.

import { Bot } from 'grammy';
import { saveMessage } from '../core/memory-engine';
import { migrate } from '../db/migrations';
import type { ProjectHint } from '../types';
import { registerCommands } from './commands';

function detectProject(_text: string): ProjectHint {
  return 'unknown';
}

/** Ограничение по владельцу только если OSIRIS_OWNER_ID задан и не 0. */
function ownerRestrictionActive(): boolean {
  const raw = process.env.OSIRIS_OWNER_ID;
  if (raw === undefined || raw.trim() === '') return false;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n === 0) return false;
  return true;
}

/**
 * Базовый инстанс: миграции + фильтр владельца.
 * Дальше: registerCommands(bot), затем installJarvisMessageHandlers(bot), затем start.
 */
export function createBot(token: string): Bot {
  const bot = new Bot(token);

  migrate();

  bot.use(async (ctx, next) => {
    console.log('[osiris:debug] update from:', ctx.from?.id, 'type:', Object.keys(ctx.update).find((k) => k !== 'update_id'));
    if (!ownerRestrictionActive()) return next();
    const ownerId = Number(process.env.OSIRIS_OWNER_ID);
    if (ctx.from?.id !== ownerId) return;
    return next();
  });

  return bot;
}

/** Эхо и ошибки — только после registerCommands, иначе /ping съест message:text. */
export function installJarvisMessageHandlers(bot: Bot): void {
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
      console.error('[osiris:bot] saveMessage failed:', err);
    }

    await ctx.reply(`[Осирис] Получено: ${text}\n[Saved: message #${savedId}]`);
  });

  bot.catch((err) => {
    console.error('[osiris:bot error]', err);
  });
}

/**
 * Long polling в фоне. Workaround: на Node.js v25 + tsx колбэк `onStart` у grammY
 * не вызывается, поэтому не ждём его — даём сети время и возвращаем `bot`.
 * При переходе на Node 20 LTS в Docker можно снова опереться на `onStart`.
 */
export async function startExistingBot(bot: Bot): Promise<Bot> {
  void bot.start().catch((err: unknown) => {
    console.error('[osiris:fatal]', err);
    process.exit(1);
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  return bot;
}

export async function startBot(token: string): Promise<Bot> {
  const bot = createBot(token);
  registerCommands(bot);
  installJarvisMessageHandlers(bot);
  return startExistingBot(bot);
}
