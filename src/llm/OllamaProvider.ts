// ============================================================
// src/llm/OllamaProvider.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/OllamaProvider.ts
// Изменения: путь импорта типов → ./types
// ============================================================
import type {
  LLMProvider,
  LLMProviderStatus,
  LLMModelInfo,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from './types.js';

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async checkHealth(): Promise<LLMProviderStatus> {
    try {
      const res = await fetch(this.baseUrl);
      if (res.ok) return { available: true };
      return { available: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  async listModels(): Promise<readonly LLMModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama listModels: HTTP ${res.status}`);
    const data = (await res.json()) as {
      models: Array<{ name: string; size: number; modified_at: string }>;
    };
    return data.models.map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
    }));
  }

  private static readonly LLM_TIMEOUT_MS = 300_000;

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          ...(request.temperature != null && { temperature: request.temperature }),
          ...(request.maxTokens != null && { num_predict: request.maxTokens }),
        },
      }),
      signal: AbortSignal.timeout(OllamaProvider.LLM_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Ollama chat: HTTP ${res.status}`);

    const data = (await res.json()) as {
      message: { role: string; content: string };
      model: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      content: data.message.content,
      model: data.model,
      tokensUsed:
        data.eval_count != null
          ? {
              prompt: data.prompt_eval_count ?? 0,
              completion: data.eval_count,
              total: (data.prompt_eval_count ?? 0) + data.eval_count,
            }
          : undefined,
      done: true,
    };
  }

  async completeStream(
    request: LLMCompletionRequest,
    onToken: (token: string) => void,
  ): Promise<LLMCompletionResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          ...(request.temperature != null && { temperature: request.temperature }),
          ...(request.maxTokens != null && { num_predict: request.maxTokens }),
        },
      }),
      signal: AbortSignal.timeout(OllamaProvider.LLM_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Ollama stream: HTTP ${res.status}`);
    if (!res.body) throw new Error('No response body for streaming');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let model = request.model;
    let promptTokens = 0;
    let completionTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            message?: { content: string };
            model?: string;
            done?: boolean;
            eval_count?: number;
            prompt_eval_count?: number;
          };
          if (parsed.message?.content) {
            fullContent += parsed.message.content;
            onToken(parsed.message.content);
          }
          if (parsed.model) model = parsed.model;
          if (parsed.eval_count != null) completionTokens = parsed.eval_count;
          if (parsed.prompt_eval_count != null) promptTokens = parsed.prompt_eval_count;
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    return {
      content: fullContent,
      model,
      tokensUsed:
        completionTokens > 0
          ? {
              prompt: promptTokens,
              completion: completionTokens,
              total: promptTokens + completionTokens,
            }
          : undefined,
      done: true,
    };
  }
}
