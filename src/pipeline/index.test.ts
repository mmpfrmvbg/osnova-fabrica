/**
 * Тесты pipeline orchestrator: executePipeline
 */

import { describe, it, expect, vi } from 'vitest';
import { executePipeline } from './orchestrator';
import type { IPipelineStep, PipelineContext, StepResult } from './types';

describe('executePipeline', () => {
  const createMockStep = (
    id: string,
    order: number,
    phase: 'intake' | 'spec_generation' | 'codegen' | 'build' | 'golden_check',
    executeFn?: (context: PipelineContext) => Promise<StepResult>,
    canExecuteFn?: (context: PipelineContext) => boolean,
  ): IPipelineStep => ({
    id,
    phase,
    order,
    execute: executeFn ?? (async (context) => ({ success: true, context })),
    canExecute: canExecuteFn,
  });

  const emptyContext: PipelineContext = {
    repairAttempts: 0,
  };

  it('выполняет шаги по порядку', async () => {
    const executionOrder: string[] = [];
    const steps: IPipelineStep[] = [
      createMockStep('step1', 2, 'spec_generation', async (ctx) => {
        executionOrder.push('step1');
        return { success: true, context: { ...ctx, spec: { specId: 'test' } as never } };
      }),
      createMockStep('step2', 1, 'intake', async (ctx) => {
        executionOrder.push('step2');
        return { success: true, context: ctx };
      }),
      createMockStep('step3', 3, 'codegen', async (ctx) => {
        executionOrder.push('step3');
        return { success: true, context: ctx };
      }),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(['step2', 'step1', 'step3']);
  });

  it('прерывает выполнение при ошибке шага', async () => {
    const steps: IPipelineStep[] = [
      createMockStep('step1', 1, 'intake', async (ctx) => ({
        success: true,
        context: ctx,
      })),
      createMockStep('step2', 2, 'spec_generation', async () => ({
        success: false,
        context: emptyContext,
        error: { type: 'validation_failed', message: 'Invalid spec' },
      })),
      createMockStep('step3', 3, 'codegen', async (ctx) => ({
        success: true,
        context: ctx,
      })),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid spec');
  });

  it('обрабатывает исключения шага', async () => {
    const steps: IPipelineStep[] = [
      createMockStep('step1', 1, 'intake', async () => {
        throw new Error('Unexpected error');
      }),
      createMockStep('step2', 2, 'spec_generation'),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Unexpected error');
    expect(result.error?.retryable).toBe(true);
  });

  it('проверяет canExecute перед выполнением шага', async () => {
    const steps: IPipelineStep[] = [
      createMockStep(
        'step1',
        1,
        'spec_generation',
        async (ctx) => ({ success: true, context: ctx }),
        () => false,
      ),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('preconditions not met');
  });

  it('передаёт контекст между шагами', async () => {
    const steps: IPipelineStep[] = [
      createMockStep('step1', 1, 'intake', async (ctx) => ({
        success: true,
        context: { ...ctx, intent: { intentId: 'test-intent' } as never },
      })),
      createMockStep('step2', 2, 'spec_generation', async (ctx) => ({
        success: true,
        context: { ...ctx, spec: { specId: 'test-spec' } as never },
      })),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.success).toBe(true);
    expect(result.context.intent).toBeDefined();
    expect(result.context.spec).toBeDefined();
  });

  it('работает с пустым списком шагов', async () => {
    const result = await executePipeline([], emptyContext);

    expect(result.success).toBe(true);
    expect(result.context).toBe(emptyContext);
  });

  it('сохраняет repairAttempts из результата шага', async () => {
    const steps: IPipelineStep[] = [
      createMockStep('step1', 1, 'intake', async (ctx) => ({
        success: true,
        context: ctx,
        repairAttempts: 2,
      })),
    ];

    const result = await executePipeline(steps, emptyContext);

    expect(result.repairAttempts).toBe(2);
  });
});
