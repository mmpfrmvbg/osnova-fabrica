// src/llm/qwen-stdout-parser.ts — I-5
// Изолированный парсер stdout Qwen CLI.
// Qwen CLI (--output-format=json) возвращает JSON-массив событий.

export type QwenOutputFormat = 'json-events' | 'plain-text';

export interface QwenParseResult {
  text: string;
  format: QwenOutputFormat;
  found: boolean;
}

export function detectQwenOutputFormat(stdout: string): QwenOutputFormat {
  return stdout.trimStart().startsWith('[') ? 'json-events' : 'plain-text';
}

export function parseQwenJsonEvents(stdout: string): QwenParseResult {
  try {
    const events = JSON.parse(stdout) as Array<{
      type?: string;
      subtype?: string;
      result?: string;
    }>;
    const resultEvent = [...events]
      .reverse()
      .find((e) => e.type === 'result' && e.subtype === 'success');
    if (resultEvent?.result) {
      return { text: resultEvent.result, format: 'json-events', found: true };
    }
    return { text: stdout, format: 'json-events', found: false };
  } catch {
    return { text: stdout, format: 'json-events', found: false };
  }
}

export function stripQwenJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Главная функция: raw stdout → чистый текст.
 * Автоматически определяет формат (json-events | plain-text).
 */
export function parseQwenStdout(stdout: string): string {
  if (!stdout) return stdout;
  const fmt = detectQwenOutputFormat(stdout);
  const text = fmt === 'json-events'
    ? parseQwenJsonEvents(stdout).text
    : stdout;
  return stripQwenJsonFence(text);
}
