// apps/jarvis/src/core/context-builder.ts
// Заглушка: формирует JarvisContext для передачи в LLM.

import type { IncomingMessage, JarvisContext, JarvisMode, ProjectHint } from '../types';

/**
 * Строит контекст для LLM из истории, фактов и системного промпта.
 * TODO: наполнить из memory-engine + summary
 */
export async function buildContext(
  _message: IncomingMessage,
  _mode: JarvisMode,
  _project: ProjectHint,
): Promise<JarvisContext> {
  // stub
  return {
    systemPrompt: 'Ты Jarvis — ассистент для проекта ОС-НОВА.',
    conversationHistory: [],
    memoryFacts: [],
    summarySnippet: undefined,
    taskSnapshot: undefined,
  };
}
