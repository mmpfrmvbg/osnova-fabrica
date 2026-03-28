import { describe, it, expect } from 'vitest';
import { PlanAgent } from './plan-agent';
import { ExecAgent } from './exec-agent';
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

  it('обрабатывает исключение в runPhase', async () => {
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

  it('бросает PlanValidationError при невалидном плане', async () => {
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
    ).rejects.toThrow();
  });
});
