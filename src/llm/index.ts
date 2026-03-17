// ============================================================
// src/llm/index.ts — публичный API LLM-слоя
// Перенесено из llama-fabrica/src/infrastructure/llm/index.ts
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
