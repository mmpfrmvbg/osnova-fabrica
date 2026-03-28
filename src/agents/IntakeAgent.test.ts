import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntakeAgent, detectAppTypeFromPrefix } from './IntakeAgent';
import type { OsnovaIntent } from '../pipeline/types';

const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn(),
}));

vi.mock('../llm/index', () => ({
  getLLMProvider: () => ({
    complete: mockLlmComplete,
  }),
}));

beforeEach(() => {
  mockLlmComplete.mockReset();
  mockLlmComplete.mockResolvedValue({ content: 'не JSON', model: 'mock', done: true });
});

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
    expect(intent.confidence).toBe(0.5);
  });

  it('fallback учитывает префикс Алгоритм: и фиксирует низкую confidence 0.5 (fallbackIntent)', async () => {
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'Алгоритм: сортировка' });
    expect(intent.appType).toBe('алгоритм');
    expect(intent.confidence).toBe(0.5);
  });

  it('Issues #3: пустой features[] от LLM не затирает низкую confidence (подставляется intent в features)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'неясно что строить',
        confidence: 0.31,
        language: 'osnova',
        features: [],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'сделай приложение' });
    expect(intent.confidence).toBe(0.31);
    expect(intent.features).toEqual(['неясно что строить']);
  });

  it('сохраняет низкую confidence из валидного JSON от LLM (Issues #1, #3)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'разобрать неоднозначный запрос',
        confidence: 0.32,
        language: 'osnova',
        features: ['нестандартный ввод'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'что-то странное про модули' });
    expect(intent.confidence).toBe(0.32);
    expect(intent.features).toEqual(['нестандартный ввод']);
    expect(intent.description).toBe('разобрать неоднозначный запрос');
  });

  it('при отсутствии confidence в JSON подставляет 0.8', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'ясная задача',
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'ясная задача' });
    expect(intent.confidence).toBe(0.8);
  });

  it('недостаточный контекст: короткий запрос → LLM даёт низкую confidence', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'недостаточно данных для однозначной постановки',
        confidence: 0.22,
        language: 'osnova',
        features: ['ambiguous input'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: '?' });
    expect(intent.confidence).toBe(0.22);
    expect(intent.description).toContain('недостаточно');
  });

  it('противоречивый ввод: LLM снижает confidence при конфликте intent/features', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'сделать CLI-калькулятор',
        confidence: 0.41,
        language: 'osnova',
        features: ['только веб-UI', 'без консоли'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({
      text: 'калькулятор в терминале но только как веб-страница без терминала',
    });
    expect(intent.confidence).toBe(0.41);
    expect(intent.features.join(' ')).toMatch(/веб|UI/i);
  });

  it('граница G1: confidence ровно 0.7 сохраняется', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'на грани',
        confidence: 0.7,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача' });
    expect(intent.confidence).toBe(0.7);
  });

  it('граница G1: confidence 0.699 ниже порога — сохраняется для gateChecker', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: 0.699,
        language: 'osnova',
        features: ['a'],
        appType: 'модуль',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача' });
    expect(intent.confidence).toBe(0.699);
    expect(intent.confidence).toBeLessThan(0.7);
  });

  it('границы шкалы: confidence 0 и 1 пробрасываются как числа', async () => {
    mockLlmComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        intent: 'ноль',
        confidence: 0,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const zero = await agent.parseIntent({ text: 't1' });
    expect(zero.confidence).toBe(0);

    mockLlmComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        intent: 'единица',
        confidence: 1,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const one = await agent.parseIntent({ text: 't2' });
    expect(one.confidence).toBe(1);
  });

  it('confidence как строка в JSON → подстановка 0.8 (не число)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: '0.95',
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'y' });
    expect(intent.confidence).toBe(0.8);
  });

  it('confidence: null в JSON → подстановка 0.8 (не number)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'задача',
        confidence: null,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'x' });
    expect(intent.confidence).toBe(0.8);
  });

  it('confidence: boolean в JSON → подстановка 0.8', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'задача',
        confidence: true,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'x' });
    expect(intent.confidence).toBe(0.8);
  });

  it('граница G1: confidence 0.701 строго выше порога 0.7 — сохраняется', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'чуть выше порога',
        confidence: 0.701,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача' });
    expect(intent.confidence).toBe(0.701);
    expect(intent.confidence).toBeGreaterThan(0.7);
  });

  it('низкая уверенность: расплывчатая формулировка → LLM даёт confidence около порога', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'уточнить требования',
        confidence: 0.28,
        language: 'osnova',
        features: ['vague goal'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({
      text: 'сделай что-нибудь полезное на твой вкус',
    });
    expect(intent.confidence).toBe(0.28);
    expect(intent.confidence).toBeLessThan(0.5);
  });

  it('число вне [0,1]: отрицательная confidence пробрасывается (без clamp в IntakeAgent)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: -0.05,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'y' });
    expect(intent.confidence).toBe(-0.05);
  });
});

describe('IntakeAgent.generateSpec (mock LLM)', () => {
  it('при невалидном JSON от LLM возвращает fallback spec', async () => {
    const agent = new IntakeAgent();
    const intent: OsnovaIntent = {
      intentId: 'i-low',
      description: 'описание для спека',
      features: ['x'],
      appType: 'утилита',
      constraints: {},
      confidence: 0.4,
    };
    const spec = await agent.generateSpec(intent);
    expect(spec.mainModule).toBe('main');
    expect(spec.procedures.some((p) => p.name === 'главная')).toBe(true);
    expect(spec.modules[0].description).toBe('описание для спека');
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

