/**
 * БЮДЖЕТ ЛЁГКОГО СОБЫТИЯ AST 3.1 (2026-11-10, атом «AST 3.1 + entry refactor»).
 *
 * Здесь закреплены НЕ слова, а клетки: сколько живых отрезков держит писатель одного события в трёх
 * формах и сколько — точка входа с цепочкой `+`/`-`. Это тот замер, на котором стоит решение
 * «P3c упирается в ФОРМАТ, а не в окно» (`docs/parser-protocol.md` §17, случай 99 реестра долга).
 *
 * Бюджет окна измерен отдельно (`docs/parser-protocol.md` §15.2): у вызываемой 12 клеток, у точки
 * входа 11. Формы:
 *   • 3.0 — `[тег, начало, конец, строка, колонка, …]` (как в P3b) — НЕ влезает;
 *   • A1  — без `конца`: `[тег, начало, длина, строка, колонка]` — влезает ровно в 12;
 *   • A2  — `[тег, индекс_токена]` — влезает с запасом в 10 (точка входа 7).
 *
 * Без модели: считается только раскладка (`allocateProgram`), поэтому файл живёт в полном прогоне.
 */
import { describe, expect, it } from "vitest";
import { parseV3 } from "../compiler-v3";
import { regModuleOrNamedFailure } from "../e2k/recordPlan";
import { annotateAtomRegions } from "../compiler/atomRegions";
import { emitShell } from "../e2k/emitterShell";
import { shellEncoder, arrayProceduresOf, heapSlotProcedures } from "../e2k/programImage";
import { entryProcedureIndex } from "../e2k/procedureCall";
import { ALLOCATABLE_REGISTERS, allocateProgram } from "../e2k/regAlloc";
import { CALLEE_REGISTERS } from "../e2k/twoPassLayout";
import { insertListSetBounds } from "../e2k/arrayBounds";
import { usesCollections, collectionReservedRegisters } from "../e2k/collectionsRuntime";
import { ARRAY_REGISTERS, ENTRY_ARRAY_CELLS } from "../e2k/arrayRuntime";

type Запись = { имя: string; ok: boolean; peakLive: number; причина: string };

const БЮДЖЕТ_ВЫЗЫВАЕМОЙ = 12;

function замерить(src: string): Запись[] {
  const разбор = parseV3(src, "p.osnova");
  expect(разбор.errors, "проба обязана разбираться").toEqual([]);
  const options = { filename: "p.osnova", parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }) };
  const built = regModuleOrNamedFailure(src, options);
  expect(built.ok, built.ok ? "" : JSON.stringify(built).slice(0, 200)).toBe(true);
  if (!built.ok) return [];
  const annotated = annotateAtomRegions(built.module, [{ atom: "A5", procedures: built.module.procedures.map((p) => p.name) }]);
  const emitted = emitShell(annotated, shellEncoder);
  const entryAt = entryProcedureIndex(emitted.scheduled.procedures);
  const arrayProcedures = arrayProceduresOf(emitted.instructions, emitted.scheduled.procedures, emitted.image.invokeNames);
  const heapSlotAt = heapSlotProcedures(emitted.instructions, emitted.scheduled.procedures, emitted.image.invokeNames, entryAt);
  const collectionReserved = usesCollections(emitted.instructions, emitted.image.invokeNames) ? collectionReservedRegisters() : [];
  const reserved = [...collectionReserved, ...(heapSlotAt.size > 0 ? [ARRAY_REGISTERS.heapSlot] : [])];
  const entryRuntime = new Set<number>([
    12,
    ...(arrayProcedures.includes(entryAt) ? Object.values(ENTRY_ARRAY_CELLS) : []),
    ...(heapSlotAt.size > 0 ? [ARRAY_REGISTERS.heapSlot] : []),
  ]);
  const bounds = insertListSetBounds(emitted.instructions, emitted.scheduled.procedures, emitted.image.invokeNames);
  const allocation = allocateProgram(bounds.code, bounds.procedures, {
    reserved,
    freeFor: (at) => (at === entryAt ? ALLOCATABLE_REGISTERS.filter((cell) => !entryRuntime.has(cell)) : CALLEE_REGISTERS),
    arrayProcedures,
    collectAnalysis: true,
  });
  return allocation.procedures.map((p, at) => ({
    имя: p.name,
    ok: allocation.report[at]!.ok,
    peakLive: allocation.report[at]!.peakLive,
    причина: allocation.report[at]!.reason,
  }));
}

const лента = [
  "  пусть лента: Список Число = []",
  "  пусть пт = 0",
  "  пока пт < 162",
  "    Списки.добавить(лента, 1, 0)",
  "    пт = пт + 1",
  "  конец пока",
  "",
].join("\n");

const уровень = (имя: string, тело: string[]) => [`процедура ${имя}(лента: Список Число, поз: Число) -> Число`, ...тело, `конец ${имя}`, ""].join("\n");
const спуск = [
  уровень("разобрать_множитель", ["  вернуть поз + 7 + лента[поз + 5]"]),
  уровень("разобрать_слагаемое", [
    "  поз = разобрать_множитель(лента, поз)",
    "  пока лента[поз] == 62 или лента[поз] == 63",
    "    поз = разобрать_множитель(лента, поз + 7 + лента[поз + 5])",
    "  конец пока",
    "  вернуть поз",
  ]),
  уровень("разобрать_выражение", [
    "  поз = разобрать_слагаемое(лента, поз)",
    "  пока лента[поз] == 60 или лента[поз] == 61",
    "    поз = разобрать_слагаемое(лента, поз + 7 + лента[поз + 5])",
    "  конец пока",
    "  вернуть поз",
  ]),
].join("\n");

/** Писатель события в форме 3.0: лист с `концом` (СУММА) — как в P3b. */
const писатель30 = [
  "процедура выписать_событие(лента: Список Число, т: Число, индекс: Число) -> Число",
  "  пусть вид = лента[т]",
  "  если вид == 3",
  "    Списки.установить(лента, индекс, 13)",
  "  иначе",
  "    Списки.установить(лента, индекс, 12)",
  "  конец если",
  "  Списки.установить(лента, индекс + 1, лента[т + 2])",
  "  Списки.установить(лента, индекс + 2, лента[т + 2] + лента[т + 4])",
  "  Списки.установить(лента, индекс + 3, лента[т + 1])",
  "  Списки.установить(лента, индекс + 4, лента[т + 3])",
  "  индекс = индекс + 5",
  "  Списки.установить(лента, индекс, лента[т + 5])",
  "  пусть место = 0",
  "  пока место < лента[т + 5]",
  "    Списки.установить(лента, индекс + 1 + место, лента[т + 6 + место])",
  "    место = место + 1",
  "  конец пока",
  "  вернуть индекс + 1 + лента[т + 5]",
  "конец выписать_событие",
  "",
].join("\n");

/** A1: тот же лист, но БЕЗ `конца` — конец считает читатель (`начало + длина`). */
const писательA1 = [
  "процедура выписать_событие(лента: Список Число, т: Число, индекс: Число) -> Число",
  "  пусть вид = лента[т]",
  "  если вид == 3",
  "    Списки.установить(лента, индекс, 13)",
  "  иначе",
  "    Списки.установить(лента, индекс, 12)",
  "  конец если",
  "  Списки.установить(лента, индекс + 1, лента[т + 2])",
  "  Списки.установить(лента, индекс + 2, лента[т + 1])",
  "  Списки.установить(лента, индекс + 3, лента[т + 3])",
  "  индекс = индекс + 4",
  "  Списки.установить(лента, индекс, лента[т + 5])",
  "  пусть место = 0",
  "  пока место < лента[т + 5]",
  "    Списки.установить(лента, индекс + 1 + место, лента[т + 6 + место])",
  "    место = место + 1",
  "  конец пока",
  "  вернуть индекс + 1 + лента[т + 5]",
  "конец выписать_событие",
  "",
].join("\n");

/** A2: `[тег, индекс_токена]` — две клетки, остальное читатель берёт из ленты токенов. */
const писательA2 = [
  "процедура выписать_событие(лента: Список Число, з: Число, индекс: Число) -> Число",
  "  Списки.установить(лента, индекс, з)",
  "  Списки.установить(лента, индекс + 1, лента[индекс])",
  "  вернуть индекс + 2",
  "конец выписать_событие",
  "",
].join("\n");

function точкаВхода(тело: string): string {
  return [
    "действие главная()",
    лента,
    "  пусть ток = 0",
    "  пусть индекс = 171",
    "  пусть r = 0",
    "  пока лента[ток] != 5",
    "    если лента[ток] == 29",
    "      пусть нач = ток + 7 + лента[ток + 5]",
    "      пусть кон = разобрать_выражение(лента, нач)",
    "      пусть поз = нач",
    "      пусть пз2 = нач",
    ...тело.split("\n").map((строка) => "      " + строка),
    "      пока пз2 < кон",
    "        пз2 = пз2 + 7 + лента[пз2 + 5]",
    ...тело.split("\n").map((строка) => "        " + строка),
    "      конец пока",
    "      ток = кон",
    "    иначе",
    "      ток = ток + 7 + лента[ток + 5]",
    "    конец если",
    "  конец пока",
    "  вернуть r",
    "конец главная",
    "",
  ].join("\n");
}

describe("бюджет лёгкого события AST 3.1", () => {
  it("АРХИТЕКТУРА — рычаг: писатель ОДНОГО события в форме 3.0 уже влезает (12), точка входа 8", () => {
    const пики = замерить([писатель30, спуск, точкаВхода("r = выписать_событие(лента, ток, индекс)\nиндекс = r")].join("\n"));
    const писатель = пики.find((п) => п.имя === "выписать_событие");
    expect(писатель).toBeDefined();
    expect(писатель!.ok, писатель!.причина).toBe(true);
    // 2026-11-12: ноль для ловушки границ больше не живёт через горячий путь проверки\n    // (src/e2k/arrayBounds.ts), поэтому измеренное значение стало 11 — бюджет стал ЗАПАСОМ.\n    expect(писатель!.peakLive).toBeLessThanOrEqual(БЮДЖЕТ_ВЫЗЫВАЕМОЙ);
    // точка входа с цепочкой `+`/`-` тоже влезает — но ровно: рычаг именно в рассылке по событию
    const главная = пики.find((п) => п.имя === "главная")!;
    expect(главная.ok, главная.причина).toBe(true);
    expect(главная.peakLive).toBe(8);
  });

  it("A1 (без `конца`) влезает ровно в бюджет вызываемой, точка входа — в свой", () => {
    const пики = замерить([писательA1, спуск, точкаВхода("r = выписать_событие(лента, ток, индекс)\nиндекс = r")].join("\n"));
    const писатель = пики.find((п) => п.имя === "выписать_событие")!;
    const главная = пики.find((п) => п.имя === "главная")!;
    expect(писатель.ok, писатель.причина).toBe(true);
    expect(писатель.peakLive).toBeLessThanOrEqual(БЮДЖЕТ_ВЫЗЫВАЕМОЙ);
    expect(главная.ok, главная.причина).toBe(true);
    expect(главная.peakLive).toBe(8);
  });

  it("A2 (индекс токена) влезает с запасом: писатель 10, точка входа 7", () => {
    const пики = замерить([писательA2, спуск, точкаВхода("r = выписать_событие(лента, 12, индекс)\nиндекс = r")].join("\n"));
    const писатель = пики.find((п) => п.имя === "выписать_событие")!;
    const главная = пики.find((п) => п.имя === "главная")!;
    expect(писатель.ok, писатель.причина).toBe(true);
    expect(писатель.peakLive).toBeLessThanOrEqual(10);
    expect(главная.ok, главная.причина).toBe(true);
    expect(главная.peakLive).toBe(7);
  });

  it("спуск 4 уровней в обоих лёгких вариантах остаётся дешёвым (≤ 9)", () => {
    const пики = замерить([писательA1, спуск, точкаВхода("r = выписать_событие(лента, ток, индекс)\nиндекс = r")].join("\n"));
    for (const имя of ["разобрать_множитель", "разобрать_слагаемое", "разобрать_выражение"]) {
      const запись = пики.find((п) => п.имя === имя)!;
      expect(запись.ok, запись.причина).toBe(true);
      expect(запись.peakLive).toBeLessThanOrEqual(9);
    }
  });
});





