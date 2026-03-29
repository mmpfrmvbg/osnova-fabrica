// ============================================================
// src/agents/intake-agent.ts — IntakeAgent: первичная обработка входа (epic scope)
// trustTier: T2 (bounded-auto)
// Input:  RawText → OsnovaIntent → OsnovaSpec
// Промпт: few-shot примеры из golden-tests
// Контракт {@link IAgent} — ./types.ts; логирование и ошибки — IntakeValidationError, logger.
// ============================================================

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { getLLMProvider } from '../llm/index';
import { IntakeValidationError, type IAgent } from './types';
import type { AgentReport, BaseAgent } from '../types/agents';
import {
  SPEC_INTENT_CONFIDENCE_DEFAULT,
  type RawText,
  type OsnovaIntent,
  type OsnovaSpec,
  type AppType,
  type OsnovaModule,
  type OsnovaType,
  type ProcedureSignature,
} from '../pipeline/types';
import type { CompileResult } from '../compiler/compiler';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';
import { logLlmUsage } from '../lib/usage-logger';
import { LANGUAGE_REGISTRY } from '../compiler/language-registry';

/** Результат фазы build (`compileSource`) — реэкспорт для вызовов, связывающих intake с компилятором. */
export type { CompileResult };

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

/** Значения {@link AppType} — для безопасного разбора JSON LLM без «голого» приведения. */
const APP_TYPES_KNOWN = [
  'утилита',
  'хранилище',
  'ui_приложение',
  'актор',
  'смешанный',
  'алгоритм',
  'тест',
  'модуль',
  'библиотека',
  'модуль_типов',
] as const satisfies readonly AppType[];

function coerceAppType(value: unknown, fallback: AppType): AppType {
  if (typeof value !== 'string') return fallback;
  return (APP_TYPES_KNOWN as readonly string[]).includes(value) ? (value as AppType) : fallback;
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
  return SPEC_INTENT_CONFIDENCE_DEFAULT;
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

/** Извлекает непустой список строк из features/roles (массив, строка, объект значений). */
function nonEmptyStringListFromUnknown(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const out = value.map(String).map(s => s.trim()).filter(s => s.length > 0);
    return out.length > 0 ? out : null;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    if (t.includes(',')) {
      return t.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    return [t];
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.values(value as Record<string, unknown>)
      .filter(v => v != null)
      .map(v => String(v).trim())
      .filter(s => s.length > 0);
    return out.length > 0 ? out : null;
  }
  return null;
}

/** Features для intent: features → roles (массив / строка / объект) → intent|fallback. */
export function intentFeaturesFromLlmPayload(parsed: LlmIntentJson, fallbackText: string): string[] {
  const fromFeatures = nonEmptyStringListFromUnknown(parsed.features);
  if (fromFeatures) return fromFeatures;
  const fromRoles = nonEmptyStringListFromUnknown(parsed.roles);
  if (fromRoles) return fromRoles;
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

export class IntakeAgent implements IAgent, BaseAgent {
  private lastRun: { intent: OsnovaIntent; spec: OsnovaSpec } | null = null;

  constructor(private registryContext: string = '') {}

  /**
   * Проверка структуры и типов входа intake: объект с непустой строкой `text` (после trim).
   * Дополнительные аргументы игнорируются (совместимость с {@link BaseAgent}).
   */
  validate(input: unknown, _ctx?: unknown, _plan?: unknown): void | AgentReport {
    this.assertRawText(input);
  }

  /** Узкое утверждение типа после проверки (внутренние вызовы). */
  private assertRawText(input: unknown): asserts input is RawText {
    if (input == null || typeof input !== 'object') {
      throw new IntakeValidationError('RawText must be a non-null object', 'text');
    }
    if (Array.isArray(input)) {
      throw new IntakeValidationError('RawText must be a plain object, not an array', 'text');
    }
    const text = (input as { text?: unknown }).text;
    if (typeof text !== 'string') {
      throw new IntakeValidationError('RawText.text must be a string', 'text');
    }
    if (text.trim() === '') {
      throw new IntakeValidationError('Task text is empty', 'text');
    }
  }

  /** Нормализация входа: обрезка пробелов по краям `text`. */
  parse(input: RawText): RawText {
    return { text: input.text.trim() };
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
      this.assertRawText(input);
    } catch (err) {
      log.warn('parseIntent: invalid input', {
        field: err instanceof IntakeValidationError ? err.field : undefined,
      });
      throw err;
    }

    const normalized = this.parse(input);

    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('parseIntent', { model });

    // Prefix routing: детерминированный override до LLM
    const prefixAppType = detectAppTypeFromPrefix(normalized.text);
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
      `Task: "${normalized.text}"`,
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
      return this.fallbackIntent(normalized.text, prefixAppType);
    }

    const p = parsed as LlmIntentJson;

    return {
      intentId: randomUUID(),
      description: String(
        p.intent ?? p.description ?? normalized.text,
      ),
      features: intentFeaturesFromLlmPayload(p, normalized.text),
      appType: prefixAppType ?? coerceAppType(p.appType, 'утилита'),
      constraints:
        p.constraints != null && typeof p.constraints === 'object' && !Array.isArray(p.constraints)
          ? (p.constraints as Record<string, unknown>)
          : {},
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

    const rawList = Array.isArray(parsed.modules) ? parsed.modules : [];
    const first = rawList[0];
    const modules: readonly OsnovaModule[] =
      rawList.length > 0 && first != null && typeof first === 'object' && !Array.isArray(first)
        ? [
            {
              name: String((first as Record<string, unknown>).name ?? 'Главный'),
              description: String((first as Record<string, unknown>).description ?? intent.description),
              isMain: Boolean((first as Record<string, unknown>).isMain),
            },
          ]
        : [{ name: 'Главный', description: intent.description, isMain: true }];

    const typesRaw = Array.isArray(parsed.types) ? parsed.types : [];
    const types: readonly OsnovaType[] = typesRaw.filter(
      (t): t is OsnovaType =>
        t != null &&
        typeof t === 'object' &&
        !Array.isArray(t) &&
        typeof (t as OsnovaType).name === 'string',
    );

    const procRaw = Array.isArray(parsed.procedures) ? parsed.procedures : [];
    const procedures: readonly ProcedureSignature[] = procRaw.filter(
      (p): p is ProcedureSignature =>
        p != null &&
        typeof p === 'object' &&
        !Array.isArray(p) &&
        typeof (p as ProcedureSignature).name === 'string' &&
        typeof (p as ProcedureSignature).returnType === 'string' &&
        (p as ProcedureSignature).params != null &&
        typeof (p as ProcedureSignature).params === 'object' &&
        !Array.isArray((p as ProcedureSignature).params),
    );

    return {
      specId: randomUUID(),
      modules,
      mainModule: String(parsed.mainModule ?? modules[0]?.name ?? 'Главный'),
      types,
      procedures,
      syscalls: Array.isArray(parsed.syscalls) ? parsed.syscalls.map(String) : [],
      conventions:
        parsed.conventions != null &&
        typeof parsed.conventions === 'object' &&
        !Array.isArray(parsed.conventions)
          ? (parsed.conventions as Record<string, unknown>)
          : {},
    };
  }

  /**
   * T-7: Валидация полноты spec перед codegen.
   * Выбрасывает SpecValidationError если spec неполный.
   * После codegen фаза build даёт {@link CompileResult} через `compileSource`.
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

  /**
   * Полный цикл intake: RawText → intent → spec (с checkSpec).
   */
  async run(
    input?: unknown,
    ..._rest: unknown[]
  ): Promise<{ intent: OsnovaIntent; spec: OsnovaSpec }> {
    const raw = input as RawText;
    this.assertRawText(raw);
    const normalized = this.parse(raw);
    const intent = await this.parseIntent(normalized);
    const spec = await this.generateSpec(intent);
    this.checkSpec(spec);
    this.lastRun = { intent, spec };
    return this.lastRun;
  }

  report(): AgentReport {
    if (!this.lastRun) {
      return { ok: false, summaryText: '[IntakeAgent] run() ещё не выполнялся' };
    }
    return {
      ok: true,
      summaryText: `[IntakeAgent] intentId=${this.lastRun.intent.intentId} specId=${this.lastRun.spec.specId}`,
    };
  }
}

// Связка выданной spec с VM / interpreter (публичный фасад модуля).
export {
  OsVbcVM,
  applyPipelineSpecToVm,
  buildPipelineVmGlobals,
  createDefaultInvokeHandler,
  createPipelineInvokeHandlerForVm,
  createPipelineVmFromSpec,
  PIPELINE_VM_GLOBAL_KEYS,
} from '../runtime/vm';
export type { OsVbcExecuteOptions, OsVbcVMOptions, VmExecutionLogEvent } from '../runtime/vm';
export { Interpreter, InterpreterError } from '../runtime/interpreter';
export type { InterpreterOptions, StackValue, InvokeHandler } from '../runtime/interpreter';
export type { AgentReport, BaseAgent } from '../types/agents';
