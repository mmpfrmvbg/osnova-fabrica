/**
 * Unit tests for IntakeAgent (input validation, spec checks) and PlanAgent (plan construction).
 * Complements IntakeAgent.test.ts / plan-agent.test.ts with focused validation and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { IntakeAgent, SpecValidationError } from './IntakeAgent';
import { PlanAgent, PlanValidationError } from './plan-agent';
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
