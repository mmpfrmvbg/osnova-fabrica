// ============================================================
// src/llm/defaults.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/defaults.ts
// Единый маппинг provider → default model.
// Импортируй отсюда везде вместо хардкода.
// ============================================================

export const DEFAULT_PROVIDER = 'qwen-cli';

export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  ollama: 'llama3.2',
  deepseek: 'deepseek-chat',
  'qwen-cli': 'qwen-coder-plus',
};

export function getDefaultModel(provider: string): string {
  return (
    PROVIDER_DEFAULT_MODEL[provider] ??
    PROVIDER_DEFAULT_MODEL[DEFAULT_PROVIDER]
  );
}
