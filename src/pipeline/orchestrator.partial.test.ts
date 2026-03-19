/**
 * Тест partial_success: при qualityScore в [0.5, 0.7) pipeline возвращает status partial без repair.
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
          procedures: [{ name: 'main', params: {}, returnType: 'Ничто' }],
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

describe('Pipeline: partial_success', () => {
  it('при qualityScore в [0.5, 0.7) возвращает status partial без repair', async () => {
    const result = await runPipeline('тест');

    expect(result.status).toBe('partial');
    expect(result.repairAttempts).toBe(0);
  }, 15000);
});

/**
 * Тест repair-цикла: первый код не компилируется, RepairEngineer исправляет его, pipeline завершаетcя с успехом.
 */
describe('Pipeline: repair cycle', () => {
  it('при ошибке компиляции запускает RepairEngineer и завершаетcя не в failure', async () => {
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

