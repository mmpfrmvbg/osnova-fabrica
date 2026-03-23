/**
 * Тест partial: при qualityScore в [0.5, 0.7) pipeline возвращает status partial без repair.
 */
import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from './orchestrator';

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

    if (messages.length === 1 && content.includes('Analyze this programming task')) {
      return {
        content: JSON.stringify({
          intent: 'Тест',
          confidence: 0.95,
          language: 'osnova',
          features: ['f1'],
          params: {},
        }),
        model: 'mock',
        done: true,
      };
    }
    if (messages.length === 2 && systemContent.includes('Return ONLY this JSON') && systemContent.includes('modules')) {
      return {
        content: JSON.stringify({
          modules: [{ name: 'M', description: 'd', isMain: true }],
          mainModule: 'main',
          types: [],
          procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
          syscalls: [],
          conventions: {},
        }),
        model: 'mock',
        done: true,
      };
    }
    if (systemContent.includes('OsnovaCodegen')) {
      return {
        content: `модуль M
процедура main()
  вернуть 42
конец`,
        model: 'mock',
        done: true,
      };
    }
    return { content: 'модуль M\nпроцедура main()\n  вернуть 42\nконец', model: 'mock', done: true };
  },
  async completeStream() {
    throw new Error('not used');
  },
});

vi.mock('../llm/index', () => ({
  getLLMProvider: () => createMockProvider(),
  DEFAULT_PROVIDER: 'qwen-cli',
  getDefaultModel: () => 'mock',
  PROVIDER_DEFAULT_MODEL: {},
}));

vi.mock('../runtime/goldenApps', () => ({
  runGoldenCheck: vi.fn().mockResolvedValue({
    executed: true,
    passed: false,
    qualityScore: 0.6,
    vmErrors: [],
    outputDiff: 'minor diff',
    durationMs: 10,
  }),
}));

describe('Pipeline: partial', () => {
  it('при qualityScore в [0.5, 0.7) возвращает status partial без repair', async () => {
    const result = await runPipeline('__test__partial__mock__');

    expect(result.status).toBe('partial');
    expect(result.repairAttempts).toBe(0);
  }, 15000);
});

/**
 * Тест repair-цикла: первый код не компилируется, RepairEngineer исправляет его, pipeline завершаетcя с успехом.
 */
describe('Pipeline: repair cycle', () => {
  it('при ошибке компиляции запускает RepairEngineer и завершаетcя не в error', async () => {
    const llm = await import('../llm/index');
    const originalGetProvider = llm.getLLMProvider;

    // Переменная состояния, чтобы различать первый и последующие вызовы OsnovaCodegen/RepairEngineer
    let codegenCalls = 0;

    // Переопределим провайдера на время теста
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (llm as any).getLLMProvider = () => ({
      id: 'mock-repair',
      name: 'MockRepairLLM',
      async checkHealth() {
        return { available: true };
      },
      async listModels() {
        return [];
      },
      async complete(req: { messages: { role: string; content: string }[] }) {
        const messages = req.messages;
        const systemContent =
          messages[0]?.role === 'system' ? (messages[0].content as string) : '';

        // generateSpec (Intake): валидный spec — иначе checkSpec (T-7) отклонит пустые procedures
        if (
          messages.length === 2 &&
          systemContent.includes('модули') &&
          systemContent.includes('JSON')
        ) {
          return {
            content: JSON.stringify({
              modules: [{ name: 'M', description: 'd', isMain: true }],
              mainModule: 'M',
              types: [],
              procedures: [{ name: 'главная', params: {}, returnType: 'Логический' }],
              syscalls: [],
              conventions: {},
            }),
            model: 'mock-repair',
            done: true,
          };
        }

        // OsnovaCodegen: первый вызов — вернуть заведомо невалидный код,
        // чтобы build упал и запустился repair.
        if (systemContent.includes('OsnovaCodegen')) {
          codegenCalls += 1;
          if (codegenCalls === 1) {
            return {
              content: 'это невалидный код на языке Основа',
              model: 'mock-repair',
              done: true,
            };
          }
          // Вторая и последующие генерации — валидный минимальный модуль
          return {
            content: [
              'модуль M',
              'процедура главная()',
              '  вернуть 0',
              'конец',
              'конец',
              '',
            ].join('\n'),
            model: 'mock-repair',
            done: true,
          };
        }

        // RepairEngineer: возвращаем такой же валидный модуль
        if (systemContent.includes('RepairEngineer')) {
          return {
            content: [
              'модуль M',
              'процедура главная()',
              '  вернуть 0',
              'конец',
              'конец',
              '',
            ].join('\n'),
            model: 'mock-repair',
            done: true,
          };
        }

        // Intake/spec оставляем семантически без изменений,
        // используем простую заглушку чтобы не нарушать формат.
        return {
          content: messages[messages.length - 1]?.content ?? '',
          model: 'mock-repair',
          done: true,
        };
      },
      async completeStream() {
        throw new Error('not used');
      },
    });

    const _saveTraceSpy = vi.spyOn(await import('../trace/traceStore'), 'saveTrace' as never);

    const result = await runPipeline('тест repair-цикла');

    // Восстановим исходный провайдер
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(llm as any).getLLMProvider = originalGetProvider;

    expect(result.repairAttempts ?? 0).toBeGreaterThanOrEqual(1);
    expect(['success', 'partial']).toContain(result.status);

    expect(_saveTraceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repairAttempts: expect.any(Number),
      }),
    );
  }, 30000);
});

describe('Pipeline: A-3 — success с non-blocking semanticErrors НЕ является аномалией', () => {
  it('при non-blocking semanticErrors + golden passed → status=success', async () => {
    const { compileToBuildReport, hasBlockingSemanticErrors } = await import('./orchestrator');

    const mockCompileResult = {
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind: 'non_blocking_warning', message: 'предупреждение' }],
      module: {},
      durationMs: 1,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = compileToBuildReport(mockCompileResult as any);
    expect(hasBlockingSemanticErrors(report)).toBe(false);
    expect(report.semanticErrors!.length).toBe(1);
    expect(report.success).toBe(true);
    expect(report.semanticErrorCount).toBe(1);
  });

  it('при BLOCKING semanticError → status=partial (не success)', async () => {
    const { BLOCKING_SEMANTIC_KINDS } = await import('./semanticKinds');
    const { compileToBuildReport, hasBlockingSemanticErrors } = await import('./orchestrator');
    const blockingKind = BLOCKING_SEMANTIC_KINDS[0]!;

    const mockCompileResult = {
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind: blockingKind, message: 'blocking error' }],
      module: {},
      durationMs: 1,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = compileToBuildReport(mockCompileResult as any);
    expect(hasBlockingSemanticErrors(report)).toBe(true);
    expect(report.success).toBe(false);
    expect(report.semanticErrorCount).toBe(1);
  });
});

describe('A-2: extractLastErrorKind', () => {
  it('undefined buildReport → "unknown"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    expect(extractLastErrorKind(undefined)).toBe('unknown');
  });

  it('пустой buildReport без ошибок → "unknown"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const report = {
      success: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      bytecode: null,
      compilerSuccess: true,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe('unknown');
  });

  it('lexer error → "lexer_error"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const report = {
      success: false,
      lexerErrors: [{ line: 1, column: 1, message: 'err' }],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      bytecode: null,
      compilerSuccess: false,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe('lexer_error');
  });

  it('blocking semantic error → возвращает kind', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const { BLOCKING_SEMANTIC_KINDS } = await import('./semanticKinds');
    const kind = BLOCKING_SEMANTIC_KINDS[0]!;
    const report = {
      success: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind, message: 'block' }],
      bytecode: null,
      compilerSuccess: false,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe(kind);
  });
});

