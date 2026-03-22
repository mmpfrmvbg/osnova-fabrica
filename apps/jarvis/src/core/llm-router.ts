// apps/jarvis/src/core/llm-router.ts
// Заглушка: роутит запрос к нужному LLM-провайдеру по режиму.

import type { JarvisContext, JarvisMode } from '../types';

export interface LlmResponse {
  text: string;
  tokensUsed: { prompt: number; completion: number };
  model: string;
}

/**
 * Вызывает LLM с учётом режима.
 * TODO: chat → быстрая модель (Qwen), plan → медленная (DeepSeek).
 */
export async function call(
  _mode: JarvisMode,
  _context: JarvisContext,
): Promise<LlmResponse> {
  // stub
  return {
    text: '[stub] LLM ответ',
    tokensUsed: { prompt: 0, completion: 0 },
    model: 'stub',
  };
}
