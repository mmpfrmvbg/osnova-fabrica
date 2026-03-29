/**
 * =============================================================================
 * Единый экспортный интерфейс для всех агентов пайплайна OSNOVA-FABRIKA
 * =============================================================================
 *
 * Этот файл — единственная точка импорта для работы с агентами.
 * Экспортирует:
 *   • Все классы агентов (IntakeAgent, PlanAgent, ExecAgent, ReviewAgent, OsnovaCodegenAgent, RepairEngineerAgent)
 *   • Типы и интерфейсы для работы с агентами
 *   • Вспомогательные функции и утилиты
 *   • Пространства имён для группировки (intake, plan)
 *
 * @module agents
 */

// ============================================================================
// АГЕНТЫ: КЛАССЫ
// ============================================================================

/**
 * IntakeAgent — первичная обработка входа (RawText → OsnovaIntent → OsnovaSpec)
 * @see {@link IAgent} — контракт агента первичной обработки
 */
export { IntakeAgent } from './intake-agent';

/**
 * PlanAgent — построение плана выполнения пайплайна (intent + spec → ExecutionPlan)
 */
export { PlanAgent } from './plan-agent';

/**
 * ExecAgent — пошаговое выполнение плана (ExecutionPlan → ExecResult)
 */
export { ExecAgent } from './exec-agent';

/**
 * ReviewAgent — проверка результатов выполнения пайплайна
 */
export { ReviewAgent } from './review-agent';

/**
 * OsnovaCodegenAgent — генерация кода на языке Основа (OsnovaSpec → OsnovaSource)
 */
export { OsnovaCodegenAgent } from './OsnovaCodegen';

/**
 * RepairEngineerAgent — ремонт кода на основе ошибок компиляции/выполнения
 */
export { RepairEngineerAgent } from './RepairEngineer';

/**
 * DiagnosticAgent — самодиагностика и автофикс ошибок пайплайна
 */
export { DiagnosticAgent } from './DiagnosticAgent';

// ============================================================================
// ОШИБКИ ВАЛИДАЦИИ
// ============================================================================

/**
 * Ошибка валидации входа IntakeAgent (пустой текст задачи и т.п.)
 */
export { IntakeValidationError } from './types';

/**
 * Ошибка валидации spec — выбрасывается при неполной спецификации
 */
export { SpecValidationError } from './intake-agent';

/**
 * Ошибка валидации плана выполнения
 */
export { PlanValidationError } from './plan-agent';

// ============================================================================
// ОШИБКИ ВЫПОЛНЕНИЯ
// ============================================================================

/**
 * Ошибка выполнения фазы пайплайна — выбрасывается при сбое обработчика фазы
 */
export { PhaseExecutionError } from './exec-agent';

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================================

/**
 * Детектирует тип приложения по префиксу текста задачи (детерминированный роутинг до LLM)
 */
export { detectAppTypeFromPrefix } from './intake-agent';

/**
 * Парсит confidence из JSON LLM (число или числовая строка, иначе 0.8)
 */
export { parseLlmConfidence } from './intake-agent';

/**
 * Проверка допустимости перехода между фазами пайплайна
 */
export { isValidPhaseTransition } from './plan-agent';

/**
 * Компиляция исходного кода Основа (делегат Compiler.compile)
 */
export { compileOsnovaSource } from './plan-agent';

/**
 * Форматирование ошибок компиляции в человекочитаемое сообщение
 */
export { formatCompileFailureMessage } from './plan-agent';

/**
 * Создание VM для выполнения пайплайна из ExecContext; безопасный прогон VM (в т.ч. из контекста после build)
 */
export {
  createPipelineVmFromExecContext,
  safeExecutePipelineVm,
  safeExecutePipelineVmFromExecContext,
  EXEC_CONTEXT_VM_UNAVAILABLE,
} from './exec-agent';

// ============================================================================
// ПРОСТРАНСТВА ИМЁН (grouped exports)
// ============================================================================

/**
 * Пространство имён intake — все экспорты из intake-agent
 */
export * as intake from './intake-agent';

/**
 * Пространство имён plan — все экспорты из plan-agent
 */
export * as plan from './plan-agent';

// ============================================================================
// ТИПЫ: ИНТЕРФЕЙСЫ АГЕНТОВ
// ============================================================================

/**
 * Контракт агента первичной обработки (RawText → intent → spec)
 */
export type { IAgent } from './types';

/**
 * Базовый контракт пайплайн-агента: validate → run → report
 */
export type { BaseAgent } from '../types/agents';

/**
 * Краткий отчёт агента для логов и трейсов
 */
export type { AgentReport } from '../types/agents';

// ============================================================================
// ТИПЫ: PLAN AGENT (синхронизировано с pipeline/types)
// ============================================================================

export type {
  /** Опции компиляции исходного кода */
  CompileOptions,
  /** Результат компиляции (успех/ошибки, bytecode) */
  CompileResult,
} from './plan-agent';

export type {
  /** Последовательность операций пайплайна */
  ExecutionPlan,
  /** Фаза пайплайна (intake, spec_generation, codegen, build, golden_check, repair) */
  PipelinePhase,
  /** Опции построения плана для PlanAgent */
  PlanAgentBuildOptions,
  /** Шаг плана: фаза + порядок + описание */
  PlanStep,
} from '../pipeline/types';

// ============================================================================
// ТИПЫ: EXEC AGENT (синхронизировано с pipeline/types и runtime/vm)
// ============================================================================

export type {
  /** Состояние пайплайна между шагами (накапливается при выполнении) */
  ExecContext,
  /** Синоним ExecContext — контекст выполнения шагов плана */
  ExecutionContext,
  /** Результат выполнения одной фазы (ok/error + patch контекста) */
  PhaseRunResult,
  /** Функция-обработчик фазы плана */
  PhaseRunner,
  /** Итог выполнения одного шага плана */
  ExecStepResult,
  /** Итог execute(): все шаги или остановка на первой ошибке */
  ExecResult,
} from './exec-agent';

export type {
  /** Результат выполнения VM пайплайна */
  PipelineVmExecuteResult,
} from '../runtime/vm';

// ============================================================================
// ТИПЫ: REVIEW AGENT
// ============================================================================

export type {
  /** Одна строка проверки в отчёте ReviewAgent */
  ReviewCheckItem,
  /** Итог проверки + человекочитаемый отчёт */
  ReviewReport,
} from './review-agent';

// ============================================================================
// ТИПЫ: DIAGNOSTIC AGENT
// ============================================================================

export type {
  /** Типы ошибок диагностики */
  DiagnosticErrorType,
  /** Одна ошибка диагностики */
  DiagnosticError,
  /** Результат диагностики */
  DiagnosticResult,
  /** Правило автофикса */
  AutofixRule,
  /** Результат применения правила автофикса */
  AutofixApplyResult,
} from './DiagnosticAgent';

// ============================================================================
// ЭКСПОРТ КОМПИЛЯТОРА (из plan-agent)
// ============================================================================

export { Compiler } from './plan-agent';
