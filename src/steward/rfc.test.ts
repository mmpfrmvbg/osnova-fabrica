import { describe, it, expect } from 'vitest';
import { isAutoApprovable, validateRFC } from './rfc';
import type { RFC } from './rfc';

const baseRFC: RFC = {
  id: 'RFC-001',
  type: 'rfc',
  title: 'Тест',
  status: 'draft',
  risk: 'low',
  author: 'lang-agent',
  created_at: '2026-03-21T00:00:00Z',
  updated_at: '2026-03-21T00:00:00Z',
  description: 'Описание',
};

describe('isAutoApprovable', () => {
  it('risk=low без phase_b → true', () => {
    expect(isAutoApprovable(baseRFC)).toBe(true);
  });
  it('risk=medium → false', () => {
    expect(isAutoApprovable({ ...baseRFC, risk: 'medium' })).toBe(false);
  });
  it('risk=low с phase_b → false', () => {
    expect(isAutoApprovable({ ...baseRFC, phase_b: { shadow_mode_pct: 85 } })).toBe(false);
  });
});

describe('validateRFC', () => {
  it('валидный RFC → valid=true', () => {
    expect(validateRFC(baseRFC).valid).toBe(true);
  });
  it('неверный id → ошибка', () => {
    const r = validateRFC({ ...baseRFC, id: 'rfc-1' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('id');
  });
  it('anti-rfc без hypothesis → ошибка', () => {
    const r = validateRFC({ ...baseRFC, type: 'anti-rfc' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('hypothesis'))).toBe(true);
  });
  it('пустой title → ошибка', () => {
    const r = validateRFC({ ...baseRFC, title: '' });
    expect(r.valid).toBe(false);
  });
});
