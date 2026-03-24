// apps/osiris/src/adapters/telegram.ts
import type { TelegramUpdate } from '../types';
import { handleMessage } from '../core/message-handler';
import { getCoreMemory, updateCoreMemory } from '../core/memory-engine';

const TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const BASE = `https://api.telegram.org/bot${TOKEN}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+=|{}.!\-])/g, '\\$1');
}

async function pollUpdates(offset: number): Promise<TelegramUpdate[]> {
  const url = `${BASE}/getUpdates?offset=${offset}&timeout=30`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status}`);
  const data = await res.json() as { result: TelegramUpdate[] };
  return data.result ?? [];
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  try {
    const escaped = escapeMarkdown(text);
    const res = await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: escaped, parse_mode: 'MarkdownV2' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] sendMessage failed ${res.status}: ${body}`);
    }
  } catch (e) {
    console.error('[telegram] sendMessage error:', e instanceof Error ? e.message : String(e));
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (!update.message?.text) return;
  const userId = `tg-${update.message.from.id}`;
  const chatId = update.message.chat.id;
  const text = update.message.text;

  // Обработка /start
  if (text === '/start') {
    await sendMessage(
      chatId,
      'Привет! Я Осирис — твой персональный помощник. Просто напиши что тебя интересует.',
    );
    return;
  }

  try {
    const result = await handleMessage(
      {
        id: String(update.update_id),
        userId,
        chatId: String(chatId),
        text,
        timestamp: new Date().toISOString(),
        isVoice: false,
      },
      'chat',
    );
    await sendMessage(chatId, result.reply);
  } catch (e) {
    console.error('[telegram] handleTelegramUpdate error:',
      e instanceof Error ? e.message : String(e));
    await sendMessage(chatId, 'Произошла ошибка. Попробуй ещё раз.');
  }
}

export async function startTelegramAdapter(): Promise<void> {
  if (!TOKEN) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set, skipping');
    return;
  }
  console.log('[telegram] adapter started');

  // Восстановить offset из core_memory
  let offset = 0;
  try {
    const core = await getCoreMemory('tg-system');
    const meta = core.meta as unknown as Record<string, unknown>;
    const saved = meta['telegram_offset'];
    if (typeof saved === 'number' && saved > 0) {
      offset = saved;
      console.log(`[telegram] restored offset=${offset}`);
    }
  } catch {
    // не критично — стартуем с 0
  }

  while (true) {
    try {
      const updates = await pollUpdates(offset);
      for (const update of updates) {
        void handleTelegramUpdate(update);
        offset = update.update_id + 1;
      }
      // Персистировать offset если были апдейты
      if (updates.length > 0) {
        try {
          await updateCoreMemory('tg-system', {
            meta: { telegram_offset: offset } as unknown as Parameters<typeof updateCoreMemory>[1]['meta'],
          });
        } catch (e) {
          console.error('[telegram] failed to persist offset:',
            e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e) {
      console.error('[telegram] polling error:',
        e instanceof Error ? e.message : String(e));
      await sleep(5000);
    }
  }
}
