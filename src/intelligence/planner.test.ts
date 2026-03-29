import { describe, expect, it } from 'vitest';

import { PlanAgent } from '../agents/plan-agent';
import { buildExecutionPlanCore, buildLinearPlanSteps } from './planner';

describe('planner (pure core)', () => {
  const agent = new PlanAgent();

  it('buildLinearPlanSteps: fromScratch adds intake → spec_generation → g1 before codegen', () => {
    const steps = buildLinearPlanSteps({ fromScratch: true, includeRepair: false });
    expect(steps.map((s) => s.phase)).toEqual([
      'intake',
      'spec_generation',
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
    ]);
    steps.forEach((s, i) => {
      expect(s.order).toBe(i + 1);
    });
  });

  it('buildLinearPlanSteps: incremental starts at codegen', () => {
    const steps = buildLinearPlanSteps({ fromScratch: false, includeRepair: false });
    expect(steps.map((s) => s.phase)).toEqual(['codegen', 'build', 'golden_check']);
  });

  it('buildLinearPlanSteps: includeRepair appends single repair after golden_check', () => {
    const steps = buildLinearPlanSteps({ fromScratch: false, includeRepair: true });
    expect(steps[steps.length - 1]!.phase).toBe('repair');
  });

  it('defaults match PlanAgent (fromScratch false, includeRepair true)', () => {
    const stepsDefault = buildLinearPlanSteps({});
    expect(stepsDefault.map((s) => s.phase)).toEqual(['codegen', 'build', 'golden_check', 'repair']);
  });

  it('buildExecutionPlanCore passes PlanAgent.validatePlan', () => {
    const full = buildExecutionPlanCore(
      { planId: 'plan-1', intentId: 'intent-1', specId: 'spec-1' },
      { fromScratch: true, includeRepair: true },
    );
    expect(() => agent.validatePlan(full)).not.toThrow();

    const inc = buildExecutionPlanCore(
      { planId: 'plan-2', intentId: 'intent-2', specId: 'spec-2' },
      { fromScratch: false, includeRepair: false },
    );
    expect(() => agent.validatePlan(inc)).not.toThrow();
  });
});
