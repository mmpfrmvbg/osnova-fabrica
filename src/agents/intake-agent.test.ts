import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntakeAgent, detectAppTypeFromPrefix, parseLlmConfidence } from './IntakeAgent';
import { checkG1 } from '../pipeline/gateChecker';
import {
  type OsnovaIntent,
  type OsnovaSpec,
  SPEC_G1_CONFIDENCE_MIN,
  SPEC_INTENT_CONFIDENCE_DEFAULT,
} from '../pipeline/types';

const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn(),
}));

vi.mock('../llm/index', () => ({
  getLLMProvider: () => ({
    complete: mockLlmComplete,
  }),
}));

/** Ответ «модель не уверена»: не-JSON / пусто — в parseIntent уходит в fallbackIntent. */
function mockLlmUnusableContent(content: string) {
  return { content, model: 'mock', done: true as const };
}

beforeEach(() => {
  mockLlmComplete.mockReset();
  mockLlmComplete.mockResolvedValue(mockLlmUnusableContent('не JSON'));
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

// ─── parseLlmConfidence (граничные значения, Issues 2–4 / ATM-008) ───

describe('parseLlmConfidence', () => {
  it('Issue #2: пустая и пробельная строка → SPEC_INTENT_CONFIDENCE_DEFAULT', () => {
    expect(parseLlmConfidence('')).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence('   \t\n')).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('Issue #3: NaN / ±Infinity как число → SPEC_INTENT_CONFIDENCE_DEFAULT (не finite)', () => {
    expect(parseLlmConfidence(Number.NaN)).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence(Number.POSITIVE_INFINITY)).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence(Number.NEGATIVE_INFINITY)).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('Issue #4: не строка и не число → SPEC_INTENT_CONFIDENCE_DEFAULT', () => {
    expect(parseLlmConfidence(undefined)).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence(null)).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence({})).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
    expect(parseLlmConfidence([])).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('строка чуть ниже SPEC_G1_CONFIDENCE_MIN → число для gateChecker', () => {
    const below = SPEC_G1_CONFIDENCE_MIN - 0.001;
    expect(parseLlmConfidence(String(below))).toBeCloseTo(below, 10);
    expect(parseLlmConfidence(String(below))).toBeLessThan(SPEC_G1_CONFIDENCE_MIN);
  });

  it('строка чуть выше SPEC_G1_CONFIDENCE_MIN → число для gateChecker', () => {
    const above = SPEC_G1_CONFIDENCE_MIN + 0.001;
    expect(parseLlmConfidence(String(above))).toBeCloseTo(above, 10);
    expect(parseLlmConfidence(String(above))).toBeGreaterThan(SPEC_G1_CONFIDENCE_MIN);
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
    expect(typeof intent.intentId).toBe('string');
    expect(intent.intentId.length).toBeGreaterThan(0);
    expect(intent.constraints).toEqual({});
  });

  it('Issues #2–4: пустой content от LLM → fallbackIntent (confidence 0.5), валидный OsnovaIntent', async () => {
    mockLlmComplete.mockResolvedValue(mockLlmUnusableContent(''));
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача с пустым ответом модели' });
    expect(intent.description).toBe('задача с пустым ответом модели');
    expect(intent.confidence).toBe(0.5);
    expect(intent.features).toEqual(['задача с пустым ответом модели']);
    expect(typeof intent.intentId).toBe('string');
    expect(intent.intentId.length).toBeGreaterThan(0);
  });

  it('Issues #2–4: только пробелы в content → fallbackIntent', async () => {
    mockLlmComplete.mockResolvedValue(mockLlmUnusableContent(' \t\n '));
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'x' });
    expect(intent.confidence).toBe(0.5);
    expect(intent.description).toBe('x');
  });

  it('fallback учитывает префикс Алгоритм: и фиксирует низкую confidence 0.5 (fallbackIntent)', async () => {
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'Алгоритм: сортировка' });
    expect(intent.appType).toBe('алгоритм');
    expect(intent.confidence).toBe(0.5);
  });

  it('roles от LLM подставляются как features если features пустой (ATM-002 / G1)', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'прочитать лог',
        confidence: 0.88,
        language: 'osnova',
        features: [],
        roles: ['file read', 'logging'],
        appType: 'модуль',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача' });
    expect(intent.features).toEqual(['file read', 'logging']);
    expect(intent.confidence).toBe(0.88);
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

  it('при отсутствии confidence в JSON подставляет SPEC_INTENT_CONFIDENCE_DEFAULT', async () => {
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
    expect(intent.confidence).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
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

  it('граница G1: confidence ровно SPEC_G1_CONFIDENCE_MIN сохраняется', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'на грани',
        confidence: SPEC_G1_CONFIDENCE_MIN,
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
    expect(intent.confidence).toBe(SPEC_G1_CONFIDENCE_MIN);
  });

  it('граница G1: confidence чуть ниже SPEC_G1_CONFIDENCE_MIN — сохраняется для gateChecker', async () => {
    const below = SPEC_G1_CONFIDENCE_MIN - 0.001;
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: below,
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
    expect(intent.confidence).toBe(below);
    expect(intent.confidence).toBeLessThan(SPEC_G1_CONFIDENCE_MIN);
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

  it('confidence как числовая строка в JSON → парсится для gate G1', async () => {
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
    expect(intent.confidence).toBe(0.95);
  });

  it('confidence как нечисловая строка → SPEC_INTENT_CONFIDENCE_DEFAULT', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: 'низкая',
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
    expect(intent.confidence).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('confidence: null в JSON → подстановка SPEC_INTENT_CONFIDENCE_DEFAULT (не number)', async () => {
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
    expect(intent.confidence).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('confidence: boolean в JSON → подстановка SPEC_INTENT_CONFIDENCE_DEFAULT', async () => {
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
    expect(intent.confidence).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('граница G1: confidence чуть выше SPEC_G1_CONFIDENCE_MIN — сохраняется', async () => {
    const above = SPEC_G1_CONFIDENCE_MIN + 0.001;
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'чуть выше порога',
        confidence: above,
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
    expect(intent.confidence).toBe(above);
    expect(intent.confidence).toBeGreaterThan(SPEC_G1_CONFIDENCE_MIN);
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

  it('Issues #2–4: низкая confidence у intent + пустой content LLM → fallbackSpec', async () => {
    mockLlmComplete.mockResolvedValue(mockLlmUnusableContent(''));
    const agent = new IntakeAgent();
    const intent: OsnovaIntent = {
      intentId: 'i-very-low',
      description: 'неясная постановка',
      features: ['vague'],
      appType: 'утилита',
      constraints: {},
      confidence: 0.18,
    };
    const spec = await agent.generateSpec(intent);
    expect(spec.mainModule).toBe('main');
    expect(spec.modules).toHaveLength(1);
    expect(spec.modules[0].isMain).toBe(true);
    expect(spec.modules[0].description).toBe('неясная постановка');
    expect(typeof spec.specId).toBe('string');
    expect(spec.specId.length).toBeGreaterThan(0);
  });

  it('Issues #2–4: низкая confidence + не-JSON от LLM → fallbackSpec (как при сбое разбора)', async () => {
    mockLlmComplete.mockResolvedValue(mockLlmUnusableContent('низкая уверенность, без JSON'));
    const agent = new IntakeAgent();
    const intent: OsnovaIntent = {
      intentId: 'i-gate',
      description: 'для gateChecker',
      features: ['a'],
      appType: 'модуль',
      constraints: {},
      confidence: 0.22,
    };
    const spec = await agent.generateSpec(intent);
    expect(spec.mainModule).toBe('main');
    expect(intent.confidence).toBeLessThan(SPEC_G1_CONFIDENCE_MIN);
  });
});

/** Минимальный spec для checkG1 (модули + mainModule; процедуры G1 не смотрит). */
const minimalSpecForG1: OsnovaSpec = {
  specId: 'fixture-g1',
  modules: [{ name: 'Главный', description: '', isMain: true }],
  mainModule: 'Главный',
  types: [],
  procedures: [],
  syscalls: [],
  conventions: {},
};

describe('IntakeAgent × checkG1: порог SPEC_G1_CONFIDENCE_MIN и маршрутизация', () => {
  it('не-утилита: confidence чуть ниже порога → G1 падает (g1_confidence)', async () => {
    const below = SPEC_G1_CONFIDENCE_MIN - 0.001;
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'низкая уверенность',
        confidence: below,
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
    expect(intent.confidence).toBe(below);
    const g1 = checkG1(intent, minimalSpecForG1);
    expect(g1.passed).toBe(false);
    expect(g1.failedChecks.some((f) => f.startsWith('g1_confidence'))).toBe(true);
  });

  it('не-утилита: confidence ровно на пороге → G1 проходит по confidence', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'на пороге',
        confidence: SPEC_G1_CONFIDENCE_MIN,
        language: 'osnova',
        features: ['a'],
        appType: 'библиотека',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'задача' });
    const g1 = checkG1(intent, minimalSpecForG1);
    expect(g1.passed).toBe(true);
    expect(g1.failedChecks.some((f) => f.startsWith('g1_confidence'))).toBe(false);
  });

  it('не-утилита: строковый confidence чуть выше порога → парсится, G1 проходит', async () => {
    const above = SPEC_G1_CONFIDENCE_MIN + 0.001;
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: String(above),
        language: 'osnova',
        features: ['a'],
        appType: 'актор',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'y' });
    expect(intent.confidence).toBeCloseTo(above, 10);
    expect(checkG1(intent, minimalSpecForG1).passed).toBe(true);
  });

  it('утилита: confidence сильно ниже порога → G1 не блокирует по confidence', async () => {
    mockLlmComplete.mockResolvedValue({
      content: JSON.stringify({
        intent: 'x',
        confidence: SPEC_G1_CONFIDENCE_MIN - 0.2,
        language: 'osnova',
        features: ['a'],
        appType: 'утилита',
        params: {},
      }),
      model: 'mock',
      done: true,
    });
    const agent = new IntakeAgent();
    const intent = await agent.parseIntent({ text: 'z' });
    expect(intent.confidence).toBeLessThan(SPEC_G1_CONFIDENCE_MIN);
    expect(checkG1(intent, minimalSpecForG1).passed).toBe(true);
  });

  it('mock LLM: два parseIntent подряд — детерминированные score/features/appType (intentId разный)', async () => {
    const payload = {
      content: JSON.stringify({
        intent: 'same',
        confidence: SPEC_G1_CONFIDENCE_MIN + 0.05,
        language: 'osnova',
        features: ['f1', 'f2'],
        appType: 'актор',
        params: {},
      }),
      model: 'mock',
      done: true as const,
    };
    mockLlmComplete.mockResolvedValue(payload);
    const agent = new IntakeAgent();
    const a = await agent.parseIntent({ text: 'одинаковый ввод' });
    const b = await agent.parseIntent({ text: 'одинаковый ввод' });
    expect(a.confidence).toBe(b.confidence);
    expect(a.description).toBe(b.description);
    expect(a.features).toEqual(b.features);
    expect(a.appType).toBe(b.appType);
    expect(checkG1(a, minimalSpecForG1).passed).toBe(checkG1(b, minimalSpecForG1).passed);
    expect(a.intentId).not.toBe(b.intentId);
    expect(mockLlmComplete).toHaveBeenCalledTimes(2);
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

