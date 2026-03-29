// ============================================================
// src/agents/DiagnosticAgent.ts — DiagnosticAgent: самодиагностика и автофикс ошибок пайплайна
// ============================================================

import type { ExecContext, PhaseRunResult } from './exec-agent';
import type { BuildReport, GoldenReport, OsnovaSource } from '../pipeline/types';
import type { AgentReport, BaseAgent } from '../types/agents';
import { BLOCKING_SEMANTIC_KINDS, NON_BLOCKING_SEMANTIC_KINDS } from '../pipeline/semanticKinds';
import { RepairEngineerAgent } from './RepairEngineer';
import { logger } from '../logger';

const log = logger('diagnostic-agent');

/** Типы ошибок, которые может детектировать DiagnosticAgent. */
export type DiagnosticErrorType =
  | 'lexer_error'
  | 'parser_error'
  | 'compiler_error'
  | 'semantic_blocking'
  | 'semantic_non_blocking'
  | 'vm_runtime_error'
  | 'golden_mismatch'
  | 'phase_execution_error';

/** Одна ошибка диагностики. */
export interface DiagnosticError {
  readonly type: DiagnosticErrorType;
  readonly message: string;
  readonly phase?: string;
  readonly line?: number;
  readonly column?: number;
  readonly fixable: boolean;
  readonly fixRule?: string;
}

/** Результат диагностики одного состояния контекста. */
export interface DiagnosticResult {
  readonly errors: readonly DiagnosticError[];
  readonly fixableCount: number;
  readonly blockingCount: number;
  readonly summaryText: string;
}

/** Правило автофикса: предикат + функция исправления. */
export interface AutofixRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly match: (error: DiagnosticError, ctx: ExecContext) => boolean;
  readonly apply: (ctx: ExecContext, error: DiagnosticError) => Promise<PhaseRunResult['patch'] | null>;
}

/** Статус применения правила автофикса. */
export interface AutofixApplyResult {
  readonly ruleId: string;
  readonly applied: boolean;
  readonly patch?: PhaseRunResult['patch'];
  readonly error?: string;
}

const BLOCKING_SEMANTIC_KIND_SET = new Set<string>(BLOCKING_SEMANTIC_KINDS);
const NON_BLOCKING_SEMANTIC_KIND_SET = new Set<string>(NON_BLOCKING_SEMANTIC_KINDS);

/**
 * Проверка: является ли семантическая ошибка блокирующей.
 */
function isBlockingSemanticKind(kind: string): boolean {
  return BLOCKING_SEMANTIC_KIND_SET.has(kind);
}

/**
 * Проверка: является ли семантическая ошибка не-блокирующей.
 */
function isNonBlockingSemanticKind(kind: string): boolean {
  return NON_BLOCKING_SEMANTIC_KIND_SET.has(kind);
}

/**
 * DiagnosticAgent — агент самодиагностики пайплайна.
 * 
 * Обязанности:
 * 1. Детектирование ошибок в ExecContext (lexer, parser, compiler, semantic, VM, golden)
 * 2. Классификация ошибок по типу и возможности автофикса
 * 3. Применение правил автофикса из встроенного реестра
 * 4. Отчёт о диагностике для логов и трейсов
 * 
 * Интеграция: вызывается в pipeline после каждой фазы для проверки состояния.
 */
export class DiagnosticAgent implements BaseAgent {
  private lastResult: DiagnosticResult | null = null;
  private readonly repairEngineer = new RepairEngineerAgent();

  /** Реестр правил автофикса — расширяется через {@link registerRule}. */
  private readonly autofixRules: Map<string, AutofixRule> = new Map();

  constructor() {
    this.registerDefaultRules();
  }

  /** Регистрация правила автофикса. */
  registerRule(rule: AutofixRule): void {
    this.autofixRules.set(rule.id, rule);
    log.debug('rule registered', { id: rule.id, name: rule.name });
  }

  /** Снятие правила автофикса по ID. */
  unregisterRule(ruleId: string): boolean {
    const deleted = this.autofixRules.delete(ruleId);
    if (deleted) log.debug('rule unregistered', { id: ruleId });
    return deleted;
  }

  /** Получение списка зарегистрированных правил. */
  getRegisteredRules(): readonly AutofixRule[] {
    return Array.from(this.autofixRules.values());
  }

  /**
   * Диагностика состояния контекста выполнения.
   * 
   * Анализирует:
   * - buildReport: lexer, parser, compiler, semantic ошибки
   * - goldenReport: VM ошибки, расхождение с эталоном
   * - phase execution: ошибки выполнения фаз
   */
  diagnose(ctx: ExecContext): DiagnosticResult {
    const errors: DiagnosticError[] = [];

    // Диагностика BuildReport
    if (ctx.buildReport) {
      const br = ctx.buildReport;

      // Lexer errors
      for (const e of br.lexerErrors ?? []) {
        errors.push({
          type: 'lexer_error',
          message: e.message,
          phase: 'build',
          line: e.line,
          column: e.column,
          fixable: true,
          fixRule: 'syntax-correction',
        });
      }

      // Parser errors
      for (const e of br.parserErrors ?? []) {
        errors.push({
          type: 'parser_error',
          message: e.message,
          phase: 'build',
          line: e.line,
          column: e.column,
          fixable: true,
          fixRule: 'syntax-correction',
        });
      }

      // Compiler errors
      for (const e of br.compilerErrors ?? []) {
        errors.push({
          type: 'compiler_error',
          message: e.message,
          phase: 'build',
          fixable: this.isCompilerErrorFixable(e.message),
          fixRule: this.getCompilerFixRule(e.message),
        });
      }

      // Semantic errors
      for (const e of br.semanticErrors ?? []) {
        const isBlocking = isBlockingSemanticKind(e.kind);
        const isNonBlocking = isNonBlockingSemanticKind(e.kind);
        
        if (isBlocking || isNonBlocking) {
          errors.push({
            type: isBlocking ? 'semantic_blocking' : 'semantic_non_blocking',
            message: e.message,
            phase: 'build',
            fixable: this.isSemanticErrorFixable(e.kind),
            fixRule: this.getSemanticFixRule(e.kind),
          });
        }
      }
    }

    // Диагностика GoldenReport
    if (ctx.goldenReport) {
      const gr = ctx.goldenReport;

      // VM runtime errors
      for (const e of gr.vmErrors ?? []) {
        errors.push({
          type: 'vm_runtime_error',
          message: e.message,
          phase: 'golden_check',
          fixable: false, // VM ошибки требуют ручного анализа
        });
      }

      // Golden mismatch
      if (gr.outputDiff) {
        errors.push({
          type: 'golden_mismatch',
          message: `Расхождение с эталоном: ${gr.outputDiff.slice(0, 200)}${gr.outputDiff.length > 200 ? '...' : ''}`,
          phase: 'golden_check',
          fixable: true,
          fixRule: 'output-correction',
        });
      }
    }

    const fixableCount = errors.filter(e => e.fixable).length;
    const blockingCount = errors.filter(e => e.type === 'semantic_blocking').length;
    const summaryText = this.buildSummaryText(errors, fixableCount, blockingCount);

    const result: DiagnosticResult = {
      errors,
      fixableCount,
      blockingCount,
      summaryText,
    };

    this.lastResult = result;
    return result;
  }

  /**
   * Применение правил автофикса к ошибкам.
   * 
   * Проходит по всем ошибкам и применяет подходящие правила из реестра.
   * Возвращает массив результатов применения правил.
   */
  async autofix(ctx: ExecContext, diagnosticResult?: DiagnosticResult): Promise<AutofixApplyResult[]> {
    const result = diagnosticResult ?? this.lastResult ?? this.diagnose(ctx);
    const applyResults: AutofixApplyResult[] = [];

    for (const error of result.errors) {
      if (!error.fixable) continue;

      for (const rule of this.autofixRules.values()) {
        if (rule.match(error, ctx)) {
          try {
            const patch = await rule.apply(ctx, error);
            applyResults.push({
              ruleId: rule.id,
              applied: patch !== null,
              patch,
            });
            log.debug('autofix rule applied', { ruleId: rule.id, errorType: error.type });
          } catch (err) {
            applyResults.push({
              ruleId: rule.id,
              applied: false,
              error: err instanceof Error ? err.message : String(err),
            });
            log.warn('autofix rule failed', { ruleId: rule.id, error: err });
          }
          break; // Применяем только первое подходящее правило
        }
      }
    }

    return applyResults;
  }

  /**
   * Автофикс через RepairEngineer для ошибок исходного кода.
   * 
   * Использует RepairEngineerAgent для исправления .osnova кода на основе
   * ошибок компиляции/выполнения.
   */
  async autofixWithRepairEngineer(ctx: ExecContext): Promise<PhaseRunResult['patch'] | null> {
    if (!ctx.source || !ctx.buildReport) {
      return null;
    }

    const hasFixableErrors = (this.lastResult?.errors ?? []).some(e => e.fixable);
    if (!hasFixableErrors) {
      return null;
    }

    try {
      const repairedSource = await this.repairEngineer.fix(
        ctx.source,
        ctx.buildReport,
        ctx.goldenReport,
        ctx.repairAttempts + 1,
      );

      return {
        source: repairedSource,
        repairAttempts: ctx.repairAttempts + 1,
      };
    } catch (err) {
      log.error('repair engineer failed', { error: err });
      return null;
    }
  }

  validate(input: unknown): DiagnosticResult {
    if (!input || typeof input !== 'object') {
      throw new Error('DiagnosticAgent.validate: ожидается ExecContext');
    }
    return this.diagnose(input as ExecContext);
  }

  run(input?: unknown): DiagnosticResult {
    if (!input || typeof input !== 'object') {
      throw new Error('DiagnosticAgent.run: ожидается ExecContext');
    }
    return this.diagnose(input as ExecContext);
  }

  report(): AgentReport {
    if (!this.lastResult) {
      return {
        ok: false,
        summaryText: '[DiagnosticAgent] нет отчёта — вызовите diagnose',
      };
    }

    const hasBlocking = this.lastResult.blockingCount > 0;
    return {
      ok: !hasBlocking,
      summaryText: this.lastResult.summaryText,
    };
  }

  /**
   * Проверка: есть ли в контексте блокирующие ошибки.
   * 
   * Блокирующие ошибки:
   * - semantic_blocking
   * - lexer_error (препятствуют парсингу)
   * - parser_error (препятствуют компиляции)
   */
  hasBlockingErrors(ctx: ExecContext): boolean {
    const result = this.diagnose(ctx);
    return result.blockingCount > 0 || 
           result.errors.some(e => e.type === 'lexer_error' || e.type === 'parser_error');
  }

  /**
   * Проверка: можно ли продолжить выполнение пайплайна.
   * 
   * Продолжение возможно если:
   * - Нет блокирующих ошибок
   * - Или все ошибки являются fixable и могут быть исправлены
   */
  canContinue(ctx: ExecContext): boolean {
    const result = this.diagnose(ctx);
    if (result.blockingCount > 0) return false;
    
    // Если есть не-fixable ошибки — нельзя продолжать
    const nonFixableErrors = result.errors.filter(e => !e.fixable);
    return nonFixableErrors.length === 0;
  }

  // ─── Приватные методы ───

  private registerDefaultRules(): void {
    // Правило: исправление синтаксических ошибок через RepairEngineer
    this.registerRule({
      id: 'syntax-correction',
      name: 'Синтаксическая коррекция',
      description: 'Исправление ошибок лексера и парсера через RepairEngineer',
      match: (error, ctx) => {
        return (error.type === 'lexer_error' || error.type === 'parser_error') && !!ctx.source;
      },
      apply: async (ctx, error) => {
        return await this.autofixWithRepairEngineer(ctx);
      },
    });

    // Правило: исправление семантических ошибок через RepairEngineer
    this.registerRule({
      id: 'semantic-repair',
      name: 'Семантический ремонт',
      description: 'Исправление семантических ошибок через RepairEngineer',
      match: (error, ctx) => {
        return (error.type === 'semantic_blocking' || error.type === 'semantic_non_blocking') && !!ctx.source;
      },
      apply: async (ctx, error) => {
        return await this.autofixWithRepairEngineer(ctx);
      },
    });

    // Правило: исправление ошибок компилятора через RepairEngineer
    this.registerRule({
      id: 'compiler-repair',
      name: 'Ремонт компилятора',
      description: 'Исправление ошибок компилятора через RepairEngineer',
      match: (error, ctx) => {
        return error.type === 'compiler_error' && !!ctx.source && !!error.fixable;
      },
      apply: async (ctx, error) => {
        return await this.autofixWithRepairEngineer(ctx);
      },
    });

    // Правило: повторная попытка golden_check при расхождении
    this.registerRule({
      id: 'golden-retry',
      name: 'Повтор golden_check',
      description: 'Повторная попытка проверки golden при расхождении с эталоном',
      match: (error, ctx) => {
        return error.type === 'golden_mismatch' && !!ctx.goldenReport;
      },
      apply: async (ctx, error) => {
        // Сбрасываем goldenReport для повторной попытки
        return {
          goldenReport: undefined,
        };
      },
    });
  }

  private isCompilerErrorFixable(message: string): boolean {
    const fixablePatterns = [
      /не объявлен/i,
      /отсутствует.*поле/i,
      /неизвестное.*поле/i,
      /неверное число аргументов/i,
      /переменная уже объявлена/i,
    ];
    return fixablePatterns.some(pattern => pattern.test(message));
  }

  private getCompilerFixRule(message: string): string | undefined {
    if (/не объявлен/i.test(message)) return 'type-declaration';
    if (/отсутствует.*поле/i.test(message)) return 'field-addition';
    if (/неизвестное.*поле/i.test(message)) return 'field-removal';
    if (/неверное число аргументов/i.test(message)) return 'argc-correction';
    if (/переменная уже объявлена/i.test(message)) return 'var-rename';
    return 'compiler-repair';
  }

  private isSemanticErrorFixable(kind: string): boolean {
    // Все blocking и non-blocking kinds считаются исправимыми через RepairEngineer
    return BLOCKING_SEMANTIC_KIND_SET.has(kind) || NON_BLOCKING_SEMANTIC_KIND_SET.has(kind);
  }

  private getSemanticFixRule(kind: string): string | undefined {
    switch (kind) {
      case 'unknown_syscall':
        return 'syscall-correction';
      case 'undeclared_var':
        return 'var-declaration';
      case 'unknown_procedure':
        return 'procedure-declaration';
      case 'syscall_argc':
        return 'argc-correction';
      case 'redeclare_var':
        return 'var-rename';
      case 'invented_syntax':
        return 'syntax-correction';
      case 'break_outside_loop':
      case 'continue_outside_loop':
        return 'loop-construct-fix';
      case 'keyword_as_identifier':
        return 'identifier-rename';
      default:
        return 'semantic-repair';
    }
  }

  private buildSummaryText(errors: readonly DiagnosticError[], fixableCount: number, blockingCount: number): string {
    const total = errors.length;
    const header = `[DiagnosticAgent] ошибок: ${total}, исправимых: ${fixableCount}, блокирующих: ${blockingCount}`;
    
    if (errors.length === 0) {
      return `${header}\n  ✓ ошибок не обнаружено`;
    }

    const body = errors
      .slice(0, 10) // Ограничиваем вывод первыми 10 ошибками
      .map(e => {
        const status = e.fixable ? '🔧' : e.type === 'semantic_blocking' ? '🚫' : '⚠️';
        const loc = e.line != null && e.column != null ? `[${e.line}:${e.column}]` : '';
        return `  ${status} ${e.type}${loc}: ${e.message.slice(0, 80)}${e.message.length > 80 ? '...' : ''}`;
      })
      .join('\n');

    const footer = errors.length > 10 ? `\n  ... и ещё ${errors.length - 10} ошибок` : '';
    
    return `${header}\n${body}${footer}`;
  }
}
