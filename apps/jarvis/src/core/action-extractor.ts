// apps/jarvis/src/core/action-extractor.ts
// Заглушка: извлекает факты и задачи из сообщения ассистента.

import type { FactDraft, TaskDraft } from '../types';

export interface ExtractedActions {
  facts: FactDraft[];
  tasks: TaskDraft[];
}

/**
 * Парсит ответ LLM и извлекает структурированные действия.
 * TODO: JSON-парсинг structured output с fallback на regex.
 */
export function extract(_message: string): ExtractedActions {
  // stub
  return { facts: [], tasks: [] };
}
