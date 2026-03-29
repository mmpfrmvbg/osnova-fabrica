/**
 * PlanAgent — проверки относительно контракта шагов и полей:
 * - {@link ExecutionPlan}, {@link PlanStep}: `src/pipeline/types.ts`
 * - `BaseAgent` (validate / run): вход `{ intent, spec, options? }` — `src/types/agents.ts`
 * При `fromScratch` первые фазы плана — `intake` → `spec_generation` (до G1), в том же порядке, что цепочка IntakeAgent после порога непустого RawText.
 */
import { describe, it, expect } from 'vitest';
import { PlanAgent, PlanValidationError, type ExecutionPlan } from './plan-agent';
import { ExecAgent, type PhaseRunner } from './exec-agent';
import type { OsnovaIntent, OsnovaSpec, PlanStep } from '../pipeline/types';

/** Утверждение структуры плана по spec (`ExecutionPlan` / `PlanStep`). */
function assertPlanMatchesPipelineSpec(plan: ExecutionPlan): void {
  expect(plan.planId.trim().length).toBeGreaterThan(0);
  expect(plan.intentId.trim().length).toBeGreaterThan(0);
  expect(plan.specId.trim().length).toBeGreaterThan(0);
  expect(typeof plan.fromScratch).toBe('boolean');
  expect(Array.isArray(plan.steps)).toBe(true);
  expect(plan.steps.length).toBeGreaterThan(0);
  for (const step of plan.steps) {
    const s = step as PlanStep;
    expect(typeof s.phase).toBe('string');
    expect(typeof s.order).toBe('number');
    if (s.description !== undefined) {
      expect(typeof s.description).toBe('string');
    }
  }
}

function sampleIntent(over: Partial<OsnovaIntent> = {}): OsnovaIntent {
  return {
    intentId: 'intent-1',
    description: 'тест',
    features: ['a'],
    appType: 'утилита',
    constraints: {},
    confidence: 0.9,
    ...over,
  };
}

function sampleSpec(over: Partial<OsnovaSpec> = {}): OsnovaSpec {
  return {
    specId: 'spec-1',
    modules: [{ name: 'Главный', description: 'd', isMain: true }],
    mainModule: 'Главный',
    types: [],
    procedures: [{ name: 'главная', params: {}, returnType: 'Логический' }],
    syscalls: [],
    conventions: {},
    ...over,
  };
}

describe('PlanAgent.buildPlan', () => {
  const agent = new PlanAgent();

  it('строит инкрементальный план: codegen → build → golden_check → repair', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: true,
    });
    expect(plan.fromScratch).toBe(false);
    expect(plan.steps.map(s => s.phase)).toEqual([
      'codegen',
      'build',
      'golden_check',
      'repair',
    ]);
    expect(plan.intentId).toBe('intent-1');
    expect(plan.specId).toBe('spec-1');
    assertPlanMatchesPipelineSpec(plan);
  });

  it('без repair — три шага', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), { includeRepair: false });
    expect(plan.steps.map(s => s.phase)).toEqual(['codegen', 'build', 'golden_check']);
  });

  it('fromScratch добавляет intake и spec_generation', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    expect(plan.steps.map(s => s.phase)).toEqual([
      'intake',
      'spec_generation',
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
    ]);
    assertPlanMatchesPipelineSpec(plan);
    expect(plan.steps[0]!.phase).toBe('intake');
    expect(plan.steps[1]!.phase).toBe('spec_generation');
    expect(plan.steps[0]!.order).toBe(1);
    expect(plan.steps[1]!.order).toBe(2);
  });

  it('бросает PlanValidationError без intentId', () => {
    expect(() =>
      agent.buildPlan(sampleIntent({ intentId: '' }), sampleSpec()),
    ).toThrow(PlanValidationError);
  });

  it('бросает PlanValidationError без specId', () => {
    expect(() =>
      agent.buildPlan(sampleIntent(), sampleSpec({ specId: '  ' })),
    ).toThrow(PlanValidationError);
  });
});

describe('PlanAgent.validate / run: пустой и неполный контекст', () => {
  const agent = new PlanAgent();

  function expectValidateCode(fn: () => void, code: string): void {
    try {
      fn();
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PlanValidationError);
      expect((e as PlanValidationError).code).toBe(code);
    }
  }

  it('validate: undefined / null / {} / частичный объект — code validate', () => {
    expectValidateCode(() => agent.validate(undefined as unknown), 'validate');
    expectValidateCode(() => agent.validate(null as unknown), 'validate');
    expectValidateCode(() => agent.validate({}), 'validate');
    expectValidateCode(() => agent.validate({ intent: sampleIntent() }), 'validate');
    expectValidateCode(() => agent.validate({ spec: sampleSpec() }), 'validate');
    expectValidateCode(() => agent.validate({ intent: null, spec: sampleSpec() } as unknown), 'validate');
  });

  it('run: то же для входа — code run', () => {
    expectValidateCode(() => agent.run(undefined as unknown), 'run');
    expectValidateCode(() => agent.run(null as unknown), 'run');
    expectValidateCode(() => agent.run({}), 'run');
    expectValidateCode(() => agent.run({ intent: sampleIntent() }), 'run');
    expectValidateCode(() => agent.run({ spec: sampleSpec() }), 'run');
  });
});

describe('PlanAgent: минимальный и перегруженный контекст id', () => {
  const agent = new PlanAgent();

  it('минимальные непустые intentId/specId (один символ)', () => {
    const plan = agent.buildPlan(sampleIntent({ intentId: 'a' }), sampleSpec({ specId: 'b' }));
    expect(plan.intentId).toBe('a');
    expect(plan.specId).toBe('b');
    assertPlanMatchesPipelineSpec(plan);
  });

  it('очень длинные intentId/specId без усечения в плане', () => {
    const long = 'z'.repeat(10_000);
    const plan = agent.buildPlan(
      sampleIntent({ intentId: long }),
      sampleSpec({ specId: long }),
      { includeRepair: false },
    );
    expect(plan.intentId).toHaveLength(10_000);
    expect(plan.specId).toHaveLength(10_000);
    assertPlanMatchesPipelineSpec(plan);
  });
});

describe('PlanAgent.validatePlan', () => {
  const agent = new PlanAgent();

  it('отклоняет нарушение порядка фаз', () => {
    const bad: ExecutionPlan = {
      planId: 'p1',
      intentId: 'i1',
      specId: 's1',
      fromScratch: false,
      steps: [
        { phase: 'codegen', order: 1 },
        { phase: 'golden_check', order: 2 },
      ],
    };
    expect(() => agent.validatePlan(bad)).toThrow(PlanValidationError);
  });

  it('отклоняет неверный order', () => {
    const bad: ExecutionPlan = {
      planId: 'p1',
      intentId: 'i1',
      specId: 's1',
      fromScratch: false,
      steps: [
        { phase: 'codegen', order: 2 },
        { phase: 'build', order: 3 },
        { phase: 'golden_check', order: 4 },
      ],
    };
    expect(() => agent.validatePlan(bad)).toThrow(PlanValidationError);
  });

  it('отклоняет пустой массив шагов', () => {
    const bad: ExecutionPlan = {
      planId: 'p1',
      intentId: 'i1',
      specId: 's1',
      fromScratch: false,
      steps: [],
    };
    expect(() => agent.validatePlan(bad)).toThrow(PlanValidationError);
  });

  it('отклоняет более одного repair после golden_check', () => {
    const bad: ExecutionPlan = {
      planId: 'p1',
      intentId: 'i1',
      specId: 's1',
      fromScratch: false,
      steps: [
        { phase: 'codegen', order: 1 },
        { phase: 'build', order: 2 },
        { phase: 'golden_check', order: 3 },
        { phase: 'repair', order: 4 },
        { phase: 'repair', order: 5 },
      ],
    };
    expect(() => agent.validatePlan(bad)).toThrow(PlanValidationError);
  });
});

describe('PlanAgent: валидный план и ветки выполнения (симуляция LLM через runPhase)', () => {
  const planAgent = new PlanAgent();
  const execAgent = new ExecAgent(planAgent);

  it('построенный план проходит validatePlan (инкремент и fromScratch)', () => {
    const inc = planAgent.buildPlan(sampleIntent(), sampleSpec(), { includeRepair: true });
    expect(() => planAgent.validatePlan(inc)).not.toThrow();
    const full = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    expect(() => planAgent.validatePlan(full)).not.toThrow();
  });

  it('успешный полный прогон fromScratch: все шаги ok, completed: true', async () => {
    const intent = sampleIntent();
    const spec = sampleSpec();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    const runPhase: PhaseRunner = async (phase, _step, _ctx) => {
      if (phase === 'intake') return { ok: true, patch: { intent } };
      if (phase === 'spec_generation') return { ok: true, patch: { spec } };
      return { ok: true };
    };
    const result = await execAgent.execute(plan, runPhase, {});
    expect(result.completed).toBe(true);
    expect(result.steps.every(s => s.ok)).toBe(true);
    expect(result.steps.length).toBe(plan.steps.length);
    expect(result.state.intent).toBe(intent);
    expect(result.state.spec).toBe(spec);
  });

  it('деградация: ошибка на spec_generation (как сбой LLM) — остановка, completed: false', async () => {
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    const runPhase: PhaseRunner = async phase => {
      if (phase === 'intake') return { ok: true, patch: { intent: sampleIntent() } };
      if (phase === 'spec_generation') return { ok: false, error: 'LLM: quota exceeded' };
      return { ok: true };
    };
    const result = await execAgent.execute(plan, runPhase, {});
    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('spec_generation');
    expect(result.error).toContain('quota');
    expect(result.steps.filter(s => s.ok).length).toBe(1);
  });

  it('деградация: throw из runPhase на spec_generation — сообщение в error', async () => {
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    const runPhase: PhaseRunner = async phase => {
      if (phase === 'intake') return { ok: true, patch: { intent: sampleIntent() } };
      if (phase === 'spec_generation') throw new Error('LLM unreachable');
      return { ok: true };
    };
    const result = await execAgent.execute(plan, runPhase, {});
    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('spec_generation');
    expect(result.error).toBe('LLM unreachable');
  });

  it('пустой ответ LLM: ok:false без текста ошибки — стабильное сообщение шага', async () => {
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    const runPhase: PhaseRunner = async phase => {
      if (phase === 'intake') return { ok: true, patch: { intent: sampleIntent() } };
      if (phase === 'spec_generation') return { ok: false, error: '   ' };
      return { ok: true };
    };
    const result = await execAgent.execute(plan, runPhase, {});
    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('spec_generation');
    expect(result.error).toBe('step failed: spec_generation (order 2)');
  });

  it('инкрементальный план: сбой на codegen (LLM codegen) — первая фаза падает без предшествующих шагов', async () => {
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), { includeRepair: false });
    const runPhase: PhaseRunner = async phase => {
      if (phase === 'codegen') return { ok: false, error: '' };
      return { ok: true };
    };
    const result = await execAgent.execute(plan, runPhase, {});
    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('codegen');
    expect(result.error).toBe('step failed: codegen (order 1)');
    expect(result.steps).toHaveLength(1);
  });
});
