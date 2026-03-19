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
});

import { describe, it, expect } from 'vitest';
import { filterAndTransform, type TraceRecord } from './export-dataset';

function mkRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    status: 'success',
    task: 'тест',
    spec: { mainModule: 'M', procedures: [], syscalls: [] },
    source: { source: 'модуль M\nпроцедура главная()\n  вернуть 1\nконец' },
    buildReport: { success: true, compilerSuccess: true },
    goldenReport: { qualityScore: 0.8 },
    ...overrides,
  };
}

describe('filterAndTransform', () => {
  it('оставляет только записи с buildReport.success === true', () => {
    const records: TraceRecord[] = [
      mkRecord({ buildReport: { success: true, compilerSuccess: true } }),
      mkRecord({ buildReport: { success: false, compilerSuccess: true } }), // lexer/parser errors
      mkRecord({ buildReport: { success: true, compilerSuccess: true } }),
    ];
    const examples = filterAndTransform(records);
    expect(examples).toHaveLength(2);
  });

  it('отбрасывает записи со status !== success', () => {
    const records: TraceRecord[] = [
      mkRecord({ status: 'success' }),
      mkRecord({ status: 'failure' }),
      mkRecord({ status: 'partial' }),
    ];
    const examples = filterAndTransform(records);
    expect(examples).toHaveLength(1);
  });

  it('отбрасывает записи без source.source', () => {
    const records: TraceRecord[] = [
      mkRecord({ source: { source: 'код' } }),
      mkRecord({ source: { source: '' } }),
      mkRecord({ source: undefined }),
    ];
    const examples = filterAndTransform(records);
    expect(examples).toHaveLength(1);
  });

  it('фильтрует по minQuality', () => {
    const records: TraceRecord[] = [
      mkRecord({ goldenReport: { qualityScore: 0.9 } }),
      mkRecord({ goldenReport: { qualityScore: 0.3 } }),
    ];
    const examples = filterAndTransform(records, 0.5);
    expect(examples).toHaveLength(1);
  });
});
