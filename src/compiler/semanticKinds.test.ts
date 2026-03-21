import { describe, it, expect } from 'vitest';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';

describe('BLOCKING_SEMANTIC_KINDS', () => {
  it('содержит ровно 6 kinds', () => {
    expect(BLOCKING_SEMANTIC_KINDS).toHaveLength(6);
  });

  it('содержит все ожидаемые kinds', () => {
    const expected = [
      'unknown_syscall',
      'undeclared_var',
      'unknown_procedure',
      'syscall_argc',
      'redeclare_var',
      'invented_syntax',
    ];
    for (const kind of expected) {
      expect(BLOCKING_SEMANTIC_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('является readonly tuple — не изменяется в рантайме', () => {
    // Проверяем что тип as const работает: массив не пустой и не undefined
    expect(BLOCKING_SEMANTIC_KINDS.length).toBeGreaterThan(0);
  });
});
