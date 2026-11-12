// ============================================================
// src/llm/defaults.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/defaults.ts
// Единый маппинг provider → default model.
// Импортируй отсюда везде вместо хардкода.
// ============================================================

/**
 * Провайдер по умолчанию.
 *
 * Основная дорога — DeepSeek API. `qwen-cli` выведен из эксплуатации: CLI
 * больше не используется, ключи отозваны, поэтому по умолчанию он не выбирается.
 */
export const DEFAULT_PROVIDER = 'deepseek';

export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  ollama: 'llama3.2',
  // DeepSeek V4: deepseek-chat/deepseek-reasoner выводятся из эксплуатации 24.07.2026.
  deepseek: 'deepseek-flash',
  // Legacy. Оставлено, пока на `qwen-cli` ещё ссылаются apps/osiris/.env.example,
  // spec.yaml и forge: удаление сломало бы их молча, а не громко.
  'qwen-cli': 'qwen-coder-plus',
};

export function getDefaultModel(provider: string): string {
  return (
    PROVIDER_DEFAULT_MODEL[provider] ??
    PROVIDER_DEFAULT_MODEL[DEFAULT_PROVIDER]
  );
}
