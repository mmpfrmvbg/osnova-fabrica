// ============================================================
// src/agents/IntakeAgent.ts — Агент intake + spec_generation
// trustTier: T2 (bounded-auto)
// Input:  RawText → OsnovaIntent → OsnovaSpec
// Промпт: few-shot примеры из golden-tests
// ============================================================

import { randomUUID } from 'crypto';
import { getLLMProvider } from '../llm/index';
import type { RawText, OsnovaIntent, OsnovaSpec, AppType } from '../pipeline/types';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';

const log = logger('intake-agent');

const SPEC_SYSTEM_PROMPT = `
Ты генерируешь спецификацию для программы на языке Основа.
Язык Основа — один модуль, только процедуры, без классов и объектов.

"modules" ВСЕГДА содержит РОВНО ОДИН элемент — главный модуль.
  Вспомогательный код — процедуры внутри того же модуля, не отдельные модули.
  НЕЛЬЗЯ: [{"name": "Главный"}, {"name": "Задачи"}, {"name": "Хранилище"}]
  ПРАВИЛЬНО: [{"name": "Главный", "description": "...", "isMain": true}]
ВАЖНО: "types" всегда пустой массив []. Объектных типов в языке нет.
ВАЖНО: "mainModule" — имя главного модуля на кириллице (например: "Главный").
ВАЖНО: "syscalls" — только из списка:
  система.лог.вывести, система.хранилище.записать, система.хранилище.прочитать,
  система.хранилище.ключи, система.хранилище.удалить, система.строка.объединить,
  система.массив.длина, система.массив.получить, система.массив.добавить,
  система.массив.создать, система.массив.установить, система.массив.удалить,
  система.файлы.прочитать_все, система.файлы.записать_все, система.время.сейчас

Верни ТОЛЬКО этот JSON, без объяснений:
{
  "modules": [{"name": "Главный", "description": "описание", "isMain": true}],
  "mainModule": "Главный",
  "types": [],
  "procedures": [{"name": "главная", "params": {}, "returnType": "Логический"}],
  "syscalls": ["система.лог.вывести"],
  "conventions": {}
}
`.trim();

export class IntakeAgent {
  constructor(private registryContext: string = '') {}

  async parseIntent(input: RawText): Promise<OsnovaIntent> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('parseIntent', { model });

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          {
            role: 'user',
            content: [
              'Analyze this programming task and return ONLY a JSON object with fields: intent, confidence, language, features, params.',
              '',
              'Return ONLY this JSON, nothing else:',
              '{',
              '  "intent": "brief description",',
              '  "confidence": 0.9,',
              '  "language": "osnova",',
              '  "features": ["feature1", "feature2"],',
              '  "appType": "утилита",',
              '  "params": {}',
              '}',
              '',
              'features — list of 1-3 key capabilities the program must have.',
              'Example for "calculate sum 1 to 10": features: ["arithmetic loop","print result"]',
              '',
              `Task: "${input.text}"`,
              this.registryContext ? '\n\n' + this.registryContext : '',
            ].join('\n'),
          },
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: 2000,
      });
    } catch (err) {
      throw wrapLlmError(err, 'IntakeAgent.parseIntent', { model });
    }

    let parsed: Record<string, unknown>;
    try {
      const cleaned = this.cleanJsonResponse(response.content, 'parseIntent');
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn('parseIntent: JSON parse failed, using fallback');
      log.debug('parseIntent: raw LLM response', { raw: response?.content });
      return this.fallbackIntent(input.text);
    }

    return {
      intentId: randomUUID(),
      description: String(
        (parsed as { intent?: unknown }).intent ??
          (parsed as { description?: unknown }).description ??
          input.text,
      ),
      features:
        Array.isArray((parsed as { features?: unknown }).features) &&
        (parsed as { features: unknown[] }).features.length > 0
          ? (parsed as { features: unknown[] }).features.map(String)
          : [String((parsed as { intent?: unknown }).intent ?? input.text)],
      appType: (parsed.appType as AppType) ?? 'утилита',
      constraints: (parsed.constraints as Record<string, unknown>) ?? {},
      confidence:
        typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
    };
  }

  async generateSpec(intent: OsnovaIntent): Promise<OsnovaSpec> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('generateSpec', { model, intentId: intent.intentId });

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          {
            role: 'system',
            content: SPEC_SYSTEM_PROMPT + (this.registryContext ? '\n\n' + this.registryContext : ''),
          },
          {
            role: 'user',
            content: JSON.stringify({
              description: intent.description,
              features: intent.features,
              appType: intent.appType,
            }),
          },
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: 4000,
      });
    } catch (err) {
      throw wrapLlmError(err, 'IntakeAgent.generateSpec', { model });
    }

    let parsed: Record<string, unknown>;
    try {
      const cleaned = this.cleanJsonResponse(response.content, 'generateSpec');
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn('generateSpec: JSON parse failed, using fallback');
      log.debug('generateSpec: raw LLM response', { raw: response?.content });
      return this.fallbackSpec(intent);
    }

    const rawModules = Array.isArray(parsed.modules)
      ? (parsed.modules as Array<{ name: string; description: string; isMain?: boolean }>)
      : [];
    const modules = rawModules.length > 0
      ? [rawModules[0]!] as Array<{ name: string; description: string; isMain: boolean }>
      : [{ name: 'Главный', description: intent.description, isMain: true }];

    return {
      specId: randomUUID(),
      modules,
      mainModule: String(parsed.mainModule ?? modules[0]?.name ?? 'Главный'),
      types: Array.isArray(parsed.types) ? parsed.types : [],
      procedures: Array.isArray(parsed.procedures) ? parsed.procedures : [],
      syscalls: Array.isArray(parsed.syscalls) ? parsed.syscalls.map(String) : [],
      conventions: (parsed.conventions as Record<string, unknown>) ?? {},
    };
  }

  private fallbackIntent(text: string): OsnovaIntent {
    return {
      intentId: randomUUID(),
      description: text,
      features: [text],
      appType: 'утилита',
      constraints: {},
      confidence: 0.5,
    };
  }

  private fallbackSpec(intent: OsnovaIntent): OsnovaSpec {
    return {
      specId: randomUUID(),
      modules: [{ name: 'main', description: intent.description, isMain: true }],
      mainModule: 'main',
      types: [],
      procedures: [],
      syscalls: [],
      conventions: {},
    };
  }

  private cleanJsonResponse(raw: string, _context: 'parseIntent' | 'generateSpec'): string {
    if (!raw) return raw;
    let text = raw.trim();

    // Снять ```json ... ``` или ``` ... ``` обёртку
    if (text.startsWith('```')) {
      text = text.replace(/^```[a-zA-Z]*\s*/, '');
      const lastFence = text.lastIndexOf('```');
      if (lastFence !== -1) {
        text = text.slice(0, lastFence);
      }
      text = text.trim();
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }

    return text.trim();
  }
}
