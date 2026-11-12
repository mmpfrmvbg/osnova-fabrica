/**
 * ОРАКУЛ ГРАНИЦ АТОМОВ В БАЙТКОДЕ: тест написан ДО реализации.
 *
 * ## Зачем это нужно
 *
 * Флаги `optimizable` существуют, но планировщик их не читает: ему не с чем сопоставить —
 * в байткоде не отмечено, где кончается один атом и начинается другой. Пока разметки нет,
 * вся работа над атласом остаётся декларацией.
 *
 * ## Что проверяется
 *
 * 1. **Каталог в коде совпадает с документом.** 27 атомов и те же флаги, что в
 *    `docs/osnova-signature-spec.md` §2. Иначе код и документ разойдутся, и планировщик
 *    будет читать не тот флаг, что записан в спецификации.
 * 2. **Разметка покрывает код целиком**: каждый элемент кода принадлежит ровно одному
 *    атому; ни одного непокрытого и ни одного пересечения.
 * 3. **`optimizable` берётся из каталога**, а не из разметки вызывающего: подменить флаг
 *    в разметке нельзя.
 * 4. **Исходный модуль не меняется** (возвращается копия) — тот же урок, что `{...ins}`.
 * 5. **НЕГАТИВНЫЙ КОНТРОЛЬ**: неизвестный атом, процедура без атома, флаг, расходящийся с
 *    каталогом, — всё обязано находиться.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  ATOM_CATALOGUE,
  annotateAtomRegions,
  isOptimizableAtom,
  verifyAtomRegions,
  type AtomAssignment,
} from "./atomRegions";
import type { RegInstruction, RegModule } from "../runtime/vm/regcode";

const ROOT = path.resolve(__dirname, "..", "..");
const SIGNATURE_SPEC = path.join("docs", "osnova-signature-spec.md");

/** Разобрать каталог из документа: id → optimizable. */
function catalogueFromDoc(): Record<string, string> {
  const text = fs.readFileSync(path.join(ROOT, SIGNATURE_SPEC), "utf-8");
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.replace(/[*`]/g, "").trim());
    const id = cells[1] ?? "";
    if (!/^[A-E][1-9]$/.test(id)) continue;
    result[id] = cells[6] ?? "";
  }
  return result;
}

/** Модуль из двух процедур: «фильтр» (0..2) и «прочее» (3..5). */
function module(): RegModule {
  const ins = (op: string, d: number): RegInstruction => ({ op, d } as RegInstruction);
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "тест",
    constants: [],
    procedures: [
      { name: "фильтр", codeOffset: 0, argc: 0, vregs: 8, localToVreg: {} },
      { name: "прочее", codeOffset: 3, argc: 0, vregs: 8, localToVreg: {} },
    ],
    code: [ins("const", 1), ins("add", 2), ins("ret", 3), ins("const", 4), ins("add", 5), ins("ret", 6)],
  };
}

const ASSIGNMENT: AtomAssignment[] = [
  { atom: "B5", procedures: ["фильтр"] },
  { atom: "A1", procedures: ["прочее"] },
];

describe("каталог атомов в коде против документа", () => {
  it("в каталоге 27 атомов", () => {
    expect(ATOM_CATALOGUE).toHaveLength(27);
    expect(ATOM_CATALOGUE.map((a) => a.id).sort()).toEqual(
      ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "D1", "D2", "D3", "D4", "E1", "E2", "E3", "E4"].sort(),
    );
  });

  it("флаги в коде совпадают с флагами в документе (§2 спецификации)", () => {
    const doc = catalogueFromDoc();
    expect(Object.keys(doc)).toHaveLength(27);
    for (const atom of ATOM_CATALOGUE) {
      expect(String(atom.optimizable), `атом ${atom.id}`).toBe(doc[atom.id]);
    }
  });

  it("оптимизируемых атомов ровно четыре и это A5, A6, B4, B5", () => {
    expect(ATOM_CATALOGUE.filter((a) => a.optimizable).map((a) => a.id)).toEqual(["A5", "A6", "B4", "B5"]);
    expect(isOptimizableAtom("A6")).toBe(true);
    expect(isOptimizableAtom("A1")).toBe(false);
  });
});

describe("разметка границ атомов в байткоде", () => {
  it("каждая процедура получает диапазон, оптимизируемость — из каталога", () => {
    const annotated = annotateAtomRegions(module(), ASSIGNMENT);
    expect(annotated.atoms).toHaveLength(2);
    const [first, second] = annotated.atoms!;
    expect(first).toMatchObject({ atom: "B5", optimizable: true, procedure: 0, start: 0, end: 3 });
    expect(second).toMatchObject({ atom: "A1", optimizable: false, procedure: 1, start: 3, end: 6 });
  });

  it("разметка покрывает код целиком и проверка не находит нарушений", () => {
    const annotated = annotateAtomRegions(module(), ASSIGNMENT);
    expect(verifyAtomRegions(annotated)).toEqual([]);
  });

  it("флаг в разметке нельзя подменить: он берётся из каталога", () => {
    // Разметка вызывающего просит пометить A1 оптимизируемым — это игнорируется,
    // потому что источник истины — каталог.
    const annotated = annotateAtomRegions(module(), [
      { atom: "A1", procedures: ["фильтр", "прочее"], optimizable: true } as AtomAssignment,
    ]);
    for (const region of annotated.atoms!) expect(region.optimizable).toBe(false);
  });

  it("исходный модуль не меняется", () => {
    const source = module();
    const before = JSON.parse(JSON.stringify(source));
    annotateAtomRegions(source, ASSIGNMENT);
    expect(JSON.parse(JSON.stringify(source))).toEqual(before);
    expect(source.atoms).toBeUndefined();
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: неизвестный атом ловится", () => {
    const annotate = (): AtomAssignment[] => [{ atom: "Z9", procedures: ["фильтр", "прочее"] }];
    expect(() => annotateAtomRegions(module(), annotate())).toThrow(/неизвестный атом/i);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: процедура без атома ловится проверкой", () => {
    const annotated = annotateAtomRegions(module(), [{ atom: "B5", procedures: ["фильтр"] }]);
    const problems = verifyAtomRegions(annotated);
    expect(problems.length, "непокрытая процедура не найдена").toBeGreaterThan(0);
    expect(problems[0]).toMatch(/не размечена|не покрыт/i);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: пересечение диапазонов ловится", () => {
    const annotated = annotateAtomRegions(module(), ASSIGNMENT);
    // Портим разметку вручную: второй диапазон начинается раньше конца первого.
    annotated.atoms![1]!.start = 2;
    const problems = verifyAtomRegions(annotated);
    expect(problems.some((p) => /пересек/i.test(p)), `не найдено пересечение: ${problems.join("; ")}`).toBe(true);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: флаг, разошедшийся с каталогом, ловится", () => {
    const annotated = annotateAtomRegions(module(), ASSIGNMENT);
    annotated.atoms![0]!.optimizable = false; // B5 оптимизируем
    const problems = verifyAtomRegions(annotated);
    expect(problems.some((p) => /каталог/i.test(p)), `не найдено расхождение: ${problems.join("; ")}`).toBe(true);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: процедура, отнесённая к двум атомам, ловится", () => {
    expect(() =>
      annotateAtomRegions(module(), [
        { atom: "B5", procedures: ["фильтр"] },
        { atom: "A1", procedures: ["фильтр"] },
      ]),
    ).toThrow(/двум атомам|повторно/i);
  });
});
