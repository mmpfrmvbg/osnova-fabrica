/**
 * Unit and integration tests for IntakeAgent, PlanAgent, ExecAgent, and ReviewAgent.
 * Integration scenarios: full-cycle simulation (validate → plan → execute → review) and error propagation in the chain.
 */
import { describe, it, expect } from 'vitest';
import { compileSource } from '../compiler/compiler';
import { compileToBuildReport } from '../pipeline/orchestrator';
import { runGoldenCheck } from '../runtime/goldenApps';
import { IntakeAgent, SpecValidationError, parseLlmConfidence } from './IntakeAgent';
import { PlanAgent, PlanValidationError, isValidPhaseTransition } from './plan-agent';
import { ExecAgent, createPipelineVmFromExecContext, type ExecContext } from './exec-agent';
import { PIPELINE_VM_GLOBAL_KEYS } from '../runtime/vm';
import { ReviewAgent } from './review-agent';
import { IntakeValidationError } from './types';
import type { OsnovaIntent, OsnovaSpec, RawText } from '../pipeline/types';

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

describe('parseLlmConfidence — порог G1 (ATM-002)', () => {
  it('числовая строка парсится', () => {
    expect(parseLlmConfidence('0.71')).toBe(0.71);
    expect(parseLlmConfidence(' 0.699 ')).toBeCloseTo(0.699);
  });

  it('нечисловая строка → 0.8', () => {
    expect(parseLlmConfidence('высокая')).toBe(0.8);
  });

  it('число как раньше', () => {
    expect(parseLlmConfidence(0.42)).toBe(0.42);
  });
});

describe('IntakeAgent — validate и parse', () => {
  const agent = new IntakeAgent();

  it('validate: отклоняет null и примитивы', () => {
    expect(() => agent.validate(null)).toThrow(IntakeValidationError);
    expect(() => agent.validate(undefined)).toThrow(IntakeValidationError);
    expect(() => agent.validate('str')).toThrow(IntakeValidationError);
    expect(() => agent.validate(1)).toThrow(IntakeValidationError);
  });

  it('validate: отклоняет массив (в JS typeof [] === object)', () => {
    expect(() => agent.validate([])).toThrow(IntakeValidationError);
  });

  it('validate: отклоняет отсутствие или не-строковый text', () => {
    expect(() => agent.validate({})).toThrow(IntakeValidationError);
    expect(() => agent.validate({ text: undefined })).toThrow(IntakeValidationError);
    expect(() => agent.validate({ text: 42 as unknown as string })).toThrow(
      IntakeValidationError,
    );
  });

  it('validate: отклоняет boxed String (не примитив string)', () => {
    expect(() =>
      agent.validate({ text: Object('boxed') as unknown as string }),
    ).toThrow(IntakeValidationError);
  });

  it('validate: принимает объект без прототипа с непустым text', () => {
    const raw = Object.assign(Object.create(null), { text: 'задача без __proto__' });
    agent.validate(raw);
    expect(agent.parse(raw as RawText)).toEqual({
      text: 'задача без __proto__',
    });
  });

  it('parse: обрезает пробелы по краям text', () => {
    expect(agent.parse({ text: '  hello  ' })).toEqual({ text: 'hello' });
  });

  it('parse: после validate допустимый RawText сохраняет содержимое', () => {
    const raw = { text: 'задача' };
    agent.validate(raw);
    expect(agent.parse(raw)).toEqual({ text: 'задача' });
  });
});

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
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
      'repair',
    ]);
    expect(plan.steps.length).toBe(7);
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

describe('PlanAgent — gate → role (ATM-008)', () => {
  const agent = new PlanAgent();

  it('G1 (g1_spec_ready) идёт после spec_generation и до codegen', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: false,
    });
    const ixG1 = plan.steps.findIndex(s => s.phase === 'g1_spec_ready');
    const ixSpec = plan.steps.findIndex(s => s.phase === 'spec_generation');
    const ixCodegen = plan.steps.findIndex(s => s.phase === 'codegen');
    expect(ixSpec).toBeGreaterThanOrEqual(0);
    expect(ixG1).toBe(ixSpec + 1);
    expect(ixCodegen).toBe(ixG1 + 1);
  });
});

describe('PlanAgent — инкрементальный план для ExecAgent (ATM-009)', () => {
  const agent = new PlanAgent();

  it('без fromScratch: только роли codegen → build → golden_check (без gate-шагов в плане)', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    expect(plan.steps.map(s => s.phase)).toEqual(['codegen', 'build', 'golden_check']);
    expect(plan.steps.some(s => s.phase === 'g1_spec_ready')).toBe(false);
  });
});

describe('PlanAgent — зависимости фаз (переходы)', () => {
  it('isValidPhaseTransition: допустимые рёбра пайплайна', () => {
    expect(isValidPhaseTransition('intake', 'spec_generation')).toBe(true);
    expect(isValidPhaseTransition('spec_generation', 'g1_spec_ready')).toBe(true);
    expect(isValidPhaseTransition('g1_spec_ready', 'codegen')).toBe(true);
    expect(isValidPhaseTransition('codegen', 'build')).toBe(true);
    expect(isValidPhaseTransition('build', 'golden_check')).toBe(true);
    expect(isValidPhaseTransition('golden_check', 'repair')).toBe(true);
  });

  it('isValidPhaseTransition: недопустимые пропуски или обратный порядок', () => {
    expect(isValidPhaseTransition('spec_generation', 'codegen')).toBe(false);
    expect(isValidPhaseTransition('codegen', 'golden_check')).toBe(false);
    expect(isValidPhaseTransition('build', 'codegen')).toBe(false);
    expect(isValidPhaseTransition('intake', 'codegen')).toBe(false);
  });

  it('validatePlan: отклоняет spec_generation → codegen без g1_spec_ready', () => {
    const agent = new PlanAgent();
    expect(() =>
      agent.validatePlan({
        planId: 'p',
        intentId: 'i',
        specId: 's',
        fromScratch: true,
        steps: [
          { phase: 'intake', order: 1 },
          { phase: 'spec_generation', order: 2 },
          { phase: 'codegen', order: 3 },
          { phase: 'build', order: 4 },
          { phase: 'golden_check', order: 5 },
        ],
      }),
    ).toThrow(PlanValidationError);
  });
});

describe('PlanAgent — edge cases: run, validate, двойной repair', () => {
  const agent = new PlanAgent();
  const intent = sampleIntent();
  const spec = sampleSpec();

  it('run совпадает с buildPlan для тех же intent/spec/options', () => {
    const opts = { fromScratch: false, includeRepair: true } as const;
    const a = agent.buildPlan(intent, spec, opts);
    const b = agent.run({ intent, spec, options: opts });
    expect(b.fromScratch).toBe(a.fromScratch);
    expect(b.steps.map(s => s.phase)).toEqual(a.steps.map(s => s.phase));
    expect(b.intentId).toBe(a.intentId);
    expect(b.specId).toBe(a.specId);
  });

  it('validate принимает пару intent+spec без options', () => {
    expect(() => agent.validate({ intent, spec })).not.toThrow();
  });

  it('validate отклоняет не-объект и пустую пару', () => {
    expect(() => agent.validate(null)).toThrow(PlanValidationError);
    expect(() => agent.validate({ intent })).toThrow(PlanValidationError);
    expect(() => agent.validate({ spec })).toThrow(PlanValidationError);
  });

  it('fromScratch без repair: 6 шагов, последний golden_check', () => {
    const plan = agent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    expect(plan.steps.map(s => s.phase)).toEqual([
      'intake',
      'spec_generation',
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
    ]);
    expect(plan.steps[plan.steps.length - 1]!.phase).toBe('golden_check');
  });

  it('validatePlan: два шага repair подряд недопустимы', () => {
    expect(() =>
      agent.validatePlan({
        planId: 'p',
        intentId: 'i',
        specId: 's',
        fromScratch: false,
        steps: [
          { phase: 'codegen', order: 1 },
          { phase: 'build', order: 2 },
          { phase: 'golden_check', order: 3 },
          { phase: 'repair', order: 4 },
          { phase: 'repair', order: 5 },
        ],
      }),
    ).toThrow(PlanValidationError);
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

  it('fromScratch + repair: проходит все фазы пайплайна по порядку', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: true,
      includeRepair: true,
    });
    const exec = new ExecAgent(planAgent);
    const phases: string[] = [];

    const result = await exec.execute(plan, async (phase, step, ctx) => {
      expect(step.phase).toBe(phase);
      phases.push(phase);
      return { ok: true, patch: { repairAttempts: ctx.repairAttempts } };
    });

    expect(result.completed).toBe(true);
    expect(phases).toEqual([
      'intake',
      'spec_generation',
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
      'repair',
    ]);
  });

  it('при ok: false без error подставляет сообщение по фазе', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);

    const result = await exec.execute(plan, async phase => {
      if (phase === 'build') {
        return { ok: false };
      }
      return { ok: true };
    });

    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('build');
    expect(result.error).toBe('step failed: build (order 2)');
    expect(result.steps[1]!.error).toBe('step failed: build (order 2)');
  });
});

describe('ExecAgent.executeStep', () => {
  it('применяет patch только при ok: true', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const state: ExecContext = { repairAttempts: 0 };

    const step0 = plan.steps[0]!;
    const r0 = await exec.executeStep(
      step0,
      async () => ({
        ok: false,
        patch: { intent: sampleIntent({ intentId: 'should-not-apply' }) },
      }),
      state,
    );
    expect(r0.stop).toBe(true);
    expect(r0.stepResult.ok).toBe(false);
    expect(state.intent).toBeUndefined();

    const step1 = plan.steps[1]!;
    const r1 = await exec.executeStep(
      step1,
      async () => ({ ok: true, patch: { repairAttempts: 1 } }),
      state,
    );
    expect(r1.stop).toBe(false);
    expect(state.repairAttempts).toBe(1);
  });
});

function reviewOkCtx(over: Partial<ExecContext> = {}): ExecContext {
  const spec = sampleSpec();
  return {
    repairAttempts: 0,
    spec,
    source: { filename: 'главная.osnova', source: 'модуль Главный\nконец' },
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

  it('проваливает при goldenReport.executed=false даже если passed=true', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      goldenReport: {
        executed: false,
        passed: true,
        qualityScore: 1,
        vmErrors: [],
        outputDiff: null,
        durationMs: 1,
      },
    });
    const report = agent.review(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
  });

  it('review + план: plan_spec_ids и plan_source проходят при согласованных данных', () => {
    const planAgent = new PlanAgent();
    const intent = sampleIntent();
    const spec = sampleSpec();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const ctx = reviewOkCtx({ intent });
    const report = agent.review(spec, ctx, plan);
    expect(report.items.find(i => i.id === 'plan_spec_ids')?.ok).toBe(true);
    expect(report.items.find(i => i.id === 'plan_source')?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('review + план: проваливает plan_spec_ids при другом specId в плане', () => {
    const planAgent = new PlanAgent();
    const intent = sampleIntent();
    const spec = sampleSpec();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const otherSpec = { ...spec, specId: 'other-spec' };
    const report = agent.review(otherSpec, reviewOkCtx({ spec }), plan);
    expect(report.items.find(i => i.id === 'plan_spec_ids')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('review + план: проваливает plan_source если нет исходника при codegen в плане', () => {
    const planAgent = new PlanAgent();
    const intent = sampleIntent();
    const spec = sampleSpec();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const ctx = reviewOkCtx({ intent, source: undefined });
    const report = agent.review(spec, ctx, plan);
    expect(report.items.find(i => i.id === 'plan_source')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('review + план fromScratch: проваливает plan_intent без intent в контексте', () => {
    const planAgent = new PlanAgent();
    const intent = sampleIntent();
    const spec = sampleSpec();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    const ctx = reviewOkCtx({ intent: undefined });
    const report = agent.review(spec, ctx, plan);
    expect(report.items.find(i => i.id === 'plan_intent')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('Интеграция — полный цикл и цепочка агентов', () => {
  it('полный цикл: Intake (validate/parse/checkSpec) → Plan → Exec → Review — успех', async () => {
    const intake = new IntakeAgent();
    const raw = { text: '  интеграционная задача  ' };
    intake.validate(raw);
    expect(intake.parse(raw)).toEqual({ text: 'интеграционная задача' });

    const intent = sampleIntent();
    const spec = sampleSpec();
    intake.checkSpec(spec);

    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: true, includeRepair: true });
    const exec = new ExecAgent(planAgent);
    const reviewAgent = new ReviewAgent();

    const execResult = await exec.execute(plan, async (phase, _step, ctx) => {
      switch (phase) {
        case 'intake':
          return { ok: true, patch: { intent } };
        case 'spec_generation':
          return { ok: true, patch: { spec } };
        case 'g1_spec_ready':
          return { ok: true };
        case 'codegen':
          return {
            ok: true,
            patch: {
              source: { filename: 'главная.osnova', source: 'модуль Главный\nконец' },
            },
          };
        case 'build':
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
        case 'golden_check':
          return {
            ok: true,
            patch: {
              goldenReport: {
                executed: true,
                passed: true,
                qualityScore: 1,
                vmErrors: [],
                outputDiff: null,
                durationMs: 2,
              },
            },
          };
        case 'repair':
          return { ok: true, patch: { repairAttempts: ctx.repairAttempts + 1 } };
      }
    });

    expect(execResult.completed).toBe(true);
    const report = reviewAgent.review(spec, execResult.state, plan);
    expect(report.ok).toBe(true);
    expect(execResult.state.repairAttempts).toBe(1);
  });

  it('цепочка: ошибка на build — Exec останавливается, Review отражает провал сборки', async () => {
    const intake = new IntakeAgent();
    const intent = sampleIntent();
    const spec = sampleSpec();
    intake.checkSpec(spec);

    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const exec = new ExecAgent(planAgent);
    const reviewAgent = new ReviewAgent();

    const execResult = await exec.execute(
      plan,
      async phase => {
        if (phase === 'codegen') {
          return {
            ok: true,
            patch: {
              source: { filename: 'x.osnova', source: 'модуль X\nконец' },
            },
          };
        }
        if (phase === 'build') {
          return { ok: false, error: 'compile error' };
        }
        return { ok: true };
      },
      { intent, spec },
    );

    expect(execResult.completed).toBe(false);
    expect(execResult.stoppedAtPhase).toBe('build');
    expect(execResult.error).toBe('compile error');
    const report = reviewAgent.review(spec, execResult.state, plan);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'build')?.ok).toBe(false);
  });

  it('цепочка: ошибка на golden_check — Review проваливает golden', async () => {
    const intent = sampleIntent();
    const spec = sampleSpec();
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const exec = new ExecAgent(planAgent);
    const reviewAgent = new ReviewAgent();

    const execResult = await exec.execute(
      plan,
      async phase => {
        if (phase === 'codegen') {
          return {
            ok: true,
            patch: {
              source: { filename: 'g.osnova', source: 'модуль G\nконец' },
            },
          };
        }
        if (phase === 'build') {
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
        if (phase === 'golden_check') {
          return {
            ok: true,
            patch: {
              goldenReport: {
                executed: true,
                passed: false,
                qualityScore: 0,
                vmErrors: [],
                outputDiff: 'failed',
                durationMs: 1,
              },
            },
          };
        }
        return { ok: true };
      },
      { intent, spec },
    );

    expect(execResult.completed).toBe(true);
    const report = reviewAgent.review(spec, execResult.state, plan);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
  });

  it('цепочка: исключение на spec_generation — прерывание, spec не попадает в контекст', async () => {
    const intent = sampleIntent();
    const spec = sampleSpec();
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    const exec = new ExecAgent(planAgent);

    const execResult = await exec.execute(plan, async phase => {
      if (phase === 'intake') return { ok: true, patch: { intent } };
      if (phase === 'spec_generation') throw new Error('LLM недоступен');
      return { ok: true };
    });

    expect(execResult.completed).toBe(false);
    expect(execResult.stoppedAtPhase).toBe('spec_generation');
    expect(execResult.error).toBe('LLM недоступен');
    expect(execResult.state.spec).toBeUndefined();
  });

  it('Intake: пустой RawText — валидация до Plan/Exec', () => {
    const intake = new IntakeAgent();
    expect(() => intake.validate({ text: '' })).toThrow(IntakeValidationError);
  });

  it('Intake.checkSpec: невалидный spec — до codegen не допускается', () => {
    const intake = new IntakeAgent();
    expect(() =>
      intake.checkSpec(
        sampleSpec({
          procedures: [],
        }),
      ),
    ).toThrow(SpecValidationError);
  });
});

/** Тот же исходник, что в pipeline E2E (сумма 1…10); связка compiler → VM → ReviewAgent без моков. */
const INTEGRATION_SUM_SOURCE = `
модуль Главный
процедура главная()
  пусть сумма = 0
  пусть счётчик = 1
  пока счётчик <= 10
    сумма = сумма + счётчик
    счётчик = счётчик + 1
  конец
  система.лог.вывести(сумма)
  вернуть сумма
конец
`.trim();

describe('ExecAgent — createPipelineVmFromExecContext (runtime/vm)', () => {
  it('возвращает null без spec, bytecode или при невалидном bytecode', () => {
    expect(createPipelineVmFromExecContext({ repairAttempts: 0 })).toBeNull();
    const spec = sampleSpec();
    expect(
      createPipelineVmFromExecContext({
        repairAttempts: 0,
        spec,
        buildReport: {
          success: true,
          lexerErrors: [],
          parserErrors: [],
          compilerErrors: [],
          bytecode: null,
          compilerSuccess: true,
          durationMs: 0,
        },
      }),
    ).toBeNull();
    expect(
      createPipelineVmFromExecContext({
        repairAttempts: 0,
        spec,
        buildReport: {
          success: true,
          lexerErrors: [],
          parserErrors: [],
          compilerErrors: [],
          bytecode: { invalid: true },
          compilerSuccess: true,
          durationMs: 0,
        },
      }),
    ).toBeNull();
  });

  it('создаёт VM с applyPipelineSpecToVm: globals и успешный execute', async () => {
    const spec = sampleSpec({
      mainModule: 'главная',
      procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
    });
    const buildReport = compileToBuildReport(compileSource(INTEGRATION_SUM_SOURCE));
    expect(buildReport.success).toBe(true);
    const vm = createPipelineVmFromExecContext({ repairAttempts: 0, spec, buildReport });
    expect(vm).not.toBeNull();
    expect(vm!.globals[PIPELINE_VM_GLOBAL_KEYS.SPEC_ID]).toBe(spec.specId);
    const ret = await vm!.execute({ procedure: 'главная' });
    expect(ret).toBe(55);
  }, 20000);

  it('execute: несуществующая процедура — ошибка пробрасывается', async () => {
    const spec = sampleSpec({
      mainModule: 'главная',
      procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
    });
    const buildReport = compileToBuildReport(compileSource(INTEGRATION_SUM_SOURCE));
    const vm = createPipelineVmFromExecContext({ repairAttempts: 0, spec, buildReport });
    expect(vm).not.toBeNull();
    await expect(vm!.execute({ procedure: 'нет_такой_процедуры' })).rejects.toThrow();
  }, 20000);
});

describe('Интеграция — compiler → runtime → ReviewAgent (реальный тулчейн)', () => {
  it('compileToBuildReport + runGoldenCheck формируют ExecContext, который validate принимает', async () => {
    const spec = sampleSpec({
      mainModule: 'главная',
      procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
    });
    new IntakeAgent().checkSpec(spec);

    const buildReport = compileToBuildReport(compileSource(INTEGRATION_SUM_SOURCE));
    expect(buildReport.success).toBe(true);
    expect(buildReport.bytecode).toBeTruthy();

    const goldenReport = await runGoldenCheck(buildReport.bytecode, {
      ...spec,
      expectedReturnValue: 55,
    });
    expect(goldenReport.executed).toBe(true);
    expect(goldenReport.passed).toBe(true);
    expect(goldenReport.vmErrors).toEqual([]);

    const review = new ReviewAgent().validate(spec, {
      repairAttempts: 0,
      spec,
      source: { filename: 'главная.osnova', source: INTEGRATION_SUM_SOURCE },
      buildReport,
      goldenReport,
    });
    expect(review.ok).toBe(true);
  }, 20000);
});
