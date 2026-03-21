import { describe, it, expect } from 'vitest';
import {
  detectSentinelAntiPattern,
  detectCorrectTryCatch,
  detectInventedSyntax,
  analyzeRfc002,
  analyzeRfc003,
  analyzeShadow,
  aggregateShadow,
} from './shadowMode';

describe('detectSentinelAntiPattern', () => {
  it('находит == пусто', () => {
    expect(detectSentinelAntiPattern('если x == пусто')).toBe(1);
  });
  it('находит != пусто', () => {
    expect(detectSentinelAntiPattern('если r != пусто')).toBe(1);
  });
  it('находит == -1', () => {
    expect(detectSentinelAntiPattern('если код == -1')).toBe(1);
  });
  it('0 в чистом коде', () => {
    expect(detectSentinelAntiPattern('вернуть 42')).toBe(0);
  });
});

describe('detectCorrectTryCatch', () => {
  it('находит попробовать/иначе_попытка', () => {
    const src = 'попробовать\n  вернуть 1\nиначе_попытка е\n  вернуть 0\nконец';
    expect(detectCorrectTryCatch(src)).toBe(1);
  });
  it('0 без попробовать', () => {
    expect(detectCorrectTryCatch('вернуть 1')).toBe(0);
  });
});

describe('detectInventedSyntax', () => {
  it('находит структура(', () => {
    expect(detectInventedSyntax('пусть x = структура(1, 2)')).toBe(1);
  });
  it('находит данные x =', () => {
    expect(detectInventedSyntax('данные счётчик = 0')).toBe(1);
  });
  it('находит система.типы.', () => {
    expect(detectInventedSyntax('система.типы.создать("X")')).toBe(1);
  });
  it('0 в корректном коде', () => {
    expect(detectInventedSyntax('пусть x = { a: 1 }')).toBe(0);
  });
});

describe('analyzeRfc002', () => {
  it('sentinel без try → incorrect', () => {
    const h = analyzeRfc002('если r == пусто\n  вернуть 0\nконец');
    expect(h.correct).toBe(false);
    expect(h.count).toBeGreaterThan(0);
  });
  it('try без sentinel → correct', () => {
    const h = analyzeRfc002('попробовать\n  вернуть 1\nиначе_попытка е\n  вернуть 0\nконец');
    expect(h.correct).toBe(true);
  });
  it('чистый код (нет ни того ни другого) → correct', () => {
    const h = analyzeRfc002('вернуть 42');
    expect(h.correct).toBe(true);
  });
  it('sentinel + try → incorrect (sentinel доминирует)', () => {
    const src = 'если r == пусто\nпопробовать\nиначе_попытка е\nконец';
    const h = analyzeRfc002(src);
    expect(h.correct).toBe(false);
  });
});

describe('analyzeRfc003', () => {
  it('invented syntax → incorrect', () => {
    const h = analyzeRfc003('пусть x = структура(1, 2)');
    expect(h.correct).toBe(false);
    expect(h.count).toBeGreaterThan(0);
  });
  it('чистый код → correct', () => {
    const h = analyzeRfc003('пусть x = { a: 1 }');
    expect(h.correct).toBe(true);
  });
});

describe('analyzeShadow', () => {
  it('возвращает hits для обоих RFC', () => {
    const r = analyzeShadow('вернуть 1');
    expect(r.hits).toHaveLength(2);
    expect(r.hits.map(h => h.rfc).sort()).toEqual(['RFC-002', 'RFC-003'].sort());
  });
  it('totalByRfc суммирует count', () => {
    const r = analyzeShadow('если x == пусто');
    expect(r.totalByRfc['RFC-002']).toBeGreaterThan(0);
  });
});

describe('aggregateShadow', () => {
  it('readyForPhaseB false если < 50 трейсов', () => {
    const hits = Array.from({ length: 40 }, () => ({ rfc: 'RFC-002' as const, count: 1, correct: true }));
    const agg = aggregateShadow('RFC-002', hits);
    expect(agg.readyForPhaseB).toBe(false);
  });
  it('readyForPhaseB true если >= 50 и rate >= 0.80', () => {
    const hits = Array.from({ length: 50 }, () => ({ rfc: 'RFC-002' as const, count: 1, correct: true }));
    const agg = aggregateShadow('RFC-002', hits);
    expect(agg.readyForPhaseB).toBe(true);
    expect(agg.correctRate).toBe(1.0);
  });
  it('correctRate считается правильно', () => {
    const hits = [
      { rfc: 'RFC-002' as const, count: 1, correct: true },
      { rfc: 'RFC-002' as const, count: 1, correct: false },
      { rfc: 'RFC-002' as const, count: 1, correct: true },
      { rfc: 'RFC-002' as const, count: 1, correct: false },
    ];
    const agg = aggregateShadow('RFC-002', hits);
    expect(agg.correctRate).toBe(0.5);
  });
  it('пустой массив → rate 0, readyForPhaseB false', () => {
    const agg = aggregateShadow('RFC-003', []);
    expect(agg.correctRate).toBe(0);
    expect(agg.readyForPhaseB).toBe(false);
  });
});
