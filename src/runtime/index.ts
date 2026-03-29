/**
 * Публичная точка входа рантайма VM / интерпретатора.
 * Из `./vm` — OsVbcVM и пайплайн; из `./interpreter` — runProgram, loadModule, Interpreter, VM (то же исполнение, что под капотом у `vm.ts`).
 * Импорт из `../runtime`, `./vm` или `./interpreter` даёт согласованную поверхность.
 */
import type { OsVbcVMOptions, OsVbcExecuteOptions } from "./vm";
import type { OsVbcModule } from "./vm/bytecode";

export * from "./vm";
export { Interpreter, InterpreterError, runProgram, loadModule, VM } from "./interpreter";
export type { RunProgramOptions, TryFrame } from "./interpreter";

// ─── Типы пайплайна (pipeline/types.ts) ───

export type {
  PipelineResult,
  PipelineStatus,
  PipelineTracePersistedStatus,
  PipelinePhase,
  ExecutionPlan,
  PlanStep,
  OsnovaSpec,
  OsnovaIntent,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  DiagnosticCode,
  DiagnosticStatus,
  DiagnosticReport,
  DiagnosticPipelineStatus,
} from "../pipeline/types";

export {
  PIPELINE_STATUS_FOR_DIAGNOSTIC,
  DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS,
  ALL_DIAGNOSTIC_CODES,
  ALL_DIAGNOSTIC_PIPELINE_STATUSES,
  SPEC_G1_CONFIDENCE_MIN,
  SPEC_QUALITY_PASS,
  SPEC_QUALITY_PARTIAL,
  is015DiagnosticCode,
  isFBK016DiagnosticCode,
  is015DiagnosticPipelineStatus,
  isFBK016DiagnosticPipelineStatus,
  pipelineStatusFromDiagnosticCode,
  diagnosticCodeFromPipelineStatus,
  toPipelineTracePersistedStatus,
} from "../pipeline/types";

/** Ошибка валидации runtime конфигурации. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

/**
 * Валидирует опции VM перед запуском.
 * @throws {RuntimeConfigError} При невалидной конфигурации.
 */
export function validateVmOptions(opts: OsVbcVMOptions): void {
  if (opts.maxSteps !== undefined && (!Number.isInteger(opts.maxSteps) || opts.maxSteps <= 0)) {
    throw new RuntimeConfigError("maxSteps должен быть положительным целым числом");
  }
}

/**
 * Валидирует опции выполнения VM.
 * @throws {RuntimeConfigError} При невалидной конфигурации.
 */
export function validateExecuteOptions(opts: OsVbcExecuteOptions): void {
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new RuntimeConfigError("timeoutMs должен быть конечным положительным числом");
  }
  if (opts.args !== undefined && !Array.isArray(opts.args)) {
    throw new RuntimeConfigError("args должен быть массивом");
  }
}

/**
 * Валидирует байткод модуля.
 * @throws {RuntimeConfigError} При невалидном модуле.
 */
export function validateBytecode(module: unknown): asserts module is OsVbcModule {
  if (!module || typeof module !== "object") {
    throw new RuntimeConfigError("Модуль должен быть объектом");
  }
  if (!("instructions" in module) || !Array.isArray(module.instructions)) {
    throw new RuntimeConfigError("Модуль должен содержать instructions");
  }
}

/**
 * Полная валидация runtime конфигурации.
 * @throws {RuntimeConfigError} При невалидной конфигурации.
 */
export function validateRuntimeConfig(
  module: unknown,
  vmOpts?: OsVbcVMOptions,
  execOpts?: OsVbcExecuteOptions,
): void {
  validateBytecode(module);
  if (vmOpts) validateVmOptions(vmOpts);
  if (execOpts) validateExecuteOptions(execOpts);
}
