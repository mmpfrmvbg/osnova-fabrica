// src/intelligence/summarizer.ts
// Один LLM-запрос на сигнал. role='intelligence'.
// Возвращает { summary, relevance_score }.

import { getLLMProvider } from '../llm/index';
import { getDefaultModel } from '../llm/defaults';
import { resolveProvider } from '../llm/routing';
import { logLlmUsage } from '../lib/usage-logger';
import type { RawItem } from './prefilter';

// Дефолт — модель текущего провайдера (deepseek), а не имя модели Qwen.
const SUMMARIZER_MODEL =
  process.env.OSNOVA_INTELLIGENCE_MODEL ??
  process.env.OSNOVA_MODEL ??
  getDefaultModel(resolveProvider());

const SYSTEM_PROMPT = `
Ты — аналитик технологической разведки для проекта ОС-НОВА.
ОС-НОВА — русскоязычная платформа с собственным языком программирования,
компилятором, VM и LLM-пайплайном кодогенерации.

По каждому элементу выдай JSON:
{
  "summary": "<1-2 предложения на русском, суть и relevance для ОС-НОВА>",
  "relevance_score": <0.0-1.0>
}

relevance_score:
  0.9-1.0 — прямая угроза или возможность (конкурент с LLM-codegen, новый DSL)
  0.7-0.8 — смежная технология (новый компилятор, LLM-инструмент)
  0.5-0.6 — косвенный сигнал (тренды рынка, новые модели)
  0.0-0.4 — слабая связь

Отвечай ТОЛЬКО валидным JSON, без markdown, без пояснений.
`.trim();

export interface SummaryResult {
  summary: string;
  relevance_score: number;
}

export async function summarizeItem(item: RawItem): Promise<SummaryResult> {
  const provider = getLLMProvider();
  const t0 = Date.now();

  const userPrompt = `Заголовок: ${item.title}\nURL: ${item.url}\nФрагмент: ${item.snippet ?? '(нет)'}`;

  let raw: string;
  try {
    const response = await provider.complete({
      model: SUMMARIZER_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 300,
      temperature: 0.1,
    });

    logLlmUsage({
      timestamp: new Date().toISOString(),
      role: 'intelligence',
      model: SUMMARIZER_MODEL,
      tokenUsage: {
        prompt: response.tokensUsed?.prompt ?? 0,
        completion: response.tokensUsed?.completion ?? 0,
        total: response.tokensUsed?.total ?? 0,
      },
      durationMs: Date.now() - t0,
    });

    raw = response.content.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: `[summarizer error: ${msg}]`, relevance_score: 0 };
  }

  try {
    // Снять markdown-блок если LLM всё же завернул в ```json
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as { summary?: string; relevance_score?: number };
    return {
      summary: String(parsed.summary ?? ''),
      relevance_score: Number(parsed.relevance_score ?? 0),
    };
  } catch {
    return { summary: raw.slice(0, 200), relevance_score: 0.3 };
  }
}
