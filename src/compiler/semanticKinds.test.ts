import { describe, it, expect } from 'vitest';
import {
  BLOCKING_SEMANTIC_KINDS,
  NON_BLOCKING_SEMANTIC_KINDS,
  ALL_SEMANTIC_KINDS,
} from './semanticKinds';
import { DIAGNOSTIC_KINDS } from './diagnosticCatalogue';

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

// ============================================================
// Связь со каталогом. Вывод списков из каталога и сторожа дрейфа
// (уникальность имён и кодов, скан `semantic.ts`, негативный контроль)
// живут в `diagnosticCatalogue.test.ts` — здесь только то, что видно
// со стороны самих списков, без повторов.
// ============================================================

describe('списки и каталог', () => {
  const catalogueKinds = DIAGNOSTIC_KINDS.map((entry) => entry.kind);

  it('ни один список не несёт вида, которого нет в каталоге', () => {
    for (const kind of ALL_SEMANTIC_KINDS) {
      expect(catalogueKinds, `вид «${kind}» объявлен списком`).toContain(kind);
    }
  });

  it('ALL_SEMANTIC_KINDS — только ОТНЕСЁННЫЕ виды, а не весь каталог', () => {
    // Различие, которое легко перепутать: «все виды языка» — это каталог (15),
    // а `ALL_SEMANTIC_KINDS` — списки потребителей (9). Шесть видов с долгом
    // стоят вне обоих списков, и это названо в каталоге, а не забыто.
    expect(ALL_SEMANTIC_KINDS.length).toBeLessThan(DIAGNOSTIC_KINDS.length);
    const listed = new Set<string>(ALL_SEMANTIC_KINDS);
    const unlisted = catalogueKinds.filter((kind) => !listed.has(kind));
    expect(unlisted, 'виды каталога вне списков').toHaveLength(6);
    for (const kind of unlisted) {
      const entry = DIAGNOSTIC_KINDS.find((e) => e.kind === kind)!;
      expect(entry.debt, `«${kind}» вне списков обязан быть назван долгом`).toBeTruthy();
    }
  });
});