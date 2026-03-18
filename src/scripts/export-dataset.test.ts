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
