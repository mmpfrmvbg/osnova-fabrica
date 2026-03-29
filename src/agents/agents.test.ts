/**
 * Unit and integration tests for IntakeAgent, PlanAgent, ExecAgent, and ReviewAgent.
 * Integration scenarios: full-cycle simulation (validate → plan → execute → review) and error propagation in the chain.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock LLM provider to avoid real API calls during tests
vi.mock('../llm/index', () => ({
  getLLMProvider: () => ({
    complete: async () => ({ content: '{"intent":"test","confidence":0.9,"language":"osnova","features":["test"],"appType":"утилита"}', model: 'mock', done: true }),
  }),
}));

import { compileSource, compileToBuildReport } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import {
  IntakeAgent,
  SpecValidationError,
  detectAppTypeFromPrefix,
  intentFeaturesFromLlmPayload,
  parseLlmConfidence,
} from './IntakeAgent';
import { PlanAgent, PlanValidationError, isValidPhaseTransition, type PipelinePhase } from './plan-agent';
import {
  ExecAgent,
  createPipelineVmFromExecContext,
  safeExecutePipelineVmFromExecContext,
  EXEC_CONTEXT_VM_UNAVAILABLE,
  type ExecContext,
} from './exec-agent';
import { PIPELINE_VM_GLOBAL_KEYS } from '../runtime/vm';
import { ReviewAgent } from './review-agent';
import { IntakeValidationError } from './types';
import type { OsnovaIntent, OsnovaSpec, RawText } from '../pipeline/types';
import { SPEC_INTENT_CONFIDENCE_DEFAULT } from '../pipeline/types';

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

describe('detectAppTypeFromPrefix — префиксы до LLM (intake)', () => {
  it('распознаёт тип по строке начала задачи', () => {
    expect(detectAppTypeFromPrefix('алгоритм: сортировка')).toBe('алгоритм');
    expect(detectAppTypeFromPrefix('тест: проверка')).toBe('тест');
    expect(detectAppTypeFromPrefix('модуль типов: перечисления')).toBe('модуль_типов');
    expect(detectAppTypeFromPrefix('модуль: утилиты')).toBe('модуль');
    expect(detectAppTypeFromPrefix('библиотека: общий код')).toBe('библиотека');
  });

  it('возвращает null без префикса', () => {
    expect(detectAppTypeFromPrefix('  утилита без метки  ')).toBeNull();
  });
});

describe('parseLlmConfidence — порог G1 (ATM-002)', () => {
  it('числовая строка парсится', () => {
    expect(parseLlmConfidence('0.71')).toBe(0.71);
    expect(parseLlmConfidence(' 0.699 ')).toBeCloseTo(0.699);
  });

  it('нечисловая строка → SPEC_INTENT_CONFIDENCE_DEFAULT', () => {
    expect(parseLlmConfidence('высокая')).toBe(SPEC_INTENT_CONFIDENCE_DEFAULT);
  });

  it('число как раньше', () => {
    expect(parseLlmConfidence(0.42)).toBe(0.42);
  });
});

describe('intentFeaturesFromLlmPayload — roles/features для G1 (ATM-001)', () => {
  it('roles строка (одна capability) → один элемент', () => {
    expect(
      intentFeaturesFromLlmPayload(
        { features: [], roles: 'file read', intent: 'x' },
        'fallback',
      ),
    ).toEqual(['file read']);
  });

  it('roles строка с запятыми → несколько capability', () => {
    expect(
      intentFeaturesFromLlmPayload(
        { features: [], roles: ' read log ,  export ', intent: 'x' },
        'fallback',
      ),
    ).toEqual(['read log', 'export']);
  });

  it('roles объект значений → значения как features', () => {
    expect(
      intentFeaturesFromLlmPayload(
        { features: [], roles: { a: 'storage', b: 'logging' }, intent: 'x' },
        'fallback',
      ),
    ).toEqual(['storage', 'logging']);
  });

  it('пустой features[] и только пробельные строки в массиве → intent + fallback', () => {
    expect(
      intentFeaturesFromLlmPayload(
        { features: ['', '  ', '\t'], roles: [], intent: 'цель' },
        'задача',
      ),
    ).toEqual(['цель']);
  });

  it('features имеет приоритет над roles', () => {
    expect(
      intentFeaturesFromLlmPayload(
        { features: ['only'], roles: ['ignored'], intent: 'x' },
        'fallback',
      ),
    ).toEqual(['only']);
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

  it('validate: отклоняет пустой и пробельный text (тот же порог, что parseIntent)', () => {
    expect(() => agent.validate({ text: '' })).toThrow(IntakeValidationError);
    expect(() => agent.validate({ text: ' \t\n ' })).toThrow(IntakeValidationError);
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

  it('buildPlan: отклоняет пустой intentId или specId (validateInputs)', () => {
    expect(() =>
      agent.buildPlan(sampleIntent({ intentId: '' }), sampleSpec()),
    ).toThrow(PlanValidationError);
    expect(() =>
      agent.buildPlan(sampleIntent({ intentId: '   ' }), sampleSpec()),
    ).toThrow(PlanValidationError);
    expect(() =>
      agent.buildPlan(sampleIntent(), sampleSpec({ specId: '' })),
    ).toThrow(PlanValidationError);
    expect(() =>
      agent.buildPlan(sampleIntent(), sampleSpec({ specId: '\t' })),
    ).toThrow(PlanValidationError);
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

describe('ExecAgent — ошибки выполнения шага (ATM-010)', () => {
  it('исключение в runPhase не на первом шаге: stop, error, шаг с ok: false', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const result = await exec.execute(plan, async phase => {
      if (phase === 'build') {
        throw new Error('runPhase failure');
      }
      return { ok: true };
    });
    expect(result.completed).toBe(false);
    expect(result.stoppedAtPhase).toBe('build');
    expect(result.error).toBe('runPhase failure');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]!.ok).toBe(false);
    expect(result.steps[1]!.error).toBe('runPhase failure');
  });
});

describe('ExecAgent — контекст выполнения runPhase (ATM-011)', () => {
  it('runPhase получает phase, step (order) и накопленный ctx между шагами', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const intent = sampleIntent();
    const spec = sampleSpec();
    const seen: Array<{ phase: string; order: number; hasSource: boolean }> = [];

    const result = await exec.execute(
      plan,
      async (phase, step, ctx) => {
        expect(step.phase).toBe(phase);
        seen.push({
          phase,
          order: step.order,
          hasSource: ctx.source != null,
        });
        if (phase === 'codegen') {
          return { ok: true, patch: { source: { filename: 'm.osnova', source: 'модуль M\nконец' } } };
        }
        if (phase === 'build') {
          expect(ctx.intent).toEqual(intent);
          expect(ctx.spec).toEqual(spec);
          expect(ctx.source?.filename).toBe('m.osnova');
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
                durationMs: 0,
              },
            },
          };
        }
        return { ok: true };
      },
      { intent, spec, repairAttempts: 0 },
    );

    expect(result.completed).toBe(true);
    expect(seen).toEqual([
      { phase: 'codegen', order: 1, hasSource: false },
      { phase: 'build', order: 2, hasSource: true },
      { phase: 'golden_check', order: 3, hasSource: true },
    ]);
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

describe('PlanAgent — defaults, report, контракт с IntakeAgent (ATM-002)', () => {
  const agent = new PlanAgent();

  it('buildPlan без options: инкремент + repair по умолчанию (как после IntakeAgent.run + готовый артефакт)', () => {
    const plan = agent.buildPlan(sampleIntent(), sampleSpec());
    expect(plan.fromScratch).toBe(false);
    expect(plan.steps.map(s => s.phase)).toEqual([
      'codegen',
      'build',
      'golden_check',
      'repair',
    ]);
  });

  it('report: до buildPlan/run — подсказка что план ещё не строился', () => {
    const fresh = new PlanAgent();
    const rep = fresh.report();
    expect(rep.ok).toBe(false);
    expect(rep.summaryText).toContain('ещё не строился');
  });

  it('validatePlan: пустой planId', () => {
    expect(() =>
      agent.validatePlan({
        planId: '',
        intentId: 'i',
        specId: 's',
        fromScratch: false,
        steps: [
          { phase: 'codegen', order: 1 },
          { phase: 'build', order: 2 },
          { phase: 'golden_check', order: 3 },
        ],
      }),
    ).toThrow(PlanValidationError);
  });

  it('цепочка IntakeAgent (sample) → PlanAgent.buildPlan: те же intentId/specId в плане', () => {
    const intake = new IntakeAgent();
    const intent = sampleIntent({ intentId: 'intake-plan-bridge' });
    const spec = sampleSpec({ specId: 'intake-plan-spec' });
    intake.checkSpec(spec);
    const plan = agent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    expect(plan.intentId).toBe(intent.intentId);
    expect(plan.specId).toBe(spec.specId);
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

  it('executeStep: исключение в runPhase — stop, fatalError, patch не применяется', async () => {
    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), {
      fromScratch: false,
      includeRepair: false,
    });
    const exec = new ExecAgent(planAgent);
    const state: ExecContext = { repairAttempts: 0 };

    const r = await exec.executeStep(
      plan.steps[0]!,
      async () => {
        throw new Error('phase handler down');
      },
      state,
    );

    expect(r.stop).toBe(true);
    expect(r.fatalError).toBe('phase handler down');
    expect(r.stepResult.ok).toBe(false);
    expect(state.intent).toBeUndefined();
  });
});

describe('ExecAgent — validate, run, report (BaseAgent)', () => {
  const planAgent = new PlanAgent();

  it('validate: отклоняет не-план и делегирует validatePlan валидному плану', () => {
    const exec = new ExecAgent(planAgent);
    expect(() => exec.validate(null)).toThrow(PlanValidationError);
    expect(() => exec.validate({})).toThrow(PlanValidationError);
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), { fromScratch: false, includeRepair: false });
    expect(() => exec.validate(plan)).not.toThrow();
  });

  it('run: требует plan и runPhase', async () => {
    const exec = new ExecAgent(planAgent);
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), { fromScratch: false, includeRepair: false });
    await expect(exec.run(undefined)).rejects.toThrow(PlanValidationError);
    await expect(exec.run({ plan } as unknown as Parameters<ExecAgent['run']>[0])).rejects.toThrow(PlanValidationError);
    await expect(exec.run({ runPhase: async () => ({ ok: true }) } as unknown as Parameters<ExecAgent['run']>[0])).rejects.toThrow(
      PlanValidationError,
    );
  });

  it('run: делегирует execute; report отражает успех и ошибку', async () => {
    const exec = new ExecAgent(planAgent);
    const plan = planAgent.buildPlan(sampleIntent(), sampleSpec(), { fromScratch: false, includeRepair: false });

    const ok = await exec.run({
      plan,
      runPhase: async () => ({ ok: true }),
    });
    expect(ok.completed).toBe(true);
    let rep = exec.report();
    expect(rep.ok).toBe(true);
    expect(rep.summaryText).toContain('completed=true');

    const fail = await exec.run({
      plan,
      runPhase: async (phase: PipelinePhase) =>
        phase === 'codegen' ? { ok: false, error: 'x' } : { ok: true },
    });
    expect(fail.completed).toBe(false);
    rep = exec.report();
    expect(rep.ok).toBe(false);
    expect(rep.summaryText).toContain('error=x');
  });

  it('report: до execute — подсказка что execute/run не вызывались', () => {
    const exec = new ExecAgent(planAgent);
    const rep = exec.report();
    expect(rep.ok).toBe(false);
    expect(rep.summaryText).toContain('ещё не вызывались');
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

describe('ReviewAgent.validate (ATM-012)', () => {
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

  it('некорректный эталонный spec: не бросает, фиксирует spec_parameter и spec_in_context', () => {
    const report = agent.review(null as unknown as OsnovaSpec, reviewOkCtx());
    expect(report.items.find(i => i.id === 'spec_parameter')?.ok).toBe(false);
    expect(report.items.find(i => i.id === 'spec_in_context')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('validate: при двух аргументах без ctx — ошибка', () => {
    expect(() =>
      agent.validate(sampleSpec(), undefined as unknown as ExecContext),
    ).toThrow(/второй аргумент \(ctx\)/);
  });

  it('validate объектная форма { spec, ctx } — успех', () => {
    const spec = sampleSpec();
    const report = agent.validate({ spec, ctx: reviewOkCtx() });
    expect(report.ok).toBe(true);
  });

  it('проваливает build при блокирующей семантической ошибке (success=true)', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      buildReport: {
        success: true,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [],
        semanticErrors: [{ message: 'не объявлено', kind: 'undeclared_var' }],
        bytecode: null,
        compilerSuccess: true,
        durationMs: 1,
      },
    });
    const report = agent.validate(spec, ctx);
    expect(report.items.find(i => i.id === 'build')?.ok).toBe(false);
    expect(report.items.find(i => i.id === 'build')?.detail).toContain('семантическ');
    expect(report.ok).toBe(false);
  });

  it('проваливает golden при нечисловом qualityScore', () => {
    const spec = sampleSpec();
    const ctx = reviewOkCtx({
      goldenReport: {
        executed: true,
        passed: true,
        qualityScore: Number.NaN,
        vmErrors: [],
        outputDiff: null,
        durationMs: 1,
      },
    });
    const report = agent.validate(spec, ctx);
    expect(report.items.find(i => i.id === 'golden')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('ReviewAgent — run, report и ошибки validate (BaseAgent) (ATM-012)', () => {
  const agent = new ReviewAgent();
  const spec = sampleSpec();

  it('run: отклоняет undefined, не-объект, отсутствие spec или ctx', () => {
    expect(() => agent.run()).toThrow(/ожидается/);
    expect(() => agent.run('x' as unknown as Parameters<ReviewAgent['run']>[0])).toThrow(/ожидается/);
    expect(() => agent.run({ spec } as Parameters<ReviewAgent['run']>[0])).toThrow(/ожидается/);
    expect(() => agent.run({ ctx: reviewOkCtx() } as Parameters<ReviewAgent['run']>[0])).toThrow(/ожидается/);
  });

  it('run: эквивалентен review при валидных полях', () => {
    const ctx = reviewOkCtx();
    const a = agent.review(spec, ctx);
    const b = agent.run({ spec, ctx });
    expect(b.ok).toBe(a.ok);
    expect(b.items.map(i => i.id)).toEqual(a.items.map(i => i.id));
  });

  it('report: до review — подсказка вызвать review/validate/run', () => {
    const fresh = new ReviewAgent();
    const rep = fresh.report();
    expect(rep.ok).toBe(false);
    expect(rep.summaryText).toContain('нет отчёта');
  });

  it('report: после review отражает ok и summaryText', () => {
    const r = new ReviewAgent();
    const repOk = r.review(spec, reviewOkCtx());
    const out = r.report();
    expect(out.ok).toBe(repOk.ok);
    expect(out.summaryText).toBe(repOk.summaryText);
  });

  it('validate: одна форма-аргумент с невалидным объектом — ошибка', () => {
    expect(() => agent.validate(null as unknown as { spec: OsnovaSpec; ctx: ExecContext })).toThrow(
      /ожидается \(spec, ctx/,
    );
    expect(() => agent.validate({ spec } as unknown as { spec: OsnovaSpec; ctx: ExecContext })).toThrow(
      /ожидается \(spec, ctx/,
    );
  });

  it('review: инкрементальный план и intent в контексте с другим intentId — plan_intent проваливается', () => {
    const planAgent = new PlanAgent();
    const intent = sampleIntent({ intentId: 'plan-intent' });
    const specLocal = sampleSpec();
    const plan = planAgent.buildPlan(intent, specLocal, { fromScratch: false, includeRepair: false });
    const ctx = reviewOkCtx({
      intent: sampleIntent({ intentId: 'другой-intent' }),
    });
    const report = agent.review(specLocal, ctx, plan);
    expect(report.items.find(i => i.id === 'plan_intent')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

/**
 * E2E: четыре агента подряд с проверкой накопления ExecContext между фазами (ATM-EPK-260328-017-005).
 */
describe('E2E — intake → plan → exec → review (контекст между агентами)', () => {
  it('Intake → PlanAgent → ExecAgent накапливает intent/spec/source/build/golden; ReviewAgent принимает', async () => {
    const intake = new IntakeAgent();
    const raw = { text: '  задача E2E передача контекста  ' };
    intake.validate(raw);
    expect(intake.parse(raw)).toEqual({ text: 'задача E2E передача контекста' });

    const intent = sampleIntent({ intentId: 'e2e-chain-intent', description: 'E2E chain' });
    const spec = sampleSpec({ specId: 'e2e-chain-spec' });
    intake.checkSpec(spec);

    const planAgent = new PlanAgent();
    const plan = planAgent.buildPlan(intent, spec, { fromScratch: true, includeRepair: false });
    expect(plan.intentId).toBe(intent.intentId);
    expect(plan.specId).toBe(spec.specId);
    expect(plan.steps[plan.steps.length - 1]!.phase).toBe('golden_check');

    const exec = new ExecAgent(planAgent);
    const execResult = await exec.execute(plan, async (phase, _step, ctx) => {
      switch (phase) {
        case 'intake':
          expect(ctx.intent).toBeUndefined();
          expect(ctx.spec).toBeUndefined();
          return { ok: true, patch: { intent } };
        case 'spec_generation':
          expect(ctx.intent?.intentId).toBe('e2e-chain-intent');
          expect(ctx.spec).toBeUndefined();
          return { ok: true, patch: { spec } };
        case 'g1_spec_ready':
          expect(ctx.intent?.intentId).toBe('e2e-chain-intent');
          expect(ctx.spec?.specId).toBe('e2e-chain-spec');
          return { ok: true };
        case 'codegen':
          expect(ctx.spec?.specId).toBe('e2e-chain-spec');
          return {
            ok: true,
            patch: {
              source: { filename: 'e2e-chain.osnova', source: 'модуль Главный\nконец' },
            },
          };
        case 'build':
          expect(ctx.source?.filename).toBe('e2e-chain.osnova');
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
          expect(ctx.buildReport?.success).toBe(true);
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
          return { ok: true };
      }
    });

    expect(execResult.completed).toBe(true);
    expect(execResult.state.intent?.intentId).toBe('e2e-chain-intent');
    expect(execResult.state.spec?.specId).toBe('e2e-chain-spec');
    expect(execResult.state.source?.filename).toBe('e2e-chain.osnova');
    expect(execResult.state.goldenReport?.passed).toBe(true);

    const reviewAgent = new ReviewAgent();
    const report = reviewAgent.review(spec, execResult.state, plan);
    expect(report.ok).toBe(true);
    expect(report.items.find(i => i.id === 'plan_spec_ids')?.ok).toBe(true);
    expect(report.items.find(i => i.id === 'plan_source')?.ok).toBe(true);
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

describe('ExecAgent — safeExecutePipelineVmFromExecContext (ATM-EPK-260328-017-003)', () => {
  it('без spec/bytecode: ok: false и стабильное сообщение', async () => {
    const r = await safeExecutePipelineVmFromExecContext({ repairAttempts: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(EXEC_CONTEXT_VM_UNAVAILABLE);
  });

  it('успешный прогон главной процедуры через контекст после build', async () => {
    const spec = sampleSpec({
      mainModule: 'главная',
      procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
    });
    const buildReport = compileToBuildReport(compileSource(INTEGRATION_SUM_SOURCE));
    expect(buildReport.success).toBe(true);
    const ctx: ExecContext = { repairAttempts: 0, spec, buildReport };
    const r = await safeExecutePipelineVmFromExecContext(ctx, { procedure: 'главная' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe(55);
  }, 20000);

  it('ошибка VM: несуществующая процедура — ok: false без throw', async () => {
    const spec = sampleSpec({
      mainModule: 'главная',
      procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
    });
    const buildReport = compileToBuildReport(compileSource(INTEGRATION_SUM_SOURCE));
    const r = await safeExecutePipelineVmFromExecContext(
      { repairAttempts: 0, spec, buildReport },
      { procedure: 'нет_такой_процедуры' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
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
