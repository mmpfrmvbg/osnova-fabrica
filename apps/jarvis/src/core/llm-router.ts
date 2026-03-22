// apps/jarvis/src/core/llm-router.ts
import type { JarvisMode } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  text: string;
  tokensUsed: { prompt: number; completion: number };
  model: string;
}

const TIMEOUT_MS = 30_000;

export async function call(
  messages: ChatMessage[],
  _mode: JarvisMode = 'chat',
): Promise<LlmResponse> {
  const apiKey = process.env.LLM_API_KEY ?? '';
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
  const model = process.env.LLM_MODEL ?? 'deepseek-chat';

  if (!apiKey) {
    throw new Error(
      '[llm-router] LLM_API_KEY не задан. Задайте в apps/jarvis/.env',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });

    const json = await res.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
      error?: { message?: string };
    };

    if (!res.ok) {
      throw new Error(
        `[llm-router] HTTP ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`,
      );
    }

    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      tokensUsed: {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
      },
      model: json.model ?? model,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`[llm-router] timeout after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
