/**
 * Интеграционные тесты пайплайна с mock LLM.
 * Проверяют цепочку: intake → spec → codegen → build → golden_check и gates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPipeline, compileToBuildReport } from './orchestrator';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import type { OsnovaIntent, OsnovaSpec, BuildReport, GoldenReport } from './types';
import { compileSource } from '../compiler/compiler';
import { saveTrace } from '../trace/traceStore';
import { runGoldenCheck } from '../runtime/goldenApps';
import { IntakeAgent } from '../agents/IntakeAgent';

// Mock LLM provider: возвращает заготовленные ответы для каждого агента
const createMockProvider = () => ({
  id: 'mock',
  name: 'MockLLM',
  async checkHealth() {
    return { available: true };
  },
  async listModels() {
    return [];
  },
  async complete(request: { messages: { role: string; content: string }[] }) {
    const messages = request.messages;
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';
    const systemContent = messages[0]?.role === 'system' ? (messages[0].content as string) : '';

    // IntakeAgent parseIntent: один user message с "Analyze this programming task"
    if (messages.length === 1 && content.includes('Analyze this programming task')) {
      return {
        content: JSON.stringify({
          intent: 'Посчитать сумму чисел от 1 до 10',
          confidence: 0.95,
          language: 'osnova',
          features: ['arithmetic loop', 'print result'],
          params: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    // IntakeAgent generateSpec: system + user, system имеет "modules" (и "Return ONLY" или "Верни ТОЛЬКО")
    if (
      messages.length === 2 &&
      systemContent.includes('modules') &&
      (systemContent.includes('Return ONLY this JSON') || systemContent.includes('Верни ТОЛЬКО'))
    ) {
      return {
        content: JSON.stringify({
          modules: [{ name: 'Главный', description: 'Main', isMain: true }],
          mainModule: 'главная',
          types: [],
          procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
          syscalls: ['система.лог.вывести'],
          conventions: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    // OsnovaCodegenAgent: генерирует .osnova, system prompt содержит "OsnovaCodegen"
    if (systemContent.includes('OsnovaCodegen') && systemContent.includes('Syscall API')) {
      const osnovaSource = `
модуль Главный
процедура главная()
  пусть сумма = 0
  пусть счётчик = 1
  пока счётчик <= 10
    сумма = сумма + счётчик
    счётчик = счётчик + 1
  конец
  система.лог.вывести(сумма)
  вернуть сумма
конец
`.trim();
      return {
        content: osnovaSource,
        model: 'mock',
        done: true,
      };
    }

    // RepairEngineer (если вызовут)
    const osnovaRepair = `
модуль Главный
процедура главная()
  пусть сумма = 0
  пусть счётчик = 1
  пока счётчик <= 10
    сумма = сумма + счётчик
    счётчик = счётчик + 1
  конец
  система.лог.вывести(сумма)
  вернуть сумма
конец
`.trim();
    return {
      content: osnovaRepair,
      model: 'mock',
      done: true,
    };
  },
  async completeStream() {
    throw new Error('completeStream not used in pipeline');
  },
});

vi.mock('../llm/index', () => ({
  getLLMProvider: () => createMockProvider(),
  DEFAULT_PROVIDER: 'qwen-cli',
  getDefaultModel: () => 'mock',
  PROVIDER_DEFAULT_MODEL: {},
}));

vi.mock('../trace/traceStore', () => ({
  saveTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../runtime/goldenApps');
vi.mock('../agents/IntakeAgent', async () => {
  const actual = await vi.importActual('../agents/IntakeAgent');
  return actual;
});

describe('Pipeline integration (mock LLM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runPipeline: task → success with mock LLM', async () => {
    vi.mocked(runGoldenCheck).mockResolvedValueOnce({
      executed: true,
      passed: true,
      qualityScore: 0.9,
      vmErrors: [],
      outputDiff: null,
      durationMs: 10,
    });

    const result = await runPipeline('посчитай сумму от 1 до 10');

    expect(result.status).toBe('success');
    expect(result.intent).toBeDefined();
    expect(result.intent?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.spec).toBeDefined();
    expect(result.spec?.mainModule).toBe('главная');
    expect(result.source).toBeDefined();
    expect(result.source?.source).toContain('модуль');
    expect(result.source?.source).toContain('процедура');
    expect(result.buildReport?.success).toBe(true);
    expect(result.goldenReport?.executed).toBe(true);
    expect(result.repairAttempts).toBe(0);
    expect(vi.mocked(saveTrace)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: expect.any(String) }),
    );
  }, 15000);

  it('runPipeline: partial — qualityScore в [0.5, 0.7)', async () => {
    // mock goldenCheck возвращает qualityScore=0.6 → ожидаем статус partial
    vi.mocked(runGoldenCheck).mockResolvedValueOnce({
      executed: true,
      passed: false,
      qualityScore: 0.6,
      vmErrors: [],
      outputDiff: 'minor diff',
      durationMs: 10,
    });

    const result = await runPipeline('тест partial');
    expect(result.status).toBe('partial');
  });

  it('runPipeline: repair_exhausted — G3 всегда падает', async () => {
    // mock goldenCheck всегда возвращает qualityScore=0.1 → repair loop исчерпывается
    vi.mocked(runGoldenCheck).mockResolvedValue({
      executed: true,
      passed: false,
      qualityScore: 0.1,
      vmErrors: [{ message: 'wrong output' }],
      outputDiff: 'big diff',
      durationMs: 10,
    });

    const result = await runPipeline('тест repair_exhausted');
    expect(result.status).toBe('repair_exhausted');
  });

  it('runPipeline: failure — G1 падает при пустых features', async () => {
    // mock IntakeAgent возвращает intent с features=[] → G1 блокирует
    vi.spyOn(IntakeAgent.prototype, 'parseIntent').mockResolvedValueOnce({
      intentId: 'test',
      description: 'тест',
      features: [],
      appType: 'утилита',
      constraints: {},
      confidence: 0.9,
    } as OsnovaIntent);

    const result = await runPipeline('тест G1 failure');
    expect(result.status).toBe('failure');
  });
});

describe('compileToBuildReport', () => {
  it('CompileResult → BuildReport: success', () => {
    const source = `
модуль t
процедура main()
  вернуть 42
конец
`.trim();
    const compileResult = compileSource(source);
    const report = compileToBuildReport(compileResult);

    expect(report.success).toBe(true);
    expect(report.bytecode).toBeTruthy();
    expect(report.lexerErrors).toHaveLength(0);
    expect(report.parserErrors).toHaveLength(0);
  });

  it('CompileResult → BuildReport: parser errors', () => {
    const source = 'модуль x\nпроцедура 123()\nконец';
    const compileResult = compileSource(source);
    const report = compileToBuildReport(compileResult);

    expect(report.success).toBe(false);
    expect(report.parserErrors.length).toBeGreaterThan(0);
  });
});

describe('Gates: G1, G2, G3', () => {
  const validIntent: OsnovaIntent = {
    intentId: 'test',
    description: 'test',
    features: ['f1'],
    appType: 'утилита',
    constraints: {},
    confidence: 0.9,
  };

  const validSpec: OsnovaSpec = {
    specId: 'test',
    modules: [{ name: 'M', description: 'd', isMain: true }],
    mainModule: 'main',
    types: [],
    procedures: [{ name: 'main', params: {}, returnType: 'Ничто' }],
    syscalls: [],
    conventions: {},
  };

  it('G1: passes with valid intent and spec', () => {
    const g1 = checkG1(validIntent, validSpec);
    expect(g1.passed).toBe(true);
    expect(g1.failedChecks).toHaveLength(0);
  });

  it('G1: passes when confidence < 0.7 for утилита (check skipped)', () => {
    const intent = { ...validIntent, confidence: 0.5 };
    const g1 = checkG1(intent, validSpec);
    expect(g1.passed).toBe(true);
  });

  it('G1: fails when confidence < 0.7 for non-утилита', () => {
    const intent = { ...validIntent, appType: 'ui_приложение', confidence: 0.5 };
    const g1 = checkG1(intent, validSpec);
    expect(g1.passed).toBe(false);
    expect(g1.failedChecks.some(c => c.includes('confidence'))).toBe(true);
  });

  it('G1: fails when no modules', () => {
    const spec = { ...validSpec, modules: [] };
    const g1 = checkG1(validIntent, spec);
    expect(g1.passed).toBe(false);
  });

  it('G2: passes with successful build', () => {
    const buildReport: BuildReport = {
      success: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      bytecode: {},
      compilerSuccess: true,
      durationMs: 10,
    };
    const g2 = checkG2(buildReport);
    expect(g2.passed).toBe(true);
  });

  it('G2: fails when parser errors', () => {
    const buildReport: BuildReport = {
      success: false,
      lexerErrors: [],
      parserErrors: [{ line: 1, column: 1, message: 'err' }],
      compilerErrors: [],
      bytecode: null,
      compilerSuccess: false,
      durationMs: 10,
    };
    const g2 = checkG2(buildReport);
    expect(g2.passed).toBe(false);
  });

  it('G3: passes when executed and quality OK', () => {
    const goldenReport: GoldenReport = {
      executed: true,
      passed: true,
      qualityScore: 0.9,
      vmErrors: [],
      outputDiff: null,
      durationMs: 10,
    };
    const g3 = checkG3(goldenReport);
    expect(g3.passed).toBe(true);
  });

  it('G3: fails when VM not executed', () => {
    const goldenReport: GoldenReport = {
      executed: false,
      passed: false,
      qualityScore: 0,
      vmErrors: [{ message: 'crash' }],
      outputDiff: null,
      durationMs: 10,
    };
    const g3 = checkG3(goldenReport);
    expect(g3.passed).toBe(false);
  });
});
