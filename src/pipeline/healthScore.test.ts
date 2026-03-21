import { describe, it, expect } from 'vitest';
import { calcHealthScore, clamp, repairPenalty } from './healthScore';

describe('clamp', () => {
  it('не выходит за верхнюю границу', () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
  });
  it('не выходит за нижнюю границу', () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });
  it('пропускает значение внутри диапазона', () => {
    expect(clamp(0.7, 0, 1)).toBe(0.7);
  });
});

describe('repairPenalty', () => {
  it('0 попыток → 1.0', () => {
    expect(repairPenalty(0)).toBe(1.0);
  });
  it('1 попытка → 0.9', () => {
    expect(repairPenalty(1)).toBe(0.9);
  });
  it('2 попытки → 0.75', () => {
    expect(repairPenalty(2)).toBe(0.75);
  });
  it('3 попытки → 0.6', () => {
    expect(repairPenalty(3)).toBe(0.6);
  });
  it('10 попыток → 0.6 (любое >= 3)', () => {
    expect(repairPenalty(10)).toBe(0.6);
  });
});

describe('calcHealthScore', () => {
  it('success без repair → 1.0', () => {
    expect(calcHealthScore({ status: 'success', repairAttempts: 0 })).toBe(1.0);
  });

  it('failure → 0.0', () => {
    expect(calcHealthScore({ status: 'failure', repairAttempts: 0 })).toBe(0.0);
  });

  it('partial без repair → 0.6', () => {
    expect(calcHealthScore({ status: 'partial', repairAttempts: 0 })).toBe(0.6);
  });

  it('repair_exhausted → 0.2', () => {
    expect(calcHealthScore({ status: 'repair_exhausted', repairAttempts: 3 })).toBeCloseTo(0.12);
    // 0.2 * 0.6 = 0.12
  });

  it('success с 1 repair → 0.9', () => {
    expect(calcHealthScore({ status: 'success', repairAttempts: 1 })).toBeCloseTo(0.9);
  });

  it('success с qualityScore=1.0 → 1.0', () => {
    expect(calcHealthScore({ status: 'success', repairAttempts: 0, goldenQualityScore: 1.0 })).toBe(1.0);
    // base = 1.0*0.5 + 1.0*0.5 = 1.0; penalty=1.0; clamp(1.0)=1.0
  });

  it('partial с qualityScore=0.8 → mixed', () => {
    // base = 0.6*0.5 + 0.8*0.5 = 0.7; penalty=1.0; score=0.7
    expect(calcHealthScore({ status: 'partial', repairAttempts: 0, goldenQualityScore: 0.8 })).toBeCloseTo(0.7);
  });

  it('всегда возвращает значение в [0, 1]', () => {
    const cases = [
      { status: 'success' as const, repairAttempts: 0, goldenQualityScore: 2.0 },
      { status: 'failure' as const, repairAttempts: 100 },
      { status: 'partial' as const, repairAttempts: 0, goldenQualityScore: -0.5 },
    ];
    for (const c of cases) {
      const score = calcHealthScore(c);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('goldenQualityScore=0 не применяет bonus (base остаётся)', () => {
    // qualityScore === 0 → условие > 0 не срабатывает
    expect(calcHealthScore({ status: 'success', repairAttempts: 0, goldenQualityScore: 0 })).toBe(1.0);
  });
});
