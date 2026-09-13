// ============================================================
// src/llm/types.ts — LLM domain interfaces
// Перенесено из llama-fabrica/src/domain/llm/types.ts
// Зависимости: нет (только примитивные типы)
// ============================================================

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly prefix?: boolean;
}

export interface LLMCompletionRequest {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly responseFormat?: { type: 'text' | 'json_object' };
  /**
   * thinking-режим DeepSeek V4. У API он включён по умолчанию (effort=high),
   * поэтому для уровня Low его нужно выключать явно (`false`).
   * Провайдеры без thinking-режима параметр игнорируют.
   */
  readonly thinking?: boolean;
  /** Уровень рассуждений DeepSeek V4 (`reasoning_effort`). */
  readonly reasoningEffort?: 'low' | 'high' | 'max';
}

export interface LLMCompletionResponse {
  readonly content: string;
  readonly model: string;
  readonly tokensUsed?: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
  readonly done: boolean;
  readonly truncated?: boolean;
  readonly finishReason?: string;
  readonly cacheHitTokens?: number;
  /**
   * Цепочка рассуждений reasoning-модели (`reasoning_content`).
   * Приходит отдельно от `content`; для многоходовых диалогов без `tools`
   * обратно в API её передавать не нужно.
   */
  readonly reasoningContent?: string;
}

export interface LLMModelInfo {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface LLMProviderStatus {
  readonly available: boolean;
  readonly error?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  checkHealth(): Promise<LLMProviderStatus>;
  listModels(): Promise<readonly LLMModelInfo[]>;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
  completeStream(
    request: LLMCompletionRequest,
    onToken: (token: string) => void,
  ): Promise<LLMCompletionResponse>;
}
