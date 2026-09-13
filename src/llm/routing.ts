// ============================================================
// src/llm/routing.ts — посфазная маршрутизация LLM (тир × уровень)
// Спецификация: docs/llm-routing-v1.md
//
// defaults.ts отвечает на вопрос «модель по умолчанию для провайдера»,
// routing.ts — «модель и режим для конкретной фазы пайплайна при заданном
// тире (flash/pro/auto) и уровне усилий (low/med/high)».
//
// Провайдер-специфичность: тир и reasoning_effort применимы только к DeepSeek.
// Для qwen-cli/ollama тир деградирует к OSNOVA_MODEL / дефолту провайдера.
// ============================================================

import { DEFAULT_PROVIDER, getDefaultModel } from './defaults.js';

/** Тир модели: `auto` = Flash + эскалация repair→Pro, `flash`, `pro`. */
export type LlmTier = 'auto' | 'flash' | 'pro';

/** Уровень усилий: `low` — без thinking, `med` — баланс, `high` — максимум. */
export type LlmLevel = 'low' | 'med' | 'high';

/** Фазы пайплайна, потребляющие LLM (build/golden — не LLM). */
export type PipelinePhase = 'intake' | 'spec' | 'codegen' | 'repair';

/** Уровень «размышлений» DeepSeek V4 (reasoning_effort). */
export type ReasoningEffort = 'low' | 'high' | 'max';

export const DEFAULT_TIER: LlmTier = 'auto';
export const DEFAULT_LEVEL: LlmLevel = 'med';

export const LLM_TIERS: readonly LlmTier[] = ['auto', 'flash', 'pro'];
export const LLM_LEVELS: readonly LlmLevel[] = ['low', 'med', 'high'];
export const PIPELINE_PHASES: readonly PipelinePhase[] = ['intake', 'spec', 'codegen', 'repair'];

/** Имена моделей DeepSeek V4 по тиру (deepseek-chat/reasoner уходят 24.07.2026). */
export const DEEPSEEK_TIER_MODEL: Record<'flash' | 'pro', string> = {
  flash: 'deepseek-flash',
  pro: 'deepseek-pro',
};

/** Пер-фазные env-override (по прецеденту OSNOVA_INTELLIGENCE_MODEL). */
const PHASE_MODEL_ENV: Record<PipelinePhase, string> = {
  intake: 'OSNOVA_MODEL_INTAKE',
  spec: 'OSNOVA_MODEL_SPEC',
  codegen: 'OSNOVA_MODEL_CODEGEN',
  repair: 'OSNOVA_MODEL_REPAIR',
};

/**
 * reasoning_effort по фазе и уровню. undefined = thinking выключен.
 * Матрица: docs/llm-routing-v1.md §4.2.
 */
const REASONING_EFFORT: Record<PipelinePhase, Record<LlmLevel, ReasoningEffort | undefined>> = {
  intake: { low: undefined, med: 'high', high: 'max' },
  spec: { low: undefined, med: undefined, high: 'high' },
  codegen: { low: undefined, med: 'high', high: 'max' },
  repair: { low: undefined, med: 'high', high: 'max' },
};

/**
 * temperature по фазе и уровню.
 * В thinking-режиме DeepSeek игнорирует temperature (§8), поэтому реально
 * эти значения действуют только на уровнях/фазах без reasoning.
 */
const TEMPERATURE: Record<PipelinePhase, Record<LlmLevel, number>> = {
  intake: { low: 0, med: 0, high: 0 },
  spec: { low: 0, med: 0, high: 0 },
  codegen: { low: 0.2, med: 0.3, high: 0.4 },
  repair: { low: 0.1, med: 0.1, high: 0.1 },
};

/** Базовый лимит output-токенов по фазе (без головы под thinking). */
const BASE_MAX_TOKENS: Record<PipelinePhase, number> = {
  intake: 2000,
  spec: 4000,
  codegen: 8000,
  repair: 8000,
};

/** Thinking-токены входят в лимит output — даём двукратный запас (§8.3). */
const THINKING_MAX_TOKENS_FACTOR = 2;

/** Порог эскалации repair→Pro: сколько подряд неудач терпим до переключения. */
const ESCALATION_THRESHOLD: Record<LlmLevel, number> = {
  low: Number.POSITIVE_INFINITY,
  med: 3,
  high: 1,
};

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/** Провайдер из окружения (без инстанцирования LLMProvider). */
export function resolveProvider(): string {
  return process.env.OSNOVA_PROVIDER ?? DEFAULT_PROVIDER;
}

/** `OSNOVA_TIER` → тир; неизвестное значение → {@link DEFAULT_TIER}. */
export function resolveTier(raw?: string): LlmTier {
  const value = firstDefined(raw, process.env.OSNOVA_TIER);
  return (LLM_TIERS as readonly string[]).includes(value ?? '')
    ? (value as LlmTier)
    : DEFAULT_TIER;
}

/** `OSNOVA_LEVEL` → уровень; неизвестное значение → {@link DEFAULT_LEVEL}. */
export function resolveLevel(raw?: string): LlmLevel {
  const value = firstDefined(raw, process.env.OSNOVA_LEVEL);
  return (LLM_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as LlmLevel)
    : DEFAULT_LEVEL;
}

/**
 * Модель для фазы. Приоритет:
 * 1. явный override фазы (`OSNOVA_MODEL_<PHASE>`);
 * 2. DeepSeek → имя модели по тиру (`auto`/`flash` → flash, `pro` → pro);
 * 3. прочие провайдеры → `OSNOVA_MODEL ??` дефолт провайдера (тир не применяется).
 */
export function resolveModel(phase: PipelinePhase, tier: LlmTier = resolveTier()): string {
  const override = process.env[PHASE_MODEL_ENV[phase]];
  if (override != null && override.trim() !== '') return override.trim();

  const provider = resolveProvider();
  if (provider === 'deepseek') {
    return tier === 'pro' ? DEEPSEEK_TIER_MODEL.pro : DEEPSEEK_TIER_MODEL.flash;
  }
  const envModel = process.env.OSNOVA_MODEL;
  if (envModel != null && envModel.trim() !== '') return envModel.trim();
  return getDefaultModel(provider);
}

/**
 * Модель-эскалация для фазы (Pro).
 * Для не-DeepSeek провайдеров — no-op: тир игнорируется, модель не меняется.
 */
export function resolveEscalationModel(phase: PipelinePhase): string {
  return resolveModel(phase, 'pro');
}

/** Thinking включён, если для фазы/уровня задан `reasoning_effort`. */
export function resolveThinking(phase: PipelinePhase, level: LlmLevel = resolveLevel()): boolean {
  return REASONING_EFFORT[phase][level] !== undefined;
}

/** `reasoning_effort` для фазы/уровня (undefined = thinking off). */
export function resolveReasoningEffort(
  phase: PipelinePhase,
  level: LlmLevel = resolveLevel(),
): ReasoningEffort | undefined {
  return REASONING_EFFORT[phase][level];
}

/**
 * temperature для фазы/уровня.
 * В thinking-режиме DeepSeek игнорирует temperature, поэтому возвращаем
 * undefined — чтобы не отправлять заведомо бессмысленный параметр.
 */
export function resolveTemperature(
  phase: PipelinePhase,
  level: LlmLevel = resolveLevel(),
): number | undefined {
  if (resolveThinking(phase, level)) return undefined;
  return TEMPERATURE[phase][level];
}

/** maxTokens для фазы/уровня (с запасом под thinking-токены, если он включён). */
export function resolveMaxTokens(phase: PipelinePhase, level: LlmLevel = resolveLevel()): number {
  const base = BASE_MAX_TOKENS[phase];
  return resolveThinking(phase, level) ? base * THINKING_MAX_TOKENS_FACTOR : base;
}

/**
 * Нужна ли эскалация repair→Pro.
 * Только фаза repair, только `tier=auto`, и только после порога подряд
 * неудачных итераций (low — никогда, med — 3, high — 1).
 */
export function shouldEscalateToPro(
  phase: PipelinePhase,
  level: LlmLevel = resolveLevel(),
  consecutiveFailures = 0,
  tier: LlmTier = resolveTier(),
): boolean {
  if (tier !== 'auto') return false;
  if (phase !== 'repair') return false;
  return consecutiveFailures >= ESCALATION_THRESHOLD[level];
}

/** Полная политика фазы — ровно то, что уходит в `LLMCompletionRequest`. */
export interface PhaseRouting {
  readonly phase: PipelinePhase;
  readonly tier: LlmTier;
  readonly level: LlmLevel;
  readonly model: string;
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly thinking: boolean;
  readonly reasoningEffort: ReasoningEffort | undefined;
}

export interface PhaseRoutingOptions {
  readonly tier?: LlmTier;
  readonly level?: LlmLevel;
  /** Явный override модели (например, эскалация repair→Pro). */
  readonly model?: string;
}

/**
 * Единая точка входа для агентов:
 * фаза → `{ model, temperature, maxTokens, thinking, reasoningEffort }`.
 */
export function resolvePhaseRouting(
  phase: PipelinePhase,
  opts: PhaseRoutingOptions = {},
): PhaseRouting {
  const tier = opts.tier ?? resolveTier();
  const level = opts.level ?? resolveLevel();
  return {
    phase,
    tier,
    level,
    model: opts.model ?? resolveModel(phase, tier),
    temperature: resolveTemperature(phase, level),
    maxTokens: resolveMaxTokens(phase, level),
    thinking: resolveThinking(phase, level),
    reasoningEffort: resolveReasoningEffort(phase, level),
  };
}

/** Компактная сводка маршрутизации — для логов, CLI и тестов. */
export function routingSummary(
  tier: LlmTier = resolveTier(),
  level: LlmLevel = resolveLevel(),
): readonly PhaseRouting[] {
  return PIPELINE_PHASES.map(phase => resolvePhaseRouting(phase, { tier, level }));
}
