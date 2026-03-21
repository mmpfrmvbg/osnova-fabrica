import { describe, it, expect } from 'vitest';
import { analyzeDatasetHealth, inferCategory } from './analyze-dataset-health';

describe('inferCategory', () => {
  it('из поля category', () => {
    expect(inferCategory({ category: 'errors' })).toBe('errors');
  });
  it('heuristic: массив', () => {
    expect(inferCategory({ task: 'сделай массив из 5 чисел' })).toBe('arrays');
  });
  it('heuristic: ошибк', () => {
    expect(inferCategory({ task: 'обработай ошибку' })).toBe('errors');
  });
  it('fallback: generic', () => {
    expect(inferCategory({ task: 'неизвестная задача' })).toBe('generic');
  });
});

describe('analyzeDatasetHealth', () => {
  it('пустой массив → предупреждение', () => {
    const r = analyzeDatasetHealth([]);
    expect(r.total_success).toBe(0);
    expect(r.warnings[0]).toContain('Нет success');
  });

  it('только failure → 0 success', () => {
    const r = analyzeDatasetHealth([{ status: 'failure', category: 'generic' }]);
    expect(r.total_success).toBe(0);
  });

  it('одна категория 100% → не underrepresented', () => {
    const traces = Array.from({ length: 20 }, () => ({ status: 'success', category: 'generic' }));
    const r = analyzeDatasetHealth(traces);
    expect(r.underrepresented).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('категория с 5% → underrepresented', () => {
    const traces = [
      ...Array.from({ length: 95 }, () => ({ status: 'success', category: 'generic' })),
      ...Array.from({ length: 5 }, () => ({ status: 'success', category: 'errors' })),
    ];
    const r = analyzeDatasetHealth(traces);
    const errCat = r.categories.find(c => c.category === 'errors');
    expect(errCat?.underrepresented).toBe(true);
    expect(r.warnings.some(w => w.includes('errors'))).toBe(true);
  });

  it('категории отсортированы по убыванию count', () => {
    const traces = [
      ...Array.from({ length: 60 }, () => ({ status: 'success', category: 'generic' })),
      ...Array.from({ length: 40 }, () => ({ status: 'success', category: 'arrays' })),
    ];
    const r = analyzeDatasetHealth(traces);
    expect(r.categories[0]!.category).toBe('generic');
  });
});
