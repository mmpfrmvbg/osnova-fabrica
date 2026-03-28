// ============================================================
// src/agents/IntakeAgent.ts — Агент intake + spec_generation
// trustTier: T2 (bounded-auto)
// Input:  RawText → OsnovaIntent → OsnovaSpec
// Промпт: few-shot примеры из golden-tests
// ============================================================

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { getLLMProvider } from '../llm/index';
import { IntakeValidationError, type IAgent } from './types';
import type { RawText, OsnovaIntent, OsnovaSpec, AppType } from '../pipeline/types';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';
import { logLlmUsage } from '../lib/usage-logger';
import { LANGUAGE_REGISTRY } from '../compiler/language-registry';

const log = logger('intake-agent');

/** Таблица префиксов → appType. Проверяется детерминированно, до LLM-вызова. */
const PREFIX_APP_TYPE_MAP: Array<[RegExp, AppType]> = [
  [/^алгоритм\s*:/i, 'алгоритм'],
  [/^тест\s*:/i, 'тест'],
  [/^модуль\s*типов\s*:/i, 'модуль_типов'],
  [/^модуль\s*:/i, 'модуль'],
  [/^библиотека\s*:/i, 'библиотека'],
];

/** Возвращает appType из префикса или null если нет. */
export function detectAppTypeFromPrefix(text: string): AppType | null {
  const trimmed = text.trim();
  for (const [re, appType] of PREFIX_APP_TYPE_MAP) {
    if (re.test(trimmed)) return appType;
  }
  return null;
}

/** Confidence из JSON LLM: число или числовая строка; иначе 0.8 (как раньше для не-чисел). */
export function parseLlmConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0.8;
}

type LlmIntentJson = {
  intent?: unknown;
  description?: unknown;
  features?: unknown;
  /** Некоторые модели возвращают roles вместо features — учитываем для G1 (features не пустой). */
  roles?: unknown;
  appType?: unknown;
  constraints?: unknown;
  confidence?: unknown;
};

function featuresFromLlmParsed(parsed: LlmIntentJson, fallbackText: string): string[] {
  const rawFeatures = parsed.features;
  const rawRoles = parsed.roles;
  if (Array.isArray(rawFeatures) && rawFeatures.length > 0) {
    return rawFeatures.map(String);
  }
  if (Array.isArray(rawRoles) && rawRoles.length > 0) {
    return rawRoles.map(String);
  }
  return [String(parsed.intent ?? fallbackText)];
}

function loadAbPromptOverride(): string | null {
  const promptFile = process.env.OSNOVA_AB_PROMPT_FILE;
  if (!promptFile) return null;
  try {
    return fs.readFileSync(promptFile, 'utf-8').trim();
  } catch {
    process.stderr.write(
      `[ab-prompt] не удалось прочитать ${promptFile} — используется встроенный промпт\n`,
    );
    return null;
  }
}

function buildSpecSystemPrompt(): string {
  const stableSyscalls = LANGUAGE_REGISTRY.syscalls
    .filter(s => s.status === 'stable')
    .map(s => `  ${s.name}`)
    .join(',\n');

  return `
Ты генерируешь спецификацию для программы на языке Основа.
Язык Основа — один модуль, только процедуры, без классов и объектов.

"modules" ВСЕГДА содержит РОВНО ОДИН элемент — главный модуль.
  Вспомогательный код — процедуры внутри того же модуля, не отдельные модули.
  НЕЛЬЗЯ: [{"name": "Главный"}, {"name": "Задачи"}, {"name": "Хранилище"}]
  ПРАВИЛЬНО: [{"name": "Главный", "description": "...", "isMain": true}]
ВАЖНО: "types" всегда пустой массив []. Объектных типов в языке нет.
ВАЖНО: "mainModule" — имя главного модуля на кириллице (например: "Главный").
ВАЖНО: "syscalls" — только из этого списка (stable syscalls):
${stableSyscalls}

ПРИМЕРЫ (задача → правильный JSON):

Пример 1 — счётчик:
Вход: {"description":"считать от 1 до 10 и вывести сумму","features":["arithmetic loop","print result"],"appType":"утилита"}
Выход:
{"modules":[{"name":"Счётчик","description":"Суммирует числа от 1 до 10","isMain":true}],"mainModule":"Счётчик","types":[],"procedures":[{"name":"главная","params":{},"returnType":"Целое32"}],"syscalls":["система.лог.вывести"],"conventions":{}}

Пример 2 — хранилище задач:
Вход: {"description":"сохранить список задач в хранилище и вывести их","features":["storage write","storage read","list output"],"appType":"утилита"}
Выход:
{"modules":[{"name":"Задачи","description":"Сохраняет и читает задачи из хранилища","isMain":true}],"mainModule":"Задачи","types":[],"procedures":[{"name":"главная","params":{},"returnType":"Логический"},{"name":"сохранитьЗадачу","params":{"ключ":"Строка","название":"Строка"},"returnType":"пусто"}],"syscalls":["система.хранилище.записать","система.хранилище.прочитать","система.лог.вывести"],"conventions":{}}

Пример 3 — обработка ошибок:
Вход: {"description":"прочитать файл и обработать ошибку если файл не найден","features":["file read","error handling"],"appType":"утилита"}
Выход:
{"modules":[{"name":"ЧтениеФайла","description":"Читает файл с обработкой ошибки","isMain":true}],"mainModule":"ЧтениеФайла","types":[],"procedures":[{"name":"главная","params":{},"returnType":"Целое32"}],"syscalls":["система.файлы.прочитать_все","система.файлы.существует","система.лог.вывести"],"conventions":{}}

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
}

export class SpecValidationError extends Error {
  constructor(
    public readonly missing: string[],
    public readonly specId: string,
  ) {
    super(
      `[T-7:checkSpec] Spec неполный (specId=${specId}). ` +
      `Отсутствует: ${missing.join(', ')}. ` +
      'Codegen без полной spec запрещён.',
    );
    this.name = 'SpecValidationError';
  }
}

export class IntakeAgent implements IAgent {
  constructor(private registryContext: string = '') {}

  private validateRawText(input: RawText): void {
    if (input == null || typeof input.text !== 'string') {
      throw new IntakeValidationError('RawText.text must be a string', 'text');
    }
    if (input.text.trim() === '') {
      throw new IntakeValidationError('Task text is empty', 'text');
    }
  }

  private validateIntentForSpec(intent: OsnovaIntent): void {
    if (!intent.intentId?.trim()) {
      throw new IntakeValidationError('intent.intentId is required', 'intentId');
    }
    if (!intent.description?.trim()) {
      throw new IntakeValidationError('intent.description is required', 'description');
    }
    if (!Array.isArray(intent.features)) {
      throw new IntakeValidationError('intent.features must be an array', 'features');
    }
  }

  async parseIntent(input: RawText): Promise<OsnovaIntent> {
    try {
      this.validateRawText(input);
    } catch (err) {
      log.warn('parseIntent: invalid input', {
        field: err instanceof IntakeValidationError ? err.field : undefined,
      });
      throw err;
    }

    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('parseIntent', { model });

    // Prefix routing: детерминированный override до LLM
    const prefixAppType = detectAppTypeFromPrefix(input.text);
    if (prefixAppType !== null) {
      log.debug('parseIntent: prefix appType detected', { prefixAppType });
    }

    const abSystem = loadAbPromptOverride();
    const userContent = [
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
    ].join('\n');

    let response;
    const t0 = Date.now();
    try {
      response = await provider.complete({
        model,
        messages: abSystem
          ? [
              { role: 'system', content: abSystem },
              { role: 'user', content: userContent },
            ]
          : [{ role: 'user', content: userContent }],
        responseFormat: { type: 'json_object' },
        maxTokens: 2000,
      });
    } catch (err) {
      throw wrapLlmError(err, 'IntakeAgent.parseIntent', { model });
    }

    logLlmUsage({
      timestamp: new Date().toISOString(),
      role: 'IntakeAgent',
      model,
      tokenUsage: {
        prompt:     response.tokensUsed?.prompt     ?? 0,
        completion: response.tokensUsed?.completion ?? 0,
        total:      response.tokensUsed?.total      ?? 0,
      },
      durationMs: Date.now() - t0,
    });

    let parsed: Record<string, unknown>;
    try {
      const cleaned = this.cleanJsonResponse(response.content, 'parseIntent');
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn('parseIntent: JSON parse failed, using fallback');
      log.debug('parseIntent: raw LLM response', { raw: response?.content });
      return this.fallbackIntent(input.text, prefixAppType);
    }

    const p = parsed as LlmIntentJson;

    return {
      intentId: randomUUID(),
      description: String(
        p.intent ?? p.description ?? input.text,
      ),
      features: featuresFromLlmParsed(p, input.text),
      appType: prefixAppType ?? (parsed.appType as AppType) ?? 'утилита',
      constraints: (parsed.constraints as Record<string, unknown>) ?? {},
      confidence: parseLlmConfidence(p.confidence),
    };
  }

  async generateSpec(intent: OsnovaIntent): Promise<OsnovaSpec> {
    try {
      this.validateIntentForSpec(intent);
    } catch (err) {
      log.warn('generateSpec: invalid intent', {
        field: err instanceof IntakeValidationError ? err.field : undefined,
      });
      throw err;
    }

    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('generateSpec', { model, intentId: intent.intentId });

    const systemPrompt =
      loadAbPromptOverride() ??
      buildSpecSystemPrompt() + (this.registryContext ? '\n\n' + this.registryContext : '');

    let response;
    const t0 = Date.now();
    try {
      response = await provider.complete({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
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

    logLlmUsage({
      timestamp: new Date().toISOString(),
      role: 'IntakeAgent',
      model,
      tokenUsage: {
        prompt:     response.tokensUsed?.prompt     ?? 0,
        completion: response.tokensUsed?.completion ?? 0,
        total:      response.tokensUsed?.total      ?? 0,
      },
      durationMs: Date.now() - t0,
    });

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

  /**
   * T-7: Валидация полноты spec перед codegen.
   * Выбрасывает SpecValidationError если spec неполный.
   */
  checkSpec(spec: OsnovaSpec): void {
    const missing: string[] = [];

    if (!spec.mainModule || spec.mainModule.trim() === '') {
      missing.push('mainModule (пусто или отсутствует)');
    }
    if (!Array.isArray(spec.modules) || spec.modules.length === 0) {
      missing.push('modules (пустой массив)');
    }
    if (!Array.isArray(spec.procedures) || spec.procedures.length === 0) {
      missing.push('procedures (пустой массив — нет ни одной процедуры)');
    }
    const hasMain = (spec.procedures ?? []).some(
      (p) => p.name === 'главная',
    );
    if (!hasMain) {
      missing.push('procedures[].name="главная" (обязательная процедура отсутствует)');
    }

    if (missing.length > 0) {
      throw new SpecValidationError(missing, spec.specId ?? 'unknown');
    }
  }

  private fallbackIntent(text: string, prefixAppType: AppType | null = null): OsnovaIntent {
    return {
      intentId: randomUUID(),
      description: text,
      features: [text],
      appType: prefixAppType ?? 'утилита',
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
      procedures: [{ name: 'главная', params: {}, returnType: 'Логический' }],
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
