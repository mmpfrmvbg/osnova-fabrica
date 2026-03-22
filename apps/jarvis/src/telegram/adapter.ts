// apps/jarvis/src/telegram/adapter.ts
// Telegram-бот через grammy с персистентностью в SQLite.

import { Bot } from 'grammy';
import { saveMessage, getRelevantFacts } from '../core/memory-engine';
import { getDb, migrate } from '../db/migrations';
import * as path from 'path';
import type { ProjectHint } from '../types';

function detectProject(_text: string): ProjectHint {
  return 'unknown';
}

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

/** Ограничение по владельцу только если JARVIS_OWNER_ID задан и не 0. */
function ownerRestrictionActive(): boolean {
  const raw = process.env.JARVIS_OWNER_ID;
  if (raw === undefined || raw.trim() === '') return false;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n === 0) return false;
  return true;
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Применить миграции при старте
  migrate();

  bot.use(async (ctx, next) => {
    if (!ownerRestrictionActive()) return next();
    const ownerId = Number(process.env.JARVIS_OWNER_ID);
    if (ctx.from?.id !== ownerId) return;
    return next();
  });

  bot.command('ping', async (ctx) => {
    const count = getMessageCount();
    const dbPath = getDbPath();
    const countStr = count >= 0 ? String(count) : 'N/A';
    await ctx.reply(`Jarvis online 🟢 | DB: ${dbPath} | Messages: ${countStr}`);
  });

  bot.command('facts', async (ctx) => {
    // Без аргументов — последние 5 фактов по общему запросу
    const rawArg = ctx.message?.text?.replace('/facts', '').trim() ?? '';
    const query = rawArg.length > 0 ? rawArg : '';

    let facts;
    if (query.length > 0) {
      facts = await getRelevantFacts(query, 'unknown', 5);
    } else {
      // FTS не любит пустой MATCH — нейтральный запрос для LIKE-fallback
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
    console.error('[jarvis:bot error]', err);
  });

  return bot;
}

/**
 * Запускает long polling. В grammY `await bot.start()` не завершится, пока бот
 * не остановлен (внутри `await loop`). Ждём только `onStart`, затем возвращаем
 * `bot`; опрос идёт в фоне. Ошибки до onStart — через reject; после — лог + exit.
 */
export async function startBot(token: string): Promise<Bot> {
  const bot = createBot(token);
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const untilReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void bot
    .start({
      onStart: (info) => {
        console.log(`[jarvis] session @${info.username}`);
        if (!ready) {
          ready = true;
          resolveReady();
        }
      },
    })
    .catch((err: unknown) => {
      if (!ready) rejectReady(err);
      else {
        console.error('[jarvis:fatal]', err);
        process.exit(1);
      }
    });

  await untilReady;
  return bot;
}
