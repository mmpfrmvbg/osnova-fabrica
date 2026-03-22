// apps/jarvis/src/telegram/adapter.ts
// Заглушка Telegram-адаптера.
// Принимает grammy Update, преобразует в IncomingMessage.

import type { IncomingMessage } from '../types';

// grammy Update shape (минимальный subset без зависимости от grammy в этом файле)
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot: boolean; username?: string };
    chat: { id: number };
    text?: string;
    voice?: { file_id: string; duration: number };
    date: number;
  };
}

/**
 * Преобразует Telegram Update в IncomingMessage.
 * Возвращает null если update не содержит текстового или голосового сообщения.
 */
export function adaptUpdate(update: TelegramUpdate): IncomingMessage | null {
  const msg = update.message;
  if (!msg) return null;

  const text = msg.text ?? (msg.voice ? '[voice]' : null);
  if (text === null) return null;

  return {
    id: String(msg.message_id),
    userId: String(msg.from?.id ?? 'unknown'),
    chatId: String(msg.chat.id),
    text,
    timestamp: new Date(msg.date * 1000).toISOString(),
    isVoice: Boolean(msg.voice),
  };
}
