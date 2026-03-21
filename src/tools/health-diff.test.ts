import { describe, it, expect } from 'vitest';
import { buildMetricRows, buildDiffMessage, findPreviousSnapshot } from './health-diff';

// Мок-snapshot с RFC rates
const snapWithRfc = {
  total: 100,
  semantic_errors_in_success: 0,
  avg_quality_score: 0.85,
  avg_repair_attempts: 0.4,
  build_success_rate: 0.92,
  teachability_score: 0.78,
  byStatus: { success: 80, repair_exhausted: 5, failure: 15 },
  sentinel_rate: 0.03,
  invented_syntax_rate: 0.005,
  shadow_rfc002_correct_rate: 0.87,
  shadow_rfc003_correct_rate: 0.96,
};

const snapPrev = {
  ...snapWithRfc,
  teachability_score: 0.7,
  build_success_rate: 0.88,
  sentinel_rate: 0.06,
  invented_syntax_rate: 0.02,
  shadow_rfc002_correct_rate: 0.75,
  shadow_rfc003_correct_rate: 0.93,
};

describe('buildMetricRows с RFC rates', () => {
  it('содержит sentinel_rate, invented_syntax_rate, RFC-002, RFC-003', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('sentinel_rate');
    expect(keys).toContain('invented_syntax_rate');
    expect(keys).toContain('shadow_rfc002_correct_rate');
    expect(keys).toContain('shadow_rfc003_correct_rate');
  });

  it('sentinel_rate: current=0.03 < threshold 0.05 → higherIsBetter=false', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const row = rows.find((r) => r.key === 'sentinel_rate')!;
    expect(row.current).toBeCloseTo(0.03);
    expect(row.higherIsBetter).toBe(false);
    expect(row.threshold).toBe(0.05);
  });

  it('invented_syntax_rate: delta = 0.005 - 0.02 = -0.015 (улучшение)', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const row = rows.find((r) => r.key === 'invented_syntax_rate')!;
    expect(row.delta).toBeCloseTo(-0.015);
  });

  it('RFC-002: current=0.87 >= threshold 0.80 → 🟢', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const row = rows.find((r) => r.key === 'shadow_rfc002_correct_rate')!;
    expect(row.current).toBeCloseTo(0.87);
    expect(row.threshold).toBe(0.8);
  });

  it('RFC-003: prev=0.93 < threshold 0.95 → было 🔴, стало 🟢', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const row = rows.find((r) => r.key === 'shadow_rfc003_correct_rate')!;
    expect(row.current).toBeCloseTo(0.96);
    expect(row.previous).toBeCloseTo(0.93);
  });
});

describe('buildDiffMessage с RFC rates', () => {
  it('содержит строки RFC-002 и RFC-003 в выводе', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const msg = buildDiffMessage(rows, '2026-03-28', '2026-03-21');
    expect(msg).toContain('RFC-002');
    expect(msg).toContain('RFC-003');
    expect(msg).toContain('Sentinel');
  });

  it('содержит 🟢 для sentinel_rate < 5%', () => {
    const rows = buildMetricRows(snapWithRfc, snapPrev);
    const msg = buildDiffMessage(rows, '2026-03-28', '2026-03-21');
    expect(msg).toContain('🟢');
  });
});

describe('findPreviousSnapshot', () => {
  it('возвращает null если нет дат', () => {
    const result = findPreviousSnapshot('2026-03-28', '/nonexistent/dir');
    expect(result).toBeNull();
  });
});
