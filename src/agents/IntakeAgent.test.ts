import { describe, it, expect, vi } from 'vitest';
import { IntakeAgent, detectAppTypeFromPrefix } from './IntakeAgent';
import type { OsnovaIntent } from '../pipeline/types';

// Mock LLM: всегда возвращаем невалидный JSON.
vi.mock('../llm/index', () => ({
  getLLMProvider: () => ({
    complete: async () => ({ content: 'не JSON', model: 'mock', done: true }),
  }),
}));

// ─── fallbackIntent ───

describe('IntakeAgent.fallbackIntent', () => {
  const agent = new IntakeAgent();

  it('возвращает валидный OsnovaIntent с описанием задачи', () => {
    const intent = (agent as any).fallbackIntent('посчитать сумму') as OsnovaIntent;
    expect(intent.description).toBe('посчитать сумму');
    expect(intent.features).toContain('посчитать сумму');
    expect(intent.appType).toBe('утилита');
    expect(intent.confidence).toBe(0.5);
    expect(typeof intent.intentId).toBe('string');
    expect(intent.intentId.length).toBeGreaterThan(0);
  });

  it('каждый вызов возвращает уникальный intentId', () => {
    const a = (agent as any).fallbackIntent('задача') as OsnovaIntent;
    const b = (agent as any).fallbackIntent('задача') as OsnovaIntent;
    expect(a.intentId).not.toBe(b.intentId);
  });

  it('constraints — пустой объект', () => {
    const intent = (agent as any).fallbackIntent('x') as OsnovaIntent;
    expect(intent.constraints).toEqual({});
  });
});

// ─── fallbackSpec ───

describe('IntakeAgent.fallbackSpec', () => {
  const agent = new IntakeAgent();

  it('возвращает валидный OsnovaSpec с модулем main', () => {
    const intent: OsnovaIntent = {
      intentId: 'i1',
      description: 'тест',
      features: ['фича'],
      appType: 'утилита',
      constraints: {},
      confidence: 0.9,
    };
    const spec = (agent as any).fallbackSpec(intent);
    expect(spec.modules).toHaveLength(1);
    expect(spec.modules[0].isMain).toBe(true);
    expect(spec.mainModule).toBe('main');
    expect(spec.types).toEqual([]);
    expect(spec.procedures).toEqual([
      { name: 'главная', params: {}, returnType: 'Логический' },
    ]);
    expect(spec.syscalls).toEqual([]);
    expect(typeof spec.specId).toBe('string');
  });

  it('description модуля берётся из intent.description', () => {
    const intent: OsnovaIntent = {
      intentId: 'i2',
      description: 'моя задача',
      features: [],
      appType: 'утилита',
      constraints: {},
      confidence: 0.8,
    };
    const spec = (agent as any).fallbackSpec(intent);
    expect(spec.modules[0].description).toBe('моя задача');
  });
});

// ─── cleanJsonResponse ───

describe('IntakeAgent.cleanJsonResponse', () => {
  const agent = new IntakeAgent();
  const clean = (raw: string) => (agent as any).cleanJsonResponse(raw, 'parseIntent') as string;

  it('возвращает JSON без изменений', () => {
    const json = '{"key": "value"}';
    expect(clean(json)).toBe(json);
  });

  it('strip-ает markdown-фенс ```json ... ```', () => {
    const raw = '```json\n{"key": "val"}\n```';
    const result = clean(raw);
    expect(result).toContain('"key"');
    expect(result).not.toContain('```');
  });

  it('strip-ает markdown-фенс ``` ... ```', () => {
    const raw = '```\n{"a": 1}\n```';
    expect(clean(raw)).not.toContain('```');
  });

  it('возвращает пустую строку при пустом вводе', () => {
    expect(clean('')).toBe('');
  });

  it('извлекает JSON из текста с мусором вокруг', () => {
    const raw = 'вот результат: {"ok": true} конец';
    const result = clean(raw);
    expect(result).toContain('"ok"');
  });
});

// ─── parseIntent с mock LLM ───

describe('IntakeAgent.parseIntent (mock LLM)', () => {
  it('возвращает fallback при невалидном JSON от LLM', async () => {
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'любая задача' });
    // должен вернуть fallback, не упасть
    expect(intent.description).toBe('любая задача');
    expect(intent.appType).toBe('утилита');
  });

  it('fallback учитывает префикс Алгоритм:', async () => {
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'Алгоритм: сортировка' });
    expect(intent.appType).toBe('алгоритм');
  });
});

describe('detectAppTypeFromPrefix', () => {
  it('Алгоритм: сортировка списка → "алгоритм"', () => {
    expect(detectAppTypeFromPrefix('Алгоритм: сортировка списка')).toBe('алгоритм');
  });

  it('алгоритм: (lowercase) → "алгоритм"', () => {
    expect(detectAppTypeFromPrefix('алгоритм: поиск в массиве')).toBe('алгоритм');
  });

  it('Тест: проверить что сумма → "тест"', () => {
    expect(detectAppTypeFromPrefix('Тест: проверить что сумма равна 10')).toBe('тест');
  });

  it('Модуль: работа с файлами → "модуль"', () => {
    expect(detectAppTypeFromPrefix('Модуль: работа с файлами')).toBe('модуль');
  });

  it('Библиотека: математика → "библиотека"', () => {
    expect(detectAppTypeFromPrefix('Библиотека: математические функции')).toBe('библиотека');
  });

  it('Модуль типов: ... → "модуль_типов"', () => {
    expect(detectAppTypeFromPrefix('Модуль типов: базовые типы')).toBe('модуль_типов');
  });

  it('обычная задача без префикса → null', () => {
    expect(detectAppTypeFromPrefix('Посчитать сумму от 1 до 10')).toBeNull();
  });

  it('Утилита без явного префикса → null', () => {
    expect(detectAppTypeFromPrefix('сохранить задачи в хранилище')).toBeNull();
  });
});

