import { describe, it, expect } from 'vitest';
import { computeHealthMetrics, isMockTrace } from './analyze-language-health';

describe('computeHealthMetrics', () => {
  it('пустой массив → все нули', () => {
    const m = computeHealthMetrics([]);
    expect(m.total).toBe(0);
    expect(m.semantic_errors_in_success).toBe(0);
    expect(m.non_blocking_semantic_in_success).toBe(0);
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
    expect(m.non_blocking_semantic_in_success).toBe(0);
    expect(m.avg_quality_score).toBe(1.0);
  });

  it('СТОП-СИГНАЛ: success + blocking semantic → semantic_errors_in_success=1', () => {
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
    expect(m.non_blocking_semantic_in_success).toBe(0);
  });

  it('success + только non-blocking semantic → стоп-сигнала нет, non_blocking=1', () => {
    const m = computeHealthMetrics([
      {
        status: 'success',
        buildReport: {
          success: true,
          semanticErrors: [{ kind: 'chained_compare', message: 'цепочка сравнений' }],
        },
        repairAttempts: 0,
      },
    ]);
    expect(m.semantic_errors_in_success).toBe(0);
    expect(m.non_blocking_semantic_in_success).toBe(1);
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

  it('sinceDate фильтрует старые трейсы', () => {
    const old = {
      status: 'success',
      timestamp: '2026-03-19T00:00:00.000Z',
      repairAttempts: 0,
      buildReport: {
        success: true,
        semanticErrors: [{ kind: 'redeclare_var', message: 'x' }],
      },
    };
    const fresh = {
      status: 'success',
      timestamp: '2026-03-21T12:00:00.000Z',
      repairAttempts: 0,
      buildReport: { success: true, semanticErrors: [] },
    };
    const all = computeHealthMetrics([old, fresh]);
    expect(all.semantic_errors_in_success).toBe(1);

    const filtered = computeHealthMetrics([old, fresh], new Date('2026-03-21T00:00:00.000Z'));
    expect(filtered.semantic_errors_in_success).toBe(0);
    expect(filtered.total).toBe(1);
  });

  it('sinceDate undefined — поведение как раньше', () => {
    const t = {
      status: 'success',
      timestamp: '2026-01-01T00:00:00.000Z',
      repairAttempts: 0,
      buildReport: { success: true, semanticErrors: [] },
    };
    const m = computeHealthMetrics([t], undefined);
    expect(m.total).toBe(1);
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

describe('isMockTrace', () => {
  it('true для __test__partial__mock__', () => {
    expect(isMockTrace({ task: '__test__partial__mock__' })).toBe(true);
  });

  it('true для __test__foo', () => {
    expect(isMockTrace({ task: '__test__foo' })).toBe(true);
  });

  it('true для задачи с __mock__ в середине', () => {
    expect(isMockTrace({ task: 'some__mock__task' })).toBe(true);
  });

  it('false для обычной задачи', () => {
    expect(isMockTrace({ task: 'Посчитать сумму от 1 до 10' })).toBe(false);
  });

  it('false для undefined task', () => {
    expect(isMockTrace({})).toBe(false);
  });
});

describe('computeHealthMetrics — mock traces excluded', () => {
  it('мок-трейс не попадает в teachability', () => {
    const traces = [
      {
        status: 'success',
        repairAttempts: 0,
        task: 'реальная задача',
        timestamp: new Date().toISOString(),
      },
      {
        status: 'success',
        repairAttempts: 3,
        task: '__test__partial__mock__',
        timestamp: new Date().toISOString(),
      },
    ];
    const m = computeHealthMetrics(traces);
    expect(m.teachability_score).toBe(1.0);
    expect(m.total).toBe(1);
  });
});
