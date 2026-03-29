// ============================================================
// src/intelligence/planner.ts — чистое ядро плана (типы пайплайна + сборка шагов)
// Контракт фаз и шагов совпадает с {@link PlanAgent} / src/pipeline/types.ts
// ============================================================

import type {
  ExecutionPlan,
  PlanAgentBuildOptions,
  PlanStep,
  PipelinePhase,
} from '../pipeline/types';

/** Псевдоним под словарь «Plan» в задачах intelligence — тот же контракт, что {@link ExecutionPlan}. */
export type Plan = ExecutionPlan;

/** Псевдоним «Step» — тот же контракт, что {@link PlanStep}. */
export type Step = PlanStep;

export type { ExecutionPlan, PlanAgentBuildOptions, PlanStep, PipelinePhase } from '../pipeline/types';

/**
 * Упорядоченные шаги линейного пайплайна (без I/O).
 * Семантика и порядок совпадают с приватным buildExecutionSteps в PlanAgent.
 */
export function buildLinearPlanSteps(options: PlanAgentBuildOptions = {}): readonly PlanStep[] {
  const fromScratch = options.fromScratch ?? false;
  const includeRepair = options.includeRepair ?? true;
  const steps: PlanStep[] = [];
  let order = 1;
  const push = (phase: PipelinePhase, description?: string): void => {
    steps.push({ phase, order: order++, description });
  };

  if (fromScratch) {
    push('intake', 'parseIntent: RawText → OsnovaIntent');
    push('spec_generation', 'generateSpec: OsnovaIntent → OsnovaSpec');
    push('g1_spec_ready', 'gate G1_spec_ready: intent+spec → готовность к codegen');
  }

  push('codegen', 'generate: OsnovaSpec → OsnovaSource');
  push('build', 'Compiler.compile → CompileResult → BuildReport');
  push('golden_check', 'runGoldenCheck');

  if (includeRepair) {
    push('repair', 'RepairEngineer loop (до лимита попыток)');
  }

  return steps;
}

/**
 * Собирает {@link ExecutionPlan} с заданными идентификаторами и теми же опциями, что у PlanAgent.buildPlan.
 */
export function buildExecutionPlanCore(
  ids: { readonly planId: string; readonly intentId: string; readonly specId: string },
  options: PlanAgentBuildOptions = {},
): ExecutionPlan {
  const fromScratch = options.fromScratch ?? false;
  const includeRepair = options.includeRepair ?? true;
  return {
    planId: ids.planId,
    intentId: ids.intentId,
    specId: ids.specId,
    fromScratch,
    steps: buildLinearPlanSteps({ fromScratch, includeRepair }),
  };
}
