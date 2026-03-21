import { describe, it, expect } from 'vitest';
import { filterAndTransform, type TraceRecord } from './export-dataset';

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    runId: 'test-1',
    status: 'success',
    task: 'посчитай сумму от 1 до 10',
    modelId: 'qwen-coder-plus',
    repairAttempts: 0,
    buildReport: { success: true, compilerSuccess: true },
    goldenReport: { qualityScore: 0.9 },
    source: { source: 'модуль t\nпроцедура главная()\n  вернуть 55\nконец\nконец' },
    spec: {
      mainModule: 't',
      procedures: [{ name: 'главная' }],
      syscalls: [],
    },
    intent: {
      description: 'Сумма чисел от 1 до 10',
      appType: 'утилита',
      features: ['цикл', 'сложение'],
    },
    ...overrides,
  };
}

/** Алиас для кейсов, где явно нужен «успешный» минимальный трейс */
const makeSuccessRecord = makeRecord;

describe('filterAndTransform', () => {
  it('включает успешные записи', () => {
    const result = filterAndTransform([makeRecord()]);
    expect(result).toHaveLength(1);
    expect(result[0]!.target_text).toContain('модуль t');
  });

  it('исключает status != success', () => {
    const result = filterAndTransform([makeRecord({ status: 'failure' })]);
    expect(result).toHaveLength(0);
  });

  it('исключает buildReport.success = false', () => {
    const result = filterAndTransform([
      makeRecord({ buildReport: { success: false, compilerSuccess: false } }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('исключает пустой source', () => {
    const result = filterAndTransform([makeRecord({ source: { source: '   ' } })]);
    expect(result).toHaveLength(0);
  });

  it('фильтрует по minQuality', () => {
    const low = makeRecord({ goldenReport: { qualityScore: 0.3 } });
    const high = makeRecord({ goldenReport: { qualityScore: 0.9 } });
    expect(filterAndTransform([low, high], 0.5)).toHaveLength(1);
  });

  it('фильтрует по minRepairs', () => {
    const zero = makeRecord({ repairAttempts: 0 });
    const two = makeRecord({ repairAttempts: 2 });
    const result = filterAndTransform([zero, two], 0, 1);
    expect(result).toHaveLength(1);
  });

  it('input_text содержит задачу и тип приложения', () => {
    const result = filterAndTransform([makeRecord()]);
    expect(result[0]!.input_text).toContain('посчитай сумму от 1 до 10');
    expect(result[0]!.input_text).toContain('утилита');
    expect(result[0]!.input_text).toContain('цикл, сложение');
  });

  it('meta содержит repairAttempts и modelId', () => {
    const result = filterAndTransform([makeRecord({ repairAttempts: 2, modelId: 'deepseek' })]);
    expect(result[0]!.meta?.repairAttempts).toBe(2);
    expect(result[0]!.meta?.modelId).toBe('deepseek');
  });

  it('возвращает пустой массив для пустого входа', () => {
    expect(filterAndTransform([])).toHaveLength(0);
  });

  it('оставляет только записи с buildReport.success === true', () => {
    const records: TraceRecord[] = [
      makeRecord({ buildReport: { success: true, compilerSuccess: true } }),
      makeRecord({ buildReport: { success: false, compilerSuccess: true } }),
      makeRecord({ buildReport: { success: true, compilerSuccess: true } }),
    ];
    expect(filterAndTransform(records)).toHaveLength(2);
  });

  it('отбрасывает записи со status !== success', () => {
    const records: TraceRecord[] = [
      makeRecord({ status: 'success' }),
      makeRecord({ status: 'failure' }),
      makeRecord({ status: 'partial' }),
    ];
    expect(filterAndTransform(records)).toHaveLength(1);
  });

  it('отбрасывает записи без source.source', () => {
    const records: TraceRecord[] = [
      makeRecord({ source: { source: 'код' } }),
      makeRecord({ source: { source: '' } }),
      makeRecord({ source: undefined }),
    ];
    expect(filterAndTransform(records)).toHaveLength(1);
  });

  // --- тесты новых мета-полей ---

  it('meta.traceId совпадает с meta.runId', () => {
    const rec = makeSuccessRecord();
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.traceId).toBe(ex.meta?.runId);
  });

  it('meta.semanticErrorCount = 0 если semanticErrors пустой', () => {
    const rec = makeSuccessRecord({
      buildReport: { success: true, compilerSuccess: true, semanticErrors: [] },
    });
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.semanticErrorCount).toBe(0);
  });

  it('meta.semanticErrorCount отражает число ошибок', () => {
    const rec = makeSuccessRecord({
      buildReport: {
        success: true,
        compilerSuccess: true,
        semanticErrors: [
          { kind: 'undeclared_var', message: 'x' },
          { kind: 'syscall_argc', message: 'y' },
        ],
      },
    });
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.semanticErrorCount).toBe(2);
  });

  it('meta.category берётся из intent.appType', () => {
    const rec = makeSuccessRecord({ intent: { appType: 'утилита', features: [] } });
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.category).toBe('утилита');
  });

  it('meta.category = первый feature если нет appType', () => {
    const rec = makeSuccessRecord({
      intent: {
        description: 'd',
        features: ['калькулятор', 'история'],
      },
    });
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.category).toBe('калькулятор');
  });

  it('meta.category = "unknown" если нет intent', () => {
    const rec = makeSuccessRecord({ intent: undefined });
    const [ex] = filterAndTransform([rec]);
    expect(ex.meta?.category).toBe('unknown');
  });
});
