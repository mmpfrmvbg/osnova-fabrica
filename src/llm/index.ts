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
export type {
  LlmTier,
  LlmLevel,
  PipelinePhase,
  ReasoningEffort,
  PhaseRouting,
  PhaseRoutingOptions,
} from './routing.js';
export {
  DEFAULT_TIER,
  DEFAULT_LEVEL,
  LLM_TIERS,
  LLM_LEVELS,
  PIPELINE_PHASES,
  DEEPSEEK_TIER_MODEL,
  resolveProvider,
  resolveTier,
  resolveLevel,
  resolveModel,
  resolveEscalationModel,
  resolveThinking,
  resolveReasoningEffort,
  resolveTemperature,
  resolveMaxTokens,
  shouldEscalateToPro,
  resolvePhaseRouting,
  routingSummary,
} from './routing.js';

import type { LLMProvider } from './types.js';
import { OllamaProvider } from './OllamaProvider.js';
import { DeepSeekProvider } from './DeepSeekProvider.js';
import { QwenCliProvider } from './QwenCliProvider.js';
import { DEFAULT_PROVIDER, PROVIDER_DEFAULT_MODEL } from './defaults.js';

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
      // Legacy: Qwen CLI выведен из эксплуатации. Оставлен явным opt-in —
      // молчаливого отката на него больше нет (см. `default` ниже).
      return new QwenCliProvider();
    default:
      throw new Error(
        `Неизвестный OSNOVA_PROVIDER="${name}". Допустимые: ` +
          `${Object.keys(PROVIDER_DEFAULT_MODEL).join(', ')}`,
      );
  }
}

/**
 * Фабрика провайдера по переменной окружения OSNOVA_PROVIDER.
 * Значения: 'deepseek' (default) | 'ollama' | 'qwen-cli' (legacy)
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
