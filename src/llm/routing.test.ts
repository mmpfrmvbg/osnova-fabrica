// ============================================================
// src/llm/routing.test.ts — тесты посфазной маршрутизации
// Спецификация: docs/llm-routing-v1.md
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_LEVEL,
  DEFAULT_TIER,
  LLM_LEVELS,
  LLM_TIERS,
  PIPELINE_PHASES,
  resolveEscalationModel,
  resolveLevel,
  resolveMaxTokens,
  resolveModel,
  resolvePhaseRouting,
  resolveReasoningEffort,
  resolveTemperature,
  resolveThinking,
  resolveTier,
  routingSummary,
  shouldEscalateToPro,
} from './routing';

/** Явно «сбросить» переменную окружения для теста. */
function clearEnv(...names: string[]): void {
  for (const name of names) vi.stubEnv(name, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveTier / resolveLevel', () => {
  it('возвращает дефолты, когда переменные не заданы', () => {
    clearEnv('OSNOVA_TIER', 'OSNOVA_LEVEL');
    expect(resolveTier()).toBe(DEFAULT_TIER);
    expect(resolveLevel()).toBe(DEFAULT_LEVEL);
  });

  it('читает валидные значения из окружения', () => {
    vi.stubEnv('OSNOVA_TIER', 'pro');
    vi.stubEnv('OSNOVA_LEVEL', 'high');
    expect(resolveTier()).toBe('pro');
    expect(resolveLevel()).toBe('high');
  });

  it('неизвестное значение падает в дефолт', () => {
    vi.stubEnv('OSNOVA_TIER', 'turbo');
    vi.stubEnv('OSNOVA_LEVEL', 'ultra');
    expect(resolveTier()).toBe(DEFAULT_TIER);
    expect(resolveLevel()).toBe(DEFAULT_LEVEL);
  });

  it('явный аргумент приоритетнее окружения', () => {
    vi.stubEnv('OSNOVA_TIER', 'flash');
    vi.stubEnv('OSNOVA_LEVEL', 'low');
    expect(resolveTier('pro')).toBe('pro');
    expect(resolveLevel('high')).toBe('high');
  });
});

describe('resolveModel', () => {
  it('DeepSeek: тир auto и flash → deepseek-flash, pro → deepseek-pro', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    clearEnv('OSNOVA_MODEL_CODEGEN');
    expect(resolveModel('codegen', 'auto')).toBe('deepseek-flash');
    expect(resolveModel('codegen', 'flash')).toBe('deepseek-flash');
    expect(resolveModel('codegen', 'pro')).toBe('deepseek-pro');
  });

  it('не-DeepSeek: тир игнорируется, работает OSNOVA_MODEL', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'ollama');
    vi.stubEnv('OSNOVA_MODEL', 'my-local-model');
    clearEnv('OSNOVA_MODEL_SPEC');
    expect(resolveModel('spec', 'pro')).toBe('my-local-model');
  });

  it('не-DeepSeek без OSNOVA_MODEL: дефолт провайдера', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'qwen-cli');
    clearEnv('OSNOVA_MODEL', 'OSNOVA_MODEL_INTAKE');
    expect(resolveModel('intake', 'flash')).toBe('qwen-coder-plus');
  });

  it('пер-фазный override OSNOVA_MODEL_<PHASE> приоритетнее тира', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    vi.stubEnv('OSNOVA_MODEL_REPAIR', 'custom-repair-model');
    expect(resolveModel('repair', 'flash')).toBe('custom-repair-model');
  });

  it('пустой override не подменяет модель', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    clearEnv('OSNOVA_MODEL_INTAKE');
    expect(resolveModel('intake', 'flash')).toBe('deepseek-flash');
  });

  it('resolveEscalationModel всегда даёт Pro у DeepSeek', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    clearEnv('OSNOVA_MODEL_REPAIR');
    expect(resolveEscalationModel('repair')).toBe('deepseek-pro');
  });
});

describe('матрица reasoning (docs/llm-routing-v1.md §4.2)', () => {
  it('reasoning_effort по фазе и уровню', () => {
    expect(resolveReasoningEffort('intake', 'low')).toBeUndefined();
    expect(resolveReasoningEffort('intake', 'med')).toBe('high');
    expect(resolveReasoningEffort('intake', 'high')).toBe('max');

    expect(resolveReasoningEffort('spec', 'med')).toBeUndefined();
    expect(resolveReasoningEffort('spec', 'high')).toBe('high');

    expect(resolveReasoningEffort('codegen', 'low')).toBeUndefined();
    expect(resolveReasoningEffort('codegen', 'med')).toBe('high');

    expect(resolveReasoningEffort('repair', 'low')).toBeUndefined();
    expect(resolveReasoningEffort('repair', 'med')).toBe('high');
    expect(resolveReasoningEffort('repair', 'high')).toBe('max');
  });

  it('resolveThinking выводится из reasoning_effort', () => {
    expect(resolveThinking('codegen', 'low')).toBe(false);
    expect(resolveThinking('codegen', 'med')).toBe(true);
    expect(resolveThinking('spec', 'med')).toBe(false);
    expect(resolveThinking('spec', 'high')).toBe(true);
  });

  it('temperature отдаётся только вне thinking-режима', () => {
    // thinking on → undefined (DeepSeek игнорирует temperature)
    expect(resolveTemperature('intake', 'med')).toBeUndefined();
    expect(resolveTemperature('codegen', 'high')).toBeUndefined();
    // thinking off → значение по фазе
    expect(resolveTemperature('intake', 'low')).toBe(0);
    expect(resolveTemperature('spec', 'med')).toBe(0);
    expect(resolveTemperature('codegen', 'low')).toBe(0.2);
    expect(resolveTemperature('repair', 'low')).toBe(0.1);
  });

  it('maxTokens удваивается при включённом thinking', () => {
    expect(resolveMaxTokens('intake', 'low')).toBe(2000);
    expect(resolveMaxTokens('intake', 'med')).toBe(4000);
    expect(resolveMaxTokens('spec', 'med')).toBe(4000);
    expect(resolveMaxTokens('spec', 'high')).toBe(8000);
    expect(resolveMaxTokens('codegen', 'low')).toBe(8000);
    expect(resolveMaxTokens('codegen', 'med')).toBe(16000);
    expect(resolveMaxTokens('repair', 'high')).toBe(16000);
  });
});

describe('shouldEscalateToPro', () => {
  it('low — эскалации нет', () => {
    expect(shouldEscalateToPro('repair', 'low', 100, 'auto')).toBe(false);
  });

  it('med — порог 3 подряд неудачи', () => {
    expect(shouldEscalateToPro('repair', 'med', 2, 'auto')).toBe(false);
    expect(shouldEscalateToPro('repair', 'med', 3, 'auto')).toBe(true);
  });

  it('high — эскалация после первой неудачи', () => {
    expect(shouldEscalateToPro('repair', 'high', 0, 'auto')).toBe(false);
    expect(shouldEscalateToPro('repair', 'high', 1, 'auto')).toBe(true);
  });

  it('только repair', () => {
    expect(shouldEscalateToPro('codegen', 'high', 5, 'auto')).toBe(false);
    expect(shouldEscalateToPro('intake', 'high', 5, 'auto')).toBe(false);
  });

  it('только tier=auto', () => {
    expect(shouldEscalateToPro('repair', 'high', 5, 'flash')).toBe(false);
    expect(shouldEscalateToPro('repair', 'high', 5, 'pro')).toBe(false);
  });

  it('берёт level/tier из окружения по умолчанию', () => {
    vi.stubEnv('OSNOVA_LEVEL', 'high');
    vi.stubEnv('OSNOVA_TIER', 'auto');
    expect(shouldEscalateToPro('repair', undefined, 1)).toBe(true);
  });
});

describe('resolvePhaseRouting / routingSummary', () => {
  it('собирает полную политику фазы', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    clearEnv('OSNOVA_MODEL_CODEGEN');
    const r = resolvePhaseRouting('codegen', { tier: 'flash', level: 'med' });
    expect(r).toEqual({
      phase: 'codegen',
      tier: 'flash',
      level: 'med',
      model: 'deepseek-flash',
      temperature: undefined,
      maxTokens: 16000,
      thinking: true,
      reasoningEffort: 'high',
    });
  });

  it('явный model override (эскалация) подменяет модель', () => {
    vi.stubEnv('OSNOVA_PROVIDER', 'deepseek');
    const r = resolvePhaseRouting('repair', { tier: 'auto', level: 'med', model: 'deepseek-pro' });
    expect(r.model).toBe('deepseek-pro');
    expect(r.tier).toBe('auto');
  });

  it('routingSummary покрывает все фазы', () => {
    const summary = routingSummary('auto', 'med');
    expect(summary.map(r => r.phase)).toEqual([...PIPELINE_PHASES]);
  });

  it('списки тиров и уровней не пусты и согласованы', () => {
    expect(LLM_TIERS).toContain(DEFAULT_TIER);
    expect(LLM_LEVELS).toContain(DEFAULT_LEVEL);
  });
});
