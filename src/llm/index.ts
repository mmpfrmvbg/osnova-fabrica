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
export { getDefaultModel, PROVIDER_DEFAULT_MODEL } from './defaults.js';

import type { LLMProvider } from './types.js';
import { OllamaProvider } from './OllamaProvider.js';
import { DeepSeekProvider } from './DeepSeekProvider.js';
import { QwenCliProvider } from './QwenCliProvider.js';

/**
 * Фабрика провайдера по переменной окружения OSNOVA_PROVIDER.
 * Значения: 'qwen-cli' (default) | 'deepseek' | 'ollama'
 */
export function getLLMProvider(): LLMProvider {
  const name = process.env.OSNOVA_PROVIDER ?? 'qwen-cli';
  switch (name) {
    case 'deepseek': return new DeepSeekProvider(process.env.DEEPSEEK_API_KEY ?? '');
    case 'ollama':   return new OllamaProvider();
    case 'qwen-cli':
    default:         return new QwenCliProvider();
  }
}
