// ============================================================
// src/agents/exec-agent.ts — ExecAgent: пошаговое выполнение плана
// ============================================================

import { PlanAgent, type ExecutionPlan, type PipelinePhase, type PlanStep } from './plan-agent';
import type { BuildReport, GoldenReport, OsnovaIntent, OsnovaSpec, OsnovaSource } from '../pipeline/types';

/** Состояние пайплайна между шагами (накапливается при выполнении). */
export interface ExecContext {
  intent?: OsnovaIntent;
  spec?: OsnovaSpec;
  source?: OsnovaSource;
  buildReport?: BuildReport;
  goldenReport?: GoldenReport;
  repairAttempts: number;
}

/** Результат одного вызова обработчика фазы. */
export interface PhaseRunResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Слияние в контекст перед следующим шагом. */
  readonly patch?: Partial<Omit<ExecContext, 'repairAttempts'>> & { repairAttempts?: number };
}

export type PhaseRunner = (
  phase: PipelinePhase,
  step: PlanStep,
  ctx: ExecContext,
) => Promise<PhaseRunResult>;

/** Итог выполнения одного шага плана. */
export interface ExecStepResult {
  readonly phase: PipelinePhase;
  readonly order: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

/** Итог execute(): все шаги или остановка на первой ошибке. */
export interface ExecResult {
  readonly planId: string;
  readonly completed: boolean;
  readonly stoppedAtPhase?: PipelinePhase;
  readonly steps: readonly ExecStepResult[];
  readonly state: ExecContext;
  readonly error?: string;
}

function applyPatch(ctx: ExecContext, patch: PhaseRunResult['patch']): void {
  if (!patch) return;
  const p = patch as Partial<ExecContext>;
  if (p.intent !== undefined) ctx.intent = p.intent;
  if (p.spec !== undefined) ctx.spec = p.spec;
  if (p.source !== undefined) ctx.source = p.source;
  if (p.buildReport !== undefined) ctx.buildReport = p.buildReport;
  if (p.goldenReport !== undefined) ctx.goldenReport = p.goldenReport;
  if (p.repairAttempts !== undefined) ctx.repairAttempts = p.repairAttempts;
}

export class ExecAgent {
  constructor(private readonly planAgent: PlanAgent = new PlanAgent()) {}

  /**
   * Выполняет шаги плана по порядку, вызывая `runPhase` на каждую фазу.
   * При `ok: false` останавливается и возвращает `completed: false`.
   */
  async execute(
    plan: ExecutionPlan,
    runPhase: PhaseRunner,
    initialContext: Partial<Omit<ExecContext, 'repairAttempts'>> & { repairAttempts?: number } = {},
  ): Promise<ExecResult> {
    this.planAgent.validatePlan(plan);

    const state: ExecContext = {
      repairAttempts: initialContext.repairAttempts ?? 0,
      intent: initialContext.intent,
      spec: initialContext.spec,
      source: initialContext.source,
      buildReport: initialContext.buildReport,
      goldenReport: initialContext.goldenReport,
    };

    const steps: ExecStepResult[] = [];

    for (const step of plan.steps) {
      const t0 = Date.now();
      let outcome: PhaseRunResult;
      try {
        outcome = await runPhase(step.phase, step, state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          phase: step.phase,
          order: step.order,
          ok: false,
          durationMs: Date.now() - t0,
          error: message,
        });
        return {
          planId: plan.planId,
          completed: false,
          stoppedAtPhase: step.phase,
          steps,
          state,
          error: message,
        };
      }

      applyPatch(state, outcome.patch);

      steps.push({
        phase: step.phase,
        order: step.order,
        ok: outcome.ok,
        durationMs: Date.now() - t0,
        error: outcome.error,
      });

      if (!outcome.ok) {
        return {
          planId: plan.planId,
          completed: false,
          stoppedAtPhase: step.phase,
          steps,
          state,
          error: outcome.error,
        };
      }
    }

    return {
      planId: plan.planId,
      completed: true,
      steps,
      state,
    };
  }
}
