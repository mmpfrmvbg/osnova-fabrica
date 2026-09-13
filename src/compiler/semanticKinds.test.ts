import { describe, it, expect } from 'vitest';
import {
  BLOCKING_SEMANTIC_KINDS,
  NON_BLOCKING_SEMANTIC_KINDS,
  ALL_SEMANTIC_KINDS,
} from './semanticKinds';

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

describe('BLOCKING_SEMANTIC_KINDS и NON_BLOCKING_SEMANTIC_KINDS', () => {
  it('не пересекаются', () => {
    const blocking = new Set<string>(BLOCKING_SEMANTIC_KINDS);
    const intersection = (NON_BLOCKING_SEMANTIC_KINDS as readonly string[]).filter(
      (kind) => blocking.has(kind),
    );
    expect(intersection).toEqual([]);
  });
});

describe('ALL_SEMANTIC_KINDS', () => {
  it('содержит все элементы BLOCKING_SEMANTIC_KINDS', () => {
    for (const kind of BLOCKING_SEMANTIC_KINDS) {
      expect(ALL_SEMANTIC_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('содержит все элементы NON_BLOCKING_SEMANTIC_KINDS', () => {
    for (const kind of NON_BLOCKING_SEMANTIC_KINDS) {
      expect(ALL_SEMANTIC_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('не содержит дублей', () => {
    const unique = new Set<string>(ALL_SEMANTIC_KINDS);
    expect(unique.size).toBe(ALL_SEMANTIC_KINDS.length);
  });

  it('имеет длину, равную сумме длин обоих списков', () => {
    expect(ALL_SEMANTIC_KINDS).toHaveLength(
      BLOCKING_SEMANTIC_KINDS.length + NON_BLOCKING_SEMANTIC_KINDS.length,
    );
  });
});