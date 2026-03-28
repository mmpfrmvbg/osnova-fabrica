import { describe, it, expect } from 'vitest';
import { ReviewAgent } from './review-agent';
import type { ExecContext } from './exec-agent';
import type { OsnovaSpec } from '../pipeline/types';

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

function okCtx(over: Partial<ExecContext> = {}): ExecContext {
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
    const report = agent.validate(spec, okCtx());
    expect(report.ok).toBe(true);
    expect(report.items.every(i => i.ok)).toBe(true);
    expect(report.summaryText).toContain('ReviewAgent');
    expect(report.summaryText).toContain('spec_in_context');
  });

  it('проваливает при другом specId в контексте', () => {
    const spec = sampleSpec();
    const ctx = okCtx({ spec: { ...sampleSpec(), specId: 'other' } });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'spec_in_context')?.ok).toBe(false);
  });

  it('проваливает при отсутствии buildReport', () => {
    const spec = sampleSpec();
    const ctx = okCtx({ buildReport: undefined });
    const report = agent.validate(spec, ctx);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.id === 'build')?.ok).toBe(false);
  });

  it('проваливает при buildReport.success=false', () => {
    const spec = sampleSpec();
    const ctx = okCtx({
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
    const ctx = okCtx({
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
});
