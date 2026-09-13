// ============================================================
// src/llm/DeepSeekProvider.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/DeepSeekProvider.ts
// Изменения: путь импорта типов → ./types
// ============================================================
import type {
  LLMProvider,
  LLMProviderStatus,
  LLMModelInfo,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from './types.js';

const DEEPSEEK_API = 'https://api.deepseek.com';
const DEEPSEEK_BETA_API = 'https://api.deepseek.com/beta';

export class DeepSeekProvider implements LLMProvider {
  readonly id = 'deepseek';
  readonly name = 'DeepSeek';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async checkHealth(): Promise<LLMProviderStatus> {
    try {
      const res = await fetch(`${DEEPSEEK_API}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.ok) return { available: true };
      return { available: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  async listModels(): Promise<readonly LLMModelInfo[]> {
    const res = await fetch(`${DEEPSEEK_API}/v1/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`DeepSeek listModels: HTTP ${res.status}`);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    return (data.data ?? []).map((m) => ({
      name: m.id,
      size: 0,
      modifiedAt: '',
    }));
  }

  private buildBody(
    request: LLMCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.prefix !== undefined && { prefix: m.prefix }),
      })),
      stream,
      max_tokens: request.maxTokens ?? 8192,
    };
    // thinking-режим у DeepSeek V4 включён по умолчанию (effort=high), поэтому
    // отправляем явный тумблер — иначе уровень Low не сможет его выключить.
    if (request.thinking !== undefined) {
      body.thinking = { type: request.thinking ? 'enabled' : 'disabled' };
    }
    if (request.reasoningEffort !== undefined) {
      body.reasoning_effort = request.reasoningEffort;
    }
    // В thinking-режиме DeepSeek игнорирует temperature — не отправляем впустую.
    if (request.temperature != null && !request.thinking) {
      body.temperature = request.temperature;
    }
    if (request.stop != null && request.stop.length > 0) body.stop = request.stop;
    if (request.responseFormat != null) body.response_format = request.responseFormat;
    return body;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const body = this.buildBody(request, false);
    const res = await fetch(`${DEEPSEEK_BETA_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`DeepSeek chat: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoningContent = choice?.message?.reasoning_content;
    const usage = data.usage;
    const finishReason = choice?.finish_reason ?? 'stop';

    return {
      content,
      model: data.model ?? request.model,
      tokensUsed:
        usage != null
          ? {
              prompt: usage.prompt_tokens ?? 0,
              completion: usage.completion_tokens ?? 0,
              total: usage.total_tokens ?? 0,
            }
          : undefined,
      done: true,
      truncated: finishReason === 'length',
      finishReason,
      cacheHitTokens: usage?.prompt_cache_hit_tokens ?? 0,
      ...(reasoningContent != null && { reasoningContent }),
    };
  }

  async completeStream(
    request: LLMCompletionRequest,
    onToken: (token: string) => void,
  ): Promise<LLMCompletionResponse> {
    const body = this.buildBody(request, true);
    const response = await fetch(`${DEEPSEEK_BETA_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`DeepSeek stream error: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('DeepSeek stream: no body');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
              finish_reason?: string;
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) { content += delta.content; onToken(delta.content); }
          // CoT-токены не отдаём в onToken — они не часть ответа, но нужны учёту.
          if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
        } catch { /* skip malformed chunk */ }
      }
    }

    return {
      content,
      model: request.model,
      done: true,
      truncated: false,
      finishReason: 'stop',
      ...(reasoningContent !== '' && { reasoningContent }),
    };
  }
}
