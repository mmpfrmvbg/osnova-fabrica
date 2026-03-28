import { describe, it, expect } from 'vitest';
import { PlanAgent, PlanValidationError, type ExecutionPlan } from './plan-agent';
import type { OsnovaIntent, OsnovaSpec } from '../pipeline/types';

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
      'codegen',
      'build',
      'golden_check',
    ]);
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
});
