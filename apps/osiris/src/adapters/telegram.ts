// apps/osiris/src/adapters/telegram.ts
import type { TelegramUpdate } from '../types';
import { handleMessage } from '../core/message-handler';

const TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const BASE = `https://api.telegram.org/bot${TOKEN}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const res = await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
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
  let offset = 0;
  while (true) {
    try {
      const updates = await pollUpdates(offset);
      for (const update of updates) {
        void handleTelegramUpdate(update);
        offset = update.update_id + 1;
      }
    } catch (e) {
      console.error('[telegram] polling error:',
        e instanceof Error ? e.message : String(e));
      await sleep(5000);
    }
  }
}
