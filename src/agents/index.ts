/**
 * Barrel: публичные агенты пайплайна и типы — единая точка импорта из `src/agents`.
 * Контракты intent/spec/plan совпадают с `src/pipeline/types`; фазы — с `PlanAgent` / `ExecAgent`.
 * Цепочка intake/plan: именованные экспорты и пространства `intake` / `plan` (фасады `intake-agent`, `plan-agent`).
 */

export { IntakeAgent } from './intake-agent';
export {
  SpecValidationError,
  detectAppTypeFromPrefix,
  parseLlmConfidence,
} from './intake-agent';

export * as intake from './intake-agent';
export * as plan from './plan-agent';

export { IntakeValidationError, type IAgent } from './types';

export {
  PlanAgent,
  PlanValidationError,
  isValidPhaseTransition,
  compileOsnovaSource,
  formatCompileFailureMessage,
  Compiler,
} from './plan-agent';
export type {
  CompileOptions,
  CompileResult,
  ExecutionPlan,
  PipelinePhase,
  PlanAgentBuildOptions,
  PlanStep,
} from './plan-agent';

export {
  ExecAgent,
  createPipelineVmFromExecContext,
  safeExecutePipelineVm,
} from './exec-agent';
export type {
  ExecContext,
  PhaseRunResult,
  PhaseRunner,
  ExecStepResult,
  ExecResult,
  PipelineVmExecuteResult,
} from './exec-agent';

export { ReviewAgent } from './review-agent';
export type { ReviewCheckItem, ReviewReport } from './review-agent';

export { OsnovaCodegenAgent } from './OsnovaCodegen';
export { RepairEngineerAgent } from './RepairEngineer';

export type { AgentReport, BaseAgent } from '../types/agents';
