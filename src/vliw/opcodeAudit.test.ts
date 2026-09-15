/**
 * Аудит опкодов: «эффект или значение? есть ли неявный барьер?»
 *
 * ## Зачем этот файл
 *
 * Планировщик дважды ошибся на одном и том же классе дефекта:
 *
 * 1. `ret` не был помечен эффектом и не имел предшественников в графе —
 *    планировщик выдавал его первым, и процедура завершалась до того, как
 *    срабатывали эффекты (`storage_demo.osnova`, `блокнот.osnova`);
 * 2. `try_begin` переставлялся, потому что не закрывал участок.
 *
 * Общее у них: **валидатор проверял то, что есть в артефакте, и не видел того,
 * чего в нём нет.** Проверка рёбер не находит отсутствующее ребро.
 *
 * Поэтому здесь аудит идёт не по данным, а по **списку опкодов**: для каждого
 * опкода, который меняет наблюдаемое состояние, утверждается одно из двух:
 *
 * - он объявлен эффектом (`isEffectInstruction`), либо
 * - он структурно закрывает линейный участок (`linearRegionStarts`).
 *
 * Если у какого-то опкода нет ни того, ни другого — это будущий дефект того же
 * класса, и тест падает СЕЙЧАС, а не когда он проявится на реальной программе.
 *
 * ## Три уровня полноты
 *
 * 1. **Регистровый уровень** — проверяется напрямую по `RegInstruction`.
 * 2. **Стековый уровень** — список {@link STATE_CHANGING_STACK_OPS} проверяется
 *    на согласованность с `ALL_OPS`: если в языке появится новый опкод, тест
 *    потребует отнести его к эффектам или к значениям явно.
 * 3. **Полнота по языку** — тест падает, если в `ALL_OPS` появился опкод, не
 *    упомянутый ни в одном из списков ниже. Так «забыть» опкод нельзя.
 */

import { describe, it, expect } from "vitest";
import { ALL_OPS } from "../runtime/vm/bytecode";
import {
  isEffectInstruction,
  regInstructionDef,
  regInstructionUses,
} from "./regGraph";
import { linearRegionStarts, splitLinearRegions } from "./reorderScheduler";
import type { RegInstruction } from "../runtime/vm/regcode";

// ---------------------------------------------------------------------------
// Классификация опкодов регистрового кода
// ---------------------------------------------------------------------------

/**
 * Опкоды, которые **меняют наблюдаемое состояние** и потому обязаны быть либо
 * эффектом, либо барьером участка.
 *
 * Проставляя здесь опкод, автор обязан осознанно ответить на вопрос «эффект или
 * значение»: тест проверит, что ответ реализован.
 */
const STATE_CHANGING: readonly string[] = [
  "local.set",   // запись в слот кадра
  "obj.set",     // запись поля объекта (память, наблюдаемо снаружи)
  "obj.new",     // создание объекта (аллокация)
  "call",        // вызов процедуры: её эффекты наблюдаемы
  "invoke",      // системный вызов: обычно эффект, кроме read-only
  "jmp",         // передача управления
  "jmp_if",
  "jmp_if_not",
  "try_begin",   // открывает защищённый блок
  "try_end",     // закрывает его
  "throw",       // передача управления + наблюдаемое исключение
  "ret",         // завершение процедуры: наблюдает всё, что было до него
];

/**
 * Опкоды, которые только вырабатывают значение и ничего не меняют.
 * Перечислены явно — чтобы «забыть» опкод было невозможно (см. тест полноты).
 */
const PURE_VALUE: readonly string[] = [
  "const",
  "const.true",
  "const.false",
  "const.null",
  "move",
  "add",
  "sub",
  "mul",
  "div",
  "rem",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "and",
  "or",
  "not",
  "obj.get",
];

/**
 * Опкоды, и создающие значение, и меняющие состояние.
 *
 * `obj.new` возвращает объект (`d`), но само создание — наблюдаемое событие:
 * порядок создания относительно записей полей значим. Такие опкоды обязаны быть
 * эффектами; проверяются отдельным блоком ниже.
 */
const VALUE_AND_EFFECT: readonly string[] = ["obj.new"];

/**
 * Опкоды языка Основа, которые меняют состояние.
 *
 * Стековый уровень. Нужен, чтобы полнота проверялась и для языка, а не только
 * для регистрового кодогена: если в языке появится новый опкод-эффект, он должен
 * быть добавлен сюда и в `dependencyGraph.ts`.
 */
const STATE_CHANGING_STACK_OPS: readonly string[] = [
  "local.set",
  "obj.set",
  "obj.new",
  "call",
  "invoke",
  "jmp",
  "jmp_if",
  "jmp_if_not",
  "try_begin",
  "try_end",
  "throw",
  "ret",
];

/** Конструирует минимальную регистровую инструкцию по имени опкода. */
function regInstructionOf(op: string): RegInstruction | null {
  switch (op) {
    case "const":
      return { op: "const", d: 0, type: "i32", k: 0 } as RegInstruction;
    case "const.true":
      return { op: "const.true", d: 0 } as RegInstruction;
    case "const.false":
      return { op: "const.false", d: 0 } as RegInstruction;
    case "const.null":
      return { op: "const.null", d: 0 } as RegInstruction;
    case "move":
      return { op: "move", d: 0, a: 1 } as RegInstruction;
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "rem":
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "and":
    case "or":
      return { op, d: 0, a: 1, b: 2 } as unknown as RegInstruction;
    case "not":
      return { op: "not", d: 0, a: 1 } as RegInstruction;
    case "obj.get":
      return { op: "obj.get", d: 0, a: 1, key: 2 } as RegInstruction;
    case "obj.set":
      return { op: "obj.set", a: 1, key: 2, b: 3 } as RegInstruction;
    case "obj.new":
      return { op: "obj.new", d: 0 } as RegInstruction;
    case "call":
      return { op: "call", fi: 0, args: [], argc: 0 } as RegInstruction;
    case "invoke":
      return { op: "invoke", name: "система.лог.вывести", args: [1], argc: 1 } as RegInstruction;
    case "jmp":
      return { op: "jmp", off: 0 } as RegInstruction;
    case "jmp_if":
      return { op: "jmp_if", off: 0, cond: 1 } as RegInstruction;
    case "jmp_if_not":
      return { op: "jmp_if_not", off: 0, cond: 1 } as RegInstruction;
    case "try_begin":
      return { op: "try_begin", off: 0, catchReg: 1 } as RegInstruction;
    case "try_end":
      return { op: "try_end" } as RegInstruction;
    case "throw":
      return { op: "throw", a: 1 } as RegInstruction;
    case "ret":
      return { op: "ret", v: 1 } as RegInstruction;
    case "local.set":
    case "local.get":
    case "dup":
    case "pop":
      // Этих опкодов в регистровой форме нет (локальные промоутятся в vreg'и).
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Полнота: каждый опкод языка отнесён явно
// ---------------------------------------------------------------------------

describe("опкод-аудит: полнота классификации", () => {
  it("каждый опкод языка упомянут явно — эффект или значение", () => {
    const known = new Set<string>([
      ...STATE_CHANGING,
      ...STATE_CHANGING_STACK_OPS,
      ...PURE_VALUE,
      // Опкоды, которых в регистровой форме нет, но которые есть в языке.
      // Отсутствие объяснено: локальные переменные занимают фиксированные vreg,
      // поэтому local.get/local.set исчезают; dup/pop — артефакты стека.
      "local.get",
      "dup",
      "pop",
    ]);
    const missing = ALL_OPS.filter((op) => !known.has(op));
    expect(
      missing,
      `Новые опкоды не отнесены ни к эффектам, ни к значениям: ${missing.join(", ")}. ` +
        `Добавьте их в STATE_CHANGING / PURE_VALUE в этом файле, ответив на вопрос ` +
        `«эффект или значение» и «есть ли неявный барьер».`,
    ).toEqual([]);
  });

  it("списки не пересекаются", () => {
    const overlap = STATE_CHANGING.filter((op) => PURE_VALUE.includes(op));
    expect(overlap).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Регистровый уровень: эффект ИЛИ барьер
// ---------------------------------------------------------------------------

describe("опкод-аудит: у каждого эффектного опкода есть защита", () => {
  for (const op of STATE_CHANGING) {
    const ins = regInstructionOf(op);
    if (ins === null) continue;

    it(`«${op}»: объявлен эффектом или закрывает участок`, () => {
      const isEffect = isEffectInstruction(ins);
      // Барьер участка: опкод либо сам начинает участок, либо после него
      // начинается новый.
      const code = [
        { op: "const", d: 1, type: "i32", k: 0 } as RegInstruction,
        ins,
        { op: "const", d: 2, type: "i32", k: 1 } as RegInstruction,
      ];
      const starts = linearRegionStarts(code);
      const closesRegion = starts.has(1) || starts.has(2);

      expect(
        isEffect || closesRegion,
        `«${op}» меняет состояние, но не объявлен эффектом и не закрывает участок. ` +
          `Это тот же дефект, что был с ret и try_begin: планировщик сможет выдать ` +
          `его в произвольном месте.`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Регистровый уровень: значение И барьер для терминаторов
// ---------------------------------------------------------------------------

describe("опкод-аудит: терминаторы закрывают участок", () => {
  const TERMINATORS = ["ret", "jmp", "jmp_if", "jmp_if_not"] as const;

  for (const op of TERMINATORS) {
    it(`«${op}» закрывает линейный участок`, () => {
      const ins = regInstructionOf(op)!;
      const code = [
        { op: "const", d: 1, type: "i32", k: 0 } as RegInstruction,
        ins,
        { op: "const", d: 2, type: "i32", k: 1 } as RegInstruction,
      ];
      const regions = splitLinearRegions(code);
      // Инструкция после терминатора обязана начать новый участок.
      const startsNew = regions.some((r) => r.start === 2);
      expect(startsNew, `после «${op}» должен начинаться новый участок`).toBe(true);
    });
  }

  it("try_begin закрывает участок (обработчик — отдельный участок)", () => {
    const ins = regInstructionOf("try_begin")!;
    const code = [
      { op: "const", d: 1, type: "i32", k: 0 } as RegInstruction,
      ins,
      { op: "const", d: 2, type: "i32", k: 1 } as RegInstruction,
    ];
    const starts = linearRegionStarts(code);
    // Участок начинается и в теле (сам try_begin), и в обработчике (off).
    expect(starts.has(1)).toBe(true);
    expect(starts.has(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Регистровый уровень: чистые операции не объявлены эффектами
// ---------------------------------------------------------------------------

describe("опкод-аудит: чистые операции не тормозят перестановку", () => {
  for (const op of PURE_VALUE) {
    const ins = regInstructionOf(op);
    if (ins === null) continue;

    it(`«${op}»: не эффект`, () => {
      // Если чистая операция объявлена эффектом, планировщик перестанет
      // переставлять её — потеряем ILP на ровном месте.
      expect(
        isEffectInstruction(ins),
        `«${op}» только вырабатывает значение, но объявлена эффектом`,
      ).toBe(false);
    });
  }
});

describe("опкод-аудит: опкоды «значение И эффект» объявлены эффектами", () => {
  for (const op of VALUE_AND_EFFECT) {
    it(`«${op}»: вырабатывает значение, но обязан быть эффектом`, () => {
      const ins = regInstructionOf(op)!;
      // Вырабатывает значение — значит есть def.
      expect(regInstructionDef(ins), `${op} должен писать регистр`).toBe(0);
      // Но порядок значим — значит эффект.
      expect(
        isEffectInstruction(ins),
        `«${op}» создаёт наблюдаемое состояние и должен быть эффектом`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Читает/пишет: невыдуманность модели регистров
// ---------------------------------------------------------------------------

describe("опкод-аудит: чтение и запись регистров не выдуманы", () => {
  it("obj.set ничего не пишет в регистр, но читает объект, ключ и значение", () => {
    const ins = regInstructionOf("obj.set")!;
    expect(regInstructionDef(ins)).toBeUndefined();
    expect(regInstructionUses(ins)).toEqual([1, 2, 3]);
  });

  it("try_begin пишет в регистр пойманного значения (это запись, не чтение)", () => {
    const ins = regInstructionOf("try_begin")!;
    expect(regInstructionDef(ins)).toBe(1);
    expect(regInstructionUses(ins)).toEqual([]);
  });

  it("терминаторы не пишут в регистры", () => {
    for (const op of ["jmp", "jmp_if", "jmp_if_not", "ret", "throw"] as const) {
      const ins = regInstructionOf(op)!;
      expect(regInstructionDef(ins), op).toBeUndefined();
    }
  });

  it("у каждой инструкции с d регистр попадает в defs", () => {
    for (const op of ["add", "mul", "not", "move", "obj.get", "obj.new"] as const) {
      const ins = regInstructionOf(op)!;
      expect(regInstructionDef(ins), op).toBe(0);
    }
  });
});
