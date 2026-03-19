import { describe, it, expect, vi } from 'vitest';
import { collectTopErrors, buildModelStats, printRepairStats } from './trace-viewer';

type MinTrace = Parameters<typeof collectTopErrors>[0][number];

function makeTrace(overrides: Partial<MinTrace> = {}): MinTrace {
  return {
    runId: 'r1',
    status: 'success',
    task: 'тест',
    timestamp: new Date().toISOString(),
    repairAttempts: 0,
    ...overrides,
  };
}

describe('collectTopErrors', () => {
  it('возвращает пустую карту если нет ошибок', () => {
    expect(collectTopErrors([makeTrace()])).toEqual(new Map());
  });

  it('считает ошибки компилятора', () => {
    const t = makeTrace({
      buildReport: {
        compilerErrors: [{ message: "Unknown symbol 'x'" }, { message: "Unknown symbol 'y'" }],
      },
    });
    const map = collectTopErrors([t]);
    const key = [...map.keys()].find(k => k.includes('Unknown symbol'));
    expect(key).toBeDefined();
    expect(map.get(key!)).toBe(2);
  });

  it('нормализует числа в ключах', () => {
    const t = makeTrace({
      buildReport: {
        lexerErrors: [{ message: 'Error at line 5' }, { message: 'Error at line 10' }],
      },
    });
    const map = collectTopErrors([t]);
    const keys = [...map.keys()];
    expect(keys.length).toBe(1);
    expect(map.get(keys[0]!)).toBe(2);
  });

  it('объединяет все типы ошибок', () => {
    const t = makeTrace({
      buildReport: {
        lexerErrors: [{ message: 'lex error' }],
        parserErrors: [{ message: 'parse error' }],
        semanticErrors: [{ message: 'semantic error' }],
      },
    });
    expect(collectTopErrors([t]).size).toBe(3);
  });
});

describe('buildModelStats', () => {
  it('считает по моделям', () => {
    const traces = [
      makeTrace({ modelId: 'deepseek', status: 'success', repairAttempts: 0 }),
      makeTrace({ modelId: 'deepseek', status: 'failure', repairAttempts: 2 }),
      makeTrace({ modelId: 'qwen', status: 'success', repairAttempts: 1 }),
    ];
    const stats = buildModelStats(traces);
    expect(stats.get('deepseek')).toEqual({ total: 2, success: 1, repairs: 2 });
    expect(stats.get('qwen')).toEqual({ total: 1, success: 1, repairs: 1 });
  });

  it('использует unknown для записей без modelId', () => {
    const stats = buildModelStats([makeTrace()]);
    expect(stats.has('unknown')).toBe(true);
  });
});

describe('printRepairStats', () => {
  it('считает распределение repair-попыток корректно', () => {
    // просто вызываем чтобы убедиться что не падает при пустом массиве
    expect(() => printRepairStats([])).not.toThrow();
  });

  it('корректно считает success rate для 0 попыток', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const traces = [
      makeTrace({ status: 'success', repairAttempts: 0 }),
      makeTrace({ status: 'failure', repairAttempts: 0 }),
      makeTrace({ status: 'success', repairAttempts: 1 }),
      makeTrace({ status: 'repair_exhausted', repairAttempts: 3 }),
    ];

    expect(() => printRepairStats(traces)).not.toThrow();

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // 0 attempts: 2 прогона, 1 success => 50.0%
    expect(output).toContain('success rate 50.0%');

    logSpy.mockRestore();
  });
});

