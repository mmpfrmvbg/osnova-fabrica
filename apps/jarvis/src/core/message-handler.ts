// apps/jarvis/src/core/message-handler.ts
// Заглушка: принимает IncomingMessage, координирует пайплайн.

import type { IncomingMessage, JarvisMode } from '../types';

export interface HandleResult {
  reply: string;
  mode: JarvisMode;
  trackedFacts: number;
  trackedTasks: number;
}

/**
 * Обрабатывает входящее сообщение.
 * TODO: подключить memory-engine, context-builder, llm-router, action-extractor.
 */
export async function handleMessage(
  message: IncomingMessage,
  _mode: JarvisMode = 'chat',
): Promise<HandleResult> {
  // Заглушка — возвращает эхо
  return {
    reply: `[stub] echo: ${message.text}`,
    mode: 'chat',
    trackedFacts: 0,
    trackedTasks: 0,
  };
}
