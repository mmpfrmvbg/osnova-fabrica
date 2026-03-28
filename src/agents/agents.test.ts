/**
 * Unit tests for IntakeAgent, PlanAgent, ExecAgent (plan execution), and ReviewAgent (result validation).
 * Complements single-file agent tests with focused validation and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { IntakeAgent, SpecValidationError } from './IntakeAgent';
import { PlanAgent, PlanValidationError } from './plan-agent';
import { ExecAgent, type ExecContext } from './exec-agent';
import { ReviewAgent } from './review-agent';
import { IntakeValidationError } from './types';
import type { OsnovaIntent, OsnovaSpec } from '../pipeline/types';

function sampleIntent(over: Partial<OsnovaIntent> = {}): OsnovaIntent {
  return {
    intentId: 'intent-agents',
    description: 'описание',
    features: ['a'],
    appType: 'утилита',
    constraints: {},
    confidence: 0.9,
    ...over,
  };
}

function sampleSpec(over: Partial<OsnovaSpec> = {}): OsnovaSpec {
  return {
    specId: 'spec-agents',
    modules: [{ name: 'Главный', description: 'd', isMain: true }],
    mainModule: 'Главный',
    types: [],
    procedures: [{ name: 'главная', params: {}, returnType: 'Логический' }],
    syscalls: [],
    conventions: {},
    ...over,
  };
}

describe('IntakeAgent — валидация входа parseIntent', () => {
  const agent = new IntakeAgent();

  it('отклоняет пустой текст', async () => {
    await expect(agent.parseIntent({ text: '' })).rejects.toThrow(IntakeValidationError);
    await expect(agent.parseIntent({ text: '' })).rejects.toMatchObject({
      field: 'text',
    });
  });

  it('отклоняет текст из одних пробелов', async () => {
    await expect(agent.parseIntent({ text: '   \t\n  ' })).rejects.toThrow(IntakeValidationError);
  });

  it('отклоняет не-строковый text', async () => {
    await expect(
      agent.parseIntent({ text: null as unknown as string }),
    ).rejects.toThrow(IntakeValidationError);
  });
});

describe('IntakeAgent — валидация входа generateSpec', () => {
  const agent = new IntakeAgent();

  it('отклоняет пустой intentId', async () => {
    await expect(agent.generateSpec(sampleIntent({ intentId: '  ' }))).rejects.toThrow(
      IntakeValidationError,
    );
  });

  it('отклоняет пустое description', async () => {
    await expect(agent.generateSpec(sampleIntent({ description: '' }))).rejects.toThrow(
      IntakeValidationError,
    );
  });

  it('отклоняет features не-массив', async () => {
    await expect(
      agent.generateSpec(sampleIntent({ features: 'x' as unknown as string[] })),
    ).rejects.toThrow(IntakeValidationError);
  });
});

describe('IntakeAgent.checkSpec — граничные случаи', () => {
  const agent = new IntakeAgent();

  it('принимает минимально полный spec', () => {
    expect(() => agent.checkSpec(sampleSpec())).not.toThrow();
  });

  it('бросает SpecValidationError если mainModule пустой', () => {
    expect(() =>
      agent.checkSpec(sampleSpec({ mainModule: '  ' })),
    ).toThrow(SpecValidationError);
  });

  it('бросает SpecValidationError если modules пустой', () => {
    expect(() => agent.checkSpec(sampleSpec({ modules: [] }))).toThrow(SpecValidationError);
  });

  it('бросает SpecValidationError если нет процедуры главная', () => {
    expect(() =>
      agent.checkSpec(
        sampleSpec({
          procedures: [{ name: 'вспомогательная', params: {}, returnType: 'пусто' }],
        }),
      ),
    ).toThrow(SpecValidationError);
  });
});

describe('PlanAgent — построение плана', () => {
  const agent = new PlanAgent();

  it('fromScratch + repair: цепочка intake → … → repair', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: true,
    });
    expect(plan.fromScratch).toBe(true);
    expect(plan.steps.map((s) => s.phase)).toEqual([
      'intake',
      'spec_generation',
      'codegen',
      'build',
      'golden_check',
      'repair',
    ]);
    expect(plan.steps.length).toBe(6);
    plan.steps.forEach((s, i) => {
      expect(s.order).toBe(i + 1);
    });
  });

  it('план содержит непустые planId, intentId, specId', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec());
    expect(plan.planId.length).toBeGreaterThan(0);
    expect(plan.intentId).toBe('intent-agents');
    expect(plan.specId).toBe('spec-agents');
  });
});

describe('PlanAgent — граничные случаи validatePlan', () => {
  const agent = new PlanAgent();

  it('fromScratch: отклоняет план без ведущего intake', () => {
    expect(() =>
      agent.validatePlan({
        planId: 'p',
        intentId: 'i',
        specId: 's',
        fromScratch: true,
        steps: [
          { phase: 'spec_generation', order: 1 },
          { phase: 'codegen', order: 2 },
          { phase: 'build', order: 3 },
          { phase: 'golden_check', order: 4 },
        ],
      }),
    ).toThrow(PlanValidationError);
  });

  it('инкрементальный план: отклоняет старт не с codegen', () => {
    expect(() =>
      agent.validatePlan({
        planId: 'p',
        intentId: 'i',
        specId: 's',
        fromScratch: false,
        steps: [
          { phase: 'build', order: 1 },
          { phase: 'golden_check', order: 2 },
          { phase: 'repair', order: 3 },
        ],
      }),
    ).toThrow(PlanValidationError);
  });
});

describe('ExecAgent.execute', () => {
  it('выполняет все шаги инкрементального плана по порядку', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const phases: string[] = [];

    const result = await exec.execute(plan, async phase => {
      phases.push(phase);
      return { ok: true };
    });

    expect(result.completed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(phases).toEqual(['codegen', 'build', 'golden_check']);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.ok)).toBe(true);
    expect(result.planId).toBe(plan.planId);
  });

  it('останавливается на первой ошибке (ok: false)', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    let n = 0;

    const result = await exec.execute(plan, async phase => {
      n++;
      if (phase === 'build') {
        return { ok: false, error: 'build failed' };
      }
      return { ok: true };
    });

    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('build');
    expect(result.error).toBe('build failed');
    expect(n).toBe(2);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.ok).toBe(true);
    expect(result.steps[1]!.ok).toBe(false);
  });

  it('обрабатывает исключение Error в runPhase', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);

    const result = await exec.execute(plan, async phase => {
      if (phase === 'codegen') {
        throw new Error('boom');
      }
      return { ok: true };
    });

    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('codegen');
    expect(result.error).toBe('boom');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.ok).toBe(false);
  });

  it('обрабатывает не-Error throw в runPhase', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);

    const result = await exec.execute(plan, async phase => {
      if (phase === 'codegen') {
        throw 'string-boom';
      }
      return { ok: true };
    });

    expect(result.completed).toBe(false);
    expect(result.error).toBe('string-boom');
  });

  it('применяет patch к контексту между шагами', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const intent = sampleIntent();
    const spec = sampleSpec();

    const result = await exec.execute(
      plan,
      async (phase, _step, ctx) => {
        if (phase === 'codegen') {
          return { ok: true, patch: { source: { filename: 'main.osnova', source: 'модуль M\nконец' } } };
        }
        if (phase === 'build') {
          expect(ctx.source?.filename).toBe('main.osnova');
          return {
            ok: true,
            patch: {
              buildReport: {
                success: true,
                lexerErrors: [],
                parserErrors: [],
                compilerErrors: [],
                bytecode: null,
                compilerSuccess: true,
                durationMs: 1,
              },
            },
          };
        }
        return { ok: true };
      },
      { intent, spec },
    );

    expect(result.completed).toBe(true);
    expect(result.state.intent).toEqual(intent);
    expect(result.state.spec).toEqual(spec);
    expect(result.state.source?.filename).toBe('main.osnova');
    expect(result.state.buildReport?.success).toBe(true);
  });

  it('бросает при невалидном плане (validatePlan)', async () => {
    const planAgent = new PlanAgent();
    const exec = new ExecAgent(planAgent);

    await expect(
      exec.execute(
        {
          planId: 'p',
          intentId: 'i',
          specId: 's',
          fromScratch: false,
          steps: [],
        },
        async () => ({ ok: true }),
      ),
    ).rejects.toThrow(PlanValidationError);
  });
});

function reviewOkCtx(over: Partial<ExecContext> = {}): ExecContext {
  const spec = sampleSpec();
  return {
    repairAttempts: 0,
    spec,
    buildReport: {
      success: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      bytecode: null,
      compilerSuccess: true,
      durationMs: 1,
    },
    goldenReport: {
      executed: true,
      passed: true,
      qualityScore: 1,
      vmErrors: [],
      outputDiff: null,
      durationMs: 2,
    },
    ...over,
  };
}

describe('ReviewAgent.validate', () => {
  const agent = new ReviewAgent();

  it('возвращает ok при согласованном spec и успешных build/golden', () => {
    const spec = sampleSpec();
    const report = agent.validate(spec, reviewOkCtx());
    expect(report.ok).toBe(true);
    expect(report.items.every(i => i.ok)).toBe(true);
    expect(report.summaryText).toContain('ReviewAgent');
    expect(report.summaryText).toContain('spec_in_context');
  });

  it('проваливает при отсутствии spec в контексте', () => {
    const spec = sampleSpec();
    const report = agent.validate(spec, { repairAttempts: 0 });
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'spec_in_context')?.ok).toBe(false);
  });

  it('проваливает при другом specId в контексте', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({ spec: { ...sampleSpec(), specId: 'other' } });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'spec_in_context')?.ok).toBe(false);
  });

  it('проваливает при отсутствии buildReport', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({ buildReport: undefined });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'build')?.ok).toBe(false);
  });

  it('проваливает при buildReport.success=false', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      buildReport: {
        success: false,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [{ message: 'x' }],
        bytecode: null,
        compilerSuccess: false,
        durationMs: 1,
      },
    });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'build')?.ok).toBe(false);
  });

  it('проваливает при goldenReport.passed=false', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      goldenReport: {
        executed: true,
        passed: false,
        qualityScore: 0.2,
        vmErrors: [],
        outputDiff: '{"failedChecks":["x"]}',
        durationMs: 1,
      },
    });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
  });

  it('проваливает при vmErrors в goldenReport', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      goldenReport: {
        executed: true,
        passed: true,
        qualityScore: 1,
        vmErrors: [{ message: 'vm oops' }],
        outputDiff: null,
        durationMs: 1,
      },
    });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
  });

  it('проваливает при отсутствии goldenReport', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({ goldenReport: undefined });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
  });
});
