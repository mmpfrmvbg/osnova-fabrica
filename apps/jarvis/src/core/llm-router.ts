// apps/jarvis/src/core/llm-router.ts
import { spawnSync } from 'child_process';
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

const HTTP_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 60_000;

function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'system') return `[системный промпт]: ${m.content}`;
      if (m.role === 'assistant') return `Jarvis: ${m.content}`;
      return m.content;
    })
    .join('\n');
}

async function callQwenCli(messages: ChatMessage[]): Promise<LlmResponse> {
  const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
  const prompt = buildPrompt(messages);

  const result = spawnSync('qwen', [prompt, '-y', '--output-format', 'text'], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    // Windows: npm global `qwen` is a .cmd shim; spawn без shell даёт EINVAL
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw new Error(`[llm-router] qwen CLI error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(
      `[llm-router] qwen CLI exit ${result.status ?? 'null'}: ${stderr.slice(0, 300)}`,
    );
  }

  const text = (result.stdout ?? '').trim();
  return { text, tokensUsed: { prompt: 0, completion: 0 }, model };
}

async function callHttpApi(messages: ChatMessage[]): Promise<LlmResponse> {
  const apiKey = process.env.LLM_API_KEY ?? '';
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
  const model = process.env.LLM_MODEL ?? 'deepseek-chat';

  if (!apiKey) {
    throw new Error(
      '[llm-router] LLM_API_KEY не задан. Задайте в apps/jarvis/.env',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

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
      throw new Error(`[llm-router] timeout after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function call(
  messages: ChatMessage[],
  _mode: JarvisMode = 'chat',
): Promise<LlmResponse> {
  const provider = process.env.OSNOVA_PROVIDER ?? 'openai-compatible';
  if (provider === 'qwen-cli') {
    return callQwenCli(messages);
  }
  return callHttpApi(messages);
}
