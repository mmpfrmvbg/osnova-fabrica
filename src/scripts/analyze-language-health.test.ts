import { describe, it, expect } from 'vitest';
import { computeHealthMetrics } from './analyze-language-health';

describe('computeHealthMetrics', () => {
  it('пустой массив → все нули', () => {
    const m = computeHealthMetrics([]);
    expect(m.total).toBe(0);
    expect(m.semantic_errors_in_success).toBe(0);
  });

  it('success без семантических ошибок → semantic_errors_in_success=0', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        buildReport: { success: true, semanticErrors: [] },
        goldenReport: { qualityScore: 1.0 },
        repairAttempts: 0,
      },
    ]);
    expect(m.semantic_errors_in_success).toBe(0);
    expect(m.avg_quality_score).toBe(1.0);
  });

  it('СТОП-СИГНАЛ: success + семантические ошибки → semantic_errors_in_success=1', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        buildReport: {
          success: true,
          semanticErrors: [{ kind: 'undeclared_var', message: 'x не объявлен' }],
        },
        repairAttempts: 0,
      },
    ]);
    expect(m.semantic_errors_in_success).toBe(1);
  });

  it('failure + семантические ошибки → НЕ стоп-сигнал', () => {
    const m = computeHealthMetrics([
      {
        status: 'failure',
        buildReport: {
          semanticErrors: [{ kind: 'undeclared_var', message: 'x' }],
        },
        repairAttempts: 0,
      },
    ]);
    expect(m.semantic_errors_in_success).toBe(0);
  });

  it('avg_repair_attempts считается корректно', () => {
    const m = computeHealthMetrics([
      { status: 'success', repairAttempts: 0, buildReport: {} },
      { status: 'success', repairAttempts: 2, buildReport: {} },
    ]);
    expect(m.avg_repair_attempts).toBe(1.0);
  });

  it('build_success_rate = доля buildReport.success=true', () => {
    const m = computeHealthMetrics([
      { status: 'success', buildReport: { success: true }, repairAttempts: 0 },
      { status: 'failure', buildReport: { success: false }, repairAttempts: 0 },
    ]);
    expect(m.build_success_rate).toBe(0.5);
  });
});
