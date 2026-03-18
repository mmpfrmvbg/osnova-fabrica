// ============================================================
// src/llm/index.ts — публичный API LLM-слоя
// ============================================================

export type {
  LLMProvider,
  LLMMessage,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelInfo,
  LLMProviderStatus,
} from './types.js';

export { OllamaProvider } from './OllamaProvider.js';
export { DeepSeekProvider } from './DeepSeekProvider.js';
export { QwenCliProvider } from './QwenCliProvider.js';
export {
  getDefaultModel,
  PROVIDER_DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from './defaults.js';

import type { LLMProvider } from './types.js';
import { OllamaProvider } from './OllamaProvider.js';
import { DeepSeekProvider } from './DeepSeekProvider.js';
import { QwenCliProvider } from './QwenCliProvider.js';
import { DEFAULT_PROVIDER } from './defaults.js';

let _provider: LLMProvider | null = null;

function createProvider(): LLMProvider {
  const name = process.env.OSNOVA_PROVIDER ?? DEFAULT_PROVIDER;
  switch (name) {
    case 'deepseek': {
      const key = process.env.DEEPSEEK_API_KEY ?? '';
      if (!key || key.trim() === '') {
        throw new Error(
          'DEEPSEEK_API_KEY не задан или пуст. Обязателен при OSNOVA_PROVIDER=deepseek',
        );
      }
      return new DeepSeekProvider(key);
    }
    case 'ollama':
      return new OllamaProvider();
    case 'qwen-cli':
    default:
      return new QwenCliProvider();
  }
}

/**
 * Фабрика провайдера по переменной окружения OSNOVA_PROVIDER.
 * Значения: 'qwen-cli' (default) | 'deepseek' | 'ollama'
 * Singleton — один экземпляр на процесс.
 */
export function getLLMProvider(): LLMProvider {
  if (!_provider) _provider = createProvider();
  return _provider;
}

/** Сброс провайдера (для тестов). */
export function resetLLMProvider(): void {
  _provider = null;
}
