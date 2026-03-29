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
 * Создание VM для выполнения пайплайна из ExecContext
 */
export { createPipelineVmFromExecContext } from './exec-agent';

/**
 * Безопасное выполнение VM с обработкой ошибок
 */
export { safeExecutePipelineVm } from './exec-agent';

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
// ТИПЫ: PLAN AGENT
// ============================================================================

export type {
  /** Опции компиляции исходного кода */
  CompileOptions,
  /** Результат компиляции (успех/ошибки, bytecode) */
  CompileResult,
  /** Последовательность операций пайплайна */
  ExecutionPlan,
  /** Фаза пайплайна (intake, spec_generation, codegen, build, golden_check, repair) */
  PipelinePhase,
  /** Опции построения плана для PlanAgent */
  PlanAgentBuildOptions,
  /** Шаг плана: фаза + порядок + описание */
  PlanStep,
} from './plan-agent';

// ============================================================================
// ТИПЫ: EXEC AGENT
// ============================================================================

export type {
  /** Состояние пайплайна между шагами (накапливается при выполнении) */
  ExecContext,
  /** Результат выполнения одной фазы (ok/error + patch контекста) */
  PhaseRunResult,
  /** Функция-обработчик фазы плана */
  PhaseRunner,
  /** Итог выполнения одного шага плана */
  ExecStepResult,
  /** Итог execute(): все шаги или остановка на первой ошибке */
  ExecResult,
  /** Результат выполнения VM пайплайна */
  PipelineVmExecuteResult,
} from './exec-agent';

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
// ЭКСПОРТ КОМПИЛЯТОРА (из plan-agent)
// ============================================================================

export { Compiler } from './plan-agent';
