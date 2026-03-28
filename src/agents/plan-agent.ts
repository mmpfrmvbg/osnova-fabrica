// ============================================================
// src/agents/plan-agent.ts — PlanAgent: план выполнения пайплайна
// OsnovaIntent / OsnovaSpec — те же контракты, что выдаёт IntakeAgent
// (parseIntent → generateSpec); идентификаторы должны совпадать с проверенным контекстом.
// ============================================================

import { randomUUID } from 'crypto';
import type { OsnovaIntent, OsnovaSpec } from '../pipeline/types';
import type { AgentReport, BaseAgent } from '../types/agents';

/** Фаза линейного пайплайна (см. orchestrator.ts). */
export type PipelinePhase =
  | 'intake'
  | 'spec_generation'
  /** Между spec и codegen: quality gate G1 (gates.yaml), до роли OsnovaCodegen. */
  | 'g1_spec_ready'
  | 'codegen'
  | 'build'
  | 'golden_check'
  | 'repair';

export interface PlanStep {
  readonly phase: PipelinePhase;
  /** Порядок выполнения, с 1. */
  readonly order: number;
  readonly description?: string;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly intentId: string;
  readonly specId: string;
  /** true — план с нуля (intake → …); false — только после готовой spec. */
  readonly fromScratch: boolean;
  readonly steps: readonly PlanStep[];
}

export interface PlanAgentBuildOptions {
  /** Включить intake и spec_generation в начало плана. По умолчанию false. */
  readonly fromScratch?: boolean;
  /** Добавить финальный шаг repair (после golden_check). По умолчанию true. */
  readonly includeRepair?: boolean;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Объект с полями intent + spec (как после цепочки IntakeAgent). */
function hasIntentAndSpec(
  x: unknown,
): x is { intent: OsnovaIntent; spec: OsnovaSpec; options?: PlanAgentBuildOptions } {
  if (!isRecord(x)) return false;
  return x.intent != null && x.spec != null;
}

/** Порядок фаз для проверки монотонности (меньше = раньше в пайплайне). */
const PHASE_RANK: Record<PipelinePhase, number> = {
  intake: 0,
  spec_generation: 1,
  g1_spec_ready: 2,
  codegen: 3,
  build: 4,
  golden_check: 5,
  repair: 6,
};

/** Допустимые переходы между фазами (зависимости: `to` требует предшествующий `from`). */
const VALID_PHASE_TRANSITIONS: ReadonlySet<string> = new Set([
  'intake→spec_generation',
  'spec_generation→g1_spec_ready',
  'g1_spec_ready→codegen',
  'codegen→build',
  'build→golden_check',
  'golden_check→repair',
]);

export function isValidPhaseTransition(from: PipelinePhase, to: PipelinePhase): boolean {
  return VALID_PHASE_TRANSITIONS.has(`${from}→${to}`);
}

export class PlanValidationError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export class PlanAgent implements BaseAgent {
  private lastPlan: ExecutionPlan | null = null;

  /**
   * Строит последовательность операций пайплайна по intent + spec.
   */
  buildPlan(
    intent: OsnovaIntent,
    spec: OsnovaSpec,
    options: PlanAgentBuildOptions = {},
  ): ExecutionPlan {
    const fromScratch = options.fromScratch ?? false;
    const includeRepair = options.includeRepair ?? true;

    this.validateInputs(intent, spec);

    const steps = this.buildExecutionSteps(fromScratch, includeRepair);

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      intentId: intent.intentId,
      specId: spec.specId,
      fromScratch,
      steps,
    };

    this.validatePlan(plan);
    this.lastPlan = plan;
    return plan;
  }

  /**
   * Проверяет пару intent+spec перед построением плана.
   * Ожидает `{ intent: OsnovaIntent, spec: OsnovaSpec }`.
   */
  validate(input: unknown, _ctx?: unknown, _plan?: unknown): void {
    if (!hasIntentAndSpec(input)) {
      throw new PlanValidationError(
        'validate: ожидается объект { intent, spec }',
        'validate',
      );
    }
    this.validateInputs(input.intent, input.spec);
  }

  /**
   * То же, что {@link buildPlan}, с сохранением для {@link report}.
   */
  run(input?: unknown): ExecutionPlan {
    if (!hasIntentAndSpec(input)) {
      throw new PlanValidationError(
        'run: ожидается { intent, spec, options? }',
        'run',
      );
    }
    return this.buildPlan(input.intent, input.spec, input.options ?? {});
  }

  report(): AgentReport {
    if (!this.lastPlan) {
      return { ok: false, summaryText: '[PlanAgent] план ещё не строился (buildPlan/run)' };
    }
    return {
      ok: true,
      summaryText: `[PlanAgent] planId=${this.lastPlan.planId} шагов=${this.lastPlan.steps.length}`,
    };
  }

  /**
   * Проверяет структуру плана: непустые id, порядок шагов, допустимая последовательность фаз.
   */
  validatePlan(plan: ExecutionPlan): void {
    if (!plan.planId?.trim()) {
      throw new PlanValidationError('plan.planId is required', 'plan_id');
    }
    if (!plan.intentId?.trim()) {
      throw new PlanValidationError('plan.intentId is required', 'intent_id');
    }
    if (!plan.specId?.trim()) {
      throw new PlanValidationError('plan.specId is required', 'spec_id');
    }
    const steps = plan.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new PlanValidationError('plan.steps must be a non-empty array', 'steps_empty');
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if (typeof s.order !== 'number' || s.order !== i + 1) {
        throw new PlanValidationError(
          `plan.steps[${i}].order must equal ${i + 1} (получено ${s.order})`,
          'step_order',
        );
      }
      if (!s.phase || !(s.phase in PHASE_RANK)) {
        throw new PlanValidationError(`invalid phase at index ${i}: ${String(s.phase)}`, 'phase');
      }
    }

    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]!.phase as PipelinePhase;
      const cur = steps[i]!.phase as PipelinePhase;
      if (!isValidPhaseTransition(prev, cur)) {
        throw new PlanValidationError(
          `invalid dependency: after ${prev} expected a valid successor, got ${cur}`,
          'step_dependency',
        );
      }
    }

    const phases = steps.map(s => s.phase);
    if (plan.fromScratch) {
      if (phases[0] !== 'intake' || phases[1] !== 'spec_generation') {
        throw new PlanValidationError(
          'fromScratch plan must start with intake → spec_generation',
          'from_scratch_prefix',
        );
      }
    } else {
      if (phases[0] !== 'codegen') {
        throw new PlanValidationError(
          'incremental plan must start with codegen',
          'incremental_start',
        );
      }
    }

    const tail = plan.fromScratch ? phases.slice(2) : phases;
    const expectedCore: PipelinePhase[] = plan.fromScratch
      ? ['g1_spec_ready', 'codegen', 'build', 'golden_check']
      : ['codegen', 'build', 'golden_check'];
    for (let i = 0; i < expectedCore.length; i++) {
      if (tail[i] !== expectedCore[i]) {
        throw new PlanValidationError(
          `expected phase ${expectedCore[i]} at position ${i}, got ${tail[i]}`,
          'expected_core',
        );
      }
    }
    const afterCore = tail.slice(expectedCore.length);
    if (afterCore.length > 1) {
      throw new PlanValidationError('at most one repair step after golden_check', 'repair_count');
    }
    if (afterCore.length === 1 && afterCore[0] !== 'repair') {
      throw new PlanValidationError('only repair may follow golden_check', 'after_golden');
    }
  }

  /**
   * Декомпозиция пайплайна на упорядоченные шаги: опционально полный intake-цикл,
   * затем codegen → build → golden_check и опционально repair.
   */
  private buildExecutionSteps(fromScratch: boolean, includeRepair: boolean): PlanStep[] {
    const steps: PlanStep[] = [];
    let order = 1;
    const push = (phase: PipelinePhase, description?: string) => {
      steps.push({ phase, order: order++, description });
    };

    if (fromScratch) {
      push('intake', 'parseIntent: RawText → OsnovaIntent');
      push('spec_generation', 'generateSpec: OsnovaIntent → OsnovaSpec');
      push('g1_spec_ready', 'gate G1_spec_ready: intent+spec → готовность к codegen');
    }

    push('codegen', 'generate: OsnovaSpec → OsnovaSource');
    push('build', 'compileSource → BuildReport');
    push('golden_check', 'runGoldenCheck');

    if (includeRepair) {
      push('repair', 'RepairEngineer loop (до лимита попыток)');
    }

    return steps;
  }

  private validateInputs(intent: OsnovaIntent, spec: OsnovaSpec): void {
    if (!intent.intentId?.trim()) {
      throw new PlanValidationError('intent.intentId is required', 'intent');
    }
    if (!spec.specId?.trim()) {
      throw new PlanValidationError('spec.specId is required', 'spec');
    }
  }
}

export type { AgentReport, BaseAgent } from '../types/agents';
