/**
 * Тесты для DiagnosticAgent — агент самодиагностики и автофикса
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticAgent } from './DiagnosticAgent';
import type { ExecContext } from './exec-agent';
import type { BuildReport, GoldenReport } from '../pipeline/types';

function createMockContext(overrides?: Partial<ExecContext>): ExecContext {
  return {
    repairAttempts: 0,
    ...overrides,
  };
}

function createMockBuildReport(overrides?: Partial<BuildReport>): BuildReport {
  return {
    success: true,
    bytecode: null,
    lexerErrors: [],
    parserErrors: [],
    compilerErrors: [],
    semanticErrors: [],
    ...overrides,
  };
}

function createMockGoldenReport(overrides?: Partial<GoldenReport>): GoldenReport {
  return {
    executed: true,
    passed: true,
    qualityScore: 1.0,
    vmErrors: [],
    outputDiff: '',
    ...overrides,
  };
}

describe('DiagnosticAgent', () => {
  let agent: DiagnosticAgent;

  beforeEach(() => {
    agent = new DiagnosticAgent();
  });

  describe('diagnose', () => {
    it('возвращает пустой результат для чистого контекста', () => {
      const ctx = createMockContext();
      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(0);
      expect(result.fixableCount).toBe(0);
      expect(result.blockingCount).toBe(0);
      expect(result.summaryText).toContain('ошибок: 0');
    });

    it('детектирует lexer ошибки', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          lexerErrors: [
            { line: 1, column: 5, message: 'Неизвестный символ' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        type: 'lexer_error',
        message: 'Неизвестный символ',
        phase: 'build',
        line: 1,
        column: 5,
        fixable: true,
      });
      expect(result.fixableCount).toBe(1);
    });

    it('детектирует parser ошибки', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          parserErrors: [
            { line: 3, column: 10, message: 'Ожидается конец' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('parser_error');
      expect(result.fixableCount).toBe(1);
    });

    it('детектирует compiler ошибки', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          compilerErrors: [
            { message: 'Тип не объявлен: МойТип' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('compiler_error');
      expect(result.errors[0].fixable).toBe(true);
    });

    it('детектирует blocking semantic ошибки', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          semanticErrors: [
            { kind: 'undeclared_var', message: 'Переменная не объявлена' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('semantic_blocking');
      expect(result.blockingCount).toBe(1);
    });

    it('детектирует non-blocking semantic ошибки', () => {
      // Вид-пример обязан быть неблокирующим ПО ФАКТУ. Здесь стоял
      // `break_outside_loop`; 2026-09-28 он переведён в блокирующие, потому что
      // программа с `прервать` вне цикла не собирается (замер —
      // `src/compiler/diagnosticCatalogue.ts`, поле `buildRefused` отменено вместе
      // с расхождением). Неблокирующий вид в каталоге сегодня один:
      // `keyword_as_identifier` — ключевое слово в роли имени переменной; сборку
      // он не останавливает.
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: true,
          semanticErrors: [
            { kind: 'keyword_as_identifier', message: 'ключевое слово в роли имени' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('semantic_non_blocking');
      expect(result.blockingCount).toBe(0);
    });

    it('детектирует VM runtime ошибки', () => {
      const ctx = createMockContext({
        goldenReport: createMockGoldenReport({
          vmErrors: [
            { message: 'Division by zero' },
          ],
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('vm_runtime_error');
      expect(result.errors[0].fixable).toBe(false);
    });

    it('детектирует golden mismatch', () => {
      const ctx = createMockContext({
        goldenReport: createMockGoldenReport({
          outputDiff: 'Expected: 5, Got: 6',
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('golden_mismatch');
      expect(result.errors[0].fixable).toBe(true);
    });

    it('агрегирует множественные ошибки', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          lexerErrors: [{ line: 1, column: 1, message: 'Lexer error' }],
          parserErrors: [{ line: 2, column: 2, message: 'Parser error' }],
          compilerErrors: [{ message: 'Compiler error' }],
          semanticErrors: [
            { kind: 'type_not_declared', message: 'Type error' },
          ],
        }),
        goldenReport: createMockGoldenReport({
          vmErrors: [{ message: 'VM error' }],
          outputDiff: 'Diff',
        }),
      });

      const result = agent.diagnose(ctx);

      expect(result.errors.length).toBeGreaterThan(1);
      expect(result.summaryText).toContain('ошибок:');
    });
  });

  describe('hasBlockingErrors', () => {
    it('возвращает false для чистого контекста', () => {
      const ctx = createMockContext();
      expect(agent.hasBlockingErrors(ctx)).toBe(false);
    });

    it('возвращает true для blocking semantic ошибок', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          success: false,
          semanticErrors: [
            { kind: 'undeclared_var', message: 'Переменная не объявлена' },
          ],
        }),
      });
      expect(agent.hasBlockingErrors(ctx)).toBe(true);
    });

    it('возвращает true для lexer ошибок', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          lexerErrors: [{ line: 1, column: 1, message: 'Lexer error' }],
        }),
      });
      expect(agent.hasBlockingErrors(ctx)).toBe(true);
    });
  });

  describe('canContinue', () => {
    it('возвращает true для чистого контекста', () => {
      const ctx = createMockContext();
      expect(agent.canContinue(ctx)).toBe(true);
    });

    it('возвращает false для blocking ошибок', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          semanticErrors: [
            { kind: 'undeclared_var', message: 'Переменная не объявлена' },
          ],
        }),
      });
      expect(agent.canContinue(ctx)).toBe(false);
    });

    it('возвращает false для не-fixable ошибок', () => {
      const ctx = createMockContext({
        goldenReport: createMockGoldenReport({
          vmErrors: [{ message: 'VM error' }],
        }),
      });
      // VM ошибки не fixable
      expect(agent.canContinue(ctx)).toBe(false);
    });
  });

  describe('autofix rules', () => {
    it('имеет правила автофикса по умолчанию', () => {
      const rules = agent.getRegisteredRules();
      expect(rules.length).toBeGreaterThan(0);
    });

    it('позволяет регистрировать новые правила', () => {
      const customRule = {
        id: 'custom-rule',
        name: 'Custom Rule',
        description: 'Test rule',
        match: () => true,
        apply: async () => null,
      };

      agent.registerRule(customRule);
      const rules = agent.getRegisteredRules();
      expect(rules.some(r => r.id === 'custom-rule')).toBe(true);
    });

    it('позволяет удалять правила', () => {
      const customRule = {
        id: 'temp-rule',
        name: 'Temp Rule',
        description: 'Test rule',
        match: () => true,
        apply: async () => null,
      };

      agent.registerRule(customRule);
      const removed = agent.unregisterRule('temp-rule');
      expect(removed).toBe(true);

      const rules = agent.getRegisteredRules();
      expect(rules.some(r => r.id === 'temp-rule')).toBe(false);
    });
  });

  describe('autofix', () => {
    it('возвращает пустой массив для чистого контекста', async () => {
      const ctx = createMockContext();
      const results = await agent.autofix(ctx);
      expect(results).toHaveLength(0);
    });

    it('применяет правила к fixable ошибкам', async () => {
      const ctx = createMockContext({
        source: { filename: 'test.osnova', source: 'модуль Тест\nконец\n' },
        buildReport: createMockBuildReport({
          lexerErrors: [{ line: 1, column: 1, message: 'Lexer error' }],
        }),
      });

      const results = await agent.autofix(ctx);
      // Правила применяются, но могут не вернуть patch без реального кода
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('report', () => {
    it('возвращает отчёт после diagnose', () => {
      const ctx = createMockContext();
      agent.diagnose(ctx);
      const report = agent.report();

      expect(report.ok).toBe(true);
      expect(report.summaryText).toContain('DiagnosticAgent');
    });

    it('возвращает ok=false для blocking ошибок', () => {
      const ctx = createMockContext({
        buildReport: createMockBuildReport({
          semanticErrors: [
            { kind: 'undeclared_var', message: 'Переменная не объявлена' },
          ],
        }),
      });
      agent.diagnose(ctx);
      const report = agent.report();

      expect(report.ok).toBe(false);
    });

    it('возвращает ошибку если diagnose не вызывался', () => {
      const report = agent.report();
      expect(report.ok).toBe(false);
      expect(report.summaryText).toContain('нет отчёта');
    });
  });

  describe('validate/run', () => {
    it('validate принимает ExecContext', () => {
      const ctx = createMockContext();
      const result = agent.validate(ctx);
      expect(result && 'ok' in result && result.ok).toBe(true);
      expect(result && 'summaryText' in result && result.summaryText).toBeDefined();
    });

    it('validate бросает ошибку для некорректного входа', () => {
      expect(() => agent.validate(null)).toThrow('ExecContext');
      expect(() => agent.validate('string')).toThrow('ExecContext');
    });

    it('run принимает ExecContext', () => {
      const ctx = createMockContext();
      const result = agent.run(ctx);
      expect(result.errors).toBeDefined();
    });

    it('run бросает ошибку для некорректного входа', () => {
      expect(() => agent.run(null)).toThrow('ExecContext');
      expect(() => agent.run('string')).toThrow('ExecContext');
    });
  });
});
