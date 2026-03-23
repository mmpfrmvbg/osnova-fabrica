import { call } from './llm-router';

export interface ExtractedActions {
  intent: 'build' | 'task' | 'fact' | 'chat';
  facts: string[];
  tasks: string[];
}

const FALLBACK: ExtractedActions = { intent: 'chat', facts: [], tasks: [] };

function isValidIntent(value: unknown): value is ExtractedActions['intent'] {
  return value === 'build' || value === 'task' || value === 'fact' || value === 'chat';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

function parseResponse(raw: string): ExtractedActions | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!isValidIntent(parsed.intent)) return null;
  return {
    intent: parsed.intent,
    facts: toStringArray(parsed.facts),
    tasks: toStringArray(parsed.tasks),
  };
}

export async function extractActions(text: string, context: string): Promise<ExtractedActions> {
  try {
    const response = await call([
      {
        role: 'system',
        content:
          'Ты — помощник Осириса. Анализируй сообщение и контекст. Определи intent: build|task|fact|chat. Отвечай только JSON.',
      },
      {
        role: 'user',
        content:
          `Контекст:\n${context}\n\nСообщение:\n${text}\n\n` +
          'Верни только JSON строго такого вида: {"intent":"build|task|fact|chat","facts":[],"tasks":[]}',
      },
    ]);

    const parsed = parseResponse(response.text);
    if (!parsed) {
      console.error('[osiris:action-extractor] invalid JSON schema');
      return FALLBACK;
    }
    return parsed;
  } catch (e) {
    console.error(
      '[osiris:action-extractor] failed:',
      e instanceof Error ? e.message : String(e),
    );
    return FALLBACK;
  }
}
