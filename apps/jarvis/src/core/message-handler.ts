// apps/jarvis/src/core/message-handler.ts
import type { IncomingMessage, JarvisMode } from '../types';
import * as memory from './memory-engine';
import { call as callLlm } from './llm-router';
import type { ChatMessage } from './llm-router';

export interface HandleResult {
  reply: string;
  mode: JarvisMode;
  trackedFacts: number;
  trackedTasks: number;
}

const SYSTEM_PROMPT =
  'Ты — Jarvis, персональный AI-ассистент. Отвечай кратко и по делу. ' +
  'Помни контекст разговора.';

async function maybeSummarize(userId: string): Promise<void> {
  try {
    const count = memory.countUserMessages(userId);
    if (count === 0 || count % 50 !== 0) return;

    const dialog = memory.getMessagesForSummary(userId, 50);
    const result = await callLlm([
      {
        role: 'system',
        content:
          'Ты — помощник по суммаризации диалогов. Отвечай только текстом резюме.',
      },
      {
        role: 'user',
        content:
          `Сожми этот диалог в краткое резюме фактов о пользователе ` +
          `и ключевых темах разговора. Максимум 200 слов.\n\n${dialog}`,
      },
    ]);

    await memory.saveSummary({
      userId,
      scope: 'session',
      project: null,
      periodStart: null,
      periodEnd: null,
      text: result.text,
      generatedAt: new Date().toISOString(),
    });
    console.log(`[jarvis:memory] summary saved for userId=${userId} at msg#${count}`);
  } catch (e) {
    console.error('[jarvis:memory] summarize error:', e instanceof Error ? e.message : e);
  }
}

export async function handleMessage(
  message: IncomingMessage,
  _mode: JarvisMode = 'chat',
): Promise<HandleResult> {
  // 1. Загрузить последний summary для контекста
  const summary = await memory.getLatestSummaryByUser(message.userId);

  // 2. Загрузить последние 20 сообщений
  const recent = await memory.getRecentMessages(message.userId, 20);

  // 3. Собрать messages[] для LLM
  const history: ChatMessage[] = recent
    .slice()
    .reverse()
    .map((r) => ({ role: r.role as ChatMessage['role'], content: r.text }));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(summary
      ? [{ role: 'system' as const, content: `Контекст предыдущих разговоров: ${summary.text}` }]
      : []),
    ...history,
    { role: 'user', content: message.text },
  ];

  // 4. Сохранить входящее сообщение
  await memory.saveMessage({
    userId: message.userId,
    chatId: message.chatId ?? message.userId,
    messageId: message.id,
    role: 'user',
    text: message.text,
    timestamp: message.timestamp ?? new Date().toISOString(),
    tags: [],
    projectHint: 'chat',
    sessionId: null,
    rawJson: null,
  });

  // 5. Вызвать LLM
  let reply: string;
  try {
    const result = await callLlm(messages, _mode);
    reply = result.text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[jarvis:handler] LLM error:', msg);
    reply = `[ошибка LLM] ${msg}`;
  }

  // 6. Сохранить ответ
  await memory.saveMessage({
    userId: message.userId,
    chatId: message.chatId ?? message.userId,
    messageId: null,
    role: 'assistant',
    text: reply,
    timestamp: new Date().toISOString(),
    tags: [],
    projectHint: 'chat',
    sessionId: null,
    rawJson: null,
  });

  // 7. Суммаризация — асинхронно, не блокирует ответ
  setImmediate(() => { void maybeSummarize(message.userId); });

  return { reply, mode: _mode, trackedFacts: 0, trackedTasks: 0 };
}
