// ============================================================
// src/agents/exec-agent.ts — ExecAgent: пошаговое выполнение плана
// ============================================================

import { PlanAgent, PlanValidationError, type ExecutionPlan, type PipelinePhase, type PlanStep } from './plan-agent';
import type { BuildReport, GoldenReport, OsnovaIntent, OsnovaSpec, OsnovaSource } from '../pipeline/types';
import type { AgentReport, BaseAgent } from '../types/agents';
import {
  OsVbcVM,
  createPipelineVmFromSpec,
  safeExecutePipelineVm,
  type OsVbcExecuteOptions,
  type PipelineVmExecuteResult,
} from '../runtime/vm';

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
  if (patch.intent !== undefined) ctx.intent = patch.intent;
  if (patch.spec !== undefined) ctx.spec = patch.spec;
  if (patch.source !== undefined) ctx.source = patch.source;
  if (patch.buildReport !== undefined) ctx.buildReport = patch.buildReport;
  if (patch.goldenReport !== undefined) ctx.goldenReport = patch.goldenReport;
  if (patch.repairAttempts !== undefined) ctx.repairAttempts = patch.repairAttempts;
}

function normalizeStepFailureMessage(
  phase: PlanStep['phase'],
  order: number,
  explicit?: string,
): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return `step failed: ${phase} (order ${order})`;
}

/**
 * Собирает {@link OsVbcVM} из накопленного контекста после фазы build: bytecode в
 * {@link ExecContext.buildReport} и тот же {@link ExecContext.spec}, что накопил исполнитель шагов.
 * Делегирует {@link createPipelineVmFromSpec} — единая точка привязки spec к VM (globals + invoke).
 *
 * @returns `null`, если нет spec, bytecode или модуль не проходит валидацию байткода.
 */
export function createPipelineVmFromExecContext(ctx: ExecContext): OsVbcVM | null {
  const spec = ctx.spec;
  const bytecode = ctx.buildReport?.bytecode;
  if (!spec || bytecode == null) {
    return null;
  }
  return createPipelineVmFromSpec(spec, bytecode);
}

/** Если {@link createPipelineVmFromExecContext} вернул бы `null` — то же сообщение в {@link safeExecutePipelineVmFromExecContext}. */
export const EXEC_CONTEXT_VM_UNAVAILABLE =
  'ExecContext: нет spec или bytecode, либо байткод не является валидным модулем OsVbc';

/**
 * Собирает VM из накопленного {@link ExecContext} (после build) и выполняет процедуру через
 * {@link safeExecutePipelineVm} — единая точка интеграции ExecAgent ↔ runtime без throw из VM.
 */
export async function safeExecutePipelineVmFromExecContext(
  ctx: ExecContext,
  opts?: OsVbcExecuteOptions,
): Promise<PipelineVmExecuteResult> {
  const vm = createPipelineVmFromExecContext(ctx);
  if (!vm) {
    return { ok: false, error: EXEC_CONTEXT_VM_UNAVAILABLE };
  }
  return safeExecutePipelineVm(vm, opts);
}

export class ExecAgent implements BaseAgent {
  private lastExec: ExecResult | null = null;

  constructor(private readonly planAgent: PlanAgent = new PlanAgent()) {}

  /**
   * Один шаг плана: `runPhase(phase, step, ctx)` для любой {@link PipelinePhase}.
   * Patch в контекст применяется только при `ok: true`.
   */
  async executeStep(
    step: PlanStep,
    runPhase: PhaseRunner,
    state: ExecContext,
  ): Promise<{ readonly stepResult: ExecStepResult; readonly stop: boolean; readonly fatalError?: string }> {
    const t0 = Date.now();
    let outcome: PhaseRunResult;
    try {
      outcome = await runPhase(step.phase, step, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stepResult: {
          phase: step.phase,
          order: step.order,
          ok: false,
          durationMs: Date.now() - t0,
          error: message,
        },
        stop: true,
        fatalError: message,
      };
    }

    const durationMs = Date.now() - t0;

    if (outcome.ok) {
      applyPatch(state, outcome.patch);
      return {
        stepResult: {
          phase: step.phase,
          order: step.order,
          ok: true,
          durationMs,
        },
        stop: false,
      };
    }

    const errMsg = normalizeStepFailureMessage(step.phase, step.order, outcome.error);
    return {
      stepResult: {
        phase: step.phase,
        order: step.order,
        ok: false,
        durationMs,
        error: errMsg,
      },
      stop: true,
      fatalError: errMsg,
    };
  }

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
      const { stepResult, stop, fatalError } = await this.executeStep(step, runPhase, state);
      steps.push(stepResult);

      if (stop) {
        const out: ExecResult = {
          planId: plan.planId,
          completed: false,
          stoppedAtPhase: step.phase,
          steps,
          state,
          error: fatalError,
        };
        this.lastExec = out;
        return out;
      }
    }

    const done: ExecResult = {
      planId: plan.planId,
      completed: true,
      steps,
      state,
    };
    this.lastExec = done;
    return done;
  }

  /**
   * Проверяет структуру плана (как перед execute).
   */
  validate(input: unknown, _ctx?: unknown, _plan?: unknown): void {
    const plan = input as ExecutionPlan;
    if (!plan || typeof plan !== 'object' || !('planId' in plan)) {
      throw new PlanValidationError('validate: ожидается ExecutionPlan', 'validate');
    }
    this.planAgent.validatePlan(plan);
  }

  /**
   * Выполняет план: `{ plan, runPhase, initialContext? }`.
   */
  async run(input?: unknown): Promise<ExecResult> {
    const p = input as {
      plan: ExecutionPlan;
      runPhase: PhaseRunner;
      initialContext?: Partial<Omit<ExecContext, 'repairAttempts'>> & { repairAttempts?: number };
    };
    if (!p?.plan || typeof p.runPhase !== 'function') {
      throw new PlanValidationError('run: ожидается { plan, runPhase, initialContext? }', 'run');
    }
    return this.execute(p.plan, p.runPhase, p.initialContext ?? {});
  }

  report(): AgentReport {
    if (!this.lastExec) {
      return { ok: false, summaryText: '[ExecAgent] execute/run ещё не вызывались' };
    }
    const e = this.lastExec;
    return {
      ok: e.completed,
      summaryText: `[ExecAgent] planId=${e.planId} completed=${e.completed}${e.error ? ` error=${e.error}` : ''}`,
    };
  }
}

export type { AgentReport, BaseAgent } from '../types/agents';
export type { PipelineVmExecuteResult };
export { safeExecutePipelineVm } from '../runtime/vm';
