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

export async function handleMessage(
  message: IncomingMessage,
  _mode: JarvisMode = 'chat',
): Promise<HandleResult> {
  // 1. Загрузить историю из memory-engine
  const recent = await memory.getRecentMessages(
    message.userId ?? 'unknown',
    20,
  );

  // 2. Собрать messages[] для LLM
  const history: ChatMessage[] = recent
    .slice()
    .reverse()
    .map((r) => ({ role: r.role as ChatMessage['role'], content: r.text }));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message.text },
  ];

  // 3. Сохранить входящее сообщение
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

  // 4. Вызвать LLM
  let reply: string;
  try {
    const result = await callLlm(messages, _mode);
    reply = result.text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[jarvis:handler] LLM error:', msg);
    reply = `[ошибка LLM] ${msg}`;
  }

  // 5. Сохранить ответ
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

  return { reply, mode: _mode, trackedFacts: 0, trackedTasks: 0 };
}
