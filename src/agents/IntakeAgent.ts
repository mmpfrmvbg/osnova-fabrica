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

const INTENT_SYSTEM_PROMPT = `
Ты — IntakeAgent системы osnova-fabrica.
Твоя задача: проанализировать текстовый запрос пользователя и вернуть JSON с полями:
{
  "description": string,
  "features": string[],
  "appType": "утилита" | "хранилище" | "ui_приложение" | "актор" | "смешанный",
  "constraints": {},
  "confidence": number (0..1)
}
НЕ придумывай лишнего. Отвечай ТОЛЬКО JSON, без markdown.
`.trim();

const SPEC_SYSTEM_PROMPT = `
Ты — SpecArchitect системы osnova-fabrica.
На основании OsnovaIntent сгенерируй OsnovaSpec для программы на языке ОСНОВА.
Язык Основа: кириллический синтаксис, типы Целое32/Строка/Логический/?Тип/Результат,
процедуры, система.хранилище / система.окно / система.сеть.

Верни JSON:
{
  "modules": [{"name": string, "description": string, "isMain": boolean}],
  "mainModule": string,
  "types": [{"name": string, "fields": {}}],
  "procedures": [{"name": string, "params": {}, "returnType": string}],
  "syscalls": string[],
  "conventions": {}
}
Отвечай ТОЛЬКО JSON, без markdown.
`.trim();

export class IntakeAgent {
  async parseIntent(input: RawText): Promise<OsnovaIntent> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'llama3.2';
    log.debug('parseIntent', { model });

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: input.text },
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: 2000,
      });
    } catch (err) {
      throw wrapLlmError(err, 'IntakeAgent.parseIntent', { model });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      log.warn('parseIntent: JSON parse failed, using fallback');
      return this.fallbackIntent(input.text);
    }

    return {
      intentId: randomUUID(),
      description: String(parsed.description ?? input.text),
      features: Array.isArray(parsed.features) ? parsed.features.map(String) : [],
      appType: (parsed.appType as AppType) ?? 'утилита',
      constraints: (parsed.constraints as Record<string, unknown>) ?? {},
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  }

  async generateSpec(intent: OsnovaIntent): Promise<OsnovaSpec> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'llama3.2';
    log.debug('generateSpec', { model, intentId: intent.intentId });

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          { role: 'system', content: SPEC_SYSTEM_PROMPT },
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
      parsed = JSON.parse(response.content);
    } catch {
      log.warn('generateSpec: JSON parse failed, using fallback');
      return this.fallbackSpec(intent);
    }

    return {
      specId: randomUUID(),
      modules: Array.isArray(parsed.modules)
        ? (parsed.modules as Array<{ name: string; description: string; isMain: boolean }>)
        : [{ name: 'main', description: intent.description, isMain: true }],
      mainModule: String(parsed.mainModule ?? 'main'),
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
}
