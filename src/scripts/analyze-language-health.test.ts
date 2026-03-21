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

describe('top_workaround_patterns (S-1)', () => {
  it('catchVar: пусть ошибка = без попробовать', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        repairAttempts: 0,
        buildReport: { success: true },
        source: { source: 'пусть ошибка = пусто\nесли ошибка == пусто' },
      } as any,
    ]);
    const cv = m.top_workaround_patterns.find((p) => p.pattern === 'catchVar');
    expect(cv?.count).toBe(1);
  });

  it('sentinel: == пусто в коде', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        repairAttempts: 0,
        buildReport: { success: true },
        source: { source: 'если x == пусто' },
      } as any,
    ]);
    const s = m.top_workaround_patterns.find((p) => p.pattern === 'sentinel');
    expect(s?.count).toBe(1);
  });

  it('flag_loop: флаговый цикл', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        repairAttempts: 0,
        buildReport: { success: true },
        source: { source: 'пусть найдено = ложь\nпока i < 10\nнайдено = истина\nконец' },
      } as any,
    ]);
    const fl = m.top_workaround_patterns.find((p) => p.pattern === 'flag_loop');
    expect(fl?.count).toBe(1);
  });
});

describe('teachability_score (T-8)', () => {
  it('все success с 0 попыток → 1.0', () => {
    const m = computeHealthMetrics([
      { status: 'success', repairAttempts: 0, buildReport: { success: true } },
      { status: 'success', repairAttempts: 0, buildReport: { success: true } },
    ]);
    expect(m.teachability_score).toBe(1.0);
  });

  it('половина с 0 попыток → 0.5', () => {
    const m = computeHealthMetrics([
      { status: 'success', repairAttempts: 0, buildReport: { success: true } },
      { status: 'success', repairAttempts: 2, buildReport: { success: true } },
    ]);
    expect(m.teachability_score).toBe(0.5);
  });

  it('нет success → 0', () => {
    const m = computeHealthMetrics([
      { status: 'failure', repairAttempts: 0, buildReport: { success: false } },
    ]);
    expect(m.teachability_score).toBe(0);
  });
});

describe('windowMode (S-7)', () => {
  it('lastN=1 берёт только последний трейс', () => {
    const m = computeHealthMetrics(
      [
        { status: 'failure', repairAttempts: 0, buildReport: { success: false } },
        { status: 'success', repairAttempts: 0, buildReport: { success: true } },
      ],
      { lastN: 1 },
    );
    expect(m.total).toBe(1);
    expect(m.byStatus['success']).toBe(1);
  });

  it('lastHours24 фильтрует старые трейсы', () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const m = computeHealthMetrics(
      [
        { status: 'success', repairAttempts: 0, buildReport: { success: true }, timestamp: old },
        { status: 'success', repairAttempts: 0, buildReport: { success: true }, timestamp: fresh },
      ],
      { lastHours24: true },
    );
    expect(m.total).toBe(1);
  });
});
