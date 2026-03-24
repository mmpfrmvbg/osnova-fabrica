// apps/osiris/src/core/llm-router.ts
import { spawnSync } from 'child_process';
import type { JarvisMode } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmResponse {
  text: string;
  tokensUsed: { prompt: number; completion: number };
  model: string;
  toolCalls?: ToolCall[];
}

const HTTP_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 60_000;

function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'system') return `[системный промпт]: ${m.content}`;
      if (m.role === 'assistant') return `Осирис: ${m.content}`;
      return m.content;
    })
    .join('\n');
}

async function callQwenCli(
  messages: ChatMessage[],
  _options?: { tools?: ToolDefinition[]; tool_choice?: 'auto' | 'none' },
): Promise<LlmResponse> {
  const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
  const prompt = buildPrompt(messages);

  // На Windows .cmd-шимы не работают через spawnSync без shell.
  // Вызываем cmd.exe /c явно — shell:false, инъекция через
  // shell-интерпретатор исключена, cmd.exe получает промпт как
  // отдельный аргумент argv (не через shell-конкатенацию).
  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin
    ? ['cmd.exe', ['/c', 'qwen', prompt, '-y', '--output-format', 'text']]
    : ['qwen', [prompt, '-y', '--output-format', 'text']];

  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
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

async function callHttpApi(
  messages: ChatMessage[],
  options?: { tools?: ToolDefinition[]; tool_choice?: 'auto' | 'none' },
): Promise<LlmResponse> {
  const apiKey = process.env.LLM_API_KEY ?? '';
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
  const model = process.env.LLM_MODEL ?? 'deepseek-chat';

  if (!apiKey) {
    throw new Error(
      '[llm-router] LLM_API_KEY не задан. Задайте в apps/osiris/.env',
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
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(options?.tools ? { tools: options.tools, tool_choice: options.tool_choice ?? 'auto' } : {}),
      }),
      signal: controller.signal,
    });

    const json = await res.json() as {
      choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
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
    const rawToolCalls = json.choices?.[0]?.message?.tool_calls as ToolCall[] | undefined;
    return {
      text,
      tokensUsed: {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
      },
      model: json.model ?? model,
      toolCalls: rawToolCalls,
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
  options?: { tools?: ToolDefinition[]; tool_choice?: 'auto' | 'none' },
): Promise<LlmResponse> {
  const provider = process.env.OSNOVA_PROVIDER ?? 'openai-compatible';
  if (provider === 'qwen-cli') {
    return callQwenCli(messages, options);
  }
  return callHttpApi(messages, options);
}
