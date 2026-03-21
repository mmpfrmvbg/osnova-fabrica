import { describe, it, expect } from 'vitest';
import { getRepairTarget, formatRepairTarget } from './repairTarget';

describe('getRepairTarget', () => {
  it('undeclared_var → правильная инструкция', () => {
    const t = getRepairTarget('undeclared_var');
    expect(t.kind).toBe('undeclared_var');
    expect(t.instruction).toContain('пусть');
  });
  it('js_try_catch → упоминает попробовать', () => {
    const t = getRepairTarget('js_try_catch');
    expect(t.instruction).toContain('попробовать');
  });
  it('invented_syntax → упоминает структура', () => {
    const t = getRepairTarget('invented_syntax');
    expect(t.instruction).toContain('структура');
  });
  it('unknown kind → fallback на unknown', () => {
    const t = getRepairTarget('nonexistent_kind_xyz');
    expect(t.kind).toBe('unknown');
  });
  it('unknown → инструкция содержит модуль', () => {
    const t = getRepairTarget('unknown');
    expect(t.instruction).toContain('модуль');
  });
});

describe('formatRepairTarget', () => {
  it('форматирует один kind', () => {
    const s = formatRepairTarget(['undeclared_var']);
    expect(s).toContain('ЦЕЛЕВЫЕ ИНСТРУКЦИИ');
    expect(s).toContain('UNDECLARED_VAR');
  });
  it('дедуплицирует дублирующиеся kinds', () => {
    const s = formatRepairTarget(['undeclared_var', 'undeclared_var']);
    const count = (s.match(/UNDECLARED_VAR/g) ?? []).length;
    expect(count).toBe(1);
  });
  it('пустой массив → только заголовок', () => {
    const s = formatRepairTarget([]);
    expect(s).toContain('ЦЕЛЕВЫЕ ИНСТРУКЦИИ');
  });
});
